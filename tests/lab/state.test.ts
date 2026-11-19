/** State identity and rev semantics, scenario start / restart / leave, the scenario view. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GI, SE, buildSolution, cableBench, consoleToConfig, makeLab, miniScenario, ok, port, type, world } from './fixture.ts';
import { Lab } from '../../src/engine/lab.ts';

test('a new lab has no scenario and a stable state object', () => {
  const { lab } = makeLab();
  const s = lab.getState();
  assert.equal(s.rev, 0);
  assert.equal(s.scenario, null);
  assert.equal(s.world, null);
  assert.deepEqual(s.sessions, []);
  assert.deepEqual(s.journal, []);
  assert.equal(s.report, null);
  assert.equal(lab.getState(), s, 'same object until something changes');
  assert.deepEqual(s.settings, { strictCables: true, qosClassifiesInnerHeader: true, fontScale: 1, font: 'lexend', terminalFontPx: 14, terminalPaging: true, reduceMotion: false });
});

test('getState and subscribe work unbound (useSyncExternalStore passes them that way)', () => {
  const { lab } = makeLab();
  const { getState, subscribe } = lab;
  let calls = 0;
  const off = subscribe(() => { calls++; });
  ok(lab.startScenario('mini', 'free'));
  assert.equal(calls, 1);
  assert.equal(getState().scenario?.summary.id, 'mini');
  off();
  lab.moveDevice('R1', 5, 6);
  assert.equal(calls, 1, 'unsubscribed listeners are not called');
});

test('every change publishes a new state object with rev + 1 and a new world reference', () => {
  const { lab } = makeLab();
  ok(lab.startScenario('mini', 'free'));
  const a = lab.getState();
  assert.equal(lab.getState(), a);
  lab.moveDevice('R1', 11, 22);
  const b = lab.getState();
  assert.notEqual(b, a);
  assert.equal(b.rev, a.rev + 1);
  assert.notEqual(b.world, a.world, 'new top-level world object');
  assert.equal(b.world?.devices.R1.x, 11);
  // nothing changes → same object
  lab.moveDevice('R1', 11, 22);
  lab.moveDevice('nobody', 1, 1);
  assert.equal(lab.getState(), b);
  // read-only calls never publish
  lab.portStatus(port('R1', GI));
  lab.consolePcOf('R1');
  lab.listScenarios();
  lab.solution();
  lab.commandSheet();
  lab.exportLab();
  lab.trace({ fromDeviceId: 'PC1', dst: '10.0.1.1', proto: 'icmp' });
  assert.equal(lab.getState(), b);
  ok(lab.connectCable('crossover', port('PC1', 'Ethernet0'), port('R1', GI)));
  const c = lab.getState();
  assert.equal(c.rev, b.rev + 1);
  assert.notEqual(c.journal, b.journal, 'the journal array is replaced when an entry is added');
  assert.equal(b.journal.length, 0, 'older snapshots keep their journal');
});

test('a listener that throws does not stop the lab or the other listeners', () => {
  const { lab } = makeLab();
  let seen = 0;
  lab.subscribe(() => { throw new Error('bad listener'); });
  lab.subscribe(() => { seen++; });
  ok(lab.startScenario('mini', 'free'));
  assert.equal(seen, 1);
});

test('listScenarios returns the summaries; the default registry is used when none is given', () => {
  const { lab } = makeLab();
  assert.deepEqual(lab.listScenarios().map((s) => s.id), ['mini', 'mini-prebuilt']);
  const plain = new Lab({ storage: null });
  assert.ok(Array.isArray(plain.listScenarios()));
  assert.equal(plain.getState().storage.available, false);
});

test('startScenario builds the bench: devices from the scenario, nothing cabled, nothing configured', () => {
  const { lab, clock } = makeLab();
  assert.deepEqual(lab.startScenario('nope', 'free'), { ok: false, message: 'There is no assignment called "nope".' });
  assert.equal(lab.startScenario('mini', 'weird' as never).ok, false);
  ok(lab.startScenario('mini', 'exam', { timerMinutes: 180, seed: 7 }));
  const s = lab.getState();
  const sc = s.scenario!;
  assert.equal(sc.mode, 'exam');
  assert.equal(sc.seed, 7);
  assert.equal(sc.timerMinutes, 180);
  assert.equal(sc.startedAt, clock.t);
  assert.equal(sc.finished, false);
  assert.equal(sc.hintsUsed, 0);
  assert.deepEqual(sc.guide, [], 'exam mode carries no guide');
  assert.equal(sc.requirements.length, 4);
  assert.equal(sc.brief.intro, 'Connect PC1 to R2 through R1.');
  assert.deepEqual(world(lab).order, ['R1', 'R2', 'PC1', 'PC2']);
  assert.deepEqual(world(lab).cables, []);
  assert.deepEqual(s.journal, []);
  assert.deepEqual(s.sessions, []);
  assert.equal(s.report, null);
});

test('guide statuses: guided is strictly sequential, free shows what is done, both follow guideProgress', () => {
  const { lab } = makeLab();
  ok(lab.startScenario('mini', 'guided'));
  const st = () => lab.getState().scenario!.guide.map((g) => `${g.id}:${g.status}`);
  assert.deepEqual(st(), ['cable:active', 'r1:locked', 'route:locked']);
  cableBench(lab);
  assert.deepEqual(st(), ['cable:done', 'r1:active', 'route:locked']);
  // un-doing a step makes it the active step again
  const id = lab.portStatus(port('R1', SE)).cableId!;
  // (cabling is not allowed in step 2, so do it in free mode)
  ok(lab.startScenario('mini', 'free'));
  assert.deepEqual(st(), ['cable:active', 'r1:locked', 'route:locked']);
  const con = consoleToConfig(lab, 'PC1', 'R1');
  type(lab, con, ['hostname R1', `interface ${GI}`, 'ip address 10.0.1.1 255.255.255.0', 'no shutdown']);
  assert.deepEqual(st(), ['cable:active', 'r1:done', 'route:locked'], 'free mode: a later step that is satisfied shows as done');
  cableBench(lab);
  assert.deepEqual(st(), ['cable:done', 'r1:done', 'route:active']);
  assert.ok(id);
});

test('restartScenario gives a fresh bench with a new startedAt; leaveScenario goes back to no scenario', () => {
  const { lab, clock } = makeLab();
  lab.restartScenario();
  lab.leaveScenario();
  assert.equal(lab.getState().rev, 0, 'nothing to restart or leave');
  ok(lab.startScenario('mini', 'guided', { seed: 3 }));
  cableBench(lab);
  lab.noteHintUsed('cable');
  const first = lab.getState().scenario!;
  assert.equal(world(lab).cables.length, 3);
  lab.restartScenario();
  const again = lab.getState().scenario!;
  assert.equal(again.mode, 'guided');
  assert.equal(again.seed, 3);
  assert.notEqual(again.startedAt, first.startedAt, 'the UI uses startedAt as the key of a fresh bench');
  assert.equal(again.hintsUsed, 0);
  assert.equal(world(lab).cables.length, 0);
  assert.deepEqual(lab.getState().journal, []);
  clock.t += 60_000;
  lab.leaveScenario();
  const s = lab.getState();
  assert.equal(s.scenario, null);
  assert.equal(s.world, null);
  assert.deepEqual(s.sessions, []);
  assert.deepEqual(s.journal, []);
  assert.equal(s.report, null);
  // every method is harmless without a lab
  assert.equal(lab.connectCable('straight', port('PC1', 'Ethernet0'), port('R1', GI)).ok, false);
  assert.equal(lab.openConsole('R1').ok, false);
});

test('a pre-built scenario starts cabled and configured, silently: no journal, no initial dialog, DHCP leases in place', () => {
  const { lab } = makeLab();
  ok(lab.startScenario('mini-prebuilt', 'free'));
  const w = world(lab);
  assert.equal(w.cables.length, 3);
  assert.deepEqual(lab.getState().journal, []);
  const r1 = w.devices.R1;
  assert.ok(r1.kind === 'router' && r1.config.hostname === 'R1' && r1.runtime.setupDialogDone);
  assert.ok(r1.kind === 'router' && r1.startupConfig !== null, 'a pre-configured device has its configuration saved');
  const pc1 = w.devices.PC1;
  const pc2 = w.devices.PC2;
  assert.ok(pc1.kind === 'pc' && pc1.nic.address === '10.0.1.10' && pc1.services.syslog);
  assert.ok(pc2.kind === 'pc' && pc2.nic.address === '10.0.2.2', 'PC2 got its lease while the lab was set up');
  assert.equal(lab.portStatus(port('R1', SE)).status, 'up/up');
  const rep = lab.check();
  assert.equal(rep.points, rep.maxPoints);
  // console: straight to the prompt
  ok(lab.connectCable('console', port('PC1', 'COM1'), port('R1', 'Console')));
  const open = lab.openConsole('R1');
  assert.ok(open.ok);
  assert.equal(open.ok && open.session.prompt, 'R1>');
  assert.doesNotMatch(open.ok ? open.banner : '', /Configuration Dialog/);
  assert.match(open.ok ? open.banner : '', /R1 con0 is now available/);
});

test('the whole fixture can be solved through LabApi', () => {
  const { lab } = makeLab();
  ok(lab.startScenario('mini', 'free'));
  buildSolution(lab);
  assert.deepEqual(lab.getState().scenario!.guide.map((g) => g.status), ['done', 'done', 'done']);
  const rep = lab.check();
  assert.equal(rep.points, 10);
});

test('a scenario whose build() throws gives a plain failure', () => {
  const broken = { ...miniScenario({ id: 'bad' }), build() { throw new Error('no bench today'); } };
  const { lab } = makeLab({ scenarios: [broken] });
  const r = lab.startScenario('bad', 'free');
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /could not be set up: no bench today/);
  assert.equal(lab.getState().scenario, null);
});
