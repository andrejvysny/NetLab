import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorld, addDevice, getIos } from '../../src/engine/world.ts';
import { registerCommands, startSession, execLine, helpFor, inspectLine } from '../../src/engine/cli/framework.ts';
import type { CommandDef, ExecOutcome } from '../../src/engine/cli/framework.ts';
import type { Acl, IosDevice, QosConfig } from '../../src/engine/types.ts';
import * as qosMod from '../../src/engine/cli/commands/qos.ts';
import { LEGACY_NOTE, MSG } from '../../src/engine/cli/commands/qos.ts';

// Minimal navigation owned by other modules, so this suite only depends on the QoS module.
const nav: CommandDef[] = [
  { modes: 'user', pattern: 'enable', feature: 'system', run: (e) => e.setMode('priv') },
  { modes: 'priv', pattern: 'configure terminal', feature: 'system', run: (e) => e.setMode('config') },
  {
    modes: 'config', pattern: 'interface <ifname:if>', feature: 'interface', mutates: false,
    run: (e, a) => { if (!e.device.config.interfaces[a.ifname]) e.reject('% Invalid interface'); e.setMode('config-if', { ifNames: [a.ifname] }); },
  },
];
registerCommands(nav);
qosMod.install();

function lab(id = 'r1') {
  const w = createWorld();
  addDevice(w, { id, model: 'isr4331', label: id.toUpperCase(), x: 0, y: 0 });
  const { session } = startSession(w, id, 'console');
  const dev = getIos(w, id);
  const run = (l: string): ExecOutcome => execLine(w, session, l);
  const runAll = (lines: string[]): ExecOutcome[] => lines.map((l) => {
    const o = run(l);
    assert.ok(o.status === 'ok' || o.status === 'empty', `"${l}" → ${o.status}: ${o.output}`);
    return o;
  });
  run('enable'); run('configure terminal');
  return { w, s: session, dev, run, runAll };
}

/** The ACLs of the reference solution are built by the ACL module; here they are created directly. */
function addReferenceAcls(dev: IosDevice): void {
  const any = { kind: 'any' } as const;
  const acl = (id: string, entries: Acl['entries']): Acl => ({ id, type: 'extended', named: true, entries });
  let seq = 0;
  const p = (protocol: 'tcp' | 'udp', port: number, dst: boolean) => ({
    seq: (seq += 10), action: 'permit' as const, protocol, src: any, dst: any,
    ...(dst ? { dstPort: { op: 'eq' as const, ports: [port] } } : { srcPort: { op: 'eq' as const, ports: [port] } }),
  });
  dev.config.acls.matchGuaranteed = acl('matchGuaranteed', [
    p('tcp', 23, true), p('tcp', 23, false), p('tcp', 22, true), p('tcp', 22, false),
    p('udp', 161, true), p('udp', 161, false), p('udp', 162, true), p('udp', 162, false),
  ]);
  dev.config.acls.matchPriority = acl('matchPriority', [{ seq: 10, action: 'permit', protocol: 'icmp', src: any, dst: any }]);
}

const COURSE = readFileSync(new URL('../../docs/COURSE.md', import.meta.url), 'utf8');

const REF_QOS = [
  'class-map match-all classPriority',
  ' match access-group name matchPriority',
  'class-map match-all classGuaranteed',
  ' match access-group name matchGuaranteed',
  'policy-map output_QE',
  ' class classPriority',
  '  priority 16',
  ' class classGuaranteed',
  '  bandwidth 48',
  ' class class-default',
  '  fair-queue',
  'policy-map output_SE',
  ' class class-default',
  '  shape average percent 95',
  '  service-policy output_QE',
];
const IF_LINES = ['interface Serial0/1/0', ' service-policy output output_SE'];

