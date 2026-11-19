import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lab } from '../../src/engine/lab.ts';
import type { GradeReport, PcServices } from '../../src/engine/types.ts';
import { getScenario } from '../../src/scenarios/index.ts';
import { R1_COURSE, R2_COURSE } from '../config/reference.ts';
import { consoleToConfig, ok, type, world } from '../lab/fixture.ts';

/** docs/COURSE.md listing: legacy IKE values, no qos pre-classify. */
test('course listing scores 18/18 by default; WAN after encryption grades the classifications that actually occur', () => {
  const def = getScenario('case-study-2026')!;
  const inst = def.build(0);
  const lab = new Lab({ scenarios: [def] });
  ok(lab.startScenario(def.summary.id, 'free'));
  for (const c of inst.solution.cables) if (c.kind !== 'console') ok(lab.connectCable(c.kind, c.a, c.b, { dceEnd: c.dceEnd }));
  const config = (dev: string, text: string): void => {
    const id = consoleToConfig(lab, 'PC1', dev);
    const result = lab.applyConfigText(dev, text, 'merge');
    assert.equal(result.ok, true, result.message ?? result.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.output}`).join('\n'));
    type(lab, id, ['end', 'copy running-config startup-config', '']);
  };
  for (const [id, text] of [['R1', R1_COURSE], ['R2', R2_COURSE]]) {
    assert.doesNotMatch(text, /qos pre-classify/);
    config(id, text);
  }
  const pcs = Object.entries(inst.solution.pcs);
  for (const [id, pc] of pcs) {
    for (const service of Object.keys(pc.services ?? {}) as (keyof PcServices)[]) lab.setPcService(id, service, !!pc.services?.[service]);
    if (pc.mode === 'static') ok(lab.setPcNic(id, pc));
  }
  for (const [id, pc] of pcs) if (pc.mode === 'dhcp') ok(lab.setPcNic(id, pc));

  const failedIds = (checks: { id: string; pass: boolean }[]) => checks.filter((c) => !c.pass).map((c) => c.id);
  const qosChecks = (report: GradeReport) => report.requirements.find((r) => r.id === 'qos')!.checks;
  const progress = () => inst.guideProgress(world(lab), lab.getState().journal).qos;
  assert.equal(lab.getState().settings.qosClassifiesInnerHeader, true);
  const course = lab.check();
  assert.deepEqual(failedIds(course.requirements), []);
  assert.equal(course.points, 18);
  assert.equal(progress(), true);

  // Same student configuration, different profile via Settings. Only QoS should fail.
  lab.updateSettings({ qosClassifiesInnerHeader: false });
  assert.equal(lab.getState().report, null, 'the old course-profile result is no longer shown');
  const espOnly = lab.check();
  assert.deepEqual(failedIds(espOnly.requirements), ['qos']);
  assert.match(qosChecks(espOnly).find((c) => c.id === 'qos/r1-priority')?.trace?.map((s) => s.detail).join(' ') ?? '', /classified on the ESP wrapper/);
  assert.equal(progress(), false);

  // Real outer-header matching can select a queue, but a catch-all ESP match cannot separate services in the same tunnel.
  config('R1', 'ip access-list extended matchPriority\n permit esp any any');
  const outerMatch = qosChecks(lab.check());
  assert.equal(outerMatch.find((c) => c.id === 'qos/r1-priority')?.pass, true);
  assert.ok(failedIds(outerMatch).includes('qos/r1-guaranteed'));
  config('R1', 'ip access-list extended matchPriority\n no permit esp any any');

  // A command on a map that is not attached does nothing; each active sender is checked independently.
  config('R1', 'crypto map UNUSED 10 ipsec-isakmp\n qos pre-classify');
  assert.deepEqual(failedIds(qosChecks(lab.check())), failedIds(qosChecks(espOnly)));
  config('R1', 'crypto map CM 10 ipsec-isakmp\n qos pre-classify');
  assert.deepEqual(failedIds(qosChecks(lab.check())), ['qos/r2-priority', 'qos/r2-guaranteed']);
  config('R2', 'crypto map CM 10 ipsec-isakmp\n qos pre-classify');
  const preClassified = lab.check();
  assert.deepEqual(failedIds(preClassified.requirements), []);
  assert.equal(preClassified.points, 18);
  assert.equal(progress(), true);

  const resumed = new Lab({ scenarios: [def] });
  ok(resumed.importLab(lab.exportLab()));
  assert.equal(resumed.getState().settings.qosClassifiesInnerHeader, false);
  assert.equal(resumed.check().points, 18);
});
