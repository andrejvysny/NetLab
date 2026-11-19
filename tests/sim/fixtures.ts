/**
 * Test fixtures for the simulation engine: the complete reference lab of docs/COURSE.md built as objects
 * (devices via addDevice, cables, both routers' IosConfig, PC settings and services), plus helpers to derive
 * broken variants. No CLI text is involved.
 */
import type {
  Ace, Acl, AclProtocol, AddrMatch, Cable, CableKind, FlowSpec, IosConfig, IosDevice, PcDevice, PortMatch, World, WorldSettings,
} from '../../src/engine/types.ts';
import { addDevice, createWorld, getIos, getPc, nextId } from '../../src/engine/world.ts';
import { dhcpAcquire } from '../../src/engine/sim/index.ts';

// ───────────────────────────── addresses of the reference plan ─────────────────────────────
export const ADDR = {
  r1Lan: '192.168.100.1', pc1: '192.168.100.10', pc2: '192.168.100.101',
  r1Wan: '60.50.30.1', r2Wan: '60.50.30.2',
  r2Lan: '60.50.40.1', pc3: '60.50.40.2',
  r1Lo0: '1.1.1.1', r1Lo100: '60.50.50.100', r2Lo0: '2.2.2.2',
  pc1Public: '60.50.50.100',
} as const;
export const GI = 'GigabitEthernet0/0/0';
export const SE = 'Serial0/1/0';

// ───────────────────────────── ACL builders ─────────────────────────────
export const any: AddrMatch = { kind: 'any' };
export function host(address: string): AddrMatch { return { kind: 'host', address }; }
export function net(address: string, wildcard: string): AddrMatch { return { kind: 'net', address, wildcard }; }
export function eq(...ports: number[]): PortMatch { return { op: 'eq', ports }; }

type AceInit = Omit<Ace, 'seq'>;
export function permit(protocol: AclProtocol, src: AddrMatch, dst: AddrMatch, extra: Partial<Ace> = {}): AceInit {
  return { action: 'permit', protocol, src, dst, ...extra };
}
export function deny(protocol: AclProtocol, src: AddrMatch, dst: AddrMatch, extra: Partial<Ace> = {}): AceInit {
  return { action: 'deny', protocol, src, dst, ...extra };
}
/** Entry of a standard list: source only. */
export function stdPermit(src: AddrMatch): AceInit { return { action: 'permit', protocol: 'ip', src, dst: any }; }
export function stdDeny(src: AddrMatch): AceInit { return { action: 'deny', protocol: 'ip', src, dst: any }; }
/** Build an access list; entries get sequence numbers 10, 20, 30 … */
export function acl(id: string, type: 'standard' | 'extended', entries: AceInit[], named = false): Acl {
  return { id, type, named, entries: entries.map((e, i) => ({ ...e, seq: (i + 1) * 10 })) };
}
export function setAcl(cfg: IosConfig, list: Acl): void { cfg.acls[list.id] = list; }

// ───────────────────────────── bench and cabling ─────────────────────────────
export function buildBench(settings: Partial<WorldSettings> = {}): World {
  const w = createWorld(settings);
  addDevice(w, { id: 'R1', model: 'isr4331', label: 'R1', x: 300, y: 200 });
  addDevice(w, { id: 'R2', model: 'isr4331', label: 'R2', x: 600, y: 200 });
  addDevice(w, { id: 'SW1', model: 'c9300l', label: 'SW1', x: 150, y: 300 });
  addDevice(w, { id: 'SW2', model: 'c9300l', label: 'SW2', x: 750, y: 300 });
  addDevice(w, { id: 'PC1', model: 'pc-windows', label: 'PC1', x: 50, y: 420 });
  addDevice(w, { id: 'PC2', model: 'pc-windows', label: 'PC2', x: 200, y: 420 });
  addDevice(w, { id: 'PC3', model: 'pc-macos', label: 'PC3', x: 700, y: 420 });
  for (const id of ['R1', 'R2', 'SW1', 'SW2']) getIos(w, id).runtime.setupDialogDone = true;
  return w;
}

