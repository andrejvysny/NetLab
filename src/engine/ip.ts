/** IPv4, interface-name and well-known-port helpers. Pure functions, no state. Owned by the orchestrator. */

export function isIp(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}
export function ipToInt(s: string): number {
  const p = s.split('.').map(Number);
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}
export function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
/** True for contiguous subnet masks such as 255.255.255.192 (0.0.0.0 and 255.255.255.255 included). */
export function isMask(s: string): boolean {
  if (!isIp(s)) return false;
  const inv = (~ipToInt(s)) >>> 0;
  return (inv & (inv + 1)) === 0;
}
export function maskToPrefix(mask: string): number {
  let n = ipToInt(mask), c = 0;
  while (n & 0x80000000) { c++; n = (n << 1) >>> 0; }
  return c;
}
export function prefixToMask(len: number): string {
  return intToIp(len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0);
}
export function maskToWildcard(mask: string): string { return intToIp((~ipToInt(mask)) >>> 0); }
export function wildcardToMask(wc: string): string { return intToIp((~ipToInt(wc)) >>> 0); }
export function networkOf(address: string, mask: string): string { return intToIp((ipToInt(address) & ipToInt(mask)) >>> 0); }
export function broadcastOf(address: string, mask: string): string {
  return intToIp(((ipToInt(address) & ipToInt(mask)) | (~ipToInt(mask))) >>> 0);
}
export function inSubnet(ip: string, network: string, mask: string): boolean {
  return ((ipToInt(ip) & ipToInt(mask)) >>> 0) === ((ipToInt(network) & ipToInt(mask)) >>> 0);
}
export function sameSubnet(a: string, b: string, mask: string): boolean { return inSubnet(a, b, mask); }
/** ACL-style match: bits set in the wildcard are "don't care". */
export function matchesWildcard(ip: string, address: string, wildcard: string): boolean {
  const care = (~ipToInt(wildcard)) >>> 0;
  return ((ipToInt(ip) & care) >>> 0) === ((ipToInt(address) & care) >>> 0);
}
/** Classful default mask (used by `network` statements and DHCP pools without a mask). */
export function classfulMask(ip: string): string {
  const first = Number(ip.split('.')[0]);
  return first < 128 ? '255.0.0.0' : first < 192 ? '255.255.0.0' : '255.255.255.0';
}
export function isPrivate(ip: string): boolean {
  const n = ipToInt(ip);
  return inRange(n, '10.0.0.0', '10.255.255.255') || inRange(n, '172.16.0.0', '172.31.255.255') || inRange(n, '192.168.0.0', '192.168.255.255');
}
function inRange(n: number, lo: string, hi: string): boolean { return n >= ipToInt(lo) && n <= ipToInt(hi); }
/** Usable host addresses of a subnet: first, last and count (0 for /31 and /32). */
export function hostRange(network: string, mask: string): { first: string; last: string; count: number } {
  const len = maskToPrefix(mask);
  const net = ipToInt(networkOf(network, mask));
  const size = len >= 31 ? 0 : 2 ** (32 - len) - 2;
  return { first: intToIp(net + 1), last: intToIp(net + Math.max(size, 1)), count: size };
}

// ───────────── Interface names ─────────────
const IF_TYPES: [string, string][] = [
  // [canonical, short] — order matters for prefix matching
  ['GigabitEthernet', 'Gi'],
  ['FastEthernet', 'Fa'],
  ['TenGigabitEthernet', 'Te'],
  ['Serial', 'Se'],
  ['Loopback', 'Lo'],
  ['Vlan', 'Vl'],
  ['Tunnel', 'Tu'],
  ['Ethernet', 'Et'],
];
/**
 * Parse what a user types for an interface: 'g0/0/0', 'gi 0/0/0', 'GigabitEthernet0/0/0', 's0/1/0', 'lo100', 'vlan 1'.
 * Returns the canonical name ('GigabitEthernet0/0/0') or null. `typeOnly` reports a bare, valid type prefix ('gi').
 */
export function parseIfName(input: string): { name: string } | { typeOnly: string } | null {
  const m = /^([A-Za-z]+)\s*([0-9][0-9/.:]*)?$/.exec(input.trim());
  if (!m) return null;
  const typed = m[1].toLowerCase();
  const matches = IF_TYPES.filter(([canon]) => canon.toLowerCase().startsWith(typed));
  if (matches.length === 0) return null;
  // 'e' is ambiguous in theory; prefer the first table entry that matches (GigabitEthernet for 'g', Serial for 's'…)
  const canon = matches[0][0];
  if (!m[2]) return { typeOnly: canon };
  return { name: canon + m[2] };
}
export function shortIfName(name: string): string {
  for (const [canon, short] of IF_TYPES) if (name.startsWith(canon)) return short + name.slice(canon.length);
  return name;
}
/** Sort key so interfaces list like IOS: Gi0/0/0, Gi0/0/1, Se0/1/0, Lo0, Vlan1. */
export function ifSortKey(name: string): string {
  const typeRank = ['GigabitEthernet', 'FastEthernet', 'TenGigabitEthernet', 'Ethernet', 'Serial', 'Tunnel', 'Loopback', 'Vlan']
    .findIndex((t) => name.startsWith(t));
  const nums = (name.match(/\d+/g) ?? []).map((n) => n.padStart(5, '0')).join('/');
  return String(typeRank < 0 ? 9 : typeRank) + ':' + nums;
}

// ───────────── Well-known ports / protocols ─────────────
export const PORT_NAMES: Record<string, number> = {
  'ftp-data': 20, ftp: 21, ssh: 22, telnet: 23, smtp: 25, domain: 53, bootps: 67, bootpc: 68, tftp: 69, www: 80,
  pop3: 110, ntp: 123, snmp: 161, snmptrap: 162, bgp: 179, isakmp: 500, syslog: 514, 'non500-isakmp': 4500,
};
/** 'www' → 80, '80' → 80, unknown → null. */
export function parsePort(s: string): number | null {
  if (/^\d+$/.test(s)) { const n = Number(s); return n <= 65535 ? n : null; }
  return PORT_NAMES[s.toLowerCase()] ?? null;
}
/** 80 → 'www' for the given transport ('tcp' | 'udp'), else the number as text. IOS prints names in running-config. */
export function portName(port: number, proto: 'tcp' | 'udp'): string {
  const tcpOnly = ['ftp-data', 'ftp', 'ssh', 'telnet', 'smtp', 'www', 'pop3', 'bgp'];
  const udpOnly = ['bootps', 'bootpc', 'tftp', 'ntp', 'snmp', 'snmptrap', 'isakmp', 'syslog', 'non500-isakmp'];
  for (const [name, n] of Object.entries(PORT_NAMES)) {
    if (n !== port) continue;
    if (name === 'ssh') return '22'; // IOS shows 22 numerically
    if (name === 'domain') return name;
    if (proto === 'tcp' && tcpOnly.includes(name)) return name;
    if (proto === 'udp' && udpOnly.includes(name)) return name;
  }
  return String(port);
}
export const PROTO_NUMBERS: Record<string, number> = { icmp: 1, tcp: 6, udp: 17, gre: 47, esp: 50, ahp: 51, eigrp: 88, ospf: 89 };
