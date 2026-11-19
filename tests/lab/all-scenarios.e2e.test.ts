/**
 * Every registered assignment (src/scenarios) through the real Lab:
 *  - it starts in every mode and the exam rules hold,
 *  - its model solution, applied the quick way (config files through the console, PCs, DHCP), scores 100 %,
 *  - in guided mode, following the guide's own examples step by step is never stopped and ends at 100 %.
 * Skips itself while the scenario registry is empty.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lab } from '../../src/engine/lab.ts';
import { failures } from './e2e-driver.ts';
import { solveWithFiles } from './all-scenarios-driver.ts';
import { loadScenarios, walkGuide } from './guided-driver.ts';

const mod = await loadScenarios();
const defs = Array.isArray(mod.SCENARIOS) ? mod.SCENARIOS.filter((s) => !!s && !!s.summary) : [];
const none = defs.length === 0 ? 'src/scenarios/index.ts registers no scenarios yet' : false;
const seedsOf = (seedable: boolean): number[] => (seedable ? [0, 5] : [0]);

test('every assignment starts in every mode; exam mode hides the guide, the tools and the solution until it is finished', { skip: none }, () => {
  const lab = new Lab({ storage: null });
  assert.deepEqual(lab.listScenarios().map((s) => s.id), defs.map((d) => d.summary.id));
  for (const def of defs) {
    const id = def.summary.id;
    for (const mode of ['guided', 'free', 'exam'] as const) {
      const r = lab.startScenario(id, mode, { timerMinutes: mode === 'exam' ? 180 : null });
      assert.equal(r.ok, true, `${id} in ${mode} mode: ${r.message}`);
      const s = lab.getState();
      assert.equal(s.scenario?.summary.id, id);
      assert.ok(s.world && s.world.order.length > 0, `${id} has a bench`);
      assert.deepEqual(s.journal, [], `${id}: pre-built parts are not journaled`);
      assert.doesNotThrow(() => JSON.stringify(s));
      if (mode === 'exam') {
        assert.deepEqual(s.scenario?.guide, []);
        assert.equal(lab.solution(), null, `${id}: no solution during the exam`);
        const first = s.world.order[0];
        assert.ok('error' in lab.trace({ fromDeviceId: first, dst: '10.0.0.1', proto: 'icmp' }));
        const rep = lab.finishExam();
        assert.equal(rep.scenarioId, id);
        assert.ok(rep.maxPoints > 0, `${id} has points`);
        assert.ok(rep.scaled18 >= 0 && rep.scaled18 <= 18);
        assert.equal(lab.getState().scenario?.finished, true);
        assert.ok(lab.solution(), `${id}: the solution is shown after the exam`);
      } else {
        const guide = s.scenario?.guide ?? [];
        assert.ok(guide.length > 0, `${id} has guide steps`);
        assert.ok(guide.filter((g) => g.status === 'active').length <= 1, `${id}: at most one active step`);
        assert.ok(lab.solution(), `${id}: the solution is available in ${mode} mode`);
      }
    }
  }
});

for (const def of defs) {
  const id = def.summary.id;
  for (const seed of seedsOf(def.summary.seedable)) {
    test(`${id} (seed ${seed}): the model solution sent as config files through LabApi scores 100 %`, () => {
      const lab = new Lab({ storage: null });
      assert.equal(lab.startScenario(id, 'free', { seed }).ok, true);
      const rep = solveWithFiles(lab);
      assert.equal(rep.points, rep.maxPoints, `not passed:\n${failures(rep)}`);
      assert.equal(rep.scaled18, 18);
    });

    test(`${id} (seed ${seed}): guided mode — the guide's own examples, step by step, are never stopped and end at 100 %`, (t) => {
      if (typeof mod.stepScripts !== 'function') { t.skip('src/scenarios/index.ts does not export stepScripts()'); return; }
      const lab = new Lab({ storage: null });
      assert.equal(lab.startScenario(id, 'guided', { seed }).ok, true);
      const problems = walkGuide(lab, mod.stepScripts(def.build(seed)));
      assert.deepEqual(problems, []);
      assert.equal(lab.getState().journal.filter((e) => e.blocked).length, 0, 'nothing was stopped on the way');
      assert.ok(lab.getState().scenario!.guide.every((g) => g.status === 'done'));
      const rep = lab.check();
      assert.equal(rep.points, rep.maxPoints, `not passed:\n${failures(rep)}`);
    });
  }
}
