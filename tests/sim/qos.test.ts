/** MQC QoS (ARCHITECTURE §6.5): classification, hierarchy, counters, IPsec interaction, qosPlan. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDR, GI, SE, acl, any, eq, permit, ping, r1, r2, referenceLab, setAcl, smallLab, tcp, udp } from './fixtures.ts';
import { qosCounter, qosCounterKey, qosLoad, qosPlan, sendFlow } from '../../src/engine/sim/index.ts';
import { getIos, getPc } from '../../src/engine/world.ts';
import type { World } from '../../src/engine/types.ts';

const GI1 = 'GigabitEthernet0/0/1';

test('hierarchical policy: parent and child classes are both counted, in packets and bytes', () => {
  const w = referenceLab();
  const base = structuredClone(r1(w).runtime.qosCounters);
  const delta = (path: string, cls: string) => {
    const now = qosCounter(w, 'R1', SE, path, cls);
    const was = base[qosCounterKey(SE, 'out', path, cls)] ?? { packets: 0, bytes: 0 };
    return [now.packets - was.packets, now.bytes - was.bytes];
  };
  sendFlow(w, ping('PC1', ADDR.pc3, { bytes: 100 }));
  sendFlow(w, tcp('PC1', ADDR.pc3, 80, { bytes: 60 }));
  sendFlow(w, tcp('PC1', ADDR.r2Wan, 23, { bytes: 60 }));
  // The Telnet SYN is the first Telnet packet: it also causes one IKE packet (UDP 500, 200 bytes) from R1.
  // Tunnel-mode ESP adds 56 bytes to every protected packet; the counters show what is really transmitted.
  assert.deepEqual(delta('output_SE', 'class-default'), [4, 156 + 60 + 116 + 200], 'the parent class sees everything');
  assert.deepEqual(delta('output_SE/output_QE', 'classPriority'), [1, 156]);
  assert.deepEqual(delta('output_SE/output_QE', 'classGuaranteed'), [1, 116]);
  assert.deepEqual(delta('output_SE/output_QE', 'class-default'), [2, 60 + 200], 'HTTP and IKE');
  // key format: `${ifName}|out|${policy}|${class}`, child classes under `${parent}/${child}`
  assert.ok(`${SE}|out|output_SE/output_QE|classPriority` in r1(w).runtime.qosCounters);
  assert.ok(`${SE}|out|output_SE|class-default` in r1(w).runtime.qosCounters);
  // nothing is classified on interfaces without a policy
  assert.ok(Object.keys(r1(w).runtime.qosCounters).every((k) => k.startsWith(`${SE}|out|`)));
});

test('IPsec and QoS: by default the original header is classified; without that only "qos pre-classify" sees inside ESP', () => {
  const inner = referenceLab();
  assert.equal(inner.settings.qosClassifiesInnerHeader, true);
  const a = sendFlow(inner, ping('PC1', ADDR.pc3));
  assert.equal(a.forward.qos[0].childClass, 'classPriority');
  const qa = a.forward.steps.find((s) => s.stage === 'qos');
  assert.equal(qa?.text, 'QoS on Serial0/1/0 puts the packet into class classPriority of policy output_QE: priority queue, up to 16 kbit/s.');
  assert.match(qa?.detail ?? '', /classified on the original packet, not on the ESP wrapper/);

  const outer = referenceLab({ settings: { qosClassifiesInnerHeader: false } });
  const b = sendFlow(outer, ping('PC1', ADDR.pc3));
  assert.equal(b.ok, true);
  assert.equal(b.forward.qos[0].childClass, 'class-default', 'the classifier only sees ESP');
  assert.match(b.forward.steps.find((s) => s.stage === 'qos')?.detail ?? '', /classified on the ESP wrapper: the original header is hidden \(no "qos pre-classify" on the crypto map\)/);
  assert.equal(sendFlow(outer, tcp('PC1', ADDR.r2Wan, 23)).forward.qos[0].childClass, 'class-default');
  // unencrypted traffic is classified normally
  assert.equal(sendFlow(outer, tcp('PC1', ADDR.pc3, 80)).forward.qos[0].childClass, 'class-default');
  // qos pre-classify on the crypto map entry restores classification on the original header
  r1(outer).config.crypto.maps[0].entries[0].qosPreClassify = true;
  const c = sendFlow(outer, ping('PC1', ADDR.pc3));
  assert.equal(c.forward.qos[0].childClass, 'classPriority');
  assert.match(c.forward.steps.find((s) => s.stage === 'qos')?.detail ?? '', /"qos pre-classify" on the crypto map/);
  assert.equal(c.reverse?.qos[0].childClass, 'class-default', 'R2 has no pre-classify');
  // matching ESP itself is a way to classify tunnel traffic
  const cfg2 = r2(outer).config;
  setAcl(cfg2, acl('matchPriority', 'extended', [permit('esp', any, any)], true));
  assert.equal(sendFlow(outer, ping('PC1', ADDR.pc3)).reverse?.qos[0].childClass, 'classPriority');
});

/** One router; policy on Gi0/0/1 towards PC3. */
function flatLab(): World {
  const w = smallLab();
  const c = getIos(w, 'R1').config;
  setAcl(c, acl('101', 'extended', [permit('tcp', any, any, { dstPort: eq(80) })]));
  c.qos.classMaps = [
    { name: 'VOICE', matchType: 'match-all', matches: [{ kind: 'protocol', protocol: 'icmp' }] },
    { name: 'WEB', matchType: 'match-all', matches: [{ kind: 'access-group', acl: '101' }] },
    { name: 'MGMT', matchType: 'match-any', matches: [{ kind: 'protocol', protocol: 'telnet' }, { kind: 'protocol', protocol: 'snmp' }] },
    { name: 'GHOST', matchType: 'match-all', matches: [{ kind: 'access-group', acl: 'nope' }] },
  ];
  c.qos.policyMaps = [{
    name: 'LAN_OUT', classes: [
      { className: 'GHOST', bandwidth: { kbps: 10 } },
      { className: 'VOICE', priority: { percent: 10 } },
      { className: 'WEB', bandwidth: { percent: 30 }, police: { bps: 2000000 } },
      { className: 'MGMT', bandwidth: { remainingPercent: 50 } },
    ],
  }];
  c.interfaces[GI1].servicePolicyOut = 'LAN_OUT';
  for (const k of ['http', 'ftp', 'telnet'] as const) getPc(w, 'PC3').services[k] = true;
  return w;
}

