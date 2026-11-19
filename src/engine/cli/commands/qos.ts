/**
 * QoS (MQC) — feature 'qos'.
 *
 * Global:      class-map [match-all|match-any] <name> · policy-map <name> · no forms
 * Sub-modes:   config-cmap (match …, description) · config-pmap (class, description) ·
 *              config-pmap-c (priority, bandwidth, fair-queue, shape average, police, queue-limit, service-policy,
 *                             set [ip] dscp|precedence, random-detect; `class` / `no class` also work here like on IOS)
 * Interface:   service-policy {input|output} <policy-map> · no service-policy {input|output} [<name>]
 * Legacy queueing (priority-list, queue-list, priority-group, custom-queue-list, interface fair-queue) does not exist on
 * IOS XE: answered with "% Invalid input detected at '^' marker." plus a simulator note.
 *
 * session.ctx keys defined here:
 *   config-cmap    { classMap: string }                 (class-map name)
 *   config-pmap    { policy: string }                   (policy-map name)
 *   config-pmap-c  { policy: string; class: string }    (policy-map name + class name, 'class-default' included)
 */
import type { ClassMap, ClassMatch, InterfaceConfig, PolicyClass, PolicyMap, QosConfig } from '../../types.ts';
import type { CmdEnv, CommandDef } from '../framework.ts';
import { currentInterfaces, promptFor, registerCommands } from '../framework.ts';

// ───────────────────────────── IOS messages ─────────────────────────────
export const MSG = {
  classNotConfigured: (n: string) => `% class map ${n} not configured`,
  policyNotConfigured: (n: string) => `% policy map ${n} not configured`,
  classMapInUse: (n: string) => `Class-map ${n} is being used`,
  consistentUnits: 'All classes with bandwidth should have consistent units',
  invalidInput: "% Invalid input detected at '^' marker.",
  // Wording of the messages below could not be verified against a real IOS XE 17.3 router.
  policyMapInUse: (n: string) => `Policy-map ${n} is being used`,
  sumExceeds: 'Sum total of class bandwidths exceeds 100 percent',
  priorityAndBandwidth: 'Priority and bandwidth are not allowed in the same class',
  selfChild: (n: string) => `% Policy map ${n} cannot be used as a child of itself`,
  alreadyAttached: (dir: string, n: string) => `% Service policy ${n} is already attached to this interface in the ${dir} direction`,
  queueingInput: '% Queueing features (priority, bandwidth, shape, fair-queue, queue-limit) are not supported in the input direction',
  reservedClass: '% class-default is a reserved class name',
};
export const LEGACY_NOTE = 'Legacy queueing is not available on IOS XE routers such as the ISR 4331. Use class-map, policy-map and service-policy instead.';

// ───────────────────────────── DSCP / precedence ─────────────────────────────
const DSCP_NAMES: Record<string, number> = {
  default: 0, cs1: 8, af11: 10, af12: 12, af13: 14, cs2: 16, af21: 18, af22: 20, af23: 22, cs3: 24, af31: 26, af32: 28, af33: 30,
  cs4: 32, af41: 34, af42: 36, af43: 38, cs5: 40, ef: 46, cs6: 48, cs7: 56,
};
const PREC_NAMES: Record<string, number> = { routine: 0, priority: 1, immediate: 2, flash: 3, 'flash-override': 4, critical: 5, internet: 6, network: 7 };
/** IOS prints DSCP values by name when one exists ('46' → 'ef'). Returns null for invalid input. */
export function normalizeDscp(v: string): string | null {
  const low = v.toLowerCase();
  if (low in DSCP_NAMES) return low;
  if (/^\d+$/.test(low) && Number(low) <= 63) return Object.keys(DSCP_NAMES).find((k) => DSCP_NAMES[k] === Number(low)) ?? String(Number(low));
  return null;
}
function normalizePrecedence(v: string): string | null {
  const low = v.toLowerCase();
  if (low in PREC_NAMES) return low;
  if (/^\d+$/.test(low) && Number(low) <= 7) return String(Number(low));
  return null;
}

