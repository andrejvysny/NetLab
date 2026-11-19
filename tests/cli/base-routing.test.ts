import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDevice, createWorld, getIos } from '../../src/engine/world.ts';
import { execLine, helpFor, inspectLine, startSession } from '../../src/engine/cli/framework.ts';
import { installCli } from '../../src/engine/cli/index.ts';
import type { World } from '../../src/engine/types.ts';

installCli();

function lab() {
  const w: World = createWorld();
  addDevice(w, { id: 'r1', model: 'isr4331', label: 'R1', x: 0, y: 0 });
  getIos(w, 'r1').runtime.setupDialogDone = true;
  const { session } = startSession(w, 'r1', 'console');
  const run = (l: string) => execLine(w, session, l);
  run('enable'); run('conf t');
  run('int s0/1/0'); run('ip address 60.50.30.1 255.255.255.252');
  run('int g0/0/0'); run('ip address 192.168.100.1 255.255.255.0');
  run('exit');
  return { w, s: session, run, cfg: () => getIos(w, 'r1').config };
}
const caret = (prompt: string, before: string) => ' '.repeat(prompt.length + before.length) + '^';

test('ip routing / no ip routing', () => {
  const { run, cfg } = lab();
  assert.equal(cfg().ipRouting, true);
  const o = run('no ip routing');
  assert.equal(o.feature, 'routing'); assert.equal(cfg().ipRouting, false);
  run('ip routing');
  assert.equal(cfg().ipRouting, true);
});

test('ip route: next hop, exit interface, both, distance, replacement', () => {
  const { run, cfg } = lab();
  let o = run('ip route 0.0.0.0 0.0.0.0 s0/1/0 60.50.30.2');
  assert.equal(o.status, 'ok'); assert.equal(o.mutated, true); assert.equal(o.output, '');
  assert.deepEqual(cfg().staticRoutes, [{ prefix: '0.0.0.0', mask: '0.0.0.0', exitInterface: 'Serial0/1/0', nextHop: '60.50.30.2' }]);
  run('ip route 10.0.0.0 255.0.0.0 60.50.30.2');
  run('ip route 10.0.0.0 255.0.0.0 60.50.30.2 200');
  run('ip route 172.16.0.0 255.255.0.0 serial 0/1/0');
  assert.deepEqual(cfg().staticRoutes.slice(1), [
    { prefix: '10.0.0.0', mask: '255.0.0.0', nextHop: '60.50.30.2', distance: 200 },
    { prefix: '172.16.0.0', mask: '255.255.0.0', exitInterface: 'Serial0/1/0' },
  ]);
  o = run('ip route 0.0.0.0 0.0.0.0 g0/0/0');
  assert.equal(o.output, '%Default route without gateway, if not a point-to-point interface, may impact performance\n');
  assert.equal(run('ip route 0.0.0.0 0.0.0.0 Serial0/1/0 60.50.30.2 60').status, 'ok');
  assert.equal(cfg().staticRoutes[0].distance, 60);
});

test('ip route: IOS validation messages', () => {
  const { run, cfg } = lab();
  let o = run('ip route 10.0.0.1 255.255.255.0 60.50.30.2');
  assert.equal(o.output, '%Inconsistent address and mask\n'); assert.equal(o.status, 'rejected');
  assert.equal(run('ip route 10.0.0.0 255.0.255.0 60.50.30.2').output, '%Inconsistent address and mask\n');
  o = run('ip route 0.0.0.0 0.0.0.0 60.50.30.1');
  assert.equal(o.output, "%Invalid next hop address (it's this router)\n");
  o = run('ip route 0.0.0.0 0.0.0.0 s0/1/5 60.50.30.2');
  assert.equal(o.output.split('\n')[0], caret('Router(config)#', 'ip route 0.0.0.0 0.0.0.0 s0/1/'));
  assert.equal(run('ip route 0.0.0.0 0.0.0.0').status, 'incomplete');
  assert.equal(run('ip route 0.0.0.0 0.0.0.0 60.50.30.2 256').status, 'invalid');
  assert.equal(cfg().staticRoutes.length, 0);
});

