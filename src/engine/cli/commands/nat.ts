/**
 * NAT: `ip nat inside|outside` (interface), `ip nat pool`, `ip nat inside source static|list`, `ip nat inside destination`,
 * `ip nat translation …` timers (accepted, not simulated), and the EXEC commands `clear ip nat translation …` and
 * `clear ip nat statistics` on ISR. Catalyst 9300L has a separate Network Advantage subset: see
 * docs/final-catalyst.md for the exact supported forms and attachment restrictions.
 *
 * IOS behaviour reproduced:
 * - `source list … interface <if>` always gets `overload` (IOS XE adds it).
 * - A pool whose mask does not fit its range: "%Pool P mask M too small; should be at least M2"; start and end in different
 *   subnets of the mask: "%Start and end addresses on different subnets" (pool refused).
 * - Duplicate static entries: "% L already mapped (L -> G)" / "%NAT: similar static entry (L -> G) in table_id 0 already exists".
 * - Removing a rule that still has translations: on a console/vty IOS asks
 *   "Dynamic mapping in use, do you want to delete all entries? [no]:" (static: "Static entry in use, do you want to delete
 *   child entries? [no]:"). When the configuration comes from a file nobody can answer, so the line fails with
 *   "%Dynamic mapping in use, cannot remove" / "%Static entry in use, cannot remove" (the older IOS wording).
 *   A pool with translations: "%Pool P in use, cannot destroy" / "… cannot redefine".
 *
 * No sub-modes, so no session.ctx keys. Pending handlers: 'nat-delete-dynamic', 'nat-delete-static'
 * (PendingInput.data = { rule: NatDynamicRule | NatStaticRule }).
 */
import type { IosDevice, NatDynamicRule, NatPool, NatStaticRule, NatTranslation } from '../../types.ts';
import type { CmdEnv, CommandDef, PendingInput } from '../framework.ts';
import { currentInterfaces, registerCommands, registerPending } from '../framework.ts';
import { basicNatEnabled, catalystNatAclProblem, catalystNatMappingProblem, catalystNatPortProblem } from '../../natProfile.ts';
import { inSubnet, ipToInt, isMask, maskToPrefix, prefixToMask } from '../../ip.ts';
import { checkInterfaceRef, invalidAt, lineTokens, setExtraLine } from './acl.ts';

