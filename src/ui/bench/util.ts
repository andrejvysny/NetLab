/** Small helpers shared by the workbench UI. No engine imports except types. */
import type { Cable, CableKind, Device, PortRef, PortSpec, World } from '../../engine/types.ts';

export function refKey(r: PortRef): string { return `${r.deviceId}|${r.port}`; }
export function sameRef(a: PortRef | null | undefined, b: PortRef | null | undefined): boolean {
  return !!a && !!b && a.deviceId === b.deviceId && a.port === b.port;
}
export function clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)); }

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  try { return String(e); } catch { return 'unknown error'; }
}
/** Run a LabApi call that must never take the UI down with it. */
export function attempt<T>(fn: () => T, fallback: T): T {
  try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { console.error('[workbench] lab call failed', e); return fallback; }
}

export function findCableAt(world: World, ref: PortRef): Cable | undefined {
  return (world.cables ?? []).find((c) => sameRef(c.a, ref) || sameRef(c.b, ref));
}
export function findPort(world: World, ref: PortRef): PortSpec | undefined {
  return world.devices[ref.deviceId]?.ports?.find((p) => p.name === ref.port);
}
/** "R1 Gi0/0/0" */
export function portText(world: World, ref: PortRef): string {
  const dev = world.devices[ref.deviceId];
  const spec = findPort(world, ref);
  return `${dev?.label ?? ref.deviceId} ${spec?.short ?? ref.port}`;
}
export function otherEnd(cable: Cable, ref: PortRef): PortRef { return sameRef(cable.a, ref) ? cable.b : cable.a; }
export function serialRole(dce: boolean | undefined): 'DCE' | 'DTE' | '' { return dce === undefined ? '' : dce ? 'DCE' : 'DTE'; }

/** Does an end of this lab cable fit the socket? (A hint for highlighting only: the lab validates the pair.) */
export function plugFits(kind: CableKind, port: PortSpec): boolean {
  if (port.media === 'sfp') return false;
  if (kind === 'serial') return port.kind === 'serial';
  if (kind === 'console') return port.kind === 'rs232' || port.kind === 'console' || port.kind === 'ethernet';
  return port.kind === 'ethernet' || port.kind === 'console';
}
/** Second end of a cable whose first end already sits in a `first` socket. */
export function secondEndFits(kind: CableKind, first: PortSpec, port: PortSpec): boolean {
  if (!plugFits(kind, first) || !plugFits(kind, port)) return false;
  // A console cable has one PC-side plug and one RJ-45 plug.
  if (kind === 'console') return (first.kind === 'rs232') !== (port.kind === 'rs232');
  return true;
}

export const MODEL_TEXT: Record<string, { name: string; kindWord: string }> = {
  isr4331: { name: 'Cisco ISR 4331', kindWord: 'Router' },
  c9300l: { name: 'Cisco Catalyst 9300L-24T-4G', kindWord: 'Switch' },
  'pc-windows': { name: 'Windows PC', kindWord: 'PC' },
  'pc-macos': { name: 'MacBook', kindWord: 'PC' },
};
export function modelName(d: Device | undefined): string {
  if (!d) return '';
  return MODEL_TEXT[d.model]?.name ?? String(d.model ?? d.kind ?? 'Device');
}
export function kindWord(d: Device | undefined): string {
  if (!d) return 'Device';
  return MODEL_TEXT[d.model]?.kindWord ?? (d.kind === 'pc' ? 'PC' : d.kind === 'switch' ? 'Switch' : 'Router');
}

/** Split device output into lines. A trailing newline does not make an extra empty line. */
export function splitLines(text: unknown): string[] {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text);
  if (!s) return [];
  const parts = s.replace(/\r\n?/g, '\n').split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export function inIframe(): boolean {
  try { return window.self !== window.top; } catch { return true; }
}
/** Try to save text as a file. Returns false when the browser clearly refused. A sandboxed iframe can refuse silently. */
export function downloadText(filename: string, text: string): boolean {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, 4000);
    return true;
  } catch (e) {
    console.warn('[workbench] download failed', e);
    return false;
  }
}
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}
export function hasTextSelection(): boolean {
  try { const s = window.getSelection(); return !!s && !s.isCollapsed && s.toString().length > 0; } catch { return false; }
}