/** Plug a cable in. `dceEnd` only matters for serial cables (default: end a). */
export function cable(w: World, kind: CableKind, a: [string, string], b: [string, string], dceEnd?: 'a' | 'b'): Cable {
  const c: Cable = { id: `cable-${nextId(w)}`, kind, a: { deviceId: a[0], port: a[1] }, b: { deviceId: b[0], port: b[1] } };
  if (kind === 'serial') c.dceEnd = dceEnd ?? 'a';
  w.cables.push(c);
  return c;
}
/** Remove whatever cable is plugged into this port. */
export function unplug(w: World, deviceId: string, port: string): void {
  w.cables = w.cables.filter((c) => !((c.a.deviceId === deviceId && c.a.port === port) || (c.b.deviceId === deviceId && c.b.port === port)));
}
/** Replace the cable in this port by another kind, keeping both ends. */
export function recable(w: World, deviceId: string, port: string, kind: CableKind): void {
  const c = w.cables.find((x) => (x.a.deviceId === deviceId && x.a.port === port) || (x.b.deviceId === deviceId && x.b.port === port));
  if (!c) throw new Error(`no cable at ${deviceId} ${port}`);
  c.kind = kind;
}

export function cableReference(w: World): void {
  cable(w, 'straight', ['PC1', 'Ethernet0'], ['SW1', 'GigabitEthernet1/0/1']);
  cable(w, 'straight', ['PC2', 'Ethernet0'], ['SW1', 'GigabitEthernet1/0/2']);
  cable(w, 'straight', ['SW1', 'GigabitEthernet1/0/24'], ['R1', GI]);
  cable(w, 'serial', ['R1', SE], ['R2', SE], 'a');
  cable(w, 'crossover', ['R2', GI], ['PC3', 'Ethernet0']);
  cable(w, 'console', ['PC1', 'COM1'], ['R1', 'Console']);
}

// ───────────────────────────── router configuration ─────────────────────────────
function commonCryptoQos(cfg: IosConfig, peer: string): void {
  cfg.crypto.isakmpPolicies = [{ priority: 10, encryption: 'aes', hash: 'sha', authentication: 'pre-share', group: 2, lifetime: 86400 }];
  cfg.crypto.isakmpKeys = [{ key: 'KSS123', address: peer }];
  cfg.crypto.transformSets = [{ name: 'TS', transforms: ['esp-aes', 'esp-sha-hmac'], mode: 'tunnel' }];
  cfg.crypto.maps = [{ name: 'CM', entries: [{ seq: 10, type: 'ipsec-isakmp', matchAcl: '120', peers: [peer], transformSets: ['TS'] }] }];

  setAcl(cfg, acl('120', 'extended', [
    permit('tcp', any, any, { dstPort: eq(23) }),
    permit('tcp', any, any, { srcPort: eq(23) }),
    permit('tcp', any, any, { dstPort: eq(22) }),
    permit('tcp', any, any, { srcPort: eq(22) }),
    permit('icmp', any, any),
    permit('udp', any, any, { dstPort: eq(161) }),
    permit('udp', any, any, { srcPort: eq(161) }),
    permit('udp', any, any, { dstPort: eq(162) }),
    permit('udp', any, any, { srcPort: eq(162) }),
  ]));
  setAcl(cfg, acl('matchGuaranteed', 'extended', [
    permit('tcp', any, any, { dstPort: eq(23) }),
    permit('tcp', any, any, { srcPort: eq(23) }),
    permit('tcp', any, any, { dstPort: eq(22) }),
    permit('tcp', any, any, { srcPort: eq(22) }),
    permit('udp', any, any, { dstPort: eq(161) }),
    permit('udp', any, any, { srcPort: eq(161) }),
    permit('udp', any, any, { dstPort: eq(162) }),
    permit('udp', any, any, { srcPort: eq(162) }),
  ], true));
  setAcl(cfg, acl('matchPriority', 'extended', [permit('icmp', any, any)], true));

  cfg.qos.classMaps = [
    { name: 'classPriority', matchType: 'match-all', matches: [{ kind: 'access-group', acl: 'matchPriority' }] },
    { name: 'classGuaranteed', matchType: 'match-all', matches: [{ kind: 'access-group', acl: 'matchGuaranteed' }] },
  ];
  cfg.qos.policyMaps = [
    {
      name: 'output_QE', classes: [
        { className: 'classPriority', priority: { kbps: 16 } },
        { className: 'classGuaranteed', bandwidth: { kbps: 48 } },
        { className: 'class-default', fairQueue: true },
      ],
    },
    { name: 'output_SE', classes: [{ className: 'class-default', shapeAverage: { percent: 95 }, servicePolicy: 'output_QE' }] },
  ];
}

