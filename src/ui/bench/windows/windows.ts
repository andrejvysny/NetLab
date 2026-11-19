/** Window manager state: plain data + a reducer. Windows live inside the workbench area and can never leave it. */
import { clamp } from '../util.ts';

export type WinKind = 'terminal' | 'pc' | 'config';
export interface Win {
  /** `${kind}:${deviceId}` — one window per device and kind. */
  id: string;
  kind: WinKind;
  deviceId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
  /** Changes when this window should take the keyboard (opened, restored, chosen in the dock). A plain click does not change it. */
  focus: number;
}
export interface Area { w: number; h: number }
export interface WmState {
  wins: Win[];
  topZ: number;
  activeId: string | null;
  /** Increases whenever a window should take the keyboard. */
  focusTick: number;
  opened: number;
}
export type WmAction =
  | { type: 'open'; kind: WinKind; deviceId: string; area: Area; /** Preferred top edge of the first window (below the cable tray). */ top?: number }
  | { type: 'focus'; id: string; take?: boolean }
  | { type: 'close'; id: string }
  | { type: 'minimize'; id: string }
  | { type: 'toggleMax'; id: string }
  | { type: 'rect'; id: string; area: Area; x?: number; y?: number; w?: number; h?: number }
  /** Keyboard: move or resize relative to where the window is now. */
  | { type: 'nudge'; id: string; area: Area; dx?: number; dy?: number; dw?: number; dh?: number }
  | { type: 'tile'; area: Area }
  | { type: 'fit'; area: Area }
  | { type: 'blur' };

export const WIN_MIN_W = 340;
export const WIN_MIN_H = 240;
/** Space kept free at the bottom for the dock. */
export const DOCK_H = 56;
const TITLE_H = 44;

const DEFAULT_SIZE: Record<WinKind, { w: number; h: number }> = {
  terminal: { w: 720, h: 470 },
  pc: { w: 780, h: 540 },
  config: { w: 860, h: 580 },
};

export function initialWm(): WmState { return { wins: [], topZ: 10, activeId: null, focusTick: 0, opened: 0 }; }
export function winId(kind: WinKind, deviceId: string): string { return `${kind}:${deviceId}`; }

/** Keep a window reachable: its title bar always stays inside the area. */
export function clampRect(r: { x: number; y: number; w: number; h: number }, area: Area): { x: number; y: number; w: number; h: number } {
  const aw = Math.max(area.w, 200);
  const ah = Math.max(area.h, 160);
  const w = clamp(r.w, Math.min(WIN_MIN_W, aw - 16), Math.max(WIN_MIN_W, aw - 16));
  const h = clamp(r.h, Math.min(WIN_MIN_H, ah - 16), Math.max(WIN_MIN_H, ah - 16));
  const x = clamp(r.x, Math.min(8, 140 - w), Math.max(8, aw - 140));
  // The title bar stays above the dock, so it can always be grabbed.
  const y = clamp(r.y, 8, Math.max(8, ah - TITLE_H - DOCK_H - 4));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function topVisible(wins: Win[]): Win | undefined {
  return wins.filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0];
}

