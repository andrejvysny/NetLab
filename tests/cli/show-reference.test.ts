/**
 * Verification screens on the course's reference lab (docs/COURSE.md): build the lab, send real traffic with sendFlow,
 * then check the key lines of every major show command.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installCli, execLine, startSession } from '../../src/engine/cli/index.ts';
import type { CliSession, ExecOutcome } from '../../src/engine/cli/framework.ts';
import type { World } from '../../src/engine/types.ts';
import { sendFlow } from '../../src/engine/sim/index.ts';
import { referenceLab, ping, tcp, udp } from '../sim/fixtures.ts';

installCli();

function cli(w: World, dev: string) {
  const { session } = startSession(w, dev, 'console');
  execLine(w, session, 'enable');
  const run = (line: string): ExecOutcome => execLine(w, session, line);
  const show = (line: string): string => {
    const o = run(line);
    assert.equal(o.status, 'ok', `${dev}# ${line} → ${o.status}\n${o.output}`);
    assert.equal(o.mutated, false);
    assert.equal(o.feature, 'verify');
    return o.output;
  };
  return { session: session as CliSession, run, show };
}
const lines = (text: string, re: RegExp): string[] => text.split('\n').filter((l) => re.test(l));

test('show ip interface brief / show interfaces / show ip interface on R1 and R2', () => {
  const w = referenceLab();
  const r1 = cli(w, 'R1');
  const brief = r1.show('show ip interface brief');
  assert.match(brief, /^Interface {14}IP-Address {6}OK\? Method Status {16}Protocol$/m);
  assert.match(brief, /^GigabitEthernet0\/0\/0 {3}192\.168\.100\.1 {3}YES manual up {20}up$/m);
  assert.match(brief, /^GigabitEthernet0\/0\/1 {3}unassigned {6}YES unset  administratively down down$/m);
  assert.match(brief, /^Serial0\/1\/0 {12}60\.50\.30\.1 {6}YES manual up {20}up$/m);
  assert.match(brief, /^Loopback100 {12}60\.50\.50\.100 {4}YES manual up {20}up$/m);

  const se = r1.show('show interfaces Serial0/1/0');
  assert.match(se, /^Serial0\/1\/0 is up, line protocol is up$/m);
  assert.match(se, /Hardware is NIM-2T/);
  assert.match(se, /Internet address is 60\.50\.30\.1\/30/);
  assert.match(se, /MTU 1500 bytes, BW 128 Kbit\/sec, DLY 20000 usec/);
  assert.match(se, /Encapsulation HDLC, crc 16, loopback not set/);
  assert.match(se, /Queueing strategy: Class-based queueing/);
  const gi1 = r1.show('show interfaces gi0/0/1');
  assert.match(gi1, /^GigabitEthernet0\/0\/1 is administratively down, line protocol is down$/m);
  assert.match(gi1, /Hardware is ISR4331-3x1GE, address is [0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}/);

  const ipif = r1.show('show ip interface GigabitEthernet0/0/0');
  assert.match(ipif, /^ {2}Inbound {2}access list is 110$/m);
  assert.match(ipif, /^ {2}Outgoing access list is not set$/m);
  assert.match(ipif, /Network address translation is enabled, interface in domain inside/);
  assert.match(r1.show('show ip interface Serial0/1/0'), /interface in domain outside/);
  assert.match(r1.show('show ip interface gi0/0/2'), /Internet protocol processing disabled/);
  const r2 = cli(w, 'R2');
  assert.match(r2.show('show ip interface g0/0/0'), /^ {2}Helper address is 60\.50\.30\.1$/m);
  assert.match(r2.show('show ip interface g0/0/0'), /Network address translation is disabled/);
  // a non-existing interface is an IOS caret error
  const bad = r1.run('show interfaces gi0/0/7');
  assert.equal(bad.status, 'rejected');
  assert.match(bad.output, /% Invalid input detected at '\^' marker\./);
});

test('show ip route: legend, gateway of last resort, one S* line, classful headers; show ip route <ip>', () => {
  const w = referenceLab();
  for (const [dev, gw] of [['R1', '60.50.30.2'], ['R2', '60.50.30.1']] as const) {
    const out = cli(w, dev).show('show ip route');
    assert.match(out, /^Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP$/m);
    assert.match(out, new RegExp(`^Gateway of last resort is ${gw.replace(/\./g, '\\.')} to network 0\\.0\\.0\\.0$`, 'm'));
    assert.equal(lines(out, /^S\*/).length, 1);
    assert.match(out, new RegExp(`^S\\* {4}0\\.0\\.0\\.0/0 \\[1/0\\] via ${gw.replace(/\./g, '\\.')}, Serial0/1/0$`, 'm'));
    assert.equal(lines(out, /^[SRO] /).length, 0, 'no other static or dynamic route');
  }
  const r1 = cli(w, 'R1');
  const rt = r1.show('show ip route');
  assert.match(rt, /^ {6}1\.0\.0\.0\/32 is subnetted, 1 subnets$/m);
  assert.match(rt, /^C {8}1\.1\.1\.1 is directly connected, Loopback0$/m);
  assert.match(rt, /^ {6}60\.0\.0\.0\/8 is variably subnetted, 3 subnets, 2 masks$/m);
  assert.match(rt, /^C {8}60\.50\.30\.0\/30 is directly connected, Serial0\/1\/0$/m);
  assert.match(rt, /^L {8}60\.50\.30\.1\/32 is directly connected, Serial0\/1\/0$/m);
  assert.match(rt, /^ {6}192\.168\.100\.0\/24 is variably subnetted, 2 subnets, 2 masks$/m);
  const st = r1.show('show ip route static');
  assert.equal(lines(st, /^[CL] /).length, 0);
  assert.equal(lines(st, /^S\*/).length, 1);
  assert.equal(lines(r1.show('show ip route connected'), /^\s*[CL] /).length, 6);
  assert.match(r1.show('show ip route 2.2.2.2'), /^% Network not in table$/m);
  const d = r1.show('show ip route 0.0.0.0');
  assert.match(d, /Routing entry for 0\.0\.0\.0\/0, supernet/);
  assert.match(d, /Known via "static", distance 1, metric 0, candidate default path/);
  assert.match(d, /\* 60\.50\.30\.2, via Serial0\/1\/0/);
  assert.match(r1.show('show ip route 192.168.100.77'), /Routing entry for 192\.168\.100\.0\/24\n {2}Known via "connected"/);
  assert.match(r1.show('show ip protocols'), /\*\*\* IP Routing is NSF aware \*\*\*/);
  assert.match(r1.show('show ip static route'), /^M {2}0\.0\.0\.0\/0 \[1\/0\] via Serial0\/1\/0 60\.50\.30\.2 \[A\]$/m);
});