function vtyLines(cfg: IosConfig): void {
  cfg.lines.vty = [
    { first: 0, last: 4, accessClassIn: 'allowPC1', password: 'cisco', login: true },
    { first: 5, last: 14, accessClassIn: 'allowPC1', password: 'cisco', login: true },
  ];
}

export function configureR1(w: World): void {
  const cfg = getIos(w, 'R1').config;
  cfg.hostname = 'R1';
  cfg.ipDomainLookup = false;
  cfg.dhcp.excluded = [{ low: '192.168.100.1', high: '192.168.100.100' }];
  cfg.dhcp.pools = [
    { name: 'LAN1', network: { address: '192.168.100.0', mask: '255.255.255.0' }, defaultRouters: ['192.168.100.1'], dnsServers: [] },
    { name: 'LAN2', network: { address: '60.50.40.0', mask: '255.255.255.192' }, defaultRouters: ['60.50.40.1'], dnsServers: [] },
  ];
  commonCryptoQos(cfg, ADDR.r2Wan);
  cfg.interfaces['Loopback0'] = { name: 'Loopback0', shutdown: false, ip: { address: ADDR.r1Lo0, mask: '255.255.255.255' } };
  cfg.interfaces['Loopback100'] = { name: 'Loopback100', shutdown: false, ip: { address: ADDR.r1Lo100, mask: '255.255.255.255' } };
  Object.assign(cfg.interfaces[GI], { ip: { address: ADDR.r1Lan, mask: '255.255.255.0' }, aclIn: '110', natRole: 'inside', shutdown: false });
  Object.assign(cfg.interfaces[SE], {
    bandwidthKbps: 128, ip: { address: ADDR.r1Wan, mask: '255.255.255.252' }, natRole: 'outside', clockRate: 128000,
    cryptoMap: 'CM', servicePolicyOut: 'output_SE', shutdown: false,
  });
  cfg.nat.staticRules = [{ local: ADDR.pc1, global: ADDR.r1Lo100 }];
  cfg.nat.dynamicRules = [{ acl: '1', interface: SE, overload: true }];
  cfg.staticRoutes = [{ prefix: '0.0.0.0', mask: '0.0.0.0', exitInterface: SE, nextHop: ADDR.r2Wan }];
  setAcl(cfg, acl('1', 'standard', [stdPermit(net('192.168.100.0', '0.0.0.255'))]));
  setAcl(cfg, acl('10', 'standard', [stdPermit(host(ADDR.pc1)), stdPermit(host(ADDR.pc3))]));
  setAcl(cfg, acl('11', 'standard', [stdPermit(host(ADDR.pc1))]));
  setAcl(cfg, acl('110', 'extended', [
    deny('ip', host(ADDR.pc1), host(ADDR.r2Lo0)),
    permit('icmp', host(ADDR.pc2), net('60.50.40.0', '0.0.0.63')),
    permit('tcp', host(ADDR.pc2), net('60.50.40.0', '0.0.0.63'), { dstPort: eq(80) }),
    deny('ip', host(ADDR.pc2), net('60.50.40.0', '0.0.0.63')),
    permit('ip', any, any),
  ]));
  setAcl(cfg, acl('allowPC1', 'standard', [stdPermit(host(ADDR.pc1))], true));
  cfg.snmp.communities = [{ name: 'D105read', access: 'ro', acl: '10' }, { name: 'D105write', access: 'rw', acl: '11' }];
  cfg.logging = { hosts: [ADDR.pc1], sourceInterface: 'Loopback0' };
  vtyLines(cfg);
}

