/** Settings, auto-save slots, export / import, and tolerance of missing or failing storage. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GI, MemoryStorage, buildSolution, cableBench, consoleToConfig, fakePc, makeLab, miniScenario, ok, openConsole, plugConsole, port, type, world,
} from './fixture.ts';
import { Lab } from '../../src/engine/lab.ts';
import type { IosDevice } from '../../src/engine/types.ts';

const SCENARIOS = () => [miniScenario(), miniScenario({ id: 'mini-prebuilt', prebuilt: true })];
/** A second Lab on the same storage: what the student gets after closing and reopening the page. */
function reopen(storage: MemoryStorage | null, t = 1_700_000_500_000): Lab {
  return new Lab({ scenarios: SCENARIOS(), storage, now: () => t, pcExec: fakePc });
}

test('settings are validated, clamped and kept across page loads', () => {
  const { lab, storage } = makeLab();
  lab.updateSettings({ fontScale: 3, font: 'atkinson', terminalFontPx: 18.4, terminalPaging: false, reduceMotion: true });
  assert.deepEqual(lab.getState().settings, { strictCables: true, qosClassifiesInnerHeader: true, fontScale: 1.4, font: 'atkinson', terminalFontPx: 18, terminalPaging: false, reduceMotion: true });
  const s = lab.getState();
  lab.updateSettings({ font: 'comic' as never, fontScale: Number.NaN, terminalFontPx: 'big' as never, qosClassifiesInnerHeader: 'false' as never });
  lab.updateSettings({});
  lab.updateSettings(null as never);
  lab.updateSettings({ fontScale: 1.4 });
  assert.equal(lab.getState(), s, 'nothing valid changed → no new state');
  lab.updateSettings({ fontScale: 0.1, strictCables: false });
  assert.equal(lab.getState().settings.fontScale, 0.85);
  const next = reopen(storage);
  assert.deepEqual(next.getState().settings, { strictCables: false, qosClassifiesInnerHeader: true, fontScale: 0.85, font: 'atkinson', terminalFontPx: 18, terminalPaging: false, reduceMotion: true });
  // damaged settings fall back to the defaults
  storage.data.set('kss-netlab:settings', '{not json');
  assert.equal(reopen(storage).getState().settings.font, 'lexend');
});

test('WAN QoS profile is remembered for new labs, but saved/imported labs and restart keep their own choice', () => {
  const { lab, storage } = makeLab();
  lab.updateSettings({ qosClassifiesInnerHeader: false });
  const next = reopen(storage);
  assert.equal(next.getState().settings.qosClassifiesInnerHeader, false, 'Home remembers the preference across page loads');
  ok(next.startScenario('mini', 'free', { seed: 17, timerMinutes: 30 }));
  assert.equal(world(next).settings.qosClassifiesInnerHeader, false);
  cableBench(next);
  const exported = JSON.parse(next.exportLab());
  assert.equal(exported.world.settings.qosClassifiesInnerHeader, false);
  assert.equal(exported.settings.qosClassifiesInnerHeader, false);
  next.leaveScenario();
  next.updateSettings({ qosClassifiesInnerHeader: true });

  ok(next.loadSaved('mini.free'));
  assert.equal(next.getState().settings.qosClassifiesInnerHeader, false, 'Continue shows the active profile, not the Home preference');
  assert.equal(world(next).settings.qosClassifiesInnerHeader, false);
  next.restartScenario();
  assert.equal(next.getState().settings.qosClassifiesInnerHeader, false, 'restart keeps the saved choice');
  assert.deepEqual([next.getState().scenario?.seed, next.getState().scenario?.timerMinutes, world(next).cables.length], [17, 30, 0]);
  next.leaveScenario();
  assert.equal(next.getState().settings.qosClassifiesInnerHeader, true, 'continuing and restarting did not change the Home preference');

  // The saved World wins even if the file's UI settings mirror disagrees.
  exported.settings.qosClassifiesInnerHeader = true;
  ok(next.importLab(JSON.stringify(exported)));
  assert.equal(next.getState().settings.qosClassifiesInnerHeader, false);
  assert.equal(JSON.parse(next.exportLab()).settings.qosClassifiesInnerHeader, false);
  const valid = next.getState();
  exported.world.settings.qosClassifiesInnerHeader = 'false';
  assert.match(next.importLab(JSON.stringify(exported)).message ?? '', /WAN QoS profile is invalid/);
  assert.equal(next.getState(), valid, 'a malformed profile does not silently change the lab');

  next.check();
  next.updateSettings({ qosClassifiesInnerHeader: true });
  assert.equal(next.getState().report, null, 'a score under a different classifier is not reused');
  const stored = JSON.parse(storage.getItem('kss-netlab:lab:mini.free')!);
  assert.equal(stored.world.settings.qosClassifiesInnerHeader, true);
  assert.equal(stored.settings.qosClassifiesInnerHeader, true);
  assert.equal(stored.report, null);
  next.updateSettings({ qosClassifiesInnerHeader: false });
  assert.equal(reopen(storage).getState().settings.qosClassifiesInnerHeader, false, 'changing an open practice lab also changes the default');
});

