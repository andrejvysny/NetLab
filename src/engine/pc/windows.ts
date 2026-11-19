/**
 * Windows 10 command prompt (cmd.exe) of a lab PC. Output follows the real Windows wording and layout;
 * remarks of the simulator itself are always in brackets starting with "(Simulator:".
 */
import type { PcDevice, World } from '../types.ts';
import { networkOf, parsePort } from '../ip.ts';
import { dhcpAcquire, dhcpRelease, sendFlow } from '../sim/index.ts';
import { MAX_WAIT, curl, pcServerBanner, sshTest } from './apps.ts';
import type { ProbeResult } from './net.ts';
import { cmpIp, deviceLabel, neighbours, pingOnce, tcpConnect, traceFrom } from './net.ts';
import type { NicView, PcCmdOut } from './util.ts';
import {
  bcast, capDelay, hash32, intArg, isAddr, macBytes, macWindows, nicView, padL, padR, tokenize, winField, winHostname,
} from './util.ts';

export const WIN_PROMPT = 'C:\\Users\\student>';
const ADAPTER = 'Ethernet';
const NIC_DESCRIPTION = 'Intel(R) Ethernet Connection (7) I219-LM';
/** Most echo requests one ping command may send in the simulator. */
const MAX_PROBES = 20;
const T_FOREVER_PROBES = 8;

/** Every Windows command ends with an empty line before the next prompt. */
function out(text: string, extra: Omit<PcCmdOut, 'output'> = {}): PcCmdOut {
  const body = text.endsWith('\n') ? text : text + '\n';
  return { output: body + '\n', ...extra };
}
function lines(...l: string[]): string { return l.join('\n') + '\n'; }

export function windowsExec(world: World, pc: PcDevice, line: string): PcCmdOut {
  const toks = tokenize(line);
  if (toks.length === 0) return { output: '' };
  let first = toks[0];
  // cmd.exe accepts "ipconfig/all" and "ping/?": the switch may touch the command name.
  const glued = /^([^/]+)(\/.+)$/.exec(first);
  if (glued) { first = glued[1]; toks.splice(0, 1, glued[1], glued[2]); }
  const cmd = first.toLowerCase().replace(/\.exe$/, '');
  const args = toks.slice(1);
  switch (cmd) {
    case 'ipconfig': return ipconfig(world, pc, args);
    case 'ping': return ping(world, pc, args);
    case 'tracert': return tracert(world, pc, args);
    case 'telnet': return telnet(world, pc, args);
    case 'arp': return arp(world, pc, args);
    case 'route': return route(world, pc, args);
    case 'netstat': return netstat(world, pc, args);
    case 'hostname': return out(winHostname(pc));
    case 'getmac': return getmac(world, pc, args);
    case 'nslookup': return nslookup(world, pc, args);
    case 'curl': return curl(world, pc, args, 'windows');
    case 'ftp': return ftp(world, pc, args);
    case 'ssh': return ssh(world, pc, args);
    case 'test-netconnection': case 'tnc': return testNetConnection(world, pc, first, args);
    case 'cls': return { output: '', clear: true };
    case 'help': return help(args);
    case 'ver': return out('\nMicrosoft Windows [Version 10.0.19045.3803]');
    case 'exit': return out('(Simulator: close this window with its close button. The prompt stays open here.)');
    case 'whoami': return out(`${winHostname(pc).toLowerCase()}\\student`);
    case 'echo': {
      const rest = line.trim().replace(/^echo\.?\s?/i, '');
      return out(rest === '' ? 'ECHO is on.' : rest);
    }
    case 'powershell': case 'pwsh':
      return out('Windows PowerShell\nCopyright (C) Microsoft Corporation. All rights reserved.\n\n(Simulator: PowerShell itself is not simulated. Test-NetConnection works directly in this prompt.)');
    default:
      return out(`'${first}' is not recognized as an internal or external command,\noperable program or batch file.`);
  }
}

// ───────────────────────────── ipconfig ─────────────────────────────
const IPCONFIG_USAGE = lines(
  '',
  'USAGE:',
  '    ipconfig [/allcompartments] [/? | /all |',
  '                                 /renew [adapter] | /release [adapter] |',
  '                                 /renew6 [adapter] | /release6 [adapter] |',
  '                                 /flushdns | /displaydns | /registerdns |',
  '                                 /showclassid adapter |',
  '                                 /setclassid adapter [classid] |',
  '                                 /showclassid6 adapter |',
  '                                 /setclassid6 adapter [classid] ]',
  '',
  'where',
  '    adapter             Connection name',
  '                       (wildcard characters * and ? allowed, see examples)',
  '',
  '    Options:',
  '       /?               Display this help message',
  '       /all             Display full configuration information.',
  '       /release         Release the IPv4 address for the specified adapter.',
  '       /release6        Release the IPv6 address for the specified adapter.',
  '       /renew           Renew the IPv4 address for the specified adapter.',
  '       /renew6          Renew the IPv6 address for the specified adapter.',
  '       /flushdns        Purges the DNS Resolver cache.',
  '       /registerdns     Refreshes all DHCP leases and re-registers DNS names',
  '       /displaydns      Display the contents of the DNS Resolver Cache.',
  '       /showclassid     Displays all the dhcp class IDs allowed for adapter.',
  '       /setclassid      Modifies the dhcp class id.',
  '       /showclassid6    Displays all the IPv6 DHCP class IDs allowed for adapter.',
  '       /setclassid6     Modifies the IPv6 DHCP class id.',
);