export function configureR2(w: World): void {
  const cfg = getIos(w, 'R2').config;
  cfg.hostname = 'R2';
  cfg.ipDomainLookup = false;
  commonCryptoQos(cfg, ADDR.r1Wan);
  cfg.interfaces['Loopback0'] = { name: 'Loopback0', shutdown: false, ip: { address: ADDR.r2Lo0, mask: '255.255.255.255' } };
  Object.assign(cfg.interfaces[GI], { ip: { address: ADDR.r2Lan, mask: '255.255.255.192' }, helperAddresses: [ADDR.r1Wan], shutdown: false });
  Object.assign(cfg.interfaces[SE], {
    bandwidthKbps: 128, ip: { address: ADDR.r2Wan, mask: '255.255.255.252' }, cryptoMap: 'CM', servicePolicyOut: 'output_SE', shutdown: false,
  });
  cfg.staticRoutes = [{ prefix: '0.0.0.0', mask: '0.0.0.0', exitInterface: SE, nextHop: ADDR.r1Wan }];
  setAcl(cfg, acl('10', 'standard', [stdPermit(host(ADDR.pc1Public)), stdPermit(host(ADDR.pc3))]));
  setAcl(cfg, acl('11', 'standard', [stdPermit(host(ADDR.pc1Public))]));
  setAcl(cfg, acl('allowPC1', 'standard', [stdPermit(host(ADDR.pc1Public))], true));
  cfg.snmp.communities = [{ name: 'D105read', access: 'ro', acl: '10' }, { name: 'D105write', access: 'rw', acl: '11' }];
  cfg.logging = { hosts: [ADDR.pc1Public], sourceInterface: 'Loopback0' };
  vtyLines(cfg);
}

export function configurePcs(w: World): void {
  const pc1 = getPc(w, 'PC1');
  pc1.nic = { ...pc1.nic, mode: 'static', address: ADDR.pc1, mask: '255.255.255.0', gateway: ADDR.r1Lan };
  pc1.services.syslog = true;
  getPc(w, 'PC2').nic.mode = 'dhcp';
  const pc3 = getPc(w, 'PC3');
  pc3.nic.mode = 'dhcp';
  pc3.services.http = true;
  pc3.services.ftp = true;
}

/** PC2 and PC3 ask for their DHCP leases. Returns both results. */
export function bringUp(w: World) {
  return { pc2: dhcpAcquire(w, 'PC2'), pc3: dhcpAcquire(w, 'PC3') };
}

export interface LabOptions {
  settings?: Partial<WorldSettings>;
  /** Change the freshly built lab before any traffic flows (this is how broken variants are made). */
  mutate?: (w: World) => void;
  /** Run DHCP for PC2 and PC3 after building (default true). */
  acquire?: boolean;
}

/** The complete, cabled and configured reference lab of docs/COURSE.md. */
export function referenceLab(opts: LabOptions = {}): World {
  const w = buildBench(opts.settings);
  cableReference(w);
  configureR1(w);
  configureR2(w);
  configurePcs(w);
  opts.mutate?.(w);
  if (opts.acquire !== false) bringUp(w);
  return w;
}

/** The reference lab with one fault. The fault is applied before DHCP and before any packet is sent. */
export function brokenLab(mutate: (w: World) => void, opts: Omit<LabOptions, 'mutate'> = {}): World {
  return referenceLab({ ...opts, mutate });
}

// ───────────────────────────── shortcuts ─────────────────────────────
export function r1(w: World): IosDevice { return getIos(w, 'R1'); }
export function r2(w: World): IosDevice { return getIos(w, 'R2'); }
export function pc(w: World, id: 'PC1' | 'PC2' | 'PC3'): PcDevice { return getPc(w, id); }

export function ping(from: string, dst: string, extra: Partial<FlowSpec> = {}): FlowSpec {
  return { fromDeviceId: from, dst, proto: 'icmp', ...extra };
}
export function tcp(from: string, dst: string, dport: number, extra: Partial<FlowSpec> = {}): FlowSpec {
  return { fromDeviceId: from, dst, proto: 'tcp', dport, ...extra };
}
export function udp(from: string, dst: string, dport: number, extra: Partial<FlowSpec> = {}): FlowSpec {
  return { fromDeviceId: from, dst, proto: 'udp', dport, ...extra };
}
export function snmp(from: string, dst: string, community: string, op: 'get' | 'set' = 'get', value?: string): FlowSpec {
  return { fromDeviceId: from, dst, proto: 'udp', dport: 161, app: { kind: 'snmp', op, community, oid: 'sysName', value } };
}

