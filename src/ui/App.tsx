/**
 * App shell: LabProvider at the root, settings applied to the document, notices, error boundary,
 * Home when no scenario is open, the Lab screen otherwise. Owned by the app-shell agent.
 */
import { Icon } from './icons.tsx';
import { Component, useEffect, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import type { LabApi, UiSettings } from '../engine/labapi.ts';
import { LabProvider, useLabState } from './labContext.tsx';
import { Home } from './screens/Home.tsx';
import { LabScreen } from './screens/LabScreen.tsx';
import { Notices } from './panels/Notices.tsx';
import { ExportDialog } from './panels/ui.tsx';
import { errorText, fileSlug, safeCall, todayStamp } from './panels/safe.ts';
import './screens/app.css';

/** Mirror the user's settings onto <html>/<body> so every component (and the Workbench) picks them up. */
function applySettings(s: UiSettings | undefined) {
  if (!s) return;
  try {
    const root = document.documentElement;
    const scale = Math.min(1.4, Math.max(0.85, Number(s.fontScale) || 1));
    root.style.setProperty('--fs-scale', String(scale));
    root.style.setProperty('--term-fs', `${Math.min(28, Math.max(10, Number(s.terminalFontPx) || 14))}px`);
    const body = document.body;
    body.classList.toggle('font-atkinson', s.font === 'atkinson');
    body.classList.toggle('font-system', s.font === 'system');
    body.classList.toggle('reduce-motion', !!s.reduceMotion);
  } catch {
    /* ignore */
  }
}

function SettingsMirror() {
  const state = useLabState();
  const s = state.settings;
  useEffect(() => { applySettings(s); }, [s?.fontScale, s?.font, s?.terminalFontPx, s?.reduceMotion]);
  return null;
}

function Screens() {
  const state = useLabState();
  const sc = state.scenario;
  if (!sc) return <Home />;
  return <LabScreen key={`${sc.summary.id}:${sc.mode}:${sc.startedAt}`} />;
}

/** Dev helper: ?crash makes the lab screen throw so the error boundary can be checked. */
function CrashProbe() {
  const crash = safeCall(() => import.meta.env.DEV && new URLSearchParams(window.location.search).has('crash'), false);
  if (crash) throw new Error('Test crash (?crash in the address).');
  return null;
}

interface BoundaryProps { lab: LabApi; children: ReactNode }
interface BoundaryState { error: Error | null; exportText: string | null }

class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, exportText: null };
  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    try { console.error('KSS NetLab UI error:', error, info.componentStack); } catch { /* ignore */ }
  }
  private reset = () => this.setState({ error: null, exportText: null });
  render() {
    const { error, exportText } = this.state;
    if (!error) return this.props.children;
    const lab = this.props.lab;
    const title = safeCall(() => lab.getState().scenario?.summary.title ?? 'lab', 'lab');
    return (
      <main className="nl-crash">
        <div className="nl-crash-card card">
          <p className="nl-crash-icon" aria-hidden="true"><Icon name="alert" /></p>
          <h1>Something went wrong on this screen.</h1>
          <p className="nl-lead">Your lab is still in memory. You can save a copy of it now, then try again.</p>
          <div className="row nl-crash-actions">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={() => this.setState({ exportText: safeCall(() => lab.exportLab(), '') })}
            >
              <Icon name="download" /> Export my lab
            </button>
            <button type="button" className="btn btn-lg" onClick={this.reset}>Try again</button>
            <button
              type="button"
              className="btn btn-lg"
              onClick={() => { safeCall(() => { lab.leaveScenario(); return true; }, false); this.reset(); }}
            >
              Back to the start page
            </button>
          </div>
          <details className="nl-crash-details">
            <summary>Technical details (for the developer)</summary>
            <pre className="mono">{errorText(error)}</pre>
          </details>
        </div>
        {exportText !== null ? (
          <ExportDialog
            title="Export my lab"
            intro="Save this file. Later you can open it again with Import lab on the start page."
            filename={`kss-netlab-${fileSlug(title)}-${todayStamp()}.json`}
            text={exportText || '{}'}
            mime="application/json"
            onClose={() => this.setState({ exportText: null })}
          />
        ) : null}
      </main>
    );
  }
}

export function App(props: { lab: LabApi }) {
  // Apply the settings once before the first paint as well.
  useState(() => { applySettings(safeCall(() => props.lab.getState().settings, undefined as unknown as UiSettings)); return 0; });
  return (
    <LabProvider value={props.lab}>
      <SettingsMirror />
      <ErrorBoundary lab={props.lab}>
        <CrashProbe />
        <Screens />
      </ErrorBoundary>
      <Notices />
    </LabProvider>
  );
}
