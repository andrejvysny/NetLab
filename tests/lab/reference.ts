/**
 * The course's reference solution (docs/COURSE.md) as a self-contained assignment for the Lab tests: bench, cabling,
 * both router configurations as text, PC settings, and a grader that probes the acceptance facts.
 * It stands in for the real case study until src/scenarios provides it.
 */
import type { CheckResult, FlowSpec, RequirementResult, ScenarioDef, ScenarioInstance, ScenarioSummary, SolutionView, World } from '../../src/engine/types.ts';
import { cloneWorld, isIos, isPc } from '../../src/engine/world.ts';
import { probeFlow, routingTable } from '../../src/engine/sim/index.ts';

const SHARED = (peer: string) => `crypto isakmp policy 10
 encryption aes
 hash sha
 authentication pre-share
 group 2
crypto isakmp key KSS123 address ${peer}
crypto ipsec transform-set TS esp-aes esp-sha-hmac
 mode tunnel
crypto map CM 10 ipsec-isakmp
 set peer ${peer}
 set transform-set TS
 match address 120
class-map match-all classPriority
 match access-group name matchPriority
class-map match-all classGuaranteed
 match access-group name matchGuaranteed
policy-map output_QE
 class classPriority
  priority 16
 class classGuaranteed
  bandwidth 48
 class class-default
  fair-queue
policy-map output_SE
 class class-default
  shape average percent 95
  service-policy output_QE`;
const ACLS = `access-list 120 permit tcp any any eq telnet
access-list 120 permit tcp any eq telnet any
access-list 120 permit tcp any any eq 22
access-list 120 permit tcp any eq 22 any
access-list 120 permit icmp any any
access-list 120 permit udp any any eq snmp
access-list 120 permit udp any eq snmp any
access-list 120 permit udp any any eq snmptrap
access-list 120 permit udp any eq snmptrap any
ip access-list extended matchGuaranteed
 permit tcp any any eq telnet
 permit tcp any eq telnet any
 permit tcp any any eq 22
 permit tcp any eq 22 any
 permit udp any any eq snmp
 permit udp any eq snmp any
 permit udp any any eq snmptrap
 permit udp any eq snmptrap any
ip access-list extended matchPriority
 permit icmp any any`;
const VTY = `line vty 0 4
 access-class allowPC1 in
 password cisco
 login
line vty 5 14
 access-class allowPC1 in
 password cisco
 login
end`;

export const R1_REFERENCE = `hostname R1
no ip domain-lookup
ip dhcp excluded-address 192.168.100.1 192.168.100.100
ip dhcp pool LAN1
 network 192.168.100.0 255.255.255.0
 default-router 192.168.100.1
ip dhcp pool LAN2
 network 60.50.40.0 255.255.255.192
 default-router 60.50.40.1
${SHARED('60.50.30.2')}
interface Loopback0
 ip address 1.1.1.1 255.255.255.255
interface Loopback100
 ip address 60.50.50.100 255.255.255.255
interface GigabitEthernet0/0/0
 ip address 192.168.100.1 255.255.255.0
 ip access-group 110 in
 ip nat inside
 no shutdown
interface Serial0/1/0
 bandwidth 128
 ip address 60.50.30.1 255.255.255.252
 ip nat outside
 clock rate 128000
 crypto map CM
 service-policy output output_SE
 no shutdown
ip nat inside source static 192.168.100.10 60.50.50.100
ip nat inside source list 1 interface Serial0/1/0 overload
ip route 0.0.0.0 0.0.0.0 Serial0/1/0 60.50.30.2
access-list 1 permit 192.168.100.0 0.0.0.255
access-list 10 permit host 192.168.100.10
access-list 10 permit host 60.50.40.2
access-list 11 permit host 192.168.100.10
access-list 110 deny ip host 192.168.100.10 host 2.2.2.2
access-list 110 permit icmp host 192.168.100.101 60.50.40.0 0.0.0.63
access-list 110 permit tcp host 192.168.100.101 60.50.40.0 0.0.0.63 eq www
access-list 110 deny ip host 192.168.100.101 60.50.40.0 0.0.0.63
access-list 110 permit ip any any
${ACLS}
ip access-list standard allowPC1
 permit 192.168.100.10
snmp-server community D105read RO 10
snmp-server community D105write RW 11
logging source-interface Loopback0
logging 192.168.100.10
${VTY}
`;
export const R2_REFERENCE = `hostname R2
no ip domain-lookup
${SHARED('60.50.30.1')}
interface Loopback0
 ip address 2.2.2.2 255.255.255.255
interface GigabitEthernet0/0/0
 ip address 60.50.40.1 255.255.255.192
 ip helper-address 60.50.30.1
 no shutdown
interface Serial0/1/0
 bandwidth 128
 ip address 60.50.30.2 255.255.255.252
 crypto map CM
 service-policy output output_SE
 no shutdown
ip route 0.0.0.0 0.0.0.0 Serial0/1/0 60.50.30.1
access-list 10 permit host 60.50.50.100
access-list 10 permit host 60.50.40.2
access-list 11 permit host 60.50.50.100
${ACLS}
ip access-list standard allowPC1
 permit 60.50.50.100
snmp-server community D105read RO 10
snmp-server community D105write RW 11
logging source-interface Loopback0
logging 60.50.50.100
${VTY}
`;