const EXPECTED_POLICIES: QosConfig['policyMaps'] = [
  {
    name: 'output_QE',
    classes: [
      { className: 'classPriority', priority: { kbps: 16 } },
      { className: 'classGuaranteed', bandwidth: { kbps: 48 } },
      { className: 'class-default', fairQueue: true },
    ],
  },
  { name: 'output_SE', classes: [{ className: 'class-default', shapeAverage: { percent: 95 }, servicePolicy: 'output_QE' }] },
];
const CM_PRIORITY = { name: 'classPriority', matchType: 'match-all', matches: [{ kind: 'access-group', acl: 'matchPriority' }] } as const;
const CM_GUARANTEED = { name: 'classGuaranteed', matchType: 'match-all', matches: [{ kind: 'access-group', acl: 'matchGuaranteed' }] } as const;

test('reference lines are quoted exactly from docs/COURSE.md', () => {
  for (const l of [...REF_QOS, ...IF_LINES]) assert.ok(COURSE.includes(l + '\n'), `not in COURSE.md: "${l}"`);
});

test('reference QoS configuration (R1 and R2) typed exactly as written', () => {
  for (const id of ['r1', 'r2']) {
    const { dev, runAll } = lab(id);
    const outs = runAll([...REF_QOS, ...IF_LINES]);
    assert.deepEqual(outs.map((o) => o.prompt.replace(/^Router/, '')), [
      '(config-cmap)#', '(config-cmap)#', '(config-cmap)#', '(config-cmap)#',
      '(config-pmap)#', '(config-pmap-c)#', '(config-pmap-c)#', '(config-pmap-c)#', '(config-pmap-c)#', '(config-pmap-c)#', '(config-pmap-c)#',
      '(config-pmap)#', '(config-pmap-c)#', '(config-pmap-c)#', '(config-pmap-c)#',
      '(config-if)#', '(config-if)#',
    ]);
    for (const o of outs.slice(0, -2)) { assert.equal(o.output, ''); assert.equal(o.feature, 'qos'); assert.equal(o.mutated, true); }
    assert.deepEqual(dev.config.qos, { classMaps: [CM_PRIORITY, CM_GUARANTEED], policyMaps: EXPECTED_POLICIES });
    assert.equal(dev.config.interfaces['Serial0/1/0'].servicePolicyOut, 'output_SE');
    assert.equal(outs[outs.length - 1].feature, 'qos');
  }
});

test("teacher's QoS listing (case study, task 10) typed verbatim", () => {
  const text = readFileSync(new URL('../../docs/course/case-study-2026.sk.txt', import.meta.url), 'utf8');
  const start = text.indexOf('QoS LLQ konfigur');
  const end = text.indexOf('11. R1:');
  assert.ok(start > 0 && end > start);
  // The PDF extraction turned the ASCII hyphens into U+2010; a student types '-'.
  const block = text.slice(text.indexOf('\n', start) + 1, end).replace(/\u2010/g, '-').split('\n');
  const lines: string[] = [];
  let inAcl = false;
  for (const raw of block) {
    const t = raw.trim();
    if (/^ip access-list /.test(t)) { inAcl = true; continue; } // ACL blocks belong to the ACL module
    if (inAcl && /^(permit|deny|remark) /.test(t)) continue;
    inAcl = false;
    if (t) lines.push(raw);
  }
  assert.ok(lines.includes('   class-map match-all classGuaranteed'));
  assert.ok(lines.includes('     service-policy output_QE'));
  const { dev, run, runAll } = lab();
  addReferenceAcls(dev);
  const outs = runAll(lines);
  assert.ok(outs.some((o) => o.status === 'empty'), '"!" lines are comments');
  assert.equal(run('end').prompt, 'Router#');
  assert.deepEqual(dev.config.qos, { classMaps: [CM_GUARANTEED, CM_PRIORITY], policyMaps: EXPECTED_POLICIES });
  // interface part of the teacher's notes: "service‐policy output output_SE" on both WAN interfaces
  const ifLine = text.slice(text.indexOf('10. Na oboch'), start).split('\n').map((l) => l.replace(/\u2010/g, '-')).find((l) => l.includes('service-policy output'));
  assert.ok(ifLine);
  run('configure terminal');
  runAll(['interface Serial0/1/0', ifLine]);
  assert.equal(dev.config.interfaces['Serial0/1/0'].servicePolicyOut, 'output_SE');
});

