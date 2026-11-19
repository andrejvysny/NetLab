/** probeFlow never mutates; everything is deterministic; the world stays plain JSON. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDR, SE, ping, referenceLab, snmp, staticPc, tcp, udp } from './fixtures.ts';
import {
  dhcpAcquire, dhcpRelease, emitSyslog, interfaceState, linkInfo, lookupRoute, ownAddresses, probeFlow, qosPlan, routingTable,
  sendFlow, snmpRequest, staticRouteStatus, syslogProbe, traceroute, vtyDecision,
} from '../../src/engine/sim/index.ts';
import type { FlowSpec, World } from '../../src/engine/types.ts';

const FLOWS: FlowSpec[] = [
  ping('PC1', ADDR.pc2), ping('PC1', ADDR.pc3), ping('PC2', ADDR.pc3), ping('PC3', ADDR.pc1Public),
  ping('R1', ADDR.r2Lo0, { srcAddr: ADDR.r1Lo0 }), ping('PC1', ADDR.r2Lo0), ping('PC1', '9.9.9.9'),
  tcp('PC2', ADDR.pc3, 80), tcp('PC2', ADDR.pc3, 21), tcp('PC1', ADDR.r1Lan, 23), tcp('PC1', ADDR.r2Wan, 23), tcp('PC3', ADDR.r1Wan, 23),
  tcp('PC1', ADDR.r2Wan, 22), tcp('PC1', ADDR.pc3, 8080),
  snmp('PC1', ADDR.r2Wan, 'D105read'), snmp('PC1', ADDR.r1Lan, 'D105write', 'set', 'renamed'), snmp('PC3', ADDR.r1Wan, 'D105write', 'set', 'x'),
  udp('R2', ADDR.pc1Public, 514, { app: { kind: 'syslog', severity: 5, mnemonic: 'T', text: 't' } }), udp('PC1', ADDR.pc3, 9999),
  ping('SW1', ADDR.pc1), ping('PC1', '192.168.100.77'),
];

/** Reference lab that has not carried a single packet over the WAN: probes must negotiate SAs on their private copy. */
function untouched(): World {
  return referenceLab({
    acquire: false,
    mutate: (w) => {
      staticPc(w, 'PC2', ADDR.pc2, '255.255.255.0', ADDR.r1Lan);
      staticPc(w, 'PC3', ADDR.pc3, '255.255.255.192', ADDR.r2Lan);
    },
  });
}

test('probeFlow never mutates the world', () => {
  for (const make of [untouched, () => referenceLab()]) {
    const w = make();
    const before = structuredClone(w);
    for (const spec of FLOWS) {
      probeFlow(w, spec);
      assert.deepEqual(w, before, `world changed by probing ${spec.proto} ${spec.fromDeviceId} → ${spec.dst}`);
    }
  }
});

test('read-only API functions do not mutate either', () => {
  const w = referenceLab();
  const before = structuredClone(w);
  routingTable(w, 'R1'); routingTable(w, 'PC1'); routingTable(w, 'SW1');
  lookupRoute(w, 'R2', '8.8.8.8'); ownAddresses(w, 'R1'); staticRouteStatus(w, 'R1');
  interfaceState(w, 'R1', SE); linkInfo(w, { deviceId: 'R1', port: SE });
  qosPlan(w, 'R1', SE); vtyDecision(w, 'R2', ADDR.pc1Public); syslogProbe(w, 'R1'); syslogProbe(w, 'R2');
  traceroute(w, 'PC1', ADDR.pc3, { probe: true });
  assert.deepEqual(w, before);
});

test('a probe predicts exactly what sending does', () => {
  const w = untouched();
  for (const spec of FLOWS) {
    const predicted = probeFlow(w, spec);
    const real = sendFlow(w, spec);
    assert.deepEqual(predicted, real, `${spec.proto} ${spec.fromDeviceId} → ${spec.dst}`);
  }
});

test('deterministic: the same actions on two fresh labs give identical results and identical worlds', () => {
  const run = () => {
    const w = referenceLab();
    const results: unknown[] = FLOWS.map((spec) => sendFlow(w, spec));
    results.push(traceroute(w, 'PC1', ADDR.pc3));
    results.push(snmpRequest(w, 'PC1', { host: ADDR.r2Wan, community: 'D105read', op: 'get', oid: 'sysName' }));
    emitSyslog(w, 'R2', 4, 'TEST-4-X', 'hello');
    dhcpRelease(w, 'PC2');
    results.push(dhcpAcquire(w, 'PC2'));
    return { w, results };
  };
  const a = run();
  const b = run();
  assert.deepEqual(a.results, b.results);
  assert.deepEqual(a.w, b.w);
});

test('the world and every result stay plain JSON', () => {
  const w = referenceLab();
  const results = FLOWS.map((spec) => sendFlow(w, spec));
  emitSyslog(w, 'R1', 5, 'SYS-5-CONFIG_I', 'x');
  dhcpRelease(w, 'PC3');
  dhcpAcquire(w, 'PC3');
  assert.deepEqual(JSON.parse(JSON.stringify(w)), w, 'no undefined values, Maps, Dates or functions in the world');
  assert.deepEqual(structuredClone(w), w);
  for (const r of results) assert.doesNotThrow(() => structuredClone(r));
  // every trace step is a sentence with a known verdict
  for (const r of results) {
    for (const s of [...r.forward.steps, ...(r.reverse?.steps ?? [])]) {
      assert.ok(s.text.length > 15 && /[.!]$|\)$/.test(s.text.trim()), `step text: "${s.text}"`);
      assert.ok(['info', 'ok', 'changed', 'drop'].includes(s.verdict));
      assert.ok(w.devices[s.deviceId], `step device ${s.deviceId}`);
    }
    assert.ok(r.summary.length > 10);
    assert.equal(r.ok, r.symbol === '!');
  }
});
