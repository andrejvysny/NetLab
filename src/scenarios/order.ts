/**
 * Order observations from the journal: calm, factual notes about the sequence of work (something applied before it
 * existed, configuration before cabling, clock rate on the DTE end, unsaved work, a command typed on the wrong router).
 * They never cost points. Owned by the scenario agent.
 */
import type { JournalEntry, OrderIssue, World } from '../engine/types.ts';
import { isIos } from '../engine/world.ts';
import { renderRunningConfig } from '../engine/config/render.ts';

/** `tok` is an abbreviation of `full` with at least `min` letters. */
function kw(tok: string | undefined, full: string, min = 1): boolean {
  if (!tok) return false;
  const t = tok.toLowerCase();
  return t.length >= min && full.startsWith(t);
}
function words(line: string): string[] { return line.trim().split(/\s+/).filter((w) => w.length > 0); }
function norm(line: string): string { return words(line).join(' ').toLowerCase(); }

type Place = 'exec' | 'config' | 'if' | 'line' | 'sub';
interface Seen { defined: { acl: Set<string>; map: Set<string>; policy: Set<string> } }

/** Where a line was typed. Uses the recorded CLI mode; for pasted files the indentation and the block above decide. */
function placeOf(e: JournalEntry, lastTop: Map<string, string>): Place {
  const mode = e.mode;
  if (mode === 'user' || mode === 'priv') return 'exec';
  if (mode === 'config') return 'config';
  if (mode === 'config-if') return 'if';
  if (mode === 'config-line') return 'line';
  if (mode) return 'sub';
  if (!/^\s/.test(e.line)) return 'config';
  const top = words(lastTop.get(e.deviceId) ?? '');
  if (kw(top[0], 'interface', 3)) return 'if';
  if (kw(top[0], 'line', 2)) return 'line';
  return 'sub';
}

interface Parsed {
  defAcl?: string; defMap?: string; defPolicy?: string;
  useAcl?: string; useMap?: string; usePolicy?: string;
  clock?: boolean; save?: boolean;
}
function parse(line: string, place: Place): Parsed {
  const w = words(line);
  const out: Parsed = {};
  if (w.length === 0) return out;
  if (place === 'exec') {
    if ((kw(w[0], 'copy', 3) && kw(w[1], 'running-config', 1) && kw(w[2], 'startup-config', 1))
      || (kw(w[0], 'write', 2) && (w.length === 1 || kw(w[1], 'memory', 1)))) out.save = true;
    return out;
  }
  // Definitions are global commands. IOS accepts them from any configuration sub-mode, so they are recognised everywhere.
  if (kw(w[0], 'access-list', 2) && w[1] && w[2]) out.defAcl = w[1];
  else if (kw(w[0], 'ip', 2) && kw(w[1], 'access-list', 8) && w[3] && (kw(w[2], 'standard', 1) || kw(w[2], 'extended', 1))) out.defAcl = w[3];
  else if (kw(w[0], 'crypto', 2) && kw(w[1], 'map', 1) && w[2] && /^\d+$/.test(w[3] ?? '')) out.defMap = w[2];
  else if (kw(w[0], 'policy-map', 1) && w[1]) out.defPolicy = w[1];
  if (out.defAcl || out.defMap || out.defPolicy) return out;
  if (place === 'if') {
    if (kw(w[0], 'ip', 2) && kw(w[1], 'access-group', 8) && w[2]) out.useAcl = w[2];
    else if (kw(w[0], 'crypto', 2) && kw(w[1], 'map', 1) && w[2]) out.useMap = w[2];
    else if (kw(w[0], 'service-policy', 1) && w[2] && (kw(w[1], 'output', 1) || kw(w[1], 'input', 1))) out.usePolicy = w[2];
    else if (kw(w[0], 'clock', 2) && kw(w[1], 'rate', 1)) out.clock = true;
    return out;
  }
  if (place === 'line') {
    if (kw(w[0], 'access-class', 8) && w[1]) out.useAcl = w[1];
  }
  return out;
}

function seedFromConfig(text: string | undefined): Seen {
  const seen: Seen = { defined: { acl: new Set(), map: new Set(), policy: new Set() } };
  for (const raw of (text ?? '').split(/\r?\n/)) {
    if (/^\s/.test(raw)) continue;
    const p = parse(raw, 'config');
    if (p.defAcl) seen.defined.acl.add(p.defAcl);
    if (p.defMap) seen.defined.map.add(p.defMap);
    if (p.defPolicy) seen.defined.policy.add(p.defPolicy);
  }
  return seen;
}

export interface OrderOptions {
  /** Configuration the scenario put on the devices before the student started. */
  initialConfigs?: Record<string, string>;
  /** The student cables the bench in this scenario. */
  cablingIsTask: boolean;
  /** Number of network cables the bench needs (console cables not counted). Later re-plugging counts as repair, not as late cabling. */
  cablesNeeded?: number;
}