// ───────────────────────────── small labs for unit tests ─────────────────────────────
/** Give a PC a static address. */
export function staticPc(w: World, id: string, address: string, mask: string, gateway?: string): void {
  const p = getPc(w, id);
  p.nic = { mode: 'static', mac: p.nic.mac, address, mask };
  if (gateway) p.nic.gateway = gateway;
}
/** Configure and enable a router interface. */
export function ifUp(w: World, routerId: string, ifName: string, address?: string, mask?: string): void {
  const cfg = getIos(w, routerId).config;
  const i = cfg.interfaces[ifName] ?? (cfg.interfaces[ifName] = { name: ifName, shutdown: false });
  i.shutdown = false;
  if (address && mask) i.ip = { address, mask };
}

/**
 * One router, no NAT, no crypto: LAN A 10.0.1.0/24 (R1 Gi0/0/0 .1, PC1 .10 and PC2 .20 on SW1)
 * and LAN B 10.0.2.0/24 (R1 Gi0/0/1 .1, PC3 .10 directly on the router).
 */
export function smallLab(settings: Partial<WorldSettings> = {}): World {
  const w = buildBench(settings);
  cable(w, 'straight', ['PC1', 'Ethernet0'], ['SW1', 'GigabitEthernet1/0/1']);
  cable(w, 'straight', ['PC2', 'Ethernet0'], ['SW1', 'GigabitEthernet1/0/2']);
  cable(w, 'straight', ['SW1', 'GigabitEthernet1/0/24'], ['R1', GI]);
  cable(w, 'crossover', ['R1', 'GigabitEthernet0/0/1'], ['PC3', 'Ethernet0']);
  ifUp(w, 'R1', GI, '10.0.1.1', '255.255.255.0');
  ifUp(w, 'R1', 'GigabitEthernet0/0/1', '10.0.2.1', '255.255.255.0');
  staticPc(w, 'PC1', '10.0.1.10', '255.255.255.0', '10.0.1.1');
  staticPc(w, 'PC2', '10.0.1.20', '255.255.255.0', '10.0.1.1');
  staticPc(w, 'PC3', '10.0.2.10', '255.255.255.0', '10.0.2.1');
  return w;
}

/**
 * Three routers in a row, addresses only (no routes): PC1 10.1.0.10 — R1 —serial 10.0.12.0/30— R2 —Ethernet 10.0.23.0/24— R3 — PC3 10.3.0.10.
 * Loopback0: 1.1.1.1, 2.2.2.2, 3.3.3.3 (/32).
 */
export function threeRouters(): World {
  const w = createWorld();
  addDevice(w, { id: 'R1', model: 'isr4331', label: 'R1', x: 0, y: 0 });
  addDevice(w, { id: 'R2', model: 'isr4331', label: 'R2', x: 0, y: 0 });
  addDevice(w, { id: 'R3', model: 'isr4331', label: 'R3', x: 0, y: 0 });
  addDevice(w, { id: 'PC1', model: 'pc-windows', label: 'PC1', x: 0, y: 0 });
  addDevice(w, { id: 'PC3', model: 'pc-windows', label: 'PC3', x: 0, y: 0 });
  cable(w, 'crossover', ['PC1', 'Ethernet0'], ['R1', GI]);
  cable(w, 'serial', ['R1', SE], ['R2', SE], 'a');
  cable(w, 'crossover', ['R2', 'GigabitEthernet0/0/1'], ['R3', 'GigabitEthernet0/0/1']);
  cable(w, 'crossover', ['R3', GI], ['PC3', 'Ethernet0']);
  ifUp(w, 'R1', GI, '10.1.0.1', '255.255.255.0');
  ifUp(w, 'R1', SE, '10.0.12.1', '255.255.255.252');
  ifUp(w, 'R1', 'Loopback0', '1.1.1.1', '255.255.255.255');
  ifUp(w, 'R2', SE, '10.0.12.2', '255.255.255.252');
  ifUp(w, 'R2', 'GigabitEthernet0/0/1', '10.0.23.2', '255.255.255.0');
  ifUp(w, 'R2', 'Loopback0', '2.2.2.2', '255.255.255.255');
  ifUp(w, 'R3', 'GigabitEthernet0/0/1', '10.0.23.3', '255.255.255.0');
  ifUp(w, 'R3', GI, '10.3.0.1', '255.255.255.0');
  ifUp(w, 'R3', 'Loopback0', '3.3.3.3', '255.255.255.255');
  staticPc(w, 'PC1', '10.1.0.10', '255.255.255.0', '10.1.0.1');
  staticPc(w, 'PC3', '10.3.0.10', '255.255.255.0', '10.3.0.1');
  return w;
}