// ───────────────────────────── Helpers ─────────────────────────────
const cfg = (env: CmdEnv): QosConfig => env.device.config.qos;
const findClassMap = (env: CmdEnv, name: string): ClassMap | undefined => cfg(env).classMaps.find((c) => c.name === name);
const findPolicy = (env: CmdEnv, name: string): PolicyMap | undefined => cfg(env).policyMaps.find((p) => p.name === name);

function currentClassMap(env: CmdEnv): ClassMap {
  const name = String(env.session.ctx.classMap);
  let cm = findClassMap(env, name);
  if (!cm) { cm = { name, matchType: 'match-all', matches: [] }; cfg(env).classMaps.push(cm); }
  return cm;
}
function currentPolicy(env: CmdEnv): PolicyMap {
  const name = String(env.session.ctx.policy);
  let pm = findPolicy(env, name);
  if (!pm) { pm = { name, classes: [] }; cfg(env).policyMaps.push(pm); }
  return pm;
}
function currentClass(env: CmdEnv): PolicyClass {
  const pm = currentPolicy(env);
  const name = String(env.session.ctx.class);
  let pc = pm.classes.find((c) => c.className === name);
  if (!pc) { pc = { className: name }; addClass(pm, pc); }
  return pc;
}
/** class-default always stays last, like IOS shows it. */
function addClass(pm: PolicyMap, pc: PolicyClass): void {
  const def = pm.classes.findIndex((c) => c.className === 'class-default');
  if (def >= 0 && pc.className !== 'class-default') pm.classes.splice(def, 0, pc);
  else pm.classes.push(pc);
}

/** Interfaces (and directions) a policy-map is attached to, and the policy-maps that use it as a child. */
function policyUsers(env: CmdEnv, name: string): { attached: string[]; parents: string[] } {
  const attached = Object.values(env.device.config.interfaces)
    .filter((i) => i.servicePolicyIn === name || i.servicePolicyOut === name).map((i) => i.name);
  const parents = cfg(env).policyMaps.filter((p) => p.classes.some((c) => c.servicePolicy === name)).map((p) => p.name);
  return { attached, parents };
}
/** All policy-maps reachable from `name` through nested service-policy statements (name included). */
function descendants(env: CmdEnv, name: string, seen = new Set<string>()): Set<string> {
  if (seen.has(name)) return seen;
  seen.add(name);
  for (const c of findPolicy(env, name)?.classes ?? []) if (c.servicePolicy) descendants(env, c.servicePolicy, seen);
  return seen;
}
function hasQueueing(env: CmdEnv, name: string): boolean {
  for (const p of descendants(env, name)) {
    for (const c of findPolicy(env, p)?.classes ?? []) {
      if (c.priority || c.bandwidth || c.fairQueue || c.shapeAverage || c.queueLimit !== undefined) return true;
      if (c.extraLines?.some((l) => l.startsWith('random-detect'))) return true;
    }
  }
  return false;
}

/**
 * `class X`: the framework lets any prefix of `class-default` (c, cl, class…) select the keyword. A class-map whose
 * exact name was typed wins over that abbreviation.
 */
function className(env: CmdEnv, captured: unknown): string {
  if (!env.has('class-default')) return String(captured);
  const typed = tokens(env.line).at(-1)?.text ?? '';
  return typed.toLowerCase() !== 'class-default' && findClassMap(env, typed) ? typed : 'class-default';
}

type BwUnit = 'kbps' | 'percent' | 'remaining';
const bwUnit = (c: PolicyClass): BwUnit | undefined =>
  !c.bandwidth ? undefined : c.bandwidth.kbps !== undefined ? 'kbps' : c.bandwidth.percent !== undefined ? 'percent' : 'remaining';

