/**
 * Scenario specification: the facts of one assignment (addresses, rules, numbers) from which brief, checks,
 * guide and model solution are all derived. The case study is the specification with the reference plan.
 * Owned by the scenario agent.
 */
import type { Feature, ScenarioFamily } from '../engine/types.ts';
import { intToIp, ipToInt, maskToWildcard, prefixToMask } from '../engine/ip.ts';

export type PartId =
  | 'cabling' | 'console' | 'basics' | 'pcs' | 'routing' | 'dhcp' | 'nat' | 'acl'
  | 'ipsec' | 'qos' | 'telnet' | 'snmp' | 'syslog' | 'save';

/** Order in which a careful student works through the parts. */
export const PART_ORDER: PartId[] = [
  'cabling', 'console', 'basics', 'pcs', 'routing', 'dhcp', 'nat', 'acl', 'ipsec', 'qos', 'telnet', 'snmp', 'syslog', 'save',
];

// ───────────────────────────── services ─────────────────────────────
export type Svc = 'icmp' | 'telnet' | 'ssh' | 'snmp' | 'http' | 'ftp' | 'syslog';
export interface SvcInfo {
  /** Name inside a sentence. */
  name: string;
  proto: 'icmp' | 'tcp' | 'udp';
  ports: number[];
  /** Port keywords as the model configuration writes them (same order as `ports`). */
  words: string[];
}
export const SVC: Record<Svc, SvcInfo> = {
  icmp: { name: 'ICMP', proto: 'icmp', ports: [], words: [] },
  telnet: { name: 'Telnet', proto: 'tcp', ports: [23], words: ['telnet'] },
  ssh: { name: 'SSH', proto: 'tcp', ports: [22], words: ['22'] },
  snmp: { name: 'network management (UDP 161 and 162)', proto: 'udp', ports: [161, 162], words: ['snmp', 'snmptrap'] },
  http: { name: 'HTTP', proto: 'tcp', ports: [80], words: ['www'] },
  ftp: { name: 'FTP', proto: 'tcp', ports: [21], words: ['ftp'] },
  syslog: { name: 'syslog (UDP 514)', proto: 'udp', ports: [514], words: ['syslog'] },
};
/** Short names for lists: "Telnet, SSH and ICMP". */
export function svcShort(s: Svc): string {
  return s === 'snmp' ? 'network management (SNMP)' : s === 'syslog' ? 'syslog' : SVC[s].name;
}
export function joinAnd(items: string[], word = 'and'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
}
/** ACL lines that match a service in both directions between any two addresses (crypto and QoS match lists). */
export function svcAclLines(list: Svc[]): string[] {
  const out: string[] = [];
  for (const s of list) {
    const info = SVC[s];
    if (info.proto === 'icmp') { out.push('permit icmp any any'); continue; }
    for (const w of info.words) {
      out.push(`permit ${info.proto} any any eq ${w}`);
      out.push(`permit ${info.proto} any eq ${w} any`);
    }
  }
  return out;
}

// ───────────────────────────── addresses ─────────────────────────────
export interface Net { net: string; len: number }
export function host(n: Net, h: number): string { return intToIp(ipToInt(n.net) + h); }
export function maskOf(n: Net): string { return prefixToMask(n.len); }
export function wildOf(n: Net): string { return maskToWildcard(prefixToMask(n.len)); }
export function cidr(n: Net): string { return `${n.net}/${n.len}`; }
export function lastHost(n: Net): string { return intToIp(ipToInt(n.net) + 2 ** (32 - n.len) - 2); }
export const M32 = '255.255.255.255';

export interface Addr {
  lan1: Net;
  wan: Net;
  lan2: Net;
  r1Lo0: string;
  r2Lo0: string;
  /** Present when the assignment uses Loopback100 on R1 (PC1's public address). */
  r1Lo100?: string;
  /** Host number of PC1 inside LAN1 (10 in the case study). */
  pc1Host: number;
}
export interface Ports {
  r1Lan: string; r1Wan: string; r2Lan: string; r2Wan: string;
  swPc1: string; swPc2: string; swR1: string;
}

// ───────────────────────────── per-part options ─────────────────────────────
export interface DhcpOpts {
  /** The first N usable LAN1 addresses must never be leased. */
  excludeFirst: number;
}
export type NatOpts =
  /** Case study: PAT on the WAN interface for LAN1, static NAT for PC1 to the Loopback100 address. */
  | { mode: 'case' }
  /** Course NAT labs: a block of global addresses that the ISP router (R2) reaches through a static route. */
  | { mode: 'static' | 'pool' | 'overload'; block: Net };
