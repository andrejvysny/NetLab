/**
 * DHCP, ACL and NAT screens: show ip dhcp binding|pool|conflict|server statistics, show [ip] access-lists [<id>],
 * show ip nat translations [verbose], show ip nat statistics. Tables come from runtime (dhcpBindings, aclHits, natTranslations).
 */
import type { Ace, Acl, AclProtocol, AddrMatch, DhcpPool, IosDevice, NatTranslation, PortMatch, World } from '../../types.ts';
import { hostRange, inSubnet, intToIp, ipToInt, portName } from '../../ip.ts';
import { natStaticRules, visibleNatTranslations } from '../../sim/nat.ts';
import { catalystNatMappingProblem, natRoleOn } from '../../natProfile.ts';
import { findOwners } from '../../sim/index.ts';
import { dhcpDate, hms, joinLines, padR, secondsAt, shortDate } from './util.ts';

// ───────────────────────────── DHCP ─────────────────────────────
/** '00-50-56-C0-10-11' → '0100.5056.c010.11' (client identifier = hardware type 01 + MAC). */
export function clientIdText(mac: string): string {
  const hex = ('01' + mac.replace(/[^0-9A-Fa-f]/g, '')).toLowerCase();
  const parts: string[] = [];
  for (let i = 0; i < hex.length; i += 4) parts.push(hex.slice(i, i + 4));
  return parts.join('.');
}
function leaseSeconds(pool: DhcpPool | undefined): number | null {
  const l = pool?.lease?.trim();
  if (!l) return 86400;
  if (/^infinite$/i.test(l)) return null;
  const [d, h, m] = l.split(/\s+/).map(Number);
  return ((d || 0) * 86400) + ((h || 0) * 3600) + ((m || 0) * 60);
}
function poolIface(dev: IosDevice, pool: DhcpPool | undefined): string {
  if (!pool?.network) return 'Unknown';
  for (const [name, c] of Object.entries(dev.config.interfaces)) {
    if (c.ip && inSubnet(c.ip.address, pool.network.address, pool.network.mask)) return name;
  }
  return 'Unknown';
}

export function dhcpBinding(world: World, dev: IosDevice, only?: string): string {
  const out = [
    'Bindings from all pools not associated with VRF:',
    'IP address      Client-ID/              Lease expiration        Type       State      Interface',
    '                Hardware address/',
    '                User name',
  ];
  const list = [...dev.runtime.dhcpBindings].filter((b) => !only || b.address === only).sort((a, b) => ipToInt(a.address) - ipToInt(b.address));
  for (const b of list) {
    const pool = dev.config.dhcp.pools.find((p) => p.name === b.pool);
    const secs = leaseSeconds(pool);
    const exp = secs === null ? 'Infinite' : dhcpDate(dev, b.grantedTick, secs);
    out.push(`${padR(b.address, 15)} ${padR(clientIdText(b.clientId), 23)} ${padR(exp, 23)} ${padR('Automatic', 10)} ${padR('Active', 10)} ${poolIface(dev, pool)}`);
  }
  return joinLines(out);
}

function excludedIn(dev: IosDevice, first: number, last: number): number {
  let n = 0;
  for (let a = first; a <= last; a++) {
    if (dev.config.dhcp.excluded.some((e) => a >= ipToInt(e.low) && a <= ipToInt(e.high || e.low))) n++;
  }
  return n;
}