test('legacy saves restore the course rule if absent, preserve an explicit ESP rule, and never change the browser preference', () => {
  const { lab, storage } = makeLab();
  ok(lab.startScenario('mini', 'free'));
  const saved = JSON.parse(lab.exportLab());
  delete saved.settings.qosClassifiesInnerHeader;
  delete saved.world.settings.qosClassifiesInnerHeader;
  const legacy = JSON.stringify(saved);
  lab.leaveScenario();
  lab.updateSettings({ qosClassifiesInnerHeader: false });
  storage.setItem('kss-netlab:lab:mini.free', legacy);
  ok(lab.loadSaved('mini.free'));
  assert.equal(world(lab).settings.qosClassifiesInnerHeader, true, 'missing world flag is course mode despite the current ESP preference');
  assert.equal(JSON.parse(lab.exportLab()).settings.qosClassifiesInnerHeader, true, 'an upgraded export has an explicit flag');
  lab.leaveScenario();
  assert.equal(lab.getState().settings.qosClassifiesInnerHeader, false);

  ok(lab.importLab(legacy));
  assert.equal(world(lab).settings.qosClassifiesInnerHeader, true, 'file import also upgrades a legacy world');
  lab.leaveScenario();
  assert.equal(lab.getState().settings.qosClassifiesInnerHeader, false, 'importing a course world did not change the ESP preference');
  lab.updateSettings({ qosClassifiesInnerHeader: true });
  saved.world.settings.qosClassifiesInnerHeader = false; // world setting existed before the UI selector
  ok(lab.importLab(JSON.stringify(saved)));
  assert.equal(world(lab).settings.qosClassifiesInnerHeader, false, 'an explicit legacy world flag is not reset by the course preference');
  lab.leaveScenario();
  assert.equal(lab.getState().settings.qosClassifiesInnerHeader, true, 'importing an ESP world did not change the course preference');
});

test('exam mode locks the active WAN QoS profile across edits, finish, resume, and restart', () => {
  const { lab, storage } = makeLab();
  lab.updateSettings({ qosClassifiesInnerHeader: false });
  ok(lab.startScenario('mini', 'exam'));
  const state = lab.getState();
  lab.updateSettings({ qosClassifiesInnerHeader: true });
  assert.equal(lab.getState(), state, 'locked setting does not publish an update');
  lab.updateSettings({ qosClassifiesInnerHeader: true, fontScale: 1.2 });
  assert.equal(lab.getState().settings.fontScale, 1.2, 'reading options are not locked');
  assert.equal(world(lab).settings.qosClassifiesInnerHeader, false);
  assert.equal(reopen(storage).getState().settings.qosClassifiesInnerHeader, false, 'an exam edit does not change the next-lab default');
  const final = lab.finishExam();
  lab.updateSettings({ qosClassifiesInnerHeader: true });
  assert.equal(lab.getState().settings.qosClassifiesInnerHeader, false);
  assert.equal(lab.getState().report, final, 'finished exam still holds its final report');

  lab.leaveScenario();
  lab.updateSettings({ qosClassifiesInnerHeader: true });
  ok(lab.loadSaved('mini.exam'));
  assert.equal(lab.getState().settings.qosClassifiesInnerHeader, false);
  lab.restartScenario();
  assert.equal(lab.getState().settings.qosClassifiesInnerHeader, false, 'a resumed exam restarts under the same classifier');
  assert.equal(lab.getState().scenario?.finished, false);
  lab.leaveScenario();
  assert.equal(lab.getState().settings.qosClassifiesInnerHeader, true);
});

