import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDevice, createWorld, getIos } from '../../src/engine/world.ts';
import { execLine, inspectLine, startSession } from '../../src/engine/cli/framework.ts';
import { installCli } from '../../src/engine/cli/index.ts';
import type { World } from '../../src/engine/types.ts';

installCli();

function lab() {
  const w: World = createWorld();
  addDevice(w, { id: 'sw1', model: 'c9300l', label: 'SW1', x: 0, y: 0 });
  addDevice(w, { id: 'r1', model: 'isr4331', label: 'R1', x: 0, y: 0 });
  const open = (id: string) => {
    getIos(w, id).runtime.setupDialogDone = true;
    const { session } = startSession(w, id, 'console');
    const run = (l: string) => execLine(w, session, l);
    run('enable'); run('conf t');
    return { s: session, run };
  };
  return { w, ...open('sw1'), open, cfg: () => getIos(w, 'sw1').config };
}

test('vlan: create (default name), name, list form, reserved VLANs, no vlan', () => {
  const { w, s, run, cfg } = lab();
  let o = run('vlan 10');
  assert.equal(o.prompt, 'Switch(config-vlan)#'); assert.equal(o.mutated, false); assert.equal(o.feature, 'switching');
  assert.deepEqual(s.ctx, { vlanIds: [10] });
  assert.deepEqual(cfg().vlans['10'], { name: 'VLAN0010' });
  run('name Students');
  assert.equal(cfg().vlans['10'].name, 'Students');
  run('no name');
  assert.equal(cfg().vlans['10'].name, 'VLAN0010');
  run('exit');
  run('vlan 20,30-31');
  assert.deepEqual(s.ctx, { vlanIds: [20, 30, 31] });
  assert.ok(cfg().vlans['31']);
  run('vlan 1');
  assert.equal(run('name X').output, '%Default VLAN 1 may not have its name changed.\n');
  run('exit');
  assert.equal(run('no vlan 1').output, '%Default VLAN 1 may not be deleted.\n');
  run('no vlan 30-31');
  assert.equal(cfg().vlans['30'], undefined);
  assert.equal(run('vlan 5000').status, 'rejected');
  assert.equal(run('vlan 0').status, 'rejected');
  assert.equal(inspectLine(w, s, 'vlan 99').mutates, false);
});

test('vlan and switchport commands do not exist on a router', () => {
  const { open } = lab();
  const r = open('r1');
  assert.equal(r.run('vlan 10').status, 'invalid');
  r.run('int g0/0/0');
  assert.equal(r.run('switchport mode access').status, 'invalid');
});

test('switchport mode / access vlan (creates a missing VLAN), no forms', () => {
  const { w, s, run, cfg } = lab();
  run('int g1/0/1');
  let o = run('switchport mode access');
  assert.equal(o.feature, 'switching'); assert.equal(o.mutated, true);
  o = run('switchport access vlan 20');
  assert.equal(o.output, '% Access VLAN does not exist. Creating vlan 20\n');
  assert.deepEqual(cfg().interfaces['GigabitEthernet1/0/1'].switchport, { mode: 'access', accessVlan: 20 });
  assert.deepEqual(cfg().vlans['20'], { name: 'VLAN0020' });
  assert.equal(run('switchport access vlan 20').output, '');
  run('switchport mode trunk');
  assert.equal(cfg().interfaces['GigabitEthernet1/0/1'].switchport!.mode, 'trunk');
  run('switchport mode dynamic desirable');
  assert.equal(cfg().interfaces['GigabitEthernet1/0/1'].switchport!.mode, 'dynamic');
  run('no switchport access vlan'); run('no switchport mode');
  assert.deepEqual(cfg().interfaces['GigabitEthernet1/0/1'].switchport, { mode: 'dynamic', accessVlan: 1 });
  run('switchport trunk allowed vlan 10,20');
  run('switchport trunk allowed vlan 10,30');
  run('switchport port-security');
  assert.deepEqual(cfg().interfaces['GigabitEthernet1/0/1'].extraLines, ['switchport trunk allowed vlan 10,30', 'switchport port-security']);
  run('interface range g1/0/2 - 4');
  run('switchport access vlan 10');
  assert.ok(['GigabitEthernet1/0/2', 'GigabitEthernet1/0/3', 'GigabitEthernet1/0/4'].every((n) => cfg().interfaces[n].switchport!.accessVlan === 10));
  assert.equal(inspectLine(w, s, 'switchport mode access').feature, 'switching');
});

test('ip address on a layer-2 port is refused; no switchport makes a routed port', () => {
  const { run, cfg } = lab();
  run('int g1/0/5');
  let o = run('ip address 10.0.0.1 255.255.255.0');
  assert.equal(o.status, 'rejected');
  assert.equal(o.output.split('\n')[0], ' '.repeat('Switch(config-if)#ip '.length) + '^');
  assert.match(o.notes[0], /layer 2/);
  run('no switchport');
  assert.equal(cfg().interfaces['GigabitEthernet1/0/5'].switchport, undefined);
  assert.equal(run('ip address 10.0.0.1 255.255.255.0').status, 'ok');
  assert.equal(run('switchport mode access').status, 'rejected');
  run('switchport');
  assert.deepEqual(cfg().interfaces['GigabitEthernet1/0/5'].switchport, { mode: 'dynamic', accessVlan: 1 });
  assert.equal(cfg().interfaces['GigabitEthernet1/0/5'].ip, undefined);
});

test('interface vlan (SVI), ip default-gateway', () => {
  const { run, cfg, open } = lab();
  let o = run('interface vlan 1');
  assert.equal(o.prompt, 'Switch(config-if)#');
  run('ip address 192.168.100.2 255.255.255.0'); run('no shutdown');
  assert.deepEqual(cfg().interfaces.Vlan1, { name: 'Vlan1', shutdown: false, ip: { address: '192.168.100.2', mask: '255.255.255.0' } });
  run('int vlan 10');
  assert.deepEqual(cfg().interfaces.Vlan10, { name: 'Vlan10', shutdown: false });
  assert.equal(run('switchport').status, 'rejected');
  run('exit');
  o = run('ip default-gateway 192.168.100.1');
  assert.equal(o.feature, 'switching');
  assert.equal(cfg().defaultGateway, '192.168.100.1');
  run('no ip default-gateway');
  assert.equal(cfg().defaultGateway, undefined);
  assert.equal(run('interface vlan 4095').status, 'rejected');
  // routers accept ip default-gateway too (used only when ip routing is off)
  const r = open('r1');
  o = r.run('ip default-gateway 10.0.0.1');
  assert.equal(o.status, 'ok'); assert.match(o.notes[0], /ignores the default gateway/);
});

test('spanning-tree and vtp are accepted, not simulated', () => {
  const { run, cfg } = lab();
  let o = run('spanning-tree mode pvst');
  assert.match(o.notes[0], /not simulated/);
  run('spanning-tree mode rapid-pvst');
  run('spanning-tree vlan 1 priority 4096');
  run('vtp mode transparent');
  assert.deepEqual(cfg().extraLines, ['spanning-tree mode rapid-pvst', 'spanning-tree vlan 1 priority 4096', 'vtp mode transparent']);
  run('int g1/0/1');
  o = run('spanning-tree portfast');
  assert.equal(o.status, 'ok');
  assert.deepEqual(cfg().interfaces['GigabitEthernet1/0/1'].extraLines, ['spanning-tree portfast']);
  run('no spanning-tree portfast');
  assert.equal(cfg().interfaces['GigabitEthernet1/0/1'].extraLines, undefined);
});
