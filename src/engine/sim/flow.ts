/**
 * Flows: a request and its answer through the network (ping, TCP connection attempt, UDP request),
 * plus the things built on flows: traceroute, SNMP requests, syslog and SNMP traps.
 */
import type { AppData, Delivery, FlowSpec, IosDevice, PcDevice, World } from '../types.ts';
import { isIp } from '../ip.ts';
import { effectiveSnmpHosts, enabledSnmpTraps, hostAllowsSnmpTrap, MODELED_SNMP_TRAPS } from '../snmp.ts';
import { cloneWorld } from '../world.ts';
import type { Ctx, SimFlowResult, SimPacket, WalkResult } from './model.ts';
import { makeCtx } from './pipeline.ts';
import { explainNoRoute, lookupIn, ownAddresses, tableWith } from './routing.ts';
import { initialTtl, normalizeOid, oidLabel } from './services.ts';
import { describePacket, isIosDevice, isPcDevice, label, portText } from './text.ts';

// ───────────────────────────── request building ─────────────────────────────
function failed(deviceId: string, reason: Delivery['reason'], text: string, more?: string): Delivery {
  return {
    ok: false, reason, reasonText: more ? `${text} ${more}` : text, atDeviceId: deviceId, encrypted: false, qos: [],
    steps: [{ deviceId, stage: 'origin', feature: reason === 'no-route' ? 'routing' : 'interface', verdict: 'drop', text, detail: more }],
  };
}

function pickSource(ctx: Ctx, dev: IosDevice, spec: FlowSpec): { src: string } | { fail: Delivery } {
  const world = ctx.world;
  const own = ownAddresses(world, dev.id);
  if (spec.srcAddr) {
    const mine = own.find((a) => a.address === spec.srcAddr);
    if (!mine) return { fail: failed(dev.id, 'no-ip', `${dev.label} has no interface with the address ${spec.srcAddr}, so it cannot use it as the source.`) };
    if (!mine.up) return { fail: failed(dev.id, 'no-ip', `The source address ${spec.srcAddr} belongs to ${mine.iface} on ${dev.label}, and that interface is down.`) };
    return { src: spec.srcAddr };
  }
  if (own.some((a) => a.address === spec.dst && a.up)) return { src: spec.dst };
  if (!own.some((a) => a.up)) {
    const what = dev.kind === 'switch' ? 'Give its management interface (Vlan1) an address and enter "no shutdown".' : 'Configure an interface with "ip address" and "no shutdown".';
    return { fail: failed(dev.id, 'no-ip', `${dev.label} has no IP address on an active interface, so it cannot send packets.`, what) };
  }
  const route = lookupIn(tableWith(world, dev.id, ctx.routes), spec.dst);
  if (!route) {
    return { fail: failed(dev.id, 'no-route', `${dev.label} has no route to ${spec.dst}.`, explainNoRoute(world, dev.id, spec.dst)) };
  }
  const viaIf = dev.config.interfaces[route.resolved.iface]?.ip?.address;
  const src = viaIf ?? own.find((a) => a.up)?.address;
  if (!src) return { fail: failed(dev.id, 'no-ip', `${dev.label} has no IP address on an active interface, so it cannot send packets.`) };
  return { src };
}

/** Build the first packet of a flow. Source: spec.srcAddr, else the PC's address / the router's egress interface address. */
export function buildRequest(ctx: Ctx, spec: FlowSpec): { packet: SimPacket } | { fail: Delivery } {
  const built = buildRequestInner(ctx, spec);
  if ('fail' in built) {
    // No packet left the device; show what it would have looked like, with the source address still unknown.
    const header = describePacket({
      src: spec.srcAddr ?? '?', dst: spec.dst, proto: spec.proto, sport: spec.sport ?? 0, dport: spec.dport ?? 0,
      icmpType: 'echo', tcpSyn: true, ttl: 0, bytes: 0, app: spec.app,
    });
    for (const st of built.fail.steps) st.header ??= header;
  }
  return built;
}