test('flat policy: first matching class in policy order, else class-default; match protocol, match-any, undefined ACL', () => {
  const w = flatLab();
  const cls = (f: ReturnType<typeof sendFlow>) => f.forward.qos.map((q) => `${q.policy}/${q.className}${q.childClass ? '/' + q.childClass : ''}`);
  assert.deepEqual(cls(sendFlow(w, ping('PC1', '10.0.2.10'))), ['LAN_OUT/VOICE']);
  assert.deepEqual(cls(sendFlow(w, tcp('PC1', '10.0.2.10', 80))), ['LAN_OUT/WEB']);
  assert.deepEqual(cls(sendFlow(w, tcp('PC1', '10.0.2.10', 23))), ['LAN_OUT/MGMT']);
  assert.deepEqual(cls(sendFlow(w, udp('PC1', '10.0.2.10', 161))), ['LAN_OUT/MGMT']);
  assert.deepEqual(cls(sendFlow(w, tcp('PC1', '10.0.2.10', 21))), ['LAN_OUT/class-default'], 'implicit class-default');
  // packets the router creates are classified too
  assert.deepEqual(cls(sendFlow(w, ping('R1', '10.0.2.10'))), ['LAN_OUT/VOICE']);
  // the other direction leaves through an interface without a policy
  assert.deepEqual(sendFlow(w, ping('PC3', '10.0.1.10')).forward.qos, []);
  assert.deepEqual(sendFlow(w, ping('PC1', '10.0.2.10')).reverse?.qos, []);
  // evidence in the trace
  const step = sendFlow(w, tcp('PC1', '10.0.2.10', 80)).forward.steps.find((s) => s.stage === 'qos');
  assert.match(step?.text ?? '', /class WEB of policy LAN_OUT/);
  assert.equal(step?.detail, 'service-policy output LAN_OUT → class WEB: match access-group 101 → 10 permit tcp any any eq www');
  assert.equal(qosCounter(w, 'R1', GI1, 'LAN_OUT', 'GHOST').packets, 0, 'a class whose ACL does not exist matches nothing');
  // class order decides: put MGMT first with "match protocol ip" and it takes everything
  const c = getIos(w, 'R1').config;
  c.qos.classMaps[2].matches = [{ kind: 'protocol', protocol: 'ip' }];
  c.qos.policyMaps[0].classes.unshift(c.qos.policyMaps[0].classes.pop()!);
  assert.deepEqual(cls(sendFlow(w, ping('PC1', '10.0.2.10'))), ['LAN_OUT/MGMT']);
});

