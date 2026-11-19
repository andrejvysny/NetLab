/** Learning tools, hints, solution visibility, grading (check / finishExam) and the 18-point scale. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GI, SE, SOLUTION, buildSolution, cableBench, consoleToConfig, makeLab, miniScenario, ok, port, type, world } from './fixture.ts';
import { COMMAND_SHEET } from '../../src/content/commandSheet.ts';

function start(id = 'mini', mode: 'guided' | 'free' | 'exam' = 'free') {
  const h = makeLab();
  ok(h.lab.startScenario(id, mode));
  return h;
}

test('trace follows a packet without changing anything', () => {
  const { lab } = start('mini-prebuilt');
  const state = lab.getState();
  const before = structuredClone(world(lab));
  const r = lab.trace({ fromDeviceId: 'PC1', dst: '10.0.12.2', proto: 'icmp' });
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.ok, true);
  assert.equal(r.symbol, '!');
  assert.ok(r.forward.steps.length > 2);
  const lost = lab.trace({ fromDeviceId: 'PC1', dst: '10.9.9.9', proto: 'tcp', dport: 80 });
  assert.ok(!('error' in lost) && lost.ok === false);
  assert.deepEqual(world(lab), before, 'the world is untouched');
  assert.equal(lab.getState(), state, 'no new state, no journal entry');
  // bad input → an error result, never an exception
  for (const spec of [null, {}, { fromDeviceId: 'nobody', dst: '10.0.1.1', proto: 'icmp' }, { fromDeviceId: 'PC1', dst: 'r2', proto: 'icmp' },
    { fromDeviceId: 'PC1', dst: '10.0.1.1', proto: 'smoke' }, { fromDeviceId: 'PC1', dst: '10.0.1.1', proto: 'icmp', srcAddr: 'x' }]) {
    const e = lab.trace(spec as never);
    assert.ok('error' in e && e.error.length > 10, JSON.stringify(spec));
  }
});

test('qosLoad answers from the simulation and refuses nonsense', () => {
  const { lab } = start('mini-prebuilt');
  const r = lab.qosLoad({ deviceId: 'R1', iface: SE, offered: [{ label: 'ping', kbps: 500, flow: { fromDeviceId: 'R1', dst: '10.0.12.2', proto: 'icmp' } }] });
  assert.equal(r.message, 'No service-policy output is attached to Serial0/1/0 on R1.', 'the answer comes from the simulation');
  assert.equal(r.linkKbps, 128, 'clock rate 128000 on the DCE end');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].offeredKbps, 500);
  assert.ok(r.rows[0].deliveredKbps <= 128);
  for (const spec of [null, { deviceId: 'PC1', iface: 'Ethernet0', offered: [] }, { deviceId: 'R1', iface: 'Serial9', offered: [] }, { deviceId: 'R1', iface: SE }]) {
    const bad = lab.qosLoad(spec as never);
    assert.deepEqual([bad.ok, bad.linkKbps, bad.shapedKbps, bad.rows], [false, 0, 0, []], JSON.stringify(spec));
    assert.ok((bad.message ?? '').length > 5);
  }
});

test('exam mode: tools are off, hints do not count, the solution is hidden — until the exam is finished', () => {
  const { lab } = start('mini-prebuilt', 'exam');
  const t = lab.trace({ fromDeviceId: 'PC1', dst: '10.0.12.2', proto: 'icmp' });
  assert.deepEqual(t, { error: 'The packet walkthrough is switched off during the exam. Use ping and the show commands.' });
  const q = lab.qosLoad({ deviceId: 'R1', iface: SE, offered: [] });
  assert.deepEqual(q, { ok: false, message: 'The tools are switched off during the exam. Use the show commands on the router.', linkKbps: 0, shapedKbps: 0, rows: [] });
  assert.equal(lab.solution(), null);
  lab.noteHintUsed('cable');
  assert.equal(lab.getState().scenario!.hintsUsed, 0);
  assert.deepEqual(lab.getState().scenario!.guide, []);
  assert.equal(lab.commandSheet(), COMMAND_SHEET, 'the command sheet is allowed in every mode');
  const report = lab.finishExam();
  assert.equal(report.mode, 'exam');
  assert.equal(lab.getState().scenario!.finished, true);
  assert.deepEqual(lab.solution(), SOLUTION);
  const after = lab.trace({ fromDeviceId: 'PC1', dst: '10.0.12.2', proto: 'icmp' });
  assert.ok(!('error' in after), 'after the exam he may explore with the tools');
});

test('guided and free: the solution and the tools are there; each step counts once as a hint', () => {
  for (const mode of ['guided', 'free'] as const) {
    const { lab } = start('mini', mode);
    assert.deepEqual(lab.solution(), SOLUTION);
    assert.ok(!('error' in lab.trace({ fromDeviceId: 'PC1', dst: '10.0.1.1', proto: 'icmp' })));
    lab.noteHintUsed('cable');
    lab.noteHintUsed('cable');
    lab.noteHintUsed('r1');
    lab.noteHintUsed('no-such-step');
    lab.noteHintUsed(42 as never);
    assert.equal(lab.getState().scenario!.hintsUsed, 2);
  }
  const { lab } = makeLab();
  assert.equal(lab.solution(), null, 'no lab, no solution');
  lab.noteHintUsed('cable');
  assert.equal(lab.getState().rev, 0);
});

test('check grades the network as it is: points, maximum and the 18-point scale to one decimal', () => {
  const { lab } = start();
  let rep = lab.check();
  assert.deepEqual([rep.scenarioId, rep.mode, rep.maxPoints, rep.points, rep.scaled18], ['mini', 'free', 10, 0, 0]);
  assert.equal(rep.requirements.length, 4);
  assert.deepEqual(rep.hardwareNotes.map((h) => h.id), ['hw-1']);
  assert.equal(lab.getState().report, rep);
  cableBench(lab);
  rep = lab.check();
  assert.deepEqual([rep.points, rep.scaled18], [2, 3.6]);
  const id = consoleToConfig(lab, 'PC1', 'R1');
  type(lab, id, ['hostname R1']);
  rep = lab.check();
  assert.deepEqual([rep.points, rep.scaled18], [3, 5.4]);
  type(lab, id, [`interface ${GI}`, 'ip address 10.0.1.1 255.255.255.0', 'no shutdown']);
  ok(lab.setPcNic('PC1', { mode: 'static', address: '10.0.1.10', mask: '255.255.255.0', gateway: '10.0.1.1' }));
  rep = lab.check();
  assert.deepEqual([rep.points, rep.scaled18, rep.tick], [6, 10.8, world(lab).tick]);
  assert.deepEqual(rep.requirements.map((r) => [r.id, r.pass, r.earned]), [['req-cable', true, 2], ['req-lan', true, 3], ['req-wan', false, 0], ['req-name', true, 1]]);
  assert.equal(lab.getState().scenario!.finished, false, 'a practice check does not finish anything');
  assert.equal(lab.finishExam().points, 6, 'outside exam mode finishExam is a check');
  assert.equal(lab.getState().scenario!.finished, false);
});

test('exam: check is finishExam; the report is final but the lab stays usable', () => {
  const { lab } = start('mini', 'exam');
  cableBench(lab);
  const rep = lab.check();
  assert.equal(rep.points, 2);
  assert.equal(lab.getState().scenario!.finished, true);
  assert.equal(lab.getState().report, rep);
  // he keeps exploring: the network changes, the grade does not
  const id = consoleToConfig(lab, 'PC1', 'R1');
  type(lab, id, ['hostname R1']);
  const r1 = world(lab).devices.R1;
  assert.ok(r1.kind === 'router' && r1.config.hostname === 'R1');
  assert.equal(lab.finishExam(), rep);
  assert.equal(lab.check(), rep);
  assert.equal(lab.getState().report?.points, 2);
});

test('the grader never changes the student\'s network, even a careless one', () => {
  const { lab } = makeLab({ scenarios: [miniScenario({ rudeGrader: true })] });
  ok(lab.startScenario('mini', 'free'));
  cableBench(lab);
  const before = structuredClone(world(lab));
  const state = lab.getState();
  const rep = lab.check();
  assert.equal(rep.maxPoints, 10);
  assert.deepEqual(world(lab), before);
  assert.equal(world(lab).cables.length, 3);
  assert.equal(lab.getState().rev, state.rev + 1);
});

test('a grader or progress function that throws does not break the lab', () => {
  const { lab } = makeLab({ scenarios: [miniScenario({ throwing: true })] });
  ok(lab.startScenario('mini', 'guided'));
  assert.deepEqual(lab.getState().scenario!.guide.map((g) => g.status), ['active', 'locked', 'locked']);
  cableBench(lab);
  const rep = lab.check();
  assert.deepEqual([rep.maxPoints, rep.points, rep.scaled18], [10, 0, 0]);
  assert.equal(rep.requirements.length, 4);
  assert.match(rep.requirements[0].checks[0].observed, /The checker stopped with an error: grader exploded/);
});

test('without a lab, check and finishExam return an empty report', () => {
  const { lab } = makeLab();
  for (const rep of [lab.check(), lab.finishExam()]) {
    assert.deepEqual(rep, { scenarioId: '', mode: 'free', tick: 0, maxPoints: 0, points: 0, scaled18: 0, requirements: [], orderIssues: [], hardwareNotes: [] });
  }
  assert.equal(lab.getState().rev, 0);
});

test('the report of the solved fixture is 10 of 10, 18.0 of 18, and order issues come from the journal', () => {
  const { lab } = start('mini', 'guided');
  const id = consoleToConfig(lab, 'PC1', 'R1');
  assert.ok(lab.sessionExec(id, 'hostname R1').blocked);
  ok(lab.startScenario('mini', 'free'));
  buildSolution(lab);
  const rep = lab.check();
  assert.deepEqual([rep.points, rep.maxPoints, rep.scaled18], [10, 10, 18]);
  assert.deepEqual(rep.orderIssues, []);
  assert.ok(port('R1', GI));
});