function adapterLines(pc: PcDevice, v: NicView, all: boolean, opts: { noApipa?: boolean } = {}): string[] {
  const l: string[] = [`Ethernet adapter ${ADAPTER}:`, ''];
  const hw = () => {
    if (!all) return;
    l.push(winField('Description', NIC_DESCRIPTION));
    l.push(winField('Physical Address', macWindows(macBytes(pc.nic.mac))));
    l.push(winField('DHCP Enabled', v.dhcp ? 'Yes' : 'No'));
    l.push(winField('Autoconfiguration Enabled', 'Yes'));
  };
  if (!v.linkUp) {
    l.push(winField('Media State', 'Media disconnected'));
    l.push(winField('Connection-specific DNS Suffix'));
    hw();
    return l;
  }
  l.push(winField('Connection-specific DNS Suffix'));
  hw();
  const pref = all ? '(Preferred)' : '';
  if (v.address && v.mask) {
    l.push(winField('IPv4 Address', v.address + pref));
    l.push(winField('Subnet Mask', v.mask));
    l.push(winField('Default Gateway', v.gateway ?? ''));
    if (all && v.dhcp && v.dhcpServer) l.push(winField('DHCP Server', v.dhcpServer));
    if (all && v.dns) l.push(winField('DNS Servers', v.dns));
  } else if (v.apipa && !opts.noApipa) {
    l.push(winField('Autoconfiguration IPv4 Address', v.apipa.address + pref));
    l.push(winField('Subnet Mask', v.apipa.mask));
    l.push(winField('Default Gateway'));
  } else {
    l.push(winField('Default Gateway'));
  }
  if (all) l.push(winField('NetBIOS over Tcpip', 'Enabled'));
  return l;
}

function ipconfigBlock(pc: PcDevice, v: NicView, all: boolean, opts: { noApipa?: boolean } = {}): string {
  const l: string[] = ['', 'Windows IP Configuration', ''];
  if (all) {
    l.push(winField('Host Name', winHostname(pc)));
    l.push(winField('Primary Dns Suffix'));
    l.push(winField('Node Type', 'Hybrid'));
    l.push(winField('IP Routing Enabled', 'No'));
    l.push(winField('WINS Proxy Enabled', 'No'));
  }
  l.push('');
  l.push(...adapterLines(pc, v, all, opts));
  return l.join('\n');
}

