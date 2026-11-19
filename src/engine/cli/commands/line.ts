/**
 * line console 0 / line vty <first> [<last>] / line aux 0, and the line sub-commands
 * (password, login, login local, no login, logging synchronous, exec-timeout, transport input, access-class,
 * history size, privilege level, length, stopbits).
 *
 * session.ctx in config-line: { lineType: 'console' | 'vty' | 'aux', first: number, last: number }
 *
 * `config.lines.vty` is kept as sorted, non-overlapping ranges. Selecting lines that do not exist creates them
 * (default settings: `login`). A setting is applied to every selected line: ranges are split at the selection
 * boundaries, then neighbours with identical settings are merged again — except across the built-in 0–4 | 5+
 * boundary, which IOS always prints as separate `line vty 0 4` / `line vty 5 …` blocks (and the course's reference
 * configuration shows them that way).
 *
 * Feature: all line sub-commands are 'vty' (one CommandDef serves console and vty lines alike).
 * `privilege level 15` is kept in LineConfig.extraLines and honoured by the login hook in exec.ts.
 */
import type { CmdEnv, CommandDef } from '../framework.ts';
import { DEFAULT_TERMINAL_LENGTH, registerCommands } from '../framework.ts';
import type { IosConfig, IosDevice, LineConfig, VtyRange } from '../../types.ts';
import { invalidToken, parseSecretArg, setExtra, NOT_SIMULATED } from './system.ts';

export const VTY_MAX = 15;
const MAX_LINE_LENGTH = 512;

/** Configured length of a line, used as the initial screen length of a session. */
export function lineTerminalLength(line: LineConfig): number {
  const match = line.extraLines?.map((l) => /^length (\d+)$/.exec(l)).find(Boolean);
  return match && Number(match[1]) <= MAX_LINE_LENGTH ? Number(match[1]) : DEFAULT_TERMINAL_LENGTH;
}
export interface LineCtx { lineType: 'console' | 'vty' | 'aux'; first: number; last: number }

