/** Routing tables: connected/local, static (all forms), simplified RIP and OSPF, lookup, TTL and loops. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GI, SE, ifUp, ping, threeRouters } from './fixtures.ts';
import { lookupRoute, ownAddresses, routeText, routingTable, sendFlow, staticRouteStatus, traceroute } from '../../src/engine/sim/index.ts';
import { getIos } from '../../src/engine/world.ts';
import type { World } from '../../src/engine/types.ts';

const GI1 = 'GigabitEthernet0/0/1';
const cfg = (w: World, id: string) => getIos(w, id).config;
const lines = (w: World, id: string, code?: string) => routingTable(w, id).filter((r) => !code || r.code === code).map(routeText);
const route = (w: World, id: string, prefix: string, mask: string, nextHop?: string, exitInterface?: string, distance?: number) => {
  const r: { prefix: string; mask: string; nextHop?: string; exitInterface?: string; distance?: number } = { prefix, mask };
  if (nextHop) r.nextHop = nextHop;
  if (exitInterface) r.exitInterface = exitInterface;
  if (distance !== undefined) r.distance = distance;
  cfg(w, id).staticRoutes.push(r);
};
/** Full static routing for the three-router chain. */
function staticAll(w: World): void {
  route(w, 'R1', '0.0.0.0', '0.0.0.0', '10.0.12.2');
  route(w, 'R2', '10.1.0.0', '255.255.255.0', '10.0.12.1');
  route(w, 'R2', '10.3.0.0', '255.255.255.0', '10.0.23.3');
  route(w, 'R3', '0.0.0.0', '0.0.0.0', '10.0.23.2');
}

test('connected and local routes follow the interface state', () => {
  const w = threeRouters();
  assert.deepEqual(lines(w, 'R1'), [
    'C 1.1.1.1/32 is directly connected, Loopback0',
    `C 10.0.12.0/30 is directly connected, ${SE}`,
    `L 10.0.12.1/32 is directly connected, ${SE}`,
    `C 10.1.0.0/24 is directly connected, ${GI}`,
    `L 10.1.0.1/32 is directly connected, ${GI}`,
  ]);
  assert.deepEqual(ownAddresses(w, 'R1').map((a) => `${a.iface} ${a.address} ${a.up}`), [`${GI} 10.1.0.1 true`, `${SE} 10.0.12.1 true`, 'Loopback0 1.1.1.1 true']);
  // shut the serial link on R2: R1 loses the connected route as well
  cfg(w, 'R2').interfaces[SE].shutdown = true;
  assert.ok(!lines(w, 'R1').some((l) => l.includes(SE)));
  assert.equal(ownAddresses(w, 'R1').find((a) => a.iface === SE)?.up, false);
  // secondary addresses give their own connected and local routes
  cfg(w, 'R1').interfaces[GI].secondary = [{ address: '172.16.5.1', mask: '255.255.255.0' }];
  assert.ok(lines(w, 'R1').includes(`C 172.16.5.0/24 is directly connected, ${GI}`));
  assert.ok(lines(w, 'R1').includes(`L 172.16.5.1/32 is directly connected, ${GI}`));
  // an interface without an address gives no route; PCs have a host table
  ifUp(w, 'R1', GI1);
  assert.ok(!lines(w, 'R1').some((l) => l.includes(GI1)));
  assert.deepEqual(lines(w, 'PC1'), ['default gateway 10.1.0.1', 'C 10.1.0.0/24 is directly connected, Ethernet0']);
});

test('static routes: next hop, exit interface, both — and the default route flag', () => {
  const w = threeRouters();
  route(w, 'R1', '10.3.0.0', '255.255.255.0', '10.0.12.2');
  route(w, 'R1', '3.3.3.3', '255.255.255.255', undefined, SE);
  route(w, 'R1', '0.0.0.0', '0.0.0.0', '10.0.12.2', SE);
  assert.deepEqual(lines(w, 'R1', 'S'), [
    `S* 0.0.0.0/0 [1/0] via 10.0.12.2, ${SE}`,
    `S 3.3.3.3/32 is directly connected, ${SE}`,
    'S 10.3.0.0/24 [1/0] via 10.0.12.2',
  ]);
  const table = routingTable(w, 'R1');
  assert.equal(table[0].isDefault, true);
  assert.deepEqual(table.filter((r) => r.code === 'S').map((r) => r.resolved), [
    { iface: SE, nextHop: '10.0.12.2' }, { iface: SE, nextHop: undefined }, { iface: SE, nextHop: '10.0.12.2' },
  ]);
  // longest prefix wins, the default route catches the rest
  assert.equal(lookupRoute(w, 'R1', '10.3.0.10')?.prefixLen, 24);
  assert.equal(lookupRoute(w, 'R1', '3.3.3.3')?.prefixLen, 32);
  assert.equal(lookupRoute(w, 'R1', '8.8.8.8')?.isDefault, true);
  assert.equal(lookupRoute(w, 'R1', '10.1.0.1')?.code, 'L');
  assert.equal(lookupRoute(w, 'R1', '10.1.0.77')?.code, 'C');
  assert.equal(lookupRoute(w, 'R2', '8.8.8.8'), null);
  assert.equal(lookupRoute(w, 'PC1', '8.8.8.8')?.nextHop, '10.1.0.1');
});

