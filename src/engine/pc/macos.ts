/**
 * macOS Terminal (zsh) of the lab's MacBook. Output follows the real macOS/BSD tools;
 * remarks of the simulator itself are always in brackets starting with "(Simulator:".
 */
import type { PcDevice, World } from '../types.ts';
import { classfulMask, maskToPrefix, networkOf, parsePort } from '../ip.ts';
import { dhcpAcquire, sendFlow } from '../sim/index.ts';
import { MAX_WAIT, curl, pcServerBanner, sshTest } from './apps.ts';
import type { ProbeResult } from './net.ts';
import { deviceLabel, neighbours, pingOnce, tcpConnect, traceFrom } from './net.ts';
import type { PcCmdOut } from './util.ts';
import { TCP_SERVICE, bcast, capDelay, hash32, hexMask, intArg, isAddr, macBytes, macColon, nicView, padL, padR, tokenize } from './util.ts';

export const MAC_PROMPT = 'student@MacBook ~ % ';
const MAX_PROBES = 20;
const DEFAULT_PROBES = 4;

function out(text: string, extra: Omit<PcCmdOut, 'output'> = {}): PcCmdOut {
  return { output: text === '' || text.endsWith('\n') ? text : text + '\n', ...extra };
}

export function macExec(world: World, pc: PcDevice, line: string): PcCmdOut {
  let toks = tokenize(line);
  if (toks.length === 0) return { output: '' };
  if (toks[0] === 'sudo') {
    toks = toks.slice(1);
    if (toks.length === 0) return out('usage: sudo -h | -K | -k | -V\nusage: sudo -v [-ABknS] [-g group] [-h host] [-p prompt] [-u user]\nusage: sudo -l [-ABknS] [-g group] [-h host] [-p prompt] [-U user] [-u user] [command]\nusage: sudo [-ABbEHknPS] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] [VAR=value] [-i|-s] [<command>]');
  }
  const typed = toks[0];
  const cmd = typed.toLowerCase();
  const args = toks.slice(1);
  switch (cmd) {
    case 'ifconfig': return ifconfig(world, pc, args);
    case 'ipconfig': return ipconfig(world, pc, args);
    case 'ping': return ping(world, pc, args);
    case 'traceroute': return traceroute(world, pc, args);
    case 'telnet': return telnet(world, pc, args);
    case 'nc': case 'netcat': return nc(world, pc, args);
    case 'curl': return curl(world, pc, args, 'macos');
    case 'ftp': return ftp(world, pc, args);
    case 'ssh': return sshTest(world, pc, args, 'macos');
    case 'arp': return arp(world, pc, args);
    case 'netstat': return netstat(world, pc, args);
    case 'nslookup': case 'dig': case 'host': return dnsTool(world, pc, cmd, args);
    case 'clear': return { output: '', clear: true };
    case 'hostname': return out('MacBook.local');
    case 'whoami': return out('student');
    case 'sw_vers': return out('ProductName:\t\tmacOS\nProductVersion:\t\t14.4.1\nBuildVersion:\t\t23E224');
    case 'echo': return out(line.trim().replace(/^echo\s?/, ''));
    case 'exit': case 'logout': return out('(Simulator: close this window with its close button. The terminal stays open here.)');
    case 'help': return help();
    default: return out(`zsh: command not found: ${typed}`);
  }
}

// ───────────────────────────── ifconfig / ipconfig ─────────────────────────────
function en0Lines(world: World, pc: PcDevice): string[] {
  const v = nicView(world, pc);
  const l: string[] = [];
  l.push(v.linkUp ? 'en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500' : 'en0: flags=8823<UP,BROADCAST,SMART,SIMPLEX,MULTICAST> mtu 1500');
  l.push('\toptions=6460<TSO4,TSO6,CHANNEL_IO,PARTIAL_CSUM,ZEROINVERT_CSUM>');
  l.push(`\tether ${macColon(macBytes(pc.nic.mac))}`);
  const a = v.address && v.mask ? { address: v.address, mask: v.mask } : v.apipa;
  if (a) l.push(`\tinet ${a.address} netmask ${hexMask(a.mask)} broadcast ${bcast(a.address, a.mask)}`);
  l.push(v.linkUp ? '\tmedia: autoselect (1000baseT <full-duplex>)' : '\tmedia: autoselect (none)');
  l.push(`\tstatus: ${v.linkUp ? 'active' : 'inactive'}`);
  return l;
}

