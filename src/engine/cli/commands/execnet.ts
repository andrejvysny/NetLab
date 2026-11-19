/**
 * ping, traceroute, telnet and ssh from the IOS CLI. Every probe is a real flow through the simulation (sendFlow /
 * traceroute), so it creates NAT entries, IPsec SAs and moves the ACL / QoS / interface counters like real traffic.
 *
 * ping <ip> [repeat n] [size n] [timeout s] [source <if>|<ip>]   (options in any order)
 * ping                                                             extended-ping dialogue (privileged EXEC)
 * traceroute <ip> [source <if>|<ip>] / traceroute                  (dialogue)
 * telnet <ip> [<port>] / ssh -l <user> <ip>                        TCP probes; no SSH negotiation or router terminal sessions
 *
 * Pending-input kinds registered here: 'ping-ext', 'trace-ext'. No session.ctx keys.
 */
import type { CmdEnv, CommandDef, ModeName, PendingInput } from '../framework.ts';
import { registerCommands, registerPending } from '../framework.ts';
import type { FlowResult, World } from '../../types.ts';
import { isIp, parseIfName } from '../../ip.ts';
import { ownAddresses, probeFlow, sendFlow, serialClock, traceroute } from '../../sim/index.ts';
import type { SimFlowResult } from '../../sim/index.ts';
import { existingIf, normIf } from '../show/util.ts';

const U: ModeName[] = ['user', 'priv'];
const H: Record<string, string> = {
  ping: 'Send echo messages',
  traceroute: 'Trace route to destination',
  telnet: 'Open a telnet connection',
  ssh: 'Probe the TCP path (no SSH session is simulated)',
  ip: 'IP echo',
  repeat: 'specify repeat count',
  size: 'specify datagram size',
  timeout: 'specify timeout interval',
  source: 'specify source address or name',
  '-l': 'Specify the SSH client user name',
  '<dst>': 'Ping destination address or hostname',
  '<host>': 'Ping destination address or hostname',
  '<rep>': 'Repeat count',
  '<size>': 'Datagram size',
  '<tmo>': 'Timeout in seconds',
  '<srcif>': 'Interface name',
  '<srcip>': 'Source address',
  '<port>': 'Port number',
  '<user>': 'User name',
};
export const ROUTER_SESSION_NOTE = 'Router-to-router terminal sessions are not simulated. Use a PC to telnet into a router.';

// ───────────────────────────── helpers ─────────────────────────────
/** `ip host NAME a.b.c.d` from the configuration. */
function hostTable(env: CmdEnv, name: string): string | undefined {
  for (const l of env.device.config.extraLines) {
    const m = /^ip host (\S+)\s+(?:\d+\s+)?(\d+\.\d+\.\d+\.\d+)/.exec(l);
    if (m && m[1].toLowerCase() === name.toLowerCase()) return m[2];
  }
  return undefined;
}
/** Resolve a host-name argument like IOS: host table first, then the (simulated, failing) DNS lookup. */
function resolveName(env: CmdEnv, name: string, failText: string): string | null {
  const hit = hostTable(env, name);
  if (hit) return hit;
  if (env.device.config.ipDomainLookup) {
    env.print(`Translating "${name}"...domain server (255.255.255.255)`);
    env.delay(6000);
  }
  env.print(failText);
  return null;
}
const INVALID_SOURCE = '% Invalid source. Must use same-VRF IP address or full interface name without spaces (e.g. Serial0/1)';

/** Source option: an own address or an interface with an address. Returns the address, or null after printing the error. */
function sourceAddress(env: CmdEnv, a: Record<string, unknown>, after: number): { addr?: string } | null {
  if (a.srcip !== undefined) {
    const ip = String(a.srcip);
    if (!ownAddresses(env.world, env.device.id).some((x) => x.address === ip)) { env.print(INVALID_SOURCE); return null; }
    return { addr: ip };
  }
  if (a.srcif !== undefined) {
    const name = existingIf(env, String(a.srcif), after);
    const ip = env.device.config.interfaces[name]?.ip?.address;
    if (!ip) { env.print(INVALID_SOURCE); return null; }
    return { addr: ip };
  }
  return {};
}

