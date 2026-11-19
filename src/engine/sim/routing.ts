/**
 * Routing tables: connected (C) and local (L) routes of up interfaces, static routes (installed only when usable),
 * simplified RIP and OSPF, and longest-prefix lookup. PCs and non-routing devices get a host-style table
 * (own network + default gateway) so the packet pipeline can treat every device the same way.
 */
import type { InterfaceConfig, IosDevice, StaticRoute, World } from '../types.ts';
import { classfulMask, ifSortKey, inSubnet, ipToInt, maskToPrefix, matchesWildcard, networkOf } from '../ip.ts';
import type { OwnAddress, RouteEntry, RouteMemo } from './model.ts';
import { interfaceState, isUp } from './physical.ts';
import { l2Reach } from './switching.ts';
import { isIosDevice, isPcDevice, subnetText } from './text.ts';

const AD = { connected: 0, static: 1, ospf: 110, rip: 120 } as const;

export function newRouteMemo(): RouteMemo { return { tables: new Map() }; }

// ───────────────────────────── addresses ─────────────────────────────

/** Every IPv4 address configured on the device, with the state of its interface. */
export function ownAddresses(world: World, deviceId: string): OwnAddress[] {
  const dev = world.devices[deviceId];
  const out: OwnAddress[] = [];
  if (isPcDevice(dev)) {
    if (dev.nic.address && dev.nic.mask) {
      out.push({ address: dev.nic.address, mask: dev.nic.mask, iface: 'Ethernet0', up: isUp(world, deviceId, 'Ethernet0') });
    }
    return out;
  }
  if (!isIosDevice(dev)) return out;
  for (const name of sortedIfNames(dev)) {
    const cfg = dev.config.interfaces[name];
    if (!cfg.ip) continue;
    const up = isUp(world, deviceId, name);
    out.push({ address: cfg.ip.address, mask: cfg.ip.mask, iface: name, up });
    for (const s of cfg.secondary ?? []) out.push({ address: s.address, mask: s.mask, iface: name, up });
  }
  return out;
}

function sortedIfNames(dev: IosDevice): string[] {
  return Object.keys(dev.config.interfaces).sort((a, b) => (ifSortKey(a) < ifSortKey(b) ? -1 : ifSortKey(a) > ifSortKey(b) ? 1 : 0));
}

/** Default interface bandwidth in kbit/s when `bandwidth` is not configured. */
export function defaultBandwidthKbps(ifName: string): number {
  if (ifName.startsWith('Serial')) return 1544;
  if (ifName.startsWith('Loopback')) return 8000000;
  if (ifName.startsWith('Vlan')) return 1000000;
  return 1000000;
}
export function bandwidthKbps(cfg: InterfaceConfig | undefined, ifName: string): number {
  return cfg?.bandwidthKbps ?? defaultBandwidthKbps(ifName);
}

// ───────────────────────────── connected ─────────────────────────────
function entry(code: RouteEntry['code'], prefix: string, mask: string, distance: number, metric: number, rest: Partial<RouteEntry> & { resolved: RouteEntry['resolved'] }): RouteEntry {
  const net = networkOf(prefix, mask);
  const len = maskToPrefix(mask);
  return { code, prefix: net, mask, prefixLen: len, distance, metric, isDefault: len === 0, ...rest };
}

function connectedRoutes(world: World, dev: IosDevice): RouteEntry[] {
  const out: RouteEntry[] = [];
  for (const name of sortedIfNames(dev)) {
    const cfg = dev.config.interfaces[name];
    if (!cfg.ip || !isUp(world, dev.id, name)) continue;
    for (const a of [cfg.ip, ...(cfg.secondary ?? [])]) {
      const len = maskToPrefix(a.mask);
      if (len === 32) {
        out.push(entry('C', a.address, a.mask, AD.connected, 0, { iface: name, resolved: { iface: name } }));
      } else {
        out.push(entry('C', a.address, a.mask, AD.connected, 0, { iface: name, resolved: { iface: name } }));
        out.push(entry('L', a.address, '255.255.255.255', AD.connected, 0, { iface: name, resolved: { iface: name } }));
      }
    }
  }
  return out;
}

