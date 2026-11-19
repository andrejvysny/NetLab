/**
 * Network side of the PC prompt: every probe is a real flow through the simulation (sendFlow / traceroute /
 * dhcpAcquire), so it creates NAT entries, IPsec SAs and counters exactly like the real thing.
 * This file only turns flow results into neutral "what happened" records; the OS files print them.
 */
import type { PcDevice, TraceStep, World } from '../types.ts';
import { inSubnet } from '../ip.ts';
import type { SimFlowResult, VtyDecision } from '../sim/index.ts';
import { isUp, l2Reach, probeFlow, sendFlow, serialClock, traceroute } from '../sim/index.ts';
import type { NicView } from './util.ts';
import { deviceMac, nicView } from './util.ts';

/** Bytes of ESP overhead added on an encrypted link (tunnel header + ESP header/trailer + ICV), for timing only. */
const ESP_OVERHEAD = 58;

// ───────────────────────────── timing ─────────────────────────────
/** One-way time of a list of trace steps, ms: serial serialisation delay at the real clock rate + a little per hop. */
function stepsMs(world: World, steps: TraceStep[], bytes: number): number {
  let ms = 0.15;
  for (const s of steps) {
    if (s.stage === 'ingress') ms += 0.12;
    if (s.stage !== 'egress' || !s.iface) continue;
    const dev = world.devices[s.deviceId];
    const spec = dev?.ports.find((p) => p.name === s.iface);
    const size = bytes + (s.header?.startsWith('ESP') ? ESP_OVERHEAD : 0);
    if (spec?.kind === 'serial') {
      const clk = serialClock(world, s.deviceId, s.iface)?.effective ?? 2000000;
      ms += (size * 8 * 1000) / clk + 0.2;
    } else {
      ms += 0.05;
    }
  }
  return ms;
}

/** Round-trip time of a flow, ms (deterministic). */
export function flowRtt(world: World, flow: SimFlowResult, bytes: number): number {
  return stepsMs(world, flow.forward.steps, bytes) + (flow.reverse ? stepsMs(world, flow.reverse.steps, bytes) : 0);
}

/**
 * One-way delay to every router on the path to `dst` and to the destination itself, in path order (ms).
 * Runs on a copy of the world (nothing is counted) — it only feeds the timing columns of traceroute.
 */
export function pathDelays(world: World, pcId: string, dst: string, bytes: number, flow?: SimFlowResult): number[] {
  const f = flow ?? probeFlow(world, { fromDeviceId: pcId, dst, proto: 'icmp', bytes });
  const out: number[] = [];
  let ms = 0.15;
  for (const s of f.forward.steps) {
    if (s.stage === 'egress' && s.iface) ms += stepsMs(world, [s], bytes) - 0.15;
    if (s.stage === 'ingress') { ms += 0.12; out.push(ms); }
    if (s.stage === 'deliver' && s.verdict === 'ok') out.push(ms + 0.1);
  }
  return out;
}

// ───────────────────────────── ping ─────────────────────────────
export type UnreachCode = 'net' | 'host' | 'admin' | 'port';
export type ProbeResult =
  | { kind: 'reply'; from: string; ttl: number; rtt: number }
  | { kind: 'unreach'; from: string; code: UnreachCode; rtt: number }
  | { kind: 'ttl'; from: string; rtt: number }
  | { kind: 'timeout' }
  /** The PC itself cannot send: no address, link down, no default gateway for an off-link destination. */
  | { kind: 'local' }
  /** Destination (or gateway) on the PC's own link does not answer ARP. */
  | { kind: 'arp'; self: string };

/** Initial TTL of a PC's own packets (Windows 128, macOS 64). */
export function pcTtl(pc: PcDevice): number { return pc.os === 'macos' ? 64 : 128; }

/** One echo request from the PC through the simulated network. `bytes` = size of the whole IP packet. */
export function pingOnce(world: World, pc: PcDevice, dst: string, bytes: number): ProbeResult {
  if (dst.startsWith('127.')) return { kind: 'reply', from: dst, ttl: pcTtl(pc), rtt: 0.04 };
  const nic: NicView = nicView(world, pc);
  if (!nic.linkUp || !nic.address) return { kind: 'local' };
  const flow = sendFlow(world, { fromDeviceId: pc.id, dst, proto: 'icmp', bytes });
  const rtt = flowRtt(world, flow, bytes);
  if (flow.outcome === 'ok') {
    // The packet that makes the routers negotiate a new IPsec SA is lost meanwhile, as on real routers.
    if (flow.forward.negotiated || flow.reverse?.negotiated) return { kind: 'timeout' };
    return { kind: 'reply', from: flow.repliedFrom ?? dst, ttl: flow.reverse?.received?.ttl ?? pcTtl(pc), rtt };
  }
  if (flow.outcome === 'unreachable') {
    const err = flow.reverse?.received as ({ icmpType?: string; icmpCode?: string } | undefined);
    let code: UnreachCode = 'host';
    if (err?.icmpType === 'admin-prohibited' || err?.icmpCode === 'admin') code = 'admin';
    else if (err?.icmpCode === 'net') code = 'net';
    else if (err?.icmpCode === 'port') code = 'port';
    return { kind: 'unreach', from: flow.unreachableFrom ?? flow.reverse?.received?.src ?? dst, code, rtt };
  }
  const f = flow.forward;
  if (!f.ok && f.atDeviceId === pc.id) {
    if (f.reason === 'host-unreachable') return { kind: 'arp', self: nic.address };
    if (f.reason === 'no-ip' || f.reason === 'no-link' || f.reason === 'no-gateway') return { kind: 'local' };
  }
  const r = flow.reverse;
  if (f.reason === 'ttl-expired' && r?.ok && r.atDeviceId === pc.id && r.received?.icmpType === 'time-exceeded') {
    return { kind: 'ttl', from: r.received.src, rtt };
  }
  return { kind: 'timeout' };
}

