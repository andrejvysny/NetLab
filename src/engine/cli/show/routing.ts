/**
 * Routing screens: show ip route [static|connected|rip|ospf|<ip> [<mask>]], show ip protocols, show ip static route.
 * Entries come from the simulation's routingTable (already sorted); this module only lays them out like IOS XE 17.3.
 */
import type { IosDevice, World } from '../../types.ts';
import { classfulMask, inSubnet, ipToInt, maskToPrefix, networkOf } from '../../ip.ts';
import type { RouteEntry } from '../../sim/index.ts';
import { interfaceState, routingTable, staticRouteStatus } from '../../sim/index.ts';
import { hms, ifOrder, joinLines, padR, secondsAt } from './util.ts';

export const ROUTE_CODES = [
  'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
  '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area ',
  '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
  '       E1 - OSPF external type 1, E2 - OSPF external type 2, m - OMP',
  '       n - NAT, Ni - NAT inside, No - NAT outside, Nd - NAT DIA',
  '       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2',
  '       ia - IS-IS inter area, * - candidate default, U - per-user static route',
  '       H - NHRP, G - NHRP registered, g - NHRP registration summary',
  '       o - ODR, P - periodic downloaded static route, l - LISP',
  '       a - application route',
  '       + - replicated route, % - next hop override, p - overrides from PfR',
];

function codeOf(r: RouteEntry): string {
  const star = r.isDefault && r.code !== 'C' && r.code !== 'L' ? '*' : '';
  return `${r.code}${star}${r.codeExtra ? ' ' + r.codeExtra : ''}`;
}
/** Age shown for dynamic routes (the simulator has no timers: a short, plausible age). */
function age(world: World, r: RouteEntry): string {
  return hms(Math.min(secondsAt(world.tick), (ipToInt(r.prefix) + world.tick * 3) % 30));
}
/** The part after the network: 'is directly connected, Gi0/0/0' or '[1/0] via 60.50.30.2, Serial0/1/0'. */
function tail(world: World, r: RouteEntry): string {
  if (r.code === 'C' || r.code === 'L') return `is directly connected, ${r.iface}`;
  if (!r.nextHop) return `is directly connected, ${r.iface ?? r.resolved.iface}`;
  const dyn = r.code === 'R' || r.code === 'O';
  const via = dyn ? `${r.nextHop}, ${age(world, r)}, ${r.iface ?? r.resolved.iface}` : `${r.nextHop}${r.iface ? ', ' + r.iface : ''}`;
  return `[${r.distance}/${r.metric}] via ${via}`;
}

function gatewayLine(table: RouteEntry[]): string {
  const dflt = table.find((r) => r.isDefault && r.code !== 'C' && r.code !== 'L');
  if (!dflt) return 'Gateway of last resort is not set';
  return `Gateway of last resort is ${dflt.nextHop ?? '0.0.0.0'} to network 0.0.0.0`;
}

function classfulLen(prefix: string): number { return maskToPrefix(classfulMask(prefix)); }

