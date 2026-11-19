/**
 * Storage adapter for the Lab. The engine never touches window/localStorage itself: whoever creates the Lab hands in
 * a small adapter (or null when nothing is available, e.g. inside a sandboxed iframe). Every call is guarded here:
 * an adapter that throws only switches `available` off — the lab keeps working in memory.
 */
import type { UiSettings } from '../labapi.ts';
import { defaultSettings } from '../world.ts';

export interface LabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Every key the adapter holds (the Lab only looks at its own prefix). */
  keys(): string[];
}

export const STORAGE_PREFIX = 'kss-netlab:';
export const SETTINGS_KEY = `${STORAGE_PREFIX}settings`;
export const INDEX_KEY = `${STORAGE_PREFIX}index`;
export const SLOT_PREFIX = `${STORAGE_PREFIX}lab:`;
const PROBE_KEY = `${STORAGE_PREFIX}probe`;

/** Guarded access to a LabStorage. `available` is false when there is no adapter or the last call failed. */
export class SafeStore {
  private store: LabStorage | null;
  available: boolean;

  constructor(store: LabStorage | null | undefined) {
    this.store = store ?? null;
    this.available = false;
    this.probe();
  }

  /** true when an adapter was handed in (it may still be failing right now). */
  get present(): boolean { return this.store !== null; }

  /** Write and remove a test key. */
  probe(): boolean {
    if (!this.store) { this.available = false; return false; }
    try {
      this.store.setItem(PROBE_KEY, '1');
      this.store.removeItem(PROBE_KEY);
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  get(key: string): string | null {
    if (!this.store) return null;
    try {
      const v = this.store.getItem(key);
      return typeof v === 'string' ? v : null;
    } catch {
      this.available = false;
      return null;
    }
  }

  set(key: string, value: string): boolean {
    if (!this.store) return false;
    try {
      this.store.setItem(key, value);
      this.available = true;
      return true;
    } catch {
      this.available = false;
      return false;
    }
  }

  remove(key: string): boolean {
    if (!this.store) return false;
    try {
      this.store.removeItem(key);
      return true;
    } catch {
      this.available = false;
      return false;
    }
  }

  keys(): string[] {
    if (!this.store) return [];
    try {
      const k = this.store.keys();
      return Array.isArray(k) ? k.filter((x) => typeof x === 'string') : [];
    } catch {
      this.available = false;
      return [];
    }
  }
}

// ───────────────────────────── settings ─────────────────────────────
export const DEFAULT_SETTINGS: UiSettings = {
  ...defaultSettings(), fontScale: 1, font: 'lexend', terminalFontPx: 14, terminalPaging: true, reduceMotion: false,
};
const FONTS: UiSettings['font'][] = ['lexend', 'atkinson', 'system'];

function clamp(n: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, n)); }

/** `base` with every valid field of `raw` laid over it. Invalid or unknown fields are ignored; numbers are clamped. */
export function mergeSettings(base: UiSettings, raw: unknown): UiSettings {
  const out: UiSettings = { ...base };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.strictCables === 'boolean') out.strictCables = r.strictCables;
  if (typeof r.qosClassifiesInnerHeader === 'boolean') out.qosClassifiesInnerHeader = r.qosClassifiesInnerHeader;
  if (typeof r.fontScale === 'number' && Number.isFinite(r.fontScale)) out.fontScale = Math.round(clamp(r.fontScale, 0.85, 1.4) * 100) / 100;
  if (typeof r.font === 'string' && (FONTS as string[]).includes(r.font)) out.font = r.font as UiSettings['font'];
  if (typeof r.terminalFontPx === 'number' && Number.isFinite(r.terminalFontPx)) out.terminalFontPx = Math.round(clamp(r.terminalFontPx, 10, 32));
  if (typeof r.terminalPaging === 'boolean') out.terminalPaging = r.terminalPaging;
  if (typeof r.reduceMotion === 'boolean') out.reduceMotion = r.reduceMotion;
  return out;
}

export function sameSettings(a: UiSettings, b: UiSettings): boolean {
  return a.strictCables === b.strictCables && a.qosClassifiesInnerHeader === b.qosClassifiesInnerHeader
    && a.fontScale === b.fontScale && a.font === b.font
    && a.terminalFontPx === b.terminalFontPx && a.terminalPaging === b.terminalPaging && a.reduceMotion === b.reduceMotion;
}
