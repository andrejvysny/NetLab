#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { audit, auditCsv } from '../tests/content/coverage-runner.ts';

const { values } = parseArgs({ options: {
  json: { type: 'boolean' }, csv: { type: 'boolean' }, section: { type: 'string' }, device: { type: 'string' }, line: { type: 'string' },
} });
const section = values.section?.toUpperCase();
const model = values.device?.toLowerCase();
if ((section && !/^[A-G]$/.test(section)) || (model && !['isr4331','c9300l'].includes(model)) ||
    (values.line && !/^[1-9]\d*$/.test(values.line)) || (values.json && values.csv)) {
  throw new Error('Usage: node scripts/command-coverage.mjs [--json | --csv] [--section A..G] [--line SOURCE_LINE] [--device isr4331|c9300l]');
}
const a = audit({ section, model, line: values.line ? Number(values.line) : undefined });
const tally = (rows) => Object.fromEntries([...new Set(rows.map((r) => r.label))].sort().map((s) => [s, rows.filter((r) => r.label === s).length]));
const fail = a.results.filter((r) => 'error' in r);
if (values.json) process.stdout.write(`${JSON.stringify(a, null, 2)}\n`);
else if (values.csv) process.stdout.write(auditCsv(a));
else {
  console.log(`${a.source}: ${a.sourceLines.filter((x) => x.kind === 'command').length} command references across sections A–G`);
  for (const [model, info] of Object.entries(a.models)) {
    const rows = a.results.filter((r) => r.model === model);
    console.log(`${info.name} / ${info.ios}: ${rows.length} model probes`, tally(rows));
  }
  for (const r of fail) console.error(`${r.model} L${r.line} ${r.variant}: ${r.error}${r.output ? `\n${r.output}` : ''}`);
}
if (!a.results.length) { console.error('No matching probes.'); process.exitCode = 1; }
if (fail.length) process.exitCode = 1;
