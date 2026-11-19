/**
 * Running-config rendering: structured IosConfig → the text of `show running-config` (IOS XE 17.3 look).
 *
 * Section order (see renderRunningConfig):
 *   header (version, service …) → hostname → boot markers → enable secret/password → no aaa new-model
 *   → ip routing / no ip domain lookup / ip domain … → ip dhcp excluded-address → ip dhcp pool blocks → other global lines
 *   → spanning-tree (switch) → usernames → vlan blocks (switch) → class-maps → policy-maps → crypto isakmp policy/key
 *   → crypto ipsec transform-set → crypto map → interfaces (Loopback, Tunnel, physical, Vlan) → router ospf → router rip
 *   → ip default-gateway → ip forward-protocol nd → ip http/ssh … → ip nat → ip route → named ACLs (ip access-list …)
 *   → logging → numbered ACLs (access-list N …) → snmp-server → control-plane → banner → alias → line con/aux/vty → ntp → end
 *
 * Secrets: `enable secret` and `username … secret` print as `9 $9$sim$<reversible encoding>` (a simulator hash);
 * with `service password-encryption` line passwords and `enable password` print as Cisco type 7 (the real reversible algorithm).
 */
import { effectiveSnmpHosts, validSnmpHost } from '../snmp.ts';
import type {
  Acl, Ace, AclProtocol, AddrMatch, ClassMatch, InterfaceConfig, IosConfig, IosDevice, LineConfig, PolicyClass, PortMatch, World,
} from '../types.ts';
import { defaultIosConfig, getIos } from '../world.ts';
import { classfulMask, ifSortKey, intToIp, ipToInt, isIp, networkOf, portName } from '../ip.ts';

// ───────────────────────────── Secrets ─────────────────────────────
/** Cisco type 7 translation table (the real one). */
const XLAT = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';
const SIM_PREFIX = '$9$sim$';
const CRYPT64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function utf8(s: string): number[] { return [...new TextEncoder().encode(s)]; }
function fromUtf8(bytes: number[]): string { return new TextDecoder().decode(new Uint8Array(bytes)); }

/** Cisco type 7 encoding (`password 7 …`). The seed is derived from the text so output is deterministic. */
export function type7Encode(plain: string, seed?: number): string {
  const bytes = utf8(plain);
  const s = seed ?? bytes.reduce((a, b) => a + b, 0) % 16;
  let out = String(s).padStart(2, '0');
  bytes.forEach((b, i) => { out += ((b ^ XLAT.charCodeAt((s + i) % XLAT.length)) & 0xff).toString(16).toUpperCase().padStart(2, '0'); });
  return out;
}
/** Decode a Cisco type 7 string; null when it is not valid type 7. */
export function type7Decode(hash: string): string | null {
  if (!/^\d{2}(?:[0-9A-Fa-f]{2})*$/.test(hash)) return null;
  const s = Number(hash.slice(0, 2));
  if (s > 52) return null;
  const bytes: number[] = [];
  for (let i = 2, n = 0; i < hash.length; i += 2, n++) bytes.push(parseInt(hash.slice(i, i + 2), 16) ^ XLAT.charCodeAt((s + n) % XLAT.length));
  try { return fromUtf8(bytes); } catch { return null; }
}
/** Simulator stand-in for a type 9 secret: `$9$sim$<crypt64 of the XOR-masked text>` (reversible on purpose). */
export function simSecretEncode(plain: string): string {
  const bytes = utf8(plain).map((b, i) => b ^ XLAT.charCodeAt(i % XLAT.length));
  let out = SIM_PREFIX;
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = i + 1 >= bytes.length ? 2 : i + 2 >= bytes.length ? 3 : 4;
    for (let k = 0; k < chars; k++) out += CRYPT64[(n >> (18 - 6 * k)) & 63];
  }
  return out;
}
/** Inverse of simSecretEncode; null when the text is not a simulator secret. */
export function simSecretDecode(hash: string): string | null {
  if (!hash.startsWith(SIM_PREFIX)) return null;
  const body = hash.slice(SIM_PREFIX.length);
  if (body.length % 4 === 1 || [...body].some((c) => !CRYPT64.includes(c))) return null;
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 4) {
    const chunk = body.slice(i, i + 4);
    let n = 0;
    for (let k = 0; k < 4; k++) n = (n << 6) | (k < chunk.length ? CRYPT64.indexOf(chunk[k]) : 0);
    bytes.push((n >> 16) & 255);
    if (chunk.length > 2) bytes.push((n >> 8) & 255);
    if (chunk.length > 3) bytes.push(n & 255);
  }
  try { return fromUtf8(bytes.map((b, i) => b ^ XLAT.charCodeAt(i % XLAT.length))); } catch { return null; }
}
/** `enable secret` / `username … secret` value as running-config shows it ("9 $9$sim$…"). Already-hashed values are kept. */
function secretText(value: string): string {
  if (/^\$9\$/.test(value)) return `9 ${value}`;
  if (/^\$8\$/.test(value)) return `8 ${value}`;
  if (/^\$1\$/.test(value)) return `5 ${value}`;
  return `9 ${simSecretEncode(value)}`;
}
function passwordText(value: string, encrypt: boolean): string {
  return encrypt ? `7 ${type7Encode(value)}` : /^[07]\s+\S/.test(value) ? `0 ${value}` : value;
}