function ifconfig(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  const lo0 = ['lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384', '\toptions=1203<RXCSUM,TXCSUM,TXSTATUS,SW_TIMESTAMP>', '\tinet 127.0.0.1 netmask 0xff000000'];
  if (args.length === 0 || (args.length === 1 && args[0] === '-a')) return out([...lo0, ...en0Lines(world, pc)].join('\n'));
  const ifName = args[0];
  if (ifName.startsWith('-')) return out('usage: ifconfig [-L] [-r] interface address_family [address [dest_address]]\n                [parameters]\n       ifconfig interface create\n       ifconfig -a [-L] [-d] [-m] [-r] [-u] [-v] [address_family]\n       ifconfig -l [-d] [-u] [address_family]\n       ifconfig [-L] [-d] [-m] [-r] [-u] [-v]');
  if (ifName !== 'en0' && ifName !== 'lo0') return out(`ifconfig: interface ${ifName} does not exist`);
  if (args.length > 1) return out('ifconfig: ioctl (SIOCAIFADDR): Operation not permitted\n(Simulator: change the address in the PC network settings panel, or use sudo ipconfig set en0 DHCP.)');
  return out((ifName === 'lo0' ? lo0 : en0Lines(world, pc)).join('\n'));
}

const IPCONFIG_USAGE = 'usage: ipconfig <command> <args>\nwhere <command> is one of waitall, getifaddr, ifcount, getoption, getpacket, getv6packet, getsummary, set, setverbose';

function ipconfig(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  const sub = args[0];
  const v = nicView(world, pc);
  const addr = v.address ?? v.apipa?.address;
  if (sub === 'getifaddr') {
    if (!args[1]) return out(IPCONFIG_USAGE);
    return out(args[1] === 'en0' && addr ? addr : '');
  }
  if (sub === 'ifcount') return out(v.linkUp ? '1' : '0');
  if (sub === 'getoption') {
    if (!args[1] || !args[2]) return out(IPCONFIG_USAGE);
    if (args[1] !== 'en0' || !v.address) return out('');
    const opt = args[2];
    const value = opt === 'router' ? v.gateway : opt === 'subnet_mask' ? v.mask : opt === 'server_identifier' ? v.dhcpServer : opt === 'domain_name_server' ? v.dns : undefined;
    return out(value ?? '');
  }
  if (sub === 'set') {
    const ifName = args[1];
    const method = (args[2] ?? '').toUpperCase();
    if (!ifName || !method) return out(IPCONFIG_USAGE);
    if (ifName !== 'en0') return out(`ipconfig: set ${ifName} ${args[2]} failed, No such interface`);
    if (method !== 'DHCP') return out(`(Simulator: only "sudo ipconfig set en0 DHCP" is simulated. Set a fixed address in the PC network settings panel.)`);
    // Switch the adapter to DHCP (it may have had a manual address) and ask for a lease. Prints nothing, like macOS.
    if (pc.nic.mode !== 'dhcp') {
      pc.nic.mode = 'dhcp';
      delete pc.nic.address;
      delete pc.nic.mask;
      delete pc.nic.gateway;
      delete pc.nic.dns;
      delete pc.nic.dhcpServer;
    }
    if (!v.linkUp) return { output: '' };
    const r = dhcpAcquire(world, pc.id);
    return { output: '', delayMs: r.ok ? 1200 : MAX_WAIT };
  }
  return out(IPCONFIG_USAGE);
}

