/**
 * Robustness: seeded, deterministic damage to the reference lab must never crash the engine, never break the
 * invariants of results, and probes must stay side-effect free.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDR, GI, SE, acl, any, deny, host, net, permit, ping, r1, r2, recable, referenceLab, setAcl, snmp, stdPermit, tcp, udp, unplug } from './fixtures.ts';
import {
  dhcpAcquire, dhcpRelease, emitSyslog, interfaceState, probeFlow, qosLoad, qosPlan, routingTable, sendFlow, staticRouteStatus,
  syslogProbe, traceroute, vtyDecision,
} from '../../src/engine/sim/index.ts';
import { getIos, getPc } from '../../src/engine/world.ts';
import type { FlowSpec, World } from '../../src/engine/types.ts';

/** Small deterministic generator (no Math.random). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const DAMAGE: ((w: World, pick: (n: number) => number) => void)[] = [
  (w) => { r1(w).config.interfaces[GI].shutdown = true; },
  (w) => { r2(w).config.interfaces[SE].shutdown = true; },
  (w) => { r1(w).config.interfaces[SE].encapsulation = 'ppp'; },
  (w) => { delete r1(w).config.interfaces[SE].ip; },
  (w) => { delete r2(w).config.interfaces[GI].ip; },
  (w) => { r1(w).config.staticRoutes = []; },
  (w) => { r2(w).config.staticRoutes = [{ prefix: '0.0.0.0', mask: '0.0.0.0', nextHop: '60.50.40.2' }]; },
  (w) => { r1(w).config.staticRoutes.push({ prefix: '60.50.40.0', mask: '255.255.255.192', exitInterface: 'Null0' }); },
  (w) => { r1(w).config.staticRoutes.push({ prefix: '9.0.0.0', mask: '255.0.0.0', nextHop: '9.9.9.9' }); },
  (w) => { r1(w).config.ipRouting = false; },
  (w) => { delete r1(w).config.interfaces[SE].natRole; },
  (w) => { r1(w).config.interfaces[GI].natRole = 'outside'; r1(w).config.interfaces[SE].natRole = 'inside'; },
  (w) => { r1(w).config.nat.staticRules = [{ local: ADDR.pc1, global: ADDR.r1Wan }]; },
  (w) => { r1(w).config.nat.dynamicRules = [{ acl: 'missing', pool: 'missing', overload: false }]; },
  (w) => { r1(w).config.nat.pools = [{ name: 'P', start: '60.50.30.1', end: '60.50.30.1', mask: '255.255.255.252' }]; r1(w).config.nat.dynamicRules = [{ acl: '1', pool: 'P', overload: false }]; },
  (w) => { r1(w).config.nat.staticRules.push({ local: ADDR.pc2, proto: 'tcp', localPort: 80, interface: SE, globalPort: 8080 }); },
  (w) => { delete r1(w).config.acls['110']; },
  (w) => { r1(w).config.acls['110'].entries = []; },
  (w) => { setAcl(r1(w).config, acl('110', 'extended', [deny('ip', any, any)])); },
  (w) => { r2(w).config.interfaces[SE].aclIn = '120'; },
  (w) => { r2(w).config.interfaces[GI].aclOut = 'allowPC1'; },
  (w) => { r1(w).config.interfaces[SE].aclOut = '1'; },
  (w) => { r1(w).config.interfaces[GI].noIpUnreachables = true; },
  (w) => { r2(w).config.crypto.isakmpKeys = []; },
  (w) => { r1(w).config.crypto.maps = []; },
  (w) => { r1(w).config.crypto.maps[0].entries[0].peers = []; },
  (w) => { r1(w).config.crypto.maps[0].entries[0].peers = [ADDR.r1Wan]; },
  (w) => { r2(w).config.crypto.maps[0].entries[0].matchAcl = 'nowhere'; },
  (w) => { r2(w).config.crypto.transformSets = []; },
  (w) => { r1(w).config.crypto.isakmpEnabled = false; },
  (w) => { delete r2(w).config.interfaces[SE].cryptoMap; },
  (w) => { r1(w).config.crypto.maps[0].entries.push({ seq: 5, type: 'ipsec-isakmp', matchAcl: '1', peers: ['8.8.8.8'], transformSets: ['TS'] }); },
  (w) => { setAcl(r1(w).config, acl('120', 'extended', [permit('ip', any, any)])); },
  (w) => { setAcl(r2(w).config, acl('120', 'extended', [permit('ip', net('60.50.40.0', '0.0.0.63'), any)])); },
  (w) => { r1(w).config.qos.policyMaps = []; },
  (w) => { r1(w).config.qos.classMaps = []; },
  (w) => { r2(w).config.qos.policyMaps[1].classes[0].servicePolicy = 'output_SE'; },
  (w) => { r2(w).config.qos.policyMaps[0].classes = []; },
  (w) => { delete r1(w).config.interfaces[SE].bandwidthKbps; r1(w).config.interfaces[SE].servicePolicyIn = 'output_SE'; },
  (w) => { r1(w).config.dhcp.pools = []; },
  (w) => { r1(w).config.dhcp.excluded = [{ low: '192.168.100.1', high: '192.168.100.254' }]; },
  (w) => { r1(w).config.dhcp.pools[0].network = { address: '192.168.100.0', mask: '255.255.255.255' }; },
  (w) => { r2(w).config.interfaces[GI].helperAddresses = ['60.50.40.1', '9.9.9.9', ADDR.pc1Public]; },
  (w) => { r1(w).config.lines.vty = []; },
  (w) => { r2(w).config.lines.vty[0].accessClassIn = 'nothing'; },
  (w) => { r1(w).config.snmp.communities = []; },
  (w) => { r2(w).config.snmp.communities[0].acl = 'nothing'; },
  (w) => { r1(w).config.logging = { hosts: [ADDR.pc1, '8.8.8.8', ADDR.r1Lo0], sourceInterface: 'Loopback7' }; },
  (w) => { r1(w).config.interfaces['Loopback0'].shutdown = true; },
  (w) => { delete r1(w).config.interfaces['Loopback100']; },
  (w) => { recable(w, 'PC1', 'Ethernet0', 'crossover'); },
  (w) => { unplug(w, 'R1', SE); },
  (w) => { unplug(w, 'PC3', 'Ethernet0'); },
  (w) => { w.settings.strictCables = false; w.settings.qosClassifiesInnerHeader = false; },
  (w) => { getIos(w, 'SW1').config.interfaces['GigabitEthernet1/0/24'].switchport = { mode: 'access', accessVlan: 30 }; },
  (w) => { getIos(w, 'SW1').config.interfaces['Vlan1'] = { name: 'Vlan1', shutdown: false, ip: { address: '192.168.100.2', mask: '255.255.255.0' } }; getIos(w, 'SW1').config.defaultGateway = ADDR.r1Lan; },
  (w) => { getPc(w, 'PC1').nic.gateway = '192.168.100.2'; },
  (w) => { delete getPc(w, 'PC1').nic.gateway; },
  (w) => { getPc(w, 'PC1').nic.mask = '255.255.255.252'; },
  (w) => { getPc(w, 'PC1').nic = { mode: 'static', mac: getPc(w, 'PC1').nic.mac }; },
  (w) => { getPc(w, 'PC2').nic = { mode: 'static', mac: getPc(w, 'PC2').nic.mac, address: ADDR.pc1, mask: '255.255.255.0', gateway: ADDR.r1Lan }; },
  (w) => { r1(w).config.rip = { version: 2, networks: ['60.0.0.0', '192.168.100.0', '1.0.0.0'], autoSummary: true, passive: [] }; r2(w).config.rip = { networks: ['60.0.0.0', '2.0.0.0'], autoSummary: true, passive: ['default'] }; },
  (w) => { for (const r of [r1(w), r2(w)]) r.config.ospf = [{ processId: 1, networks: [{ address: '0.0.0.0', wildcard: '255.255.255.255', area: '0' }], passive: [], defaultOriginate: true }]; },
  (w) => { setAcl(r1(w).config, acl('1', 'standard', [stdPermit(host(ADDR.pc2))])); },
  (w, pick) => { r1(w).runtime.vtyInUse = pick(20); },
];

function flows(): FlowSpec[] {
  return [
    ping('PC1', ADDR.pc2), ping('PC1', ADDR.pc3), ping('PC2', ADDR.pc3), ping('PC3', ADDR.pc1Public), ping('PC3', ADDR.r1Wan),
    ping('R1', ADDR.r2Lo0, { srcAddr: ADDR.r1Lo0 }), ping('R2', ADDR.r1Lo0), ping('PC1', ADDR.r2Lo0), ping('PC1', '9.9.9.9'), ping('SW1', ADDR.pc3),
    ping('PC1', '192.168.100.2'), ping('PC2', '0.0.0.0'), ping('PC1', '255.255.255.255'), ping('PC1', 'not-an-address'),
    tcp('PC2', ADDR.pc3, 80), tcp('PC2', ADDR.pc3, 21), tcp('PC1', ADDR.r1Lan, 23), tcp('PC1', ADDR.r2Wan, 23), tcp('PC3', ADDR.r1Wan, 22),
    tcp('PC3', ADDR.pc1Public, 80), tcp('PC3', ADDR.r1Wan, 8080), tcp('R1', ADDR.r2Wan, 23), tcp('R2', ADDR.pc1Public, 23, { srcAddr: ADDR.r2Lo0 }),
    snmp('PC1', ADDR.r2Wan, 'D105read'), snmp('PC3', ADDR.r1Wan, 'D105write', 'set', 'x'), snmp('PC1', ADDR.r1Lan, 'D105write', 'set', 'R1'),
    udp('R2', ADDR.pc1Public, 514), udp('PC1', ADDR.pc3, 9999), udp('R1', ADDR.pc3, 162), udp('PC3', ADDR.r1Wan, 500), udp('PC3', ADDR.r1Wan, 67),
  ];
}

test('seeded damage to the reference lab: no crash, sane results, pure probes, plain-JSON world', () => {
  const next = rng(20260417);
  const pick = (n: number) => Math.floor(next() * n);
  const outcomes = new Set<string>();
  const all = flows();
  // every kind of damage once on its own, then random combinations of two or three
  const rounds = DAMAGE.length + 10;
  for (let round = 0; round < rounds; round++) {
    const chosen = round < DAMAGE.length
      ? [DAMAGE[round]]
      : [DAMAGE[pick(DAMAGE.length)], DAMAGE[pick(DAMAGE.length)], DAMAGE[pick(DAMAGE.length)]].slice(0, 2 + pick(2));
    const applied = chosen.map((d) => DAMAGE.indexOf(d));
    const tag = `round ${round}, damage #${applied.join('+#')}`;
    const w = referenceLab({
      acquire: false,
      mutate: (x) => { for (const d of chosen) { try { d(x, pick); } catch { /* damage that no longer applies (object already removed) is skipped */ } } },
    });
    try {
      dhcpAcquire(w, 'PC2');
      dhcpAcquire(w, 'PC3');
      for (const id of w.order) {
        for (const r of routingTable(w, id)) assert.ok(r.resolved.iface.length > 0 && r.prefixLen >= 0 && r.prefixLen <= 32);
        staticRouteStatus(w, id);
        for (const p of w.devices[id].ports) interfaceState(w, id, p.name);
      }
      qosPlan(w, 'R1', SE); qosPlan(w, 'R2', SE);
      vtyDecision(w, 'R1', ADDR.pc1); syslogProbe(w, 'R1'); syslogProbe(w, 'R2');
      qosLoad(w, { deviceId: 'R1', iface: SE, offered: [{ label: 'a', flow: ping('PC1', ADDR.pc3), kbps: 200 }, { label: 'b', flow: tcp('PC2', ADDR.pc3, 80), kbps: 200 }] });

      // probes: half of the flows each round, alternating
      const before = structuredClone(w);
      all.forEach((spec, i) => {
        if (i % 2 !== round % 2) return;
        const r = probeFlow(w, spec);
        outcomes.add(`${r.outcome}/${r.forward.reason ?? r.reverse?.reason ?? 'ok'}`);
        assert.equal(r.ok, r.symbol === '!');
        assert.ok(r.summary.length > 5);
        for (const d of [r.forward, r.reverse]) {
          if (!d) continue;
          if (!d.ok) assert.ok(d.reason && d.reasonText, `failed delivery without a reason (${spec.fromDeviceId} → ${spec.dst})`);
          assert.ok(d.steps.length > 0 && d.steps.length < 80, `${d.steps.length} steps (${spec.fromDeviceId} → ${spec.dst})`);
          for (const s of d.steps) assert.ok(w.devices[s.deviceId] && s.text.length > 0);
        }
      });
      assert.deepEqual(w, before, 'a probe mutated the world');

      // real traffic every third round; afterwards the world must still be plain JSON
      if (round % 3 === 0) {
        for (const spec of all) sendFlow(w, spec);
        traceroute(w, 'PC1', ADDR.pc3, { maxTtl: 6 });
        traceroute(w, 'R2', ADDR.pc1Public, { maxTtl: 6 });
        emitSyslog(w, 'R1', 3, 'TEST-3-X', 'x');
        emitSyslog(w, 'R2', 3, 'TEST-3-X', 'x');
        dhcpRelease(w, 'PC2');
        dhcpAcquire(w, 'PC2');
        assert.deepEqual(JSON.parse(JSON.stringify(w)), w, 'the world is no longer plain JSON');
      }
    } catch (e) {
      assert.fail(`${tag}: ${(e as Error).stack ?? e}`);
    }
  }
  // the damage really bites: the probes ended in many different ways
  for (const reason of ['no-link', 'no-route', 'host-unreachable', 'acl-in', 'acl-out', 'ipsec-negotiation-failed', 'ipsec-expected', 'port-closed', 'service-denied', 'ttl-expired', 'no-ip', 'no-gateway']) {
    assert.ok([...outcomes].some((o) => o.endsWith(`/${reason}`)), `no probe ended with ${reason}: ${[...outcomes].join(', ')}`);
  }
});