// ───────────────────────────── lookup ─────────────────────────────
/** Longest-prefix match in a table (lowest distance wins among equal prefixes). */
export function lookupIn(table: RouteEntry[], dst: string, opts: { skipDefault?: boolean; skipLocal?: boolean } = {}): RouteEntry | null {
  let best: RouteEntry | null = null;
  for (const r of table) {
    if (opts.skipDefault && r.prefixLen === 0) continue;
    if (opts.skipLocal && r.code === 'L') continue;
    if (!inSubnet(dst, r.prefix, r.mask)) continue;
    if (!best || r.prefixLen > best.prefixLen || (r.prefixLen === best.prefixLen && r.distance < best.distance)) best = r;
  }
  return best;
}

// ───────────────────────────── static routes ─────────────────────────────
export interface StaticRouteStatus { route: StaticRoute; installed: boolean; reason?: string }

function ownsAddress(dev: IosDevice, ip: string): boolean {
  return Object.values(dev.config.interfaces).some((c) => c.ip?.address === ip || c.secondary?.some((s) => s.address === ip));
}

/** Resolve static routes against `base` (connected + dynamic routes). Returns the usable ones and a status for each configured route. */
function resolveStatics(world: World, dev: IosDevice, base: RouteEntry[]): { routes: RouteEntry[]; status: StaticRouteStatus[] } {
  const configured = dev.config.staticRoutes;
  const resolved: (RouteEntry | null)[] = configured.map(() => null);
  const reasons: (string | undefined)[] = configured.map(() => undefined);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 50) {
    changed = false;
    const installed = [...base, ...resolved.filter((r): r is RouteEntry => r !== null)];
    configured.forEach((sr, i) => {
      if (resolved[i]) return;
      const distance = sr.distance ?? AD.static;
      const make = (res: RouteEntry['resolved']) =>
        entry('S', sr.prefix, sr.mask, distance, 0, { nextHop: sr.nextHop, iface: sr.exitInterface, resolved: res });
      if (sr.exitInterface) {
        if (sr.exitInterface === 'Null0') { resolved[i] = make({ iface: 'Null0' }); changed = true; return; }
        if (!dev.config.interfaces[sr.exitInterface]) {
          reasons[i] = `${dev.label} has no interface ${sr.exitInterface}`;
          return;
        }
        const st = interfaceState(world, dev.id, sr.exitInterface);
        if (!(st.status === 'up' && st.protocol === 'up')) {
          reasons[i] = `the exit interface ${sr.exitInterface} is ${st.status}/${st.protocol}${st.problem ? ` (${st.problem})` : ''}`;
          return;
        }
        resolved[i] = make({ iface: sr.exitInterface, nextHop: sr.nextHop });
        changed = true;
        return;
      }
      if (!sr.nextHop) { reasons[i] = 'the route has neither a next hop nor an exit interface'; return; }
      if (ownsAddress(dev, sr.nextHop)) { reasons[i] = `the next hop ${sr.nextHop} is an address of ${dev.label} itself`; return; }
      const via = lookupIn(installed, sr.nextHop, { skipDefault: true, skipLocal: true });
      if (!via) {
        reasons[i] = `the next hop ${sr.nextHop} is not in a network ${dev.label} can reach (no connected network contains it, or that interface is down)`;
        return;
      }
      if (via.resolved.iface === 'Null0') { reasons[i] = `the next hop ${sr.nextHop} is routed to Null0`; return; }
      const direct = via.code === 'C' || (via.code === 'S' && !via.resolved.nextHop);
      resolved[i] = make({ iface: via.resolved.iface, nextHop: direct ? sr.nextHop : via.resolved.nextHop });
      changed = true;
    });
  }
  const routes = resolved.filter((r): r is RouteEntry => r !== null);
  const status = configured.map((route, i) => ({ route, installed: resolved[i] !== null, reason: resolved[i] ? undefined : reasons[i] }));
  return { routes, status };
}

// ───────────────────────────── dynamic routing (simplified) ─────────────────────────────
interface L3If { name: string; address: string; mask: string; loopback: boolean; cfg: InterfaceConfig }

function l3Ifaces(world: World, dev: IosDevice): L3If[] {
  const out: L3If[] = [];
  for (const name of sortedIfNames(dev)) {
    const cfg = dev.config.interfaces[name];
    if (!cfg.ip || !isUp(world, dev.id, name)) continue;
    out.push({ name, address: cfg.ip.address, mask: cfg.ip.mask, loopback: name.startsWith('Loopback'), cfg });
  }
  return out;
}

