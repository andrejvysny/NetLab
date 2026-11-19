/**
 * Fixture data for the mock LabApi (src/ui/dev/mockLab.ts). Content follows docs/COURSE.md (case study 2026)
 * so every screen shows realistic text. Not used by the real engine. Owned by the app-shell agent.
 */
import type {
  BriefItem, DiagramSpec, Feature, GradeReport, GuideStep, HardwareNote, JournalEntry, OrderIssue,
  RequirementResult, RequirementView, ScenarioSummary, SolutionView, TraceStep,
} from '../../engine/types.ts';
import type { CommandSheetSection } from '../../engine/labapi.ts';

const ALL: Feature[] = ['cabling', 'console', 'system', 'interface', 'routing', 'dhcp', 'nat', 'acl', 'ipsec', 'qos', 'vty', 'snmp', 'syslog'];

export const SCENARIOS: ScenarioSummary[] = [
  // ── case study ──
  { id: 'case-2026', title: 'Case study 2026 — the full assignment', family: 'case-study', features: ALL, minutes: 180, level: 3, seedable: false,
    blurb: 'The real exam task. Two routers, one switch, three PCs, thirteen tasks from DHCP to syslog.' },
  { id: 'case-2026-build', title: 'Case study, part 1: build the network', family: 'case-study', features: ['cabling', 'console', 'interface', 'routing', 'dhcp', 'nat'], minutes: 75, level: 2, seedable: false,
    blurb: 'Tasks 1 to 5 only: cables, addresses, DHCP, NAT and the default routes.' },
  { id: 'case-2026-protect', title: 'Case study, part 2: protect and manage', family: 'case-study', features: ['acl', 'ipsec', 'qos', 'vty', 'snmp', 'syslog'], minutes: 90, level: 3, seedable: false,
    blurb: 'Tasks 6 to 13 on a network that already works: ACL, IPsec, QoS, Telnet, SNMP and syslog.' },
  // ── variations ──
  { id: 'var-numbers', title: 'Same task, new numbers', family: 'variation', features: ALL, minutes: 180, level: 3, seedable: true,
    blurb: 'The case study with different networks every time. You learn the method, not the numbers.' },
  { id: 'var-dhcp-r2', title: 'DHCP server on the other router', family: 'variation', features: ['interface', 'routing', 'dhcp', 'nat', 'acl'], minutes: 60, level: 2, seedable: true,
    blurb: 'R2 hands out the addresses and R1 relays. Think about NAT before you start.' },
  { id: 'var-two-lans', title: 'Two LANs behind one router', family: 'variation', features: ['interface', 'nat', 'acl', 'qos'], minutes: 90, level: 3, seedable: true,
    blurb: 'R1 gets a second LAN. The NAT, ACL and QoS rules change with it.' },
  // ── course labs ──
  { id: 'lab-cabling', title: 'Cabling and console', family: 'lab', features: ['cabling', 'console'], minutes: 20, level: 1, seedable: false,
    blurb: 'Pick the right cable for each link and open your first terminal.' },
  { id: 'lab-basics', title: 'First router setup', family: 'lab', features: ['system', 'interface', 'verify'], minutes: 30, level: 1, seedable: false,
    blurb: 'Hostname, interface addresses, no shutdown and your first ping.' },
  { id: 'lab-dhcp', title: 'DHCP server and relay', family: 'lab', features: ['dhcp', 'pc'], minutes: 30, level: 2, seedable: true,
    blurb: 'Pools, excluded addresses and ip helper-address.' },
  { id: 'lab-acl', title: 'Access lists', family: 'lab', features: ['acl', 'verify'], minutes: 40, level: 2, seedable: true,
    blurb: 'Standard and extended ACLs. Where to put them, and in which direction.' },
  { id: 'lab-nat', title: 'NAT and PAT', family: 'lab', features: ['nat', 'verify'], minutes: 40, level: 2, seedable: true,
    blurb: 'Static NAT for one host, PAT for everyone else.' },
  { id: 'lab-ipsec', title: 'IPsec site-to-site tunnel', family: 'lab', features: ['ipsec', 'acl', 'verify'], minutes: 50, level: 3, seedable: false,
    blurb: 'ISAKMP policy, transform set, crypto map, and a mirror ACL on each side.' },
  { id: 'lab-qos', title: 'QoS on a slow serial link', family: 'lab', features: ['qos', 'interface'], minutes: 45, level: 3, seedable: false,
    blurb: 'Priority, guaranteed bandwidth and a shaper, built with class-map and policy-map.' },
  { id: 'lab-mgmt', title: 'Telnet, SNMP and syslog', family: 'lab', features: ['vty', 'snmp', 'syslog'], minutes: 40, level: 2, seedable: false,
    blurb: 'Remote access from one PC only, SNMP communities and logging to a server.' },
  // ── broken networks ──
  { id: 'broken-dhcp', title: 'PC2 gets no address', family: 'broken', features: ['dhcp', 'interface'], minutes: 20, level: 2, seedable: false,
    blurb: 'Everything is cabled and configured. PC2 still shows 169.254.x.x. Find out why.' },
  { id: 'broken-tunnel', title: 'The tunnel never comes up', family: 'broken', features: ['ipsec', 'acl'], minutes: 25, level: 3, seedable: false,
    blurb: 'Ping across the WAN works, but nothing is encrypted. Two small mistakes hide in the configs.' },
  { id: 'broken-telnet', title: 'Telnet is refused', family: 'broken', features: ['vty', 'acl', 'nat'], minutes: 20, level: 2, seedable: false,
    blurb: 'PC1 should reach both routers by Telnet. R2 says no. Remember what NAT does to the source address.' },
  // ── mock exams ──
  { id: 'mock-1', title: 'Mock exam 1', family: 'mock', features: ALL, minutes: 180, level: 3, seedable: true,
    blurb: 'A full exam in the style of the real test. New topology, 13 tasks, 18 points.' },
  { id: 'mock-2', title: 'Mock exam 2 — stricter rules', family: 'mock', features: ALL, minutes: 180, level: 3, seedable: true,
    blurb: 'More ACL and QoS detail. Try it after you are happy with Mock exam 1.' },
];

// ───────────────────────── brief ─────────────────────────

export const CASE_INTRO =
  'Cable the devices as shown in the topology. Then configure them so that every task below works. ' +
  'The routers and the switch start empty. You may use any free ports.';

export const CASE_GIVEN: { label: string; value: string }[] = [
  { label: 'LAN1 (private, class C)', value: '192.168.100.0 /24' },
  { label: 'WAN1 (R1 – R2)', value: '60.50.30.0 /30' },
  { label: 'LAN2', value: '60.50.40.0 /26' },
  { label: 'R1 Loopback0', value: '1.1.1.1 /32' },
  { label: 'R1 Loopback100', value: '60.50.50.100 /32' },
  { label: 'R2 Loopback0', value: '2.2.2.2 /32' },
  { label: 'Router address in each LAN', value: 'host .1' },
  { label: 'PC1 (MS) — static', value: 'host .10' },
  { label: 'Telnet password', value: 'cisco' },
  { label: 'SNMP communities', value: 'D105read, D105write' },
];

