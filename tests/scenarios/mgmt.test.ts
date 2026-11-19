import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyConfigText } from '../../src/engine/config/apply.ts';
import { probeFlow } from '../../src/engine/sim/index.ts';
import type { ScenarioInstance, World } from '../../src/engine/types.ts';
import { getIos } from '../../src/engine/world.ts';
import { def, solvedWorld } from './helpers.ts';

const exam = def('case-study-2026').build(0);
const focused = def('lab-mgmt').build(0);
const examWorld = solvedWorld(exam);
const focusedWorld = solvedWorld(focused);
const routers = ['R1', 'R2'] as const;

function config(w: World, router: string, lines: string): void {
  const r = applyConfigText(w, router, lines, 'merge');
  assert.deepEqual(r.lines.filter((line) => !line.ok).map((line) => `${line.line}: ${line.output}`), []);
}
function requirement(w: World, inst: ScenarioInstance, id: string) {
  return inst.grade(w, []).requirements.find((r) => r.id === id)!;
}
function check(w: World, inst: ScenarioInstance, req: string, id: string) {
  return requirement(w, inst, req).checks.find((c) => c.id === `${req}/${id}`)!;
}

test('case task 11 grades usable access rather than the example line password or authentication mode', () => {
  const w = structuredClone(examWorld);
  config(w, 'R1', 'line vty 0 14\n no password\n no login');
  config(w, 'R2', 'username admin secret anotherSecret\nline vty 0 4\n login local\nline vty 5 14\n password anotherPhrase\n login');
  assert.equal(requirement(w, exam, 'telnet').pass, true);
  assert.equal(exam.guideProgress(w, []).telnet, true);
  assert.match(exam.guide.find((step) => step.id === 'telnet')?.hint ?? '', /not a specific login mode/);
  config(w, 'R1', 'line vty 5 14\n no access-class allowPC1 in');
  assert.equal(check(w, exam, 'telnet', 'pc1-r1').pass, true);
  const source = check(w, exam, 'telnet', 'others-r1');
  assert.equal(source.pass, false, 'no login does not waive the source restriction');
  assert.match(source.observed, /R1 VTY 5 to 14 would permit a source other than PC1/);
});

test('case task 11 checks broken login, PC1 coverage and source policy beyond the first VTY on either router', () => {
  for (const id of routers) {
    const dst = id === 'R1' ? '192.168.100.1' : '60.50.30.2';
    const probe = { fromDeviceId: 'PC1', dst, proto: 'tcp' as const, dport: 23 };
    const w = structuredClone(examWorld);
    const suffix = id.toLowerCase();
    const dev = getIos(w, id);
    config(w, id, 'line vty 5 14\n no password');
    assert.equal(probeFlow(w, probe).vty?.login, 'password', 'idle VTY succeeds');
    dev.runtime.vtyInUse = 5;
    assert.equal(probeFlow(w, probe).vty?.login, 'password-not-set');
    assert.equal(probeFlow(w, probe).forward.received?.src, id === 'R1' ? '192.168.100.10' : '60.50.50.100');
    let result = check(w, exam, 'telnet', `pc1-${suffix}`);
    assert.equal(result.pass, false);
    assert.match(result.observed, /line vty 5 14.*Password required, but none set/);
    assert.equal(check(w, exam, 'telnet', `others-${suffix}`).pass, true, 'source rule is correct even if login is broken');
    assert.equal(dev.runtime.vtyInUse, 5, 'grading does not touch occupied lines');
    config(w, id, 'line vty 5 14\n login local');
    assert.match(check(w, exam, 'telnet', `pc1-${suffix}`).observed, /line vty 5 14.*no user with a password exists/);
    config(w, id, 'username noPassword privilege 1');
    assert.equal(check(w, exam, 'telnet', `pc1-${suffix}`).pass, false, 'a local user without credentials is not usable');

    config(w, id, 'access-list 77 deny any\nline vty 5 14\n access-class 77 in');
    result = check(w, exam, 'telnet', `pc1-${suffix}`);
    assert.equal(result.pass, false);
    assert.match(result.observed, /line vty 5 14.*does not permit that address/);
    config(w, id, 'line vty 5 14\n no access-class 77 in');
    assert.match(check(w, exam, 'telnet', `others-${suffix}`).observed, /VTY 5 to 14 would permit a source other than PC1/);
    config(w, id, 'line vty 5 14\n transport input ssh');
    assert.equal(requirement(w, exam, 'telnet').pass, true, 'non-Telnet ranges are exempt');
  }
});

test('a configured VTY after a numbering gap remains reachable and is checked', () => {
  const w = structuredClone(examWorld);
  config(w, 'R1', 'no line vty 5 8\nline vty 9\n no password');
  getIos(w, 'R1').runtime.vtyInUse = 5;
  const probe = probeFlow(w, { fromDeviceId: 'PC1', dst: '192.168.100.1', proto: 'tcp', dport: 23 });
  assert.deepEqual([probe.vty?.line?.first, probe.vty?.login], [9, 'password-not-set']);
  assert.match(check(w, exam, 'telnet', 'pc1-r1').observed, /line vty 9 9.*Password required, but none set/);
});

test('focused management lab requires the assigned line password and login on every Telnet-enabled VTY', () => {
  for (const id of routers) {
    for (const alternative of ['no login', 'password notAssigned', 'no password', 'login local']) {
      const w = structuredClone(focusedWorld);
      config(w, id, `username admin secret cisco\nline vty 9\n ${alternative}`);
      const result = check(w, focused, 'telnet', `pc1-${id.toLowerCase()}`);
      assert.equal(result.pass, false, `${id}: ${alternative}`);
      assert.match(result.observed, /VTY 9 to 9 does not use the assigned line password and login/);
      config(w, id, 'line vty 9\n password cisco\n login');
      assert.equal(requirement(w, focused, 'telnet').pass, true);
    }
  }
});

test('syslog grader separates global disablement, remote disablement, severity and delivery', () => {
  const w = structuredClone(focusedWorld);
  const status = () => check(w, focused, 'syslog', 'r2');
  assert.equal(status().pass, true);
  config(w, 'R2', 'logging trap warnings');
  assert.match(status().observed, /filters out the required debugging-level message/);
  assert.match(status().tip!, /logging trap debugging/);
  config(w, 'R2', 'no logging trap');
  assert.match(status().observed, /remote syslog disabled \(no logging trap\)/);
  config(w, 'R2', 'no logging on');
  assert.match(status().observed, /system logging disabled \(no logging on\)/);
  assert.match(status().tip!, /logging on/);
  config(w, 'R2', 'logging on');
  assert.match(status().observed, /remote syslog disabled/);
  config(w, 'R2', 'logging trap debugging');
  assert.equal(status().pass, true);
  const server = w.devices.PC1;
  assert.ok(server.kind === 'pc');
  server.services.syslog = false;
  assert.match(status().observed, /server on PC1 is switched off/);

  const full = structuredClone(examWorld);
  config(full, 'R2', 'logging trap emergencies');
  assert.equal(check(full, exam, 'syslog', 'r2').pass, true, 'case task 13 sets no severity threshold');
  config(full, 'R2', 'no logging trap');
  const off = check(full, exam, 'syslog', 'r2');
  assert.equal(off.pass, false);
  assert.match(off.observed, /remote syslog disabled/);
  assert.doesNotMatch(off.tip!, /debugging/);
});