function isPassive(list: string[], ifName: string): boolean {
  return list.includes(ifName) || list.includes('default');
}

interface Adjacency { me: string; myIf: L3If; peer: string; peerIf: L3If }

/** Router interfaces of other routers that share a link and a subnet with `mine`. */
function linkPeers(world: World, dev: IosDevice, mine: L3If, ifacesOf: Map<string, L3If[]>): { peer: string; peerIf: L3If }[] {
  if (mine.loopback) return [];
  const out: { peer: string; peerIf: L3If }[] = [];
  for (const ep of l2Reach(world, dev.id, mine.name)) {
    const list = ifacesOf.get(ep.deviceId);
    if (!list) continue;
    const pi = list.find((x) => x.name === ep.ifName);
    if (!pi) continue;
    if (pi.mask !== mine.mask || !inSubnet(pi.address, mine.address, mine.mask)) continue;
    out.push({ peer: ep.deviceId, peerIf: pi });
  }
  return out;
}

function ripRoutes(world: World, routers: IosDevice[]): Map<string, RouteEntry[]> {
  const result = new Map<string, RouteEntry[]>();
  const speakers = routers.filter((r) => r.config.rip && r.config.ipRouting);
  if (speakers.length === 0) return result;
  const enabled = new Map<string, L3If[]>();
  for (const r of speakers) {
    const nets = r.config.rip!.networks;
    enabled.set(r.id, l3Ifaces(world, r).filter((i) => nets.some((n) => {
      const m = classfulMask(n);
      return networkOf(i.address, m) === networkOf(n, m);
    })));
  }
  interface DbEntry { prefix: string; mask: string; metric: number; nextHop?: string; iface?: string; from?: string }
  const db = new Map<string, Map<string, DbEntry>>();
  const key = (prefix: string, mask: string) => `${networkOf(prefix, mask)}/${maskToPrefix(mask)}`;
  for (const r of speakers) {
    const m = new Map<string, DbEntry>();
    for (const i of enabled.get(r.id)!) m.set(key(i.address, i.mask), { prefix: networkOf(i.address, i.mask), mask: i.mask, metric: 0 });
    if (r.config.rip!.defaultOriginate) m.set('0.0.0.0/0', { prefix: '0.0.0.0', mask: '0.0.0.0', metric: 0 });
    db.set(r.id, m);
  }
  const adjs: Adjacency[] = [];
  for (const r of speakers) {
    for (const i of enabled.get(r.id)!) {
      for (const p of linkPeers(world, r, i, enabled)) adjs.push({ me: r.id, myIf: i, peer: p.peer, peerIf: p.peerIf });
    }
  }
  const byId = new Map(speakers.map((r) => [r.id, r] as [string, IosDevice]));
  const accepts = (me: IosDevice, peer: IosDevice): boolean => {
    const mine = me.config.rip!.version;
    const theirs = peer.config.rip!.version ?? 1; // default: sends version 1
    if (mine === undefined) return true;           // default: receives version 1 and 2
    return mine === theirs;
  };
  for (let round = 0; round < 16; round++) {
    let changed = false;
    for (const a of adjs) {
      const me = byId.get(a.me)!;
      const peer = byId.get(a.peer)!;
      if (isPassive(peer.config.rip!.passive, a.peerIf.name)) continue; // a passive interface sends no updates
      if (!accepts(me, peer)) continue;
      const classful = peer.config.rip!.autoSummary || (peer.config.rip!.version ?? 1) === 1;
      for (const e of db.get(a.peer)!.values()) {
        if (e.from === a.me && e.iface === a.peerIf.name) continue; // split horizon
        const metric = e.metric + 1;
        if (metric >= 16) continue;
        let prefix = e.prefix;
        let mask = e.mask;
        if (classful && maskToPrefix(mask) !== 0) {
          const major = classfulMask(prefix);
          if (networkOf(prefix, major) !== networkOf(a.peerIf.address, major) && maskToPrefix(mask) > maskToPrefix(major)) {
            prefix = networkOf(prefix, major);
            mask = major;
          }
        }
        const k = key(prefix, mask);
        const mine = db.get(a.me)!;
        const cur = mine.get(k);
        if (cur && cur.metric <= metric) continue;
        mine.set(k, { prefix, mask, metric, nextHop: a.peerIf.address, iface: a.myIf.name, from: a.peer });
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const r of speakers) {
    const list: RouteEntry[] = [];
    for (const e of db.get(r.id)!.values()) {
      if (e.metric === 0 || !e.nextHop || !e.iface) continue;
      list.push(entry('R', e.prefix, e.mask, AD.rip, e.metric, {
        nextHop: e.nextHop, iface: e.iface, resolved: { iface: e.iface, nextHop: e.nextHop }, learnedFrom: e.from,
      }));
    }
    result.set(r.id, list);
  }
  return result;
}

function ospfCost(i: L3If): number {
  return Math.max(1, Math.floor(100000 / bandwidthKbps(i.cfg, i.name)));
}

function ospfRoutes(world: World, routers: IosDevice[]): Map<string, RouteEntry[]> {
  const result = new Map<string, RouteEntry[]>();
  const speakers = routers.filter((r) => r.config.ospf.length > 0 && r.config.ipRouting);
  if (speakers.length === 0) return result;
  interface OIf extends L3If { area: string; passive: boolean; cost: number }
  const enabled = new Map<string, OIf[]>();
  for (const r of speakers) {
    const list: OIf[] = [];
    for (const i of l3Ifaces(world, r)) {
      for (const proc of r.config.ospf) {
        const stmt = proc.networks.find((n) => matchesWildcard(i.address, n.address, n.wildcard));
        if (!stmt) continue;
        list.push({ ...i, area: stmt.area, passive: isPassive(proc.passive, i.name), cost: ospfCost(i) });
        break;
      }
    }
    enabled.set(r.id, list);
  }
  // adjacency graph
  const edges = new Map<string, { to: string; cost: number; myIf: string; nextHop: string }[]>();
  for (const r of speakers) {
    const list: { to: string; cost: number; myIf: string; nextHop: string }[] = [];
    for (const i of enabled.get(r.id)!) {
      if (i.passive) continue;
      for (const p of linkPeers(world, r, i, enabled as Map<string, L3If[]>)) {
        const pi = p.peerIf as OIf;
        if (pi.passive || pi.area !== i.area) continue;
        list.push({ to: p.peer, cost: i.cost, myIf: i.name, nextHop: pi.address });
      }
    }
    edges.set(r.id, list);
  }
  const byId = new Map(speakers.map((r) => [r.id, r] as [string, IosDevice]));
  for (const r of speakers) {
    // Dijkstra
    const dist = new Map<string, number>([[r.id, 0]]);
    const first = new Map<string, { myIf: string; nextHop: string }>();
    const done = new Set<string>();
    for (;;) {
      let u: string | null = null;
      for (const [id, d] of dist) if (!done.has(id) && (u === null || d < dist.get(u)!)) u = id;
      if (u === null) break;
      done.add(u);
      for (const e of edges.get(u) ?? []) {
        const nd = dist.get(u)! + e.cost;
        if (!dist.has(e.to) || nd < dist.get(e.to)!) {
          dist.set(e.to, nd);
          first.set(e.to, u === r.id ? { myIf: e.myIf, nextHop: e.nextHop } : first.get(u)!);
        }
      }
    }
    const best = new Map<string, RouteEntry>();
    const offer = (re: RouteEntry) => {
      const k = `${re.prefix}/${re.prefixLen}`;
      const cur = best.get(k);
      if (!cur || re.metric < cur.metric) best.set(k, re);
    };
    for (const [id, d] of dist) {
      if (id === r.id) continue;
      const hop = first.get(id);
      if (!hop) continue;
      const y = byId.get(id)!;
      for (const i of enabled.get(id)!) {
        const mask = i.loopback ? '255.255.255.255' : i.mask;
        offer(entry('O', i.address, mask, AD.ospf, d + i.cost, {
          nextHop: hop.nextHop, iface: hop.myIf, resolved: { iface: hop.myIf, nextHop: hop.nextHop }, learnedFrom: id,
        }));
      }
      if (y.config.ospf.some((p) => p.defaultOriginate) && hasStaticDefault(world, y)) {
        offer(entry('O', '0.0.0.0', '0.0.0.0', AD.ospf, 1, {
          codeExtra: 'E2', nextHop: hop.nextHop, iface: hop.myIf, resolved: { iface: hop.myIf, nextHop: hop.nextHop }, learnedFrom: id,
        }));
      }
    }
    result.set(r.id, [...best.values()]);
  }
  return result;
}

function hasStaticDefault(world: World, dev: IosDevice): boolean {
  const { routes } = resolveStatics(world, dev, connectedRoutes(world, dev));
  return routes.some((r) => r.prefixLen === 0);
}

function dynamicRoutes(world: World): Map<string, RouteEntry[]> {
  const routers: IosDevice[] = [];
  for (const id of world.order) {
    const d = world.devices[id];
    if (isIosDevice(d)) routers.push(d);
  }
  const out = new Map<string, RouteEntry[]>();
  if (!routers.some((r) => r.config.rip || r.config.ospf.length > 0)) return out;
  const rip = ripRoutes(world, routers);
  const ospf = ospfRoutes(world, routers);
  for (const r of routers) out.set(r.id, [...(ospf.get(r.id) ?? []), ...(rip.get(r.id) ?? [])]);
  return out;
}

// ───────────────────────────── assembly ─────────────────────────────
const CODE_ORDER: Record<RouteEntry['code'], number> = { C: 0, L: 1, S: 2, O: 3, R: 4 };

function sortRoutes(list: RouteEntry[]): RouteEntry[] {
  return list
    .map((r, i) => ({ r, i }))
    .sort((a, b) =>
      ipToInt(a.r.prefix) - ipToInt(b.r.prefix) || a.r.prefixLen - b.r.prefixLen || CODE_ORDER[a.r.code] - CODE_ORDER[b.r.code] || a.i - b.i)
    .map((x) => x.r);
}

function hostTable(world: World, deviceId: string): RouteEntry[] {
  const pc = world.devices[deviceId];
  if (!isPcDevice(pc)) return [];
  const nic = pc.nic;
  if (!nic.address || !nic.mask || !isUp(world, deviceId, 'Ethernet0')) return [];
  const out = [entry('C', nic.address, nic.mask, 0, 0, { iface: 'Ethernet0', resolved: { iface: 'Ethernet0' } })];
  if (nic.gateway && inSubnet(nic.gateway, nic.address, nic.mask) && nic.gateway !== nic.address) {
    out.push(entry('S', '0.0.0.0', '0.0.0.0', 1, 0, { nextHop: nic.gateway, resolved: { iface: 'Ethernet0', nextHop: nic.gateway }, fromDefaultGateway: true }));
  }
  return sortRoutes(out);
}

function iosTable(world: World, dev: IosDevice, memo: RouteMemo): RouteEntry[] {
  const conn = connectedRoutes(world, dev);
  if (!dev.config.ipRouting) {
    // A device that does not route (layer-2 switch, `no ip routing`) uses `ip default-gateway` like a host.
    const out = [...conn];
    const gw = dev.config.defaultGateway;
    if (gw) {
      const via = lookupIn(conn, gw, { skipLocal: true });
      if (via && !ownsAddress(dev, gw)) {
        out.push(entry('S', '0.0.0.0', '0.0.0.0', 1, 0, { nextHop: gw, resolved: { iface: via.resolved.iface, nextHop: gw }, fromDefaultGateway: true }));
      }
    }
    return sortRoutes(out);
  }
  if (!memo.dyn) memo.dyn = dynamicRoutes(world);
  const dyn = memo.dyn.get(dev.id) ?? [];
  const statics = resolveStatics(world, dev, [...conn, ...dyn]).routes;
  const connKeys = new Set(conn.map((r) => `${r.prefix}/${r.prefixLen}`));
  const groups = new Map<string, RouteEntry[]>();
  for (const r of [...statics, ...dyn]) {
    const k = `${r.prefix}/${r.prefixLen}`;
    if (connKeys.has(k)) continue; // a connected route always wins
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  const out = [...conn];
  for (const g of groups.values()) {
    const bestAd = Math.min(...g.map((r) => r.distance));
    const winners = g.filter((r) => r.distance === bestAd);
    const code = winners[0].code;
    // equal-distance routes of the same kind stay together (several static routes to one prefix)
    for (const r of winners) if (r.code === code) out.push(r);
  }
  return sortRoutes(out);
}

/** Routing table of a device using a per-call memo. */
export function tableWith(world: World, deviceId: string, memo: RouteMemo): RouteEntry[] {
  const hit = memo.tables.get(deviceId);
  if (hit) return hit;
  const dev = world.devices[deviceId];
  const table = isIosDevice(dev) ? iosTable(world, dev, memo) : hostTable(world, deviceId);
  memo.tables.set(deviceId, table);
  return table;
}

/**
 * The routing table, sorted like `show ip route` (by network number, then prefix length).
 * Routers: C, L, S, R, O. Switches / `no ip routing`: connected routes plus a default from `ip default-gateway`.
 * PCs: own network plus the default gateway.
 */
export function routingTable(world: World, deviceId: string): RouteEntry[] {
  return tableWith(world, deviceId, newRouteMemo());
}

/** Longest-prefix match for `dst`, or null when the device has no route. */
export function lookupRoute(world: World, deviceId: string, dst: string): RouteEntry | null {
  return lookupIn(routingTable(world, deviceId), dst);
}

/** Every configured static route with whether it is in the routing table, and if not, why. */
export function staticRouteStatus(world: World, deviceId: string): StaticRouteStatus[] {
  const dev = world.devices[deviceId];
  if (!isIosDevice(dev)) return [];
  const dyn = dynamicRoutes(world).get(deviceId) ?? [];
  return resolveStatics(world, dev, [...connectedRoutes(world, dev), ...dyn]).status;
}

function staticText(sr: StaticRoute): string {
  return `ip route ${sr.prefix} ${sr.mask}${sr.exitInterface ? ' ' + sr.exitInterface : ''}${sr.nextHop ? ' ' + sr.nextHop : ''}`;
}

/** Plain explanation for "no route to dst" on an IOS device, naming static routes that would match but are not installed. */
export function explainNoRoute(world: World, deviceId: string, dst: string): string {
  const dev = world.devices[deviceId];
  if (!isIosDevice(dev)) return '';
  const hints: string[] = [];
  if (!dev.config.ipRouting) {
    const gw = dev.config.defaultGateway;
    return gw
      ? `${dev.label} does not route by itself and its default gateway ${gw} is not in a network it is connected to.`
      : `${dev.label} does not route by itself: it needs "ip default-gateway <address>" to reach other networks.`;
  }
  for (const s of staticRouteStatus(world, deviceId)) {
    if (s.installed || !inSubnet(dst, s.route.prefix, s.route.mask)) continue;
    hints.push(`"${staticText(s.route)}" is configured but not in the routing table: ${s.reason}.`);
  }
  if (hints.length === 0) {
    for (const [name, cfg] of Object.entries(dev.config.interfaces)) {
      if (!cfg.ip || !inSubnet(dst, cfg.ip.address, cfg.ip.mask)) continue;
      const st = interfaceState(world, deviceId, name);
      if (st.status === 'up' && st.protocol === 'up') continue;
      hints.push(`${name} (${subnetText(cfg.ip.address, cfg.ip.mask)}) would be the way, but it is ${st.status}/${st.protocol}.${st.problem ? ' ' + st.problem : ''}`);
    }
  }
  if (hints.length === 0) {
    const hasDefault = dev.config.staticRoutes.some((r) => maskToPrefix(r.mask) === 0);
    hints.push(hasDefault
      ? 'No connected network and no static route covers this address.'
      : 'No connected network covers this address and there is no default route (ip route 0.0.0.0 0.0.0.0 …).');
  }
  return hints.join(' ');
}

/** The entry as `show ip route` would print it (without column padding) — evidence for traces. */
export function routeText(r: RouteEntry): string {
  const net = `${r.prefix}/${r.prefixLen}`;
  const code = `${r.code}${r.isDefault && r.code !== 'C' && r.code !== 'L' ? '*' : ''}${r.codeExtra ? ' ' + r.codeExtra : ''}`;
  if (r.code === 'C' || r.code === 'L') return `${code} ${net} is directly connected, ${r.iface}`;
  if (r.fromDefaultGateway) return `default gateway ${r.nextHop}`;
  if (!r.nextHop) return `${code} ${net} is directly connected, ${r.iface}`;
  return `${code} ${net} [${r.distance}/${r.metric}] via ${r.nextHop}${r.iface ? ', ' + r.iface : ''}`;
}
