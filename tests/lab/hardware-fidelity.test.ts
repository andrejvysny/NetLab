import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lab } from '../../src/engine/lab.ts';
import type { SavedLab } from '../../src/engine/lab/persist.ts';
import { linkInfo, serialClock } from '../../src/engine/sim/physical.ts';
import { getIos } from '../../src/engine/world.ts';
import { faceFor } from '../../src/ui/bench/geometry.ts';
import { plugFits, secondEndFits } from '../../src/ui/bench/util.ts';
import { GI, SE, MemoryStorage, cableId, consoleToConfig, ok, port, world } from './fixture.ts';

const CASE = 'case-study-2026';
const RJ45 = 'GigabitEthernet0/0/1';
const SFP = 'GigabitEthernet0/0/2';
const UPLINK = 'GigabitEthernet1/1/1';
const DOWNLINK = 'GigabitEthernet1/0/24';
const ALT_SERIAL = 'Serial0/1/1';

function start(storage: MemoryStorage | null = null): Lab {
  const lab = new Lab({ storage });
  ok(lab.startScenario(CASE, 'free'));
  return lab;
}

test('case chassis show the physical GE and NIM banks without inventing cable endpoints', () => {
  const w = world(start());
  const r = faceFor(w.devices.R1);
  const s = faceFor(w.devices.SW1);
  const combo = r.byName[GI], copper = r.byName[RJ45], sfp = r.byName[SFP];
  assert.deepEqual([combo.shape, copper.shape, sfp.shape], ['rj45', 'rj45', 'sfp']);
  assert.ok(r.comboCage, 'upper row shares one interface but has two physical connectors');
  assert.equal(r.ports.filter((p) => p.spec.name === GI).length, 1);
  assert.equal(combo.cx, copper.cx);
  assert.ok(combo.cy < copper.cy);
  assert.equal(r.comboCage.x + r.comboCage.w / 2, sfp.cx);
  assert.ok(r.banks?.some((b) => b.text === 'GE 0/0/0 · shared'));
  assert.deepEqual(r.banks?.filter((b) => b.text.startsWith('NIM')).map((b) => b.text), ['NIM 1 (0/1) · NIM-2T', 'NIM 2 (0/2)']);
  const nim1 = r.banks?.find((b) => b.text.startsWith('NIM 1'));
  assert.ok(nim1 && nim1.x < r.byName[SE].cx && r.byName[ALT_SERIAL].cx < nim1.x + nim1.w);
  assert.equal(r.byName['Serial0/2/0'], undefined);
  assert.equal(s.ports.filter(({ spec, shape }) => spec.kind === 'ethernet' && shape === 'rj45').length, 24);
  assert.deepEqual(s.ports.filter((p) => p.shape === 'sfp').map((p) => p.spec.name), [1, 2, 3, 4].map((n) => `GigabitEthernet1/1/${n}`));
  assert.equal(s.byName['GigabitEthernet1/0/1'].cx, s.byName['GigabitEthernet1/0/2'].cx);
  assert.ok(s.byName['GigabitEthernet1/0/1'].cy < s.byName['GigabitEthernet1/0/2'].cy);
  assert.ok(s.byName[DOWNLINK].cx < s.byName[UPLINK].cx);
  assert.ok(s.banks?.some((b) => b.text === '1G SFP · Gi1/1/x'));
  assert.equal(plugFits('straight', combo.spec), true);
  for (const spec of [sfp.spec, s.byName[UPLINK].spec]) {
    for (const kind of ['straight', 'crossover', 'console', 'serial'] as const) assert.equal(plugFits(kind, spec), false);
    assert.equal(secondEndFits('straight', spec, copper.spec), false);
    assert.equal(secondEndFits('straight', copper.spec, spec), false);
  }
});

