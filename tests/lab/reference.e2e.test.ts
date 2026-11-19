/**
 * The course reference solution (docs/COURSE.md) done by hand through LabApi: cables, console cable from device to device,
 * every configuration line typed on the console, PCs set up — then the acceptance facts of COURSE.md are checked through
 * the Lab. This runs today; tests/lab/case-study.e2e.test.ts does the same with the real scenario once it exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lab } from '../../src/engine/lab.ts';
import type { IosDevice, PcDevice } from '../../src/engine/types.ts';
import { fakePc } from './fixture.ts';
import { failures, solveThroughLabApi } from './e2e-driver.ts';
import { referenceScenario } from './reference.ts';

function solved() {
  const lab = new Lab({ scenarios: [referenceScenario()], storage: null, pcExec: fakePc });
  const r = solveThroughLabApi(lab, 'reference');
  return { lab, r };
}
const SE = 'Serial0/1/0';

test('reference solution typed by hand through LabApi scores 100 % and behaves as docs/COURSE.md says', () => {
  const { lab, r } = solved();
  assert.deepEqual(r.refused, [], 'IOS accepts every line of the reference configuration when it is typed');
  assert.equal(r.report.points, r.report.maxPoints, `not passed:\n${failures(r.report)}`);
  assert.equal(r.report.scaled18, 18);
  const w = lab.getState().world!;
  const pc = (id: string) => w.devices[id] as PcDevice;
  const ios = (id: string) => w.devices[id] as IosDevice;

  // DHCP: PC2 got .101 (PC1 never asked and is static), PC3 through the relay
  assert.equal(pc('PC2').nic.address, '192.168.100.101');
  assert.equal(pc('PC3').nic.address, '60.50.40.2');
  assert.equal(pc('PC3').nic.dhcpServer, '60.50.30.1');
  assert.equal(pc('PC4').nic.address, undefined, 'the unused MacBook was never told to ask');

  // the packet walkthrough tells the same story
  const flow = (spec: Parameters<Lab['trace']>[0]) => { const f = lab.trace(spec); assert.ok(!('error' in f)); return f as Exclude<typeof f, { error: string }>; };
  const p13 = flow({ fromDeviceId: 'PC1', dst: '60.50.40.2', proto: 'icmp' });
  assert.deepEqual([p13.ok, p13.forward.received?.src, p13.forward.encrypted], [true, '60.50.50.100', true]);
  assert.equal(flow({ fromDeviceId: 'PC1', dst: '2.2.2.2', proto: 'icmp' }).symbol, 'U');
  const http = flow({ fromDeviceId: 'PC2', dst: '60.50.40.2', proto: 'tcp', dport: 80 });
  assert.deepEqual([http.ok, http.forward.encrypted, http.forward.received?.src], [true, false, '60.50.30.1']);
  assert.equal(flow({ fromDeviceId: 'PC2', dst: '60.50.40.2', proto: 'tcp', dport: 21 }).ok, false);
  assert.deepEqual(p13.forward.qos.map((q) => [q.deviceId, q.policy, q.childClass]), [['R1', 'output_SE', 'classPriority']]);

  // QoS tool: 128 kbit/s link, shaped to 95 %
  const q = lab.qosLoad({ deviceId: 'R1', iface: SE, offered: [
    { label: 'ping', kbps: 100, flow: { fromDeviceId: 'R1', dst: '60.50.30.2', proto: 'icmp' } },
    { label: 'telnet', kbps: 100, flow: { fromDeviceId: 'R1', dst: '60.50.30.2', proto: 'tcp', dport: 23 } },
    { label: 'web', kbps: 100, flow: { fromDeviceId: 'R1', dst: '60.50.30.2', proto: 'tcp', dport: 80 } },
  ] });
  assert.deepEqual([q.ok, q.linkKbps, q.shapedKbps], [true, 128, 121.6]);
  assert.deepEqual(q.rows.map((x) => x.className), ['classPriority', 'classGuaranteed', 'class-default']);
  assert.equal(q.rows[0].deliveredKbps, 16);

  // Telnet: only PC1 gets in; the session is a real vty CLI on R2
  assert.equal(lab.pcExec('PC2', 'telnet 192.168.100.1').session, undefined);
  assert.equal(lab.pcExec('PC3', 'telnet 60.50.40.1').session, undefined);
  const tel = lab.pcExec('PC1', 'telnet 60.50.30.2');
  assert.ok(tel.session);
  assert.equal(tel.session.title, 'Telnet 60.50.30.2 — from PC1');
  assert.equal(lab.sessionExec(tel.session.id, 'cisco').prompt, 'R2>');
  assert.equal(ios('R2').runtime.vtyInUse, 1);
  assert.equal(lab.sessionExec(tel.session.id, 'exit').closed, true);

  // SNMP: PC1 reads and writes, PC3 only reads, PC2 gets no answer
  assert.deepEqual(lab.pcSnmp('PC1', { host: '60.50.30.2', community: 'D105read', op: 'get', oid: 'sysName.0' }), { ok: true, text: 'sysName.0 = STRING: R2' });
  assert.equal(lab.pcSnmp('PC1', { host: '60.50.30.2', community: 'D105write', op: 'set', oid: 'sysLocation.0', value: 'D105' }).ok, true);
  assert.equal(lab.pcSnmp('PC3', { host: '60.50.30.1', community: 'D105read', op: 'get', oid: 'sysName.0' }).ok, true);
  assert.equal(lab.pcSnmp('PC3', { host: '60.50.30.1', community: 'D105write', op: 'set', oid: 'sysLocation.0', value: 'x' }).ok, false);
  assert.equal(lab.pcSnmp('PC2', { host: '192.168.100.1', community: 'D105read', op: 'get', oid: 'sysName.0' }).ok, false);

  // Syslog: both routers report to PC1 from their Loopback0 (R2's messages arrive through the static NAT)
  lab.clearPcLog('PC1', 'syslog');
  const con = lab.getState().sessions.find((s) => s.deviceId === 'R2' && s.kind === 'console' && !s.closed);
  assert.ok(con, 'the console is still on R2');
  lab.sessionExec(con.id, 'configure terminal');
  const end = lab.sessionExec(con.id, 'end');
  assert.match(end.output, /%SYS-5-CONFIG_I: Configured from console by console/);
  const com = lab.portStatus({ deviceId: 'PC1', port: 'COM1' }).cableId!;
  assert.ok(lab.removeCable(com).ok);
  assert.ok(lab.connectCable('console', { deviceId: 'PC1', port: 'COM1' }, { deviceId: 'R1', port: 'Console' }).ok);
  const r1 = lab.openConsole('R1');
  assert.ok(r1.ok && r1.session.prompt === 'R1#', 'R1 is still where it was left');
  if (!r1.ok) return;
  lab.sessionExec(r1.session.id, 'configure terminal');
  lab.sessionExec(r1.session.id, 'end');
  assert.deepEqual(pc('PC1').runtime.syslog.map((m) => [m.from, m.mnemonic]), [['2.2.2.2', 'SYS-5-CONFIG_I'], ['1.1.1.1', 'SYS-5-CONFIG_I']]);
});

test('the same lab can be built from config files and resumed from an export', () => {
  const lab = new Lab({ scenarios: [referenceScenario()], storage: null, pcExec: fakePc });
  assert.ok(lab.startScenario('reference', 'free').ok);
  const sol = lab.solution()!;
  for (const c of sol.cables) if (c.kind !== 'console') assert.ok(lab.connectCable(c.kind, c.a, c.b, { dceEnd: c.dceEnd }).ok);
  // PCs first this time: PC2 and PC3 ask before any router is configured, and get their leases by themselves later
  assert.ok(lab.setPcNic('PC1', { mode: 'static', address: '192.168.100.10', mask: '255.255.255.0', gateway: '192.168.100.1' }).ok);
  lab.setPcService('PC1', 'syslog', true);
  lab.setPcService('PC3', 'http', true);
  lab.setPcService('PC3', 'ftp', true);
  assert.equal(lab.setPcNic('PC2', { mode: 'dhcp' }).ok, false);
  assert.equal(lab.setPcNic('PC3', { mode: 'dhcp' }).ok, false);
  for (const dev of ['R1', 'R2']) {
    const refused = lab.applyConfigText(dev, sol.configs[dev], 'merge');
    assert.equal(refused.ok, false, 'no console cable, no file');
    assert.match(refused.message ?? '', /No console cable is connected/);
    const old = lab.portStatus({ deviceId: 'PC1', port: 'COM1' }).cableId;
    if (old) lab.removeCable(old);
    assert.ok(lab.connectCable('console', { deviceId: 'PC1', port: 'COM1' }, { deviceId: dev, port: 'Console' }).ok);
    const rep = lab.applyConfigText(dev, sol.configs[dev], 'merge');
    assert.deepEqual([rep.ok, rep.failed], [true, 0], JSON.stringify(rep.lines.filter((l) => !l.ok)));
  }
  const w = lab.getState().world!;
  assert.equal((w.devices.PC2 as PcDevice).nic.address, '192.168.100.101');
  assert.equal((w.devices.PC3 as PcDevice).nic.address, '60.50.40.2');
  const rep = lab.check();
  assert.equal(rep.points, rep.maxPoints, failures(rep));
  // the journal has one entry per file line, with the topic of each line
  const file = lab.getState().journal.filter((e) => e.via === 'file');
  assert.ok(file.length > 150);
  assert.deepEqual(file.find((e) => e.line === 'ip nat inside')?.feature, 'nat');
  assert.deepEqual(file.find((e) => e.line === 'crypto map CM')?.feature, 'ipsec');
  assert.deepEqual(file.find((e) => e.line === 'priority 16')?.mode, 'config-pmap-c');
  // export → import → same grade
  const copy = new Lab({ scenarios: [referenceScenario()], storage: null, pcExec: fakePc });
  assert.ok(copy.importLab(lab.exportLab()).ok);
  const again = copy.check();
  assert.equal(again.points, rep.points);
  assert.deepEqual(copy.getState().world, lab.getState().world);
});
