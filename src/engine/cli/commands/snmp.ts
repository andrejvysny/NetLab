/**
 * SNMP agent configuration: `snmp-server community/location/contact/host/enable traps/trap-source/view`, accepted extras
 * (`packetsize`, `ifindex persist`, `system-shutdown`, `chassis-id`, `queue-length`, `trap timeout`, `manager`) kept in
 * `snmp.extraLines`, `no snmp-server` (removes all SNMP configuration) and the individual `no` forms.
 *
 * Normalisation: community access is stored lower case ('ro' | 'rw', default 'ro'); a community line for an existing name
 * replaces it. Notification targets replace by IP address and kind, separately for traps and informs.
 * `snmp-server enable traps` with no type stores 'all'; typed selectors use lower-case, single-spaced options.
 *
 * No sub-modes, so no session.ctx keys.
 */
import type { SnmpConfig, SnmpHost } from '../../types.ts';
import { effectiveSnmpHosts, MODELED_SNMP_TRAPS, snmpSelectorMatches, validSnmpHost } from '../../snmp.ts';
import type { Args, CmdEnv, CommandDef } from '../framework.ts';
import { registerCommands } from '../framework.ts';
import { checkInterfaceRef, invalidAt, lineTokens, setExtraLine } from './acl.ts';

const TRAP_TYPES: Record<string, string> = {
  aaa_server: 'Allow SNMP AAA traps', bfd: 'Allow SNMP BFD traps', bgp: 'Allow SNMP BGP traps', bulkstat: 'Allow bulkstat traps',
  'call-home': 'Enable SNMP CISCO-CALLHOME-MIB traps', cef: 'Allow cef related traps', config: 'Enable SNMP config traps',
  'config-copy': 'Enable SNMP config-copy traps', 'config-ctid': 'Enable SNMP config-ctid traps', cpu: 'Allow cpu related traps',
  dhcp: 'Enable SNMP DHCP traps', eigrp: 'Enable SNMP EIGRP traps', entity: 'Enable SNMP entity traps',
  'entity-diag': 'Enable SNMP CISCO-ENTITY-DIAG-MIB traps', envmon: 'Enable SNMP environmental monitor traps',
  errdisable: 'Enable error disable traps', 'event-manager': 'Allow SNMP Embedded Event Manager traps',
  firewall: 'Enable SNMP Firewall traps', flash: 'Enable SNMP FLASH notifications', hsrp: 'Enable SNMP HSRP traps',
  ike: 'Enable IKE traps', ipmulticast: 'Enable SNMP ip multi-cast notifications', ipsec: 'Enable IPsec traps',
  ipsla: 'Enable SNMP IP SLA traps', isakmp: 'Enable ISAKMP traps', isis: 'Enable IS-IS traps', l2tun: 'Enable SNMP L2 tunnel protocol traps',
  license: 'Enable license traps', 'mac-notification': 'Enable SNMP MAC Notification traps', memory: 'Enable SNMP Memory traps',
  mpls: 'Enable SNMP MPLS traps', msdp: 'Enable SNMP MSDP traps', nhrp: 'Enable SNMP NHRP traps', ospf: 'Enable OSPF traps',
  ospfv3: 'Enable OSPFv3 traps', pim: 'Enable SNMP PIM traps', pki: 'Enable SNMP pki traps', 'port-security': 'Enable SNMP port security traps',
  'power-ethernet': 'Enable SNMP power ethernet traps', rf: 'Enable all SNMP traps defined in CISCO-RF-MIB', rsvp: 'Enable RSVP flow change traps',
  snmp: 'Enable SNMP traps', stpx: 'Enable SNMP STPX MIB traps', syslog: 'Enable SNMP syslog traps', transceiver: 'Enable SNMP transceiver traps',
  tty: 'Enable TCP connection traps', udld: 'Enable SNMP UDLD traps', vlancreate: 'Enable SNMP VLAN created traps',
  vlandelete: 'Enable SNMP VLAN deleted traps', vrrp: 'Enable SNMP vrrp traps', vtp: 'Enable SNMP VTP traps',
};
const TRAP_LIST = Object.keys(TRAP_TYPES).sort();