function ipconfig(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  const opt = (args[0] ?? '').toLowerCase().replace(/^-/, '/');
  const v = nicView(world, pc);
  const head = '\nWindows IP Configuration\n\n';
  switch (opt) {
    case '': return out(ipconfigBlock(pc, v, false));
    case '/all': return out(ipconfigBlock(pc, v, true));
    case '/?': return out(IPCONFIG_USAGE);
    case '/flushdns': return out(head + 'Successfully flushed the DNS Resolver Cache.');
    case '/displaydns': return out(head + 'Could not display the DNS Resolver Cache.');
    case '/release': case '/renew': {
      if (args[1] && !matchesAdapter(args[1])) {
        return out(head + `The operation failed as no adapter is in the state permissible for\nthis operation.`);
      }
      if (!v.linkUp) return out(head + `No operation can be performed on ${ADAPTER} while it has its media disconnected.`);
      if (!v.dhcp) return out(head + 'The operation failed as no adapter is in the state permissible for\nthis operation.');
      if (opt === '/release') {
        dhcpRelease(world, pc.id);
        return out(ipconfigBlock(pc, nicView(world, pc), false, { noApipa: true }), { delayMs: 400 });
      }
      const r = dhcpAcquire(world, pc.id);
      if (!r.ok) {
        return out(head + `An error occurred while renewing interface ${ADAPTER} : unable to contact your DHCP server. Request has timed out.`, { delayMs: MAX_WAIT });
      }
      return out(ipconfigBlock(pc, nicView(world, pc), false), { delayMs: 1200 });
    }
    default:
      return out('\nError: unrecognized or incomplete command line.\n' + IPCONFIG_USAGE);
  }
}
function matchesAdapter(name: string): boolean {
  const re = new RegExp('^' + name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return re.test(ADAPTER);
}

// ───────────────────────────── ping ─────────────────────────────
const PING_USAGE = lines(
  '',
  'Usage: ping [-t] [-a] [-n count] [-l size] [-f] [-i TTL] [-v TOS]',
  '            [-r count] [-s count] [[-j host-list] | [-k host-list]]',
  '            [-w timeout] [-R] [-S srcaddr] [-c compartment] [-p]',
  '            [-4] [-6] target_name',
  '',
  'Options:',
  '    -t             Ping the specified host until stopped.',
  '                   To see statistics and continue - type Control-Break;',
  '                   To stop - type Control-C.',
  '    -a             Resolve addresses to hostnames.',
  '    -n count       Number of echo requests to send.',
  '    -l size        Send buffer size.',
  "    -f             Set Don't Fragment flag in packet (IPv4-only).",
  '    -i TTL         Time To Live.',
  '    -v TOS         Type Of Service (IPv4-only. This setting has been deprecated',
  '                   and has no effect on the type of service field in the IP',
  '                   Header).',
  '    -r count       Record route for count hops (IPv4-only).',
  '    -s count       Timestamp for count hops (IPv4-only).',
  '    -j host-list   Loose source route along host-list (IPv4-only).',
  '    -k host-list   Strict source route along host-list (IPv4-only).',
  '    -w timeout     Timeout in milliseconds to wait for each reply.',
  '    -R             Use routing header to test reverse route also (IPv6-only).',
  '    -S srcaddr     Source address to use.',
  '    -c compartment Routing compartment identifier.',
  '    -p             Ping a Hyper-V Network Virtualization provider address.',
  '    -4             Force using IPv4.',
  '    -6             Force using IPv6.',
);

function msText(rtt: number): string { return rtt < 1 ? '<1ms' : `=${Math.round(rtt)}ms`; }

function ping(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  if (args.length === 0) return out(PING_USAGE);
  let forever = false;
  let count = 4;
  let size = 32;
  let target: string | undefined;
  const valueOpts: Record<string, [number, number]> = { n: [1, 4294967295], l: [0, 65500], w: [0, 4294967295], i: [1, 255], v: [0, 255], r: [1, 9], s: [1, 4], c: [0, 4294967295] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^[-/]./.test(a)) {
      const raw = a.slice(1);
      const o = raw.toLowerCase();
      if (o === '?') return out(PING_USAGE);
      if (o === 't') { forever = true; continue; }
      if (o === 'a' || o === 'f' || o === '4' || o === 'p' || raw === 'R') continue;
      if (o === '6') return out(`Ping request could not find host ${target ?? args[i + 1] ?? ''}. Please check the name and try again.`);
      if (raw === 'S' || o === 'j' || o === 'k') {
        if (args[i + 1] === undefined) return out(`Value must be supplied for option ${a}.`);
        i++;
        continue;
      }
      if (o in valueOpts) {
        const v = args[i + 1];
        if (v === undefined) return out(`Value must be supplied for option ${a}.`);
        const [min, max] = valueOpts[o];
        const n = intArg(v, min, max);
        if (n === null) return out(`Bad value for option -${o}, valid range is from ${min} to ${max}.`);
        if (o === 'n') count = n;
        if (o === 'l') size = n;
        i++;
        continue;
      }
      return out(`Bad option ${a}.\n` + PING_USAGE);
    }
    if (target !== undefined) return out(`Bad parameter ${a}.`);
    target = a;
  }
  if (target === undefined) return out('IP address must be specified.');
  if (!isAddr(target)) return out(`Ping request could not find host ${target}. Please check the name and try again.`);

  let n = forever ? T_FOREVER_PROBES : count;
  const capped = !forever && n > MAX_PROBES;
  if (capped) n = MAX_PROBES;
  const bytes = size + 28;
  const rows: string[] = ['', `Pinging ${target} with ${size} bytes of data:`];
  let received = 0;
  const times: number[] = [];
  let delay = 0;
  for (let i = 0; i < n; i++) {
    const r: ProbeResult = pingOnce(world, pc, target, bytes);
    switch (r.kind) {
      case 'reply': {
        const rtt = r.rtt >= 1 && i === 0 ? r.rtt + 1 : r.rtt;
        rows.push(`Reply from ${r.from}: bytes=${size} time${msText(rtt)} TTL=${r.ttl}`);
        received++;
        times.push(rtt < 1 ? 0 : Math.round(rtt));
        delay += 250;
        break;
      }
      case 'unreach': {
        const what = r.code === 'port' ? 'port' : r.code === 'host' ? 'host' : 'net';
        rows.push(`Reply from ${r.from}: Destination ${what} unreachable.`);
        received++;
        delay += 250;
        break;
      }
      case 'ttl':
        rows.push(`Reply from ${r.from}: TTL expired in transit.`);
        received++;
        delay += 250;
        break;
      case 'arp':
        rows.push(`Reply from ${r.self}: Destination host unreachable.`);
        received++;
        delay += 600;
        break;
      case 'local':
        rows.push('PING: transmit failed. General failure. ');
        delay += 100;
        break;
      default:
        rows.push('Request timed out.');
        delay += 600;
    }
  }
  const lost = n - received;
  rows.push('');
  rows.push(`Ping statistics for ${target}:`);
  rows.push(`    Packets: Sent = ${n}, Received = ${received}, Lost = ${lost} (${Math.floor((lost * 100) / n)}% loss),`);
  if (times.length > 0) {
    const min = Math.min(...times);
    const max = Math.max(...times);
    const avg = Math.round(times.reduce((s, t) => s + t, 0) / times.length);
    rows.push('Approximate round trip times in milli-seconds:');
    rows.push(`    Minimum = ${min}ms, Maximum = ${max}ms, Average = ${avg}ms`);
  }
  if (forever) {
    rows.push('Control-C');
    rows.push('^C');
    rows.push(`(Simulator: ping -t was stopped after ${T_FOREVER_PROBES} echo requests.)`);
  }
  if (capped) rows.push(`(Simulator: only the first ${MAX_PROBES} echo requests are sent.)`);
  return out(rows.join('\n'), { delayMs: capDelay(delay) });
}