// ───────────────────────────── ping ─────────────────────────────
const PING_USAGE = [
  'usage: ping [-AaDdfnoQqRrv] [-c count] [-G sweepmaxsize]',
  '            [-g sweepminsize] [-h sweepincrsize] [-i wait]',
  '            [-l preload] [-M mask | time] [-m ttl] [-p pattern]',
  '            [-S src_addr] [-s packetsize] [-t timeout][-W waittime]',
  '            [-z tos] host',
  '       ping [-AaDdfLnoQqRrv] [-c count] [-I iface] [-i wait]',
  '            [-l preload] [-M mask | time] [-m ttl] [-p pattern] [-S src_addr]',
  '            [-s packetsize] [-T ttl] [-t timeout] [-W waittime]',
  '            [-z tos] mcast-group',
].join('\n');

/** IP header dump that BSD ping prints under an ICMP error. Values are derived deterministically from the probe. */
function ipDump(pc: PcDevice, target: string, size: number, seq: number): string[] {
  const src = pc.nic.address ?? '0.0.0.0';
  const id = (hash32(`${pc.id}|${target}|${seq}`) & 0xffff).toString(16).padStart(4, '0');
  const cks = (hash32(`${target}|${seq}|cks`) & 0xffff).toString(16).padStart(4, '0');
  const len = (size + 28).toString(16).padStart(4, '0');
  return [
    'Vr HL TOS  Len   ID Flg  off TTL Pro  cks      Src      Dst',
    ` 4  5  00 ${len} ${id}   0 0000  3f  01 ${cks} ${src}  ${target} `,
    '',
  ];
}

function ping(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  let count: number | null = null;
  let size = 56;
  let quiet = false;
  let target: string | undefined;
  const withValue = new Set(['c', 's', 't', 'i', 'W', 'm', 'S', 'I', 'T', 'l', 'p', 'z', 'G', 'g', 'h', 'M', 'b', 'k', 'K']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-') && a.length > 1) {
      const flag = a[1];
      if (withValue.has(flag)) {
        const v = a.length > 2 ? a.slice(2) : args[++i];
        if (v === undefined) return out(`ping: option requires an argument -- ${flag}\n${PING_USAGE}`);
        if (flag === 'c') {
          const n = intArg(v, 1, 2147483647);
          if (n === null) return out(`ping: invalid count of packets to transmit: \`${v}'`);
          count = n;
        } else if (flag === 's') {
          const n = intArg(v, 0, 65507);
          if (n === null) return out(`ping: invalid packet size: \`${v}'`);
          size = n;
        }
        continue;
      }
      for (const f of a.slice(1)) {
        if (!'AaDdfnoQqRrvL'.includes(f)) return out(`ping: illegal option -- ${f}\n${PING_USAGE}`);
        if (f === 'q') quiet = true;
      }
      continue;
    }
    if (target === undefined) target = a;
    else return out(PING_USAGE);
  }
  if (target === undefined) return out(PING_USAGE);
  if (!isAddr(target)) return out(`ping: cannot resolve ${target}: Unknown host`, { delayMs: 600 });
  const interrupted = count === null;
  let n = count ?? DEFAULT_PROBES;
  const capped = n > MAX_PROBES;
  if (capped) n = MAX_PROBES;
  const bytes = size + 28;
  const rows: string[] = [`PING ${target} (${target}): ${size} data bytes`];
  const times: number[] = [];
  let delay = 0;
  for (let i = 0; i < n; i++) {
    const r: ProbeResult = pingOnce(world, pc, target, bytes);
    const lastProbe = i === n - 1;
    const timeoutLine = () => { if (!lastProbe) rows.push(`Request timeout for icmp_seq ${i}`); };
    switch (r.kind) {
      case 'reply': {
        const ms = r.rtt + ((hash32(`${target}|${i}`) % 200) / 1000);
        times.push(ms);
        if (!quiet) rows.push(`${size + 8} bytes from ${r.from}: icmp_seq=${i} ttl=${r.ttl} time=${ms.toFixed(3)} ms`);
        delay += 250;
        break;
      }
      case 'unreach': {
        const what = r.code === 'admin' ? 'Communication prohibited by filter' : r.code === 'net' ? 'Destination Net Unreachable' : r.code === 'port' ? 'Destination Port Unreachable' : 'Destination Host Unreachable';
        if (!quiet) rows.push(`${size + 36} bytes from ${r.from}: ${what}`, ...ipDump(pc, target, size, i));
        delay += 250;
        break;
      }
      case 'ttl':
        if (!quiet) rows.push(`${size + 36} bytes from ${r.from}: Time to live exceeded`, ...ipDump(pc, target, size, i));
        delay += 250;
        break;
      case 'local':
        if (!quiet) { rows.push('ping: sendto: No route to host'); timeoutLine(); }
        delay += 150;
        break;
      case 'arp':
        if (!quiet) { if (i > 0) rows.push('ping: sendto: Host is down'); timeoutLine(); }
        delay += 600;
        break;
      default:
        if (!quiet) timeoutLine();
        delay += 600;
    }
  }
  if (interrupted) rows.push('^C');
  rows.push('');
  rows.push(`--- ${target} ping statistics ---`);
  const recv = times.length;
  const loss = ((n - recv) * 100) / n;
  rows.push(`${n} packets transmitted, ${recv} packets received, ${loss.toFixed(1)}% packet loss`);
  if (recv > 0) {
    const min = Math.min(...times);
    const max = Math.max(...times);
    const avg = times.reduce((s, t) => s + t, 0) / recv;
    const sd = Math.sqrt(times.reduce((s, t) => s + (t - avg) ** 2, 0) / recv);
    rows.push(`round-trip min/avg/max/stddev = ${min.toFixed(3)}/${avg.toFixed(3)}/${max.toFixed(3)}/${sd.toFixed(3)} ms`);
  }
  if (interrupted) rows.push(`(Simulator: macOS ping runs until you press Ctrl+C. It was stopped after ${DEFAULT_PROBES} packets. Use ping -c 4 ${target} to choose the count.)`);
  if (capped) rows.push(`(Simulator: only the first ${MAX_PROBES} packets are sent.)`);
  return out(rows.join('\n'), { delayMs: capDelay(delay) });
}

