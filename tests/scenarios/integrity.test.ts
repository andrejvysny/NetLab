import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyConfigText } from '../../src/engine/config/apply.ts';
import { dhcpAcquire, dhcpRelease, sendFlow } from '../../src/engine/sim/index.ts';
import type { JournalEntry, World } from '../../src/engine/types.ts';
import { getScenario } from '../../src/scenarios/index.ts';
import { solvedWorld } from './helpers.ts';

const instance = getScenario('case-study-2026')!.build(0);
const solved = solvedWorld(instance);
const clean = (): World => structuredClone(solved);
function type(w: World, id: string, text: string): void {
  const r = applyConfigText(w, id, text, 'merge');
  assert.deepEqual(r.lines.filter((l) => !l.ok).map((l) => `${l.line} -> ${l.output}`), []);
}
const req = (w: World, id: string) => instance.grade(w, []).requirements.find((r) => r.id === id)!;
const isPass = (w: World, id: string, chk: string) => req(w, id).checks.find((c) => c.id === `${id}/${chk}`)?.pass;

test('NAT: changing R2 management ACLs to the untranslated source breaks actual Telnet and SNMP', () => {
  const w = clean();
  const fromPc1 = { fromDeviceId: 'PC1', dst: '60.50.30.2', proto: 'tcp' as const, dport: 23 };
  assert.equal(sendFlow(w, fromPc1).forward.received?.src, '60.50.50.100');
  type(w, 'R2', `ip access-list standard allowPC1
 no permit 60.50.50.100
 permit 192.168.100.10
no access-list 10
access-list 10 permit host 192.168.100.10
access-list 10 permit host 60.50.40.2
no access-list 11
access-list 11 permit host 192.168.100.10`);
  assert.equal(isPass(w, 'telnet', 'pc1-r1'), true);
  assert.equal(isPass(w, 'telnet', 'pc1-r2'), false);
  assert.equal(isPass(w, 'snmp', 'pc1-read'), false);
  assert.equal(isPass(w, 'snmp', 'pc1-write'), false);
  assert.equal(isPass(w, 'snmp', 'pc3-read'), true);
  assert.equal(req(w, 'static-nat').pass, true);
});

test('Telnet and SNMP ACL leak beyond named PCs, even though PC2/PC3 probes alone would not detect it', () => {
  const w = clean();
  type(w, 'R2', `ip access-list standard allowPC1
 permit 60.50.99.0 0.0.0.255
access-list 10 permit 60.50.98.0 0.0.0.255
access-list 11 permit 60.50.97.0 0.0.0.255`);
  assert.equal(isPass(w, 'telnet', 'pc1-r2'), true);
  assert.equal(isPass(w, 'telnet', 'others-r2'), false);
  assert.equal(isPass(w, 'snmp', 'pc1-read'), true);
  assert.equal(isPass(w, 'snmp', 'pc1-write'), true);
  assert.equal(isPass(w, 'snmp', 'no-read'), false);
  assert.equal(isPass(w, 'snmp', 'no-write'), false);
});

test('management first-match ACL accepts explicit terminal deny and notes idle line availability, not active sessions', () => {
  const w = clean();
  type(w, 'R2', `ip access-list standard allowPC1
 deny any
 permit 60.50.99.0 0.0.0.255
access-list 10 deny any
access-list 10 permit 60.50.98.0 0.0.0.255`);
  const d = w.devices.R2;
  assert.ok(d.kind === 'router');
  d.runtime.vtyInUse = 15;
  assert.equal(req(w, 'telnet').pass, true);
  assert.equal(req(w, 'snmp').pass, true);
});

test('working management on R1 is not credited as also working on R2', () => {
  const w = clean();
  type(w, 'R2', `line vty 0 14
 transport input none
no snmp-server community D105read
no snmp-server community D105write
no logging 60.50.50.100`);
  assert.equal(isPass(w, 'telnet', 'pc1-r1'), true);
  assert.equal(isPass(w, 'telnet', 'pc1-r2'), false);
  assert.equal(isPass(w, 'snmp', 'pc1-read'), false);
  assert.equal(isPass(w, 'syslog', 'r1'), true);
  assert.equal(isPass(w, 'syslog', 'r2'), false);
});

