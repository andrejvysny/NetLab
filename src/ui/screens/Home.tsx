/**
 * Home screen: what this is, how a session works, saved labs, scenario cards by family, import.
 * Picking a scenario opens the start sheet (mode, timer, variation). Owned by the app-shell agent.
 */
import { useMemo, useRef, useState } from 'react';
import type { ScenarioSummary } from '../../engine/types.ts';
import type { SavedLabSummary } from '../../engine/labapi.ts';
import { useLab, useLabState } from '../labContext.tsx';
import { notify } from '../notify.ts';
import { ConfirmDialog, FeatureBadge, ModeBadge, featureLabel } from '../panels/ui.tsx';
import { errorText, formatDateTime, readFileText, safeCall } from '../panels/safe.ts';
import { SettingsDialog } from '../panels/SettingsDialog.tsx';
import { StartSheet } from './StartSheet.tsx';
import { FAMILY_META, FAMILY_ORDER, LevelText } from './common.tsx';
import { Icon } from '../icons.tsx';

function ScenarioCard(props: { s: ScenarioSummary; no: string; onPick: () => void }) {
  const { s } = props;
  const shown = s.features.slice(0, 5);
  const rest = s.features.slice(5);
  return (
    <li className="nl-scard" data-family={s.family}>
      <span className="nl-scard-no" aria-hidden="true">{props.no}</span>
      <button type="button" className="nl-scard-btn" onClick={props.onPick} aria-label={`${s.title}. ${s.blurb} Open to start.`}>
        <span className="nl-scard-title">{s.title}</span>
        <span className="nl-scard-blurb">{s.blurb}</span>
        <span className="nl-scard-badges">
          {shown.map((f) => <FeatureBadge key={f} feature={f} small />)}
          {rest.length ? <span className="badge nl-more" title={rest.map(featureLabel).join(', ')}>+{rest.length} more</span> : null}
        </span>
        <span className="nl-scard-meta">
          <span><Icon name="clock" /> about {s.minutes} min</span>
          <LevelText level={s.level} />
          {s.seedable ? <span><Icon name="shuffle" /> New numbers possible</span> : null}
        </span>
        <span className="nl-scard-go" aria-hidden="true">Open <Icon name="arrowRight" /></span>
      </button>
    </li>
  );
}

function SavedRow(props: { s: SavedLabSummary; onResume: () => void; onDelete: () => void }) {
  const { s } = props;
  return (
    <li className="nl-saved">
      <div className="nl-saved-main">
        <strong>{s.title}</strong>
        <span className="row nl-saved-meta">
          <ModeBadge mode={s.mode} />
          <span className="muted">Saved {formatDateTime(s.savedAt)}</span>
          {typeof s.percent === 'number' ? <span className="muted">· Last check: {s.percent} %</span> : null}
        </span>
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={props.onResume}>Continue</button>
        <button type="button" className="btn btn-ghost" onClick={props.onDelete} aria-label={`Delete saved lab: ${s.title}`}>Delete</button>
      </div>
    </li>
  );
}

