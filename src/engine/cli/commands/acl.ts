/**
 * Access lists: numbered `access-list N …` (standard 1-99/1300-1999, extended 100-199/2000-2699), named
 * `ip access-list standard|extended <name>` with the config-std-nacl / config-ext-nacl sub-modes, `ip access-group`
 * on interfaces, `ip access-list resequence`, and `clear [ip] access-list counters`.
 *
 * How the ACE grammar works
 * - The pattern DSL describes every ACE form (so `?`, abbreviations and the IOS error caret work as on a router).
 *   Port values are `word` parameters; their meaning is checked afterwards.
 * - The semantics come from ONE hand-written parser, `parseAce()`, which is also exported for other modules.
 *   The CLI handlers give it the part of the line that starts at the action word.
 *
 * Normalisation (like IOS): `A 0.0.0.0` → host A, `X 255.255.255.255` → any, address bits covered by the wildcard are
 * cleared, protocol numbers with a name become the name (6 → tcp), ICMP type numbers with a name become the name
 * (8 → echo, 3 13 → administratively-prohibited), port names are stored as numbers.
 *
 * Sequence numbers: a new entry gets (highest entry sequence number + 10). A remark does not use a sequence number of
 * its own: it carries the sequence number of the entry that follows it (IOS XE prints ` 10 remark …` / ` 10 permit …`).
 * So remark entries may share their `seq` with the next permit/deny entry; they always come first.
 *
 * session.ctx in config-std-nacl / config-ext-nacl: { acl: string (id = key of config.acls), type: 'standard' | 'extended' }.
 */
import type { Acl, Ace, AclProtocol, AddrMatch, PortMatch } from '../../types.ts';
import type { CmdEnv, CommandDef } from '../framework.ts';
import { currentInterfaces, promptFor, registerCommands } from '../framework.ts';
import { intToIp, ipToInt, isIp, isMask, parseIfName, parsePort, PORT_NAMES } from '../../ip.ts';

// ───────────────────────────── Shared CLI helpers (also used by nat.ts, snmp.ts, logging.ts) ─────────────────────────────
export interface LineToken { text: string; start: number }
export function lineTokens(line: string): LineToken[] {
  const out: LineToken[] = []; const re = /\S+/g; let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push({ text: m[0], start: m.index });
  return out;
}
/** Print the IOS caret error under position `pos` of `env.line` and stop the command. */
export function invalidAt(env: CmdEnv, pos: number): never {
  const pad = (env.promptLen || promptFor(env.world, env.session).length) + Math.max(0, pos);
  return env.reject(`${' '.repeat(pad)}^\n% Invalid input detected at '^' marker.`);
}
/** Offset in `line` of the token(s) that name interface `canonical` (falls back to the last token). */
export function interfaceTokenAt(line: string, canonical: string): number {
  const toks = lineTokens(line);
  for (let i = 0; i < toks.length; i++) {
    const r = parseIfName(toks[i].text);
    if (!r) continue;
    if ('name' in r && r.name.toLowerCase() === canonical.toLowerCase()) return toks[i].start;
    if ('typeOnly' in r && toks[i + 1] && (r.typeOnly + toks[i + 1].text).toLowerCase() === canonical.toLowerCase()) return toks[i].start;
  }
  return toks.length ? toks[toks.length - 1].start : 0;
}
/**
 * A command refers to an interface (NAT, logging source-interface, snmp-server trap-source …).
 * A physical port this device does not have is invalid input (as on IOS). A virtual interface (Loopback, Tunnel, Vlan)
 * that is not created yet is accepted with a remark.
 */
export function checkInterfaceRef(env: CmdEnv, canonical: string): void {
  if (env.device.config.interfaces[canonical]) return;
  if (/^(Loopback|Tunnel|Vlan)\d+$/.test(canonical)) {
    env.note(`${canonical} does not exist yet. Create it with "interface ${canonical}", or this setting has no effect.`);
    return;
  }
  invalidAt(env, interfaceTokenAt(env.line, canonical));
}
/** Replace (or add) one accepted-but-not-simulated line, keyed by its leading words. */
export function setExtraLine(list: string[], key: string, line: string | null): void {
  const k = key.toLowerCase();
  for (let i = list.length - 1; i >= 0; i--) {
    const l = list[i].toLowerCase();
    if (l === k || l.startsWith(k + ' ') || l === 'no ' + k || l.startsWith('no ' + k + ' ')) list.splice(i, 1);
  }
  if (line !== null) list.push(line);
}

// ───────────────────────────── Keyword tables ─────────────────────────────
const PROTO_KEYWORDS = ['ahp', 'eigrp', 'esp', 'gre', 'icmp', 'igmp', 'ip', 'ipinip', 'nos', 'ospf', 'pcp', 'pim', 'tcp', 'udp'] as const;
/** Protocol keywords that AclProtocol has no name for are stored as their number. */
const PROTO_AS_NUMBER: Record<string, number> = { igmp: 2, ipinip: 4, nos: 94, pcp: 108, pim: 103 };
const PROTO_BY_NUMBER: Record<number, AclProtocol> = { 1: 'icmp', 6: 'tcp', 17: 'udp', 47: 'gre', 50: 'esp', 51: 'ahp', 88: 'eigrp', 89: 'ospf' };
const PROTO_HELP: Record<string, string> = {
  ahp: 'Authentication Header Protocol', eigrp: "Cisco's EIGRP routing protocol", esp: 'Encapsulation Security Payload',
  gre: "Cisco's GRE tunneling", icmp: 'Internet Control Message Protocol', igmp: 'Internet Gateway Message Protocol',
  ip: 'Any Internet Protocol', ipinip: 'IP in IP tunneling', nos: 'KA9Q NOS compatible IP over IP tunneling',
  ospf: 'OSPF routing protocol', pcp: 'Payload Compression Protocol', pim: 'Protocol Independent Multicast',
  tcp: 'Transmission Control Protocol', udp: 'User Datagram Protocol',
};