test('DHCP: both leases, pool usage, the conflict found by ping-before-offer, statistics', () => {
  const w = referenceLab();
  const r1 = cli(w, 'R1');
  const b = r1.show('show ip dhcp binding');
  assert.match(b, /^192\.168\.100\.101 0100\.5056\.c0\S+\s+\w{3} \d{2} \d{4} \d{2}:\d{2} [AP]M\s+Automatic  Active     GigabitEthernet0\/0\/0$/m);
  assert.match(b, /^60\.50\.40\.2 +0100\.5056\.c0\S+ .*Automatic  Active     Unknown$/m);
  const p = r1.show('show ip dhcp pool');
  assert.match(p, /^Pool LAN1 :$/m);
  assert.match(p, /^ Excluded addresses {13}: 100$/m);
  assert.match(p, /^ 192\.168\.100\.102 {6}192\.168\.100\.1 {4}- 192\.168\.100\.254 {2}1 {5}\/ 100 {3}\/ 254$/m);
  assert.match(r1.show('show ip dhcp conflict'), /^60\.50\.40\.1 +Ping /m);
  assert.match(r1.show('show ip dhcp server statistics'), /^Automatic bindings {3}2$/m);
  assert.equal(cli(w, 'R2').show('show ip dhcp binding').split('\n').filter((l) => /^\d/.test(l)).length, 0);
});