test('qosPlan: rates from percent, police, shaper forms and problems', () => {
  const w = flatLab();
  const plan = qosPlan(w, 'R1', GI1);
  assert.equal(plan.attached, true);
  assert.equal(plan.bandwidthKbps, 1000000);
  assert.equal(plan.bandwidthConfigured, false);
  assert.equal(plan.physicalBps, 1000000000);
  assert.equal(plan.shapedBps, undefined);
  assert.deepEqual(plan.classes.map((c) => [c.className, c.treatment, c.kbps]), [
    ['GHOST', 'bandwidth', 10],
    ['VOICE', 'priority', 100000],
    ['WEB', 'bandwidth', 300000],
    ['MGMT', 'bandwidth', 450000],     // 50 % of what the priority class leaves
    ['class-default', 'default', undefined],
  ]);
  assert.equal(plan.classes[2].policeBps, 2000000);
  assert.equal(plan.classes[0].match, 'access-group nope (access list not defined)');
  assert.equal(plan.classes[1].match, 'protocol icmp');
  assert.equal(plan.classes[3].match, 'protocol telnet OR protocol snmp');
  assert.equal(plan.classes[4].match, 'everything that no other class matches');
  assert.match(plan.classes[4].text, /Best effort/);
  // "bandwidth" on the interface changes what percent means
  getIos(w, 'R1').config.interfaces[GI1].bandwidthKbps = 10000;
  assert.deepEqual(qosPlan(w, 'R1', GI1).classes.map((c) => c.kbps), [10, 1000, 3000, 4500, undefined]);
  assert.equal(qosPlan(w, 'R1', GI1).physicalBps, 1_000_000_000, 'bandwidth does not set the Ethernet speed');

  // flat shaper in class-default, absolute rate
  const c = getIos(w, 'R1').config;
  c.qos.policyMaps.push({ name: 'SHAPE_ONLY', classes: [{ className: 'class-default', shapeAverage: { bps: 512000 }, fairQueue: true }] });
  c.interfaces[GI1].servicePolicyOut = 'SHAPE_ONLY';
  const flat = qosPlan(w, 'R1', GI1);
  assert.equal(flat.shapedBps, 512000);
  assert.deepEqual(flat.classes.map((x) => [x.policy, x.className, x.treatment]), [['SHAPE_ONLY', 'class-default', 'fair-queue']]);
  // parent refers to a child policy that does not exist
  c.qos.policyMaps.push({ name: 'PARENT', classes: [{ className: 'class-default', shapeAverage: { percent: 50 }, servicePolicy: 'MISSING' }] });
  c.interfaces[GI1].servicePolicyOut = 'PARENT';
  const broken = qosPlan(w, 'R1', GI1);
  assert.equal(broken.shapedBps, 5000000);
  assert.match(broken.problem ?? '', /refers to policy-map MISSING, which does not exist/);
  // child percentages are taken from the parent's shaped rate
  c.qos.policyMaps.push({ name: 'MISSING', classes: [{ className: 'VOICE', priority: { percent: 20 } }] });
  const nested = qosPlan(w, 'R1', GI1);
  assert.deepEqual(nested.classes.map((x) => [x.policy, x.className, x.parentPolicy, x.parentClass, x.kbps]), [
    ['MISSING', 'VOICE', 'PARENT', 'class-default', 1000],
    ['MISSING', 'class-default', 'PARENT', 'class-default', undefined],
  ]);
  // no interface / no device
  assert.equal(qosPlan(w, 'R1', 'Serial9/9/9').attached, false);
  assert.equal(qosPlan(w, 'PC1', 'Ethernet0').attached, false);
  // an interface without any policy
  assert.equal(qosPlan(w, 'R1', GI).problem, 'No service-policy output is attached to GigabitEthernet0/0/0 on R1.');
});