/** IOS port keywords per transport (`access-list 101 permit tcp any any eq ?`). IOS has no `ssh` or `https` keyword. */
export const TCP_PORT_KEYWORDS: Record<string, number> = {
  bgp: 179, chargen: 19, cmd: 514, daytime: 13, discard: 9, domain: 53, drip: 3949, echo: 7, exec: 512, finger: 79,
  ftp: 21, 'ftp-data': 20, gopher: 70, hostname: 101, ident: 113, irc: 194, klogin: 543, kshell: 544, login: 513,
  lpd: 515, msrpc: 135, nntp: 119, 'onep-plain': 15001, 'onep-tls': 15002, 'pim-auto-rp': 496, pop2: 109, pop3: 110,
  smtp: 25, sunrpc: 111, syslog: 514, tacacs: 49, talk: 517, telnet: 23, time: 37, uucp: 540, whois: 43, www: 80,
};
export const UDP_PORT_KEYWORDS: Record<string, number> = {
  biff: 512, bootpc: 68, bootps: 67, discard: 9, dnsix: 195, domain: 53, echo: 7, isakmp: 500, 'mobile-ip': 434,
  nameserver: 42, 'netbios-dgm': 138, 'netbios-ns': 137, 'netbios-ss': 139, 'non500-isakmp': 4500, ntp: 123,
  'pim-auto-rp': 496, rip: 520, ripv6: 521, snmp: 161, snmptrap: 162, sunrpc: 111, syslog: 514, tacacs: 49, talk: 517,
  tftp: 69, time: 37, who: 513, xdmcp: 177,
};

