import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDevice, createWorld, getIos } from '../../src/engine/world.ts';
import { completeLine, execLine, helpFor, inspectLine, installCli, interrupt, startSession } from '../../src/engine/cli/index.ts';

installCli();

function lab(model: 'isr4331' | 'c9300l' = 'isr4331') {
  const w = createWorld();
  addDevice(w, { id: 'd', model, label: 'Device', x: 0, y: 0 });
  const dev = getIos(w, 'd');
  dev.runtime.setupDialogDone = true;
  const open = (via: 'console' | 'vty' = 'console') => {
    const { session: s, outcome: first } = startSession(w, 'd', via);
    return { s, first, run: (text: string) => execLine(w, s, text) };
  };
  const c = open();
  const configure = (...lines: string[]) => {
    c.run('en'); c.run('conf t');
    for (const text of lines) assert.equal(c.run(text).status, 'ok', text);
    c.run('end');
  };
  return { w, dev, ...c, open, configure };
}

for (const model of ['isr4331', 'c9300l'] as const) {
  test(`${model}: console abbreviations, privileged config views, mode/context and control keys`, () => {
    const { w, s, run, dev } = lab(model);
    const host = dev.config.hostname;
    const iface = model === 'isr4331' ? 'g0/0/0' : 'g1/0/1';
    const before = structuredClone(dev.config);
    assert.equal(run('sh ip int br').status, 'ok');
    assert.equal(run('sh run').status, 'invalid');
    assert.equal(run('sh start').status, 'invalid');
    assert.equal(run('conf t').status, 'invalid');
    assert.doesNotMatch(helpFor(w, s, 'show '), /running-config|startup-config/);
    assert.deepEqual(dev.config, before);
    assert.equal(run('e').status, 'ambiguous'); // enable / exit
    assert.equal(run('en').prompt, `${host}#`);
    assert.equal(run('conf t').prompt, `${host}(config)#`);
    assert.equal(run(`int ${iface}`).prompt, `${host}(config-if)#`);
    const ctx = structuredClone(s.ctx);
    const verify = run('do sh ip int br');
    assert.equal(verify.status, 'ok');
    assert.equal(verify.mutated, false);
    assert.deepEqual(s.ctx, ctx);
    assert.equal(run('show ip int br').status, 'invalid');
    assert.equal(interrupt(w, s, 'ctrl-c').prompt, `${host}(config-if)#`);
    assert.deepEqual(s.ctx, ctx);
    assert.equal(run('ex').prompt, `${host}(config)#`);
    assert.equal(interrupt(w, s, 'ctrl-z').prompt, `${host}#`);
    assert.equal(run('dis').prompt, `${host}>`);
  });
}

test('console local and line login prompts are not dismissed by either control key', () => {
  const { w, open, configure } = lab();
  configure('username student secret classroom', 'line con 0', 'login local', 'line vty 0 4', 'password classroom', 'login');
  for (const via of ['console', 'vty'] as const) {
    const { s, run, first } = open(via);
    for (const key of ['ctrl-z', 'ctrl-c'] as const) {
      assert.equal(interrupt(w, s, key).prompt, first.prompt);
      assert.equal(helpFor(w, s, ''), '');
      assert.equal(inspectLine(w, s, 'enable').status, 'pending');
    }
    if (via === 'console') assert.equal(run('student').prompt, 'Password: ');
    for (const key of ['ctrl-z', 'ctrl-c'] as const) assert.equal(interrupt(w, s, key).secret, true);
    assert.deepEqual(s.history, []);
    assert.equal(run('classroom').prompt, 'Router>');
  }
});

test('local login without users still requires credentials', () => {
  const { w, open, configure } = lab();
  configure('line con 0', 'login local');
  const { s, first, run } = open();
  assert.equal(first.prompt, 'Username: ');
  assert.equal(interrupt(w, s, 'ctrl-z').prompt, 'Username: ');
  assert.equal(run('student').prompt, 'Password: ');
  assert.equal(run('classroom').prompt, 'Username: ');
  assert.equal(s.mode, 'user');
  assert.deepEqual(s.history, []);
});

test('changing credentials while a login is pending cannot silently finish login', () => {
  const { w, dev, open, configure } = lab('c9300l');
  configure('line con 0', 'login', 'password classroom');
  const { s, first, run } = open();
  assert.equal(first.secret, true);
  delete dev.config.lines.console.password;
  assert.equal(interrupt(w, s, 'ctrl-c').prompt, 'Password: ');
  const result = run('classroom');
  assert.equal(result.closed, true);
  assert.equal(result.status, 'rejected');
  assert.match(result.output, /changed.*reconnect/i);
});

test('unsupported enable levels cannot promote to level 15', () => {
  const { run } = lab();
  assert.equal(run('enable 1').status, 'rejected');
  assert.equal(run('enable 1').prompt, 'Router>');
  assert.equal(run('enable 15').prompt, 'Router#');
});

