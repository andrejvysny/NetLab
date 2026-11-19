/**
 * Grading environment: discovers the roles of ports from the cabling (which router port leads to which neighbour),
 * reads the addresses the student configured, and runs cached probes on copies of the world.
 * Nothing here changes the world that is being graded. Owned by the scenario agent.
 */
import type { Cable, FlowSpec, IosDevice, IpMask, PcDevice, PortRef, TraceStep, World } from '../engine/types.ts';
import { isIos, isPc } from '../engine/world.ts';
import { checkCable, sendFlow } from '../engine/sim/index.ts';
import type { SimFlowResult } from '../engine/sim/index.ts';
import type { Spec } from './spec.ts';

// ───────────────────────────── cabling walk ─────────────────────────────
export interface PathEnd {
  ref: PortRef;
  /** Cables from the starting port to this end, in order. */
  path: Cable[];
  /** Switches crossed on the way. */
  switches: string[];
}

function isDataPort(world: World, ref: PortRef): boolean {
  const spec = world.devices[ref.deviceId]?.ports.find((p) => p.name === ref.port);
  return !!spec && (spec.kind === 'ethernet' || spec.kind === 'serial');
}
function cableAtPort(world: World, ref: PortRef): { cable: Cable; peer: PortRef } | undefined {
  for (const c of world.cables) {
    if (c.kind === 'console') continue;
    if (c.a.deviceId === ref.deviceId && c.a.port === ref.port) return { cable: c, peer: c.b };
    if (c.b.deviceId === ref.deviceId && c.b.port === ref.port) return { cable: c, peer: c.a };
  }
  return undefined;
}

/**
 * Every router port and PC network port that is wired to `start`, directly or through switches.
 * Follows cables only: it does not care whether a link is up, so roles can be found on a half-built bench.
 */
export function wiredEnds(world: World, start: PortRef): PathEnd[] {
  const out: PathEnd[] = [];
  const first = cableAtPort(world, start);
  if (!first || !isDataPort(world, start)) return out;
  const seenSwitch = new Set<string>();
  const queue: { ref: PortRef; path: Cable[]; switches: string[] }[] = [{ ref: first.peer, path: [first.cable], switches: [] }];
  while (queue.length) {
    const cur = queue.shift()!;
    const dev = world.devices[cur.ref.deviceId];
    if (!dev || !isDataPort(world, cur.ref)) continue;
    if (dev.kind !== 'switch') { out.push({ ref: cur.ref, path: cur.path, switches: cur.switches }); continue; }
    if (seenSwitch.has(dev.id)) continue;
    seenSwitch.add(dev.id);
    for (const p of dev.ports) {
      if (p.kind !== 'ethernet' || p.name === cur.ref.port) continue;
      const next = cableAtPort(world, { deviceId: dev.id, port: p.name });
      if (!next || cur.path.includes(next.cable)) continue;
      queue.push({ ref: next.peer, path: [...cur.path, next.cable], switches: [...cur.switches, dev.id] });
    }
  }
  return out;
}

export interface Roles {
  /** R1 port in the LAN of PC1 (or PC2). */
  r1Lan?: string;
  /** R1 and R2 ports of the link between the routers. */
  r1Wan?: string;
  r2Wan?: string;
  /** R2 port in the LAN of PC3. */
  r2Lan?: string;
  /** Cables between R1 and R2 (one cable when they are joined directly). */
  wanPath: Cable[];
  wanSwitches: string[];
  /** Wiring seen from each PC's network port. */
  fromPc: Record<string, PathEnd[]>;
}