/** ICMP message keywords: [type, code] (code undefined = any code of that type). */
export const ICMP_KEYWORDS: Record<string, [number, number?]> = {
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
const ICMP_HELP: Record<string, string> = {
  'administratively-prohibited': 'Administratively prohibited', 'alternate-address': 'Alternate address',
  'conversion-error': 'Datagram conversion', 'dod-host-prohibited': 'Host prohibited', 'dod-net-prohibited': 'Net prohibited',
  echo: 'Echo (ping)', 'echo-reply': 'Echo reply', 'general-parameter-problem': 'Parameter problem',
  'host-isolated': 'Host isolated', 'host-precedence-unreachable': 'Host unreachable for precedence',
  'host-redirect': 'Host redirect', 'host-tos-redirect': 'Host redirect for TOS', 'host-tos-unreachable': 'Host unreachable for TOS',
  'host-unknown': 'Host unknown', 'host-unreachable': 'Host unreachable', 'information-reply': 'Information replies',
  'information-request': 'Information requests', 'mask-reply': 'Mask replies', 'mask-request': 'Mask requests',
  'mobile-redirect': 'Mobile host redirect', 'net-redirect': 'Network redirect', 'net-tos-redirect': 'Net redirect for TOS',
  'net-tos-unreachable': 'Network unreachable for TOS', 'net-unreachable': 'Net unreachable', 'network-unknown': 'Network unknown',
  'no-room-for-option': 'Parameter required but no room', 'option-missing': 'Parameter required but not present',
  'packet-too-big': 'Fragmentation needed and DF set', 'parameter-problem': 'All parameter problems',
  'port-unreachable': 'Port unreachable', 'precedence-unreachable': 'Precedence cutoff',
  'protocol-unreachable': 'Protocol unreachable', 'reassembly-timeout': 'Reassembly timeout', redirect: 'All redirects',
  'router-advertisement': 'Router discovery advertisements', 'router-solicitation': 'Router discovery solicitations',
  'source-quench': 'Source quenches', 'source-route-failed': 'Source route failed', 'time-exceeded': 'All time exceededs',
  'timestamp-reply': 'Timestamp replies', 'timestamp-request': 'Timestamp requests', traceroute: 'Traceroute',
  'ttl-exceeded': 'TTL exceeded', unreachable: 'All unreachables',
};
const ICMP_KW_LIST = Object.keys(ICMP_KEYWORDS).sort();

/** Number ranges of numbered lists. */
export function aclNumberType(id: string): 'standard' | 'extended' | null {
  if (!/^\d+$/.test(id)) return null;
  const n = Number(id);
  if ((n >= 1 && n <= 99) || (n >= 1300 && n <= 1999)) return 'standard';
  if ((n >= 100 && n <= 199) || (n >= 2000 && n <= 2699)) return 'extended';
  return null;
}

// ───────────────────────────── parseAce ─────────────────────────────
export type AceParseResult =
  | { ace: Omit<Ace, 'seq'>; notes?: string[] }
  | { error: string; kind: 'invalid' | 'incomplete' | 'ambiguous'; at: number; hint?: string };

class AceError extends Error {
  kind: 'invalid' | 'incomplete' | 'ambiguous'; at: number; hint?: string;
  constructor(kind: 'invalid' | 'incomplete' | 'ambiguous', at: number, hint?: string) {
    super(kind); this.kind = kind; this.at = at; this.hint = hint;
  }
}
const AMBIG = Symbol('ambiguous');
function kwMatch(tok: string, cands: readonly string[]): string | typeof AMBIG | null {
  const low = tok.toLowerCase();
  if (cands.includes(low)) return low;
  const m = cands.filter((c) => c.startsWith(low));
  if (m.length > 1) return AMBIG;
  return m[0] ?? null;
}

/** Resolve a port value (number or IOS keyword, abbreviations allowed) for tcp/udp. */
export function resolveAclPort(tok: string, proto: 'tcp' | 'udp'): { port: number } | { error: 'invalid' | 'ambiguous'; hint?: string } {
  if (/^\d+$/.test(tok)) {
    const n = parsePort(tok);
    return n === null ? { error: 'invalid', hint: 'A port number is 0 to 65535.' } : { port: n };
  }
  const table = proto === 'tcp' ? TCP_PORT_KEYWORDS : UDP_PORT_KEYWORDS;
  const m = kwMatch(tok, Object.keys(table));
  if (m === AMBIG) return { error: 'ambiguous' };
  if (m !== null) return { port: table[m] };
  const low = tok.toLowerCase();
  if (low === 'ssh') return { error: 'invalid', hint: 'IOS has no port name "ssh" in access lists. Type the number: eq 22.' };
  if (low === 'https') return { error: 'invalid', hint: 'IOS has no port name "https" in access lists. Type the number: eq 443.' };
  const other = proto === 'tcp' ? UDP_PORT_KEYWORDS : TCP_PORT_KEYWORDS;
  if (other[low] !== undefined) {
    return { error: 'invalid', hint: `"${low}" is a ${proto === 'tcp' ? 'UDP' : 'TCP'} port name, but this entry is ${proto.toUpperCase()}. Use ${proto === 'tcp' ? 'udp' : 'tcp'}, or type the number ${other[low]}.` };
  }
  if (PORT_NAMES[low] !== undefined) return { error: 'invalid', hint: `Type the port number instead: ${PORT_NAMES[low]}.` };
  return { error: 'invalid' };
}

function normAddr(address: string, wildcard: string, notes: string[]): AddrMatch {
  const w = ipToInt(wildcard);
  if (w === 0) return { kind: 'host', address };
  if (w === 0xffffffff) return { kind: 'any' };
  const a = (ipToInt(address) & ~w) >>> 0;
  const net = intToIp(a);
  if (isMask(wildcard)) {
    notes.push(`${wildcard} looks like a subnet mask. In an access list the second number is a wildcard (the inverse of the mask): ` +
      `for example 0.0.0.255 matches a /24 network. IOS used ${wildcard} as a wildcard.`);
  }
  if (net !== address) notes.push(`IOS keeps only the bits the wildcard checks: ${address} ${wildcard} is stored as ${net} ${wildcard}.`);
  return { kind: 'net', address: net, wildcard };
}

function icmpValue(type: number, code: number | undefined): string | number {
  for (const [kw, [t, c]] of Object.entries(ICMP_KEYWORDS)) if (t === type && c === code) return kw;
  return code === undefined ? type : `${type} ${code}`;
}

/**
 * Parse one access-list entry: `permit|deny …` or `remark <text>`, the way IOS reads it after `access-list N` or inside
 * a named list. Keywords may be abbreviated. Errors carry `at` (offset into `text` of the offending token; text length
 * for an incomplete command) and an optional plain-English `hint`.
 */
export function parseAce(type: 'standard' | 'extended', text: string): AceParseResult {
  try {
    return parseAceInner(type, text);
  } catch (e) {
    if (!(e instanceof AceError)) throw e;
    const error = e.kind === 'incomplete' ? '% Incomplete command.'
      : e.kind === 'ambiguous' ? `% Ambiguous command:  "${text.trim()}"`
      : "% Invalid input detected at '^' marker.";
    const out: AceParseResult = { error, kind: e.kind, at: e.at };
    if (e.hint) out.hint = e.hint;
    return out;
  }
}

function fail(kind: 'invalid' | 'incomplete' | 'ambiguous', at: number, hint?: string): never {
  throw new AceError(kind, at, hint);
}

const PORT_OPS = ['eq', 'gt', 'lt', 'neq', 'range'];

function parseAceInner(type: 'standard' | 'extended', text: string): AceParseResult {
  const toks = lineTokens(text);
  let i = 0;
  const notes: string[] = [];
  const end = text.replace(/\s+$/, '').length;
  const peek = (): LineToken | undefined => toks[i];
  const need = (): LineToken => toks[i] ?? fail('incomplete', end);
  const kw = (t: LineToken, cands: readonly string[]): string | null => {
    const m = kwMatch(t.text, cands);
    if (m === AMBIG) return fail('ambiguous', t.start);
    return m;
  };
  const ip = (): string => {
    const t = need();
    if (!isIp(t.text)) fail('invalid', t.start);
    i++;
    return t.text;
  };
  /** any | host A | A W (standard: A [W]). Returns a keyword from `extraKw` without consuming it. */
  const addr = (optionalWildcard: boolean, extraKw: readonly string[]): AddrMatch | string => {
    const t = need();
    const m = kw(t, ['any', 'host', ...extraKw]);
    if (m === 'any') { i++; return { kind: 'any' }; }
    if (m === 'host') { i++; return { kind: 'host', address: ip() }; }
    if (m) return m;
    const a = ip();
    if (optionalWildcard) {
      const w = peek();
      if (w && isIp(w.text)) { i++; return normAddr(a, w.text, notes); }
      return { kind: 'host', address: a };
    }
    return normAddr(a, ip(), notes);
  };
  /** Trailing flags in IOS order: [established] [log]. */
  const flags = (allowed: readonly string[]): { established?: boolean; log?: boolean } => {
    const f: { established?: boolean; log?: boolean } = {};
    let cands = [...allowed];
    for (let t = peek(); t; t = peek()) {
      const m = kw(t, cands);
      if (!m) fail('invalid', t.start);
      i++;
      if (m === 'established') { f.established = true; cands = ['log']; } else { f.log = true; cands = []; }
    }
    return f;
  };

  const a = need();
  const action = kw(a, ['deny', 'permit', 'remark']) ?? fail('invalid', a.start);
  i++;
  if (action === 'remark') {
    const t = need();
    return { ace: { action: 'remark', remark: text.slice(t.start).trim(), protocol: 'ip', src: { kind: 'any' }, dst: { kind: 'any' } } };
  }
  const act = action as 'permit' | 'deny';

  if (type === 'standard') {
    const src = addr(true, []) as AddrMatch;
    const f = flags(['log']);
    const ace: Omit<Ace, 'seq'> = { action: act, protocol: 'ip', src, dst: { kind: 'any' } };
    if (f.log) ace.log = true;
    return notes.length ? { ace, notes } : { ace };
  }

  // Extended: protocol
  const pt = need();
  const pm = kw(pt, PROTO_KEYWORDS);
  let protocol: AclProtocol;
  if (pm) protocol = (PROTO_AS_NUMBER[pm] ?? pm) as AclProtocol;
  else if (/^\d+$/.test(pt.text) && Number(pt.text) <= 255) protocol = PROTO_BY_NUMBER[Number(pt.text)] ?? Number(pt.text);
  else return fail('invalid', pt.start);
  i++;
  const transport: 'tcp' | 'udp' | null = pm === 'tcp' || pm === 'udp' ? pm : null;
  const portValue = (): number => {
    const t = need();
    const r = resolveAclPort(t.text, transport ?? 'tcp');
    if ('error' in r) return fail(r.error, t.start, r.hint);
    i++;
    return r.port;
  };
  const portMatch = (op: string): PortMatch => {
    if (op === 'range') { const lo = portValue(); const hi = portValue(); return { op: 'range', ports: [lo, hi] }; }
    return { op: op as PortMatch['op'], ports: [portValue()] };
  };

  const src = addr(false, []) as AddrMatch;
  let srcPort: PortMatch | undefined;
  let dst: AddrMatch;
  const afterSrc = addr(false, transport ? PORT_OPS : []);
  if (typeof afterSrc === 'string') { i++; srcPort = portMatch(afterSrc); dst = addr(false, []) as AddrMatch; }
  else dst = afterSrc;

  let dstPort: PortMatch | undefined;
  let icmpType: string | number | undefined;
  let f: { established?: boolean; log?: boolean };
  if (transport) {
    const t = peek();
    if (t) {
      const m = kw(t, [...PORT_OPS, ...(transport === 'tcp' ? ['established'] : []), 'log']) ?? fail('invalid', t.start);
      if (PORT_OPS.includes(m)) { i++; dstPort = portMatch(m); }
    }
    f = flags(transport === 'tcp' ? ['established', 'log'] : ['log']);
  } else if (pm === 'icmp') {
    const t = peek();
    if (t) {
      if (/^\d+$/.test(t.text)) {
        const ty = Number(t.text);
        if (ty > 255) fail('invalid', t.start);
        i++;
        let code: number | undefined;
        const c = peek();
        if (c && /^\d+$/.test(c.text)) { if (Number(c.text) > 255) fail('invalid', c.start); code = Number(c.text); i++; }
        icmpType = icmpValue(ty, code);
      } else {
        const m = kw(t, [...ICMP_KW_LIST, 'log']) ?? fail('invalid', t.start);
        if (m !== 'log') { i++; icmpType = m; }
      }
    }
    f = flags(['log']);
  } else {
    f = flags(['log']);
  }
  // stable key order: action, protocol, src, srcPort, dst, dstPort, icmpType, established, log
  const ace: Omit<Ace, 'seq'> = srcPort ? { action: act, protocol, src, srcPort, dst } : { action: act, protocol, src, dst };
  if (dstPort) ace.dstPort = dstPort;
  if (icmpType !== undefined) ace.icmpType = icmpType;
  if (f.established) ace.established = true;
  if (f.log) ace.log = true;
  return notes.length ? { ace, notes } : { ace };
}

// ───────────────────────────── ACL store helpers ─────────────────────────────
function aceKey(e: Omit<Ace, 'seq'> | Ace): string {
  return JSON.stringify([e.action, e.remark ?? null, e.protocol, e.src, e.srcPort ?? null, e.dst, e.dstPort ?? null,
    e.icmpType ?? null, !!e.established, !!e.log]);
}
function nextSeq(acl: Acl): number {
  let max = 0;
  for (const e of acl.entries) if (e.action !== 'remark' && e.seq > max) max = e.seq;
  return max + 10;
}
function insertEntry(acl: Acl, e: Ace): void {
  const idx = e.action === 'remark'
    ? acl.entries.findIndex((x) => x.seq > e.seq || (x.seq === e.seq && x.action !== 'remark'))
    : acl.entries.findIndex((x) => x.seq > e.seq);
  if (idx < 0) acl.entries.push(e); else acl.entries.splice(idx, 0, e);
}
/** Add an entry. Returns an IOS error text, or null when done (an identical entry is silently not added twice). */
export function addAclEntry(acl: Acl, ace: Omit<Ace, 'seq'>, seq?: number): string | null {
  if (ace.action === 'remark') {
    insertEntry(acl, { seq: seq ?? nextSeq(acl), ...ace } as Ace);
    return null;
  }
  if (seq !== undefined && acl.entries.some((e) => e.seq === seq && e.action !== 'remark')) return '% Duplicate sequence number';
  const key = aceKey(ace);
  if (acl.entries.some((e) => e.action !== 'remark' && aceKey(e) === key)) return null;
  insertEntry(acl, { seq: seq ?? nextSeq(acl), ...ace } as Ace);
  return null;
}
function dropHits(env: CmdEnv, id: string, seq?: number): void {
  const hits = env.device.runtime.aclHits;
  for (const k of Object.keys(hits)) {
    if (seq === undefined ? k.startsWith(`${id}:`) : k === `${id}:${seq}`) delete hits[k];
  }
}
function conflictText(existing: 'standard' | 'extended'): string {
  return `Access-list type conflicts with prior definition\n% A named ${existing} IP access list with this name already exists`;
}
/** Find or create a list; rejects (IOS message) when the id exists with the other type. */
function obtainAcl(env: CmdEnv, id: string, type: 'standard' | 'extended', named: boolean): Acl {
  const acls = env.device.config.acls;
  const existing = acls[id];
  if (existing) {
    if (existing.type !== type) env.reject(conflictText(existing.type));
    return existing;
  }
  const acl: Acl = { id, type, named, entries: [] };
  acls[id] = acl;
  return acl;
}
function reportAceError(env: CmdEnv, r: Extract<AceParseResult, { error: string }>, base: number): never {
  if (r.hint) env.note(r.hint);
  if (r.kind === 'invalid') return invalidAt(env, base + r.at);
  if (r.kind === 'ambiguous') return env.reject(`% Ambiguous command:  "${env.line}"`);
  return env.reject('% Incomplete command.');
}
function parseFromLine(env: CmdEnv, type: 'standard' | 'extended', skipTokens: number): { ace: Omit<Ace, 'seq'>; notes: string[] } {
  const toks = lineTokens(env.line);
  const base = toks[skipTokens]?.start ?? env.line.length;
  const r = parseAce(type, env.line.slice(base));
  if ('error' in r) return reportAceError(env, r, base);
  return { ace: r.ace, notes: r.notes ?? [] };
}

// ───────────────────────────── Grammar generation ─────────────────────────────
const ACTION = '{action:permit|deny}';
const GENERIC_PROTOS = PROTO_KEYWORDS.filter((p) => !['icmp', 'tcp', 'udp'].includes(p));
const SRC_FORMS = ['{src:any}', '{src:host} <sh:ip>', '<sa:ip> <sw:wildcard>'];
const DST_NET = ['<da:ip> <dw:wildcard>'];
const DST_KW = ['{dst:any}', '{dst:host} <dh:ip>'];
const portForms = (t: 't' | 'u', side: 's' | 'd') =>
  ['', `{${side}op:eq|gt|lt|neq} <${t}${side}p:word>`, `{${side}op:range} <${t}${side}pl:word> <${t}${side}ph:word>`];
const ICMP_TAILS = [`[{icmp:${ICMP_KW_LIST.join('|')}}] [log]`, '<it:int(0-255)> [<ic:int(0-255)>] [log]'];
const STD_BODIES = ['{src:any} [log]', '{src:host} <sh:ip> [log]', '<sa:ip> [<sw:wildcard>] [log]'];

function extBodies(dsts: string[]): string[] {
  const out: string[] = [];
  for (const s of SRC_FORMS) for (const d of dsts) {
    out.push(`{proto:${GENERIC_PROTOS.join('|')}} ${s} ${d} [log]`);
    out.push(`<pnum:int(0-255)> ${s} ${d} [log]`);
    for (const tail of ICMP_TAILS) out.push(`{proto:icmp} ${s} ${d} ${tail}`);
    for (const sp of portForms('t', 's')) for (const dp of portForms('t', 'd')) out.push(`{proto:tcp} ${s} ${sp} ${d} ${dp} [established] [log]`);
    for (const sp of portForms('u', 's')) for (const dp of portForms('u', 'd')) out.push(`{proto:udp} ${s} ${sp} ${d} ${dp} [log]`);
  }
  return out.map((p) => p.replace(/\s+/g, ' ').trim());
}

const TCP_PORT_HELP = 'Port number (0-65535) or TCP port name: bgp, domain, ftp, ftp-data, pop3, smtp, telnet, www …';
const UDP_PORT_HELP = 'Port number (0-65535) or UDP port name: bootpc, bootps, domain, ntp, snmp, snmptrap, syslog, tftp …';
const BASE_HELP: Record<string, string> = {
  no: 'Negate a command or set its defaults',
  'access-list': 'Add an access list entry',
  permit: 'Specify packets to forward', deny: 'Specify packets to reject', remark: 'Access list entry comment',
  '<std>': 'IP standard access list', '<stdx>': 'IP standard access list (expanded range)',
  '<ext>': 'IP extended access list', '<extx>': 'IP extended access list (expanded range)',
  '<seq>': 'Sequence Number',
  ...PROTO_HELP, '<pnum>': 'An IP protocol number',
  '<sa>': 'Source address', '<sw>': 'Source wildcard bits', '<sh>': 'Source address',
  '<da>': 'Destination address', '<dw>': 'Destination wildcard bits', '<dh>': 'Destination address',
  eq: 'Match only packets on a given port number', gt: 'Match only packets with a greater port number',
  lt: 'Match only packets with a lower port number', neq: 'Match only packets not on a given port number',
  range: 'Match only packets in the range of port numbers',
  '<tsp>': TCP_PORT_HELP, '<tdp>': TCP_PORT_HELP, '<tspl>': 'Lowest ' + TCP_PORT_HELP, '<tdpl>': 'Lowest ' + TCP_PORT_HELP,
  '<tsph>': 'Highest ' + TCP_PORT_HELP, '<tdph>': 'Highest ' + TCP_PORT_HELP,
  '<usp>': UDP_PORT_HELP, '<udp>': UDP_PORT_HELP, '<uspl>': 'Lowest ' + UDP_PORT_HELP, '<udpl>': 'Lowest ' + UDP_PORT_HELP,
  '<usph>': 'Highest ' + UDP_PORT_HELP, '<udph>': 'Highest ' + UDP_PORT_HELP,
  established: 'Match established connections', log: 'Log matches against this entry',
  ...ICMP_HELP, '<it>': 'ICMP message type', '<ic>': 'ICMP message code',
  '<text>': 'Comment up to 100 characters',
};
// The first definition that creates a keyword edge provides its help text: register source-side help first.
const HELP_SRC: Record<string, string> = { ...BASE_HELP, any: 'Any source host', host: 'A single source host' };
const HELP_DST: Record<string, string> = { ...BASE_HELP, any: 'Any destination host', host: 'A single destination host' };
const HELP_STD: Record<string, string> = { ...BASE_HELP, any: 'Any source host', host: 'A single host address', '<sa>': 'Address to match', '<sw>': 'Wildcard bits' };

// ───────────────────────────── Handlers ─────────────────────────────
function numberArg(args: Record<string, unknown>): string {
  return String(args.std ?? args.stdx ?? args.ext ?? args.extx);
}
function runNumbered(type: 'standard' | 'extended') {
  return (env: CmdEnv, args: Record<string, unknown>) => {
    const id = numberArg(args);
    const { ace, notes } = parseFromLine(env, type, 2);
    const acl = obtainAcl(env, id, type, false);
    const err = addAclEntry(acl, ace);
    if (err) env.reject(err);
    for (const n of notes) env.note(n);
  };
}
function namedCtx(env: CmdEnv): { acl: Acl } {
  const id = env.session.ctx.acl as string;
  const type = env.session.ctx.type as 'standard' | 'extended';
  return { acl: obtainAcl(env, id, type, true) };
}
function runNamedAce(type: 'standard' | 'extended') {
  return (env: CmdEnv, args: Record<string, unknown>) => {
    const seq = args.seq as number | undefined;
    const { ace, notes } = parseFromLine(env, type, seq !== undefined ? 1 : 0);
    const { acl } = namedCtx(env);
    const err = addAclEntry(acl, ace, seq);
    if (err) env.reject(err);
    for (const n of notes) env.note(n);
  };
}
function runNamedNoAce(type: 'standard' | 'extended') {
  return (env: CmdEnv) => {
    const { ace } = parseFromLine(env, type, 1);
    const { acl } = namedCtx(env);
    const key = aceKey(ace);
    const idx = acl.entries.findIndex((e) => e.action !== 'remark' && aceKey(e) === key);
    if (idx < 0) return;
    const seq = acl.entries[idx].seq;
    acl.entries.splice(idx, 1);
    dropHits(env, acl.id, seq);
  };
}
function normaliseText(s: string): string { return s.trim(); }

function enterNamed(type: 'standard' | 'extended') {
  return (env: CmdEnv, args: Record<string, unknown>) => {
    const id = String(args.num ?? args.numx ?? args.name);
    const numType = aclNumberType(id);
    if (/^\d+$/.test(id) && numType !== type) env.reject('% Invalid access list name.');
    obtainAcl(env, id, type, true);
    env.setMode(type === 'standard' ? 'config-std-nacl' : 'config-ext-nacl', { acl: id, type });
  };
}
function removeNamed(type: 'standard' | 'extended') {
  return (env: CmdEnv, args: Record<string, unknown>) => {
    const id = String(args.num ?? args.numx ?? args.name);
    if (/^\d+$/.test(id) && aclNumberType(id) !== type) env.reject('% Invalid access list name.');
    const acl = env.device.config.acls[id];
    if (!acl) return;
    if (acl.type !== type) env.reject(conflictText(acl.type));
    delete env.device.config.acls[id];
    dropHits(env, id);
  };
}

const NAMED_HELP: Record<string, string> = {
  ip: 'Global IP configuration subcommands', no: 'Negate a command or set its defaults',
  'access-list': 'Named access list', standard: 'Standard Access List', extended: 'Extended Access List',
  '<num>': 'Standard IP access-list number', '<numx>': 'Standard IP access-list number (expanded range)', '<name>': 'Access-list name',
  resequence: 'Resequence Access List', '<start>': 'Starting Sequence Number', '<inc>': 'Step to increment the sequence number',
};
const NAMED_HELP_EXT: Record<string, string> = {
  ...NAMED_HELP, '<num>': 'Extended IP access-list number', '<numx>': 'Extended IP access-list number (expanded range)',
};

const STD_NUMS = ['<std:int(1-99)>', '<stdx:int(1300-1999)>'];
const EXT_NUMS = ['<ext:int(100-199)>', '<extx:int(2000-2699)>'];

function aceDefs(): CommandDef[] {
  const defs: CommandDef[] = [];
  // Numbered standard
  defs.push({
    modes: 'config', feature: 'acl', help: HELP_STD,
    pattern: STD_NUMS.flatMap((n) => STD_BODIES.map((b) => `access-list ${n} ${ACTION} ${b}`)),
    run: runNumbered('standard'),
  });
  // Numbered extended: source-side help first, then destination keywords. The expanded range 2000-2699 is rare; its
  // entry text goes straight to parseAce (same checks, `?` shows LINE) to keep the grammar small.
  defs.push({
    modes: 'config', feature: 'acl', help: HELP_SRC,
    pattern: extBodies(DST_NET).map((b) => `access-list ${EXT_NUMS[0]} ${ACTION} ${b}`),
    run: runNumbered('extended'),
  });
  defs.push({
    modes: 'config', feature: 'acl', help: HELP_DST,
    pattern: extBodies(DST_KW).map((b) => `access-list ${EXT_NUMS[0]} ${ACTION} ${b}`),
    run: runNumbered('extended'),
  });
  defs.push({
    modes: 'config', feature: 'acl', help: { ...BASE_HELP, '<rest>': 'protocol source [port] destination [port] [established] [log]' },
    pattern: `access-list ${EXT_NUMS[1]} ${ACTION} <rest:text>`,
    run: runNumbered('extended'),
  });
  // Numbered remarks
  defs.push({
    modes: 'config', feature: 'acl', help: BASE_HELP,
    pattern: [...STD_NUMS, ...EXT_NUMS].map((n) => `access-list ${n} remark <text:text>`),
    run(env, args) {
      const id = numberArg(args);
      const type = aclNumberType(id)!;
      const { ace } = parseFromLine(env, type, 2);
      addAclEntry(obtainAcl(env, id, type, false), ace);
    },
  });
  // no access-list N remark [text]: removes remarks only
  defs.push({
    modes: 'config', feature: 'acl', help: BASE_HELP,
    pattern: [...STD_NUMS, ...EXT_NUMS].map((n) => `no access-list ${n} remark [<text:text>]`),
    run(env, args) {
      const id = numberArg(args);
      const acl = env.device.config.acls[id];
      if (!acl) return;
      const text = args.text !== undefined ? normaliseText(String(args.text)) : undefined;
      acl.entries = acl.entries.filter((e) => !(e.action === 'remark' && (text === undefined || e.remark === text)));
    },
  });
  // no access-list N [anything]: IOS removes the WHOLE numbered list
  defs.push({
    modes: 'config', feature: 'acl', help: { ...BASE_HELP, '<rest>': 'Access list entry (IOS removes the whole list)' },
    pattern: [...STD_NUMS, ...EXT_NUMS].map((n) => `no access-list ${n} [<rest:text>]`),
    run(env, args) {
      const id = numberArg(args);
      if (!env.device.config.acls[id]) return;
      delete env.device.config.acls[id];
      dropHits(env, id);
      if (args.rest !== undefined) {
        env.note(`IOS removed the whole access list ${id}, not only this line. To remove one line, use "ip access-list ` +
          `${aclNumberType(id)} ${id}" and then "no <sequence number>".`);
      }
    },
  });

  // Named lists: navigation, removal, resequence
  defs.push({
    modes: 'config', feature: 'acl', mutates: false, help: NAMED_HELP,
    pattern: ['ip access-list standard <num:int(1-99)>', 'ip access-list standard <numx:int(1300-1999)>', 'ip access-list standard <name:word>'],
    run: enterNamed('standard'),
  });
  defs.push({
    modes: 'config', feature: 'acl', mutates: false, help: NAMED_HELP_EXT,
    pattern: ['ip access-list extended <num:int(100-199)>', 'ip access-list extended <numx:int(2000-2699)>', 'ip access-list extended <name:word>'],
    run: enterNamed('extended'),
  });
  defs.push({
    modes: 'config', feature: 'acl', help: NAMED_HELP,
    pattern: ['no ip access-list standard <num:int(1-99)>', 'no ip access-list standard <numx:int(1300-1999)>', 'no ip access-list standard <name:word>'],
    run: removeNamed('standard'),
  });
  defs.push({
    modes: 'config', feature: 'acl', help: NAMED_HELP_EXT,
    pattern: ['no ip access-list extended <num:int(100-199)>', 'no ip access-list extended <numx:int(2000-2699)>', 'no ip access-list extended <name:word>'],
    run: removeNamed('extended'),
  });
  defs.push({
    modes: 'config', feature: 'acl', help: { ...NAMED_HELP, '<name>': 'Access list number or name' },
    pattern: 'ip access-list resequence <name:word> <start:int(1-2147483647)> <inc:int(1-2147483647)>',
    run(env, args) {
      const acl = env.device.config.acls[String(args.name)];
      if (!acl) return;
      const hits = env.device.runtime.aclHits;
      const moved: Record<string, number> = {};
      let n = args.start as number;
      let pending: Ace[] = [];
      for (const e of acl.entries) {
        if (e.action === 'remark') { pending.push(e); continue; }
        const old = `${acl.id}:${e.seq}`;
        if (hits[old] !== undefined) { moved[`${acl.id}:${n}`] = hits[old]; delete hits[old]; }
        e.seq = n;
        for (const r of pending) r.seq = n;
        pending = [];
        n += args.inc as number;
      }
      for (const r of pending) r.seq = n;
      Object.assign(hits, moved);
    },
  });

  // Inside named lists
  const SEQ = '[<seq:int(1-2147483647)>]';
  defs.push({
    modes: 'config-std-nacl', feature: 'acl', help: HELP_STD,
    pattern: STD_BODIES.map((b) => `${SEQ} ${ACTION} ${b}`),
    run: runNamedAce('standard'),
  });
  defs.push({
    modes: 'config-std-nacl', feature: 'acl', help: HELP_STD,
    pattern: STD_BODIES.map((b) => `no ${ACTION} ${b}`),
    run: runNamedNoAce('standard'),
  });
  defs.push({
    modes: 'config-ext-nacl', feature: 'acl', help: HELP_SRC,
    pattern: extBodies(DST_NET).map((b) => `${SEQ} ${ACTION} ${b}`),
    run: runNamedAce('extended'),
  });
  defs.push({
    modes: 'config-ext-nacl', feature: 'acl', help: HELP_DST,
    pattern: extBodies(DST_KW).map((b) => `${SEQ} ${ACTION} ${b}`),
    run: runNamedAce('extended'),
  });
  defs.push({
    modes: 'config-ext-nacl', feature: 'acl', help: { ...BASE_HELP, '<rest>': 'The entry to remove, as it was typed: protocol source … destination …' },
    pattern: `no ${ACTION} <rest:text>`,
    run: runNamedNoAce('extended'),
  });
  defs.push({
    modes: ['config-std-nacl', 'config-ext-nacl'], feature: 'acl', help: BASE_HELP,
    pattern: `${SEQ} remark <text:text>`,
    run(env, args) {
      const seq = args.seq as number | undefined;
      const { acl } = namedCtx(env);
      const { ace } = parseFromLine(env, acl.type, seq !== undefined ? 1 : 0);
      addAclEntry(acl, ace, seq);
    },
  });
  defs.push({
    modes: ['config-std-nacl', 'config-ext-nacl'], feature: 'acl', help: BASE_HELP,
    pattern: 'no remark [<text:text>]',
    run(env, args) {
      const { acl } = namedCtx(env);
      const text = args.text !== undefined ? normaliseText(String(args.text)) : undefined;
      acl.entries = acl.entries.filter((e) => !(e.action === 'remark' && (text === undefined || e.remark === text)));
    },
  });
  defs.push({
    modes: ['config-std-nacl', 'config-ext-nacl'], feature: 'acl', help: BASE_HELP,
    pattern: 'no <seq:int(1-2147483647)>',
    run(env, args) {
      const { acl } = namedCtx(env);
      const seq = args.seq as number;
      acl.entries = acl.entries.filter((e) => e.seq !== seq);
      dropHits(env, acl.id, seq);
    },
  });

  // Interface: ip access-group
  const AG_HELP: Record<string, string> = {
    ip: 'Interface Internet Protocol config commands', no: 'Negate a command or set its defaults',
    'access-group': 'Specify access control for packets', '<acl>': 'IP access list number (1-199, 1300-2699) or name',
    in: 'inbound packets', out: 'outbound packets',
  };
  defs.push({
    modes: 'config-if', feature: 'acl', help: AG_HELP,
    pattern: 'ip access-group <acl:word> {dir:in|out}',
    run(env, args) {
      const id = String(args.acl);
      for (const ifc of currentInterfaces(env)) {
        if (args.dir === 'in') ifc.aclIn = id; else ifc.aclOut = id;
      }
      if (!env.device.config.acls[id]) {
        env.note(`Access list ${id} does not exist yet. Until you create it, it lets all traffic through.`);
      }
    },
  });
  defs.push({
    modes: 'config-if', feature: 'acl', help: AG_HELP,
    pattern: 'no ip access-group [<acl:word>] {dir:in|out}',
    run(env, args) {
      for (const ifc of currentInterfaces(env)) {
        if (args.dir === 'in') delete ifc.aclIn; else delete ifc.aclOut;
      }
    },
  });

  // Privileged EXEC: clear counters
  const CLR_HELP: Record<string, string> = {
    clear: 'Reset functions', ip: 'IP', 'access-list': 'Clear access list statistical information',
    counters: 'Clear access list counters', '<id>': 'Access list number or name',
  };
  defs.push({
    modes: 'priv', feature: 'acl', help: CLR_HELP,
    pattern: ['clear access-list counters [<id:word>]', 'clear ip access-list counters [<id:word>]'],
    run(env, args) {
      if (args.id === undefined) { env.device.runtime.aclHits = {}; return; }
      dropHits(env, String(args.id));
    },
  });
  return defs;
}

export const commands: CommandDef[] = aceDefs();
export function install(): void { registerCommands(commands); }