function buildRequestInner(ctx: Ctx, spec: FlowSpec): { packet: SimPacket } | { fail: Delivery } {
  const world = ctx.world;
  const dev = world.devices[spec.fromDeviceId];
  if (!dev) return { fail: failed(spec.fromDeviceId, 'no-link', `There is no device ${spec.fromDeviceId}.`) };
  if (!isIp(spec.dst)) return { fail: failed(dev.id, 'no-route', `"${spec.dst}" is not an IPv4 address, so ${dev.label} cannot send to it.`) };
  let src: string;
  if (isPcDevice(dev)) {
    if (!dev.nic.address || !dev.nic.mask) {
      const text = dev.nic.mode === 'dhcp'
        ? `${dev.label} has no IP address yet: it did not get one from a DHCP server.`
        : `${dev.label} has no IP address: configure its network adapter first.`;
      return { fail: failed(dev.id, 'no-ip', text) };
    }
    src = dev.nic.address;
  } else if (isIosDevice(dev)) {
    const s = pickSource(ctx, dev, spec);
    if ('fail' in s) return s;
    src = s.src;
  } else {
    return { fail: failed(spec.fromDeviceId, 'no-ip', 'This device cannot send packets.') };
  }
  const index = Math.max(0, world.order.indexOf(dev.id));
  const ttl = initialTtl(dev as IosDevice | PcDevice);
  if (spec.proto === 'icmp') {
    const id = spec.sport ?? index + 1;
    return { packet: { src, dst: spec.dst, proto: 'icmp', icmpType: 'echo', sport: id, dport: id, ttl, bytes: spec.bytes ?? (dev.kind === 'pc' ? 60 : 100), app: spec.app } };
  }
  const sport = spec.sport ?? 49152 + index;
  if (spec.proto === 'tcp') {
    return { packet: { src, dst: spec.dst, proto: 'tcp', sport, dport: spec.dport ?? 0, tcpSyn: true, ttl, bytes: spec.bytes ?? 60, app: spec.app } };
  }
  return { packet: { src, dst: spec.dst, proto: 'udp', sport, dport: spec.dport ?? 0, ttl, bytes: spec.bytes ?? 120, app: spec.app } };
}

// ───────────────────────────── flow ─────────────────────────────
function whatWord(spec: FlowSpec): string {
  if (spec.proto === 'icmp') return 'ping';
  if (spec.proto === 'tcp') return `TCP connection to port ${portText(spec.dport, 'tcp')}`;
  if (spec.app?.kind === 'snmp') return spec.app.op === 'trap' ? 'SNMP trap' : `SNMP ${spec.app.op} request`;
  if (spec.app?.kind === 'syslog') return 'syslog message';
  return `UDP packet to port ${portText(spec.dport, 'udp')}`;
}