export const CASE_BRIEF: BriefItem[] = [
  { no: '1', feature: 'dhcp', text: 'PC2 and PC3 get their address from DHCP. PC1 has a static address. Only one router is the DHCP server — choose it with task 4 in mind. In LAN1, do not lease the first 100 usable addresses.' },
  { no: '2', feature: 'interface', text: 'The link between the routers (WAN1) is point-to-point with a /30 mask. LAN1 uses /24. LAN2 uses /26.' },
  { no: '3', feature: 'routing', text: "Hosts must reach each other inside LAN1 and LAN2, between LAN1 and LAN2, and between the routers' loopback interfaces." },
  { no: '4', feature: 'nat', text: 'LAN1 uses a private network, but outside it appears with public addresses.',
    subItems: ['All PCs use a public address from WAN1, with many sessions at the same time.', 'PC1 (MS) must be reachable when the session starts from outside. Use the Loopback100 address for this.'] },
  { no: '5', feature: 'routing', text: 'Do not use a routing protocol. Besides the connected networks, each routing table may hold only one more entry.' },
  { no: '6', feature: 'acl', text: 'PC1 must not communicate with the Loopback0 network on R2.' },
  { no: '7', feature: 'acl', text: 'PC2 must not communicate with LAN2, except by ICMP or HTTP.' },
  { no: '8', feature: 'ipsec', text: 'Encrypt this traffic between R1 and R2 (Tunnel 1):',
    subItems: ['Telnet', 'SSH', 'ICMP', 'Network management (UDP 161 and 162)'] },
  { no: '9', feature: 'ipsec', optional: true, text: 'ICMP and FTP between PC1 and PC3 leave the PCs already encrypted (Windows IPsec). Crossed out on the 2026 sheet — not graded.' },
  { no: '10', feature: 'qos', text: 'Limit the R1–R2 link physically to 128 kbit/s. Give it QoS in both directions:',
    subItems: ['ICMP gets a priority guarantee of 16 kbit/s.', 'Telnet, SSH and network management get at least 48 kbit/s.', 'All other traffic shares the rest fairly (WFQ).', 'Shape all traffic to 95 % of the physical rate.'] },
  { no: '11', feature: 'vty', text: 'Allow Telnet to both routers, but only from PC1 (MS).' },
  { no: '12', feature: 'snmp', text: 'Make SNMP available on both routers. PC1 and PC3 may read. Only PC1 may write.' },
  { no: '13', feature: 'syslog', text: 'Both routers send syslog messages to PC1 (MS), with the source address of Loopback0.' },
];

export const CABLING_BRIEF: BriefItem[] = [
  { no: '1', feature: 'cabling', text: 'Connect PC1 and PC2 to SW1.' },
  { no: '2', feature: 'cabling', text: 'Connect SW1 to R1. Connect R1 to R2 with a serial cable. Put the DCE end on R1.' },
  { no: '3', feature: 'cabling', text: 'Connect PC3 directly to R2. Think about which Ethernet cable type you need.' },
  { no: '4', feature: 'console', text: 'Connect a console cable from PC1 to R1 and open the terminal.', subItems: ['Answer "no" to the initial configuration dialog.', 'Type enable and check that the prompt ends with #.'] },
  { no: '5', feature: 'console', optional: true, text: 'Move the console cable to R2 and open its terminal too.' },
];

export const CASE_DIAGRAM: DiagramSpec = {
  areas: [
    { label: 'LAN1  192.168.100.0/24', x: 20, y: 40, w: 370, h: 520 },
    { label: 'LAN2  60.50.40.0/26', x: 790, y: 130, w: 190, h: 330 },
  ],
  nodes: [
    { id: 'PC1', label: 'PC1 (MS)', kind: 'pc', x: 100, y: 150, notes: ['static .10'] },
    { id: 'PC2', label: 'PC2', kind: 'pc', x: 100, y: 420, notes: ['DHCP'] },
    { id: 'SW1', label: 'SW1', kind: 'switch', x: 290, y: 285 },
    { id: 'R1', label: 'R1', kind: 'router', x: 470, y: 285, notes: ['Lo0 1.1.1.1/32', 'Lo100 60.50.50.100/32'] },
    { id: 'R2', label: 'R2', kind: 'router', x: 700, y: 285, notes: ['Lo0 2.2.2.2/32'] },
    { id: 'PC3', label: 'PC3', kind: 'pc', x: 885, y: 285, notes: ['DHCP'] },
  ],
  links: [
    { a: 'PC1', b: 'SW1' },
    { a: 'PC2', b: 'SW1' },
    { a: 'SW1', b: 'R1', label: '.1' },
    { a: 'R1', b: 'R2', label: 'WAN1 /30' },
    { a: 'R1', b: 'R2', label: 'Tunnel 1', dashed: true },
    { a: 'R2', b: 'PC3', label: '.1' },
  ],
};

export const CABLING_DIAGRAM: DiagramSpec = {
  nodes: [
    { id: 'PC1', label: 'PC1', kind: 'pc', x: 120, y: 160 },
    { id: 'PC2', label: 'PC2', kind: 'pc', x: 120, y: 440 },
    { id: 'SW1', label: 'SW1', kind: 'switch', x: 330, y: 300 },
    { id: 'R1', label: 'R1', kind: 'router', x: 560, y: 300 },
    { id: 'R2', label: 'R2', kind: 'router', x: 790, y: 300 },
    { id: 'PC3', label: 'PC3', kind: 'pc', x: 790, y: 500 },
  ],
  links: [
    { a: 'PC1', b: 'SW1' }, { a: 'PC2', b: 'SW1' }, { a: 'SW1', b: 'R1' },
    { a: 'R1', b: 'R2', label: 'serial, DCE on R1' }, { a: 'R2', b: 'PC3' },
    { a: 'PC1', b: 'R1', label: 'console', dashed: true },
  ],
};

// ───────────────────────── requirements ─────────────────────────

export const CASE_REQUIREMENTS: RequirementView[] = [
  { id: 'r-cabling', no: '0', title: 'All links are up with the right cable', feature: 'cabling', points: 2 },
  { id: 'r1', no: '1', title: 'DHCP for PC2 and PC3, first 100 LAN1 addresses kept free', feature: 'dhcp', points: 3 },
  { id: 'r2', no: '2', title: 'Masks: WAN1 /30, LAN1 /24, LAN2 /26', feature: 'interface', points: 1 },
  { id: 'r3', no: '3', title: 'LANs and loopbacks reach each other', feature: 'routing', points: 2 },
  { id: 'r4a', no: '4a', title: 'PAT: the PCs leave with the WAN address', feature: 'nat', points: 2 },
  { id: 'r4b', no: '4b', title: 'Static NAT: PC1 is reachable on 60.50.50.100', feature: 'nat', points: 2 },
  { id: 'r5', no: '5', title: 'One default route, no routing protocol', feature: 'routing', points: 1 },
  { id: 'r6', no: '6', title: "PC1 cannot reach R2's Loopback0", feature: 'acl', points: 1 },
  { id: 'r7', no: '7', title: 'PC2 reaches LAN2 only by ICMP and HTTP', feature: 'acl', points: 2 },
  { id: 'r8', no: '8', title: 'Telnet, SSH, ICMP and SNMP are encrypted between R1 and R2', feature: 'ipsec', points: 3 },
  { id: 'r10', no: '10', title: 'QoS on WAN1: 128 kbit/s, priority 16, guarantee 48, WFQ, shape 95 %', feature: 'qos', points: 3 },
  { id: 'r11', no: '11', title: 'Telnet to both routers only from PC1', feature: 'vty', points: 2 },
  { id: 'r12', no: '12', title: 'SNMP: read from PC1 and PC3, write only from PC1', feature: 'snmp', points: 2 },
  { id: 'r13', no: '13', title: 'Syslog to PC1 from Loopback0', feature: 'syslog', points: 1 },
];

// ───────────────────────── guide ─────────────────────────

