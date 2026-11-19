/**
 * The scenario list: the case study, seeded variations and mock exams (the same generator with other facts),
 * broken networks (the solved case study with planted faults) and the short course labs. Owned by the scenario agent.
 */
import type { ScenarioDef, ScenarioInstance } from '../engine/types.ts';
import { rngFor } from './rng.ts';
import type { Rng } from './rng.ts';
import type { Addr, LabText, PartId, Spec, Svc } from './spec.ts';
import { ALL_PARTS, REF_ADDR, caseOptions, caseSpec, portsFor } from './spec.ts';
import { buildInstance, summaryOf } from './build.ts';
import { faultCatalogue } from './faults.ts';

// ───────────────────────────── seeded facts ─────────────────────────────
const PUBLIC_PAIRS: [number, number][] = [
  [60, 50], [70, 40], [80, 30], [90, 20], [130, 10], [140, 20], [150, 30], [160, 40], [170, 50], [180, 60],
  [190, 70], [200, 80], [45, 60], [55, 70], [65, 80], [75, 90], [85, 100], [95, 110],
];
const COMMUNITIES: [string, string][] = [
  ['D105read', 'D105write'], ['KSSread', 'KSSwrite'], ['labRO', 'labRW'], ['monitor', 'manage'], ['netView', 'netAdmin'], ['examRead', 'examWrite'],
];
const PC2_ALLOW: Svc[][] = [['icmp', 'http'], ['icmp', 'ftp'], ['icmp', 'telnet'], ['icmp', 'http', 'ftp'], ['icmp', 'ssh']];
const IPSEC_SETS: Svc[][] = [
  ['telnet', 'ssh', 'icmp', 'snmp'], ['telnet', 'icmp'], ['ssh', 'snmp', 'http'], ['icmp', 'snmp', 'syslog'],
  ['telnet', 'ssh', 'http'], ['icmp', 'http', 'syslog'], ['telnet', 'snmp'],
];
const QOS_SETS: { p: Svc[]; g: Svc[] }[] = [
  { p: ['icmp'], g: ['telnet', 'ssh', 'snmp'] },
  { p: ['telnet', 'ssh'], g: ['snmp', 'http'] },
  { p: ['snmp'], g: ['telnet', 'http'] },
  { p: ['icmp'], g: ['http', 'ftp'] },
  { p: ['telnet'], g: ['icmp', 'snmp'] },
];

function variedAddr(r: Rng): Addr {
  const [a, b] = r.pick(PUBLIC_PAIRS);
  const thirds = r.sample([10, 20, 30, 40, 50, 60, 70, 80, 90, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220], 3);
  const lan2Len = r.pick([25, 26, 26, 27, 28]);
  const size = 2 ** (32 - lan2Len);
  const lan2Base = r.int(0, 256 / size - 1) * size;
  const lan1Third = r.pick([1, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 110, 120, 150, 168, 200, 210, 220, 230, 240, 250]);
  const k = r.pick([1, 3, 5, 7, 11, 13, 15, 17, 19, 21]);
  return {
    lan1: { net: `192.168.${lan1Third}.0`, len: 24 },
    wan: { net: `${a}.${b}.${thirds[0]}.${4 * r.int(0, 63)}`, len: 30 },
    lan2: { net: `${a}.${b}.${thirds[1]}.${lan2Base}`, len: lan2Len },
    r1Lo0: `${k}.${k}.${k}.${k}`,
    r2Lo0: `${k + 1}.${k + 1}.${k + 1}.${k + 1}`,
    r1Lo100: `${a}.${b}.${thirds[2]}.${r.int(1, 254)}`,
    pc1Host: r.pick([10, 20, 30, 50]),
  };
}