test('reference QoS configuration in common abbreviated forms', () => {
  const { dev, runAll } = lab();
  runAll([
    'class-m match-all classPriority', ' mat access-g name matchPriority',
    'class-m classGuaranteed', ' ma acc na matchGuaranteed',
    'policy-m output_QE', ' cl classPriority', '  pri 16', ' cl classGuaranteed', '  band 48', ' cl class-d', '  fair',
    'policy-m output_SE', ' cl class-default', '  sha av perc 95', '  serv output_QE',
    'int s0/1/0', ' serv out output_SE',
  ]);
  assert.deepEqual(dev.config.qos, { classMaps: [CM_PRIORITY, CM_GUARANTEED], policyMaps: EXPECTED_POLICIES });
  assert.equal(dev.config.interfaces['Serial0/1/0'].servicePolicyOut, 'output_SE');
});

test('exit navigation: class → policy-map → global → privileged', () => {
  const { s, run, runAll } = lab();
  runAll(REF_QOS);
  assert.equal(s.mode, 'config-pmap-c');
  assert.deepEqual(s.ctx, { policy: 'output_SE', class: 'class-default' });
  let o = run('exit');
  assert.equal(o.prompt, 'Router(config-pmap)#');
  assert.deepEqual(s.ctx, { policy: 'output_SE' });
  o = run('exit');
  assert.equal(o.prompt, 'Router(config)#');
  o = run('exit');
  assert.equal(o.prompt, 'Router#');
  run('configure terminal');
  run('class-map classX');
  assert.deepEqual(s.ctx, { classMap: 'classX' });
  assert.equal(run('exit').prompt, 'Router(config)#');
  run('policy-map output_QE'); run('class classPriority');
  assert.equal(run('end').prompt, 'Router#');
});

test('class-map: match criteria, match type, description, no forms', () => {
  const { dev, run, runAll } = lab();
  runAll([
    'class-map match-any VOICE', 'match access-group 101', 'match access-group 101', 'match protocol HTTP', 'match ip dscp ef 46 af41 cs3',
    'match precedence 5 critical', 'match any', 'description voice and video',
  ]);
  assert.deepEqual(dev.config.qos.classMaps[0], {
    name: 'VOICE', matchType: 'match-any', description: 'voice and video',
    matches: [
      { kind: 'access-group', acl: '101' }, { kind: 'protocol', protocol: 'http' }, { kind: 'dscp', values: ['ef', 'ef', 'af41', 'cs3'] },
      { kind: 'precedence', values: ['5', 'critical'] }, { kind: 'any' },
    ],
  });
  runAll(['no match access-group 101', 'no match any', 'no match protocol http', 'no description']);
  assert.deepEqual(dev.config.qos.classMaps[0].matches.map((m) => m.kind), ['dscp', 'precedence']);
  // a bad value is a parser error with the caret under it
  const bad = run('match dscp ef af99');
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.output.split('\n')[0], ' '.repeat('Router(config-cmap)#'.length + 'match dscp ef '.length) + '^');
  assert.match(bad.output, /% Invalid input detected at '\^' marker\./);
  assert.equal(run('match precedence 1 2 3 4 5').status, 'rejected', 'at most 4 precedence values');
  assert.equal(run('match access-group 3000').status, 'invalid');
  // re-entering without a type keeps the type; a type keyword changes it
  runAll(['class-map VOICE']);
  assert.equal(dev.config.qos.classMaps[0].matchType, 'match-any');
  runAll(['class-map match-all VOICE']);
  assert.equal(dev.config.qos.classMaps[0].matchType, 'match-all');
  assert.equal(run('class-map class-default').status, 'rejected');
  assert.equal(run('class-map match-a VOICE').status, 'ambiguous');
});