// ───────────────────────────── tracert ─────────────────────────────
const TRACERT_USAGE = lines(
  '',
  'Usage: tracert [-d] [-h maximum_hops] [-j host-list] [-w timeout]',
  '               [-R] [-S srcaddr] [-4] [-6] target_name',
  '',
  'Options:',
  '    -d                 Do not resolve addresses to hostnames.',
  '    -h maximum_hops    Maximum number of hops to search for target.',
  '    -j host-list       Loose source route along host-list (IPv4-only).',
  '    -w timeout         Wait timeout milliseconds for each reply.',
  '    -R                 Trace round-trip path (IPv6-only).',
  '    -S srcaddr         Source address to use (IPv6-only).',
  '    -4                 Force using IPv4.',
  '    -6                 Force using IPv6.',
);

function tracert(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  if (args.length === 0) return out(TRACERT_USAGE);
  let maxHops = 30;
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^[-/]./.test(a)) {
      const o = a.slice(1).toLowerCase();
      if (o === '?') return out(TRACERT_USAGE);
      if (o === 'd' || o === '4') continue;
      if (o === 'h' || o === 'w' || o === 'j' || o === 's') {
        const v = args[i + 1];
        if (v === undefined) return out(`A value must be supplied for option ${a}.\n` + TRACERT_USAGE);
        if (o === 'h') {
          const n = intArg(v, 1, 255);
          if (n === null) return out(`Bad value for option ${a}.\n` + TRACERT_USAGE);
          maxHops = n;
        }
        i++;
        continue;
      }
      return out(`Bad option ${a}.\n` + TRACERT_USAGE);
    }
    if (target !== undefined) return out(`Bad parameter ${a}.\n` + TRACERT_USAGE);
    target = a;
  }
  if (target === undefined) return out(TRACERT_USAGE);
  if (!isAddr(target)) return out(`Unable to resolve target system name ${target}.`);
  const rows: string[] = ['', `Tracing route to ${target} over a maximum of ${maxHops} hops`, ''];
  const t = traceFrom(world, pc, target, 'icmp', maxHops, 92);
  let delay = 0;
  if (t.local) {
    rows.push('  1  General failure.');
    delay = 300;
  } else if (t.arpSelf) {
    rows.push(`  1  ${t.arpSelf}  reports: Destination host unreachable.`);
    delay = 2000;
  } else {
    for (const h of t.hops) {
      if (h.symbol === '*' || !h.address) {
        rows.push(`${padL(h.ttl, 3)}${'     *   '.repeat(3)}  Request timed out.`);
        delay += 900;
      } else if (h.symbol === '!') {
        const cols = [0, 1, 2].map((k) => {
          const ms = h.rtt + (k === 0 && h.rtt >= 1 ? 1 : 0);
          return `${padL(ms < 1 ? '<1' : String(Math.round(ms)), 6)} ms`;
        });
        rows.push(`${padL(h.ttl, 3)}${cols.join('')}  ${h.address}`);
        delay += 150;
      } else {
        const what = h.symbol === '!H' ? 'host' : 'net';
        rows.push(`${padL(h.ttl, 3)}  ${h.address}  reports: Destination ${what} unreachable.`);
        delay += 150;
      }
    }
    const last = t.hops[t.hops.length - 1];
    if (!t.reached && last && last.symbol === '*' && t.hops.length < maxHops) {
      rows.push(`(Simulator: tracert stops after three silent hops. The real command keeps trying up to ${maxHops} hops.)`);
    }
  }
  rows.push('');
  rows.push('Trace complete.');
  return out(rows.join('\n'), { delayMs: capDelay(delay) });
}

// ───────────────────────────── telnet / ssh / ftp ─────────────────────────────
const TELNET_USAGE = lines(
  '',
  'telnet [-a][-e escape char][-f log file][-l user][-t term][host [port]]',
  ' -a\tAttempt automatic logon. Same as -l option except uses',
  "\tthe currently logged on user's name.",
  ' -e\tEscape character to enter telnet client prompt.',
  ' -f\tFile name for client side logging',
  ' -l\tSpecifies the user name to log in with on the remote system.',
  '\tRequires that the remote system support the TELNET ENVIRON option.',
  ' -t\tSpecifies terminal type.',
  '\tSupported term types are vt100, vt52, ansi and vtnt only.',
  ' host\tSpecifies the hostname or IP address of the remote computer',
  '\tto connect to.',
  ' port\tSpecifies a port number or service name.',
);