export function orderIssues(world: World, journal: JournalEntry[], opts: OrderOptions): OrderIssue[] {
  const issues: OrderIssue[] = [];
  const seen = new Map<string, Seen>();
  const state = (dev: string): Seen => {
    let s = seen.get(dev);
    if (!s) { s = seedFromConfig(opts.initialConfigs?.[dev]); seen.set(dev, s); }
    return s;
  };
  const lastTop = new Map<string, string>();
  const told = new Set<string>();
  const once = (key: string, issue: OrderIssue): void => { if (!told.has(key)) { told.add(key); issues.push(issue); } };
  const name = (dev: string): string => world.devices[dev]?.label ?? dev;

  let firstConfig: JournalEntry | undefined;
  let lastCable: JournalEntry | undefined;
  let plugged = 0;
  const needed = Math.max(1, opts.cablesNeeded ?? 1);
  const lastChange = new Map<string, number>();
  const lastSave = new Map<string, number>();
  const typed: { dev: string; text: string; tick: number; raw: string }[] = [];
  const removed: { dev: string; text: string; tick: number }[] = [];

  for (const e of Array.isArray(journal) ? journal : []) {
    if (!e || typeof e.line !== 'string' || e.blocked) continue;
    if (e.via === 'bench') {
      // The bench is "cabled" once as many network cables were plugged in as the topology needs.
      if (e.ok && e.feature === 'cabling' && !/console|rollover/i.test(e.line) && !/^\s*(remove|unplug|disconnect)/i.test(e.line)) {
        plugged += 1;
        if (plugged <= needed) lastCable = e;
      }
      continue;
    }
    if (e.via === 'pc') continue;
    const place = placeOf(e, lastTop);
    if (!/^\s/.test(e.line) && place !== 'exec' && !e.mode) lastTop.set(e.deviceId, e.line);
    const p = parse(e.line, place);
    const st = state(e.deviceId);
    const dev = name(e.deviceId);
    if (place === 'exec') {
      if (p.save && e.ok) lastSave.set(e.deviceId, e.tick);
      continue;
    }
    if (e.ok && e.mutated) {
      firstConfig ??= e;
      lastChange.set(e.deviceId, e.tick);
      const text = norm(e.line);
      if (text.startsWith('no ')) removed.push({ dev: e.deviceId, text: text.slice(3), tick: e.tick });
      else typed.push({ dev: e.deviceId, text, tick: e.tick, raw: e.line.trim() });
    }
    if (p.defAcl && e.ok) st.defined.acl.add(p.defAcl);
    if (p.defMap && e.ok) st.defined.map.add(p.defMap);
    if (p.defPolicy && e.ok) st.defined.policy.add(p.defPolicy);
    if (p.useAcl && !st.defined.acl.has(p.useAcl)) {
      once(`acl:${e.deviceId}:${p.useAcl}`, {
        tick: e.tick, deviceId: e.deviceId, line: e.line.trim(), severity: 'info',
        text: `On ${dev}, access list ${p.useAcl} was applied before it existed. An empty list filters nothing, and the first line you add switches on the hidden deny for everything else. It is safer to build the list first and apply it last.`,
      });
    }
    if (p.useMap && !st.defined.map.has(p.useMap)) {
      once(`map:${e.deviceId}:${p.useMap}`, {
        tick: e.tick, deviceId: e.deviceId, line: e.line.trim(), severity: 'info',
        text: `On ${dev}, crypto map ${p.useMap} was put on the interface before it existed. The router refuses that. Create the crypto map first, then apply it.`,
      });
    }
    if (p.usePolicy && !st.defined.policy.has(p.usePolicy)) {
      once(`policy:${e.deviceId}:${p.usePolicy}`, {
        tick: e.tick, deviceId: e.deviceId, line: e.line.trim(), severity: 'info',
        text: `On ${dev}, policy ${p.usePolicy} was attached before the policy-map existed. The router refuses that. Create the policy-map first, then attach it.`,
      });
    }
    if (p.clock && !e.ok) {
      once(`clock:${e.deviceId}`, {
        tick: e.tick, deviceId: e.deviceId, line: e.line.trim(), severity: 'info',
        text: `clock rate was typed on ${dev} and was rejected. Check that it is a cabled serial port with the DCE end and that the requested rate is supported. show controllers serial identifies the cable end.`,
      });
    }
  }

  if (opts.cablingIsTask && firstConfig && (plugged < needed || (lastCable && firstConfig.tick < lastCable.tick))) {
    issues.push({
      tick: firstConfig.tick, deviceId: firstConfig.deviceId, line: firstConfig.line.trim(), severity: 'info',
      text: 'Configuration was typed before data cabling was finished. Either order can work; cabling first lets you verify each link as you configure it.',
    });
  }

  // A command typed on one router, removed there, and typed on another router.
  for (const r of removed) {
    // Short toggles such as "shutdown" / "no shutdown" are normal work, not a detour.
    if (r.text.split(' ').length < 3) continue;
    const before = typed.find((t) => t.dev === r.dev && t.text === r.text && t.tick < r.tick);
    if (!before) continue;
    const elsewhere = typed.find((t) => t.dev !== r.dev && t.text === r.text);
    if (!elsewhere) continue;
    once(`moved:${r.dev}:${r.text}`, {
      tick: before.tick, deviceId: r.dev, line: before.raw, severity: 'info',
      text: `"${before.raw}" was typed on ${name(r.dev)}, removed again, and typed on ${name(elsewhere.dev)}. The prompt shows the router name: a quick look before typing saves the detour.`,
    });
  }

  // Changes that were never saved.
  for (const [devId, changed] of lastChange) {
    const d = world.devices[devId];
    if (!isIos(d)) continue;
    const saved = lastSave.get(devId);
    if (saved !== undefined && saved >= changed) continue;
    let upToDate = false;
    try { upToDate = d.startupConfig !== null && d.startupConfig === renderRunningConfig(world, devId); } catch { upToDate = false; }
    if (upToDate) continue;
    issues.push({
      tick: changed, deviceId: devId, severity: 'warn',
      text: saved === undefined
        ? `${name(devId)} was configured but never saved. After a restart it would be empty. Finish with copy running-config startup-config.`
        : `${name(devId)} was changed after the last save. Type copy running-config startup-config once more at the end.`,
    });
  }
  return issues.sort((a, b) => a.tick - b.tick);
}
