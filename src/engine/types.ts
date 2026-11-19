/**
 * KSS NetLab — shared engine contracts.
 *
 * RULES
 * - Everything reachable from `World` is plain JSON data (no classes, Map/Set, Date, functions),
 *   so a world can be deep-cloned with structuredClone() and saved as JSON.
 * - Erasable TypeScript only (no enum, namespace, parameter properties) so files run under `node file.ts`.
 * - Relative imports carry the `.ts` extension.
 * - This file is owned by the orchestrator. Do not edit it; put module-private types in your own files
 *   and report contract gaps in your final report.
 */

// ───────────────────────────── Features ─────────────────────────────
/** Topic a command/step/check belongs to. Drives colours, guided-mode gating and report grouping. */
export type Feature =
  | 'cabling' | 'console' | 'system' | 'interface' | 'routing' | 'dhcp' | 'acl' | 'nat'
  | 'ipsec' | 'qos' | 'vty' | 'snmp' | 'syslog' | 'switching' | 'pc' | 'verify';

// ───────────────────────────── Physical ─────────────────────────────
export type DeviceKind = 'router' | 'switch' | 'pc';
export type DeviceModel = 'isr4331' | 'c9300l' | 'pc-windows' | 'pc-macos';
/** ethernet = network Ethernet (copper, SFP or shared); serial = WAN Smart Serial (NIM-2T); console = RJ-45 console; rs232 = PC serial/USB-serial. */
export type PortKind = 'ethernet' | 'serial' | 'console' | 'rs232';
/** straight = Ethernet straight-through; crossover = Ethernet crossover; serial = DCE/DTE serial; console = rollover. */
export type CableKind = 'straight' | 'crossover' | 'serial' | 'console';

export interface PortSpec {
  /** Canonical IOS name, e.g. 'GigabitEthernet0/0/0', 'Serial0/1/0', 'Console', 'Ethernet0', 'COM1'. */
  name: string;
  /** Short label for the canvas, e.g. 'Gi0/0/0', 'Se0/1/0', 'CON', 'Eth0', 'COM1'. */
  short: string;
  kind: PortKind;
  /** Ethernet connector bank. Omitted for a native RJ-45 jack. A combo is one IOS interface with two connectors. */
  media?: 'combo' | 'sfp';
}
export interface PortRef { deviceId: string; port: string }
export interface Cable {
  id: string;
  kind: CableKind;
  a: PortRef;
  b: PortRef;
  /** Serial cables only: which end carries the DCE connector (that end must supply the clock). */
  dceEnd?: 'a' | 'b';
}

export interface WorldSettings {
  /** true: wrong Ethernet cable type (straight vs crossover) keeps the link down. false: auto-MDIX, either works. */
  strictCables: boolean;
  /** true (default, follows the course's reference solution): the WAN QoS policy classifies on the original
   *  packet even when it is IPsec-protected. false: classification sees ESP unless `qos pre-classify` is set. */
  qosClassifiesInnerHeader: boolean;
}

export interface World {
  schema: 1;
  devices: Record<string, Device>;
  /** Stable device ordering for UI and output. */
  order: string[];
  cables: Cable[];
  settings: WorldSettings;
  /** Logical clock. Incremented by the engine on every executed command / action. */
  tick: number;
  /** Monotonic counter for generated ids (cables, translations, SAs…). */
  nextId: number;
}

interface DeviceBase {
  id: string;
  kind: DeviceKind;
  model: DeviceModel;
  /** Sticker on the device, e.g. 'R1', 'SW1', 'PC1'. Not the IOS hostname. */
  label: string;
  x: number;
  y: number;
  ports: PortSpec[];
}
export type NetworkLicense = 'network-advantage' | 'network-essentials';

export interface IosDevice extends DeviceBase {
  kind: 'router' | 'switch';
  /** Catalyst bench entitlement, not running configuration. Optional for older schema-1 labs. */
  networkLicense?: NetworkLicense;
  config: IosConfig;
  /** Text of the saved startup-config; null = factory fresh (nothing saved). */
  startupConfig: string | null;
  runtime: IosRuntime;
}
export interface PcDevice extends DeviceBase {
  kind: 'pc';
  os: 'windows' | 'macos';
  nic: PcNic;
  services: PcServices;
  runtime: PcRuntime;
}
export type Device = IosDevice | PcDevice;

// ───────────────────────────── IOS configuration ─────────────────────────────
export interface IpMask { address: string; mask: string }

