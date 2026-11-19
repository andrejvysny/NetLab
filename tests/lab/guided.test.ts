/** Guided mode: actions that belong to another step or another device are stopped and explained. Free and exam never block. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GI, R1_CONFIG, SE, SOLUTION, cableBench, cableId, consoleToConfig, makeLab, ok, plugConsole, port, type, world,
} from './fixture.ts';
import type { IosDevice, PcDevice } from '../../src/engine/types.ts';

function start(mode: 'guided' | 'free' | 'exam' = 'guided') {
  const h = makeLab();
  ok(h.lab.startScenario('mini', mode));
  return h;
}
const ios = (lab: ReturnType<typeof start>['lab'], id: string) => world(lab).devices[id] as IosDevice;
const active = (lab: ReturnType<typeof start>['lab']) => lab.getState().scenario!.guide.find((g) => g.status === 'active')?.id;

test('step 1 (cabling): console cables and looking around are always allowed, configuration is not', () => {
  const { lab } = start();
  assert.equal(active(lab), 'cable');
  const id = consoleToConfig(lab, 'PC1', 'R1'); // console cable, dialog, enable, configure terminal: all fine
  assert.equal(lab.getState().sessions[0].prompt, 'Router(config)#');
  const before = structuredClone(ios(lab, 'R1').config);
  const v = lab.sessionExec(id, 'hostname R1');
  assert.ok(v.blocked);
  assert.deepEqual(v.blocked, {
    stepId: 'cable', stepNo: 1, stepTitle: 'Cable the bench',
    reason: 'You typed "hostname R1". Basic device settings are step 2. You are on step 1: Cable the bench. Finish step 1 first. Nothing was changed.',
  });
  assert.equal(v.output, '');
  assert.equal(v.prompt, 'Router(config)#');
  assert.equal(v.closed, false);
  assert.deepEqual(ios(lab, 'R1').config, before, 'nothing was executed');
  const j = lab.getState().journal.at(-1)!;
  assert.deepEqual([j.line, j.blocked, j.ok, j.mutated, j.stepId, j.feature, j.via, j.mode], ['hostname R1', true, false, false, 'cable', 'system', 'console', 'config']);
  // navigation and show commands are never stopped
  for (const line of ['interface g0/0/0', 'exit', 'do show running-config', 'end', 'show running-config', 'disable', 'enable']) {
    assert.equal(lab.sessionExec(id, line).blocked, undefined, line);
  }
  // a feature no step allows
  type(lab, id, ['configure terminal']);
  const nat = lab.sessionExec(id, 'ip nat inside source static 10.0.1.10 10.0.12.5');
  assert.equal(nat.blocked?.reason, 'You typed "ip nat inside source static 10.0.1.10 10.0.12.5". NAT is not part of this step, and no later step needs it. You are on step 1: Cable the bench. Stay with step 1. Nothing was changed.');
});

test('the step ahead is named; finishing a step unlocks the next one; finished steps stay finished and stay open', () => {
  const { lab } = start();
  cableBench(lab);
  assert.equal(active(lab), 'r1');
  const id = consoleToConfig(lab, 'PC1', 'R1');
  // routing is step 3: jumping ahead is stopped
  const route = lab.sessionExec(id, 'ip route 10.0.2.0 255.255.255.0 10.0.12.2');
  assert.equal(route.blocked?.reason, 'You typed "ip route 10.0.2.0 255.255.255.0 10.0.12.2". Routing is step 3. You are on step 2: Set up R1. Finish step 2 first. Nothing was changed.');
  assert.equal(route.blocked?.stepNo, 2, 'the block names the step to work on now');
  assert.deepEqual(ios(lab, 'R1').config.staticRoutes, []);
  // cabling was step 1: work of a finished step is never stopped (he may have to repair it) …
  const cable = lab.removeCable(cableId(lab, port('R1', SE)));
  assert.deepEqual(cable, { ok: true });
  // … and a finished step stays finished: the guide never sends him back
  assert.deepEqual(lab.getState().scenario!.guide.map((g) => g.status), ['done', 'active', 'locked']);
  ok(lab.connectCable('serial', port('R1', SE), port('R2', SE)));
  // the step's own work goes through
  for (const v of type(lab, id, ['hostname R1', `interface ${GI}`, 'ip address 10.0.1.1 255.255.255.0', 'no shutdown'])) assert.equal(v.blocked, undefined);
  assert.equal(active(lab), 'route');
  assert.equal(lab.sessionExec(id, 'ip route 10.0.2.0 255.255.255.0 10.0.12.2').blocked, undefined);
  assert.equal(ios(lab, 'R1').config.staticRoutes.length, 1);
  // breaking step 2 again (shutdown) does not move the guide back
  type(lab, id, [`interface ${GI}`, 'shutdown']);
  assert.deepEqual(lab.getState().scenario!.guide.map((g) => g.status), ['done', 'done', 'active']);
  assert.equal(lab.sessionExec(id, 'no shutdown').blocked, undefined);
  // journal entries of executed lines carry the step that was active
  const done = lab.getState().journal.filter((e) => e.line === 'hostname R1');
  assert.deepEqual(done.map((e) => [e.blocked, e.stepId]), [[undefined, 'r1']]);
});

test('a step that is satisfied before its turn does not count until the guide gets there', () => {
  const { lab } = start();
  // step 2 (R1 basics) done first, through the always-allowed console … not possible in guided mode; use the file of a restore:
  ok(lab.startScenario('mini', 'free'));
  const id = consoleToConfig(lab, 'PC1', 'R1');
  type(lab, id, ['hostname R1', `interface ${GI}`, 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'end']);
  const saved = JSON.parse(lab.exportLab());
  // the same bench as a guided lab: step 2 is satisfied, but step 1 (cabling) is not
  ok(lab.importLab(JSON.stringify({ ...saved, mode: 'guided' })));
  assert.deepEqual(lab.getState().scenario!.guide.map((g) => g.status), ['active', 'locked', 'locked']);
  cableBench(lab);
  assert.deepEqual(lab.getState().scenario!.guide.map((g) => g.status), ['done', 'done', 'active'], 'now both count');
});

test('the wrong device is named', () => {
  const { lab } = start();
  cableBench(lab);
  const id = consoleToConfig(lab, 'PC1', 'R2'); // step 2 is about R1
  const v = lab.sessionExec(id, 'hostname R2');
  assert.equal(v.blocked?.reason,
    'You typed "hostname R2" on R2. Step 2 is about R1, not R2. Basic device settings on R2 are step 3. You are on step 2: Set up R1. Do this step on R1 first. Nothing was changed.');
  assert.equal(ios(lab, 'R2').config.hostname, 'Router');
  // a PC setting in a step that does not allow it
  const pc = lab.setPcNic('PC1', { mode: 'static', address: '10.0.1.10', mask: '255.255.255.0' });
  assert.equal(pc.ok, false);
  assert.equal(pc.blocked?.reason, 'You tried to change the network settings of PC1. PC settings are step 3. You are on step 2: Set up R1. Finish step 2 first. Nothing was changed.');
  assert.equal((world(lab).devices.PC1 as PcDevice).nic.address, undefined);
  const j = lab.getState().journal.at(-1)!;
  assert.deepEqual([j.via, j.feature, j.blocked, j.deviceId], ['pc', 'pc', true, 'PC1']);
  // looking around on a PC is never stopped; asking for an address on a DHCP adapter is not a change of settings
  assert.equal(lab.pcExec('PC1', 'ping 10.0.1.1').output, 'Request timed out.\n');
  assert.equal(lab.getState().journal.at(-1)!.blocked, undefined);
  assert.match(lab.pcExec('PC2', 'ipconfig /renew').output, /^No DHCP server/);
  assert.equal(lab.setPcNic('PC2', { mode: 'dhcp' }).blocked, undefined);
});

test('PC commands that change the adapter settings follow the step rule', () => {
  const { lab } = start();
  cableBench(lab);
  assert.equal(active(lab), 'r1'); // step 2 is about R1; PC settings come in step 3, and only for PC1
  const stopped = lab.pcExec('PC1', 'setip 10.0.1.10 255.255.255.0');
  assert.equal(stopped.output,
    'The guide stopped this command. You typed "setip 10.0.1.10 255.255.255.0" on PC1. That changes the network settings of the PC. '
    + 'PC settings are step 3. You are on step 2: Set up R1. Finish step 2 first. Nothing was changed.\n\n');
  assert.equal((world(lab).devices.PC1 as PcDevice).nic.mode, 'dhcp');
  const j = lab.getState().journal.at(-1)!;
  assert.deepEqual([j.via, j.line, j.feature, j.blocked, j.stepId], ['pc', 'setip 10.0.1.10 255.255.255.0', 'pc', true, 'r1']);
  // in step 3 the same command runs on PC1 — but PC2 is not part of any step
  const id = consoleToConfig(lab, 'PC1', 'R1');
  type(lab, id, ['hostname R1', `interface ${GI}`, 'ip address 10.0.1.1 255.255.255.0', 'no shutdown']);
  assert.equal(active(lab), 'route');
  assert.equal(lab.pcExec('PC1', 'setip 10.0.1.10 255.255.255.0').output, 'Ok.\n');
  assert.equal((world(lab).devices.PC1 as PcDevice).nic.address, '10.0.1.10');
  assert.deepEqual([lab.getState().journal.at(-1)!.feature, lab.getState().journal.at(-1)!.mutated], ['pc', true]);
  assert.match(lab.pcExec('PC2', 'setip 10.0.2.10 255.255.255.0').output, /^The guide stopped this command\..*Step 3 is about R1, R2 and PC1, not PC2\./);
});

test('a config file is checked line by line: the first line that is not allowed stops the whole file', () => {
  const { lab } = start();
  cableBench(lab);
  plugConsole(lab, 'PC1', 'R1');
  const before = structuredClone(ios(lab, 'R1').config);
  const rev = lab.getState().rev;
  const rep = lab.applyConfigText('R1', R1_CONFIG, 'merge');
  assert.equal(rep.ok, false);
  assert.deepEqual([rep.applied, rep.failed, rep.lines.length], [0, 0, 0]);
  assert.equal(rep.blocked?.reason,
    'Line 9 of the file is "ip route 10.0.2.0 255.255.255.0 10.0.12.2". Routing is step 3. You are on step 2: Set up R1. Finish step 2 first. Nothing was applied. Take that line out, or finish the step first.');
  assert.equal(rep.message, rep.blocked?.reason);
  assert.deepEqual(ios(lab, 'R1').config, before, 'not even the allowed lines above it were applied');
  assert.equal(lab.getState().rev, rev + 1);
  const j = lab.getState().journal.at(-1)!;
  assert.deepEqual([j.via, j.line, j.blocked, j.feature, j.stepId], ['file', 'ip route 10.0.2.0 255.255.255.0 10.0.12.2', true, 'routing', 'r1']);
  // only this step's lines: applied
  const own = lab.applyConfigText('R1', 'hostname R1\ninterface GigabitEthernet0/0/0\n ip address 10.0.1.1 255.255.255.0\n no shutdown\n', 'merge');
  assert.deepEqual([own.ok, own.applied, own.failed, own.blocked], [true, 4, 0, undefined]);
  assert.equal(active(lab), 'route');
});

test('a file may repeat lines of other steps as long as they change nothing', () => {
  const { lab } = start();
  cableBench(lab);
  const id = consoleToConfig(lab, 'PC1', 'R1');
  type(lab, id, ['hostname R1', `interface ${GI}`, 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'end']);
  assert.equal(active(lab), 'route');
  // step 3 does not allow cabling/acl…, but allows system/interface/routing. Add an ACL line (no step allows it) → blocked.
  const running = lab.getConfigText('R1', 'running');
  const withAcl = lab.applyConfigText('R1', `${running.replace(/\nend\n$/, '\n')}access-list 10 permit any\nend\n`, 'merge');
  assert.match(withAcl.blocked?.reason ?? '', /^Line \d+ of the file is "access-list 10 permit any"\. Access lists \(ACL\) are not part of this step, and no later step needs them\./);
  // the device's own running-config plus a route: fine, although the file is full of lines of other topics (line vty …)
  const plus = lab.applyConfigText('R1', `${running.replace(/\nend\n$/, '\n')}ip route 10.0.2.0 255.255.255.0 10.0.12.2\nend\n`, 'merge');
  assert.equal(plus.blocked, undefined);
  assert.equal(plus.failed, 0, JSON.stringify(plus.lines.filter((l) => !l.ok)));
  assert.equal(ios(lab, 'R1').config.staticRoutes.length, 1);
  // replace with the full file: same result as merge, so it is allowed
  const full = lab.getConfigText('R1', 'running');
  const same = lab.applyConfigText('R1', full, 'replace');
  assert.equal(same.blocked, undefined);
  assert.equal(ios(lab, 'R1').config.hostname, 'R1');
  // replace with a file that drops the earlier work: stopped
  const drop = lab.applyConfigText('R1', 'ip route 10.0.2.0 255.255.255.0 10.0.12.2\n', 'replace');
  assert.match(drop.blocked?.reason ?? '', /discards the old running configuration on R1.*You are on step 3: Reach R2\. Use "Apply to running config" instead/);
  assert.equal(ios(lab, 'R1').config.hostname, 'R1');
  // a file for the wrong device
  plugConsole(lab, 'PC1', 'R2');
  ok(lab.startScenario('mini', 'guided'));
  cableBench(lab);
  plugConsole(lab, 'PC1', 'R2');
  const wrong = lab.applyConfigText('R2', 'hostname R2\n', 'merge');
  assert.match(wrong.blocked?.reason ?? '', /^Line 1 of the file is "hostname R2", and the file is for R2\. Step 2 is about R1, not R2\./);
});

test('free and exam modes never block', () => {
  for (const mode of ['free', 'exam'] as const) {
    const { lab } = start(mode);
    const id = consoleToConfig(lab, 'PC1', 'R2');
    for (const v of type(lab, id, ['hostname R2', 'ip route 0.0.0.0 0.0.0.0 10.0.12.1', 'access-list 10 permit any', 'ip nat inside source static 10.0.1.10 10.0.12.5'])) {
      assert.equal(v.blocked, undefined, mode);
    }
    assert.equal(ios(lab, 'R2').config.hostname, 'R2');
    ok(lab.setPcNic('PC1', { mode: 'static', address: '10.0.1.10', mask: '255.255.255.0' }));
    cableBench(lab);
    plugConsole(lab, 'PC1', 'R1');
    const rep = lab.applyConfigText('R1', SOLUTION.configs.R1, 'replace');
    assert.deepEqual([rep.ok, rep.blocked, rep.failed], [true, undefined, 0], mode);
    ok(lab.removeCable(cableId(lab, port('R1', SE))));
    assert.ok(!lab.getState().journal.some((e) => e.blocked), mode);
  }
});

test('when every step is done nothing is blocked any more', () => {
  const { lab } = makeLab();
  ok(lab.startScenario('mini-prebuilt', 'guided'));
  assert.deepEqual(lab.getState().scenario!.guide.map((g) => g.status), ['done', 'done', 'done']);
  ok(lab.connectCable('console', port('PC1', 'COM1'), port('R1', 'Console')));
  const open = lab.openConsole('R1');
  const id = open.ok ? open.session.id : '';
  for (const v of type(lab, id, ['enable', 'configure terminal', 'access-list 10 permit any', 'ip nat inside source list 10 interface Serial0/1/0 overload'])) {
    assert.equal(v.blocked, undefined);
  }
});