function telnet(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '/?' || a === '-?' || a === '/h' || a === '-h') return out(TELNET_USAGE);
    if (/^-[eflt]$/i.test(a)) { i++; continue; }
    if (/^-a$/i.test(a)) continue;
    if (a.startsWith('-')) return out(`Invalid Command. type /? for help`);
    pos.push(a);
  }
  if (pos.length === 0) {
    return out("Welcome to Microsoft Telnet Client\n\nEscape Character is 'CTRL+]'\n\n(Simulator: the interactive Telnet client is not simulated. Type telnet <address> [port].)");
  }
  const host = pos[0];
  const portText = pos[1] ?? '23';
  const failed = (p: string, delayMs: number) => out(`Connecting To ${host}...Could not open connection to the host, on port ${p}: Connect failed`, { delayMs: capDelay(delayMs) });
  const port = parsePort(portText);
  if (port === null || port === 0) return failed(portText, 300);
  if (!isAddr(host)) return failed(portText, 1500);
  const c = tcpConnect(world, pc, host, port);
  if (c.kind === 'open') {
    if (c.isIos && c.vty?.accepted && port === 23) {
      return { output: '', telnet: { deviceId: c.deviceId, remoteAddr: c.remoteAddr, host, port } };
    }
    const banner = c.isIos ? [`(Simulator: ${deviceLabel(world, c.deviceId)} answered the TCP probe on port ${port}.)`] : pcServerBanner(world, c.deviceId, port, host);
    return out(banner.join('\n') + '\n\n\nConnection to host lost.', { delayMs: 600 });
  }
  return failed(portText, c.kind === 'refused' ? 1000 : c.kind === 'local' ? 300 : MAX_WAIT);
}

function ssh(world: World, pc: PcDevice, args: string[]): PcCmdOut { return sshTest(world, pc, args, 'windows'); }

function ftp(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  const pos = args.filter((a) => !/^-/.test(a));
  if (args.some((a) => a === '-?' || a === '/?')) {
    return out('\nTransfers files to and from a computer running an FTP server service\n(sometimes called a daemon). Ftp can be used interactively.\n\nFTP [-v] [-d] [-i] [-n] [-g] [-s:filename] [-a] [-A] [-x:sendbuffer] [-r:recvbuffer] [-b:asyncbuffers] [-w:windowsize] [host]');
  }
  if (pos.length === 0) return out('ftp> \n(Simulator: the interactive ftp> prompt is not simulated. Type ftp <address> to test an FTP server.)');
  const host = pos[0];
  if (!isAddr(host)) return out(`Unknown host ${host}.`, { delayMs: 600 });
  const c = tcpConnect(world, pc, host, 21);
  if (c.kind === 'open') {
    return out([
      `Connected to ${host}.`,
      '220 Simulated FTP server',
      `(Simulator: the FTP server of ${deviceLabel(world, c.deviceId)} answers. Logging in and file transfer are not simulated, so ftp closes again.)`,
      '221 Goodbye.',
    ].join('\n'), { delayMs: 600 });
  }
  return out(`> ftp: connect :${c.kind === 'refused' ? 'Connection refused' : 'Connection timed out'}`, { delayMs: capDelay(c.kind === 'timeout' ? MAX_WAIT : 800) });
}

// ───────────────────────────── Test-NetConnection ─────────────────────────────
const TNC_PARAMS = ['computername', 'port', 'commontcpport', 'informationlevel', 'traceroute', 'hops', 'constrainsourceaddress', 'constraininterface', 'diagnoserouting'];
const COMMON_PORTS: Record<string, number> = { http: 80, rdp: 3389, smb: 445, winrm: 5985 };

