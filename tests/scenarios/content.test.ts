/**
 * What the student sees: registry, sheet, picture, bench, seeds, model solution, hardware notes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ScenarioInstance } from '../../src/engine/types.ts';
import { SCENARIOS, getScenario, specOf } from '../../src/scenarios/index.ts';
import { HARDWARE_ROWS } from '../../src/scenarios/hardwareNotes.ts';

const caseStudy = (): ScenarioInstance => getScenario('case-study-2026')!.build(0);
const text = (inst: ScenarioInstance): string => JSON.stringify([inst.brief, inst.guide.map((g) => [g.title, g.goal, g.why, g.hint])]);

test('registry: unique ids, every family, summaries match the built instances', () => {
  assert.ok(SCENARIOS.length >= 15);
  assert.equal(new Set(SCENARIOS.map((s) => s.summary.id)).size, SCENARIOS.length);
  for (const family of ['case-study', 'variation', 'mock', 'broken', 'lab']) assert.ok(SCENARIOS.some((s) => s.summary.family === family), `family ${family}`);
  assert.equal(SCENARIOS[0].summary.id, 'case-study-2026', 'the case study comes first');
  assert.equal(getScenario('case-study-2026'), SCENARIOS[0]);
  assert.equal(getScenario('nope'), undefined);
  for (const d of SCENARIOS) {
    const inst = d.build(0);
    assert.deepEqual(inst.summary, d.summary, `${d.summary.id}: summary`);
    assert.equal(inst.seed, 0);
    assert.ok(d.summary.title.length > 5 && d.summary.blurb.length > 20 && d.summary.minutes >= 15 && d.summary.features.length > 0);
    assert.equal(d.summary.seedable, ['variation', 'mock', 'broken'].includes(d.summary.family), `${d.summary.id}: seedable`);
    assert.ok(inst.requirements.length > 0 && inst.requirements.every((r) => r.points >= 0 && r.title.length > 5));
    assert.equal(new Set(inst.requirements.map((r) => r.id)).size, inst.requirements.length);
    assert.equal(new Set(inst.guide.map((g) => g.id)).size, inst.guide.length);
  }
  for (const id of ['lab-basics', 'lab-acl', 'lab-nat-static', 'lab-nat-pool', 'lab-nat-overload', 'lab-dhcp', 'lab-ipsec', 'lab-qos', 'lab-mgmt']) {
    assert.equal(getScenario(id)?.summary.family, 'lab', id);
  }
  const mock = getScenario('mock-exam')!;
  assert.equal(mock.summary.minutes, 180);
  assert.match(mock.build(2).brief.intro, /18 practice points, 180 minutes/);
});

test('case study sheet: the 13 tasks of the assignment, task 9 optional and not graded, only real givens', () => {
  const inst = caseStudy();
  assert.deepEqual(inst.brief.items.map((i) => i.no), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13']);
  assert.deepEqual(inst.brief.items.map((i) => i.feature), ['dhcp', 'interface', 'routing', 'nat', 'routing', 'acl', 'acl', 'ipsec', 'ipsec', 'qos', 'vty', 'snmp', 'syslog']);
  assert.deepEqual(inst.brief.items.filter((i) => i.optional).map((i) => i.no), ['9']);
  const by = Object.fromEntries(inst.brief.items.map((i) => [i.no, i]));
  assert.match(by['1'].text, /first 100 usable addresses/);
  assert.match(by['2'].text, /\/30.*\/24.*\/26/);
  assert.match(by['4'].subItems!.join(' '), /Loopback100/);
  assert.match(by['7'].text, /ICMP or HTTP/);
  assert.deepEqual(by['8'].subItems, ['Telnet', 'SSH', 'ICMP', 'Network management (UDP 161 and 162)']);
  assert.match(by['10'].text, /128 kbit\/s/);
  assert.match(by['10'].subItems!.join(' '), /16 kbit\/s.*48 kbit\/s.*WFQ.*95 %/);
  assert.match(by['13'].text, /Loopback0/);
  // the sheet leaves the addresses open: the reference plan is not given away
  const sheet = JSON.stringify([inst.brief, inst.diagram]);
  for (const secret of ['192.168.100', '60.50.30', '60.50.40', '60.50.50.100', '1.1.1.1', '2.2.2.2', 'D105', 'cisco']) {
    assert.ok(!sheet.includes(secret), `the sheet does not fix "${secret}"`);
  }
  assert.ok((inst.brief.given ?? []).some((g) => /host number 10/.test(g.value)));
  // no requirement for the crossed-out task; numbering follows the sheet
  assert.deepEqual(inst.requirements.map((r) => r.no), ['C', '1', '2', '3', '4a', '4b', '5', '6', '7', '8', '10', '11', '12', '13', 'S']);
  assert.equal(inst.requirements.reduce((a, r) => a + r.points, 0), 18);
  assert.equal(inst.requirements.find((r) => r.no === 'S')!.points, 0, 'saving is checked but does not change the case score');
  assert.match(inst.brief.intro, /180 minutes.*18 points.*practice points, not official marks/);
  // short sentences
  for (const it of inst.brief.items) for (const sentence of it.text.split(/(?<=[.:])\s+/)) assert.ok(sentence.split(' ').length <= 28, `short sentence: "${sentence}"`);
});

test('model solution of the case study is the reference plan of docs/COURSE.md, with current IKE values and a note about them', () => {
  const inst = caseStudy();
  const r1 = inst.solution.configs.R1;
  const r2 = inst.solution.configs.R2;
  for (const line of [
    'ip dhcp excluded-address 192.168.100.1 192.168.100.100', ' network 60.50.40.0 255.255.255.192', ' ip address 60.50.50.100 255.255.255.255',
    ' clock rate 128000', 'ip nat inside source static 192.168.100.10 60.50.50.100', 'ip nat inside source list 1 interface Serial0/1/0 overload',
    'ip route 0.0.0.0 0.0.0.0 Serial0/1/0 60.50.30.2', 'access-list 110 deny ip host 192.168.100.10 host 2.2.2.2',
    'access-list 110 permit tcp host 192.168.100.101 60.50.40.0 0.0.0.63 eq www', 'access-list 120 permit udp any eq snmptrap any',
    '  priority 16', '  bandwidth 48', '  shape average percent 95', ' bandwidth 128', ' service-policy output output_SE',
    'snmp-server community D105read RO 10', 'snmp-server community D105write RW 11', 'logging source-interface Loopback0', 'logging 192.168.100.10',
    ' access-class allowPC1 in', ' password cisco',
  ]) assert.ok(r1.split('\n').includes(line), `R1 has "${line}"`);
  for (const line of [' ip helper-address 60.50.30.1', 'ip route 0.0.0.0 0.0.0.0 Serial0/1/0 60.50.30.1', ' permit 60.50.50.100', 'logging 60.50.50.100', 'access-list 10 permit host 60.50.50.100']) {
    assert.ok(r2.split('\n').includes(line), `R2 has "${line}"`);
  }
  assert.ok(!/clock rate/.test(r2), 'no clock rate on the DTE end');
  for (const cfg of [r1, r2]) {
    assert.match(cfg, / encryption aes\n hash sha256\n authentication pre-share\n group 14/);
    assert.ok(!/\nend\b/.test(cfg), 'no "end" in the middle of the text');
  }
  assert.ok(inst.solution.notes.some((n) => /sha256/.test(n) && /teacher/i.test(n) && /older values/.test(n)), 'a note says the teacher\'s sheet shows older IKE values');
  assert.deepEqual(inst.solution.pcs.PC1, { mode: 'static', address: '192.168.100.10', mask: '255.255.255.0', gateway: '192.168.100.1', services: { syslog: true } });
  assert.equal(inst.solution.pcs.PC2.mode, 'dhcp');
  assert.deepEqual(inst.solution.pcs.PC3, { mode: 'dhcp', services: { http: true, ftp: true } });
  const cables = inst.solution.cables.map((c) => `${c.kind} ${c.a.deviceId} ${c.a.port} - ${c.b.deviceId} ${c.b.port}${c.dceEnd ? ` dce=${c.dceEnd}` : ''}`);
  assert.deepEqual(cables, [
    'straight PC1 Ethernet0 - SW1 GigabitEthernet1/0/1', 'straight PC2 Ethernet0 - SW1 GigabitEthernet1/0/2', 'straight SW1 GigabitEthernet1/0/24 - R1 GigabitEthernet0/0/0',
    'serial R1 Serial0/1/0 - R2 Serial0/1/0 dce=a', 'crossover R2 GigabitEthernet0/0/0 - PC3 Ethernet0',
    'console PC1 COM1 - R1 Console', 'console PC3 COM1 - R2 Console',
  ]);
});

test('the topology picture is logical: no port names, no cable types, in any scenario', () => {
  for (const d of SCENARIOS) {
    for (const seed of d.summary.seedable ? [0, 1, 2, 3] : [0]) {
      const dia = d.build(seed).diagram;
      const s = JSON.stringify(dia);
      assert.ok(!/Gi\d|GigabitEthernet|Serial\d|Se\d\/|Ethernet0|straight|crossover|rollover|serial|console|DCE/i.test(s), `${d.summary.id} seed ${seed}: ${s}`);
      for (const n of dia.nodes) assert.ok(n.x >= 0 && n.x <= 1000 && n.y >= 0 && n.y <= 600, `${n.id} inside the 1000 × 600 box`);
      const ids = new Set(dia.nodes.map((n) => n.id));
      for (const l of dia.links) assert.ok(ids.has(l.a) && ids.has(l.b));
      assert.ok(dia.nodes.some((n) => n.id === 'R1') && dia.nodes.some((n) => n.id === 'PC3'));
      assert.ok(!ids.has('SW2'), 'the spare switch is not part of the assignment picture');
    }
  }
  const dia = caseStudy().diagram;
  assert.deepEqual(dia.nodes.find((n) => n.id === 'R1')!.notes, ['Loopback0 /32', 'Loopback100 /32']);
  assert.ok(dia.links.some((l) => l.dashed && /Tunnel/.test(l.label ?? '')));
});

test('the bench: the case-study devices, PC3 is the macOS laptop, faces do not overlap and keep 80 px distance', () => {
  const size = (model: string): [number, number] => (model === 'isr4331' ? [520, 160] : model === 'c9300l' ? [590, 180] : [208, 200]);
  for (const d of SCENARIOS) {
    for (const seed of d.summary.seedable ? [0, 1, 2] : [0]) {
      const bench = d.build(seed).bench;
      for (let i = 0; i < bench.length; i++) {
        for (let j = i + 1; j < bench.length; j++) {
          const [a, b] = [bench[i], bench[j]];
          const [aw, ah] = size(a.model);
          const [bw, bh] = size(b.model);
          const gapX = Math.abs(a.x - b.x) - (aw + bw) / 2;
          const gapY = Math.abs(a.y - b.y) - (ah + bh) / 2;
          assert.ok(gapX >= 80 || gapY >= 80, `${d.summary.id}: ${a.id} and ${b.id} are at least 80 px apart (x ${gapX}, y ${gapY})`);
        }
      }
    }
  }
  const bench = caseStudy().bench;
  assert.deepEqual(bench.map((b) => `${b.id}:${b.model}`), ['R1:isr4331', 'R2:isr4331', 'SW1:c9300l', 'SW2:c9300l', 'PC1:pc-windows', 'PC2:pc-windows', 'PC3:pc-macos']);
  assert.equal(caseStudy().initial, undefined, 'the case study starts from an empty, uncabled bench');
});

test('seeds: deterministic, seed 0 is the reference plan, other seeds change the facts within the promised ranges', () => {
  const variation = getScenario('variation')!;
  const strip = (i: ScenarioInstance) => JSON.stringify([i.brief, i.diagram, i.bench, i.solution, i.guide, i.requirements, i.hardwareNotes, i.initial ?? null]);
  for (const d of SCENARIOS) for (const seed of d.summary.seedable ? [0, 7] : [0]) assert.equal(strip(d.build(seed)), strip(d.build(seed)), `${d.summary.id} seed ${seed} builds the same twice`);
  // seed 0 of variation and mock exam = the case study facts
  const ref = caseStudy();
  for (const id of ['variation', 'mock-exam']) {
    const v = getScenario(id)!.build(0);
    assert.deepEqual(v.solution, ref.solution, `${id} seed 0 uses the reference plan`);
    assert.deepEqual(v.requirements, ref.requirements);
  }
  let ethernet = 0, tables = 0, firstHalf = 0, lanSource = 0;
  const lan1 = new Set<string>(), lens = new Set<number>(), links = new Set<number>(), excl = new Set<number>(), names = new Set<string>(), ipsec = new Set<string>(), pc2 = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) {
    const inst = variation.build(seed);
    const s = specOf(inst)!;
    assert.equal(inst.seed, seed);
    assert.match(s.addr.lan1.net, /^192\.168\.\d+\.0$/);
    assert.equal(s.addr.lan1.len, 24);
    assert.equal(s.addr.wan.len, 30);
    assert.ok(s.addr.lan2.len >= 25 && s.addr.lan2.len <= 28);
    assert.ok((s.wan === 'serial' ? [64, 128, 250] : [64, 128, 256]).includes(s.qos!.linkKbps));
    assert.ok(s.qos!.priority.kbps + s.qos!.guaranteed.kbps <= s.qos!.linkKbps * s.qos!.shapePercent / 100, 'the guarantees fit under the shaper');
    assert.ok(s.addr.pc1Host <= s.dhcp!.excludeFirst, 'PC1 lives inside the excluded range');
    assert.ok(!s.ipsec || s.ipsec.mode !== 'services' || !s.ipsec.services.includes('ftp'));
    lan1.add(s.addr.lan1.net); lens.add(s.addr.lan2.len); links.add(s.qos!.linkKbps); excl.add(s.dhcp!.excludeFirst); names.add(s.snmp!.ro);
    if (s.ipsec?.mode === 'services') ipsec.add(s.ipsec.services.join('+'));
    if (s.acl?.mode === 'case') { pc2.add(s.acl.pc2Allow.join('+')); if (s.acl.pc1.kind === 'lan2-first-half') firstHalf++; }
    if (s.syslog!.source === 'lan') lanSource++;
    if (s.wan === 'ethernet') {
      ethernet++;
      assert.ok(inst.bench.filter((b) => b.model === 'isr4331').every((b) => b.serialModule === false), 'routers without the serial module');
      assert.ok(inst.solution.cables.some((c) => c.kind === 'crossover' && c.a.deviceId === 'R1' && c.b.deviceId === 'R2'));
      assert.ok(!/clock rate|\n speed |\n bandwidth /.test(inst.solution.configs.R1), 'no made-up settings to change Ethernet PHY speed');
      assert.match(inst.brief.items.find((i) => i.no === '10')!.text, /physical speed is unchanged/);
      assert.match(inst.solution.configs.R1, new RegExp(`shape average ${s.qos!.linkKbps * s.qos!.shapePercent * 10}`));
      assert.ok(!inst.hardwareNotes.some((n) => /clock/.test(n.id)));
    }
    if (s.addrGiven) {
      tables++;
      assert.ok((inst.brief.given ?? []).some((g) => g.value.includes(s.addr.lan1.net)), 'the address table is on the sheet');
      assert.ok(JSON.stringify(inst.diagram).includes(s.addr.lan2.net));
    } else {
      assert.ok(!JSON.stringify(inst.brief).includes(s.addr.lan1.net), 'no address table: the sheet keeps the addresses open');
    }
  }
  assert.ok(ethernet >= 5 && ethernet <= 25, `Ethernet WAN on some seeds (${ethernet} of 40)`);
  assert.ok(tables >= 8 && tables <= 32, `address table on some seeds (${tables} of 40)`);
  assert.ok(firstHalf >= 5 && lanSource >= 5);
  assert.ok(lan1.size >= 10 && lens.size === 4 && links.size >= 3 && excl.size >= 4 && names.size >= 4 && ipsec.size >= 5 && pc2.size >= 4);
  // mock exams draw from another stream than variations
  assert.notEqual(JSON.stringify(getScenario('mock-exam')!.build(3).solution), JSON.stringify(variation.build(3).solution));
});

test('PC setups handed to the Lab are complete: a static PC always comes with address, mask and gateway', () => {
  for (const d of SCENARIOS) {
    for (const seed of d.summary.seedable ? [0, 1, 2] : [0]) {
      const inst = d.build(seed);
      for (const [where, pcs] of [['initial', inst.initial?.pcs ?? {}], ['solution', inst.solution.pcs]] as const) {
        for (const [id, p] of Object.entries(pcs)) {
          if (p.mode === 'static') assert.ok(p.address && p.mask && p.gateway, `${d.summary.id} ${where} ${id}`);
          else assert.equal(p.address, undefined);
        }
      }
    }
  }
});

test('pre-built labs come cabled, with console cables, addresses and routes, and say so', () => {
  for (const id of ['lab-acl', 'lab-nat-static', 'lab-nat-pool', 'lab-nat-overload', 'lab-dhcp', 'lab-ipsec', 'lab-qos', 'lab-mgmt', 'case-study-2026-services']) {
    const inst = getScenario(id)!.build(0);
    assert.ok(inst.initial, id);
    const kinds = (inst.initial!.cables ?? []).map((c) => c.kind);
    assert.equal(kinds.filter((k) => k === 'console').length, 2, `${id}: two console cables`);
    assert.ok(kinds.includes('serial') && kinds.includes('crossover') && kinds.filter((k) => k === 'straight').length === 3);
    assert.match(inst.initial!.configs!.R1, /hostname R1/);
    assert.match(inst.initial!.configs!.R1, /no shutdown/);
    assert.match(inst.brief.intro, /cabled/);
    assert.ok((inst.brief.given ?? []).length >= 4);
    assert.ok(inst.guide.length <= 8, `${id} is a short lab`);
    assert.equal(inst.guide.at(-1)!.id, 'save', 'every lab ends with saving');
  }
  assert.equal(getScenario('lab-basics')!.build(0).initial, undefined, 'the basic setup lab starts from scratch');
  assert.ok(!/ip route/.test(getScenario('lab-nat-static')!.build(0).initial!.configs!.R2 ?? ''), 'in the NAT labs R2 (the provider) has no default route');
});

test('hardware notes come from the final table of docs/HARDWARE_NOTES.md and fit the scenario', () => {
  const doc = readFileSync(new URL('../../docs/HARDWARE_NOTES.md', import.meta.url), 'utf8');
  const table = doc.slice(doc.indexOf('## Short notes for the student'));
  assert.ok(HARDWARE_ROWS.length >= 38);
  for (const row of HARDWARE_ROWS) {
    assert.ok(table.includes(`| ${row.id} | ${row.feature} | ${row.title} |`), `row ${row.id} is in the table with the same title`);
    assert.ok(row.text.length <= 220, `${row.id} is short`);
  }
  const ids = (id: string, seed = 0): string[] => getScenario(id)!.build(seed).hardwareNotes.map((n) => n.id);
  const cs = ids('case-study-2026');
  for (const want of ['cabling-router-mdix', 'console-setup-dialog', 'interface-clock-128k', 'nat-r2-sees-global', 'ipsec-weak-rejected', 'qos-preclassify', 'vty-line-15', 'snmp-acl-ok', 'syslog-logging-host', 'dhcp-ping-check']) {
    assert.ok(cs.includes(want), `case study has ${want}`);
  }
  assert.deepEqual(ids('lab-dhcp'), ['dhcp-ping-check']);
  assert.ok(ids('lab-qos').every((n) => n.startsWith('qos-') || n.startsWith('interface-')));
  assert.ok(!ids('lab-qos').includes('qos-preclassify'), 'no crypto map in the QoS lab');
  assert.ok(ids('lab-ipsec').every((n) => n.startsWith('ipsec-')) && ids('lab-ipsec').length >= 4);
  assert.ok(ids('lab-nat-static').every((n) => n.startsWith('nat-')));
  assert.ok(ids('lab-basics').some((n) => n.startsWith('cabling-')) && ids('lab-basics').some((n) => n.startsWith('console-')));
  for (const d of SCENARIOS) for (const n of d.build(0).hardwareNotes) assert.ok(n.title && n.text && n.feature, `${d.summary.id} ${n.id}`);
  // a broken network does not hint at the faulty area through its notes: it lists every area
  assert.ok(ids('broken-1', 4).length >= 30);
});

test('the words stay plain: no blame, no jargon without need', () => {
  for (const d of SCENARIOS) {
    const t = text(d.build(d.summary.seedable ? 2 : 0));
    assert.ok(!/\b(wrong!|fail(ed)? to|you forgot|your mistake|obviously|simply|just )\b/i.test(t), `${d.summary.id}: calm wording`);
  }
});

test('guide steps stay short: a title, a goal of one or two sentences, a why, a hint that is not the answer', () => {
  for (const d of SCENARIOS) {
    for (const seed of d.summary.seedable ? [0, 1, 2, 3] : [0]) {
      for (const g of d.build(seed).guide) {
        const where = `${d.summary.id} seed ${seed} step ${g.id}`;
        const sentences = g.goal.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((x) => x.length > 0);
        assert.ok(sentences.length <= 2, `${where}: goal has ${sentences.length} sentences: ${g.goal}`);
        assert.ok(g.title.length <= 60, `${where}: title`);
        assert.ok((g.why ?? '').length > 20 && (g.hint ?? '').length > 20 && (g.example ?? '').length > 5, `${where}: why, hint, example`);
        assert.ok(g.devices.length > 0 && g.allows.length > 0, `${where}: devices and allows`);
      }
    }
  }
});
