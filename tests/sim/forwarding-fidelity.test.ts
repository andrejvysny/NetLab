import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execLine, installCli, startSession } from '../../src/engine/cli/index.ts';
import { applyConfigText } from '../../src/engine/config/apply.ts';
import { renderConfigLines } from '../../src/engine/config/render.ts';
import { dhcpAcquire, emitSnmpTrap, emitSyslog, qosPlan, sendFlow, serialClock, snmpRequest, syslogBlockReason, syslogProbe } from '../../src/engine/sim/index.ts';
import type { World } from '../../src/engine/types.ts';
import { ADDR, SE, pc, ping, r1, r2, referenceLab, tcp } from './fixtures.ts';

installCli();

function config(w: World, id: 'R1' | 'R2', ...lines: string[]) {
  const { session } = startSession(w, id, 'file');
  session.mode = 'config';
  return lines.map((line) => {
    const out = execLine(w, session, line);
    assert.equal(out.status, 'ok', `${id}: ${line}: ${out.output}`);
    return out;
  });
}

test('no service dhcp on the server or relay prevents new leases; service dhcp restores them', () => {
  const w = referenceLab({ acquire: false });
  config(w, 'R1', 'no service dhcp');
  const direct = dhcpAcquire(w, 'PC2');
  const relayed = dhcpAcquire(w, 'PC3');
  for (const result of [direct, relayed]) {
    assert.equal(result.ok, false);
    assert.match(result.reasonText ?? '', /R1 ignores.*no service dhcp.*disables both/);
  }
  assert.equal(r1(w).runtime.dhcpBindings.length, 0);
  assert.ok(relayed.steps.some((s) => s.stage === 'egress' && s.deviceId === 'R2' && s.iface === SE), 'the relay still sends to the disabled server');

  config(w, 'R1', 'service dhcp');
  config(w, 'R2', 'no service dhcp');
  assert.equal(dhcpAcquire(w, 'PC2').ok, true);
  const stopped = dhcpAcquire(w, 'PC3');
  assert.match(stopped.reasonText ?? '', /R2 ignores.*no service dhcp.*disables both/);
  assert.ok(!stopped.steps.some((s) => s.stage === 'egress' && s.iface === SE), 'a disabled relay does not transmit a request');
  assert.equal(r1(w).runtime.dhcpBindings.length, 1);
  config(w, 'R2', 'service dhcp');
  assert.equal(dhcpAcquire(w, 'PC3').ok, true);
});

test('an undefined or remark-only PAT list selects nothing, even after a translation existed', () => {
  const w = referenceLab();
  const flow = tcp('PC2', ADDR.pc3, 80);
  assert.equal(sendFlow(w, flow).forward.received?.src, ADDR.r1Wan);
  assert.ok(r1(w).runtime.natTranslations.some((t) => t.insideLocal === ADDR.pc2));
  // End-to-end using the reference ACL/PAT/WAN order. R2's default route still lets the un-NATed flow return.
  config(w, 'R1', 'no access-list 1');
  const missing = sendFlow(w, flow);
  assert.equal(missing.forward.received?.src, ADDR.pc2);
  assert.equal(missing.ok, true, 'a working flow alone does not prove that PAT worked');
  assert.match(missing.forward.steps.find((s) => s.stage === 'nat-inside')?.detail ?? '', /not defined, so it selects no traffic for NAT/);
  assert.ok(!r1(w).runtime.natTranslations.some((t) => t.insideLocal === ADDR.pc2));
  config(w, 'R1', 'access-list 1 remark PAT for LAN1');
  assert.equal(sendFlow(w, flow).forward.received?.src, ADDR.pc2);
  config(w, 'R1', 'access-list 1 permit 192.168.100.0 0.0.0.255');
  assert.equal(sendFlow(w, flow).ok, true);
});

