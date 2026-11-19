/** NAT (ARCHITECTURE §6.3): static, dynamic pool, overload/PAT, port forwarding, load distribution, translation table. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GI, acl, any, buildBench, cable, eq, host, ifUp, net, permit, ping, setAcl, staticPc, stdPermit, tcp, udp } from './fixtures.ts';
import { probeFlow, sendFlow, translationRow } from '../../src/engine/sim/index.ts';
import { getIos, getPc } from '../../src/engine/world.ts';
import type { World } from '../../src/engine/types.ts';

const GI1 = 'GigabitEthernet0/0/1';

/**
 * Inside LAN 192.168.1.0/24 (R1 Gi0/0/0 .1 inside; PC1 .10, PC2 .11 on SW1) — R1 Gi0/0/1 200.0.0.1/24 outside —
 * Ethernet — R2 Gi0/0/1 200.0.0.2 — R2 Gi0/0/0 203.0.113.1/24 — PC3 203.0.113.10.
 * R2 has no route to the private LAN, so nothing comes back without NAT.
 */
function natLab(): World {
  const w = buildBench();
  cable(w, 'straight', ['PC1', 'Ethernet0'], ['SW1', 'GigabitEthernet1/0/1']);
  cable(w, 'straight', ['PC2', 'Ethernet0'], ['SW1', 'GigabitEthernet1/0/2']);
  cable(w, 'straight', ['SW1', 'GigabitEthernet1/0/24'], ['R1', GI]);
  cable(w, 'crossover', ['R1', GI1], ['R2', GI1]);
  cable(w, 'crossover', ['R2', GI], ['PC3', 'Ethernet0']);
  ifUp(w, 'R1', GI, '192.168.1.1', '255.255.255.0');
  ifUp(w, 'R1', GI1, '200.0.0.1', '255.255.255.0');
  ifUp(w, 'R2', GI1, '200.0.0.2', '255.255.255.0');
  ifUp(w, 'R2', GI, '203.0.113.1', '255.255.255.0');
  const c = getIos(w, 'R1').config;
  c.interfaces[GI].natRole = 'inside';
  c.interfaces[GI1].natRole = 'outside';
  c.staticRoutes = [{ prefix: '0.0.0.0', mask: '0.0.0.0', nextHop: '200.0.0.2' }];
  setAcl(c, acl('1', 'standard', [stdPermit(net('192.168.1.0', '0.0.0.255'))]));
  staticPc(w, 'PC1', '192.168.1.10', '255.255.255.0', '192.168.1.1');
  staticPc(w, 'PC2', '192.168.1.11', '255.255.255.0', '192.168.1.1');
  staticPc(w, 'PC3', '203.0.113.10', '255.255.255.0', '203.0.113.1');
  getPc(w, 'PC3').services.http = true;
  return w;
}
const nat = (w: World) => getIos(w, 'R1').config.nat;
const table = (w: World) => getIos(w, 'R1').runtime.natTranslations;
const rows = (w: World) => table(w).map(translationRow);

test('without NAT the private source goes out untranslated and the answer cannot come back', () => {
  const w = natLab();
  const f = sendFlow(w, ping('PC1', '203.0.113.10'));
  assert.equal(f.forward.ok, true);
  assert.equal(f.forward.received?.src, '192.168.1.10');
  assert.deepEqual([f.ok, f.reverse?.reason, f.reverse?.atDeviceId], [false, 'no-route', 'R2']);
  assert.equal(table(w).length, 0);
});