function conclude(ctx: Ctx, spec: FlowSpec, request: SimPacket, fwd: WalkResult): SimFlowResult {
  const world = ctx.world;
  const me = label(world, spec.fromDeviceId);
  const what = whatWord(spec);
  const f = fwd.delivery;
  const dest = f.atDeviceId ? label(world, f.atDeviceId) : spec.dst;
  const base = { forward: f, vty: fwd.vty };

  if (f.ok) {
    if (!fwd.reply || !fwd.responder) {
      return { ...base, ok: true, symbol: '!', outcome: 'ok', summary: `The ${what} from ${me} reaches ${dest} (${spec.dst}).` };
    }
    const rev = ctx.walk(fwd.responder, fwd.reply);
    const r = rev.delivery;
    const back = r.ok && r.atDeviceId === spec.fromDeviceId;
    if (!back) {
      const lostAt = r.atDeviceId && r.atDeviceId !== spec.fromDeviceId && r.ok ? ` It ended up at ${label(world, r.atDeviceId)} instead of ${me}.` : '';
      return {
        ...base, reverse: r, ok: false, symbol: '.', outcome: 'timeout',
        summary: `The ${what} from ${me} reaches ${dest}, but the answer is lost on the way back. ${r.reasonText ?? ''}${lostAt}`.trim(),
      };
    }
    const from = r.received?.src;
    const otherSource = from !== undefined && from !== request.dst;
    if (otherSource && spec.proto !== 'icmp') {
      // A TCP or UDP client only accepts an answer from the address it talked to.
      return {
        ...base, reverse: r, repliedFrom: from, ok: false, symbol: '.', outcome: 'timeout',
        summary: `The ${what} from ${me} reaches ${dest}, and an answer comes back, but from ${from} instead of ${request.dst}. ${me} does not accept it. The address is not translated the same way on the return path (check NAT).`,
      };
    }
    let summary: string;
    if (spec.proto === 'icmp' && otherSource) summary = `Ping from ${me} to ${spec.dst} gets an answer from ${dest}, but the answer comes from ${from}, not from ${spec.dst}. Address translation differs between the two directions (check NAT).`;
    else if (spec.proto === 'icmp') summary = `Ping from ${me} to ${spec.dst} works: ${dest} answers.`;
    else if (spec.proto === 'tcp') summary = fwd.vty ? fwd.vty.text : `${me} connects to ${spec.dst} on TCP port ${portText(spec.dport, 'tcp')}: ${dest} accepts the connection.`;
    else summary = `${dest} answers the ${what} from ${me}.`;
    return { ...base, reverse: r, repliedFrom: from, ok: true, symbol: '!', outcome: 'ok', summary };
  }

  // The request did not get through (or was refused). Something may still come back.
  const why = f.reasonText ?? `The ${what} from ${me} to ${spec.dst} is lost.`;
  if (fwd.reply && fwd.responder) { // TCP reset: the destination says "no"
    const rev = ctx.walk(fwd.responder, fwd.reply);
    const back = rev.delivery.ok && rev.delivery.atDeviceId === spec.fromDeviceId;
    return { ...base, reverse: rev.delivery, ok: false, symbol: '.', outcome: back ? 'refused' : 'timeout', summary: why };
  }
  if (fwd.icmpError && fwd.responder) {
    const rev = ctx.walk(fwd.responder, fwd.icmpError);
    const back = rev.delivery.ok && rev.delivery.atDeviceId === spec.fromDeviceId;
    if (back && fwd.icmpError.icmpType !== 'time-exceeded') {
      return { ...base, reverse: rev.delivery, ok: false, symbol: 'U', outcome: 'unreachable', unreachableFrom: rev.delivery.received?.src, summary: why };
    }
    return { ...base, reverse: rev.delivery, ok: false, symbol: '.', outcome: 'timeout', summary: why };
  }
  return { ...base, ok: false, symbol: '.', outcome: 'timeout', summary: why };
}

/** Run one flow inside an existing context (used by DHCP, syslog, traceroute). */
export function runFlow(ctx: Ctx, spec: FlowSpec): SimFlowResult {
  const built = buildRequest(ctx, spec);
  if ('fail' in built) {
    return { ok: false, symbol: '.', outcome: 'timeout', forward: built.fail, summary: built.fail.reasonText ?? 'The packet could not be sent.' };
  }
  const fwd = ctx.walk(spec.fromDeviceId, built.packet);
  return conclude(ctx, spec, built.packet, fwd);
}

// ───────────────────────────── syslog ─────────────────────────────
const SEVERITY_NAMES = ['emergencies', 'alerts', 'critical', 'errors', 'warnings', 'notifications', 'informational', 'debugging'];
function trapLevel(level: string | undefined): number {
  if (level === undefined) return 6;
  if (/^\d+$/.test(level)) return Number(level);
  const i = SEVERITY_NAMES.findIndex((n) => n.startsWith(level.toLowerCase()));
  return i < 0 ? 6 : i;
}