/** Round-trip time of one answered probe, ms: serialisation on serial links (ESP overhead included) plus ~1 ms of switching. */
function rttMs(world: World, r: FlowResult, size: number): number {
  let ms = 1;
  for (const d of [r.forward, r.reverse]) {
    if (!d) continue;
    for (const st of d.steps) {
      if (st.stage !== 'egress' || !st.iface || !st.iface.startsWith('Serial')) continue;
      const clk = serialClock(world, st.deviceId, st.iface)?.effective ?? 2000000;
      const bytes = size + 4 + (st.header?.startsWith('ESP') ? 56 : 0);
      ms += (bytes * 8 * 1000) / clk;
    }
  }
  return Math.max(1, Math.round(ms));
}

// ───────────────────────────── ping ─────────────────────────────
interface PingOpts { dst: string; repeat: number; size: number; timeout: number; srcAddr?: string }
/** Send the probes and print the IOS ping report. */
export function runPing(env: CmdEnv, o: PingOpts): { sent: number; ok: number; symbols: string } {
  env.print('Type escape sequence to abort.');
  env.print(`Sending ${o.repeat}, ${o.size}-byte ICMP Echos to ${o.dst}, timeout is ${o.timeout} seconds:`);
  if (o.srcAddr) env.print(`Packet sent with a source address of ${o.srcAddr} `);
  const max = Math.min(o.repeat, 1000);
  let symbols = '';
  let ok = 0;
  let waited = 0;
  const rtts: number[] = [];
  for (let i = 0; i < max; i++) {
    const r: SimFlowResult = sendFlow(env.world, { fromDeviceId: env.device.id, srcAddr: o.srcAddr, dst: o.dst, proto: 'icmp', bytes: o.size });
    let sym: string = r.symbol;
    if (i === 0 && r.forward.negotiated) sym = '.'; // the first packet is lost while the IPsec SA is negotiated
    if (sym === 'U' && symbols.endsWith('U')) sym = '.'; // ICMP unreachables are rate-limited (one per 500 ms)
    if (sym === '!') {
      ok++;
      const t = rttMs(env.world, r, o.size) + ((i * 7) % 3 === 0 ? 1 : 0);
      rtts.push(t);
      waited += t;
    } else if (sym === '.') waited += o.timeout * 1000;
    else waited += 20;
    symbols += sym;
  }
  const lines: string[] = [];
  for (let i = 0; i < symbols.length; i += 70) lines.push(symbols.slice(i, i + 70));
  env.print(lines.join('\n') || '');
  const pct = Math.floor((ok * 100) / max);
  if (ok) {
    const min = Math.min(...rtts), mx = Math.max(...rtts);
    const avg = Math.round(rtts.reduce((s, x) => s + x, 0) / rtts.length);
    env.print(`Success rate is ${pct} percent (${ok}/${max}), round-trip min/avg/max = ${min}/${avg}/${mx} ms`);
  } else env.print(`Success rate is ${pct} percent (${ok}/${max})`);
  if (o.repeat > max) env.note(`The simulator sent only the first ${max} of the ${o.repeat} packets.`);
  env.delay(Math.min(waited, 120000));
  return { sent: max, ok, symbols };
}

/** All orders of the ping options (IOS accepts them in any order). */
function pingPatterns(prefix: string): string[] {
  const opts = ['repeat <rep:int(1-2147483647)>', 'size <size:int(36-18024)>', 'timeout <tmo:int(0-3600)>', 'SRC'];
  const out: string[] = [];
  const rec = (used: string[], rest: string[]) => {
    if (used.length) {
      const base = `${prefix} ${used.join(' ')}`;
      if (used.includes('SRC')) {
        out.push(base.replace('SRC', 'source <srcif:if>'), base.replace('SRC', 'source <srcip:ip>'));
      } else out.push(base);
    }
    for (const o of rest) rec([...used, o], rest.filter((x) => x !== o));
  };
  rec([], opts);
  return out;
}