test('static NAT translates in both directions and answers ARP for the global address', () => {
  const w = natLab();
  nat(w).staticRules = [{ local: '192.168.1.10', global: '200.0.0.10' }];
  // inside → outside
  const out = sendFlow(w, ping('PC1', '203.0.113.10'));
  assert.equal(out.ok, true, out.summary);
  assert.equal(out.forward.received?.src, '200.0.0.10');
  assert.equal(out.reverse?.received?.dst, '192.168.1.10');
  // R2 reaches 200.0.0.10 on the Ethernet link because R1 answers for its NAT address
  assert.ok(out.reverse?.steps.some((s) => s.deviceId === 'R2' && s.stage === 'egress' && /to R1 GigabitEthernet0\/0\/1/.test(s.text)));
  assert.deepEqual(rows(w), ['icmp 200.0.0.10:5 192.168.1.10:5 203.0.113.10:5 203.0.113.10:5']);
  assert.equal(table(w)[0].fromStatic, true);
  // session started from outside
  getPc(w, 'PC1').services.http = true;
  const inb = sendFlow(w, tcp('PC3', '200.0.0.10', 80));
  assert.equal(inb.ok, true, inb.summary);
  assert.equal(inb.forward.atDeviceId, 'PC1');
  assert.equal(inb.forward.received?.dst, '192.168.1.10');
  assert.equal(inb.repliedFrom, '200.0.0.10');
  const stepIn = inb.forward.steps.find((s) => s.stage === 'nat-outside');
  assert.equal(stepIn?.detail, 'ip nat inside source static 192.168.1.10 200.0.0.10');
  assert.match(stepIn?.text ?? '', /static NAT, session started from outside/);
  assert.equal(stepIn?.header, 'TCP SYN 203.0.113.10:49158 → 192.168.1.10:80');
  // PC2 has no rule: still untranslated
  assert.equal(sendFlow(w, ping('PC2', '203.0.113.10')).forward.received?.src, '192.168.1.11');
  // counters: every new conversation is a miss, the reply of each a hit
  assert.deepEqual([getIos(w, 'R1').runtime.natMisses, getIos(w, 'R1').runtime.natHits], [2, 2]);
  // removing the rule removes its translations
  nat(w).staticRules = [];
  const gone = sendFlow(w, ping('PC1', '203.0.113.10'));
  assert.equal(gone.forward.received?.src, '192.168.1.10');
  assert.equal(table(w).length, 0);
});

test('dynamic NAT with a pool: one address per inside host, first come first served', () => {
  const w = natLab();
  nat(w).pools = [{ name: 'POOL', start: '200.0.0.20', end: '200.0.0.21', mask: '255.255.255.0' }];
  nat(w).dynamicRules = [{ acl: '1', pool: 'POOL', overload: false }];
  const a = sendFlow(w, ping('PC1', '203.0.113.10'));
  assert.equal(a.ok, true, a.summary);
  assert.equal(a.forward.received?.src, '200.0.0.20');
  const b = sendFlow(w, ping('PC2', '203.0.113.10'));
  assert.equal(b.forward.received?.src, '200.0.0.21');
  // the same host keeps its address for other conversations; ports are not changed
  const c = sendFlow(w, tcp('PC1', '203.0.113.10', 80));
  assert.equal(c.ok, true);
  assert.deepEqual([c.forward.received?.src, c.forward.received?.sport], ['200.0.0.20', 49156]);
  assert.match(c.forward.steps.find((s) => s.stage === 'nat-inside')?.detail ?? '', /ip nat inside source list 1 pool POOL — access-list 1 permit 192\.168\.1\.0 0\.0\.0\.255/);
  // while the mapping exists the host can be reached from outside on its pool address
  getPc(w, 'PC1').services.http = true;
  const inb = sendFlow(w, tcp('PC3', '200.0.0.20', 80));
  assert.deepEqual([inb.ok, inb.forward.atDeviceId], [true, 'PC1']);

  // pool exhausted: a third host is refused
  const w2 = natLab();
  nat(w2).pools = [{ name: 'POOL', start: '200.0.0.20', end: '200.0.0.20', mask: '255.255.255.0' }];
  nat(w2).dynamicRules = [{ acl: '1', pool: 'POOL', overload: false }];
  assert.equal(sendFlow(w2, ping('PC1', '203.0.113.10')).ok, true);
  const full = sendFlow(w2, ping('PC2', '203.0.113.10'));
  assert.deepEqual([full.ok, full.symbol, full.forward.reason, full.forward.atDeviceId], [false, 'U', 'host-unreachable', 'R1']);
  assert.match(full.summary, /NAT pool POOL on R1 has no free address left/);
  assert.match(full.summary, /overload/);
});