test('do grammar handles help and incomplete commands, and refuses mode-changing EXEC commands', () => {
  const { w, s, run, configure } = lab();
  configure('alias exec ct configure terminal');
  run('conf t'); run('int g0/0/0');
  assert.equal(run('do').status, 'incomplete');
  assert.match(helpFor(w, s, ''), /\bdo\b/);
  assert.match(helpFor(w, s, 'do '), /\bshow\b/);
  assert.doesNotMatch(helpFor(w, s, 'do '), /^  (?:configure|exit)\b/m);
  assert.match(helpFor(w, s, 'hostname '), /WORD/);
  assert.equal(completeLine(w, s, 'hostn').line, 'hostname ');
  const ctx = structuredClone(s.ctx);
  for (const command of ['do conf t', 'do conf', 'do ct', 'do exit', 'do disable']) {
    const o = run(command);
    assert.equal(o.status, 'invalid', command);
    assert.equal(o.closed, false);
    assert.equal(o.prompt, 'Router(config-if)#');
    assert.equal(s.pending, undefined);
    assert.deepEqual(s.ctx, ctx);
  }
});

test('alias output filters share inspection and execution; history keeps the typed line', () => {
  const { w, s, run, configure } = lab();
  configure('hostname R1', 'alias exec rc show running-config', 'alias exec hn show running-config | include ^hostname', 'alias exec out show');
  assert.deepEqual(inspectLine(w, s, 'rc | i ^hostname'), { status: 'ok', mutates: false, feature: 'verify' });
  assert.equal(run('rc | i ^hostname').output, 'hostname R1\n');
  assert.equal(s.history.at(-1), 'rc | i ^hostname');
  assert.equal(run('hn').output, 'hostname R1\n');
  assert.equal(run('out run |i ^hostname|^end$').output, 'hostname R1\nend\n');
  assert.match(helpFor(w, s, 'rc'), /\*rc=/);
  assert.match(helpFor(w, s, 'rc | '), /\binclude\b/);
  assert.equal(completeLine(w, s, 'rc | inc').line, 'rc | include ');
  run('conf t');
  assert.deepEqual(inspectLine(w, s, 'do rc | i ^hostname'), { status: 'ok', mutates: false, feature: 'verify' });
  assert.equal(run('do rc | i ^hostname').output, 'hostname R1\n');
  assert.equal(run('do hn').output, 'hostname R1\n');
  run('end'); run('disable');
  assert.equal(run('rc | i ^hostname').status, 'invalid');
  assert.equal(run('hn').status, 'invalid');
});

test('output modifiers validate before execution and preserve literal pipe in configuration text', () => {
  const { w, s, run, dev } = lab();
  run('en');
  for (const [text, status] of [
    ['show run |', 'incomplete'], ['show run | include', 'incomplete'],
    ['show run | bogus text', 'invalid'], ['show run | i [', 'invalid'],
  ]) {
    const result = run(text);
    assert.equal(inspectLine(w, s, text).status, status, text);
    assert.equal(result.status, status, text);
    assert.doesNotMatch(result.output, /Building configuration/);
  }
  run('conf t');
  assert.equal(run('banner motd #Lab | allowed#').status, 'ok');
  assert.equal(dev.config.bannerMotd, 'Lab | allowed');
});

test('copy destination cannot silently save or apply to a different name', () => {
  const { run, dev } = lab();
  run('en');
  assert.equal(run('copy run start').prompt, 'Destination filename [startup-config]? ');
  assert.equal(run('wrong.cfg').status, 'rejected');
  assert.equal(dev.startupConfig, null);
  run('copy run start'); run('');
  const saved = dev.startupConfig;
  assert.ok(saved);
  run('conf t'); run('hostname Changed'); run('end');
  run('copy start run');
  assert.equal(run('wrong.cfg').status, 'rejected');
  assert.equal(dev.config.hostname, 'Changed');
  run('copy start run'); run('');
  assert.equal(dev.config.hostname, 'Router');
});

test('known debug topics and menu forms validate their abbreviations and missing arguments', () => {
  const { run, dev } = lab();
  run('en');
  assert.equal(run('debug x').status, 'invalid');
  assert.equal(run('debug ip').status, 'incomplete');
  assert.equal(run('deb crypto i').status, 'ambiguous');
  assert.match(run('deb ip rip').notes.join(' '), /not simulated/);
  run('conf t');
  assert.equal(run('menu lab nonsense item value').status, 'invalid');
  assert.equal(run('menu lab text').status, 'incomplete');
  assert.deepEqual(dev.config.extraLines, []);
  assert.match(run('menu lab t item label').output, /Ambiguous/); // title / text
  assert.match(run('menu lab tex item label').notes.join(' '), /not simulated/);
});

test('configured line length is the default of a fresh console/VTY; terminal override is per session', () => {
  const { open, configure } = lab();
  configure('line con 0', 'length 7', 'line vty 0 4', 'password classroom', 'length 0');
  const console = open();
  const remote = open('vty'); remote.run('classroom');
  assert.equal(console.s.termLength, 7);
  assert.equal(remote.s.termLength, 0);
  assert.equal(console.run('terminal length 12').status, 'ok');
  assert.equal(console.s.termLength, 12);
  assert.equal(remote.s.termLength, 0);
  console.run('terminal no length');
  assert.equal(console.s.termLength, 7);
});

