import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDevice, createWorld, getIos } from '../../src/engine/world.ts';
import { execLine, helpFor, inspectLine, startSession } from '../../src/engine/cli/framework.ts';
import { installCli } from '../../src/engine/cli/index.ts';
import type { World } from '../../src/engine/types.ts';

installCli();

function lab(opts: { serial?: boolean; via?: 'console' | 'file' } = {}) {
  const w: World = createWorld();
  addDevice(w, { id: 'r1', model: 'isr4331', label: 'R1', x: 0, y: 0, serialModule: opts.serial !== false });
  addDevice(w, { id: 'r2', model: 'isr4331', label: 'R2', x: 0, y: 0 });
  addDevice(w, { id: 'sw1', model: 'c9300l', label: 'SW1', x: 0, y: 0 });
  for (const id of ['r1', 'r2', 'sw1']) getIos(w, id).runtime.setupDialogDone = true;
  const open = (id: string, via: 'console' | 'file' = opts.via ?? 'console') => {
    const { session } = startSession(w, id, via);
    const run = (l: string) => execLine(w, session, l);
    if (via !== 'file') run('enable');
    run('configure terminal');
    return { s: session, run };
  };
  const r1 = open('r1');
  return { w, ...r1, open, ifc: (n: string, id = 'r1') => getIos(w, id).config.interfaces[n] };
}
const caret = (prompt: string, typedBefore: string) => ' '.repeat(prompt.length + typedBefore.length) + '^';

test('interface navigation: abbreviations, two-token names, mutates false', () => {
  const { w, s, run } = lab();
  let o = run('int g0/0/0');
  assert.equal(o.prompt, 'Router(config-if)#'); assert.equal(o.status, 'ok'); assert.equal(o.mutated, false); assert.equal(o.feature, 'interface');
  assert.deepEqual(s.ctx, { ifNames: ['GigabitEthernet0/0/0'] });
  run('interface gigabitEthernet 0/0/1');
  assert.deepEqual(s.ctx.ifNames, ['GigabitEthernet0/0/1']);
  run('int Se0/1/1');
  assert.deepEqual(s.ctx.ifNames, ['Serial0/1/1']);
  run('interface serial 0/1/0');
  assert.deepEqual(s.ctx.ifNames, ['Serial0/1/0']);
  run('exit');
  assert.equal(inspectLine(w, s, 'interface g0/0/2').mutates, false);
});

test('interface: ports that do not exist are rejected with the caret under the wrong part', () => {
  const { run } = lab({ serial: false });
  let o = run('interface g0/0/3');
  assert.equal(o.status, 'rejected');
  assert.equal(o.output, caret('Router(config)#', 'interface g0/0/') + "\n% Invalid input detected at '^' marker.\n");
  o = run('int g9/0/0');
  assert.equal(o.output.split('\n')[0], caret('Router(config)#', 'int g'));
  o = run('int fa0/0');
  assert.equal(o.output.split('\n')[0], caret('Router(config)#', 'int '));
  assert.match(o.notes[0], /no FastEthernet ports/);
  o = run('int s0/1/0');   // no serial NIM in this router
  assert.equal(o.output.split('\n')[0], caret('Router(config)#', 'int '));
  o = run('interface vlan 1');
  assert.equal(o.status, 'rejected'); assert.match(o.notes[0], /no VLAN interfaces/);
  o = run('interface loopback');
  assert.equal(o.output, '% Incomplete command.\n'); assert.equal(o.status, 'incomplete');
  o = run('interface g0/0/0.10');
  assert.equal(o.status, 'rejected'); assert.match(o.notes[0], /Subinterfaces/);
  o = run('interface foo');
  assert.equal(o.status, 'invalid');
  assert.equal(o.output.split('\n')[0], caret('Router(config)#', 'interface '));
  assert.equal(run('interface range').output, '% Incomplete command.\n');
  // the type typed as its own word goes through the same checks
  assert.equal(run('interface gigabitEthernet 0/0/7').output.split('\n')[0], caret('Router(config)#', 'interface gigabitEthernet 0/0/'));
  assert.equal(run('interface serial x').status, 'rejected');
});

