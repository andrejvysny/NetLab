/** The order of operations on a router (ARCHITECTURE §6.1) and the quality of the trace. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDR, GI, SE, acl, any, brokenLab, deny, permit, ping, r1, r2, referenceLab, setAcl, snmp, tcp, udp } from './fixtures.ts';
import { dhcpAcquire, sendFlow } from '../../src/engine/sim/index.ts';
import type { FlowSpec, TraceStep, World } from '../../src/engine/types.ts';

const stagesAt = (steps: TraceStep[], dev: string) => steps.filter((s) => s.deviceId === dev).map((s) => s.stage);

test('order on the way out: inbound ACL → routing → NAT inside→outside → crypto map → outbound ACL → QoS → transmit', () => {
  const w = referenceLab({
    mutate: (x) => {
      // an outbound list on the WAN that only lets the tunnel and HTTP out proves that it sees the packet after NAT and encryption
      setAcl(r1(x).config, acl('160', 'extended', [
        permit('esp', { kind: 'host', address: ADDR.r1Wan }, { kind: 'host', address: ADDR.r2Wan }),
        permit('tcp', { kind: 'host', address: ADDR.r1Wan }, any, { dstPort: { op: 'eq', ports: [80] } }),
        permit('udp', any, any, { dstPort: { op: 'eq', ports: [67] } }),
        deny('ip', any, any),
      ]));
      r1(x).config.interfaces[SE].aclOut = '160';
    },
  });
  const f = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.equal(f.ok, true, f.summary);
  assert.deepEqual(stagesAt(f.forward.steps, 'R1'), ['ingress', 'acl-in', 'route', 'nat-inside', 'crypto', 'acl-out', 'qos', 'egress']);
  const out = f.forward.steps.find((s) => s.stage === 'acl-out');
  assert.match(out?.detail ?? '', /permit esp host 60\.50\.30\.1 host 60\.50\.30\.2/, 'the outbound list sees ESP between the tunnel endpoints');
  // the header after each step shows what the step did
  assert.deepEqual(f.forward.steps.filter((s) => s.deviceId === 'R1').map((s) => s.header), [
    'ICMP echo 192.168.100.10 → 60.50.40.2',                                    // ingress
    'ICMP echo 192.168.100.10 → 60.50.40.2',                                    // acl-in: private source
    'ICMP echo 192.168.100.10 → 60.50.40.2',                                    // route
    'ICMP echo 60.50.50.100 → 60.50.40.2',                                      // nat-inside
    'ESP 60.50.30.1 → 60.50.30.2 [ICMP echo 60.50.50.100 → 60.50.40.2]',        // crypto
    'ESP 60.50.30.1 → 60.50.30.2 [ICMP echo 60.50.50.100 → 60.50.40.2]',        // acl-out
    'ESP 60.50.30.1 → 60.50.30.2 [ICMP echo 60.50.50.100 → 60.50.40.2]',        // qos
    'ESP 60.50.30.1 → 60.50.30.2 [ICMP echo 60.50.50.100 → 60.50.40.2]',        // egress
  ]);
  // HTTP from PC2 leaves in clear with the PAT address: permitted by the second entry (source already translated)
  const web = sendFlow(w, tcp('PC2', ADDR.pc3, 80));
  assert.equal(web.ok, true, web.summary);
  assert.match(web.forward.steps.find((s) => s.stage === 'acl-out')?.detail ?? '', /permit tcp host 60\.50\.30\.1 any eq www/);
  // FTP from PC1 is not ESP and not HTTP: dropped by the outbound list, after NAT (the trace shows the public source)
  const ftp = sendFlow(w, tcp('PC1', ADDR.pc3, 21));
  assert.deepEqual([ftp.forward.reason, ftp.symbol], ['acl-out', 'U']);
  assert.equal(ftp.forward.steps.at(-1)?.header, 'TCP SYN 60.50.50.100:49156 → 60.50.40.2:21');
  assert.equal(ftp.reverse?.received?.dst, ADDR.pc1, 'the ICMP error goes to the real sender');
});

test('order on the way in: inbound ACL → decryption → NAT outside→inside → local delivery or routing → outbound ACL', () => {
  const w = referenceLab({
    mutate: (x) => {
      // inbound on the WAN: only the tunnel and IKE; outbound on the LAN: everything (to see the stage)
      setAcl(r1(x).config, acl('170', 'extended', [permit('esp', any, any), permit('udp', any, any, { dstPort: { op: 'eq', ports: [500] } }), permit('udp', any, any, { dstPort: { op: 'eq', ports: [67] } })]));
      r1(x).config.interfaces[SE].aclIn = '170';
      setAcl(r1(x).config, acl('171', 'extended', [permit('ip', any, any)]));
      r1(x).config.interfaces[GI].aclOut = '171';
    },
  });
  const f = sendFlow(w, ping('PC3', ADDR.pc1Public));
  assert.equal(f.ok, true, f.summary);
  assert.deepEqual(stagesAt(f.forward.steps, 'R1'), ['ingress', 'acl-in', 'decrypt', 'nat-outside', 'route', 'acl-out', 'egress']);
  assert.deepEqual(f.forward.steps.filter((s) => s.deviceId === 'R1').map((s) => s.header), [
    'ESP 60.50.30.2 → 60.50.30.1 [ICMP echo 60.50.40.2 → 60.50.50.100]',        // ingress
    'ESP 60.50.30.2 → 60.50.30.1 [ICMP echo 60.50.40.2 → 60.50.50.100]',        // acl-in: checked as ESP
    'ICMP echo 60.50.40.2 → 60.50.50.100',                                      // decrypt (the inner packet is not checked against list 170)
    'ICMP echo 60.50.40.2 → 192.168.100.10',                                    // nat-outside
    'ICMP echo 60.50.40.2 → 192.168.100.10',                                    // route
    'ICMP echo 60.50.40.2 → 192.168.100.10',                                    // acl-out: sees the inside address
    'ICMP echo 60.50.40.2 → 192.168.100.10',                                    // egress
  ]);
  // NAT outside→inside comes before local delivery: 60.50.50.100 is R1's own loopback address, yet PC1 gets the packet
  assert.equal(f.forward.atDeviceId, 'PC1');
  // local delivery comes before routing: a ping to R1's WAN address stops at R1 after decryption
  const own = sendFlow(w, ping('PC3', ADDR.r1Wan));
  assert.deepEqual(stagesAt(own.forward.steps, 'R1'), ['ingress', 'acl-in', 'decrypt', 'local']);
  // clear-text HTTP is stopped by the inbound list before anything else happens
  const web = sendFlow(w, tcp('PC3', ADDR.pc1Public, 80));
  assert.deepEqual(stagesAt(web.forward.steps, 'R1'), ['ingress', 'acl-in']);
  assert.equal(web.forward.reason, 'acl-in');
});

test('packets a router creates itself skip the inbound steps and start at routing', () => {
  const w = referenceLab();
  const f = sendFlow(w, ping('R1', ADDR.pc3));
  assert.deepEqual(stagesAt(f.forward.steps, 'R1'), ['origin', 'route', 'crypto', 'qos', 'egress']);
  assert.equal(f.forward.steps[0].text, 'R1 sends a ping (ICMP echo request) from its address 60.50.30.1 to 60.50.40.2.');
  // sourced from the LAN address it is translated like any inside host (router-originated, egress is outside)
  const g = sendFlow(w, ping('R1', ADDR.pc3, { srcAddr: ADDR.r1Lan }));
  assert.deepEqual(stagesAt(g.forward.steps, 'R1'), ['origin', 'route', 'nat-inside', 'crypto', 'qos', 'egress']);
  assert.equal(g.forward.received?.src, ADDR.r1Wan);
});

test('every trace step is exactly one sentence, names a real device and carries the packet header', () => {
  const flows = (): FlowSpec[] => [
    ping('PC1', ADDR.pc2), ping('PC1', ADDR.pc3), ping('PC2', ADDR.pc3), ping('PC3', ADDR.pc1Public), ping('R1', ADDR.r2Lo0, { srcAddr: ADDR.r1Lo0 }),
    ping('PC1', ADDR.r2Lo0), ping('PC1', '9.9.9.9'), ping('PC1', '192.168.100.77'), ping('PC3', ADDR.r1Wan), ping('R2', ADDR.r1Wan),
    tcp('PC2', ADDR.pc3, 80), tcp('PC2', ADDR.pc3, 21), tcp('PC1', ADDR.r1Lan, 23), tcp('PC1', ADDR.r2Wan, 23), tcp('PC3', ADDR.r1Wan, 23),
    tcp('PC1', ADDR.pc3, 8080), tcp('PC3', ADDR.pc1Public, 80), snmp('PC1', ADDR.r2Wan, 'D105read'), snmp('PC3', ADDR.r1Wan, 'D105write', 'set', 'x'),
    snmp('PC2', ADDR.r1Lan, 'nope'), udp('R2', ADDR.pc1Public, 514), udp('PC1', ADDR.pc3, 9999), udp('R1', ADDR.pc3, 162),
  ];
  const faults: ((x: World) => void)[] = [
    () => {},
    (x) => { r1(x).config.interfaces[GI].shutdown = true; },
    (x) => { r1(x).config.interfaces[SE].encapsulation = 'ppp'; },
    (x) => { r2(x).config.staticRoutes = []; },
    (x) => { delete r1(x).config.interfaces[SE].natRole; },
    (x) => { r1(x).config.nat.staticRules = []; },
    (x) => { r1(x).config.acls['110'].entries.pop(); },
    (x) => { r2(x).config.crypto.isakmpKeys[0].key = 'other'; },
    (x) => { delete r2(x).config.interfaces[SE].cryptoMap; },
    (x) => { delete r2(x).config.interfaces[GI].helperAddresses; },
    (x) => { r1(x).config.interfaces[GI].noIpUnreachables = true; },
    (x) => { r1(x).config.interfaces[SE].aclOut = '110'; },
    (x) => { r1(x).config.crypto.maps[0].entries[0].transformSets = []; },
    (x) => { r2(x).config.interfaces[SE].servicePolicyOut = 'missing'; },
    (x) => { r1(x).config.nat.dynamicRules = [{ acl: '1', pool: 'NOPOOL', overload: true }]; },
  ];
  let count = 0;
  const check = (w: World, steps: TraceStep[], needHeader: boolean) => {
    for (const s of steps) {
      count += 1;
      const plain = s.text.replace(/\d+\.\d+\.\d+\.\d+/g, 'A');
      assert.ok(!/[.!?]["”)]?\s+[A-Z"]/.test(plain), `more than one sentence: "${s.text}"`);
      assert.match(s.text, /[.)]$/, `no full stop: "${s.text}"`);
      assert.ok(s.text.length <= 260, `too long (${s.text.length}): "${s.text}"`);
      assert.ok(w.devices[s.deviceId], `unknown device in step: ${s.deviceId}`);
      assert.ok(['info', 'ok', 'changed', 'drop'].includes(s.verdict));
      if (needHeader) assert.ok(s.header && s.header.includes('→'), `no header on step "${s.text}"`);
    }
  };
  for (const fault of faults) {
    const w = brokenLab(fault, { acquire: false });
    for (const id of ['PC2', 'PC3']) check(w, dhcpAcquire(w, id).steps, false);
    for (const spec of flows()) {
      const r = sendFlow(w, spec);
      check(w, r.forward.steps, true);
      check(w, r.reverse?.steps ?? [], true);
      // a failed delivery always says where and why, and its last step is the drop
      for (const d of [r.forward, r.reverse]) {
        if (!d || d.ok) continue;
        assert.ok(d.reason, `no reason for ${spec.proto} ${spec.fromDeviceId} → ${spec.dst}`);
        assert.ok(d.reasonText && d.reasonText.length > 20);
        assert.ok(d.atDeviceId && w.devices[d.atDeviceId]);
        assert.equal(d.steps.at(-1)?.verdict, 'drop', `last step of a failed delivery (${d.reasonText})`);
      }
    }
  }
  assert.ok(count > 3000, `checked ${count} steps`);
});