export function dhcpPool(world: World, dev: IosDevice, only?: string): string {
  const out: string[] = [];
  for (const pool of dev.config.dhcp.pools) {
    if (only && pool.name !== only) continue;
    out.push('', `Pool ${pool.name} :`);
    out.push(' Utilization mark (high/low)    : 100 / 0');
    out.push(' Subnet size (first/next)       : 0 / 0 ');
    if (!pool.network) {
      out.push(' Total addresses                : 0', ' Leased addresses               : 0', ' Excluded addresses             : 0', ' Pending event                  : none', ' 0 subnet is currently in the pool :');
      continue;
    }
    const r = hostRange(pool.network.address, pool.network.mask);
    const first = ipToInt(r.first);
    const last = ipToInt(r.last);
    const total = r.count;
    const leased = dev.runtime.dhcpBindings.filter((b) => b.pool === pool.name).length;
    const excluded = total ? excludedIn(dev, first, last) : 0;
    out.push(` Total addresses                : ${total}`);
    out.push(` Leased addresses               : ${leased}`);
    out.push(` Excluded addresses             : ${excluded}`);
    out.push(' Pending event                  : none');
    out.push(' 1 subnet is currently in the pool :');
    out.push(' Current index        IP address range                    Leased/Excluded/Total');
    let index = '0.0.0.0';
    const bound = new Set(dev.runtime.dhcpBindings.map((b) => b.address));
    // the server continues after the last address it handed out
    const mine = dev.runtime.dhcpBindings.filter((b) => b.pool === pool.name).map((b) => ipToInt(b.address));
    const start = mine.length ? Math.max(...mine) + 1 : first;
    for (let a = start; a <= last && total; a++) {
      const ip = intToIp(a);
      if (bound.has(ip) || dev.config.dhcp.excluded.some((e) => a >= ipToInt(e.low) && a <= ipToInt(e.high || e.low))) continue;
      index = ip; break;
    }
    out.push(` ${padR(index, 20)} ${padR(r.first, 16)} - ${padR(r.last, 15)}  ${padR(leased, 5)} / ${padR(excluded, 5)} / ${total}`);
  }
  return joinLines(out);
}

/** Addresses the server found in use while pinging candidates (derived: in-use, non-excluded addresses it had to skip). */
export function dhcpConflicts(world: World, dev: IosDevice): { address: string; tick: number }[] {
  const out: { address: string; tick: number }[] = [];
  for (const pool of dev.config.dhcp.pools) {
    if (!pool.network) continue;
    const binds = dev.runtime.dhcpBindings.filter((b) => b.pool === pool.name);
    if (!binds.length) continue;
    const r = hostRange(pool.network.address, pool.network.mask);
    const maxBound = Math.max(...binds.map((b) => ipToInt(b.address)));
    const bound = new Set(dev.runtime.dhcpBindings.map((b) => b.address));
    for (let a = ipToInt(r.first); a < maxBound; a++) {
      const ip = intToIp(a);
      if (bound.has(ip) || dev.config.dhcp.excluded.some((e) => a >= ipToInt(e.low) && a <= ipToInt(e.high || e.low))) continue;
      if (findOwners(world, ip).length === 0) continue;
      const after = binds.filter((b) => ipToInt(b.address) > a).sort((x, y) => x.grantedTick - y.grantedTick)[0];
      out.push({ address: ip, tick: after?.grantedTick ?? world.tick });
    }
  }
  return out;
}
export function dhcpConflict(world: World, dev: IosDevice): string {
  const out = ['IP address        Detection method   Detection time          VRF'];
  for (const c of dhcpConflicts(world, dev)) out.push(`${padR(c.address, 17)} ${padR('Ping', 18)} ${padR(dhcpDate(dev, c.tick), 23)}`);
  return joinLines(out);
}

export function dhcpStatistics(world: World, dev: IosDevice): string {
  const n = dev.runtime.dhcpBindings.length;
  const rows = (pairs: [string, number][]) => pairs.map(([k, v]) => `${padR(k, 21)}${v}`);
  return joinLines([
    ...rows([['Memory usage', 42135 + n * 512], ['Address pools', dev.config.dhcp.pools.length], ['Database agents', 0], ['Automatic bindings', n],
      ['Manual bindings', 0], ['Expired bindings', 0], ['Malformed messages', 0], ['Secure arp entries', 0], ['Renew messages', 0],
      ['Workspace timeouts', 0], ['Static routes', 0], ['Relay bindings', 0]]),
    `${padR('Relay bindings active', 29)}0`, `${padR('Relay bindings terminated', 29)}0`, `${padR('Relay bindings selecting', 29)}0`,
    '',
    'Message              Received',
    ...rows([['BOOTREQUEST', 0], ['DHCPDISCOVER', n], ['DHCPREQUEST', n], ['DHCPDECLINE', 0], ['DHCPRELEASE', 0], ['DHCPINFORM', 0]]),
    '',
    'Message              Sent',
    ...rows([['BOOTREPLY', 0], ['DHCPOFFER', n], ['DHCPACK', n], ['DHCPNAK', 0]]),
  ]);
}