test('a static route is installed only when it is usable', () => {
  const w = threeRouters();
  route(w, 'R1', '10.3.0.0', '255.255.255.0', '10.0.99.2');          // next hop in no connected network
  route(w, 'R1', '10.4.0.0', '255.255.255.0', undefined, GI1);       // exit interface is shut down
  route(w, 'R1', '10.5.0.0', '255.255.255.0', '10.0.12.1');          // next hop is the router itself
  route(w, 'R1', '10.6.0.0', '255.255.255.0', '10.0.12.2');          // fine
  assert.deepEqual(lines(w, 'R1', 'S'), ['S 10.6.0.0/24 [1/0] via 10.0.12.2']);
  const st = staticRouteStatus(w, 'R1');
  assert.deepEqual(st.map((s) => s.installed), [false, false, false, true]);
  assert.match(st[0].reason ?? '', /next hop 10\.0\.99\.2 is not in a network R1 can reach/);
  assert.match(st[1].reason ?? '', /exit interface GigabitEthernet0\/0\/1 is administratively down\/down/);
  assert.match(st[2].reason ?? '', /address of R1 itself/);
  // the failed ping names the route that is configured but not installed
  const f = sendFlow(w, ping('PC1', '10.3.0.10'));
  assert.deepEqual([f.symbol, f.forward.reason], ['U', 'no-route']);
  assert.match(f.summary, /"ip route 10\.3\.0\.0 255\.255\.255\.0 10\.0\.99\.2" is configured but not in the routing table/);
  // a next hop is never resolved through the default route
  const w2 = threeRouters();
  route(w2, 'R1', '0.0.0.0', '0.0.0.0', '10.0.12.2');
  route(w2, 'R1', '10.3.0.0', '255.255.255.0', '172.16.0.1');
  assert.deepEqual(lines(w2, 'R1', 'S'), ['S* 0.0.0.0/0 [1/0] via 10.0.12.2']);
});

test('recursive static routes resolve through other routes', () => {
  const w = threeRouters();
  route(w, 'R1', '10.3.0.0', '255.255.255.0', '3.3.3.3');   // via R3's loopback …
  assert.deepEqual(lines(w, 'R1', 'S'), [], 'not usable until 3.3.3.3 is reachable');
  route(w, 'R1', '3.3.3.3', '255.255.255.255', '10.0.12.2'); // … which is behind R2
  assert.deepEqual(lines(w, 'R1', 'S'), ['S 3.3.3.3/32 [1/0] via 10.0.12.2', 'S 10.3.0.0/24 [1/0] via 3.3.3.3']);
  assert.deepEqual(lookupRoute(w, 'R1', '10.3.0.10')?.resolved, { iface: SE, nextHop: '10.0.12.2' });
  cfg(w, 'R1').staticRoutes.pop();
  assert.deepEqual(lines(w, 'R1', 'S'), []);
});

test('floating static route: the higher distance waits until the primary disappears', () => {
  const w = threeRouters();
  // second path R1–R2 over Ethernet
  w.cables.push({ id: 'x', kind: 'crossover', a: { deviceId: 'R1', port: GI1 }, b: { deviceId: 'R2', port: GI } });
  ifUp(w, 'R1', GI1, '10.0.21.1', '255.255.255.0');
  ifUp(w, 'R2', GI, '10.0.21.2', '255.255.255.0');
  route(w, 'R1', '10.3.0.0', '255.255.255.0', '10.0.12.2');
  route(w, 'R1', '10.3.0.0', '255.255.255.0', '10.0.21.2', undefined, 200);
  assert.deepEqual(lines(w, 'R1', 'S'), ['S 10.3.0.0/24 [1/0] via 10.0.12.2']);
  cfg(w, 'R1').interfaces[SE].shutdown = true;
  assert.deepEqual(lines(w, 'R1', 'S'), ['S 10.3.0.0/24 [200/0] via 10.0.21.2']);
  assert.equal(lookupRoute(w, 'R1', '10.3.0.10')?.resolved.iface, GI1);
});