test('PAT must select the LAN, not any source or only the two sampled hosts', () => {
  for (const lines of ['access-list 1 permit any', 'access-list 1 permit host 192.168.100.101\naccess-list 1 permit host 192.168.100.254']) {
    const w = clean();
    type(w, 'R1', `no access-list 1\n${lines}`);
    assert.equal(isPass(w, 'pat', 'pc2-out'), true);
    assert.equal(isPass(w, 'pat', 'shared'), true);
    assert.equal(isPass(w, 'pat', 'scope'), false);
  }
});

test('a permitted HTTP SYN without a return path does not finish task 7', () => {
  const w = clean();
  type(w, 'R1', `access-list 130 deny tcp any eq www any
access-list 130 permit ip any any
interface Serial0/1/0
 ip access-group 130 in`);
  const f = sendFlow(w, { fromDeviceId: 'PC2', dst: '60.50.40.2', proto: 'tcp', dport: 80 });
  assert.equal(f.forward.ok, true);
  assert.equal(f.reverse?.reason, 'acl-in');
  assert.equal(isPass(w, 'acl-pc2', 'allow-http'), false);
});

test('a DHCP exclusion hole is not excused because the static PC answered the conflict check', () => {
  const w = clean();
  type(w, 'R1', `no ip dhcp excluded-address 192.168.100.1 192.168.100.100
ip dhcp excluded-address 192.168.100.1 192.168.100.9
ip dhcp excluded-address 192.168.100.11 192.168.100.100`);
  assert.equal(isPass(w, 'dhcp', 'pc2'), true);
  assert.equal(isPass(w, 'dhcp', 'exclusion'), false);
});

test('IPsec: ESP seen leaving its sender does not prove the protected packet arrives', () => {
  const w = clean();
  type(w, 'R2', 'interface GigabitEthernet0/0/0\n shutdown\nno ip route 0.0.0.0 0.0.0.0 Serial0/1/0 60.50.30.1');
  const f = sendFlow(w, { fromDeviceId: 'R1', dst: '60.50.40.1', proto: 'udp', dport: 162 });
  assert.equal(f.forward.encrypted, true);
  assert.ok(f.forward.steps.some((x) => x.deviceId === 'R2' && x.stage === 'decrypt'));
  assert.equal(f.forward.received, undefined, 'decrypting a packet is not the same as delivering it');
  assert.equal(isPass(w, 'ipsec', 'enc-snmp'), false);
});

test('IPsec rejects encryption of an extra unlisted service beyond the first clear control', () => {
  const w = clean();
  for (const id of ['R1', 'R2']) type(w, id, `access-list 120 permit udp any any eq 514
access-list 120 permit udp any eq 514 any`);
  assert.equal(isPass(w, 'ipsec', 'tunnel'), true);
  assert.equal(isPass(w, 'ipsec', 'clear'), false);
});

test('QoS with configured policies but a dead WAN earns no task 10 points', () => {
  const w = clean();
  type(w, 'R1', 'interface Serial0/1/0\n shutdown');
  assert.equal(req(w, 'qos').earned, 0);
  assert.equal(instance.guideProgress(w, []).qos, false);
});

test('QoS accepts a larger minimum and an equivalent absolute shaper, including the documented 125 kbit/s fallback', () => {
  const w = clean();
  type(w, 'R1', 'interface Serial0/1/0\n clock rate 125000');
  for (const id of ['R1', 'R2']) type(w, id, `interface Serial0/1/0
 no bandwidth
policy-map output_QE
 class classGuaranteed
  bandwidth 56
policy-map output_SE
 class class-default
  shape average 118750`);
  assert.equal(req(w, 'qos').pass, true);
  type(w, 'R2', 'policy-map output_SE\n class class-default\n  shape average 121600');
  assert.equal(isPass(w, 'qos', 'r2-shape'), false, '95% is based on the actual accepted DCE clock');
});