// ───────────────────────────── ACL ─────────────────────────────
const PROTO_NAMES: Record<number, string> = { 1: 'icmp', 2: 'igmp', 4: 'ipinip', 6: 'tcp', 17: 'udp', 47: 'gre', 50: 'esp', 51: 'ahp', 88: 'eigrp', 89: 'ospf', 103: 'pim' };
const ICMP_NAMES: Record<number, string> = { 0: 'echo-reply', 3: 'unreachable', 5: 'redirect', 8: 'echo', 11: 'time-exceeded', 12: 'parameter-problem', 13: 'timestamp-request', 14: 'timestamp-reply', 30: 'traceroute' };
function protoText(p: AclProtocol): string { return typeof p === 'number' ? PROTO_NAMES[p] ?? String(p) : p; }
function transport(p: AclProtocol): 'tcp' | 'udp' | null { const t = protoText(p); return t === 'tcp' || t === 'udp' ? t : null; }
function addr(a: AddrMatch, standard: boolean): string {
  if (a.kind === 'any') return 'any';
  if (a.kind === 'host') return standard ? a.address : `host ${a.address}`;
  if (a.wildcard === '0.0.0.0') return standard ? a.address : `host ${a.address}`;
  if (a.wildcard === '255.255.255.255') return 'any';
  const net = intToIp((ipToInt(a.address) & ~ipToInt(a.wildcard)) >>> 0);
  return standard ? `${net}, wildcard bits ${a.wildcard}` : `${net} ${a.wildcard}`;
}
function ports(pm: PortMatch, proto: 'tcp' | 'udp' | null): string {
  return `${pm.op} ${pm.ports.map((n) => (proto ? portName(n, proto) : String(n))).join(' ')}`;
}
/** ACE as `show access-lists` prints it (without the sequence number). */
export function aceShowText(acl: Acl, ace: Ace): string {
  if (acl.type === 'standard') {
    return `${ace.action === 'deny' ? 'deny  ' : 'permit'} ${addr(ace.src, true)}${ace.log ? ' log' : ''}`;
  }
  const tp = transport(ace.protocol);
  const parts = [ace.action, protoText(ace.protocol), addr(ace.src, false)];
  if (ace.srcPort) parts.push(ports(ace.srcPort, tp));
  parts.push(addr(ace.dst, false));
  if (ace.dstPort) parts.push(ports(ace.dstPort, tp));
  if (ace.icmpType !== undefined && ace.icmpType !== '') {
    const t = ace.icmpType;
    parts.push(typeof t === 'number' || /^\d+$/.test(String(t)) ? ICMP_NAMES[Number(t)] ?? String(t) : String(t));
  }
  if (ace.established) parts.push('established');
  if (ace.log) parts.push('log');
  return parts.join(' ');
}
function aclIdCompare(a: string, b: string): number {
  const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na !== nb) return na ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
export function aclBlock(dev: IosDevice, acl: Acl): string[] {
  const head = `${acl.type === 'standard' ? 'Standard' : 'Extended'} IP access list ${acl.id}`;
  const out = [head];
  for (const ace of acl.entries) {
    if (ace.action === 'remark') continue;
    const hits = dev.runtime.aclHits[`${acl.id}:${ace.seq}`] ?? 0;
    out.push(`    ${ace.seq} ${aceShowText(acl, ace)}${hits ? ` (${hits} match${hits === 1 ? '' : 'es'})` : ''}`);
  }
  return out;
}
export function showAccessLists(dev: IosDevice, only?: string): string {
  const acls = Object.values(dev.config.acls).sort((a, b) => aclIdCompare(a.id, b.id));
  const out: string[] = [];
  for (const acl of acls) {
    if (only !== undefined && acl.id !== only) continue;
    out.push(...aclBlock(dev, acl));
  }
  return joinLines(out);
}