test('end to end with static routes; a missing return route is named', () => {
  const w = threeRouters();
  staticAll(w);
  const f = sendFlow(w, ping('PC1', '10.3.0.10'));
  assert.equal(f.ok, true, f.summary);
  assert.deepEqual(f.forward.steps.filter((s) => s.stage === 'route').map((s) => `${s.deviceId}: ${s.detail}`), [
    'R1: S* 0.0.0.0/0 [1/0] via 10.0.12.2',
    'R2: S 10.3.0.0/24 [1/0] via 10.0.23.3',
    `R3: C 10.3.0.0/24 is directly connected, ${GI}`,
  ]);
  assert.equal(f.forward.received?.ttl, 128 - 3, 'three routers, three hops of TTL');
  assert.deepEqual(traceroute(w, 'PC1', '10.3.0.10').hops.map((h) => h.address), ['10.1.0.1', '10.0.12.2', '10.0.23.3', '10.3.0.10']);
  assert.deepEqual(traceroute(w, 'R1', '3.3.3.3').hops.map((h) => `${h.address}${h.symbol}`), ['10.0.12.2!H'], 'R2 has no route to 3.3.3.3');
  // routers can ping each other's far interfaces
  assert.equal(sendFlow(w, ping('R1', '10.3.0.1')).ok, true);
  // R2 forgets the way back to LAN1
  cfg(w, 'R2').staticRoutes.shift();
  const g = sendFlow(w, ping('PC1', '10.3.0.10'));
  assert.equal(g.forward.ok, true);
  assert.deepEqual([g.ok, g.symbol, g.reverse?.reason, g.reverse?.atDeviceId], [false, '.', 'no-route', 'R2']);
  assert.match(g.summary, /R2 has no route to 10\.1\.0\.10/);
});

test('exit-interface-only route on Ethernet works through proxy ARP of the next router', () => {
  const w = threeRouters();
  staticAll(w);
  cfg(w, 'R2').staticRoutes[1] = { prefix: '10.3.0.0', mask: '255.255.255.0', exitInterface: GI1 };
  assert.ok(lines(w, 'R2', 'S').includes(`S 10.3.0.0/24 is directly connected, ${GI1}`));
  const f = sendFlow(w, ping('PC1', '10.3.0.10'));
  assert.equal(f.ok, true, f.summary);
  // on a serial link no neighbour lookup is needed at all
  cfg(w, 'R1').staticRoutes[0] = { prefix: '0.0.0.0', mask: '0.0.0.0', exitInterface: SE };
  assert.equal(sendFlow(w, ping('PC1', '10.3.0.10')).ok, true);
  // Null0 discards
  cfg(w, 'R2').staticRoutes[1] = { prefix: '10.3.0.0', mask: '255.255.255.0', exitInterface: 'Null0' };
  const n = sendFlow(w, ping('PC1', '10.3.0.10'));
  assert.equal(n.forward.reason, 'no-route');
  assert.match(n.summary, /Null0/);
});

test('two default routes that point at each other: the packet loops until its TTL runs out', () => {
  const w = threeRouters();
  route(w, 'R1', '0.0.0.0', '0.0.0.0', '10.0.12.2');
  route(w, 'R2', '0.0.0.0', '0.0.0.0', '10.0.12.1');
  const f = sendFlow(w, ping('PC1', '9.9.9.9'));
  assert.equal(f.ok, false);
  assert.equal(f.symbol, '.');
  assert.equal(f.forward.reason, 'ttl-expired');
  assert.match(f.forward.reasonText ?? '', /Routing loop: R[12] and R[12] keep sending the packet to each other until its TTL reaches 0/);
  assert.match(f.summary, /two default routes that point at each other/);
  // the trace stays short: it stops describing hops once the loop is recognised
  assert.ok(f.forward.steps.length < 20, `trace has ${f.forward.steps.length} steps`);
  assert.ok(f.forward.steps.some((s) => /the routers keep sending it to each other \(a routing loop\)/.test(s.text)));
  assert.equal(f.forward.steps.at(-1)?.verdict, 'drop');
  // the counters show how often the packet really crossed the link: TTL 128 from a Windows PC allows 127 hops,
  // and the "time exceeded" message from R2 crosses it once more on its way back to PC1
  assert.equal(f.forward.atDeviceId, 'R2');
  assert.equal(getIos(w, 'R1').runtime.ifCounters[SE].out + getIos(w, 'R2').runtime.ifCounters[SE].out, 128);
  assert.equal(f.reverse?.atDeviceId, 'PC1', 'the ICMP time-exceeded message reaches the sender');
  // traceroute shows the ping-pong
  const hops = traceroute(w, 'R1', '9.9.9.9', { maxTtl: 4 }).hops.map((h) => h.address);
  assert.deepEqual(hops, ['10.0.12.2', '10.0.12.1', '10.0.12.2', '10.0.12.1']);
});

