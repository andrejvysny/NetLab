/**
 * ip routing, ip route (+ no forms), ip default-network (accepted), router rip, router ospf and their sub-commands.
 *
 * session.ctx in config-router: { protocol: 'rip' } | { protocol: 'ospf', pid: number }
 * (RIP and OSPF share the IOS mode name `config-router`; each sub-command checks ctx.protocol and rejects with a caret
 *  where the other protocol's syntax is used, as IOS does.)
 */
import type { CmdEnv, CommandDef } from '../framework.ts';
import { registerCommands } from '../framework.ts';
import type { OspfConfig, RipConfig, StaticRoute } from '../../types.ts';
import { classfulMask, ipToInt, isIp, isMask, maskToPrefix, maskToWildcard, networkOf } from '../../ip.ts';
import { invalidAt, invalidToken, setExtra, tokenIndexOf, NOT_SIMULATED } from './system.ts';
import { ifCaretCol, ifClass, normIfName } from './interface.ts';

export type RouterCtx = { protocol: 'rip' } | { protocol: 'ospf'; pid: number };

function ownAddress(env: CmdEnv, addr: string): boolean {
  return Object.values(env.device.config.interfaces).some((i) => i.ip?.address === addr || i.secondary?.some((s) => s.address === addr));
}
function sameRoute(a: StaticRoute, b: StaticRoute): boolean {
  return a.prefix === b.prefix && a.mask === b.mask && (a.nextHop ?? '') === (b.nextHop ?? '') && (a.exitInterface ?? '') === (b.exitInterface ?? '');
}
/** Parse `ip route` arguments (shared by the positive and the no form). `base` = token index of the prefix. */
function routeFromArgs(env: CmdEnv, a: Record<string, any>, base: number): StaticRoute {
  const prefix = String(a.prefix), mask = String(a.mask);
  if (!isMask(mask) || ((ipToInt(prefix) & ~ipToInt(mask)) >>> 0) !== 0) env.reject('%Inconsistent address and mask');
  const r: StaticRoute = { prefix, mask };
  if (a.exit !== undefined) {
    const name = normIfName(String(a.exit));
    // caret like IOS: under the part of the interface name that does not exist
    if (!env.device.config.interfaces[name]) invalidAt(env, ifCaretCol(env, base + 2, name));
    r.exitInterface = name;
  }
  if (a.nh !== undefined) r.nextHop = String(a.nh);
  if (a.dist !== undefined) r.distance = Number(a.dist);
  return r;
}

function rip(env: CmdEnv): RipConfig {
  const cfg = env.device.config;
  if (!cfg.rip) cfg.rip = { networks: [], autoSummary: true, passive: [] };
  return cfg.rip;
}
function ospf(env: CmdEnv): OspfConfig {
  const ctx = env.session.ctx as RouterCtx;
  const pid = ctx.protocol === 'ospf' ? ctx.pid : 1;
  let p = env.device.config.ospf.find((o) => o.processId === pid);
  if (!p) { p = { processId: pid, networks: [], passive: [] }; env.device.config.ospf.push(p); }
  return p;
}
function proto(env: CmdEnv): 'rip' | 'ospf' { return (env.session.ctx as RouterCtx).protocol ?? 'rip'; }
/** Reject a sub-command that the current routing protocol does not have (caret under token `tok`). */
function only(env: CmdEnv, p: 'rip' | 'ospf', tok = 0): void { if (proto(env) !== p) invalidToken(env, tok); }

const HR: Record<string, string> = {
  ip: 'Global IP configuration subcommands',
  route: 'Establish static routes',
  routing: 'Enable IP routing',
  'default-network': 'Flags networks as candidates for default routes',
  router: 'Enable a routing process',
  rip: 'Routing Information Protocol (RIP)',
  ospf: 'Open Shortest Path First (OSPF)',
  no: 'Negate a command or set its defaults',
  '<prefix>': 'Destination prefix',
  '<mask>': 'Destination prefix mask',
  '<nh>': 'Forwarding router\'s address',
  '<exit>': 'Interface to send the traffic out of',
  '<dist>': 'Distance metric for this route',
  '<pid>': 'Process ID',
};
const HSR: Record<string, string> = {
  network: 'Enable routing on an IP network',
  version: 'Set routing protocol version',
  'auto-summary': 'Enable automatic network number summarization',
  'passive-interface': 'Suppress routing updates on an interface',
  'default-information': 'Control distribution of default information',
  originate: 'Distribute a default route',
  always: 'Always advertise default route',
  'router-id': 'router-id for this OSPF process',
  area: 'Set the OSPF area ID',
  no: 'Negate a command or set its defaults',
  '<addr>': 'Network number',
  '<wc>': 'OSPF wild card bits',
  '<area>': 'OSPF area ID as a decimal value or in IP address format',
  '<v>': 'version',
  '<rid>': 'OSPF router-id in IP address format',
};