test('ACLs: sequence numbers and match counters from real traffic', () => {
  const w = referenceLab();
  sendFlow(w, ping('PC1', '2.2.2.2'));
  sendFlow(w, ping('PC1', '2.2.2.2'));
  sendFlow(w, ping('PC2', '60.50.40.2'));
  sendFlow(w, tcp('PC2', '60.50.40.2', 21));
  const r1 = cli(w, 'R1');
  const a = r1.show('show access-lists 110');
  assert.match(a, /^Extended IP access list 110$/m);
  assert.match(a, /^ {4}10 deny ip host 192\.168\.100\.10 host 2\.2\.2\.2 \(2 matches\)$/m);
  assert.match(a, /^ {4}20 permit icmp host 192\.168\.100\.101 60\.50\.40\.0 0\.0\.0\.63 \(1 match\)$/m);
  assert.match(a, /^ {4}30 permit tcp host 192\.168\.100\.101 60\.50\.40\.0 0\.0\.0\.63 eq www$/m);
  assert.match(a, /^ {4}40 deny ip host 192\.168\.100\.101 60\.50\.40\.0 0\.0\.0\.63 \(1 match\)$/m);
  assert.doesNotMatch(a, /Standard IP access list/);
  const all = r1.show('show ip access-lists');
  assert.match(all, /^Standard IP access list 1\n {4}10 permit 192\.168\.100\.0, wildcard bits 0\.0\.0\.255 \(\d+ match(es)?\)$/m);
  assert.match(all, /^Standard IP access list allowPC1\n {4}10 permit 192\.168\.100\.10$/m);
  assert.match(all, /^Extended IP access list 120\n {4}10 permit tcp any any eq telnet\n {4}20 permit tcp any eq telnet any$/m);
  assert.ok(all.indexOf('access list 120') < all.indexOf('access list allowPC1'), 'numbered lists first');
  assert.equal(r1.show('show access-lists 199'), '');
});

test('NAT: static row, PAT row, IOS XE total line, statistics', () => {
  const w = referenceLab();
  sendFlow(w, ping('PC2', '60.50.40.2'));
  sendFlow(w, ping('PC1', '60.50.40.2'));
  sendFlow(w, tcp('PC2', '60.50.40.2', 80));
  const r1 = cli(w, 'R1');
  const t = r1.show('show ip nat translations');
  const rows = t.trimEnd().split('\n');
  assert.equal(rows[0], 'Pro  Inside global         Inside local          Outside local         Outside global');
  assert.match(t, /^--- {2}60\.50\.50\.100 {10}192\.168\.100\.10 {8}--- {19}--- *$/m);
  assert.match(t, /^icmp 60\.50\.30\.1:\d+ +192\.168\.100\.101:\d+ +60\.50\.40\.2:\d+ +60\.50\.40\.2:\d+$/m);
  assert.match(t, /^tcp {2}60\.50\.30\.1:\d+ +192\.168\.100\.101:\d+ 60\.50\.40\.2:80 +60\.50\.40\.2:80$/m);
  assert.match(t, /^icmp 60\.50\.50\.100:\d+ +192\.168\.100\.10:\d+ /m);
  assert.equal(rows[rows.length - 1], `Total number of translations: ${rows.length - 2}`);
  const v = r1.show('show ip nat translations verbose');
  assert.match(v, /create: \d\d\/\d\d\/\d\d \d\d:\d\d:\d\d, use: /);
  assert.match(v, /Total number of translations: 4/);
  const s = r1.show('show ip nat statistics');
  assert.match(s, /^Total active translations: 4 \(1 static, 3 dynamic; 3 extended\)$/m);
  assert.match(s, /^Outside interfaces:\n {2}Serial0\/1\/0$/m);
  assert.match(s, /^Inside interfaces: ?\n {2}GigabitEthernet0\/0\/0$/m);
  assert.match(s, /^Hits: \d+ {2}Misses: \d+$/m);
  assert.match(s, /^\[Id: 1\] access-list 1 interface Serial0\/1\/0 refcount 2$/m);
  // R2 has no NAT
  assert.equal(cli(w, 'R2').show('show ip nat translations').trimEnd().split('\n').at(-1), 'Total number of translations: 0');
});