test('the running lab is saved after every action, one slot per assignment and mode', () => {
  const { lab, storage, clock } = makeLab();
  assert.deepEqual(lab.getState().storage, { available: true, saved: [] });
  ok(lab.startScenario('mini', 'free'));
  assert.deepEqual(lab.getState().storage.saved, [{ id: 'mini.free', title: 'Mini lab', mode: 'free', savedAt: clock.t }]);
  clock.t += 5000;
  cableBench(lab);
  assert.equal(lab.getState().storage.saved[0].savedAt, clock.t, 'saved again by the cable action');
  const stored = JSON.parse(storage.data.get('kss-netlab:lab:mini.free')!);
  assert.equal(stored.world.cables.length, 3);
  assert.equal(stored.journal.length, 3);
  lab.check();
  assert.equal(lab.getState().storage.saved[0].percent, 20);
  clock.t += 5000;
  lab.leaveScenario();
  clock.t += 5000;
  ok(lab.startScenario('mini', 'exam'));
  clock.t += 5000;
  ok(lab.startScenario('mini-prebuilt', 'guided'));
  clock.t += 5000;
  lab.leaveScenario();
  const saved = lab.getState().storage.saved;
  assert.deepEqual(saved.map((s) => s.id), ['mini-prebuilt.guided', 'mini.exam', 'mini.free'], 'newest first');
  assert.equal(saved[2].percent, 20);
  // after a page reload the list is still there
  assert.deepEqual(reopen(storage).getState().storage.saved, saved);
  // a lost index is rebuilt from the slots
  storage.data.delete('kss-netlab:index');
  assert.deepEqual(reopen(storage).getState().storage.saved.map((s) => s.id).sort(), ['mini-prebuilt.guided', 'mini.exam', 'mini.free']);
});

test('loadSaved continues a lab: same network, journal, report and hints; fresh terminals; the clock goes on', () => {
  const { lab, storage, clock } = makeLab();
  ok(lab.startScenario('mini', 'guided', { seed: 4 }));
  cableBench(lab);
  lab.noteHintUsed('r1');
  const con = consoleToConfig(lab, 'PC1', 'R1');
  type(lab, con, ['hostname R1', `interface ${GI}`, 'ip address 10.0.1.1 255.255.255.0']);
  clock.t += 20 * 60_000;
  lab.check();
  const before = lab.getState();
  const exported = JSON.parse(lab.exportLab());
  lab.leaveScenario();

  const later = reopen(storage, clock.t + 86_400_000);
  assert.equal(later.getState().scenario, null);
  assert.equal(later.loadSaved('nope').ok, false);
  ok(later.loadSaved('mini.guided'));
  const s = later.getState();
  assert.deepEqual(s.world, exported.world);
  assert.deepEqual(s.journal, before.journal);
  assert.deepEqual(s.report, before.report);
  assert.deepEqual([s.scenario!.mode, s.scenario!.seed, s.scenario!.hintsUsed, s.scenario!.finished], ['guided', 4, 1, false]);
  assert.deepEqual(s.scenario!.guide.map((g) => g.status), ['done', 'active', 'locked']);
  assert.equal(clock.t + 86_400_000 - s.scenario!.startedAt, 20 * 60_000, 'twenty minutes of work so far');
  assert.deepEqual(s.sessions, [], 'terminals start fresh');
  // the console cable is still plugged in; the device is at its user prompt, no dialog
  const open = later.openConsole('R1');
  assert.ok(open.ok);
  if (!open.ok) return;
  assert.equal(open.session.prompt, 'R1>');
  assert.doesNotMatch(open.banner, /Configuration Dialog/);
  // work continues in the same slot
  type(later, open.session.id, ['enable', 'configure terminal', `interface ${GI}`, 'no shutdown']);
  assert.deepEqual(later.getState().scenario!.guide.map((g) => g.status), ['done', 'done', 'active']);
  assert.equal(JSON.parse(storage.data.get('kss-netlab:lab:mini.guided')!).world.devices.R1.config.interfaces[GI].shutdown, false);
});