// ───────────────────────────── ACLs ─────────────────────────────
const PROTO_NAMES: Record<number, string> = {
  1: 'icmp', 2: 'igmp', 4: 'ipinip', 6: 'tcp', 17: 'udp', 47: 'gre', 50: 'esp', 51: 'ahp', 88: 'eigrp', 89: 'ospf', 94: 'nos', 103: 'pim', 108: 'pcp',
};
const ICMP_NAMES: Record<number, string> = {
  0: 'echo-reply', 3: 'unreachable', 4: 'source-quench', 5: 'redirect', 6: 'alternate-address', 8: 'echo', 9: 'router-advertisement',
  10: 'router-solicitation', 11: 'time-exceeded', 12: 'parameter-problem', 13: 'timestamp-request', 14: 'timestamp-reply',
  15: 'information-request', 16: 'information-reply', 17: 'mask-request', 18: 'mask-reply', 30: 'traceroute', 31: 'conversion-error', 32: 'mobile-redirect',
};
function protoText(p: AclProtocol): string {
  if (typeof p === 'number') return PROTO_NAMES[p] ?? String(p);
  return p;
}
function protoTransport(p: AclProtocol): 'tcp' | 'udp' | null {
  const t = protoText(p);
  return t === 'tcp' || t === 'udp' ? t : null;
}
function addrText(a: AddrMatch, standard: boolean): string {
  if (a.kind === 'any') return 'any';
  if (a.kind === 'host') return standard ? a.address : `host ${a.address}`;
  if (a.wildcard === '0.0.0.0') return standard ? a.address : `host ${a.address}`;
  if (a.wildcard === '255.255.255.255') return 'any';
  // IOS stores the address with the wildcard bits cleared: 192.168.1.5 0.0.0.255 → 192.168.1.0 0.0.0.255
  const net = isIp(a.address) && isIp(a.wildcard) ? intToIp((ipToInt(a.address) & ~ipToInt(a.wildcard)) >>> 0) : a.address;
  return `${net} ${a.wildcard}`;
}
function portText(pm: PortMatch, proto: 'tcp' | 'udp' | null): string {
  const name = (n: number) => (proto ? portName(n, proto) : String(n));
  return `${pm.op} ${pm.ports.map(name).join(' ')}`;
}
function icmpText(t: string | number): string {
  if (typeof t === 'number') return ICMP_NAMES[t] ?? String(t);
  if (/^\d+$/.test(t)) return ICMP_NAMES[Number(t)] ?? t;
  return t;
}
/** ACE body without sequence number or `access-list N`, e.g. 'permit tcp any any eq www'. `deny` is padded like IOS ("deny   ip …"). */
export function formatAce(acl: Acl, ace: Ace): string {
  if (ace.action === 'remark') return `remark ${ace.remark ?? ''}`.trimEnd();
  const action = ace.action === 'deny' ? 'deny  ' : 'permit';
  const parts: string[] = [action];
  if (acl.type === 'standard') {
    parts.push(addrText(ace.src, true));
  } else {
    const transport = protoTransport(ace.protocol);
    parts.push(protoText(ace.protocol));
    parts.push(addrText(ace.src, false));
    if (ace.srcPort) parts.push(portText(ace.srcPort, transport));
    parts.push(addrText(ace.dst, false));
    if (ace.dstPort) parts.push(portText(ace.dstPort, transport));
    if (ace.icmpType !== undefined && ace.icmpType !== '') parts.push(icmpText(ace.icmpType));
    if (ace.established) parts.push('established');
  }
  if (ace.log) parts.push('log');
  return parts.join(' ');
}
/** ACL exactly as running-config prints it (numbered: one 'access-list N …' line per ACE; named: header + indented, sequenced ACEs). */
export function formatAcl(acl: Acl): string[] {
  if (!acl.named) return acl.entries.map((e) => `access-list ${acl.id} ${formatAce(acl, e)}`);
  // IOS XE 16.12+ shows the sequence numbers of named ACL entries in the configuration.
  return [`ip access-list ${acl.type} ${acl.id}`, ...acl.entries.map((e) => ` ${e.seq} ${formatAce(acl, e)}`)];
}
function aclIdCompare(a: string, b: string): number {
  const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na !== nb) return na ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// ───────────────────────────── Interfaces ─────────────────────────────