export const CASE_GUIDE: GuideStep[] = [
  { id: 'g-cable', no: 1, title: 'Cable the bench', feature: 'cabling', devices: ['PC1', 'PC2', 'SW1', 'R1', 'R2', 'PC3'], allows: ['cabling'],
    goal: 'Connect every device as shown in the topology. Choose the right cable type for each link.',
    why: 'Nothing works without a link. With strict cable rules on, the wrong Ethernet type keeps the link down.',
    hint: 'PC or router to a switch: straight-through. Router to router: serial cable. Router straight to a PC: crossover.',
    example: 'PC1 Eth0      → SW1 Gi1/0/1   straight-through\nPC2 Eth0      → SW1 Gi1/0/2   straight-through\nSW1 Gi1/0/24  → R1 Gi0/0/0    straight-through\nR1 Se0/1/0    → R2 Se0/1/0    serial (DCE end on R1)\nR2 Gi0/0/0    → PC3 Eth0      crossover' },
  { id: 'g-console', no: 2, title: 'Plug in a console cable', feature: 'console', devices: ['PC1', 'R1'], allows: ['console', 'cabling'],
    goal: "Connect a console cable from a PC's COM port to the CON port of R1. Then open the terminal.",
    why: 'The routers are empty. The console is the only way in until they have an address.',
    hint: 'The console cable is the light blue one. It goes into the port marked CON, not into a Gigabit port.',
    example: 'PC1 COM1 → R1 CON   console (rollover)\n\nWould you like to enter the initial configuration dialog? [yes/no]: no' },
  { id: 'g-basics', no: 3, title: 'Name the routers', feature: 'system', devices: ['R1', 'R2'], allows: ['system'],
    goal: 'Give each router its hostname. Turn off DNS lookup so a typo does not freeze the terminal.',
    why: 'The hostname shows in the prompt, so you always know which router you are typing on.',
    hint: 'You need privileged mode (#) and then configuration mode.',
    example: 'enable\nconfigure terminal\nhostname R1\nno ip domain-lookup' },
  { id: 'g-ifaces', no: 4, title: 'Addresses on every interface', feature: 'interface', devices: ['R1', 'R2'], allows: ['interface'],
    goal: 'Set the IP addresses from the plan on R1 and R2, including both loopbacks on R1. Turn the ports on.',
    why: 'Router ports start shut down. Without an address and no shutdown, nothing can pass.',
    hint: 'The WAN1 mask /30 is 255.255.255.252. LAN2 /26 is 255.255.255.192. Only the DCE end gets clock rate.',
    example: 'interface GigabitEthernet0/0/0\n ip address 192.168.100.1 255.255.255.0\n no shutdown\ninterface Serial0/1/0\n ip address 60.50.30.1 255.255.255.252\n bandwidth 128\n clock rate 128000\n no shutdown\ninterface Loopback0\n ip address 1.1.1.1 255.255.255.255' },
  { id: 'g-routes', no: 5, title: 'One default route on each router', feature: 'routing', devices: ['R1', 'R2'], allows: ['routing'],
    goal: 'Add exactly one static default route on each router, pointing across WAN1.',
    why: 'Task 5 allows only one extra entry per routing table, and no routing protocol.',
    hint: 'The course solution names the exit interface and the next hop.',
    example: 'ip route 0.0.0.0 0.0.0.0 Serial0/1/0 60.50.30.2' },
  { id: 'g-dhcp', no: 6, title: 'DHCP server and relay', feature: 'dhcp', devices: ['R1', 'R2'], allows: ['dhcp'],
    goal: 'Make R1 the DHCP server for LAN1 and LAN2. Keep .1 to .100 in LAN1 free. Let R2 relay requests from LAN2.',
    why: 'R1 is the server because of NAT in task 4: the server must see the real LAN2 relay address.',
    hint: 'On R2 the relay goes on the LAN interface and points to the R1 WAN address.',
    example: 'ip dhcp excluded-address 192.168.100.1 192.168.100.100\nip dhcp pool LAN1\n network 192.168.100.0 255.255.255.0\n default-router 192.168.100.1\n! on R2:\ninterface GigabitEthernet0/0/0\n ip helper-address 60.50.30.1' },
  { id: 'g-pcs', no: 7, title: 'Set up the PCs', feature: 'pc', devices: ['PC1', 'PC2', 'PC3'], allows: ['pc'],
    goal: 'Give PC1 its static address and gateway. Set PC2 and PC3 to DHCP and check that they get an address.',
    hint: 'Use ipconfig /renew on PC2 and PC3. PC2 should get 192.168.100.101.',
    example: 'PC1: 192.168.100.10  255.255.255.0  gateway 192.168.100.1\nPC2: DHCP\nPC3: DHCP' },
  { id: 'g-nat', no: 8, title: 'NAT: PAT and static NAT', feature: 'nat', devices: ['R1'], allows: ['nat', 'acl'],
    goal: 'Translate LAN1 to the WAN address with overload. Map PC1 to the Loopback100 address.',
    hint: 'Mark the LAN interface as inside and the WAN interface as outside.',
    example: 'access-list 1 permit 192.168.100.0 0.0.0.255\nip nat inside source list 1 interface Serial0/1/0 overload\nip nat inside source static 192.168.100.10 60.50.50.100\ninterface GigabitEthernet0/0/0\n ip nat inside\ninterface Serial0/1/0\n ip nat outside' },
  { id: 'g-acl', no: 9, title: 'One ACL for tasks 6 and 7', feature: 'acl', devices: ['R1'], allows: ['acl'],
    goal: 'Write one extended ACL and apply it inbound on the R1 LAN interface.',
    why: 'Inbound on the LAN side, the packets still carry the private source addresses.',
    hint: 'ACL lines are read from the top. The deny for PC2 must come after its permits, and before permit ip any any.',
    example: 'access-list 110 deny ip host 192.168.100.10 host 2.2.2.2\naccess-list 110 permit icmp host 192.168.100.101 60.50.40.0 0.0.0.63\naccess-list 110 permit tcp host 192.168.100.101 60.50.40.0 0.0.0.63 eq www\naccess-list 110 deny ip host 192.168.100.101 60.50.40.0 0.0.0.63\naccess-list 110 permit ip any any' },
  { id: 'g-ipsec', no: 10, title: 'IPsec tunnel between R1 and R2', feature: 'ipsec', devices: ['R1', 'R2'], allows: ['ipsec', 'acl'],
    goal: 'Build the same ISAKMP policy, key, transform set and crypto map on both routers. Apply the map to WAN1.',
    hint: 'The crypto ACL must be a mirror on the other router. The course uses protocol-only lines with any any.',
    example: 'crypto isakmp policy 10\n encryption aes\n hash sha\n authentication pre-share\n group 2\ncrypto isakmp key KSS123 address 60.50.30.2\ncrypto ipsec transform-set TS esp-aes esp-sha-hmac\ncrypto map CM 10 ipsec-isakmp\n set peer 60.50.30.2\n set transform-set TS\n match address 120' },
  { id: 'g-qos', no: 11, title: 'QoS on the WAN link', feature: 'qos', devices: ['R1', 'R2'], allows: ['qos', 'acl', 'interface'],
    goal: 'Build a two-level policy: a parent shaper at 95 % with a child policy for priority, guarantee and WFQ.',
    hint: 'bandwidth 128 on both serial interfaces makes the percent values right.',
    example: 'policy-map output_QE\n class classPriority\n  priority 16\n class classGuaranteed\n  bandwidth 48\n class class-default\n  fair-queue\npolicy-map output_SE\n class class-default\n  shape average percent 95\n  service-policy output_QE' },
  { id: 'g-vty', no: 12, title: 'Telnet only from PC1', feature: 'vty', devices: ['R1', 'R2'], allows: ['vty', 'acl'],
    goal: 'Allow Telnet on all vty lines with a password, and only from PC1.',
    why: 'R2 sees PC1 as 60.50.50.100 because of the static NAT on R1.',
    example: 'ip access-list standard allowPC1\n permit 192.168.100.10\nline vty 0 4\n access-class allowPC1 in\n password cisco\n login' },
  { id: 'g-snmp', no: 13, title: 'SNMP communities', feature: 'snmp', devices: ['R1', 'R2'], allows: ['snmp', 'acl'],
    goal: 'Create a read community for PC1 and PC3, and a write community for PC1 only.',
    example: 'access-list 10 permit host 192.168.100.10\naccess-list 10 permit host 60.50.40.2\naccess-list 11 permit host 192.168.100.10\nsnmp-server community D105read RO 10\nsnmp-server community D105write RW 11' },
  { id: 'g-syslog', no: 14, title: 'Syslog to PC1', feature: 'syslog', devices: ['R1', 'R2', 'PC1'], allows: ['syslog', 'pc'],
    goal: 'Send log messages to PC1 from the Loopback0 address. Turn on the syslog server on PC1.',
    example: 'logging source-interface Loopback0\nlogging 192.168.100.10' },
  { id: 'g-verify', no: 15, title: 'Test everything', feature: 'verify', devices: ['PC1', 'PC2', 'PC3', 'R1', 'R2'], allows: ['verify'],
    goal: 'Ping, Telnet and check the tables. Then press Check.',
    example: 'show ip nat translations\nshow crypto ipsec sa\nshow policy-map interface Serial0/1/0\nshow access-lists' },
];