export interface InterfaceConfig {
  /** Canonical name: 'GigabitEthernet0/0/0', 'Serial0/1/0', 'Loopback0', 'Vlan1'. Same as its key in IosConfig.interfaces. */
  name: string;
  description?: string;
  ip?: IpMask;
  secondary?: IpMask[];
  /** Router physical ports and switch Vlan1 start shut down; switch ports and loopbacks start up. */
  shutdown: boolean;
  /** `bandwidth <kbit/s>` (informational; used by QoS percent calculations). */
  bandwidthKbps?: number;
  /** `clock rate <bit/s>` — only valid on the DCE end of a serial cable. */
  clockRate?: number;
  encapsulation?: 'hdlc' | 'ppp';
  /** `ip access-group <acl> in|out` */
  aclIn?: string;
  aclOut?: string;
  natRole?: 'inside' | 'outside';
  helperAddresses?: string[];
  /** `crypto map <name>` */
  cryptoMap?: string;
  /** `service-policy output|input <policy-map>` */
  servicePolicyOut?: string;
  servicePolicyIn?: string;
  /** `no ip unreachables` */
  noIpUnreachables?: boolean;
  duplex?: string;
  speed?: string;
  /** Switch ports only. */
  switchport?: { mode: 'access' | 'trunk' | 'dynamic'; accessVlan: number };
  /** Accepted-but-not-simulated interface commands, kept verbatim for show running-config. */
  extraLines?: string[];
}

export interface StaticRoute {
  prefix: string;
  mask: string;
  nextHop?: string;
  exitInterface?: string;
  distance?: number;
}
export interface RipConfig { version?: 1 | 2; networks: string[]; autoSummary: boolean; passive: string[]; defaultOriginate?: boolean }
export interface OspfConfig {
  processId: number;
  routerId?: string;
  networks: { address: string; wildcard: string; area: string }[];
  passive: string[];
  defaultOriginate?: boolean;
}

export interface DhcpPool {
  name: string;
  network?: IpMask;
  defaultRouters: string[];
  dnsServers: string[];
  domainName?: string;
  /** e.g. '1' (days) or 'infinite'; undefined = default. */
  lease?: string;
  extraLines?: string[];
}
export interface DhcpConfig {
  excluded: { low: string; high: string }[];
  pools: DhcpPool[];
}

export type AddrMatch =
  | { kind: 'any' }
  | { kind: 'host'; address: string }
  | { kind: 'net'; address: string; wildcard: string };
export interface PortMatch { op: 'eq' | 'neq' | 'lt' | 'gt' | 'range'; ports: number[] }
export type AclProtocol = 'ip' | 'tcp' | 'udp' | 'icmp' | 'esp' | 'ahp' | 'gre' | 'ospf' | 'eigrp' | number;
export interface Ace {
  /** Sequence number (10, 20, …). */
  seq: number;
  action: 'permit' | 'deny' | 'remark';
  /** remark text when action === 'remark'. */
  remark?: string;
  /** Standard ACLs always use 'ip'. */
  protocol: AclProtocol;
  src: AddrMatch;
  srcPort?: PortMatch;
  /** Standard ACLs: { kind: 'any' }. */
  dst: AddrMatch;
  dstPort?: PortMatch;
  /** ICMP type keyword or number, e.g. 'echo', 'echo-reply', 'unreachable', 'time-exceeded', 8. */
  icmpType?: string | number;
  established?: boolean;
  log?: boolean;
}
export interface Acl {
  /** '10', '110' or a name such as 'allowPC1'. Same as its key in IosConfig.acls. */
  id: string;
  type: 'standard' | 'extended';
  /** true when created with `ip access-list standard|extended …` (rendered in named form). */
  named: boolean;
  entries: Ace[];
}

export interface NatPool { name: string; start: string; end: string; mask: string; rotary?: boolean }
export interface NatStaticRule {
  local: string;
  /** Global address; omitted when `interface` is used. */
  global?: string;
  proto?: 'tcp' | 'udp';
  localPort?: number;
  globalPort?: number;
  /** `ip nat inside source static tcp … interface <if> <port>` */
  interface?: string;
  extendable?: boolean;
}
export interface NatDynamicRule {
  acl: string;
  pool?: string;
  interface?: string;
  overload: boolean;
}
export interface NatConfig {
  pools: NatPool[];
  staticRules: NatStaticRule[];
  dynamicRules: NatDynamicRule[];
  /** `ip nat inside destination list <acl> pool <pool>` (TCP load distribution). */
  insideDestinationRules: { acl: string; pool: string }[];
}

