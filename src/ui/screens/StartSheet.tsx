/** Start sheet: choose the mode (with a plain explanation), optional exam timer, new variation. Owned by the app-shell agent. */
import { Icon } from '../icons.tsx';
import { useState } from 'react';
import type { LabMode, ScenarioSummary } from '../../engine/types.ts';
import { useLab } from '../labContext.tsx';
import { FeatureBadge, MODE_META, Modal } from '../panels/ui.tsx';
import { errorText } from '../panels/safe.ts';
import { FAMILY_META, LevelText } from './common.tsx';

const MODE_TEXT: Record<LabMode, { lead: string; points: string[] }> = {
  guided: {
    lead: 'One step at a time. If you do something that belongs to a later step, the lab stops you and explains why.',
    points: ['Hints and example commands', 'Check whenever you like', 'Best for learning a new topic'],
  },
  free: {
    lead: 'Work in any order. Check whenever you like. Hints and tools are there when you want them.',
    points: ['Packet walkthrough and QoS test', 'Hints on request', 'Best for practice'],
  },
  exam: {
    lead: 'Like the real test. No hints and no tools. You get your grade at the end.',
    points: ['Order mistakes are only reported', 'Optional timer', 'Best when you feel ready'],
  },
};

export function StartSheet(props: { scenario: ScenarioSummary; onClose: () => void }) {
  const lab = useLab();
  const s = props.scenario;
  const [mode, setMode] = useState<LabMode>(s.family === 'mock' ? 'exam' : 'guided');
  const [timerOn, setTimerOn] = useState(true);
  const [minutes, setMinutes] = useState<number>(180);
  const [seed, setSeed] = useState<number | null>(null);
  const [error, setError] = useState('');

  const start = () => {
    setError('');
    try {
      const mins = Math.min(600, Math.max(5, Math.round(minutes || 180)));
      const r = lab.startScenario(s.id, mode, {
        seed: s.seedable && seed !== null ? seed : undefined,
        timerMinutes: mode === 'exam' && timerOn ? mins : null,
      });
      if (!r.ok) setError(r.message ?? 'The lab could not start.');
      // On success the app switches to the lab screen by itself; this sheet unmounts with the home screen.
    } catch (e) {
      setError(`The lab could not start: ${errorText(e)}`);
    }
  };

  const fam = FAMILY_META[s.family];
  return (
    <Modal
      title={s.title}
      subtitle={<span>{fam ? <Icon name={fam.icon} /> : null} {fam?.title}</span>}
      onClose={props.onClose}
      size="lg"
      closeLabel="Back"
      footer={
        <>
          <button type="button" className="btn btn-lg" onClick={props.onClose}>Back</button>
          <button type="button" className="btn btn-primary btn-lg" onClick={start}>
            Start in {MODE_META[mode].label} mode →
          </button>
        </>
      }
    >
      <div className="stack nl-start">
        <p className="nl-lead">{s.blurb}</p>
        <div className="row">
          <span className="muted"><Icon name="clock" /> about {s.minutes} min</span>
          <LevelText level={s.level} />
        </div>
        <div className="row nl-start-badges">
          {s.features.map((f) => <FeatureBadge key={f} feature={f} small />)}
        </div>

        <fieldset className="nl-modes">
          <legend><h3>How do you want to work?</h3></legend>
          <div className="nl-mode-grid">
            {(['guided', 'free', 'exam'] as LabMode[]).map((m, i) => (
              <label key={m} className={`nl-mode-card${mode === m ? ' is-on' : ''}`} data-mode={m}>
                <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} data-autofocus={i === 0 ? true : undefined} />
                <span className="nl-mode-name"><Icon name={MODE_META[m].icon} /> {MODE_META[m].label}</span>
                <span className="nl-mode-lead">{MODE_TEXT[m].lead}</span>
                <ul className="nl-mode-points">
                  {MODE_TEXT[m].points.map((p) => <li key={p}>{p}</li>)}
                </ul>
                {mode === m ? <span className="nl-mode-chosen"><Icon name="check" /> Chosen</span> : null}
              </label>
            ))}
          </div>
        </fieldset>

        {mode === 'exam' ? (
          <div className="card nl-start-opt">
            <label className="nl-check">
              <input type="checkbox" checked={timerOn} onChange={(e) => setTimerOn(e.target.checked)} />
              <span><strong>Use a timer</strong> — the real test takes about 3 hours.</span>
            </label>
            {timerOn ? (
              <div className="row nl-start-timer">
                <label className="field">
                  Minutes
                  <input type="number" min={5} max={600} step={5} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} style={{ width: 120 }} />
                </label>
                <p className="muted nl-start-timer-note">The timer only shows the time. When it reaches zero you get a message, and you decide when to finish.</p>
              </div>
            ) : (
              <p className="muted">No timer. Take as long as you need.</p>
            )}
          </div>
        ) : null}

        {s.seedable ? (
          <div className="card nl-start-opt">
            <strong>Numbers</strong>
            <p className="muted">This assignment can make new addresses and rules, so you practise the method and not the numbers.</p>
            <div className="row">
              <button type="button" className="btn" onClick={() => setSeed(1 + Math.floor(Math.random() * 99998))}><Icon name="shuffle" /> New variation</button>
              {seed !== null ? (
                <>
                  <span className="badge nl-seed">Variation #{seed}</span>
                  <button type="button" className="btn btn-ghost" onClick={() => setSeed(null)}>Use the standard numbers</button>
                </>
              ) : (
                <span className="muted">Standard numbers (as on the sheet).</span>
              )}
            </div>
          </div>
        ) : null}

        {error ? <p className="note bad" role="alert">{error}</p> : null}
      </div>
    </Modal>
  );
}
