import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { audit, auditCsv } from './coverage-runner.ts';

test('exact five-page sheet: declared CLI dispositions and behavior probes hold on both virtual devices', () => {
  const a = audit();
  assert.deepEqual(a.results.filter((r) => 'error' in r).map((r) => ({ line: r.line, variant: r.variant, model: r.model, error: r.error })), []);
  assert.ok(auditCsv(a) === readFileSync(new URL('../../docs/command-coverage.csv', import.meta.url), 'utf8'),
    'Refresh the coverage snapshot with node scripts/command-coverage.mjs --csv > docs/command-coverage.csv');
});