test('configuration before cabling is advisory; saving is recommended and does not affect the practice score', () => {
  const w = clean();
  const j: JournalEntry[] = [
    { tick: 1, deviceId: 'R1', via: 'console', line: 'hostname R1', mode: 'config', feature: 'system', mutated: true, ok: true },
    ...instance.solution.cables.filter((c) => c.kind !== 'console').map((c, i): JournalEntry => ({
      tick: 5 + i, deviceId: c.a.deviceId, via: 'bench', line: `Plug ${c.kind} ${c.a.port} to ${c.b.port}`, feature: 'cabling', ok: true, mutated: true,
    })),
  ];
  const d = w.devices.R1;
  assert.ok(d.kind === 'router');
  d.startupConfig = null;
  const report = instance.grade(w, j);
  assert.ok(report.orderIssues.some((i) => /Either order can work/.test(i.text)));
  assert.equal(report.requirements.find((r) => r.id === 'saved')?.pass, false);
  assert.equal(report.requirements.reduce((sum, r) => sum + r.earned, 0), 18);
  assert.deepEqual(report.requirements, instance.grade(w, []).requirements);
});

test('guide prints the DHCP commands for the actual client operating systems', () => {
  const g = instance.guide.find((x) => x.id === 'dhcp')!;
  assert.match(g.example ?? '', /PC2: ipconfig \/renew/);
  assert.match(g.example ?? '', /PC3: sudo ipconfig set en0 DHCP/);
  assert.doesNotMatch(g.example ?? '', /PC3: ipconfig \/renew/);
});

test('Lab guides NAT to R1, but Exam mode allows the same command before data cabling', async () => {
  const { Lab } = await import('../../src/engine/lab.ts');
  const { consoleIn, perform } = await import('../lab/guided-driver.ts');
  const { stepScripts } = await import('../../src/scenarios/index.ts');
  const lab = new Lab({ storage: null });
  const cmd = 'ip nat inside source static 192.168.100.10 60.50.50.100';
  assert.equal(lab.startScenario('case-study-2026', 'guided').ok, true);
  for (const step of stepScripts(instance)) {
    if (step.stepId === 'nat') break;
    for (const a of step.script) perform(lab, a);
  }
  const r2 = consoleIn(lab, 'R2', 'config');
  assert.match(lab.sessionExec(r2, cmd).blocked?.reason ?? '', /about R1, not R2/);
  const r1 = consoleIn(lab, 'R1', 'config');
  assert.equal(lab.sessionExec(r1, cmd).blocked, undefined);

  assert.equal(lab.startScenario('case-study-2026', 'exam').ok, true);
  assert.equal(lab.connectCable('console', { deviceId: 'PC1', port: 'COM1' }, { deviceId: 'R1', port: 'Console' }).ok, true);
  const r1exam = consoleIn(lab, 'R1', 'config');
  assert.equal(lab.sessionExec(r1exam, cmd).blocked, undefined);
  assert.equal(lab.getState().journal.at(-1)?.ok, true);
});


test('one DHCP server on R2 is a valid alternative in the full case when DHCP relay and NAT actually work', () => {
  const w = clean();
  type(w, 'R1', `no ip dhcp pool LAN1
no ip dhcp pool LAN2
no ip dhcp excluded-address 192.168.100.1 192.168.100.100
interface GigabitEthernet0/0/0
 ip helper-address 60.50.30.2`);
  type(w, 'R2', `interface GigabitEthernet0/0/0
 no ip helper-address 60.50.30.1
ip dhcp excluded-address 192.168.100.1 192.168.100.100
ip dhcp pool LAN1
 network 192.168.100.0 255.255.255.0
 default-router 192.168.100.1
ip dhcp pool LAN2
 network 60.50.40.0 255.255.255.192
 default-router 60.50.40.1`);
  for (const pc of ['PC2', 'PC3']) {
    dhcpRelease(w, pc);
    assert.ok(dhcpAcquire(w, pc).ok);
  }
  assert.equal(req(w, 'dhcp').pass, true);
  assert.equal(req(w, 'pat').pass, true);
  assert.equal(req(w, 'static-nat').pass, true);
  assert.equal(req(w, 'snmp').pass, true);
});
