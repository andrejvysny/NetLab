import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDevice, createWorld, getIos } from '../../src/engine/world.ts';
import { execLine, inspectLine, interrupt, startSession } from '../../src/engine/cli/framework.ts';
import type { World } from '../../src/engine/types.ts';
import { installCli } from '../../src/engine/cli/index.ts';

installCli();

function world(): World {
  const w = createWorld();
  addDevice(w, { id: 'r1', model: 'isr4331', label: 'R1', x: 0, y: 0 });
  return w;
}
function open(w: World, via: 'console' | 'vty' | 'file' = 'console', id = 'r1') {
  const { session, outcome } = startSession(w, id, via, { remoteAddr: via === 'vty' ? '192.168.100.10' : undefined });
  return { s: session, first: outcome, run: (l: string) => execLine(w, session, l) };
}
/** Console session past the initial dialog, in privileged EXEC. */
function priv(w: World) {
  const c = open(w);
  if (c.first.prompt.startsWith('Would you like')) c.run('no');
  c.run('enable');
  return c;
}
function configure(w: World, lines: string[]): void {
  const c = open(w, 'file');
  c.run('configure terminal');
  for (const l of lines) { const o = c.run(l); assert.ok(['ok', 'pending'].includes(o.status), `${l}: ${o.output}`); }
}
/** Run `fn`; false when it hit a 'not implemented' stub of another agent (caller skips). */
function implemented(fn: () => void): boolean {
  try { fn(); return true; } catch (e) { if (e instanceof Error && e.message === 'not implemented') return false; throw e; }
}

test('initial configuration dialog on a factory-fresh console', () => {
  const w = world();
  const c = open(w);
  assert.equal(c.first.output, '         --- System Configuration Dialog ---\n\n');
  assert.equal(c.first.prompt, 'Would you like to enter the initial configuration dialog? [yes/no]: ');
  let o = c.run('maybe');
  assert.match(o.output, /% Please answer 'yes' or 'no'\./);
  assert.equal(o.prompt, 'Would you like to enter the initial configuration dialog? [yes/no]: ');
  o = c.run('yes');
  assert.equal(o.notes.length, 1); assert.match(o.notes[0], /not simulated/);
  assert.equal(o.prompt, 'Would you like to enter the initial configuration dialog? [yes/no]: ');
  assert.equal(getIos(w, 'r1').runtime.setupDialogDone, false);
  o = c.run('no');
  assert.equal(o.output, '\n\nPress RETURN to get started!\n');
  assert.equal(o.prompt, 'Router>');
  assert.equal(getIos(w, 'r1').runtime.setupDialogDone, true);
  // the next console session goes straight to the prompt
  assert.equal(open(w).first.prompt, 'Router>');
});

test('setup dialog: "n" abbreviation, Ctrl-C, vty and file sessions skip it', () => {
  let w = world();
  let c = open(w);
  assert.equal(c.run('n').prompt, 'Router>');
  w = world();
  c = open(w);
  const o = interrupt(w, c.s, 'ctrl-c');
  assert.equal(o.prompt, 'Router>');
  assert.match(o.output, /Press RETURN to get started!/);
  w = world();
  assert.equal(open(w, 'file').first.prompt, 'Router#');
  w = world();
  getIos(w, 'r1').config.lines.vty[0].password = 'cisco';
  assert.equal(open(w, 'vty').first.prompt, 'Password: ');
});

test('enable: no password, enable secret, 3 tries, secret wins over password', () => {
  const w = world();
  getIos(w, 'r1').runtime.setupDialogDone = true;
  let c = open(w);
  let o = c.run('en');
  assert.equal(o.prompt, 'Router#'); assert.equal(o.mutated, false);
  assert.equal(c.run('disable').prompt, 'Router>');
  getIos(w, 'r1').config.enableSecret = 'class';
  o = c.run('enable');
  assert.equal(o.prompt, 'Password: '); assert.equal(o.secret, true);
  o = c.run('wrong');
  assert.equal(o.prompt, 'Password: ');
  o = c.run('class');
  assert.equal(o.prompt, 'Router#');
  c.run('disable');
  c.run('enable'); c.run('a'); c.run('b');
  o = c.run('c');
  assert.equal(o.output, '% Bad secrets\n\n'); assert.equal(o.prompt, 'Router>');
  // enable password is ignored while a secret exists
  getIos(w, 'r1').config.enablePassword = 'pass';
  c = open(w);
  c.run('enable');
  assert.equal(c.run('pass').prompt, 'Password: ');
  assert.equal(c.run('class').prompt, 'Router#');
  delete getIos(w, 'r1').config.enableSecret;
  c = open(w); c.run('enable');
  assert.equal(c.run('pass').prompt, 'Router#');
  // Ctrl-C at the enable password returns to user EXEC
  c = open(w); c.run('enable');
  assert.equal(interrupt(w, c.s, 'ctrl-c').prompt, 'Router>');
});