test('policy-map class needs an existing class-map', () => {
  const { dev, s, run, runAll } = lab();
  runAll(['policy-map P']);
  const o = run('class nope');
  assert.equal(o.status, 'rejected');
  assert.equal(o.output, '% class map nope not configured\n');
  assert.equal(o.prompt, 'Router(config-pmap)#');
  assert.equal(dev.config.qos.policyMaps[0].classes.length, 0);
  runAll(['class class-default', 'fair-queue', 'class-map C1', 'policy-map P', 'class C1', 'bandwidth 100']);
  assert.deepEqual(dev.config.qos.policyMaps[0].classes.map((c) => c.className), ['C1', 'class-default'], 'class-default stays last');
  // from inside a class, `class` moves to another class of the same policy
  runAll(['class class-default']);
  assert.deepEqual(s.ctx, { policy: 'P', class: 'class-default' });
  assert.equal(run('class nope').output, '% class map nope not configured\n');
  // no class (from the class itself goes back to the policy-map)
  runAll(['no class C1']);
  assert.equal(s.mode, 'config-pmap');
  assert.deepEqual(dev.config.qos.policyMaps[0].classes.map((c) => c.className), ['class-default']);
});

test('priority/bandwidth rules: same class, consistent units, percent sums', () => {
  const { dev, run, runAll } = lab();
  runAll(['class-map A', 'class-map B', 'class-map C', 'policy-map P', 'class A', 'priority 16']);
  let o = run('bandwidth 48');
  assert.equal(o.status, 'rejected'); assert.equal(o.output, MSG.priorityAndBandwidth + '\n');
  runAll(['class B', 'bandwidth 48']);
  o = run('priority 10');
  assert.equal(o.status, 'rejected'); assert.equal(o.output, MSG.priorityAndBandwidth + '\n');
  // kbps and percent bandwidth may not be mixed in one policy
  runAll(['class C']);
  o = run('bandwidth percent 20');
  assert.equal(o.output, 'All classes with bandwidth should have consistent units\n');
  o = run('bandwidth remaining percent 20');
  assert.equal(o.output, 'All classes with bandwidth should have consistent units\n');
  runAll(['bandwidth 30', 'class class-default', 'bandwidth 10']);
  // the class itself may switch units when it is the only bandwidth class
  runAll(['policy-map Q', 'class A', 'priority percent 30', 'class B', 'bandwidth percent 60', 'bandwidth percent 70']);
  o = run('bandwidth percent 71');
  assert.equal(o.status, 'rejected'); assert.equal(o.output, MSG.sumExceeds + '\n');
  runAll(['class A']);
  assert.equal(run('priority percent 31').output, MSG.sumExceeds + '\n');
  runAll(['priority percent 25', 'priority 100 2000']);
  assert.deepEqual(dev.config.qos.policyMaps[1].classes[0].priority, { kbps: 100, burstBytes: 2000 });
  runAll(['class B', 'bandwidth remaining percent 90', 'class C']);
  assert.equal(run('bandwidth remaining percent 11').output, MSG.sumExceeds + '\n');
  runAll(['bandwidth remaining percent 10']);
  assert.deepEqual(dev.config.qos.policyMaps[1].classes.map((c) => c.bandwidth), [undefined, { remainingPercent: 90 }, { remainingPercent: 10 }]);
  // no forms
  runAll(['no bandwidth', 'class A', 'no priority']);
  assert.deepEqual(dev.config.qos.policyMaps[1].classes.map((c) => [c.priority, c.bandwidth]), [[undefined, undefined], [undefined, { remainingPercent: 90 }], [undefined, undefined]]);
  assert.equal(run('priority percent 101').status, 'invalid');
  assert.equal(run('bandwidth 4').status, 'invalid');
});