// ───────────────────────────── traceroute ─────────────────────────────
function traceroute(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  let maxHops = 64;
  let numeric = false;
  let icmp = false;
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-') && a.length > 1) {
      const f = a[1];
      if ('mwqpfszgiMPS'.includes(f)) {
        const v = a.length > 2 ? a.slice(2) : args[++i];
        if (v === undefined) return out(`traceroute: option requires an argument -- ${f}`);
        if (f === 'm') {
          const n = intArg(v, 1, 255);
          if (n === null) return out(`traceroute: max ttl must be 1 to 255`);
          maxHops = n;
        }
        continue;
      }
      for (const c of a.slice(1)) {
        if (c === 'n') numeric = true;
        else if (c === 'I') icmp = true;
        else if (!'adDeFlrSvx'.includes(c)) return out(`traceroute: illegal option -- ${c}\nUsage: traceroute [-adDeFInrSvx] [-A as_server] [-f first_ttl] [-g gateway] [-i iface]\n\t[-M first_ttl] [-m max_ttl] [-p port] [-P proto] [-q nqueries] [-s src_addr]\n\t[-t tos] [-w waittime] [-z pausemsecs] host [packetlen]`);
      }
      continue;
    }
    if (target === undefined) target = a;
  }
  if (target === undefined) return out('Usage: traceroute [-adDeFInrSvx] [-A as_server] [-f first_ttl] [-g gateway] [-i iface]\n\t[-M first_ttl] [-m max_ttl] [-p port] [-P proto] [-q nqueries] [-s src_addr]\n\t[-t tos] [-w waittime] [-z pausemsecs] host [packetlen]');
  if (!isAddr(target)) return out(`traceroute: unknown host ${target}`, { delayMs: 600 });
  const t = traceFrom(world, pc, target, icmp ? 'icmp' : 'udp', maxHops, 52);
  if (t.local) return out('traceroute: findsaddr: failed to connect to peer for src addr selection.');
  const rows: string[] = [`traceroute to ${target} (${target}), ${maxHops} hops max, 52 byte packets`];
  let delay = 0;
  if (t.arpSelf) {
    for (let k = 1; k <= 3; k++) rows.push(`${padL(k, 2)}  * * *`);
    rows.push(`(Simulator: traceroute stops after three silent hops here. The real command keeps trying up to ${maxHops} hops; press Ctrl+C to stop it.)`);
    return out(rows.join('\n'), { delayMs: MAX_WAIT });
  }
  for (const h of t.hops) {
    if (h.symbol === '*' || !h.address) {
      rows.push(`${padL(h.ttl, 2)}  * * *`);
      delay += 900;
      continue;
    }
    const mark = h.symbol === '!' ? '' : h.symbol === '!A' ? ' !X' : ` ${h.symbol}`;
    const times = [0, 1, 2].map((k) => `${(h.rtt + ((hash32(`${h.address}|${k}`) % 150) / 1000)).toFixed(3)} ms${mark}`);
    const who = numeric ? h.address : `${h.address} (${h.address})`;
    rows.push(`${padL(h.ttl, 2)}  ${who}  ${times.join('  ')}`);
    delay += 150;
  }
  const last = t.hops[t.hops.length - 1];
  if (!t.reached && last && last.symbol === '*' && t.hops.length < maxHops) {
    rows.push(`(Simulator: traceroute stops after three silent hops here. The real command keeps trying up to ${maxHops} hops; press Ctrl+C to stop it.)`);
  }
  return out(rows.join('\n'), { delayMs: capDelay(delay) });
}