function psBlock(rows: [string, string][]): string {
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${padR(k, w)} : ${v}`).join('\n');
}

function testNetConnection(world: World, pc: PcDevice, typed: string, args: string[]): PcCmdOut {
  const name = typed.toLowerCase() === 'tnc' ? 'Test-NetConnection' : typed;
  let host: string | undefined;
  let port: number | undefined;
  let quiet = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      const key = a.slice(1).toLowerCase();
      const hits = TNC_PARAMS.filter((p) => p.startsWith(key));
      const exact = TNC_PARAMS.find((p) => p === key);
      const param = exact ?? (hits.length === 1 ? hits[0] : undefined);
      if (!param && hits.length > 1) {
        return out(`${name} : Parameter cannot be processed because the parameter name '${a.slice(1)}' is ambiguous. Possible matches include: ${hits.map((h) => '-' + TNC_PARAMS_DISPLAY[h]).join(' ')}.`);
      }
      if (!param) return out(`${name} : A parameter cannot be found that matches parameter name '${a.slice(1)}'.`);
      const v = args[i + 1];
      if (param === 'traceroute' || param === 'diagnoserouting') continue;
      if (v === undefined) return out(`${name} : Missing an argument for parameter '${TNC_PARAMS_DISPLAY[param]}'. Specify a parameter of type 'System.${param === 'port' ? 'Int32' : 'String'}' and try again.`);
      i++;
      if (param === 'computername') host = v;
      else if (param === 'port') {
        const n = intArg(v, 1, 65535);
        if (n === null) return out(`${name} : Cannot validate argument on parameter 'Port'. The ${v} argument is not valid.`);
        port = n;
      } else if (param === 'commontcpport') {
        const n = COMMON_PORTS[v.toLowerCase()];
        if (n === undefined) return out(`${name} : Cannot validate argument on parameter 'CommonTCPPort'. The argument "${v}" does not belong to the set "HTTP,RDP,SMB,WINRM" specified by the ValidateSet attribute.`);
        port = n;
      } else if (param === 'informationlevel') quiet = v.toLowerCase() === 'quiet';
      continue;
    }
    if (host === undefined) host = a;
    else if (port === undefined && intArg(a, 1, 65535) !== null) port = Number(a);
  }
  const target = host ?? 'internetbeacon.msedge.net';
  if (!isAddr(target)) return out(`WARNING: Name resolution of ${target} failed`, { delayMs: 1500 });
  const v = nicView(world, pc);
  const src = v.address ?? '';
  const pingStatus = (r: ProbeResult): string =>
    r.kind === 'unreach' ? (r.code === 'host' ? 'DestinationHostUnreachable' : r.code === 'port' ? 'DestinationPortUnreachable' : 'DestinationNetworkUnreachable')
      : r.kind === 'arp' ? 'DestinationHostUnreachable' : r.kind === 'ttl' ? 'TtlExpired' : 'TimedOut';
  const warnings: string[] = [];
  const rows: [string, string][] = [['ComputerName', target], ['RemoteAddress', target]];
  let ok: boolean;
  let delay = 400;
  if (port !== undefined) {
    rows.push(['RemotePort', String(port)]);
    rows.push(['InterfaceAlias', ADAPTER], ['SourceAddress', src]);
    const c = tcpConnect(world, pc, target, port);
    ok = c.kind === 'open';
    if (!ok) {
      warnings.push(`WARNING: TCP connect to (${target} : ${port}) failed`);
      const p = pingOnce(world, pc, target, 60);
      if (p.kind !== 'reply') warnings.push(`WARNING: Ping to ${target} failed with status: ${pingStatus(p)}`);
      rows.push(['PingSucceeded', p.kind === 'reply' ? 'True' : 'False'], ['PingReplyDetails (RTT)', `${p.kind === 'reply' ? Math.round(p.rtt) : 0} ms`]);
      delay = c.kind === 'refused' ? 1500 : MAX_WAIT;
    }
    rows.push(['TcpTestSucceeded', ok ? 'True' : 'False']);
  } else {
    rows.push(['InterfaceAlias', ADAPTER], ['SourceAddress', src]);
    const p = pingOnce(world, pc, target, 60);
    ok = p.kind === 'reply';
    if (!ok) { warnings.push(`WARNING: Ping to ${target} failed with status: ${pingStatus(p)}`); delay = MAX_WAIT; }
    rows.push(['PingSucceeded', ok ? 'True' : 'False'], ['PingReplyDetails (RTT)', `${p.kind === 'reply' ? Math.round(p.rtt) : 0} ms`]);
  }
  if (quiet) return out([...warnings, ok ? 'True' : 'False'].join('\n'), { delayMs: capDelay(delay) });
  const text = [...warnings, '', '', psBlock(rows)].join('\n');
  return out(text, { delayMs: capDelay(delay) });
}
const TNC_PARAMS_DISPLAY: Record<string, string> = {
  computername: 'ComputerName', port: 'Port', commontcpport: 'CommonTCPPort', informationlevel: 'InformationLevel', traceroute: 'TraceRoute',
  hops: 'Hops', constrainsourceaddress: 'ConstrainSourceAddress', constraininterface: 'ConstrainInterface', diagnoserouting: 'DiagnoseRouting',
};

// ───────────────────────────── arp / route / netstat / getmac ─────────────────────────────
const ARP_USAGE = lines(
  '',
  'Displays and modifies the IP-to-Physical address translation tables used by',
  'address resolution protocol (ARP).',
  '',
  'ARP -s inet_addr eth_addr [if_addr]',
  'ARP -d inet_addr [if_addr]',
  'ARP -a [inet_addr] [-N if_addr] [-v]',
  '',
  '  -a            Displays current ARP entries by interrogating the current',
  '                protocol data.  If inet_addr is specified, the IP and Physical',
  '                addresses for only the specified computer are displayed.  If',
  '                more than one network interface uses ARP, entries for each ARP',
  '                table are displayed.',
  '  -g            Same as -a.',
  '  -v            Displays current ARP entries in verbose mode.  All invalid',
  '                entries and entries on the loop-back interface will be shown.',
  '  inet_addr     Specifies an internet address.',
  '  -N if_addr    Displays the ARP entries for the network interface specified',
  '                by if_addr.',
  '  -d            Deletes the host specified by inet_addr. inet_addr may be',
  '                wildcarded with * to delete all hosts.',
  '  -s            Adds the host and associates the Internet address inet_addr',
  '                with the Physical address eth_addr.  The Physical address is',
  '                given as 6 hexadecimal bytes separated by hyphens. The entry',
  '                is permanent.',
);

function arp(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  const o = (args[0] ?? '').toLowerCase().replace(/^\//, '-');
  if (o === '-d') return out('The ARP entry deletion failed: The requested operation requires elevation.');
  if (o === '-s') return out('The ARP entry addition failed: The requested operation requires elevation.');
  if (o !== '-a' && o !== '-g') return out(ARP_USAGE);
  const v = nicView(world, pc);
  if (!v.address || !v.mask) return out('No ARP Entries Found.');
  const rows: [string, string, string][] = neighbours(world, pc).map((n) => [n.address, macWindows(n.mac, false), 'dynamic']);
  const statics: [string, string][] = [
    [bcast(v.address, v.mask), 'ff-ff-ff-ff-ff-ff'],
    ['224.0.0.22', '01-00-5e-00-00-16'],
    ['224.0.0.251', '01-00-5e-00-00-fb'],
    ['224.0.0.252', '01-00-5e-00-00-fc'],
    ['239.255.255.250', '01-00-5e-7f-ff-fa'],
    ['255.255.255.255', 'ff-ff-ff-ff-ff-ff'],
  ];
  for (const [a, m] of statics) rows.push([a, m, 'static']);
  const filter = args[1] && isAddr(args[1]) ? args[1] : undefined;
  const shown = filter ? rows.filter((r) => r[0] === filter) : rows;
  if (shown.length === 0) return out('No ARP Entries Found.');
  const text = ['', `Interface: ${v.address} --- 0x5`, '  Internet Address      Physical Address      Type', ...shown.map(([a, m, t]) => `  ${padR(a, 22)}${padR(m, 22)}${t}`)];
  return out(text.join('\n'));
}

function routeTable(world: World, pc: PcDevice): string {
  const v = nicView(world, pc);
  const mac = macBytes(pc.nic.mac).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const bar = '='.repeat(75);
  const row = (d: string, m: string, g: string, i: string, met: number | string) => `${padL(d, 17)}${padL(m, 17)}${padL(g, 17)}${padL(i, 17)}${padL(met, 7)}`;
  const l: string[] = [bar, 'Interface List', ` 11...${mac} ......${NIC_DESCRIPTION}`, '  1...........................Software Loopback Interface 1', bar, '', 'IPv4 Route Table', bar, 'Active Routes:'];
  l.push('Network Destination        Netmask          Gateway       Interface  Metric');
  const routes: [string, string, string, string, number][] = [];
  const addr = v.address;
  const mask = v.mask;
  if (addr && mask && v.gateway) routes.push(['0.0.0.0', '0.0.0.0', v.gateway, addr, 25]);
  routes.push(['127.0.0.0', '255.0.0.0', 'On-link', '127.0.0.1', 331], ['127.0.0.1', '255.255.255.255', 'On-link', '127.0.0.1', 331], ['127.255.255.255', '255.255.255.255', 'On-link', '127.0.0.1', 331]);
  if (addr && mask) {
    routes.push([networkOf(addr, mask), mask, 'On-link', addr, 281], [addr, '255.255.255.255', 'On-link', addr, 281]);
    if (mask !== '255.255.255.255') routes.push([bcast(addr, mask), '255.255.255.255', 'On-link', addr, 281]);
  }
  routes.push(['224.0.0.0', '240.0.0.0', 'On-link', '127.0.0.1', 331]);
  if (addr) routes.push(['224.0.0.0', '240.0.0.0', 'On-link', addr, 281]);
  routes.push(['255.255.255.255', '255.255.255.255', 'On-link', '127.0.0.1', 331]);
  if (addr) routes.push(['255.255.255.255', '255.255.255.255', 'On-link', addr, 281]);
  routes.sort((a, b) => cmpIp(a[0], b[0]) || cmpIp(a[1], b[1]) || (a[3] === '127.0.0.1' ? -1 : 1));
  for (const r of routes) l.push(row(...r));
  l.push(bar, 'Persistent Routes:');
  if (pc.nic.mode === 'static' && v.gateway) {
    l.push('  Network Address          Netmask  Gateway Address  Metric');
    l.push(`${padL('0.0.0.0', 17)}${padL('0.0.0.0', 17)}${padL(v.gateway, 17)}  Default`);
  } else {
    l.push('  None');
  }
  l.push(bar);
  return '\n' + l.join('\n');
}

function route(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  const o = (args[0] ?? '').toLowerCase();
  if (o === 'print') return out(routeTable(world, pc));
  if (o === 'add' || o === 'delete' || o === 'change') return out('The requested operation requires elevation.');
  return out(lines(
    '',
    'Manipulates network routing tables.',
    '',
    'ROUTE [-f] [-p] [-4|-6] command [destination]',
    '                  [MASK netmask]  [gateway] [METRIC metric]  [IF interface]',
    '',
    '  command      One of these:',
    '                 PRINT     Prints  a route',
    '                 ADD       Adds    a route',
    '                 DELETE    Deletes a route',
    '                 CHANGE    Modifies an existing route',
  ));
}

function netstat(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  const flags = args.join('').toLowerCase();
  if (flags.includes('r')) return out(routeTable(world, pc));
  return out('\nActive Connections\n\n  Proto  Local Address          Foreign Address        State');
}

function getmac(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  if (args.some((a) => a === '/?')) return out('\nGETMAC [/S system [/U username [/P [password]]]] [/FO format] [/NH] [/V]\n\nDescription:\n    This tool enables an administrator to display the MAC address\n    for network adapters on a system.');
  const v = nicView(world, pc);
  const h = hash32(pc.id).toString(16).toUpperCase().padStart(8, '0');
  const transport = v.linkUp ? `\\Device\\Tcpip_{${h}-3B1D-4E5F-9A7B-${h.slice(0, 4)}${h}}` : 'Media disconnected';
  return out(['', 'Physical Address    Transport Name', '=================== ==========================================================', `${padR(macWindows(macBytes(pc.nic.mac)), 20)}${transport}`].join('\n'));
}

// ───────────────────────────── nslookup ─────────────────────────────
function nslookup(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  const v = nicView(world, pc);
  const name = args.find((a) => !a.startsWith('-'));
  const server = v.dns;
  if (!server) {
    if (!name) return out('*** Default servers are not available\nDefault Server:  UnKnown\nAddress:  127.0.0.1\n\n(Simulator: the interactive nslookup prompt is not simulated. There is no DNS server in this lab.)');
    return out(`*** Default servers are not available\nServer:  UnKnown\nAddress:  127.0.0.1\n\n*** UnKnown can't find ${name}: No response from server`, { delayMs: 600 });
  }
  // A real DNS query (UDP 53) goes out, and nothing answers it.
  sendFlow(world, { fromDeviceId: pc.id, dst: server, proto: 'udp', dport: 53, app: { kind: 'generic', label: 'DNS query' } });
  const to = 'DNS request timed out.\n    timeout was 2 seconds.';
  if (!name) return out(`${to}\nDefault Server:  UnKnown\nAddress:  ${server}\n\n(Simulator: the interactive nslookup prompt is not simulated. There is no DNS server in this lab.)`, { delayMs: 2000 });
  return out(`${to}\nServer:  UnKnown\nAddress:  ${server}\n\n${to}\n${to}\n*** Request to UnKnown timed-out`, { delayMs: MAX_WAIT });
}