test('other class actions: shape, police, queue-limit, set, random-detect, nested policy', () => {
  const { dev, run, runAll } = lab();
  runAll(['policy-map Z', 'class C']);
  assert.deepEqual(dev.config.qos.policyMaps[0].classes.map((c) => c.className), ['class-default'], 'without a class-map C, "class C" abbreviates class-default');
  runAll(['no policy-map Z']);
  runAll(['class-map C', 'policy-map CHILD', 'class C', 'priority 16', 'policy-map P', 'class C',
    'shape average 128000', 'queue-limit 30 packets', 'set ip dscp 46', 'police 8000', 'fair-queue']);
  let pc = dev.config.qos.policyMaps[1].classes[0];
  assert.deepEqual(pc, { className: 'C', shapeAverage: { bps: 128000 }, queueLimit: 30, setDscp: 'ef', police: { bps: 8000 }, fairQueue: true });
  const po = run('police cir 16000 conform-action transmit exceed-action drop');
  assert.equal(po.status, 'ok'); assert.match(po.notes[0], /not simulated/);
  const rd = run('random-detect dscp-based');
  assert.match(rd.notes[0], /not simulated/);
  runAll(['set precedence 5']);
  pc = dev.config.qos.policyMaps[1].classes[0];
  assert.deepEqual(pc.police, { bps: 16000 });
  assert.deepEqual(pc.extraLines, ['random-detect dscp-based', 'set precedence 5']);
  assert.equal(run('set dscp af99').status, 'rejected');
  runAll(['no shape average 128000', 'no queue-limit', 'no set dscp', 'no police', 'no fair-queue', 'no random-detect', 'no set precedence']);
  assert.deepEqual(dev.config.qos.policyMaps[1].classes[0], { className: 'C' });
  // nested policy: child must exist and cannot be the policy itself (or contain it)
  let o = run('service-policy NOPE');
  assert.equal(o.output, '% policy map NOPE not configured\n');
  o = run('service-policy P');
  assert.equal(o.status, 'rejected'); assert.equal(o.output, MSG.selfChild('P') + '\n');
  runAll(['shape average percent 95', 'service-policy CHILD']);
  assert.equal(dev.config.qos.policyMaps[1].classes[0].servicePolicy, 'CHILD');
  runAll(['policy-map CHILD', 'class class-default']);
  assert.equal(run('service-policy P').status, 'rejected', 'a loop through a child is refused too');
  runAll(['policy-map P', 'class C', 'no service-policy']);
  assert.equal(dev.config.qos.policyMaps[1].classes[0].servicePolicy, undefined);
});

test('lab examples (konfig_WFQ_CBWFQ_LLQ): CBWFQ, LLQ with burst and percent, "service output"', () => {
  const { dev, run, runAll } = lab();
  runAll([
    'class-map class1', 'match access-group 101', 'exit', 'class-map class2', 'match access-group 102', 'exit',
    'policy-map policy1', 'class class1', 'bandwidth 3000', 'queue-limit 30', 'exit', 'class class2', 'bandwidth 2000', 'exit', 'exit',
    'interface Serial0/1/0', 'service output policy1', 'exit',
    'class-map voice', 'match access-group 102', 'policy-map policy2', 'class voice', 'priority 50 60',
  ]);
  assert.equal(run('class bar').output, '% class map bar not configured\n');
  runAll(['class class-default', 'fair-queue', 'policy-map policy3', 'class voice', 'priority percent 15', 'class class1', 'bandwidth percent 20', 'class class-default', 'fair-queue']);
  assert.deepEqual(dev.config.qos.policyMaps.map((p) => p.classes), [
    [{ className: 'class1', bandwidth: { kbps: 3000 }, queueLimit: 30 }, { className: 'class2', bandwidth: { kbps: 2000 } }],
    [{ className: 'voice', priority: { kbps: 50, burstBytes: 60 } }, { className: 'class-default', fairQueue: true }],
    [{ className: 'voice', priority: { percent: 15 } }, { className: 'class1', bandwidth: { percent: 20 } }, { className: 'class-default', fairQueue: true }],
  ]);
  assert.equal(dev.config.interfaces['Serial0/1/0'].servicePolicyOut, 'policy1');
});