/** Route lines with the classful "is subnetted" headers. `table` = full table (header counts), `shown` = entries to print. */
function routeLines(world: World, table: RouteEntry[], shown: RouteEntry[]): string[] {
  const out: string[] = [];
  const groups = new Map<string, RouteEntry[]>();
  const flat: { key: number; line: string }[] = [];
  for (const r of table) {
    const cl = classfulLen(r.prefix);
    if (r.prefixLen < cl || r.prefixLen === 0) continue; // supernets and the default stand alone
    const major = networkOf(r.prefix, classfulMask(r.prefix));
    const g = groups.get(major);
    if (g) g.push(r); else groups.set(major, [r]);
  }
  const shownSet = new Set(shown);
  const majors = [...groups.keys()].sort((a, b) => ipToInt(a) - ipToInt(b));
  const blocks: { key: number; lines: string[] }[] = [];
  for (const r of shown) {
    const cl = classfulLen(r.prefix);
    if (r.prefixLen < cl || r.prefixLen === 0) flat.push({ key: ipToInt(r.prefix), line: `${padR(codeOf(r), 6)}${r.prefix}/${r.prefixLen} ${tail(world, r)}` });
  }
  for (const major of majors) {
    const all = groups.get(major)!;
    const mine = all.filter((r) => shownSet.has(r));
    if (!mine.length) continue;
    const cl = classfulLen(major);
    const lines: string[] = [];
    if (all.length === 1 && all[0].prefixLen === cl) {
      const r = all[0];
      lines.push(`${padR(codeOf(r), 6)}${r.prefix}/${r.prefixLen} ${tail(world, r)}`);
    } else {
      const masks = new Set(all.map((r) => r.prefixLen));
      const subnets = new Set(all.map((r) => `${r.prefix}/${r.prefixLen}`)).size;
      if (masks.size === 1) {
        const len = all[0].prefixLen;
        lines.push(`      ${major}/${len} is subnetted, ${subnets} subnets`);
        for (const r of mine) lines.push(`${padR(codeOf(r), 9)}${r.prefix} ${tail(world, r)}`);
      } else {
        lines.push(`      ${major}/${cl} is variably subnetted, ${subnets} subnets, ${masks.size} masks`);
        for (const r of mine) lines.push(`${padR(codeOf(r), 9)}${r.prefix}/${r.prefixLen} ${tail(world, r)}`);
      }
    }
    blocks.push({ key: ipToInt(major), lines });
  }
  const all: { key: number; lines: string[] }[] = [...flat.map((f) => ({ key: f.key, lines: [f.line] })), ...blocks];
  all.sort((a, b) => a.key - b.key);
  for (const b of all) out.push(...b.lines);
  return out;
}

/** show ip route on a device that does not route (switch without `ip routing`). */
function hostRouteView(dev: IosDevice): string {
  const gw = dev.config.defaultGateway;
  return joinLines([
    gw ? `Default gateway is ${gw}` : 'Default gateway is not set',
    '',
    'Host               Gateway           Last Use    Total Uses  Interface',
    'ICMP redirect cache is empty',
  ]);
}

export function showIpRoute(world: World, dev: IosDevice, filter?: 'static' | 'connected' | 'rip' | 'ospf'): string {
  if (!dev.config.ipRouting) return hostRouteView(dev);
  const table = routingTable(world, dev.id);
  const shown = filter === 'static' ? table.filter((r) => r.code === 'S')
    : filter === 'connected' ? table.filter((r) => r.code === 'C' || r.code === 'L')
      : filter === 'rip' ? table.filter((r) => r.code === 'R')
        : filter === 'ospf' ? table.filter((r) => r.code === 'O')
          : table;
  const out = [...ROUTE_CODES, '', gatewayLine(table), ''];
  const routes = routeLines(world, table, shown);
  out.push(...routes);
  // with nothing to list, IOS still ends with the blank line after the gateway line
  return joinLines(out) + (routes.length ? '' : '\n');
}

function knownVia(r: RouteEntry, dev: IosDevice): string {
  switch (r.code) {
    case 'C': return `  Known via "connected", distance 0, metric 0 (connected, via interface)`;
    case 'L': return `  Known via "connected", distance 0, metric 0 (connected)`;
    case 'S': return `  Known via "static", distance ${r.distance}, metric 0${r.isDefault ? ', candidate default path' : ''}`;
    case 'R': return `  Known via "rip", distance ${r.distance}, metric ${r.metric}${r.isDefault ? ', candidate default path' : ''}`;
    case 'O': {
      const pid = dev.config.ospf[0]?.processId ?? 1;
      const type = r.codeExtra === 'E2' ? ', type extern 2, forward metric 1' : r.codeExtra === 'IA' ? ', type inter area' : ', type intra area';
      return `  Known via "ospf ${pid}", distance ${r.distance}, metric ${r.metric}${type}${r.isDefault ? ', candidate default path' : ''}`;
    }
  }
}
function entryDetail(world: World, dev: IosDevice, r: RouteEntry): string {
  const cl = classfulLen(r.prefix);
  const out = [`Routing entry for ${r.prefix}/${r.prefixLen}${r.prefixLen < cl ? ', supernet' : ''}`, knownVia(r, dev)];
  if (r.code === 'R') out.push('  Redistributing via rip');
  if (r.code === 'O' || r.code === 'R') out.push(`  Last update from ${r.nextHop} on ${r.iface ?? r.resolved.iface}, ${age(world, r)} ago`);
  out.push('  Routing Descriptor Blocks:');
  if (r.code === 'C' || r.code === 'L' || !r.nextHop) out.push(`  * directly connected, via ${r.iface ?? r.resolved.iface}`);
  else if (r.code === 'R' || r.code === 'O') out.push(`  * ${r.nextHop}, from ${r.nextHop}, ${age(world, r)} ago, via ${r.iface ?? r.resolved.iface}`);
  else out.push(`  * ${r.nextHop}${r.iface ? `, via ${r.iface}` : ''}`);
  out.push(`      Route metric is ${r.metric}, traffic share count is 1`);
  return joinLines(out);
}

