/**
 * Verification commands (feature 'verify', never mutating): every `show …` except running-config / startup-config
 * (showconfig.ts). The screens themselves are built in ../show/*.ts from the structured configuration, the runtime tables
 * and the simulation API; this file only holds the grammar.
 *
 * User EXEC gets the subset real IOS allows there (version, clock, interfaces, routes, arp, cdp, users, line …);
 * everything else is privileged EXEC only. Unknown `show` sub-commands are left to the framework's invalid-input error.
 * `show queueing` (removed in IOS XE) answers with the IOS invalid-input caret plus a simulator note.
 *
 * No modes, no session.ctx keys, no pending input.
 */
import { basicNatEnabled } from '../../natProfile.ts';
import type { CmdEnv, CommandDef, ModeName } from '../framework.ts';
import { registerCommands } from '../framework.ts';
import {
  controllersBlock, interfacesDescription, interfacesStatus, interfacesTrunk, ipInterfaceBrief, macTable, showControllers,
  showInterfaces, showIpInterface, showProtocols, vlanBrief,
} from '../show/interfaces.ts';
import { showIpProtocols, showIpRoute, showIpRouteFor, showIpStaticRoute } from '../show/routing.ts';
import { dhcpBinding, dhcpConflict, dhcpPool, dhcpStatistics, natStatistics, natTranslations, showAccessLists } from '../show/services.ts';
import { cryptoMap, cryptoSession, ipsecSa, isakmpKey, isakmpPolicy, isakmpSa, isakmpSaDetail, transformSets } from '../show/crypto.ts';
import { policyMapInterface, showClassMap, showPolicyMap } from '../show/qos.ts';
import { lineDetail, lineRows, showLineTable, showLogging, showSnmp, showUsers, snmpCommunity, snmpHost, chassisId } from '../show/mgmt.ts';
import {
  showAliases, showArp, showCdp, showCdpDetail, showCdpNeighbors, showClock, showDebugging, showFlash, showHistory, showHosts,
  showInventory, showLicense, showPlatform, showVersion,
} from '../show/system.ts';
import { existingIf, invalidTok, toks } from '../show/util.ts';

const U: ModeName[] = ['user', 'priv'];
const P: ModeName = 'priv';
const SW: ('router' | 'switch')[] = ['switch'];
const RT: ('router' | 'switch')[] = ['router'];

