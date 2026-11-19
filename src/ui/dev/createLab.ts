/**
 * The ONE place that decides which LabApi implementation the app uses. main.tsx calls createLab().
 *
 * Normal use: the real Lab (src/engine/lab.ts) with a guarded localStorage adapter. When the browser gives no
 * storage (private mode, sandboxed iframe) the adapter is null: the lab still works, it only cannot save.
 *
 * URL switches:
 *   ?start=<scenarioId>&mode=<guided|free|exam>   start this assignment right away
 *   ?resume                                       open the most recently saved lab
 *   ?nostorage                                    run without saving (as inside a sandbox)
 *   ?mock                                         UI development: use the in-memory MockLab instead of the engine
 *                                                 (it understands ?start, ?mode, ?resume and ?nostorage as before)
 * Note: labContext.tsx passes lab.getState and lab.subscribe UNBOUND to useSyncExternalStore; both implementations
 * define them as bound arrow-function fields.
 */
import type { LabApi } from '../../engine/labapi.ts';
import type { LabMode } from '../../engine/types.ts';
import type { LabStorage } from '../../engine/lab.ts';
import { Lab } from '../../engine/lab.ts';
import { MockLab } from './mockLab.ts';
import { notify } from '../notify.ts';

/** localStorage behind try/catch on every access. null when the browser has none or refuses to hand it out. */
export function browserStorage(): LabStorage | null {
  let ls: Storage;
  try {
    ls = window.localStorage;
    if (!ls) return null;
    const probe = 'kss-netlab:probe';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
  } catch {
    return null;
  }
  // The Lab guards every call itself as well (a failing call switches saving off, nothing else).
  return {
    getItem: (key) => { try { return ls.getItem(key); } catch { return null; } },
    setItem: (key, value) => { ls.setItem(key, value); },
    removeItem: (key) => { try { ls.removeItem(key); } catch { /* ignore */ } },
    keys: () => {
      const out: string[] = [];
      try {
        for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (typeof k === 'string') out.push(k); }
      } catch { /* ignore */ }
      return out;
    },
  };
}

export function createLab(): LabApi {
  let params = new URLSearchParams();
  try { params = new URLSearchParams(window.location.search); } catch { /* sandboxed: ignore */ }
  const modeParam = params.get('mode');
  const mode: LabMode = modeParam === 'exam' || modeParam === 'guided' ? modeParam : 'free';
  const start = params.get('start');

  if (params.has('mock')) {
    const mock = new MockLab({
      storage: !params.has('nostorage'),
      resume: params.has('resume'),
      start: start ? { id: start, mode } : undefined,
    });
    // Mock only: a handle for driving the UI from the browser console during testing.
    try {
      const w = window as unknown as { __kssMockLab?: MockLab; __kssNotify?: typeof notify };
      w.__kssMockLab = mock;
      w.__kssNotify = notify;
    } catch { /* ignore */ }
    return mock;
  }

  const lab = new Lab({ storage: params.has('nostorage') ? null : browserStorage() });
  try {
    if (start) {
      const r = lab.startScenario(start, mode, { timerMinutes: mode === 'exam' ? 180 : null });
      if (!r.ok) notify({ kind: 'bad', title: 'Could not start this assignment', text: r.message ?? `There is no assignment called "${start}".` });
    } else if (params.has('resume')) {
      const last = lab.getState().storage.saved[0];
      if (last) lab.loadSaved(last.id);
    }
  } catch { /* the start page still works */ }
  // A handle for looking at the lab from the browser console.
  try {
    const w = window as unknown as { __kssLab?: Lab; __kssNotify?: typeof notify };
    w.__kssLab = lab;
    w.__kssNotify = notify;
  } catch { /* ignore */ }
  return lab;
}
