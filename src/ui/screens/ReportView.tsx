/**
 * Report: full-screen sheet with the score, the 18-point scale, a per-feature summary, one card per requirement
 * (checks, expected/observed, tips, packet traces), order issues, hardware notes and — when available — the model
 * solution next to the student's running configuration. Owned by the app-shell agent.
 */
import { Icon } from '../icons.tsx';
import { useMemo, useState } from 'react';
import type { CheckResult, Feature, GradeReport, RequirementResult, SolutionView } from '../../engine/types.ts';
import { useLab, useLabState } from '../labContext.tsx';
import { CABLE_META } from '../features.ts';
import { ConfirmDialog, FeatureBadge, MODE_META, Modal, Reveal, StatusPill, Tabs, TabPanel } from '../panels/ui.tsx';
import { TraceSteps } from '../panels/TraceView.tsx';
import { fmtPts, reqState, useDeviceLabel } from '../panels/TaskPanel.tsx';
import { safeCall } from '../panels/safe.ts';
import { diffConfigs } from './configDiff.ts';

function kindWords(pct: number, exam: boolean, allScoredPassed: boolean): { head: string; text: string } {
  if (allScoredPassed) return { head: 'All scored requirements passed.', text: 'The simulated network met the checks for this assignment. See the evidence below.' };
  if (pct >= 95) return { head: 'One last check.', text: 'Most checks passed. Open the remaining requirement to see what the lab observed.' };
  if (pct >= 75) return { head: 'Very good.', text: 'Most of the network works. A few details below are worth a second look.' };
  if (pct >= 50) return { head: 'Good progress.', text: 'The base is there. Go through the cards marked “Not yet”, one at a time.' };
  if (pct > 0) return { head: 'A solid start.', text: exam ? 'Many parts are still missing. Look at the first card that is not passed, and start there next time.' : 'Many parts are still missing. That is normal at this stage. Fix one card, then check again.' };
  return { head: 'Nothing passed yet.', text: 'That is fine — the cards below say exactly what was expected. Start with the first one.' };
}

function ScoreHero(props: { report: GradeReport }) {
  const r = props.report;
  const pct = r.maxPoints > 0 ? Math.round((r.points / r.maxPoints) * 100) : 0;
  const scored = r.requirements.filter(x => x.points > 0);
  const passed = scored.filter(x => x.pass).length;
  const words = kindWords(pct, r.mode === 'exam', scored.length > 0 && passed === scored.length);
  return (
    <section className="nl-score" aria-labelledby="score-h">
      <div className="nl-score-ring" style={{ ['--pct' as string]: `${pct}` }} aria-hidden="true">
        <span><b>{pct}</b><small>%</small></span>
      </div>
      <div className="nl-score-text">
        <h2 id="score-h">{words.head}</h2>
        <p className="nl-lead">{words.text}</p>
        <dl className="nl-score-facts">
          <div><dt>Practice score</dt><dd><b>{fmtPts(r.scaled18)}</b> of 18 points</dd></div>
          <div><dt>Lab points</dt><dd><b>{fmtPts(r.points)}</b> of {fmtPts(r.maxPoints)}</dd></div>
          <div><dt>Requirements passed</dt><dd><b>{passed}</b> of {scored.length}</dd></div>
        </dl>
        <p className="muted">NetLab’s weights are for practice, not the instructor’s marking scheme.</p>
        <p className="muted">{r.practiceBasis?.revision === 2 ? `WAN QoS at this check: ${r.practiceBasis.qos === 'course' ? 'Course compatible' : 'After encryption'}.` : 'Historical check: this saved report used an earlier version of NetLab. Its profile and weights may differ.'}</p>
        <p className="sr-only">Score: {pct} percent.</p>
      </div>
    </section>
  );
}

