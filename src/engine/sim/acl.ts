/**
 * Access lists (ARCHITECTURE §6.2): first match wins, implicit deny at the end, an undefined (or empty) list permits everything.
 * Also: ACE text for traces, hit counters, and the helpers IPsec needs (mirror images, "does this entry cover that one").
 */
import type { Ace, Acl, AclProtocol, AddrMatch, IosRuntime, Packet, PortMatch } from '../types.ts';
import { ipToInt, matchesWildcard, portName } from '../ip.ts';

const PROTO_BY_NUMBER: Record<number, Packet['proto']> = { 1: 'icmp', 6: 'tcp', 17: 'udp', 50: 'esp' };
function protocolMatches(proto: AclProtocol, p: Packet): boolean {
  if (proto === 'ip') return true;
  if (typeof proto === 'number') return PROTO_BY_NUMBER[proto] === p.proto;
  if (proto === 'tcp' || proto === 'udp' || proto === 'icmp' || proto === 'esp') return p.proto === proto;
  return false; // ahp, gre, ospf, eigrp: the simulator never creates such packets
}

export function addrMatches(m: AddrMatch, ip: string): boolean {
  switch (m.kind) {
    case 'any': return true;
    case 'host': return m.address === ip;
    case 'net': return matchesWildcard(ip, m.address, m.wildcard);
  }
}

export function portMatches(m: PortMatch | undefined, port: number | undefined): boolean {
  if (!m) return true;
  const p = port ?? 0;
  switch (m.op) {
    case 'eq': return m.ports.includes(p);
    case 'neq': return !m.ports.includes(p);
    case 'lt': return p < m.ports[0];
    case 'gt': return p > m.ports[0];
    case 'range': return p >= m.ports[0] && p <= m.ports[1];
  }
}

/** IOS ICMP message keywords → [type, code?]. A keyword without a code matches every code of that type. */
const ICMP_KEYWORDS: Record<string, [number, number?]> = {
  'administratively-prohibited': [3, 13], 'alternate-address': [6], 'conversion-error': [31], 'dod-host-prohibited': [3, 10],
  'dod-net-prohibited': [3, 9], echo: [8], 'echo-reply': [0], 'general-parameter-problem': [12, 0], 'host-isolated': [3, 8],
  'host-precedence-unreachable': [3, 14], 'host-redirect': [5, 1], 'host-tos-redirect': [5, 3], 'host-tos-unreachable': [3, 12],
  'host-unknown': [3, 7], 'host-unreachable': [3, 1], 'information-reply': [16], 'information-request': [15],
  'mask-reply': [18], 'mask-request': [17], 'mobile-redirect': [32], 'net-redirect': [5, 0], 'net-tos-redirect': [5, 2],
  'net-tos-unreachable': [3, 11], 'net-unreachable': [3, 0], 'network-unknown': [3, 6], 'no-room-for-option': [12, 2],
  'option-missing': [12, 1], 'packet-too-big': [3, 4], 'parameter-problem': [12], 'port-unreachable': [3, 3],
  'precedence-unreachable': [3, 15], 'protocol-unreachable': [3, 2], 'reassembly-timeout': [11, 1], redirect: [5],
  'router-advertisement': [9], 'router-solicitation': [10], 'source-quench': [4], 'source-route-failed': [3, 5],
  'time-exceeded': [11], 'timestamp-reply': [14], 'timestamp-request': [13], traceroute: [30], 'ttl-exceeded': [11, 0],
  unreachable: [3],
};

/** ICMP type and code of a simulated packet. Code undefined = not known (matches any code). */
function icmpOf(p: Packet): [number, number | undefined] {
  const code = (p as { icmpCode?: string }).icmpCode;
  switch (p.icmpType ?? 'echo') {
    case 'echo': return [8, 0];
    case 'echo-reply': return [0, 0];
    case 'admin-prohibited': return [3, 13];
    case 'time-exceeded': return [11, 0];
    case 'unreachable': return [3, code === 'net' ? 0 : code === 'host' ? 1 : code === 'port' ? 3 : code === 'admin' ? 13 : undefined];
  }
}