test('loopbacks are created on demand and can be deleted', () => {
  const { run, ifc, w } = lab();
  assert.equal(run('interface loopback 0').prompt, 'Router(config-if)#');
  assert.deepEqual(ifc('Loopback0'), { name: 'Loopback0', shutdown: false });
  run('int lo100');
  assert.ok(ifc('Loopback100'));
  run('exit');
  run('no interface loopback 100');
  assert.equal(ifc('Loopback100'), undefined);
  assert.equal(run('no interface loopback 100').status, 'ok');
  const o = run('no interface g0/0/0');
  assert.equal(o.status, 'rejected'); assert.match(o.notes[0], /physical port cannot be deleted/);
  assert.ok(getIos(w, 'r1').config.interfaces['GigabitEthernet0/0/0']);
});

test('interface range: forms, prompt, applies to all, errors', () => {
  const { run, s, ifc, open } = lab();
  let o = run('interface range g0/0/0 - 2');
  assert.equal(o.prompt, 'Router(config-if-range)#');
  assert.deepEqual(s.ctx, { ifNames: ['GigabitEthernet0/0/0', 'GigabitEthernet0/0/1', 'GigabitEthernet0/0/2'], range: true });
  run('no shutdown');
  assert.equal(ifc('GigabitEthernet0/0/1').shutdown, false);
  run('exit');
  run('interface range gi0/0/0-1');
  assert.equal((s.ctx.ifNames as string[]).length, 2);
  run('interface range g0/0/0 , s0/1/0');
  assert.deepEqual(s.ctx.ifNames, ['GigabitEthernet0/0/0', 'Serial0/1/0']);
  run('exit');
  o = run('interface range g0/0/0 - 5');
  assert.equal(o.status, 'rejected');
  assert.equal(o.output.split('\n')[0], caret('Router(config)#', 'interface range g0/0/0 - '));
  o = run('interface range g0/0/0 - 1 , g0/0/7');
  assert.equal(o.output.split('\n')[0], caret('Router(config)#', 'interface range g0/0/0 - 1 , g0/0/'));
  assert.equal(run('interface range').output, '% Incomplete command.\n');
  const sw = open('sw1');
  o = sw.run('interface range g1/0/1 - 24');
  assert.equal(o.prompt, 'Switch(config-if-range)#');
  assert.equal((sw.s.ctx.ifNames as string[]).length, 24);
});

test('ip address: valid, masks, network/broadcast, host checks, /32 only on loopbacks', () => {
  const { run, ifc } = lab();
  run('int g0/0/0');
  let o = run('ip add 192.168.100.1 255.255.255.0');
  assert.equal(o.status, 'ok'); assert.equal(o.mutated, true); assert.equal(o.feature, 'interface');
  assert.deepEqual(ifc('GigabitEthernet0/0/0').ip, { address: '192.168.100.1', mask: '255.255.255.0' });
  run('int s0/1/0');
  assert.equal(run('ip address 60.50.30.0 255.255.255.252').output, 'Bad mask /30 for address 60.50.30.0\n');
  assert.equal(run('ip address 60.50.30.3 255.255.255.252').output, 'Bad mask /30 for address 60.50.30.3\n');
  assert.equal(run('ip address 60.50.30.1 255.0.255.0').output, 'Bad mask 0xFF00FF00 for address 60.50.30.1\n');
  assert.equal(run('ip address 127.0.0.1 255.0.0.0').output, 'Not a valid host address - 127.0.0.1\n');
  assert.equal(run('ip address 224.0.0.5 255.255.255.0').output, 'Not a valid host address - 224.0.0.5\n');
  assert.equal(run('ip address 60.50.30.1 255.255.255.255').output, 'Bad mask /32 for address 60.50.30.1\n');
  assert.equal(run('ip address 60.50.30.1 255.255.255.252').status, 'ok');
  assert.equal(run('ip address 60.50.30.1').status, 'incomplete');
  run('int lo0');
  assert.equal(run('ip address 1.1.1.1 255.255.255.255').status, 'ok');
  run('int g0/0/2');
  o = run('ip address 10.0.0.0 255.255.255.254');
  assert.equal(o.status, 'ok');
  assert.equal(o.output, '% Warning: use /31 mask on non point-to-point interface cautiously\n');
});