/** The case study with other facts. Seed 0 is the reference plan itself. */
export function variedSpec(seed: number, stream: string): Spec {
  const s = caseSpec();
  s.seed = seed;
  if (seed === 0) return s;
  const r = rngFor(stream, seed);
  s.addr = variedAddr(r);
  s.wan = r.chance(0.3) ? 'ethernet' : 'serial';
  s.ports = portsFor(s.wan);
  s.addrGiven = r.chance(0.5);
  s.dhcp = { excludeFirst: r.pick([50, 100, 120, 150, 200].filter((n) => n >= s.addr.pc1Host)) };
  s.acl = { mode: 'case', pc1: r.chance(0.4) ? { kind: 'lan2-first-half' } : { kind: 'r2-lo0' }, pc2Allow: [...r.pick(PC2_ALLOW)] };
  s.ipsec = { mode: 'services', services: [...r.pick(IPSEC_SETS)] };
  const nominal = r.pick([64, 128, 256]);
  // The serial interface rounds 256000 to 250000 on this bench. Use the achievable rate in the assignment.
  const link = s.wan === 'serial' && nominal === 256 ? 250 : nominal;
  const sets = r.pick(QOS_SETS);
  s.qos = {
    linkKbps: link,
    priority: { kbps: Math.round(link / 8), services: [...sets.p] },
    guaranteed: { kbps: Math.round(r.pick([link / 4, (link * 3) / 8, link / 2])), services: [...sets.g] },
    shapePercent: r.pick([80, 85, 90, 95]),
  };
  const [ro, rw] = r.pick(COMMUNITIES);
  s.snmp = { ro, rw, namesGiven: true, readers: 'pc1-pc3' };
  s.syslog = { source: r.chance(0.35) ? 'lan' : 'Loopback0' };
  return s;
}

// ───────────────────────────── case study and its halves ─────────────────────────────
const BUILD_PARTS: PartId[] = ['cabling', 'console', 'basics', 'pcs', 'routing', 'dhcp', 'nat', 'save'];
const BUILT_BASE: PartId[] = ['cabling', 'console', 'basics', 'pcs', 'routing', 'dhcp', 'nat'];
const SERVICE_PARTS: PartId[] = ['acl', 'ipsec', 'qos', 'telnet', 'snmp', 'syslog', 'save'];

function casePart1(): Spec {
  const s = caseSpec();
  s.id = 'case-study-2026-build';
  s.title = 'Case study, first half: build the network';
  s.blurb = 'Tasks 1 to 5 from scratch: cables, addresses, default routes, DHCP with relay, and NAT.';
  s.minutes = 80;
  s.level = 2;
  s.parts = [...BUILD_PARTS];
  return s;
}
function casePart2(): Spec {
  const s = caseSpec();
  s.id = 'case-study-2026-services';
  s.title = 'Case study, second half: protect and manage';
  s.blurb = 'Tasks 6 to 13 on a network that already works: access list, IPsec, QoS, Telnet, SNMP and syslog.';
  s.minutes = 100;
  s.parts = [...SERVICE_PARTS];
  s.prebuilt = [...BUILT_BASE];
  return s;
}

// ───────────────────────────── broken networks ─────────────────────────────
function brokenSpec(count: number, seed: number): Spec {
  const s = caseSpec();
  s.id = `broken-${count}`;
  s.family = 'broken';
  s.style = 'ticket';
  s.seedable = true;
  s.seed = seed;
  s.title = count === 1 ? 'Broken network: one fault' : count === 2 ? 'Broken network: two faults' : 'Broken network: three faults';
  s.blurb = count === 1
    ? 'The case study is built and it worked. Now one thing is wrong. Read the ticket, find the cause, fix it.'
    : `The case study is built and it worked. Now ${count === 2 ? 'two' : 'three'} things are wrong. Work through the tickets from the bottom layer up.`;
  s.minutes = 15 + 15 * count;
  s.level = count === 1 ? 2 : 3;
  s.prebuilt = [...ALL_PARTS];
  const all = faultCatalogue(s);
  const r = rngFor(`broken-${count}`, seed);
  const picked: typeof all = [];
  const pool = [...all];
  let guard = 0;
  while (picked.length < count && pool.length && guard++ < 500) {
    const f = pool.splice(r.int(0, pool.length - 1), 1)[0];
    if (picked.some((x) => x.slot === f.slot)) continue;
    // prefer faults in different areas, so each ticket is its own puzzle
    if (picked.some((x) => x.layer === f.layer) && pool.some((x) => !picked.some((y) => y.layer === x.layer))) continue;
    picked.push(f);
  }
  s.faults = picked.map((f) => f.id);
  return s;
}