// ───────────────────────────── telnet / nc / ftp ─────────────────────────────
function telnet(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  const pos = args.filter((a) => !a.startsWith('-'));
  if (pos.length === 0) return out('telnet> \n(Simulator: the interactive telnet> prompt is not simulated. Type telnet <address> [port].)');
  const host = pos[0];
  const portText = pos[1] ?? '23';
  if (!isAddr(host)) return out(`telnet: could not resolve ${host}/${portText}: nodename nor servname provided, or not known`, { delayMs: 600 });
  const port = parsePort(portText);
  if (port === null || port === 0) return out(`telnet: could not resolve ${host}/${portText}: nodename nor servname provided, or not known`);
  const c = tcpConnect(world, pc, host, port);
  if (c.kind === 'open') {
    if (c.isIos && c.vty?.accepted && port === 23) {
      return { output: '', telnet: { deviceId: c.deviceId, remoteAddr: c.remoteAddr, host, port } };
    }
    const banner = c.isIos ? [`(Simulator: ${deviceLabel(world, c.deviceId)} answered the TCP probe on port ${port}.)`] : pcServerBanner(world, c.deviceId, port, host);
    return out([`Trying ${host}...`, `Connected to ${host}.`, "Escape character is '^]'.", ...banner, 'Connection closed by foreign host.'].join('\n'), { delayMs: 600 });
  }
  const why = c.kind === 'refused' ? 'Connection refused' : c.kind === 'local' ? 'Network is unreachable' : 'Operation timed out';
  return out([`Trying ${host}...`, `telnet: connect to address ${host}: ${why}`, 'telnet: Unable to connect to remote host'].join('\n'), {
    delayMs: capDelay(c.kind === 'timeout' ? MAX_WAIT : c.kind === 'refused' ? 600 : 150),
  });
}

const NC_USAGE = 'usage: nc [-46AacCDdEFhklMnOortUuvz] [-K tc] [-b boundif] [-i interval] [-p source_port]\n\t  [--apple-delegate-pid pid] [--apple-delegate-uuid uuid]\n\t  [-s source_ip_address] [-w timeout] [-X proxy_version]\n\t  [-x proxy_address[:port]] [hostname] [port[s]]';