const PHYSICAL = /^(GigabitEthernet|FastEthernet|TenGigabitEthernet|Ethernet|Serial)/;
function ifGroup(name: string): number {
  if (name.startsWith('Loopback')) return 0;
  if (name.startsWith('Tunnel')) return 1;
  if (name.startsWith('Vlan')) return 3;
  return 2;
}
export function interfaceOrder(names: string[]): string[] {
  return [...names].sort((a, b) => ifGroup(a) - ifGroup(b) || (ifSortKey(a) < ifSortKey(b) ? -1 : ifSortKey(a) > ifSortKey(b) ? 1 : 0));
}
const notAuto = (v?: string) => !!v && v !== 'auto';

/** One interface block as lines: ['interface GigabitEthernet0/0/0', ' ip address …', …] (no trailing '!'). */
export function renderInterface(device: IosDevice, ifName: string): string[] {
  const i: InterfaceConfig | undefined = device.config.interfaces[ifName];
  if (!i) return [];
  const name = i.name || ifName;
  const out = [`interface ${name}`];
  const physical = PHYSICAL.test(name);
  const isSwitch = device.kind === 'switch';
  const l2 = isSwitch && physical && !!i.switchport;
  if (i.description) out.push(` description ${i.description}`);
  if (l2 && i.switchport) {
    if (i.switchport.accessVlan !== 1) out.push(` switchport access vlan ${i.switchport.accessVlan}`);
    if (i.switchport.mode !== 'dynamic') out.push(` switchport mode ${i.switchport.mode}`);
  } else if (isSwitch && physical) out.push(' no switchport');
  if (i.bandwidthKbps !== undefined) out.push(` bandwidth ${i.bandwidthKbps}`);
  if (!l2) {
    for (const s of i.secondary ?? []) out.push(` ip address ${s.address} ${s.mask} secondary`);
    if (i.ip) out.push(` ip address ${i.ip.address} ${i.ip.mask}`);
    else if (!(i.secondary ?? []).length) out.push(' no ip address');
    if (i.aclIn) out.push(` ip access-group ${i.aclIn} in`);
    if (i.aclOut) out.push(` ip access-group ${i.aclOut} out`);
    for (const h of i.helperAddresses ?? []) out.push(` ip helper-address ${h}`);
    if (i.noIpUnreachables) out.push(' no ip unreachables');
    if (i.natRole) out.push(` ip nat ${i.natRole}`);
  }
  if (i.encapsulation === 'ppp') out.push(' encapsulation ppp');
  if (i.shutdown) out.push(' shutdown');
  if (i.clockRate !== undefined) out.push(` clock rate ${i.clockRate}`);
  const furniture: string[] = [];
  if (notAuto(i.duplex)) out.push(` duplex ${i.duplex}`);
  if (notAuto(i.speed)) out.push(` speed ${i.speed}`);
  if (device.kind === 'router' && name.startsWith('GigabitEthernet')) {
    // ISR 4000 Ethernet ports always show their auto-negotiation state.
    const off = notAuto(i.duplex) || notAuto(i.speed) || (i.extraLines ?? []).some((x) => x.trim() === 'no negotiation auto');
    out.push(off ? ' no negotiation auto' : ' negotiation auto');
    furniture.push('negotiation auto', 'no negotiation auto');
  }
  if (i.cryptoMap) out.push(` crypto map ${i.cryptoMap}`);
  if (i.servicePolicyIn) out.push(` service-policy input ${i.servicePolicyIn}`);
  if (i.servicePolicyOut) out.push(` service-policy output ${i.servicePolicyOut}`);
  for (const x of i.extraLines ?? []) {
    const t = x.trim();
    if (t && !furniture.includes(t)) out.push(` ${t}`);
  }
  return out;
}

