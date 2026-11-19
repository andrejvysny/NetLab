import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, addDevice } from '../../src/engine/world.ts';
import { registerCommands, startSession, execLine, helpFor, completeLine, inspectLine, interrupt, currentInterfaces } from '../../src/engine/cli/framework.ts';
import type { CommandDef } from '../../src/engine/cli/framework.ts';

const defs: CommandDef[] = [
  { modes: 'user', pattern: 'enable', feature: 'system', run: (e) => e.setMode('priv') },
  { modes: 'priv', pattern: 'configure terminal', feature: 'system', run: (e) => e.setMode('config') },
  { modes: 'priv', pattern: 'copy running-config startup-config', feature: 'system', run: (e) => e.print('[OK]') },
  { modes: 'priv', pattern: 'clear counters', feature: 'system', run: () => {} },
  { modes: 'priv', pattern: 'show ip interface brief', feature: 'verify', run: (e) => e.print('Interface  IP-Address') },
  { modes: 'config', pattern: 'hostname <name:word>', feature: 'system', help: { hostname: 'Set system network name' }, run: (e, a) => { e.device.config.hostname = a.name; } },
  { modes: 'config', pattern: 'interface <ifname:if>', feature: 'interface', mutates: false, run: (e, a) => {
      if (!e.device.config.interfaces[a.ifname]) e.reject('% Invalid interface');
      e.setMode('config-if', { ifNames: [a.ifname] });
  } },
  { modes: 'config-if', pattern: 'ip address <addr:ip> <mask:mask> [secondary]', feature: 'interface', run: (e, a) => {
      for (const i of currentInterfaces(e)) i.ip = { address: a.addr, mask: a.mask };
      if (e.has('secondary')) e.print('secondary!');
  } },
  { modes: 'config-if', pattern: ['shutdown', 'no shutdown'], feature: 'interface', run: (e) => { for (const i of currentInterfaces(e)) i.shutdown = !e.has('no'); } },
  { modes: 'config-if', pattern: 'ip access-group <acl:word> {dir:in|out}', feature: 'acl', run: (e, a) => { for (const i of currentInterfaces(e)) { if (a.dir === 'in') i.aclIn = a.acl; else i.aclOut = a.acl; } } },
  { modes: 'config', pattern: 'access-list <n:int(1-99)> {action:permit|deny} <rest:text>', feature: 'acl', run: (e, a) => e.print(`std ${a.n} ${a.action} ${a.rest}`) },
  { modes: 'config', pattern: 'access-list <n:int(100-199)> {action:permit|deny} <rest:text>', feature: 'acl', run: (e, a) => e.print(`ext ${a.n} ${a.action} ${a.rest}`) },
];
registerCommands(defs);

function lab() {
  const w = createWorld(); addDevice(w, { id: 'r1', model: 'isr4331', label: 'R1', x: 0, y: 0 });
  const { session, outcome } = startSession(w, 'r1', 'console');
  return { w, s: session, outcome, run: (l: string) => execLine(w, session, l) };
}

test('modes, abbreviations, prompts', () => {
  const { w, s, outcome, run } = lab();
  assert.equal(outcome.prompt, 'Router>');
  assert.equal(run('en').prompt, 'Router#');
  assert.equal(run('conf t').prompt, 'Router(config)#');
  assert.equal(run('host R1').prompt, 'R1(config)#');
  assert.equal(run('int g0/0/0').prompt, 'R1(config-if)#');
  const o = run('ip add 10.0.0.1 255.255.255.0');
  assert.equal(o.status, 'ok'); assert.equal(o.mutated, true); assert.equal(o.feature, 'interface');
  assert.deepEqual(w.devices.r1.kind === 'router' && w.devices.r1.config.interfaces['GigabitEthernet0/0/0'].ip, { address: '10.0.0.1', mask: '255.255.255.0' });
  run('no sh');
  assert.equal(w.devices.r1.kind === 'router' && w.devices.r1.config.interfaces['GigabitEthernet0/0/0'].shutdown, false);
  assert.equal(run('interface serial 0/1/0').prompt, 'R1(config-if)#');
  assert.deepEqual(s.ctx.ifNames, ['Serial0/1/0']);
  assert.equal(run('ip access-group 110 in').status, 'ok');
  // global command from a sub-mode falls through
  assert.equal(run('hostname R9').prompt, 'R9(config)#');
  assert.equal(run('end').prompt, 'R9#');
});

test('errors: invalid caret, incomplete, ambiguous, dns lookup', () => {
  const { run } = lab();
  run('en');
  let o = run('co t');
  assert.equal(o.status, 'ambiguous'); assert.match(o.output, /% Ambiguous command:  "co t"/);
  o = run('conf');
  assert.equal(o.status, 'incomplete'); assert.match(o.output, /% Incomplete command\./);
  o = run('show ip rout');
  assert.equal(o.status, 'invalid');
  assert.equal(o.output.split('\n')[0], ' '.repeat('Router#'.length + 'show ip '.length) + '^');
  o = run('xyz');
  assert.match(o.output, /Translating "xyz"\.\.\.domain server/); assert.equal(o.delayMs, 6000);
  run('conf t');
  o = run('interface g9/9/9');
  assert.equal(o.status, 'rejected'); assert.equal(o.prompt, 'Router(config)#');
  o = run('access-list 10 permit 1.1.1.1');
  assert.match(o.output, /^std 10 permit 1\.1\.1\.1/);
  o = run('access-list 110 permit tcp any any eq www');
  assert.match(o.output, /^ext 110 permit tcp any any eq www/);
  o = run('access-list 250 permit ip any any');
  assert.equal(o.status, 'invalid');
  o = run('do show ip interface brief');
  assert.equal(o.status, 'ok'); assert.equal(o.prompt, 'Router(config)#'); assert.equal(o.mutated, false);
  o = run('do show ip xx');
  assert.equal(o.output.split('\n')[0], ' '.repeat('Router(config)#'.length + 'do show ip '.length) + '^');
});

test('help, completion, inspect, interrupt', () => {
  const { w, s, run } = lab();
  run('en');
  assert.match(helpFor(w, s, 'c'), /clear\s+configure\s+copy/);
  assert.match(helpFor(w, s, 'configure '), /terminal/);
  assert.match(helpFor(w, s, 'show ip interface brief '), /<cr>/);
  assert.equal(completeLine(w, s, 'conf').line, 'configure ');
  assert.deepEqual(completeLine(w, s, 'co').candidates, ['configure', 'copy']);
  run('conf t');
  assert.match(helpFor(w, s, 'hostname '), /WORD/);
  assert.match(helpFor(w, s, ''), /hostname\s+Set system network name/);
  assert.deepEqual(inspectLine(w, s, 'hostname X'), { status: 'ok', feature: 'system', mutates: true });
  assert.deepEqual(inspectLine(w, s, 'do show ip interface brief'), { status: 'ok', feature: 'verify', mutates: false });
  assert.equal(inspectLine(w, s, 'interface g0/0/1').mutates, false);
  run('int g0/0/1');
  assert.equal(inspectLine(w, s, 'ip access-group 1 out').feature, 'acl');
  assert.equal(interrupt(w, s, 'ctrl-z').prompt, 'Router#');
  assert.equal(run('exit').closed, true);
});