/** show ip route <ip> [<mask>] — longest match excluding the default route (IOS: "% Network not in table"). */
export function showIpRouteFor(world: World, dev: IosDevice, addr: string, mask?: string): string {
  const table = dev.config.ipRouting ? routingTable(world, dev.id) : [];
  let hit: RouteEntry | undefined;
  if (mask) {
    const len = maskToPrefix(mask);
    hit = table.find((r) => r.prefixLen === len && r.prefix === networkOf(addr, mask));
    if (!hit) return mask === '255.255.255.255' || len === 32 ? '% Subnet not in table' : '% Subnet not in table';
  } else {
    const cands = table.filter((r) => (r.prefixLen > 0 || addr === '0.0.0.0') && inSubnet(addr, r.prefix, r.mask));
    for (const r of cands) if (!hit || r.prefixLen > hit.prefixLen) hit = r;
    if (!hit) return '% Network not in table';
  }
  return entryDetail(world, dev, hit);
}

// ───────────────────────────── show ip protocols ─────────────────────────────
function routerId(world: World, dev: IosDevice, configured?: string): string {
  if (configured) return configured;
  const addrs = (loop: boolean) => Object.entries(dev.config.interfaces)
    .filter(([n, c]) => !!c.ip && n.startsWith('Loopback') === loop && (() => { const s = interfaceState(world, dev.id, n); return s.status === 'up' && s.protocol === 'up'; })())
    .map(([, c]) => c.ip!.address);
  const pick = (l: string[]) => l.sort((a, b) => ipToInt(b) - ipToInt(a))[0];
  return pick(addrs(true)) ?? pick(addrs(false)) ?? '0.0.0.0';
}