// ───────────────────────────── QoS ─────────────────────────────
function classMatchText(m: ClassMatch): string {
  switch (m.kind) {
    case 'access-group': return /^\d+$/.test(m.acl) ? `match access-group ${m.acl}` : `match access-group name ${m.acl}`;
    case 'protocol': return `match protocol ${m.protocol}`;
    case 'dscp': return `match dscp ${m.values.join(' ')}`;
    case 'precedence': return `match precedence ${m.values.join(' ')}`;
    case 'any': return 'match any';
  }
}
function policyClassLines(c: PolicyClass): string[] {
  const out = [` class ${c.className}`];
  if (c.setDscp) out.push(`  set dscp ${c.setDscp}`);
  if (c.police) out.push(`  police ${c.police.bps}`);
  if (c.priority) {
    const p = c.priority;
    const burst = p.burstBytes !== undefined ? ` ${p.burstBytes}` : '';
    if (p.percent !== undefined) out.push(`  priority percent ${p.percent}${burst}`);
    else if (p.kbps !== undefined) out.push(`  priority ${p.kbps}${burst}`);
    else out.push('  priority');
  }
  if (c.bandwidth) {
    const b = c.bandwidth;
    if (b.remainingPercent !== undefined) out.push(`  bandwidth remaining percent ${b.remainingPercent}`);
    else if (b.percent !== undefined) out.push(`  bandwidth percent ${b.percent}`);
    else if (b.kbps !== undefined) out.push(`  bandwidth ${b.kbps}`);
  }
  if (c.shapeAverage) {
    const s = c.shapeAverage;
    if (s.percent !== undefined) out.push(`  shape average percent ${s.percent}`);
    else if (s.bps !== undefined) out.push(`  shape average ${s.bps}`);
    // A child policy under a shaper is nested one level deeper, as IOS prints it.
    if (c.servicePolicy) out.push(`   service-policy ${c.servicePolicy}`);
  }
  if (c.fairQueue) out.push('  fair-queue');
  if (c.queueLimit !== undefined) out.push(`  queue-limit ${c.queueLimit} packets`);
  if (c.servicePolicy && !c.shapeAverage) out.push(`  service-policy ${c.servicePolicy}`);
  for (const x of c.extraLines ?? []) if (x.trim()) out.push(`  ${x.trim()}`);
  return out;
}

// ───────────────────────────── Lines ─────────────────────────────
function lineBody(l: LineConfig, vty: boolean, encrypt: boolean, console = false): string[] {
  const out: string[] = [];
  if (l.accessClassIn) out.push(` access-class ${l.accessClassIn} in`);
  if (l.accessClassOut) out.push(` access-class ${l.accessClassOut} out`);
  if (l.execTimeout && !(l.execTimeout[0] === 10 && l.execTimeout[1] === 0)) out.push(` exec-timeout ${l.execTimeout[0]} ${l.execTimeout[1]}`);
  if (l.password !== undefined && l.password !== '') out.push(` password ${passwordText(l.password, encrypt)}`);
  if (l.loggingSynchronous) out.push(' logging synchronous');
  if (l.login === 'local') out.push(' login local');
  else if (l.login) out.push(' login');
  else if (vty) out.push(' no login');
  if (l.transportInput) out.push(` transport input ${l.transportInput}`);
  for (const x of l.extraLines ?? []) if (x.trim() && !(console && x.trim() === 'stopbits 1')) out.push(` ${x.trim()}`);
  // The console line always shows its stop bits on IOS XE.
  if (console && !(l.extraLines ?? []).some((x) => /^stopbits\s/.test(x.trim()))) out.push(' stopbits 1');
  return out;
}

