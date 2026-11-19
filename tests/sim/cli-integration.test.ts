/**
 * Contract check between the CLI/config agents and the simulation engine: the course's configuration TEXT, fed through
 * the real CLI (applyConfigText), must produce exactly the structured configuration the engine fixtures use — and the
 * acceptance facts must hold on a lab configured that way.
 *
 * This file depends on modules owned by other agents (src/engine/config/apply.ts, the CLI command modules and
 * tests/config/reference.ts). If it fails while every other sim test passes, the contract between the CLI and the
 * engine has drifted — look at the reported difference first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDR, SE, bringUp, buildBench, cableReference, configurePcs, configureR1, configureR2, ping, snmp, tcp } from './fixtures.ts';
import { emitSyslog, qosPlan, routingTable, sendFlow } from '../../src/engine/sim/index.ts';
import { getIos, getPc } from '../../src/engine/world.ts';
import type { World } from '../../src/engine/types.ts';

async function labFromCourseText(): Promise<World> {
  const { applyConfigText } = await import('../../src/engine/config/apply.ts');
  const { R1_COURSE, R2_COURSE } = await import('../config/reference.ts');
  const w = buildBench();
  cableReference(w);
  configurePcs(w);
  for (const [id, text] of [['R1', R1_COURSE], ['R2', R2_COURSE]] as const) {
    const r = applyConfigText(w, id, text, 'replace');
    assert.deepEqual(r.lines.filter((l) => !l.ok).map((l) => `${l.lineNo}: ${l.line} → ${l.output}`), [], `${id}: every course line is accepted by the CLI`);
  }
  return w;
}

test('course configuration text → CLI → the same IosConfig as the engine fixtures', async () => {
  const viaCli = await labFromCourseText();
  const viaObjects = buildBench();
  cableReference(viaObjects);
  configurePcs(viaObjects);
  configureR1(viaObjects);
  configureR2(viaObjects);
  for (const id of ['R1', 'R2']) assert.deepEqual(getIos(viaCli, id).config, getIos(viaObjects, id).config, id);
});

test('a lab configured from the course text meets the acceptance facts', async () => {
  const w = await labFromCourseText();
  const { pc2, pc3 } = bringUp(w);
  assert.deepEqual([pc2.address, pc3.address], [ADDR.pc2, ADDR.pc3]);
  for (const id of ['R1', 'R2']) assert.deepEqual(routingTable(w, id).filter((r) => r.code === 'S').map((r) => r.isDefault), [true]);
  const a = sendFlow(w, ping('PC1', ADDR.pc3));
  assert.deepEqual([a.ok, a.forward.received?.src, a.forward.encrypted, a.forward.qos[0]?.childClass], [true, ADDR.pc1Public, true, 'classPriority']);
  assert.equal(sendFlow(w, ping('PC2', ADDR.pc3)).forward.received?.src, ADDR.r1Wan);
  assert.equal(sendFlow(w, ping('PC3', ADDR.pc1Public)).forward.atDeviceId, 'PC1');
  assert.equal(sendFlow(w, ping('PC1', ADDR.r2Lo0)).symbol, 'U');
  assert.equal(sendFlow(w, ping('R1', ADDR.r2Lo0, { srcAddr: ADDR.r1Lo0 })).ok, true);
  assert.deepEqual([80, 21, 23].map((port) => sendFlow(w, tcp('PC2', ADDR.pc3, port)).ok), [true, false, false]);
  assert.deepEqual([sendFlow(w, tcp('PC1', ADDR.r2Wan, 23)).vty?.login, sendFlow(w, tcp('PC3', ADDR.r2Wan, 23)).outcome], ['password', 'refused']);
  assert.deepEqual([sendFlow(w, snmp('PC3', ADDR.r1Wan, 'D105read')).ok, sendFlow(w, snmp('PC3', ADDR.r1Wan, 'D105write', 'set', 'x')).ok], [true, false]);
  assert.equal(qosPlan(w, 'R2', SE).shapedBps, 121600);
  emitSyslog(w, 'R1', 5, 'SYS-5-CONFIG_I', 'Configured from console by console');
  emitSyslog(w, 'R2', 5, 'SYS-5-CONFIG_I', 'Configured from console by console');
  assert.deepEqual(getPc(w, 'PC1').runtime.syslog.map((m) => m.from), [ADDR.r1Lo0, ADDR.r2Lo0]);
});