export const CABLING_GUIDE: GuideStep[] = CASE_GUIDE.slice(0, 2);

// ───────────────────────── traces ─────────────────────────

const traceDhcpRelayMissing: TraceStep[] = [
  { deviceId: 'PC3', stage: 'origin', feature: 'dhcp', verdict: 'info', text: 'PC3 has no address yet, so it broadcasts a DHCP Discover.', header: 'UDP 0.0.0.0:68 → 255.255.255.255:67 (DHCP Discover)' },
  { deviceId: 'PC3', stage: 'link', feature: 'cabling', verdict: 'ok', text: 'The crossover cable to R2 is up.', iface: 'Ethernet0' },
  { deviceId: 'R2', stage: 'ingress', feature: 'interface', verdict: 'ok', iface: 'GigabitEthernet0/0/0', text: 'R2 receives the broadcast on its LAN port.' },
  { deviceId: 'R2', stage: 'drop', feature: 'dhcp', verdict: 'drop', iface: 'GigabitEthernet0/0/0', text: 'R2 is not a DHCP server and has no relay on this port, so the broadcast stops here.', detail: 'interface GigabitEthernet0/0/0 — no "ip helper-address"' },
];

const traceAclOrder: TraceStep[] = [
  { deviceId: 'PC2', stage: 'origin', feature: 'pc', verdict: 'info', text: 'PC2 opens an FTP connection to PC3.', header: 'TCP 192.168.100.101:49152 → 60.50.40.2:21 SYN' },
  { deviceId: 'SW1', stage: 'switch', feature: 'switching', verdict: 'ok', text: 'SW1 forwards the frame to R1 (VLAN 1).', iface: 'GigabitEthernet1/0/24' },
  { deviceId: 'R1', stage: 'acl-in', feature: 'acl', verdict: 'ok', iface: 'GigabitEthernet0/0/0', text: 'ACL 110 inbound: the first matching line permits the packet.', detail: 'access-list 110 permit ip any any   (line 30 — before the deny for PC2)' },
  { deviceId: 'R1', stage: 'route', feature: 'routing', verdict: 'ok', text: 'Default route: out of Serial0/1/0 to 60.50.30.2.', detail: 'S* 0.0.0.0/0 [1/0] via 60.50.30.2, Serial0/1/0' },
  { deviceId: 'R1', stage: 'nat-inside', feature: 'nat', verdict: 'changed', iface: 'Serial0/1/0', text: 'PAT changes the source to the WAN address.', header: 'TCP 60.50.30.1:1024 → 60.50.40.2:21 SYN', detail: 'ip nat inside source list 1 interface Serial0/1/0 overload' },
  { deviceId: 'R1', stage: 'crypto', feature: 'ipsec', verdict: 'info', iface: 'Serial0/1/0', text: 'FTP is not in crypto ACL 120, so it leaves in clear text.' },
  { deviceId: 'R2', stage: 'route', feature: 'routing', verdict: 'ok', text: 'LAN2 is directly connected on GigabitEthernet0/0/0.' },
  { deviceId: 'PC3', stage: 'deliver', feature: 'pc', verdict: 'ok', text: 'PC3 accepts the FTP connection. Task 7 says this should have been blocked.', header: 'TCP 60.50.30.1:1024 → 60.50.40.2:21 SYN' },
];

const traceNotEncrypted: TraceStep[] = [
  { deviceId: 'R1', stage: 'origin', feature: 'verify', verdict: 'info', text: 'R1 pings R2 from Loopback0.', header: 'ICMP echo 1.1.1.1 → 2.2.2.2' },
  { deviceId: 'R1', stage: 'route', feature: 'routing', verdict: 'ok', text: 'Default route: out of Serial0/1/0.' },
  { deviceId: 'R1', stage: 'crypto', feature: 'ipsec', verdict: 'changed', iface: 'Serial0/1/0', text: 'ICMP matches crypto ACL 120. R1 tries to build a tunnel to 60.50.30.2.', detail: 'crypto map CM 10 → match address 120: permit icmp any any' },
  { deviceId: 'R2', stage: 'ingress', feature: 'ipsec', verdict: 'drop', iface: 'Serial0/1/0', text: 'R2 has no crypto map on Serial0/1/0, so it cannot answer the tunnel request. The ping fails.', detail: 'R2 interface Serial0/1/0 — no "crypto map CM"' },
];

const traceStaticNat: TraceStep[] = [
  { deviceId: 'PC3', stage: 'origin', feature: 'pc', verdict: 'info', text: 'PC3 pings the public address of PC1.', header: 'ICMP echo 60.50.40.2 → 60.50.50.100' },
  { deviceId: 'R2', stage: 'route', feature: 'routing', verdict: 'ok', text: 'Default route: out of Serial0/1/0 to R1.' },
  { deviceId: 'R1', stage: 'nat-outside', feature: 'nat', verdict: 'info', iface: 'Serial0/1/0', text: 'No static NAT rule for 60.50.50.100. The address is not translated.' },
  { deviceId: 'R1', stage: 'local', feature: 'interface', verdict: 'info', text: '60.50.50.100 is the Loopback100 address, so R1 answers itself. PC1 never sees the ping.', detail: 'interface Loopback100 — ip address 60.50.50.100 255.255.255.255' },
];

const traceSnmpWrite: TraceStep[] = [
  { deviceId: 'PC3', stage: 'origin', feature: 'snmp', verdict: 'info', text: 'PC3 sends an SNMP set with community D105write.', header: 'UDP 60.50.40.2:50000 → 60.50.30.2:161 (SNMP set)' },
  { deviceId: 'R2', stage: 'local', feature: 'snmp', verdict: 'ok', text: 'Community D105write has no ACL on R2, so anyone may write.', detail: 'snmp-server community D105write RW' },
];