// ───────────────────────────── Global extra lines ─────────────────────────────
type Zone = 'service' | 'loggingTop' | 'clock' | 'domain' | 'misc' | 'stp' | 'users' | 'crypto' | 'http' | 'nat' | 'loggingLow' | 'banner' | 'alias' | 'ntp';
function zoneOf(line: string): Zone {
  const l = line.trim();
  if (/^(no )?service\s/.test(l)) return 'service';
  if (/^(no )?logging\s+(buffered|console|monitor|rate-limit|count|persistent|queue-limit)\b/.test(l)) return 'loggingTop';
  if (/^(no )?logging\b/.test(l)) return 'loggingLow';
  if (/^(no )?clock\s/.test(l)) return 'clock';
  if (/^(no )?ip\s+(domain|name-server|host|cef)\b/.test(l) || /^(no )?ipv6\s+(cef|unicast-routing)\b/.test(l)) return 'domain';
  if (/^(no )?(spanning-tree|vtp)\s/.test(l)) return 'stp';
  if (/^username\s/.test(l)) return 'users';
  if (/^(no )?crypto\s/.test(l)) return 'crypto';
  if (/^(no )?ip\s+nat\s/.test(l)) return 'nat';
  if (/^(no )?ip\s+(http|ssh|tftp|scp)\b/.test(l)) return 'http';
  if (/^banner\s/.test(l)) return 'banner';
  if (/^alias\s/.test(l)) return 'alias';
  if (/^(no )?ntp\s/.test(l)) return 'ntp';
  return 'misc';
}
/** Lines the renderer always prints itself; an identical extra line is not printed twice. */
const FURNITURE = new Set([
  'version 17.3', 'service timestamps debug datetime msec', 'service timestamps log datetime msec', 'boot-start-marker', 'boot-end-marker',
  'no aaa new-model', 'ip forward-protocol nd', 'control-plane', 'spanning-tree extend system-id', 'spanning-tree mode rapid-pvst', 'end',
]);

const SWITCH_PROVISION: Record<string, string> = { c9300l: 'c9300l-24t-4g' };