test('interface service-policy: missing policy, one per direction, input queueing, no forms', () => {
  const { dev, run, runAll } = lab();
  runAll([...REF_QOS, 'policy-map MARK', 'class class-default', 'set dscp af21', 'exit', 'exit', 'interface Serial0/1/0']);
  let o = run('service-policy output NOPE');
  assert.equal(o.status, 'rejected'); assert.equal(o.output, '% policy map NOPE not configured\n');
  runAll(['service-policy output output_SE', 'service-policy output output_SE']);
  o = run('service-policy output output_QE');
  assert.equal(o.status, 'rejected'); assert.equal(o.output, MSG.alreadyAttached('output', 'output_SE') + '\n');
  assert.equal(dev.config.interfaces['Serial0/1/0'].servicePolicyOut, 'output_SE');
  o = run('service-policy input output_SE');
  assert.equal(o.status, 'rejected'); assert.equal(o.output, MSG.queueingInput + '\n');
  runAll(['service-policy input MARK']);
  assert.equal(dev.config.interfaces['Serial0/1/0'].servicePolicyIn, 'MARK');
  o = run('no service-policy output output_QE');
  assert.equal(o.status, 'ok'); assert.equal(o.output, ''); assert.equal(o.notes.length, 1);
  assert.equal(dev.config.interfaces['Serial0/1/0'].servicePolicyOut, 'output_SE', 'a different name removes nothing');
  runAll(['no service-policy output output_SE', 'no service-policy input']);
  assert.equal(dev.config.interfaces['Serial0/1/0'].servicePolicyOut, undefined);
  assert.equal(dev.config.interfaces['Serial0/1/0'].servicePolicyIn, undefined);
  runAll(['service-policy output output_QE']);
  assert.equal(dev.config.interfaces['Serial0/1/0'].servicePolicyOut, 'output_QE');
});

test('removal guards: class-map used by a policy, policy-map attached or used as a child', () => {
  const { dev, run, runAll } = lab();
  runAll([...REF_QOS, ...IF_LINES, 'exit']);
  let o = run('no class-map classPriority');
  assert.equal(o.status, 'rejected'); assert.equal(o.output, 'Class-map classPriority is being used\n');
  o = run('no policy-map output_SE');
  assert.equal(o.status, 'rejected'); assert.equal(o.output, MSG.policyMapInUse('output_SE') + '\n');
  o = run('no policy-map output_QE');
  assert.equal(o.status, 'rejected', 'used as a child of output_SE');
  assert.equal(dev.config.qos.policyMaps.length, 2);
  assert.equal(dev.config.qos.classMaps.length, 2);
  runAll(['interface Serial0/1/0', 'no service-policy output output_SE', 'exit', 'no policy-map output_SE', 'no policy-map output_QE',
    'no class-map classPriority', 'no class-map match-all classGuaranteed', 'no class-map NOPE', 'no policy-map NOPE']);
  assert.deepEqual(dev.config.qos, { classMaps: [], policyMaps: [] });
});