export function discoverRoles(world: World): Roles {
  const fromPc: Record<string, PathEnd[]> = {};
  for (const id of world.order) {
    if (isPc(world.devices[id])) fromPc[id] = wiredEnds(world, { deviceId: id, port: 'Ethernet0' });
  }
  const roles: Roles = { wanPath: [], wanSwitches: [], fromPc };
  const endOn = (pc: string, router: string): string | undefined => fromPc[pc]?.find((e) => e.ref.deviceId === router)?.ref.port;
  roles.r1Lan = endOn('PC1', 'R1') ?? endOn('PC2', 'R1');
  roles.r2Lan = endOn('PC3', 'R2');
  const r1 = world.devices['R1'];
  if (r1) {
    let best: { p: string; q: string; path: Cable[]; switches: string[]; rank: number } | undefined;
    for (const p of r1.ports) {
      if ((p.kind !== 'ethernet' && p.kind !== 'serial') || p.name === roles.r1Lan) continue;
      for (const e of wiredEnds(world, { deviceId: 'R1', port: p.name })) {
        if (e.ref.deviceId !== 'R2' || e.ref.port === roles.r2Lan) continue;
        const rank = (e.switches.length === 0 ? 0 : 2) + (p.kind === 'serial' ? 0 : 1);
        if (!best || rank < best.rank) best = { p: p.name, q: e.ref.port, path: e.path, switches: e.switches, rank };
      }
    }
    if (best) { roles.r1Wan = best.p; roles.r2Wan = best.q; roles.wanPath = best.path; roles.wanSwitches = best.switches; }
  }
  return roles;
}

/** First problem on a cable path, in plain words, or null when every cable can carry traffic. */
export function pathProblem(world: World, path: Cable[]): string | null {
  for (const c of path) {
    const r = checkCable(world, c.kind, c.a, c.b);
    if (!r.usable) return r.problem ?? 'A cable on this path cannot be used between these two ports.';
  }
  return null;
}

// ───────────────────────────── copies ─────────────────────────────
function deepCopy<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = deepCopy(v[i]);
    return out as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const k in v as Record<string, unknown>) out[k] = deepCopy((v as Record<string, unknown>)[k]);
  return out as T;
}
/** A full, independent copy of a world. The world is plain JSON, so a simple recursive copy is exact (and much faster than structuredClone). */
export function copyWorld(world: World): World { return deepCopy(world); }

/** A clean session on the same hardware/profile. Existing leases are client state, not session residue. */
export function probeWorld(world: World): World {
  const w = copyWorld(world);
  for (const d of Object.values(w.devices)) if (isIos(d)) {
    d.runtime.natTranslations = [];
    d.runtime.ikeSas = [];
    d.runtime.ipsecSas = [];
    d.runtime.vtyInUse = 0;
  }
  return w;
}

// ───────────────────────────── environment ─────────────────────────────
export interface Seen {
  r1Lan?: IpMask; r1Wan?: IpMask; r2Wan?: IpMask; r2Lan?: IpMask;
  r1Lo0?: IpMask; r1Lo100?: IpMask; r2Lo0?: IpMask;
  pc1?: string; pc2?: string; pc3?: string;
}
export interface Env {
  world: World;
  spec: Spec;
  roles: Roles;
  r1?: IosDevice;
  r2?: IosDevice;
  /** Addresses as configured right now. */
  a: Seen;
  /** Send a request and its answer through a copy of the world. Cached per environment. */
  probe(flow: FlowSpec): SimFlowResult;
  /** Cache for expensive derived results. */
  memo<T>(key: string, make: () => T): T;
  pc(id: string): PcDevice | undefined;
}

function ipOf(dev: IosDevice | undefined, ifName: string | undefined): IpMask | undefined {
  if (!dev || !ifName) return undefined;
  const ip = dev.config.interfaces[ifName]?.ip;
  return ip ? { address: ip.address, mask: ip.mask } : undefined;
}