export function syslogBlockReason(dev: IosDevice, severity?: number): 'logging-off' | 'trap-off' | 'severity' | undefined {
  const log = dev.config.logging;
  if (log.extraLines?.includes('no logging on')) return 'logging-off';
  if (log.extraLines?.includes('no logging trap')) return 'trap-off';
  if (severity !== undefined && severity > trapLevel(log.trapLevel)) return 'severity';
}

const LOG_BUFFER_MAX = 1000;
function bufferLog(world: World, dev: IosDevice, severity: number, mnemonic: string, text: string): void {
  if (syslogBlockReason(dev) === 'logging-off') return;
  dev.runtime.logBuffer.push({ tick: world.tick, severity, mnemonic, text });
  if (dev.runtime.logBuffer.length > LOG_BUFFER_MAX) dev.runtime.logBuffer.splice(0, dev.runtime.logBuffer.length - LOG_BUFFER_MAX);
}

function sourceOf(world: World, dev: IosDevice, ifName: string | undefined): string | undefined {
  if (!ifName) return undefined;
  const a = ownAddresses(world, dev.id).find((x) => x.iface === ifName && x.up);
  return a?.address;
}

function notificationCollected(world: World, kind: 'syslog' | 'snmp', flow: SimFlowResult): boolean {
  const { ok, atDeviceId, received } = flow.forward;
  const at = world.devices[atDeviceId ?? ''];
  return ok && isPcDevice(at) && at.services.syslog && received?.app?.kind === kind && received.dport === (kind === 'syslog' ? 514 : 162);
}

function countNotification(ctx: Ctx, dev: IosDevice, kind: 'syslog' | 'snmp', host: string, flow: SimFlowResult): void {
  const notification = dev.runtime.notificationCounters ??= {};
  const counter = (notification[kind] ??= {})[host] ??= { attempts: 0, collected: 0 };
  counter.attempts++;
  if (notificationCollected(ctx.world, kind, flow)) counter.collected++;
}

function sendSyslog(ctx: Ctx, dev: IosDevice, severity: number, mnemonic: string, text: string): { host: string; flow: SimFlowResult }[] {
  const out: { host: string; flow: SimFlowResult }[] = [];
  const log = dev.config.logging;
  if (syslogBlockReason(dev, severity)) return out;
  const srcAddr = sourceOf(ctx.world, dev, log.sourceInterface);
  for (const host of log.hosts) {
    const flow = runFlow(ctx, { fromDeviceId: dev.id, srcAddr, dst: host, proto: 'udp', dport: 514, app: { kind: 'syslog', severity, mnemonic, text } });
    countNotification(ctx, dev, 'syslog', host, flow);
    out.push({ host, flow });
  }
  return out;
}

/** Notification traffic can hit a logging ACL itself; keep those messages local, never emit recursively. */
function bufferPendingLogs(ctx: Ctx): void {
  for (const l of ctx.logs.splice(0)) {
    const dev = ctx.world.devices[l.deviceId];
    if (isIosDevice(dev)) bufferLog(ctx.world, dev, l.severity, l.mnemonic, l.text);
  }
}

/** Send log messages raised by an ordinary flow. Logs from forwarding those notifications are only buffered. */
export function flushLogs(ctx: Ctx): void {
  for (const l of ctx.logs.splice(0)) {
    const dev = ctx.world.devices[l.deviceId];
    if (!isIosDevice(dev)) continue;
    bufferLog(ctx.world, dev, l.severity, l.mnemonic, l.text);
    sendSyslog(ctx, dev, l.severity, l.mnemonic, l.text);
  }
  bufferPendingLogs(ctx);
}

/**
 * A device logs a message: it goes into the local buffer and, when its severity is within `logging trap`,
 * as UDP 514 to every `logging` host from the `logging source-interface` address (default: the egress interface).
 */
export function emitSyslog(world: World, deviceId: string, severity: number, mnemonic: string, text: string): void {
  const dev = world.devices[deviceId];
  if (!isIosDevice(dev) || syslogBlockReason(dev) === 'logging-off') return;
  bufferLog(world, dev, severity, mnemonic, text);
  if (!dev.config.logging.hosts.length || syslogBlockReason(dev, severity)) return;
  const ctx = makeCtx(world);
  sendSyslog(ctx, dev, severity, mnemonic, text);
  bufferPendingLogs(ctx);
}

