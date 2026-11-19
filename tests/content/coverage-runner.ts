import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execLine, inspectLine, interrupt, startSession } from '../../src/engine/cli/index.ts';
import { MODEL_INFO } from '../../src/engine/world.ts';
import { cases } from './coverage-cases.ts';
import type { Case, Label } from './coverage-cases.ts';
import { commands, fixture, transcript } from './coverage-fixture.ts';
import type { Bench, Model } from './coverage-fixture.ts';

const SHEET_SHA256 = '6fb95d74c30a0a42c717e0943fd13d8ef6b4e91210d8bcf00e229c5523faa1bb';
const source = readFileSync(new URL('../../docs/course/cheat-sheet.txt', import.meta.url), 'utf8');
const sha256 = createHash('sha256').update(source).digest('hex');
const lines = source.split('\n');
const wrapped = new Map([[68,69],[71,72],[75,76],[103,104],[170,171],[172,173],[270,271]]);
const standalone = new Set([56,83,84,86,87,134,157,158,159]);
const references = new Map([[257,'See Section B: ACL syntax; Section G L259 and L262 test its SNMP consumer.']]);
const models = ['isr4331','c9300l'] as const;
export function sheetInventory() {
  let section = '', page = 1;
  return lines.flatMap((raw, i) => {
    const line = i + 1;
    const t = raw.trim();
    if (!t || t.startsWith('Test – konfiguračné príkazy')) return [];
    if (/^[1-5]$/.test(t)) { page = Number(t) + 1; return []; }
    if ([...wrapped.values()].includes(line)) return [];
    const title = /^([A-G])\) /.exec(t);
    if (title) section = title[1];
    const lastLine = wrapped.get(line) ?? line;
    const text = lines.slice(i,lastLine).join('\n');
    const kind = (/(^Router\b.*#|^Router>)/.test(t) || standalone.has(line)) ? 'command' : references.has(line) ? 'reference' : 'context';
    return [{ section, page, line, lastLine, text, kind, ...(references.has(line) ? { reference: references.get(line) } : {}) }];
  });
}

export function validateInventory() {
  assert.equal(sha256, SHEET_SHA256, 'Sheet changed: review every manifest line before updating the snapshot hash');
  const inv = sheetInventory();
  assert.deepEqual(new Set(inv.filter((x) => x.kind === 'command').map((x) => x.line)), new Set(cases.map((c) => c.line)));
  assert.deepEqual(new Set(inv.map((x) => x.section).filter(Boolean)), new Set('ABCDEFG'));
  assert.equal(new Set(cases.map((c) => `${c.line}:${c.variant}`)).size, cases.length);
  assert.equal(inv.filter((x) => x.kind === 'command').length, 149, 'review manifest after changes to the physical sheet');
}

export function executeCase(row: Case, model: Model) {
  const b = fixture(model, row.preset ?? 'fresh');
  const target = row.target ?? 'X';
  const evaluate = (text: string | ((ctx: Bench) => string)) => typeof text === 'function' ? text(b) : text;
  const expected = model === 'c9300l' ? row.switch ?? row.router : row.router;
  const s = startSession(b.w, target, 'console').session;
  const input = evaluate(row.input);
  const blocker = model === 'c9300l' && row.switchBlock ? evaluate(row.switchBlock) : undefined;
  const unsupportedCatCrypto = model === 'c9300l' && row.line >= 123 && row.line <= 145 && row.line !== 134;
  const prefix = unsupportedCatCrypto ? (row.mode === 'config-if' ? ['configure terminal', `interface ${b.wan}`] : ['configure terminal']) : (row.pre ?? []).map(evaluate);
  const setup = [...(row.mode !== 'user' ? ['enable'] : []), ...prefix];
  const base = { line: row.line, variant: row.variant, model, ios: MODEL_INFO[model].ios, networkLicense: MODEL_INFO[model].networkLicense, target, input, mode: row.mode,
    fixture: row.preset ?? 'fresh', setup, prerequisite: row.prerequisite, hasPeerOrFixtureSetup: !!row.before, expected: expected.status,
    expectedLabel: expected.label, proof: expected.proof, key: row.key };
  try {
    row.before?.(b);
    commands(b.w, target, setup, s);
    if (!blocker) assert.equal(s.mode, row.mode, 'prerequisites did not reach command mode');
    else assert.equal(s.mode, 'config');
  } catch (e) {
    return { ...base, prerequisiteCommands: transcript(b.w).slice(), label: 'unresolved' as Label, error: `Fixture failed: ${(e as Error).message}` };
  }
  const entered = blocker ?? input;
  const attempted = { ...base, prerequisiteCommands: transcript(b.w).slice(), effectiveMode: blocker ? 'config' : row.mode, executed: entered,
    ...(blocker ? { blockedAt: blocker } : {}) };
  const run = () => {
    const parser = row.key ? 'key-event' : inspectLine(b.w, s, entered).status;
    const outcome = row.key ? interrupt(b.w, s, row.key) : execLine(b.w, s, entered);
    return { parser, outcome };
  };
  let execution: ReturnType<typeof run>;
  try { execution = run(); } catch (e) {
    return { ...attempted, label: 'unresolved' as Label, error: `CLI threw: ${(e as Error).message}` };
  }
  const { parser, outcome } = execution;
  const observed = { ...attempted, parser, outcome: outcome.status, notes: outcome.notes, output: outcome.output, nextMode: s.mode };
  try {
    assert.equal(outcome.status, expected.status, `execution status for ${entered}`);
    if (expected.label === 'functional') assert.ok(expected.verify, 'functional requires an independent assertion');
    expected.verify?.({ ...b, s, target }, outcome);
    return { ...observed, label: expected.label };
  } catch(e) {
    return { ...observed, label: 'unresolved' as Label, error: (e as Error).message };
  }
}
export function audit(filter: { section?: string; line?: number; model?: Model } = {}) {
  validateInventory();
  const sourceLines = sheetInventory();
  const chosen = filter.model ? models.filter((m) => m === filter.model) : models;
  const index = new Map(sourceLines.map((s) => [s.line,s]));
  const selected = cases.filter((c) => (!filter.section || index.get(c.line)?.section === filter.section) && (!filter.line || filter.line === c.line));
  return {
    source: 'docs/course/cheat-sheet.txt', sha256,
    models: Object.fromEntries(chosen.map((model) => [model, MODEL_INFO[model]])), sourceLines,
    results: selected.flatMap((c) => chosen.filter((m) => (!c.rOnly || m === 'isr4331') && (!c.sOnly || m === 'c9300l')).map((m) => ({ section: index.get(c.line)?.section, page: index.get(c.line)?.page, ...executeCase(c, m) }))),
  };
}

/** Compact artifact for spreadsheets; JSON mode retains raw output and the full prerequisite transcript. */
export function auditCsv(a: ReturnType<typeof audit>): string {
  const quote = (s: unknown) => `"${String(s ?? '').replaceAll('"', '""')}"`;
  const index = new Map(a.sourceLines.map((r) => [r.line,r]));
  const rows = [['section','page','line','last_line','paper_text','variant','model','ios','network_license','target','fixture','mode','effective_mode','input','executed','blocked_at','setup','parser','outcome','label','evidence','error'],
    ...a.results.map((r) => [r.section, r.page, r.line, index.get(r.line)?.lastLine, index.get(r.line)?.text.trim().replace(/\s+/g,' '),
      r.variant, r.model, r.ios, r.networkLicense, r.target, r.fixture, r.mode, 'effectiveMode' in r ? r.effectiveMode : '', r.input, 'executed' in r ? r.executed : '',
      'blockedAt' in r ? r.blockedAt : '', r.setup.join(' ; '),
      'parser' in r ? r.parser : '', 'outcome' in r ? r.outcome : '', r.label, r.proof, 'error' in r ? r.error : ''])];
  return rows.map((r) => r.map(quote).join(',')).join('\n') + '\n';
}