test('overload (PAT): many hosts share one address; ports are kept unless they collide', () => {
  const w = natLab();
  nat(w).pools = [{ name: 'POOL', start: '200.0.0.20', end: '200.0.0.20', mask: '255.255.255.0' }];
  nat(w).dynamicRules = [{ acl: '1', pool: 'POOL', overload: true }];
  const a = sendFlow(w, tcp('PC1', '203.0.113.10', 80));
  const b = sendFlow(w, tcp('PC2', '203.0.113.10', 80));
  assert.deepEqual([a.ok, b.ok], [true, true]);
  assert.deepEqual([a.forward.received?.src, a.forward.received?.sport], ['200.0.0.20', 49156]);
  assert.deepEqual([b.forward.received?.src, b.forward.received?.sport], ['200.0.0.20', 49157]);
  assert.match(a.forward.steps.find((s) => s.stage === 'nat-inside')?.text ?? '', /PAT, overload.*; the source port stays 49156\.$/);
  // both PCs use the same source port: the second one gets a new port, and the answer finds its way back
  const c = sendFlow(w, tcp('PC1', '203.0.113.10', 80, { sport: 5000 }));
  const d = sendFlow(w, tcp('PC2', '203.0.113.10', 80, { sport: 5000 }));
  assert.equal(c.forward.received?.sport, 5000);
  assert.equal(d.forward.received?.sport, 1024);
  assert.match(d.forward.steps.find((s) => s.stage === 'nat-inside')?.text ?? '', /source port changes from 5000 to 1024 because 5000 is already used/);
  assert.deepEqual([d.ok, d.reverse?.atDeviceId, d.reverse?.received?.dport], [true, 'PC2', 5000]);
  assert.deepEqual(rows(w), [
    'tcp 200.0.0.20:49156 192.168.1.10:49156 203.0.113.10:80 203.0.113.10:80',
    'tcp 200.0.0.20:49157 192.168.1.11:49157 203.0.113.10:80 203.0.113.10:80',
    'tcp 200.0.0.20:5000 192.168.1.10:5000 203.0.113.10:80 203.0.113.10:80',
    'tcp 200.0.0.20:1024 192.168.1.11:5000 203.0.113.10:80 203.0.113.10:80',
  ]);
  // repeating a conversation reuses its translation
  const again = sendFlow(w, tcp('PC2', '203.0.113.10', 80, { sport: 5000 }));
  assert.equal(again.forward.received?.sport, 1024);
  assert.equal(table(w).length, 4);
  assert.match(again.forward.steps.find((s) => s.stage === 'nat-inside')?.text ?? '', /reusing the translation of this conversation/);
  // a new session from outside to the shared address has no translation: it ends on nobody
  const inb = sendFlow(w, tcp('PC3', '200.0.0.20', 80));
  assert.equal(inb.ok, false);
  assert.notEqual(inb.forward.atDeviceId, 'PC1');
});