/** Help texts, as IOS words them. */
const H: Record<string, string> = {
  show: 'Show running system information',
  ip: 'IP information',
  interface: 'Interface status and configuration',
  interfaces: 'Interface status and configuration',
  brief: 'Brief summary of IP status and configuration',
  status: 'Show interface line status',
  description: 'Show interface description',
  trunk: 'Show interface trunk information',
  controllers: 'Interface controller status',
  vlan: 'VTP VLAN status',
  mac: 'MAC configuration',
  'address-table': 'MAC forwarding table',
  dynamic: 'dynamic entry type',
  protocols: 'Active network routing protocols',
  route: 'IP routing table',
  static: 'Static routes',
  connected: 'Connected networks',
  rip: 'Routing Information Protocol (RIP)',
  ospf: 'Open Shortest Path First (OSPF)',
  dhcp: 'Show items in the DHCP database',
  binding: 'DHCP address bindings',
  pool: 'DHCP pools information',
  conflict: 'DHCP address conflicts',
  server: 'Miscellaneous DHCP server information',
  statistics: 'Translation statistics',
  'access-lists': 'List access lists',
  nat: 'IP NAT information',
  translations: 'Translation entries',
  verbose: 'Show extra information',
  crypto: 'Encryption module',
  isakmp: 'Show ISAKMP',
  policy: 'Show ISAKMP protection suite policy',
  sa: 'Show ISAKMP Security Associations',
  key: 'Show ISAKMP preshared keys',
  detail: 'detailed output',
  ipsec: 'Show IPSEC policy',
  'transform-set': 'Crypto IPSEC transform set',
  map: 'Crypto maps',
  session: 'Show crypto sessions currently present in the system',
  peer: 'IPSEC SA for a peer',
  'class-map': 'Show QoS Class Map',
  'policy-map': 'Show QoS Policy Map',
  input: 'Input policy',
  output: 'Output policy',
  snmp: 'snmp statistics',
  community: 'show snmp communities',
  host: 'show snmp notification recipients',
  location: 'snmp location',
  contact: 'snmp contact',
  chassis: 'snmp chassis',
  logging: 'Show the contents of logging buffers',
  users: 'Display information about terminal lines',
  all: 'Include information about inactive ports',
  line: 'TTY line information',
  console: 'Primary terminal line',
  vty: 'Virtual terminal',
  aux: 'Auxiliary line',
  version: 'System hardware and software status',
  clock: 'Display the system clock',
  history: 'Display the session command history',
  hosts: 'IP domain-name, lookup style, nameservers, and host table',
  arp: 'ARP table',
  cdp: 'CDP information',
  neighbors: 'CDP neighbor entries',
  inventory: 'Show the physical inventory',
  platform: 'show platform information',
  'flash:': 'display information about flash: file system',
  'bootflash:': 'display information about bootflash: file system',
  license: 'Show license information',
  summary: 'Show license summary',
  aliases: 'Display alias commands',
  exec: 'Exec mode',
  configure: 'Global configuration mode',
  debugging: 'State of each debugging option',
  terminal: 'Display terminal configuration parameters',
  privilege: 'Show current privilege level',
  sessions: 'Information about Telnet connections',
  queueing: '(removed in IOS XE: use show policy-map interface)',
  '<ifname>': 'Interface name',
  '<addr>': 'Network to display information about or hostname',
  '<mask>': 'Network mask',
  '<id>': 'ACL number or name',
  '<name>': 'Name',
  '<n>': 'Line number',
};

/** Print `text` (with a trailing newline unless empty). */
function out(env: CmdEnv, text: string): void { if (text !== '') env.print(text.endsWith('\n') ? text : text + '\n'); }
function ifArg(env: CmdEnv, a: Record<string, unknown>, after: number): string | undefined {
  return a.ifname === undefined ? undefined : existingIf(env, String(a.ifname), after);
}
function def(modes: ModeName | ModeName[], pattern: string | string[], run: CommandDef['run'], kinds?: ('router' | 'switch')[]): CommandDef {
  return { modes, pattern, feature: 'verify', mutates: false, help: H, kinds, run };
}

function requireNat(env: CmdEnv): void {
  if (!basicNatEnabled(env.device)) env.reject('% Catalyst NAT requires the Network Advantage classroom profile.');
}

