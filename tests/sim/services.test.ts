/** Local services (ARCHITECTURE §6.7): PC servers, router ports, vty lines, SNMP agent, syslog and traps. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDR, GI, acl, host, pc, ping, r1, r2, referenceLab, setAcl, smallLab, snmp, stdPermit, tcp, udp } from './fixtures.ts';
import {
  emitSnmpTrap, emitSyslog, normalizeOid, oidLabel, ownAddresses, probeFlow, sendFlow, snmpRequest, vtyDecision,
} from '../../src/engine/sim/index.ts';
import { getIos, getPc } from '../../src/engine/world.ts';

test('PC services: HTTP 80, FTP 21 and Telnet 23 answer only when switched on', () => {
  const w = smallLab();
  const p3 = getPc(w, 'PC3');
  for (const [key, port, name] of [['http', 80, 'web server \\(HTTP\\)'], ['ftp', 21, 'FTP server'], ['telnet', 23, 'Telnet server']] as const) {
    const off = sendFlow(w, tcp('PC1', '10.0.2.10', port));
    assert.deepEqual([off.ok, off.symbol, off.outcome, off.forward.reason, off.forward.atDeviceId], [false, '.', 'refused', 'port-closed', 'PC3'], key);
    assert.match(off.summary, new RegExp(`The ${name} on PC3 is switched off`));
    assert.equal(off.reverse?.atDeviceId, 'PC1', 'the reset comes back');
    p3.services[key] = true;
    const on = sendFlow(w, tcp('PC1', '10.0.2.10', port));
    assert.deepEqual([on.ok, on.symbol, on.outcome], [true, '!', 'ok'], key);
    assert.equal(on.vty, undefined, 'a PC has no vty lines');
  }
  // any other port is closed
  const other = sendFlow(w, tcp('PC1', '10.0.2.10', 8080));
  assert.equal(other.outcome, 'refused');
  assert.match(other.summary, /PC3 has no service on TCP port 8080/);
  // a PC answers ping whenever it has an address; its own addresses are listed
  assert.equal(sendFlow(w, ping('PC1', '10.0.2.10')).ok, true);
  assert.deepEqual(ownAddresses(w, 'PC3'), [{ address: '10.0.2.10', mask: '255.255.255.0', iface: 'Ethernet0', up: true }]);
});

test('router ports: ping on every up address, closed TCP ports refuse, closed UDP ports answer "port unreachable"', () => {
  const w = referenceLab();
  for (const addr of [ADDR.r1Lan, ADDR.r1Wan, ADDR.r1Lo0]) assert.equal(sendFlow(w, ping('PC1', addr)).forward.atDeviceId, 'R1', addr);
  assert.equal(sendFlow(w, ping('R1', ADDR.r1Lo0)).ok, true, 'a router can ping itself');
  const http = sendFlow(w, tcp('PC1', ADDR.r1Lan, 80));
  assert.deepEqual([http.outcome, http.forward.reason], ['refused', 'port-closed']);
  assert.match(http.summary, /R1 has no service on TCP port www \(80\)/);
  const u = sendFlow(w, udp('PC1', ADDR.r1Lan, 9999));
  assert.deepEqual([u.symbol, u.outcome, u.forward.reason, u.unreachableFrom], ['U', 'unreachable', 'port-closed', ADDR.r1Lan]);
  // an address on a down interface is not the router's any more
  r1(w).config.interfaces['Loopback0'].shutdown = true;
  const gone = sendFlow(w, ping('PC1', ADDR.r1Lo0));
  assert.notEqual(gone.forward.atDeviceId, 'R1');
  // source address selection
  assert.equal(sendFlow(w, ping('R1', ADDR.pc3)).forward.received?.src, ADDR.r1Wan, 'default: the egress interface address');
  assert.equal(sendFlow(w, ping('R1', ADDR.pc1)).forward.received?.src, ADDR.r1Lan);
  const bad = sendFlow(w, ping('R1', ADDR.pc3, { srcAddr: '9.9.9.9' }));
  assert.deepEqual([bad.ok, bad.forward.reason], [false, 'no-ip']);
  assert.match(bad.summary, /R1 has no interface with the address 9\.9\.9\.9/);
  const down = sendFlow(w, ping('R1', ADDR.pc3, { srcAddr: ADDR.r1Lo0 }));
  assert.match(down.summary, /belongs to Loopback0 on R1, and that interface is down/);
});

test('vty lines: which line serves, transport input, SSH, access-class with an extended list', () => {
  const w = referenceLab();
  const d = vtyDecision(w, 'R1', ADDR.pc1);
  assert.deepEqual([d.accepted, d.login, d.line?.first, d.line?.last, d.acl], [true, 'password', 0, 4, 'allowPC1']);
  // sessions in use move new connections to higher lines; with all 15 busy nobody gets in
  r1(w).runtime.vtyInUse = 5;
  assert.deepEqual([vtyDecision(w, 'R1', ADDR.pc1).line?.first, vtyDecision(w, 'R1', ADDR.pc1).line?.last], [5, 14]);
  r1(w).runtime.vtyInUse = 15;
  assert.deepEqual([vtyDecision(w, 'R1', ADDR.pc1).accepted, vtyDecision(w, 'R1', ADDR.pc1).reason], [false, 'no-free-line']);
  r1(w).runtime.vtyInUse = 0;
  // the second range can have other rules than the first
  r1(w).config.lines.vty[1] = { first: 5, last: 14, login: 'local' };
  r1(w).runtime.vtyInUse = 5;
  assert.equal(vtyDecision(w, 'R1', '8.8.8.8').login, 'local-no-users');
  r1(w).config.users.push({ name: 'admin', secret: 'x' });
  assert.equal(vtyDecision(w, 'R1', '8.8.8.8').login, 'local');
  r1(w).runtime.vtyInUse = 0;
  // transport input
  r1(w).config.lines.vty[0].transportInput = 'telnet';
  assert.equal(vtyDecision(w, 'R1', ADDR.pc1, 'telnet').accepted, true);
  const ssh = sendFlow(w, tcp('PC1', ADDR.r1Lan, 22));
  assert.deepEqual([ssh.outcome, ssh.vty?.reason], ['refused', 'ssh-not-modeled']);
  r1(w).config.lines.vty[0].transportInput = 'none';
  assert.equal(sendFlow(w, tcp('PC1', ADDR.r1Lan, 23)).outcome, 'refused');
  r1(w).config.lines.vty[0].transportInput = 'all';
  assert.equal(sendFlow(w, tcp('PC1', ADDR.r1Lan, 22)).ok, false, 'allowing a VTY transport does not start an SSH server');
  // access-class is counted like any ACL
  const before = r1(w).runtime.aclHits['allowPC1:10'] ?? 0;
  sendFlow(w, tcp('PC1', ADDR.r1Lan, 23));
  assert.equal(r1(w).runtime.aclHits['allowPC1:10'], before + 1);
  // an access-class that names a list which does not exist filters nothing
  r2(w).config.lines.vty[0].accessClassIn = 'nothing';
  assert.equal(vtyDecision(w, 'R2', '8.8.8.8').accepted, true);
  // not a router
  assert.deepEqual([vtyDecision(w, 'PC1', ADDR.pc1).accepted, vtyDecision(w, 'PC1', ADDR.pc1).reason], [false, 'not-ios']);
});

test('SNMP agent: the small MIB, writable objects, errors, OID spelling', () => {
  const w = referenceLab();
  const get = (oid: string) => snmpRequest(w, 'PC1', { host: ADDR.r1Lan, community: 'D105read', op: 'get', oid });
  const set = (oid: string, value: string) => snmpRequest(w, 'PC1', { host: ADDR.r1Lan, community: 'D105write', op: 'set', oid, value });
  assert.match(get('sysDescr.0').text, /^sysDescr\.0 = STRING: Cisco IOS Software \[Amsterdam\], ISR Software .* Version 17\.03\.04a/);
  assert.equal(get('.1.3.6.1.2.1.1.5.0').text, 'sysName.0 = STRING: R1');
  assert.equal(get('SNMPv2-MIB::sysName.0').text, 'sysName.0 = STRING: R1');
  assert.equal(get('ifNumber').text, `ifNumber.0 = INTEGER: ${Object.keys(r1(w).config.interfaces).length}`);
  const names = Object.keys(r1(w).config.interfaces);
  const gi = names.indexOf(GI) + 1;
  assert.equal(get(`ifDescr.${gi}`).text, `ifDescr.${gi} = STRING: ${GI}`);
  assert.equal(get(`ifOperStatus.${gi}`).text, `ifOperStatus.${gi} = INTEGER: up(1)`);
  const unused = names.indexOf('GigabitEthernet0/0/2') + 1;
  assert.equal(get(`ifAdminStatus.${unused}`).text, `ifAdminStatus.${unused} = INTEGER: down(2)`);
  assert.match(get('sysUpTime').text, /^sysUpTime\.0 = Timeticks: /);
  // unknown object: the agent answers with an error
  const bad = get('1.3.6.1.4.1.9.9.9.9');
  assert.equal(bad.ok, false);
  assert.equal(bad.flow.ok, true, 'a response did come back');
  assert.match(bad.text, /noSuchName/);
  // writing
  assert.equal(set('sysName', 'Edge1').text, 'sysName.0 = STRING: Edge1');
  assert.equal(r1(w).config.hostname, 'Edge1');
  assert.equal(get('sysName').text, 'sysName.0 = STRING: Edge1');
  const ro = set('sysDescr', 'nope');
  assert.equal(ro.ok, false);
  assert.match(ro.text, /notWritable/);
  // helpers
  assert.equal(normalizeOid('sysContact'), '1.3.6.1.2.1.1.4.0');
  assert.equal(normalizeOid('sysContact.0'), '1.3.6.1.2.1.1.4.0');
  assert.equal(oidLabel('1.3.6.1.2.1.1.6.0'), 'sysLocation.0');
  assert.equal(oidLabel('1.2.3'), '1.2.3');
  // a probe never writes
  assert.equal(probeFlow(w, snmp('PC1', ADDR.r1Lan, 'D105write', 'set', 'Other')).ok, true);
  assert.equal(r1(w).config.hostname, 'Edge1');
  // a packet on UDP 161 that is not an SNMP request gets no answer
  const raw = sendFlow(w, udp('PC1', ADDR.r1Lan, 161));
  assert.deepEqual([raw.ok, raw.symbol, raw.forward.reason], [false, '.', 'service-denied']);
});

test('SNMP traps reach the management station when hosts and traps are configured', () => {
  const w = referenceLab();
  const c = r2(w).config.snmp;
  assert.deepEqual(emitSnmpTrap(w, 'R2', 'linkDown', 'Interface GigabitEthernet0/0/0 down'), [], 'no host, no traps enabled');
  c.hosts = [{ address: ADDR.pc1Public, community: 'D105read', type: 'traps' }];
  assert.deepEqual(emitSnmpTrap(w, 'R2', 'linkDown', 'x'), [], 'traps not enabled');
  c.enableTraps = ['all'];
  const sent = emitSnmpTrap(w, 'R2', 'linkDown', 'Interface GigabitEthernet0/0/0 down');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].ok, true, sent[0].summary);
  assert.equal(sent[0].forward.encrypted, true, 'UDP 162 is protected by the crypto ACL');
  assert.deepEqual(pc(w, 'PC1').runtime.traps.map((t) => [t.from, t.community, t.text]), [[ADDR.r2Wan, 'D105read', 'Interface GigabitEthernet0/0/0 down']]);
  // trap-source
  c.trapSource = 'Loopback0';
  emitSnmpTrap(w, 'R2', 'linkUp', 'up again');
  assert.equal(pc(w, 'PC1').runtime.traps.at(-1)?.from, ADDR.r2Lo0);
  // only the enabled types are sent
  c.enableTraps = ['config'];
  assert.equal(emitSnmpTrap(w, 'R2', 'linkDown', 'x').length, 0);
  assert.equal(emitSnmpTrap(w, 'R2', 'config', 'changed').length, 1);
  // management software off on PC1: the trap is thrown away
  pc(w, 'PC1').services.syslog = false;
  const lost = emitSnmpTrap(w, 'R2', 'config', 'changed')[0];
  assert.deepEqual([lost.ok, lost.forward.reason, lost.forward.atDeviceId], [false, 'port-closed', 'PC1']);
});

test('syslog: buffer, several hosts, a host that is a router, a plain UDP 514 packet', () => {
  const w = referenceLab();
  pc(w, 'PC2').services.syslog = true;
  r1(w).config.logging.hosts = [ADDR.pc1, ADDR.pc2, ADDR.r2Wan];
  emitSyslog(w, 'R1', 5, 'LINEPROTO-5-UPDOWN', 'Line protocol on Interface Serial0/1/0, changed state to up');
  assert.deepEqual(pc(w, 'PC1').runtime.syslog.map((m) => [m.from, m.severity, m.mnemonic]), [['1.1.1.1', 5, 'LINEPROTO-5-UPDOWN']]);
  assert.equal(pc(w, 'PC2').runtime.syslog.length, 1);
  assert.equal(r1(w).runtime.logBuffer.at(-1)?.text, 'Line protocol on Interface Serial0/1/0, changed state to up');
  assert.equal(r1(w).runtime.logBuffer.at(-1)?.tick, w.tick);
  // emitSyslog on a PC or an unknown device is ignored
  emitSyslog(w, 'PC1', 5, 'X', 'y');
  emitSyslog(w, 'nobody', 5, 'X', 'y');
  // a test packet to UDP 514 is recorded as such
  const f = sendFlow(w, udp('PC3', ADDR.pc1Public, 514));
  assert.equal(f.ok, true, f.summary);
  assert.equal(pc(w, 'PC1').runtime.syslog.at(-1)?.from, ADDR.pc3);
  // ACL on R1 that only lets PC1's own traffic through does not affect syslog from R1 itself
  setAcl(r1(w).config, acl('10', 'standard', [stdPermit(host(ADDR.pc1))]));
  // the buffer does not grow without limit
  for (let i = 0; i < 1100; i++) emitSyslog(w, 'SW1', 6, 'TEST-6-X', `message ${i}`);
  assert.equal(getIos(w, 'SW1').runtime.logBuffer.length, 1000);
  assert.equal(getIos(w, 'SW1').runtime.logBuffer.at(-1)?.text, 'message 1099');
});