export function makeEnv(world: World, spec: Spec): Env {
  const roles = discoverRoles(world);
  const d1 = world.devices['R1'];
  const d2 = world.devices['R2'];
  const r1 = isIos(d1) ? d1 : undefined;
  const r2 = isIos(d2) ? d2 : undefined;
  const pc = (id: string): PcDevice | undefined => { const d = world.devices[id]; return isPc(d) ? d : undefined; };
  const a: Seen = {
    r1Lan: ipOf(r1, roles.r1Lan), r1Wan: ipOf(r1, roles.r1Wan), r2Wan: ipOf(r2, roles.r2Wan), r2Lan: ipOf(r2, roles.r2Lan),
    r1Lo0: ipOf(r1, 'Loopback0'), r1Lo100: ipOf(r1, 'Loopback100'), r2Lo0: ipOf(r2, 'Loopback0'),
    pc1: pc('PC1')?.nic.address, pc2: pc('PC2')?.nic.address, pc3: pc('PC3')?.nic.address,
  };
  const flows = new Map<string, SimFlowResult>();
  const memos = new Map<string, unknown>();
  // Every probe starts from the same state: a private copy of the world. The only thing carried from one probe to the
  // next is an IPsec tunnel that a probe managed to negotiate: the engine re-checks such a tunnel against the
  // configuration before it uses it, so the outcome is the same as negotiating again, only faster.
  let base: World | undefined;
  const keepTunnels = (from: World, into: World): void => {
    for (const id of into.order) {
      const src = from.devices[id];
      const dst = into.devices[id];
      if (!isIos(src) || !isIos(dst)) continue;
      for (const sa of src.runtime.ipsecSas) {
        if (!dst.runtime.ipsecSas.some((x) => x.id === sa.id)) dst.runtime.ipsecSas.push({ ...sa, localIdent: { ...sa.localIdent }, remoteIdent: { ...sa.remoteIdent }, encaps: 0, decaps: 0 });
      }
      for (const sa of src.runtime.ikeSas) {
        if (!dst.runtime.ikeSas.some((x) => x.local === sa.local && x.remote === sa.remote)) dst.runtime.ikeSas.push({ ...sa });
      }
    }
    into.nextId = Math.max(into.nextId, from.nextId);
  };
  return {
    world, spec, roles, r1, r2, a, pc,
    probe(flow) {
      const key = JSON.stringify(flow);
      let r = flows.get(key);
      if (!r) {
        base ??= probeWorld(world);
        const w = copyWorld(base);
        r = sendFlow(w, flow);
        keepTunnels(w, base);
        flows.set(key, r);
      }
      return r;
    },
    memo<T>(key: string, make: () => T): T {
      if (!memos.has(key)) memos.set(key, make());
      return memos.get(key) as T;
    },
  };
}

// ───────────────────────────── flow helpers ─────────────────────────────
export function traceOf(f: SimFlowResult): TraceStep[] {
  return [...f.forward.steps, ...(f.reverse?.steps ?? [])];
}
/** The request arrived at this device (answered, refused or ignored there). */
export function arrivedAt(f: SimFlowResult, deviceId: string): boolean {
  return f.forward.atDeviceId === deviceId
    && (f.forward.ok || f.forward.reason === 'port-closed' || f.forward.reason === 'service-denied');
}
/** The request was thrown away by an access list. */
export function stoppedByAcl(f: SimFlowResult): boolean {
  return f.forward.reason === 'acl-in' || f.forward.reason === 'acl-out';
}
export function ping(from: string, dst: string, srcAddr?: string): FlowSpec {
  return srcAddr ? { fromDeviceId: from, dst, proto: 'icmp', srcAddr } : { fromDeviceId: from, dst, proto: 'icmp' };
}
export function tcp(from: string, dst: string, dport: number): FlowSpec {
  return { fromDeviceId: from, dst, proto: 'tcp', dport };
}
export function udp(from: string, dst: string, dport: number): FlowSpec {
  return { fromDeviceId: from, dst, proto: 'udp', dport };
}
/** How the packet looked when it left `deviceId` through `iface`: 'esp' (encrypted), 'clear', or 'none' (it never left there). */
export function wireForm(steps: TraceStep[], deviceId: string, iface: string | undefined): 'esp' | 'clear' | 'none' {
  if (!iface) return 'none';
  const s = steps.find((x) => x.deviceId === deviceId && x.stage === 'egress' && x.iface === iface);
  if (!s) return 'none';
  return (s.header ?? '').startsWith('ESP') ? 'esp' : 'clear';
}
