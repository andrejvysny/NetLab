/**
 * Verification screens outside the reference solution: dynamic routing, dynamic NAT with a pool, failed IKE,
 * logging buffer, SNMP hosts, filters by name/address/interface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installCli, execLine, startSession } from '../../src/engine/cli/index.ts';
import type { ExecOutcome } from '../../src/engine/cli/framework.ts';
import type { World } from '../../src/engine/types.ts';
import { getIos } from '../../src/engine/world.ts';
import { emitSyslog, sendFlow } from '../../src/engine/sim/index.ts';
import { acl, net, ping, referenceLab, smallLab, stdPermit, threeRouters, GI } from '../sim/fixtures.ts';

installCli();

function cli(w: World, dev: string) {
  getIos(w, dev).runtime.setupDialogDone = true;
  const { session } = startSession(w, dev, 'console');
  execLine(w, session, 'enable');
  return (line: string): string => {
    const o: ExecOutcome = execLine(w, session, line);
    assert.equal(o.status, 'ok', `${dev}# ${line} → ${o.status}\n${o.output}`);
    return o.output;
  };
}

test('RIP and OSPF: R routes with [120/n] and age, show ip protocols blocks, show ip route <ip> for a RIP route', () => {
  const w = threeRouters();
  for (const id of ['R1', 'R2', 'R3']) getIos(w, id).config.rip = { version: 2, networks: ['10.0.0.0', '1.0.0.0', '2.0.0.0', '3.0.0.0'], autoSummary: false, passive: [] };
  getIos(w, 'R2').config.ospf = [{ processId: 1, networks: [{ address: '2.2.2.2', wildcard: '0.0.0.0', area: '0' }], passive: [] }];
  const r1 = cli(w, 'R1');
  const rt = r1('show ip route');
  assert.match(rt, /^R {8}10\.3\.0\.0\/24 \[120\/2\] via 10\.0\.12\.2, \d\d:\d\d:\d\d, Serial0\/1\/0$/m);
  assert.match(rt, /^ {6}3\.0\.0\.0\/32 is subnetted, 1 subnets\nR {8}3\.3\.3\.3 \[120\/2\] via 10\.0\.12\.2, /m);
  assert.match(r1('show ip route rip'), /^R {8}10\.0\.23\.0\/24 \[120\/1\]/m);
  assert.doesNotMatch(r1('show ip route rip'), /^C /m);
  const det = r1('show ip route 10.3.0.5');
  assert.match(det, /^Routing entry for 10\.3\.0\.0\/24\n {2}Known via "rip", distance 120, metric 2\n {2}Redistributing via rip\n {2}Last update from 10\.0\.12\.2 on Serial0\/1\/0, \d\d:\d\d:\d\d ago$/m);
  const pr = r1('show ip protocols');
  assert.match(pr, /^Routing Protocol is "rip"$/m);
  assert.match(pr, /^ {2}Default version control: send version 2, receive version 2$/m);
  assert.match(pr, /^ {4}Serial0\/1\/0 {11}2 {5}2 /m);
  assert.match(pr, /^ {2}Automatic network summarization is not in effect$/m);
  assert.match(pr, /^ {4}10\.0\.12\.2 {12}120 {6}\d\d:\d\d:\d\d$/m);
  const p2 = cli(w, 'R2')('show ip protocols');
  assert.match(p2, /^Routing Protocol is "ospf 1"\n.*\n.*\n {2}Router ID 2\.2\.2\.2$/m);
});

test('dynamic NAT with a pool (no overload): simple entry, session entry, pool statistics', () => {
  const w = smallLab();
  const cfg = getIos(w, 'R1').config;
  cfg.interfaces[GI].natRole = 'inside';
  cfg.interfaces['GigabitEthernet0/0/1'].natRole = 'outside';
  cfg.acls['1'] = acl('1', 'standard', [stdPermit(net('10.0.1.0', '0.0.0.255'))]);
  cfg.nat.pools.push({ name: 'PUB', start: '10.0.2.100', end: '10.0.2.109', mask: '255.255.255.0' });
  cfg.nat.dynamicRules.push({ acl: '1', pool: 'PUB', overload: false });
  assert.ok(sendFlow(w, ping('PC1', '10.0.2.10')).ok);
  const r1 = cli(w, 'R1');
  const t = r1('show ip nat translations');
  assert.match(t, /^--- {2}10\.0\.2\.100 +10\.0\.1\.10 +--- +---$/m);
  assert.match(t, /^icmp 10\.0\.2\.100:\d+ +10\.0\.1\.10:\d+ +10\.0\.2\.10:\d+ +10\.0\.2\.10:\d+$/m);
  assert.match(t, /^Total number of translations: 2$/m);
  const s = r1('show ip nat statistics');
  assert.match(s, /^Total active translations: 2 \(0 static, 2 dynamic; 1 extended\)$/m);
  assert.match(s, /^\[Id: 1\] access-list 1 pool PUB refcount 1\n pool PUB: id 1, netmask 255\.255\.255\.0\n\tstart 10\.0\.2\.100 end 10\.0\.2\.109\n\ttype generic, total addresses 10, allocated 1 \(10%\), misses 0$/m);
});

test('IKE phase 1 failure shows MM_NO_STATE; crypto session DOWN without SAs; key list', () => {
  const w = referenceLab({ acquire: false });
  getIos(w, 'R2').config.crypto.isakmpKeys = [{ key: 'WRONG', address: '60.50.30.1' }];
  const r1 = cli(w, 'R1');
  const p = r1('ping 2.2.2.2 source Loopback0');
  assert.match(p, /^\.\.\.\.\.$/m);
  assert.match(r1('show crypto isakmp sa'), /^60\.50\.30\.2 {6}60\.50\.30\.1 {6}MM_NO_STATE {10}0 ACTIVE$/m);
  const ss = r1('show crypto session');
  assert.match(ss, /^Session status: DOWN/m);
  assert.match(ss, /IKEv1 SA: local 60\.50\.30\.1\/500 remote 60\.50\.30\.2\/500 Inactive/);
  assert.match(r1('show crypto ipsec sa'), /#pkts encaps: 0, #pkts encrypt: 0, #pkts digest: 0/);
  assert.doesNotMatch(r1('show crypto ipsec sa'), /^ {6}spi: 0x/m);
  assert.match(cli(w, 'R2')('show crypto isakmp key'), /^default {6}60\.50\.30\.1 {34}WRONG$/m);
});

test('show logging distinguishes global and remote disables, retaining history without claiming new sends', () => {
  const w = referenceLab();
  emitSyslog(w, 'R2', 5, 'TEST', 'Historical entry');
  const r2 = cli(w, 'R2');
  const configure = (line: string) => { r2('configure terminal'); r2(line); r2('end'); };
  configure('no logging trap');
  let log = r2('show logging');
  assert.match(log, /^Syslog logging: enabled$/m);
  assert.match(log, /^ {4}Trap logging: disabled \(no logging trap\)$/m);
  assert.match(log, /Logging to 60\.50\.50\.100 +\(udp port 514; disabled\): 1 modeled attempts, 1 collected/);
  assert.match(log, /%TEST: Historical entry/);
  configure('no logging on');
  log = r2('show logging');
  assert.match(log, /^Syslog logging: disabled \(no logging on\)$/m);
  assert.match(log, /^ {4}Trap logging: disabled \(no logging on\)$/m);
  assert.match(log, /%TEST: Historical entry/);
  configure('logging on');
  configure('logging trap debugging');
  assert.match(r2('show logging'), /^ {4}Trap logging: level debugging$/m);
});

test('logging buffer, trap level, SNMP hosts and contact, filters by name / address / interface', () => {
  const w = referenceLab();
  const r1cfg = getIos(w, 'R1').config;
  r1cfg.logging.trapLevel = 'warnings';
  r1cfg.snmp.hosts.push({ address: '192.168.100.10', community: 'D105read', version: '2c', type: 'traps' });
  r1cfg.snmp.contact = 'Lab admin';
  emitSyslog(w, 'R1', 5, 'SYS-5-CONFIG_I', 'Configured from console by console');
  emitSyslog(w, 'R1', 3, 'LINK-3-UPDOWN', 'Interface Serial0/1/0, changed state to down');
  const r1 = cli(w, 'R1');
  const log = r1('show logging');
  assert.match(log, /^ {4}Trap logging: level warnings$/m);
  assert.doesNotMatch(log, /message lines logged/);
  assert.match(log, /^\*May 18 \d\d:\d\d:\d\d\.\d{3}: %SYS-5-CONFIG_I: Configured from console by console$/m);
  assert.match(log, /^\*May 18 \d\d:\d\d:\d\d\.\d{3}: %LINK-3-UPDOWN: Interface Serial0\/1\/0, changed state to down$/m);
  assert.match(r1('show snmp host'), /^Notification host: 192\.168\.100\.10\tudp-port: 162\ttype: trap\nuser: D105read\tsecurity model: v2c$/m);
  assert.match(r1('show snmp'), /^Contact: Lab admin$/m);
  assert.match(r1('show snmp'), /^ {4}Logging to 192\.168\.100\.10\.162 \(traps\): disabled, 0 modeled attempts, 0 collected\.$/m);
  assert.match(r1('show snmp contact'), /^Lab admin$/m);
  // filters
  assert.equal(r1('show ip dhcp binding 192.168.100.101').split('\n').filter((l) => /^\d/.test(l)).length, 1);
  assert.match(r1('show ip dhcp pool LAN2'), /^Pool LAN2 :$/m);
  assert.doesNotMatch(r1('show ip dhcp pool LAN2'), /LAN1/);
  assert.match(r1('show access-lists allowPC1'), /^Standard IP access list allowPC1\n {4}10 permit 192\.168\.100\.10$/m);
  assert.match(r1('show class-map classGuaranteed'), /^ Class Map match-all classGuaranteed/m);
  assert.match(r1('show class-map nope'), /^Class-map nope not found$/m);
  assert.match(r1('show policy-map output_SE'), /^ {2}Policy Map output_SE$/m);
  assert.doesNotMatch(r1('show policy-map output_SE'), /output_QE\n {4}Class classPriority/);
  assert.match(r1('show ip arp 192.168.100.10'), /^Internet {2}192\.168\.100\.10 /m);
  assert.equal(r1('show ip arp 192.168.100.10').trim().split('\n').length, 2);
  assert.match(r1('show cdp neighbors Serial0/1/0'), /Total cdp entries displayed : 1/);
  assert.match(r1('show crypto map interface Serial0/1/0'), /Crypto Map IPv4 "CM" 10 ipsec-isakmp/);
  assert.match(r1('show crypto ipsec sa interface Serial0/1/0'), /interface: Serial0\/1\/0/);
  assert.match(r1('show interfaces description'), /^Se0\/1\/0 {24}up {13}up/m);
  assert.match(r1('show aliases exec'), /^ {2}p {21}ping$/m);
});

test('show cdp honours "no cdp run"; serial encapsulation mismatch is up/down', () => {
  const w = referenceLab();
  const r2 = getIos(w, 'R2').config;
  r2.interfaces['Serial0/1/0'].encapsulation = 'ppp';
  const r1 = cli(w, 'R1');
  assert.match(r1('show ip interface brief'), /^Serial0\/1\/0 {12}60\.50\.30\.1 {6}YES manual up {20}down$/m);
  assert.match(r1('show interfaces Serial0/1/0'), /^Serial0\/1\/0 is up, line protocol is down$/m);
  assert.doesNotMatch(r1('show cdp neighbors'), /^R2 /m);
  r2.interfaces['Serial0/1/0'].encapsulation = undefined;
  assert.match(r1('show cdp neighbors'), /^R2 /m);
  getIos(w, 'R1').config.extraLines.push('no cdp run');
  assert.match(r1('show cdp neighbors'), /^% CDP is not enabled$/m);
});