/**
 * Would a syslog message from this device reach its logging hosts right now? Runs on a copy of the world (nothing changes).
 * One entry per attempted `logging` host; `received` is true when a syslog server recorded the message.
 * If logging is off or the message is outside the severity threshold, there are no attempts.
 */
export function syslogProbe(world: World, deviceId: string, severity = 5): { host: string; received: boolean; seenFrom?: string; flow: SimFlowResult }[] {
  const copy = cloneWorld(world);
  const dev = copy.devices[deviceId];
  if (!isIosDevice(dev)) return [];
  const ctx = makeCtx(copy);
  return sendSyslog(ctx, dev, severity, 'SYS-5-CONFIG_I', 'Configured from console by console').map(({ host, flow }) => ({
    host, received: notificationCollected(copy, 'syslog', flow), seenFrom: flow.forward.received?.src, flow,
  }));
}

/**
 * Send configured SNMPv1/v2c-style traps (UDP 162) for a modeled event. Off/filtered/display-only entries
 * do not originate flows, increment counters or leave trace steps. Network failures on real attempts are visible.
 */
export function emitSnmpTrap(world: World, deviceId: string, trapType: string, text: string): SimFlowResult[] {
  const dev = world.devices[deviceId];
  if (!isIosDevice(dev)) return [];
  const name = trapType.trim().toLowerCase().replace(/\s+/g, ' ');
  const trap = MODELED_SNMP_TRAPS.find((t) => t === name || t === `snmp ${name}`);
  const snmp = dev.config.snmp;
  if (!trap || !enabledSnmpTraps(snmp).includes(trap)) return [];
  const hosts = effectiveSnmpHosts(snmp).filter((host) => hostAllowsSnmpTrap(host, trap));
  if (!hosts.length) return [];
  const ctx = makeCtx(world);
  const srcAddr = sourceOf(world, dev, snmp.trapSource);
  const out = hosts.map((h) => {
    const app: AppData = { kind: 'snmp', op: 'trap', community: h.community, oid: trap, value: text };
    const flow = runFlow(ctx, { fromDeviceId: dev.id, srcAddr, dst: h.address, proto: 'udp', dport: 162, app });
    countNotification(ctx, dev, 'snmp', h.address, flow);
    return flow;
  });
  bufferPendingLogs(ctx);
  return out;
}

// ───────────────────────────── public flows ─────────────────────────────
/** Send a request and its answer through the network. Mutates runtime state (counters, NAT table, SAs, logs). */
export function sendFlow(world: World, spec: FlowSpec): SimFlowResult {
  const ctx = makeCtx(world);
  const result = runFlow(ctx, spec);
  flushLogs(ctx);
  return result;
}

/** Same as sendFlow, on a copy of the world: nothing in `world` changes. */
export function probeFlow(world: World, spec: FlowSpec): SimFlowResult {
  return sendFlow(cloneWorld(world), spec);
}

// ───────────────────────────── traceroute ─────────────────────────────
export interface TracerouteHop {
  ttl: number;
  /** Address that answered for this hop (as the sender sees it). */
  address?: string;
  /** '!' = this hop answered; '*' = no answer; '!H' host unreachable, '!N' network unreachable, '!A' administratively prohibited. */
  symbol: string;
}
export interface TracerouteOptions {
  /** Default 30. */
  maxTtl?: number;
  /** Source address for a router (must be one of its own). */
  srcAddr?: string;
  /** Probe type. Default: UDP to a high port from routers (IOS), ICMP echo from PCs (Windows tracert). */
  proto?: 'udp' | 'icmp';
  /** true: work on a copy of the world, nothing is counted. Default false (the probes are real packets). */
  probe?: boolean;
}

/**
 * Hop-by-hop path discovery with rising TTL. Stops when the destination answers, when an unreachable message comes back,
 * or after three silent hops in a row.
 */
