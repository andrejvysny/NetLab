/**
 * Test helpers for the scenarios: build worlds, apply fault operations, replay guide scripts through the real CLI,
 * and summarise grading results.
 */
import assert from 'node:assert/strict';
import type { GuideStep, JournalEntry, RequirementResult, ScenarioInstance, World } from '../../src/engine/types.ts';
import { isPc } from '../../src/engine/world.ts';
import { pcExec } from '../../src/engine/pc/cmd.ts';
import { renewCommand } from '../../src/scenarios/spec.ts';
import { applyConfigText, saveStartupConfig } from '../../src/engine/config/apply.ts';
import { execLine, inspectLine, installCli, startSession } from '../../src/engine/cli/index.ts';
import type { CliSession } from '../../src/engine/cli/framework.ts';
import { consolePeer, dhcpAcquire } from '../../src/engine/sim/index.ts';
import { SCENARIOS, applySolution, startWorld, stepScripts } from '../../src/scenarios/index.ts';
import type { Action } from '../../src/scenarios/index.ts';
import { plugCable, setPc, unplugAt } from '../../src/scenarios/apply.ts';
import type { FaultOps } from '../../src/scenarios/faults.ts';

installCli();

export function def(id: string) {
  const d = SCENARIOS.find((s) => s.summary.id === id);
  assert.ok(d, `scenario ${id} exists`);
  return d;
}
export function seedsOf(seedable: boolean): number[] { return seedable ? [0, 1, 2, 3, 4, 5] : [0]; }