test('export → import gives the same lab back', () => {
  const { lab, clock } = makeLab();
  ok(lab.startScenario('mini', 'exam', { timerMinutes: 180, seed: 9 }));
  buildSolution(lab);
  lab.pcExec('PC1', 'telnet 10.0.12.2'); // an open vty session must not survive
  clock.t += 45 * 60_000;
  lab.finishExam();
  lab.updateSettings({ font: 'atkinson', fontScale: 1.2 });
  const json = lab.exportLab();
  const data = JSON.parse(json);
  assert.deepEqual([data.format, data.version, data.scenarioId, data.seed, data.mode, data.finished, data.timerMinutes, data.elapsedMs],
    ['kss-netlab-lab', 1, 'mini', 9, 'exam', true, 180, 45 * 60_000]);
  for (const key of ['world', 'journal', 'report', 'settings', 'hintSteps', 'savedAt', 'startedAt']) assert.ok(key in data, key);
  const a = lab.getState();

  // another browser, nothing stored there
  const other = new Lab({ scenarios: SCENARIOS(), storage: null, now: () => 5_000_000_000_000, pcExec: fakePc });
  const r = other.importLab(json);
  assert.deepEqual(r, { ok: true, message: 'Opened "Mini lab".' });
  const b = other.getState();
  const expectedWorld = structuredClone(a.world!);
  (expectedWorld.devices.R2 as IosDevice).runtime.vtyInUse = 0;
  assert.deepEqual(b.world, expectedWorld);
  assert.deepEqual(b.journal, a.journal);
  assert.deepEqual(b.report, a.report);
  assert.deepEqual({ ...b.scenario, startedAt: 0 }, { ...a.scenario, startedAt: 0 });
  assert.equal(5_000_000_000_000 - b.scenario!.startedAt, 45 * 60_000);
  assert.deepEqual(b.settings, a.settings, 'reading preferences travel with the file');
  assert.deepEqual(b.sessions, []);
  assert.deepEqual(other.solution(), lab.solution(), 'a finished exam shows its solution after import too');
  assert.equal(other.check(), b.report, 'the exam grade stays final');
  // and exporting again gives the same content
  const again = JSON.parse(other.exportLab());
  for (const key of ['scenarioId', 'seed', 'mode', 'world', 'journal', 'report', 'finished', 'hintSteps', 'timerMinutes', 'elapsedMs', 'dhcpClients']) {
    assert.deepEqual(again[key], key === 'world' ? expectedWorld : data[key], key);
  }
});