test('"no ip routing": the router stops forwarding and uses ip default-gateway itself', () => {
  const w = threeRouters();
  staticAll(w);
  cfg(w, 'R2').ipRouting = false;
  const f = sendFlow(w, ping('PC1', '10.3.0.10'));
  assert.deepEqual([f.forward.reason, f.forward.atDeviceId], ['no-route', 'R2']);
  assert.match(f.summary, /"no ip routing" is set/);
  assert.ok(lines(w, 'R2').every((l) => /^[CL] /.test(l)), 'static routes are not used');
  assert.equal(sendFlow(w, ping('R2', '10.1.0.10')).forward.reason, 'no-route');
  cfg(w, 'R2').defaultGateway = '10.0.12.1';
  assert.equal(sendFlow(w, ping('R2', '10.1.0.10')).ok, true);
});

test('RIP: routers exchange the networks their network statements cover, transitively (AD 120)', () => {
  const w = threeRouters();
  for (const id of ['R1', 'R2', 'R3']) cfg(w, id).rip = { version: 2, networks: ['10.0.0.0'], autoSummary: false, passive: [] };
  assert.deepEqual(lines(w, 'R1', 'R'), [
    `R 10.0.23.0/24 [120/1] via 10.0.12.2, ${SE}`,
    `R 10.3.0.0/24 [120/2] via 10.0.12.2, ${SE}`,
  ]);
  assert.deepEqual(lines(w, 'R3', 'R'), [
    `R 10.0.12.0/30 [120/1] via 10.0.23.2, ${GI1}`,
    `R 10.1.0.0/24 [120/2] via 10.0.23.2, ${GI1}`,
  ]);
  assert.equal(routingTable(w, 'R1').find((r) => r.code === 'R')?.learnedFrom, 'R2');
  assert.equal(sendFlow(w, ping('PC1', '10.3.0.10')).ok, true);
  // loopbacks are not covered by "network 10.0.0.0"
  assert.equal(lookupRoute(w, 'R1', '3.3.3.3'), null);
  cfg(w, 'R3').rip!.networks.push('3.0.0.0');
  assert.ok(lines(w, 'R1', 'R').includes(`R 3.3.3.3/32 [120/2] via 10.0.12.2, ${SE}`));
  // with auto-summary the loopback crosses the 10.x link as its classful network
  cfg(w, 'R3').rip!.autoSummary = true;
  assert.ok(lines(w, 'R1', 'R').includes(`R 3.0.0.0/8 [120/2] via 10.0.12.2, ${SE}`));
  assert.equal(sendFlow(w, ping('R1', '3.3.3.3')).ok, true);

  // a passive interface sends no updates: R2 no longer learns from R3
  cfg(w, 'R3').rip!.passive = [GI1];
  assert.deepEqual(lines(w, 'R2', 'R'), [`R 10.1.0.0/24 [120/1] via 10.0.12.1, ${SE}`]);
  assert.ok(lines(w, 'R3', 'R').length > 0, 'R3 still listens');
  cfg(w, 'R3').rip!.passive = [];
  // version mismatch: a version 2 router ignores version 1 updates
  cfg(w, 'R2').rip!.version = 1;
  assert.deepEqual(lines(w, 'R1', 'R'), []);
  // RIP not enabled on the link: nothing is exchanged
  cfg(w, 'R2').rip!.version = 2;
  cfg(w, 'R2').rip!.networks = ['192.168.1.0'];
  assert.deepEqual(lines(w, 'R1', 'R'), []);
  // a link that goes down withdraws the routes
  cfg(w, 'R2').rip!.networks = ['10.0.0.0'];
  cfg(w, 'R3').interfaces[GI1].shutdown = true;
  assert.deepEqual(lines(w, 'R1', 'R'), []);
  // default-information originate
  cfg(w, 'R2').rip!.defaultOriginate = true;
  assert.deepEqual(lines(w, 'R1', 'R'), [`R* 0.0.0.0/0 [120/1] via 10.0.12.2, ${SE}`]);
});

