import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDevice, createWorld, getIos } from '../../src/engine/world.ts';
import { execLine, helpFor, inspectLine, startSession } from '../../src/engine/cli/framework.ts';
import { installCli } from '../../src/engine/cli/index.ts';
import type { World } from '../../src/engine/types.ts';

installCli();

function lab(id = 'r1', model: 'isr4331' | 'c9300l' = 'isr4331') {
  const w: World = createWorld();
  addDevice(w, { id, model, label: id, x: 0, y: 0 });
  getIos(w, id).runtime.setupDialogDone = true;
  const { session } = startSession(w, id, 'console');
  const run = (l: string) => execLine(w, session, l);
  run('enable'); run('conf t');
  return { w, s: session, run, cfg: () => getIos(w, id).config };
}

test('ip dhcp excluded-address: single, range, wrong order, no form', () => {
  const { run, cfg } = lab();
  let o = run('ip dhcp excluded-address 192.168.100.1 192.168.100.100');
  assert.equal(o.status, 'ok'); assert.equal(o.feature, 'dhcp'); assert.equal(o.mutated, true);
  run('ip dhcp excluded-address 192.168.100.200');
  run('ip dhcp excluded-address 192.168.100.200');
  assert.deepEqual(cfg().dhcp.excluded, [{ low: '192.168.100.1', high: '192.168.100.100' }, { low: '192.168.100.200', high: '192.168.100.200' }]);
  o = run('ip dhcp excluded-address 10.0.0.10 10.0.0.1');
  assert.equal(o.status, 'rejected');
  assert.equal(o.output.split('\n')[0], ' '.repeat('Router(config)#ip dhcp excluded-address 10.0.0.10 '.length) + '^');
  run('no ip dhcp excluded-address 192.168.100.200');
  assert.equal(cfg().dhcp.excluded.length, 1);
});

test('ip dhcp pool: mode, network forms, default-router, dns-server, domain-name, lease', () => {
  const { w, s, run, cfg } = lab();
  let o = run('ip dhcp pool LAN1');
  assert.equal(o.prompt, 'Router(dhcp-config)#'); assert.equal(o.mutated, false);
  assert.deepEqual(s.ctx, { pool: 'LAN1' });
  assert.deepEqual(cfg().dhcp.pools, [{ name: 'LAN1', defaultRouters: [], dnsServers: [] }]);
  run('network 192.168.100.0 255.255.255.0');
  run('default-router 192.168.100.1');
  run('dns-server 8.8.8.8 1.1.1.1');
  run('domain-name kss.local');
  run('lease 0 8');
  assert.deepEqual(cfg().dhcp.pools[0], {
    name: 'LAN1', network: { address: '192.168.100.0', mask: '255.255.255.0' }, defaultRouters: ['192.168.100.1'],
    dnsServers: ['8.8.8.8', '1.1.1.1'], domainName: 'kss.local', lease: '0 8',
  });
  run('lease infinite'); assert.equal(cfg().dhcp.pools[0].lease, 'infinite');
  run('lease 1'); assert.equal(cfg().dhcp.pools[0].lease, undefined);
  assert.equal(run('lease 0 24').status, 'invalid');
  run('network 60.50.40.0 /26');
  assert.deepEqual(cfg().dhcp.pools[0].network, { address: '60.50.40.0', mask: '255.255.255.192' });
  run('network 10.1.2.3');
  assert.deepEqual(cfg().dhcp.pools[0].network, { address: '10.0.0.0', mask: '255.0.0.0' });
  o = run('network 192.168.100.5 255.255.255.0');
  assert.deepEqual(cfg().dhcp.pools[0].network, { address: '192.168.100.0', mask: '255.255.255.0' });
  assert.match(o.notes[0], /192\.168\.100\.0/);
  assert.equal(run('network 192.168.100.0 255.0.255.0').status, 'rejected');
  assert.equal(run('network 192.168.100.0 /33').status, 'rejected');
  run('default-router 10.0.0.1 10.0.0.2 10.0.0.3 10.0.0.4 10.0.0.5 10.0.0.6 10.0.0.7 10.0.0.8');
  assert.equal(cfg().dhcp.pools[0].defaultRouters.length, 8);
  assert.equal(run('default-router 10.0.0.1 10.0.0.2 10.0.0.3 10.0.0.4 10.0.0.5 10.0.0.6 10.0.0.7 10.0.0.8 10.0.0.9').status, 'invalid');
  run('no default-router'); run('no dns-server'); run('no domain-name'); run('no lease'); run('no network');
  assert.deepEqual(cfg().dhcp.pools[0], { name: 'LAN1', defaultRouters: [], dnsServers: [] });
  assert.equal(inspectLine(w, s, 'default-router 1.1.1.1').feature, 'dhcp');
  assert.match(helpFor(w, s, ''), /default-router\s+Default routers/);
});