test('IPsec: isakmp policy/sa/key, ipsec sa counters rise after a ping, transform-set, crypto map, session', () => {
  const w = referenceLab();
  const r1 = cli(w, 'R1');
  const pol = r1.show('show crypto isakmp policy');
  assert.match(pol, /^Global IKE policy\nProtection suite of priority 10\n\tencryption algorithm:\tAES - Advanced Encryption Standard \(128 bit key\.\)$/m);
  assert.match(pol, /\tauthentication method:\tPre-Shared Key/);
  assert.match(pol, /\tDiffie-Hellman group:\t#2 \(1024 bit\)/);
  assert.match(pol, /^Default protection suite\n\tencryption algorithm:\tDES - Data Encryption Standard \(56 bit keys\)\.$/m);
  assert.match(r1.show('show crypto isakmp key'), /^default {6}60\.50\.30\.2 {34}KSS123$/m);

  r1.show('ping 2.2.2.2 source Loopback0');
  const sa = r1.show('show crypto isakmp sa');
  assert.match(sa, /^dst {13}src {13}state {10}conn-id status$/m);
  assert.match(sa, /^60\.50\.30\.2 {6}60\.50\.30\.1 {6}QM_IDLE {11}1001 ACTIVE$/m);
  // the responder lists the initiator as src as well
  assert.match(cli(w, 'R2').show('show crypto isakmp sa'), /^60\.50\.30\.2 {6}60\.50\.30\.1 {6}QM_IDLE/m);

  const encaps = (text: string): number => {
    const block = text.split('protected vrf').find((b) => b.includes('remote ident (addr/mask/prot/port): (0.0.0.0/0.0.0.0/1/0)'))!;
    return Number(/#pkts encaps: (\d+)/.exec(block)![1]);
  };
  const before = r1.show('show crypto ipsec sa');
  assert.match(before, /^interface: Serial0\/1\/0\n {4}Crypto map tag: CM, local addr 60\.50\.30\.1$/m);
  assert.match(before, /local {2}ident \(addr\/mask\/prot\/port\): \(0\.0\.0\.0\/0\.0\.0\.0\/6\/0\)\n {3}remote ident \(addr\/mask\/prot\/port\): \(0\.0\.0\.0\/0\.0\.0\.0\/6\/23\)/);
  assert.match(before, /current_peer 60\.50\.30\.2 port 500/);
  assert.match(before, /inbound esp sas:\n {6}spi: 0x[0-9A-F]+\(\d+\)\n {8}transform: esp-aes esp-sha-hmac ,\n {8}in use settings =\{Tunnel, \}/);
  const n0 = encaps(before);
  r1.show('ping 2.2.2.2 source Loopback0');
  const after = r1.show('show crypto ipsec sa');
  assert.equal(encaps(after), n0 + 5);
  assert.match(after, /#pkts decaps: \d+, #pkts decrypt: \d+, #pkts verify: \d+/);
  assert.match(r1.show('show crypto ipsec sa peer 60.50.30.2'), /interface: Serial0\/1\/0/);

  assert.match(r1.show('show crypto ipsec transform-set'), /^Transform set TS: \{ esp-aes esp-sha-hmac {2}\} *\n {3}will negotiate = \{ Tunnel, {2}\},/m);
  const map = r1.show('show crypto map');
  assert.match(map, /^Crypto Map IPv4 "CM" 10 ipsec-isakmp$/m);
  assert.match(map, /Peer = 60\.50\.30\.2/);
  assert.match(map, /Extended IP access list 120\n +access-list 120 permit tcp any any port = 23/);
  assert.match(map, /TS: {2}\{ esp-aes esp-sha-hmac {2}\} ,/);
  assert.match(map, /Interfaces using crypto map CM:\n +Serial0\/1\/0/);
  const sess = r1.show('show crypto session');
  assert.match(sess, /^Interface: Serial0\/1\/0\nSession status: UP-ACTIVE/m);
  assert.match(sess, /IKEv1 SA: local 60\.50\.30\.1\/500 remote 60\.50\.30\.2\/500 Active/);
});

test('QoS: class-map, policy-map, show policy-map interface counters and the 121600 bps shaper', () => {
  const w = referenceLab();
  const r1 = cli(w, 'R1');
  assert.match(r1.show('show class-map'), /^ Class Map match-all classPriority \(id \d+\)\n {3}Match access-group name matchPriority *$/m);
  const pm = r1.show('show policy-map');
  assert.match(pm, /^ {2}Policy Map output_QE\n {4}Class classPriority\n {6}priority 16 \(kbps\)\n {4}Class classGuaranteed\n {6}bandwidth 48 \(kbps\)\n {4}Class class-default\n {6}fair-queue$/m);
  assert.match(pm, /^ {2}Policy Map output_SE\n {4}Class class-default\n {6}Average Rate Traffic Shaping\n {6}cir 95%\n {6}service-policy output_QE$/m);

  const prio = (text: string): number => Number(/Class-map: classPriority \(match-all\) *\n *(\d+) packets/.exec(text)![1]);
  const before = r1.show('show policy-map interface Serial0/1/0');
  assert.match(before, /^ Serial0\/1\/0 *\n\n {2}Service-policy output: output_SE$/m);
  assert.match(before, /^ {4}Class-map: class-default \(match-any\) *$/m);
  assert.match(before, /^ {6}shape \(average\) cir 121600, bc 486, be 486$/m);
  assert.match(before, /^ {6}target shape rate 121600$/m);
  assert.match(before, /^ {6}Service-policy : output_QE$/m);
  assert.match(before, /^ {8}Class-map: classPriority \(match-all\) *\n {10}\d+ packets, \d+ bytes\n {10}5 minute offered rate 0000 bps, drop rate 0000 bps\n {10}Match: access-group name matchPriority\n {10}Priority: 16 kbps, burst bytes 1500, b\/w exceed drops: 0$/m);
  assert.match(before, /^ {10}bandwidth 48 kbps$/m);
  assert.match(before, /^ {10}Fair-queue: per-flow queue limit 16 packets$/m);
  const p0 = prio(before);
  r1.show('ping 60.50.40.2');
  const after = r1.show('show policy-map interface Serial0/1/0 output');
  assert.equal(prio(after), p0 + 5);
  // Telnet / SNMP traffic lands in classGuaranteed
  sendFlow(w, udp('R1', '60.50.40.2', 161));
  assert.match(r1.show('show policy-map interface Serial0/1/0'), /Class-map: classGuaranteed \(match-all\) *\n {10}[1-9]\d* packets/);
  assert.equal(r1.show('show policy-map interface Serial0/1/0 input'), '');
  assert.equal(r1.show('show policy-map interface gi0/0/0'), '');
  // show queueing does not exist on IOS XE
  const q = r1.run('show queueing priority');
  assert.equal(q.status, 'rejected');
  assert.equal(q.output.split('\n')[0], ' '.repeat('R1#show '.length) + '^');
  assert.match(q.output, /% Invalid input detected at '\^' marker\./);
  assert.match(q.notes.join(' '), /show policy-map interface/);
});

test('serial controllers (DCE/DTE), CDP neighbours from the cabling, ARP, protocols', () => {
  const w = referenceLab();
  const r1 = cli(w, 'R1');
  const r2 = cli(w, 'R2');
  assert.match(r1.show('show controllers serial 0/1/0'), /^Interface Serial0\/1\/0\nHardware is NIM-2T\nDCE V\.35, clock rate 128000$/m);
  assert.match(r2.show('show controllers serial 0/1/0'), /^DTE V\.35 TX and RX clocks detected\.$/m);
  assert.match(r1.show('show controllers Serial0/1/1'), /No serial cable attached/);
  const cdp = r1.show('show cdp neighbors');
  assert.match(cdp, /^Device ID {8}Local Intrfce {5}Holdtme {4}Capability {2}Platform {2}Port ID$/m);
  assert.match(cdp, /^R2 {15}Ser 0\/1\/0 {9}\d{3} {13}R B S I ISR4331\/K Ser 0\/1\/0$/m);
  assert.match(cdp, /^Switch {11}Gig 0\/0\/0 {9}\d{3} {17}S I C9300L-24 Gig 1\/0\/24$/m);
  assert.match(cdp, /^Total cdp entries displayed : 2$/m);
  const det = r2.show('show cdp neighbors detail');
  assert.match(det, /^Device ID: R1$/m);
  assert.match(det, /^ {2}IP address: 60\.50\.30\.1$/m);
  assert.match(det, /^Interface: Serial0\/1\/0, {2}Port ID \(outgoing port\): Serial0\/1\/0$/m);
  // PCs do not speak CDP; R2's LAN port leads to PC3 only
  assert.doesNotMatch(r2.show('show cdp neighbors'), /Gig 0\/0\/0/);
  const arp = r1.show('show ip arp');
  assert.match(arp, /^Internet {2}192\.168\.100\.1 {12}- {2}[0-9a-f.]{14} {2}ARPA {3}GigabitEthernet0\/0\/0$/m);
  assert.match(arp, /^Internet {2}192\.168\.100\.10 +\d+ {2}0050\.56c0\.[0-9a-f]{4} {2}ARPA {3}GigabitEthernet0\/0\/0$/m);
  assert.match(arp, /^Internet {2}192\.168\.100\.101 /m);
  assert.match(r1.show('show protocols'), /^Global values:\n {2}Internet Protocol routing is enabled$/m);
});

test('switch views: interfaces status, vlan brief, mac address-table from the cabling', () => {
  const w = referenceLab();
  const sw = cli(w, 'SW1');
  const st = sw.show('show interfaces status');
  assert.match(st, /^Port {9}Name {15}Status {7}Vlan {7}Duplex {2}Speed Type *$/m);
  assert.match(st, /^Gi1\/0\/1 {25}connected {4}1 {10}a-full a-1000 10\/100\/1000BaseTX$/m);
  assert.match(st, /^Gi1\/0\/3 {25}notconnect {3}1 {12}auto {3}auto 10\/100\/1000BaseTX$/m);
  const vb = sw.show('show vlan brief');
  assert.match(vb, /^1 {4}default {26}active {4}Gi1\/0\/1, Gi1\/0\/2, Gi1\/0\/3, Gi1\/0\/4$/m);
  assert.match(vb, /^1002 fddi-default {21}act\/unsup/m);
  const mt = sw.show('show mac address-table dynamic');
  assert.match(mt, /^ {3}1 {4}0050\.56c0\.[0-9a-f]{4} {4}DYNAMIC {5}Gi1\/0\/1$/m);
  assert.match(mt, /^ {3}1 {4}0050\.56c0\.[0-9a-f]{4} {4}DYNAMIC {5}Gi1\/0\/2$/m);
  assert.match(mt, /^ {3}1 {4}[0-9a-f.]{14} {4}DYNAMIC {5}Gi1\/0\/24$/m);
  assert.match(mt, /^Total Mac Addresses for this criterion: 3$/m);
  assert.match(sw.show('show mac address-table'), /^ All {4}0100\.0ccc\.cccc {4}STATIC {6}CPU$/m);
  assert.match(sw.show('show ip interface brief'), /^Vlan1 {18}unassigned {6}YES unset  administratively down down\nGigabitEthernet1\/0\/1/m);
  assert.match(sw.show('show interfaces gi1/0/1'), /^GigabitEthernet1\/0\/1 is up, line protocol is up \(connected\)$/m);
  assert.match(sw.show('show interfaces gi1/0/5'), /^GigabitEthernet1\/0\/5 is down, line protocol is down \(notconnect\)$/m);
  assert.match(sw.show('show ip route'), /^Default gateway is not set$/m);
  // switch-only commands do not exist on a router
  assert.equal(cli(w, 'R1').run('show vlan brief').status, 'invalid');
  assert.equal(cli(w, 'R1').run('show mac address-table').status, 'invalid');
});

test('management: snmp, logging with source interface and the buffer, users, line, version, clock', () => {
  const w = referenceLab();
  const r1 = cli(w, 'R1');
  const com = r1.show('show snmp community');
  assert.match(com, /^Community name: D105read\nCommunity Index: cisco\d+\nCommunity SecurityName: D105read\nstorage-type: nonvolatile\t active\taccess-list: 10$/m);
  assert.match(com, /^Community name: D105write$/m);
  assert.match(r1.show('show snmp'), /^Chassis: \S+$/m);
  assert.match(cli(w, 'R2').show('show snmp host'), /^$/m);
  sendFlow(w, ping('PC1', '2.2.2.2'));
  const log = r1.show('show logging');
  assert.match(log, /^Syslog logging: enabled/m);
  assert.match(log, /^ {4}Trap logging: level informational$/m);
  assert.match(log, /^ {8}Logging to 192\.168\.100\.10 {2}\(udp port 514; route available\): \d+ modeled attempts, \d+ collected\.$/m);
  assert.match(log, /^ {8}Logging Source-Interface: {7}VRF Name:\n {8}Loopback0$/m);
  assert.match(log, /^Log Buffer \(102400 bytes\):$/m);
  const users = r1.show('show users');
  assert.match(users, /^\* {2}0 con 0 {16}idle {17}00:00:00/m);
  const line = r1.show('show line vty 0');
  assert.match(line, /^Line 2, Location: "", Type: ""$/m);
  assert.match(line, /^Allowed input transports are telnet ssh\.$/m);
  assert.match(line, /SSH transport settings do not start an SSH server; TCP 22 is a path probe only/);
  assert.match(r1.show('show line'), /^ +2 +2 VTY .* allo /m);
  const v = r1.show('show version');
  assert.match(v, /^Cisco IOS XE Software, Version 17\.03\.04a$/m);
  assert.match(v, /Version 17\.3\.4a, RELEASE SOFTWARE/);
  assert.match(v, /^R1 uptime is \d+ (minute|hour)/m);
  assert.match(v, /^cisco ISR4331\/K9 \(1RU\) processor/m);
  assert.match(v, /^3 Gigabit Ethernet interfaces\n2 Serial interfaces$/m);
  assert.match(v, /^Configuration register is 0x2102$/m);
  assert.match(cli(w, 'SW1').show('show version'), /^Model Number {23}: C9300L-24T-4G$/m);
  assert.match(r1.show('show clock'), /^\*\d\d:\d\d:\d\d\.\d{3} UTC \w{3} \w{3} \d+ \d{4}$/m);
  assert.match(r1.show('show inventory'), /PID: NIM-2T/);
  assert.match(r1.show('show platform'), /^ 0\/1 {6}NIM-2T/m);
  assert.match(r1.show('show privilege'), /^Current privilege level is 15$/m);
  r1.show('show clock');
  assert.match(r1.show('show history'), /^ {2}show clock\n {2}show history$/m);
});