export function Home() {
  const lab = useLab();
  const state = useLabState();
  const scenarios = useMemo(() => safeCall(() => lab.listScenarios(), []), [lab]);
  const [picked, setPicked] = useState<ScenarioSummary | null>(null);
  const [toDelete, setToDelete] = useState<SavedLabSummary | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const saved = state.storage?.saved ?? [];
  const storageOk = state.storage?.available !== false;

  const groups = FAMILY_ORDER.map((f) => ({ family: f, items: scenarios.filter((s) => s.family === f) })).filter((g) => g.items.length > 0);
  const firstLab = scenarios.find((s) => s.family === 'lab' && s.level === 1) ?? scenarios[0];

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await readFileText(file);
      const r = lab.importLab(text);
      if (r.ok) notify({ kind: 'ok', title: 'Lab opened', text: r.message });
      else notify({ kind: 'bad', title: 'Could not open this file', text: r.message ?? 'The file is not a lab file.' });
    } catch (e) {
      notify({ kind: 'bad', title: 'Could not read the file', text: errorText(e) });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="nl-home">
      <header className="nl-home-top">
        <div className="nl-brand">
          <span className="nl-brand-mark" aria-hidden="true"><Icon name="network" /></span>
          <span className="nl-brand-text">
            <span className="nl-brand-name">KSS <b>NetLab</b></span>
            <span className="nl-brand-sub">Network laboratory · IOS XE 17.3 simulator</span>
          </span>
        </div>
        <nav className="row" aria-label="Start page tools">
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}><Icon name="folder" /> Open a lab file</button>
          <button type="button" className="btn" onClick={() => setSettingsOpen(true)}><Icon name="settings" /> Settings</button>
          <input ref={fileRef} type="file" accept=".json,application/json,text/plain" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => importFile(e.target.files?.[0])} />
        </nav>
      </header>

      <div className="nl-home-shell">
        <aside className="nl-home-side" aria-label="Course contents">
          <p className="nl-side-label">Course contents</p>
          <nav className="nl-jump" aria-label="Jump to a group">
            {groups.map((g) => (
              <a key={g.family} href={`#fam-${g.family}`} className="nl-jump-link" data-feature={FAMILY_META[g.family].tone}>
                <Icon name={FAMILY_META[g.family].icon} />
                <span className="nl-jump-name">{FAMILY_META[g.family].title}</span>
                <span className="nl-jump-count">{g.items.length}</span>
              </a>
            ))}
          </nav>
          <dl className="nl-side-facts">
            <div><dt>Routers</dt><dd>Cisco ISR 4331</dd></div>
            <div><dt>Switches</dt><dd>Catalyst 9300L-24T-4G</dd></div>
            <div><dt>Software</dt><dd>IOS XE 17.3 (modelled)</dd></div>
          </dl>
        </aside>

        <main className="nl-home-main">
          <section className="nl-hero" aria-labelledby="hero-title">
            <p className="nl-eyebrow">KSS · Practical exam preparation</p>
            <h1 id="hero-title">Practise the router exam, one step at a time.</h1>
            <p className="nl-lead">
              Cable the devices from the assignment, configure them at the console, then test your network. NetLab models the course commands for the ISR 4331 and Catalyst 9300L-24T-4G on IOS XE 17.3; it does not run Cisco firmware.
            </p>
            {firstLab && saved.length === 0 ? (
              <button type="button" className="nl-bigstart" onClick={() => setPicked(firstLab)}>
                <span className="nl-bigstart-tag">Recommended first lab</span>
                <strong>New here? Start with “{firstLab.title}”</strong>
                <small>About {firstLab.minutes} minutes. Guided mode shows you one step at a time.</small>
                <span className="nl-bigstart-go" aria-hidden="true"><Icon name="arrowRight" /></span>
              </button>
            ) : null}
          </section>

          <section className="nl-how" aria-labelledby="how-title">
            <h2 id="how-title">How a session works</h2>
            <ol className="nl-how-list">
              <li>
                <span className="nl-how-no" aria-hidden="true">1</span>
                <div><strong>Pick a task</strong><p>Choose an assignment below. Then choose how you want to work: guided, free, or exam.</p></div>
              </li>
              <li>
                <span className="nl-how-no" aria-hidden="true">2</span>
                <div><strong>Cable and configure</strong><p>Plug in the cables, open a terminal through the console cable, and type the commands.</p></div>
              </li>
              <li>
                <span className="nl-how-no" aria-hidden="true">3</span>
                <div><strong>Check your work</strong><p>The lab tests what the network really does, and explains every result in plain words.</p></div>
              </li>
            </ol>
          </section>

          {!storageOk ? (
            <p className="note warn nl-home-note">
              <strong>Saving is switched off in this window.</strong> Your lab is not kept when you close the page. To keep a copy, use <b>Settings → Export lab</b> before you leave.
            </p>
          ) : null}

          {saved.length > 0 ? (
            <section className="nl-saved-sec" aria-labelledby="saved-title">
              <h2 id="saved-title">Continue where you left off</h2>
              <ul className="nl-saved-list">
                {saved.map((s) => (
                  <SavedRow
                    key={s.id}
                    s={s}
                    onResume={() => {
                      const r = safeCall(() => lab.loadSaved(s.id), { ok: false, message: 'Could not open this lab.' });
                      if (!r.ok) notify({ kind: 'bad', title: 'Could not open this lab', text: r.message });
                    }}
                    onDelete={() => setToDelete(s)}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {groups.map((g, gi) => (
            <section key={g.family} id={`fam-${g.family}`} className="nl-family" aria-labelledby={`fam-${g.family}-title`}>
              <div className="nl-family-head" data-feature={FAMILY_META[g.family].tone}>
                <span className="nl-family-icon" aria-hidden="true"><Icon name={FAMILY_META[g.family].icon} /></span>
                <div>
                  <h2 id={`fam-${g.family}-title`}><span className="nl-family-no">{gi + 1}</span>{FAMILY_META[g.family].title}</h2>
                  <p className="muted">{FAMILY_META[g.family].text}</p>
                </div>
                <span className="nl-family-count muted">{g.items.length} {g.items.length === 1 ? 'assignment' : 'assignments'}</span>
              </div>
              <ul className="nl-scards">
                {g.items.map((s, i) => <ScenarioCard key={s.id} s={s} no={`${gi + 1}.${i + 1}`} onPick={() => setPicked(s)} />)}
              </ul>
            </section>
          ))}
          {scenarios.length === 0 ? <p className="note">No assignments are installed yet.</p> : null}
          <footer className="nl-home-foot muted">
            NetLab runs locally in your browser. In Guided or Free practice, open Commands → Device support to compare a paper command with the behavior of each virtual device.
          </footer>
        </main>
      </div>

      {picked ? <StartSheet scenario={picked} onClose={() => setPicked(null)} /> : null}
      {toDelete ? (
        <ConfirmDialog
          title="Delete this saved lab?"
          confirmLabel="Delete it"
          danger
          onCancel={() => setToDelete(null)}
          onConfirm={() => { safeCall(() => { lab.deleteSaved(toDelete.id); return true; }, false); setToDelete(null); }}
        >
          <p><strong>{toDelete.title}</strong></p>
          <p>Your cables, configuration and results for this lab will be gone. This cannot be undone.</p>
        </ConfirmDialog>
      ) : null}
      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