// ───────────────────────────── Running-config ─────────────────────────────
/** Body of the running-config: from the first '!' after "Current configuration" to 'end' (lines, no header). */
export function renderConfigLines(device: IosDevice): string[] {
  const c: IosConfig = device.config;
  const isRouter = device.kind === 'router';
  const encrypt = c.servicePasswordEncryption;
  const out: string[] = [];
  const bang = () => { if (out.length === 0 || out[out.length - 1] !== '!') out.push('!'); };
  const push = (...l: string[]) => { for (const x of l) out.push(x); };

  const zones: Record<Zone, string[]> = {
    service: [], loggingTop: [], clock: [], domain: [], misc: [], stp: [], users: [], crypto: [], http: [], nat: [], loggingLow: [], banner: [], alias: [], ntp: [],
  };
  for (const raw of [...(c.extraLines ?? []), ...(c.logging.extraLines ?? [])]) {
    const l = raw.trim();
    if (!l || l === '!' || FURNITURE.has(l)) continue;
    zones[zoneOf(l)].push(l);
  }

  // Header
  push('!', 'version 17.3');
  for (const kind of ['debug', 'log']) {
    if (!zones.service.some((l) => new RegExp(`^(no )?service timestamps ${kind}\\b`).test(l))) push(`service timestamps ${kind} datetime msec`);
  }
  if (encrypt) push('service password-encryption');
  push(...zones.service);
  bang();
  push(`hostname ${c.hostname}`);
  bang();
  push('boot-start-marker', 'boot-end-marker');
  bang();
  push(...zones.loggingTop);
  bang();
  if (c.enableSecret) push(`enable secret ${secretText(c.enableSecret)}`);
  if (c.enablePassword) push(`enable password ${passwordText(c.enablePassword, encrypt)}`);
  bang();
  push('no aaa new-model');
  if (!isRouter && SWITCH_PROVISION[device.model]) push(`switch 1 provision ${SWITCH_PROVISION[device.model]}`);
  push(...zones.clock);
  bang();

  // IP basics and DHCP
  if (isRouter && !c.ipRouting) push('no ip routing');
  if (!isRouter && c.ipRouting) push('ip routing');
  if (!c.ipDomainLookup) push('no ip domain lookup');
  push(...zones.domain);
  for (const x of c.dhcp.excluded) push(x.low === x.high || !x.high ? `ip dhcp excluded-address ${x.low}` : `ip dhcp excluded-address ${x.low} ${x.high}`);
  bang();
  for (const p of c.dhcp.pools) {
    push(`ip dhcp pool ${p.name}`);
    if (p.network) push(` network ${p.network.address} ${p.network.mask}`);
    if (p.defaultRouters.length) push(` default-router ${p.defaultRouters.join(' ')}`);
    if (p.dnsServers.length) push(` dns-server ${p.dnsServers.join(' ')}`);
    if (p.domainName) push(` domain-name ${p.domainName}`);
    if (p.lease && !/^1(\s+0)*$/.test(p.lease.trim())) push(` lease ${p.lease}`);
    for (const x of p.extraLines ?? []) if (x.trim()) push(` ${x.trim()}`);
    bang();
  }
  push(...zones.misc);
  bang();

  // Spanning tree (Catalyst defaults)
  if (!isRouter) {
    if (!zones.stp.some((l) => /^spanning-tree mode\s/.test(l))) push('spanning-tree mode rapid-pvst');
    if (!zones.stp.includes('no spanning-tree extend system-id')) push('spanning-tree extend system-id');
  }
  push(...zones.stp.filter((l) => l !== 'no spanning-tree extend system-id'));
  bang();

  // Users
  for (const u of c.users) push(`username ${u.name}${u.privilege !== undefined ? ` privilege ${u.privilege}` : ''} secret ${secretText(u.secret)}`);
  push(...zones.users);
  bang();

  // VLANs (switch)
  const vlanIds = Object.keys(c.vlans ?? {}).filter((v) => /^\d+$/.test(v)).map(Number).sort((a, b) => a - b);
  for (const v of vlanIds) {
    if (v === 1 || (v >= 1002 && v <= 1005)) continue;
    push(`vlan ${v}`);
    const name = c.vlans[String(v)]?.name;
    if (name && name !== `VLAN${String(v).padStart(4, '0')}`) push(` name ${name}`);
    bang();
  }

  // QoS
  for (const cm of c.qos.classMaps) {
    push(`class-map ${cm.matchType} ${cm.name}`);
    if (cm.description) push(` description ${cm.description}`);
    for (const m of cm.matches) push(` ${classMatchText(m)}`);
  }
  bang();
  for (const pm of c.qos.policyMaps) {
    push(`policy-map ${pm.name}`);
    if (pm.description) push(` description ${pm.description}`);
    const classes = [...pm.classes.filter((k) => k.className !== 'class-default'), ...pm.classes.filter((k) => k.className === 'class-default')];
    for (const k of classes) push(...policyClassLines(k));
  }
  bang();

  // Crypto
  if (!c.crypto.isakmpEnabled) push('no crypto isakmp enable');
  for (const p of [...c.crypto.isakmpPolicies].sort((a, b) => a.priority - b.priority)) {
    push(`crypto isakmp policy ${p.priority}`);
    if (p.encryption && p.encryption !== 'des') push(` encr ${p.encryption}`);
    if (p.hash && p.hash !== 'sha') push(` hash ${p.hash}`);
    if (p.authentication && p.authentication !== 'rsa-sig') push(` authentication ${p.authentication}`);
    if (p.group && p.group !== 1) push(` group ${p.group}`);
    if (p.lifetime && p.lifetime !== 86400) push(` lifetime ${p.lifetime}`);
  }
  for (const k of c.crypto.isakmpKeys) push(`crypto isakmp key ${k.key} address ${k.address}${k.mask ? ` ${k.mask}` : ''}`);
  push(...zones.crypto);
  bang();
  for (const t of c.crypto.transformSets) {
    push(`crypto ipsec transform-set ${t.name} ${t.transforms.join(' ')}`, ` mode ${t.mode}`);
    bang();
  }
  for (const m of c.crypto.maps) {
    for (const e of [...m.entries].sort((a, b) => a.seq - b.seq)) {
      push(`crypto map ${m.name} ${e.seq} ${e.type}`);
      if (e.description) push(` description ${e.description}`);
      for (const p of e.peers) push(` set peer ${p}`);
      if (e.saLifetimeSeconds !== undefined) push(` set security-association lifetime seconds ${e.saLifetimeSeconds}`);
      if (e.saLifetimeKilobytes !== undefined) push(` set security-association lifetime kilobytes ${e.saLifetimeKilobytes}`);
      if (e.transformSets.length) push(` set transform-set ${e.transformSets.join(' ')}`);
      if (e.pfsGroup !== undefined) push(` set pfs group${e.pfsGroup}`);
      if (e.matchAcl) push(` match address ${e.matchAcl}`);
      if (e.qosPreClassify) push(' qos pre-classify');
    }
    bang();
  }

  // Interfaces
  for (const name of interfaceOrder(Object.keys(c.interfaces))) {
    push(...renderInterface(device, name));
    bang();
  }

  // Routing protocols
  for (const o of [...c.ospf].sort((a, b) => a.processId - b.processId)) {
    push(`router ospf ${o.processId}`);
    if (o.routerId) push(` router-id ${o.routerId}`);
    for (const p of o.passive) push(` passive-interface ${p}`);
    for (const n of o.networks) push(` network ${n.address} ${n.wildcard} area ${n.area}`);
    if (o.defaultOriginate) push(' default-information originate');
    bang();
  }
  if (c.rip) {
    const r = c.rip;
    push('router rip');
    if (r.version) push(` version ${r.version}`);
    for (const p of r.passive) push(` passive-interface ${p}`);
    for (const n of r.networks) push(` network ${isIp(n) ? networkOf(n, classfulMask(n)) : n}`);
    if (r.defaultOriginate) push(' default-information originate');
    if (!r.autoSummary) push(' no auto-summary');
    bang();
  }

  // IP services, NAT, static routes
  if (c.defaultGateway) push(`ip default-gateway ${c.defaultGateway}`);
  push('ip forward-protocol nd');
  push(...zones.http);
  push(...zones.nat);
  for (const p of c.nat.pools) push(`ip nat pool ${p.name} ${p.start} ${p.end} netmask ${p.mask}${p.rotary ? ' type rotary' : ''}`);
  for (const d of c.nat.dynamicRules) {
    const target = d.pool ? `pool ${d.pool}` : `interface ${d.interface}`;
    push(`ip nat inside source list ${d.acl} ${target}${d.overload ? ' overload' : ''}`);
  }
  for (const s of c.nat.staticRules) {
    const proto = s.proto ? `${s.proto} ` : '';
    const local = s.localPort !== undefined ? `${s.local} ${s.localPort}` : s.local;
    const global = s.interface ? `interface ${s.interface}${s.globalPort !== undefined ? ` ${s.globalPort}` : ''}`
      : s.globalPort !== undefined ? `${s.global} ${s.globalPort}` : `${s.global}`;
    push(`ip nat inside source static ${proto}${local} ${global}${s.extendable ? ' extendable' : ''}`);
  }
  for (const d of c.nat.insideDestinationRules) push(`ip nat inside destination list ${d.acl} pool ${d.pool}`);
  for (const r of c.staticRoutes) {
    const parts = ['ip route', r.prefix, r.mask];
    if (r.exitInterface) parts.push(r.exitInterface);
    if (r.nextHop) parts.push(r.nextHop);
    if (r.distance !== undefined) parts.push(String(r.distance));
    push(parts.join(' '));
  }
  bang();

  // Named ACLs (standard first, then extended), logging, numbered ACLs
  const acls = Object.values(c.acls);
  const named = acls.filter((a) => a.named).sort((a, b) => (a.type === b.type ? aclIdCompare(a.id, b.id) : a.type === 'standard' ? -1 : 1));
  for (const a of named) push(...formatAcl(a));
  bang();
  push(...zones.loggingLow);
  if (c.logging.trapLevel && c.logging.trapLevel !== 'informational' && c.logging.trapLevel !== '6') push(`logging trap ${c.logging.trapLevel}`);
  if (c.logging.sourceInterface) push(`logging source-interface ${c.logging.sourceInterface}`);
  for (const h of c.logging.hosts) push(`logging host ${h}`);
  for (const a of acls.filter((x) => !x.named).sort((x, y) => aclIdCompare(x.id, y.id))) push(...formatAcl(a));
  bang();

  // SNMP
  const s = c.snmp;
  for (const v of s.views) push(`snmp-server view ${v.name} ${v.oid} ${v.included ? 'included' : 'excluded'}`);
  for (const cm of s.communities) push(`snmp-server community ${cm.name}${cm.view ? ` view ${cm.view}` : ''} ${cm.access.toUpperCase()}${cm.acl ? ` ${cm.acl}` : ''}`);
  if (s.trapSource) push(`snmp-server trap-source ${s.trapSource}`);
  if (s.location) push(`snmp-server location ${s.location}`);
  if (s.contact) push(`snmp-server contact ${s.contact}`);
  for (const t of s.enableTraps) push(t === 'all' || t === '' ? 'snmp-server enable traps' : `snmp-server enable traps ${t}`);
  for (const t of s.disableTraps ?? []) push(`no snmp-server enable traps ${t}`);
  for (const h of effectiveSnmpHosts(s).filter(validSnmpHost)) {
    const parts = ['snmp-server host', h.address];
    if (h.type === 'informs') parts.push('informs');
    if (h.version) parts.push('version', h.version);
    if (h.version === '3') parts.push(h.securityLevel ?? 'noauth');
    parts.push(h.community, ...(h.notificationTypes ?? []));
    push(parts.join(' '));
  }
  for (const x of s.extraLines ?? []) if (x.trim()) push(x.trim());
  bang();

  // Control plane, banner, aliases
  push('control-plane');
  if (!isRouter) push(' service-policy input system-cpp-policy');
  bang();
  if (c.bannerMotd !== undefined && c.bannerMotd !== '') push(...`banner motd ^C${c.bannerMotd}^C`.split('\n'));
  push(...zones.banner);
  bang();
  for (const a of c.aliases) push(`alias ${a.mode} ${a.name} ${a.command}`);
  push(...zones.alias);
  bang();

  // Lines
  push('line con 0', ...lineBody(c.lines.console, false, encrypt, true));
  if (isRouter) push('line aux 0', ' stopbits 1');
  for (const v of [...c.lines.vty].sort((a, b) => a.first - b.first)) {
    push(v.first === v.last ? `line vty ${v.first}` : `line vty ${v.first} ${v.last}`, ...lineBody(v, true, encrypt));
  }
  bang();
  push(...zones.ntp);
  bang();
  push('end');
  return out;
}