const H: Record<string, string> = {
  no: 'Negate a command or set its defaults', 'snmp-server': 'Modify SNMP engine parameters',
  community: 'Enable SNMP; set community string and access privs', '<name>': 'SNMP community string',
  view: 'Restrict this community to a named MIB view', '<view>': 'MIB view to which this community has access',
  ro: 'Read-only access with this community string', rw: 'Read-write access with this community string',
  '<acl>': 'Std IP accesslist allowed access with this community string (1-99, 1300-1999 or name)',
  location: 'Text for mib object sysLocation', contact: 'Text for mib object sysContact', '<text>': 'identification string',
  host: 'Specify hosts to receive SNMP notifications', '<addr>': 'IP address of SNMP notification host',
  traps: 'Send Trap messages to this host', informs: 'Send Inform messages to this host',
  version: 'SNMP version to use for notification messages', '1': 'Use SNMPv1', '2c': 'Use SNMPv2c', '3': 'Use the SNMPv3 security model',
  auth: 'Use the SNMPv3 authNoPriv Security Level', noauth: 'Use the SNMPv3 noAuthNoPriv Security Level', priv: 'Use the SNMPv3 authPriv Security Level',
  '<community>': 'SNMPv1/v2c community string or SNMPv3 user name', '<types>': 'Notification families to send to this host',
  enable: 'Enable SNMP Traps or Informs', '<opts>': 'Notification options',
  'trap-source': 'Assign an interface for the source address of all traps', '<ifname>': 'Interface for the trap source address',
  '<vname>': 'Name of the view', '<oid>': 'MIB view family name or OID (e.g. system, 1.3.6.1.2.1.1)',
  included: 'MIB family is included in the view', excluded: 'MIB family is excluded from the view',
  packetsize: 'Largest SNMP packet size', '<size>': 'Packet size', ifindex: 'Enable ifindex persistence', persist: 'Persist interface indices',
  'system-shutdown': 'Enable use of the SNMP reload command', 'chassis-id': 'String to uniquely describe this chassis',
  'queue-length': 'Message queue length for each TRAP host', '<len>': 'Queue length', trap: 'SNMP trap options',
  timeout: 'Set timeout for TRAP message retransmissions', '<sec>': 'Timeout in seconds', manager: 'Modify SNMP manager parameters',
  ...TRAP_TYPES,
};
// Same word, other meaning: `snmp-server enable traps` and `snmp-server view` (vs. `host … traps`, `community … view`).
const H_ENABLE: Record<string, string> = { ...H, traps: 'Enable SNMP Traps' };
const H_VIEW: Record<string, string> = { ...H, view: 'Define an SNMPv2 MIB view' };

const single = (s: string) => s.trim().replace(/\s+/g, ' ');

function emptySnmp(): SnmpConfig {
  return { communities: [], hosts: [], enableTraps: [], views: [], extraLines: [] };
}
function extra(env: CmdEnv): string[] {
  const s = env.device.config.snmp;
  if (!s.extraLines) s.extraLines = [];
  return s.extraLines;
}
function accepted(env: CmdEnv, key: string, line: string | null): void {
  setExtraLine(extra(env), key, line);
  if (line !== null) env.note(`Accepted, but not simulated: ${key}.`);
}

const HOST = 'snmp-server host <addr:ip> [{htype:traps|informs}]';
const HOST_FORMS = [
  `${HOST} [version {ver:1|2c}] <community:word> [<types:text>]`,
  `${HOST} version {ver:3} [{sec:auth|noauth|priv}] <community:word> [<types:text>]`,
];
const isKeyword = (word: string, choices: readonly string[]) => choices.some((k) => k.startsWith(word.toLowerCase()));

function hostArgs(env: CmdEnv, args: Args): SnmpHost {
  // The matcher can fall back to WORD after an incomplete keyword branch. Do not save the keywords as credentials.
  if (args.community !== undefined && args.ver === undefined && isKeyword(args.community, ['traps', 'informs', 'version'])) {
    const toks = lineTokens(env.line);
    const i = toks.findIndex((t) => t.text === args.addr) + (args.htype ? 2 : 1);
    if (isKeyword(args.community, ['version']) && toks[i + 1] && !isKeyword(toks[i + 1].text, ['1', '2c', '3'])) {
      invalidAt(env, toks[i + 1].start);
    }
    env.reject('% Incomplete command.');
  }
  if (args.ver === '3' && args.sec === undefined && isKeyword(args.community, ['auth', 'noauth', 'priv'])) env.reject('% Incomplete command.');
  if (args.community?.toLowerCase() === 'vrf') env.reject('% SNMP notification VRFs are not modeled.');
  const notificationTypes = args.types === undefined ? [] : [...new Set(single(String(args.types)).toLowerCase().split(' '))];
  if (notificationTypes.includes('udp-port')) env.reject('% Only the default SNMP trap port (162) is modeled.');
  return {
    address: args.addr, community: args.community, ...(args.ver ? { version: args.ver } : {}),
    type: args.htype ?? 'traps',
    ...(args.ver === '3' ? { securityLevel: args.sec ?? 'noauth' } : {}),
    ...(notificationTypes.length ? { notificationTypes } : {}),
  };
}