// ───────────────────────────── course labs ─────────────────────────────
const LAB_BASE: PartId[] = ['cabling', 'console', 'basics', 'pcs', 'routing'];
const LAB_ADDR: Addr = { lan1: REF_ADDR.lan1, wan: REF_ADDR.wan, lan2: REF_ADDR.lan2, r1Lo0: REF_ADDR.r1Lo0, r2Lo0: REF_ADDR.r2Lo0, pc1Host: 10 };
const READY = 'The network is cabled, addressed and routed. Console cables are in place: PC1 reaches R1, PC3 reaches R2.';

function labSpec(id: string, title: string, blurb: string, minutes: number, level: 1 | 2 | 3, parts: PartId[], text: LabText, more: Partial<Spec> = {}): Spec {
  return {
    id, title, family: 'lab', blurb, minutes, level, seedable: false, seed: 0, style: 'lab',
    hasPc2: true, wan: 'serial', addr: { ...LAB_ADDR }, addrGiven: true, ports: portsFor('serial'),
    parts, prebuilt: [...LAB_BASE], r2Default: true, lab: text, ...more,
  };
}

function labs(): Spec[] {
  const out: Spec[] = [];
  out.push(labSpec('lab-basics', 'Lab: cabling and basic router setup',
    'From an empty bench to the first ping: cables, console, names, addresses, clock rate, default routes, save.', 40, 1,
    ['cabling', 'console', 'basics', 'pcs', 'routing', 'save'],
    {
      intro: 'The devices are not connected and not configured. Build a small network: PC1 behind R1, PC3 behind R2, and a serial link between the routers. Use the addresses from the table. You may use any free ports.',
      items: [
        { feature: 'cabling', text: 'Cable the bench as the topology shows. Choose the right cable type for each link.' },
        { feature: 'console', text: 'Connect a console cable from a PC to each router and open the terminal.' },
        { feature: 'interface', text: 'Name the routers R1 and R2. Configure the interface addresses from the table and switch the interfaces on. Set clock rate 128000 on the DCE end of the serial link.' },
        { feature: 'pc', text: 'Give PC1 and PC3 their static address, mask and default gateway.' },
        { feature: 'routing', text: 'Add one static default route on each router. PC1 and PC3 must be able to ping each other. The loopbacks must reach each other.' },
        { feature: 'system', text: 'Save the configuration on both routers.' },
      ],
    },
    { hasPc2: false, prebuilt: [], clockRate: 128000 }));

  out.push(labSpec('lab-acl', 'Lab: standard, extended and named access lists',
    'Three small filters on a working network. You practise where each kind of list belongs, and in which direction.', 40, 2,
    ['acl'],
    {
      intro: `${READY} There is no NAT in this lab, so every router sees the real addresses. PC3 runs a web server and an FTP server.`,
      items: [
        { feature: 'acl', text: 'Standard list: PC2 must not reach LAN2. Filter on R2, with a standard access list. Other hosts must not be affected.' },
        { feature: 'acl', text: 'Extended list: no host of LAN1 may open HTTP (TCP port 80) to LAN2. Filter on R1, with an extended access list. All other traffic stays allowed.' },
        {
          feature: 'acl', text: 'Named list: create the named access list PING_OUT_ONLY on R1 and apply it to traffic that comes in over the WAN link.',
          subItems: ['Nobody outside may ping R1 or LAN1.', 'Pings sent from LAN1 must still get their answers.', 'All other traffic stays allowed.'],
        },
      ],
    },
    { acl: { mode: 'lab' }, servers: { PC3: { http: true, ftp: true }, PC1: { http: true } } }));

  const natIntro = `${READY} LAN1 uses private addresses. R2 plays the provider: it has no route to LAN1 and no default route. The company has bought the global addresses 42.0.0.48/28 (42.0.0.49 to 42.0.0.62).`;
  const block = { net: '42.0.0.48', len: 28 };
  out.push(labSpec('lab-nat-static', 'Lab: static NAT',
    'One inside host gets one fixed global address, so it can be reached from outside.', 25, 2, ['nat'],
    {
      intro: natIntro,
      items: [
        { feature: 'nat', text: 'On R1 mark the inside and the outside interface. Translate PC1 (the shared server) to the global address 42.0.0.49 with a static rule.' },
        { feature: 'routing', text: 'On R2 add a static route to 42.0.0.48/28 towards R1.' },
        { feature: 'verify', text: 'Test: PC1 pings PC3, and PC3 pings 42.0.0.49. Look at show ip nat translations on R1. PC2 has no translation: think about why its pings fail.' },
      ],
    },
    { nat: { mode: 'static', block }, r2Default: false, servers: { PC1: { http: true }, PC3: { http: true } } }));
  out.push(labSpec('lab-nat-pool', 'Lab: dynamic NAT with a pool',
    'Inside hosts borrow global addresses from a pool, one address per host.', 25, 2, ['nat'],
    {
      intro: natIntro,
      items: [
        { feature: 'nat', text: 'On R1 mark the inside and the outside interface. Create a pool with the global addresses 42.0.0.49 to 42.0.0.62. Translate every host of LAN1 to an address from the pool. Each host gets its own global address (no overload).' },
        { feature: 'routing', text: 'On R2 add a static route to 42.0.0.48/28 towards R1.' },
        { feature: 'verify', text: 'Test: PC1 and PC2 ping PC3. Look at show ip nat translations on R1.' },
      ],
    },
    { nat: { mode: 'pool', block }, r2Default: false, servers: { PC3: { http: true } } }));
  out.push(labSpec('lab-nat-overload', 'Lab: NAT overload (PAT)',
    'All inside hosts share one global address. The router tells the sessions apart by port number.', 25, 2, ['nat'],
    {
      intro: natIntro,
      items: [
        { feature: 'nat', text: 'On R1 mark the inside and the outside interface. Translate every host of LAN1 to the single global address 42.0.0.49. Many hosts must be able to use it at the same time (overload).' },
        { feature: 'routing', text: 'On R2 add a static route to 42.0.0.48/28 towards R1.' },
        { feature: 'verify', text: 'Test: PC1 and PC2 ping PC3 at the same time. Look at the port numbers in show ip nat translations on R1.' },
      ],
    },
    { nat: { mode: 'overload', block }, r2Default: false, servers: { PC3: { http: true } } }));

  out.push(labSpec('lab-dhcp', 'Lab: DHCP server and relay',
    'One router serves both LANs. The other router relays the requests.', 25, 2, ['dhcp'],
    {
      intro: `${READY} PC1 has a static address. PC2 and PC3 are set to DHCP and have no address yet.`,
      items: [
        { feature: 'dhcp', text: 'Make R1 the DHCP server for LAN1 and for LAN2. Only one router may be a DHCP server.' },
        { feature: 'dhcp', text: 'In LAN1 do not hand out the first 10 usable addresses. The router and PC1 live there.' },
        { feature: 'dhcp', text: 'PC3 is behind R2. Make R2 pass its DHCP requests on to R1.' },
        { feature: 'pc', text: 'Renew the leases on PC2 and PC3 and check their address, mask and default gateway.' },
      ],
    },
    { dhcp: { excludeFirst: 10 } }));

  out.push(labSpec('lab-ipsec', 'Lab: IPsec tunnel between two routers',
    'ISAKMP policy, pre-shared key, transform set, crypto access list, crypto map: the five blocks of a site-to-site tunnel.', 45, 3, ['ipsec'],
    {
      intro: `${READY} There is no NAT in this lab.`,
      items: [
        { feature: 'ipsec', text: 'Build an IPsec tunnel between R1 and R2 with a pre-shared key. Use the WAN addresses as tunnel end points.' },
        { feature: 'ipsec', text: 'Encrypt all IP traffic between LAN1 and LAN2, in both directions.' },
        { feature: 'ipsec', text: 'Traffic to other addresses, for example a ping from PC1 to the WAN address of R2, must cross the link without encryption and still work.' },
        { feature: 'verify', text: 'Test with a ping from PC1 to PC3. Then look at show crypto isakmp sa and show crypto ipsec sa on both routers.' },
      ],
    },
    { ipsec: { mode: 'lans' }, servers: { PC3: { http: true, ftp: true } } }));

  out.push(labSpec('lab-qos', 'Lab: QoS with LLQ and shaping',
    'A slow serial link, a priority class, a guaranteed class, fair queueing for the rest, and a shaper around it all.', 45, 3, ['qos'],
    {
      intro: `${READY} The serial link has no clock rate and no QoS yet.`,
      items: [
        { feature: 'interface', text: 'Limit the serial link between R1 and R2 to 128 kbit/s: clock rate on the DCE end, bandwidth on both WAN interfaces.' },
        {
          feature: 'qos', text: 'Provide quality of service on this link in both directions:',
          subItems: ['ICMP gets 8 kbit/s, guaranteed, with priority.', 'FTP gets a guaranteed bandwidth of at least 60 kbit/s.', 'All other traffic shares the remaining bandwidth by WFQ.', 'Shape all traffic to 90 % of the physical speed.'],
        },
        { feature: 'verify', text: 'Ping across the link and watch the counters in show policy-map interface on both routers.' },
      ],
    },
    { qos: { linkKbps: 128, priority: { kbps: 8, services: ['icmp'] }, guaranteed: { kbps: 60, services: ['ftp'] }, shapePercent: 90 }, servers: { PC3: { http: true, ftp: true } } }));

  out.push(labSpec('lab-mgmt', 'Lab: Telnet, SNMP and syslog',
    'Remote access for one management station, two SNMP communities with access lists, and a central log.', 40, 2, ['telnet', 'snmp', 'syslog'],
    {
      intro: `${READY} There is no NAT in this lab. PC1 is the management station: it runs the SNMP tool and the syslog server.`,
      items: [
        { feature: 'vty', text: 'Allow Telnet to both routers with the password cisco. Only PC1 may connect.' },
        {
          feature: 'snmp', text: 'Configure SNMP on both routers:',
          subItems: [
            'Community D105read for reading. Only hosts of LAN1 (the network of the SNMP station) may use it.',
            'Community D105write for reading and writing. Only PC1 may use it.',
            'Location D105 and contact d105@fiit.stuba.sk.',
          ],
        },
        { feature: 'syslog', text: 'Start the syslog server on PC1. Both routers send their log messages of every level (down to debugging) to PC1. The source address is the address of Loopback0.' },
      ],
    },
    {
      telnet: { password: 'cisco', passwordGiven: true },
      snmp: { ro: 'D105read', rw: 'D105write', namesGiven: true, readers: 'lan1', location: 'D105', contact: 'd105@fiit.stuba.sk' },
      syslog: { source: 'Loopback0', allLevels: true },
    }));
  return out;
}

