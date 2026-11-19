/** Left task panel: Assignment, Steps (guided/free) and Checklist tabs. Owned by the app-shell agent. */
import { Icon } from '../icons.tsx';
import { useMemo, useState } from 'react';
import type { BriefItem, GuideStep, RequirementResult } from '../../engine/types.ts';
import type { ScenarioView } from '../../engine/labapi.ts';
import { useLab, useLabState } from '../labContext.tsx';
import { CopyButton, FeatureBadge, Modal, Reveal, StatusPill, TabPanel, Tabs } from './ui.tsx';
import type { PassState, TabDef } from './ui.tsx';
import { Diagram, DiagramList } from './Diagram.tsx';
import { safeCall } from './safe.ts';

export type TaskTab = 'assignment' | 'steps' | 'checklist';

export function useDeviceLabel(): (id: string) => string {
  const state = useLabState();
  const world = state.world;
  return (id: string) => world?.devices?.[id]?.label ?? id;
}

export function reqState(r: RequirementResult | undefined): PassState {
  if (!r) return 'none';
  if (r.pass) return 'pass';
  return r.earned > 0 ? 'partial' : 'fail';
}

function fmtPts(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
export { fmtPts };

// ───────────────────────── Assignment ─────────────────────────

function TaskItem(props: { item: BriefItem }) {
  const it = props.item;
  return (
    <li className={`nl-task-item${it.optional ? ' is-optional' : ''}`} data-feature={it.feature}>
      <span className="nl-task-no" aria-hidden="true">{it.no}</span>
      <div className="nl-task-body">
        <div className="row nl-task-badges">
          <span className="sr-only">Task {it.no}.</span>
          <FeatureBadge feature={it.feature} small />
          {it.optional ? <span className="badge nl-optional">Optional · not graded</span> : null}
        </div>
        <p className="nl-task-text">{it.text}</p>
        {it.subItems && it.subItems.length ? (
          <ul className="nl-task-sub">{it.subItems.map((s, i) => <li key={i}>{s}</li>)}</ul>
        ) : null}
      </div>
    </li>
  );
}

function AssignmentTab(props: { sc: ScenarioView }) {
  const brief = props.sc.brief ?? { intro: '', items: [] };
  const items = Array.isArray(brief.items) ? brief.items : [];
  const [big, setBig] = useState(false);
  const [focus, setFocus] = useState(false);
  const [idx, setIdx] = useState(0);
  const cur = Math.min(idx, Math.max(0, items.length - 1));
  return (
    <div className="nl-assign stack">
      {brief.intro ? <p className="nl-intro">{brief.intro}</p> : null}

      <section className="nl-pcard" aria-labelledby="topo-h">
        <div className="nl-pcard-head">
          <h3 id="topo-h">Topology</h3>
          <button type="button" className="btn btn-sm" onClick={() => setBig(true)}><Icon name="expand" /> Bigger</button>
        </div>
        <Diagram spec={props.sc.diagram} title={`Topology for ${props.sc.summary.title}`} onEnlarge={() => setBig(true)} />
        <Reveal label="Show the links as a list" openLabel="Hide the list">
          <DiagramList spec={props.sc.diagram} />
        </Reveal>
      </section>

      {brief.given && brief.given.length ? (
        <section className="nl-pcard" aria-labelledby="given-h">
          <h3 id="given-h">Given values</h3>
          <dl className="nl-given">
            {brief.given.map((g, i) => (
              <div key={i} className="nl-given-row">
                <dt>{g.label}</dt>
                <dd className="mono">{g.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <section aria-labelledby="tasks-h">
        <div className="nl-pcard-head">
          <h3 id="tasks-h">Tasks <span className="muted">({items.length})</span></h3>
          {items.length > 1 ? (
            <label className="nl-check nl-check-sm">
              <input type="checkbox" checked={focus} onChange={(e) => setFocus(e.target.checked)} />
              <span>One at a time</span>
            </label>
          ) : null}
        </div>
        {items.length === 0 ? <p className="muted">This assignment has no task list.</p> : focus ? (
          <div className="stack">
            <ol className="nl-task-list"><TaskItem item={items[cur]} /></ol>
            <div className="row nl-focus-nav">
              <button type="button" className="btn" disabled={cur === 0} onClick={() => setIdx(cur - 1)}>← Previous</button>
              <span className="muted">Task {cur + 1} of {items.length}</span>
              <button type="button" className="btn" disabled={cur >= items.length - 1} onClick={() => setIdx(cur + 1)}>Next →</button>
            </div>
          </div>
        ) : (
          <ol className="nl-task-list">{items.map((it, i) => <TaskItem key={`${it.no}-${i}`} item={it} />)}</ol>
        )}
      </section>

      {big ? (
        <Modal title="Topology" onClose={() => setBig(false)} size="lg">
          <Diagram spec={props.sc.diagram} large title={`Topology for ${props.sc.summary.title}`} />
          <DiagramList spec={props.sc.diagram} />
        </Modal>
      ) : null}
    </div>
  );
}

// ───────────────────────── Steps ─────────────────────────

type StepWithStatus = GuideStep & { status: 'done' | 'active' | 'locked' };

function ActiveStep(props: { step: StepWithStatus; total: number; mode: ScenarioView['mode']; isCurrent: boolean; onBack?: () => void }) {
  const lab = useLab();
  const label = useDeviceLabel();
  const s = props.step;
  const hint = () => safeCall(() => { lab.noteHintUsed(s.id); return true; }, false);
  return (
    <article className="nl-step-active" data-feature={s.feature} aria-labelledby={`step-${s.id}-t`}>
      <div className="row nl-step-meta">
        <span className="nl-step-count">Step {s.no} of {props.total}</span>
        <FeatureBadge feature={s.feature} small />
        {s.status === 'done' ? <StatusPill state="pass" labels={{ pass: 'Done' }} /> : null}
        {s.status === 'locked' ? <span className="nl-pill" data-state="none">{props.mode === 'guided' ? <><Icon name="lock" /> Later</> : 'Not done yet'}</span> : null}
      </div>
      <h3 id={`step-${s.id}-t`} className="nl-step-title">{s.title}</h3>
      <p className="nl-step-goal">{s.goal}</p>
      {s.why ? <p className="nl-step-why"><strong>Why: </strong>{s.why}</p> : null}
      {s.devices && s.devices.length ? (
        <div className="row nl-step-devs">
          <span className="muted">Work on:</span>
          {s.devices.map((d) => <span key={d} className="nl-devchip">{label(d)}</span>)}
        </div>
      ) : null}
      {s.hint ? (
        <Reveal label="Show a hint" openLabel="Hide the hint" icon="hint" onFirstOpen={hint}>
          <p>{s.hint}</p>
        </Reveal>
      ) : null}
      {s.example ? (
        <Reveal label="Show example commands" openLabel="Hide the example" icon="terminal" onFirstOpen={hint}>
          <div className="nl-example">
            <pre className="mono">{s.example}</pre>
            <CopyButton text={s.example} label="Copy example" />
          </div>
          <p className="muted nl-example-note">The example uses the numbers from the sheet. Check them against your own plan.</p>
        </Reveal>
      ) : null}
      {!props.isCurrent && props.onBack ? (
        <button type="button" className="btn" onClick={props.onBack}>← Back to the current step</button>
      ) : null}
    </article>
  );
}

function StepsTab(props: { sc: ScenarioView; onCheck: () => void }) {
  const guide = (Array.isArray(props.sc.guide) ? props.sc.guide : []) as StepWithStatus[];
  const mode = props.sc.mode;
  const active = guide.find((g) => g.status === 'active');
  const [openId, setOpenId] = useState<string | null>(null);
  const shownId = openId ?? active?.id ?? guide[0]?.id ?? null;
  const done = guide.filter((g) => g.status === 'done').length;
  if (guide.length === 0) return <p className="muted">This assignment has no steps.</p>;
  const allDone = done === guide.length;
  return (
    <div className="nl-steps stack">
      <div className="nl-progress">
        <div className="nl-progress-text"><strong>{done} of {guide.length}</strong> steps done</div>
        <div className="nl-progress-bar" aria-hidden="true">
          {guide.map((g) => <span key={g.id} data-status={g.status} />)}
        </div>
        {props.sc.hintsUsed > 0 ? <p className="muted nl-hints-used">Hints used: {props.sc.hintsUsed}</p> : null}
      </div>
      {allDone ? <p className="note ok"><strong>All steps are done.</strong> Press Check to see your full result.</p> : null}
      <ol className="nl-step-list">
        {guide.map((g) => {
          const canOpen = mode !== 'guided' || g.status !== 'locked';
          if (g.id === shownId) {
            return (
              <li key={g.id} className="nl-step-li is-open">
                <ActiveStep step={g} total={guide.length} mode={mode} isCurrent={g.id === (active?.id ?? null) || !active} onBack={active ? () => setOpenId(null) : undefined} />
              </li>
            );
          }
          return (
            <li key={g.id} className="nl-step-li" data-status={g.status}>
              <button
                type="button"
                className="nl-step-row"
                data-feature={g.feature}
                disabled={!canOpen}
                onClick={() => setOpenId(g.id)}
                aria-label={`Step ${g.no}: ${g.title}. ${g.status === 'done' ? 'Done' : g.status === 'active' ? 'Current step' : mode === 'guided' ? 'Locked, comes later' : 'Not done yet'}.`}
              >
                <span className="nl-step-no" aria-hidden="true">{g.status === 'done' ? '✓' : g.status === 'locked' && mode === 'guided' ? <Icon name="lock" /> : g.no}</span>
                <span className="nl-step-rtitle">{g.title}</span>
                <span className="nl-step-rstate">{g.status === 'done' ? 'Done' : g.status === 'active' ? 'Now' : mode === 'guided' ? 'Later' : 'Open'}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="nl-step-checkbar">
        <p className="muted">Think the step is finished? Press Check. The lab tests it and tells you what to fix.</p>
        <button type="button" className="btn btn-primary" onClick={props.onCheck}><Icon name="check" /> Check now</button>
      </div>
    </div>
  );
}

// ───────────────────────── Checklist ─────────────────────────

function ChecklistTab(props: { sc: ScenarioView; onCheck: () => void; onOpenReport: () => void }) {
  const state = useLabState();
  const report = state.report;
  const exam = props.sc.mode === 'exam';
  const reqs = Array.isArray(props.sc.requirements) ? props.sc.requirements : [];
  const byId = useMemo(() => new Map((report?.requirements ?? []).map((r) => [r.id, r])), [report]);
  const total = reqs.reduce((s, r) => s + (r.points || 0), 0);
  return (
    <div className="nl-checklist stack">
      {report ? (
        <div className="nl-check-summary">
          <p><strong>{exam ? 'Final grade' : 'Last check'}: {fmtPts(report.points)} of {fmtPts(report.maxPoints)} practice points</strong> <span className="muted">({fmtPts(report.scaled18)} / 18 normalized)</span></p>
          <div className="row">
            <button type="button" className="btn" onClick={props.onOpenReport}><Icon name="report" /> Open the full report</button>
            {!exam ? <button type="button" className="btn" onClick={props.onCheck}><Icon name="check" /> Check again</button> : null}
          </div>
        </div>
      ) : (
        <div className="nl-check-summary">
          <p>
            {exam
              ? <>These are the graded parts. You see the results when you finish the exam.</>
              : <>Nothing checked yet. Press Check to test your network against this list.</>}
          </p>
          {!exam ? <button type="button" className="btn btn-primary" onClick={props.onCheck}><Icon name="check" /> Check now</button> : null}
          <p className="muted">Total: {fmtPts(total)} points.</p>
        </div>
      )}
      <ul className="nl-req-list">
        {reqs.map((r) => {
          const res = byId.get(r.id);
          const st = reqState(res);
          return (
            <li key={r.id} className="nl-req" data-state={st} data-feature={r.feature}>
              <span className="nl-req-no" aria-hidden="true">{r.no}</span>
              <div className="nl-req-main">
                <span className="nl-req-title"><span className="sr-only">Requirement {r.no}: </span>{r.title}</span>
                <span className="row nl-req-meta">
                  <FeatureBadge feature={r.feature} small />
                  <span className="nl-req-pts">{r.points === 0 ? 'Advisory · not scored' : `${res ? `${fmtPts(res.earned)} / ` : ''}${fmtPts(r.points)} ${r.points === 1 ? 'point' : 'points'}`}</span>
                  {res ? <StatusPill state={st} /> : null}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ───────────────────────── panel ─────────────────────────

export function TaskPanel(props: { tab: TaskTab; onTab: (t: TaskTab) => void; onCollapse: () => void; onCheck: () => void; onOpenReport: () => void }) {
  const state = useLabState();
  const sc = state.scenario;
  if (!sc) return null;
  const hasSteps = sc.mode !== 'exam' && Array.isArray(sc.guide) && sc.guide.length > 0;
  const done = hasSteps ? sc.guide.filter((g) => g.status === 'done').length : 0;
  const tabs: TabDef<TaskTab>[] = [
    { id: 'assignment', label: 'Assignment', icon: 'doc' },
    ...(hasSteps ? [{ id: 'steps' as const, label: 'Steps', icon: 'steps' as const, count: `${done}/${sc.guide.length}` }] : []),
    { id: 'checklist', label: 'Checklist', icon: 'checklist' },
  ];
  const tab = tabs.some((t) => t.id === props.tab) ? props.tab : 'assignment';
  return (
    <div className="nl-taskpanel">
      <div className="nl-taskpanel-head">
        <Tabs tabs={tabs} value={tab} onChange={props.onTab} label="Task panel" idBase="task" />
        <button type="button" className="btn btn-ghost btn-sm nl-collapse" onClick={props.onCollapse} aria-label="Hide the task panel">◀ Hide</button>
      </div>
      <TabPanel idBase="task" id={tab} className="nl-taskpanel-body">
        {tab === 'assignment' ? <AssignmentTab sc={sc} /> : null}
        {tab === 'steps' ? <StepsTab sc={sc} onCheck={props.onCheck} /> : null}
        {tab === 'checklist' ? <ChecklistTab sc={sc} onCheck={props.onCheck} onOpenReport={props.onOpenReport} /> : null}
      </TabPanel>
    </div>
  );
}
