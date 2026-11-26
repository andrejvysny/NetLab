/** File-style configuration: reading and applying config text needs the console connection, like a terminal. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GI, R1_CONFIG, cableBench, cableId, consoleToConfig, makeLab, ok, plugConsole, port, type, world } from './fixture.ts';
import type { IosDevice } from '../../src/engine/types.ts';

function start(id = 'mini', mode: 'guided' | 'free' | 'exam' = 'free') {
  const h = makeLab();
  ok(h.lab.startScenario(id, mode));
  return h;
}
const ios = (lab: ReturnType<typeof start>['lab'], id: string) => world(lab).devices[id] as IosDevice;

test('getConfigText needs the console cable; without it the text is a harmless comment that says what to do', () => {
  const { lab } = start();
  const none = lab.getConfigText('R1', 'running');
  assert.equal(none, '! No console cable is connected to R1.\n! Plug a Console (rollover) cable from the COM1 port of a PC into the CON port of R1.\n! Then load the configuration again.\n');
  assert.equal(lab.getConfigText('R1', 'startup'), none);
  assert.equal(lab.getConfigText('PC1', 'running'), '');
  assert.equal(lab.getConfigText('ghost', 'running'), '');
  plugConsole(lab, 'PC1', 'R1');
  const running = lab.getConfigText('R1', 'running');
  assert.match(running, /^!\nversion 17\.3\n/, 'file text: no "Building configuration..." header');
  assert.match(running, /\nhostname Router\n/);
  assert.match(running, /\nend\n$/);
  assert.equal(lab.getConfigText('R1', 'startup'), '', 'nothing saved yet');
  // applying the comment text changes nothing (comments are skipped)
  const before = structuredClone(ios(lab, 'R1').config);
  const rep = lab.applyConfigText('R1', none, 'merge');
  assert.deepEqual([rep.ok, rep.applied, rep.failed], [true, 0, 0]);
  assert.deepEqual(ios(lab, 'R1').config, before);
});

test('the startup-config is readable after it was saved, without the show-command header', () => {
  const { lab } = start();
  const id = consoleToConfig(lab, 'PC1', 'R1');
  type(lab, id, ['hostname R1', 'end', 'copy running-config startup-config', '']);
  const startup = lab.getConfigText('R1', 'startup');
  assert.match(startup, /^!\nversion 17\.3\n/);
  assert.match(startup, /\nhostname R1\n/);
  assert.equal(startup, lab.getConfigText('R1', 'running'));
  // what was read can be applied again and changes nothing
  const before = structuredClone(ios(lab, 'R1').config);
  const rep = lab.applyConfigText('R1', startup, 'merge');
  assert.equal(rep.failed, 0, JSON.stringify(rep.lines.filter((l) => !l.ok)));
  assert.deepEqual(ios(lab, 'R1').config, before);
});

test('once a report exists the configurations can be read without a cable (the report compares them with the model)', () => {
  const { lab } = start();
  cableBench(lab);
  assert.match(lab.getConfigText('R2', 'running'), /^! No console cable/);
  lab.check();
  assert.match(lab.getConfigText('R2', 'running'), /\nhostname Router\n/);
  assert.match(lab.getConfigText('R1', 'running'), /\nhostname Router\n/);
  // applying still needs the cable
  const rep = lab.applyConfigText('R2', 'hostname R2\n', 'merge');
  assert.deepEqual([rep.ok, rep.applied, rep.lines.length], [false, 0, 0]);
  assert.equal(rep.message, 'No console cable is connected to R2. A configuration file is sent through the console. '
    + 'Plug a Console (rollover) cable from the COM1 port of a PC into the CON port of R2. Then apply again.');
  assert.equal(ios(lab, 'R2').config.hostname, 'Router');
  // a restart forgets the report, and with it the shortcut
  lab.restartScenario();
  assert.match(lab.getConfigText('R2', 'running'), /^! No console cable/);
});

test('applyConfigText: merge adds, replace erases first; every line is journaled with its topic; errors are reported per line', () => {
  const { lab } = start();
  cableBench(lab);
  plugConsole(lab, 'PC1', 'R1');
  const merge = lab.applyConfigText('R1', R1_CONFIG, 'merge');
  assert.deepEqual([merge.ok, merge.applied, merge.failed], [true, 13, 0]);
  assert.equal(ios(lab, 'R1').config.hostname, 'R1');
  assert.equal(lab.portStatus(port('R1', GI)).status, 'up/up');
  const j = lab.getState().journal.filter((e) => e.via === 'file');
  assert.equal(j.length, 13);
  assert.deepEqual(j.slice(0, 4).map((e) => [e.mode, e.line, e.feature, e.ok, e.mutated]), [
    ['config', 'hostname R1', 'system', true, true],
    ['config', 'interface GigabitEthernet0/0/0', 'interface', true, false],
    ['config-if', 'ip address 10.0.1.1 255.255.255.0', 'interface', true, true],
    ['config-if', 'no shutdown', 'interface', true, true],
  ]);
  assert.deepEqual(j.map((e) => e.feature).slice(8), ['routing', 'syslog', 'vty', 'vty', 'vty']);
  assert.ok(j.every((e, i) => i === 0 || e.tick >= j[i - 1].tick));
  // a file with a mistake: the good lines are applied, the bad one is reported
  const bad = lab.applyConfigText('R1', 'interface Loopback3\n ip adress 3.3.3.3 255.255.255.255\n description ok\n', 'merge');
  assert.deepEqual([bad.ok, bad.applied, bad.failed], [false, 2, 1]);
  assert.deepEqual(bad.lines.map((l) => [l.lineNo, l.ok]), [[1, true], [2, false], [3, true]]);
  assert.match(bad.lines[1].output, /Invalid input/);
  const last = lab.getState().journal.slice(-3);
  assert.deepEqual(last.map((e) => [e.line, e.ok, e.mutated]), [['interface Loopback3', true, false], ['ip adress 3.3.3.3 255.255.255.255', false, false], ['description ok', true, true]]);
  // replace: only what is in the file remains
  const repl = lab.applyConfigText('R1', 'hostname Solo\n', 'replace');
  assert.deepEqual([repl.ok, repl.applied], [true, 1]);
  assert.equal(ios(lab, 'R1').config.hostname, 'Solo');
  assert.equal(ios(lab, 'R1').config.interfaces.Loopback3, undefined);
  assert.equal(ios(lab, 'R1').config.interfaces[GI].ip, undefined);
  assert.equal(lab.portStatus(port('R1', GI)).status, 'administratively down/down');
  // odd input
  assert.equal(lab.applyConfigText('R1', 42 as never, 'merge').ok, false);
  assert.equal(lab.applyConfigText('PC1', 'hostname X', 'merge').message, 'PC1 is a PC. It has no IOS configuration.');
  assert.equal(lab.applyConfigText('ghost', 'hostname X', 'merge').message, 'That device is not on the bench.');
});

test('replace while the terminal sits in a sub-mode brings the terminal back to a safe prompt', () => {
  const { lab } = start();
  const id = consoleToConfig(lab, 'PC1', 'R1');
  type(lab, id, ['interface loopback 4', 'ip address 4.4.4.4 255.255.255.255']);
  assert.equal(lab.getState().sessions[0].prompt, 'Router(config-if)#');
  ok(lab.applyConfigText('R1', 'hostname R1\n', 'replace'));
  assert.equal(lab.getState().sessions[0].prompt, 'R1#');
  assert.equal(lab.sessionExec(id, 'show running-config | include hostname').output.includes('hostname R1'), true);
  ok(lab.removeCable(cableId(lab, port('PC1', 'COM1'))));
});

for (const mode of ['free', 'guided'] as const) {
  test(`${mode}: moving the console cable only grants access to its real endpoints; text remains running-only`, () => {
    const { lab } = start('mini-prebuilt', mode);
    plugConsole(lab, 'PC1', 'R1');
    const startup = lab.getConfigText('R1', 'startup');
    assert.ok(startup.trim());
    const open = lab.openConsole('R1');
    assert.ok(open.ok);
    ok(lab.applyConfigText('R1', 'hostname Unsaved\n', 'merge'));
    assert.equal(lab.getConfigText('R1', 'startup'), startup);
    assert.match(lab.getConfigText('R1', 'running'), /hostname Unsaved/);
    ok(lab.removeCable(cableId(lab, port('PC1', 'COM1'))));
    assert.equal(lab.sessionExec(open.session.id, 'enable').closed, true);
    assert.equal(lab.applyConfigText('R1', 'hostname NoCable\n', 'replace').ok, false);
    plugConsole(lab, 'PC1', 'R2');
    assert.equal(lab.openConsole('R1').ok, false);
    assert.equal(lab.consoleTargetOf('PC1'), 'R2');
    plugConsole(lab, 'PC1', 'R1');
    assert.equal(lab.getConfigText('R1', 'startup'), startup);
    assert.equal(ios(lab, 'R1').config.hostname, 'Unsaved');
  });
}

test('blocked and accepted file credentials are shown as typed in results and in the saved journal', () => {
  const { lab } = start('mini', 'guided');
  plugConsole(lab, 'PC1', 'R1');
  const blocked = lab.applyConfigText('R1', 'Router(config)#enable secret fixture-only', 'merge');
  assert.ok(blocked.blocked);
  assert.match(blocked.blocked.reason, /Router\(config\)#enable secret fixture-only/);
  ok(lab.startScenario('mini', 'free'));
  plugConsole(lab, 'PC1', 'R1');
  const accepted = lab.applyConfigText('R1', 'line vty 0 4\n password fixture-only\n', 'merge');
  assert.equal(accepted.ok, true);
  assert.equal(accepted.lines[1].line, ' password fixture-only');
  assert.match(JSON.stringify(JSON.parse(lab.exportLab()).journal), /password fixture-only/);
  assert.equal(ios(lab, 'R1').config.lines.vty[0].password, 'fixture-only', 'actual configuration remains usable');
});
