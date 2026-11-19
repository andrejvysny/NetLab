/**
 * End to end: the real case study (src/scenarios), solved purely through LabApi the way the student would do it, must
 * score 100 %. Skips itself (with a message) while the scenario registry is still empty or has no 'case-study-2026'.
 * The same driver always runs against the test fixture, so the driver itself is never untested.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS } from '../../src/scenarios/index.ts';
import { Lab } from '../../src/engine/lab.ts';
import { fakePc, miniScenario } from './fixture.ts';
import { failures, solveThroughLabApi } from './e2e-driver.ts';

const CASE_STUDY = 'case-study-2026';

test('e2e driver: the fixture assignment solved by hand through LabApi scores 100 %', () => {
  const lab = new Lab({ scenarios: [miniScenario()], storage: null, pcExec: fakePc });
  const r = solveThroughLabApi(lab, 'mini');
  assert.deepEqual(r.refused, []);
  assert.equal(r.typed, 28, 'every line of both model configurations');
  assert.equal(r.report.points, r.report.maxPoints, failures(r.report));
  assert.equal(r.report.scaled18, 18);
});

test('case study 2026: cabled, configured line by line on the console and graded through LabApi → 100 %', (t) => {
  const def = Array.isArray(SCENARIOS) ? SCENARIOS.find((s) => s?.summary?.id === CASE_STUDY) : undefined;
  if (!def) {
    t.skip(`scenario "${CASE_STUDY}" is not registered in src/scenarios/index.ts yet (${Array.isArray(SCENARIOS) ? SCENARIOS.length : 0} scenarios found)`);
    return;
  }
  // The real thing: default scenario registry, real PC command prompt, no storage.
  const lab = new Lab({ storage: null });
  const r = solveThroughLabApi(lab, CASE_STUDY);
  assert.deepEqual(r.refused, [], 'every line of the model configuration is accepted when typed on the console');
  assert.ok(r.typed > 50, `the model configuration was typed (${r.typed} lines)`);
  assert.ok(r.report.maxPoints > 0, 'the case study has points');
  assert.equal(r.report.points, r.report.maxPoints, `the model solution must score 100 %. Not passed:\n${failures(r.report)}`);
  assert.equal(r.report.scaled18, 18);
  assert.ok(!lab.getState().journal.some((e) => e.blocked), 'free mode never blocks');
  // the same lab survives export → import with the same grade
  const copy = new Lab({ storage: null });
  const back = copy.importLab(lab.exportLab());
  assert.equal(back.ok, true, back.message ?? '');
  assert.equal(copy.check().points, r.report.points);
});