export const commands: CommandDef[] = [
  // ── interfaces ──
  def(U, 'show ip interface brief', (env) => out(env, ipInterfaceBrief(env.world, env.device))),
  def(U, 'show ip interface [<ifname:if>]', (env, a) => out(env, showIpInterface(env.world, env.device, ifArg(env, a, 3)))),
  def(U, 'show interfaces [<ifname:if>]', (env, a) => out(env, showInterfaces(env.world, env.device, ifArg(env, a, 2)))),
  def(U, 'show interfaces description', (env) => out(env, interfacesDescription(env.world, env.device))),
  def(U, 'show interfaces status', (env) => out(env, interfacesStatus(env.world, env.device)), SW),
  def(U, 'show interfaces trunk', (env) => out(env, interfacesTrunk(env.world, env.device)), SW),
  def(P, 'show controllers [<ifname:if>]', (env, a) => {
    const name = ifArg(env, a, 2);
    out(env, name ? controllersBlock(env.world, env.device, name) : showControllers(env.world, env.device));
  }),
  def(U, 'show vlan [brief]', (env) => out(env, vlanBrief(env.device)), SW),
  def(U, 'show mac address-table [dynamic]', (env) => out(env, macTable(env.world, env.device, env.has('dynamic'))), SW),
  def(U, 'show protocols [<ifname:if>]', (env, a) => out(env, showProtocols(env.world, env.device, ifArg(env, a, 2)))),

  // ── routing ──
  def(U, 'show ip route [{f:static|connected|rip|ospf}]', (env, a) => out(env, showIpRoute(env.world, env.device, a.f as 'static' | undefined))),
  def(U, 'show ip route <addr:ip> [<mask:mask>]', (env, a) => out(env, showIpRouteFor(env.world, env.device, String(a.addr), a.mask === undefined ? undefined : String(a.mask)))),
  def(U, 'show ip protocols [summary]', (env) => out(env, showIpProtocols(env.world, env.device))),
  def(P, 'show ip static route', (env) => out(env, showIpStaticRoute(env.world, env.device))),

  // ── DHCP ──
  def(P, 'show ip dhcp binding [<addr:ip>]', (env, a) => out(env, dhcpBinding(env.world, env.device, a.addr as string | undefined))),
  def(P, 'show ip dhcp pool [<name:word>]', (env, a) => out(env, dhcpPool(env.world, env.device, a.name as string | undefined))),
  def(P, 'show ip dhcp conflict', (env) => out(env, dhcpConflict(env.world, env.device))),
  def(P, 'show ip dhcp server statistics', (env) => out(env, dhcpStatistics(env.world, env.device))),

  // ── ACL ──
  def(P, ['show access-lists [<id:word>]', 'show ip access-lists [<id:word>]'], (env, a) => out(env, showAccessLists(env.device, a.id as string | undefined))),

  // ── NAT ──
  def(P, 'show ip nat translations [verbose]', (env) => { requireNat(env); out(env, natTranslations(env.world, env.device, env.has('verbose'))); }),
  def(P, 'show ip nat statistics', (env) => { requireNat(env); out(env, natStatistics(env.world, env.device)); }),

  // ── IPsec ──
  def(P, 'show crypto isakmp policy', (env) => out(env, isakmpPolicy(env.device)), RT),
  def(P, 'show crypto isakmp sa [detail]', (env) => out(env, env.has('detail') ? isakmpSaDetail(env.world, env.device) : isakmpSa(env.world, env.device)), RT),
  def(P, 'show crypto isakmp key', (env) => out(env, isakmpKey(env.device)), RT),
  def(P, ['show crypto ipsec sa [detail]', 'show crypto ipsec sa peer <peer:ip>'], (env, a) => out(env, ipsecSa(env.world, env.device, a.peer as string | undefined)), RT),
  def(P, 'show crypto ipsec sa interface <ifname:if>', (env, a) => out(env, ipsecSa(env.world, env.device, undefined, ifArg(env, a, 5))), RT),
  def(P, 'show crypto ipsec transform-set', (env) => out(env, transformSets(env.device)), RT),
  def(P, ['show crypto map', 'show crypto map interface <ifname:if>'], (env, a) => out(env, cryptoMap(env.world, env.device, ifArg(env, a, 4))), RT),
  def(P, 'show crypto session [detail]', (env) => out(env, cryptoSession(env.world, env.device, env.has('detail'))), RT),

  // ── QoS ──
  def(P, 'show class-map [<name:word>]', (env, a) => out(env, showClassMap(env.device, a.name as string | undefined))),
  def(P, 'show policy-map [<name:word>]', (env, a) => out(env, showPolicyMap(env.device, a.name as string | undefined))),
  def(P, 'show policy-map interface [<ifname:if>] [{dir:input|output}]', (env, a) => {
    out(env, policyMapInterface(env.world, env.device, ifArg(env, a, 3), a.dir as 'input' | 'output' | undefined));
  }),
  {
    modes: U, pattern: ['show queueing', 'show queueing <rest:text>'], feature: 'verify', mutates: false, help: H,
    run(env) {
      env.note('IOS XE has no "show queueing" (legacy queueing was removed). Use "show policy-map interface <interface>" to see the QoS queues.');
      invalidTok(env, 1);
    },
  },

  // ── management ──
  def(P, 'show snmp', (env) => out(env, showSnmp(env.world, env.device))),
  def(P, 'show snmp community', (env) => out(env, snmpCommunity(env.device))),
  def(P, 'show snmp host', (env) => out(env, snmpHost(env.device))),
  def(P, 'show snmp location', (env) => out(env, env.device.config.snmp.location ?? '')),
  def(P, 'show snmp contact', (env) => out(env, env.device.config.snmp.contact ?? '')),
  def(P, 'show snmp chassis', (env) => out(env, chassisId(env.world, env.device))),
  def(P, 'show logging', (env) => out(env, showLogging(env.world, env.device))),
  def(U, 'show users [all]', (env) => out(env, showUsers(env.device, env.session))),
  def(U, 'show line', (env) => out(env, showLineTable(env.device, env.session))),
  def(U, ['show line <n:int(0-1000)>', 'show line {type:console|vty|aux} <rel:int(0-1000)>'], (env, a) => {
    const rows = lineRows(env.device);
    const want = a.type === undefined ? rows.find((r) => r.abs === a.n)
      : rows.find((r) => r.rel === a.rel && r.type === (a.type === 'console' ? 'CTY' : a.type === 'aux' ? 'AUX' : 'VTY'));
    if (!want) invalidTok(env, toks(env.line).length - 1);
    out(env, lineDetail(env.device, env.session, want, env.session.termLength));
  }),
  def(U, 'show terminal', (env) => {
    const rows = lineRows(env.device);
    const vtys = rows.filter((r) => r.type === 'VTY');
    const mine = env.session.via === 'vty' ? vtys[Math.max(0, Math.min(vtys.length - 1, env.device.runtime.vtyInUse - 1))] ?? rows[0] : rows[0];
    out(env, lineDetail(env.device, env.session, mine, env.session.termLength).split('\n').slice(3).join('\n'));
  }),
  def(U, 'show privilege', (env) => out(env, `Current privilege level is ${env.session.mode === 'user' ? 1 : 15}`)),
  def(U, 'show sessions', (env) => out(env, '% No connections open')),

  // ── system ──
  def(U, 'show version', (env) => out(env, showVersion(env.world, env.device))),
  def(U, 'show clock [detail]', (env) => out(env, showClock(env.world, env.device, env.has('detail')))),
  def(U, 'show history [all]', (env) => out(env, showHistory(env.session))),
  def(U, 'show hosts', (env) => out(env, showHosts(env.device))),
  def(U, ['show arp', 'show ip arp'], (env) => out(env, showArp(env.world, env.device))),
  def(U, 'show ip arp <addr:ip>', (env, a) => out(env, showArp(env.world, env.device, { addr: String(a.addr) }))),
  def(U, 'show ip arp <ifname:if>', (env, a) => out(env, showArp(env.world, env.device, { iface: ifArg(env, a, 3) }))),
  def(U, 'show cdp', (env) => out(env, showCdp(env.device))),
  def(U, 'show cdp neighbors [<ifname:if>]', (env, a) => out(env, showCdpNeighbors(env.world, env.device, ifArg(env, a, 3)))),
  def(U, 'show cdp neighbors [<ifname:if>] detail', (env, a) => out(env, showCdpDetail(env.world, env.device, ifArg(env, a, 3)))),
  def(U, 'show cdp entry *', (env) => out(env, showCdpDetail(env.world, env.device).replace(/\n*Total cdp entries displayed : \d+\s*$/, ''))),
  def(U, 'show inventory', (env) => out(env, showInventory(env.world, env.device))),
  def(P, 'show platform', (env) => out(env, showPlatform(env.world, env.device)), RT),
  def(P, 'show flash:', (env) => out(env, showFlash(env.device))),
  def(P, 'show bootflash:', (env) => out(env, showFlash(env.device)), RT),
  def(P, ['show license', 'show license summary', 'show license usage'], (env) => out(env, showLicense(env.device))),
  def(U, 'show aliases [{mode:exec|configure|interface}]', (env, a) => out(env, showAliases(env.device, a.mode as string | undefined))),
  def(P, 'show debugging', (env) => {
    out(env, showDebugging());
    env.note('The simulator does not keep debug settings: debug output is not simulated.');
  }),
];

export function install(): void { registerCommands(commands); }
