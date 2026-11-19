/**
 * Guided mode against the real case study: follow the guide step by step through LabApi, doing exactly what each step's
 * example does (the scenario module publishes that as replayable "step scripts"). Doing the steps in order must never
 * be stopped by the guide, every step must turn "done" when its work is finished, and the result must be 100 %.
 * Skips itself while src/scenarios has no 'case-study-2026' or no stepScripts().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lab } from '../../src/engine/lab.ts';
import { failures } from './e2e-driver.ts';
import { consoleIn, loadScenarios, perform } from './guided-driver.ts';

const CASE_STUDY = 'case-study-2026';

test('case study 2026 in guided mode: the steps done in order are never stopped, each turns "done", the result is 100 %', async (t) => {
  const mod = await loadScenarios();
  const def = Array.isArray(mod.SCENARIOS) ? mod.SCENARIOS.find((s) => s?.summary?.id === CASE_STUDY) : undefined;
  if (!def) { t.skip(`scenario "${CASE_STUDY}" is not registered in src/scenarios/index.ts yet`); return; }
  if (typeof mod.stepScripts !== 'function') { t.skip('src/scenarios/index.ts does not export stepScripts(): the guide steps cannot be replayed'); return; }

  // The instance the Lab builds is a different object from ours; the scripts are the same for the same seed.
  const scripts = mod.stepScripts(def.build(0));
  const lab = new Lab({ storage: null });
  assert.equal(lab.startScenario(CASE_STUDY, 'guided').ok, true);
  const guide = () => lab.getState().scenario!.guide;
  assert.ok(guide().length > 5, 'the case study has guide steps');
  assert.deepEqual(scripts.map((s) => s.stepId), guide().map((g) => g.id), 'one script per guide step, in guide order');
  assert.equal(guide()[0].status, 'active');

  for (const [i, step] of scripts.entries()) {
    const g = guide()[i];
    assert.equal(g.status, 'active', `step ${g.no} (${g.title}) is the active step before its work starts — statuses: ${guide().map((x) => `${x.no}:${x.status}`).join(' ')}`);
    for (const a of step.script) perform(lab, a);
    assert.equal(guide()[i].status, 'done', `step ${g.no} (${g.title}) is done after its example was followed`);
  }
  assert.ok(guide().every((s) => s.status === 'done'));
  assert.ok(!lab.getState().journal.some((e) => e.blocked), 'nothing was stopped on the way');
  const report = lab.check();
  assert.equal(report.points, report.maxPoints, `guided walk-through must end at 100 %. Not passed:\n${failures(report)}`);

  // and the guide really guards the order: in a fresh guided lab, NAT in step 1 is refused with a pointer to its step
  assert.equal(lab.startScenario(CASE_STUDY, 'guided').ok, true);
  assert.equal(lab.connectCable('console', { deviceId: 'PC1', port: 'COM1' }, { deviceId: 'R1', port: 'Console' }).ok, true);
  const id = consoleIn(lab, 'R1', 'config');
  const v = lab.sessionExec(id, 'ip nat inside source static 192.168.100.10 60.50.50.100');
  assert.ok(v.blocked, 'NAT is not part of step 1');
  assert.match(v.blocked.reason, /^You typed "ip nat inside source static 192\.168\.100\.10 60\.50\.50\.100"\. NAT is step \d+\. You are on step 1: /);
});