export type Pc1Rule = { kind: 'r2-lo0' } | { kind: 'lan2-first-half' };
export type AclOpts =
  /** Case study: one extended ACL, inbound on R1's LAN interface. */
  | { mode: 'case'; pc1: Pc1Rule; pc2Allow: Svc[] }
  /** Course ACL lab: a standard, an extended and a named list. */
  | { mode: 'lab' };
export type IpsecOpts =
  | { mode: 'services'; services: Svc[] }
  /** Everything between LAN1 and LAN2. */
  | { mode: 'lans' };
export interface QosOpts {
  linkKbps: number;
  priority: { kbps: number; services: Svc[] };
  guaranteed: { kbps: number; services: Svc[] };
  shapePercent: number;
}
export interface TelnetOpts { password: string; passwordGiven?: boolean }
export interface SnmpOpts {
  ro: string;
  rw: string;
  /** The sheet names the communities. */
  namesGiven: boolean;
  /** Who may read: PC1 and PC3 (case study) or every host of LAN1 (course lab). Only PC1 may write. */
  readers: 'pc1-pc3' | 'lan1';
  location?: string;
  contact?: string;
}
export interface SyslogOpts {
  /** Interface whose address is the source of the messages: Loopback0, or the router's LAN interface. */
  source: 'Loopback0' | 'lan';
  /** Course lab: send every level, including debugging. */
  allLevels?: boolean;
}

export interface LabText { intro: string; items: { text: string; feature: Feature; subItems?: string[] }[] }

export interface Spec {
  id: string;
  title: string;
  family: ScenarioFamily;
  blurb: string;
  minutes: number;
  level: 1 | 2 | 3;
  seedable: boolean;
  seed: number;
  /** How the assignment is presented. */
  style: 'sheet' | 'exam' | 'ticket' | 'lab';
  hasPc2: boolean;
  wan: 'serial' | 'ethernet';
  addr: Addr;
  /** true: the sheet fixes every address (checks compare with the table). false: the student chooses within the rules. */
  addrGiven: boolean;
  ports: Ports;
  /** Graded parts. */
  parts: PartId[];
  /** Parts that are already done when the student starts (`initial`). */
  prebuilt: PartId[];
  /** R2 has a default route towards R1 (false in the NAT labs, where R2 plays the provider). */
  r2Default: boolean;
  /** `clock rate` asked for on the DCE end when there is no QoS part (basic setup lab). */
  clockRate?: number;
  dhcp?: DhcpOpts;
  nat?: NatOpts;
  acl?: AclOpts;
  ipsec?: IpsecOpts;
  qos?: QosOpts;
  telnet?: TelnetOpts;
  snmp?: SnmpOpts;
  syslog?: SyslogOpts;
  /** Servers that already run on the PCs of a pre-built lab. */
  servers?: Record<string, { http?: boolean; ftp?: boolean; telnet?: boolean; syslog?: boolean }>;
  /** Planted faults (broken networks): ids from the fault catalogue. */
  faults?: string[];
  lab?: LabText;
}

export function has(s: Spec, p: PartId): boolean { return s.parts.includes(p) || s.prebuilt.includes(p); }
export function isTask(s: Spec, p: PartId): boolean { return s.parts.includes(p) && !s.prebuilt.includes(p); }