test('configuration show caret diagnostics stay under what was typed', () => {
  const { run, configure } = lab();
  configure('alias exec ri show running-config interface');
  run('conf t'); run('int g0/0/0');
  for (const prefix of ['  do   show run interface ', 'do  ri ']) {
    const result = run(`${prefix}Loopback123`);
    assert.equal(result.status, 'rejected');
    assert.equal(result.output.split('\n')[0], ' '.repeat('Router(config-if)#'.length + prefix.length) + '^');
  }
});

test('release-specific config-register command and bare configure source limits', () => {
  for (const model of ['isr4331', 'c9300l'] as const) {
    const { run, dev } = lab(model);
    run('en');
    assert.match(run('configure').prompt, /\[terminal\]/);
    assert.match(run('m').output, /Only terminal configuration/);
    assert.match(run('configure network').output, /Only terminal configuration/);
    const start = run('conf t').prompt;
    assert.match(start, /\(config\)#$/);
    const output = run('config-register 0x2102');
    assert.equal(output.prompt, start);
    if (model === 'c9300l') {
      assert.equal(output.status, 'invalid');
      assert.deepEqual(dev.config.extraLines, []);
    } else {
      assert.equal(output.status, 'ok');
      assert.match(output.notes.join(' '), /not simulated/);
    }
  }
});

test('configuration credentials, including aliases, are saved in CLI history', () => {
  const { s, run } = lab();
  run('en'); run('conf t');
  assert.equal(run('enable secret ephemeral').status, 'ok');
  assert.equal(run('alias configure ep enable password').status, 'ok');
  assert.equal(run('ep classroom').status, 'ok');
  assert.deepEqual(s.history, ['en', 'conf t', 'enable secret ephemeral', 'alias configure ep enable password', 'ep classroom']);
});

test('CLI outcomes carry length, pending shape and a display-only input echo', () => {
  const { w, run, configure } = lab();
  configure('line console 0', 'length 9');
  const terminal = startSession(w, 'd', 'console');
  assert.equal(terminal.outcome.termLength, 9);
  assert.equal(terminal.outcome.pendingInput, null);
  const set = run('terminal length 0');
  assert.equal(set.termLength, 0);
  assert.equal(set.status, 'ok');
  assert.deepEqual(set.echo, { kind: 'plain', text: 'terminal length 0' });
  run('conf t');
  run('alias configure ap enable password');
  const configured = run('ap s?cret-value');
  assert.deepEqual(configured.echo, { kind: 'plain', text: 'ap s?cret-value' });
  run('end');
  run('disable');
  const ask = run('enable');
  assert.deepEqual(ask.pendingInput, { kind: 'password', paste: 'manual' });
  assert.equal(ask.termLength, 0);
  const retry = run('different-secret');
  assert.equal(retry.status, 'rejected');
  assert.deepEqual(retry.echo, { kind: 'hidden' });
  assert.deepEqual(retry.pendingInput, ask.pendingInput);
  assert.equal(run('s?cret-value').pendingInput, null);
});

test('copy startup-config and reload report source lines and fail safely for unsupported startup text', () => {
  const { dev, run, configure, s } = lab();
  configure('hostname Working', 'enable secret valid');
  run('terminal length 0');
  const running = dev.config, runtime = dev.runtime;
  dev.startupConfig = 'hostname UnsafePartial\nlegacy-unknown feature\n!\nenable secret 9 $9$vendor$legacy-secret\nend\n';
  const startup = dev.startupConfig;
  assert.deepEqual(run('copy startup-config running-config').pendingInput, { kind: 'text', paste: 'allow' });
  const copy = run('');
  assert.equal(copy.status, 'rejected');
  assert.match(copy.output, /startup-config line 2:.*Invalid input/s);
  assert.match(copy.output, /startup-config line 4: enable secret 9 \$9\$vendor\$legacy-secret\n.*encrypted credential.*Copy canceled/s);
  assert.doesNotMatch(copy.output, /bytes copied/);
  assert.equal(dev.config, running);
  assert.equal(dev.runtime, runtime);
  assert.equal(dev.startupConfig, startup);
  const ask = run('reload');
  assert.deepEqual(ask.pendingInput, { kind: 'confirm', paste: 'manual' });
  if (ask.prompt.includes('Save?')) run('no');
  const reload = run('');
  assert.equal(reload.status, 'rejected');
  assert.match(reload.output, /startup-config line 2:.*startup-config line 4:.*Reload canceled/s);
  assert.doesNotMatch(reload.output, /SYS-5-RELOAD|Press RETURN/);
  assert.equal(dev.config, running);
  assert.equal(dev.runtime, runtime);
  assert.equal(dev.startupConfig, startup);
  assert.equal(reload.prompt, 'Working#');
  assert.equal(reload.termLength, 0);
  assert.equal(s.closed, false);
});