// ───────────────────────── report ─────────────────────────

const REQ_RESULTS: RequirementResult[] = [
  { ...CASE_REQUIREMENTS[0], earned: 2, pass: true, checks: [
    { id: 'c-links', label: 'Every link in the topology is up', pass: true, expected: '5 links up/up', observed: '5 links up/up' },
    { id: 'c-serial-dce', label: 'Serial DCE end has a clock rate', pass: true, expected: 'clock rate 128000 on the DCE end', observed: 'R1 Serial0/1/0 (DCE): clock rate 128000' },
  ] },
  { ...CASE_REQUIREMENTS[1], earned: 1.5, pass: false, checks: [
    { id: 'c-pc2-lease', label: 'PC2 gets an address from DHCP', pass: true, expected: '192.168.100.101 or higher', observed: '192.168.100.101 from 192.168.100.1' },
    { id: 'c-excluded', label: 'The first 100 LAN1 addresses are not leased', pass: true, expected: 'no lease between .1 and .100', observed: 'excluded 192.168.100.1 – 192.168.100.100' },
    { id: 'c-pc3-lease', label: 'PC3 gets an address from DHCP', pass: false, expected: 'an address from 60.50.40.0/26 through the relay', observed: 'No answer. PC3 shows 169.254.12.7.',
      tip: 'On R2, under the LAN interface, add ip helper-address 60.50.30.1 (the R1 WAN address).', trace: traceDhcpRelayMissing },
  ] },
  { ...CASE_REQUIREMENTS[2], earned: 1, pass: true, checks: [
    { id: 'c-masks', label: 'Interface masks match the plan', pass: true, expected: 'WAN1 /30, LAN1 /24, LAN2 /26', observed: 'WAN1 /30, LAN1 /24, LAN2 /26' },
  ] },
  { ...CASE_REQUIREMENTS[3], earned: 2, pass: true, checks: [
    { id: 'c-lan-lan', label: 'PC1 pings PC3', pass: true, expected: 'reply', observed: '!!!!! (5 of 5)' },
    { id: 'c-loop-loop', label: 'R1 Loopback0 pings R2 Loopback0', pass: true, expected: 'reply', observed: '!!!!! (5 of 5)' },
  ] },
  { ...CASE_REQUIREMENTS[4], earned: 2, pass: true, checks: [
    { id: 'c-pat', label: 'PC2 → PC3 arrives from the WAN address', pass: true, expected: 'source 60.50.30.1', observed: 'source 60.50.30.1 (port 1024)' },
  ] },
  { ...CASE_REQUIREMENTS[5], earned: 0, pass: false, checks: [
    { id: 'c-static-out', label: 'PC3 → 60.50.50.100 reaches PC1', pass: false, expected: 'PC1 answers', observed: 'R1 answered itself (Loopback100). PC1 got nothing.',
      tip: 'Add ip nat inside source static 192.168.100.10 60.50.50.100 on R1.', trace: traceStaticNat },
    { id: 'c-static-in', label: 'PC1 → PC3 arrives from 60.50.50.100', pass: false, expected: 'source 60.50.50.100', observed: 'source 60.50.30.1 (PAT, not static NAT)' },
  ] },
  { ...CASE_REQUIREMENTS[6], earned: 1, pass: true, checks: [
    { id: 'c-routes', label: 'Each routing table has one extra entry', pass: true, expected: 'R1: 1 static default; R2: 1 static default', observed: 'R1: S* 0.0.0.0/0; R2: S* 0.0.0.0/0' },
    { id: 'c-noproto', label: 'No routing protocol', pass: true, expected: 'no router rip / ospf', observed: 'none' },
  ] },
  { ...CASE_REQUIREMENTS[7], earned: 1, pass: true, checks: [
    { id: 'c-pc1-lo', label: "PC1 → 2.2.2.2 is blocked", pass: true, expected: 'dropped (U)', observed: 'U — ACL 110 on R1, line 10' },
  ] },
  { ...CASE_REQUIREMENTS[8], earned: 1, pass: false, checks: [
    { id: 'c-pc2-icmp', label: 'PC2 → PC3 ping works', pass: true, expected: 'reply', observed: '!!!!!' },
    { id: 'c-pc2-http', label: 'PC2 → PC3 HTTP works', pass: true, expected: 'connection opens', observed: 'connection opens' },
    { id: 'c-pc2-ftp', label: 'PC2 → PC3 FTP is blocked', pass: false, expected: 'dropped by an ACL', observed: 'The FTP connection opened.',
      tip: 'ACL lines are read from the top. Move "permit ip any any" to the end, after the deny for PC2.', trace: traceAclOrder },
  ] },
  { ...CASE_REQUIREMENTS[9], earned: 1, pass: false, checks: [
    { id: 'c-isakmp', label: 'ISAKMP policies match', pass: true, expected: 'aes / sha / pre-share / group 2 on both', observed: 'aes / sha / pre-share / group 2 on both' },
    { id: 'c-icmp-esp', label: 'ICMP crosses WAN1 inside ESP', pass: false, expected: 'encrypted (ESP)', observed: 'The ping failed. No tunnel was built.',
      tip: 'Apply the crypto map on R2 too: interface Serial0/1/0, then crypto map CM.', trace: traceNotEncrypted },
    { id: 'c-http-clear', label: 'HTTP stays in clear text', pass: true, expected: 'not encrypted', observed: 'not encrypted' },
  ] },
  { ...CASE_REQUIREMENTS[10], earned: 2, pass: false, checks: [
    { id: 'c-bw', label: 'bandwidth 128 on both serial ports', pass: true, expected: '128 kbit/s', observed: 'R1 128, R2 128' },
    { id: 'c-shape', label: 'Shaper at 95 %', pass: true, expected: '121.6 kbit/s', observed: 'shape average percent 95 → 121.6 kbit/s' },
    { id: 'c-prio', label: 'ICMP is in the priority class', pass: false, expected: 'classPriority, priority 16', observed: 'class-default (classPriority matches ACL matchPriority, which is empty)',
      tip: 'Create the ACL: ip access-list extended matchPriority, then permit icmp any any.' },
  ] },
  { ...CASE_REQUIREMENTS[11], earned: 2, pass: true, checks: [
    { id: 'c-tel-pc1', label: 'PC1 can Telnet to R1 and R2', pass: true, expected: 'password prompt', observed: 'Password: (both)' },
    { id: 'c-tel-pc3', label: 'PC3 is refused', pass: true, expected: 'refused', observed: '% Connection refused by remote host' },
  ] },
  { ...CASE_REQUIREMENTS[12], earned: 1, pass: false, checks: [
    { id: 'c-snmp-read', label: 'PC1 and PC3 can read', pass: true, expected: 'answer', observed: 'answer from both routers' },
    { id: 'c-snmp-write', label: 'PC3 cannot write', pass: false, expected: 'no answer', observed: 'R2 accepted the write from PC3.',
      tip: 'Add the ACL number to the write community on R2: snmp-server community D105write RW 11.', trace: traceSnmpWrite },
  ] },
  { ...CASE_REQUIREMENTS[13], earned: 1, pass: true, checks: [
    { id: 'c-syslog', label: 'PC1 receives messages from 1.1.1.1 and 2.2.2.2', pass: true, expected: 'from 1.1.1.1 and 2.2.2.2', observed: 'from 1.1.1.1 and 2.2.2.2' },
  ] },
];