export function wmReducer(s: WmState, a: WmAction): WmState {
  switch (a.type) {
    case 'open': {
      const id = winId(a.kind, a.deviceId);
      const existing = s.wins.find((w) => w.id === id);
      const z = s.topZ + 1;
      if (existing) {
        return {
          ...s, topZ: z, activeId: id, focusTick: s.focusTick + 1,
          wins: s.wins.map((w) => (w.id === id ? { ...w, minimized: false, z, focus: s.focusTick + 1, ...clampRect(w, a.area) } : w)),
        };
      }
      const size = DEFAULT_SIZE[a.kind];
      const w = Math.min(size.w, a.area.w - 32);
      const h = Math.min(size.h, a.area.h - DOCK_H - 24);
      // Cascade: each new window sits a little lower and further right; wrap around before leaving the area.
      const slot = s.opened % 6;
      const maxX = Math.max(16, a.area.w - w - 16);
      const maxY = Math.max(12, a.area.h - DOCK_H - h - 8);
      const x = Math.min(maxX, 24 + slot * 44);
      // Below the cable tray when there is room for that, otherwise as high as needed to stay on the bench.
      const y = Math.min(maxY, (a.top ?? 16) + slot * 40);
      const win: Win = { id, kind: a.kind, deviceId: a.deviceId, ...clampRect({ x, y, w, h }, a.area), z, minimized: false, maximized: false, focus: s.focusTick + 1 };
      return { ...s, wins: [...s.wins, win], topZ: z, activeId: id, focusTick: s.focusTick + 1, opened: s.opened + 1 };
    }
    case 'focus': {
      const win = s.wins.find((w) => w.id === a.id);
      if (!win) return s;
      if (s.activeId === a.id && !win.minimized && !a.take) return s;
      const z = s.topZ + 1;
      const take = !!a.take || win.minimized;
      return {
        ...s, topZ: z, activeId: a.id, focusTick: take ? s.focusTick + 1 : s.focusTick,
        wins: s.wins.map((w) => (w.id === a.id ? { ...w, minimized: false, z, focus: take ? s.focusTick + 1 : w.focus } : w)),
      };
    }
    case 'blur': return s.activeId === null ? s : { ...s, activeId: null };
    case 'close':
    case 'minimize': {
      const wins = a.type === 'close' ? s.wins.filter((w) => w.id !== a.id) : s.wins.map((w) => (w.id === a.id ? { ...w, minimized: true } : w));
      if (s.activeId !== a.id) return { ...s, wins };
      // The window below takes over, keyboard included.
      const next = topVisible(wins)?.id ?? null;
      if (!next) return { ...s, wins, activeId: null };
      return { ...s, activeId: next, focusTick: s.focusTick + 1, wins: wins.map((w) => (w.id === next ? { ...w, focus: s.focusTick + 1 } : w)) };
    }
    case 'toggleMax':
      return { ...s, wins: s.wins.map((w) => (w.id === a.id ? { ...w, maximized: !w.maximized } : w)) };
    case 'rect':
      return {
        ...s,
        wins: s.wins.map((w) => (w.id === a.id
          ? { ...w, ...clampRect({ x: a.x ?? w.x, y: a.y ?? w.y, w: a.w ?? w.w, h: a.h ?? w.h }, a.area) }
          : w)),
      };
    case 'nudge':
      return {
        ...s,
        wins: s.wins.map((w) => (w.id === a.id
          ? { ...w, ...clampRect({ x: w.x + (a.dx ?? 0), y: w.y + (a.dy ?? 0), w: w.w + (a.dw ?? 0), h: w.h + (a.dh ?? 0) }, a.area) }
          : w)),
      };
    case 'fit':
      return { ...s, wins: s.wins.map((w) => ({ ...w, ...clampRect(w, a.area) })) };
    case 'tile': {
      const vis = s.wins.filter((w) => !w.minimized).sort((x, y) => x.z - y.z);
      if (!vis.length) return s;
      const cols = vis.length <= 3 ? vis.length : Math.ceil(Math.sqrt(vis.length));
      const rows = Math.ceil(vis.length / cols);
      const pad = 10;
      const cw = (a.area.w - pad * (cols + 1)) / cols;
      const ch = (a.area.h - DOCK_H - pad * (rows + 1)) / rows;
      const place = new Map<string, { x: number; y: number; w: number; h: number }>();
      vis.forEach((w, i) => {
        const c = i % cols;
        const r = Math.floor(i / cols);
        place.set(w.id, clampRect({ x: pad + c * (cw + pad), y: pad + r * (ch + pad), w: cw, h: ch }, a.area));
      });
      return { ...s, wins: s.wins.map((w) => (place.has(w.id) ? { ...w, ...place.get(w.id)!, maximized: false } : w)) };
    }
  }
}