function nc(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  let verbose = false;
  let zero = false;
  let udp = false;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const f = a[k];
        if ('wGipsKbIOxX'.includes(f)) { if (k === a.length - 1) i++; break; }
        if (f === 'v') verbose = true;
        else if (f === 'z') zero = true;
        else if (f === 'u') udp = true;
        else if (!'46AacCDdEFhklMnOortU'.includes(f)) return out(`nc: illegal option -- ${f}\n${NC_USAGE}`);
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length < 2) return out(NC_USAGE);
  const host = pos[0];
  const portText = pos[1];
  if (!isAddr(host)) return out('nc: getaddrinfo: nodename nor servname provided, or not known', { delayMs: 600 });
  const port = parsePort(portText);
  if (port === null || port === 0) return out(`nc: port number invalid: ${portText}`);
  if (udp) return out(`(Simulator: nc -u is not simulated. UDP has no connection to test; use snmpget from the management station panel instead.)`);
  const c = tcpConnect(world, pc, host, port);
  const note = zero ? '' : '\n(Simulator: nc only tests the connection here; nothing is sent.)';
  if (c.kind === 'open') {
    const svc = TCP_SERVICE[port] ?? '*';
    return out((verbose ? `Connection to ${host} port ${port} [tcp/${svc}] succeeded!` : '') + note, { delayMs: 300 });
  }
  const why = c.kind === 'refused' ? 'Connection refused' : c.kind === 'local' ? 'Network is unreachable' : 'Operation timed out';
  return out((verbose ? `nc: connectx to ${host} port ${port} (tcp) failed: ${why}` : '') + note, { delayMs: capDelay(c.kind === 'timeout' ? MAX_WAIT : 300) });
}

function ftp(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  const pos = args.filter((a) => !a.startsWith('-'));
  if (pos.length === 0) return out('ftp> \n(Simulator: the interactive ftp> prompt is not simulated. Type ftp <address> to test an FTP server.)');
  const host = pos[0];
  if (!isAddr(host)) return out(`ftp: Can't lookup \`${host}:ftp': nodename nor servname provided, or not known`, { delayMs: 600 });
  const c = tcpConnect(world, pc, host, 21);
  if (c.kind === 'open') {
    return out([
      `Connected to ${host}.`,
      '220 Simulated FTP server',
      `(Simulator: the FTP server of ${deviceLabel(world, c.deviceId)} answers. Logging in and file transfer are not simulated, so ftp closes again.)`,
      '221 Goodbye.',
    ].join('\n'), { delayMs: 600 });
  }
  const why = c.kind === 'refused' ? 'Connection refused' : c.kind === 'local' ? 'Network is unreachable' : 'Operation timed out';
  return out(`ftp: Can't connect to \`${host}:21': ${why}\nftp: Can't connect to \`${host}:ftp'`, { delayMs: capDelay(c.kind === 'timeout' ? MAX_WAIT : 600) });
}

// ───────────────────────────── arp / netstat / DNS ─────────────────────────────
function arp(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  const usage = 'usage: arp [-n] [-i interface] hostname\n       arp [-n] [-i interface] [-l] -a\n       arp -d hostname [pub] [ifscope interface]\n       arp -d [-i interface] -a\n       arp -s hostname ether_addr [temp] [reject] [blackhole] [pub [only]] [ifscope interface]';
  const flags = args.filter((a) => a.startsWith('-')).join('');
  if (flags.includes('d') || flags.includes('s')) return out('arp: SIOCDELRT: Operation not permitted\n(Simulator: changing the ARP table is not simulated.)');
  if (!flags.includes('a')) return out(usage);
  const v = nicView(world, pc);
  if (!v.address || !v.mask) return { output: '' };
  const rows = neighbours(world, pc).map((n) => `? (${n.address}) at ${macColon(n.mac)} on en0 ifscope [ethernet]`);
  rows.push(`? (${bcast(v.address, v.mask)}) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]`);
  rows.push('? (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]');
  return out(rows.join('\n'));
}