// ───────────────────────────── vty range helpers ─────────────────────────────
function settingsOf(r: VtyRange): LineConfig {
  const { first: _f, last: _l, ...rest } = r;
  void _f; void _l;
  return rest;
}
function canon(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ':' + canon((v as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
function sameSettings(a: VtyRange, b: VtyRange): boolean {
  const sa = settingsOf(a), sb = settingsOf(b);
  if (sa.extraLines && !sa.extraLines.length) delete sa.extraLines;
  if (sb.extraLines && !sb.extraLines.length) delete sb.extraLines;
  return canon(sa) === canon(sb);
}
/** Sort and merge neighbours with identical settings (never across 4|5). */
export function normalizeVty(cfg: IosConfig): void {
  const list = [...cfg.lines.vty].sort((a, b) => a.first - b.first);
  const out: VtyRange[] = [];
  for (const r of list) {
    const prev = out[out.length - 1];
    if (prev && prev.last + 1 === r.first && !(prev.last === 4 && r.first === 5) && sameSettings(prev, r)) prev.last = r.last;
    else out.push(r);
  }
  cfg.lines.vty = out;
}
/** Create missing lines first..last with default vty settings. */
export function ensureVty(cfg: IosConfig, first: number, last: number): void {
  for (let n = first; n <= last; n++) {
    if (cfg.lines.vty.some((r) => r.first <= n && n <= r.last)) continue;
    cfg.lines.vty.push({ first: n, last: n, login: true });
  }
  normalizeVty(cfg);
}
/** Split ranges so that first..last are covered by whole ranges; returns those ranges. */
function splitVty(cfg: IosConfig, first: number, last: number): VtyRange[] {
  const out: VtyRange[] = [];
  for (const r of cfg.lines.vty) {
    const pieces: [number, number][] = [];
    if (r.last < first || r.first > last) { out.push(r); continue; }
    if (r.first < first) pieces.push([r.first, first - 1]);
    pieces.push([Math.max(r.first, first), Math.min(r.last, last)]);
    if (r.last > last) pieces.push([last + 1, r.last]);
    for (const [a, b] of pieces) out.push({ ...structuredClone(r), first: a, last: b });
  }
  cfg.lines.vty = out.sort((a, b) => a.first - b.first);
  return cfg.lines.vty.filter((r) => r.first >= first && r.last <= last);
}
/** Apply `fn` to every vty line first..last (creating them if needed), then normalize. */
export function applyVty(cfg: IosConfig, first: number, last: number, fn: (l: LineConfig) => void): void {
  ensureVty(cfg, first, last);
  for (const r of splitVty(cfg, first, last)) fn(r);
  normalizeVty(cfg);
}
export function vtyLineNumbers(cfg: IosConfig): number[] {
  const out: number[] = [];
  for (const r of cfg.lines.vty) for (let n = r.first; n <= r.last; n++) out.push(n);
  return out.sort((a, b) => a - b);
}
export function vtyLine(cfg: IosConfig, n: number): VtyRange | undefined {
  return cfg.lines.vty.find((r) => r.first <= n && n <= r.last);
}
/** Absolute line number as IOS prints it (`show line`, `% Login disabled on line N`). ISR 4331: 0 CTY, 1 AUX, 2+ VTY. */
export function absoluteLine(dev: IosDevice, type: 'console' | 'vty' | 'aux', n: number): number {
  if (type === 'console') return 0;
  if (type === 'aux') return 1;
  return n + (dev.kind === 'router' ? 2 : 1);
}

// ───────────────────────────── sub-command plumbing ─────────────────────────────
function ctxOf(env: CmdEnv): LineCtx {
  const c = env.session.ctx as Partial<LineCtx>;
  return { lineType: c.lineType ?? 'console', first: c.first ?? 0, last: c.last ?? 0 };
}
/** Run `fn` on each selected line. Returns the absolute numbers of lines touched, with their config. */
function forLines(env: CmdEnv, fn: (l: LineConfig) => void): { abs: number; cfg: LineConfig }[] {
  const ctx = ctxOf(env);
  const cfg = env.device.config;
  if (ctx.lineType === 'aux') { env.note(NOT_SIMULATED + 'the AUX line (the simulator has no modem port).'); return []; }
  if (ctx.lineType === 'console') { fn(cfg.lines.console); return [{ abs: 0, cfg: cfg.lines.console }]; }
  applyVty(cfg, ctx.first, ctx.last, fn);
  const out: { abs: number; cfg: LineConfig }[] = [];
  for (let n = ctx.first; n <= ctx.last; n++) { const l = vtyLine(cfg, n); if (l) out.push({ abs: absoluteLine(env.device, 'vty', n), cfg: l }); }
  return out;
}
function extra(l: LineConfig, line: string, key: number, mode: 'set' | 'remove' = 'set'): void {
  if (!l.extraLines) l.extraLines = [];
  setExtra(l.extraLines, line, key, mode);
  if (!l.extraLines.length) delete l.extraLines;
}

const HL: Record<string, string> = {
  line: 'Configure a terminal line',
  console: 'Primary terminal line',
  vty: 'Virtual terminal',
  aux: 'Auxiliary line',
  '<first>': 'First Line number',
  '<last>': 'Last Line number',
  '0': 'First Line number',
};
const HS: Record<string, string> = {
  password: 'Set a password',
  login: 'Enable password checking',
  local: 'Local password checking',
  logging: 'Modify message logging facilities',
  synchronous: 'Synchronized message output',
  'exec-timeout': 'Set the EXEC timeout',
  transport: 'Define transport protocols for line',
  input: 'Define which protocols to use when connecting to the terminal server',
  all: 'All protocols',
  none: 'No protocols',
  telnet: 'TCP/IP Telnet protocol',
  ssh: 'TCP/IP SSH protocol',
  'access-class': 'Filter connections based on an IP access list',
  in: 'Filter incoming connections',
  out: 'Filter outgoing connections',
  'vrf-also': 'Same access list is applied for all VRFs',
  history: 'Enable and control the command history function',
  size: 'Set history buffer size',
  privilege: 'Change privilege level for line',
  level: 'Assign default privilege level for line',
  length: 'Set number of lines on a screen',
  stopbits: 'Set async line stop bits',
  no: 'Negate a command or set its defaults',
  '0': 'Specifies an UNENCRYPTED password will follow',
  '7': 'Specifies a HIDDEN password will follow',
  '<pw>': 'The UNENCRYPTED (cleartext) line password',
  '<acl>': 'IP access list name or number',
  '<min>': 'Timeout in minutes',
  '<sec>': 'Timeout in seconds',
};

export const commands: CommandDef[] = [
  // ── navigation ──
  {
    modes: 'config', pattern: 'line console 0', feature: 'system', mutates: false, help: HL,
    run(env) { env.setMode('config-line', { lineType: 'console', first: 0, last: 0 }); },
  },
  {
    modes: 'config', pattern: 'line aux 0', feature: 'system', mutates: false, help: HL, kinds: ['router'],
    run(env) {
      env.setMode('config-line', { lineType: 'aux', first: 0, last: 0 });
      env.note(NOT_SIMULATED + 'the AUX line (the simulator has no modem port).');
    },
  },
  {
    modes: 'config', pattern: `line vty <first:int(0-${VTY_MAX})> [<last:int(0-${VTY_MAX})>]`, feature: 'vty', mutates: false, help: HL,
    run(env, a) {
      const first = Number(a.first);
      const last = a.last === undefined ? first : Number(a.last);
      // IOS offers <first+1 - 15> for the last line number
      if (a.last !== undefined && last <= first) invalidToken(env, 3);
      ensureVty(env.device.config, first, last);
      env.setMode('config-line', { lineType: 'vty', first, last });
    },
  },
  {
    modes: 'config', pattern: `no line vty <first:int(0-${VTY_MAX})> [<last:int(0-${VTY_MAX})>]`, feature: 'vty', help: HL,
    run(env, a) {
      const first = Number(a.first);
      const last = a.last === undefined ? first : Number(a.last);
      if (a.last !== undefined && last <= first) invalidToken(env, 4);
      if (first < 5) env.reject("% Can't delete last 5 VTY lines");
      const cfg = env.device.config;
      splitVty(cfg, first, last);
      cfg.lines.vty = cfg.lines.vty.filter((r) => r.last < first || r.first > last);
      normalizeVty(cfg);
    },
  },

  // ── password ──
  {
    modes: 'config-line', pattern: ['password <pw:text>', 'password {t:0|7} <pw:text>'], feature: 'vty', help: HS,
    run(env, a) {
      const r = parseSecretArg(a.t ? `${a.t} ${a.pw}` : String(a.pw), 'password');
      if ('error' in r) return env.reject(r.error);
      forLines(env, (l) => { l.password = r.plain; });
    },
  },
  { modes: 'config-line', pattern: 'no password [<pw:text>]', feature: 'vty', help: HS, run(env) { forLines(env, (l) => { delete l.password; }); } },

  // ── login ──
  {
    modes: 'config-line', pattern: 'login', feature: 'vty', help: HS,
    run(env) {
      const touched = forLines(env, (l) => { l.login = true; });
      for (const t of touched) if (t.cfg.password === undefined) env.print(`% Login disabled on line ${t.abs}, until 'password' is set`);
    },
  },
  {
    modes: 'config-line', pattern: 'login local', feature: 'vty', help: HS,
    run(env) {
      forLines(env, (l) => { l.login = 'local'; });
      if (!env.device.config.users.some((u) => u.secret !== '')) env.note('No local user with a password exists yet. Create one with: username <name> secret <password>');
    },
  },
  { modes: 'config-line', pattern: ['no login', 'no login local'], feature: 'vty', help: HS, run(env) { forLines(env, (l) => { l.login = false; }); } },

  // ── logging synchronous ──
  {
    modes: 'config-line', pattern: ['logging synchronous', 'no logging synchronous'], feature: 'vty', help: HS,
    run(env) {
      const on = !env.has('no');
      forLines(env, (l) => { if (on) l.loggingSynchronous = true; else delete l.loggingSynchronous; });
      env.note('Line setting stored. The simulated console queues status messages regardless of logging synchronous.');
    },
  },

  // ── exec-timeout ──
  {
    modes: 'config-line', pattern: 'exec-timeout <min:int(0-35791)> [<sec:int(0-2147483)>]', feature: 'vty', help: HS,
    run(env, a) {
      const v: [number, number] = [Number(a.min), a.sec === undefined ? 0 : Number(a.sec)];
      forLines(env, (l) => { if (v[0] === 10 && v[1] === 0) delete l.execTimeout; else l.execTimeout = v; });
      env.note(NOT_SIMULATED + 'idle timeouts (sessions never time out in the simulator).');
    },
  },
  { modes: 'config-line', pattern: 'no exec-timeout [<min:int(0-35791)> [<sec:int(0-2147483)>]]', feature: 'vty', help: HS, run(env) { forLines(env, (l) => { delete l.execTimeout; }); } },

  // ── transport input ──
  {
    modes: 'config-line', pattern: ['transport input {p:all|none}', 'transport input telnet [ssh]', 'transport input ssh [telnet]'], feature: 'vty', help: HS,
    run(env, a) {
      const t = env.has('telnet'), s = env.has('ssh');
      const v: LineConfig['transportInput'] = a.p ? a.p as 'all' | 'none' : t && s ? 'telnet ssh' : t ? 'telnet' : 'ssh';
      forLines(env, (l) => { l.transportInput = v; });
      if (v === 'ssh') env.note('With transport input ssh, Telnet to these lines is refused. NetLab probes the TCP 22 path but does not run an SSH server.');
      else if (s) env.note('SSH transport is saved as configuration only. NetLab probes the TCP 22 path but does not run an SSH server.');
    },
  },
  { modes: 'config-line', pattern: 'no transport input [<rest:text>]', feature: 'vty', help: HS, run(env) { forLines(env, (l) => { delete l.transportInput; }); } },

  // ── access-class ──
  {
    modes: 'config-line', pattern: 'access-class <acl:word> {dir:in|out} [vrf-also]', feature: 'vty', help: HS,
    run(env, a) {
      const acl = String(a.acl);
      forLines(env, (l) => { if (a.dir === 'in') l.accessClassIn = acl; else l.accessClassOut = acl; });
      if (a.dir === 'out') env.note(NOT_SIMULATED + 'outgoing access-class (it filters Telnet sessions started from this router).');
    },
  },
  {
    modes: 'config-line', pattern: ['no access-class <acl:word> {dir:in|out} [vrf-also]', 'no access-class'], feature: 'vty', help: HS,
    run(env, a) {
      forLines(env, (l) => {
        if (!a.dir || a.dir === 'in') { if (!a.acl || l.accessClassIn === a.acl) delete l.accessClassIn; }
        if (!a.dir || a.dir === 'out') { if (!a.acl || l.accessClassOut === a.acl) delete l.accessClassOut; }
      });
    },
  },

  // ── accepted, not simulated ──
  {
    modes: 'config-line', pattern: ['history size <n:int(0-256)>', 'no history size [<n:int(0-256)>]'], feature: 'vty', help: HS,
    run(env, a) {
      const no = env.has('no');
      forLines(env, (l) => extra(l, `history size ${a.n ?? ''}`.trim(), 2, no || Number(a.n) === 20 ? 'remove' : 'set'));
      env.note(NOT_SIMULATED + 'the history size.');
    },
  },
  {
    modes: 'config-line', pattern: ['privilege level <n:int(0-15)>', 'no privilege level [<n:int(0-15)>]'], feature: 'vty', help: HS,
    run(env, a) {
      const no = env.has('no');
      forLines(env, (l) => extra(l, `privilege level ${a.n ?? ''}`.trim(), 2, no || Number(a.n) === 1 ? 'remove' : 'set'));
      // level 15 is simulated (the session starts in privileged EXEC); other levels behave like level 1
      if (!no && Number(a.n) !== 15 && Number(a.n) !== 1) env.note(NOT_SIMULATED + 'privilege levels other than 1 and 15.');
    },
  },
  {
    modes: 'config-line', pattern: [`length <n:int(0-${MAX_LINE_LENGTH})>`, 'no length'], feature: 'vty', help: HS,
    run(env, a) {
      const remove = env.has('no') || Number(a.n) === DEFAULT_TERMINAL_LENGTH;
      forLines(env, (l) => extra(l, `length ${a.n ?? ''}`.trim(), 1, remove ? 'remove' : 'set'));
      env.note('New sessions inherit this CLI length. Use terminal length in the Workbench to change the browser pager.');
    },
  },
  {
    modes: 'config-line', pattern: ['stopbits {n:1|1.5|2}', 'no stopbits'], feature: 'vty', help: HS,
    // `stopbits 1` is what the ISR 4300 console uses out of the box: nothing to store
    run(env, a) { const no = env.has('no'); forLines(env, (l) => extra(l, `stopbits ${a.n ?? ''}`.trim(), 1, no || a.n === '1' ? 'remove' : 'set')); },
  },
];

let installed = false;
export function install(): void { if (installed) return; installed = true; registerCommands(commands); }