export const ORDER_ISSUES: OrderIssue[] = [
  { tick: 41, deviceId: 'R1', line: 'ip access-group 110 in', severity: 'info',
    text: 'You applied ACL 110 before you wrote its lines. An empty ACL lets everything through, so nothing broke. On a live network, write the ACL first and apply it last.' },
  { tick: 77, deviceId: 'R2', line: 'service-policy output output_SE', severity: 'warn',
    text: 'You applied the QoS policy before the class-maps existed. IOS refused the command the first time, and you had to type it again.' },
  { tick: 112, severity: 'info', text: 'You never saved the configuration (copy running-config startup-config). On the real routers a reload would lose your work.' },
];

export const HARDWARE_NOTES: HardwareNote[] = [
  { id: 'hn-preclassify', feature: 'qos', title: 'QoS and IPsec on the same interface',
    text: 'On the lab ISR 4331, the QoS policy may see encrypted packets as ESP. If ICMP lands in class-default, add qos pre-classify under the crypto map entry.' },
  { id: 'hn-dce', feature: 'interface', title: 'Which end is DCE?',
    text: 'Look at the serial cable connector, or type show controllers serial 0/1/0. Only that end takes clock rate 128000.' },
  { id: 'hn-vty', feature: 'vty', title: 'vty lines on the ISR 4331',
    text: 'The real router has lines vty 0 4 and 5 15 (not 5 14). Put the access-class and password on both ranges.' },
];

export function makeReport(scenarioId: string, mode: GradeReport['mode'], tick: number, requirements: RequirementView[]): GradeReport {
  const byId = new Map(REQ_RESULTS.map((r) => [r.id, r]));
  const reqs: RequirementResult[] = requirements.map((r) => byId.get(r.id) ?? { ...r, earned: r.points, pass: true, checks: [
    { id: `${r.id}-c`, label: r.title, pass: true, expected: 'works', observed: 'works' },
  ] });
  const maxPoints = reqs.reduce((s, r) => s + r.points, 0);
  const points = reqs.reduce((s, r) => s + r.earned, 0);
  return {
    scenarioId, mode, tick, maxPoints, points,
    scaled18: maxPoints ? Math.round((points / maxPoints) * 180) / 10 : 0,
    requirements: reqs,
    orderIssues: ORDER_ISSUES,
    hardwareNotes: HARDWARE_NOTES,
  };
}

// ───────────────────────── solution ─────────────────────────

const QOS_AND_CRYPTO_SHARED = `class-map match-all classPriority
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

const ACL_120_AND_QOS_ACLS = `access-list 120 permit tcp any any eq telnet
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

export const MODEL_R1 = `hostname R1
no ip domain-lookup
ip dhcp excluded-address 192.168.100.1 192.168.100.100
ip dhcp pool LAN1
 network 192.168.100.0 255.255.255.0
 default-router 192.168.100.1
ip dhcp pool LAN2
 network 60.50.40.0 255.255.255.192
 default-router 60.50.40.1
crypto isakmp policy 10
 encryption aes
 hash sha
 authentication pre-share
 group 2
crypto isakmp key KSS123 address 60.50.30.2
crypto ipsec transform-set TS esp-aes esp-sha-hmac
 mode tunnel
crypto map CM 10 ipsec-isakmp
 set peer 60.50.30.2
 set transform-set TS
 match address 120
${QOS_AND_CRYPTO_SHARED}
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
${ACL_120_AND_QOS_ACLS}
ip access-list standard allowPC1
 permit 192.168.100.10
snmp-server community D105read RO 10
snmp-server community D105write RW 11
logging source-interface Loopback0
logging 192.168.100.10
line vty 0 4
 access-class allowPC1 in
 password cisco
 login
line vty 5 14
 access-class allowPC1 in
 password cisco
 login
end`;

export const MODEL_R2 = `hostname R2
no ip domain-lookup
crypto isakmp policy 10
 encryption aes
 hash sha
 authentication pre-share
 group 2
crypto isakmp key KSS123 address 60.50.30.1
crypto ipsec transform-set TS esp-aes esp-sha-hmac
 mode tunnel
crypto map CM 10 ipsec-isakmp
 set peer 60.50.30.1
 set transform-set TS
 match address 120
${QOS_AND_CRYPTO_SHARED}
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
${ACL_120_AND_QOS_ACLS}
ip access-list standard allowPC1
 permit 60.50.50.100
snmp-server community D105read RO 10
snmp-server community D105write RW 11
logging source-interface Loopback0
logging 60.50.50.100
line vty 0 4
 access-class allowPC1 in
 password cisco
 login
line vty 5 14
 access-class allowPC1 in
 password cisco
 login
end`;

/** A realistic, partly wrong running-config for R1 (what `show running-config` would print). */
export const STUDENT_R1 = `Building configuration...

Current configuration : 4127 bytes
!
! Last configuration change at 10:42:17 UTC Tue Jun 10 2026
!
version 17.3
service timestamps debug datetime msec
service timestamps log datetime msec
platform qfp utilization monitor load 80
no platform punt-keepalive disable-kernel-core
!
hostname R1
!
boot-start-marker
boot-end-marker
!
no aaa new-model
!
no ip domain lookup
!
ip dhcp excluded-address 192.168.100.1 192.168.100.100
!
ip dhcp pool LAN1
 network 192.168.100.0 255.255.255.0
 default-router 192.168.100.1
!
ip dhcp pool LAN2
 network 60.50.40.0 255.255.255.192
 default-router 60.50.40.1
!
login on-success log
!
license udi pid ISR4331/K9 sn FDO21520T1K
!
crypto isakmp policy 10
 encryption aes
 hash sha
 authentication pre-share
 group 2
crypto isakmp key KSS123 address 60.50.30.2
!
crypto ipsec transform-set TS esp-aes esp-sha-hmac
 mode tunnel
!
crypto map CM 10 ipsec-isakmp
 set peer 60.50.30.2
 set transform-set TS
 match address 120
!
class-map match-all classPriority
 match access-group name matchPriority
class-map match-all classGuaranteed
 match access-group name matchGuaranteed
!
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
  service-policy output_QE
!
interface Loopback0
 ip address 1.1.1.1 255.255.255.255
!
interface Loopback100
 ip address 60.50.50.100 255.255.255.255
!
interface GigabitEthernet0/0/0
 ip address 192.168.100.1 255.255.255.0
 ip access-group 110 in
 ip nat inside
 negotiation auto
!
interface GigabitEthernet0/0/1
 no ip address
 shutdown
 negotiation auto
!
interface GigabitEthernet0/0/2
 no ip address
 shutdown
 negotiation auto
!
interface Serial0/1/0
 bandwidth 128
 ip address 60.50.30.1 255.255.255.252
 ip nat outside
 crypto map CM
 service-policy output output_SE
 clock rate 128000
!
interface Serial0/1/1
 no ip address
 shutdown
!
ip forward-protocol nd
no ip http server
no ip http secure-server
ip nat inside source list 1 interface Serial0/1/0 overload
ip route 0.0.0.0 0.0.0.0 Serial0/1/0 60.50.30.2
!
ip access-list standard allowPC1
 10 permit 192.168.100.10
ip access-list extended matchGuaranteed
 10 permit tcp any any eq telnet
 20 permit tcp any eq telnet any
 30 permit tcp any any eq 22
 40 permit tcp any eq 22 any
 50 permit udp any any eq snmp
 60 permit udp any eq snmp any
 70 permit udp any any eq snmptrap
 80 permit udp any eq snmptrap any
!
access-list 1 permit 192.168.100.0 0.0.0.255
access-list 10 permit 192.168.100.10
access-list 10 permit 60.50.40.2
access-list 11 permit 192.168.100.10
access-list 110 deny   ip host 192.168.100.10 host 2.2.2.2
access-list 110 permit icmp host 192.168.100.101 60.50.40.0 0.0.0.63
access-list 110 permit ip any any
access-list 110 permit tcp host 192.168.100.101 60.50.40.0 0.0.0.63 eq www
access-list 110 deny   ip host 192.168.100.101 60.50.40.0 0.0.0.63
access-list 120 permit tcp any any eq telnet
access-list 120 permit tcp any eq telnet any
access-list 120 permit tcp any any eq 22
access-list 120 permit tcp any eq 22 any
access-list 120 permit icmp any any
access-list 120 permit udp any any eq snmp
access-list 120 permit udp any eq snmp any
access-list 120 permit udp any any eq snmptrap
access-list 120 permit udp any eq snmptrap any
!
logging source-interface Loopback0
logging host 192.168.100.10
snmp-server community D105read RO 10
snmp-server community D105write RW 11
!
control-plane
!
line con 0
 transport input none
 stopbits 1
line aux 0
 stopbits 1
line vty 0 4
 access-class allowPC1 in
 password cisco
 login
line vty 5 14
 access-class allowPC1 in
 password cisco
 login
!
end`;