// ───────────────────────────── NAT ─────────────────────────────
function staticGlobal(world: World, dev: IosDevice, r: { global?: string; interface?: string }): string {
  if (r.global) return r.global;
  if (r.interface) return dev.config.interfaces[r.interface]?.ip?.address ?? '0.0.0.0';
  return '0.0.0.0';
}
function natRow(pro: string, ig: string, il: string, ol: string, og: string): string {
  return `${padR(pro, 4)} ${padR(ig, 21)} ${padR(il, 21)} ${padR(ol, 21)} ${og}`;
}
interface NatRowData { text: string; t?: NatTranslation; staticRule?: boolean; simple?: boolean }
/** Is `ip` handed out by a dynamic rule with a pool and without overload? */
function simplePool(dev: IosDevice, ip: string): boolean {
  return dev.config.nat.dynamicRules.some((r) => {
    if (!r.pool || r.overload) return false;
    const p = dev.config.nat.pools.find((x) => x.name === r.pool);
    return !!p && ipToInt(ip) >= ipToInt(p.start) && ipToInt(ip) <= ipToInt(p.end);
  });
}
function natRows(world: World, dev: IosDevice): NatRowData[] {
  const rows: NatRowData[] = [];
  for (const r of natStaticRules(dev)) {
    const g = staticGlobal(world, dev, r);
    if (r.proto) {
      rows.push({ staticRule: true, text: natRow(r.proto, `${g}:${r.globalPort ?? 0}`, `${r.local}:${r.localPort ?? 0}`, '---', '---') });
    } else rows.push({ staticRule: true, text: natRow('---', g, r.local, '---', '---') });
  }
  const list = [...visibleNatTranslations(world, dev)].sort((a, b) => a.id - b.id);
  // dynamic NAT without overload keeps a simple address entry beside the per-session entries
  const simple = new Set<string>();
  for (const t of list) {
    if (t.fromStatic || !simplePool(dev, t.insideGlobal)) continue;
    const key = `${t.insideGlobal}|${t.insideLocal}`;
    if (simple.has(key)) continue;
    simple.add(key);
    rows.push({ simple: true, text: natRow('---', t.insideGlobal, t.insideLocal, '---', '---') });
  }
  for (const t of list) {
    rows.push({
      t, text: natRow(t.proto, `${t.insideGlobal}:${t.insideGlobalPort}`, `${t.insideLocal}:${t.insideLocalPort}`,
        `${t.outsideLocal}:${t.outsideLocalPort}`, `${t.outsideGlobal}:${t.outsideGlobalPort}`),
    });
  }
  return rows;
}
const NAT_TIMEOUT: Record<string, number> = { icmp: 60, udp: 300, tcp: 86400 };
function inputIdb(dev: IosDevice, t: NatTranslation): string {
  for (const [name, c] of Object.entries(dev.config.interfaces)) {
    if (c.natRole === 'inside' && c.ip && inSubnet(t.insideLocal, c.ip.address, c.ip.mask)) return name;
  }
  return Object.entries(dev.config.interfaces).find(([, c]) => c.natRole === 'inside')?.[0] ?? '';
}
export function natTranslations(world: World, dev: IosDevice, verbose: boolean): string {
  const rows = natRows(world, dev);
  const out = ['Pro  Inside global         Inside local          Outside local         Outside global'];
  const now = world.tick;
  let mapId = 0;
  for (const r of rows) {
    out.push(r.text);
    if (!verbose) continue;
    if (dev.kind === 'switch') {
      if (r.t) out.push(`  Flags: ${r.t.fromStatic ? 'static, ' : ''}extended; created at lab tick ${r.t.createdTick}`);
      else out.push(r.staticRule ? '  Flags: static mapping' : '  Flags: dynamic address mapping');
      continue;
    }
    if (r.simple) {
      out.push('  create: ' + shortDate(dev, now) + ', use: ' + shortDate(dev, now) + ', timeout: 23:59:59', '  Flags: none', '');
      continue;
    }
    if (r.staticRule) {
      mapId++;
      out.push(`  create: ${shortDate(dev, 0)}, use: ${shortDate(dev, 0)}, timeout: 00:00:00`);
      out.push(`  Map-Id(In): ${mapId}`);
      out.push('  Flags: static');
      out.push('  Mac-Address: 0000.0000.0000    Input-IDB: ');
      out.push(`  entry-id: 0x${(0x1000 + mapId).toString(16)}, use_count:0`);
      out.push('');
      continue;
    }
    const t = r.t!;
    const ageS = secondsAt(now) - secondsAt(t.createdTick);
    const to = NAT_TIMEOUT[t.proto] ?? 60;
    out.push(`  create: ${shortDate(dev, t.createdTick)}, use: ${shortDate(dev, now)}, timeout: ${hms(Math.max(0, to - Math.min(ageS, to - 1)))}`);
    out.push(`  Map-Id(In): ${t.fromStatic ? 1 : dev.config.nat.staticRules.length + 1}`);
    out.push(`  Flags: ${t.fromStatic ? 'static, ' : ''}extended`);
    out.push(`  Mac-Address: 0000.0000.0000    Input-IDB: ${inputIdb(dev, t)}`);
    out.push(`  entry-id: 0x${(0x2000 + t.id).toString(16)}, use_count:1`);
    out.push('');
  }
  out.push(`Total number of translations: ${rows.length}`);
  return joinLines(out);
}

