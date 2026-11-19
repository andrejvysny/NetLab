/**
 * Every scenario, and seeds 0–5 of the seedable ones:
 *   bench + initial → nothing vacuous is credited → model solution applies without a single CLI error →
 *   grading gives 100 % and every guide step is done. Grading never changes the world and is deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, applySolution, benchWorld, getScenario, startWorld } from '../../src/scenarios/index.ts';
import { gradeOf, score, seedsOf } from './helpers.ts';

for (const d of SCENARIOS) {
  for (const seed of seedsOf(d.summary.seedable)) {
    const name = `${d.summary.id} seed ${seed}`;

    test(`${name}: start state is graded without crash and earns nothing that was not provided`, () => {
      const inst = d.build(seed);
      const world = startWorld(inst);
      const before = structuredClone(world);
      const result = inst.grade(world, []);
      assert.deepEqual(world, before, 'grade() leaves the world untouched');
      const s = score(result.requirements);
      if (!inst.initial) {
        assert.equal(s.points, 0, 'an untouched bench scores 0');
        assert.deepEqual(result.requirements.flatMap((r) => r.checks.filter((c) => c.pass).map((c) => c.id)), [], 'no check passes on an untouched bench');
      } else if (d.summary.family === 'lab') {
        assert.equal(s.points, 0, 'a pre-built lab starts at 0: the base network alone earns nothing');
      } else if (d.summary.family === 'broken') {
        assert.ok(s.points < s.max, 'a broken network does not start at 100 %');
      } else {
        assert.equal(s.points, 0, 'the services half starts with an unscored saved base, but without service points');
      }
      // every check explains itself
      for (const r of result.requirements) {
        for (const c of r.checks) {
          assert.ok(c.expected.length > 10 && c.observed.length > 5, `${c.id} states expected and observed`);
          if (!c.pass) assert.ok(c.tip && c.tip.length > 5, `${c.id} gives a tip when it fails`);
        }
      }
      const progress = inst.guideProgress(world, []);
      assert.deepEqual(world, before, 'guideProgress() leaves the world untouched');
      assert.deepEqual(Object.keys(progress), inst.guide.map((g) => g.id), 'one progress entry per guide step');
    });

    test(`${name}: the model solution scores 100 % and completes every guide step`, () => {
      const inst = d.build(seed);
      const world = startWorld(inst);
      const applied = applySolution(world, inst);
      assert.deepEqual(applied.failed, [], 'the model configuration applies without a single CLI error');
      const before = structuredClone(world);
      const result = inst.grade(world, []);
      const s = score(result.requirements);
      assert.deepEqual(s.failedChecks, [], 'no check fails on the model solution');
      assert.equal(s.percent, 100);
      assert.deepEqual(result.requirements.map((r) => r.id), inst.requirements.map((r) => r.id), 'results follow the requirement list');
      for (const r of result.requirements) assert.equal(r.earned, r.points);
      const progress = inst.guideProgress(world, []);
      assert.deepEqual(Object.entries(progress).filter(([, v]) => !v).map(([k]) => k), [], 'every guide step is done');
      assert.deepEqual(world, before, 'grade() and guideProgress() leave the solved world untouched');
      // deterministic: an independent instance and an independent copy of the world give the same report
      if (seed <= 1) {
        const again = d.build(seed).grade(structuredClone(world), []);
        assert.deepEqual(again, result);
        assert.deepEqual(d.build(seed).guideProgress(structuredClone(world), []), progress);
      }
    });
  }

  test(`${d.summary.id}: a bare bench (devices only) is graded without crash and scores 0`, () => {
    const inst = d.build(0);
    const world = benchWorld(inst);
    const before = structuredClone(world);
    const s = gradeOf(inst, world);
    assert.equal(s.points, 0);
    const progress = inst.guideProgress(world, []);
    assert.equal(typeof progress, 'object');
    assert.deepEqual(world, before);
  });
}

test('grading tolerates a damaged world and a missing journal', () => {
  const inst = getScenario('case-study-2026')!.build(0);
  const world = startWorld(inst);
  applySolution(world, inst);
  // devices vanish, a PC loses its address, a cable points nowhere
  delete world.devices['PC2'];
  world.order = world.order.filter((x) => x !== 'PC2');
  world.cables.push({ id: 'ghost', kind: 'straight', a: { deviceId: 'R9', port: 'x' }, b: { deviceId: 'SW1', port: 'GigabitEthernet1/0/9' } });
  const result = inst.grade(world, undefined as unknown as []);
  assert.ok(Array.isArray(result.requirements) && result.requirements.length === inst.requirements.length);
  assert.ok(Array.isArray(result.orderIssues));
  assert.equal(typeof inst.guideProgress(world, undefined as unknown as []), 'object');
});