test('enable on a vty without any enable password: % No password set', () => {
  const w = world();
  const r = getIos(w, 'r1');
  r.config.lines.vty[0].login = false;
  const c = open(w, 'vty');
  assert.equal(c.first.prompt, 'Router>');
  const o = c.run('enable');
  assert.equal(o.output, '% No password set\n'); assert.equal(o.prompt, 'Router>'); assert.equal(o.status, 'rejected');
  r.config.enableSecret = 'class';
  c.run('enable');
  assert.equal(c.run('class').prompt, 'Router#');
});

test('configure terminal and the configure question', () => {
  const w = world();
  const c = priv(w);
  let o = c.run('conf t');
  assert.equal(o.output, 'Enter configuration commands, one per line.  End with CNTL/Z.\n');
  assert.equal(o.prompt, 'Router(config)#');
  assert.equal(o.mutated, false);
  c.run('end');
  o = c.run('configure');
  assert.equal(o.prompt, 'Configuring from terminal, memory, or network [terminal]? ');
  o = c.run('');
  assert.equal(o.prompt, 'Router(config)#');
  c.run('end');
  c.run('conf'); o = c.run('x');
  assert.match(o.output, /\?Must be "terminal", "memory" or "network"/);
  assert.equal(o.prompt, 'Router#');
  assert.deepEqual(inspectLine(w, c.s, 'configure terminal'), { status: 'ok', feature: 'system', mutates: false });
});

test('terminal, clock set, debug and undebug', () => {
  const w = world();
  const c = priv(w);
  assert.equal(c.run('terminal length 0').status, 'ok');
  assert.equal(c.s.termLength, 0);
  c.run('term no length'); assert.equal(c.s.termLength, 24);
  assert.equal(c.run('terminal monitor').output, '% Console already monitors\n');
  let o = c.run('clock set 10:15:00 12 November 2026');
  assert.equal(o.status, 'ok'); assert.equal(o.notes.length, 1);
  assert.equal(c.run('clock set 10:15:00 Nov 12 2026').status, 'ok');
  o = c.run('clock set 25:00:00 12 Nov 2026');
  assert.equal(o.status, 'rejected');
  assert.equal(o.output.split('\n')[0], ' '.repeat('Router#clock set '.length) + '^');
  assert.equal(c.run('clock set 10:00:00 40 Nov 2026').status, 'rejected');
  for (const line of ['debug ip rip', 'deb crypto isa', 'undebug all', 'u all', 'no debug all', 'no debug ip rip']) {
    o = c.run(line);
    assert.equal(o.status, 'ok', line);
    assert.equal(o.output, ''); assert.match(o.notes[0], /not simulated/);
    assert.equal(o.feature, 'verify'); assert.equal(o.mutated, false);
  }
  assert.equal(c.run('debug something odd').status, 'invalid');
  o = c.run('debug all');
  assert.equal(o.prompt, 'This may severely impact network performance. Continue? (yes/[no]): ');
  assert.match(c.run('yes').notes[0], /not simulated/);
});

