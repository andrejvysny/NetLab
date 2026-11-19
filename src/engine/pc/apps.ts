/**
 * Client programs that exist on both operating systems with (almost) the same output: curl, and the banners a
 * simulated PC server shows when a raw connection reaches it. Texts follow curl 8.x.
 */
import type { PcDevice, World } from '../types.ts';
import type { ConnResult } from './net.ts';
import { deviceLabel, tcpConnect } from './net.ts';
import type { PcCmdOut } from './util.ts';
import { capDelay, intArg, isAddr } from './util.ts';

type Os = 'windows' | 'macos';

/** The small page a simulated PC web server returns. */
export function httpBody(serverLabel: string, host: string): string {
  return [
    '<!DOCTYPE html>',
    '<html>',
    `<head><title>${serverLabel} test page</title></head>`,
    '<body>',
    '<h1>It works!</h1>',
    `<p>Simulated web server on ${serverLabel} (${host}).</p>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
export function httpHeaders(serverLabel: string, length: number): string[] {
  return [
    'HTTP/1.1 200 OK',
    `Server: SimHTTP/1.0 (${serverLabel})`,
    'Content-Type: text/html',
    `Content-Length: ${length}`,
    'Connection: close',
  ];
}

const CURL_FLAGS_NO_VALUE = new Set(['-I', '--head', '-i', '--include', '-v', '--verbose', '-s', '--silent', '-S', '--show-error', '-L', '--location', '-k', '--insecure', '-f', '--fail', '-4', '--ipv4']);
const CURL_FLAGS_VALUE = new Set(['-m', '--max-time', '--connect-timeout', '-o', '--output', '-A', '--user-agent', '-H', '--header', '-X', '--request', '-u', '--user']);

/** `curl [options] <url>`: an HTTP request over a real TCP connection through the simulated network. */
export function curl(world: World, pc: PcDevice, args: string[], os: Os): PcCmdOut {
  const end = os === 'windows' ? '\n\n' : '\n';
  let head = false;
  let include = false;
  let verbose = false;
  let silent = false;
  let url: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      return { output: 'Usage: curl [options...] <url>\n -d, --data <data>   HTTP POST data\n -f, --fail          Fail fast with no output on HTTP errors\n -h, --help <category> Get help for commands\n -i, --include       Include protocol response headers in the output\n -I, --head          Show document info only\n -o, --output <file> Write to file instead of stdout\n -O, --remote-name   Write output to a file named as the remote file\n -s, --silent        Silent mode\n -v, --verbose       Make the operation more talkative\n -V, --version       Show version number and quit' + end };
    }
    if (a.startsWith('-') && a.length > 1) {
      if (CURL_FLAGS_NO_VALUE.has(a)) {
        if (a === '-I' || a === '--head') head = true;
        if (a === '-i' || a === '--include') include = true;
        if (a === '-v' || a === '--verbose') verbose = true;
        if (a === '-s' || a === '--silent') silent = true;
        continue;
      }
      if (CURL_FLAGS_VALUE.has(a)) { i++; continue; }
      if (/^-[IivsSLkf]+$/.test(a)) { // combined short flags, e.g. -sI
        if (a.includes('I')) head = true;
        if (a.includes('i')) include = true;
        if (a.includes('v')) verbose = true;
        if (a.includes('s')) silent = true;
        continue;
      }
      return { output: `curl: option ${a}: is unknown\ncurl: try 'curl --help' for more information${end}` };
    }
    if (url === undefined) url = a;
  }
  if (url === undefined) return { output: `curl: no URL specified\ncurl: try 'curl --help' or 'curl --manual' for more information${end}` };
  const m = /^(?:([A-Za-z][A-Za-z0-9+.-]*):\/\/)?([^/:?#]*)(?::(\d*))?([/?#].*)?$/.exec(url);
  if (!m) return { output: `curl: (3) URL rejected: Malformed input to a URL function${end}` };
  const scheme = (m[1] ?? 'http').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return { output: `curl: (1) Protocol "${m[1]}" not supported${end}` };
  const host = m[2];
  if (!host) return { output: `curl: (3) URL rejected: No host part in the URL${end}` };
  const port = m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { output: `curl: (3) URL rejected: Port number was not a decimal number between 0 and 65535${end}` };
  const path = m[4] && m[4].startsWith('/') ? m[4] : '/';
  if (!isAddr(host)) return { output: `curl: (6) Could not resolve host: ${host}${end}`, delayMs: 600 };

  const conn: ConnResult = tcpConnect(world, pc, host, port);
  const trying = verbose ? `*   Trying ${host}:${port}...\n` : '';
  if (conn.kind !== 'open') {
    let code = 7;
    let why = 'Connection refused';
    let delay = 600;
    if (conn.kind === 'timeout') { code = 28; why = os === 'windows' ? 'Timed out' : 'Operation timed out'; delay = MAX_WAIT; }
    else if (conn.kind === 'local') { why = os === 'windows' ? "Couldn't connect to server" : 'Network is unreachable'; delay = 100; }
    const text = `curl: (${code}) Failed to connect to ${host} port ${port}: ${why}`;
    return { output: `${trying}${silent ? '' : text}${silent && !verbose ? '' : end}`, delayMs: capDelay(delay) };
  }
  const server = world.devices[conn.deviceId];
  const serverLabel = deviceLabel(world, conn.deviceId);
  const isWeb = !!server && server.kind === 'pc' && server.services.http && port === 80;
  if (!isWeb) {
    // Something accepted the connection, but it does not speak HTTP (FTP or Telnet server, router vty line).
    return { output: `${trying}${verbose ? `* Connected to ${host} (${host}) port ${port}\n` : ''}curl: (1) Received HTTP/0.9 when not allowed${end}`, delayMs: 300 };
  }
  const body = httpBody(serverLabel, host);
  const headers = httpHeaders(serverLabel, body.length);
  let out = '';
  if (verbose) {
    out += trying;
    out += `* Connected to ${host} (${host}) port ${port}\n`;
    out += `> ${head ? 'HEAD' : 'GET'} ${path} HTTP/1.1\n> Host: ${host}\n> User-Agent: curl/8.4.0\n> Accept: */*\n>\n`;
    out += headers.map((h) => `< ${h}`).join('\n') + '\n<\n';
    if (!head) out += body;
    out += `* Closing connection\n`;
  } else if (head) {
    out += headers.join('\n') + '\n\n';
  } else {
    if (include) out += headers.join('\n') + '\n\n';
    out += body;
  }
  if (os === 'windows') out += '\n';
  return { output: out, delayMs: 300 };
}

/** Longest wait for a connection that never answers (shown as a pause before the error). */
export const MAX_WAIT = 3000;

/** Greeting a simulated PC server sends when a raw TCP client (telnet, nc) connects to it. */
export function pcServerBanner(world: World, deviceId: string, port: number, host: string): string[] {
  const name = deviceLabel(world, deviceId);
  if (port === 21) return ['220 Simulated FTP server', `(Simulator: ${name} accepted the connection on TCP port 21. The FTP dialogue is not simulated.)`];
  if (port === 23) return [`Welcome to the simulated Telnet service on ${name}.`, `(Simulator: the Telnet connection to ${name} (${host}) works. Logging in to a PC is not simulated.)`];
  if (port === 80) return [`(Simulator: TCP port 80 on ${host} is open: the web server of ${name} accepted the connection.)`];
  return [`(Simulator: TCP port ${port} on ${host} is open: ${name} accepted the connection.)`];
}

// ───────────────────────────── ssh ─────────────────────────────
const SSH_USAGE = [
  'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface]',
  '           [-b bind_address] [-c cipher_spec] [-D [bind_address:]port]',
  '           [-E log_file] [-e escape_char] [-F configfile] [-I pkcs11]',
  '           [-i identity_file] [-J [user@]host[:port]] [-L address]',
  '           [-l login_name] [-m mac_spec] [-O ctl_cmd] [-o option] [-p port]',
  '           [-Q query_option] [-R address] [-S ctl_path] [-W host:port]',
  '           [-w local_tun[:remote_tun]] destination [command]',
].join('\n');

/** Shared by both prompts: parse an OpenSSH-like command and probe TCP 22 (or -p), without negotiating SSH. */
export function sshTest(world: World, pc: PcDevice, args: string[], os: 'windows' | 'macos'): PcCmdOut {
  const wrap = (t: string, extra: Omit<PcCmdOut, 'output'> = {}): PcCmdOut => ({ output: (t.endsWith('\n') ? t : t + '\n') + (os === 'windows' ? '\n' : ''), ...extra });
  let port = 22;
  let dest: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-p') {
      const n = intArg(args[i + 1], 1, 65535);
      if (n === null) return wrap(`Bad port '${args[i + 1] ?? ''}'`);
      port = n;
      i++;
      continue;
    }
    if (/^-[BbcDEeFIiJLlmOoQRSWw]$/.test(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    if (dest === undefined) dest = a;
  }
  if (dest === undefined) return wrap(SSH_USAGE);
  const host = dest.includes('@') ? dest.slice(dest.lastIndexOf('@') + 1) : dest;
  if (!isAddr(host)) {
    return wrap(`ssh: Could not resolve hostname ${host}: ${os === 'windows' ? 'No such host is known. ' : 'nodename nor servname provided, or not known'}`.trimEnd(), { delayMs: 600 });
  }
  const c = tcpConnect(world, pc, host, port);
  if (c.kind === 'open') {
    const who = deviceLabel(world, c.deviceId);
    return wrap(`(Simulator: ${who} (${host}) answered the TCP probe on port ${port}. No SSH session was opened (SSH is not simulated).)`, { delayMs: 600 });
  }
  const why = c.kind === 'refused' ? 'Connection refused' : c.kind === 'local' ? 'Network is unreachable' : os === 'windows' ? 'Connection timed out' : 'Operation timed out';
  const detail = c.kind === 'refused' && c.vty?.reason === 'ssh-not-modeled' ? `\n(Simulator: ${c.vty.text})` : '';
  return wrap(`ssh: connect to host ${host} port ${port}: ${why}${detail}`, { delayMs: capDelay(c.kind === 'timeout' ? MAX_WAIT : 600) });
}