function pingCommand(env: CmdEnv, a: Record<string, unknown>, dstIndex: number): void {
  let dst: string;
  if (a.dst !== undefined) dst = String(a.dst);
  else {
    const r = resolveName(env, String(a.host), '% Unrecognized host or address, or protocol not running.');
    if (!r) return;
    dst = r;
  }
  const src = sourceAddress(env, a, dstIndex + 1);
  if (!src) return;
  runPing(env, {
    dst, repeat: a.rep === undefined ? 5 : Number(a.rep), size: a.size === undefined ? 100 : Number(a.size),
    timeout: a.tmo === undefined ? 2 : Number(a.tmo), srcAddr: src.addr,
  });
}

// ───────────────────────────── dialogues (extended ping / traceroute) ─────────────────────────────
interface Step { key: string; prompt: string; check?: (env: CmdEnv, input: string, d: Record<string, unknown>) => { value?: unknown; error?: string; retry?: boolean; skipTo?: string } }
const yesNo = (dflt: boolean) => (_env: CmdEnv, input: string) => {
  const t = input.trim().toLowerCase();
  if (!t) return { value: dflt };
  if ('yes'.startsWith(t)) return { value: true };
  if ('no'.startsWith(t)) return { value: false };
  return { value: dflt };
};
const num = (dflt: number, lo: number, hi: number) => (_env: CmdEnv, input: string) => {
  const t = input.trim();
  if (!t) return { value: dflt };
  if (!/^\d+$/.test(t) || Number(t) < lo || Number(t) > hi) return { error: `% A decimal number between ${lo} and ${hi}.` };
  return { value: Number(t) };
};
const protocol = (_env: CmdEnv, input: string) => {
  const t = input.trim();
  if (!t || 'ip'.startsWith(t.toLowerCase())) return { value: 'ip' };
  return { error: `% Unknown protocol - "${t}", type "ping ?" for help` };
};
function target(env: CmdEnv, input: string): { value?: unknown; error?: string } {
  const t = input.trim();
  if (isIp(t)) return { value: t };
  if (t && /^[A-Za-z][\w.-]*$/.test(t)) {
    const hit = hostTable(env, t);
    if (hit) return { value: hit };
  }
  return { error: '% Bad IP address or host name' };
}
function source(env: CmdEnv, input: string): { value?: unknown; error?: string; retry?: boolean } {
  const t = input.trim();
  if (!t) return { value: undefined };
  if (isIp(t)) {
    if (ownAddresses(env.world, env.device.id).some((x) => x.address === t && x.up)) return { value: t };
    return { error: '% Invalid source address- IP address not on any of our up interfaces', retry: true };
  }
  const p = parseIfName(t);
  const name = p && 'name' in p ? normIf(p.name) : undefined;
  const ip = name ? env.device.config.interfaces[name]?.ip?.address : undefined;
  if (ip) return { value: ip };
  return { error: '% Invalid source address- IP address not on any of our up interfaces', retry: true };
}

