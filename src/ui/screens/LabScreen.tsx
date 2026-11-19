/**
 * Lab screen: slim top bar + collapsible, resizable task panel + the Workbench + one optional side panel
 * (command sheet, tools or my actions). Owned by the app-shell agent.
 */
import { Icon } from '../icons.tsx';
import type { IconName } from '../icons.tsx';
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useLab, useLabState } from '../labContext.tsx';
import { notify } from '../notify.ts';
import { Workbench } from '../bench/Workbench.tsx';
import { ConfirmDialog, ExportDialog, ModeBadge } from '../panels/ui.tsx';
import { TaskPanel } from '../panels/TaskPanel.tsx';
import type { TaskTab } from '../panels/TaskPanel.tsx';
import { CommandSheet } from '../panels/CommandSheet.tsx';
import { Tools } from '../panels/Tools.tsx';
import { Journal } from '../panels/Journal.tsx';
import { SettingsDialog } from '../panels/SettingsDialog.tsx';
import { errorText, fileSlug, formatDuration, safeCall, storageGet, storageSet, todayStamp } from '../panels/safe.ts';
import { ReportView } from './ReportView.tsx';

type Side = 'sheet' | 'tools' | 'journal';
type Dialog = 'settings' | 'leave' | 'finish' | 'export';

const PANEL_KEY = 'kss-netlab-ui-panel';
const MIN_W = 300;
const DEFAULT_W = 420;

function loadPanelPrefs(): { w: number; open: boolean } {
  try {
    const raw = storageGet(PANEL_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { w?: number; open?: boolean };
      return { w: typeof p.w === 'number' ? p.w : DEFAULT_W, open: p.open !== false };
    }
  } catch { /* ignore */ }
  return { w: DEFAULT_W, open: true };
}
function maxPanelW(): number {
  return Math.max(MIN_W, Math.min(720, Math.floor((typeof window !== 'undefined' ? window.innerWidth : 1280) * 0.45)));
}

// ───────────────────────── clock ─────────────────────────

function Clock(props: { startedAt: number; timerMinutes: number | null; finished: boolean }) {
  const countdown = props.timerMinutes !== null && props.timerMinutes > 0;
  const [visible, setVisible] = useState(countdown);
  const [now, setNow] = useState(() => Date.now());
  const warned = useRef<{ soon: boolean; up: boolean }>({ soon: false, up: false });
  useEffect(() => {
    if (props.finished) return;
    // Updates quietly every 15 s; the display only shows minutes, so nothing ticks in front of the user.
    const t = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(t);
  }, [props.finished]);
  const elapsed = Math.max(0, now - (props.startedAt || now));
  const left = countdown ? (props.timerMinutes as number) * 60000 - elapsed : 0;
  useEffect(() => {
    if (!countdown || props.finished) return;
    if (left <= 15 * 60000 && left > 0 && !warned.current.soon && (props.timerMinutes as number) > 20) {
      warned.current.soon = true;
      notify({ kind: 'info', title: '15 minutes left', text: 'Save time for a final check of your work.' });
    }
    if (left <= 0 && !warned.current.up) {
      warned.current.up = true;
      notify({ kind: 'warn', title: 'Time is up', text: 'You can keep working, or finish the exam when you are ready.', ttl: 0 });
    }
  }, [left, countdown, props.finished, props.timerMinutes]);

  if (!visible) {
    return (
      <button type="button" className="btn btn-sm nl-clock-btn" onClick={() => setVisible(true)} title={countdown ? 'Show the time left' : 'Show how long you have worked'}>
        <Icon name="clock" /> Show time
      </button>
    );
  }
  const text = countdown ? (left > 0 ? `${formatDuration(left, true)} left` : 'Time is up') : `${formatDuration(elapsed)}`;
  return (
    <span className="nl-clock" data-state={countdown && left <= 0 ? 'up' : countdown && left <= 15 * 60000 ? 'soon' : 'ok'}>
      <Icon name="clock" />
      <span className="nl-clock-label">{countdown ? 'Exam timer' : 'Working for'}</span>
      <b>{text}</b>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setVisible(false)} aria-label="Hide the time">Hide</button>
    </span>
  );
}

// ───────────────────────── side panel ─────────────────────────

function SidePanel(props: { title: string; icon: IconName; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const auto = el.querySelector<HTMLElement>('[data-autofocus]');
    (auto ?? el.querySelector<HTMLElement>('h2'))?.focus();
  }, [props.title]);
  return (
    <aside
      ref={ref}
      className={`nl-side${props.wide ? ' is-wide' : ''}`}
      aria-label={props.title}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); props.onClose(); } }}
    >
      <div className="nl-side-head">
        <h2 tabIndex={-1}><Icon name={props.icon} /> {props.title}</h2>
        <button type="button" className="btn btn-ghost nl-close" onClick={props.onClose}><Icon name="x" /> Close</button>
      </div>
      <div className="nl-side-body">{props.children}</div>
    </aside>
  );
}

// ───────────────────────── screen ─────────────────────────

