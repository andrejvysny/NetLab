/** Terminals: the console rule, one persistent console session per device, the CLI round trip, reload, logout. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GI, cableBench, cableId, consoleToConfig, makeLab, ok, openConsole, plugConsole, port, type, world } from './fixture.ts';
import type { IosDevice } from '../../src/engine/types.ts';

function start(mode: 'guided' | 'free' | 'exam' = 'free') {
  const h = makeLab();
  ok(h.lab.startScenario('mini', mode));
  return h;
}
const r1 = (lab: ReturnType<typeof start>['lab']) => world(lab).devices.R1 as IosDevice;

test('no console cable: no terminal, and the message says exactly what to plug where', () => {
  const { lab } = start();
  const before = lab.getState();
  const r = lab.openConsole('R1');
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.message,
    'No console cable is plugged into R1. Plug a Console (rollover) cable from the COM1 port of a PC into the CON port of R1. Then open R1 again.');
  assert.equal(lab.getState(), before);
  assert.equal(lab.consolePcOf('R1'), null);
  assert.equal(lab.consoleTargetOf('PC1'), null);
  // a network cable is not a console
  ok(lab.connectCable('crossover', port('PC1', 'Ethernet0'), port('R1', GI)));
  assert.equal(lab.openConsole('R1').ok, false);
  // an Ethernet cable in the CON port
  ok(lab.connectCable('crossover', port('PC2', 'Ethernet0'), port('R1', 'Console')));
  const eth = lab.openConsole('R1');
  assert.match(eth.ok ? '' : eth.message, /cable in the CON port of R1 is an Ethernet cable/);
  // other refusals
  const pc = lab.openConsole('PC1');
  assert.match(pc.ok ? '' : pc.message, /PC1 is a PC\. It has no console port/);
  assert.equal(lab.openConsole('ghost').ok, false);
  assert.deepEqual(lab.getState().sessions, []);
});

test('with the cable: a console session with the initial dialog of a factory-fresh router', () => {
  const { lab } = start();
  plugConsole(lab, 'PC1', 'R1');
  assert.equal(lab.consolePcOf('R1'), 'PC1');
  assert.equal(lab.consoleTargetOf('PC1'), 'R1');
  assert.equal(lab.consolePcOf('PC1'), null);
  assert.equal(lab.consoleTargetOf('R1'), null);
  const r = lab.openConsole('R1');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.match(r.banner, /--- System Configuration Dialog ---/);
  assert.deepEqual(r.session, {
    id: r.session.id, deviceId: 'R1', kind: 'console', pcId: 'PC1', title: 'R1 — console (PC1 COM1, 9600 8N1)',
    prompt: 'Would you like to enter the initial configuration dialog? [yes/no]: ', secret: false, closed: false,
    termLength: 24, pendingInput: { kind: 'confirm', paste: 'allow' },
  });
  assert.deepEqual(lab.getState().sessions, [r.session]);
  // opening again reuses the session and shows nothing new
  const again = lab.openConsole('R1');
  assert.ok(again.ok && again.session.id === r.session.id && again.banner === '');
  assert.equal(lab.getState().sessions.length, 1);
});

test('full CLI round trip: dialog → enable → configure terminal → interface …', () => {
  const { lab } = start();
  cableBench(lab);
  plugConsole(lab, 'PC1', 'R1');
  const id = openConsole(lab, 'R1');
  const prompts: string[] = [];
  const run = (line: string) => { const v = lab.sessionExec(id, line); prompts.push(v.prompt); return v; };
  assert.match(run('no').output, /Press RETURN to get started!/);
  run('');
  run('enable');
  assert.match(run('configure terminal').output, /Enter configuration commands, one per line/);
  run('hostname R1');
  run('interface g0/0/0');
  run('ip address 10.0.1.1 255.255.255.0');
  const up = run('no shutdown');
  run('end');
  assert.deepEqual(prompts, ['Router>', 'Router>', 'Router#', 'Router(config)#', 'R1(config)#', 'R1(config-if)#', 'R1(config-if)#', 'R1(config-if)#', 'R1#']);
  assert.match(up.output, /%LINK-3-UPDOWN: Interface GigabitEthernet0\/0\/0, changed state to up\n.*%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0\/0\/0, changed state to up\n$/);
  assert.equal(r1(lab).config.hostname, 'R1');
  assert.deepEqual(r1(lab).config.interfaces[GI].ip, { address: '10.0.1.1', mask: '255.255.255.0' });
  assert.equal(lab.portStatus(port('R1', GI)).status, 'up/up');
  const show = lab.sessionExec(id, 'show running-config | include hostname');
  assert.equal(show.output, 'hostname R1\n');
  // the session view in the state follows the prompt
  assert.equal(lab.getState().sessions[0].prompt, 'R1#');
  // journal: dialog answers and empty lines are not actions; everything else is, with mode and feature
  const j = lab.getState().journal.filter((e) => e.via === 'console');
  assert.deepEqual(j.map((e) => [e.mode, e.line, e.feature, e.ok, e.mutated]), [
    ['user', 'enable', 'system', true, false],
    ['priv', 'configure terminal', 'system', true, false],
    ['config', 'hostname R1', 'system', true, true],
    ['config', 'interface g0/0/0', 'interface', true, false],
    ['config-if', 'ip address 10.0.1.1 255.255.255.0', 'interface', true, true],
    ['config-if', 'no shutdown', 'interface', true, true],
    ['config-if', 'end', 'system', true, false],
    ['priv', 'show running-config | include hostname', 'verify', true, false],
  ]);
});

test('IOS errors come back as output, are journaled as failed and change nothing', () => {
  const { lab } = start();
  const id = consoleToConfig(lab, 'PC1', 'R1');
  const bad = lab.sessionExec(id, 'ip adress 1.2.3.4');
  assert.match(bad.output, /\^\n% Invalid input detected at '\^' marker\./);
  assert.equal(bad.prompt, 'Router(config)#');
  const last = lab.getState().journal.at(-1)!;
  assert.deepEqual([last.line, last.ok, last.mutated], ['ip adress 1.2.3.4', false, false]);
  type(lab, id, ['end']);
  const typo = lab.sessionExec(id, 'shwo');
  assert.equal(typo.delayMs, 6000, 'the familiar DNS wait after a typo');
  assert.match(typo.output, /Translating "shwo"/);
  // legacy queueing: rejected with a simulator note
  type(lab, id, ['configure terminal']);
  const legacy = lab.sessionExec(id, 'priority-list 1 protocol ip high');
  assert.match(legacy.output, /Invalid input/);
  assert.ok(legacy.notes.length > 0);
});

test('help, completion, history and control keys', () => {
  const { lab } = start();
  const id = consoleToConfig(lab, 'PC1', 'R1');
  assert.match(lab.sessionHelp(id, 'host'), /hostname/);
  assert.match(lab.sessionHelp(id, 'hostname '), /WORD/);
  assert.deepEqual(lab.sessionComplete(id, 'hostn'), { line: 'hostname ', candidates: ['hostname'] });
  assert.deepEqual(lab.sessionComplete(id, ''), { line: '', candidates: [] });
  type(lab, id, ['interface g0/0/0']);
  const rev = lab.getState().rev;
  const z = lab.sessionKey(id, 'ctrl-z');
  assert.match(z.output, /^\^Z\n/);
  assert.match(z.output, /%SYS-5-CONFIG_I: Configured from console by console/);
  assert.equal(z.prompt, 'Router#');
  assert.ok(lab.getState().rev > rev);
  assert.deepEqual(lab.sessionHistory(id), ['enable', 'configure terminal', 'interface g0/0/0']);
  assert.equal(lab.sessionKey(id, 'ctrl-c').output, '');
  // unknown sessions are closed sessions
  assert.deepEqual(lab.sessionExec('nope', 'enable'), {
    output: '', prompt: '', secret: false, closed: true, notes: [], status: 'rejected', echo: { kind: 'hidden' }, pendingInput: null,
  });
  assert.equal(lab.sessionHelp('nope', 'x'), '');
  assert.deepEqual(lab.sessionComplete('nope', 'sh'), { line: 'sh', candidates: [] });
  assert.equal(lab.sessionKey('nope', 'ctrl-z').closed, true);
  assert.deepEqual(lab.sessionHistory('nope'), []);
});

test('unplugging the console cable closes the terminal; plugging it back resumes where the device was', () => {
  const { lab } = start();
  const id = consoleToConfig(lab, 'PC1', 'R1');
  type(lab, id, ['hostname R1', 'interface loopback 5']);
  assert.equal(lab.getState().sessions[0].prompt, 'R1(config-if)#');
  ok(lab.removeCable(cableId(lab, port('PC1', 'COM1'))));
  const closed = lab.getState().sessions[0];
  assert.deepEqual([closed.id, closed.closed, closed.prompt], [id, true, '']);
  assert.equal(lab.sessionExec(id, 'ip address 5.5.5.5 255.255.255.255').closed, true, 'nothing reaches the device without the cable');
  assert.equal(r1(lab).config.interfaces.Loopback5.ip, undefined);
  assert.equal(lab.openConsole('R1').ok, false);
  // back in — from the other PC this time
  ok(lab.connectCable('console', port('PC2', 'COM1'), port('R1', 'Console')));
  assert.equal(lab.getState().sessions[0].closed, true, 'the terminal stays closed until it is opened again');
  const back = lab.openConsole('R1');
  assert.ok(back.ok);
  if (!back.ok) return;
  assert.equal(back.banner, '', 'the device shows nothing new: it never noticed');
  assert.equal(back.session.id, id);
  assert.equal(back.session.prompt, 'R1(config-if)#');
  assert.equal(back.session.title, 'R1 — console (PC2 COM1, 9600 8N1)');
  assert.equal(back.session.pcId, 'PC2');
  type(lab, id, ['ip address 5.5.5.5 255.255.255.255']);
  assert.deepEqual(r1(lab).config.interfaces.Loopback5.ip, { address: '5.5.5.5', mask: '255.255.255.255' });
  assert.deepEqual(lab.sessionHistory(id).slice(-3), ['hostname R1', 'interface loopback 5', 'ip address 5.5.5.5 255.255.255.255']);
});

test('an unanswered initial dialog is still waiting after the cable was moved away and back', () => {
  const { lab } = start();
  plugConsole(lab, 'PC1', 'R1');
  openConsole(lab, 'R1');
  plugConsole(lab, 'PC1', 'R2');
  const r2 = lab.openConsole('R2');
  assert.ok(r2.ok && /Configuration Dialog/.test(r2.banner));
  assert.deepEqual(lab.getState().sessions.map((s) => [s.deviceId, s.closed]), [['R1', true], ['R2', false]]);
  plugConsole(lab, 'PC1', 'R1');
  const back = lab.openConsole('R1');
  assert.ok(back.ok && back.banner === '');
  assert.match(back.ok ? back.session.prompt : '', /initial configuration dialog/);
  assert.deepEqual(lab.getState().sessions.map((s) => [s.deviceId, s.closed]), [['R1', false], ['R2', true]]);
});

test('logout on the console closes the session; opening it again starts a new EXEC (with the line password)', () => {
  const { lab } = start();
  const id = consoleToConfig(lab, 'PC1', 'R1');
  type(lab, id, ['hostname R1', 'line console 0', 'password letmein', 'login', 'end']);
  const out = lab.sessionExec(id, 'exit');
  assert.equal(out.closed, true);
  assert.equal(out.prompt, '');
  assert.equal(lab.getState().sessions[0].closed, true);
  assert.equal(lab.sessionExec(id, 'enable').closed, true);
  const again = lab.openConsole('R1');
  assert.ok(again.ok);
  if (!again.ok) return;
  assert.equal(again.session.id, id);
  assert.match(again.banner, /R1 con0 is now available[\s\S]*Press RETURN to get started\.[\s\S]*User Access Verification/);
  assert.deepEqual([again.session.prompt, again.session.secret], ['Password: ', true]);
  const wrong = lab.sessionExec(id, 'nope');
  assert.equal(wrong.secret, true);
  const right = lab.sessionExec(id, 'letmein');
  assert.deepEqual([right.prompt, right.secret], ['R1>', false]);
  assert.ok(!lab.getState().journal.some((e) => e.line === 'letmein' || e.line === 'nope'), 'passwords never reach the journal');
});

test('closeSession removes the terminal view; the device keeps its console state', () => {
  const { lab } = start();
  const id = consoleToConfig(lab, 'PC1', 'R1');
  lab.closeSession(id);
  assert.deepEqual(lab.getState().sessions, []);
  assert.equal(lab.sessionExec(id, 'hostname X').closed, true);
  const back = lab.openConsole('R1');
  assert.ok(back.ok && back.banner === '' && back.session.prompt === 'Router(config)#');
  lab.closeSession('nope');
});

test('reload from the console: the device restarts and the same terminal starts from the beginning', () => {
  const { lab } = start();
  cableBench(lab);
  const id = consoleToConfig(lab, 'PC1', 'R1');
  type(lab, id, ['hostname R1', `interface ${GI}`, 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'end']);
  assert.equal(lab.portStatus(port('PC1', 'Ethernet0')).led, 'green');
  const ask = lab.sessionExec(id, 'reload');
  assert.match(ask.prompt, /System configuration has been modified\. Save\?/);
  type(lab, id, ['no']);
  const done = lab.sessionExec(id, '');
  assert.match(done.output, /%SYS-5-RELOAD: Reload requested by console/);
  assert.match(done.output, /System Configuration Dialog/);
  assert.match(done.prompt, /initial configuration dialog/);
  assert.ok(done.notes.some((n) => /restarted/.test(n)));
  assert.equal(r1(lab).config.hostname, 'Router', 'nothing was saved, so the configuration is gone');
  assert.equal(lab.portStatus(port('PC1', 'Ethernet0')).led, 'amber');
  assert.equal(lab.getState().sessions[0].closed, false);
  // saved configuration survives
  type(lab, id, ['no', '', 'enable', 'configure terminal', 'hostname R1', 'end', 'write memory', 'reload']);
  const again = lab.sessionExec(id, '');
  assert.match(again.output, /Press RETURN to get started!/);
  assert.equal(again.prompt, 'R1>');
  assert.equal(r1(lab).config.hostname, 'R1');
});