export const commands: CommandDef[] = [
  // ── ip routing ──
  { modes: 'config', pattern: ['ip routing', 'no ip routing'], feature: 'routing', help: HR, run(env) { env.device.config.ipRouting = !env.has('no'); } },

  // ── static routes ──
  {
    modes: 'config',
    pattern: [
      'ip route <prefix:ip> <mask:mask> <nh:ip> [<dist:int(1-255)>] [permanent]',
      'ip route <prefix:ip> <mask:mask> <exit:if> [<nh:ip>] [<dist:int(1-255)>] [permanent]',
    ],
    feature: 'routing', help: { ...HR, permanent: 'permanent route' },
    run(env, a) {
      const r = routeFromArgs(env, a, 2);
      if (r.nextHop && ownAddress(env, r.nextHop)) env.reject("%Invalid next hop address (it's this router)");
      const list = env.device.config.staticRoutes;
      const i = list.findIndex((x) => sameRoute(x, r));
      if (i >= 0) list[i] = r; else list.push(r);
      if (r.prefix === '0.0.0.0' && r.mask === '0.0.0.0' && r.exitInterface && !r.nextHop && ifClass(r.exitInterface) === 'ethernet') {
        env.print('%Default route without gateway, if not a point-to-point interface, may impact performance');
      }
    },
  },
  {
    modes: 'config',
    pattern: [
      'no ip route <prefix:ip> <mask:mask> [<dist:int(1-255)>]',
      'no ip route <prefix:ip> <mask:mask> <nh:ip> [<dist:int(1-255)>] [permanent]',
      'no ip route <prefix:ip> <mask:mask> <exit:if> [<nh:ip>] [<dist:int(1-255)>] [permanent]',
    ],
    feature: 'routing', help: HR,
    run(env, a) {
      const r = routeFromArgs(env, a, 3);
      const list = env.device.config.staticRoutes;
      const exact = r.nextHop !== undefined || r.exitInterface !== undefined;
      const keep = list.filter((x) => !(x.prefix === r.prefix && x.mask === r.mask && (!exact || sameRoute(x, r))));
      if (keep.length === list.length) env.reject('%No matching route to delete');
      env.device.config.staticRoutes = keep;
    },
  },
  {
    modes: 'config', pattern: ['ip default-network <addr:ip>', 'no ip default-network <addr:ip>'], feature: 'routing', help: HR,
    run(env, a) {
      setExtra(env.device.config.extraLines, `ip default-network ${a.addr}`, 3, env.has('no') ? 'remove' : 'set');
      env.note(NOT_SIMULATED + 'ip default-network (use ip route 0.0.0.0 0.0.0.0 … for a default route).');
    },
  },

  // ── router rip / router ospf ──
  {
    modes: 'config', pattern: 'router rip', feature: 'routing', mutates: false, help: HR,
    run(env) { rip(env); env.setMode('config-router', { protocol: 'rip' }); },
  },
  {
    modes: 'config', pattern: 'router ospf <pid:int(1-65535)>', feature: 'routing', mutates: false, help: HR,
    run(env, a) {
      const pid = Number(a.pid);
      env.setMode('config-router', { protocol: 'ospf', pid });
      ospf(env);
    },
  },
  { modes: 'config', pattern: 'no router rip', feature: 'routing', help: HR, run(env) { delete env.device.config.rip; } },
  {
    modes: 'config', pattern: 'no router ospf <pid:int(1-65535)>', feature: 'routing', help: HR,
    run(env, a) { env.device.config.ospf = env.device.config.ospf.filter((o) => o.processId !== Number(a.pid)); },
  },

  // ── RIP and OSPF sub-commands ──
  {
    modes: 'config-router', pattern: 'version {v:1|2}', feature: 'routing', help: { ...HSR, '1': 'RIP version 1', '2': 'RIP version 2' },
    run(env, a) { only(env, 'rip'); rip(env).version = Number(a.v) as 1 | 2; },
  },
  { modes: 'config-router', pattern: 'no version [{v:1|2}]', feature: 'routing', help: HSR, run(env) { only(env, 'rip', 1); delete rip(env).version; } },
  {
    modes: 'config-router', pattern: 'network <addr:ip>', feature: 'routing', help: HSR,
    run(env, a) {
      if (proto(env) === 'ospf') env.reject('% Incomplete command.');
      const net = networkOf(String(a.addr), classfulMask(String(a.addr)));
      const r = rip(env);
      if (!r.networks.includes(net)) r.networks.push(net);
    },
  },
  {
    modes: 'config-router', pattern: 'no network <addr:ip>', feature: 'routing', help: HSR,
    run(env, a) {
      if (proto(env) === 'ospf') env.reject('% Incomplete command.');
      const net = networkOf(String(a.addr), classfulMask(String(a.addr)));
      const r = rip(env);
      r.networks = r.networks.filter((n) => n !== net);
    },
  },
  {
    modes: 'config-router', pattern: ['network <addr:ip> <wc:wildcard> area <area:word>', 'no network <addr:ip> <wc:wildcard> area <area:word>'], feature: 'routing', help: HSR,
    run(env, a) {
      const no = env.has('no');
      if (proto(env) === 'rip') invalidToken(env, no ? 3 : 2);
      const area = String(a.area);
      if (!(/^\d+$/.test(area) && Number(area) <= 4294967295) && !isIp(area)) invalidToken(env, no ? 5 : 4);
      const p = ospf(env);
      const entry = { address: String(a.addr), wildcard: String(a.wc), area };
      const same = (n: typeof entry) => n.address === entry.address && n.wildcard === entry.wildcard;
      if (no) { p.networks = p.networks.filter((n) => !(same(n) && n.area === area)); return; }
      const i = p.networks.findIndex(same);
      if (i >= 0) p.networks[i] = entry; else p.networks.push(entry);
      if (isMask(entry.wildcard) && entry.wildcard !== '0.0.0.0' && entry.wildcard !== '255.255.255.255') {
        env.note(`OSPF expects a wildcard here, not a subnet mask. For a /${maskToPrefix(entry.wildcard)} network the wildcard is ${maskToWildcard(entry.wildcard)}.`);
      }
    },
  },
  {
    modes: 'config-router', pattern: ['auto-summary', 'no auto-summary'], feature: 'routing', help: HSR,
    run(env) { only(env, 'rip', env.has('no') ? 1 : 0); rip(env).autoSummary = !env.has('no'); },
  },
  {
    modes: 'config-router', pattern: ['passive-interface <ifname:if>', 'no passive-interface <ifname:if>'], feature: 'routing', help: HSR,
    run(env, a) {
      const no = env.has('no');
      const name = normIfName(String(a.ifname));
      if (!env.device.config.interfaces[name]) invalidAt(env, ifCaretCol(env, no ? 2 : 1, name));
      const list = proto(env) === 'rip' ? rip(env).passive : ospf(env).passive;
      const i = list.indexOf(name);
      if (no) { if (i >= 0) list.splice(i, 1); } else if (i < 0) list.push(name);
    },
  },
  {
    modes: 'config-router', pattern: ['default-information originate [always]', 'no default-information originate [always]'], feature: 'routing', help: HSR,
    run(env) {
      const on = !env.has('no');
      if (env.has('always') && proto(env) === 'rip') invalidToken(env, tokenIndexOf(env, 'always', 1));
      if (proto(env) === 'rip') { if (on) rip(env).defaultOriginate = true; else delete rip(env).defaultOriginate; }
      else { if (on) ospf(env).defaultOriginate = true; else delete ospf(env).defaultOriginate; }
    },
  },
  {
    modes: 'config-router', pattern: 'router-id <rid:ip>', feature: 'routing', help: HSR,
    run(env, a) { only(env, 'ospf'); ospf(env).routerId = String(a.rid); },
  },
  { modes: 'config-router', pattern: 'no router-id [<rid:ip>]', feature: 'routing', help: HSR, run(env) { only(env, 'ospf', 1); delete ospf(env).routerId; } },
];


let installed = false;
export function install(): void { if (installed) return; installed = true; registerCommands(commands); }