export function LabScreen() {
  const lab = useLab();
  const state = useLabState();
  const sc = state.scenario;
  const mode = sc?.mode ?? 'free';
  const exam = mode === 'exam';
  const finished = !!sc?.finished;
  const [side, setSide] = useState<Side | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [exportText, setExportText] = useState('');
  const [reportOpen, setReportOpen] = useState(false);
  const prefs = useRef(loadPanelPrefs());
  const [panelOpen, setPanelOpen] = useState(prefs.current.open);
  const [panelW, setPanelW] = useState(() => Math.min(maxPanelW(), Math.max(MIN_W, prefs.current.w)));
  const [tab, setTab] = useState<TaskTab>(mode === 'guided' ? 'steps' : 'assignment');
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => { storageSet(PANEL_KEY, JSON.stringify({ w: panelW, open: panelOpen })); }, [panelW, panelOpen]);
  useEffect(() => {
    const onResize = () => setPanelW((w) => Math.min(maxPanelW(), w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // In exam mode the tools are not available.
  useEffect(() => { if (exam && side === 'tools') setSide(null); }, [exam, side]);

  // Tell the student when a guided step is finished (once per step).
  const activeId = sc?.guide?.find((g) => g.status === 'active')?.id ?? null;
  const prevActive = useRef<string | null>(activeId);
  useEffect(() => {
    const prev = prevActive.current;
    prevActive.current = activeId;
    if (!sc || mode === 'exam' || !prev || prev === activeId) return;
    const was = sc.guide.find((g) => g.id === prev);
    if (was?.status !== 'done') return;
    const next = sc.guide.find((g) => g.id === activeId);
    notify({ kind: 'ok', title: `Step ${was.no} done: ${was.title}`, text: next ? `Next: step ${next.no}, ${next.title}.` : 'That was the last step. Press Check for your full result.' });
  }, [activeId, sc, mode]);

  if (!sc) return null;

  const check = () => {
    try {
      lab.check();
      setReportOpen(true);
    } catch (e) {
      notify({ kind: 'bad', title: 'The check did not work', text: errorText(e) });
    }
  };
  const finishExam = () => {
    setDialog(null);
    try {
      lab.finishExam();
      setReportOpen(true);
    } catch (e) {
      notify({ kind: 'bad', title: 'Could not finish the exam', text: errorText(e) });
    }
  };
  const toggleSide = (s: Side) => setSide((cur) => (cur === s ? null : s));

  const onResizerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  };
  const onResizerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const left = bodyRef.current?.getBoundingClientRect().left ?? 0;
    setPanelW(Math.min(maxPanelW(), Math.max(MIN_W, Math.round(e.clientX - left))));
  };
  const onResizerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const sideTitle: Record<Side, { title: string; icon: IconName }> = {
    sheet: { title: 'Command sheet', icon: 'book' },
    tools: { title: 'Tools', icon: 'tools' },
    journal: { title: 'My actions', icon: 'history' },
  };

  return (
    <div className={`nl-lab${side ? ' has-side' : ''}`}>
      <header className="nl-topbar">
        <div className="nl-top-left">
          <span className="nl-brand-mark nl-brand-sm" aria-hidden="true"><Icon name="network" /></span>
          <h1 className="nl-top-title" title={sc.summary.title}>{sc.summary.title}</h1>
          <ModeBadge mode={mode} />
          {finished ? <span className="nl-pill" data-state="pass"><Icon name="check" /> Exam finished</span> : null}
        </div>
        <div className="nl-top-mid">
          {!finished ? <Clock startedAt={sc.startedAt} timerMinutes={sc.timerMinutes} finished={finished} /> : null}
        </div>
        <nav className="nl-top-actions" aria-label="Lab tools">
          <button type="button" className="btn nl-tbtn" aria-pressed={side === 'sheet'} onClick={() => toggleSide('sheet')}><span aria-hidden="true"><Icon name="book" /></span> Commands</button>
          {!exam ? (
            <button type="button" className="btn nl-tbtn" aria-pressed={side === 'tools'} onClick={() => toggleSide('tools')}><span aria-hidden="true"><Icon name="tools" /></span> Tools</button>
          ) : null}
          <button type="button" className="btn nl-tbtn" aria-pressed={side === 'journal'} onClick={() => toggleSide('journal')}><span aria-hidden="true"><Icon name="history" /></span> My actions</button>
          {state.report ? (
            <button type="button" className="btn nl-tbtn" onClick={() => setReportOpen(true)}><span aria-hidden="true"><Icon name="report" /></span> Report</button>
          ) : null}
          {exam ? (
            !finished ? <button type="button" className="btn btn-primary nl-tbtn" onClick={() => setDialog('finish')}><span aria-hidden="true"><Icon name="flag" /></span> Finish exam</button> : null
          ) : (
            <button type="button" className="btn btn-primary nl-tbtn" onClick={check}><span aria-hidden="true"><Icon name="check" /></span> Check</button>
          )}
          <button type="button" className="btn nl-tbtn" onClick={() => setDialog('settings')}><span aria-hidden="true"><Icon name="settings" /></span> Settings</button>
          <button type="button" className="btn nl-tbtn" onClick={() => setDialog('leave')}><span aria-hidden="true"><Icon name="exit" /></span> Leave</button>
        </nav>
      </header>

      <div className="nl-lab-body" ref={bodyRef}>
        {panelOpen ? (
          <>
            <section className="nl-task" style={{ width: panelW }} aria-label="Task">
              <TaskPanel tab={tab} onTab={setTab} onCollapse={() => setPanelOpen(false)} onCheck={check} onOpenReport={() => setReportOpen(true)} />
            </section>
            <div
              className="nl-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the task panel"
              aria-valuemin={MIN_W}
              aria-valuemax={maxPanelW()}
              aria-valuenow={panelW}
              tabIndex={0}
              onPointerDown={onResizerDown}
              onPointerMove={onResizerMove}
              onPointerUp={onResizerUp}
              onPointerCancel={onResizerUp}
              onDoubleClick={() => setPanelW(Math.min(maxPanelW(), DEFAULT_W))}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') { e.preventDefault(); setPanelW((w) => Math.max(MIN_W, w - 32)); }
                else if (e.key === 'ArrowRight') { e.preventDefault(); setPanelW((w) => Math.min(maxPanelW(), w + 32)); }
                else if (e.key === 'Home') { e.preventDefault(); setPanelW(MIN_W); }
                else if (e.key === 'End') { e.preventDefault(); setPanelW(maxPanelW()); }
              }}
              title="Drag to resize. Double-click for the normal width."
            >
              <span className="nl-resizer-grip" aria-hidden="true" />
            </div>
          </>
        ) : (
          <nav className="nl-rail" aria-label="Task panel (hidden)">
            <button type="button" className="nl-rail-btn is-main" onClick={() => setPanelOpen(true)} aria-label="Show the task panel">
              <span aria-hidden="true"><Icon name="arrowRight" /></span><span>Show</span>
            </button>
            <button type="button" className="nl-rail-btn" onClick={() => { setTab('assignment'); setPanelOpen(true); }}><span aria-hidden="true"><Icon name="doc" /></span><span>Task</span></button>
            {!exam && sc.guide.length ? (
              <button type="button" className="nl-rail-btn" onClick={() => { setTab('steps'); setPanelOpen(true); }}><span aria-hidden="true"><Icon name="steps" /></span><span>Steps</span></button>
            ) : null}
            <button type="button" className="nl-rail-btn" onClick={() => { setTab('checklist'); setPanelOpen(true); }}><span aria-hidden="true"><Icon name="checklist" /></span><span>Checks</span></button>
          </nav>
        )}

        <main className="nl-bench" aria-label="Lab bench">
          <Workbench />
        </main>

        {side ? (
          <SidePanel title={sideTitle[side].title} icon={sideTitle[side].icon} onClose={() => setSide(null)} wide={side === 'tools'}>
            {side === 'sheet' ? <CommandSheet mode={mode} /> : side === 'tools' ? <Tools /> : <Journal />}
          </SidePanel>
        ) : null}
      </div>

      {reportOpen && state.report ? <ReportView onClose={() => setReportOpen(false)} /> : null}
      {dialog === 'settings' ? <SettingsDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'finish' ? (
        <ConfirmDialog
          title="Finish the exam?"
          confirmLabel="Yes, finish and grade"
          cancelLabel="Not yet"
          onCancel={() => setDialog(null)}
          onConfirm={finishExam}
        >
          <p>The lab grades your network as it is now.</p>
          <p>After this you can look at the results and the model solution, but the grade will not change.</p>
        </ConfirmDialog>
      ) : null}
      {dialog === 'leave' ? (
        <ConfirmDialog
          title="Leave the lab?"
          confirmLabel="Leave"
          cancelLabel="Stay"
          onCancel={() => setDialog(null)}
          onConfirm={() => { setDialog(null); safeCall(() => { lab.leaveScenario(); return true; }, false); }}
          extra={!state.storage?.available ? (
            <button type="button" className="btn btn-lg" onClick={() => { setExportText(safeCall(() => lab.exportLab(), '')); setDialog('export'); }}><Icon name="download" /> Export first</button>
          ) : undefined}
        >
          {state.storage?.available
            ? <p>Your lab is saved in this browser. You can continue it later from the start page.</p>
            : <p><strong>Saving is switched off in this window.</strong> If you leave now, this lab is lost. Export it first to keep a copy.</p>}
        </ConfirmDialog>
      ) : null}
      {dialog === 'export' ? (
        <ExportDialog
          title="Export lab"
          intro="Save this file. You can open it again with Open a lab file on the start page."
          filename={`kss-netlab-${fileSlug(sc.summary.title)}-${todayStamp()}.json`}
          text={exportText || '{}'}
          mime="application/json"
          onClose={() => setDialog('leave')}
        />
      ) : null}
    </div>
  );
}