test('OSPF: adjacent routers in the same area exchange the networks their statements match (AD 110)', () => {
  const w = threeRouters();
  for (const id of ['R1', 'R2', 'R3']) {
    cfg(w, id).ospf = [{ processId: 1, networks: [{ address: '10.0.0.0', wildcard: '0.255.255.255', area: '0' }], passive: [] }];
  }
  // costs: serial 1544 kbit/s → 64, GigabitEthernet → 1
  assert.deepEqual(lines(w, 'R1', 'O'), [
    `O 10.0.23.0/24 [110/65] via 10.0.12.2, ${SE}`,
    `O 10.3.0.0/24 [110/66] via 10.0.12.2, ${SE}`,
  ]);
  assert.deepEqual(lines(w, 'R3', 'O'), [
    `O 10.0.12.0/30 [110/65] via 10.0.23.2, ${GI1}`,
    `O 10.1.0.0/24 [110/66] via 10.0.23.2, ${GI1}`,
  ]);
  assert.equal(sendFlow(w, ping('PC1', '10.3.0.10')).ok, true);
  // bandwidth changes the cost
  cfg(w, 'R1').interfaces[SE].bandwidthKbps = 128;
  assert.ok(lines(w, 'R1', 'O').includes(`O 10.0.23.0/24 [110/782] via 10.0.12.2, ${SE}`));
  delete cfg(w, 'R1').interfaces[SE].bandwidthKbps;
  // loopbacks are advertised as host routes once a statement covers them
  cfg(w, 'R3').ospf[0].networks.push({ address: '3.3.3.3', wildcard: '0.0.0.0', area: '0' });
  assert.ok(lines(w, 'R1', 'O').includes(`O 3.3.3.3/32 [110/66] via 10.0.12.2, ${SE}`));
  // a passive interface forms no adjacency (but its network is still advertised by its owner)
  cfg(w, 'R3').ospf[0].passive = [GI1];
  assert.deepEqual(lines(w, 'R1', 'O'), [`O 10.0.23.0/24 [110/65] via 10.0.12.2, ${SE}`]);
  cfg(w, 'R3').ospf[0].passive = [];
  // area mismatch on the R1–R2 link: no adjacency there
  cfg(w, 'R1').ospf[0].networks[0].area = '1';
  assert.deepEqual(lines(w, 'R1', 'O'), []);
  assert.ok(!lines(w, 'R2', 'O').some((l) => l.includes('10.1.0.0')));
  cfg(w, 'R1').ospf[0].networks[0].area = '0';
  // default-information originate needs a default route on the originator
  cfg(w, 'R3').ospf[0].defaultOriginate = true;
  assert.equal(lookupRoute(w, 'R1', '8.8.8.8'), null);
  cfg(w, 'R3').staticRoutes.push({ prefix: '0.0.0.0', mask: '0.0.0.0', exitInterface: 'Null0' });
  assert.ok(lines(w, 'R1', 'O').includes(`O* E2 0.0.0.0/0 [110/1] via 10.0.12.2, ${SE}`));
});

test('administrative distance decides between sources: static 1, OSPF 110, RIP 120; connected always wins', () => {
  const w = threeRouters();
  for (const id of ['R1', 'R2', 'R3']) {
    cfg(w, id).rip = { version: 2, networks: ['10.0.0.0'], autoSummary: false, passive: [] };
  }
  assert.equal(lookupRoute(w, 'R1', '10.3.0.10')?.code, 'R');
  for (const id of ['R1', 'R2', 'R3']) {
    cfg(w, id).ospf = [{ processId: 1, networks: [{ address: '10.0.0.0', wildcard: '0.255.255.255', area: '0' }], passive: [] }];
  }
  assert.equal(lookupRoute(w, 'R1', '10.3.0.10')?.code, 'O');
  assert.equal(routingTable(w, 'R1').filter((r) => r.prefix === '10.3.0.0').length, 1, 'only the best source is installed');
  route(w, 'R1', '10.3.0.0', '255.255.255.0', '10.0.12.2');
  assert.equal(lookupRoute(w, 'R1', '10.3.0.10')?.code, 'S');
  route(w, 'R1', '10.1.0.0', '255.255.255.0', '10.0.12.2');
  assert.equal(lookupRoute(w, 'R1', '10.1.0.10')?.code, 'C');
  // a static with distance 130 loses against both protocols
  cfg(w, 'R1').staticRoutes = [{ prefix: '10.3.0.0', mask: '255.255.255.0', nextHop: '10.0.12.2', distance: 130 }];
  assert.equal(lookupRoute(w, 'R1', '10.3.0.10')?.code, 'O');
});