// ───────────────────────────── registry ─────────────────────────────
function fixed(make: () => Spec): ScenarioDef {
  return { summary: summaryOf(make()), build: (): ScenarioInstance => buildInstance(make()) };
}
function seeded(make: (seed: number) => Spec): ScenarioDef {
  return { summary: summaryOf(make(0)), build: (seed: number): ScenarioInstance => buildInstance(make(Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0)) };
}

function variation(seed: number): Spec {
  const s = variedSpec(seed, 'variation');
  s.id = 'variation';
  s.family = 'variation';
  s.seedable = true;
  s.title = 'Variation: the same skills with new facts';
  s.blurb = 'The case study with other networks, other rules and other numbers on every seed. Some seeds use an Ethernet WAN link or give a full address table.';
  return s;
}
function mock(seed: number): Spec {
  const s = variedSpec(seed, 'mock-exam');
  s.id = 'mock-exam';
  s.family = 'mock';
  s.style = 'exam';
  s.seedable = true;
  s.minutes = 180;
  s.title = 'Mock exam: 180 minutes, 18 practice points';
  s.blurb = 'A full exam sheet in the style of the real test. Empty bench, thirteen tasks, three hours. Seed 0 is the 2026 case study.';
  return s;
}

export const CASE_STUDY_ID = 'case-study-2026';

export const ALL_SCENARIOS: ScenarioDef[] = [
  fixed(caseSpec),
  fixed(casePart1),
  fixed(casePart2),
  seeded(variation),
  seeded(mock),
  seeded((seed) => brokenSpec(1, seed)),
  seeded((seed) => brokenSpec(2, seed)),
  seeded((seed) => brokenSpec(3, seed)),
  ...labs().map((s) => fixed(() => ({ ...s, addr: { ...s.addr }, parts: [...s.parts], prebuilt: [...s.prebuilt] }))),
];
export { caseOptions };