const GI = 'GigabitEthernet0/0/0';
const SE = 'Serial0/1/0';
const p = (deviceId: string, port: string) => ({ deviceId, port });

export const REFERENCE_SOLUTION: SolutionView = {
  cables: [
    { kind: 'straight', a: p('PC1', 'Ethernet0'), b: p('SW1', 'GigabitEthernet1/0/1') },
    { kind: 'straight', a: p('PC2', 'Ethernet0'), b: p('SW1', 'GigabitEthernet1/0/2') },
    { kind: 'straight', a: p('SW1', 'GigabitEthernet1/0/24'), b: p('R1', GI) },
    { kind: 'serial', a: p('R1', SE), b: p('R2', SE), dceEnd: 'a' },
    { kind: 'crossover', a: p('R2', GI), b: p('PC3', 'Ethernet0') },
    { kind: 'console', a: p('PC1', 'COM1'), b: p('R1', 'Console'), note: 'moved to the device being configured' },
  ],
  configs: { R1: R1_REFERENCE, R2: R2_REFERENCE },
  pcs: {
    PC1: { mode: 'static', address: '192.168.100.10', mask: '255.255.255.0', gateway: '192.168.100.1', services: { syslog: true } },
    PC2: { mode: 'dhcp' },
    PC3: { mode: 'dhcp', services: { http: true, ftp: true } },
  },
  notes: [],
};

interface Probe { id: string; label: string; spec: FlowSpec; ok: boolean; symbol?: string; seenFrom?: string; encrypted?: boolean }
const PROBES: { req: string; title: string; points: number; probes: Probe[] }[] = [
  { req: 'reach', title: 'LAN1, LAN2 and the loopbacks talk to each other', points: 4, probes: [
    { id: 'p1-p2', label: 'PC1 pings PC2', spec: { fromDeviceId: 'PC1', dst: '192.168.100.101', proto: 'icmp' }, ok: true },
    { id: 'p1-p3', label: 'PC1 pings PC3', spec: { fromDeviceId: 'PC1', dst: '60.50.40.2', proto: 'icmp' }, ok: true, seenFrom: '60.50.50.100', encrypted: true },
    { id: 'p2-p3', label: 'PC2 pings PC3', spec: { fromDeviceId: 'PC2', dst: '60.50.40.2', proto: 'icmp' }, ok: true, seenFrom: '60.50.30.1' },
    { id: 'lo-lo', label: 'R1 Loopback0 pings R2 Loopback0', spec: { fromDeviceId: 'R1', srcAddr: '1.1.1.1', dst: '2.2.2.2', proto: 'icmp' }, ok: true },
    { id: 'p3-p1', label: 'PC3 reaches PC1 from outside', spec: { fromDeviceId: 'PC3', dst: '60.50.50.100', proto: 'icmp' }, ok: true },
  ] },
  { req: 'acl', title: 'PC1 and PC2 are restricted', points: 4, probes: [
    { id: 'p1-lo', label: 'PC1 must not reach 2.2.2.2', spec: { fromDeviceId: 'PC1', dst: '2.2.2.2', proto: 'icmp' }, ok: false, symbol: 'U' },
    { id: 'p2-http', label: 'PC2 → PC3 HTTP', spec: { fromDeviceId: 'PC2', dst: '60.50.40.2', proto: 'tcp', dport: 80 }, ok: true, encrypted: false },
    { id: 'p2-ftp', label: 'PC2 → PC3 FTP is stopped', spec: { fromDeviceId: 'PC2', dst: '60.50.40.2', proto: 'tcp', dport: 21 }, ok: false },
  ] },
  { req: 'mgmt', title: 'Telnet only from PC1', points: 4, probes: [
    { id: 't-p1-r2', label: 'PC1 → R2 Telnet', spec: { fromDeviceId: 'PC1', dst: '60.50.30.2', proto: 'tcp', dport: 23 }, ok: true, encrypted: true },
    { id: 't-p1-r1', label: 'PC1 → R1 Telnet', spec: { fromDeviceId: 'PC1', dst: '192.168.100.1', proto: 'tcp', dport: 23 }, ok: true },
    { id: 't-p2-r1', label: 'PC2 → R1 Telnet refused', spec: { fromDeviceId: 'PC2', dst: '192.168.100.1', proto: 'tcp', dport: 23 }, ok: false },
    { id: 't-p3-r2', label: 'PC3 → R2 Telnet refused', spec: { fromDeviceId: 'PC3', dst: '60.50.40.1', proto: 'tcp', dport: 23 }, ok: false },
  ] },
];

