/** Access lists (ARCHITECTURE §6.2): evaluation rules and their effect in the packet pipeline. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GI, acl, any, deny, eq, host, net, permit, ping, setAcl, smallLab, stdDeny, stdPermit, tcp, udp } from './fixtures.ts';
import { aceText, aclEvaluate, aclEvidence, probeFlow, sendFlow } from '../../src/engine/sim/index.ts';
import { OUTBOUND_ACL_FILTERS_LOCAL_PACKETS } from '../../src/engine/sim/index.ts';
import { getIos, getPc } from '../../src/engine/world.ts';
import type { Packet, World } from '../../src/engine/types.ts';

const GI1 = 'GigabitEthernet0/0/1';
const pkt = (over: Partial<Packet>): Packet => ({ src: '10.0.1.10', dst: '10.0.2.10', proto: 'icmp', icmpType: 'echo', ttl: 64, bytes: 60, ...over });
const r1cfg = (w: World) => getIos(w, 'R1').config;

test('first match wins, implicit deny at the end', () => {
  const list = acl('101', 'extended', [
    deny('ip', host('10.0.1.10'), host('10.0.2.10')),
    permit('ip', host('10.0.1.10'), any),
    permit('icmp', any, any),
  ]);
  const a = aclEvaluate(list, pkt({}));
  assert.deepEqual([a.permit, a.implicit, a.ace?.seq], [false, false, 10]);
  const b = aclEvaluate(list, pkt({ dst: '10.0.2.11' }));
  assert.deepEqual([b.permit, b.implicit, b.ace?.seq], [true, false, 20]);
  const c = aclEvaluate(list, pkt({ src: '10.0.1.20' }));
  assert.deepEqual([c.permit, c.ace?.seq], [true, 30]);
  const d = aclEvaluate(list, pkt({ src: '10.0.1.20', proto: 'tcp', sport: 1024, dport: 80, tcpSyn: true }));
  assert.deepEqual([d.permit, d.implicit, d.ace], [false, true, undefined]);
  assert.match(aclEvidence('101', list, d), /implicit "deny ip any any"/);
});

test('a list that is referenced but not defined (or has no entries) permits everything', () => {
  assert.deepEqual(aclEvaluate(undefined, pkt({})), { permit: true, implicit: true });
  assert.deepEqual(aclEvaluate(acl('102', 'extended', []), pkt({})), { permit: true, implicit: true });
  const onlyRemark = acl('103', 'extended', []);
  onlyRemark.entries.push({ seq: 10, action: 'remark', remark: 'nothing yet', protocol: 'ip', src: any, dst: any });
  assert.equal(aclEvaluate(onlyRemark, pkt({})).permit, true);
  // remarks are skipped, not matched
  const withRemark = acl('104', 'extended', [permit('tcp', any, any)]);
  withRemark.entries.unshift({ seq: 5, action: 'remark', remark: 'web only', protocol: 'ip', src: any, dst: any });
  assert.equal(aclEvaluate(withRemark, pkt({})).permit, false);
  assert.equal(aclEvaluate(withRemark, pkt({ proto: 'tcp', dport: 80, sport: 5000 })).ace?.seq, 10);
});

test('standard lists match the source address only', () => {
  const list = acl('10', 'standard', [stdDeny(host('10.0.1.10')), stdPermit(net('10.0.1.0', '0.0.0.255'))]);
  assert.equal(aclEvaluate(list, pkt({})).permit, false);
  assert.equal(aclEvaluate(list, pkt({ src: '10.0.1.20', dst: '1.2.3.4', proto: 'udp', dport: 53 })).permit, true);
  assert.equal(aclEvaluate(list, pkt({ src: '10.0.2.10' })).permit, false);
  assert.equal(aceText(list.entries[0], 'standard'), 'deny 10.0.1.10');
  assert.equal(aceText(list.entries[1], 'standard'), 'permit 10.0.1.0 0.0.0.255');
});

test('extended lists: protocol, wildcard, ports, ICMP type, established', () => {
  const t = (over: Partial<Packet>) => pkt({ proto: 'tcp', sport: 40000, dport: 80, tcpSyn: true, ...over });
  const one = (entry: ReturnType<typeof permit>, p: Packet) => aclEvaluate(acl('150', 'extended', [entry]), p).permit;
  // protocol
  assert.equal(one(permit('tcp', any, any), pkt({})), false);
  assert.equal(one(permit('icmp', any, any), pkt({})), true);
  assert.equal(one(permit('ip', any, any), t({})), true);
  assert.equal(one(permit(6, any, any), t({})), true);
  assert.equal(one(permit(17, any, any), t({})), false);
  assert.equal(one(permit('esp', any, any), pkt({ proto: 'esp' })), true);
  assert.equal(one(permit('gre', any, any), pkt({ proto: 'esp' })), false);
  // wildcard masks
  assert.equal(one(permit('ip', net('10.0.0.0', '0.0.255.255'), any), pkt({})), true);
  assert.equal(one(permit('ip', net('10.0.1.8', '0.0.0.7'), any), pkt({})), true);
  assert.equal(one(permit('ip', net('10.0.1.16', '0.0.0.7'), any), pkt({})), false);
  assert.equal(one(permit('ip', any, net('10.0.2.0', '0.0.0.63')), pkt({ dst: '10.0.2.70' })), false);
  // ports
  assert.equal(one(permit('tcp', any, any, { dstPort: eq(80) }), t({})), true);
  assert.equal(one(permit('tcp', any, any, { dstPort: eq(80, 443) }), t({ dport: 443 })), true);
  assert.equal(one(permit('tcp', any, any, { dstPort: eq(80) }), t({ dport: 21 })), false);
  assert.equal(one(permit('tcp', any, any, { srcPort: eq(80) }), t({})), false, 'source port, not destination');
  assert.equal(one(permit('tcp', any, any, { srcPort: eq(80) }), t({ sport: 80, dport: 40000, tcpSyn: false })), true);
  assert.equal(one(permit('tcp', any, any, { dstPort: { op: 'neq', ports: [80] } }), t({})), false);
  assert.equal(one(permit('tcp', any, any, { dstPort: { op: 'lt', ports: [1024] } }), t({})), true);
  assert.equal(one(permit('tcp', any, any, { dstPort: { op: 'gt', ports: [1023] } }), t({})), false);
  assert.equal(one(permit('tcp', any, any, { dstPort: { op: 'range', ports: [20, 21] } }), t({ dport: 21 })), true);
  assert.equal(one(permit('tcp', any, any, { dstPort: { op: 'range', ports: [20, 21] } }), t({ dport: 22 })), false);
  assert.equal(one(permit('udp', any, any, { dstPort: eq(80) }), t({})), false, 'udp entry, tcp packet');
  assert.equal(one(permit('tcp', any, any, { dstPort: eq(80) }), pkt({})), false, 'a port entry never matches ICMP');
  // ICMP types
  assert.equal(one(permit('icmp', any, any, { icmpType: 'echo' }), pkt({})), true);
  assert.equal(one(permit('icmp', any, any, { icmpType: 'echo-reply' }), pkt({})), false);
  assert.equal(one(permit('icmp', any, any, { icmpType: 'echo-reply' }), pkt({ icmpType: 'echo-reply' })), true);
  assert.equal(one(permit('icmp', any, any, { icmpType: 0 }), pkt({ icmpType: 'echo-reply' })), true);
  assert.equal(one(permit('icmp', any, any, { icmpType: 8 }), pkt({})), true);
  assert.equal(one(permit('icmp', any, any, { icmpType: 'unreachable' }), pkt({ icmpType: 'admin-prohibited' })), true);
  assert.equal(one(permit('icmp', any, any, { icmpType: 'time-exceeded' }), pkt({ icmpType: 'unreachable' })), false);
  // every IOS keyword form: all codes of a type, one code, numbers, "type code"
  const unreach = (code: 'net' | 'host' | 'port') => ({ ...pkt({ icmpType: 'unreachable' }), icmpCode: code }) as Packet;
  assert.equal(one(permit('icmp', any, any, { icmpType: 'host-unreachable' }), unreach('host')), true);
  assert.equal(one(permit('icmp', any, any, { icmpType: 'host-unreachable' }), unreach('port')), false);
  assert.equal(one(permit('icmp', any, any, { icmpType: 'port-unreachable' }), unreach('port')), true);
  assert.equal(one(permit('icmp', any, any, { icmpType: 'unreachable' }), unreach('net')), true);
  assert.equal(one(permit('icmp', any, any, { icmpType: 3 }), unreach('net')), true);
  assert.equal(one(permit('icmp', any, any, { icmpType: '3 1' }), unreach('host')), true);
  assert.equal(one(permit('icmp', any, any, { icmpType: '3 1' }), unreach('net')), false);
  assert.equal(one(permit('icmp', any, any, { icmpType: 'administratively-prohibited' }), pkt({ icmpType: 'admin-prohibited' })), true);
  assert.equal(one(permit('icmp', any, any, { icmpType: 'administratively-prohibited' }), unreach('host')), false);
  assert.equal(one(permit('icmp', any, any, { icmpType: 'ttl-exceeded' }), pkt({ icmpType: 'time-exceeded' })), true);
  assert.equal(one(permit('icmp', any, any, { icmpType: 11 }), pkt({ icmpType: 'time-exceeded' })), true);
  assert.equal(one(permit('icmp', any, any, { icmpType: 'redirect' }), pkt({})), false);
  assert.equal(one(permit('icmp', any, any, { icmpType: 'no-such-keyword' }), pkt({})), false);
  // established = TCP that is not the first packet of a connection
  assert.equal(one(permit('tcp', any, any, { established: true }), t({})), false);
  assert.equal(one(permit('tcp', any, any, { established: true }), t({ tcpSyn: false })), true);
  assert.equal(one(permit('tcp', any, any, { established: true }), pkt({})), false);
  // text
  assert.equal(aceText(permit('tcp', host('1.1.1.1'), net('10.0.0.0', '0.0.0.255'), { dstPort: eq(80) }) as never), 'permit tcp host 1.1.1.1 10.0.0.0 0.0.0.255 eq www');
  assert.equal(aceText(permit('udp', any, any, { srcPort: eq(161), log: true }) as never), 'permit udp any eq snmp any log');
  assert.equal(aceText(permit('tcp', any, any, { dstPort: eq(22), established: true }) as never), 'permit tcp any any eq 22 established');
  assert.equal(aceText(deny('icmp', any, any, { icmpType: 'echo' }) as never), 'deny icmp any any echo');
});

test('inbound ACL: transit drop is answered with "administratively prohibited" (U) and counted', () => {
  const w = smallLab();
  setAcl(r1cfg(w), acl('100', 'extended', [deny('tcp', any, net('10.0.2.0', '0.0.0.255'), { dstPort: eq(80) }), permit('ip', any, any)]));
  r1cfg(w).interfaces[GI].aclIn = '100';
  getPc(w, 'PC3').services.http = true;
  getPc(w, 'PC3').services.ftp = true;
  const web = sendFlow(w, tcp('PC1', '10.0.2.10', 80));
  assert.deepEqual([web.ok, web.symbol, web.outcome, web.forward.reason, web.forward.atDeviceId], [false, 'U', 'unreachable', 'acl-in', 'R1']);
  assert.equal(web.unreachableFrom, '10.0.1.1');
  assert.equal(web.reverse?.received?.icmpType, 'admin-prohibited');
  const stepAcl = web.forward.steps.at(-1)!;
  assert.deepEqual([stepAcl.stage, stepAcl.feature, stepAcl.verdict, stepAcl.iface], ['acl-in', 'acl', 'drop', GI]);
  assert.match(stepAcl.detail ?? '', /access-list 100 deny tcp any 10\.0\.2\.0 0\.0\.0\.255 eq www\s+\(entry 10\)/);
  assert.equal(sendFlow(w, tcp('PC1', '10.0.2.10', 21)).ok, true);
  assert.equal(sendFlow(w, ping('PC1', '10.0.2.10')).ok, true);
  assert.deepEqual(getIos(w, 'R1').runtime.aclHits, { '100:10': 1, '100:20': 2 });
  // traffic in the other direction does not pass this interface inbound
  getPc(w, 'PC1').services.http = true;
  assert.equal(sendFlow(w, tcp('PC3', '10.0.1.10', 80)).ok, true);

  // "no ip unreachables": the drop becomes silent
  r1cfg(w).interfaces[GI].noIpUnreachables = true;
  const quiet = sendFlow(w, tcp('PC1', '10.0.2.10', 80));
  assert.deepEqual([quiet.symbol, quiet.outcome, quiet.forward.reason], ['.', 'timeout', 'acl-in']);
  assert.match(quiet.summary, /no ip unreachables/);
});

test('an inbound ACL also filters packets for the router itself, and replies need a permit too', () => {
  const w = smallLab();
  setAcl(r1cfg(w), acl('PERMIT_ECHO_REPLY_ONLY', 'extended', [permit('icmp', any, any, { icmpType: 'echo-reply' })], true));
  r1cfg(w).interfaces[GI1].aclIn = 'PERMIT_ECHO_REPLY_ONLY';
  // PC3 → router: echo is not permitted
  assert.equal(sendFlow(w, ping('PC3', '10.0.2.1')).forward.reason, 'acl-in');
  // router → PC3 and PC1 → PC3: the echo goes out, the echo-reply is permitted back in
  assert.equal(sendFlow(w, ping('R1', '10.0.2.10')).ok, true);
  const p = sendFlow(w, ping('PC1', '10.0.2.10'));
  assert.equal(p.ok, true, p.summary);
  assert.match(p.reverse?.steps.find((s) => s.stage === 'acl-in')?.detail ?? '', /ip access-list extended PERMIT_ECHO_REPLY_ONLY → 10 permit icmp any any echo-reply/);
  // TCP answers from PC3 are not echo-replies: the SYN arrives, the SYN-ACK dies on the way back
  getPc(w, 'PC3').services.http = true;
  const t = sendFlow(w, tcp('PC1', '10.0.2.10', 80));
  assert.equal(t.forward.ok, true);
  assert.deepEqual([t.ok, t.reverse?.reason, t.reverse?.atDeviceId], [false, 'acl-in', 'R1']);
  // "established" lets answers back in, but no new connections
  r1cfg(w).acls['PERMIT_ECHO_REPLY_ONLY'].entries.push({ seq: 20, action: 'permit', protocol: 'tcp', src: any, dst: any, established: true });
  assert.equal(sendFlow(w, tcp('PC1', '10.0.2.10', 80)).ok, true);
  getPc(w, 'PC1').services.http = true;
  assert.equal(sendFlow(w, tcp('PC3', '10.0.1.10', 80)).forward.reason, 'acl-in');
});

test('a list applied to an interface but not defined filters nothing; an empty list neither', () => {
  const w = smallLab();
  r1cfg(w).interfaces[GI].aclIn = 'NOT_YET';
  const f = sendFlow(w, ping('PC1', '10.0.2.10'));
  assert.equal(f.ok, true);
  const note = f.forward.steps.find((s) => s.stage === 'acl-in');
  assert.equal(note?.verdict, 'info');
  assert.match(note?.text ?? '', /Access list NOT_YET is applied inbound on GigabitEthernet0\/0\/0, but it filters nothing \(it is not defined\)/);
  setAcl(r1cfg(w), acl('NOT_YET', 'extended', [], true));
  assert.equal(sendFlow(w, ping('PC1', '10.0.2.10')).ok, true);
  // the first entry activates the implicit deny
  r1cfg(w).acls['NOT_YET'].entries.push({ seq: 10, action: 'permit', protocol: 'tcp', src: any, dst: any });
  assert.equal(sendFlow(w, ping('PC1', '10.0.2.10')).forward.reason, 'acl-in');
});

test('outbound ACL: filters transit packets as they leave, not packets the router creates itself', () => {
  const w = smallLab();
  setAcl(r1cfg(w), acl('120', 'extended', [deny('icmp', any, host('10.0.2.10')), permit('ip', any, any)]));
  r1cfg(w).interfaces[GI1].aclOut = '120';
  const f = sendFlow(w, ping('PC1', '10.0.2.10'));
  assert.deepEqual([f.ok, f.symbol, f.forward.reason, f.forward.atDeviceId], [false, 'U', 'acl-out', 'R1']);
  const s = f.forward.steps.at(-1)!;
  assert.deepEqual([s.stage, s.iface, s.verdict], ['acl-out', GI1, 'drop']);
  assert.match(f.summary, /access list 120, applied outbound on GigabitEthernet0\/0\/1, denies it/);
  // the route lookup happened before the outbound list was consulted
  assert.deepEqual(f.forward.steps.map((x) => x.stage), ['origin', 'switch', 'ingress', 'route', 'acl-out']);
  // other traffic passes and is counted
  getPc(w, 'PC3').services.http = true;
  assert.equal(sendFlow(w, tcp('PC1', '10.0.2.10', 80)).ok, true);
  assert.deepEqual(getIos(w, 'R1').runtime.aclHits, { '120:10': 1, '120:20': 1 });
  // the router's own ping is not filtered by its outbound list (IOS behaviour)
  assert.equal(OUTBOUND_ACL_FILTERS_LOCAL_PACKETS, false);
  const own = sendFlow(w, ping('R1', '10.0.2.10'));
  assert.equal(own.ok, true, own.summary);
  assert.match(own.forward.steps.find((x) => x.stage === 'acl-out')?.text ?? '', /IOS does not filter packets that the router creates itself/);
  assert.deepEqual(getIos(w, 'R1').runtime.aclHits, { '120:10': 1, '120:20': 1 }, 'no hit for the router\'s own packet');
});

test('UDP to a closed port comes back as "port unreachable"; an ACL can hide that answer', () => {
  const w = smallLab();
  const f = sendFlow(w, udp('PC1', '10.0.2.10', 9999));
  assert.deepEqual([f.ok, f.symbol, f.outcome, f.forward.reason, f.forward.atDeviceId], [false, 'U', 'unreachable', 'port-closed', 'PC3']);
  assert.equal(f.unreachableFrom, '10.0.2.10');
  setAcl(r1cfg(w), acl('130', 'extended', [deny('icmp', any, any, { icmpType: 'unreachable' }), permit('ip', any, any)]));
  r1cfg(w).interfaces[GI1].aclIn = '130';
  const g = sendFlow(w, udp('PC1', '10.0.2.10', 9999));
  assert.deepEqual([g.symbol, g.outcome, g.reverse?.reason], ['.', 'timeout', 'acl-in']);
  // no error message is ever generated about an error message
  assert.equal(g.reverse?.steps.at(-1)?.verdict, 'drop');
});

test('an entry with "log" writes %SEC-6-IPACCESSLOG… to the buffer and to the logging hosts', () => {
  const w = smallLab();
  const c = r1cfg(w);
  setAcl(c, acl('140', 'extended', [
    deny('tcp', any, any, { dstPort: eq(23), log: true }),
    permit('icmp', any, any, { log: true }),
    permit('ip', any, any),
  ]));
  c.interfaces[GI].aclIn = '140';
  c.logging.hosts = ['10.0.2.10'];
  getPc(w, 'PC3').services.syslog = true;
  sendFlow(w, tcp('PC1', '10.0.2.10', 23));
  sendFlow(w, ping('PC1', '10.0.2.10'));
  sendFlow(w, tcp('PC1', '10.0.2.10', 80));
  const buf = getIos(w, 'R1').runtime.logBuffer;
  assert.deepEqual(buf.map((m) => `${m.severity} ${m.mnemonic}: ${m.text}`), [
    '6 SEC-6-IPACCESSLOGP: list 140 denied tcp 10.0.1.10(49156) -> 10.0.2.10(23), 1 packet',
    '6 SEC-6-IPACCESSLOGDP: list 140 permitted icmp 10.0.1.10 -> 10.0.2.10 (8/0), 1 packet',
  ]);
  assert.deepEqual(getPc(w, 'PC3').runtime.syslog.map((m) => [m.from, m.mnemonic]), [['10.0.2.1', 'SEC-6-IPACCESSLOGP'], ['10.0.2.1', 'SEC-6-IPACCESSLOGDP']]);
  // a probe logs nothing
  const before = structuredClone(w);
  probeFlow(w, tcp('PC1', '10.0.2.10', 23));
  assert.deepEqual(w, before);
});
