/** DEV ONLY harness for the workbench (open /bench.html). Not part of the built app. */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { LabMode } from '../../../engine/types.ts';
import { LabProvider, useLabState } from '../../labContext.tsx';
import { dismissNotice, getNotices, subscribeNotices } from '../../notify.ts';
import type { Notice } from '../../notify.ts';
import '../../theme.css';
import { Workbench } from '../Workbench.tsx';
import { createMockLab } from './mockLab.ts';

const { lab, controls } = createMockLab();
(window as unknown as { __lab: unknown; __controls: unknown }).__lab = lab;
(window as unknown as { __lab: unknown; __controls: unknown }).__controls = controls;

function Notices() {
  const [list, setList] = useState<Notice[]>(getNotices());
  useEffect(() => subscribeNotices(setList), []);
  return (
    <div style={{ position: 'fixed', right: 16, bottom: 16, display: 'grid', gap: 8, zIndex: 1000, maxWidth: 380 }}>
      {list.map((n) => (
        <div key={n.id} className={`note ${n.kind === 'guide' ? 'warn' : n.kind === 'info' ? '' : n.kind}`} data-notice={n.kind} style={{ boxShadow: 'var(--shadow)' }}>
          <strong>{n.title}</strong>
          {n.text && <p>{n.text}</p>}
          <button className="btn btn-sm" onClick={() => dismissNotice(n.id)}>Close</button>
        </div>
      ))}
    </div>
  );
}

function DevBar() {
  const state = useLabState();
  const [block, setBlock] = useState(false);
  const mode = state.scenario?.mode ?? 'guided';
  return (
    <header style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '8px 14px', borderBottom: '2px solid var(--line)', background: 'var(--card)', fontSize: 13 }}>
      <strong>Workbench harness</strong>
      <label>mode{' '}
        <select value={mode} onChange={(e) => controls.setMode(e.target.value as LabMode)}>
          <option value="guided">guided</option><option value="free">free</option><option value="exam">exam</option>
        </select>
      </label>
      <label><input type="checkbox" checked={block} onChange={(e) => { setBlock(e.target.checked); controls.blockNext(e.target.checked); }} /> guide blocks next change</label>
      <label><input type="checkbox" checked={state.settings.terminalPaging} onChange={(e) => lab.updateSettings({ terminalPaging: e.target.checked })} /> paging</label>
      <label><input type="checkbox" checked={state.settings.strictCables} onChange={(e) => lab.updateSettings({ strictCables: e.target.checked })} /> strict cables</label>
      <button className="btn btn-sm" onClick={() => controls.cableReference()}>Cable reference topology</button>
      <button className="btn btn-sm" onClick={() => controls.injectSyslog('pc1')}>Syslog → PC1</button>
      <button className="btn btn-sm" onClick={() => controls.injectTrap('pc1')}>Trap → PC1</button>
      <button className="btn btn-sm" onClick={() => controls.dropSession('r1')}>Drop R1 sessions</button>
      <span className="muted">rev {state.rev}</span>
    </header>
  );
}

function App() {
  return (
    <LabProvider value={lab}>
      <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100%' }}>
        <DevBar />
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 300px) minmax(0, 1fr)', minHeight: 0 }}>
          <aside style={{ borderRight: '2px solid var(--line)', padding: 20, overflow: 'auto' }}>
            <h2 style={{ fontSize: 'var(--fs-lg)' }}>Task panel (placeholder)</h2>
            <p className="muted" style={{ marginTop: 10 }}>The real app shell puts the assignment here. The workbench fills the area on the right.</p>
            <p className="muted" style={{ marginTop: 10 }}>Telnet from a PC prompt: 192.168.100.1 or 60.50.30.2, password cisco.</p>
          </aside>
          <main style={{ minWidth: 0, minHeight: 0 }}><Workbench /></main>
        </div>
      </div>
      <Notices />
    </LabProvider>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