export interface IsakmpPolicy {
  priority: number;
  /** 'des' | '3des' | 'aes' | 'aes 192' | 'aes 256' */
  encryption: string;
  /** 'sha' | 'md5' | 'sha256' | 'sha384' | 'sha512' */
  hash: string;
  authentication: 'pre-share' | 'rsa-sig' | 'rsa-encr';
  group: number;
  lifetime: number;
}
export interface CryptoMapEntry {
  seq: number;
  type: 'ipsec-isakmp';
  matchAcl?: string;
  peers: string[];
  transformSets: string[];
  pfsGroup?: number;
  saLifetimeSeconds?: number;
  saLifetimeKilobytes?: number;
  qosPreClassify?: boolean;
  description?: string;
}
export interface CryptoConfig {
  /** false after `no crypto isakmp enable`. */
  isakmpEnabled: boolean;
  isakmpPolicies: IsakmpPolicy[];
  isakmpKeys: { key: string; address: string; mask?: string }[];
  transformSets: { name: string; transforms: string[]; mode: 'tunnel' | 'transport' }[];
  maps: { name: string; entries: CryptoMapEntry[] }[];
}

export type ClassMatch =
  | { kind: 'access-group'; acl: string }
  | { kind: 'protocol'; protocol: string }
  | { kind: 'dscp'; values: string[] }
  | { kind: 'precedence'; values: string[] }
  | { kind: 'any' };
export interface ClassMap { name: string; matchType: 'match-all' | 'match-any'; matches: ClassMatch[]; description?: string }
export interface PolicyClass {
  /** Class-map name or 'class-default'. */
  className: string;
  priority?: { kbps?: number; percent?: number; burstBytes?: number };
  bandwidth?: { kbps?: number; percent?: number; remainingPercent?: number };
  fairQueue?: boolean;
  shapeAverage?: { bps?: number; percent?: number };
  police?: { bps: number };
  queueLimit?: number;
  /** Nested (child) policy-map: `service-policy <name>` inside a class. */
  servicePolicy?: string;
  setDscp?: string;
  extraLines?: string[];
}
export interface PolicyMap { name: string; classes: PolicyClass[]; description?: string }
export interface QosConfig { classMaps: ClassMap[]; policyMaps: PolicyMap[] }

export type ModeledSnmpTrap = 'config' | 'snmp linkdown' | 'snmp linkup';
export interface SnmpHost {
  address: string;
  /** Community for v1/v2c, user name for v3. */
  community: string;
  version?: '1' | '2c' | '3';
  securityLevel?: 'auth' | 'noauth' | 'priv';
  type: 'traps' | 'informs';
  /** Notification families on the host line; no list means all enabled families. */
  notificationTypes?: string[];
}
export interface SnmpConfig {
  communities: { name: string; access: 'ro' | 'rw'; acl?: string; view?: string }[];
  location?: string;
  contact?: string;
  hosts: SnmpHost[];
  /** Trap selectors enabled with `snmp-server enable traps [type [options]]`; 'all' means no type was given. */
  enableTraps: string[];
  /** Explicit exclusions still covered by a broader selector, e.g. all except linkDown. */
  disableTraps?: ModeledSnmpTrap[];
  trapSource?: string;
  views: { name: string; oid: string; included: boolean }[];
  extraLines?: string[];
}
export interface LoggingConfig {
  /** `logging <ip>` / `logging host <ip>` */
  hosts: string[];
  sourceInterface?: string;
  /** `logging trap <level>`; undefined = informational. */
  trapLevel?: string;
  extraLines?: string[];
}

export interface LineConfig {
  password?: string;
  /** false = `no login`; true = `login`; 'local' = `login local`. */
  login: boolean | 'local';
  loggingSynchronous?: boolean;
  execTimeout?: [number, number];
  accessClassIn?: string;
  accessClassOut?: string;
  /** undefined = default transport configuration. Telnet is modeled; TCP 22 is a path probe without an SSH server. */
  transportInput?: 'all' | 'none' | 'telnet' | 'ssh' | 'telnet ssh';
  extraLines?: string[];
}
export interface VtyRange extends LineConfig { first: number; last: number }