/** `want` is a keyword ('echo'), a type number (8), or 'type code' ('3 13'). */
function icmpTypeMatches(want: string | number, p: Packet): boolean {
  let type: number;
  let code: number | undefined;
  if (typeof want === 'number') type = want;
  else if (ICMP_KEYWORDS[want]) [type, code] = ICMP_KEYWORDS[want];
  else {
    const m = /^(\d+)(?:\s+(\d+))?$/.exec(want.trim());
    if (!m) return false;
    type = Number(m[1]);
    code = m[2] === undefined ? undefined : Number(m[2]);
  }
  const [haveType, haveCode] = icmpOf(p);
  if (type !== haveType) return false;
  return code === undefined || haveCode === undefined || code === haveCode;
}

/** Does one entry match the packet? `standard` lists look at the source address only. */
export function aceMatches(ace: Ace, p: Packet, standard = false): boolean {
  if (ace.action === 'remark') return false;
  if (!addrMatches(ace.src, p.src)) return false;
  if (standard) return true;
  if (!protocolMatches(ace.protocol, p)) return false;
  if (!addrMatches(ace.dst, p.dst)) return false;
  const l4 = p.proto === 'tcp' || p.proto === 'udp';
  if (ace.srcPort || ace.dstPort) {
    if (!l4) return false;
    if (!portMatches(ace.srcPort, p.sport)) return false;
    if (!portMatches(ace.dstPort, p.dport)) return false;
  }
  if (ace.icmpType !== undefined) {
    if (p.proto !== 'icmp' || !icmpTypeMatches(ace.icmpType, p)) return false;
  }
  if (ace.established) {
    if (p.proto !== 'tcp' || p.tcpSyn === true) return false;
  }
  return true;
}

/**
 * Evaluate an access list. `implicit` is true when no entry decided:
 *  - list not defined, or defined without any permit/deny entry → permit (IOS filters nothing in that case),
 *  - no entry matched → the implicit `deny ip any any` at the end.
 */
export function aclEvaluate(acl: Acl | undefined, packet: Packet): { permit: boolean; ace?: Ace; implicit: boolean } {
  if (!acl) return { permit: true, implicit: true };
  const entries = acl.entries.filter((e) => e.action !== 'remark');
  if (entries.length === 0) return { permit: true, implicit: true };
  const standard = acl.type === 'standard';
  for (const ace of entries) {
    if (aceMatches(ace, packet, standard)) return { permit: ace.action === 'permit', ace, implicit: false };
  }
  return { permit: false, implicit: true };
}

/** Count a match on an entry (`show access-lists` shows these). */
export function countHit(runtime: IosRuntime, aclId: string, ace: Ace | undefined): void {
  if (!ace) return;
  const key = `${aclId}:${ace.seq}`;
  runtime.aclHits[key] = (runtime.aclHits[key] ?? 0) + 1;
}

// ───────────── text ─────────────
function addrText(m: AddrMatch, standard: boolean): string {
  switch (m.kind) {
    case 'any': return 'any';
    case 'host': return standard ? m.address : `host ${m.address}`;
    case 'net': return `${m.address} ${m.wildcard}`;
  }
}
function portMatchText(m: PortMatch | undefined, proto: AclProtocol): string {
  if (!m) return '';
  const tp = proto === 'udp' ? 'udp' : 'tcp';
  return ` ${m.op} ${m.ports.map((p) => portName(p, tp)).join(' ')}`;
}

/** The entry as it would be typed, e.g. 'deny ip host 192.168.100.10 host 2.2.2.2'. */
export function aceText(ace: Ace, type: 'standard' | 'extended' = 'extended'): string {
  if (ace.action === 'remark') return `remark ${ace.remark ?? ''}`;
  if (type === 'standard') return `${ace.action} ${addrText(ace.src, true)}${ace.log ? ' log' : ''}`;
  let s = `${ace.action} ${ace.protocol} ${addrText(ace.src, false)}${portMatchText(ace.srcPort, ace.protocol)}`;
  s += ` ${addrText(ace.dst, false)}${portMatchText(ace.dstPort, ace.protocol)}`;
  if (ace.icmpType !== undefined) s += ` ${ace.icmpType}`;
  if (ace.established) s += ' established';
  if (ace.log) s += ' log';
  return s;
}

/** 'access list 110' / 'access list allowPC1' — for sentences. */
export function aclName(id: string): string { return `access list ${id}`; }

