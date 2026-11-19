/** No LabApi method may throw: bad ids, wrong types and odd values give a failed result or a safe default. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GI, SE, buildSolution, makeLab, ok, port } from './fixture.ts';
import type { LabApi } from '../../src/engine/labapi.ts';

/** Small deterministic generator (tests must be repeatable). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDS: unknown[] = ['R1', 'R2', 'PC1', 'PC2', 'nope', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty', undefined, null, 0, -1, Number.NaN, {}, [], true, 'x'.repeat(500)];
const PORTS: unknown[] = [GI, SE, 'Console', 'COM1', 'Ethernet0', 'GigabitEthernet9/9/9', '', '__proto__', undefined, null, 7, {}];
const TEXTS: unknown[] = ['', ' ', 'enable', 'configure terminal', 'hostname R1', 'interface g0/0/0', 'no shutdown', 'end', 'exit', '?', 'show running-config',
  'reload', 'no', 'yes', 'ping 10.0.1.1', 'telnet 10.0.12.2', 'ipconfig /renew', 'cls', 'boom', 'a\nb\r\nc', '\u0000\u0007', 'x'.repeat(3000), undefined, null, 5, {}, ['enable']];
const ODD: unknown[] = [undefined, null, 0, 1, -1, 2.5, Number.NaN, Infinity, '', 'x', true, false, {}, [], () => 1];
const KINDS: unknown[] = ['straight', 'crossover', 'serial', 'console', 'fibre', '', undefined, null, 3];
const MODES: unknown[] = ['guided', 'free', 'exam', 'party', undefined, null, 1];

function exercise(lab: LabApi, r: () => number, sessionIds: () => unknown[]): void {
  const pick = <T>(list: T[]): T => list[Math.floor(r() * list.length)];
  const ref = (): unknown => (r() < 0.1 ? pick(ODD) : { deviceId: pick(IDS), port: pick(PORTS) });
  const sid = (): unknown => (r() < 0.6 ? pick(sessionIds()) : pick(IDS));
  const any = <T>(v: unknown): T => v as T;
  const calls: (() => unknown)[] = [
    () => lab.getState(),
    () => lab.subscribe(any(pick(ODD)))(),
    () => lab.listScenarios(),
    () => lab.moveDevice(any(pick(IDS)), any(pick(ODD)), any(pick(ODD))),
    () => lab.connectCable(any(pick(KINDS)), any(ref()), any(ref()), any(r() < 0.5 ? { dceEnd: pick(['a', 'b', 'c', 1]) } : pick(ODD))),
    () => lab.removeCable(any(r() < 0.5 ? lab.getState().world?.cables[0]?.id : pick(IDS))),
    () => lab.portStatus(any(ref())),
    () => lab.consoleTargetOf(any(pick(IDS))),
    () => lab.consolePcOf(any(pick(IDS))),
    () => lab.openConsole(any(pick(IDS))),
    () => lab.sessionExec(any(sid()), any(pick(TEXTS))),
    () => lab.sessionHelp(any(sid()), any(pick(TEXTS))),
    () => lab.sessionComplete(any(sid()), any(pick(TEXTS))),
    () => lab.sessionKey(any(sid()), any(pick(['ctrl-z', 'ctrl-c', 'ctrl-x', undefined, 4]))),
    () => lab.sessionHistory(any(sid())),
    () => lab.closeSession(any(sid())),
    () => lab.getConfigText(any(pick(IDS)), any(pick(['running', 'startup', 'other', undefined]))),
    () => lab.applyConfigText(any(pick(IDS)), any(pick(TEXTS)), any(pick(['merge', 'replace', 'x', undefined]))),
    () => lab.setPcNic(any(pick(IDS)), any(r() < 0.2 ? pick(ODD) : { mode: pick(['static', 'dhcp', 'x', undefined]), address: pick(['10.0.1.10', '999.1.1.1', '', 5, undefined]), mask: pick(['255.255.255.0', '255.0.255.0', 8, undefined]), gateway: pick(['10.0.1.1', 'gw', undefined]) })),
    () => lab.setPcService(any(pick(IDS)), any(pick(['http', 'ftp', 'telnet', 'syslog', 'x', undefined, '__proto__'])), any(pick([true, false, 'on', undefined]))),
    () => lab.pcExec(any(pick(IDS)), any(pick(TEXTS))),
    () => lab.pcSnmp(any(pick(IDS)), any(r() < 0.2 ? pick(ODD) : { host: pick(['10.0.12.2', 'r2', undefined, 4]), community: pick(['public', '', undefined, {}]), op: pick(['get', 'set', 'walk']), oid: pick(['sysName.0', '', undefined, 9]), value: pick(['v', undefined, 3]) })),
    () => lab.clearPcLog(any(pick(IDS)), any(pick(['syslog', 'traps', 'x', undefined]))),
    () => lab.trace(any(r() < 0.2 ? pick(ODD) : { fromDeviceId: pick(IDS), dst: pick(['10.0.1.1', '10.0.12.2', 'x', undefined, 1]), proto: pick(['icmp', 'tcp', 'udp', 'x']), dport: pick([23, 80, -1, 'x', undefined]), srcAddr: pick([undefined, '10.0.1.1', 'bad']) })),
    () => lab.qosLoad(any(r() < 0.2 ? pick(ODD) : { deviceId: pick(IDS), iface: pick(PORTS), offered: pick([[], [{ label: 'a', kbps: 100, flow: { fromDeviceId: 'R1', dst: '10.0.12.2', proto: 'icmp' } }], [null, 3, { label: 4 }], 'x', undefined]) })),
    () => lab.noteHintUsed(any(pick(['cable', 'r1', 'route', ...IDS]))),
    () => lab.solution(),
    () => lab.commandSheet(),
    () => lab.check(),
    () => lab.updateSettings(any(r() < 0.3 ? pick(ODD) : { fontScale: pick([1, 9, 'x', Number.NaN]), font: pick(['lexend', 'system', 'x', 3]), strictCables: pick([true, false, 'no']), terminalFontPx: pick([14, 0, 'x']), bogus: 1 })),
    () => lab.exportLab(),
    () => lab.importLab(any(pick([...TEXTS, '{}', '{"format":"kss-netlab-lab","version":1}', '[]']))),
    () => lab.loadSaved(any(pick([...IDS, 'mini.free', 'mini.guided']))),
    () => lab.deleteSaved(any(pick([...IDS, 'mini.exam']))),
  ];
  const start = (): unknown => (r() < 0.7
    ? lab.startScenario(pick(['mini', 'mini-prebuilt']), pick(['guided', 'free', 'exam']), { seed: 3 })
    : lab.startScenario(any(pick(['mini', 'mini-prebuilt', ...IDS])), any(pick(MODES)), any(r() < 0.5 ? pick(ODD) : { seed: pick(ODD), timerMinutes: pick(ODD) })));
  const rare: (() => unknown)[] = [
    start, start, start,
    () => lab.restartScenario(),
    () => lab.leaveScenario(),
    () => lab.finishExam(),
    () => lab.importLab(lab.exportLab()),
  ];
  // a working console (and now and then Telnet), so that the session calls reach a real CLI
  calls.push(
    () => { lab.connectCable('console', { deviceId: pick(['PC1', 'PC2']), port: 'COM1' }, { deviceId: pick(['R1', 'R2']), port: 'Console' }); return lab.openConsole(pick(['R1', 'R2'])); },
    () => lab.openConsole(pick(['R1', 'R2'])),
    () => lab.pcExec('PC1', 'telnet 10.0.12.2'),
  );
  const call = r() < 0.05 ? pick(rare) : pick(calls);
  call();
}

function checkState(lab: LabApi): void {
  const s = lab.getState();
  assert.equal(typeof s.rev, 'number');
  assert.ok(Array.isArray(s.sessions) && Array.isArray(s.journal) && Array.isArray(s.storage.saved));
  assert.doesNotThrow(() => JSON.stringify(s), 'the state stays plain data');
  if (s.world) {
    assert.deepEqual(JSON.parse(JSON.stringify(s.world)), s.world, 'the world stays plain JSON (no undefined fields, no class instances)');
    for (const c of s.world.cables) assert.ok(s.world.devices[c.a.deviceId] && s.world.devices[c.b.deviceId]);
  }
  for (const v of s.sessions) assert.ok(typeof v.id === 'string' && typeof v.prompt === 'string' && typeof v.title === 'string');
}

for (const [name, setup] of [
  ['no lab open', (_lab: LabApi) => undefined],
  ['free mode, empty bench', (lab: LabApi) => { ok(lab.startScenario('mini', 'free')); }],
  ['guided mode', (lab: LabApi) => { ok(lab.startScenario('mini', 'guided')); }],
  ['exam mode, solved network', (lab: LabApi) => { ok(lab.startScenario('mini', 'exam')); buildSolution(lab); }],
  ['pre-built network with a console', (lab: LabApi) => { ok(lab.startScenario('mini-prebuilt', 'free')); ok(lab.connectCable('console', port('PC1', 'COM1'), port('R1', 'Console'))); lab.openConsole('R1'); }],
] as const) {
  test(`fuzz: 1500 random calls with bad input never throw (${name})`, () => {
    const { lab } = makeLab();
    setup(lab);
    const r = rng(name.length * 7919 + 17);
    const errors = console.error;
    const seen: unknown[] = [];
    let withLab = 0;
    let withSession = 0;
    console.error = (...args: unknown[]) => { seen.push(args); };
    try {
      for (let i = 0; i < 1500; i++) {
        try {
          exercise(lab, r, () => [...lab.getState().sessions.map((s) => s.id), 'con1', 'tel2']);
        } catch (e) {
          assert.fail(`call ${i} threw: ${e instanceof Error ? e.stack : String(e)}`);
        }
        if (lab.getState().scenario) withLab++;
        if (lab.getState().sessions.some((s) => !s.closed)) withSession++;
        if (i % 100 === 0) checkState(lab);
      }
    } finally {
      console.error = errors;
    }
    checkState(lab);
    assert.deepEqual(seen.slice(0, 3), [], 'no method needed its emergency catch');
    assert.ok(withLab > 500, `the run spent enough calls inside a lab (${withLab})`);
    assert.ok(withSession > 100, `the run spent enough calls with an open terminal (${withSession})`);
    // …and the lab still works afterwards
    ok(lab.startScenario('mini', 'free'));
    buildSolution(lab);
    assert.equal(lab.check().points, 10);
  });
}

test('prototype names are not devices', () => {
  const { lab } = makeLab();
  ok(lab.startScenario('mini', 'free'));
  for (const id of ['__proto__', 'constructor', 'toString']) {
    assert.equal(lab.openConsole(id).ok, false);
    assert.match((lab.openConsole(id) as { message: string }).message, /not on the bench/);
    assert.equal(lab.setPcNic(id, { mode: 'dhcp' }).ok, false);
    assert.equal(lab.connectCable('straight', port(id, 'Ethernet0'), port('R1', GI)).ok, false);
    assert.deepEqual(lab.pcExec(id, 'ping 1.1.1.1'), { output: '' });
    assert.equal(lab.getConfigText(id, 'running'), '');
    assert.equal(lab.consolePcOf(id), null);
    assert.equal(lab.portStatus(port(id, 'Console')).led, 'off');
  }
});