// ───────────────────────────── help ─────────────────────────────
const HELP: [string, string][] = [
  ['ARP', 'Displays the IP-to-Physical address translation table (arp -a).'],
  ['CLS', 'Clears the screen.'],
  ['CURL', 'Asks a web server for a page: curl http://address/ (curl -I shows only the headers).'],
  ['ECHO', 'Displays messages.'],
  ['EXIT', 'Quits the CMD.EXE program (command interpreter).'],
  ['FTP', 'Tests an FTP server: ftp address'],
  ['GETMAC', 'Displays the MAC address of the network adapter.'],
  ['HOSTNAME', 'Prints the name of this computer.'],
  ['IPCONFIG', 'Shows the IP settings: ipconfig, ipconfig /all, ipconfig /release, ipconfig /renew'],
  ['NSLOOKUP', 'Asks a DNS server for a name (this lab has no DNS server).'],
  ['PING', 'Sends echo requests: ping address [-n count] [-l size] [-t]'],
  ['ROUTE', 'Displays the routing table: route print'],
  ['SSH', 'Probes TCP 22 without opening an SSH session: ssh address'],
  ['TELNET', 'Opens a Telnet connection: telnet address [port]'],
  ['TNC', 'Tests any TCP port: Test-NetConnection address -Port number'],
  ['TRACERT', 'Shows the routers on the way to an address: tracert address'],
  ['VER', 'Displays the Windows version.'],
];
function help(args: string[]): PcCmdOut {
  if (args[0]) {
    const h = HELP.find(([k]) => k.toLowerCase() === args[0].toLowerCase());
    if (h) return out(`${h[1]}`);
    return out(`This command is not supported by the help utility.  Try "${args[0]} /?".`);
  }
  return out(['For more information on a specific command, type HELP command-name', ...HELP.map(([k, t]) => `${padR(k, 15)}${t}`)].join('\n'));
}