test('no ip route: exact and prefix-only forms', () => {
  const { run, cfg } = lab();
  run('ip route 0.0.0.0 0.0.0.0 s0/1/0 60.50.30.2');
  run('ip route 10.0.0.0 255.0.0.0 60.50.30.2');
  run('ip route 10.0.0.0 255.0.0.0 Serial0/1/0');
  assert.equal(run('no ip route 10.0.0.0 255.0.0.0 60.50.30.9').output, '%No matching route to delete\n');
  run('no ip route 10.0.0.0 255.0.0.0 60.50.30.2');
  assert.equal(cfg().staticRoutes.length, 2);
  run('no ip route 10.0.0.0 255.0.0.0');
  assert.equal(cfg().staticRoutes.length, 1);
  run('no ip route 0.0.0.0 0.0.0.0 s0/1/0 60.50.30.2');
  assert.equal(cfg().staticRoutes.length, 0);
  assert.equal(run('no ip route 0.0.0.0 0.0.0.0').output, '%No matching route to delete\n');
});

test('router rip: version, network (classful), auto-summary, passive, default route', () => {
  const { s, w, run, cfg } = lab();
  let o = run('router rip');
  assert.equal(o.prompt, 'Router(config-router)#'); assert.equal(o.mutated, false);
  assert.deepEqual(s.ctx, { protocol: 'rip' });
  run('version 2');
  run('network 192.168.100.0');
  run('network 60.50.30.0');
  run('no auto-summary');
  run('passive-interface g0/0/0');
  run('default-information originate');
  assert.deepEqual(cfg().rip, { networks: ['192.168.100.0', '60.0.0.0'], autoSummary: false, passive: ['GigabitEthernet0/0/0'], version: 2, defaultOriginate: true });
  run('no network 60.50.30.0'); run('no passive-interface g0/0/0'); run('no default-information originate'); run('no version'); run('auto-summary');
  assert.deepEqual(cfg().rip, { networks: ['192.168.100.0'], autoSummary: true, passive: [] });
  // OSPF syntax inside RIP: caret under the wildcard
  o = run('network 10.0.0.0 0.0.0.255 area 0');
  assert.equal(o.output.split('\n')[0], caret('Router(config-router)#', 'network 10.0.0.0 '));
  assert.equal(run('router-id 1.1.1.1').status, 'rejected');
  assert.equal(run('passive-interface g0/0/9').status, 'rejected');
  assert.equal(inspectLine(w, s, 'network 10.0.0.0').feature, 'routing');
  run('exit');
  run('no router rip');
  assert.equal(cfg().rip, undefined);
});

test('router ospf: network/wildcard/area, router-id, passive, default-information, no router ospf', () => {
  const { s, run, cfg } = lab();
  run('router ospf 1');
  assert.deepEqual(s.ctx, { protocol: 'ospf', pid: 1 });
  run('router-id 1.1.1.1');
  run('network 192.168.100.0 0.0.0.255 area 0');
  run('network 60.50.30.0 0.0.0.3 area 0.0.0.0');
  run('passive-interface gigabitEthernet 0/0/0');
  run('default-information originate always');
  assert.deepEqual(cfg().ospf, [{
    processId: 1, routerId: '1.1.1.1', passive: ['GigabitEthernet0/0/0'], defaultOriginate: true,
    networks: [{ address: '192.168.100.0', wildcard: '0.0.0.255', area: '0' }, { address: '60.50.30.0', wildcard: '0.0.0.3', area: '0.0.0.0' }],
  }]);
  const o = run('network 10.0.0.0 255.255.255.0 area 0');
  assert.match(o.notes[0], /wildcard/);
  assert.equal(run('network 10.0.0.0').output, '% Incomplete command.\n');
  assert.equal(run('network 10.0.0.0 0.0.0.255 area x').status, 'rejected');
  assert.equal(run('version 2').status, 'rejected');
  assert.equal(run('no auto-summary').status, 'rejected');
  run('no network 10.0.0.0 255.255.255.0 area 0');
  run('no router-id');
  assert.equal(cfg().ospf[0].networks.length, 2); assert.equal(cfg().ospf[0].routerId, undefined);
  run('router ospf 2'); run('exit');
  assert.equal(cfg().ospf.length, 2);
  run('no router ospf 1');
  assert.deepEqual(cfg().ospf.map((p) => p.processId), [2]);
  assert.equal(run('router ospf 0').status, 'invalid');
});

test('ip default-network is accepted (not simulated); help texts', () => {
  const { w, s, run, cfg } = lab();
  const o = run('ip default-network 10.0.0.0');
  assert.match(o.notes[0], /not simulated/);
  assert.deepEqual(cfg().extraLines, ['ip default-network 10.0.0.0']);
  assert.match(helpFor(w, s, 'ip '), /route\s+Establish static routes/);
  assert.match(helpFor(w, s, 'router '), /ospf\s+Open Shortest Path First \(OSPF\)/);
});