test('importLab refuses anything that is not a lab file, with a plain message', () => {
  const { lab } = makeLab();
  ok(lab.startScenario('mini', 'free'));
  cableBench(lab);
  const good = JSON.parse(lab.exportLab());
  const state = lab.getState();
  const bad = (json: unknown, re: RegExp) => {
    const r = lab.importLab(json as string);
    assert.equal(r.ok, false);
    assert.match(r.message ?? '', re, String(json).slice(0, 60));
  };
  bad('', /file is empty/);
  bad(undefined, /file is empty/);
  bad(42, /file is empty/);
  bad('hostname R1\n!', /not a lab file/);
  bad('[1,2,3]', /not a KSS NetLab lab file/);
  bad('{"format":"something-else"}', /not a KSS NetLab lab file/);
  bad(new Lab({ scenarios: [], storage: null }).exportLab(), /exported while no lab was open/);
  bad(JSON.stringify({ ...good, version: 99 }), /newer version/);
  bad(JSON.stringify({ ...good, mode: 'party' }), /damaged/);
  bad(JSON.stringify({ ...good, scenarioId: 'long-gone' }), /assignment that this version does not have \("long-gone"\)/);
  bad(JSON.stringify({ ...good, world: null }), /damaged \(world is missing\)/);
  bad(JSON.stringify({ ...good, world: { ...good.world, devices: { ...good.world.devices, R1: { id: 'R1' } } } }), /damaged/);
  bad(JSON.stringify({ ...good, world: { ...good.world, cables: [{ id: 'c', kind: 'straight', a: { deviceId: 'X', port: 'p' }, b: { deviceId: 'R1', port: GI } }] } }), /damaged/);
  assert.equal(lab.getState(), state, 'a refused file changes nothing');
  // a file with small defects is still opened
  ok(lab.importLab(JSON.stringify({ ...good, journal: 'oops', report: 7, hintSteps: null, settings: null, elapsedMs: -5 })));
  assert.deepEqual(lab.getState().journal, []);
  assert.equal(lab.getState().report, null);
  assert.equal(world(lab).cables.length, 3);
});

test('loadSaved does not touch the reading preferences; deleteSaved removes a slot', () => {
  const { lab, storage } = makeLab();
  lab.updateSettings({ fontScale: 1.3 });
  ok(lab.startScenario('mini', 'free'));
  lab.leaveScenario();
  lab.updateSettings({ fontScale: 0.9 });
  ok(lab.loadSaved('mini.free'));
  assert.equal(lab.getState().settings.fontScale, 0.9);
  lab.leaveScenario();
  lab.deleteSaved('mini.free');
  lab.deleteSaved('nope');
  lab.deleteSaved(null as never);
  assert.deepEqual(lab.getState().storage.saved, []);
  assert.equal(storage.data.has('kss-netlab:lab:mini.free'), false);
  assert.deepEqual(lab.loadSaved('mini.free'), { ok: false, message: 'That saved lab is not there any more.' });
  // a damaged slot
  storage.data.set('kss-netlab:lab:broken', '{"format":"kss-netlab-lab"');
  assert.match(lab.loadSaved('broken').message ?? '', /saved lab is damaged/);
});

test('without storage everything works; the state says saving is off', () => {
  for (const storage of [null, undefined]) {
    const lab = new Lab({ scenarios: SCENARIOS(), storage: storage as null, pcExec: fakePc });
    assert.deepEqual(lab.getState().storage, { available: false, saved: [] });
    ok(lab.startScenario('mini', 'free'));
    buildSolution(lab);
    assert.equal(lab.check().points, 10);
    lab.updateSettings({ fontScale: 1.1 });
    assert.equal(lab.getState().settings.fontScale, 1.1);
    const json = lab.exportLab();
    lab.leaveScenario();
    assert.deepEqual(lab.getState().storage, { available: false, saved: [] });
    assert.equal(lab.loadSaved('mini.free').ok, false);
    lab.deleteSaved('mini.free');
    ok(lab.importLab(json));
    assert.equal(lab.check().points, 10);
  }
});

test('storage that throws (sandboxed iframe) switches saving off and nothing else', () => {
  const storage = new MemoryStorage();
  storage.broken = true;
  const lab = new Lab({ scenarios: SCENARIOS(), storage, pcExec: fakePc });
  assert.equal(lab.getState().storage.available, false);
  ok(lab.startScenario('mini', 'free'));
  buildSolution(lab);
  assert.equal(lab.check().points, 10);
  lab.updateSettings({ reduceMotion: true });
  lab.leaveScenario();
  lab.deleteSaved('x');
  assert.equal(lab.loadSaved('mini.free').ok, false);
  assert.deepEqual(lab.getState().storage, { available: false, saved: [] });
});

