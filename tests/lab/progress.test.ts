/**
 * Guide progress scheduling: a cheap progress check runs after every action; an expensive one (a scenario that probes the
 * network for 100 ms) is postponed until the state is read — and a guided-mode refusal never relies on old progress.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GI, SOLUTION, cableBench, consoleToConfig, makeLab, miniScenario, ok, port, type, typeConfig } from './fixture.ts';
import { Lab } from '../../src/engine/lab.ts';
import { fakePc } from './fixture.ts';

/** A lab whose guideProgress "takes" `costMs` on the injected clock. */
function slowLab(costMs: number) {
  const clock = { t: 1_700_000_000_000 };
  const calls = { n: 0 };
  const lab = new Lab({
    scenarios: [miniScenario({ onProgress: () => { calls.n++; clock.t += costMs; } })],
    storage: null, now: () => clock.t, pcExec: fakePc,
  });
  return { lab, calls, clock };
}
const statuses = (lab: Lab) => lab.getState().scenario!.guide.map((g) => g.status);

test('a cheap progress check runs after every action: one new state per action, statuses always current', () => {
  const { lab, calls } = slowLab(0);
  ok(lab.startScenario('mini', 'free'));
  const n0 = calls.n;
  const rev0 = lab.getState().rev;
  ok(lab.connectCable('crossover', port('PC1', 'Ethernet0'), port('R1', GI)));
  assert.equal(calls.n, n0 + 1);
  assert.equal(lab.getState().rev, rev0 + 1);
  assert.equal(calls.n, n0 + 1, 'reading the state costs nothing');
});

test('an expensive progress check is postponed: a burst of lines costs one check, when the state is read', () => {
  const { lab, calls } = slowLab(100);
  ok(lab.startScenario('mini', 'free'));
  assert.deepEqual(statuses(lab), ['active', 'locked', 'locked']);
  cableBench(lab);
  const id = consoleToConfig(lab, 'PC1', 'R1');
  assert.deepEqual(statuses(lab), ['done', 'active', 'locked']);
  const before = calls.n;
  let notified = 0;
  let seenInListener: string[] = [];
  lab.subscribe(() => { notified++; seenInListener = lab.getState().scenario!.guide.map((g) => g.status); });
  // a "paste": many lines, nobody reads the state in between
  assert.deepEqual(typeConfig(lab, id, SOLUTION.configs.R1), []);
  assert.equal(calls.n, before, 'no progress check during the burst');
  assert.ok(notified >= 10, 'every line still published a state');
  assert.deepEqual(seenInListener, ['done', 'active', 'locked'], 'listeners get the state that was published, not a recomputed one');
  const published = notified;
  // the first read brings the guide up to date — once
  const s1 = lab.getState();
  assert.equal(calls.n, before + 1);
  assert.deepEqual(s1.scenario!.guide.map((g) => g.status), ['done', 'done', 'active']);
  assert.equal(lab.getState(), s1, 'and then the state is stable again');
  assert.equal(calls.n, before + 1);
  assert.equal(notified, published, 'the catch-up itself is not announced (the reader already has the new state)');
  // a read after a burst that changed no step: no new state object
  type(lab, id, ['configure terminal', 'interface loopback 9', 'end']);
  const mid = calls.n;
  const s2 = lab.getState();
  assert.equal(calls.n, mid + 1);
  assert.equal(lab.getState(), s2);
  assert.deepEqual(s2.scenario!.guide.map((g) => g.status), ['done', 'done', 'active']);
});

