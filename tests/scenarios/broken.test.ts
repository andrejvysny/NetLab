/**
 * Broken networks: every instance fails at least one requirement when the student opens it, the tickets describe
 * symptoms (not causes), and the documented fixes, typed through the CLI, bring it to 100 %.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySolution, faultsOf, getScenario, startWorld } from '../../src/scenarios/index.ts';
import { gradeOf } from './helpers.ts';

const SEEDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

for (const [id, count] of [['broken-1', 1], ['broken-2', 2], ['broken-3', 3]] as const) {
  const d = getScenario(id)!;

  test(`${id}: family, seedable, and different seeds plant different faults`, () => {
    assert.equal(d.summary.family, 'broken');
    assert.equal(d.summary.seedable, true);
    const sets = new Set(SEEDS.map((seed) => faultsOf(d.build(seed)).map((f) => f.id).sort().join('+')));
    assert.ok(sets.size >= 6, `${sets.size} different fault sets over ${SEEDS.length} seeds`);
    assert.deepEqual(faultsOf(d.build(3)).map((f) => f.id), faultsOf(d.build(3)).map((f) => f.id), 'the same seed gives the same faults');
  });

  for (const seed of SEEDS) {
    test(`${id} seed ${seed}: fails before the fix, 100 % after the documented fixes`, () => {
      const inst = d.build(seed);
      const faults = faultsOf(inst);
      assert.equal(faults.length, count, 'number of planted faults');
      assert.equal(new Set(faults.map((f) => f.slot)).size, count, 'the faults do not touch the same setting');

      // the sheet: tickets with symptoms, the address plan, and the reminder of the rules
      const tickets = inst.brief.items.filter((i) => /^T\d+$/.test(i.no));
      assert.equal(tickets.length, count);
      const briefText = JSON.stringify(inst.brief);
      for (const f of faults) {
        assert.ok(tickets.some((t) => t.text === f.ticket));
        assert.ok(!briefText.includes(f.title) && !briefText.includes(f.fixText), 'the brief does not give the cause away');
      }
      assert.ok((inst.brief.given ?? []).length >= 4, 'the address plan of the built network is given');
      assert.ok(inst.initial && Object.keys(inst.initial.configs ?? {}).length === 2 && (inst.initial.cables ?? []).length >= 5);

      // before
      const world = startWorld(inst);
      const before = gradeOf(inst, world);
      assert.ok(before.failing.length >= 1, 'at least one requirement fails');
      for (const f of faults) for (const req of f.mustFail) assert.ok(before.failing.includes(req), `${f.id} makes ${req} fail; failing: ${before.failing.join(', ')}`);
      const progress = inst.guideProgress(world, []);
      assert.ok(Object.values(progress).some((v) => !v), 'the troubleshooting guide has open steps');

      // the solution names every fault and its fix
      for (const f of faults) assert.ok(inst.solution.notes.some((n) => n.includes(f.title) && n.includes(f.fixText)), `the solution explains ${f.id}`);

      // after
      const applied = applySolution(world, inst);
      assert.deepEqual(applied.failed, [], 'every fix line is accepted by the CLI');
      const after = gradeOf(inst, world);
      assert.deepEqual(after.failedChecks, []);
      assert.equal(after.percent, 100);
      assert.deepEqual(Object.entries(inst.guideProgress(world, [])).filter(([, v]) => !v), [], 'every troubleshooting step is done');
    });
  }
}
