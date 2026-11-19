/** The reference solution on other cabling: grading must not depend on which free ports were used. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDR, GI, SE, bringUp, cable, ping, r1, r2, referenceLab, snmp, tcp, unplug } from './fixtures.ts';
import { interfaceState, linkInfo, qosLoad, qosPlan, routingTable, sendFlow, snmpRequest, syslogProbe } from '../../src/engine/sim/index.ts';
import type { World } from '../../src/engine/types.ts';

const GI1 = 'GigabitEthernet0/0/1';

/** WAN over Ethernet (crossover R1 Gi0/0/1 – R2 Gi0/0/1) instead of the serial link. */
function ethernetWan(): World {
  const w = referenceLab({
    acquire: false,
    mutate: (x) => {
      unplug(x, 'R1', SE);
      cable(x, 'crossover', ['R1', GI1], ['R2', GI1]);
      for (const dev of [r1(x), r2(x)]) {
        const c = dev.config;
        const { ip, natRole, cryptoMap, servicePolicyOut, bandwidthKbps } = c.interfaces[SE];
        c.interfaces[SE] = { name: SE, shutdown: true };
        c.interfaces[GI1] = { name: GI1, shutdown: false };
        if (ip) c.interfaces[GI1].ip = ip;
        if (natRole) c.interfaces[GI1].natRole = natRole;
        if (cryptoMap) c.interfaces[GI1].cryptoMap = cryptoMap;
        if (servicePolicyOut) c.interfaces[GI1].servicePolicyOut = servicePolicyOut;
        if (bandwidthKbps) c.interfaces[GI1].bandwidthKbps = bandwidthKbps;
        c.staticRoutes = c.staticRoutes.map((r) => ({ ...r, exitInterface: GI1 }));
        c.nat.dynamicRules = c.nat.dynamicRules.map((r) => ({ ...r, interface: GI1 }));
      }
    },
  });
  return w;
}

test('reference solution with an Ethernet WAN link behaves the same', () => {
  const w = ethernetWan();
  assert.equal(interfaceState(w, 'R1', GI1).protocol, 'up');
  const { pc2, pc3 } = bringUp(w);
  assert.deepEqual([pc2.address, pc3.address, pc3.server], [ADDR.pc2, ADDR.pc3, ADDR.r1Wan]);
  assert.deepEqual(routingTable(w, 'R1').filter((r) => r.code === 'S').map((r) => [r.isDefault, r.nextHop, r.iface]), [[true, ADDR.r2Wan, GI1]]);

  const a = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.deepEqual([a.ok, a.forward.received?.src, a.forward.encrypted], [true, ADDR.pc1Public, true], a.summary);
  assert.equal(a.forward.qos[0].childClass, 'classPriority');
  assert.equal(a.forward.qos[0].iface, GI1);
  const b = sendFlow(w, ping('PC2', ADDR.pc3));
  assert.deepEqual([b.ok, b.forward.received?.src], [true, ADDR.r1Wan], b.summary);
  const c = sendFlow(w, ping('PC3', ADDR.pc1Public));
  assert.deepEqual([c.ok, c.forward.atDeviceId], [true, 'PC1'], c.summary);
  assert.equal(sendFlow(w, ping('PC1', ADDR.r2Lo0)).symbol, 'U');
  assert.equal(sendFlow(w, ping('R1', ADDR.r2Lo0, { srcAddr: ADDR.r1Lo0 })).ok, true);
  assert.equal(sendFlow(w, tcp('PC2', ADDR.pc3, 80)).ok, true);
  assert.equal(sendFlow(w, tcp('PC2', ADDR.pc3, 21)).forward.reason, 'acl-in');
  assert.equal(sendFlow(w, tcp('PC1', ADDR.r2Wan, 23)).ok, true);
  assert.equal(sendFlow(w, tcp('PC3', ADDR.r1Wan, 23)).outcome, 'refused');
  assert.equal(snmpRequest(w, 'PC1', { host: ADDR.r2Wan, community: 'D105write', op: 'set', oid: 'sysContact', value: 'x' }).ok, true);
  assert.equal(sendFlow(w, snmp('PC2', ADDR.r2Wan, 'D105read')).ok, false);
  assert.deepEqual(syslogProbe(w, 'R2').map((p) => [p.received, p.seenFrom]), [[true, ADDR.r2Lo0]]);
  // Configured bandwidth affects percentage shaping, not the Ethernet line rate.
  const plan = qosPlan(w, 'R1', GI1);
  assert.deepEqual([plan.attached, plan.physicalBps, plan.clockRateBps, plan.bandwidthKbps, plan.shapedBps], [true, 1_000_000_000, undefined, 128, 121600]);
  // the wrong cable on the router–router link
  const bad = ethernetWan();
  bad.cables.find((x) => x.a.port === GI1)!.kind = 'straight';
  assert.equal(linkInfo(bad, { deviceId: 'R1', port: GI1 }).problem, 'Straight-through cable between two routers: this pair needs a crossover cable.');
  assert.equal(sendFlow(bad, ping('R1', ADDR.r2Wan)).forward.reason, 'no-route');
});