test('legacy queueing is rejected like IOS XE, with a note', () => {
  const { dev, run, runAll } = lab();
  const before = JSON.stringify(dev.config);
  const check = (line: string, prompt: string, word: string) => {
    const o = run(line);
    assert.equal(o.status, 'rejected', line);
    assert.equal(o.mutated, false);
    assert.equal(o.feature, 'qos');
    assert.equal(o.output, ' '.repeat(prompt.length + line.indexOf(word)) + "^\n% Invalid input detected at '^' marker.\n", line);
    assert.deepEqual(o.notes, [LEGACY_NOTE]);
    assert.equal(o.prompt, prompt);
  };
  check('priority-list 1 protocol ip high list 101', 'Router(config)#', 'priority-list');
  check('priority-list 1 queue-limit 20 40 60 80', 'Router(config)#', 'priority-list');
  check('queue-list 1 protocol ip 1 list 101', 'Router(config)#', 'queue-list');
  check('queue-list 1 queue 1 byte-count 3000', 'Router(config)#', 'queue-list');
  check('no priority-list 1', 'Router(config)#', 'priority-list');
  runAll(['interface Serial0/1/0']);
  check('priority-list 1 protocol ip high list 101', 'Router(config-if)#', 'priority-list');
  check('priority-group 1', 'Router(config-if)#', 'priority-group');
  check('custom-queue-list 1', 'Router(config-if)#', 'custom-queue-list');
  check('fair-queue', 'Router(config-if)#', 'fair-queue');
  check('fair-queue 64 256 0', 'Router(config-if)#', 'fair-queue');
  check('no fair-queue', 'Router(config-if)#', 'fair-queue');
  assert.equal(JSON.stringify(dev.config), before);
  // mistyped MQC lines in a policy-map class are ordinary parser errors, never "legacy queueing"
  runAll(['exit', 'class-map C', 'policy-map P', 'class C']);
  let o = run('priority percent 101');
  assert.equal(o.status, 'invalid'); assert.deepEqual(o.notes, []);
  assert.equal(o.output.split('\n')[0], ' '.repeat('Router(config-pmap-c)#'.length + 'priority percent '.length) + '^');
  o = run('priority 16 10');
  assert.equal(o.status, 'invalid'); assert.deepEqual(o.notes, []);
  o = run('priority');
  assert.equal(o.status, 'incomplete'); assert.equal(o.output, '% Incomplete command.\n');
  o = run('queue-l 0');
  assert.equal(o.status, 'invalid'); assert.deepEqual(o.notes, []);
  assert.equal(o.prompt, 'Router(config-pmap-c)#');
  assert.equal(LEGACY_NOTE, 'Legacy queueing is not available on IOS XE routers such as the ISR 4331. Use class-map, policy-map and service-policy instead.');
});

test('feature, mutates and help', () => {
  const { w, s, run, runAll } = lab();
  assert.deepEqual(inspectLine(w, s, 'class-map match-all X'), { status: 'ok', feature: 'qos', mutates: true });
  assert.deepEqual(inspectLine(w, s, 'policy-map P'), { status: 'ok', feature: 'qos', mutates: true });
  assert.deepEqual(inspectLine(w, s, 'priority-list 1 protocol ip high'), { status: 'ok', feature: 'qos', mutates: false });
  runAll(['class-map C', 'policy-map P']);
  assert.deepEqual(inspectLine(w, s, 'class C'), { status: 'ok', feature: 'qos', mutates: true });
  run('class C');
  assert.deepEqual(inspectLine(w, s, 'priority 16'), { status: 'ok', feature: 'qos', mutates: true });
  assert.deepEqual(inspectLine(w, s, 'class class-default'), { status: 'ok', feature: 'qos', mutates: true });
  assert.match(helpFor(w, s, ''), /priority\s+Strict Scheduling Priority for this Class/);
  assert.match(helpFor(w, s, 'bandwidth '), /remaining\s+percentage of remaining bandwidth/);
  assert.match(helpFor(w, s, 'shape average '), /percent\s+% of total bandwidth/);
  run('exit'); run('exit');
  assert.match(helpFor(w, s, 'class-map '), /match-all\s+Logical-AND all matching statements under this classmap/);
  run('interface Serial0/1/0');
  assert.deepEqual(inspectLine(w, s, 'service-policy output P'), { status: 'ok', feature: 'qos', mutates: true });
  assert.deepEqual(inspectLine(w, s, 'fair-queue'), { status: 'ok', feature: 'qos', mutates: false });
  assert.match(helpFor(w, s, 'service-policy '), /output\s+Assign policy-map to the output of an interface/);
});
