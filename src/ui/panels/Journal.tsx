/** "My actions": the journal as a readable timeline with filters and text export. Owned by the app-shell agent. */
import { Icon } from '../icons.tsx';
import { useMemo, useState } from 'react';
import type { JournalEntry } from '../../engine/types.ts';
import { useLabState } from '../labContext.tsx';
import { ExportDialog, FeatureBadge, featureLabel } from './ui.tsx';
import { useDeviceLabel } from './TaskPanel.tsx';
import { fileSlug, todayStamp } from './safe.ts';

const VIA: Record<JournalEntry['via'], string> = { console: 'Console', vty: 'Telnet', file: 'Config file', pc: 'PC settings', bench: 'Bench' };

function statusOf(e: JournalEntry): { word: string; icon: string; state: string } {
  if (e.blocked) return { word: 'Stopped by the guide', icon: '⊘', state: 'blocked' };
  if (!e.ok) return { word: 'Error', icon: '✗', state: 'fail' };
  return { word: e.mutated ? 'Changed' : 'OK', icon: '✓', state: 'pass' };
}

export function Journal() {
  const state = useLabState();
  const label = useDeviceLabel();
  const journal = Array.isArray(state.journal) ? state.journal : [];
  const [dev, setDev] = useState('all');
  const [feat, setFeat] = useState('all');
  const [problems, setProblems] = useState(false);
  const [newestFirst, setNewestFirst] = useState(true);
  const [exportText, setExportText] = useState<string | null>(null);

  const devices = useMemo(() => [...new Set(journal.map((e) => e.deviceId))], [journal]);
  const features = useMemo(() => [...new Set(journal.map((e) => e.feature))], [journal]);
  const list = journal.filter((e) => (dev === 'all' || e.deviceId === dev) && (feat === 'all' || e.feature === feat) && (!problems || !e.ok || e.blocked));
  const shown = newestFirst ? [...list].reverse() : list;
  const issues = journal.filter((e) => !e.ok || e.blocked).length;

  const asText = () => {
    const title = state.scenario?.summary.title ?? 'Lab';
    const lines = list.map((e) => {
      const st = statusOf(e).word;
      return `#${String(e.tick).padStart(4)}  ${label(e.deviceId).padEnd(8)} ${VIA[e.via].padEnd(12)} ${(e.mode ? `(${e.mode})` : '').padEnd(14)} ${e.line}   [${featureLabel(e.feature)}] ${st}`;
    });
    return [`KSS NetLab — my actions`, title, `${list.length} actions`, '', ...lines, ''].join('\n');
  };

  return (
    <div className="nl-journal">
      <div className="nl-journal-tools">
        <div className="nl-form nl-form-tight">
          <label className="field">
            <span>Device</span>
            <select value={dev} onChange={(e) => setDev(e.target.value)} data-autofocus>
              <option value="all">All devices</option>
              {devices.map((d) => <option key={d} value={d}>{label(d)}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Topic</span>
            <select value={feat} onChange={(e) => setFeat(e.target.value)}>
              <option value="all">All topics</option>
              {features.map((f) => <option key={f} value={f}>{featureLabel(f)}</option>)}
            </select>
          </label>
        </div>
        <div className="row">
          <label className="nl-check nl-check-sm">
            <input type="checkbox" checked={problems} onChange={(e) => setProblems(e.target.checked)} />
            <span>Only errors and stops ({issues})</span>
          </label>
          <button type="button" className="btn btn-sm" onClick={() => setNewestFirst(!newestFirst)}>{newestFirst ? '↓ Newest first' : '↑ Oldest first'}</button>
          <button type="button" className="btn btn-sm" disabled={list.length === 0} onClick={() => setExportText(asText())}><Icon name="download" /> Export as text</button>
        </div>
        <p className="muted" role="status">{list.length} of {journal.length} actions</p>
      </div>
      {journal.length === 0 ? <p className="note">Nothing yet. Every command you type and every cable you plug in shows up here.</p> : null}
      <ol className="nl-timeline">
        {shown.map((e, i) => {
          const st = statusOf(e);
          return (
            <li key={`${e.tick}-${i}`} className="nl-tl-item" data-state={st.state} data-feature={e.feature}>
              <div className="nl-tl-top">
                <span className="nl-tl-dev">{label(e.deviceId)}</span>
                <span className="muted nl-tl-via">{VIA[e.via] ?? e.via}{e.mode ? ` · ${e.mode}` : ''}</span>
                <span className="nl-tl-status" data-state={st.state}><span aria-hidden="true">{st.icon}</span> {st.word}</span>
              </div>
              <code className="nl-tl-line">{e.line}</code>
              <div className="row nl-tl-meta">
                <FeatureBadge feature={e.feature} small />
                <span className="muted">action #{e.tick}</span>
              </div>
            </li>
          );
        })}
      </ol>
      {exportText !== null ? (
        <ExportDialog
          title="Export my actions"
          intro="A plain text list of what you did. Good for looking back, or for asking your teacher."
          filename={`kss-netlab-actions-${fileSlug(state.scenario?.summary.title ?? 'lab')}-${todayStamp()}.txt`}
          text={exportText}
          onClose={() => setExportText(null)}
        />
      ) : null}
    </div>
  );
}