export function natStatistics(world: World, dev: IosDevice): string {
  const nat = dev.config.nat;
  const tr = visibleNatTranslations(world, dev);
  const rows = natRows(world, dev);
  const statics = natStaticRules(dev).length;
  const dynamic = rows.length - statics;
  const extended = tr.length + natStaticRules(dev).filter((r) => !!r.proto).length;
  const out = [`Total active translations: ${statics + dynamic} (${statics} static, ${dynamic} dynamic; ${extended} extended)`];
  const outside = Object.keys(dev.config.interfaces).filter((n) => natRoleOn(dev, n) === 'outside');
  const inside = Object.keys(dev.config.interfaces).filter((n) => natRoleOn(dev, n) === 'inside');
  out.push('Outside interfaces:');
  out.push(outside.length ? `  ${outside.join(', ')}` : '');
  out.push('Inside interfaces: ');
  out.push(inside.length ? `  ${inside.join(', ')}` : '');
  out.push(`Hits: ${dev.runtime.natHits}  Misses: ${dev.runtime.natMisses}`);
  if (dev.kind === 'router') out.push('Expired translations: 0');
  out.push('Dynamic mappings:');
  if (nat.dynamicRules.length) out.push('-- Inside Source');
  nat.dynamicRules.forEach((r, i) => {
    const owners = tr.filter((t) => !t.fromStatic && (dev.kind === 'router' || t.mappingAcl === r.acl)).length;
    const target = r.pool ? `pool ${r.pool}` : `interface ${r.interface}`;
    const problem = catalystNatMappingProblem(world, dev, r);
    out.push(`[Id: ${i + 1}] access-list ${r.acl} ${target} refcount ${owners}${problem ? ` (inactive: ${problem})` : ''}`);
    if (r.pool) {
      const p = nat.pools.find((x) => x.name === r.pool);
      if (p) {
        const total = ipToInt(p.end) - ipToInt(p.start) + 1;
        const used = new Set(tr.filter((t) => (dev.kind === 'router' || t.mappingAcl === r.acl) && ipToInt(t.insideGlobal) >= ipToInt(p.start) && ipToInt(t.insideGlobal) <= ipToInt(p.end)).map((t) => t.insideGlobal)).size;
        out.push(` pool ${p.name}: id ${i + 1}, netmask ${p.mask}`);
        out.push(`\tstart ${p.start} end ${p.end}`);
        out.push(`\ttype ${p.rotary ? 'rotary' : 'generic'}, total addresses ${total}, allocated ${used} (${total ? Math.floor(used * 100 / total) : 0}%)${dev.kind === 'router' ? ', misses 0' : ''}`);
      }
    }
  });
  if (dev.kind === 'switch') {
    out.push('Lab counters: successful rewrites and failed allocations; ASIC/CEF and translation aging are not simulated.');
    return joinLines(out);
  }
  if (nat.insideDestinationRules.length) {
    out.push('-- Inside Destination');
    nat.insideDestinationRules.forEach((r, i) => out.push(`[Id: ${nat.dynamicRules.length + i + 1}] access-list ${r.acl} pool ${r.pool} refcount 0`));
  }
  out.push('nat-limit statistics:', ' max entry: max allowed 0, used 0, missed 0');
  out.push('In-to-out drops: 0  Out-to-in drops: 0');
  out.push('Pool stats drop: 0  Mapping stats drop: 0');
  out.push('Port block alloc fail: 0');
  out.push('IP alias add fail: 0');
  out.push('Limit entry add fail: 0');
  return joinLines(out);
}