test('clear commands', () => {
  const w = world();
  const r = getIos(w, 'r1');
  const c = priv(w);
  r.runtime.dhcpBindings = [
    { address: '192.168.100.101', clientId: 'a', pool: 'LAN1', grantedTick: 1 },
    { address: '192.168.100.102', clientId: 'b', pool: 'LAN1', grantedTick: 1 },
  ];
  assert.equal(c.run('clear ip dhcp binding 192.168.100.101').status, 'ok');
  assert.deepEqual(r.runtime.dhcpBindings.map((b) => b.address), ['192.168.100.102']);
  assert.equal(c.run('clear ip dhcp binding *').status, 'ok');
  assert.equal(r.runtime.dhcpBindings.length, 0);
  r.runtime.ifCounters = { 'GigabitEthernet0/0/0': { in: 5, out: 6 } };
  let o = c.run('clear counters');
  assert.equal(o.prompt, 'Clear "show interface" counters on all interfaces [confirm]');
  c.run('');
  assert.deepEqual(r.runtime.ifCounters, {});
  o = c.run('clear counters g0/0/0');
  assert.equal(o.prompt, 'Clear "show interface" counters on this interface [confirm]');
  c.run('n');
  assert.equal(c.run('clear counters g0/0/7').status, 'rejected');
  o = c.run('clear line 2');
  assert.equal(o.prompt, '[confirm]');
  o = c.run('');
  assert.equal(o.status, 'rejected');
  assert.match(o.output, /not simulated.*No session was reset/);
  assert.equal(c.run('clear line vty 3').prompt, '[confirm]'); c.run('n');
  assert.equal(c.run('clear line 99').status, 'rejected');
  assert.equal(c.run('clear arp-cache').status, 'ok');
  assert.equal(c.run('clear ip route *').status, 'ok');
});

test('banner motd is shown when a session starts', () => {
  const w = world();
  configure(w, ['banner motd #Authorized access only#']);
  getIos(w, 'r1').runtime.setupDialogDone = true;
  const c = open(w);
  assert.equal(c.first.output, 'Authorized access only\n');
  assert.equal(c.first.prompt, 'Router>');
});

test('console login with line password (3 attempts, console stays open)', () => {
  const w = world();
  configure(w, ['line con 0', 'password cisco', 'login']);
  getIos(w, 'r1').runtime.setupDialogDone = true;
  let c = open(w);
  assert.equal(c.first.output, '\nUser Access Verification\n\n');
  assert.equal(c.first.prompt, 'Password: '); assert.equal(c.first.secret, true);
  assert.equal(c.run('cisco').prompt, 'Router>');
  c = open(w);
  c.run('x'); c.run('y');
  const o = c.run('z');
  assert.match(o.output, /% Bad passwords/);
  assert.equal(o.closed, false);
  assert.equal(o.prompt, 'Password: ');
  // Ctrl-C does not bypass the password
  assert.equal(interrupt(w, c.s, 'ctrl-c').prompt, 'Password: ');
  assert.equal(c.run('cisco').prompt, 'Router>');
});

test('console: login without a password does not lock you out', () => {
  const w = world();
  const c = priv(w);
  c.run('conf t'); c.run('line con 0');
  const o = c.run('login');
  assert.equal(o.output, "% Login disabled on line 0, until 'password' is set\n");
  assert.equal(open(w).first.prompt, 'Router>');
});

test('vty login: password, 3 bad attempts close, no password closes', () => {
  const w = world();
  configure(w, ['line vty 0 4', 'password cisco', 'login']);
  let c = open(w, 'vty');
  assert.equal(c.first.output, '\nUser Access Verification\n\n');
  assert.equal(c.first.prompt, 'Password: ');
  let o = c.run('cisco');
  assert.equal(o.prompt, 'Router>'); assert.equal(o.closed, false);
  c = open(w, 'vty');
  c.run('a'); assert.equal(c.run('b').prompt, 'Password: ');
  o = c.run('c');
  assert.equal(o.output, '% Bad passwords\n\n'); assert.equal(o.closed, true);
  // factory default: login without password
  const w2 = world();
  c = open(w2, 'vty');
  assert.equal(c.first.output, '\nPassword required, but none set\n');
  assert.equal(c.first.closed, true);
  // no login: straight in
  configure(w2, ['line vty 0 4', 'no login']);
  assert.equal(open(w2, 'vty').first.prompt, 'Router>');
});

test('vty login uses the line at position vtyInUse (line 5 has its own settings)', () => {
  const w = world();
  configure(w, ['line vty 0 4', 'password one', 'login', 'line vty 5 14', 'password two', 'login']);
  const r = getIos(w, 'r1');
  r.runtime.vtyInUse = 5;
  const c = open(w, 'vty');
  assert.equal(c.run('one').prompt, 'Password: ');
  assert.equal(c.run('two').prompt, 'Router>');
});