test('a second pool with the same network gets a note; no ip dhcp pool removes pool and its bindings', () => {
  const { w, run, cfg } = lab();
  run('ip dhcp pool A'); run('network 10.0.0.0 255.255.255.0');
  run('ip dhcp pool B');
  const o = run('network 10.0.0.0 255.255.255.0');
  assert.match(o.notes[0], /Pool A already serves/);
  getIos(w, 'r1').runtime.dhcpBindings.push({ address: '10.0.0.2', clientId: 'x', pool: 'A', grantedTick: 1 });
  run('exit');
  run('no ip dhcp pool A');
  assert.deepEqual(cfg().dhcp.pools.map((p) => p.name), ['B']);
  assert.equal(getIos(w, 'r1').runtime.dhcpBindings.length, 0);
});

test('service dhcp and other accepted DHCP globals', () => {
  const { run, cfg } = lab();
  run('no service dhcp');
  assert.deepEqual(cfg().extraLines, ['no service dhcp']);
  run('service dhcp');
  assert.deepEqual(cfg().extraLines, []);
  const o = run('ip dhcp ping packets 0');
  assert.match(o.notes[0], /not simulated/);
  assert.deepEqual(cfg().extraLines, ['ip dhcp ping packets 0']);
  run('ip dhcp pool P'); run('option 150 ip 10.0.0.5');
  assert.deepEqual(cfg().dhcp.pools[0].extraLines, ['option 150 ip 10.0.0.5']);
});

test('ip helper-address on interfaces (feature dhcp), not on layer-2 switch ports', () => {
  const { w, s, run, cfg } = lab();
  run('int g0/0/0');
  let o = run('ip helper-address 60.50.30.1');
  assert.equal(o.feature, 'dhcp'); assert.equal(o.status, 'ok');
  run('ip helper-address 10.0.0.9'); run('ip helper-address 10.0.0.9');
  assert.deepEqual(cfg().interfaces['GigabitEthernet0/0/0'].helperAddresses, ['60.50.30.1', '10.0.0.9']);
  run('no ip helper-address 10.0.0.9');
  assert.deepEqual(cfg().interfaces['GigabitEthernet0/0/0'].helperAddresses, ['60.50.30.1']);
  run('no ip helper-address');
  assert.equal(cfg().interfaces['GigabitEthernet0/0/0'].helperAddresses, undefined);
  assert.equal(inspectLine(w, s, 'ip helper-address 1.1.1.1').feature, 'dhcp');
  const sw = lab('sw1', 'c9300l');
  sw.run('int g1/0/1');
  o = sw.run('ip helper-address 10.0.0.1');
  assert.equal(o.status, 'rejected');
  assert.equal(o.output.split('\n')[0], ' '.repeat('Switch(config-if)#ip '.length) + '^');
  sw.run('int vlan 1');
  assert.equal(sw.run('ip helper-address 10.0.0.1').status, 'ok');
});
