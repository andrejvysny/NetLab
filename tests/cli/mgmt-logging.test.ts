/** logging commands: reference lines, cheat-sheet and lab lines, level normalisation, accepted extras, `no` forms, help. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, addDevice, getIos } from '../../src/engine/world.ts';
import { startSession, execLine, helpFor } from '../../src/engine/cli/framework.ts';
import * as logging from '../../src/engine/cli/commands/logging.ts';
import { syslogLevelNumber } from '../../src/engine/cli/commands/logging.ts';
logging.install();

function lab() {
  const w = createWorld();
  addDevice(w, { id: 'r1', model: 'isr4331', label: 'R1', x: 0, y: 0 });
  const { session: s } = startSession(w, 'r1', 'console');
  s.mode = 'config';
  const dev = getIos(w, 'r1');
  dev.config.interfaces['Loopback0'] = { name: 'Loopback0', shutdown: false };
  const run = (l: string) => execLine(w, s, l);
  const ok = (l: string) => {
    const o = run(l);
    assert.equal(o.status, 'ok', `"${l}" → ${o.status}\n${o.output}`);
    assert.equal(o.feature, 'syslog', l);
    assert.equal(o.mutated, true, l);
    return o;
  };
  return { w, s, dev, run, ok };
}

test('reference configuration lines (R1, R2) and abbreviations', () => {
  const a = lab();
  a.ok('logging source-interface Loopback0');
  a.ok('logging 192.168.100.10');
  assert.deepEqual(a.dev.config.logging, { hosts: ['192.168.100.10'], sourceInterface: 'Loopback0' });
  const b = lab();
  b.ok('logg so lo0');
  b.ok('logg host 192.168.100.10');
  assert.deepEqual(b.dev.config.logging, a.dev.config.logging);
  const r2 = lab();
  r2.ok('logging source-interface Loopback0');
  r2.ok('logging 60.50.50.100');
  assert.deepEqual(r2.dev.config.logging.hosts, ['60.50.50.100']);
});

test('hosts: both spellings, no duplicates, no forms', () => {
  const { dev, ok, run } = lab();
  ok('logging 192.168.100.10');
  ok('logging host 192.168.100.10');
  ok('logging host 10.0.0.5');
  assert.deepEqual(dev.config.logging.hosts, ['192.168.100.10', '10.0.0.5']);
  ok('no logging 192.168.100.10');
  ok('no logging host 10.0.0.5');
  ok('no logging host 10.9.9.9');
  assert.deepEqual(dev.config.logging.hosts, []);
  assert.equal(run('logging').status, 'incomplete');
  assert.equal(run('logging 192.168.100').status, 'invalid');
});

test('source interface', () => {
  const { dev, ok, run } = lab();
  ok('logging source-interface loopback 0');
  assert.equal(dev.config.logging.sourceInterface, 'Loopback0');
  ok('logging source-interface g0/0/1');
  assert.equal(dev.config.logging.sourceInterface, 'GigabitEthernet0/0/1');
  const line = 'logging source-interface Serial0/9/9';
  const o = run(line);
  assert.equal(o.status, 'rejected');
  assert.equal(o.output, ' '.repeat('Router(config)#'.length + line.indexOf('Serial')) + "^\n% Invalid input detected at '^' marker.\n");
  assert.equal(dev.config.logging.sourceInterface, 'GigabitEthernet0/0/1');
  const o2 = ok('logging source-interface Loopback9');
  assert.ok(o2.notes.some((n) => /Loopback9 does not exist yet/.test(n)));
  ok('no logging source-interface');
  assert.equal(dev.config.logging.sourceInterface, undefined);
});

test('trap levels: names, numbers, default', () => {
  const { dev, ok, run } = lab();
  ok('logging trap debugging');
  assert.equal(dev.config.logging.trapLevel, 'debugging');
  ok('logging trap warnings');
  assert.equal(dev.config.logging.trapLevel, 'warnings');
  ok('logging trap 3');
  assert.equal(dev.config.logging.trapLevel, 'errors', 'numbers become names');
  ok('logging trap emerg');
  assert.equal(dev.config.logging.trapLevel, 'emergencies');
  ok('logging trap informational');
  assert.equal(dev.config.logging.trapLevel, undefined, 'informational is the default');
  ok('logging trap 7');
  ok('no logging trap');
  assert.equal(dev.config.logging.trapLevel, undefined);
  assert.deepEqual(dev.config.logging.extraLines, ['no logging trap']);
  ok('logging trap');
  assert.deepEqual(dev.config.logging.extraLines, [], 'the affirmative form re-enables logging at the default threshold');
  assert.equal(dev.config.logging.trapLevel, undefined);
  assert.equal(run('logging trap 8').status, 'invalid');
  assert.equal(run('logging trap e').status, 'ambiguous', 'emergencies or errors');
  assert.equal(syslogLevelNumber('warnings'), 4);
  assert.equal(syslogLevelNumber('7'), 7);
  assert.equal(syslogLevelNumber(undefined), 6);
  assert.equal(syslogLevelNumber('loud'), null);
});

test('accepted extras: on, console, monitor, buffered, facility, history, rate-limit', () => {
  const { dev, ok } = lab();
  let o = ok('logging buffered 128000 debugging');
  assert.ok(o.notes.some((n) => /Accepted, but not simulated/.test(n)));
  ok('logging rate-limit all 3 except informational');
  ok('logging console warnings');
  ok('logging console 2');
  ok('logging monitor informational');
  ok('logging facility local5');
  ok('logging history errors');
  ok('no logging on');
  assert.deepEqual(dev.config.logging.extraLines, [
    'logging buffered 128000 debugging', 'logging rate-limit all 3 except informational', 'logging console critical',
    'logging monitor informational', 'logging facility local5', 'logging history errors', 'no logging on',
  ]);
  ok('logging on');
  ok('no logging console');
  ok('logging buffered 16384');
  ok('no logging facility');
  ok('no logging rate-limit');
  ok('no logging history');
  ok('logging monitor');
  assert.deepEqual(dev.config.logging.extraLines, ['no logging console', 'logging buffered 16384']);
  o = ok('no logging buffered');
  assert.deepEqual(dev.config.logging.extraLines, ['no logging console', 'no logging buffered']);
  assert.deepEqual(dev.config.logging.hosts, [], 'extras do not touch the syslog hosts');
});

test('? help reads like IOS', () => {
  const { w, s } = lab();
  const top = helpFor(w, s, 'logging ');
  assert.match(top, /A\.B\.C\.D\s+IP address of the logging host/);
  assert.match(top, /source-interface\s+Specify interface for source address in logging transactions/);
  assert.match(top, /trap\s+Set syslog server logging level/);
  assert.match(helpFor(w, s, 'logging trap '), /<0-7>\s+Logging severity level[\s\S]*warnings\s+Warning conditions\s+\(severity=4\)[\s\S]*<cr>/);
});