test('storage that fails later (quota) only turns saving off; it comes back when writing works again', () => {
  const { lab, storage } = makeLab();
  ok(lab.startScenario('mini', 'free'));
  assert.equal(lab.getState().storage.available, true);
  storage.full = true;
  cableBench(lab);
  assert.equal(lab.getState().storage.available, false);
  assert.deepEqual(lab.getState().storage.saved, []);
  assert.equal(world(lab).cables.length, 3, 'the lab itself went on');
  storage.full = false;
  lab.moveDevice('R1', 1, 2);
  assert.equal(lab.getState().storage.available, true);
  assert.deepEqual(lab.getState().storage.saved.map((s) => s.id), ['mini.free']);
  assert.equal(JSON.parse(storage.data.get('kss-netlab:lab:mini.free')!).world.cables.length, 3);
});

test('a restored lab keeps DHCP clients asking and forgets Telnet sessions', () => {
  const { lab, storage } = makeLab();
  ok(lab.startScenario('mini', 'free'));
  cableBench(lab);
  lab.setPcNic('PC2', { mode: 'dhcp' }); // no server yet
  lab.leaveScenario();
  const later = reopen(storage);
  ok(later.loadSaved('mini.free'));
  plugConsole(later, 'PC1', 'R2');
  const id = openConsole(later, 'R2');
  type(later, id, ['no', '', 'enable', 'configure terminal', 'ip dhcp pool LAN2', 'network 10.0.2.0 255.255.255.0', `interface ${GI}`, 'ip address 10.0.2.1 255.255.255.0', 'no shutdown']);
  const pc2 = world(later).devices.PC2;
  assert.ok(pc2.kind === 'pc' && pc2.nic.address === '10.0.2.2', 'PC2 was still asking after the restore');
  assert.ok(port('PC2', 'Ethernet0'));
});

test('a full storage: the oldest saved labs make room for the lab being worked on', () => {
  const { lab, storage, clock } = makeLab();
  ok(lab.startScenario('mini', 'free'));
  clock.t += 1000;
  ok(lab.startScenario('mini', 'guided'));
  clock.t += 1000;
  ok(lab.startScenario('mini-prebuilt', 'free'));
  const size = (id: string) => storage.data.get(`kss-netlab:lab:${id}`)!.length;
  // room for the current lab and one more, not for all three plus growth
  storage.quota = [...storage.data].reduce((n, [k, v]) => n + k.length + v.length, 0) + 200;
  clock.t += 1000;
  // make the current lab grow
  ok(lab.connectCable('console', port('PC1', 'COM1'), port('R1', 'Console')));
  const id = openConsole(lab, 'R1');
  type(lab, id, ['enable', 'configure terminal', 'interface loopback 1', 'interface loopback 2', 'interface loopback 3', 'interface loopback 4', 'end']);
  const s = lab.getState().storage;
  assert.equal(s.available, true, 'saving still works');
  assert.deepEqual(s.saved.map((x) => x.id), ['mini-prebuilt.free', 'mini.guided'], 'the oldest slot (mini.free) made room');
  assert.equal(storage.data.has('kss-netlab:lab:mini.free'), false);
  assert.ok(size('mini-prebuilt.free') > 0);
  assert.equal(JSON.parse(storage.data.get('kss-netlab:lab:mini-prebuilt.free')!).world.devices.R1.config.interfaces.Loopback4.name, 'Loopback4');
  // when even an empty storage is too small, saving is off — and the lab goes on
  storage.quota = 500;
  type(lab, id, ['configure terminal', 'interface loopback 5', 'end']);
  assert.equal(lab.getState().storage.available, false);
  assert.equal(world(lab).devices.R1.kind, 'router');
});
