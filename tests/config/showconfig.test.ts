import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { World } from '../../src/engine/types.ts';
import { addDevice, createWorld, getIos } from '../../src/engine/world.ts';
import { execLine, inspectLine, installCli, startSession } from '../../src/engine/cli/index.ts';
import { renderRunningConfig } from '../../src/engine/config/render.ts';
import { saveStartupConfig } from '../../src/engine/config/apply.ts';
import { startupConfigView } from '../../src/engine/cli/commands/showconfig.ts';
import { r1Config } from './reference.ts';

installCli();

function lab(model: 'isr4331' | 'c9300l' = 'isr4331') {
  const w: World = createWorld();
  addDevice(w, { id: 'd', model, label: 'D', x: 0, y: 0 });
  if (model === 'isr4331') getIos(w, 'd').config = r1Config();
  const { session } = startSession(w, 'd', 'file'); // privileged EXEC, no login hooks
  return { w, s: session, run: (l: string) => execLine(w, session, l) };
}

test('show running-config prints the rendered configuration (privileged EXEC, feature verify)', () => {
  const { w, s, run } = lab();
  const o = run('show running-config');
  assert.equal(o.status, 'ok');
  assert.equal(o.output, renderRunningConfig(w, 'd') + '\n');
  assert.equal(o.feature, 'verify');
  assert.equal(o.mutated, false);
  assert.equal(run('sh run').output, o.output);
  assert.deepEqual(inspectLine(w, s, 'show running-config'), { status: 'ok', feature: 'verify', mutates: false });
  s.mode = 'user';
  assert.notEqual(run('show running-config').status, 'ok');
});

test('output modifiers work on show running-config', () => {
  const { run } = lab();
  assert.equal(run('show running-config | include hostname').output, 'hostname R1\n');
  assert.equal(run('show run | section ^interface Serial0/1/0').output,
    'interface Serial0/1/0\n bandwidth 128\n ip address 60.50.30.1 255.255.255.252\n ip nat outside\n clock rate 128000\n crypto map CM\n service-policy output output_SE\n');
  // like IOS, the section filter is a regex over every line: the NAT rule naming Serial0/1/0 matches too
  assert.match(run('show run | section Serial0/1/0').output, /\nip nat inside source list 1 interface Serial0\/1\/0 overload\n/);
  assert.match(run('show run | begin line vty').output, /^line vty 0 4\n access-class allowPC1 in\n/);
});

test('show running-config interface <if>', () => {
  const { run } = lab();
  const body = '!\ninterface GigabitEthernet0/0/0\n ip address 192.168.100.1 255.255.255.0\n ip access-group 110 in\n ip nat inside\n negotiation auto\nend\n';
  const o = run('show running-config interface g0/0/0');
  assert.equal(o.output, `Building configuration...\n\nCurrent configuration : ${Buffer.byteLength(body)} bytes\n${body}\n`);
  assert.equal(run('show run int Lo0100').output, run('show run int Loopback100').output);
  assert.equal(run('show run int Loopback100').output.split('\n').slice(3).join('\n'), '!\ninterface Loopback100\n ip address 60.50.50.100 255.255.255.255\nend\n\n');
  const bad = run('show running-config interface Loopback7');
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.output, `${' '.repeat('R1#show running-config interface '.length)}^\n% Invalid input detected at '^' marker.\n`);
});

test('show startup-config: not present, then the saved file with the NVRAM line', () => {
  const { w, run } = lab();
  assert.equal(run('show startup-config').output, 'startup-config is not present\n');
  saveStartupConfig(w, 'd');
  const out = run('show startup-config').output;
  const running = renderRunningConfig(w, 'd');
  const body = running.split('\n').slice(3).join('\n');
  assert.equal(out, `Using ${Buffer.byteLength(body)} out of 33554432 bytes\n${body}\n`);
  assert.match(out, /^Using \d+ out of 33554432 bytes\n!\nversion 17\.3\n/);
  assert.doesNotMatch(out, /Building configuration/);
  assert.match(run('show startup-config | include ^hostname').output, /^hostname R1\n$/);
});

test('switch NVRAM size and hand-written startup files', () => {
  const { w, run } = lab('c9300l');
  getIos(w, 'd').startupConfig = 'hostname SW1\nend\n';
  assert.equal(run('show startup-config').output, 'Using 17 out of 2097152 bytes\nhostname SW1\nend\n\n');
  assert.equal(startupConfigView('Building configuration...\n\nCurrent configuration : 9 bytes\n!\nend\n', 'isr4331'), 'Using 6 out of 33554432 bytes\n!\nend\n');
});

test('section keeps the children of an indented heading', () => {
  const { run } = lab();
  assert.equal(run('show run | section ^ class classPriority$').output, ' class classPriority\n  priority 16\n');
});
