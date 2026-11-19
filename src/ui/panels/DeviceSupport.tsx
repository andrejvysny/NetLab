import { useMemo, useState } from 'react';
import { DEVICE_SUPPORT } from '../../content/deviceSupport.generated.ts';
import { SUPPORT_MODELS, SUPPORT_SECTIONS, SUPPORT_STATUSES, searchSupport } from '../../content/deviceSupport.ts';
import type { SupportFilters, SupportModel, SupportProbe, SupportSource, SupportStatus } from '../../content/deviceSupport.ts';

const PAGE_SIZE = 12;
const statuses = Object.keys(SUPPORT_STATUSES) as SupportStatus[];
const shortModel: Record<SupportModel, string> = { isr4331: 'ISR 4331', c9300l: 'Catalyst 9300L' };
const outcomeText: Partial<Record<SupportProbe[2], string>> = { ok: 'Accepted', invalid: 'Invalid', rejected: 'Rejected' };
const modeText = (mode: SupportProbe[5]) => mode === 'user' ? 'User EXEC (>)' : mode === 'priv' ? 'Privileged EXEC (#)' : `(${mode})#`;

function AuditGuide() {
  return (
    <details className="nl-ds-guide">
      <summary>How to read results and check hardware</summary>
      <p>These tests use virtual devices, not Cisco hardware. One paper line may have several syntax or interface variants, so counts are probes, not distinct commands.</p>
      <ul>
        {SUPPORT_MODELS.map((model) => {
          const { name, ios, networkLicense } = DEVICE_SUPPORT.models[model];
          return <li key={model}>{name} · IOS XE {ios}{networkLicense === 'network-advantage' ? ' · Network Advantage' : ''}</li>;
        })}
      </ul>
      <p><strong>Hardware-only or uncertain?</strong> On an instructor-approved device, check the exact release and license with <code>show version</code>, then use <code>?</code> in the appropriate mode to check syntax. Verify the behavior separately: accepting a command is not proof it works. For documented restrictions, use an applicable model, port or link role; retrying the same input won’t change the restriction.</p>
      <dl>
        {statuses.map((status) => <div key={status}><dt>{SUPPORT_STATUSES[status].label}</dt><dd>{SUPPORT_STATUSES[status].meaning}</dd></div>)}
      </dl>
      <p>Audit and Cisco references: <code>docs/COMMAND_COVERAGE.md</code>. Line numbers refer to <code>{DEVICE_SUPPORT.source}</code>.</p>
    </details>
  );
}

function Probe({ row }: { row: SupportProbe }) {
  const [model, status, outcome, variant, input, mode, evidence, blocked] = row;
  return (
    <li className="nl-ds-probe">
      <div className="nl-ds-meta">
        <span className="nl-ds-status" data-status={status}>{SUPPORT_STATUSES[status].label}</span>
        <strong>{shortModel[model]}</strong>
      </div>
      <p className="nl-ds-fine muted">{variant}</p>
      <p className="nl-ds-code"><span>{blocked ? 'Not run:' : 'Probe:'}</span>{' '}{input === 'Ctrl+Z' ? <kbd>{input}</kbd> : <code>{input}</code>}</p>
      <p className="nl-ds-fine">{blocked ? 'Target mode' : 'Mode'}: <code>{modeText(mode)}</code>{!blocked && <> · Lab result: {outcomeText[outcome] ?? outcome}</>}</p>
      {blocked && <p className="nl-ds-fine nl-ds-code">Blocked in <code>{modeText(blocked[1])}</code> at <code>{blocked[0]}</code>.</p>}
      <p>{DEVICE_SUPPORT.evidence[evidence]}</p>
    </li>
  );
}

export function DeviceSupport() {
  const [filters, setFilters] = useState<SupportFilters>({ model: 'all', status: 'all', query: '' });
  const [page, setPage] = useState(0);
  const results = useMemo(() => searchSupport(DEVICE_SUPPORT, filters), [filters]);
  const start = page * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, results.length);
  const groups = new Map<SupportSource, SupportProbe[]>();
  for (const { source, probe } of results.slice(start, end)) {
    const probes = groups.get(source) ?? [];
    probes.push(probe);
    groups.set(source, probes);
  }
  function updateFilter(change: Partial<SupportFilters>) {
    setFilters({ ...filters, ...change });
    setPage(0);
  }

  return (
    <section className="nl-ds" aria-labelledby="device-support-title">
      <div>
        <h3 id="device-support-title">Device support</h3>
        <p className="muted">What the virtual devices did with examples from the course sheet. Not a physical hardware test or a lab solution.</p>
      </div>
      <div className="nl-ds-controls">
        <label className="field"><span>Find a command</span>
          <input type="search" value={filters.query} onChange={(e) => updateFilter({ query: e.target.value })} placeholder="e.g. clock rate, alias, show ip nat" />
        </label>
        <div className="nl-ds-filters">
          <label className="field"><span>Model</span>
            <select value={filters.model} onChange={(e) => updateFilter({ model: e.target.value as SupportFilters['model'] })}>
              <option value="all">All models</option>
              {SUPPORT_MODELS.map((model) => <option key={model} value={model}>{shortModel[model]}</option>)}
            </select>
          </label>
          <label className="field"><span>Status</span>
            <select value={filters.status} onChange={(e) => updateFilter({ status: e.target.value as SupportFilters['status'] })}>
              <option value="all">All statuses</option>
              {statuses.map((status) => <option key={status} value={status}>{SUPPORT_STATUSES[status].label}</option>)}
            </select>
          </label>
        </div>
      </div>
      <AuditGuide />
      <div className="nl-ds-meta nl-ds-pager">
        <p className="muted" role="status">
          {!results.length ? 'No matching probes.' : results.length <= PAGE_SIZE ? `${results.length} matching ${results.length === 1 ? 'probe' : 'probes'}` : `Showing ${start + 1}–${end} of ${results.length} probes`}
        </p>
        {results.length > PAGE_SIZE && (
          <nav className="nl-ds-meta" aria-label="Probe pages">
            <button type="button" className="btn btn-sm" aria-label="Previous probes" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button>
            <button type="button" className="btn btn-sm" aria-label="Next probes" disabled={end === results.length} onClick={() => setPage(page + 1)}>Next</button>
          </nav>
        )}
      </div>
      {!results.length && <p>Try another command, model or status.</p>}
      {[...groups].map(([[section, sourcePage, line, lastLine, paper], probes]) => (
        <section key={line} className="nl-ds-source">
          <header>
            <h4>Section {section} · {SUPPORT_SECTIONS[section]}</h4>
            <p className="nl-ds-fine muted">Paper page {sourcePage} · {lastLine === line ? `line ${line}` : `lines ${line}–${lastLine}`}</p>
            <p className="nl-ds-code"><span>Printed:</span> <code>{paper}</code></p>
          </header>
          <ul className="nl-ds-probes" role="list">{probes.map((row) => <Probe key={`${row[0]}:${row[3]}`} row={row} />)}</ul>
        </section>
      ))}
    </section>
  );
}