const PING_STEPS: Step[] = [
  { key: 'proto', prompt: 'Protocol [ip]: ', check: protocol },
  { key: 'dst', prompt: 'Target IP address: ', check: target },
  { key: 'repeat', prompt: 'Repeat count [5]: ', check: num(5, 1, 2147483647) },
  { key: 'size', prompt: 'Datagram size [100]: ', check: num(100, 36, 18024) },
  { key: 'timeout', prompt: 'Timeout in seconds [2]: ', check: num(2, 0, 3600) },
  {
    key: 'ext', prompt: 'Extended commands [n]: ',
    check: (env, input) => { const r = yesNo(false)(env, input); return r.value ? r : { value: false, skipTo: 'sweep-end' }; },
  },
  { key: 'ingress', prompt: 'Ingress ping [n]: ', check: yesNo(false) },
  { key: 'src', prompt: 'Source address or interface: ', check: source },
  { key: 'tos', prompt: 'Type of service [0]: ', check: num(0, 0, 255) },
  { key: 'df', prompt: 'Set DF bit in IP header? [no]: ', check: yesNo(false) },
  { key: 'validate', prompt: 'Validate reply data? [no]: ', check: yesNo(false) },
  { key: 'pattern', prompt: 'Data pattern [0x0000ABCD]: ' },
  { key: 'options', prompt: 'Loose, Strict, Record, Timestamp, Verbose[none]: ' },
  { key: 'sweep', prompt: 'Sweep range of sizes [n]: ', check: yesNo(false) },
];
const TRACE_STEPS: Step[] = [
  { key: 'proto', prompt: 'Protocol [ip]: ', check: protocol },
  { key: 'dst', prompt: 'Target IP address: ', check: target },
  { key: 'ingress', prompt: 'Ingress traceroute [n]: ', check: yesNo(false) },
  { key: 'src', prompt: 'Source address: ', check: source },
  { key: 'dscp', prompt: 'DSCP Value [0]: ', check: num(0, 0, 63) },
  { key: 'numeric', prompt: 'Numeric display [n]: ', check: yesNo(false) },
  { key: 'timeout', prompt: 'Timeout in seconds [3]: ', check: num(3, 0, 3600) },
  { key: 'probes', prompt: 'Probe count [3]: ', check: num(3, 1, 65535) },
  { key: 'minttl', prompt: 'Minimum Time to Live [1]: ', check: num(1, 0, 255) },
  { key: 'maxttl', prompt: 'Maximum Time to Live [30]: ', check: num(30, 1, 255) },
  { key: 'port', prompt: 'Port Number [33434]: ', check: num(33434, 1025, 65535) },
  { key: 'options', prompt: 'Loose, Strict, Record, Timestamp, Verbose[none]: ' },
];

function dialogue(kind: string, steps: Step[], finish: (env: CmdEnv, d: Record<string, unknown>) => void) {
  return (env: CmdEnv, input: string, p: PendingInput): void => {
    const d = { ...(p.data ?? {}) } as Record<string, unknown>;
    const i = Number(d.__step ?? 0);
    const step = steps[i];
    const r = step.check ? step.check(env, input, d) : { value: input.trim() };
    if (r.error) {
      if (r.retry) env.ask({ kind, prompt: step.prompt, data: d });
      return env.reject(r.error);
    }
    d[step.key] = r.value;
    let next = i + 1;
    if (r.skipTo === 'sweep-end') next = steps.length;
    if (next >= steps.length) { finish(env, d); return; }
    d.__step = next;
    env.ask({ kind, prompt: steps[next].prompt, data: d });
  };
}

