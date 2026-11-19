import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDevice, createWorld, getIos } from '../../src/engine/world.ts';
import { execLine, helpFor, inspectLine, startSession } from '../../src/engine/cli/framework.ts';
import { installCli } from '../../src/engine/cli/index.ts';
import { applyVty, ensureVty, normalizeVty } from '../../src/engine/cli/commands/line.ts';
import { defaultIosConfig, portsFor } from '../../src/engine/world.ts';
import type { World } from '../../src/engine/types.ts';

installCli();

function lab(model: 'isr4331' | 'c9300l' = 'isr4331') {
  const w: World = createWorld();
  addDevice(w, { id: 'd', model, label: 'D', x: 0, y: 0 });
  getIos(w, 'd').runtime.setupDialogDone = true;
  const { session } = startSession(w, 'd', 'console');
  const run = (l: string) => execLine(w, session, l);
  run('enable'); run('conf t');
  return { w, s: session, run, cfg: () => getIos(w, 'd').config };
}
const ranges = (cfg: { lines: { vty: { first: number; last: number }[] } }) => cfg.lines.vty.map((r) => `${r.first}-${r.last}`);

test('line vty / line con: navigation, ctx, mutates false, abbreviations', () => {
  const { w, s, run } = lab();
  let o = run('line vty 0 4');
  assert.equal(o.prompt, 'Router(config-line)#'); assert.equal(o.mutated, false); assert.equal(o.feature, 'vty');
  assert.deepEqual(s.ctx, { lineType: 'vty', first: 0, last: 4 });
  o = run('line con 0');
  assert.deepEqual(s.ctx, { lineType: 'console', first: 0, last: 0 });
  assert.equal(o.mutated, false);
  run('line vty 3');
  assert.deepEqual(s.ctx, { lineType: 'vty', first: 3, last: 3 });
  assert.equal(inspectLine(w, s, 'line vty 5 14').mutates, false);
  assert.equal(run('line console 1').status, 'invalid');
  o = run('line vty 4 2');
  assert.equal(o.status, 'rejected');
  assert.equal(o.output.split('\n')[0], ' '.repeat('Router(config-line)#line vty 4 '.length) + '^');
  assert.equal(run('line vty 0 16').status, 'invalid');
  assert.equal(run('line aux 0').status, 'ok');
});

test('selecting new vty lines creates them; settings split and merge ranges', () => {
  const { run, cfg } = lab();
  assert.deepEqual(ranges(cfg()), ['0-4']);
  run('line vty 5 14');
  assert.deepEqual(ranges(cfg()), ['0-4', '5-14'], 'IOS keeps 0-4 and 5+ apart');
  assert.deepEqual(cfg().lines.vty[1], { first: 5, last: 14, login: true });
  run('password cisco');
  assert.deepEqual(ranges(cfg()), ['0-4', '5-14']);
  run('line vty 2 7');
  run('transport input telnet');
  assert.deepEqual(ranges(cfg()), ['0-1', '2-4', '5-7', '8-14']);
  assert.equal(cfg().lines.vty[1].transportInput, 'telnet');
  assert.equal(cfg().lines.vty[2].transportInput, 'telnet');
  assert.equal(cfg().lines.vty[2].password, 'cisco');
  assert.equal(cfg().lines.vty[0].password, undefined);
  run('line vty 0 15');
  run('password cisco'); run('transport input telnet');
  assert.deepEqual(ranges(cfg()), ['0-4', '5-15']);
  assert.ok(cfg().lines.vty.every((r) => r.password === 'cisco' && r.transportInput === 'telnet'));
  run('line vty 8 9');
  run('no transport input');
  run('line vty 8 9');
  run('transport input telnet');
  assert.deepEqual(ranges(cfg()), ['0-4', '5-15'], 'neighbours with identical settings merge again');
});

test('vty helpers keep ranges non-overlapping and sorted', () => {
  const cfg = defaultIosConfig('router', portsFor('isr4331'));
  ensureVty(cfg, 10, 12);
  assert.deepEqual(ranges(cfg), ['0-4', '10-12']);
  applyVty(cfg, 3, 11, (l) => { l.loggingSynchronous = true; });
  assert.deepEqual(ranges(cfg), ['0-2', '3-4', '5-11', '12-12']);
  assert.ok(cfg.lines.vty.filter((r) => r.first >= 3 && r.last <= 11).every((r) => r.loggingSynchronous));
  applyVty(cfg, 0, 15, (l) => { l.loggingSynchronous = true; });
  assert.deepEqual(ranges(cfg), ['0-4', '5-15']);
  cfg.lines.vty.reverse();
  normalizeVty(cfg);
  assert.deepEqual(ranges(cfg), ['0-4', '5-15']);
});

