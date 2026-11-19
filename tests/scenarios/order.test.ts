/**
 * Order observations from the journal: factual, calm, and only where something really happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalEntry, ScenarioInstance, World } from '../../src/engine/types.ts';
import { benchWorld, getScenario, startWorld } from '../../src/scenarios/index.ts';
import { solvedWorld, walkthrough } from './helpers.ts';

const inst: ScenarioInstance = getScenario('case-study-2026')!.build(0);
const solved: World = solvedWorld(inst);

let tick = 0;
function cli(deviceId: string, mode: string, line: string, more: Partial<JournalEntry> = {}): JournalEntry {
  tick += 1;
  return { tick, deviceId, via: 'console', mode, line, feature: 'system', ok: true, mutated: mode.startsWith('config'), ...more };
}
function cable(line: string, feature: 'cabling' | 'console' = 'cabling'): JournalEntry {
  tick += 1;
  return { tick, deviceId: 'R1', via: 'bench', line, feature, ok: true, mutated: true };
}
const CABLES = [
  'Plug in Ethernet straight-through cable: PC1 Eth0 to SW1 Gi1/0/1', 'Plug in Ethernet straight-through cable: PC2 Eth0 to SW1 Gi1/0/2',
  'Plug in Ethernet straight-through cable: SW1 Gi1/0/24 to R1 Gi0/0/0', 'Plug in serial cable: R1 Se0/1/0 to R2 Se0/1/0 (DCE end at R1 Se0/1/0)',
  'Plug in Ethernet crossover cable: R2 Gi0/0/0 to PC3 Eth0',
];
const saveBoth = (): JournalEntry[] => [cli('R1', 'priv', 'copy running-config startup-config'), cli('R2', 'priv', 'copy run start')];
const issuesOf = (journal: JournalEntry[], world: World = solved) => inst.grade(world, journal).orderIssues;

test('an empty journal and a clean journal raise nothing', () => {
  assert.deepEqual(issuesOf([]), []);
  tick = 0;
  const j = [
    ...CABLES.map((c) => cable(c)), cable('Plug in console cable: PC1 COM1 to R1 CON', 'console'),
    cli('R1', 'config', 'access-list 110 permit ip any any'), cli('R1', 'config', 'interface g0/0/0', { mutated: false }), cli('R1', 'config-if', 'ip access-group 110 in'),
    cli('R1', 'config', 'crypto map CM 10 ipsec-isakmp'), cli('R1', 'config-crypto-map', 'interface s0/1/0', { mutated: false }), cli('R1', 'config-if', 'crypto map CM'),
    cli('R1', 'config-if', 'policy-map output_SE'), cli('R1', 'config-pmap', 'interface s0/1/0', { mutated: false }), cli('R1', 'config-if', 'service-policy output output_SE'),
    cli('R1', 'config-if', 'clock rate 128000'),
    ...saveBoth(),
  ];
  assert.deepEqual(issuesOf(j), []);
});

test('the walkthrough of the model guide raises nothing', () => {
  const fresh = getScenario('case-study-2026')!.build(0);
  const world = benchWorld(fresh);
  const journal = walkthrough(fresh, world);
  assert.ok(journal.length > 150);
  assert.deepEqual(fresh.grade(world, journal).orderIssues, []);
});

test('an access list applied before it existed is noted once, as information', () => {
  tick = 0;
  const j = [
    ...CABLES.map((c) => cable(c)),
    cli('R1', 'config-if', 'ip access-g 110 in'), cli('R1', 'config-if', 'ip access-group 110 in'),
    cli('R1', 'config', 'access-list 110 deny ip host 192.168.100.10 host 2.2.2.2'),
    cli('R2', 'config-line', 'access-class allowPC1 in'), cli('R2', 'config', 'ip access-list standard allowPC1', { mutated: false }),
    ...saveBoth(),
  ];
  const got = issuesOf(j);
  assert.deepEqual(got.map((i) => [i.deviceId, i.severity, i.line]), [['R1', 'info', 'ip access-g 110 in'], ['R2', 'info', 'access-class allowPC1 in']]);
  assert.match(got[0].text, /^On R1, access list 110 was applied before it existed\./);
});

test('a crypto map or a policy applied before it existed is noted', () => {
  tick = 0;
  const j = [
    ...CABLES.map((c) => cable(c)),
    cli('R2', 'config-if', 'crypto map CM', { ok: false, mutated: false, feature: 'ipsec' }),
    cli('R2', 'config-if', 'service-policy output output_SE', { ok: false, mutated: false, feature: 'qos' }),
    cli('R2', 'config', 'crypto map CM 10 ipsec-isakmp'), cli('R2', 'config', 'policy-map output_SE'),
    cli('R2', 'config-if', 'crypto map CM'), cli('R2', 'config-if', 'service-policy output output_SE'),
    ...saveBoth(),
  ];
  const got = issuesOf(j);
  assert.equal(got.length, 2);
  assert.match(got[0].text, /crypto map CM was put on the interface before it existed/);
  assert.match(got[1].text, /policy output_SE was attached before the policy-map existed/);
  assert.ok(got.every((i) => i.severity === 'info' && i.deviceId === 'R2'));
});

test('configuration typed before the cabling was done is noted; repairing a cable later is not', () => {
  tick = 0;
  const early = [cable(CABLES[0]), cli('R1', 'config', 'hostname R1'), ...CABLES.slice(1).map((c) => cable(c)), ...saveBoth()];
  const got = issuesOf(early);
  assert.equal(got.length, 1);
  assert.match(got[0].text, /Configuration was typed before data cabling was finished. Either order can work/);
  assert.equal(got[0].severity, 'info');
  tick = 0;
  const repair = [
    ...CABLES.map((c) => cable(c)), cli('R1', 'config', 'hostname R1'),
    cable('Unplug Ethernet crossover cable: R2 Gi0/0/0 to PC3 Eth0'), cable(CABLES[4]), ...saveBoth(),
  ];
  assert.deepEqual(issuesOf(repair), []);
  // a pre-cabled lab never gets this remark
  const lab = getScenario('lab-acl')!.build(0);
  tick = 0;
  const w = startWorld(lab);
  assert.deepEqual(lab.grade(w, [cli('R1', 'config', 'access-list 100 permit ip any any'), cable(CABLES[4]), ...saveBoth()]).orderIssues.filter((i) => /cabling/.test(i.text)), []);
});

test('clock rate on the DTE end is noted', () => {
  tick = 0;
  const j = [...CABLES.map((c) => cable(c)), cli('R2', 'config-if', 'clock rate 128000', { ok: false, mutated: false, feature: 'interface' }), ...saveBoth()];
  const got = issuesOf(j);
  assert.equal(got.length, 1);
  assert.match(got[0].text, /clock rate was typed on R2 and was rejected.*DCE/);
  assert.equal(got[0].severity, 'info');
});

test('work that was never saved is a warning; saving at the end clears it; "write memory" counts', () => {
  const unsaved = structuredClone(solved);
  (unsaved.devices.R1 as { startupConfig: string | null }).startupConfig = null;
  (unsaved.devices.R2 as { startupConfig: string | null }).startupConfig = 'hostname R2\n';
  tick = 0;
  const j = [...CABLES.map((c) => cable(c)), cli('R1', 'config', 'hostname R1'), cli('R2', 'config', 'hostname R2'), cli('R2', 'priv', 'write memory'), cli('R2', 'config', 'no ip domain-lookup')];
  const got = issuesOf(j, unsaved);
  assert.deepEqual(got.map((i) => [i.deviceId, i.severity]), [['R1', 'warn'], ['R2', 'warn']]);
  assert.match(got[0].text, /R1 was configured but never saved/);
  assert.match(got[1].text, /R2 was changed after the last save/);
  tick = 0;
  assert.deepEqual(issuesOf([...CABLES.map((c) => cable(c)), cli('R1', 'config', 'hostname R1'), cli('R1', 'priv', 'wr')], unsaved), []);
});

test('a command typed on the wrong router, removed and typed on the right one is noted', () => {
  tick = 0;
  const line = 'ip nat inside source static 192.168.100.10 60.50.50.100';
  const j = [...CABLES.map((c) => cable(c)), cli('R2', 'config', line), cli('R2', 'config', `no ${line}`), cli('R1', 'config', line), ...saveBoth()];
  const got = issuesOf(j);
  assert.equal(got.length, 1);
  assert.match(got[0].text, /was typed on R2, removed again, and typed on R1/);
  assert.equal(got[0].severity, 'info');
  assert.equal(got[0].deviceId, 'R2');
  // switching an interface off and on again on two routers is ordinary work
  tick = 0;
  const toggles = [...CABLES.map((c) => cable(c)), cli('R1', 'config-if', 'shutdown'), cli('R1', 'config-if', 'no shutdown'), cli('R2', 'config-if', 'shutdown'), cli('R2', 'config-if', 'no shutdown'), ...saveBoth()];
  assert.deepEqual(issuesOf(toggles), []);
});

test('lists that exist from the start of a pre-built lab count as existing; blocked lines are ignored', () => {
  const lab = getScenario('case-study-2026-services')!.build(0);
  const w = startWorld(lab);
  tick = 0;
  // access list 1 (NAT) is part of the pre-built network
  const j = [cli('R1', 'config-if', 'ip access-group 1 in'), cli('R1', 'config-if', 'ip access-group 150 in', { blocked: true, ok: false, mutated: false }), ...saveBoth()];
  assert.deepEqual(lab.grade(w, j).orderIssues.filter((i) => /access list/.test(i.text)), []);
});

test('remarks never use blame and always say what to do next', () => {
  tick = 0;
  const j = [
    cli('R1', 'config-if', 'ip access-group 110 in'), cli('R2', 'config-if', 'crypto map CM', { ok: false, mutated: false }),
    cli('R2', 'config-if', 'clock rate 64000', { ok: false, mutated: false }), ...CABLES.map((c) => cable(c)),
  ];
  const got = issuesOf(j, benchWorld(inst));
  assert.ok(got.length >= 4);
  for (const i of got) {
    assert.ok(!/wrong|mistake|forgot|should have|failed/i.test(i.text), i.text);
    assert.ok(i.text.split('. ').length >= 2, 'a fact and a next step');
    assert.ok(typeof i.tick === 'number');
  }
});
