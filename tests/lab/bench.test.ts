/** Bench: cabling validation and journal, port status, the strict-cable rule, moving devices. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GI, SE, cableBench, cableId, consoleToConfig, makeLab, ok, port, type, world } from './fixture.ts';

const GI1 = 'GigabitEthernet0/0/1';

function start(mode: 'guided' | 'free' | 'exam' = 'free') {
  const h = makeLab();
  ok(h.lab.startScenario('mini', mode));
  return h;
}

test('connectCable refuses what is physically impossible, in plain words', () => {
  const { lab } = start();
  const before = lab.getState();
  const no = (r: { ok: boolean; message?: string }, re: RegExp) => { assert.equal(r.ok, false); assert.match(r.message ?? '', re); };
  no(lab.connectCable('straight', port('PC1', 'Ethernet0'), port('R1', 'Nope0')), /does not exist/);
  no(lab.connectCable('straight', port('ghost', 'Ethernet0'), port('R1', GI)), /does not exist/);
  no(lab.connectCable('straight', port('R1', GI), port('R1', GI)), /same port/);
  no(lab.connectCable('serial', port('PC1', 'Ethernet0'), port('R1', GI)), /serial cable only fits the Serial ports/i);
  no(lab.connectCable('straight', port('R1', SE), port('R2', SE)), /does not fit a Serial port/);
  no(lab.connectCable('crossover', port('PC1', 'COM1'), port('R1', GI)), /does not fit a PC's COM port/);
  no(lab.connectCable('console', port('R1', 'Console'), port('R2', 'Console')), /from a PC's COM port/);
  no(lab.connectCable('fibre' as never, port('PC1', 'Ethernet0'), port('R1', GI)), /Pick a cable/);
  no(lab.connectCable('straight', null as never, port('R1', GI)), /two ports/);
  assert.equal(lab.getState(), before, 'a refused cable changes nothing');
  assert.deepEqual(world(lab).cables, []);
});

test('one cable per port', () => {
  const { lab } = start();
  ok(lab.connectCable('crossover', port('PC1', 'Ethernet0'), port('R1', GI)));
  const r = lab.connectCable('crossover', port('PC2', 'Ethernet0'), port('R1', GI));
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /R1 GigabitEthernet0\/0\/0 already has a cable\. Unplug it first/);
  assert.equal(world(lab).cables.length, 1);
});

test('wrong but possible combinations are plugged in and simply give no link', () => {
  const { lab } = start();
  // straight cable PC–router: fits, but the pair needs a crossover
  const a = ok(lab.connectCable('straight', port('PC1', 'Ethernet0'), port('R1', GI)));
  assert.match(a.message ?? '', /needs a crossover cable/);
  // Ethernet cable in a console port
  const b = ok(lab.connectCable('crossover', port('PC2', 'Ethernet0'), port('R2', 'Console')));
  assert.match(b.message ?? '', /console port carries no network traffic/);
  // console cable in an Ethernet port
  const c = ok(lab.connectCable('console', port('PC1', 'COM1'), port('R1', GI1)));
  assert.match(c.message ?? '', /Plug it into the port marked CON/);
  assert.equal(world(lab).cables.length, 3);
  const st = lab.portStatus(port('PC1', 'Ethernet0'));
  assert.equal(st.led, 'amber');
  assert.equal(st.status, 'down/down');
  assert.equal(st.cableKind, 'straight');
  assert.match(st.problem ?? '', /needs a crossover cable/);
  assert.equal(lab.portStatus(port('R2', 'Console')).led, 'amber');
  assert.equal(lab.portStatus(port('PC1', 'COM1')).led, 'amber');
  assert.equal(lab.consolePcOf('R1'), null, 'a console cable in an Ethernet port gives no console');
  const open = lab.openConsole('R1');
  assert.equal(open.ok, false);
  assert.match(open.ok ? '' : open.message, /console cable from PC1 COM1 is plugged into GigabitEthernet0\/0\/1 of R1.*Move that end to the port marked CON/);
});

test('a serial cable defaults its DCE end to the first port; the journal records every cable action', () => {
  const { lab } = start();
  ok(lab.connectCable('serial', port('R1', SE), port('R2', SE)));
  ok(lab.connectCable('console', port('PC1', 'COM1'), port('R1', 'Console')));
  ok(lab.connectCable('crossover', port('PC1', 'Ethernet0'), port('R1', GI)));
  const w = world(lab);
  assert.equal(w.cables[0].dceEnd, 'a');
  assert.equal('dceEnd' in w.cables[1], false, 'only serial cables carry a DCE end');
  assert.equal(lab.portStatus(port('R1', SE)).dce, true);
  assert.equal(lab.portStatus(port('R2', SE)).dce, false);
  ok(lab.removeCable(cableId(lab, port('R1', SE))));
  ok(lab.connectCable('serial', port('R1', SE), port('R2', SE), { dceEnd: 'b' }));
  assert.equal(lab.portStatus(port('R2', SE)).dce, true);
  const j = lab.getState().journal;
  assert.deepEqual(j.map((e) => [e.via, e.feature, e.ok, e.mutated, e.deviceId]), [
    ['bench', 'cabling', true, true, 'R1'],
    ['bench', 'console', true, true, 'PC1'],
    ['bench', 'cabling', true, true, 'PC1'],
    ['bench', 'cabling', true, true, 'R1'],
    ['bench', 'cabling', true, true, 'R1'],
  ]);
  assert.equal(j[0].line, 'Plug in serial cable: R1 Serial0/1/0 to R2 Serial0/1/0 (DCE end at R1 Serial0/1/0)');
  assert.equal(j[1].line, 'Plug in console cable: PC1 COM1 to R1 Console');
  assert.equal(j[3].line, 'Unplug serial cable: R1 Serial0/1/0 to R2 Serial0/1/0');
  assert.match(j[4].line, /DCE end at R2 Serial0\/1\/0/);
  assert.ok(j.every((e, i) => i === 0 || e.tick > j[i - 1].tick), 'the logical clock moves with every action');
  const gone = lab.removeCable('cable-999');
  assert.equal(gone.ok, false);
  assert.match(gone.message ?? '', /not on the bench/);
});

test('portStatus: LED, IOS-style status, problem text and a safe answer for unknown ports', () => {
  const { lab } = start();
  assert.deepEqual(lab.portStatus(port('R1', GI)), { ref: port('R1', GI), kind: 'ethernet', led: 'off', status: 'administratively down/down' });
  assert.deepEqual(lab.portStatus(port('PC1', 'COM1')), { ref: port('PC1', 'COM1'), kind: 'rs232', led: 'off' });
  assert.deepEqual(lab.portStatus(port('R1', 'Console')), { ref: port('R1', 'Console'), kind: 'console', led: 'off' });
  assert.deepEqual(lab.portStatus(port('nobody', 'x')), { ref: port('nobody', 'x'), kind: 'ethernet', led: 'off' });
  assert.equal(lab.portStatus(undefined as never).led, 'off');
  cableBench(lab);
  let st = lab.portStatus(port('R1', GI));
  assert.equal(st.led, 'amber');
  assert.equal(st.status, 'administratively down/down');
  assert.match(st.problem ?? '', /is shut down\. Enter "no shutdown"/);
  assert.equal(st.cableKind, 'crossover');
  assert.equal(st.cableId, cableId(lab, port('PC1', 'Ethernet0')));
  assert.equal(lab.portStatus(port('PC1', 'Ethernet0')).status, 'down/down');
  const con = consoleToConfig(lab, 'PC1', 'R1');
  type(lab, con, [`interface ${GI}`, 'no shutdown']);
  st = lab.portStatus(port('R1', GI));
  assert.deepEqual([st.led, st.status, st.problem], ['green', 'up/up', undefined]);
  assert.deepEqual([lab.portStatus(port('PC1', 'Ethernet0')).led, lab.portStatus(port('PC1', 'Ethernet0')).status], ['green', 'up/up']);
  assert.equal(lab.portStatus(port('R1', 'Console')).led, 'green');
  assert.equal(lab.portStatus(port('PC1', 'COM1')).cableKind, 'console');
  // serial: R1 is up, R2 still shut → down/down with a reason that names the other end
  type(lab, con, [`interface ${SE}`, 'no shutdown']);
  st = lab.portStatus(port('R1', SE));
  assert.equal(st.status, 'down/down');
  assert.match(st.problem ?? '', /other end of the cable \(R2 Serial0\/1\/0\) is shut down/);
});

test('exam mode gives no problem texts and no cable warnings', () => {
  const { lab } = start('exam');
  const r = ok(lab.connectCable('straight', port('PC1', 'Ethernet0'), port('R1', GI)));
  assert.equal(r.message, undefined);
  const st = lab.portStatus(port('PC1', 'Ethernet0'));
  assert.equal(st.led, 'amber');
  assert.equal(st.status, 'down/down');
  assert.equal(st.problem, undefined);
  ok(lab.connectCable('crossover', port('PC2', 'Ethernet0'), port('R2', 'Console')));
  assert.equal(lab.portStatus(port('R2', 'Console')).problem, undefined);
});

test('the strict-cable rule follows the setting, changes links at once, and is locked in the exam', () => {
  const { lab } = start();
  ok(lab.connectCable('straight', port('PC1', 'Ethernet0'), port('R1', GI)));
  const con = consoleToConfig(lab, 'PC1', 'R1');
  type(lab, con, [`interface ${GI}`, 'no shutdown']);
  assert.equal(lab.portStatus(port('R1', GI)).status, 'down/down');
  const journalBefore = lab.getState().journal.length;
  lab.updateSettings({ strictCables: false });
  assert.equal(lab.getState().settings.strictCables, false);
  assert.equal(world(lab).settings.strictCables, false);
  assert.equal(lab.portStatus(port('R1', GI)).status, 'up/up');
  const j = lab.getState().journal;
  assert.equal(j.length, journalBefore + 1);
  assert.equal(j[j.length - 1].via, 'bench');
  // the open console shows the link coming up with its next output
  const v = lab.sessionExec(con, 'exit');
  assert.match(v.output, /%LINK-3-UPDOWN: Interface GigabitEthernet0\/0\/0, changed state to up/);
  lab.updateSettings({ strictCables: true });
  assert.equal(lab.portStatus(port('R1', GI)).status, 'down/down');

  const exam = start('exam').lab;
  exam.updateSettings({ strictCables: false, fontScale: 1.2 });
  assert.equal(exam.getState().settings.strictCables, true, 'locked during an exam');
  assert.equal(world(exam).settings.strictCables, true);
  assert.equal(exam.getState().settings.fontScale, 1.2, 'the other settings still change');
});

test('a new lab uses the preferred cable rule', () => {
  const { lab } = makeLab();
  lab.updateSettings({ strictCables: false });
  ok(lab.startScenario('mini', 'free'));
  assert.equal(world(lab).settings.strictCables, false);
  ok(lab.connectCable('straight', port('PC1', 'Ethernet0'), port('R1', GI)));
  assert.equal(lab.portStatus(port('PC1', 'Ethernet0')).problem, 'The other end of the cable (R1 GigabitEthernet0/0/0) is shut down. Enter "no shutdown" there.');
});

test('moveDevice moves, ignores nonsense and does not journal', () => {
  const { lab } = start();
  lab.moveDevice('PC1', 40.5, 60);
  assert.deepEqual([world(lab).devices.PC1.x, world(lab).devices.PC1.y], [40.5, 60]);
  const s = lab.getState();
  lab.moveDevice('PC1', Number.NaN, 1);
  lab.moveDevice('PC1', 'left' as never, 1);
  lab.moveDevice('PC1', Infinity, 1);
  assert.equal(lab.getState(), s);
  assert.deepEqual(s.journal, []);
});