test('no line vty: removes lines above 4 only', () => {
  const { run, cfg } = lab();
  run('line vty 5 15'); run('exit');
  run('no line vty 10 15');
  assert.deepEqual(ranges(cfg()), ['0-4', '5-9']);
  const o = run('no line vty 0 4');
  assert.equal(o.output, "% Can't delete last 5 VTY lines\n");
  assert.deepEqual(ranges(cfg()), ['0-4', '5-9']);
});

test('password / login / login local / no login and the Login disabled warning', () => {
  const { run, cfg } = lab();
  run('line vty 0 4');
  let o = run('login');
  assert.equal(o.output, [2, 3, 4, 5, 6].map((n) => `% Login disabled on line ${n}, until 'password' is set`).join('\n') + '\n');
  o = run('password cisco');
  assert.equal(o.status, 'ok'); assert.equal(o.output, '');
  assert.equal(run('login').output, '');
  assert.deepEqual(cfg().lines.vty[0], { first: 0, last: 4, login: true, password: 'cisco' });
  run('login local');
  assert.equal(cfg().lines.vty[0].login, 'local');
  run('no login');
  assert.equal(cfg().lines.vty[0].login, false);
  run('no password');
  assert.equal(cfg().lines.vty[0].password, undefined);
  run('password 7 070C285F4D06');
  assert.equal(cfg().lines.vty[0].password, 'cisco');
  run('line con 0');
  run('password cisco'); run('login'); run('logging synchronous'); run('exec-timeout 0 0');
  assert.deepEqual(cfg().lines.console, { login: true, password: 'cisco', loggingSynchronous: true, execTimeout: [0, 0] });
  run('no logging synchronous'); run('no exec-timeout');
  assert.deepEqual(cfg().lines.console, { login: true, password: 'cisco' });
});

test('switch vty lines are numbered from 1 in the warning', () => {
  const { run } = lab('c9300l');
  run('line vty 0 1');
  assert.equal(run('login').output, "% Login disabled on line 1, until 'password' is set\n% Login disabled on line 2, until 'password' is set\n");
});

test('transport input forms', () => {
  const { run, cfg } = lab();
  run('line vty 0 4');
  run('transport input none'); assert.equal(cfg().lines.vty[0].transportInput, 'none');
  run('transport input all'); assert.equal(cfg().lines.vty[0].transportInput, 'all');
  run('transport input ssh'); assert.equal(cfg().lines.vty[0].transportInput, 'ssh');
  run('transport input telnet ssh'); assert.equal(cfg().lines.vty[0].transportInput, 'telnet ssh');
  run('transport input ssh telnet'); assert.equal(cfg().lines.vty[0].transportInput, 'telnet ssh');
  run('transport in tel'); assert.equal(cfg().lines.vty[0].transportInput, 'telnet');
  run('no transport input'); assert.equal(cfg().lines.vty[0].transportInput, undefined);
  assert.equal(run('transport input rlogin').status, 'invalid');
});

test('access-class in/out and the no forms (feature vty)', () => {
  const { w, s, run, cfg } = lab();
  run('line vty 0 4');
  let o = run('access-class allowPC1 in');
  assert.equal(o.feature, 'vty'); assert.equal(o.mutated, true);
  assert.equal(cfg().lines.vty[0].accessClassIn, 'allowPC1');
  o = run('access-class 5 out');
  assert.equal(cfg().lines.vty[0].accessClassOut, '5'); assert.match(o.notes[0], /not simulated/);
  run('no access-class 5 out');
  assert.equal(cfg().lines.vty[0].accessClassOut, undefined);
  run('no access-class other in');
  assert.equal(cfg().lines.vty[0].accessClassIn, 'allowPC1', 'a different ACL name does not remove it');
  run('no access-class allowPC1 in');
  assert.equal(cfg().lines.vty[0].accessClassIn, undefined);
  assert.equal(run('access-class allowPC1').status, 'incomplete');
  assert.deepEqual(inspectLine(w, s, 'access-class 10 in'), { status: 'ok', feature: 'vty', mutates: true });
});

test('history size, privilege level, length are accepted as extra lines', () => {
  const { run, cfg } = lab();
  run('line vty 0 4');
  run('history size 50'); run('privilege level 15'); run('length 0');
  assert.deepEqual(cfg().lines.vty[0].extraLines, ['history size 50', 'privilege level 15', 'length 0']);
  run('no history size'); run('privilege level 1'); run('no length');
  assert.equal(cfg().lines.vty[0].extraLines, undefined);
  run('line con 0');
  run('stopbits 1');
  assert.equal(cfg().lines.console.extraLines, undefined);
  run('stopbits 2');
  assert.deepEqual(cfg().lines.console.extraLines, ['stopbits 2']);
});

test('line help texts', () => {
  const { w, s, run } = lab();
  assert.match(helpFor(w, s, 'line '), /vty\s+Virtual terminal/);
  run('line vty 0 4');
  assert.match(helpFor(w, s, ''), /access-class\s+Filter connections based on an IP access list/);
  assert.match(helpFor(w, s, 'transport input '), /telnet\s+TCP\/IP Telnet protocol/);
});