export interface IosConfig {
  hostname: string;
  enableSecret?: string;
  enablePassword?: string;
  servicePasswordEncryption: boolean;
  /** default true: a mistyped word in EXEC mode triggers a DNS lookup delay. */
  ipDomainLookup: boolean;
  /** routers: true; switches: false. */
  ipRouting: boolean;
  bannerMotd?: string;
  users: { name: string; privilege?: number; secret: string }[];
  aliases: { mode: 'exec' | 'configure' | 'interface'; name: string; command: string }[];
  interfaces: Record<string, InterfaceConfig>;
  staticRoutes: StaticRoute[];
  rip?: RipConfig;
  ospf: OspfConfig[];
  dhcp: DhcpConfig;
  acls: Record<string, Acl>;
  nat: NatConfig;
  crypto: CryptoConfig;
  qos: QosConfig;
  snmp: SnmpConfig;
  logging: LoggingConfig;
  lines: { console: LineConfig; vty: VtyRange[] };
  /** Switches. */
  vlans: Record<string, { name: string }>;
  defaultGateway?: string;
  /** Accepted-but-not-simulated global commands, kept verbatim for show running-config. */
  extraLines: string[];
}

// ───────────────────────────── IOS runtime state ─────────────────────────────
export interface NatTranslation {
  id: number;
  proto: 'icmp' | 'tcp' | 'udp';
  insideLocal: string;
  insideLocalPort: number;
  insideGlobal: string;
  insideGlobalPort: number;
  outsideLocal: string;
  outsideLocalPort: number;
  outsideGlobal: string;
  outsideGlobalPort: number;
  /** true when created from a static rule (a session entry on top of the static mapping). */
  fromStatic?: boolean;
  /** Catalyst dynamic selector and original request flags for revalidating live entries after config edits. */
  mappingAcl?: string;
  tcpSyn?: boolean;
  icmpType?: Packet['icmpType'];
  createdTick: number;
}
/** IPsec traffic selector ("proxy identity"): address/mask/protocol/port, port 0 and protocol 0 = any. */
export interface Selector { address: string; mask: string; protocol: number; port: number }
export interface IkeSa { id: number; local: string; remote: string; state: 'QM_IDLE' | 'MM_NO_STATE'; createdTick: number }
export interface IpsecSa {
  id: number;
  iface: string;
  mapName: string;
  seq: number;
  localEndpoint: string;
  remoteEndpoint: string;
  localIdent: Selector;
  remoteIdent: Selector;
  transform: string;
  mode: 'tunnel' | 'transport';
  spiIn: number;
  spiOut: number;
  encaps: number;
  decaps: number;
  createdTick: number;
}
export interface DhcpBinding { address: string; clientId: string; pool: string; grantedTick: number }
export interface LogMessage { tick: number; severity: number; mnemonic: string; text: string }
/** Outcomes observed by the model, not acknowledgements available to the IOS sender. */
export interface NotificationCounter { attempts: number; collected: number }

export interface IosRuntime {
  /** false until the user has answered the initial configuration dialog on a factory-fresh device. */
  setupDialogDone: boolean;
  natTranslations: NatTranslation[];
  natHits: number;
  natMisses: number;
  /** Match counters, key `${aclId}:${seq}`. */
  aclHits: Record<string, number>;
  dhcpBindings: DhcpBinding[];
  ikeSas: IkeSa[];
  ipsecSas: IpsecSa[];
  /** Packet counters, key `${ifName}|${dir}|${policyMap}|${className}` (child classes: `${parentPolicy}/${childPolicy}`). */
  qosCounters: Record<string, { packets: number; bytes: number }>;
  /** Interface packet counters, key = interface name. */
  ifCounters: Record<string, { in: number; out: number }>;
  logBuffer: LogMessage[];
  notificationCounters?: Partial<Record<'syslog' | 'snmp', Record<string, NotificationCounter>>>;
  /** Count of established vty sessions (for `show users`). */
  vtyInUse: number;
}

// ───────────────────────────── PC ─────────────────────────────
export interface PcNic {
  mode: 'static' | 'dhcp';
  mac: string;
  /** Static settings (mode 'static') or the current lease (mode 'dhcp'). Empty when unconfigured / no lease. */
  address?: string;
  mask?: string;
  gateway?: string;
  dns?: string;
  /** DHCP server that granted the lease. */
  dhcpServer?: string;
}
export interface PcServices { http: boolean; ftp: boolean; telnet: boolean; syslog: boolean }
export interface SyslogRecord { tick: number; from: string; severity: number; mnemonic: string; text: string }
export interface SnmpTrapRecord { tick: number; from: string; community: string; text: string }
export interface PcRuntime { syslog: SyslogRecord[]; traps: SnmpTrapRecord[] }

