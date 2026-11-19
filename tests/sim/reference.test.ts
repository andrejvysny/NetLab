/**
 * Acceptance: every bullet of "What must be true when this solution is loaded" in docs/COURSE.md,
 * asserted against the reference lab built in fixtures.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDR, GI, SE, bringUp, pc, ping, r1, r2, referenceLab, snmp, tcp, udp } from './fixtures.ts';
import {
  dhcpAcquire, emitSyslog, interfaceState, probeFlow, qosPlan, routingTable, sendFlow, snmpRequest, syslogProbe, vtyDecision,
} from '../../src/engine/sim/index.ts';
import type { Delivery } from '../../src/engine/types.ts';

const lab = () => referenceLab();

function wanClass(d: Delivery, router: 'R1' | 'R2') {
  return d.qos.find((q) => q.deviceId === router && q.iface === SE);
}

test('all reference links are up', () => {
  const w = lab();
  for (const [dev, ifName] of [['R1', GI], ['R1', SE], ['R2', GI], ['R2', SE], ['R1', 'Loopback0'], ['R1', 'Loopback100'], ['R2', 'Loopback0'],
    ['SW1', 'GigabitEthernet1/0/1'], ['SW1', 'GigabitEthernet1/0/2'], ['SW1', 'GigabitEthernet1/0/24'], ['PC1', 'Ethernet0'], ['PC3', 'Ethernet0']]) {
    const s = interfaceState(w, dev, ifName);
    assert.deepEqual([s.status, s.protocol], ['up', 'up'], `${dev} ${ifName}: ${s.problem}`);
  }
});

test('DHCP: PC2 leases 192.168.100.101, PC3 leases 60.50.40.2 through the relay', () => {
  const w = referenceLab({ acquire: false });
  const { pc2, pc3 } = bringUp(w);
  assert.equal(pc2.ok, true, pc2.reasonText ?? '');
  assert.equal(pc2.address, '192.168.100.101');
  assert.equal(pc2.mask, '255.255.255.0');
  assert.equal(pc2.gateway, '192.168.100.1');
  assert.equal(pc2.server, '192.168.100.1');
  assert.deepEqual(
    { address: pc(w, 'PC2').nic.address, mask: pc(w, 'PC2').nic.mask, gateway: pc(w, 'PC2').nic.gateway, server: pc(w, 'PC2').nic.dhcpServer },
    { address: '192.168.100.101', mask: '255.255.255.0', gateway: '192.168.100.1', server: '192.168.100.1' });
  assert.ok(pc2.steps.some((s) => s.detail === 'ip dhcp excluded-address 192.168.100.1 192.168.100.100'), 'the exclusion is named in the trace');

  assert.equal(pc3.ok, true, pc3.reasonText ?? '');
  assert.equal(pc3.address, '60.50.40.2');
  assert.equal(pc3.mask, '255.255.255.192');
  assert.equal(pc3.gateway, '60.50.40.1');
  assert.equal(pc3.server, '60.50.30.1', 'the server is R1, reached through the helper address');
  // the relay and the ping-before-offer conflict check are visible in the trace
  assert.ok(pc3.steps.some((s) => s.deviceId === 'R2' && /ip helper-address 60\.50\.30\.1/.test(s.text)));
  const skip = pc3.steps.find((s) => /pings 60\.50\.40\.1 before offering/.test(s.text));
  assert.equal(skip?.text, 'R1 pings 60.50.40.1 before offering it: R2 answers, so the address is in use and is skipped.');
  // bindings live on R1 only
  assert.deepEqual(r1(w).runtime.dhcpBindings.map((b) => [b.address, b.pool]), [['192.168.100.101', 'LAN1'], ['60.50.40.2', 'LAN2']]);
  assert.equal(r2(w).runtime.dhcpBindings.length, 0);
  // asking again gives the same addresses
  assert.equal(dhcpAcquire(w, 'PC2').address, '192.168.100.101');
  assert.equal(dhcpAcquire(w, 'PC3').address, '60.50.40.2');
});

test('routing tables: connected and local routes plus exactly one static default route', () => {
  const w = lab();
  for (const [id, nextHop] of [['R1', ADDR.r2Wan], ['R2', ADDR.r1Wan]] as const) {
    const table = routingTable(w, id);
    const statics = table.filter((r) => r.code === 'S');
    assert.equal(statics.length, 1, `${id} has exactly one static route`);
    assert.equal(statics[0].isDefault, true);
    assert.equal(`${statics[0].prefix}/${statics[0].prefixLen}`, '0.0.0.0/0');
    assert.equal(statics[0].nextHop, nextHop);
    assert.equal(statics[0].iface, SE);
    assert.ok(table.every((r) => ['C', 'L', 'S'].includes(r.code)), 'no dynamic routes');
  }
  const net = (id: string, code: string) => routingTable(w, id).filter((r) => r.code === code).map((r) => `${r.prefix}/${r.prefixLen} ${r.iface}`);
  assert.deepEqual(net('R1', 'C'), ['1.1.1.1/32 Loopback0', `60.50.30.0/30 ${SE}`, '60.50.50.100/32 Loopback100', `192.168.100.0/24 ${GI}`]);
  assert.deepEqual(net('R1', 'L'), [`60.50.30.1/32 ${SE}`, `192.168.100.1/32 ${GI}`]);
  assert.deepEqual(net('R2', 'C'), ['2.2.2.2/32 Loopback0', `60.50.30.0/30 ${SE}`, `60.50.40.0/26 ${GI}`]);
  assert.deepEqual(net('R2', 'L'), [`60.50.30.2/32 ${SE}`, `60.50.40.1/32 ${GI}`]);
  // sorted like show ip route: the default route comes first
  assert.equal(routingTable(w, 'R1')[0].code, 'S');
});

test('PC1 and PC2 ping each other inside LAN1 without touching the router', () => {
  const w = lab();
  for (const [from, to] of [['PC1', ADDR.pc2], ['PC2', ADDR.pc1]] as const) {
    const f = sendFlow(w, ping(from, to));
    assert.equal(f.ok, true, f.summary);
    assert.equal(f.symbol, '!');
    assert.ok(!f.forward.steps.some((s) => s.deviceId === 'R1'), 'same LAN: the router is not involved');
    assert.ok(f.forward.steps.some((s) => s.stage === 'switch' && s.deviceId === 'SW1'));
  }
});

test('PC1 → PC3 ping works and PC3 sees 60.50.50.100 (static NAT)', () => {
  const w = lab();
  const f = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.equal(f.ok, true, f.summary);
  assert.equal(f.forward.atDeviceId, 'PC3');
  assert.equal(f.forward.received?.src, '60.50.50.100');
  assert.equal(f.reverse?.atDeviceId, 'PC1');
  assert.equal(f.reverse?.received?.dst, ADDR.pc1, 'the reply is translated back');
  const nat = f.forward.steps.find((s) => s.stage === 'nat-inside');
  assert.equal(nat?.detail, 'ip nat inside source static 192.168.100.10 60.50.50.100');
  assert.equal(nat?.header, 'ICMP echo 60.50.50.100 → 60.50.40.2');
});

test('PC2 → PC3 ping works and PC3 sees 60.50.30.1 (PAT on the WAN address)', () => {
  const w = lab();
  const f = sendFlow(w, ping('PC2', ADDR.pc3));
  assert.equal(f.ok, true, f.summary);
  assert.equal(f.forward.received?.src, '60.50.30.1');
  assert.equal(f.reverse?.received?.dst, ADDR.pc2);
  const nat = f.forward.steps.find((s) => s.stage === 'nat-inside');
  assert.match(nat?.detail ?? '', /ip nat inside source list 1 interface Serial0\/1\/0 overload/);
  assert.match(nat?.detail ?? '', /access-list 1 permit 192\.168\.100\.0 0\.0\.0\.255/);
});

test('PC3 → 60.50.50.100 reaches PC1: ping and every TCP service PC1 runs (session started from outside)', () => {
  const w = lab();
  const f = sendFlow(w, ping('PC3', ADDR.pc1Public));
  assert.equal(f.ok, true, f.summary);
  assert.equal(f.forward.atDeviceId, 'PC1');
  assert.equal(f.forward.received?.dst, ADDR.pc1);
  assert.equal(f.reverse?.received?.src, ADDR.pc1Public, 'PC3 gets the answer from the public address');

  pc(w, 'PC1').services.http = true;
  pc(w, 'PC1').services.ftp = true;
  pc(w, 'PC1').services.telnet = true;
  for (const port of [80, 21, 23]) {
    const t = sendFlow(w, tcp('PC3', ADDR.pc1Public, port));
    assert.equal(t.ok, true, `TCP ${port}: ${t.summary}`);
    assert.equal(t.forward.atDeviceId, 'PC1');
    assert.equal(t.reverse?.received?.src, ADDR.pc1Public);
  }
  // a service PC1 does not run is refused by PC1 itself (the packet still gets there)
  pc(w, 'PC1').services.ftp = false;
  const closed = sendFlow(w, tcp('PC3', ADDR.pc1Public, 21));
  assert.equal(closed.ok, false);
  assert.equal(closed.outcome, 'refused');
  assert.equal(closed.forward.atDeviceId, 'PC1');
});

test('R1 ping 2.2.2.2 source Loopback0 works', () => {
  const w = lab();
  const f = sendFlow(w, ping('R1', ADDR.r2Lo0, { srcAddr: ADDR.r1Lo0 }));
  assert.equal(f.ok, true, f.summary);
  assert.equal(f.forward.atDeviceId, 'R2');
  assert.equal(f.forward.received?.src, '1.1.1.1');
  assert.equal(f.reverse?.atDeviceId, 'R1');
});

test('PC1 → 2.2.2.2 is dropped by ACL 110 on R1 (symbol U)', () => {
  const w = lab();
  const f = sendFlow(w, ping('PC1', ADDR.r2Lo0));
  assert.equal(f.ok, false);
  assert.equal(f.symbol, 'U');
  assert.equal(f.outcome, 'unreachable');
  assert.equal(f.forward.reason, 'acl-in');
  assert.equal(f.forward.atDeviceId, 'R1');
  assert.equal(f.unreachableFrom, ADDR.r1Lan);
  const drop = f.forward.steps.at(-1)!;
  assert.equal(drop.stage, 'acl-in');
  assert.equal(drop.verdict, 'drop');
  assert.match(drop.detail ?? '', /access-list 110 deny ip host 192\.168\.100\.10 host 2\.2\.2\.2/);
  // every protocol is blocked, not only ping
  assert.equal(sendFlow(w, tcp('PC1', ADDR.r2Lo0, 23)).forward.reason, 'acl-in');
  assert.equal(r1(w).runtime.aclHits['110:10'], 2, 'hit counter of the deny entry');
});

test('PC2 → PC3: ICMP and HTTP pass, FTP and Telnet are dropped by ACL 110; PC2 → PC1 and PC2 → R2 WAN are unaffected', () => {
  const w = lab();
  assert.equal(sendFlow(w, ping('PC2', ADDR.pc3)).ok, true);
  const http = sendFlow(w, tcp('PC2', ADDR.pc3, 80));
  assert.equal(http.ok, true, http.summary);
  assert.equal(http.forward.atDeviceId, 'PC3');
  for (const port of [21, 23]) {
    const f = sendFlow(w, tcp('PC2', ADDR.pc3, port));
    assert.equal(f.ok, false, `TCP ${port} must be blocked`);
    assert.equal(f.forward.reason, 'acl-in');
    assert.equal(f.forward.atDeviceId, 'R1');
    assert.equal(f.symbol, 'U');
    assert.match(f.forward.steps.at(-1)?.detail ?? '', /access-list 110 deny ip host 192\.168\.100\.101 60\.50\.40\.0 0\.0\.0\.63/);
  }
  assert.equal(sendFlow(w, ping('PC2', ADDR.pc1)).ok, true);
  assert.equal(sendFlow(w, tcp('PC2', ADDR.r2Wan, 80)).forward.atDeviceId, 'R2', 'not filtered: reaches R2');
  const wan = sendFlow(w, ping('PC2', ADDR.r2Wan));
  assert.equal(wan.ok, true, wan.summary);
  // PC1 is not restricted towards LAN2
  assert.equal(sendFlow(w, tcp('PC1', ADDR.pc3, 21)).ok, true);
});

test('WAN link: ICMP, TCP 22/23 and UDP 161/162 travel inside ESP; HTTP, FTP, DHCP relay and syslog travel in clear', () => {
  const w = lab();
  const enc = (d: Delivery) => d.encrypted;
  // encrypted
  assert.equal(enc(sendFlow(w, ping('PC1', ADDR.pc3)).forward), true, 'ICMP');
  assert.equal(enc(sendFlow(w, tcp('PC1', ADDR.r2Wan, 23)).forward), true, 'Telnet');
  assert.equal(enc(sendFlow(w, tcp('PC1', ADDR.r2Wan, 22)).forward), true, 'SSH');
  assert.equal(enc(sendFlow(w, tcp('PC1', ADDR.pc3, 22)).forward), true, 'SSH to a host behind R2');
  const snmpFlow = sendFlow(w, snmp('PC1', ADDR.r2Wan, 'D105read'));
  assert.equal(enc(snmpFlow.forward), true, 'SNMP request');
  assert.equal(enc(snmpFlow.reverse!), true, 'SNMP response');
  assert.equal(enc(sendFlow(w, udp('R2', ADDR.pc1Public, 162)).forward), true, 'SNMP trap');
  const telnet = sendFlow(w, tcp('PC1', ADDR.r2Wan, 23));
  assert.equal(enc(telnet.reverse!), true, 'Telnet answer');
  // the ESP header is visible in the trace: tunnel endpoints are the WAN addresses
  const esp = sendFlow(w, ping('PC1', ADDR.pc3)).forward.steps.find((s) => s.stage === 'crypto' && s.verdict === 'changed');
  assert.equal(esp?.header, 'ESP 60.50.30.1 → 60.50.30.2 [ICMP echo 60.50.50.100 → 60.50.40.2]');

  // clear
  const http = sendFlow(w, tcp('PC1', ADDR.pc3, 80));
  assert.deepEqual([http.ok, enc(http.forward), enc(http.reverse!)], [true, false, false], 'HTTP');
  const ftp = sendFlow(w, tcp('PC1', ADDR.pc3, 21));
  assert.deepEqual([ftp.ok, enc(ftp.forward), enc(ftp.reverse!)], [true, false, false], 'FTP');
  for (const p of syslogProbe(w, 'R2')) assert.deepEqual([p.received, enc(p.flow.forward)], [true, false], 'syslog');
  // DHCP relay: the relayed request and the answer cross the WAN without ESP
  const again = dhcpAcquire(w, 'PC3');
  assert.equal(again.ok, true);
  const wanSteps = again.steps.filter((s) => s.stage === 'egress' && s.iface === SE);
  assert.equal(wanSteps.length, 2, 'request and offer cross the serial link');
  assert.ok(wanSteps.every((s) => /^UDP DHCP/.test(s.header ?? '')), 'both are plain UDP, not ESP');
  assert.equal(enc(sendFlow(w, udp('R2', ADDR.r1Wan, 67, { sport: 67, srcAddr: ADDR.r2Lan, app: { kind: 'dhcp', op: 'discover', clientId: 'x', giaddr: ADDR.r2Lan } })).forward), false);
});

test('WAN QoS on both routers: ICMP → classPriority, Telnet/SSH/SNMP → classGuaranteed, the rest → class-default', () => {
  const w = lab();
  const expectClass = (d: Delivery, router: 'R1' | 'R2', child: string, what: string) => {
    assert.deepEqual(wanClass(d, router), { deviceId: router, iface: SE, policy: 'output_SE', className: 'class-default', childPolicy: 'output_QE', childClass: child }, what);
  };
  // R1 egress (traffic from LAN1 / R1 towards R2)
  expectClass(sendFlow(w, ping('PC1', ADDR.pc3)).forward, 'R1', 'classPriority', 'ICMP on R1');
  expectClass(sendFlow(w, tcp('PC1', ADDR.r2Wan, 23)).forward, 'R1', 'classGuaranteed', 'Telnet on R1');
  expectClass(sendFlow(w, tcp('PC1', ADDR.pc3, 22)).forward, 'R1', 'classGuaranteed', 'SSH on R1');
  expectClass(sendFlow(w, snmp('PC1', ADDR.r2Wan, 'D105read')).forward, 'R1', 'classGuaranteed', 'SNMP on R1');
  expectClass(sendFlow(w, udp('R1', ADDR.pc3, 162)).forward, 'R1', 'classGuaranteed', 'SNMP trap on R1');
  expectClass(sendFlow(w, tcp('PC1', ADDR.pc3, 80)).forward, 'R1', 'class-default', 'HTTP on R1');
  expectClass(sendFlow(w, tcp('PC1', ADDR.pc3, 21)).forward, 'R1', 'class-default', 'FTP on R1');
  // R2 egress (the other direction, including answers)
  expectClass(sendFlow(w, ping('PC3', ADDR.pc1Public)).forward, 'R2', 'classPriority', 'ICMP on R2');
  expectClass(sendFlow(w, ping('PC1', ADDR.pc3)).reverse!, 'R2', 'classPriority', 'ICMP reply on R2');
  expectClass(sendFlow(w, tcp('PC3', ADDR.r1Wan, 23)).forward, 'R2', 'classGuaranteed', 'Telnet on R2');
  expectClass(sendFlow(w, tcp('PC1', ADDR.r2Wan, 23)).reverse!, 'R2', 'classGuaranteed', 'Telnet answer on R2');
  expectClass(sendFlow(w, snmp('PC3', ADDR.r1Wan, 'D105read')).forward, 'R2', 'classGuaranteed', 'SNMP on R2');
  expectClass(sendFlow(w, snmp('PC1', ADDR.r2Wan, 'D105read')).reverse!, 'R2', 'classGuaranteed', 'SNMP response on R2');
  expectClass(sendFlow(w, tcp('PC1', ADDR.pc3, 80)).reverse!, 'R2', 'class-default', 'HTTP answer on R2');
  for (const p of syslogProbe(w, 'R2')) expectClass(p.flow.forward, 'R2', 'class-default', 'syslog on R2');

  for (const id of ['R1', 'R2']) {
    const plan = qosPlan(w, id, SE);
    assert.equal(plan.attached, true);
    assert.equal(plan.policy, 'output_SE');
    assert.equal(plan.bandwidthKbps, 128);
    assert.equal(plan.physicalBps, 128000, 'clock rate on the DCE end (R1)');
    assert.equal(plan.clockRateBps, 128000);
    assert.equal(plan.shapedBps, 121600, '95 % of 128 kbit/s = 121.6 kbit/s');
    assert.deepEqual(plan.shaper && [plan.shaper.policy, plan.shaper.className], ['output_SE', 'class-default']);
    assert.deepEqual(plan.classes.map((c) => [c.policy, c.className, c.treatment, c.kbps]), [
      ['output_QE', 'classPriority', 'priority', 16],
      ['output_QE', 'classGuaranteed', 'bandwidth', 48],
      ['output_QE', 'class-default', 'fair-queue', undefined],
    ]);
    assert.match(plan.classes[0].match, /permit icmp any any/);
    assert.match(plan.classes[1].match, /permit tcp any any eq telnet/);
    assert.match(plan.classes[1].match, /permit udp any eq snmptrap any/);
  }
});

test('Telnet: PC1 reaches a password prompt on both routers; PC2 and PC3 are refused by both', () => {
  const w = lab();
  for (const [dst, router, seenAs] of [[ADDR.r1Lan, 'R1', ADDR.pc1], [ADDR.r2Wan, 'R2', ADDR.pc1Public]] as const) {
    const f = sendFlow(w, tcp('PC1', dst, 23));
    assert.equal(f.ok, true, f.summary);
    assert.equal(f.outcome, 'ok');
    assert.equal(f.forward.atDeviceId, router);
    assert.equal(f.forward.received?.src, seenAs, 'source address as the router sees it');
    assert.equal(f.vty?.accepted, true);
    assert.equal(f.vty?.login, 'password', 'a password prompt follows');
    assert.equal(f.vty?.line?.password, 'cisco');
  }
  // other addresses of the routers work for PC1 too
  assert.equal(sendFlow(w, tcp('PC1', ADDR.r1Lo0, 23)).ok, true);
  assert.equal(sendFlow(w, tcp('PC1', ADDR.r2Lan, 23)).ok, true);

  const refused = (from: string, dst: string, router: string) => {
    const f = sendFlow(w, tcp(from, dst, 23));
    assert.equal(f.ok, false, `${from} → ${dst} must be refused`);
    assert.equal(f.outcome, 'refused', f.summary);
    assert.equal(f.forward.reason, 'service-denied');
    assert.equal(f.forward.atDeviceId, router);
    assert.equal(f.vty?.reason, 'access-class');
    assert.match(f.summary, /access-class allowPC1 in/);
  };
  refused('PC2', ADDR.r1Lan, 'R1');
  refused('PC2', ADDR.r2Wan, 'R2');
  refused('PC3', ADDR.r2Lan, 'R2');
  refused('PC3', ADDR.r2Wan, 'R2');
  refused('PC3', ADDR.r1Wan, 'R1');
  // the pure helper agrees
  assert.equal(vtyDecision(w, 'R2', ADDR.pc1Public).accepted, true);
  assert.equal(vtyDecision(w, 'R2', ADDR.pc1).accepted, false, 'R2 only knows PC1 by its NAT address');
  assert.equal(vtyDecision(w, 'R1', ADDR.pc1).accepted, true);
});

test('SNMP: PC1 reads and writes on both routers, PC3 only reads, PC2 gets no answer', () => {
  const w = lab();
  // PC1
  assert.deepEqual(snmpRequest(w, 'PC1', { host: ADDR.r1Lan, community: 'D105read', op: 'get', oid: 'sysName.0' }).text, 'sysName.0 = STRING: R1');
  assert.deepEqual(snmpRequest(w, 'PC1', { host: ADDR.r2Wan, community: 'D105read', op: 'get', oid: '1.3.6.1.2.1.1.5.0' }).text, 'sysName.0 = STRING: R2');
  const w1 = snmpRequest(w, 'PC1', { host: ADDR.r1Lan, community: 'D105write', op: 'set', oid: 'sysLocation', value: 'Lab D105' });
  assert.equal(w1.ok, true, w1.text);
  assert.equal(r1(w).config.snmp.location, 'Lab D105');
  const w2 = snmpRequest(w, 'PC1', { host: ADDR.r2Wan, community: 'D105write', op: 'set', oid: 'sysContact', value: 'student' });
  assert.equal(w2.ok, true, w2.text);
  assert.equal(r2(w).config.snmp.contact, 'student');
  assert.equal(snmpRequest(w, 'PC1', { host: ADDR.r2Wan, community: 'D105read', op: 'get', oid: 'sysContact' }).text, 'sysContact.0 = STRING: student');

  // PC3: read yes, write no
  for (const host of [ADDR.r1Wan, ADDR.r2Lan, ADDR.r2Wan]) {
    const rd = snmpRequest(w, 'PC3', { host, community: 'D105read', op: 'get', oid: 'sysName' });
    assert.equal(rd.ok, true, `PC3 read from ${host}: ${rd.text}`);
    const wr = snmpRequest(w, 'PC3', { host, community: 'D105write', op: 'set', oid: 'sysName', value: 'hacked' });
    assert.equal(wr.ok, false);
    assert.equal(wr.text, `Timeout: No Response from ${host}`);
    assert.equal(wr.flow.forward.reason, 'service-denied');
    assert.equal(wr.flow.symbol, '.');
  }
  assert.equal(r1(w).config.hostname, 'R1');
  assert.equal(r2(w).config.hostname, 'R2');

  // PC2: nothing (192.168.100.101 on R1, 60.50.30.1 after PAT on R2)
  for (const host of [ADDR.r1Lan, ADDR.r2Wan]) {
    for (const [community, op] of [['D105read', 'get'], ['D105write', 'set']] as const) {
      const r = snmpRequest(w, 'PC2', { host, community, op, oid: 'sysName', value: 'x' });
      assert.equal(r.ok, false);
      assert.match(r.text, /^Timeout/);
      assert.equal(r.flow.forward.reason, 'service-denied');
    }
  }
  // a read-only community never writes, even from PC1
  assert.equal(probeFlow(w, snmp('PC1', ADDR.r1Lan, 'D105read', 'set', 'x')).ok, false);
});

test('syslog: PC1 receives messages from 1.1.1.1 (R1) and 2.2.2.2 (R2)', () => {
  const w = lab();
  emitSyslog(w, 'R1', 5, 'SYS-5-CONFIG_I', 'Configured from console by console');
  emitSyslog(w, 'R2', 5, 'SYS-5-CONFIG_I', 'Configured from console by console');
  const log = pc(w, 'PC1').runtime.syslog;
  assert.deepEqual(log.map((m) => m.from), ['1.1.1.1', '2.2.2.2']);
  assert.deepEqual(log.map((m) => m.mnemonic), ['SYS-5-CONFIG_I', 'SYS-5-CONFIG_I']);
  assert.equal(log[0].severity, 5);
  assert.equal(r1(w).runtime.logBuffer.length, 1);
  assert.equal(r2(w).runtime.logBuffer.length, 1);
  assert.deepEqual(syslogProbe(w, 'R1').map((p) => [p.host, p.received, p.seenFrom]), [[ADDR.pc1, true, '1.1.1.1']]);
  assert.deepEqual(syslogProbe(w, 'R2').map((p) => [p.host, p.received, p.seenFrom]), [[ADDR.pc1Public, true, '2.2.2.2']]);
});