test('syslog disable switches block actual UDP delivery and survive rendering and import', () => {
  const w = referenceLab();
  const rt = r2(w).runtime;
  const logs = pc(w, 'PC1').runtime.syslog;
  const initially = logs.length;
  const emit = (severity = 5) => emitSyslog(w, 'R2', severity, 'TEST', 'Simulated log');
  assert.equal(syslogProbe(w, 'R2')[0]?.received, true);

  config(w, 'R2', 'logging trap debugging', 'no logging trap');
  assert.equal(syslogBlockReason(r2(w), 5), 'trap-off');
  assert.deepEqual(syslogProbe(w, 'R2'), []);
  emit(0);
  assert.equal(logs.length, initially);
  assert.equal(rt.logBuffer.at(-1)?.mnemonic, 'TEST', 'no logging trap does not disable the buffer');
  const text = renderConfigLines(r2(w)).join('\n');
  assert.match(text, /^no logging trap$/m);
  const restored = referenceLab();
  assert.equal(applyConfigText(restored, 'R2', text, 'replace').ok, true);
  assert.equal(syslogBlockReason(r2(restored)), 'trap-off');
  assert.deepEqual(syslogProbe(restored, 'R2'), []);

  config(w, 'R2', 'logging trap informational');
  emit(7);
  assert.equal(logs.length, initially, 'default trap threshold still filters severity 7');
  emit();
  assert.equal(logs.length, initially + 1);
  assert.equal(logs.at(-1)?.from, ADDR.r2Lo0);

  config(w, 'R2', 'no logging on', 'logging trap debugging');
  const buffered = rt.logBuffer.length;
  assert.equal(syslogBlockReason(r2(w), 7), 'logging-off');
  emit();
  assert.equal(logs.length, initially + 1);
  assert.equal(rt.logBuffer.length, buffered);
  config(w, 'R2', 'logging on');
  emit(7);
  assert.equal(logs.length, initially + 2);
});

test('an SNMP view applies to reads and writes; unsupported notifications do not appear as traps', () => {
  const w = referenceLab();
  config(w, 'R2', 'snmp-server view SystemOnly system included',
    'snmp-server view SystemOnly 1.3.6.1.2.1.1.4 excluded',
    'snmp-server community D105write view SystemOnly rw 11');
  const snmp = (oid: string, op: 'get' | 'set' = 'get') => snmpRequest(w, 'PC1', { host: ADDR.r2Wan, community: 'D105write', oid, op, value: 'new contact' });
  assert.equal(snmp('sysName').ok, true);
  assert.match(snmp('ifNumber').text, /noSuchName/, 'outside included subtree');
  assert.match(snmp('sysContact').text, /noSuchName/, 'more specific exclusion overrides its ancestor');
  const before = r2(w).config.snmp.contact;
  assert.match(snmp('sysContact', 'set').text, /noAccess/);
  assert.equal(r2(w).config.snmp.contact, before);
  config(w, 'R2', 'no snmp-server view SystemOnly');
  assert.equal(snmp('sysName').ok, false, 'removing a view cannot make the community unrestricted');

  const notes = config(w, 'R2', 'snmp-server enable traps config',
    `snmp-server host ${ADDR.pc1Public} informs version 2c private`,
    `snmp-server host ${ADDR.pc1Public} traps version 3 auth username`);
  assert.ok(notes.slice(1).every((o) => o.notes.some((n) => n.includes('does not send a notification'))));
  assert.deepEqual(emitSnmpTrap(w, 'R2', 'config', 'change'), []);
  assert.equal(pc(w, 'PC1').runtime.traps.length, 0);
  config(w, 'R2', `snmp-server host ${ADDR.pc1Public} traps version 2c public`);
  assert.equal(emitSnmpTrap(w, 'R2', 'config', 'change').length, 1);
  assert.equal(pc(w, 'PC1').runtime.traps.length, 1);
});