// ───────────────────────────── Ownership of translations ─────────────────────────────
function inRange(ip: string, start: string, end: string): boolean {
  const n = ipToInt(ip);
  return n >= ipToInt(start) && n <= ipToInt(end);
}
function poolNamed(dev: IosDevice, name: string | undefined): NatPool | undefined {
  return name === undefined ? undefined : dev.config.nat.pools.find((p) => p.name === name);
}
/** Dynamic translations created by this rule (matched by the global address it hands out). */
export function dynamicRuleTranslations(dev: IosDevice, rule: NatDynamicRule): NatTranslation[] {
  const dyn = dev.runtime.natTranslations.filter((t) => !t.fromStatic);
  if (dev.kind === 'switch') return dyn.filter((t) => t.mappingAcl === rule.acl);
  let global: ((ip: string) => boolean) | null = null;
  const pool = poolNamed(dev, rule.pool);
  if (pool) global = (ip) => inRange(ip, pool.start, pool.end);
  else if (rule.interface) {
    const addr = dev.config.interfaces[rule.interface]?.ip?.address;
    if (addr) global = (ip) => ip === addr;
  }
  if (global) { const g = global; return dyn.filter((t) => g(t.insideGlobal)); }
  return dev.config.nat.dynamicRules.length === 1 ? dyn : [];
}
/** Session entries created on top of this static mapping. */
export function staticRuleTranslations(dev: IosDevice, rule: NatStaticRule): NatTranslation[] {
  return dev.runtime.natTranslations.filter((t) => t.fromStatic && t.insideLocal === rule.local
    && (rule.global === undefined || t.insideGlobal === rule.global)
    && (rule.localPort === undefined || t.insideLocalPort === rule.localPort));
}
function poolTranslations(dev: IosDevice, pool: NatPool): NatTranslation[] {
  return dev.runtime.natTranslations.filter((t) => !t.fromStatic
    && (inRange(t.insideGlobal, pool.start, pool.end) || inRange(t.insideLocal, pool.start, pool.end)));
}
function dropTranslations(dev: IosDevice, list: NatTranslation[]): void {
  const ids = new Set(list.map((t) => t.id));
  dev.runtime.natTranslations = dev.runtime.natTranslations.filter((t) => !ids.has(t.id));
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isYes = (s: string) => /^\s*y(es?)?\s*$/i.test(s);

function requireCatalystPort(env: CmdEnv, ifName: string): void {
  const problem = catalystNatPortProblem(env.device, ifName);
  if (problem) env.reject(`% ${problem}`);
}
function runRole(env: CmdEnv, args: Record<string, unknown>): void {
  const ifs = currentInterfaces(env);
  for (const ifc of ifs) requireCatalystPort(env, ifc.name);
  for (const ifc of ifs) {
    if (!env.has('no')) ifc.natRole = args.role as 'inside' | 'outside';
    else if (ifc.natRole === args.role) delete ifc.natRole;
  }
}
function catalystRotary(env: CmdEnv): void {
  if (env.device.kind === 'switch') env.reject('% Rotary TCP distribution is not modeled on Catalyst 9300L; exact IOS XE 17.3 support is unverified.');
}

// ───────────────────────────── Help ─────────────────────────────
const H: Record<string, string> = {
  ip: 'Global IP configuration subcommands', no: 'Negate a command or set its defaults', nat: 'NAT configuration commands',
  inside: 'Inside address translation', source: 'Source address translation', destination: 'Destination address translation',
  static: 'Specify static local->global mapping', list: 'Specify access list describing local addresses',
  interface: 'Specify interface for global address', overload: 'Overload an address translation',
  extendable: 'Extend this translation when used', tcp: 'Transmission Control Protocol', udp: 'User Datagram Protocol',
  '<local>': 'Inside local IP address', '<global>': 'Inside global IP address', '<lport>': 'Local UDP/TCP port',
  '<gport>': 'Global UDP/TCP port', '<acl>': 'Access list number (1-2699) or name', '<ifname>': 'Interface for the global address',
};
const H_SRC_POOL: Record<string, string> = { ...H, pool: 'Name pool of global addresses', '<pool>': 'Pool name for global addresses' };
const H_DST_POOL: Record<string, string> = { ...H, pool: 'Name pool of local addresses', '<pool>': 'Pool name for local addresses', list: 'Specify access list describing global addresses' };
const H_POOL: Record<string, string> = {
  ...H, pool: 'Define pool of addresses', '<name>': 'Pool name', '<start>': 'Start IP address', '<end>': 'End IP address',
  netmask: 'Specify the network mask', '<mask>': 'Network mask', 'prefix-length': 'Specify the prefix length',
  '<len>': 'Prefix length', type: 'Specify the pool type', rotary: 'Rotary address pool',
};
const H_TRANS: Record<string, string> = {
  ...H, translation: 'NAT translation entry configuration', timeout: 'Specify timeout for dynamic NAT translations',
  'tcp-timeout': 'Specify timeout for NAT TCP flows', 'udp-timeout': 'Specify timeout for NAT UDP flows',
  'icmp-timeout': 'Specify timeout for NAT ICMP flows', 'dns-timeout': 'Specify timeout for NAT DNS flows',
  'finrst-timeout': 'Specify timeout for NAT TCP flows after a FIN or RST',
  'syn-timeout': 'Specify timeout for NAT TCP flows after a SYN and no further data',
  'port-timeout': 'Specify timeout for NAT TCP/UDP port specific flows', 'max-entries': 'Specify maximum number of NAT entries',
  '<sec>': 'Timeout in seconds', never: 'Never timeout', '<port>': 'Port number', '<n>': 'Number of entries',
  log: 'NAT logging', translations: 'NAT translations logging', syslog: 'Send NAT translation logs to syslog',
};
const H_IF: Record<string, string> = {
  ip: 'Interface Internet Protocol config commands', no: 'Negate a command or set its defaults', nat: 'NAT interface commands',
  inside: 'Inside interface for address translation', outside: 'Outside interface for address translation',
};
const H_CLEAR: Record<string, string> = {
  clear: 'Reset functions', ip: 'IP', nat: 'Clear NAT', translation: 'Clear dynamic translation',
  '*': 'Delete all dynamic translations', forced: 'Force clear of entries that may have child associations',
  inside: 'Inside addresses (and ports)', outside: 'Outside addresses (and ports)', statistics: 'Clear translation statistics',
  tcp: 'Transmission Control Protocol', udp: 'User Datagram Protocol',
  '<gip>': 'Inside global IP address', '<lip>': 'Inside local IP address', '<gport>': 'Global port', '<lport>': 'Local port',
  '<olip>': 'Outside local IP address', '<ogip>': 'Outside global IP address', '<olport>': 'Outside local port', '<ogport>': 'Outside global port',
};

// ───────────────────────────── Pool ─────────────────────────────
function commonPrefix(a: string, b: string): number {
  const x = (ipToInt(a) ^ ipToInt(b)) >>> 0;
  return x === 0 ? 32 : Math.clz32(x);
}
function runPool(env: CmdEnv, args: Record<string, unknown>): void {
  if (env.has('rotary')) catalystRotary(env);
  const name = String(args.name);
  const start = String(args.start);
  const end = String(args.end);
  const byPrefix = args.len !== undefined;
  const mask = byPrefix ? prefixToMask(args.len as number) : String(args.mask);
  if (!byPrefix && (!isMask(mask) || mask === '0.0.0.0')) {
    const toks = lineTokens(env.line);
    const at = toks.findIndex((t) => t.text === mask);
    invalidAt(env, at >= 0 ? toks[at].start : env.line.length);
  }
  if (ipToInt(end) < ipToInt(start)) env.reject('%End address less than start address');
  const prefix = maskToPrefix(mask);
  const needed = Math.min(30, commonPrefix(start, end));
  if (env.device.kind === 'router' && prefix > needed) {
    env.print(byPrefix
      ? `%Pool ${name} prefix length ${prefix} too large; should be no more than ${needed}`
      : `%Pool ${name} mask ${mask} too small; should be at least ${prefixToMask(needed)}`);
  }
  if (!inSubnet(end, start, mask)) env.reject('%Start and end addresses on different subnets');
  const pool: NatPool = { name, start, end, mask };
  if (env.has('rotary')) pool.rotary = true;
  const pools = env.device.config.nat.pools;
  const idx = pools.findIndex((p) => p.name === name);
  if (idx >= 0) {
    if (same(pools[idx], pool)) return;
    if (poolTranslations(env.device, pools[idx]).length) env.reject(`%Pool ${name} in use, cannot redefine`);
    pools[idx] = pool;
  } else pools.push(pool);
}
function runNoPool(env: CmdEnv, args: Record<string, unknown>): void {
  if (env.has('rotary')) catalystRotary(env);
  const pools = env.device.config.nat.pools;
  const idx = pools.findIndex((p) => p.name === String(args.name));
  if (idx < 0) return;
  if (poolTranslations(env.device, pools[idx]).length) env.reject(`%Pool ${pools[idx].name} in use, cannot destroy`);
  pools.splice(idx, 1);
}

// ───────────────────────────── Static rules ─────────────────────────────
function staticFromArgs(env: CmdEnv, args: Record<string, unknown>): NatStaticRule {
  const rule: NatStaticRule = { local: String(args.local) };
  if (args.global !== undefined) rule.global = String(args.global);
  if (args.proto !== undefined) {
    rule.proto = args.proto as 'tcp' | 'udp';
    rule.localPort = args.lport as number;
    rule.globalPort = args.gport as number;
  }
  if (args.ifname !== undefined) {
    if (env.device.kind === 'switch') env.reject('% Static NAT to an interface is not modeled on Catalyst 9300L; use a literal inside global IPv4 address.');
    checkInterfaceRef(env, String(args.ifname));
    rule.interface = String(args.ifname);
  }
  if (env.has('extendable')) rule.extendable = true;
  // canonical key order: local, global, proto, localPort, globalPort, interface, extendable
  const out: NatStaticRule = { local: rule.local };
  if (rule.global !== undefined) out.global = rule.global;
  if (rule.proto) { out.proto = rule.proto; out.localPort = rule.localPort; out.globalPort = rule.globalPort; }
  if (rule.interface) out.interface = rule.interface;
  if (rule.extendable) out.extendable = true;
  return out;
}
const globalText = (r: NatStaticRule) => r.global ?? r.interface ?? '';
function runStatic(env: CmdEnv, args: Record<string, unknown>): void {
  const rule = staticFromArgs(env, args);
  const rules = env.device.config.nat.staticRules;
  if (rules.some((r) => same(r, rule))) return;
  const sameKind = rules.filter((r) => (r.proto ?? null) === (rule.proto ?? null));
  const sameLocal = sameKind.find((r) => r.local === rule.local && r.localPort === rule.localPort);
  if (sameLocal && !(sameLocal.extendable && rule.extendable)) {
    env.reject(`% ${rule.local} already mapped (${sameLocal.local} -> ${globalText(sameLocal)})`);
  }
  const sameGlobal = sameKind.find((r) => globalText(r) === globalText(rule) && r.globalPort === rule.globalPort
    && (r.local !== rule.local || r.localPort !== rule.localPort));
  if (sameGlobal) env.reject(`%NAT: similar static entry (${sameGlobal.local} -> ${globalText(sameGlobal)}) in table_id 0 already exists`);
  rules.push(rule);
}
function runNoStatic(env: CmdEnv, args: Record<string, unknown>): void {
  const want = staticFromArgs(env, args);
  const rules = env.device.config.nat.staticRules;
  const key = (r: NatStaticRule) => JSON.stringify([r.local, r.global ?? null, r.proto ?? null, r.localPort ?? null, r.globalPort ?? null, r.interface ?? null]);
  const rule = rules.find((r) => key(r) === key(want));
  if (!rule) return;
  const used = staticRuleTranslations(env.device, rule);
  if (used.length) {
    if (env.session.via === 'file') env.reject('%Static entry in use, cannot remove');
    env.ask({ kind: 'nat-delete-static', response: 'confirm', prompt: 'Static entry in use, do you want to delete child entries? [no]: ', data: { rule } });
    return;
  }
  rules.splice(rules.indexOf(rule), 1);
}

// ───────────────────────────── Dynamic rules ─────────────────────────────
function runSourceList(env: CmdEnv, args: Record<string, unknown>): void {
  const rule: NatDynamicRule = { acl: String(args.acl), overload: env.has('overload') };
  if (args.pool !== undefined) rule.pool = String(args.pool);
  if (args.ifname !== undefined) {
    checkInterfaceRef(env, String(args.ifname));
    rule.interface = String(args.ifname);
    requireCatalystPort(env, rule.interface);
    if (env.device.kind === 'switch' && !rule.overload) env.reject('% Use explicit overload for Catalyst interface PAT in this lab.');
    if (!rule.overload) env.note('IOS adds "overload" by itself when the global address is an interface address.');
    rule.overload = true;
  }
  if (env.device.kind === 'switch') {
    const problem = catalystNatAclProblem(env.device, rule.acl);
    if (problem) env.reject(`% ${problem}`);
    if (poolNamed(env.device, rule.pool)?.rotary) catalystRotary(env);
    if (rule.interface) {
      const inactive = catalystNatMappingProblem(env.world, env.device, rule);
      if (inactive) env.note(`Interface PAT is inactive: ${inactive}`);
    }
  }
  const ordered: NatDynamicRule = { acl: rule.acl, ...(rule.pool !== undefined ? { pool: rule.pool } : {}), ...(rule.interface ? { interface: rule.interface } : {}), overload: rule.overload };
  const rules = env.device.config.nat.dynamicRules;
  const idx = rules.findIndex((r) => r.acl === ordered.acl);
  if (idx >= 0) {
    if (same(rules[idx], ordered)) return;
    if (dynamicRuleTranslations(env.device, rules[idx]).length) env.reject('%Dynamic mapping in use, cannot remove');
    rules[idx] = ordered;
  } else rules.push(ordered);
  if (ordered.pool && !poolNamed(env.device, ordered.pool)) env.note(`Pool ${ordered.pool} does not exist yet. Create it with "ip nat pool ${ordered.pool} …".`);
  if (!env.device.config.acls[ordered.acl]) env.note(`Access list ${ordered.acl} does not exist yet. It chooses which inside addresses are translated.`);
}
function runNoSourceList(env: CmdEnv, args: Record<string, unknown>): void {
  const rules = env.device.config.nat.dynamicRules;
  const rule = rules.find((r) => r.acl === String(args.acl)
    && (args.pool === undefined || r.pool === String(args.pool))
    && (args.ifname === undefined || r.interface === String(args.ifname)));
  if (!rule) return;
  if (dynamicRuleTranslations(env.device, rule).length) {
    if (env.session.via === 'file') env.reject('%Dynamic mapping in use, cannot remove');
    env.ask({ kind: 'nat-delete-dynamic', response: 'confirm', prompt: 'Dynamic mapping in use, do you want to delete all entries? [no]: ', data: { rule } });
    return;
  }
  rules.splice(rules.indexOf(rule), 1);
}
function runDestination(env: CmdEnv, args: Record<string, unknown>): void {
  catalystRotary(env);
  const rule = { acl: String(args.acl), pool: String(args.pool) };
  const rules = env.device.config.nat.insideDestinationRules;
  const idx = rules.findIndex((r) => r.acl === rule.acl);
  if (idx >= 0) {
    if (same(rules[idx], rule)) return;
    rules[idx] = rule;
  } else rules.push(rule);
  if (!poolNamed(env.device, rule.pool)) env.note(`Pool ${rule.pool} does not exist yet. Create it with "ip nat pool ${rule.pool} … type rotary".`);
}
function runNoDestination(env: CmdEnv, args: Record<string, unknown>): void {
  catalystRotary(env);
  const nat = env.device.config.nat;
  const rule = nat.insideDestinationRules.find((r) => r.acl === String(args.acl) && (args.pool === undefined || r.pool === String(args.pool)));
  if (!rule) return;
  const pool = poolNamed(env.device, rule.pool);
  if (pool && poolTranslations(env.device, pool).length) {
    if (env.session.via === 'file') env.reject('%Dynamic mapping in use, cannot remove');
    env.ask({ kind: 'nat-delete-dynamic', response: 'confirm', prompt: 'Dynamic mapping in use, do you want to delete all entries? [no]: ', data: { destination: rule } });
    return;
  }
  nat.insideDestinationRules.splice(nat.insideDestinationRules.indexOf(rule), 1);
}

// ───────────────────────────── Pending answers ─────────────────────────────
function onDeleteDynamic(env: CmdEnv, input: string, pending: PendingInput): void {
  if (!isYes(input)) return;
  const dev = env.device; const nat = dev.config.nat;
  const data = pending.data ?? {};
  if (data.destination) {
    const d = data.destination as { acl: string; pool: string };
    const idx = nat.insideDestinationRules.findIndex((r) => same(r, d));
    const pool = poolNamed(dev, d.pool);
    if (pool) dropTranslations(dev, poolTranslations(dev, pool));
    if (idx >= 0) nat.insideDestinationRules.splice(idx, 1);
    return;
  }
  const rule = data.rule as NatDynamicRule;
  const idx = nat.dynamicRules.findIndex((r) => same(r, rule));
  if (idx < 0) return;
  dropTranslations(dev, dynamicRuleTranslations(dev, nat.dynamicRules[idx]));
  nat.dynamicRules.splice(idx, 1);
}
function onDeleteStatic(env: CmdEnv, input: string, pending: PendingInput): void {
  if (!isYes(input)) return;
  const dev = env.device; const rules = dev.config.nat.staticRules;
  const rule = (pending.data ?? {}).rule as NatStaticRule;
  const idx = rules.findIndex((r) => same(r, rule));
  if (idx < 0) return;
  dropTranslations(dev, staticRuleTranslations(dev, rules[idx]));
  rules.splice(idx, 1);
}

// ───────────────────────────── Accepted, not simulated ─────────────────────────────
function runTranslationTimer(env: CmdEnv, args: Record<string, unknown>): void {
  const toks = lineTokens(env.line);
  const negate = toks[0].text.toLowerCase() === 'no';
  let key: string; let line: string;
  if (args.which === 'port-timeout') {
    key = `ip nat translation port-timeout ${args.pproto} ${args.port}`;
    line = `${key} ${args.sec ?? 'never'}`;
  } else if (args.which === 'max-entries') {
    key = 'ip nat translation max-entries';
    line = `${key} ${args.n}`;
  } else {
    key = `ip nat translation ${args.which}`;
    line = `${key} ${args.sec ?? 'never'}`;
  }
  setExtraLine(env.device.config.extraLines, key, negate ? null : line);
  if (!negate) env.note(`Accepted, but not simulated: ${key}. Translations in the simulator do not time out.`);
}

// ───────────────────────────── Definitions ─────────────────────────────
const STATIC_FORMS = [
  '<local:ip> <global:ip> [extendable]',
  '<local:ip> interface <ifname:if>',
  '{proto:tcp|udp} <local:ip> <lport:int(1-65535)> <global:ip> <gport:int(1-65535)> [extendable]',
  '{proto:tcp|udp} <local:ip> <lport:int(1-65535)> interface <ifname:if> <gport:int(1-65535)>',
];
const TIMER_KINDS = 'timeout|tcp-timeout|udp-timeout|icmp-timeout|dns-timeout|finrst-timeout|syn-timeout';

export const commands: CommandDef[] = [
  // Interface roles
  {
    modes: 'config-if', kinds: ['router', 'switch'], feature: 'nat', help: H_IF,
    pattern: 'ip nat {role:inside|outside}',
    run: runRole,
  },
  {
    modes: 'config-if', kinds: ['router', 'switch'], feature: 'nat', help: H_IF,
    pattern: 'no ip nat {role:inside|outside}',
    run: runRole,
  },
  // Source static (registered first so `inside`/`source` get their help text from H)
  {
    modes: 'config', kinds: ['router', 'switch'], feature: 'nat', help: H,
    pattern: STATIC_FORMS.map((f) => `ip nat inside source static ${f}`),
    run: runStatic,
  },
  {
    modes: 'config', kinds: ['router', 'switch'], feature: 'nat', help: H,
    pattern: STATIC_FORMS.map((f) => `no ip nat inside source static ${f}`),
    run: runNoStatic,
  },
  // Source list (dynamic NAT / PAT)
  {
    modes: 'config', kinds: ['router', 'switch'], feature: 'nat', help: H_SRC_POOL,
    pattern: ['ip nat inside source list <acl:word> pool <pool:word> [overload]', 'ip nat inside source list <acl:word> interface <ifname:if> [overload]'],
    run: runSourceList,
  },
  {
    modes: 'config', kinds: ['router', 'switch'], feature: 'nat', help: H_SRC_POOL,
    pattern: ['no ip nat inside source list <acl:word> [pool <pool:word> [overload]]', 'no ip nat inside source list <acl:word> interface <ifname:if> [overload]'],
    run: runNoSourceList,
  },
  {
    modes: 'config', kinds: ['switch'], feature: 'nat', help: H,
    pattern: ['ip nat inside source route-map <rest:text>', 'ip nat inside source static <local:ip> <global:ip> route-map <rest:text>'],
    run(env) { env.reject('% Route-mapped NAT is not supported on Catalyst 9300 IOS XE 17.3.'); },
  },
  // Destination (TCP load distribution)
  {
    modes: 'config', kinds: ['router', 'switch'], feature: 'nat', help: H_DST_POOL,
    pattern: 'ip nat inside destination list <acl:word> pool <pool:word>',
    run: runDestination,
  },
  {
    modes: 'config', kinds: ['router', 'switch'], feature: 'nat', help: H_DST_POOL,
    pattern: 'no ip nat inside destination list <acl:word> [pool <pool:word>]',
    run: runNoDestination,
  },
  // Pools
  {
    modes: 'config', kinds: ['router', 'switch'], feature: 'nat', help: H_POOL,
    pattern: [
      'ip nat pool <name:word> <start:ip> <end:ip> netmask <mask:mask> [type rotary]',
      'ip nat pool <name:word> <start:ip> <end:ip> prefix-length <len:int(1-32)> [type rotary]',
    ],
    run: runPool,
  },
  {
    modes: 'config', kinds: ['router', 'switch'], feature: 'nat', help: H_POOL,
    pattern: [
      'no ip nat pool <name:word>',
      'no ip nat pool <name:word> <start:ip> <end:ip> netmask <mask:mask> [type rotary]',
      'no ip nat pool <name:word> <start:ip> <end:ip> prefix-length <len:int(1-32)> [type rotary]',
    ],
    run: runNoPool,
  },
  // Timers and logging: accepted, stored verbatim, not simulated
  {
    modes: 'config', kinds: ['router'], feature: 'nat', help: H_TRANS,
    pattern: [
      `ip nat translation {which:${TIMER_KINDS}} {<sec:int(0-536870)>|never}`,
      `ip nat translation {which:port-timeout} {pproto:tcp|udp} <port:int(1-65535)> {<sec:int(0-536870)>|never}`,
      'ip nat translation {which:max-entries} <n:int(1-2147483647)>',
      `no ip nat translation {which:${TIMER_KINDS}} [<sec:int(0-536870)>|never]`,
      'no ip nat translation {which:port-timeout} {pproto:tcp|udp} <port:int(1-65535)> [<sec:int(0-536870)>|never]',
      'no ip nat translation {which:max-entries} [<n:int(1-2147483647)>]',
    ].flatMap(expandParamChoice),
    run: runTranslationTimer,
  },
  {
    modes: 'config', kinds: ['router'], feature: 'nat', help: H_TRANS,
    pattern: ['ip nat log translations syslog', 'no ip nat log translations syslog'],
    run(env) {
      const negate = env.has('no');
      setExtraLine(env.device.config.extraLines, 'ip nat log translations syslog', negate ? null : 'ip nat log translations syslog');
      if (!negate) env.note('Accepted, but not simulated: ip nat log translations syslog.');
    },
  },
  // Privileged EXEC
  {
    modes: 'priv', kinds: ['router', 'switch'], feature: 'nat', help: H_CLEAR,
    pattern: 'clear ip nat translation *',
    run(env) { env.device.runtime.natTranslations = []; },
  },
  {
    modes: 'priv', kinds: ['router'], feature: 'nat', help: H_CLEAR,
    pattern: 'clear ip nat translation forced',
    run(env) { env.device.runtime.natTranslations = []; },
  },
  {
    modes: 'priv', kinds: ['router'], feature: 'nat', help: H_CLEAR,
    pattern: [
      'clear ip nat translation inside <gip:ip> <lip:ip> [outside <olip:ip> <ogip:ip>]',
      'clear ip nat translation {proto:tcp|udp} inside <gip:ip> <gport:int(1-65535)> <lip:ip> <lport:int(1-65535)> [outside <olip:ip> <olport:int(1-65535)> <ogip:ip> <ogport:int(1-65535)>]',
    ],
    run(env, args) {
      const rt = env.device.runtime;
      rt.natTranslations = rt.natTranslations.filter((t) => !(
        t.insideGlobal === args.gip && t.insideLocal === args.lip
        && (args.proto === undefined || (t.proto === args.proto && t.insideGlobalPort === args.gport && t.insideLocalPort === args.lport))
        && (args.olip === undefined || (t.outsideLocal === args.olip && t.outsideGlobal === args.ogip))
        && (args.olport === undefined || (t.outsideLocalPort === args.olport && t.outsideGlobalPort === args.ogport))
      ));
    },
  },
  {
    modes: 'priv', kinds: ['router'], feature: 'nat', help: H_CLEAR,
    pattern: 'clear ip nat statistics',
    run(env) { env.device.runtime.natHits = 0; env.device.runtime.natMisses = 0; },
  },
];

/** The DSL has no "parameter or keyword" choice: expand `{<sec:…>|never}` / `[<sec:…>|never]` into separate patterns. */
function expandParamChoice(p: string): string[] {
  const m = /([{[])<sec:int\(0-536870\)>\|never([}\]])/.exec(p);
  if (!m) return [p];
  const optional = m[1] === '[';
  const a = p.replace(m[0], optional ? '[<sec:int(0-536870)>]' : '<sec:int(0-536870)>');
  const b = p.replace(m[0], optional ? '[never]' : 'never');
  return [a, b];
}

export function install(): void {
  registerCommands(commands.map((def) => ({ ...def, run(env, args) {
    if (!basicNatEnabled(env.device)) env.reject('% Catalyst NAT requires the Network Advantage classroom profile.');
    def.run(env, args);
  } })));
  registerPending('nat-delete-dynamic', onDeleteDynamic);
  registerPending('nat-delete-static', onDeleteStatic);
}