export interface Score { points: number; max: number; percent: number; failing: string[]; failedChecks: string[] }
export function score(reqs: RequirementResult[]): Score {
  const points = reqs.reduce((a, r) => a + r.earned, 0);
  const max = reqs.reduce((a, r) => a + r.points, 0);
  return {
    points: Math.round(points * 10) / 10, max, percent: max === 0 ? 0 : Math.round((points / max) * 1000) / 10,
    failing: reqs.filter((r) => !r.pass).map((r) => r.id),
    failedChecks: reqs.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.observed}`)),
  };
}
export function gradeOf(inst: ScenarioInstance, world: World): Score { return score(inst.grade(world, []).requirements); }

/** Bench + initial + model solution. Asserts that every configuration line was accepted by the CLI. */
export function solvedWorld(inst: ScenarioInstance): World {
  const world = startWorld(inst);
  const r = applySolution(world, inst);
  assert.deepEqual(r.failed, [], 'every line of the model configuration is accepted by the CLI');
  return world;
}

export function renewLeases(world: World): void {
  for (const id of world.order) { const d = world.devices[id]; if (isPc(d) && d.nic.mode === 'dhcp') dhcpAcquire(world, id); }
}
export function saveRouters(world: World): void { for (const id of ['R1', 'R2']) saveStartupConfig(world, id); }

/** Apply the operations of a fault (break or fix): cables on the bench, configuration through the CLI, PC settings. */
export function applyOps(world: World, ops: FaultOps, what: string): void {
  for (const op of ops.cables ?? []) {
    if ('remove' in op) unplugAt(world, op.remove); else plugCable(world, op.add);
  }
  for (const [dev, lines] of Object.entries(ops.configs ?? {})) {
    const r = applyConfigText(world, dev, lines.join('\n'), 'merge');
    assert.deepEqual(r.lines.filter((l) => !l.ok).map((l) => `${l.line} → ${l.output.trim()}`), [], `${what}: every line is accepted on ${dev}`);
  }
  for (const [pc, setup] of Object.entries(ops.pcs ?? {})) setPc(world, pc, setup);
}

// ───────────────────────────── replaying guide scripts through the real CLI ─────────────────────────────
function consoleSession(world: World, deviceId: string): CliSession {
  assert.ok(consolePeer(world, deviceId), `a console cable reaches ${deviceId} before anything is typed there`);
  const { session } = startSession(world, deviceId, 'console');
  let guard = 0;
  while (session.pending && guard++ < 5) execLine(world, session, session.pending.kind === 'setup-dialog' ? 'no' : '');
  if (session.mode === 'user') execLine(world, session, 'enable');
  assert.equal(session.mode, 'priv', `${deviceId}: privileged mode reached`);
  return session;
}

/** Run one action of a guide step as the student would, and check that the step's `allows` covers it. Records a journal when one is given. */
export function runAction(world: World, step: GuideStep, a: Action, journal?: JournalEntry[]): void {
  // The same rule the Lab uses in guided mode: the feature must be in `allows`, and the device must be one of the step's devices.
  const allowed = (feature: string, what: string, devices: string[] = []): void => {
    assert.ok((step.allows as string[]).includes(feature), `step "${step.id}" allows ${feature} (needed for: ${what})`);
    if (devices.length) assert.ok(devices.some((d) => step.devices.includes(d)), `step "${step.id}" lists the device for: ${what} (${devices.join(', ')})`);
  };
  const note = (e: Omit<JournalEntry, 'tick' | 'stepId'>): void => { world.tick += 1; journal?.push({ tick: world.tick, stepId: step.id, ...e }); };
  switch (a.kind) {
    case 'note': return;
    case 'cable': {
      const feature = a.cable.kind === 'console' ? 'console' : 'cabling';
      allowed(feature, `cable ${a.cable.a.deviceId}–${a.cable.b.deviceId}`, [a.cable.a.deviceId, a.cable.b.deviceId]);
      plugCable(world, a.cable);
      note({ deviceId: a.cable.a.deviceId, via: 'bench', line: `connect ${a.cable.kind} ${a.cable.a.deviceId} ${a.cable.a.port} - ${a.cable.b.deviceId} ${a.cable.b.port}`, feature, ok: true, mutated: true });
      return;
    }
    case 'uncable':
      allowed('cabling', 'unplug a cable', [a.ref.deviceId]);
      unplugAt(world, a.ref);
      note({ deviceId: a.ref.deviceId, via: 'bench', line: `remove cable at ${a.ref.deviceId} ${a.ref.port}`, feature: 'cabling', ok: true, mutated: true });
      return;
    case 'pc':
      allowed('pc', `settings of ${a.pcId}`, [a.pcId]);
      setPc(world, a.pcId, a.setup);
      note({ deviceId: a.pcId, via: 'pc', line: `set adapter ${a.setup.mode}`, feature: 'pc', ok: true, mutated: true });
      return;
    case 'renew': {
      const line = renewCommand(a.pcId);
      allowed('pc', `${line} on ${a.pcId}`, [a.pcId]);
      const result = pcExec(world, a.pcId, line);
      assert.doesNotMatch(result.output, /usage:|not recognized|command not found|could not be run/i);
      note({ deviceId: a.pcId, via: 'pc', line, feature: 'pc', ok: true, mutated: true });
      return;
    }
    case 'config':
    case 'exec': {
      const session = consoleSession(world, a.deviceId);
      if (a.kind === 'config') {
        execLine(world, session, 'configure terminal');
        assert.equal(session.mode, 'config');
      }
      for (const raw of a.lines) {
        const line = raw.trim();
        if (line.startsWith('!')) continue;
        const mode = session.mode;
        const pending = !!session.pending;
        const info = inspectLine(world, session, line);
        if (info.status !== 'pending' && info.status !== 'empty') {
          assert.equal(info.status, 'ok', `${a.deviceId} understands "${line}" in mode ${session.mode}`);
          if (info.mutates) allowed(info.feature, `"${line}" on ${a.deviceId}`, [a.deviceId]);
        }
        const out = execLine(world, session, line);
        assert.ok(['ok', 'empty', 'pending'].includes(out.status), `${a.deviceId} accepts "${line}": ${out.output.trim()}`);
        if (!pending && line) journal?.push({ tick: world.tick, deviceId: a.deviceId, via: 'console', mode, line, feature: out.feature, ok: true, mutated: out.mutated, stepId: step.id });
      }
      if (a.kind === 'config') execLine(world, session, 'end');
      return;
    }
  }
}

/** Follow every guide step's example in order. Returns the journal of what was done. */
export function walkthrough(inst: ScenarioInstance, world: World): JournalEntry[] {
  const journal: JournalEntry[] = [];
  const scripts = stepScripts(inst);
  assert.equal(scripts.length, inst.guide.length, 'every guide step has a script');
  for (const step of inst.guide) {
    const sc = scripts.find((x) => x.stepId === step.id);
    assert.ok(sc, `script for step ${step.id}`);
    for (const a of sc.script) {
      runAction(world, step, a, journal);
      if (a.kind === 'config' || a.kind === 'exec') {
        for (const l of a.lines) if (l.trim()) assert.ok((step.example ?? '').includes(l), `the example of step "${step.id}" shows the line "${l.trim()}"`);
      }
    }
    const progress = inst.guideProgress(world, journal);
    assert.equal(progress[step.id], true, `step ${step.no} "${step.title}" (${step.id}) is done after its example was followed`);
  }
  return journal;
}