/** Policy-wide checks IOS runs when a bandwidth/priority value changes in one class. */
function checkPolicy(env: CmdEnv, pm: PolicyMap, self: PolicyClass, next: { bandwidth?: PolicyClass['bandwidth']; priority?: PolicyClass['priority'] }): void {
  const others = pm.classes.filter((c) => c !== self);
  if (next.bandwidth) {
    const unit = bwUnit({ className: '', bandwidth: next.bandwidth });
    if (others.some((c) => bwUnit(c) && bwUnit(c) !== unit)) env.reject(MSG.consistentUnits);
  }
  const bwPct = (c: PolicyClass) => c.bandwidth?.percent ?? 0;
  const prPct = (c: PolicyClass) => c.priority?.percent ?? 0;
  const mineBw = next.bandwidth ? (next.bandwidth.percent ?? 0) : bwPct(self);
  const minePr = next.priority ? (next.priority.percent ?? 0) : prPct(self);
  const total = others.reduce((s, c) => s + bwPct(c) + prPct(c), 0) + mineBw + minePr;
  if (total > 100) env.reject(MSG.sumExceeds);
  const remaining = others.reduce((s, c) => s + (c.bandwidth?.remainingPercent ?? 0), 0)
    + (next.bandwidth ? (next.bandwidth.remainingPercent ?? 0) : (self.bandwidth?.remainingPercent ?? 0));
  if (remaining > 100) env.reject(MSG.sumExceeds);
}

function removeExtra(pc: PolicyClass, prefix: string): void {
  if (!pc.extraLines) return;
  pc.extraLines = pc.extraLines.filter((l) => !l.startsWith(prefix));
  if (!pc.extraLines.length) delete pc.extraLines;
}
function putExtra(pc: PolicyClass, prefix: string, line: string): void {
  removeExtra(pc, prefix);
  (pc.extraLines ??= []).push(line);
}

/** Token positions of the trimmed command line. */
function tokens(line: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = []; const re = /\S+/g; let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push({ text: m[0], start: m.index });
  return out;
}
/** The standard IOS parser error with the caret under token `index` of the line. */
function invalidAt(env: CmdEnv, index: number, note?: string): never {
  const toks = tokens(env.line);
  const at = toks[Math.min(index, toks.length - 1)]?.start ?? 0;
  if (note) env.note(note);
  return env.reject(' '.repeat((env.promptLen || promptFor(env.world, env.session).length) + at) + '^\n' + MSG.invalidInput);
}

// ───────────────────────────── Help texts ─────────────────────────────
const GLOBAL_HELP: Record<string, string> = {
  no: 'Negate a command or set its defaults',
  'class-map': 'Configure CPL Class Map',
  'match-all': 'Logical-AND all matching statements under this classmap',
  'match-any': 'Logical-OR all matching statements under this classmap',
  '<name>': 'class-map name',
  'policy-map': 'Configure QoS Policy Map',
  '<pname>': 'policy-map name',
};
const CMAP_HELP: Record<string, string> = {
  no: GLOBAL_HELP.no,
  match: 'classification criteria',
  'access-group': 'Access group',
  '<acl>': 'Access list index',
  name: 'Named Access List',
  '<aclname>': 'Access List name',
  protocol: 'Protocol',
  '<proto>': 'Protocol name (NBAR)',
  ip: 'IP specific values',
  dscp: 'Match DSCP in IPv4 and IPv6 packets',
  precedence: 'Match Precedence in IPv4 and IPv6 packets',
  '<values>': 'Up to 8 values (DSCP) or 4 values (precedence)',
  any: 'Any packets',
  description: 'Class-Map description',
  '<text>': 'Description of this class-map (up to 200 characters)',
};
const PMAP_HELP: Record<string, string> = {
  no: GLOBAL_HELP.no,
  class: 'policy criteria',
  'class-default': 'System default class matching otherwise unclassified packets',
  '<cname>': 'class-map name',
  description: 'Policy-Map description',
  '<text>': 'Description of this policy-map (up to 200 characters)',
};
const PMAPC_HELP: Record<string, string> = {
  ...PMAP_HELP,
  priority: 'Strict Scheduling Priority for this Class',
  '<kbps>': 'Kilo Bits per second',
  '<burst>': 'Burst in bytes',
  percent: '% of total bandwidth',
  '<pct>': 'percentage',
  bandwidth: 'Bandwidth',
  remaining: 'percentage of remaining bandwidth',
  'fair-queue': 'Enable Flow-based Fair Queuing in this Class',
  shape: 'Traffic Shaping',
  average: 'configure token bucket: CIR (bps) [Bc (bits) [Be (bits)]], send out Bc only per interval',
  '<bps>': 'Target Bit Rate (bits per second)',
  police: 'Police',
  cir: 'Committed information rate',
  '<rest>': 'burst sizes and actions',
  'queue-limit': 'Queue Max Threshold for Tail Drop',
  '<packets>': 'Packets by default',
  packets: 'Packets',
  'service-policy': 'Configure Flow Next',
  '<child>': 'policy-map name',
  set: 'Set QoS values',
  ip: 'Set IP specific values',
  dscp: 'Set DSCP in IP(v4) and IPv6 packets',
  precedence: 'Set precedence in IP(v4) and IPv6 packets',
  '<value>': 'Differentiated services codepoint value',
  'random-detect': 'Enable Random Early Detection as drop policy',
  'dscp-based': 'Enable dscp-based WRED as drop policy',
  'precedence-based': 'Enable precedence-based WRED as drop policy',
};
const IF_HELP: Record<string, string> = {
  no: GLOBAL_HELP.no,
  'service-policy': 'Configure CPL Service Policy',
  input: 'Assign policy-map to the input of an interface',
  output: 'Assign policy-map to the output of an interface',
  '<pname>': 'policy-map name',
};