// ───────────────────────────── derived addresses of the model plan ─────────────────────────────
export interface Model {
  r1Lan: string; r2Lan: string; r1Wan: string; r2Wan: string;
  pc1: string; pc2: string; pc3: string;
  mLan1: string; mLan2: string; mWan: string;
  /** PC1 as devices behind R1's WAN interface see it. */
  pc1Outside: string;
  /** PC2 as devices behind R1's WAN interface see it. */
  pc2Outside: string;
  /** Clock rate for the DCE end, bit/s (serial WAN only). */
  clock?: number;
}
export function renewCommand(pcId: string): string { return pcId === 'PC3' ? 'sudo ipconfig set en0 DHCP' : 'ipconfig /renew'; }
export function dhcpClients(s: Spec): boolean { return has(s, 'dhcp'); }
export function model(s: Spec): Model {
  const a = s.addr;
  const r1Lan = host(a.lan1, 1);
  const r2Lan = host(a.lan2, 1);
  const r1Wan = host(a.wan, 1);
  const r2Wan = host(a.wan, 2);
  const pc1 = host(a.lan1, a.pc1Host);
  const pc2 = dhcpClients(s) ? host(a.lan1, (s.dhcp?.excludeFirst ?? 0) + 1) : host(a.lan1, 20);
  const pc3 = dhcpClients(s) ? host(a.lan2, 2) : host(a.lan2, 10);
  let pc1Outside = pc1;
  let pc2Outside = pc2;
  if (has(s, 'nat') && s.nat) {
    if (s.nat.mode === 'case') { pc1Outside = a.r1Lo100 ?? pc1; pc2Outside = r1Wan; }
    else if (s.nat.mode === 'static') { pc1Outside = host(s.nat.block, 1); }
    else if (s.nat.mode === 'pool') { pc1Outside = host(s.nat.block, 1); pc2Outside = host(s.nat.block, 2); }
    else { pc1Outside = host(s.nat.block, 1); pc2Outside = host(s.nat.block, 1); }
  }
  const clock = s.wan === 'serial' ? (s.qos ? s.qos.linkKbps * 1000 : s.clockRate ?? 128000) : undefined;
  return {
    r1Lan, r2Lan, r1Wan, r2Wan, pc1, pc2, pc3,
    mLan1: maskOf(a.lan1), mLan2: maskOf(a.lan2), mWan: maskOf(a.wan), pc1Outside, pc2Outside, clock,
  };
}

// ───────────────────────────── the reference plan (docs/COURSE.md) ─────────────────────────────
export const REF_ADDR: Addr = {
  lan1: { net: '192.168.100.0', len: 24 },
  wan: { net: '60.50.30.0', len: 30 },
  lan2: { net: '60.50.40.0', len: 26 },
  r1Lo0: '1.1.1.1',
  r2Lo0: '2.2.2.2',
  r1Lo100: '60.50.50.100',
  pc1Host: 10,
};
export function portsFor(wan: 'serial' | 'ethernet'): Ports {
  return {
    r1Lan: 'GigabitEthernet0/0/0', r2Lan: 'GigabitEthernet0/0/0',
    r1Wan: wan === 'serial' ? 'Serial0/1/0' : 'GigabitEthernet0/0/1',
    r2Wan: wan === 'serial' ? 'Serial0/1/0' : 'GigabitEthernet0/0/1',
    swPc1: 'GigabitEthernet1/0/1', swPc2: 'GigabitEthernet1/0/2', swR1: 'GigabitEthernet1/0/24',
  };
}
export const ALL_PARTS: PartId[] = [...PART_ORDER];

/** Options of the case study as the 2026 sheet states them. */
export function caseOptions(): Pick<Spec, 'dhcp' | 'nat' | 'acl' | 'ipsec' | 'qos' | 'telnet' | 'snmp' | 'syslog'> {
  return {
    dhcp: { excludeFirst: 100 },
    nat: { mode: 'case' },
    acl: { mode: 'case', pc1: { kind: 'r2-lo0' }, pc2Allow: ['icmp', 'http'] },
    ipsec: { mode: 'services', services: ['telnet', 'ssh', 'icmp', 'snmp'] },
    qos: { linkKbps: 128, priority: { kbps: 16, services: ['icmp'] }, guaranteed: { kbps: 48, services: ['telnet', 'ssh', 'snmp'] }, shapePercent: 95 },
    telnet: { password: 'cisco' },
    snmp: { ro: 'D105read', rw: 'D105write', namesGiven: false, readers: 'pc1-pc3' },
    syslog: { source: 'Loopback0' },
  };
}

/** The full case study with the reference plan. */
export function caseSpec(): Spec {
  return {
    id: 'case-study-2026',
    title: 'Case study 2026: the full assignment',
    family: 'case-study',
    blurb: 'Practise the 2026 assignment from scratch: two routers, one switch, three PCs and thirteen numbered tasks (task 9 is crossed out).',
    minutes: 180,
    level: 3,
    seedable: false,
    seed: 0,
    style: 'sheet',
    hasPc2: true,
    wan: 'serial',
    addr: { ...REF_ADDR },
    addrGiven: false,
    ports: portsFor('serial'),
    parts: [...ALL_PARTS],
    prebuilt: [],
    r2Default: true,
    ...caseOptions(),
  };
}

/** Course nominal 128 kbit/s or the documented 125 kbit/s fallback on cards without that setting. */
export function clockFits(configured: number | undefined, want: number): boolean {
  return configured === want || (want === 128000 && configured === 125000);
}