/** BSD netstat style destination: natural (classful) masks print without /len, trailing .0 octets are dropped. */
function bsdNet(address: string, mask: string): string {
  const net = networkOf(address, mask);
  const len = maskToPrefix(mask);
  const parts = net.split('.');
  while (parts.length > 1 && parts[parts.length - 1] === '0') parts.pop();
  const short = parts.join('.');
  return mask === classfulMask(net) ? short : `${short}/${len}`;
}

function netstat(world: World, pc: PcDevice, args: string[]): PcCmdOut {
  const flags = args.join('');
  if (!flags.includes('r')) return out('Active Internet connections\nProto Recv-Q Send-Q  Local Address          Foreign Address        (state)');
  const v = nicView(world, pc);
  const row = (d: string, g: string, f: string, i: string, e = '') => `${padR(d, 19)}${padR(g, 19)}${padR(f, 20)}${padL(i, 5)}${e ? ' ' + padL(e, 6) : ''}`;
  const l: string[] = ['Routing tables', '', 'Internet:', 'Destination        Gateway            Flags               Netif Expire'];
  if (v.address && v.mask && v.gateway) l.push(row('default', v.gateway, 'UGScg', 'en0'));
  l.push(row('127', '127.0.0.1', 'UCS', 'lo0'));
  l.push(row('127.0.0.1', '127.0.0.1', 'UH', 'lo0'));
  if (v.address && v.mask) {
    l.push(row(bsdNet(v.address, v.mask), 'link#6', 'UCS', 'en0', '!'));
    if (v.gateway) l.push(row(`${v.gateway}/32`, 'link#6', 'UCS', 'en0', '!'));
    l.push(row(`${v.address}/32`, 'link#6', 'UCS', 'en0', '!'));
  } else if (v.apipa) {
    l.push(row('169.254', 'link#6', 'UCS', 'en0', '!'));
  }
  return out(l.join('\n'));
}

function dnsTool(world: World, pc: PcDevice, cmd: string, args: string[]): PcCmdOut {
  const v = nicView(world, pc);
  const name = args.find((a) => !a.startsWith('-') && !a.startsWith('@') && !a.startsWith('+'));
  if (!name) {
    if (cmd === 'host') return out('Usage: host [-aCdilrTvVw] [-c class] [-N ndots] [-t type] [-W time]\n            [-R number] [-m flag] [-p port] hostname [server]');
    if (cmd === 'nslookup') return out('> \n(Simulator: the interactive nslookup prompt is not simulated. There is no DNS server in this lab.)');
  }
  if (v.dns) sendFlow(world, { fromDeviceId: pc.id, dst: v.dns, proto: 'udp', dport: 53, app: { kind: 'generic', label: 'DNS query' } });
  return out(';; connection timed out; no servers could be reached', { delayMs: MAX_WAIT });
}

function help(): PcCmdOut {
  const rows: [string, string][] = [
    ['ifconfig [en0]', 'show the network settings of the adapter'],
    ['ipconfig getifaddr en0', 'print only the IP address'],
    ['sudo ipconfig set en0 DHCP', 'ask the DHCP server for a new address'],
    ['ping [-c 4] address', 'send echo requests'],
    ['traceroute address', 'show the routers on the way'],
    ['telnet address [port]', 'open a Telnet connection'],
    ['nc -vz address port', 'test any TCP port'],
    ['curl http://address/', 'ask a web server for a page (curl -I: headers only)'],
    ['ftp address', 'test an FTP server'],
    ['ssh address', 'probe TCP 22 (no SSH session)'],
    ['arp -a', 'show the ARP table'],
    ['netstat -rn', 'show the routing table'],
    ['clear', 'clear the screen'],
  ];
  return out(['(Simulator: zsh has no "help" command. These commands work in this terminal:)', ...rows.map(([c, t]) => `  ${padR(c, 28)}${t}`)].join('\n'));
}