function FeatureSummary(props: { reqs: RequirementResult[] }) {
  const groups = new Map<Feature, { earned: number; points: number; n: number; pass: number }>();
  for (const r of props.reqs) {
    const g = groups.get(r.feature) ?? { earned: 0, points: 0, n: 0, pass: 0 };
    g.earned += r.earned; g.points += r.points; g.n += 1; g.pass += r.pass ? 1 : 0;
    groups.set(r.feature, g);
  }
  return (
    <section aria-labelledby="feat-h">
      <h2 id="feat-h" className="nl-rsec-title">By topic</h2>
      <ul className="nl-featsum">
        {[...groups.entries()].map(([f, g]) => {
          const pct = g.points ? Math.round((g.earned / g.points) * 100) : 0;
          const word = g.pass === g.n ? 'All passed' : g.earned > 0 ? 'Partly' : 'Not yet';
          return (
            <li key={f} className="nl-featsum-item" data-feature={f}>
              <FeatureBadge feature={f} small />
              <span className="nl-featsum-pts">{fmtPts(g.earned)} / {fmtPts(g.points)}</span>
              <span className="nl-featsum-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
              <span className="nl-featsum-word" data-state={g.pass === g.n ? 'pass' : g.earned > 0 ? 'partial' : 'fail'}>{word}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CheckRow(props: { c: CheckResult }) {
  const c = props.c;
  const label = useDeviceLabel();
  return (
    <li className="nl-chk" data-state={c.pass ? 'pass' : 'fail'}>
      <div className="nl-chk-head">
        <StatusPill state={c.pass ? 'pass' : 'fail'} labels={{ pass: 'OK', fail: 'Not yet' }} />
        <span className="nl-chk-label">{c.label}</span>
      </div>
      <dl className="nl-chk-eo">
        <div><dt>Expected</dt><dd>{c.expected}</dd></div>
        <div><dt>What the lab saw</dt><dd>{c.observed}</dd></div>
      </dl>
      {c.tip ? <p className="nl-tip"><Icon name="hint" /> <strong>Tip: </strong>{c.tip}</p> : null}
      {c.trace && c.trace.length ? (
        <Reveal label="Show the packet's path" openLabel="Hide the packet's path" icon="path">
          <TraceSteps steps={c.trace} deviceLabel={label} />
        </Reveal>
      ) : null}
    </li>
  );
}

function RequirementCard(props: { r: RequirementResult }) {
  const r = props.r;
  const st = reqState(r);
  const [open, setOpen] = useState(!r.pass);
  const checks = Array.isArray(r.checks) ? r.checks : [];
  return (
    <li className="nl-rcard" data-state={st} data-feature={r.feature}>
      <button type="button" className="nl-rcard-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="nl-rcard-no" aria-hidden="true">{r.no}</span>
        <span className="nl-rcard-title"><span className="sr-only">Requirement {r.no}: </span>{r.title}</span>
        <span className="nl-rcard-side">
          <FeatureBadge feature={r.feature} small />
          <StatusPill state={st} />
          <span className="nl-rcard-pts">{fmtPts(r.earned)} / {fmtPts(r.points)}</span>
          <span className="nl-rcard-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </span>
      </button>
      {open ? (
        <div className="nl-rcard-body">
          {checks.length === 0 ? <p className="muted">No details for this requirement.</p> : <ul className="nl-chk-list">{checks.map((c) => <CheckRow key={c.id} c={c} />)}</ul>}
        </div>
      ) : null}
    </li>
  );
}

function ConfigCompare(props: { deviceId: string; model: string }) {
  const lab = useLab();
  const state = useLabState();
  const running = useMemo(() => safeCall(() => lab.getConfigText(props.deviceId, 'running'), ''), [lab, props.deviceId, state.rev]);
  const diff = useMemo(() => diffConfigs(props.model, running), [props.model, running]);
  return (
    <div className="stack">
      <p className="nl-diff-sum">
        <span className="nl-diff-key" data-status="missing">− missing</span> {diff.missing} {diff.missing === 1 ? 'line' : 'lines'} from the model are not in your configuration.{' '}
        <span className="nl-diff-key" data-status="extra">+ extra</span> {diff.extra} {diff.extra === 1 ? 'line' : 'lines'} of yours are not in the model.
      </p>
      <p className="muted">This is a text comparison, not a score. Some defaults and boilerplate are hidden. ACL order and interface placement still matter; use the traffic checks above.</p>
      <div className="nl-diff">
        <div className="nl-diff-col">
          <h4>Model configuration</h4>
          <pre className="nl-diff-pre mono" aria-label="Model configuration">
            {diff.model.map((l, i) => (
              <span key={i} className="nl-dl" data-status={l.status}>
                <span className="nl-dl-mark" aria-hidden="true">{l.status === 'missing' ? '−' : ' '}</span>
                {l.text}
                {l.status === 'missing' ? <span className="nl-dl-tag">missing</span> : null}
                {'\n'}
              </span>
            ))}
          </pre>
        </div>
        <div className="nl-diff-col">
          <h4>Your running configuration</h4>
          {running.trim() ? (
            <pre className="nl-diff-pre mono" aria-label="Your running configuration">
              {diff.student.map((l, i) => (
                <span key={i} className="nl-dl" data-status={l.status}>
                  <span className="nl-dl-mark" aria-hidden="true">{l.status === 'extra' ? '+' : ' '}</span>
                  {l.text}
                  {l.status === 'extra' ? <span className="nl-dl-tag">extra</span> : null}
                  {'\n'}
                </span>
              ))}
            </pre>
          ) : <p className="muted">No running configuration is available for this device.</p>}
        </div>
      </div>
    </div>
  );
}

function SolutionSection(props: { sol: SolutionView }) {
  const sol = props.sol;
  const label = useDeviceLabel();
  const portLabel = (d: string, p: string) => `${label(d)} ${p}`;
  const devs = Object.keys(sol.configs ?? {});
  const [dev, setDev] = useState(devs[0] ?? '');
  const pcs = Object.entries(sol.pcs ?? {});
  return (
    <div className="nl-solution">
      <p className="muted">One correct way to do it. Other ways can be right too — the checks test what the network does, not the exact lines.</p>

      {sol.cables && sol.cables.length ? (
        <div className="nl-pcard">
          <h3>Cabling</h3>
          <table className="nl-table">
            <thead><tr><th scope="col">Cable</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Note</th></tr></thead>
            <tbody>
              {sol.cables.map((c, i) => (
                <tr key={i}>
                  <td><span className="nl-cable-swatch" data-cable={c.kind} aria-hidden="true" /> {CABLE_META[c.kind]?.label ?? c.kind}</td>
                  <td className="mono">{portLabel(c.a.deviceId, c.a.port)}{c.dceEnd === 'a' ? ' (DCE)' : ''}</td>
                  <td className="mono">{portLabel(c.b.deviceId, c.b.port)}{c.dceEnd === 'b' ? ' (DCE)' : ''}</td>
                  <td>{c.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Use free ports compatible with the lead and its function. Match the assignment’s logical connections; equivalent compatible ports can work.</p>
        </div>
      ) : null}

      {devs.length ? (
        <div className="nl-pcard">
          <h3>Configuration, side by side</h3>
          {devs.length > 1 ? (
            <Tabs tabs={devs.map((d) => ({ id: d, label: label(d) }))} value={dev} onChange={setDev} label="Device" idBase="soldev" />
          ) : null}
          {dev ? (
            <TabPanel idBase="soldev" id={dev}>
              <ConfigCompare key={dev} deviceId={dev} model={sol.configs[dev] ?? ''} />
            </TabPanel>
          ) : null}
        </div>
      ) : null}

      {pcs.length ? (
        <div className="nl-pcard">
          <h3>PC settings</h3>
          <table className="nl-table">
            <thead><tr><th scope="col">PC</th><th scope="col">Address</th><th scope="col">Mask</th><th scope="col">Gateway</th><th scope="col">Services</th></tr></thead>
            <tbody>
              {pcs.map(([id, p]) => (
                <tr key={id}>
                  <td><b>{label(id)}</b></td>
                  <td className="mono">{p.mode === 'dhcp' ? 'DHCP' : p.address ?? '—'}</td>
                  <td className="mono">{p.mode === 'dhcp' ? '(from DHCP)' : p.mask ?? '—'}</td>
                  <td className="mono">{p.mode === 'dhcp' ? '(from DHCP)' : p.gateway ?? '—'}</td>
                  <td>{Object.entries(p.services ?? {}).filter(([, v]) => v).map(([k]) => k.toUpperCase()).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {sol.notes && sol.notes.length ? (
        <div className="nl-pcard">
          <h3>Notes</h3>
          <ul className="nl-notes">{sol.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}

type Filter = 'all' | 'todo' | 'passed';

export function ReportView(props: { onClose: () => void; onLeft?: () => void }) {
  const lab = useLab();
  const state = useLabState();
  const label = useDeviceLabel();
  const report = state.report;
  const sc = state.scenario;
  const sol = useMemo(() => safeCall<SolutionView | null>(() => lab.solution(), null), [lab, state.rev]);
  const [filter, setFilter] = useState<Filter>('all');
  const [confirm, setConfirm] = useState<null | 'restart' | 'leave'>(null);
  if (!report) return null;
  const entries = Array.isArray(report.requirements) ? report.requirements : [];
  const reqs = entries.filter(r => r.points > 0);
  const advisory = entries.filter(r => r.points === 0);
  const todo = reqs.filter((r) => !r.pass);
  const shown = filter === 'all' ? reqs : filter === 'todo' ? todo : reqs.filter((r) => r.pass);
  const orderIssues = Array.isArray(report.orderIssues) ? report.orderIssues : [];
  const hw = Array.isArray(report.hardwareNotes) ? report.hardwareNotes : [];
  const mode = MODE_META[report.mode] ?? MODE_META.free;

  return (
    <Modal
      title="Your report"
      subtitle={`${sc?.summary.title ?? ''} · ${mode.label}${report.mode === 'exam' ? ' — final grade' : ' — practice check'}`}
      onClose={props.onClose}
      size="full"
      closeLabel="Back to the lab"
      closeOnBackdrop={false}
      className="nl-report"
      footer={
        <>
          <button type="button" className="btn btn-lg" onClick={() => setConfirm('leave')}>Leave the lab</button>
          <button type="button" className="btn btn-lg" onClick={() => setConfirm('restart')}>↺ Start again</button>
          <button type="button" className="btn btn-primary btn-lg" onClick={props.onClose}>Back to the lab</button>
        </>
      }
    >
      <div className="nl-report-inner" tabIndex={-1} data-autofocus>
        <ScoreHero report={report} />
        {report.mode !== 'exam' ? <p className="note">This is a practice check. You can keep working and check again as often as you like.</p> : null}
        <FeatureSummary reqs={reqs} />

        <section aria-labelledby="req-h">
          <div className="nl-rsec-head">
            <h2 id="req-h" className="nl-rsec-title">Requirement by requirement</h2>
            <div className="nl-seg" role="group" aria-label="Show">
              {([['all', `All (${reqs.length})`], ['todo', `Not yet (${todo.length})`], ['passed', `Passed (${reqs.length - todo.length})`]] as [Filter, string][]).map(([id, text]) => (
                <button key={id} type="button" className="nl-seg-btn" aria-pressed={filter === id} onClick={() => setFilter(id)}>{text}</button>
              ))}
            </div>
          </div>
          {shown.length === 0 ? <p className="muted">Nothing to show here.</p> : (
            <ul className="nl-rcards">{shown.map((r) => <RequirementCard key={r.id} r={r} />)}</ul>
          )}
        </section>

        {advisory.length > 0 && <section aria-label="Unscored reminders"><h2 className="nl-rsec-title">Unscored reminders</h2><ul className="nl-notes">{advisory.map(r => <li key={r.id}><b>{r.title}</b> — {r.pass ? 'Done.' : (r.checks.find(c => !c.pass)?.tip ?? 'Check before leaving the bench.')} No points are deducted.</li>)}</ul></section>}
        {orderIssues.length ? (
          <section className="nl-order" aria-labelledby="order-h">
            <h2 id="order-h" className="nl-rsec-title">About the order of your work</h2>
            <p className="muted">These do not cost points. They are habits that help on real equipment.</p>
            <ul className="nl-order-list">
              {orderIssues.map((o, i) => (
                <li key={i} className="nl-order-item" data-severity={o.severity}>
                  <span className="nl-order-kind">{o.severity === 'warn' ? <><Icon name="alert" /> Worth fixing</> : <><Icon name="info" /> Good to know</>}</span>
                  <p>{o.text}</p>
                  {o.deviceId || o.line ? (
                    <p className="muted nl-order-where">
                      {o.deviceId ? <>On <b>{label(o.deviceId)}</b></> : null}
                      {o.line ? <> — <code>{o.line}</code></> : null}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {hw.length ? (
          <section className="nl-hw" aria-labelledby="hw-h">
            <h2 id="hw-h" className="nl-rsec-title">On the real routers, also check…</h2>
            <p className="muted">Advice only — no points. The lab follows the course solution; the real ISR 4331 may differ here.</p>
            <ul className="nl-hw-list">
              {hw.map((h) => (
                <li key={h.id} className="nl-hw-item" data-feature={h.feature}>
                  <div className="row"><FeatureBadge feature={h.feature} small /><strong>{h.title}</strong></div>
                  <p>{h.text}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {sol ? (
          <section className="nl-solution-wrap" aria-label="Model solution">
            <Reveal
              label="Show the model solution"
              openLabel="Hide the model solution"
              icon="book"
              className="nl-solution-reveal"
              defaultOpen={report.mode === 'exam'}
            >
              {report.mode !== 'exam' ? <p className="muted">Tip: try to fix the cards above yourself first. The solution is here when you need it.</p> : null}
              <SolutionSection sol={sol} />
            </Reveal>
          </section>
        ) : report.mode === 'exam' ? null : (
          <p className="muted">The model solution is not available for this lab.</p>
        )}
      </div>

      {confirm === 'restart' ? (
        <ConfirmDialog
          title="Start this lab again?"
          confirmLabel="Yes, start again"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); safeCall(() => { lab.restartScenario(); return true; }, false); props.onClose(); }}
        >
          <p>All cables and configuration are removed. The bench goes back to the start.</p>
        </ConfirmDialog>
      ) : null}
      {confirm === 'leave' ? (
        <ConfirmDialog
          title="Leave the lab?"
          confirmLabel="Leave"
          onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); safeCall(() => { lab.leaveScenario(); return true; }, false); props.onLeft?.(); }}
        >
          <p>{state.storage?.available ? 'Your lab is saved in this browser. You can continue it from the start page.' : 'Saving is switched off in this window. Your lab will be lost unless you export it first (Settings → Export lab).'}</p>
        </ConfirmDialog>
      ) : null}
    </Modal>
  );
}