// ───────────────────────────── traceroute ─────────────────────────────
export function runTraceroute(env: CmdEnv, dst: string, opts: { srcAddr?: string; timeout?: number; probes?: number; maxTtl?: number } = {}): void {
  const probes = opts.probes ?? 3;
  const tmo = opts.timeout ?? 3;
  env.print('Type escape sequence to abort.');
  env.print(`Tracing the route to ${dst}`);
  env.print('VRF info: (vrf in name/id, vrf out name/id)');
  const res = traceroute(env.world, env.device.id, dst, { srcAddr: opts.srcAddr, maxTtl: opts.maxTtl ?? 30 });
  let waited = 0;
  const lastTtl = res.hops.length ? res.hops[res.hops.length - 1].ttl : 0;
  for (const hop of res.hops) {
    const ttl = String(hop.ttl).padStart(3);
    if (hop.symbol === '*' || !hop.address) {
      env.print(`${ttl} ${Array(probes).fill(' *').join('')} `);
      waited += tmo * 1000 * probes;
      continue;
    }
    if (hop.symbol !== '!') {
      const parts = Array.from({ length: probes }, (_, i) => (i % 2 === 0 ? hop.symbol : '*'));
      env.print(`${ttl} ${hop.address} ${parts.join('  ')} `);
      waited += Math.floor(probes / 2) * tmo * 1000;
      continue;
    }
    const probe = probeFlow(env.world, { fromDeviceId: env.device.id, srcAddr: opts.srcAddr, dst: hop.address, proto: 'icmp', bytes: 60 });
    const base = probe.ok ? rttMs(env.world, probe, 60) : hop.ttl * 4;
    const isRouterEnd = hop.ttl === lastTtl && res.reached && (() => {
      const owner = Object.values(env.world.devices).find((d) => d.kind !== 'pc' && Object.values(d.config.interfaces).some((c) => c.ip?.address === hop.address));
      return !!owner;
    })();
    const parts = Array.from({ length: probes }, (_, i) => {
      if (isRouterEnd && i === 1) return '*'; // port unreachables of a router are rate-limited
      return `${base + ((hop.ttl + i) % 3 === 0 ? 4 : 0)} msec`;
    });
    if (isRouterEnd) waited += tmo * 1000;
    env.print(`${ttl} ${hop.address} ${parts.join(' ').replace(/ \* /g, ' *  ')}`);
  }
  env.delay(Math.min(waited, 120000));
}

// ───────────────────────────── telnet / ssh ─────────────────────────────
function connect(env: CmdEnv, dst: string, port: number, service: 'telnet' | 'ssh'): void {
  const label = port === 23 ? dst : `${dst}, ${port}`;
  const r: SimFlowResult = sendFlow(env.world, { fromDeviceId: env.device.id, dst, proto: 'tcp', dport: port });
  const localFail = !r.ok && r.forward.atDeviceId === env.device.id && (r.forward.reason === 'no-route' || r.forward.reason === 'no-ip' || r.forward.reason === 'no-link');
  if (service === 'telnet') env.print(r.outcome === 'ok' ? `Trying ${label} ... Open` : `Trying ${label} ... `);
  if (localFail || r.outcome === 'unreachable') {
    env.print('% Destination unreachable; gateway or host down');
    return;
  }
  if (r.outcome === 'refused') {
    env.print('% Connection refused by remote host');
    if (r.vty?.reason === 'ssh-not-modeled') env.note(r.vty.text);
    return;
  }
  if (r.outcome === 'timeout') {
    env.print('% Connection timed out; remote host not responding');
    env.delay(30000);
    return;
  }
  // A TCP answer from a non-SSH listener (for example, ssh -p 23 to Telnet) is not an SSH session.
  if (service === 'ssh') {
    env.print(`TCP probe to ${dst} port ${port} succeeded. No SSH session was opened (SSH is not simulated).`);
    return;
  }
  const at = r.forward.atDeviceId ? env.world.devices[r.forward.atDeviceId] : undefined;
  const closed = `[Connection to ${dst} closed by foreign host]`;
  if (at && at.kind !== 'pc' && port === 23 && r.vty?.accepted) {
    const login = r.vty.login;
    if (login === 'password') env.print('\n\nUser Access Verification\n\nPassword: ');
    else if (login === 'password-not-set') env.print('\n\nPassword required, but none set\n\n');
    else if (login === 'local' || login === 'local-no-users') env.print('\n\nUser Access Verification\n\nUsername: ');
    else env.print(`\n\n${at.config.hostname}>`);
    env.print(closed);
    env.note(ROUTER_SESSION_NOTE);
    return;
  }
  env.print('');
  env.print(closed);
  env.note(`The connection to ${dst} port ${port} works. Terminal sessions from a router to this host are not simulated.`);
}