// ───────────────────────────── Commands ─────────────────────────────
const sameMatch = (a: ClassMatch, b: ClassMatch) => JSON.stringify(a) === JSON.stringify(b);

function parseValues(env: CmdEnv, text: string, kind: 'dscp' | 'precedence'): string[] {
  const toks = tokens(env.line);
  const first = toks.length - text.trim().split(/\s+/).length;
  const vals = text.trim().split(/\s+/);
  const max = kind === 'dscp' ? 8 : 4;
  const out: string[] = [];
  vals.forEach((v, i) => {
    if (i >= max) invalidAt(env, first + i);
    const n = kind === 'dscp' ? normalizeDscp(v) : normalizePrecedence(v);
    if (n === null) invalidAt(env, first + i);
    out.push(n);
  });
  return out;
}

export const commands: CommandDef[] = [
  // ── class-map ──
  {
    modes: 'config', feature: 'qos', mutates: true,
    pattern: 'class-map [{type:match-all|match-any}] <name:word>',
    help: GLOBAL_HELP,
    run(env, a) {
      const name = String(a.name);
      if (name.toLowerCase() === 'class-default') env.reject(MSG.reservedClass);
      if (name === 'match-all' || name === 'match-any') env.reject('% Incomplete command.');
      let cm = findClassMap(env, name);
      if (!cm) { cm = { name, matchType: (a.type as ClassMap['matchType']) ?? 'match-all', matches: [] }; cfg(env).classMaps.push(cm); }
      else if (a.type) cm.matchType = a.type;
      env.setMode('config-cmap', { classMap: name });
    },
  },
  {
    modes: 'config', feature: 'qos',
    pattern: 'no class-map [{type:match-all|match-any}] <name:word>',
    help: GLOBAL_HELP,
    run(env, a) {
      const list = cfg(env).classMaps;
      const i = list.findIndex((c) => c.name === a.name);
      if (i < 0) return;
      if (cfg(env).policyMaps.some((p) => p.classes.some((c) => c.className === a.name))) env.reject(MSG.classMapInUse(a.name));
      list.splice(i, 1);
    },
  },
  {
    modes: 'config-cmap', feature: 'qos',
    pattern: [
      'match access-group <acl:int(1-2799)>', 'match access-group name <aclname:word>',
      'match protocol <proto:word>', 'match [ip] dscp <values:text>', 'match [ip] precedence <values:text>', 'match any',
      'no match access-group <acl:int(1-2799)>', 'no match access-group name <aclname:word>',
      'no match protocol <proto:word>', 'no match [ip] dscp <values:text>', 'no match [ip] precedence <values:text>', 'no match any',
    ],
    help: CMAP_HELP,
    run(env, a) {
      let m: ClassMatch;
      if (env.has('access-group')) m = { kind: 'access-group', acl: String(a.aclname ?? a.acl) };
      else if (env.has('protocol')) m = { kind: 'protocol', protocol: String(a.proto).toLowerCase() };
      else if (env.has('dscp')) m = { kind: 'dscp', values: parseValues(env, String(a.values), 'dscp') };
      else if (env.has('precedence')) m = { kind: 'precedence', values: parseValues(env, String(a.values), 'precedence') };
      else m = { kind: 'any' };
      const cm = currentClassMap(env);
      const i = cm.matches.findIndex((x) => sameMatch(x, m));
      if (env.has('no')) { if (i >= 0) cm.matches.splice(i, 1); }
      else if (i < 0) cm.matches.push(m);
    },
  },
  {
    modes: 'config-cmap', feature: 'qos',
    pattern: ['description <text:text>', 'no description [<text:text>]'],
    help: CMAP_HELP,
    run(env, a) { const cm = currentClassMap(env); if (env.has('no')) delete cm.description; else cm.description = String(a.text); },
  },

  // ── policy-map ──
  {
    modes: 'config', feature: 'qos', mutates: true,
    pattern: 'policy-map <pname:word>',
    help: GLOBAL_HELP,
    run(env, a) {
      if (!findPolicy(env, a.pname)) cfg(env).policyMaps.push({ name: a.pname, classes: [] });
      env.setMode('config-pmap', { policy: a.pname });
    },
  },
  {
    modes: 'config', feature: 'qos',
    pattern: 'no policy-map <pname:word>',
    help: GLOBAL_HELP,
    run(env, a) {
      const list = cfg(env).policyMaps;
      const i = list.findIndex((p) => p.name === a.pname);
      if (i < 0) return;
      const u = policyUsers(env, a.pname);
      if (u.attached.length || u.parents.some((p) => p !== a.pname)) env.reject(MSG.policyMapInUse(a.pname));
      list.splice(i, 1);
    },
  },
  {
    modes: 'config-pmap', feature: 'qos',
    pattern: ['description <text:text>', 'no description [<text:text>]'],
    help: PMAP_HELP,
    run(env, a) { const pm = currentPolicy(env); if (env.has('no')) delete pm.description; else pm.description = String(a.text); },
  },
  {
    // IOS accepts `class …` in config-pmap-c too (the parser falls back to the parent mode).
    modes: ['config-pmap', 'config-pmap-c'], feature: 'qos', mutates: true,
    pattern: ['class <cname:word>', 'class class-default'],
    help: PMAP_HELP,
    run(env, a) {
      const name = className(env, a.cname);
      if (name !== 'class-default' && !findClassMap(env, name)) env.reject(MSG.classNotConfigured(name));
      const pm = currentPolicy(env);
      if (!pm.classes.some((c) => c.className === name)) addClass(pm, { className: name });
      env.setMode('config-pmap-c', { policy: pm.name, class: name });
    },
  },
  {
    modes: ['config-pmap', 'config-pmap-c'], feature: 'qos',
    pattern: ['no class <cname:word>', 'no class class-default'],
    help: PMAP_HELP,
    run(env, a) {
      const name = className(env, a.cname);
      const pm = currentPolicy(env);
      pm.classes = pm.classes.filter((c) => c.className !== name);
      if (env.session.mode === 'config-pmap-c') env.setMode('config-pmap', { policy: pm.name });
    },
  },

  // ── policy-map class actions ──
  {
    modes: 'config-pmap-c', feature: 'qos',
    pattern: ['priority <kbps:int(1-2000000)> [<burst:int(32-2000000)>]', 'priority percent <pct:int(1-100)> [<burst:int(32-2000000)>]'],
    help: PMAPC_HELP,
    run(env, a) {
      const pm = currentPolicy(env); const pc = currentClass(env);
      if (pc.bandwidth) env.reject(MSG.priorityAndBandwidth);
      const priority: NonNullable<PolicyClass['priority']> = a.pct !== undefined ? { percent: a.pct } : { kbps: a.kbps };
      if (a.burst !== undefined) priority.burstBytes = a.burst;
      checkPolicy(env, pm, pc, { priority });
      pc.priority = priority;
    },
  },
  {
    modes: 'config-pmap-c', feature: 'qos',
    pattern: 'no priority [<rest:text>]',
    help: PMAPC_HELP,
    run(env) { delete currentClass(env).priority; },
  },
  {
    modes: 'config-pmap-c', feature: 'qos',
    pattern: ['bandwidth <kbps:int(8-10000000)>', 'bandwidth percent <pct:int(1-100)>', 'bandwidth remaining percent <rpct:int(1-100)>'],
    help: PMAPC_HELP,
    run(env, a) {
      const pm = currentPolicy(env); const pc = currentClass(env);
      if (pc.priority) env.reject(MSG.priorityAndBandwidth);
      const bandwidth: NonNullable<PolicyClass['bandwidth']> =
        a.rpct !== undefined ? { remainingPercent: a.rpct } : a.pct !== undefined ? { percent: a.pct } : { kbps: a.kbps };
      checkPolicy(env, pm, pc, { bandwidth });
      pc.bandwidth = bandwidth;
    },
  },
  {
    modes: 'config-pmap-c', feature: 'qos',
    pattern: 'no bandwidth [<rest:text>]',
    help: PMAPC_HELP,
    run(env) { delete currentClass(env).bandwidth; },
  },
  {
    modes: 'config-pmap-c', feature: 'qos',
    pattern: ['fair-queue', 'no fair-queue'],
    help: PMAPC_HELP,
    run(env) { const pc = currentClass(env); if (env.has('no')) delete pc.fairQueue; else pc.fairQueue = true; },
  },
  {
    modes: 'config-pmap-c', feature: 'qos',
    pattern: ['shape average <bps:int(8000-10000000000)>', 'shape average percent <pct:int(1-100)>', 'no shape [<rest:text>]'],
    help: PMAPC_HELP,
    run(env, a) {
      const pc = currentClass(env);
      if (env.has('no')) delete pc.shapeAverage;
      else pc.shapeAverage = a.pct !== undefined ? { percent: a.pct } : { bps: a.bps };
    },
  },
  {
    modes: 'config-pmap-c', feature: 'qos',
    pattern: ['police <bps:int(8000-10000000000)> [<rest:text>]', 'police cir <bps:int(8000-10000000000)> [<rest:text>]', 'no police [<rest:text>]'],
    help: PMAPC_HELP,
    run(env, a) {
      const pc = currentClass(env);
      if (env.has('no')) { delete pc.police; return; }
      pc.police = { bps: a.bps };
      if (a.rest) env.note('Accepted, but not simulated: police burst sizes and actions. Only the policer rate is recorded.');
    },
  },
  {
    modes: 'config-pmap-c', feature: 'qos',
    pattern: ['queue-limit <packets:int(1-2000000)> [packets]', 'no queue-limit [<rest:text>]'],
    help: PMAPC_HELP,
    run(env, a) { const pc = currentClass(env); if (env.has('no')) delete pc.queueLimit; else pc.queueLimit = a.packets; },
  },
  {
    modes: 'config-pmap-c', feature: 'qos',
    pattern: ['service-policy <child:word>', 'no service-policy [<child:word>]'],
    help: PMAPC_HELP,
    run(env, a) {
      const pm = currentPolicy(env); const pc = currentClass(env);
      if (env.has('no')) { delete pc.servicePolicy; return; }
      if (!findPolicy(env, a.child)) env.reject(MSG.policyNotConfigured(a.child));
      if (a.child === pm.name || descendants(env, a.child).has(pm.name)) env.reject(MSG.selfChild(pm.name));
      pc.servicePolicy = a.child;
    },
  },
  {
    modes: 'config-pmap-c', feature: 'qos',
    pattern: ['set [ip] dscp <value:word>', 'no set [ip] dscp [<value:word>]'],
    help: PMAPC_HELP,
    run(env, a) {
      const pc = currentClass(env);
      if (env.has('no')) { delete pc.setDscp; return; }
      const v = normalizeDscp(String(a.value));
      if (v === null) invalidAt(env, tokens(env.line).length - 1);
      pc.setDscp = v;
    },
  },
  {
    modes: 'config-pmap-c', feature: 'qos',
    pattern: ['set [ip] precedence <value:word>', 'no set [ip] precedence [<value:word>]'],
    help: PMAPC_HELP,
    run(env, a) {
      const pc = currentClass(env);
      if (env.has('no')) { removeExtra(pc, 'set precedence'); return; }
      const v = normalizePrecedence(String(a.value));
      if (v === null) invalidAt(env, tokens(env.line).length - 1);
      putExtra(pc, 'set precedence', `set precedence ${v}`);
      env.note('Accepted, but not simulated: precedence marking.');
    },
  },
  {
    modes: 'config-pmap-c', feature: 'qos',
    pattern: ['random-detect [{m:dscp-based|precedence-based}]', 'no random-detect [{m:dscp-based|precedence-based}]'],
    help: PMAPC_HELP,
    run(env, a) {
      const pc = currentClass(env);
      if (env.has('no')) { removeExtra(pc, 'random-detect'); return; }
      putExtra(pc, 'random-detect', a.m ? `random-detect ${a.m}` : 'random-detect');
      env.note('Accepted, but not simulated: WRED (random-detect). The simulator does not model drops under congestion.');
    },
  },

  // ── Interface ──
  {
    modes: 'config-if', feature: 'qos',
    pattern: 'service-policy {dir:input|output} <pname:word>',
    help: IF_HELP,
    run(env, a) {
      if (!findPolicy(env, a.pname)) env.reject(MSG.policyNotConfigured(a.pname));
      if (a.dir === 'input' && hasQueueing(env, a.pname)) env.reject(MSG.queueingInput);
      const key: 'servicePolicyIn' | 'servicePolicyOut' = a.dir === 'input' ? 'servicePolicyIn' : 'servicePolicyOut';
      const ifs = currentInterfaces(env);
      for (const i of ifs) { const cur = i[key]; if (cur && cur !== a.pname) env.reject(MSG.alreadyAttached(a.dir, cur)); }
      for (const i of ifs) i[key] = a.pname;
    },
  },
  {
    modes: 'config-if', feature: 'qos',
    pattern: 'no service-policy {dir:input|output} [<pname:word>]',
    help: IF_HELP,
    run(env, a) {
      const key: 'servicePolicyIn' | 'servicePolicyOut' = a.dir === 'input' ? 'servicePolicyIn' : 'servicePolicyOut';
      for (const i of currentInterfaces(env) as InterfaceConfig[]) {
        if (!i[key]) continue;
        if (a.pname && i[key] !== a.pname) {
          env.note(`Nothing removed on ${i.name}: its ${a.dir} policy is ${i[key]}, not ${a.pname}.`);
          continue;
        }
        delete i[key];
      }
    },
  },

  // ── Legacy queueing: not on IOS XE ──
  // The patterns follow the old IOS syntax (list numbers 1-16 and the first keyword) so that a mistyped MQC line such as
  // `priority percent 101` in config-pmap-c (which falls back to global mode) is never mistaken for `priority-list`.
  // The global forms are also registered in config-if, where students type them by habit, so the caret uses that prompt.
  {
    modes: ['config', 'config-if'], feature: 'qos', mutates: false,
    pattern: [
      'priority-list <n:int(1-16)> {protocol|interface|default|queue-limit} [<rest:text>]',
      'queue-list <n:int(1-16)> {protocol|interface|default|queue|lowest-custom|stun} [<rest:text>]',
      'no priority-list <n:int(1-16)> [<rest:text>]',
      'no queue-list <n:int(1-16)> [<rest:text>]',
    ],
    run(env) { invalidAt(env, env.has('no') ? 1 : 0, LEGACY_NOTE); },
  },
  {
    modes: 'config-if', feature: 'qos', mutates: false,
    pattern: [
      'priority-group <n:int(1-16)>', 'custom-queue-list <n:int(1-16)>', 'fair-queue [<rest:text>]',
      'no priority-group [<rest:text>]', 'no custom-queue-list [<rest:text>]', 'no fair-queue [<rest:text>]',
    ],
    run(env) { invalidAt(env, env.has('no') ? 1 : 0, LEGACY_NOTE); },
  },
];

export function install(): void { registerCommands(commands); }