test('vty login local: Username/Password, % Login invalid, privilege 15 lands in privileged EXEC', () => {
  const w = world();
  configure(w, ['username admin privilege 15 secret s3cret', 'username bob password 0 bobpw', 'line vty 0 4', 'login local']);
  let c = open(w, 'vty');
  assert.equal(c.first.prompt, 'Username: '); assert.equal(c.first.secret, false);
  let o = c.run('admin');
  assert.equal(o.prompt, 'Password: '); assert.equal(o.secret, true);
  assert.equal(c.run('s3cret').prompt, 'Router#');
  c = open(w, 'vty');
  c.run('bob');
  assert.equal(c.run('bobpw').prompt, 'Router>');
  c = open(w, 'vty');
  c.run('bob'); o = c.run('nope');
  assert.equal(o.output, '% Login invalid\n\n'); assert.equal(o.prompt, 'Username: ');
  c.run('x'); c.run('y'); c.run('z'); o = c.run('w');
  assert.equal(o.closed, true);
});

test('privilege level 15 on a line starts the session in privileged EXEC', () => {
  const w = world();
  configure(w, ['line vty 0 4', 'password cisco', 'login', 'privilege level 15', 'line con 0', 'privilege level 15']);
  const c = open(w, 'vty');
  assert.equal(c.run('cisco').prompt, 'Router#');
  getIos(w, 'r1').runtime.setupDialogDone = true;
  assert.equal(open(w).first.prompt, 'Router#');
});

test('save, erase and reload (needs config/apply.ts and render.ts)', (t) => {
  const w = world();
  const c = priv(w);
  c.run('conf t'); c.run('hostname R1'); c.run('end');
  let o = c.run('copy run start');
  assert.equal(o.prompt, 'Destination filename [startup-config]? ');
  let ok = implemented(() => { o = c.run(''); });
  if (!ok) { t.skip('saveStartupConfig is still a stub'); return; }
  assert.equal(o.output, 'Building configuration...\n[OK]\n');
  assert.notEqual(getIos(w, 'r1').startupConfig, null);
  assert.equal(c.run('wr').output, 'Building configuration...\n[OK]\n');
  // reload with nothing changed: only the confirmation
  let rel: ReturnType<typeof c.run> | undefined;
  ok = implemented(() => { rel = c.run('reload'); });
  if (!ok) { t.skip('renderRunningConfig is still a stub'); return; }
  assert.equal(rel!.prompt, 'Proceed with reload? [confirm]');
  ok = implemented(() => { o = c.run(''); });
  if (!ok) { t.skip('reloadDevice is still a stub'); return; }
  assert.equal(o.prompt, 'R1>');
  // modified → Save? question
  c.run('en'); c.run('conf t'); c.run('hostname R9'); c.run('end');
  o = c.run('reload');
  assert.equal(o.prompt, 'System configuration has been modified. Save? [yes/no]: ');
  o = c.run('maybe');
  assert.match(o.output, /Please answer 'yes' or 'no'/);
  o = c.run('no');
  assert.equal(o.prompt, 'Proceed with reload? [confirm]');
  o = c.run('');
  assert.equal(o.prompt, 'R1>', 'unsaved hostname is lost after reload');
  // write erase + reload → factory fresh, dialog again
  c.run('en');
  o = c.run('write erase');
  assert.equal(o.prompt, 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]');
  o = c.run('');
  assert.equal(o.output, '[OK]\nErase of nvram: complete\n');
  assert.equal(getIos(w, 'r1').startupConfig, null);
  c.run('reload');
  if (c.s.pending?.kind === 'reload-save') c.run('no');
  o = c.run('');
  assert.equal(o.prompt, 'Would you like to enter the initial configuration dialog? [yes/no]: ');
});

test('erase and copy prompts can be declined', (t) => {
  const w = world();
  const c = priv(w);
  c.run('erase startup-config');
  assert.equal(c.run('n').output, '');
  const o = c.run('copy startup-config running-config');
  assert.equal(o.prompt, 'Destination filename [running-config]? ');
  assert.equal(c.run('').output, '%Error opening nvram:/startup-config (No such file or directory)\n');
  void t;
});

test('feature and mutates of EXEC commands', () => {
  const w = world();
  const c = priv(w);
  assert.deepEqual(inspectLine(w, c.s, 'enable'), { status: 'ok', feature: 'system', mutates: false });
  assert.equal(inspectLine(w, c.s, 'copy running-config startup-config').mutates, false);
  assert.equal(inspectLine(w, c.s, 'reload').mutates, true);
  assert.equal(inspectLine(w, c.s, 'write erase').mutates, true);
  assert.equal(inspectLine(w, c.s, 'debug ip nat').feature, 'verify');
  assert.equal(inspectLine(w, c.s, 'clear ip dhcp binding *').feature, 'dhcp');
});