// ───────────────────────────── TCP connection test ─────────────────────────────
export type ConnResult =
  | { kind: 'open'; flow: SimFlowResult; deviceId: string; remoteAddr: string; vty?: VtyDecision; isIos: boolean }
  | { kind: 'refused'; flow: SimFlowResult; vty?: VtyDecision }
  | { kind: 'timeout'; flow?: SimFlowResult }
  | { kind: 'local' };

/** Open a TCP connection from the PC (SYN → SYN-ACK or RST) through the simulated network. */
export function tcpConnect(world: World, pc: PcDevice, dst: string, port: number): ConnResult {
  const nic = nicView(world, pc);
  if (!nic.linkUp || !nic.address) return { kind: 'local' };
  const flow = sendFlow(world, { fromDeviceId: pc.id, dst, proto: 'tcp', dport: port });
  if (flow.outcome === 'ok') {
    const deviceId = flow.forward.atDeviceId ?? '';
    const dev = world.devices[deviceId];
    return {
      kind: 'open', flow, deviceId, vty: flow.vty,
      remoteAddr: flow.forward.received?.src ?? nic.address,
      isIos: !!dev && (dev.kind === 'router' || dev.kind === 'switch'),
    };
  }
  if (flow.outcome === 'refused') return { kind: 'refused', flow, vty: flow.vty };
  const f = flow.forward;
  if (!f.ok && f.atDeviceId === pc.id && (f.reason === 'no-ip' || f.reason === 'no-link' || f.reason === 'no-gateway')) return { kind: 'local' };
  // timeout, or an ICMP unreachable for the SYN: the client keeps retrying until it gives up
  return { kind: 'timeout', flow };
}

/** Name of the device that answered an open connection, e.g. 'PC3'. */
export function deviceLabel(world: World, deviceId: string): string {
  return world.devices[deviceId]?.label ?? deviceId;
}

// ───────────────────────────── traceroute ─────────────────────────────
export interface HopRow { ttl: number; address?: string; symbol: string; rtt: number }
export interface TraceOut {
  hops: HopRow[];
  reached: boolean;
  /** The PC cannot send at all (no address, link down, no usable gateway). */
  local: boolean;
  /** The first hop (gateway or on-link destination) does not answer ARP: the PC reports it itself. */
  arpSelf?: string;
}
export function traceFrom(world: World, pc: PcDevice, dst: string, proto: 'icmp' | 'udp', maxTtl: number, bytes: number): TraceOut {
  const nic = nicView(world, pc);
  if (!nic.linkUp || !nic.address) return { hops: [], reached: false, local: true };
  if (sendFlowLocalCheck(world, pc, dst)) return { hops: [], reached: false, local: true };
  const probe = probeFlow(world, { fromDeviceId: pc.id, dst, proto: 'icmp', bytes });
  const f = probe.forward;
  if (!f.ok && f.atDeviceId === pc.id && f.reason === 'host-unreachable') return { hops: [], reached: false, local: false, arpSelf: nic.address };
  const delays = pathDelays(world, pc.id, dst, bytes, probe);
  const t = traceroute(world, pc.id, dst, { proto, maxTtl });
  const hops = t.hops.map((h) => {
    const d = delays[Math.min(h.ttl - 1, delays.length - 1)] ?? 0.2 * h.ttl;
    return { ttl: h.ttl, address: h.address, symbol: h.symbol, rtt: 2 * d };
  });
  return { hops, reached: t.reached, local: false };
}

/** True when the PC cannot even put a packet for `dst` on the wire (no gateway for an off-link address). */
function sendFlowLocalCheck(world: World, pc: PcDevice, dst: string): boolean {
  const nic = pc.nic;
  if (!nic.address || !nic.mask) return true;
  if (inSubnet(dst, nic.address, nic.mask) || dst === nic.address) return false;
  return !nic.gateway || !inSubnet(nic.gateway, nic.address, nic.mask);
}

// ───────────────────────────── neighbours (arp -a) ─────────────────────────────
export interface Neighbour { address: string; mac: number[] }
/** Devices on the PC's own link that own an address in its subnet (what the ARP cache holds after some traffic). */
export function neighbours(world: World, pc: PcDevice): Neighbour[] {
  const nic = nicView(world, pc);
  if (!nic.linkUp || !nic.address || !nic.mask) return [];
  const out: Neighbour[] = [];
  const seen = new Set<string>();
  for (const ep of l2Reach(world, pc.id, 'Ethernet0')) {
    if (!isUp(world, ep.deviceId, ep.ifName)) continue;
    const dev = world.devices[ep.deviceId];
    if (!dev) continue;
    const addrs: { address: string; mac: number[] }[] = [];
    if (dev.kind === 'pc') {
      if (dev.nic.address) addrs.push({ address: dev.nic.address, mac: macOf(dev.nic.mac) });
    } else {
      const c = dev.config.interfaces[ep.ifName];
      for (const a of [c?.ip, ...(c?.secondary ?? [])]) if (a) addrs.push({ address: a.address, mac: deviceMac(dev.id, ep.ifName) });
    }
    for (const a of addrs) {
      if (a.address === nic.address || seen.has(a.address) || !inSubnet(a.address, nic.address, nic.mask)) continue;
      seen.add(a.address);
      out.push(a);
    }
  }
  return out.sort((x, y) => cmpIp(x.address, y.address));
}
function macOf(mac: string): number[] {
  return mac.split(/[-:.]/).map((x) => parseInt(x, 16) || 0).slice(0, 6);
}
export function cmpIp(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