// ───────────────────────────── Packets, probes, traces ─────────────────────────────
export type L4 = 'icmp' | 'tcp' | 'udp' | 'esp' | 'other';
export type AppData =
  | { kind: 'syslog'; severity: number; mnemonic: string; text: string }
  | { kind: 'snmp'; op: 'get' | 'set' | 'response' | 'trap'; community: string; oid?: string; value?: string; error?: string }
  | { kind: 'dhcp'; op: 'discover' | 'offer' | 'request' | 'ack'; clientId: string; giaddr?: string; yiaddr?: string; mask?: string; gateway?: string; dns?: string; server?: string }
  | { kind: 'ike' }
  | { kind: 'generic'; label: string };
export interface Packet {
  src: string;
  dst: string;
  proto: L4;
  sport?: number;
  dport?: number;
  icmpType?: 'echo' | 'echo-reply' | 'unreachable' | 'admin-prohibited' | 'time-exceeded';
  /** TCP: true for the first packet of a connection, false for packets of an established flow. */
  tcpSyn?: boolean;
  ttl: number;
  bytes: number;
  app?: AppData;
  /** ESP only: the protected original packet and SPI. */
  inner?: Packet;
  spi?: number;
}

export type TraceStage =
  | 'origin' | 'link' | 'switch' | 'ingress' | 'acl-in' | 'decrypt' | 'nat-outside' | 'local' | 'route'
  | 'nat-inside' | 'crypto' | 'acl-out' | 'qos' | 'egress' | 'deliver' | 'drop';
export interface TraceStep {
  deviceId: string;
  stage: TraceStage;
  feature: Feature;
  /** One plain sentence: what happened and why. */
  text: string;
  /** Optional evidence: the config line / table row that decided it. */
  detail?: string;
  verdict: 'info' | 'ok' | 'changed' | 'drop';
  iface?: string;
  /** Header after this step, e.g. 'ICMP echo 60.50.50.100 → 60.50.40.2'. */
  header?: string;
}
export type DropReason =
  | 'no-ip' | 'no-link' | 'no-gateway' | 'no-route' | 'host-unreachable' | 'ttl-expired'
  | 'acl-in' | 'acl-out' | 'ipsec-negotiation-failed' | 'ipsec-expected' | 'ipsec-no-sa'
  | 'port-closed' | 'service-denied' | 'loop';
export interface Delivery {
  ok: boolean;
  reason?: DropReason;
  reasonText?: string;
  /** Device that dropped or received the packet. */
  atDeviceId?: string;
  /** Packet as received by the destination (after NAT etc.). */
  received?: Packet;
  steps: TraceStep[];
  /** True when the packet crossed at least one link inside ESP. */
  encrypted: boolean;
  /** True when this packet caused a new IPsec SA to be negotiated (real routers lose the first packet meanwhile). */
  negotiated?: boolean;
  /** QoS classification at every egress interface that has an output service-policy. */
  qos: { deviceId: string; iface: string; policy: string; className: string; childPolicy?: string; childClass?: string }[];
}
export interface FlowSpec {
  fromDeviceId: string;
  /** Override the source address (router `source` interface address). Default: address of the egress interface / PC NIC. */
  srcAddr?: string;
  dst: string;
  proto: 'icmp' | 'tcp' | 'udp';
  /** Destination port (tcp/udp). */
  dport?: number;
  sport?: number;
  app?: AppData;
  bytes?: number;
}
export interface FlowResult {
  /** Request delivered AND reply came back (tcp: handshake completed; udp without a responder: request delivered). */
  ok: boolean;
  /** Ping-style symbol: '!' success, '.' timeout, 'U' destination/administratively unreachable. */
  symbol: '!' | '.' | 'U';
  forward: Delivery;
  reverse?: Delivery;
  /** One sentence for humans. */
  summary: string;
}

