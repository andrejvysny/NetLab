/**
 * Requirement and check plumbing: every check states what was expected and what was seen, in plain words,
 * gives one short tip, and carries the trace of the probe that decided it. Owned by the scenario agent.
 */
import type {
  CheckResult, Feature, FlowSpec, GuideStep, PcSetup, PortRef, RequirementResult, SolutionCable, TraceStep,
} from '../engine/types.ts';
import type { SimFlowResult } from '../engine/sim/index.ts';
import type { Env } from './env.ts';
import { traceOf } from './env.ts';

export interface Outcome {
  pass: boolean;
  expected: string;
  observed: string;
  tip?: string;
  trace?: TraceStep[];
}
export interface CheckDef {
  id: string;
  label: string;
  /** Ids of checks in the same requirement that must pass first; otherwise this check is "not judged yet". */
  needs?: string[];
  run(env: Env): Outcome;
}
export interface ReqDef {
  id: string;
  title: string;
  feature: Feature;
  points: number;
  checks: CheckDef[];
}

/** What a guide step does when its example is followed. Used to print the example and to replay it in tests. */
export type Action =
  | { kind: 'cable'; cable: SolutionCable }
  | { kind: 'uncable'; ref: PortRef }
  /** Lines typed in global configuration mode (sub-mode lines are indented). */
  | { kind: 'config'; deviceId: string; lines: string[] }
  /** Lines typed in privileged EXEC mode. An empty line answers a prompt with Enter. */
  | { kind: 'exec'; deviceId: string; lines: string[] }
  | { kind: 'pc'; pcId: string; setup: PcSetup }
  /** The PC asks for a DHCP lease using its platform’s command. */
  | { kind: 'renew'; pcId: string }
  /** Text only: something to look at or to try. */
  | { kind: 'note'; text: string };

export interface StepDef extends Omit<GuideStep, 'no' | 'example'> {
  script: Action[];
  done(env: Env): boolean;
}

function safeRun(c: CheckDef, env: Env): Outcome {
  try {
    return c.run(env);
  } catch (e) {
    return {
      pass: false, expected: c.label,
      observed: `This check could not be finished (${e instanceof Error ? e.message : String(e)}).`,
      tip: 'Check the cabling and the basic addresses first, then run the check again.',
    };
  }
}

/** Run every check of a requirement. Earned points grow with the share of passed checks. */
export function evalReq(env: Env, req: ReqDef, no: string): RequirementResult {
  const done = new Map<string, boolean>();
  const checks: CheckResult[] = [];
  for (const c of req.checks) {
    const blockedBy = (c.needs ?? []).find((id) => done.get(id) !== true);
    let result: CheckResult;
    if (blockedBy !== undefined) {
      const first = req.checks.find((x) => x.id === blockedBy);
      result = {
        id: `${req.id}/${c.id}`, label: c.label, pass: false, expected: c.label,
        observed: `Not judged yet. First this must work: "${first?.label ?? blockedBy}".`,
        tip: 'This check waits for the one it names. Work on that one first.',
      };
    } else {
      const o = safeRun(c, env);
      result = { id: `${req.id}/${c.id}`, label: c.label, pass: o.pass, expected: o.expected, observed: o.observed };
      if (!o.pass) result.tip = o.tip || 'Check the devices and interfaces named in this check.';
      if (o.trace && o.trace.length) result.trace = o.trace;
    }
    done.set(c.id, result.pass);
    checks.push(result);
  }
  const passed = checks.filter((c) => c.pass).length;
  const pass = checks.length > 0 && passed === checks.length;
  const earned = checks.length === 0 ? 0 : Math.round((req.points * passed / checks.length) * 10) / 10;
  return { id: req.id, no, title: req.title, feature: req.feature, points: req.points, earned: pass ? req.points : earned, pass, checks };
}

/** True when every check passes; stop early for live guide updates. */
export function reqPasses(env: Env, req: ReqDef | undefined): boolean {
  if (!req) return false;
  return env.memo(`req:${req.id}`, () => {
    const passed = new Set<string>();
    return req.checks.length > 0 && req.checks.every((c) => {
      if (c.needs?.some((id) => !passed.has(id)) || !safeRun(c, env).pass) return false;
      passed.add(c.id);
      return true;
    });
  });
}
/** True when the named checks of a requirement pass (ignoring the others). */
export function checksPass(env: Env, req: ReqDef | undefined, ids: string[]): boolean {
  if (!req) return false;
  const r = env.memo(`reqfull:${req.id}`, () => evalReq(env, req, ''));
  return ids.every((id) => r.checks.find((c) => c.id === `${req.id}/${id}`)?.pass === true);
}

// ───────────────────────────── wording ─────────────────────────────
const PORT_WORDS: Record<number, string> = { 21: 'FTP', 22: 'SSH', 23: 'Telnet', 80: 'HTTP', 161: 'SNMP', 162: 'SNMP trap', 514: 'syslog', 69: 'TFTP' };
/** 'Ping', 'Telnet (TCP 23)', 'UDP port 161 (SNMP)'. */
export function flowWord(f: FlowSpec): string {
  if (f.proto === 'icmp') return 'Ping';
  const w = PORT_WORDS[f.dport ?? -1];
  if (f.proto === 'tcp') return w ? `${w} (TCP ${f.dport})` : `TCP port ${f.dport}`;
  return w ? `${w} (UDP ${f.dport})` : `UDP port ${f.dport}`;
}
export function ok(expected: string, observed: string, trace?: TraceStep[]): Outcome {
  return { pass: true, expected, observed, trace };
}
export function bad(expected: string, observed: string, tip: string, trace?: TraceStep[]): Outcome {
  return { pass: false, expected, observed, tip, trace };
}
/** A check that cannot run because an address or a link is still missing. */
export function missing(expected: string, what: string, tip: string): Outcome {
  return { pass: false, expected, observed: what, tip };
}
export function flowTrace(f: SimFlowResult): TraceStep[] { return traceOf(f); }

/** Several outcomes that must all hold: the first failure decides; otherwise the observations are joined. */
export function allOf(parts: Outcome[]): Outcome {
  const expected = parts.map((p) => p.expected).join(' ');
  const fail = parts.find((p) => !p.pass);
  if (fail) return { pass: false, expected, observed: fail.observed, tip: fail.tip, trace: fail.trace };
  return { pass: true, expected, observed: parts.map((p) => p.observed).join(' '), trace: parts[parts.length - 1]?.trace };
}
