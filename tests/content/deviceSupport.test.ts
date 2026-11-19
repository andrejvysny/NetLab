import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { generatedFile, renderDeviceSupport } from '../../scripts/generate-device-support.ts';
import { DEVICE_SUPPORT } from '../../src/content/deviceSupport.generated.ts';
import { searchSupport, SUPPORT_STATUSES } from '../../src/content/deviceSupport.ts';
import type { SupportFilters } from '../../src/content/deviceSupport.ts';
import { deviceSupportAvailable, EXAM_COMMAND_SHEET } from '../../src/ui/panels/commandDrawerPolicy.ts';
import { audit } from './coverage-runner.ts';

const search = (filters: Partial<SupportFilters> = {}) => searchSupport(DEVICE_SUPPORT, { model: 'all', status: 'all', query: '', ...filters });

test('browser support inventory is the current executed audit, not a separate compatibility claim', () => {
  const observed = audit();
  assert.ok(readFileSync(generatedFile, 'utf8') === renderDeviceSupport(observed), 'Refresh with node scripts/generate-device-support.ts');
  const rows = search();
  assert.equal(rows.length, observed.results.length);
  assert.equal(DEVICE_SUPPORT.sources.length, observed.sourceLines.filter((row) => row.kind === 'command').length);
  assert.deepEqual(new Set(rows.map(({ probe }) => probe[1])), new Set(Object.keys(SUPPORT_STATUSES)));
  assert.deepEqual(DEVICE_SUPPORT.models.c9300l.networkLicense, observed.models.c9300l.networkLicense);
});

test('search combines model and status with original notation, concrete input and blocked prerequisites', () => {
  const rejectedClock = search({ model: 'c9300l', status: 'hardware-rejection', query: '  CLOCK   RATE ' });
  assert.equal(rejectedClock.length, 1);
  const [{ source, probe }] = rejectedClock;
  assert.deepEqual(source.slice(0, 4), ['A', 1, 32, 32]);
  assert.equal(probe[2], 'rejected');
  assert.match(DEVICE_SUPPORT.evidence[probe[6]], /no WIC\/NIM serial controller/);
  assert.equal(search({ model: 'c9300l', status: 'functional', query: 'clock rate' }).length, 0);
  assert.ok(search({ model: 'isr4331', status: 'functional', query: 'clock rate' }).length > 0);
  assert.equal(search({ query: 'not-a-probed-command' }).length, 0);

  const [accepted] = search({ model: 'isr4331', status: 'functional', query: 'service-policy output OUT' });
  assert.match(accepted.source[4], /service_policy/);
  assert.match(accepted.probe[4], /service-policy/);
  assert.ok(search({ status: 'ill-formed', query: 'service_policy' }).length > 0);
  assert.ok(search({ query: 'operator-dest -port' }).some(({ source }) => source[2] === 71 && source[3] === 72));

  const blocked = search({ model: 'c9300l', status: 'hardware-rejection', query: 'crypto isakmp policy 10' })
    .find(({ probe }) => probe[4] === 'encryption aes');
  assert.ok(blocked);
  assert.equal(blocked.probe[5], 'config-isakmp');
  assert.deepEqual(blocked.probe[7], ['crypto isakmp policy 10', 'config']);
});

test('printed alias EXEC notation remains distinguishable from the successful global config probe', () => {
  const rows = search({ model: 'isr4331', query: 'Router#alias exec' });
  assert.deepEqual(rows.map(({ probe }) => [probe[1], probe[5]]), [['ill-formed', 'priv'], ['functional', 'config']]);
  assert.equal(rows[0].probe[4], rows[1].probe[4]);
  assert.equal(rows[0].source[4], rows[1].source[4]);
});

test('Exam exposes the paper sections but no guided audit or annotations', () => {
  assert.equal(deviceSupportAvailable('exam'), false);
  assert.equal(deviceSupportAvailable('guided'), true);
  assert.equal(deviceSupportAvailable('free'), true);
  assert.deepEqual(EXAM_COMMAND_SHEET.map((s) => s.id), ['sheet-a', 'sheet-b', 'sheet-c', 'sheet-d', 'sheet-e', 'sheet-f', 'sheet-g-alias', 'sheet-g-syslog', 'sheet-g-snmp']);
  const lines = EXAM_COMMAND_SHEET.flatMap((s) => s.lines);
  assert.ok(lines.some((l) => l.text === 'Router>enable'));
  assert.ok(lines.every((line) => Object.keys(line).join() === 'text'), 'no optional note or warning, including in search');
  assert.doesNotMatch(JSON.stringify(EXAM_COMMAND_SHEET), /60\.50\.50\.100|bandwidth 128|BenchX|Not on the paper sheet/);
});