const SNMP_OPTIONS = ['authentication', 'linkdown', 'linkup', 'coldstart', 'warmstart'];
function trapSelector(env: CmdEnv, args: Args): string {
  if (args.trap === undefined) return 'all';
  const options = args.opts === undefined ? [] : single(String(args.opts)).toLowerCase().split(' ');
  if (args.trap !== 'snmp') return [args.trap, ...options].join(' ');
  const normalized = options.map((word) => {
    const hits = SNMP_OPTIONS.filter((o) => o.startsWith(word));
    if (hits.length !== 1) env.reject(`% Invalid SNMP notification option: ${word}.`);
    return hits[0];
  });
  return [args.trap, ...new Set(normalized)].join(' ');
}

export const commands: CommandDef[] = [
  // Hosts first: the first definition to create a keyword edge supplies its `?` help text.
  {
    modes: 'config', feature: 'snmp', help: H, pattern: HOST_FORMS,
    run(env, args) {
      const host = hostArgs(env, args);
      if (!validSnmpHost(host)) env.reject('% SNMPv1 does not support informs; use version 2c or 3.');
      const s = env.device.config.snmp;
      const hosts = effectiveSnmpHosts(s);
      const idx = hosts.findIndex((h) => h.address === host.address && h.type === host.type);
      if (idx >= 0) hosts[idx] = host; else hosts.push(host);
      s.hosts = hosts;
      if (host.version === '3' || host.type === 'informs') {
        env.note('Accepted, but not simulated: SNMPv3 and SNMP informs. This entry does not send a notification in the lab.');
      }
    },
  },
  {
    modes: 'config', feature: 'snmp', help: H,
    pattern: [`no ${HOST}`, ...HOST_FORMS.map((p) => `no ${p}`)],
    run(env, args) {
      const s = env.device.config.snmp;
      const match = hostArgs(env, args);
      s.hosts = effectiveSnmpHosts(s).filter((h) => !(h.address === match.address && h.type === match.type
        && (args.community === undefined || h.community === match.community)
        && (args.ver === undefined || (h.version ?? '1') === match.version)
        && (args.sec === undefined || (h.securityLevel ?? 'noauth') === match.securityLevel)));
    },
  },
  {
    modes: 'config', feature: 'snmp', help: H,
    pattern: 'snmp-server community <name:word> [view <view:word>] [{access:ro|rw}] [<acl:word>]',
    run(env, args) {
      if (args.acl !== undefined && args.view === undefined && 'view'.startsWith(String(args.acl).toLowerCase())) env.reject('% Incomplete command.');
      const s = env.device.config.snmp;
      const c: SnmpConfig['communities'][number] = { name: args.name, access: args.access ?? 'ro' };
      if (args.acl !== undefined) c.acl = String(args.acl);
      if (args.view !== undefined) c.view = String(args.view);
      const idx = s.communities.findIndex((x) => x.name === c.name);
      if (idx >= 0) s.communities[idx] = c; else s.communities.push(c);
      if (c.view && !s.views.some((v) => v.name === c.view)) env.note(`View ${c.view} is not defined yet. Define it with "snmp-server view ${c.view} <oid> included".`);
    },
  },
  {
    modes: 'config', feature: 'snmp', help: H,
    pattern: 'no snmp-server community <name:word> [<rest:text>]',
    run(env, args) {
      const s = env.device.config.snmp;
      s.communities = s.communities.filter((c) => c.name !== args.name);
    },
  },
  {
    modes: 'config', feature: 'snmp', help: H,
    pattern: ['snmp-server location <text:text>', 'snmp-server contact <text:text>'],
    run(env, args) {
      const s = env.device.config.snmp;
      if (env.has('location')) s.location = String(args.text).trim(); else s.contact = String(args.text).trim();
    },
  },
  {
    modes: 'config', feature: 'snmp', help: H,
    pattern: ['no snmp-server location [<text:text>]', 'no snmp-server contact [<text:text>]'],
    run(env) {
      const s = env.device.config.snmp;
      if (env.has('location')) delete s.location; else delete s.contact;
    },
  },
  {
    modes: 'config', feature: 'snmp', help: H_ENABLE,
    pattern: ['snmp-server enable traps', `snmp-server enable traps {trap:${TRAP_LIST.join('|')}} [<opts:text>]`],
    run(env, args) {
      const s = env.device.config.snmp;
      const t = trapSelector(env, args);
      if (!s.enableTraps.includes(t)) s.enableTraps.push(t);
      const disabled = (s.disableTraps ?? []).filter((trap) => !snmpSelectorMatches(t, trap));
      if (disabled.length) s.disableTraps = disabled; else delete s.disableTraps;
    },
  },
  {
    modes: 'config', feature: 'snmp', help: H_ENABLE,
    pattern: ['no snmp-server enable traps', `no snmp-server enable traps {trap:${TRAP_LIST.join('|')}} [<opts:text>]`],
    run(env, args) {
      const s = env.device.config.snmp;
      const t = trapSelector(env, args);
      if (t === 'all') { s.enableTraps = []; delete s.disableTraps; return; }
      const [family, ...options] = t.split(' ');
      s.enableTraps = [...new Set(s.enableTraps.flatMap((selector) => {
        if (selector === t || (!options.length && selector.startsWith(`${family} `))) return [];
        if (family !== 'snmp' || !selector.startsWith('snmp ')) return [selector];
        const rest = selector.split(' ').slice(1).filter((o) => !options.includes(o));
        return rest.length ? [`snmp ${rest.join(' ')}`] : [];
      }))];
      // A broad positive line can still cover the explicitly disabled event. Preserve that exception across reload.
      const disabled = MODELED_SNMP_TRAPS.filter((trap) => (s.disableTraps?.includes(trap) || snmpSelectorMatches(t, trap))
        && s.enableTraps.some((sel) => snmpSelectorMatches(sel, trap)));
      if (disabled.length) s.disableTraps = disabled; else delete s.disableTraps;
    },
  },
  {
    modes: 'config', feature: 'snmp', help: H,
    pattern: 'snmp-server trap-source <ifname:if>',
    run(env, args) {
      checkInterfaceRef(env, String(args.ifname));
      env.device.config.snmp.trapSource = String(args.ifname);
    },
  },
  {
    modes: 'config', feature: 'snmp', help: H,
    pattern: 'no snmp-server trap-source [<ifname:if>]',
    run(env) { delete env.device.config.snmp.trapSource; },
  },
  {
    modes: 'config', feature: 'snmp', help: H_VIEW,
    pattern: 'snmp-server view <vname:word> <oid:word> {inc:included|excluded}',
    run(env, args) {
      const s = env.device.config.snmp;
      const v = { name: String(args.vname), oid: String(args.oid), included: args.inc === 'included' };
      const idx = s.views.findIndex((x) => x.name === v.name && x.oid === v.oid);
      if (idx >= 0) s.views[idx] = v; else s.views.push(v);
    },
  },
  {
    modes: 'config', feature: 'snmp', help: H_VIEW,
    pattern: 'no snmp-server view <vname:word> [<oid:word>] [{inc:included|excluded}]',
    run(env, args) {
      const s = env.device.config.snmp;
      s.views = s.views.filter((v) => !(v.name === args.vname && (args.oid === undefined || v.oid === args.oid)));
    },
  },
  // Accepted extras (not simulated)
  {
    modes: 'config', feature: 'snmp', help: H,
    pattern: [
      'snmp-server packetsize <size:int(484-17940)>', 'snmp-server ifindex persist', 'snmp-server system-shutdown',
      'snmp-server chassis-id <text:text>', 'snmp-server queue-length <len:int(1-5000)>', 'snmp-server trap timeout <sec:int(1-1000)>',
      'snmp-server manager',
    ],
    run(env, args) {
      if (env.has('packetsize')) accepted(env, 'snmp-server packetsize', `snmp-server packetsize ${args.size}`);
      else if (env.has('ifindex')) accepted(env, 'snmp-server ifindex persist', 'snmp-server ifindex persist');
      else if (env.has('system-shutdown')) accepted(env, 'snmp-server system-shutdown', 'snmp-server system-shutdown');
      else if (env.has('chassis-id')) accepted(env, 'snmp-server chassis-id', `snmp-server chassis-id ${String(args.text).trim()}`);
      else if (env.has('queue-length')) accepted(env, 'snmp-server queue-length', `snmp-server queue-length ${args.len}`);
      else if (env.has('timeout')) accepted(env, 'snmp-server trap timeout', `snmp-server trap timeout ${args.sec}`);
      else accepted(env, 'snmp-server manager', 'snmp-server manager');
    },
  },
  {
    modes: 'config', feature: 'snmp', help: H,
    pattern: [
      'no snmp-server packetsize [<size:int(484-17940)>]', 'no snmp-server ifindex persist', 'no snmp-server system-shutdown',
      'no snmp-server chassis-id [<text:text>]', 'no snmp-server queue-length [<len:int(1-5000)>]', 'no snmp-server trap timeout [<sec:int(1-1000)>]',
      'no snmp-server manager',
    ],
    run(env) {
      const key = env.has('packetsize') ? 'snmp-server packetsize' : env.has('ifindex') ? 'snmp-server ifindex persist'
        : env.has('system-shutdown') ? 'snmp-server system-shutdown' : env.has('chassis-id') ? 'snmp-server chassis-id'
        : env.has('queue-length') ? 'snmp-server queue-length' : env.has('timeout') ? 'snmp-server trap timeout' : 'snmp-server manager';
      setExtraLine(extra(env), key, null);
    },
  },
  {
    modes: 'config', feature: 'snmp', help: H,
    pattern: 'no snmp-server',
    run(env) { env.device.config.snmp = emptySnmp(); },
  },
];

export function install(): void { registerCommands(commands); }