test('ip address: overlap with another interface is refused', () => {
  const { run, ifc } = lab();
  run('int g0/0/1'); run('ip address 10.0.0.1 255.255.255.0');
  run('int g0/0/0');
  let o = run('ip address 10.0.0.5 255.255.0.0');
  assert.equal(o.output, '% 10.0.0.0 overlaps with GigabitEthernet0/0/1\n'); assert.equal(o.status, 'rejected');
  o = run('ip address 10.0.0.200 255.255.255.128');
  assert.equal(o.output, '% 10.0.0.128 overlaps with GigabitEthernet0/0/1\n');
  assert.equal(ifc('GigabitEthernet0/0/0').ip, undefined);
  // re-entering the same address on the same interface is fine
  run('int g0/0/1');
  assert.equal(run('ip address 10.0.0.1 255.255.255.0').status, 'ok');
  // range: the second interface fails, the first one keeps the address
  run('interface range g0/0/0 , g0/0/2');
  o = run('ip address 172.16.0.1 255.255.0.0');
  assert.equal(o.status, 'ok');
  assert.equal(o.output, '% 172.16.0.0 overlaps with GigabitEthernet0/0/0\n');
  assert.deepEqual(ifc('GigabitEthernet0/0/0').ip, { address: '172.16.0.1', mask: '255.255.0.0' });
  assert.equal(ifc('GigabitEthernet0/0/2').ip, undefined);
});

test('secondary addresses and the no ip address forms', () => {
  const { run, ifc } = lab();
  run('int g0/0/0');
  run('ip address 10.1.1.1 255.255.255.0');
  run('ip address 10.2.2.1 255.255.255.0 secondary');
  assert.deepEqual(ifc('GigabitEthernet0/0/0').secondary, [{ address: '10.2.2.1', mask: '255.255.255.0' }]);
  assert.equal(run('no ip address 10.1.1.1 255.255.255.0').output, 'Must delete secondary before deleting primary\n');
  run('no ip address 10.2.2.1 255.255.255.0 secondary');
  assert.equal(ifc('GigabitEthernet0/0/0').secondary, undefined);
  run('no ip address 10.1.1.1 255.255.255.0');
  assert.equal(ifc('GigabitEthernet0/0/0').ip, undefined);
  run('ip address 10.1.1.1 255.255.255.0'); run('ip address 10.3.3.1 255.255.255.0 secondary');
  run('no ip address');
  assert.equal(ifc('GigabitEthernet0/0/0').ip, undefined); assert.equal(ifc('GigabitEthernet0/0/0').secondary, undefined);
});

test('shutdown, description, bandwidth (+ no forms and abbreviations)', () => {
  const { run, ifc } = lab();
  run('int g0/0/0');
  assert.equal(ifc('GigabitEthernet0/0/0').shutdown, true);
  run('no sh');
  assert.equal(ifc('GigabitEthernet0/0/0').shutdown, false);
  run('shut');
  assert.equal(ifc('GigabitEthernet0/0/0').shutdown, true);
  run('description Link to SW1 port 24');
  assert.equal(ifc('GigabitEthernet0/0/0').description, 'Link to SW1 port 24');
  run('no desc');
  assert.equal(ifc('GigabitEthernet0/0/0').description, undefined);
  run('int s0/1/0');
  run('bandwidth 128');
  assert.equal(ifc('Serial0/1/0').bandwidthKbps, 128);
  assert.equal(run('bandwidth 0').status, 'invalid');
  run('no bandwidth');
  assert.equal(ifc('Serial0/1/0').bandwidthKbps, undefined);
});

test('clock rate: DCE end only, rounding, not on Ethernet, file sessions without a cable', () => {
  const { w, run, ifc, open } = lab();
  run('int s0/1/0');
  let o = run('clock rate 128000');
  assert.equal(o.output, '%Error: This command applies only to DCE interfaces\n'); assert.equal(o.status, 'rejected');
  assert.match(o.notes[0], /No serial cable/);
  w.cables.push({ id: 'c1', kind: 'serial', a: { deviceId: 'r1', port: 'Serial0/1/0' }, b: { deviceId: 'r2', port: 'Serial0/1/0' }, dceEnd: 'a' });
  o = run('clock rate 128000');
  assert.equal(o.status, 'ok'); assert.equal(ifc('Serial0/1/0').clockRate, 128000);
  assert.match(o.notes.join(' '), /not listed for the NIM-2T/);
  o = run('clock rate 130000');
  assert.equal(o.output, '%Clockrate rounded to nearest value that your hardware can support.\n');
  assert.equal(ifc('Serial0/1/0').clockRate, 125000);
  for (const rate of [1200, 115200, 256000, 512000, 5300000, 8000000]) {
    const result = run(`clock rate ${rate}`);
    assert.equal(result.status, 'ok');
    assert.doesNotMatch(result.output, /rounded/);
    assert.equal(ifc('Serial0/1/0').clockRate, rate);
  }
  assert.equal(run('clock rate 1199').status, 'invalid');
  assert.equal(run('clock rate 8000001').status, 'invalid');
  run('no clock rate');
  assert.equal(ifc('Serial0/1/0').clockRate, undefined);
  // the DTE end
  const r2 = open('r2');
  r2.run('int s0/1/0');
  o = r2.run('clock rate 128000');
  assert.equal(o.output, '%Error: This command applies only to DCE interfaces\n');
  assert.match(o.notes[0], /DTE/);
  // Ethernet: the command does not exist there
  run('int g0/0/0');
  o = run('clock rate 64000');
  assert.equal(o.output.split('\n')[0], caret('Router(config-if)#', ''));
  // a configuration file applied while the cable is unplugged keeps the clock rate
  const r1b = open('r1', 'file');
  r1b.run('int s0/1/1');
  assert.equal(r1b.run('clock rate 64000').status, 'ok');
  assert.equal(ifc('Serial0/1/1').clockRate, 64000);
});

