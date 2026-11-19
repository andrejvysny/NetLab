/**
 * DHCP server and relay: ip dhcp excluded-address, ip dhcp pool + pool sub-commands (network, default-router,
 * dns-server, domain-name, lease), no ip dhcp pool, [no] service dhcp, interface [no] ip helper-address.
 *
 * session.ctx in dhcp-config: { pool: string }
 *
 * `no service dhcp` has no structured field in IosConfig: it is kept as the extra line 'no service dhcp'
 * (absent = DHCP service on, the IOS default).
 */
import type { CmdEnv, CommandDef } from '../framework.ts';
import { currentInterfaces, registerCommands } from '../framework.ts';
import type { DhcpPool } from '../../types.ts';
import { classfulMask, ipToInt, isMask, maskToPrefix, networkOf, prefixToMask } from '../../ip.ts';
import { invalidToken, setExtra, NOT_SIMULATED } from './system.ts';
import { rejectIfL2 } from './interface.ts';

function pool(env: CmdEnv): DhcpPool {
  const name = String((env.session.ctx as { pool?: string }).pool ?? '');
  const pools = env.device.config.dhcp.pools;
  let p = pools.find((x) => x.name === name);
  if (!p) { p = { name, defaultRouters: [], dnsServers: [] }; pools.push(p); }
  return p;
}
function poolExtra(p: DhcpPool, line: string, key: number, mode: 'set' | 'remove'): void {
  if (!p.extraLines) p.extraLines = [];
  setExtra(p.extraLines, line, key, mode);
  if (!p.extraLines.length) delete p.extraLines;
}
/** Up to 8 addresses: `<a1:ip> [<a2:ip> [… <a8:ip>]]`. */
function addrList(n = 8): string {
  let s = '';
  for (let i = n; i >= 2; i--) s = ` [<a${i}:ip>${s}]`;
  return `<a1:ip>${s}`;
}
function collect(a: Record<string, any>): string[] {
  const out: string[] = [];
  for (let i = 1; i <= 8; i++) if (a[`a${i}`] !== undefined && !out.includes(String(a[`a${i}`]))) out.push(String(a[`a${i}`]));
  return out;
}

const HD: Record<string, string> = {
  ip: 'Global IP configuration subcommands',
  dhcp: 'Configure DHCP server and relay parameters',
  'excluded-address': 'Prevent DHCP from assigning certain addresses',
  pool: 'Configure DHCP address pools',
  service: 'Modify use of network based services',
  'helper-address': 'Specify a destination address for UDP broadcasts',
  no: 'Negate a command or set its defaults',
  '<low>': 'Low IP address',
  '<high>': 'High IP address',
  '<name>': 'Pool name',
  '<addr>': 'IP destination address',
};
const HP: Record<string, string> = {
  network: 'Network number and mask',
  'default-router': 'Default routers',
  'dns-server': 'DNS servers',
  'domain-name': 'Domain name',
  lease: 'Address lease time',
  infinite: 'Infinite lease',
  option: 'Raw DHCP options',
  no: 'Negate a command or set its defaults',
  '<net>': 'Network number in dotted-decimal notation',
  '<mask>': 'Network mask',
  '<len>': 'Network mask or prefix length (/nn)',
  '<a1>': 'Router\'s IP address',
  '<days>': 'Days',
  '<hours>': 'Hours',
  '<mins>': 'Minutes',
  '<dn>': 'Domain name',
};

