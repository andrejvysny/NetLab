/** Shared helpers for the scenario parts: probe targets, standard flow checks, the Part contract. Owned by the scenario agent. */
import type { FlowSpec, PcSetup, SolutionCable } from '../../engine/types.ts';
import type { SimFlowResult } from '../../engine/sim/index.ts';
import type { Outcome, ReqDef, StepDef } from '../checks.ts';
import { bad, flowTrace, flowWord, missing, ok } from '../checks.ts';
import type { Env } from '../env.ts';
import { arrivedAt, stoppedByAcl } from '../env.ts';
import type { PartId, Spec } from '../spec.ts';

/** One building block of a scenario, built from the Spec, so brief, checks, guide and solution always agree. */
export interface Built {
  id: PartId;
  /** Model configuration lines of this part, per router (sub-mode lines are indented by one space). */
  config: Record<string, string[]>;
  cables: SolutionCable[];
  pcs: Record<string, PcSetup>;
  requirements: ReqDef[];
  steps: StepDef[];
}
export type PartFactory = (s: Spec) => Built;
export function emptyBuilt(id: PartId): Built {
  return { id, config: {}, cables: [], pcs: {}, requirements: [], steps: [] };
}

// ───────────────────────────── targets ─────────────────────────────
export interface Target {
  /** How the target is called in a sentence. */
  name: string;
  addr?: string;
  /** Device that should receive the packet. */
  dev: string;
  /** Said when the address is not known yet. */
  gap: string;
}
export const T = {
  pc1: (e: Env): Target => ({ name: 'PC1', addr: e.a.pc1, dev: 'PC1', gap: 'PC1 has no IP address yet.' }),
  pc2: (e: Env): Target => ({ name: 'PC2', addr: e.a.pc2, dev: 'PC2', gap: 'PC2 has no IP address yet.' }),
  pc3: (e: Env): Target => ({ name: 'PC3', addr: e.a.pc3, dev: 'PC3', gap: 'PC3 has no IP address yet.' }),
  r1Lan: (e: Env): Target => ({ name: "R1's LAN address", addr: e.a.r1Lan?.address, dev: 'R1', gap: "R1's LAN interface has no IP address yet." }),
  r1Wan: (e: Env): Target => ({ name: "R1's WAN address", addr: e.a.r1Wan?.address, dev: 'R1', gap: "R1's WAN interface has no IP address yet." }),
  r2Wan: (e: Env): Target => ({ name: "R2's WAN address", addr: e.a.r2Wan?.address, dev: 'R2', gap: "R2's WAN interface has no IP address yet." }),
  r2Lan: (e: Env): Target => ({ name: "R2's LAN address", addr: e.a.r2Lan?.address, dev: 'R2', gap: "R2's LAN interface has no IP address yet." }),
  r1Lo0: (e: Env): Target => ({ name: "R1's Loopback0", addr: e.a.r1Lo0?.address, dev: 'R1', gap: 'R1 has no Loopback0 address yet.' }),
  r2Lo0: (e: Env): Target => ({ name: "R2's Loopback0", addr: e.a.r2Lo0?.address, dev: 'R2', gap: 'R2 has no Loopback0 address yet.' }),
  pc1Public: (e: Env): Target => ({ name: "PC1's public address (R1 Loopback100)", addr: e.a.r1Lo100?.address, dev: 'PC1', gap: 'R1 has no Loopback100 address yet.' }),
  fixed: (name: string, addr: string, dev: string): Target => ({ name, addr, dev, gap: '' }),
};

export interface Probe {
  from: string;
  to: Target;
  proto: 'icmp' | 'tcp' | 'udp';
  port?: number;
  sport?: number;
  /** Source address for a router that sends from a chosen interface. */
  srcAddr?: string;
}
export function specOf(p: Probe): FlowSpec | null {
  if (!p.to.addr) return null;
  const f: FlowSpec = { fromDeviceId: p.from, dst: p.to.addr, proto: p.proto };
  if (p.port !== undefined) f.dport = p.port;
  if (p.sport !== undefined) f.sport = p.sport;
  if (p.srcAddr) f.srcAddr = p.srcAddr;
  return f;
}
export function sentence(p: Probe): string {
  const f = specOf(p);
  const word = p.sport !== undefined ? `${p.proto.toUpperCase()} source port ${p.sport}` : f ? flowWord(f) : p.proto === 'icmp' ? 'Ping' : `${p.proto.toUpperCase()} port ${p.port}`;
  return `${word} from ${p.from} to ${p.to.name}${p.to.addr ? ` (${p.to.addr})` : ''}`;
}
export function runProbe(env: Env, p: Probe): SimFlowResult | null {
  const f = specOf(p);
  return f ? env.probe(f) : null;
}

/** Request and answer must both get through. */
export function works(env: Env, p: Probe, tip: string): Outcome {
  const expected = `${sentence(p)} gets an answer.`;
  const f = runProbe(env, p);
  if (!f) return missing(expected, p.to.gap, tip);
  if (f.ok && f.forward.atDeviceId === p.to.dev) return ok(expected, f.summary, flowTrace(f));
  return bad(expected, f.ok ? `An answer came from ${f.forward.atDeviceId}, not the expected device ${p.to.dev}.` : f.summary, tip, flowTrace(f));
}
/** The request must arrive at the target device (it may be refused there: the path is what counts). */
export function arrives(env: Env, p: Probe, tip: string): Outcome {
  const expected = `${sentence(p)} arrives at ${p.to.dev}.`;
  const f = runProbe(env, p);
  if (!f) return missing(expected, p.to.gap, tip);
  return arrivedAt(f, p.to.dev) ? ok(expected, f.summary, flowTrace(f)) : bad(expected, f.summary, tip, flowTrace(f));
}
/** Require an observed packet-filter rejection; a broken route, tunnel or application is not a policy. */
export function stopped(env: Env, p: Probe, tip: string): Outcome {
  const expected = `${sentence(p)} is stopped on the way.`;
  const f = runProbe(env, p);
  if (!f) return missing(expected, p.to.gap, tip);
  return stoppedByAcl(f) ? ok(expected, f.summary, flowTrace(f))
    : bad(expected, `No packet filter denied this request. ${f.summary}`, tip, flowTrace(f));
}

/** Device that owns an address right now (router interface or PC). */
export function ownerOf(env: Env, address: string | undefined): string | undefined {
  if (!address) return undefined;
  for (const id of env.world.order) {
    const d = env.world.devices[id];
    if (d.kind === 'pc') { if (d.nic.address === address) return id; continue; }
    for (const c of Object.values(d.config.interfaces)) {
      if (c.ip?.address === address || c.secondary?.some((x) => x.address === address)) return id;
    }
  }
  return undefined;
}

/** Indent sub-mode lines by one space, as running-config prints them. */
export function block(head: string, lines: string[]): string[] {
  return [head, ...lines.map((l) => ` ${l}`)];
}
export function cfgAction(deviceId: string, lines: string[]): { kind: 'config'; deviceId: string; lines: string[] } {
  return { kind: 'config', deviceId, lines };
}