export function showIpProtocols(world: World, dev: IosDevice): string {
  const out = ['*** IP Routing is NSF aware ***', ''];
  if (!dev.config.ipRouting) return joinLines(out);
  out.push(
    'Routing Protocol is "application"',
    '  Sending updates every 0 seconds',
    '  Invalid after 0 seconds, hold down 0, flushed after 0',
    '  Outgoing update filter list for all interfaces is not set',
    '  Incoming update filter list for all interfaces is not set',
    '  Maximum path: 32',
    '  Routing for Networks:',
    '  Routing Information Sources:',
    '    Gateway         Distance      Last Update',
    '  Distance: (default is 4)',
    '',
  );
  const table = routingTable(world, dev.id);
  for (const o of dev.config.ospf) {
    const areas = new Set(o.networks.map((n) => n.area));
    out.push(
      `Routing Protocol is "ospf ${o.processId}"`,
      '  Outgoing update filter list for all interfaces is not set',
      '  Incoming update filter list for all interfaces is not set',
      `  Router ID ${routerId(world, dev, o.routerId)}`,
      `  Number of areas in this router is ${areas.size}. ${areas.size} normal 0 stub 0 nssa`,
      '  Maximum path: 4',
      '  Routing for Networks:',
      ...o.networks.map((n) => `    ${n.address} ${n.wildcard} area ${n.area}`),
    );
    if (o.passive.length) out.push('  Passive Interface(s):', ...o.passive.map((p) => `    ${p}`));
    out.push('  Routing Information Sources:', '    Gateway         Distance      Last Update');
    const srcs = [...new Set(table.filter((r) => r.code === 'O' && r.nextHop).map((r) => r.learnedFrom ?? r.nextHop!))];
    for (const s of srcs) {
      const d = world.devices[s];
      const id = d && d.kind !== 'pc' ? routerId(world, d, d.config.ospf[0]?.routerId) : s;
      out.push(`    ${padR(id, 15)}      110      ${hms(20 + world.tick % 40)}`);
    }
    out.push('  Distance: (default is 110)', '');
  }
  const rip = dev.config.rip;
  if (rip) {
    const ver = rip.version;
    out.push(
      'Routing Protocol is "rip"',
      '  Outgoing update filter list for all interfaces is not set',
      '  Incoming update filter list for all interfaces is not set',
      `  Sending updates every 30 seconds, next due in ${1 + world.tick % 29} seconds`,
      '  Invalid after 180 seconds, hold down 180, flushed after 240',
      '  Redistributing: rip',
      `  Default version control: send version ${ver ?? 1}, receive ${ver ? `version ${ver}` : 'any version'}`,
      '    Interface             Send  Recv  Triggered RIP  Key-chain',
    );
    for (const name of ifOrder(dev)) {
      const c = dev.config.interfaces[name];
      if (!c.ip || rip.passive.includes(name)) continue;
      const st = interfaceState(world, dev.id, name);
      if (st.status !== 'up' || st.protocol !== 'up') continue;
      const covered = rip.networks.some((n) => inSubnet(c.ip!.address, n, classfulMask(n)));
      if (!covered) continue;
      out.push(`    ${padR(name, 22)}${padR(ver ?? 1, 6)}${padR(ver ?? '1 2', 6)}         No        none`);
    }
    out.push(`  Automatic network summarization is ${rip.autoSummary ? 'in effect' : 'not in effect'}`, '  Maximum path: 4', '  Routing for Networks:');
    for (const n of rip.networks) out.push(`    ${networkOf(n, classfulMask(n))}`);
    if (rip.passive.length) out.push('  Passive Interface(s):', ...rip.passive.map((p) => `    ${p}`));
    out.push('  Routing Information Sources:', '    Gateway         Distance      Last Update');
    const srcs = [...new Set(table.filter((r) => r.code === 'R' && r.nextHop).map((r) => r.nextHop!))];
    for (const s of srcs) out.push(`    ${padR(s, 15)}      120      ${hms(5 + world.tick % 25)}`);
    out.push('  Distance: (default is 120)', '');
  }
  return joinLines(out);
}

// ───────────────────────────── show ip static route ─────────────────────────────
export function showIpStaticRoute(world: World, dev: IosDevice): string {
  const out = [
    'Codes: M - Manual static, A - AAA download, N - IP NAT, D - DHCP,',
    '       G - GPRS, V - Crypto VPN, C - CASA, P - Channel interface processor,',
    '       B - BGP VPN Route Leak, L - Lisp dynamic EID, T - Tracking object',
    '       R - Static Replicated, I - Static Import from global',
    'Codes in []: A - active, N - non-active, B - BFD-tracked, D - Not Tracked, P - permanent, -T Default Track',
    '',
    'Codes in (): UP - up, DN - Down, AD-DN - Admin-Down, DL - Deleted',
    'Static local RIB for default ',
    '',
  ];
  for (const s of staticRouteStatus(world, dev.id)) {
    const r = s.route;
    const via = [r.exitInterface, r.nextHop].filter((x) => !!x).join(' ');
    out.push(`M  ${r.prefix}/${maskToPrefix(r.mask)} [${r.distance ?? 1}/0] via ${via} [${s.installed ? 'A' : 'N'}]`);
  }
  return joinLines(out);
}