export const SOLUTION: SolutionView = {
  cables: [
    { kind: 'straight', a: { deviceId: 'PC1', port: 'Ethernet0' }, b: { deviceId: 'SW1', port: 'GigabitEthernet1/0/1' } },
    { kind: 'straight', a: { deviceId: 'PC2', port: 'Ethernet0' }, b: { deviceId: 'SW1', port: 'GigabitEthernet1/0/2' } },
    { kind: 'straight', a: { deviceId: 'SW1', port: 'GigabitEthernet1/0/24' }, b: { deviceId: 'R1', port: 'GigabitEthernet0/0/0' } },
    { kind: 'serial', a: { deviceId: 'R1', port: 'Serial0/1/0' }, b: { deviceId: 'R2', port: 'Serial0/1/0' }, dceEnd: 'a', note: 'DCE end on R1: it supplies the clock (clock rate 128000).' },
    { kind: 'crossover', a: { deviceId: 'R2', port: 'GigabitEthernet0/0/0' }, b: { deviceId: 'PC3', port: 'Ethernet0' }, note: 'Router to PC directly: crossover.' },
    { kind: 'console', a: { deviceId: 'PC1', port: 'COM1' }, b: { deviceId: 'R1', port: 'Console' }, note: 'Move it to each device while you configure it.' },
  ],
  configs: { R1: MODEL_R1, R2: MODEL_R2 },
  pcs: {
    PC1: { mode: 'static', address: '192.168.100.10', mask: '255.255.255.0', gateway: '192.168.100.1', services: { syslog: true } },
    PC2: { mode: 'dhcp' },
    PC3: { mode: 'dhcp', services: { http: true, ftp: true } },
  },
  notes: [
    'R1 is the DHCP server. With NAT on R1, R2 could not tell LAN1 hosts apart, so the server belongs on R1.',
    'From R2 the PC1 address is 60.50.50.100 (static NAT). R2 uses that address in its ACLs and logging.',
    'SW2 stays unused. The switch needs no configuration.',
  ],
};

// ───────────────────────── command sheet ─────────────────────────

export const COMMAND_SHEET: CommandSheetSection[] = [
  { id: 'basics', title: 'Basic router setup', feature: 'system', lines: [
    { text: 'enable' },
    { text: 'configure terminal' },
    { text: 'hostname name' },
    { text: 'no ip domain-lookup', note: 'Stops the long wait after a typo.' },
    { text: 'banner motd #message#' },
    { text: 'line con 0' },
    { text: ' logging synchronous', note: 'Log messages no longer break the line you are typing.' },
    { text: 'end' },
    { text: 'copy running-config startup-config', note: 'Saves your work. Do this before you finish.' },
  ] },
  { id: 'interfaces', title: 'Interfaces', feature: 'interface', lines: [
    { text: 'interface GigabitEthernet0/0/0' },
    { text: ' ip address ip-address subnet-mask' },
    { text: ' description text' },
    { text: ' no shutdown', note: 'Router ports start shut down.' },
    { text: 'interface Serial0/1/0' },
    { text: ' clock rate 128000', note: 'Only on the DCE end of the serial cable.', warn: 'On the DTE end IOS says: This command applies only to DCE interfaces.' },
    { text: ' bandwidth 128', note: 'In kbit/s. QoS percent values are based on it.' },
    { text: 'interface Loopback0' },
  ] },
  { id: 'routing', title: 'Routing', feature: 'routing', lines: [
    { text: 'ip route 0.0.0.0 0.0.0.0 next-hop-ip', note: 'Default route.' },
    { text: 'ip route 0.0.0.0 0.0.0.0 Serial0/1/0 60.50.30.2', note: 'Exit interface and next hop, like the course solution.' },
    { text: 'ip route network mask next-hop-ip' },
    { text: 'router rip' },
    { text: ' network network-address' },
    { text: 'router ospf process-id' },
    { text: ' network address wildcard area area-number' },
  ] },
  { id: 'verify', title: 'Check and verify', feature: 'verify', lines: [
    { text: 'show ip interface brief' },
    { text: 'show ip route' },
    { text: 'show running-config' },
    { text: 'show controllers serial 0/1/0', note: 'Tells you if this end is DCE or DTE.' },
    { text: 'ping ip-address' },
    { text: 'ping 2.2.2.2 source Loopback0' },
    { text: 'traceroute ip-address' },
    { text: 'show access-lists', note: 'Shows match counters per line.' },
    { text: 'show ip nat translations' },
    { text: 'show crypto isakmp sa' },
    { text: 'show crypto ipsec sa', note: 'Look at #pkts encaps and decaps.' },
    { text: 'show policy-map interface Serial0/1/0' },
  ] },
  { id: 'acl', title: 'Access lists (ACL)', feature: 'acl', lines: [
    { text: 'access-list 1-99 permit|deny source wildcard', note: 'Standard ACL: checks the source only.' },
    { text: 'access-list 100-199 permit|deny protocol source wildcard [port] destination wildcard [port]', note: 'Extended ACL.' },
    { text: 'access-list 110 permit tcp host 192.168.100.101 60.50.40.0 0.0.0.63 eq www' },
    { text: 'ip access-list extended name' },
    { text: 'interface GigabitEthernet0/0/0' },
    { text: ' ip access-group 110 in' },
    { text: 'no ip unreachables' },
    { text: 'no access-list 110', warn: 'Deletes the whole ACL, not one line.' },
    { text: 'operators: eq, neq, lt, gt, range', note: 'eq = equal, neq = not equal, lt = lower than, gt = greater than.' },
  ] },
  { id: 'nat', title: 'NAT and PAT', feature: 'nat', lines: [
    { text: 'ip nat inside source static local-ip global-ip' },
    { text: 'ip nat pool name start-ip end-ip netmask mask' },
    { text: 'access-list 1 permit 192.168.100.0 0.0.0.255' },
    { text: 'ip nat inside source list 1 pool name overload' },
    { text: 'ip nat inside source list 1 interface Serial0/1/0 overload', note: 'PAT on the WAN address.' },
    { text: ' ip nat inside', note: 'On the LAN interface.' },
    { text: ' ip nat outside', note: 'On the WAN interface.' },
    { text: 'clear ip nat translation *' },
  ] },
  { id: 'ipsec', title: 'IPsec', feature: 'ipsec', lines: [
    { text: 'crypto isakmp policy 10' },
    { text: ' encryption aes' },
    { text: ' hash sha' },
    { text: ' authentication pre-share' },
    { text: ' group 2' },
    { text: 'crypto isakmp key key-value address peer-ip' },
    { text: 'crypto ipsec transform-set TS esp-aes esp-sha-hmac' },
    { text: ' mode tunnel' },
    { text: 'crypto map CM 10 ipsec-isakmp' },
    { text: ' match address 120' },
    { text: ' set peer peer-ip' },
    { text: ' set transform-set TS' },
    { text: 'interface Serial0/1/0' },
    { text: ' crypto map CM', note: 'Needed on both routers.' },
    { text: 'access-list 120 …', warn: 'The crypto ACL must be a mirror image on the other router.' },
    { text: 'clear crypto sa' },
  ] },
  { id: 'qos', title: 'QoS', feature: 'qos', lines: [
    { text: 'class-map match-all name' },
    { text: ' match access-group name acl-name' },
    { text: 'policy-map name' },
    { text: ' class class-name' },
    { text: '  priority 16', note: 'Priority queue in kbit/s.' },
    { text: '  bandwidth 48', note: 'Guaranteed minimum in kbit/s.' },
    { text: ' class class-default' },
    { text: '  fair-queue' },
    { text: '  shape average percent 95' },
    { text: '  service-policy child-policy', note: 'Nested policy inside the shaper.' },
    { text: 'interface Serial0/1/0' },
    { text: ' service-policy output name' },
    { text: 'priority-list / queue-list / custom-queue-list', warn: 'Old queueing commands from the sheet. They do not exist on IOS XE (ISR 4331). Use class-map and policy-map.' },
  ] },
  { id: 'dhcp', title: 'DHCP', feature: 'dhcp', lines: [
    { text: 'ip dhcp excluded-address low-address high-address' },
    { text: 'ip dhcp pool name' },
    { text: ' network network-address mask' },
    { text: ' default-router ip-address' },
    { text: 'interface GigabitEthernet0/0/0' },
    { text: ' ip helper-address server-ip', note: 'Relay: on the interface that hears the PCs.' },
    { text: 'show ip dhcp binding' },
  ] },
  { id: 'mgmt', title: 'Management: Telnet, SNMP, syslog', feature: 'vty', lines: [
    { text: 'line vty 0 4' },
    { text: ' password cisco' },
    { text: ' login' },
    { text: ' access-class allowPC1 in', note: 'Who may log in.' },
    { text: 'line vty 5 14', warn: 'Configure the second range too, or Telnet may get in through it.' },
    { text: 'snmp-server community name ro|rw acl-number' },
    { text: 'snmp-server host host-ip community' },
    { text: 'logging ip-address' },
    { text: 'logging source-interface Loopback0' },
    { text: 'logging trap informational' },
    { text: 'alias exec shortcut command' },
  ] },
];