test('responder crypto ACL first-match deny blocks negotiation and reuse despite its later mirrored permit', () => {
  const w = referenceLab();
  const request = ping('PC1', ADDR.pc3);
  assert.equal(sendFlow(w, request).ok, true);
  config(w, 'R2', 'ip access-list extended 120', `5 deny icmp host ${ADDR.pc3} host ${ADDR.pc1Public}`);
  const denied = sendFlow(w, request);
  assert.equal(denied.forward.reason, 'ipsec-negotiation-failed');
  assert.match(denied.summary, /R2 denies the mirrored packet at entry 5/);
  assert.equal(denied.forward.encrypted, false);
  assert.equal(r1(w).runtime.ipsecSas.length + r2(w).runtime.ipsecSas.length, 0);
  config(w, 'R2', 'ip access-list extended 120', 'no 5');
  const restored = sendFlow(w, request);
  assert.deepEqual([restored.ok, restored.forward.negotiated, restored.reverse?.encrypted], [true, true, true]);
  assert.deepEqual([r1(w).runtime.ipsecSas[0].encaps, r2(w).runtime.ipsecSas[0].decaps], [1, 1]);
});

test('TCP 22 still crosses in ESP and is classified, but no SSH service or login is claimed', () => {
  const w = referenceLab();
  config(w, 'R2', 'line vty 0 4', 'transport input telnet ssh');
  const f = sendFlow(w, tcp('PC1', ADDR.r2Wan, 22));
  assert.deepEqual([f.outcome, f.forward.atDeviceId, f.forward.encrypted, f.reverse?.encrypted], ['refused', 'R2', true, true]);
  assert.equal(f.forward.qos[0]?.childClass, 'classGuaranteed');
  assert.match(f.summary, /does not run an SSH server/);
  assert.equal(f.vty?.login, undefined);
  assert.equal(sendFlow(w, tcp('PC1', ADDR.r2Wan, 23)).vty?.login, 'password');
  assert.equal(sendFlow(w, tcp('PC2', ADDR.r2Wan, 23)).vty?.reason, 'access-class');
});

test('QoS keeps the nominal serial clock separate from bandwidth metadata after no clock rate', () => {
  const w = referenceLab();
  config(w, 'R1', `interface ${SE}`, 'no clock rate');
  const clock = serialClock(w, 'R2', SE)!;
  const plan = qosPlan(w, 'R2', SE);
  assert.equal(clock.configured, undefined);
  assert.equal(plan.physicalBps, clock.effective);
  assert.equal(plan.clockRateBps, undefined);
  assert.equal(plan.bandwidthKbps, 128);
  assert.equal(plan.shapedBps, 121600, 'shape percent still uses configured bandwidth');
});

test('qos pre-classify changes the strict-profile classifier but does not reset negotiated SAs', () => {
  const w = referenceLab({ settings: { qosClassifiesInnerHeader: false } });
  const request = ping('PC1', ADDR.pc3);
  const first = sendFlow(w, request);
  assert.equal(first.forward.qos[0]?.childClass, 'class-default');
  const old = r1(w).runtime.ipsecSas[0];
  const expected = old.encaps + 1;
  config(w, 'R1', 'crypto map CM 10 ipsec-isakmp', 'qos pre-classify');
  const next = sendFlow(w, request);
  assert.equal(r1(w).runtime.ipsecSas[0].id, old.id);
  assert.equal(r1(w).runtime.ipsecSas[0].encaps, expected);
  assert.deepEqual([next.forward.negotiated, next.forward.qos[0]?.childClass, next.reverse?.qos[0]?.childClass], [undefined, 'classPriority', 'class-default']);
  config(w, 'R1', 'crypto map CM 10 ipsec-isakmp', 'no qos pre-classify');
  assert.equal(sendFlow(w, request).forward.qos[0]?.childClass, 'class-default');

  const exam = referenceLab();
  const notes = config(exam, 'R1', 'crypto map CM 10 ipsec-isakmp', 'qos pre-classify');
  assert.match(notes[1].notes.join(' '), /saved but does not change classification in this profile/);
  assert.match(sendFlow(exam, request).forward.steps.find((s) => s.stage === 'qos')?.detail ?? '', /training profile/);
});