test('encapsulation, duplex, speed, ip unreachables', () => {
  const { w, s, run, ifc } = lab();
  run('int s0/1/0');
  run('encapsulation ppp');
  assert.equal(ifc('Serial0/1/0').encapsulation, 'ppp');
  run('encap hdlc');
  assert.equal(ifc('Serial0/1/0').encapsulation, undefined);
  assert.equal(run('duplex full').output.split('\n')[0], caret('Router(config-if)#', ''));
  run('int g0/0/0');
  let o = run('encapsulation ppp');
  assert.equal(o.output.split('\n')[0], caret('Router(config-if)#', 'encapsulation '));
  run('duplex full'); run('speed 100');
  assert.equal(ifc('GigabitEthernet0/0/0').duplex, 'full'); assert.equal(ifc('GigabitEthernet0/0/0').speed, '100');
  run('speed auto'); run('no duplex');
  assert.equal(ifc('GigabitEthernet0/0/0').duplex, undefined); assert.equal(ifc('GigabitEthernet0/0/0').speed, undefined);
  run('int lo0');
  assert.equal(run('encapsulation ppp').output.split('\n')[0], caret('Router(config-if)#', ''));
  run('int g0/0/0');
  o = run('no ip unreachables');
  assert.equal(o.feature, 'acl');
  assert.equal(ifc('GigabitEthernet0/0/0').noIpUnreachables, true);
  run('ip unreachables');
  assert.equal(ifc('GigabitEthernet0/0/0').noIpUnreachables, undefined);
  assert.equal(inspectLine(w, s, 'no ip unreachables').feature, 'acl');
});

test('accepted-but-not-simulated interface lines go to extraLines (defaults are not stored)', () => {
  const { run, ifc } = lab();
  run('int g0/0/0');
  let o = run('no ip redirects');
  assert.match(o.notes[0], /^Accepted, but not simulated/);
  run('no ip proxy-arp'); run('mtu 1400'); run('no negotiation auto'); run('no cdp enable'); run('ip ospf cost 10');
  assert.deepEqual(ifc('GigabitEthernet0/0/0').extraLines, ['no ip redirects', 'no ip proxy-arp', 'mtu 1400', 'no negotiation auto', 'no cdp enable', 'ip ospf cost 10']);
  run('ip redirects'); run('mtu 1500'); run('negotiation auto'); run('cdp enable'); run('ip proxy-arp'); run('no ip ospf cost 10');
  assert.equal(ifc('GigabitEthernet0/0/0').extraLines, undefined);
  run('int s0/1/0');
  o = run('negotiation auto');
  assert.equal(o.status, 'rejected');
  assert.equal(run('ppp authentication chap').status, 'ok');
  assert.deepEqual(ifc('Serial0/1/0').extraLines, ['ppp authentication chap']);
});

test('default interface resets a port', () => {
  const { run, ifc } = lab();
  run('int g0/0/0'); run('ip address 10.0.0.1 255.255.255.0'); run('no shut'); run('exit');
  const o = run('default interface g0/0/0');
  assert.equal(o.output, 'Interface GigabitEthernet0/0/0 set to default configuration\n');
  assert.deepEqual(ifc('GigabitEthernet0/0/0'), { name: 'GigabitEthernet0/0/0', shutdown: true });
});

test('? help in interface mode', () => {
  const { w, s, run } = lab();
  run('int g0/0/0');
  const h = helpFor(w, s, 'ip ');
  assert.match(h, /address\s+Set the IP address of an interface/);
  assert.match(helpFor(w, s, ''), /shutdown\s+Shutdown the selected interface/);
  assert.match(helpFor(w, s, 'ip address 10.0.0.1 255.255.255.0 '), /secondary\s+Make this IP address a secondary address/);
});