export function traceroute(world: World, fromDeviceId: string, dst: string, opts: TracerouteOptions = {}): { hops: TracerouteHop[]; reached: boolean } {
  const w = opts.probe ? cloneWorld(world) : world;
  const ctx = makeCtx(w);
  const dev = w.devices[fromDeviceId];
  const hops: TracerouteHop[] = [];
  if (!dev) return { hops, reached: false };
  const proto = opts.proto ?? (dev.kind === 'pc' ? 'icmp' : 'udp');
  const max = opts.maxTtl ?? 30;
  let reached = false;
  let silent = 0;
  for (let ttl = 1; ttl <= max; ttl++) {
    const spec: FlowSpec = { fromDeviceId, srcAddr: opts.srcAddr, dst, proto, dport: proto === 'udp' ? 33433 + ttl : undefined };
    const built = buildRequest(ctx, spec);
    let hop: TracerouteHop = { ttl, symbol: '*' };
    let stop = false;
    if (!('fail' in built)) {
      const fwd = ctx.walk(fromDeviceId, { ...built.packet, ttl });
      const answer = fwd.delivery.ok ? fwd.reply : (fwd.icmpError ?? fwd.reply);
      if (fwd.delivery.ok && !fwd.reply) {
        hop = { ttl, address: dst, symbol: '!' };
        reached = true;
      } else if (answer && fwd.responder) {
        const rev = ctx.walk(fwd.responder, answer);
        if (rev.delivery.ok && rev.delivery.atDeviceId === fromDeviceId) {
          const address = rev.delivery.received?.src;
          if (fwd.delivery.ok || fwd.delivery.reason === 'port-closed' || fwd.delivery.reason === 'service-denied') {
            hop = { ttl, address, symbol: '!' };
            reached = true;
          } else if (fwd.delivery.reason === 'ttl-expired') {
            hop = { ttl, address, symbol: '!' };
          } else {
            const symbol = fwd.delivery.reason === 'acl-in' || fwd.delivery.reason === 'acl-out' ? '!A' : fwd.delivery.reason === 'no-route' ? '!H' : '!N';
            hop = { ttl, address, symbol };
            stop = true;
          }
        }
      }
    }
    hops.push(hop);
    silent = hop.symbol === '*' ? silent + 1 : 0;
    if (reached || stop || silent >= 3) break;
  }
  flushLogs(ctx);
  return { hops, reached };
}

// ───────────────────────────── SNMP ─────────────────────────────
/**
 * SNMP get/set from a management station (or any device) to `req.host`. `ok` = a response without error came back.
 * `text` reads like a command-line SNMP tool: 'sysName.0 = STRING: R1' or 'Timeout: No Response from 60.50.30.2'.
 */
export function snmpRequest(
  world: World, fromDeviceId: string, req: { host: string; community: string; op: 'get' | 'set'; oid: string; value?: string },
): { ok: boolean; text: string; flow: SimFlowResult } {
  const oid = normalizeOid(req.oid);
  const flow = sendFlow(world, {
    fromDeviceId, dst: req.host, proto: 'udp', dport: 161,
    app: { kind: 'snmp', op: req.op, community: req.community, oid, value: req.value },
  });
  const app = flow.reverse?.received?.app;
  if (!flow.ok || !app || app.kind !== 'snmp' || app.op !== 'response') {
    return { ok: false, text: `Timeout: No Response from ${req.host}`, flow };
  }
  if (app.error) {
    const reason = app.error === 'notWritable' ? '(notWritable) That object does not support modification'
      : app.error === 'noAccess' ? '(noAccess) The MIB view does not allow access to this object.'
        : '(noSuchName) There is no such variable name in the accessible MIB.';
    return { ok: false, text: `Error in packet.\nReason: ${reason}\nFailed object: ${oidLabel(oid)}`, flow };
  }
  return { ok: true, text: `${oidLabel(oid)} = ${app.value ?? ''}`, flow };
}