// ───────────────────────────── Scenarios, guidance, grading ─────────────────────────────
export type LabMode = 'guided' | 'free' | 'exam';
export type ScenarioFamily = 'case-study' | 'variation' | 'lab' | 'broken' | 'mock';
export interface ScenarioSummary {
  id: string;
  title: string;
  family: ScenarioFamily;
  features: Feature[];
  /** Suggested working time. */
  minutes: number;
  level: 1 | 2 | 3;
  blurb: string;
  /** true: a new seed produces different addresses/rules. */
  seedable: boolean;
}
export interface BriefItem { no: string; text: string; feature: Feature; optional?: boolean; subItems?: string[] }
/** The logical picture printed on the assignment sheet (NOT the cabling answer). Coordinates in a 0..1000 × 0..600 box. */
export interface DiagramSpec {
  nodes: { id: string; label: string; kind: DeviceKind; x: number; y: number; notes?: string[] }[];
  links: { a: string; b: string; label?: string; dashed?: boolean }[];
  areas?: { label: string; x: number; y: number; w: number; h: number }[];
}
export interface BenchDeviceSeed {
  id: string;
  model: DeviceModel;
  label: string;
  x: number;
  y: number;
  /** Routers: false removes the serial NIM (no Serial ports). Default true. */
  serialModule?: boolean;
}
export interface SolutionCable { kind: CableKind; a: PortRef; b: PortRef; dceEnd?: 'a' | 'b'; note?: string }
export interface PcSetup { mode: 'static' | 'dhcp'; address?: string; mask?: string; gateway?: string; services?: Partial<PcServices> }
export interface SolutionView {
  cables: SolutionCable[];
  /** Model configuration per IOS device id, as config-file text. */
  configs: Record<string, string>;
  pcs: Record<string, PcSetup>;
  notes: string[];
}
export interface GuideStep {
  id: string;
  no: number;
  title: string;
  feature: Feature;
  /** Device ids where this step's work happens. */
  devices: string[];
  /** What to achieve, in one or two short sentences. */
  goal: string;
  why?: string;
  hint?: string;
  /** Example commands, shown only on request. */
  example?: string;
  /** Features of state-changing commands/actions permitted while this step is active. */
  allows: Feature[];
}
export interface RequirementView { id: string; no: string; title: string; feature: Feature; points: number }
export interface CheckResult {
  id: string;
  label: string;
  pass: boolean;
  expected: string;
  observed: string;
  tip?: string;
  trace?: TraceStep[];
}
export interface RequirementResult extends RequirementView { earned: number; pass: boolean; checks: CheckResult[] }
export interface OrderIssue { tick: number; deviceId?: string; line?: string; text: string; severity: 'info' | 'warn' }
export interface HardwareNote { id: string; feature: Feature; title: string; text: string }
export interface GradeReport {
  scenarioId: string;
  mode: LabMode;
  tick: number;
  maxPoints: number;
  points: number;
  /** Practice-rubric version and profile at measurement time. Absent on historical saves. */
  practiceBasis?: { revision: 2; qos: 'course' | 'after-encryption' };
  /** NetLab practice points normalized to 18; not an instructor-issued mark. */
  scaled18: number;
  requirements: RequirementResult[];
  orderIssues: OrderIssue[];
  hardwareNotes: HardwareNote[];
}
export interface JournalEntry {
  tick: number;
  deviceId: string;
  via: 'console' | 'vty' | 'file' | 'pc' | 'bench';
  /** CLI mode name when the line was entered. */
  mode?: string;
  line: string;
  feature: Feature;
  ok: boolean;
  mutated: boolean;
  /** Guided mode refused the action. */
  blocked?: boolean;
  stepId?: string;
}
export interface ScenarioInstance {
  summary: ScenarioSummary;
  seed: number;
  brief: { intro: string; items: BriefItem[]; given?: { label: string; value: string }[] };
  diagram: DiagramSpec;
  bench: BenchDeviceSeed[];
  /** Pre-built parts (short labs and broken networks). Applied by the lab before the user starts. */
  initial?: { cables?: SolutionCable[]; configs?: Record<string, string>; pcs?: Record<string, PcSetup>; settings?: Partial<WorldSettings> };
  requirements: RequirementView[];
  guide: GuideStep[];
  solution: SolutionView;
  hardwareNotes: HardwareNote[];
  /** Pure: must not mutate `world` (clone internally before sending probe traffic). */
  grade(world: World, journal: JournalEntry[]): { requirements: RequirementResult[]; orderIssues: OrderIssue[] };
  /** Pure: which guide steps are satisfied by the current state. Key = step id. */
  guideProgress(world: World, journal: JournalEntry[]): Record<string, boolean>;
}
export interface ScenarioDef { summary: ScenarioSummary; build(seed: number): ScenarioInstance }