test('interface overload: the ICMP identifier counts as the port', () => {
  const w = natLab();
  nat(w).dynamicRules = [{ acl: '1', interface: GI1, overload: true }];
  const a = sendFlow(w, ping('PC1', '203.0.113.10', { sport: 7 }));
  const b = sendFlow(w, ping('PC2', '203.0.113.10', { sport: 7 }));
  assert.deepEqual([a.ok, b.ok], [true, true]);
  assert.deepEqual([a.forward.received?.src, a.forward.received?.sport], ['200.0.0.1', 7]);
  assert.deepEqual([b.forward.received?.src, b.forward.received?.sport], ['200.0.0.1', 1024]);
  assert.match(b.forward.steps.find((s) => s.stage === 'nat-inside')?.text ?? '', /ICMP identifier changes from 7 to 1024/);
  assert.equal(b.reverse?.received?.sport, 7, 'the reply carries PC2\'s own identifier again');
  assert.deepEqual(rows(w), [
    'icmp 200.0.0.1:7 192.168.1.10:7 203.0.113.10:7 203.0.113.10:7',
    'icmp 200.0.0.1:1024 192.168.1.11:7 203.0.113.10:1024 203.0.113.10:1024',
  ]);
  // the router still answers for its own address
  assert.equal(sendFlow(w, ping('PC3', '200.0.0.1')).forward.atDeviceId, 'R1');
  // an ICMP error about a translated packet is translated back to the inside host
  const lost = sendFlow(w, ping('PC1', '198.51.100.1'));
  assert.deepEqual([lost.symbol, lost.forward.reason, lost.forward.atDeviceId, lost.reverse?.atDeviceId], ['U', 'no-route', 'R2', 'PC1']);
  assert.equal(lost.unreachableFrom, '200.0.0.2');
});

test('static rules win over dynamic rules; extended ACLs can select by destination', () => {
  const w = natLab();
  nat(w).staticRules = [{ local: '192.168.1.10', global: '200.0.0.10' }];
  nat(w).dynamicRules = [{ acl: '1', interface: GI1, overload: true }];
  assert.equal(sendFlow(w, ping('PC1', '203.0.113.10')).forward.received?.src, '200.0.0.10');
  assert.equal(sendFlow(w, ping('PC2', '203.0.113.10')).forward.received?.src, '200.0.0.1');
  // dynamic rule with an extended list: only traffic to 203.0.113.0/24 is translated
  const w2 = natLab();
  setAcl(getIos(w2, 'R1').config, acl('101', 'extended', [permit('ip', net('192.168.1.0', '0.0.0.255'), net('203.0.113.0', '0.0.0.255'))]));
  nat(w2).dynamicRules = [{ acl: '101', interface: GI1, overload: true }];
  assert.equal(sendFlow(w2, ping('PC1', '203.0.113.10')).forward.received?.src, '200.0.0.1');
  assert.equal(sendFlow(w2, ping('PC1', '200.0.0.2')).forward.received?.src, '192.168.1.10');
  // rules are tried in order; the first whose list permits the packet is used
  const w3 = natLab();
  setAcl(getIos(w3, 'R1').config, acl('2', 'standard', [stdPermit(host('192.168.1.11'))]));
  nat(w3).pools = [{ name: 'P2', start: '200.0.0.30', end: '200.0.0.30', mask: '255.255.255.0' }];
  nat(w3).dynamicRules = [{ acl: '2', pool: 'P2', overload: true }, { acl: '1', interface: GI1, overload: true }];
  assert.equal(sendFlow(w3, ping('PC2', '203.0.113.10')).forward.received?.src, '200.0.0.30');
  assert.equal(sendFlow(w3, ping('PC1', '203.0.113.10')).forward.received?.src, '200.0.0.1');
});