function byteLength(s: string): number { return new TextEncoder().encode(s).length; }
/** Wrap body lines in the "Building configuration..." header with the byte count, as IOS prints it. */
export function withHeader(lines: string[]): string {
  const body = lines.join('\n') + '\n';
  return `Building configuration...\n\nCurrent configuration : ${byteLength(body)} bytes\n${body}`;
}

/** Full `show running-config` text (header, sections in IOS order, `end`). */
export function renderRunningConfig(world: World, deviceId: string): string {
  return withHeader(renderConfigLines(getIos(world, deviceId)));
}

/** `show running-config interface <if>` text, or null when the interface does not exist. */
export function renderInterfaceConfig(device: IosDevice, ifName: string): string | null {
  const block = renderInterface(device, ifName);
  if (!block.length) return null;
  return withHeader(['!', ...block, 'end']);
}

/** Lines that matter when comparing two configurations (drops the header, byte count and blank lines). */
export function configBodyLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) =>
    l !== '' && !/^Building configuration/.test(l) && !/^Current configuration\s*:/.test(l) && !/^Using \d+ out of \d+ bytes/.test(l));
}

/** True when the running-config differs from the saved startup-config (header/byte-count lines ignored).
 *  With nothing saved, the comparison is against the factory-default configuration. */
export function renderStartupDiff(world: World, deviceId: string): boolean {
  const dev = getIos(world, deviceId);
  const running = configBodyLines(renderRunningConfig(world, deviceId));
  let saved: string[];
  if (dev.startupConfig !== null && dev.startupConfig !== undefined) saved = configBodyLines(dev.startupConfig);
  else saved = configBodyLines(withHeader(renderConfigLines({ ...dev, config: defaultIosConfig(dev.kind, dev.ports) })));
  if (running.length !== saved.length) return true;
  return running.some((l, i) => l !== saved[i]);
}