test('guided mode never refuses on old progress', () => {
  const { lab, calls } = slowLab(100);
  ok(lab.startScenario('mini', 'guided'));
  ok(lab.connectCable('console', port('PC1', 'COM1'), port('R1', 'Console')));
  const open = lab.openConsole('R1');
  assert.ok(open.ok);
  const id = open.ok ? open.session.id : '';
  type(lab, id, ['no', '', 'enable', 'configure terminal']);
  // finish step 1 (cabling) and go straight on with step 2 without anyone reading the state
  for (const c of SOLUTION.cables) assert.equal(lab.connectCable(c.kind, c.a, c.b, { dceEnd: c.dceEnd }).ok, true);
  const before = calls.n;
  const v = lab.sessionExec(id, 'hostname R1');
  assert.equal(v.blocked, undefined, 'step 1 was finished by the last cable; the lab checked before refusing');
  assert.equal(v.prompt, 'R1(config)#');
  assert.equal(calls.n, before + 1, 'one check, made because a refusal was about to happen');
  // lines the (possibly old) active step allows cost no check at all
  const n1 = calls.n;
  type(lab, id, ['interface g0/0/0', 'ip address 10.0.1.1 255.255.255.0']);
  assert.equal(calls.n, n1);
  // a real refusal is still a refusal
  const nat = lab.sessionExec(id, 'ip nat inside source static 10.0.1.10 10.0.12.5');
  assert.match(nat.blocked?.reason ?? '', /NAT is not part of this step, and no later step needs it\. You are on step 2: Set up R1\. Stay with step 2\./);
  // check() and a config file also work from fresh progress
  type(lab, id, ['no shutdown']);
  const rep = lab.applyConfigText('R1', 'ip route 10.0.2.0 255.255.255.0 10.0.12.2\n', 'merge');
  assert.equal(rep.blocked, undefined, 'step 2 was finished by "no shutdown"; routing is step 3');
  assert.deepEqual(statuses(lab), ['done', 'done', 'active']);
});

test('looking around costs no progress check; a scenario that reads the journal is asked whenever the journal grows', () => {
  const calls = { n: 0 };
  const plain = new Lab({ scenarios: [miniScenario({ onProgress: () => { calls.n++; } })], storage: null, now: () => 1_700_000_000_000, pcExec: fakePc });
  ok(plain.startScenario('mini', 'free'));
  cableBench(plain);
  const id = consoleToConfig(plain, 'PC1', 'R1');
  type(plain, id, ['hostname R1']);
  const n0 = calls.n;
  type(plain, id, ['interface g0/0/0', 'exit', 'do show running-config', 'line vty 0 4', 'exit', 'do show running-config | include hostname', '', 'ip adress']);
  plain.getState();
  assert.equal(calls.n, n0, 'moving around, show commands and typos leave the network as it is');
  type(plain, id, ['interface g0/0/0', 'description uplink']);
  assert.equal(calls.n, n0 + 1, 'a real change is checked');
  type(plain, id, ['end']);
  assert.equal(calls.n, n0 + 2, 'leaving configuration mode writes a log message: that is a change');
  type(plain, id, ['show running-config', 'show startup-config']);
  assert.equal(calls.n, n0 + 2);
  plain.setPcService('PC1', 'http', true);
  assert.equal(calls.n, n0 + 3, 'a PC service is a change too');

  // a scenario whose progress looks at the journal
  const seen = { n: 0, last: 0 };
  const reader = new Lab({ scenarios: [miniScenario({ onProgress: (_w, journal) => { seen.n++; seen.last = journal.filter((e) => e.feature === 'verify').length; } })], storage: null, now: () => 1_700_000_000_000, pcExec: fakePc });
  ok(reader.startScenario('mini', 'free'));
  const con = consoleToConfig(reader, 'PC1', 'R1');
  const m0 = seen.n;
  type(reader, con, ['end', 'show running-config', 'show running-config']);
  assert.equal(seen.n, m0 + 3, 'every journaled line may change the answer');
  assert.equal(seen.last, 2);
  assert.equal(reader.getState().journal.length, 6, 'the scenario got a copy: the journal itself is untouched');
});

test('a scenario that cannot handle the watched journal is asked again with a plain array', () => {
  let plainCalls = 0;
  const lab = new Lab({
    scenarios: [miniScenario({ onProgress: (_w, journal) => { structuredClone(journal); plainCalls++; } })],
    storage: null, pcExec: fakePc,
  });
  ok(lab.startScenario('mini', 'free'));
  cableBench(lab);
  assert.ok(plainCalls >= 2);
  assert.deepEqual(statuses(lab), ['done', 'active', 'locked'], 'progress still works');
});