// ───────────────────────────── commands ─────────────────────────────
export const commands: CommandDef[] = [
  {
    modes: U, pattern: ['ping <dst:ip>', 'ping ip <dst:ip>', ...pingPatterns('ping <dst:ip>'), ...pingPatterns('ping ip <dst:ip>')],
    feature: 'verify', mutates: false, help: H,
    run(env, a) { pingCommand(env, a, env.has('ip') ? 2 : 1); },
  },
  {
    modes: U, pattern: ['ping <host:word>', ...pingPatterns('ping <host:word>')], feature: 'verify', mutates: false, help: H,
    run(env, a) { pingCommand(env, a, 1); },
  },
  {
    modes: 'priv', pattern: ['ping', 'ping ip'], feature: 'verify', mutates: false, help: H,
    run(env) { env.ask({ kind: 'ping-ext', prompt: PING_STEPS[0].prompt, data: { __step: 0 } }); },
  },
  {
    modes: U, pattern: ['traceroute <dst:ip>', 'traceroute <dst:ip> source <srcif:if>', 'traceroute <dst:ip> source <srcip:ip>', 'traceroute ip <dst:ip>', 'traceroute ip <dst:ip> source <srcif:if>', 'traceroute ip <dst:ip> source <srcip:ip>'],
    feature: 'verify', mutates: false, help: { ...H, '<dst>': 'Trace route to destination address or hostname' },
    run(env, a) {
      const src = sourceAddress(env, a, env.has('ip') ? 4 : 3);
      if (!src) return;
      runTraceroute(env, String(a.dst), { srcAddr: src.addr });
    },
  },
  {
    modes: U, pattern: 'traceroute <host:word>', feature: 'verify', mutates: false, help: { ...H, '<host>': 'Trace route to destination address or hostname' },
    run(env, a) {
      const r = resolveName(env, String(a.host), '% Unrecognized host or address, or protocol not running.');
      if (r) runTraceroute(env, r);
    },
  },
  {
    modes: 'priv', pattern: 'traceroute', feature: 'verify', mutates: false, help: H,
    run(env) { env.ask({ kind: 'trace-ext', prompt: TRACE_STEPS[0].prompt, data: { __step: 0 } }); },
  },
  {
    modes: U, pattern: ['telnet <dst:ip>', 'telnet <dst:ip> <port:int(1-65535)>'], feature: 'verify', mutates: false, help: { ...H, '<dst>': 'IP address or hostname of a remote system' },
    run(env, a) { connect(env, String(a.dst), a.port === undefined ? 23 : Number(a.port), 'telnet'); },
  },
  {
    modes: U, pattern: ['telnet <host:word>', 'telnet <host:word> <port:int(1-65535)>'], feature: 'verify', mutates: false, help: { ...H, '<host>': 'IP address or hostname of a remote system' },
    run(env, a) {
      const r = resolveName(env, String(a.host), '% Bad IP address or host name');
      if (r) connect(env, r, a.port === undefined ? 23 : Number(a.port), 'telnet');
    },
  },
  {
    modes: U, pattern: ['ssh -l <user:word> <dst:ip>', 'ssh -l <user:word> -p <port:int(1-65535)> <dst:ip>', 'ssh -v 2 -l <user:word> <dst:ip>'],
    feature: 'verify', mutates: false, help: { ...H, '-p': 'Connect to this port', '-v': 'Specify SSH Protocol Version', '<dst>': 'IP address or hostname of a remote system' },
    run(env, a) { connect(env, String(a.dst), a.port === undefined ? 22 : Number(a.port), 'ssh'); },
  },
];

export function install(): void {
  registerCommands(commands);
  registerPending('ping-ext', dialogue('ping-ext', PING_STEPS, (env, d) => {
    runPing(env, { dst: String(d.dst), repeat: Number(d.repeat ?? 5), size: Number(d.size ?? 100), timeout: Number(d.timeout ?? 2), srcAddr: d.src as string | undefined });
  }));
  registerPending('trace-ext', dialogue('trace-ext', TRACE_STEPS, (env, d) => {
    runTraceroute(env, String(d.dst), { srcAddr: d.src as string | undefined, timeout: Number(d.timeout ?? 3), probes: Number(d.probes ?? 3), maxTtl: Number(d.maxttl ?? 30) });
  }));
}