test('student cabling and CLI distinguish native RJ-45, the shared GE port and empty SFP cages', () => {
  const lab = start();
  const sw = port('SW1', DOWNLINK), r1 = port('R1', GI), sfp = port('R1', SFP), up = port('SW1', UPLINK);
  const rejected = (result: { ok: boolean; message?: string }) => {
    assert.equal(result.ok, false);
    assert.match(result.message ?? '', /SFP cage/);
  };
  const oldJournal = lab.getState().journal;
  rejected(lab.connectCable('straight', sw, sfp));
  rejected(lab.connectCable('crossover', up, r1));
  rejected(lab.connectCable('console', port('PC1', 'COM1'), sfp));
  rejected(lab.connectCable('serial', port('R1', SE), port('R2', SFP)));
  assert.deepEqual(lab.getState().journal, oldJournal);
  assert.deepEqual(world(lab).cables, []);
  lab.updateSettings({ strictCables: false });
  rejected(lab.connectCable('straight', sw, sfp));

  ok(lab.connectCable('straight', sw, r1));
  ok(lab.connectCable('straight', port('SW1', 'GigabitEthernet1/0/23'), port('R1', RJ45)));
  const rr = consoleToConfig(lab, 'PC1', 'R1');
  const cmd = (line: string) => lab.sessionExec(rr, line).output;
  cmd('interface gi0/0/1'); cmd('no shutdown');
  assert.equal(lab.portStatus(port('R1', RJ45)).status, 'up/up');
  assert.match(cmd('media-type sfp'), /Invalid input/);
  cmd('interface GigabitEthernet 0/0/0'); cmd('no shutdown');
  assert.equal(lab.portStatus(r1).status, 'up/up');
  assert.match(cmd('do show controllers gi0/0/0'), /Link: up.*Media type: RJ45/);
  cmd('media-type sfp');
  assert.equal(lab.portStatus(r1).status, 'down/down');
  assert.equal(lab.portStatus(sw).status, 'down/down');
  assert.match(lab.portStatus(sw).problem ?? '', /media-type sfp/);
  assert.match(cmd('do show interfaces gi0/0/0'), /media type is SFP \(not installed\)/);
  cmd('no media-type');
  assert.equal(lab.portStatus(sw).status, 'up/up');
  cmd('interface gi0/0/2'); cmd('no shutdown');
  assert.match(cmd('media-type rj45'), /Invalid input/);
  assert.match(cmd('do show controllers gigabitethernet 0/0/2'), /Link: down, Media type: SFP \(not installed\)/);

  const ss = consoleToConfig(lab, 'PC2', 'SW1');
  const swCmd = (line: string) => lab.sessionExec(ss, line).output;
  assert.match(lab.sessionExec(ss, 'interface gI1/1/1').prompt, /\(config-if\)#$/);
  assert.match(swCmd('do show interfaces gi1/1/1'), /^GigabitEthernet1\/1\/1 is down, line protocol is down.*media type is SFP \(not installed\)/s);
  assert.match(swCmd('do show interfaces status'), /^Gi1\/1\/4\s+notconnect.*SFP \(not installed\)$/m);
  assert.match(swCmd('do show interfaces status'), /^Gi1\/0\/24\s+connected.*10\/100\/1000BaseTX$/m);
  assert.match(swCmd('do show version'), /^28 Gigabit Ethernet interfaces$/m);
  assert.match(swCmd('interface te1/1/1'), /Invalid input/);
});

test('serial controller diagnostics follow a reversed DCE lead, admin state, and HDLC/PPP independently', () => {
  const lab = start();
  const a = port('R1', SE), b = port('R2', ALT_SERIAL);
  const ar = consoleToConfig(lab, 'PC1', 'R1'), br = consoleToConfig(lab, 'PC2', 'R2');
  const cmd = (s: string, line: string) => lab.sessionExec(s, line).output;
  const ac = () => cmd(ar, 'do show controllers SERIAL 0/1/0');
  const bc = () => cmd(br, 'do show controllers Se0/1/1');
  assert.match(cmd(ar, 'interface Se0/2/0'), /Invalid input/);
  cmd(ar, 'interface se0/1/0'); cmd(br, 'interface se0/1/1');
  assert.match(ac(), /No serial cable attached/);
  assert.match(cmd(ar, 'clock rate 64000'), /applies only to DCE/);
  assert.equal(lab.connectCable('serial', a, port('R1', ALT_SERIAL)).ok, false);
  ok(lab.connectCable('serial', a, b, { dceEnd: 'b' }));
  assert.deepEqual([lab.portStatus(a).dce, lab.portStatus(b).dce], [false, true]);
  assert.match(ac(), /DTE V\.35 clocks stopped/);
  assert.match(bc(), /DCE V\.35, clock rate 2000000 \(NetLab fallback; no clock rate configured\)/);
  assert.match(cmd(ar, 'clock rate 128000'), /applies only to DCE/);
  cmd(br, 'clock rate 128000'); cmd(br, 'no shutdown');
  assert.match(ac(), /clocks stopped/);
  assert.match(bc(), /Clock path inactive/);
  cmd(ar, 'no shutdown');
  assert.equal(lab.portStatus(a).status, 'up/up');
  assert.match(ac(), /TX and RX clocks detected/);
  assert.match(bc(), /DCE V\.35, clock rate 128000\nSmart Serial, NIM subslot 0\/1/);
  cmd(br, 'encapsulation ppp');
  assert.equal(lab.portStatus(a).status, 'up/down');
  assert.match(ac(), /clocks detected[\s\S]*Interface state: Up\nLine protocol: down/);
  cmd(ar, 'encapsulation ppp');
  assert.equal(lab.portStatus(b).status, 'up/up');
  cmd(br, 'no clock rate');
  assert.match(bc(), /NetLab fallback; no clock rate configured/);
  assert.equal(lab.portStatus(a).status, 'up/up');
  cmd(br, 'shutdown');
  assert.match(ac(), /clocks stopped/);
  ok(lab.removeCable(cableId(lab, a)));
  assert.match(ac(), /No serial cable attached/);
  assert.equal(serialClock(world(lab), 'R1', SE), null);
});

test('legacy v1 import and continue update inventory without rewiring or losing student configuration', () => {
  const storage = new MemoryStorage();
  const lab = start(storage);
  ok(lab.connectCable('serial', port('R1', SE), port('R2', SE)));
  const saved = JSON.parse(lab.exportLab()) as SavedLab;
  for (const d of Object.values(saved.world.devices)) for (const p of d.ports) delete p.media;
  const r1 = getIos(saved.world, 'R1');
  const sw = getIos(saved.world, 'SW1');
  sw.ports = sw.ports.filter((p) => !p.name.startsWith('GigabitEthernet1/1/'));
  for (let n = 1; n <= 4; n++) delete sw.config.interfaces[`GigabitEthernet1/1/${n}`];
  sw.config.interfaces[DOWNLINK].description = 'Student switch port';
  r1.config.interfaces[SFP].shutdown = false;
  r1.config.interfaces[SFP].description = 'Student LAN';
  r1.startupConfig = 'hostname R1-saved';
  delete saved.world.cables[0].dceEnd;
  const legacySfp = { id: 'cable-legacy', kind: 'straight' as const, a: port('SW1', DOWNLINK), b: port('R1', SFP) };
  saved.world.cables.push(legacySfp);
  // A different run may have routers without serial cards; preserve that option on restore as well.
  const r2 = getIos(saved.world, 'R2');
  assert.equal(r2.ports.filter((p) => p.kind === 'serial').length, 2);
  const json = JSON.stringify(saved);
  storage.setItem(`kss-netlab:lab:${CASE}.free`, json);

  for (const load of [(next: Lab) => next.importLab(json), (next: Lab) => next.loadSaved(`${CASE}.free`)]) {
    const next = new Lab({ storage });
    // Reload the real old data for each path (import also autosaves its upgraded world).
    storage.setItem(`kss-netlab:lab:${CASE}.free`, json);
    ok(load(next));
    const w = world(next), restored = getIos(w, 'R1');
    assert.deepEqual(w.cables, saved.world.cables, 'no silent recabling');
    assert.deepEqual(next.getState().journal, saved.journal);
    assert.equal(restored.config.interfaces[SFP].description, 'Student LAN');
    assert.equal(restored.startupConfig, 'hostname R1-saved');
    assert.equal(getIos(w, 'SW1').config.interfaces[DOWNLINK].description, 'Student switch port');
    assert.deepEqual(getIos(w, 'SW1').config.interfaces[UPLINK], { name: UPLINK, shutdown: false, switchport: { mode: 'dynamic', accessVlan: 1 } });
    assert.equal(faceFor(w.devices.R1).byName[SFP].shape, 'sfp');
    assert.equal(faceFor(w.devices.SW1).byName[UPLINK].shape, 'sfp');
    assert.equal(linkInfo(w, legacySfp.b).usable, false);
    assert.equal(next.portStatus(legacySfp.a).status, 'down/down');
    assert.match(next.portStatus(legacySfp.a).problem ?? '', /SFP cage/);
    const session = consoleToConfig(next, 'PC1', 'R1');
    const cmd = (line: string) => next.sessionExec(session, line).output;
    cmd('interface serial 0/1/0');
    assert.doesNotMatch(cmd('clock rate 64000'), /only to DCE/);
    assert.match(cmd('do show controllers serial 0/1/0'), /DCE V\.35, clock rate 64000/);
    ok(next.removeCable(legacySfp.id));
    ok(next.connectCable('straight', legacySfp.a, port('R1', GI)));
  }
  r2.ports = r2.ports.filter((p) => p.kind !== 'serial');
  delete r2.config.interfaces[SE]; delete r2.config.interfaces[ALT_SERIAL];
  saved.world.cables.shift(); // no WAN lead on a router without a serial module
  const noNim = new Lab({ storage: null });
  ok(noNim.importLab(JSON.stringify(saved)));
  assert.equal(faceFor(world(noNim).devices.R2).byName[SE], undefined);
  assert.ok(faceFor(world(noNim).devices.R2).banks?.some((b) => b.text === 'NIM 1 (0/1) · empty' && b.empty));
  assert.equal(noNim.connectCable('serial', port('R1', SE), port('R2', SE)).ok, false);
});
