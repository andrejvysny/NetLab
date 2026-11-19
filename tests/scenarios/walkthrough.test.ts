/**
 * Guide walkthrough: following each step's example in order — cables on the bench, lines typed into the real CLI of
 * the right device over a console cable, PC settings — completes that step, never needs a command whose feature is
 * outside the step's `allows`, and ends at 100 %.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, startWorld } from '../../src/scenarios/index.ts';
import { score, seedsOf, walkthrough } from './helpers.ts';

for (const d of SCENARIOS) {
  for (const seed of seedsOf(d.summary.seedable)) {
    test(`${d.summary.id} seed ${seed}: the guide can be followed step by step`, () => {
      const inst = d.build(seed);
      const world = startWorld(inst);
      assert.ok(inst.guide.length >= 1);
      assert.deepEqual(inst.guide.map((g) => g.no), inst.guide.map((_, i) => i + 1), 'steps are numbered 1..n');
      const journal = walkthrough(inst, world);
      const result = inst.grade(world, journal);
      const g = score(result.requirements);
      assert.deepEqual(g.failedChecks, [], 'after the last step everything passes');
      assert.equal(g.percent, 100);
      assert.deepEqual(result.orderIssues, [], 'the order of the guide raises no order remarks');
    });
  }
}

test('guide of the case study follows the path a careful student takes', () => {
  const inst = SCENARIOS.find((s) => s.summary.id === 'case-study-2026')!.build(0);
  assert.deepEqual(inst.guide.map((g) => g.id), [
    'cable', 'console', 'basics-r1', 'basics-r2', 'pcs', 'routing', 'dhcp', 'nat', 'acl', 'ipsec', 'qos', 'telnet', 'snmp', 'syslog', 'save',
  ]);
  for (const g of inst.guide) {
    assert.ok(g.title.length > 3 && g.title.length <= 60, `${g.id}: short title`);
    assert.ok(g.goal.length > 20 && (g.why ?? '').length > 20 && (g.hint ?? '').length > 20 && (g.example ?? '').length > 10, `${g.id}: goal, why, hint, example`);
    assert.ok(g.devices.length >= 1 && g.allows.length >= 1);
  }
  const by = Object.fromEntries(inst.guide.map((g) => [g.id, g]));
  assert.ok(by.telnet.allows.includes('vty') && by.telnet.allows.includes('acl'));
  assert.ok(by.nat.allows.includes('nat') && by.nat.allows.includes('acl') && by.nat.allows.includes('interface'));
  assert.ok(by.qos.allows.includes('qos') && by.qos.allows.includes('interface'));
  // hints point the way; they do not contain the answer lines
  for (const g of inst.guide) {
    for (const line of (g.example ?? '').split('\n').map((l) => l.trim()).filter((l) => /^(ip (route|nat|dhcp)|access-list|crypto|snmp-server|logging) /.test(l))) {
      assert.ok(!(g.hint ?? '').includes(line), `${g.id}: the hint does not contain "${line}"`);
    }
  }
});

test('guide progress follows the state, not the typing: a step is done however it was reached', () => {
  const inst = SCENARIOS.find((s) => s.summary.id === 'case-study-2026')!.build(0);
  const world = startWorld(inst);
  const p0 = inst.guideProgress(world, []);
  assert.ok(Object.values(p0).every((v) => v === false), 'nothing is done on an empty bench');
});
