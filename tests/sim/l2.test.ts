/** Layer 2: broadcast domains through switches, VLANs, neighbour resolution, the switch management SVI. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GI, cable, ifUp, ping, smallLab, staticPc, tcp } from './fixtures.ts';
import { l2Reach, ownAddresses, resolveNeighbor, routingTable, sendFlow, traceroute } from '../../src/engine/sim/index.ts';
import { getIos, getPc } from '../../src/engine/world.ts';
import type { World } from '../../src/engine/types.ts';

const names = (w: World, d: string, i: string) => l2Reach(w, d, i).map((e) => `${e.deviceId}:${e.ifName}`).sort();
const port = (w: World, sw: string, n: number) => getIos(w, sw).config.interfaces[`GigabitEthernet1/0/${n}`];

test('all switch ports are in VLAN 1 by default: one broadcast domain, no configuration needed', () => {
  const w = smallLab();
  assert.deepEqual(names(w, 'PC1', 'Ethernet0'), ['PC2:Ethernet0', `R1:${GI}`, 'SW1:Vlan1']);
  assert.deepEqual(names(w, 'R1', GI), ['PC1:Ethernet0', 'PC2:Ethernet0', 'SW1:Vlan1']);
  assert.deepEqual(names(w, 'PC3', 'Ethernet0'), ['R1:GigabitEthernet0/0/1'], 'a direct cable has exactly one neighbour');
  const hop = l2Reach(w, 'PC1', 'Ethernet0').find((e) => e.deviceId === 'R1')!.hops;
  assert.deepEqual(hop, [{ switchId: 'SW1', inPort: 'GigabitEthernet1/0/1', outPort: 'GigabitEthernet1/0/24', vlan: 1 }]);
  const f = sendFlow(w, ping('PC1', '10.0.1.20'));
  assert.equal(f.ok, true, f.summary);
  assert.deepEqual(f.forward.steps.map((s) => s.stage), ['origin', 'switch', 'deliver']);
  assert.equal(getIos(w, 'SW1').runtime.ifCounters['GigabitEthernet1/0/1'].in, 1);
  assert.equal(getIos(w, 'SW1').runtime.ifCounters['GigabitEthernet1/0/2'].out, 1);
});

test('neighbour resolution: the next hop must own the address on an up interface of the same segment', () => {
  const w = smallLab();
  assert.equal(resolveNeighbor(w, 'PC1', 'Ethernet0', '10.0.1.1')?.deviceId, 'R1');
  assert.equal(resolveNeighbor(w, 'PC1', 'Ethernet0', '10.0.1.20')?.deviceId, 'PC2');
  assert.equal(resolveNeighbor(w, 'PC1', 'Ethernet0', '10.0.2.1'), null, 'R1 owns it, but on another link');
  assert.equal(resolveNeighbor(w, 'PC1', 'Ethernet0', '10.0.1.99'), null);

  // nobody has the address
  const none = sendFlow(w, ping('PC1', '10.0.1.99'));
  assert.deepEqual([none.ok, none.symbol, none.forward.reason], [false, '.', 'host-unreachable']);
  assert.match(none.summary, /PC1 cannot find 10\.0\.1\.99 on the link of Ethernet0/);
  assert.match(none.summary, /No device in the lab has the address 10\.0\.1\.99/);

  // a router reports nothing when ARP fails for a connected destination: the ping times out
  const far = sendFlow(w, ping('PC1', '10.0.2.99'));
  assert.deepEqual([far.ok, far.symbol, far.forward.reason, far.forward.atDeviceId], [false, '.', 'host-unreachable', 'R1']);

  // wrong gateway: an address of the router, but on the other LAN
  getPc(w, 'PC1').nic.gateway = '10.0.2.1';
  const gw = sendFlow(w, ping('PC1', '10.0.2.10'));
  assert.equal(gw.forward.reason, 'no-gateway');
  assert.match(gw.summary, /default gateway 10\.0\.2\.1 of PC1 is not a neighbour in its own network 10\.0\.1\.0\/24/);
  // gateway in the right network, but nobody has it
  getPc(w, 'PC1').nic.gateway = '10.0.1.254';
  const gw2 = sendFlow(w, ping('PC1', '10.0.2.10'));
  assert.equal(gw2.forward.reason, 'host-unreachable');
  assert.match(gw2.summary, /cannot reach its default gateway 10\.0\.1\.254/);
  // no gateway at all
  delete getPc(w, 'PC1').nic.gateway;
  const gw3 = sendFlow(w, ping('PC1', '10.0.2.10'));
  assert.equal(gw3.forward.reason, 'no-gateway');
  assert.match(gw3.summary, /PC1 has no default gateway/);
  // the local LAN still works without a gateway
  assert.equal(sendFlow(w, ping('PC1', '10.0.1.20')).ok, true);
  // and the far PC's answer needs its own gateway
  getPc(w, 'PC1').nic.gateway = '10.0.1.1';
  delete getPc(w, 'PC3').nic.gateway;
  const back = sendFlow(w, ping('PC1', '10.0.2.10'));
  assert.equal(back.forward.ok, true);
  assert.equal(back.reverse?.reason, 'no-gateway');
  assert.match(back.summary, /answer is lost on the way back/);
});

test('a PC is not a router and a wrong mask breaks delivery', () => {
  const w = smallLab();
  // PC1 uses PC2 as its gateway
  getPc(w, 'PC1').nic.gateway = '10.0.1.20';
  const f = sendFlow(w, ping('PC1', '10.0.2.10'));
  assert.deepEqual([f.forward.reason, f.forward.atDeviceId], ['no-route', 'PC2']);
  assert.match(f.summary, /A PC is not a router/);
  // PC1 with a /16 mask believes 10.0.2.10 is on its own link
  getPc(w, 'PC1').nic.gateway = '10.0.1.1';
  getPc(w, 'PC1').nic.mask = '255.255.0.0';
  const g = sendFlow(w, ping('PC1', '10.0.2.10'));
  assert.equal(g.forward.reason, 'host-unreachable');
  assert.match(g.forward.steps[0].detail ?? '', /inside PC1's own network 10\.0\.0\.0\/16/);
  // a PC can always ping itself, and nothing at all without an address
  assert.equal(sendFlow(w, ping('PC1', '10.0.1.10')).ok, true);
  delete getPc(w, 'PC1').nic.address;
  assert.equal(sendFlow(w, ping('PC1', '10.0.1.20')).forward.reason, 'no-ip');
});

test('VLANs separate ports; access ports of two switches join a VLAN; trunks carry several VLANs', () => {
  const w = smallLab();
  // PC2 moved to VLAN 10: it no longer hears PC1 or the router
  port(w, 'SW1', 2).switchport = { mode: 'access', accessVlan: 10 };
  assert.deepEqual(names(w, 'PC2', 'Ethernet0'), []);
  assert.deepEqual(names(w, 'PC1', 'Ethernet0'), [`R1:${GI}`, 'SW1:Vlan1']);
  const f = sendFlow(w, ping('PC1', '10.0.1.20'));
  assert.equal(f.forward.reason, 'host-unreachable');
  assert.match(f.summary, /PC2 Ethernet0 has the address 10\.0\.1\.20, but it is not on the same link/);

  // SW2 joins through an access link in VLAN 10 (crossover between switches); a PC there talks to PC2
  cable(w, 'crossover', ['SW1', 'GigabitEthernet1/0/10'], ['SW2', 'GigabitEthernet1/0/10']);
  port(w, 'SW1', 10).switchport = { mode: 'access', accessVlan: 10 };
  port(w, 'SW2', 10).switchport = { mode: 'access', accessVlan: 10 };
  port(w, 'SW2', 1).switchport = { mode: 'access', accessVlan: 10 };
  // move PC3 from the router to SW2 port 1
  w.cables = w.cables.filter((c) => c.a.deviceId !== 'R1' || c.a.port !== 'GigabitEthernet0/0/1');
  cable(w, 'straight', ['PC3', 'Ethernet0'], ['SW2', 'GigabitEthernet1/0/1']);
  staticPc(w, 'PC3', '10.0.1.30', '255.255.255.0');
  assert.deepEqual(names(w, 'PC2', 'Ethernet0'), ['PC3:Ethernet0']);
  const g = sendFlow(w, ping('PC2', '10.0.1.30'));
  assert.equal(g.ok, true, g.summary);
  assert.deepEqual(g.forward.steps.filter((s) => s.stage === 'switch').map((s) => s.deviceId), ['SW1', 'SW2']);
  assert.match(g.forward.steps[1].text, /VLAN 10/);

  // the same over a trunk: VLAN 1 and VLAN 10 both cross, and stay separate
  port(w, 'SW1', 10).switchport = { mode: 'trunk', accessVlan: 1 };
  port(w, 'SW2', 10).switchport = { mode: 'trunk', accessVlan: 1 };
  assert.deepEqual(names(w, 'PC2', 'Ethernet0'), ['PC3:Ethernet0']);
  port(w, 'SW2', 1).switchport = { mode: 'access', accessVlan: 1 };
  assert.deepEqual(names(w, 'PC3', 'Ethernet0'), ['PC1:Ethernet0', `R1:${GI}`, 'SW1:Vlan1', 'SW2:Vlan1']);
  assert.deepEqual(names(w, 'PC2', 'Ethernet0'), []);
  // trunk on one side only: tagged VLAN 10 frames are dropped by the access port, native VLAN 1 still crosses
  port(w, 'SW2', 10).switchport = { mode: 'access', accessVlan: 1 };
  assert.ok(names(w, 'PC3', 'Ethernet0').includes('PC1:Ethernet0'));
  port(w, 'SW2', 1).switchport = { mode: 'access', accessVlan: 10 };
  assert.deepEqual(names(w, 'PC2', 'Ethernet0'), []);
});

test('switch management: Vlan1 with an address answers ping; ip default-gateway is needed for other networks', () => {
  const w = smallLab();
  const sw = getIos(w, 'SW1');
  sw.config.interfaces['Vlan1'] = { name: 'Vlan1', shutdown: false, ip: { address: '10.0.1.2', mask: '255.255.255.0' } };
  assert.deepEqual(ownAddresses(w, 'SW1'), [{ address: '10.0.1.2', mask: '255.255.255.0', iface: 'Vlan1', up: true }]);
  // same LAN
  const local = sendFlow(w, ping('PC1', '10.0.1.2'));
  assert.equal(local.ok, true, local.summary);
  assert.equal(local.forward.atDeviceId, 'SW1');
  // other LAN: the request arrives, the switch has no way back
  const far = sendFlow(w, ping('PC3', '10.0.1.2'));
  assert.equal(far.forward.ok, true);
  assert.equal(far.ok, false);
  assert.equal(far.reverse?.reason, 'no-route');
  assert.match(far.summary, /SW1 does not route by itself: it needs "ip default-gateway <address>" to reach other networks/);
  assert.deepEqual(routingTable(w, 'SW1').map((r) => r.code), ['C', 'L']);
  sw.config.defaultGateway = '10.0.1.1';
  assert.equal(routingTable(w, 'SW1').find((r) => r.isDefault)?.nextHop, '10.0.1.1');
  const ok = sendFlow(w, ping('PC3', '10.0.1.2'));
  assert.equal(ok.ok, true, ok.summary);
  // the switch can ping out, too
  assert.equal(sendFlow(w, ping('SW1', '10.0.2.10')).ok, true);
  // Telnet to the switch: default vty lines have "login" but no password
  const t = sendFlow(w, tcp('PC1', '10.0.1.2', 23));
  assert.deepEqual([t.ok, t.vty?.login], [true, 'password-not-set']);
  // a switch does not route: it cannot be used as a gateway
  getPc(w, 'PC1').nic.gateway = '10.0.1.2';
  const gw = sendFlow(w, ping('PC1', '10.0.2.10'));
  assert.deepEqual([gw.forward.reason, gw.forward.atDeviceId], ['no-route', 'SW1']);
  assert.match(gw.summary, /SW1 works as a layer-2 switch/);
  // shut down again: no answer, and the switch itself cannot send
  sw.config.interfaces['Vlan1'].shutdown = true;
  assert.equal(sendFlow(w, ping('PC2', '10.0.1.2')).forward.reason, 'host-unreachable');
  const mute = sendFlow(w, ping('SW1', '10.0.1.10'));
  assert.equal(mute.forward.reason, 'no-ip');
  assert.match(mute.summary, /SW1 has no IP address on an active interface.*Vlan1/);
});

test('traceroute lists every router on the way and stops at the destination', () => {
  const w = smallLab();
  assert.deepEqual(traceroute(w, 'PC1', '10.0.2.10'), {
    hops: [{ ttl: 1, address: '10.0.1.1', symbol: '!' }, { ttl: 2, address: '10.0.2.10', symbol: '!' }], reached: true,
  });
  assert.deepEqual(traceroute(w, 'R1', '10.0.2.10'), { hops: [{ ttl: 1, address: '10.0.2.10', symbol: '!' }], reached: true });
  // unknown network: the router answers "unreachable"
  assert.deepEqual(traceroute(w, 'PC1', '172.16.0.1'), { hops: [{ ttl: 1, address: '10.0.1.1', symbol: '!H' }], reached: false });
  // silent destination: three stars, then stop
  const silent = traceroute(w, 'PC1', '10.0.2.99');
  assert.deepEqual(silent.hops.map((h) => h.symbol), ['!', '*', '*', '*']);
  assert.equal(silent.reached, false);
  // probe mode leaves the world alone
  const before = structuredClone(w);
  traceroute(w, 'PC1', '10.0.2.10', { probe: true });
  assert.deepEqual(w, before);
  void ifUp;
});