/** Evidence line for a trace: the list and the deciding entry (or the implicit rule). */
export function aclEvidence(id: string, acl: Acl | undefined, result: { ace?: Ace; implicit: boolean; permit: boolean }): string {
  if (!acl) return `access list ${id} is not defined, so it filters nothing`;
  if (result.ace) {
    const line = aceText(result.ace, acl.type);
    return acl.named
      ? `ip access-list ${acl.type} ${id} → ${result.ace.seq} ${line}`
      : `access-list ${id} ${line}   (entry ${result.ace.seq})`;
  }
  if (result.permit) return `access list ${id} has no permit/deny entries, so it filters nothing`;
  return `access list ${id}: no entry matches → implicit "deny ip any any" at the end of every list`;
}

// ───────────── helpers for IPsec ─────────────
/** The packet as its answer would look: source and destination swapped. */
export function mirrorPacket<T extends Packet>(p: T): T {
  return { ...p, src: p.dst, dst: p.src, sport: p.dport, dport: p.sport };
}

function addrCovers(big: AddrMatch, small: AddrMatch): boolean {
  if (big.kind === 'any') return true;
  if (big.kind === 'net' && big.wildcard === '255.255.255.255') return true;
  if (small.kind === 'any') return false;
  if (small.kind === 'host') return addrMatches(big, small.address);
  // small is a net
  if (big.kind === 'host') return small.wildcard === '0.0.0.0' && small.address === big.address;
  const wb = ipToInt(big.wildcard);
  const ws = ipToInt(small.wildcard);
  if (((wb | ws) >>> 0) !== wb) return false; // small must not have "don't care" bits that big cares about
  const care = (~wb) >>> 0;
  return ((ipToInt(big.address) & care) >>> 0) === ((ipToInt(small.address) & care) >>> 0);
}

function intervals(m: PortMatch): [number, number][] {
  switch (m.op) {
    case 'eq': return m.ports.map((p) => [p, p] as [number, number]);
    case 'neq': {
      const p = m.ports[0];
      const out: [number, number][] = [];
      if (p > 0) out.push([0, p - 1]);
      if (p < 65535) out.push([p + 1, 65535]);
      return out;
    }
    case 'lt': return m.ports[0] > 0 ? [[0, m.ports[0] - 1]] : [];
    case 'gt': return m.ports[0] < 65535 ? [[m.ports[0] + 1, 65535]] : [];
    case 'range': return [[m.ports[0], m.ports[1]]];
  }
}
function portCovers(big: PortMatch | undefined, small: PortMatch | undefined): boolean {
  if (!big) return true;
  if (!small) return false;
  const b = intervals(big);
  return intervals(small).every(([lo, hi]) => b.some(([blo, bhi]) => blo <= lo && bhi >= hi));
}
function protoCovers(big: AclProtocol, small: AclProtocol): boolean {
  if (big === 'ip') return true;
  const norm = (x: AclProtocol) => (typeof x === 'number' ? (PROTO_BY_NUMBER[x] ?? x) : x);
  return norm(big) === norm(small);
}

/**
 * IPsec proxy check: does `theirs` (an entry of the responder's crypto ACL) cover the mirror image of `mine`
 * (the initiator's matching entry)? Mirror image = source and destination swapped, ports swapped.
 */
export function aceCoversMirror(theirs: Ace, mine: Ace): boolean {
  if (theirs.action !== 'permit') return false;
  if (!protoCovers(theirs.protocol, mine.protocol)) return false;
  if (!addrCovers(theirs.src, mine.dst)) return false;
  if (!addrCovers(theirs.dst, mine.src)) return false;
  if (!portCovers(theirs.srcPort, mine.dstPort)) return false;
  if (!portCovers(theirs.dstPort, mine.srcPort)) return false;
  if (theirs.icmpType !== undefined && theirs.icmpType !== mine.icmpType) return false;
  return true;
}

/** The mirror image of an entry, as text — what the other router's crypto ACL should contain. */
export function mirrorAceText(ace: Ace): string {
  const m: Ace = { ...ace, src: ace.dst, dst: ace.src, srcPort: ace.dstPort, dstPort: ace.srcPort };
  return aceText(m, 'extended');
}