// ───────────────────────── journal ─────────────────────────

export const JOURNAL: JournalEntry[] = [
  { tick: 1, deviceId: 'PC1', via: 'bench', line: 'Cable straight-through: PC1 Ethernet0 ↔ SW1 GigabitEthernet1/0/1', feature: 'cabling', ok: true, mutated: true },
  { tick: 2, deviceId: 'PC2', via: 'bench', line: 'Cable straight-through: PC2 Ethernet0 ↔ SW1 GigabitEthernet1/0/2', feature: 'cabling', ok: true, mutated: true },
  { tick: 3, deviceId: 'SW1', via: 'bench', line: 'Cable crossover: SW1 GigabitEthernet1/0/24 ↔ R1 GigabitEthernet0/0/0', feature: 'cabling', ok: true, mutated: true },
  { tick: 4, deviceId: 'SW1', via: 'bench', line: 'Cable removed: SW1 GigabitEthernet1/0/24 ↔ R1 GigabitEthernet0/0/0', feature: 'cabling', ok: true, mutated: true },
  { tick: 5, deviceId: 'SW1', via: 'bench', line: 'Cable straight-through: SW1 GigabitEthernet1/0/24 ↔ R1 GigabitEthernet0/0/0', feature: 'cabling', ok: true, mutated: true },
  { tick: 6, deviceId: 'R1', via: 'bench', line: 'Cable serial: R1 Serial0/1/0 (DCE) ↔ R2 Serial0/1/0', feature: 'cabling', ok: true, mutated: true },
  { tick: 7, deviceId: 'R1', via: 'bench', line: 'Cable console: PC1 COM1 ↔ R1 Console', feature: 'console', ok: true, mutated: true },
  { tick: 8, deviceId: 'R1', via: 'console', mode: 'exec', line: 'enable', feature: 'system', ok: true, mutated: false },
  { tick: 9, deviceId: 'R1', via: 'console', mode: 'priv', line: 'configure terminal', feature: 'system', ok: true, mutated: false },
  { tick: 10, deviceId: 'R1', via: 'console', mode: 'config', line: 'hostname R1', feature: 'system', ok: true, mutated: true },
  { tick: 11, deviceId: 'R1', via: 'console', mode: 'config', line: 'no ip domain-lookup', feature: 'system', ok: true, mutated: true },
  { tick: 12, deviceId: 'R1', via: 'console', mode: 'config', line: 'ip dhcp pool LAN1', feature: 'dhcp', ok: false, mutated: false, blocked: true, stepId: 'g-dhcp' },
  { tick: 13, deviceId: 'R1', via: 'console', mode: 'config', line: 'interface GigabitEthernet0/0/0', feature: 'interface', ok: true, mutated: false },
  { tick: 14, deviceId: 'R1', via: 'console', mode: 'config-if', line: 'ip address 192.168.100.1 255.255.255.0', feature: 'interface', ok: true, mutated: true },
  { tick: 15, deviceId: 'R1', via: 'console', mode: 'config-if', line: 'no shutdown', feature: 'interface', ok: true, mutated: true },
  { tick: 16, deviceId: 'R1', via: 'console', mode: 'config-if', line: 'interface Serial0/1/0', feature: 'interface', ok: true, mutated: false },
  { tick: 17, deviceId: 'R1', via: 'console', mode: 'config-if', line: 'ip address 60.50.30.1 255.255.255.252', feature: 'interface', ok: true, mutated: true },
  { tick: 18, deviceId: 'R1', via: 'console', mode: 'config-if', line: 'clock rate 128000', feature: 'interface', ok: true, mutated: true },
  { tick: 19, deviceId: 'R1', via: 'console', mode: 'config-if', line: 'ip adress 1.1.1.1 255.255.255.255', feature: 'interface', ok: false, mutated: false },
  { tick: 20, deviceId: 'R2', via: 'file', line: 'interface Serial0/1/0', feature: 'interface', ok: true, mutated: false },
  { tick: 21, deviceId: 'R2', via: 'file', line: ' clock rate 128000', feature: 'interface', ok: false, mutated: false },
  { tick: 22, deviceId: 'R2', via: 'file', line: ' ip address 60.50.30.2 255.255.255.252', feature: 'interface', ok: true, mutated: true },
  { tick: 23, deviceId: 'PC1', via: 'pc', line: 'NIC static 192.168.100.10 255.255.255.0 gateway 192.168.100.1', feature: 'pc', ok: true, mutated: true },
  { tick: 24, deviceId: 'PC1', via: 'pc', line: 'ping 192.168.100.1', feature: 'verify', ok: true, mutated: false },
  { tick: 25, deviceId: 'R2', via: 'vty', mode: 'exec', line: 'show ip interface brief', feature: 'verify', ok: true, mutated: false },
];
