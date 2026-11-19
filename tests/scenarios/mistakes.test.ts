/**
 * The grader is not fooled.
 *  - Every fault of the catalogue (36 single mistakes), applied to the solved case study, makes the requirement(s) it
 *    is aimed at fail, while everything outside its documented side effects still passes. Its documented fix,
 *    typed through the CLI, brings the lab back to 100 %.
 *  - A correct solution that looks completely different from the model solution scores 100 %.
 *  - Shortcuts that would satisfy a naive checker (deny everything, encrypt everything, no access control) earn nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ScenarioInstance, World } from '../../src/engine/types.ts';
import { applyConfigText } from '../../src/engine/config/apply.ts';
import { benchWorld, caseSpec, faultCatalogue, getScenario } from '../../src/scenarios/index.ts';
import { plugCable, setPc } from '../../src/scenarios/apply.ts';
import { ALT_CABLES, ALT_PCS, ALT_R1, ALT_R2 } from './alternative.ts';
import { applyOps, gradeOf, renewLeases, saveRouters, solvedWorld } from './helpers.ts';

const inst: ScenarioInstance = getScenario('case-study-2026')!.build(0);
const solved: World = solvedWorld(inst);
const catalogue = faultCatalogue(caseSpec());

function typeOn(world: World, dev: string, text: string): void {
  const r = applyConfigText(world, dev, text, 'merge');
  assert.deepEqual(r.lines.filter((l) => !l.ok).map((l) => `${l.line} → ${l.output.trim()}`), [], `lines accepted on ${dev}`);
}

test('the solved case study is the baseline: 100 %', () => {
  assert.equal(gradeOf(inst, solved).percent, 100);
});

test('the catalogue holds at least 18 faults and covers every topic, physical ones included', () => {
  assert.ok(catalogue.length >= 18, `${catalogue.length} faults`);
  assert.equal(new Set(catalogue.map((f) => f.id)).size, catalogue.length, 'ids are unique');
  for (const layer of ['physical', 'addressing', 'dhcp', 'nat', 'acl', 'ipsec', 'qos', 'mgmt']) {
    assert.ok(catalogue.some((f) => f.layer === layer), `a fault for ${layer}`);
  }
  for (const feature of ['cabling', 'interface', 'routing', 'dhcp', 'nat', 'acl', 'ipsec', 'qos', 'vty', 'snmp', 'syslog', 'pc']) {
    assert.ok(catalogue.some((f) => f.feature === feature), `a fault whose cause is ${feature}`);
  }
  const reqIds = new Set(inst.requirements.map((r) => r.id));
  for (const f of catalogue) {
    assert.ok(f.mustFail.length > 0, `${f.id} names the requirement it breaks`);
    for (const id of [...f.mustFail, ...f.mayFail]) assert.ok(reqIds.has(id), `${f.id}: ${id} is a requirement of the case study`);
    assert.ok(f.ticket.length > 20 && f.title.length > 20 && f.fixText.length > 10, `${f.id} has ticket, cause and fix texts`);
    assert.ok(!f.ticket.includes(f.title), `${f.id}: the ticket describes the symptom, not the cause`);
  }
});

for (const f of catalogue) {
  test(`single mistake "${f.id}": the right requirement fails, unrelated ones pass, the fix restores 100 %`, () => {
    const world = structuredClone(solved);
    const env0 = structuredClone(world);
    applyOps(world, f.break, `${f.id} (break)`);
    assert.notDeepEqual(world, env0, 'the mistake changes the lab');
    saveRouters(world); // the mistake was saved with the rest
    // Faults below the DHCP layer are graded twice: with the leases the PCs still hold, and after they asked again.
    const rounds = ['physical', 'addressing', 'dhcp', 'acl'].includes(f.layer) ? [false, true] : [false];
    for (const renewed of rounds) {
      if (renewed) renewLeases(world);
      const g = gradeOf(inst, world);
      for (const id of f.mustFail) assert.ok(g.failing.includes(id), `${id} must fail${renewed ? ' (after new leases)' : ''}; failing: ${g.failing.join(', ')}`);
      const unexpected = g.failing.filter((id) => !f.mustFail.includes(id) && !f.mayFail.includes(id));
      assert.deepEqual(unexpected, [], `unrelated requirements still pass${renewed ? ' (after new leases)' : ''}`);
      assert.ok(g.percent < 100);
    }
    applyOps(world, f.fix, `${f.id} (fix)`);
    renewLeases(world);
    saveRouters(world);
    const after = gradeOf(inst, world);
    assert.deepEqual(after.failedChecks, [], 'the documented fix repairs the lab');
    assert.equal(after.percent, 100);
  });
}

// ───────────────────────────── an equivalent but different solution ─────────────────────────────
function alternativeWorld(): World {
  const world = benchWorld(inst);
  for (const c of ALT_CABLES) plugCable(world, c);
  typeOn(world, 'R1', ALT_R1);
  typeOn(world, 'R2', ALT_R2);
  for (const [id, setup] of Object.entries(ALT_PCS)) setPc(world, id, setup);
  renewLeases(world);
  saveRouters(world);
  return world;
}
const alternative = alternativeWorld();

test('an equivalent but different solution scores 100 %: other ports and addresses, named ACLs, other names, next-hop routes', () => {
  const g = gradeOf(inst, alternative);
  assert.deepEqual(g.failedChecks, []);
  assert.equal(g.percent, 100);
  assert.deepEqual(Object.values(inst.guideProgress(alternative, [])).filter((v) => !v), [], 'every guide step counts as done too');
});

const altMistakes: { name: string; dev: string; text: string; fails: string[] }[] = [
  { name: 'final permit removed from the named list', dev: 'R1', text: 'ip access-list extended LAN1-IN\n no permit ip any any', fails: ['acl-pc1', 'acl-pc2'] },
  { name: 'shaper set to a wrong fixed rate', dev: 'R2', text: 'policy-map SHAPE\n class class-default\n  shape average 100000', fails: ['qos'] },
  { name: 'PC3 allowed to write by SNMP', dev: 'R1', text: 'ip access-list standard SNMP-WRITE\n permit host 99.1.1.66', fails: ['snmp'] },
  { name: 'clock rate removed from the DCE end (R2 here)', dev: 'R2', text: 'interface Serial0/1/1\n no clock rate', fails: ['qos'] },
  { name: 'logging without a source interface on R2', dev: 'R2', text: 'no logging source-interface', fails: ['syslog'] },
];
for (const m of altMistakes) {
  test(`different solution with one mistake (${m.name}): ${m.fails.join(' and ')} fail${m.fails.length === 1 ? 's' : ''}`, () => {
    const world = structuredClone(alternative);
    typeOn(world, m.dev, m.text);
    saveRouters(world);
    const g = gradeOf(inst, world);
    for (const id of m.fails) assert.ok(g.failing.includes(id), `${id} fails; failing: ${g.failing.join(', ')}`);
  });
}

// ───────────────────────────── shortcuts earn nothing ─────────────────────────────
function earned(world: World, id: string): number {
  return inst.grade(world, []).requirements.find((r) => r.id === id)!.earned;
}
function fromSolved(dev: string, text: string): World {
  const world = structuredClone(solved);
  typeOn(world, dev, text);
  saveRouters(world);
  return world;
}

test('shortcut: an access list that denies everything earns no ACL points', () => {
  const world = fromSolved('R1', 'no access-list 110\naccess-list 110 deny ip any any');
  assert.equal(earned(world, 'acl-pc1'), 0);
  assert.equal(earned(world, 'acl-pc2'), 0);
});

test('shortcut: encrypting everything fails the IPsec requirement', () => {
  const world = structuredClone(solved);
  for (const dev of ['R1', 'R2']) typeOn(world, dev, 'no access-list 120\naccess-list 120 permit ip any any');
  saveRouters(world);
  const g = inst.grade(world, []).requirements.find((r) => r.id === 'ipsec')!;
  assert.equal(g.pass, false);
  assert.equal(g.checks.find((c) => c.id === 'ipsec/clear')!.pass, false, 'traffic that is not on the list must stay in clear');
});

test('shortcut: vty lines without an access-class fail Telnet', () => {
  const world = structuredClone(solved);
  for (const dev of ['R1', 'R2']) typeOn(world, dev, 'line vty 0 4\n no access-class allowPC1 in\nline vty 5 14\n no access-class allowPC1 in');
  const g = inst.grade(world, []).requirements.find((r) => r.id === 'telnet')!;
  assert.equal(g.pass, false);
  assert.deepEqual(g.checks.filter((c) => !c.pass).map((c) => c.id), ['telnet/others-r1', 'telnet/others-r2']);
});

test('shortcut: a protected first vty range does not hide an open second range', () => {
  const world = fromSolved('R2', 'line vty 5 14\n no access-class allowPC1 in');
  const g = inst.grade(world, []).requirements.find((r) => r.id === 'telnet')!;
  assert.equal(g.checks.find((c) => c.id === 'telnet/others-r2')!.pass, false);
});

test('mistake: Telnet with login but no line password cannot give PC1 access', () => {
  const world = fromSolved('R1', 'line vty 0 4\n no password');
  assert.equal(inst.grade(world, []).requirements.find((r) => r.id === 'telnet')!.checks.find((c) => c.id === 'telnet/pc1-r1')!.pass, false);
});

test('shortcut: SNMP communities without access lists fail SNMP', () => {
  const world = structuredClone(solved);
  for (const dev of ['R1', 'R2']) typeOn(world, dev, 'no snmp-server community D105read\nno snmp-server community D105write\nsnmp-server community D105read RO\nsnmp-server community D105write RW');
  const g = inst.grade(world, []).requirements.find((r) => r.id === 'snmp')!;
  assert.deepEqual(g.checks.filter((c) => !c.pass).map((c) => c.id), ['snmp/no-write', 'snmp/no-read']);
});

test('mistake: a routing protocol next to the static route fails the routing requirement', () => {
  const world = fromSolved('R1', 'router rip\n version 2\n network 192.168.100.0');
  assert.ok(gradeOf(inst, world).failing.includes('routes'));
});

test('mistake: a second static route fails the routing requirement', () => {
  const world = fromSolved('R2', 'ip route 192.168.100.0 255.255.255.0 60.50.30.1');
  assert.deepEqual(gradeOf(inst, world).failing, ['routes']);
});

test('mistake: PC2 with a static address fails DHCP only', () => {
  const world = structuredClone(solved);
  setPc(world, 'PC2', { mode: 'static', address: '192.168.100.101', mask: '255.255.255.0', gateway: '192.168.100.1' });
  assert.deepEqual(gradeOf(inst, world).failing, ['dhcp']);
});

test('mistake: a second DHCP server on R2 fails the one-server check', () => {
  const world = fromSolved('R2', 'ip dhcp pool EXTRA\n network 60.50.40.0 255.255.255.192\n default-router 60.50.40.1');
  renewLeases(world);
  const g = inst.grade(world, []).requirements.find((r) => r.id === 'dhcp')!;
  assert.equal(g.checks.find((c) => c.id === 'dhcp/one-server')!.pass, false);
});

test('mistake: routers joined by Ethernet where the sheet needs a serial link fails cabling and QoS', () => {
  const world = structuredClone(solved);
  plugCable(world, { kind: 'crossover', a: { deviceId: 'R1', port: 'GigabitEthernet0/0/1' }, b: { deviceId: 'R2', port: 'GigabitEthernet0/0/1' } });
  world.cables = world.cables.filter((c) => c.kind !== 'serial');
  const g = gradeOf(inst, world);
  assert.ok(g.failing.includes('cabling'));
});

test('mistake: without qos pre-classify the QoS classes miss encrypted traffic when the router classifies after encryption', () => {
  const world = structuredClone(solved);
  world.settings.qosClassifiesInnerHeader = false;
  assert.equal(gradeOf(inst, world).percent, 100, 'the model solution has qos pre-classify, so it works on such a router too');
  for (const dev of ['R1', 'R2']) typeOn(world, dev, 'crypto map CM 10 ipsec-isakmp\n no qos pre-classify');
  saveRouters(world);
  const g = inst.grade(world, []).requirements.find((r) => r.id === 'qos')!;
  assert.equal(g.pass, false);
  assert.match(g.checks.find((c) => c.id === 'qos/r1-priority')!.tip ?? '', /qos pre-classify/);
});

test('every failing check carries a tip, and probe-based checks carry the trace of the deciding probe', () => {
  const world = fromSolved('R1', 'interface GigabitEthernet0/0/0\n no ip nat inside');
  const result = inst.grade(world, []);
  const failed = result.requirements.flatMap((r) => r.checks.filter((c) => !c.pass));
  assert.ok(failed.length > 0);
  for (const c of failed) assert.ok(c.tip && c.tip.length > 5, `${c.id} has a tip`);
  const pat = result.requirements.find((r) => r.id === 'pat')!.checks[0];
  assert.equal(pat.pass, false);
  assert.ok(pat.trace && pat.trace.length > 3, 'the PAT check shows the path of the ping');
  assert.match(pat.observed, /192\.168\.100\.101/, 'observed says which address R2 saw');
});