test('qosLoad: what each flow gets when the link is full (LLQ first, guarantees next, the rest shared)', () => {
  const w = referenceLab();
  const offered = [
    { label: 'ping flood', flow: ping('PC1', ADDR.pc3), kbps: 50 },
    { label: 'telnet', flow: tcp('PC1', ADDR.r2Wan, 23), kbps: 100 },
    { label: 'web', flow: tcp('PC1', ADDR.pc3, 80), kbps: 200 },
    { label: 'ftp', flow: tcp('PC1', ADDR.pc3, 21), kbps: 100 },
  ];
  const before = structuredClone(w);
  const r = qosLoad(w, { deviceId: 'R1', iface: SE, offered });
  assert.deepEqual(w, before, 'the tool only probes');
  assert.deepEqual([r.ok, r.linkKbps, r.shapedKbps], [true, 128, 121.6]);
  assert.deepEqual(r.rows.map((x) => [x.label, x.className, x.treatment, x.offeredKbps, x.deliveredKbps]), [
    ['ping flood', 'classPriority', 'priority 16 kbit/s', 50, 16],                    // limited to its priority rate
    ['telnet', 'classGuaranteed', 'bandwidth 48 kbit/s guaranteed', 100, 74.2],       // 48 guaranteed + its share of the rest
    ['web', 'class-default', 'fair-queue (WFQ)', 200, 15.7],                          // the two default flows share equally
    ['ftp', 'class-default', 'fair-queue (WFQ)', 100, 15.7],
  ]);
  const sum = r.rows.reduce((s, x) => s + x.deliveredKbps, 0);
  assert.ok(Math.abs(sum - 121.6) < 0.2, `everything adds up to the shaped rate (${sum})`);
  // light load: nobody loses anything
  const light = qosLoad(w, { deviceId: 'R1', iface: SE, offered: offered.map((o) => ({ ...o, kbps: 10 })) });
  assert.deepEqual(light.rows.map((x) => x.deliveredKbps), [10, 10, 10, 10]);
  // the guaranteed class keeps its 48 kbit/s even when the default class floods the link
  const flood = qosLoad(w, { deviceId: 'R1', iface: SE, offered: [{ label: 'telnet', flow: tcp('PC1', ADDR.r2Wan, 23), kbps: 40 }, { label: 'web', flow: tcp('PC1', ADDR.pc3, 80), kbps: 5000 }] });
  assert.deepEqual(flood.rows.map((x) => x.deliveredKbps), [40, 81.6]);
  // a flow that never reaches the interface is reported as such
  const blocked = qosLoad(w, { deviceId: 'R1', iface: SE, offered: [{ label: 'blocked', flow: ping('PC1', ADDR.r2Lo0), kbps: 30 }, { label: 'local', flow: ping('PC1', ADDR.pc2), kbps: 30 }] });
  assert.deepEqual(blocked.rows.map((x) => [x.className, x.deliveredKbps]), [['—', 0], ['—', 0]]);
  assert.match(blocked.rows[0].treatment, /does not leave through Serial0\/1\/0: R1 drops the packet: access list 110/);
  // the other direction is measured on R2
  const back = qosLoad(w, { deviceId: 'R2', iface: SE, offered: [{ label: 'echo replies', flow: ping('PC1', ADDR.pc3), kbps: 64 }, { label: 'web answers', flow: tcp('PC1', ADDR.pc3, 80), kbps: 500 }] });
  assert.deepEqual(back.rows.map((x) => [x.className, x.deliveredKbps]), [['classPriority', 16], ['class-default', 105.6]]);

  // without a policy there is one queue at the physical rate: everybody loses the same share
  const none = referenceLab({ mutate: (x) => { delete r1(x).config.interfaces[SE].servicePolicyOut; } });
  const fifo = qosLoad(none, { deviceId: 'R1', iface: SE, offered: [{ label: 'ping', flow: ping('PC1', ADDR.pc3), kbps: 64 }, { label: 'web', flow: tcp('PC1', ADDR.pc3, 80), kbps: 192 }] });
  assert.equal(fifo.ok, false);
  assert.equal(fifo.message, 'No service-policy output is attached to Serial0/1/0 on R1.');
  assert.deepEqual([fifo.linkKbps, fifo.shapedKbps], [128, 128]);
  assert.deepEqual(fifo.rows.map((x) => [x.className, x.deliveredKbps]), [['(no policy)', 32], ['(no policy)', 96]]);
});