/** The reference lab as an assignment. `id` lets a test register it under the real case-study id. */
export function referenceScenario(id = 'reference'): ScenarioDef {
  const summary: ScenarioSummary = {
    id, title: 'Reference case study', family: 'case-study', features: ['cabling', 'dhcp', 'nat', 'acl', 'ipsec', 'qos', 'vty', 'snmp', 'syslog'],
    minutes: 180, level: 3, blurb: 'The course reference solution.', seedable: false,
  };
  const requirements = [
    ...PROBES.map((g, i) => ({ id: g.req, no: String(i + 1), title: g.title, feature: 'verify' as const, points: g.points })),
    { id: 'dhcp', no: '4', title: 'PC2 and PC3 get their addresses from R1', feature: 'dhcp' as const, points: 3 },
    { id: 'routes', no: '5', title: 'One default route and nothing else', feature: 'routing' as const, points: 3 },
  ];
  return {
    summary,
    build(seed: number): ScenarioInstance {
      return {
        summary, seed,
        brief: { intro: 'Build the case study.', items: [] },
        diagram: { nodes: [], links: [] },
        bench: [
          { id: 'R1', model: 'isr4331', label: 'R1', x: 420, y: 120 },
          { id: 'R2', model: 'isr4331', label: 'R2', x: 720, y: 120 },
          { id: 'SW1', model: 'c9300l', label: 'SW1', x: 180, y: 260 },
          { id: 'SW2', model: 'c9300l', label: 'SW2', x: 520, y: 330 },
          { id: 'PC1', model: 'pc-windows', label: 'PC1', x: 80, y: 460 },
          { id: 'PC2', model: 'pc-windows', label: 'PC2', x: 300, y: 460 },
          { id: 'PC3', model: 'pc-windows', label: 'PC3', x: 760, y: 420 },
          { id: 'PC4', model: 'pc-macos', label: 'MacBook', x: 540, y: 500 },
        ],
        requirements,
        guide: [],
        solution: REFERENCE_SOLUTION,
        hardwareNotes: [],
        grade(world: World) {
          const w = cloneWorld(world);
          const results: RequirementResult[] = PROBES.map((g, i) => {
            const checks: CheckResult[] = g.probes.map((pr) => {
              const r = probeFlow(w, pr.spec);
              const seen = r.forward.received?.src;
              const pass = r.ok === pr.ok && (pr.symbol === undefined || r.symbol === pr.symbol) && (pr.seenFrom === undefined || seen === pr.seenFrom)
                && (pr.encrypted === undefined || r.forward.encrypted === pr.encrypted);
              return {
                id: pr.id, label: pr.label, pass,
                expected: `${pr.ok ? 'works' : 'stopped'}${pr.symbol ? ` (${pr.symbol})` : ''}${pr.seenFrom ? `, seen from ${pr.seenFrom}` : ''}${pr.encrypted === undefined ? '' : pr.encrypted ? ', encrypted' : ', in clear'}`,
                observed: `${r.ok ? 'works' : 'stopped'} (${r.symbol}), seen from ${seen ?? '-'}, ${r.forward.encrypted ? 'encrypted' : 'in clear'}: ${r.summary}`,
              };
            });
            const pass = checks.every((c) => c.pass);
            return { ...requirements[i], earned: pass ? g.points : 0, pass, checks };
          });
          const pc2 = w.devices.PC2;
          const pc3 = w.devices.PC3;
          const a2 = isPc(pc2) && pc2.nic.mode === 'dhcp' ? pc2.nic.address : undefined;
          const a3 = isPc(pc3) && pc3.nic.mode === 'dhcp' ? pc3.nic.address : undefined;
          const dhcpOk = a2 === '192.168.100.101' && a3 === '60.50.40.2';
          results.push({ ...requirements[3], earned: dhcpOk ? 3 : 0, pass: dhcpOk, checks: [{ id: 'leases', label: 'Leases', pass: dhcpOk, expected: 'PC2 192.168.100.101, PC3 60.50.40.2', observed: `PC2 ${a2 ?? 'none'}, PC3 ${a3 ?? 'none'}` }] });
          const statics = ['R1', 'R2'].map((id) => (isIos(w.devices[id]) ? routingTable(w, id).filter((r) => r.code !== 'C' && r.code !== 'L') : []));
          const routesOk = statics.every((list) => list.length === 1 && list[0].isDefault);
          results.push({ ...requirements[4], earned: routesOk ? 3 : 0, pass: routesOk, checks: [{ id: 'routes', label: 'Routing tables', pass: routesOk, expected: 'one default route each', observed: statics.map((l) => l.length).join(' / ') }] });
          return { requirements: results, orderIssues: [] };
        },
        guideProgress() { return {}; },
      };
    },
  };
}