export const commands: CommandDef[] = [
  // ── excluded addresses ──
  {
    modes: 'config', pattern: 'ip dhcp excluded-address <low:ip> [<high:ip>]', feature: 'dhcp', help: HD,
    run(env, a) {
      const low = String(a.low), high = a.high === undefined ? low : String(a.high);
      if (ipToInt(high) < ipToInt(low)) {
        env.note('The second address must not be lower than the first one.');
        invalidToken(env, 4);
      }
      const list = env.device.config.dhcp.excluded;
      if (!list.some((r) => r.low === low && r.high === high)) list.push({ low, high });
    },
  },
  {
    modes: 'config', pattern: 'no ip dhcp excluded-address <low:ip> [<high:ip>]', feature: 'dhcp', help: HD,
    run(env, a) {
      const low = String(a.low), high = a.high === undefined ? low : String(a.high);
      const d = env.device.config.dhcp;
      d.excluded = d.excluded.filter((r) => !(r.low === low && r.high === high));
    },
  },

  // ── pools ──
  {
    modes: 'config', pattern: 'ip dhcp pool <name:word>', feature: 'dhcp', mutates: false, help: HD,
    run(env, a) { env.setMode('dhcp-config', { pool: String(a.name) }); pool(env); },
  },
  {
    modes: 'config', pattern: 'no ip dhcp pool <name:word>', feature: 'dhcp', help: HD,
    run(env, a) {
      const d = env.device.config.dhcp;
      d.pools = d.pools.filter((p) => p.name !== a.name);
      env.device.runtime.dhcpBindings = env.device.runtime.dhcpBindings.filter((b) => b.pool !== a.name);
    },
  },
  {
    modes: 'dhcp-config', pattern: ['network <net:ip> [<mask:mask>]', 'network <net:ip> <len:word>'], feature: 'dhcp', help: HP,
    run(env, a) {
      const addr = String(a.net);
      let mask: string;
      if (a.len !== undefined) {
        const m = /^\/(\d{1,2})$/.exec(String(a.len));
        if (!m || Number(m[1]) < 1 || Number(m[1]) > 30) invalidToken(env, 2);
        mask = prefixToMask(Number(m[1]));
      } else if (a.mask !== undefined) {
        mask = String(a.mask);
        if (!isMask(mask) || maskToPrefix(mask) === 0 || maskToPrefix(mask) > 30) invalidToken(env, 2);
      } else mask = classfulMask(addr);
      const net = networkOf(addr, mask);
      const p = pool(env);
      if (net !== addr) env.note(`IOS keeps the network address ${net} for this pool.`);
      const other = env.device.config.dhcp.pools.find((x) => x !== p && x.network && x.network.address === net && x.network.mask === mask);
      if (other) env.note(`Pool ${other.name} already serves ${net} ${mask}. Use one pool per network.`);
      p.network = { address: net, mask };
    },
  },
  { modes: 'dhcp-config', pattern: 'no network [<net:ip> [<mask:mask>]]', feature: 'dhcp', help: HP, run(env) { delete pool(env).network; } },
  {
    modes: 'dhcp-config', pattern: `default-router ${addrList()}`, feature: 'dhcp', help: HP,
    run(env, a) { pool(env).defaultRouters = collect(a); },
  },
  { modes: 'dhcp-config', pattern: `no default-router [${addrList()}]`, feature: 'dhcp', help: HP, run(env) { pool(env).defaultRouters = []; } },
  {
    modes: 'dhcp-config', pattern: `dns-server ${addrList()}`, feature: 'dhcp', help: { ...HP, '<a1>': "Server's IP address" },
    run(env, a) { pool(env).dnsServers = collect(a); },
  },
  { modes: 'dhcp-config', pattern: `no dns-server [${addrList()}]`, feature: 'dhcp', help: HP, run(env) { pool(env).dnsServers = []; } },
  { modes: 'dhcp-config', pattern: 'domain-name <dn:word>', feature: 'dhcp', help: HP, run(env, a) { pool(env).domainName = String(a.dn); } },
  { modes: 'dhcp-config', pattern: 'no domain-name [<dn:word>]', feature: 'dhcp', help: HP, run(env) { delete pool(env).domainName; } },
  {
    modes: 'dhcp-config', pattern: ['lease infinite', 'lease <days:int(0-365)> [<hours:int(0-23)> [<mins:int(0-59)>]]'], feature: 'dhcp', help: HP,
    run(env, a) {
      const p = pool(env);
      if (env.has('infinite')) { p.lease = 'infinite'; return; }
      const parts = [a.days, a.hours, a.mins].filter((x) => x !== undefined).map(Number);
      p.lease = parts.join(' ');
      if (p.lease === '1') delete p.lease; // 1 day is the default
    },
  },
  { modes: 'dhcp-config', pattern: 'no lease [<rest:text>]', feature: 'dhcp', help: HP, run(env) { delete pool(env).lease; } },
  {
    modes: 'dhcp-config', pattern: ['option <code:int(0-254)> <rest:text>', 'no option <code:int(0-254)> [<rest:text>]'], feature: 'dhcp', help: HP,
    run(env, a) {
      poolExtra(pool(env), `option ${a.code} ${a.rest ?? ''}`.trim(), 2, env.has('no') ? 'remove' : 'set');
      env.note(NOT_SIMULATED + 'extra DHCP options.');
    },
  },

  // ── global DHCP service switches ──
  {
    modes: 'config', pattern: ['service dhcp', 'no service dhcp'], feature: 'dhcp', help: { ...HD, dhcp: 'Enable DHCP server and relay agent' },
    run(env) { setExtra(env.device.config.extraLines, 'no service dhcp', 2, env.has('no') ? 'set' : 'remove'); },
  },
  {
    modes: 'config', pattern: ['ip dhcp ping packets <n:int(0-10)>', 'no ip dhcp ping packets [<n:int(0-10)>]'], feature: 'dhcp', help: { ...HD, ping: 'Specify ping parameters used by DHCP', packets: 'Specify number of ping packets' },
    run(env, a) {
      const no = env.has('no');
      setExtra(env.device.config.extraLines, `ip dhcp ping packets ${a.n ?? ''}`.trim(), 4, no || Number(a.n) === 2 ? 'remove' : 'set');
      env.note(NOT_SIMULATED + 'the ping count (the simulated server always checks a free address once before offering it).');
    },
  },
  {
    modes: 'config', pattern: ['ip dhcp conflict logging', 'no ip dhcp conflict logging'], feature: 'dhcp', help: { ...HD, conflict: 'DHCP address conflict parameters', logging: 'Enable conflict logging' },
    run(env) { setExtra(env.device.config.extraLines, 'no ip dhcp conflict logging', 4, env.has('no') ? 'set' : 'remove'); env.note(NOT_SIMULATED + 'DHCP conflict logging.'); },
  },

  // ── relay ──
  {
    modes: 'config-if', pattern: 'ip helper-address <addr:ip>', feature: 'dhcp', help: HD,
    run(env, a) {
      const ifs = currentInterfaces(env);
      rejectIfL2(env, ifs, 'helper-address');
      for (const ifc of ifs) {
        const list = ifc.helperAddresses ?? [];
        if (!list.includes(String(a.addr))) list.push(String(a.addr));
        ifc.helperAddresses = list;
      }
    },
  },
  {
    modes: 'config-if', pattern: 'no ip helper-address [<addr:ip>]', feature: 'dhcp', help: HD,
    run(env, a) {
      for (const ifc of currentInterfaces(env)) {
        if (a.addr === undefined) delete ifc.helperAddresses;
        else if (ifc.helperAddresses) {
          ifc.helperAddresses = ifc.helperAddresses.filter((h) => h !== a.addr);
          if (!ifc.helperAddresses.length) delete ifc.helperAddresses;
        }
      }
    },
  },
];

let installed = false;
export function install(): void { if (installed) return; installed = true; registerCommands(commands); }