test('Ethernet QoS Load is bounded by speed or shaping, never by bandwidth metadata alone', () => {
  const w = ethernetWan();
  bringUp(w);
  const offered = [{ label: 'web', flow: tcp('PC1', ADDR.pc3, 80), kbps: 200_000 }];
  const load = () => qosLoad(w, { deviceId: 'R1', iface: GI1, offered });
  let r = load();
  assert.deepEqual([r.ok, r.linkKbps, r.shapedKbps, r.rows[0].deliveredKbps], [true, 1_000_000, 121.6, 121.6]);
  delete r1(w).config.interfaces[GI1].servicePolicyOut;
  r = load();
  assert.deepEqual([r.ok, r.linkKbps, r.shapedKbps, r.rows[0].deliveredKbps], [false, 1_000_000, 1_000_000, 200_000]);

  r2(w).config.interfaces[GI1].speed = '100';
  assert.equal(qosPlan(w, 'R2', GI1).physicalBps, 100_000_000);
  r = load();
  assert.deepEqual([r.linkKbps, r.shapedKbps, r.rows[0].deliveredKbps], [100_000, 100_000, 100_000]);
  r1(w).config.interfaces[GI1].speed = '10';
  r1(w).config.interfaces[GI1].bandwidthKbps = 1_000_000;
  r1(w).config.interfaces[GI1].servicePolicyOut = 'output_SE';
  r = load();
  assert.equal(qosPlan(w, 'R1', GI1).shapedBps, 950_000_000, 'the percent command still uses the configured reference rate');
  assert.deepEqual([r.ok, r.linkKbps, r.shapedKbps, r.rows[0].deliveredKbps], [true, 10_000, 10_000, 10_000]);
});

test('reference solution with the DCE end of the serial cable on R2', () => {
  const w = referenceLab({
    mutate: (x) => {
      x.cables.find((c) => c.kind === 'serial')!.dceEnd = 'b';
      delete r1(x).config.interfaces[SE].clockRate;
      r2(x).config.interfaces[SE].clockRate = 128000;
    },
  });
  assert.equal(linkInfo(w, { deviceId: 'R2', port: SE }).dce, true);
  assert.equal(linkInfo(w, { deviceId: 'R1', port: SE }).dce, false);
  assert.equal(sendFlow(w, ping('PC1', ADDR.pc3)).ok, true);
  for (const id of ['R1', 'R2']) assert.deepEqual([qosPlan(w, id, SE).physicalBps, qosPlan(w, id, SE).clockRateBps], [128000, 128000]);
  r2(w).config.interfaces[SE].clockRate = 125000;
  for (const id of ['R1', 'R2']) {
    const plan = qosPlan(w, id, SE);
    assert.deepEqual([plan.physicalBps, plan.clockRateBps, plan.bandwidthKbps, plan.shapedBps], [125000, 125000, 128, 121600]);
  }
});

test('reference solution with LAN1 spread over two chained switches and other switch ports', () => {
  const w = referenceLab({
    acquire: false,
    mutate: (x) => {
      // PC2 moves to SW2; SW2 hangs off SW1 with a crossover cable; the router uplink uses another port
      unplug(x, 'PC2', 'Ethernet0');
      cable(x, 'straight', ['PC2', 'Ethernet0'], ['SW2', 'GigabitEthernet1/0/7']);
      cable(x, 'crossover', ['SW1', 'GigabitEthernet1/0/23'], ['SW2', 'GigabitEthernet1/0/23']);
      unplug(x, 'R1', GI);
      cable(x, 'straight', ['SW2', 'GigabitEthernet1/0/12'], ['R1', GI]);
    },
  });
  const { pc2, pc3 } = bringUp(w);
  assert.deepEqual([pc2.address, pc3.address], [ADDR.pc2, ADDR.pc3]);
  const f = sendFlow(w, ping('PC1', ADDR.pc2));
  assert.equal(f.ok, true, f.summary);
  assert.deepEqual(f.forward.steps.filter((s) => s.stage === 'switch').map((s) => s.deviceId), ['SW1', 'SW2']);
  assert.equal(sendFlow(w, ping('PC1', ADDR.pc3)).forward.received?.src, ADDR.pc1Public);
  assert.equal(sendFlow(w, ping('PC2', ADDR.pc3)).forward.received?.src, ADDR.r1Wan);
});
