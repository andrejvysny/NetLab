/**
 * Negative tests: the reference lab with exactly one fault. Each fault must produce the expected failure
 * and a reason a student can act on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADDR, GI, SE, acl, any, brokenLab, host, net, pc, permit, ping, r1, r2, recable, referenceLab, setAcl, snmp, stdPermit, tcp, udp,
} from './fixtures.ts';
import {
  dhcpAcquire, emitSyslog, interfaceState, linkInfo, portLed, probeFlow, qosPlan, routingTable, sendFlow, snmpRequest,
  serialClock, staticRouteStatus, syslogProbe, vtyDecision,
} from '../../src/engine/sim/index.ts';

test('wrong Ethernet cable type keeps the link down with strict cables; auto-MDIX accepts it', () => {
  const strict = brokenLab((w) => recable(w, 'PC1', 'Ethernet0', 'crossover'));
  const link = linkInfo(strict, { deviceId: 'PC1', port: 'Ethernet0' });
  assert.equal(link.cabled, true);
  assert.equal(link.usable, false);
  assert.equal(link.problem, 'Crossover cable between a PC and a switch: this pair needs a straight-through cable.');
  assert.deepEqual(interfaceState(strict, 'SW1', 'GigabitEthernet1/0/1'), { status: 'down', protocol: 'down', problem: link.problem });
  assert.equal(portLed(strict, { deviceId: 'PC1', port: 'Ethernet0' }), 'amber');
  const f = sendFlow(strict, ping('PC1', ADDR.pc2));
  assert.equal(f.ok, false);
  assert.equal(f.symbol, '.');
  assert.equal(f.forward.reason, 'no-link');
  assert.match(f.summary, /needs a straight-through cable/);

  const auto = brokenLab((w) => recable(w, 'PC1', 'Ethernet0', 'crossover'), { settings: { strictCables: false } });
  assert.equal(linkInfo(auto, { deviceId: 'PC1', port: 'Ethernet0' }).usable, true);
  assert.equal(sendFlow(auto, ping('PC1', ADDR.pc2)).ok, true);

  // the router–PC link needs the opposite: straight-through is wrong there
  const r2pc3 = brokenLab((w) => recable(w, 'PC3', 'Ethernet0', 'straight'));
  assert.equal(linkInfo(r2pc3, { deviceId: 'R2', port: GI }).problem, 'Straight-through cable between a PC and a router: this pair needs a crossover cable.');
  assert.equal(pc(r2pc3, 'PC3').nic.address, undefined, 'PC3 cannot even get a lease');
  // and the switch–router uplink
  const uplink = brokenLab((w) => recable(w, 'R1', GI, 'crossover'));
  assert.equal(linkInfo(uplink, { deviceId: 'R1', port: GI }).problem, 'Crossover cable between a router and a switch: this pair needs a straight-through cable.');
});

test('interface left shut down', () => {
  const w = brokenLab((x) => { r1(x).config.interfaces[GI].shutdown = true; });
  assert.deepEqual([interfaceState(w, 'R1', GI).status, interfaceState(w, 'R1', GI).protocol], ['administratively down', 'down']);
  assert.match(interfaceState(w, 'R1', GI).problem ?? '', /no shutdown/);
  // the far end sees a dead link
  const sw = interfaceState(w, 'SW1', 'GigabitEthernet1/0/24');
  assert.deepEqual([sw.status, sw.protocol], ['down', 'down']);
  assert.match(sw.problem ?? '', /R1 GigabitEthernet0\/0\/0\) is shut down/);
  // no connected route, PC1 cannot find its gateway, PC2 gets no lease
  assert.ok(!routingTable(w, 'R1').some((r) => r.iface === GI));
  const f = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.equal(f.ok, false);
  assert.equal(f.forward.reason, 'host-unreachable');
  assert.match(f.summary, /default gateway 192\.168\.100\.1/);
  assert.match(f.summary, /administratively down/);
  assert.equal(pc(w, 'PC2').nic.address, undefined);
  assert.match(dhcpAcquire(w, 'PC2').reasonText ?? '', /^No DHCP server answered/);

  // WAN side shut on R2: R1's serial goes down/down and its default route disappears
  const wan = brokenLab((x) => { r2(x).config.interfaces[SE].shutdown = true; });
  assert.deepEqual([interfaceState(wan, 'R1', SE).status, interfaceState(wan, 'R1', SE).protocol], ['down', 'down']);
  assert.equal(routingTable(wan, 'R1').filter((r) => r.code === 'S').length, 0, 'the static route is only installed when usable');
  const status = staticRouteStatus(wan, 'R1');
  assert.equal(status[0].installed, false);
  assert.match(status[0].reason ?? '', /Serial0\/1\/0 is down\/down/);
  const g = sendFlow(wan, ping('PC1', ADDR.pc3));
  assert.equal(g.forward.reason, 'no-route');
  assert.equal(g.symbol, 'U', 'R1 answers with an ICMP unreachable');
});

test('serial encapsulation mismatch: up/down, no routes over the link', () => {
  const w = brokenLab((x) => { r1(x).config.interfaces[SE].encapsulation = 'ppp'; });
  for (const id of ['R1', 'R2']) {
    const s = interfaceState(w, id, SE);
    assert.deepEqual([s.status, s.protocol], ['up', 'down'], id);
    assert.match(s.problem ?? '', /Encapsulation mismatch/);
    assert.match(s.problem ?? '', /PPP/);
    assert.match(s.problem ?? '', /HDLC/);
    assert.ok(!routingTable(w, id).some((r) => r.iface === SE || r.resolved.iface === SE));
  }
  const f = sendFlow(w, ping('PC1', ADDR.r2Wan));
  assert.equal(f.ok, false);
  assert.equal(f.forward.reason, 'no-route');
  assert.match(f.summary, /Encapsulation mismatch/);
  // same encapsulation on both ends works again
  const ok = brokenLab((x) => { r1(x).config.interfaces[SE].encapsulation = 'ppp'; r2(x).config.interfaces[SE].encapsulation = 'ppp'; });
  assert.equal(sendFlow(ok, ping('PC1', ADDR.pc3)).ok, true);
});

test('missing default route on R2: requests arrive, answers die on R2', () => {
  const w = brokenLab((x) => { r2(x).config.staticRoutes = []; });
  assert.equal(routingTable(w, 'R2').filter((r) => r.code === 'S').length, 0);
  const f = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.equal(f.ok, false);
  assert.equal(f.symbol, '.');
  assert.equal(f.forward.ok, true, 'the request reaches PC3');
  assert.equal(f.reverse?.reason, 'no-route');
  assert.equal(f.reverse?.atDeviceId, 'R2');
  assert.match(f.summary, /answer is lost on the way back/);
  assert.match(f.summary, /R2 has no route to 60\.50\.50\.100/);
  assert.match(f.summary, /no default route/);
  // from PC3 the router says so with an ICMP unreachable
  const g = sendFlow(w, ping('PC3', ADDR.pc1Public));
  assert.deepEqual([g.ok, g.symbol, g.forward.reason, g.forward.atDeviceId], [false, 'U', 'no-route', 'R2']);
  // R1's loopback cannot be reached from R2 either
  assert.equal(sendFlow(w, ping('R2', ADDR.r1Lo0)).forward.reason, 'no-route');
});

test('"ip nat outside" missing: nothing is translated and the trace says why', () => {
  const w = brokenLab((x) => { delete r1(x).config.interfaces[SE].natRole; });
  const f = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.equal(f.forward.received?.src, ADDR.pc1, 'PC3 sees the private address');
  const note = f.forward.steps.find((s) => s.feature === 'nat');
  assert.ok(note, 'the trace explains the missing translation');
  assert.equal(note.verdict, 'info');
  assert.match(note.text, /Serial0\/1\/0 \(where it leaves\) is not marked "ip nat outside"/);
  assert.match(note.detail ?? '', /ip nat inside source static 192\.168\.100\.10 60\.50\.50\.100/);
  assert.equal(sendFlow(w, ping('PC2', ADDR.pc3)).forward.received?.src, ADDR.pc2);
  // PC1's public address now ends on R1's loopback instead of PC1
  const g = sendFlow(w, ping('PC3', ADDR.pc1Public));
  assert.equal(g.forward.atDeviceId, 'R1');
  assert.ok(g.forward.steps.some((s) => s.stage === 'nat-outside' && /not marked "ip nat outside"/.test(s.text)));
  // and R2 no longer recognises PC1
  const t = sendFlow(w, tcp('PC1', ADDR.r2Wan, 23));
  assert.equal(t.outcome, 'refused');
  assert.match(t.summary, /from 192\.168\.100\.10/);
  // the same for a missing "ip nat inside"
  const inside = brokenLab((x) => { delete r1(x).config.interfaces[GI].natRole; });
  const h = sendFlow(inside, ping('PC2', ADDR.pc3));
  assert.equal(h.forward.received?.src, ADDR.pc2);
  assert.match(h.forward.steps.find((s) => s.feature === 'nat')?.text ?? '', /GigabitEthernet0\/0\/0 \(where the packet came in\) is not marked "ip nat inside"/);
});

test('NAT access list does not match LAN1: PC2 leaves untranslated', () => {
  const w = brokenLab((x) => setAcl(r1(x).config, acl('1', 'standard', [stdPermit(net('192.168.10.0', '0.0.0.255'))])));
  const f = sendFlow(w, ping('PC2', ADDR.pc3));
  assert.equal(f.forward.received?.src, ADDR.pc2, 'not 60.50.30.1');
  const note = f.forward.steps.find((s) => s.stage === 'nat-inside');
  assert.match(note?.text ?? '', /NAT leaves the source 192\.168\.100\.101 unchanged/);
  assert.match(note?.detail ?? '', /ip nat inside source list 1 interface Serial0\/1\/0 overload: access list 1: no entry matches/);
  assert.equal(r1(w).runtime.natTranslations.filter((t) => t.insideLocal === ADDR.pc2).length, 0);
  // PC1 still uses its static rule
  assert.equal(sendFlow(w, ping('PC1', ADDR.pc3)).forward.received?.src, ADDR.pc1Public);
  // consequences: R2's SNMP ACL would now see the private address
  assert.equal(probeFlow(w, tcp('PC2', ADDR.pc3, 80)).forward.received?.src, ADDR.pc2);
});

test('static NAT missing: PC3 cannot start a session to PC1', () => {
  const w = brokenLab((x) => { r1(x).config.nat.staticRules = []; });
  pc(w, 'PC1').services.http = true;
  const p = sendFlow(w, ping('PC3', ADDR.pc1Public));
  assert.equal(p.forward.atDeviceId, 'R1', 'the ping ends on R1 Loopback100, not on PC1');
  assert.notEqual(p.forward.atDeviceId, 'PC1');
  const t = sendFlow(w, tcp('PC3', ADDR.pc1Public, 80));
  assert.equal(t.ok, false);
  assert.equal(t.forward.atDeviceId, 'R1');
  assert.equal(t.forward.reason, 'port-closed');
  // PC1 now shares the PAT address, so R2 no longer recognises it either
  assert.equal(sendFlow(w, ping('PC1', ADDR.pc3)).forward.received?.src, ADDR.r1Wan);
  assert.equal(sendFlow(w, tcp('PC1', ADDR.r2Wan, 23)).outcome, 'refused');
  // syslog from R2 is no longer delivered to PC1
  assert.deepEqual(syslogProbe(w, 'R2').map((x) => x.received), [false]);
});

test('ACL 110 applied "out" instead of "in": the forbidden traffic passes', () => {
  const w = brokenLab((x) => { const i = r1(x).config.interfaces[GI]; delete i.aclIn; i.aclOut = '110'; });
  const f = sendFlow(w, ping('PC1', ADDR.r2Lo0));
  assert.equal(f.ok, true, 'task 6 is not met any more');
  assert.equal(f.symbol, '!');
  assert.ok(!f.forward.steps.some((s) => s.stage === 'acl-in'));
  assert.equal(sendFlow(w, tcp('PC2', ADDR.pc3, 21)).ok, true, 'task 7 is not met any more');
  // the list is consulted on the way back into LAN1 instead
  const back = f.reverse?.steps.find((s) => s.stage === 'acl-out');
  assert.match(back?.text ?? '', /outbound access list 110 on GigabitEthernet0\/0\/0 permits/);
  assert.match(back?.detail ?? '', /permit ip any any/);
});

test('ACL 110 without the final permit: the implicit deny blocks everything else', () => {
  const w = brokenLab((x) => { r1(x).config.acls['110'].entries.pop(); }, { acquire: false });
  const f = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.deepEqual([f.ok, f.symbol, f.forward.reason], [false, 'U', 'acl-in']);
  assert.match(f.summary, /has no entry that permits it, so the implicit deny at the end applies/);
  assert.match(f.forward.steps.at(-1)?.detail ?? '', /implicit "deny ip any any"/);
  // even the router itself and DHCP are cut off
  assert.equal(sendFlow(w, ping('PC1', ADDR.r1Lan)).forward.reason, 'acl-in');
  const lease = dhcpAcquire(w, 'PC2');
  assert.equal(lease.ok, false);
  assert.match(lease.reasonText ?? '', /access list 110, applied inbound on GigabitEthernet0\/0\/0, does not permit it/);
});

test('ISAKMP key mismatch', () => {
  const w = brokenLab((x) => { r2(x).config.crypto.isakmpKeys[0].key = 'KSS124'; });
  const f = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.deepEqual([f.ok, f.symbol, f.forward.reason, f.forward.atDeviceId], [false, '.', 'ipsec-negotiation-failed', 'R1']);
  assert.match(f.summary, /pre-shared keys do not match/);
  assert.doesNotMatch(f.summary, /KSS123|KSS124/, 'diagnostics identify the mismatch without printing keys');
  assert.equal(r1(w).runtime.ipsecSas.length, 0);
  assert.deepEqual(r1(w).runtime.ikeSas.map((s) => s.state), ['MM_NO_STATE']);
  // traffic that is not selected for encryption still flows
  assert.equal(sendFlow(w, tcp('PC1', ADDR.pc3, 80)).ok, true);
  // from the other side as well
  assert.equal(sendFlow(w, ping('PC3', ADDR.r1Wan)).forward.reason, 'ipsec-negotiation-failed');
  // a missing key is reported differently
  const none = brokenLab((x) => { r2(x).config.crypto.isakmpKeys = []; });
  assert.match(sendFlow(none, ping('PC1', ADDR.pc3)).summary, /R2 has no pre-shared key for 60\.50\.30\.1/);
});

test('ISAKMP policy mismatch', () => {
  const w = brokenLab((x) => { r2(x).config.crypto.isakmpPolicies[0].group = 5; });
  const f = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.equal(f.forward.reason, 'ipsec-negotiation-failed');
  assert.match(f.summary, /no ISAKMP policy in common/);
  assert.match(f.summary, /R1 offers policy 10 \(aes, sha, pre-share, group 2\)/);
  assert.match(f.summary, /R2 has policy 10 \(aes, sha, pre-share, group 5\)/);
  for (const mut of [
    (x: ReturnType<typeof referenceLab>) => { r2(x).config.crypto.isakmpPolicies[0].encryption = '3des'; },
    (x: ReturnType<typeof referenceLab>) => { r2(x).config.crypto.isakmpPolicies[0].hash = 'md5'; },
    (x: ReturnType<typeof referenceLab>) => { r2(x).config.crypto.isakmpPolicies = []; },
    (x: ReturnType<typeof referenceLab>) => { r1(x).config.crypto.isakmpEnabled = false; },
  ]) {
    assert.equal(sendFlow(brokenLab(mut), ping('PC1', ADDR.pc3)).forward.reason, 'ipsec-negotiation-failed');
  }
  // a second, matching policy with another number is enough
  const extra = brokenLab((x) => {
    r2(x).config.crypto.isakmpPolicies[0].group = 5;
    r2(x).config.crypto.isakmpPolicies.push({ priority: 20, encryption: 'aes', hash: 'sha', authentication: 'pre-share', group: 2, lifetime: 3600 });
  });
  assert.equal(sendFlow(extra, ping('PC1', ADDR.pc3)).ok, true);
});

test('transform-set mismatch', () => {
  const w = brokenLab((x) => { r2(x).config.crypto.transformSets[0].transforms = ['esp-3des', 'esp-md5-hmac']; });
  const f = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.equal(f.forward.reason, 'ipsec-negotiation-failed');
  assert.match(f.summary, /no transform-set in common/);
  assert.match(f.summary, /R1 offers TS \(esp-aes esp-sha-hmac, tunnel\)/);
  assert.match(f.summary, /R2 accepts TS \(esp-3des esp-md5-hmac, tunnel\)/);
  // phase 1 was fine: the ISAKMP SA exists, only the IPsec SA is missing
  assert.deepEqual(r1(w).runtime.ikeSas.map((s) => s.state), ['QM_IDLE']);
  assert.equal(r1(w).runtime.ipsecSas.length, 0);
  // the mode is part of the transform-set
  const mode = brokenLab((x) => { r2(x).config.crypto.transformSets[0].mode = 'transport'; });
  assert.match(sendFlow(mode, ping('PC1', ADDR.pc3)).summary, /no transform-set in common/);
});

test('crypto ACL not mirrored on R2', () => {
  const w = brokenLab((x) => setAcl(r2(x).config, acl('120', 'extended', [permit('ip', net('60.50.40.0', '0.0.0.63'), net('192.168.100.0', '0.0.0.255'))])));
  const f = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.equal(f.forward.reason, 'ipsec-negotiation-failed');
  assert.match(f.summary, /crypto access list 120 on R2 has no entry that mirrors "permit icmp any any" of R1/);
  // R2 does not select the reply for encryption, so R1 refuses it in clear text
  const g = sendFlow(w, ping('PC3', ADDR.r1Wan));
  assert.equal(g.forward.reason, 'ipsec-expected');
  assert.equal(g.forward.atDeviceId, 'R1');
  assert.match(g.summary, /arrived on Serial0\/1\/0 without encryption/);

  // one missing mirror line breaks exactly that kind of traffic
  const partial = brokenLab((x) => { r2(x).config.acls['120'].entries = r2(x).config.acls['120'].entries.filter((e) => !(e.protocol === 'udp' && e.srcPort?.ports[0] === 161)); });
  assert.equal(sendFlow(partial, ping('PC1', ADDR.pc3)).ok, true, 'ICMP still has its mirror');
  const s = sendFlow(partial, snmp('PC1', ADDR.r2Wan, 'D105read'));
  assert.equal(s.forward.reason, 'ipsec-negotiation-failed');
  assert.match(s.summary, /"permit udp any eq snmp any"/, 'names the entry R2 needs');
});

test('crypto map not applied on one side', () => {
  const w = brokenLab((x) => { delete r2(x).config.interfaces[SE].cryptoMap; });
  const f = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.equal(f.forward.reason, 'ipsec-negotiation-failed');
  assert.match(f.summary, /R2 has no crypto map on Serial0\/1\/0/);
  // R2 sends in clear; R1 expects ESP and drops (and logs it)
  const g = sendFlow(w, ping('R2', ADDR.r1Wan));
  assert.deepEqual([g.ok, g.symbol, g.forward.reason, g.forward.atDeviceId], [false, '.', 'ipsec-expected', 'R1']);
  assert.ok(r1(w).runtime.logBuffer.some((m) => m.mnemonic === 'CRYPTO-4-RECVD_PKT_NOT_IPSEC'));
  // unprotected traffic is unaffected
  assert.equal(sendFlow(w, tcp('PC1', ADDR.pc3, 80)).ok, true);

  // missing on R1 instead: R1 sends clear text, R2 drops it
  const other = brokenLab((x) => { delete r1(x).config.interfaces[SE].cryptoMap; });
  const h = sendFlow(other, ping('PC1', ADDR.pc3));
  assert.deepEqual([h.forward.reason, h.forward.atDeviceId, h.forward.encrypted], ['ipsec-expected', 'R2', false]);
});

test('"ip helper-address" missing or on the wrong interface', () => {
  const missing = brokenLab((x) => { delete r2(x).config.interfaces[GI].helperAddresses; });
  assert.equal(pc(missing, 'PC3').nic.address, undefined);
  const a = dhcpAcquire(missing, 'PC3');
  assert.equal(a.ok, false);
  assert.equal(a.reasonText, 'No DHCP server answered: R2 hears the request on GigabitEthernet0/0/0 but has no pool for 60.50.40.0/26 and no ip helper-address there.');
  assert.equal(sendFlow(missing, ping('PC3', ADDR.r2Lan)).forward.reason, 'no-ip');

  const wrong = brokenLab((x) => {
    delete r2(x).config.interfaces[GI].helperAddresses;
    r2(x).config.interfaces[SE].helperAddresses = [ADDR.r1Wan];
  });
  const b = dhcpAcquire(wrong, 'PC3');
  assert.equal(b.ok, false);
  assert.match(b.reasonText ?? '', /no ip helper-address there/);
  assert.match(b.reasonText ?? '', /"ip helper-address 60\.50\.30\.1" is configured on Serial0\/1\/0, but the request arrives on GigabitEthernet0\/0\/0/);

  // helper points at a router that is not a DHCP server for that network
  const noPool = brokenLab((x) => { r1(x).config.dhcp.pools = r1(x).config.dhcp.pools.filter((p) => p.name !== 'LAN2'); });
  assert.match(dhcpAcquire(noPool, 'PC3').reasonText ?? '', /R1 receives the relayed request but has no DHCP pool for 60\.50\.40\.0\/26/);
  // helper points at an address nobody has
  const lost = brokenLab((x) => { r2(x).config.interfaces[GI].helperAddresses = ['60.50.30.3']; });
  assert.match(dhcpAcquire(lost, 'PC3').reasonText ?? '', /R2 forwards the request to 60\.50\.30\.3 .* but it does not arrive/);
});

test('DHCP exclusion missing: PC2 gets .2', () => {
  const w = brokenLab((x) => { r1(x).config.dhcp.excluded = []; }, { acquire: false });
  const lease = dhcpAcquire(w, 'PC2');
  assert.equal(lease.address, '192.168.100.2');
  // .1 was skipped only because the router itself answered the test ping
  assert.ok(lease.steps.some((s) => /pings 192\.168\.100\.1 before offering it: R1 answers/.test(s.text)));
  // a partial exclusion is honoured exactly
  const part = brokenLab((x) => { r1(x).config.dhcp.excluded = [{ low: '192.168.100.1', high: '192.168.100.50' }]; });
  assert.equal(pc(part, 'PC2').nic.address, '192.168.100.51');
});

test('service-policy missing or attached as input', () => {
  const none = brokenLab((x) => { delete r1(x).config.interfaces[SE].servicePolicyOut; });
  const f = sendFlow(none, ping('PC1', ADDR.pc3));
  assert.equal(f.ok, true);
  assert.equal(f.forward.qos.length, 0, 'nothing classifies on R1');
  assert.equal(f.reverse?.qos.length, 1, 'R2 still does');
  const plan = qosPlan(none, 'R1', SE);
  assert.equal(plan.attached, false);
  assert.equal(plan.problem, 'No service-policy output is attached to Serial0/1/0 on R1.');
  assert.equal(plan.shapedBps, undefined);
  assert.equal(plan.physicalBps, 128000);

  const input = brokenLab((x) => { const i = r1(x).config.interfaces[SE]; i.servicePolicyIn = i.servicePolicyOut; delete i.servicePolicyOut; });
  assert.equal(sendFlow(input, ping('PC1', ADDR.pc3)).forward.qos.length, 0);
  const p2 = qosPlan(input, 'R1', SE);
  assert.equal(p2.attached, false);
  assert.match(p2.problem ?? '', /attached to Serial0\/1\/0 as input/);
  assert.match(p2.problem ?? '', /service-policy output output_SE/);

  // attached, but the policy-map does not exist
  const ghost = brokenLab((x) => { r1(x).config.interfaces[SE].servicePolicyOut = 'output_XX'; });
  assert.match(qosPlan(ghost, 'R1', SE).problem ?? '', /policy-map output_XX does not exist/);
  // bandwidth not set: the shaper works on the default 1544 kbit/s
  const bw = brokenLab((x) => { delete r1(x).config.interfaces[SE].bandwidthKbps; });
  assert.equal(qosPlan(bw, 'R1', SE).shapedBps, 1466800);
  assert.equal(qosPlan(bw, 'R1', SE).bandwidthConfigured, false);
  // No explicit clock rate: use the nominal DCE default, not the interface bandwidth metadata.
  const clock = brokenLab((x) => { delete r1(x).config.interfaces[SE].clockRate; });
  assert.equal(qosPlan(clock, 'R2', SE).clockRateBps, undefined);
  assert.equal(qosPlan(clock, 'R2', SE).physicalBps, serialClock(clock, 'R2', SE)?.effective);
});

test('vty without password versus access-class denying', () => {
  // no password: the TCP connection is accepted, the login then fails
  const nopw = brokenLab((x) => { for (const l of r1(x).config.lines.vty) delete l.password; });
  const f = sendFlow(nopw, tcp('PC1', ADDR.r1Lan, 23));
  assert.equal(f.ok, true);
  assert.equal(f.outcome, 'ok');
  assert.equal(f.vty?.accepted, true);
  assert.equal(f.vty?.login, 'password-not-set');
  assert.match(f.summary, /Password required, but none set/);

  // access-class denies: the connection itself is refused
  const denied = brokenLab((x) => setAcl(r1(x).config, acl('allowPC1', 'standard', [stdPermit(host('192.168.100.11'))], true)));
  const g = sendFlow(denied, tcp('PC1', ADDR.r1Lan, 23));
  assert.equal(g.ok, false);
  assert.equal(g.outcome, 'refused');
  assert.equal(g.forward.reason, 'service-denied');
  assert.equal(g.vty?.accepted, false);
  assert.equal(g.vty?.reason, 'access-class');
  assert.match(g.summary, /"access-class allowPC1 in" on line vty 0 4 does not permit that address/);

  // R2 with the private address of PC1 in its list (the classic mistake)
  const priv = brokenLab((x) => setAcl(r2(x).config, acl('allowPC1', 'standard', [stdPermit(host(ADDR.pc1))], true)));
  assert.equal(sendFlow(priv, tcp('PC1', ADDR.r2Wan, 23)).outcome, 'refused');
  assert.match(vtyDecision(priv, 'R2', ADDR.pc1Public).text, /does not permit that address/);

  // other vty faults
  const transport = brokenLab((x) => { for (const l of r1(x).config.lines.vty) l.transportInput = 'ssh'; });
  const t = sendFlow(transport, tcp('PC1', ADDR.r1Lan, 23));
  assert.deepEqual([t.outcome, t.vty?.reason], ['refused', 'transport-input']);
  const noLogin = brokenLab((x) => { for (const l of r1(x).config.lines.vty) l.login = false; });
  assert.equal(sendFlow(noLogin, tcp('PC1', ADDR.r1Lan, 23)).vty?.login, 'none');
  const noLines = brokenLab((x) => { r1(x).config.lines.vty = []; });
  assert.deepEqual([sendFlow(noLines, tcp('PC1', ADDR.r1Lan, 23)).outcome, vtyDecision(noLines, 'R1', ADDR.pc1).reason], ['refused', 'no-vty']);
});

test('SNMP community ACL denying', () => {
  const w = brokenLab((x) => setAcl(r1(x).config, acl('10', 'standard', [stdPermit(host('192.168.100.99'))])));
  const r = snmpRequest(w, 'PC1', { host: ADDR.r1Lan, community: 'D105read', op: 'get', oid: 'sysName' });
  assert.equal(r.ok, false);
  assert.equal(r.text, 'Timeout: No Response from 192.168.100.1');
  assert.equal(r.flow.forward.reason, 'service-denied');
  assert.equal(r.flow.symbol, '.');
  assert.match(r.flow.summary, /access list 10 of community "D105read" does not permit the source 192\.168\.100\.10/);
  // the write community has its own list and still works
  assert.equal(snmpRequest(w, 'PC1', { host: ADDR.r1Lan, community: 'D105write', op: 'set', oid: 'sysContact', value: 'me' }).ok, true);
  // unknown community and no SNMP at all
  assert.match(sendFlow(w, snmp('PC1', ADDR.r1Lan, 'public')).summary, /community "public" is not configured/);
  const off = brokenLab((x) => { r1(x).config.snmp.communities = []; });
  const closed = sendFlow(off, snmp('PC1', ADDR.r1Lan, 'D105read'));
  assert.deepEqual([closed.forward.reason, closed.symbol], ['service-denied', '.']);
  assert.match(closed.summary, /SNMP is not enabled on R1 \(no "snmp-server community"\)/);
  // R2 with PC1's private address in ACL 10: PC1 arrives as 60.50.50.100 and is refused
  const priv = brokenLab((x) => setAcl(r2(x).config, acl('10', 'standard', [stdPermit(host(ADDR.pc1)), stdPermit(host(ADDR.pc3))])));
  assert.equal(snmpRequest(priv, 'PC1', { host: ADDR.r2Wan, community: 'D105read', op: 'get', oid: 'sysName' }).ok, false);
  assert.equal(snmpRequest(priv, 'PC3', { host: ADDR.r2Wan, community: 'D105read', op: 'get', oid: 'sysName' }).ok, true);
});

test('logging host unreachable', () => {
  const w = brokenLab((x) => { r1(x).config.logging.hosts = ['192.168.100.99']; r2(x).config.logging.hosts = ['60.50.50.99']; });
  emitSyslog(w, 'R1', 5, 'SYS-5-CONFIG_I', 'Configured from console by console');
  emitSyslog(w, 'R2', 5, 'SYS-5-CONFIG_I', 'Configured from console by console');
  assert.equal(pc(w, 'PC1').runtime.syslog.length, 0);
  assert.equal(r1(w).runtime.logBuffer.length, 1, 'the message is still in the local buffer');
  const p1 = syslogProbe(w, 'R1')[0];
  assert.equal(p1.received, false);
  assert.equal(p1.flow.forward.reason, 'host-unreachable');
  assert.match(p1.flow.summary, /No device in the lab has the address 192\.168\.100\.99/);
  // R2 logs to an address nobody has: the packet bounces between the two default routes
  const p2 = syslogProbe(w, 'R2')[0];
  assert.equal(p2.received, false);
  assert.equal(p2.flow.forward.reason, 'ttl-expired');
  assert.match(p2.flow.summary, /Routing loop/);

  // syslog server switched off on PC1
  const off = brokenLab((x) => { pc(x, 'PC1').services.syslog = false; });
  const p3 = syslogProbe(off, 'R1')[0];
  assert.equal(p3.received, false);
  assert.match(p3.flow.summary, /syslog server on PC1 is switched off/);
  // source interface missing: the message arrives, but from the wrong address
  const src = brokenLab((x) => { delete r2(x).config.logging.sourceInterface; });
  assert.deepEqual(syslogProbe(src, 'R2').map((x) => [x.received, x.seenFrom]), [[true, ADDR.r2Wan]]);
  // severity filter
  const trap = brokenLab((x) => { r1(x).config.logging.trapLevel = 'errors'; });
  emitSyslog(trap, 'R1', 5, 'SYS-5-CONFIG_I', 'not sent: notifications are below errors');
  emitSyslog(trap, 'R1', 3, 'LINK-3-UPDOWN', 'Interface Serial0/1/0, changed state to up');
  assert.deepEqual(pc(trap, 'PC1').runtime.syslog.map((m) => m.mnemonic), ['LINK-3-UPDOWN']);
  assert.equal(r1(trap).runtime.logBuffer.length, 2);
  void udp; void any;
});