test('port forwarding: static NAT with ports, global address or interface form', () => {
  const w = natLab();
  getPc(w, 'PC1').services.http = true;
  nat(w).staticRules = [{ local: '192.168.1.10', proto: 'tcp', localPort: 80, interface: GI1, globalPort: 8080 }];
  const f = sendFlow(w, tcp('PC3', '200.0.0.1', 8080));
  assert.equal(f.ok, true, f.summary);
  assert.deepEqual([f.forward.atDeviceId, f.forward.received?.dst, f.forward.received?.dport], ['PC1', '192.168.1.10', 80]);
  assert.deepEqual([f.reverse?.received?.src, f.reverse?.received?.sport], ['200.0.0.1', 8080]);
  assert.equal(f.forward.steps.find((s) => s.stage === 'nat-outside')?.detail, 'ip nat inside source static tcp 192.168.1.10 80 interface GigabitEthernet0/0/1 8080');
  // other ports of the interface address still belong to the router
  assert.equal(sendFlow(w, tcp('PC3', '200.0.0.1', 80)).forward.atDeviceId, 'R1');
  assert.equal(sendFlow(w, ping('PC3', '200.0.0.1')).forward.atDeviceId, 'R1');
  // the same with an explicit global address
  nat(w).staticRules = [{ local: '192.168.1.10', proto: 'tcp', localPort: 80, global: '200.0.0.40', globalPort: 80 }];
  const g = sendFlow(w, tcp('PC3', '200.0.0.40', 80));
  assert.deepEqual([g.ok, g.forward.atDeviceId], [true, 'PC1']);
  // only that port is forwarded
  assert.notEqual(sendFlow(w, tcp('PC3', '200.0.0.40', 21)).forward.atDeviceId, 'PC1');
  // traffic the server starts itself from another port is not covered by the port rule
  assert.equal(sendFlow(w, ping('PC1', '203.0.113.10')).forward.received?.src, '192.168.1.10');
});

test('TCP load distribution: connections to the virtual address rotate over the real servers', () => {
  const w = natLab();
  getPc(w, 'PC1').services.http = true;
  getPc(w, 'PC2').services.http = true;
  const c = getIos(w, 'R1').config;
  setAcl(c, acl('2', 'standard', [stdPermit(host('200.0.0.50'))]));
  nat(w).pools = [{ name: 'SERVERS', start: '192.168.1.10', end: '192.168.1.11', mask: '255.255.255.0', rotary: true }];
  nat(w).insideDestinationRules = [{ acl: '2', pool: 'SERVERS' }];
  const hits: (string | undefined)[] = [];
  for (let i = 0; i < 4; i++) {
    const f = sendFlow(w, tcp('PC3', '200.0.0.50', 80, { sport: 6000 + i }));
    assert.equal(f.ok, true, f.summary);
    assert.equal(f.repliedFrom, '200.0.0.50', 'the client only ever sees the virtual address');
    hits.push(f.forward.atDeviceId);
  }
  assert.deepEqual(hits, ['PC1', 'PC2', 'PC1', 'PC2']);
  assert.match(sendFlow(w, tcp('PC3', '200.0.0.50', 80, { sport: 7000 })).forward.steps.find((s) => s.stage === 'nat-outside')?.text ?? '', /NAT load distribution/);
  // an existing connection stays with its server
  assert.equal(sendFlow(w, tcp('PC3', '200.0.0.50', 80, { sport: 6001 })).forward.atDeviceId, 'PC2');
});

test('nothing is translated without the interface roles; packets the router creates are translated when a rule matches', () => {
  const w = natLab();
  nat(w).dynamicRules = [{ acl: '1', interface: GI1, overload: true }];
  // router-originated packet sourced from the inside address
  const own = sendFlow(w, ping('R1', '203.0.113.10', { srcAddr: '192.168.1.1' }));
  assert.equal(own.ok, true, own.summary);
  assert.equal(own.forward.received?.src, '200.0.0.1');
  // sourced from the outside address: no rule matches, nothing to do
  assert.equal(sendFlow(w, ping('R1', '203.0.113.10')).forward.received?.src, '200.0.0.1');
  // roles removed
  delete getIos(w, 'R1').config.interfaces[GI].natRole;
  const f = sendFlow(w, ping('PC1', '203.0.113.10'));
  assert.equal(f.forward.received?.src, '192.168.1.10');
  assert.match(f.forward.steps.find((s) => s.feature === 'nat')?.text ?? '', /not marked "ip nat inside"/);
  // probeFlow shows what would happen without creating translations
  getIos(w, 'R1').config.interfaces[GI].natRole = 'inside';
  const before = table(w).length;
  assert.equal(probeFlow(w, udp('PC2', '203.0.113.10', 53)).forward.received?.src, '200.0.0.1');
  assert.equal(table(w).length, before);
  void any; void eq;
});
