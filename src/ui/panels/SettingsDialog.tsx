/** Settings dialog: reading, terminal, bench rules, and saving/importing. Owned by the app-shell agent. */
import { Icon } from '../icons.tsx';
import { useRef, useState } from 'react';
import type { UiSettings } from '../../engine/labapi.ts';
import { useLab, useLabState } from '../labContext.tsx';
import { ExportDialog, Modal } from './ui.tsx';
import { errorText, fileSlug, readFileText, safeCall, todayStamp } from './safe.ts';

const FONTS: { id: UiSettings['font']; label: string; sample: string; family: string }[] = [
  { id: 'lexend', label: 'Lexend', sample: 'Wide letters, easy to track.', family: "'Lexend', system-ui, sans-serif" },
  { id: 'atkinson', label: 'Atkinson Hyperlegible', sample: 'Letters that are hard to mix up: Il1 O0.', family: "'Atkinson Hyperlegible', system-ui, sans-serif" },
  { id: 'system', label: 'System font', sample: 'The normal font of your computer.', family: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
];

function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string; help: string; disabled?: boolean; lockedText?: string }) {
  return (
    <label className={`nl-toggle${props.disabled ? ' is-disabled' : ''}`}>
      <input type="checkbox" role="switch" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="nl-toggle-track" aria-hidden="true"><span className="nl-toggle-knob" /></span>
      <span className="nl-toggle-text">
        <strong>{props.label} <span className="nl-toggle-state">{props.checked ? 'On' : 'Off'}</span></strong>
        <span className="muted">{props.help}</span>
        {props.disabled && props.lockedText ? <span className="nl-locked"><Icon name="lock" /> {props.lockedText}</span> : null}
      </span>
    </label>
  );
}

export function SettingsDialog(props: { onClose: () => void }) {
  const lab = useLab();
  const state = useLabState();
  const s = state.settings;
  const inLab = !!state.scenario;
  const exam = state.scenario?.mode === 'exam';
  const courseQos = s?.qosClassifiesInnerHeader !== false;
  const [exportText, setExportText] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<UiSettings>) => { safeCall(() => { lab.updateSettings(patch); return true; }, false); };

  const doImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await readFileText(file);
      const r = lab.importLab(text);
      setImportMsg({ ok: r.ok, text: r.ok ? (r.message ?? 'The lab is open.') : (r.message ?? 'This is not a lab file.') });
      if (r.ok) props.onClose();
    } catch (e) {
      setImportMsg({ ok: false, text: `Could not read the file: ${errorText(e)}` });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const pct = Math.round((s?.fontScale ?? 1) * 100);
  return (
    <>
      <Modal title="Settings" onClose={props.onClose} size="md" footer={<button type="button" className="btn btn-primary btn-lg" onClick={props.onClose}>Done</button>}>
        <div className="nl-settings">
          <section className="nl-set-sec" aria-labelledby="set-read">
            <h3 id="set-read">Reading</h3>
            <label className="field">
              <span>Text size: <b>{pct} %</b></span>
              <div className="row nl-range-row">
                <button type="button" className="btn btn-sm" onClick={() => set({ fontScale: Math.max(0.85, Math.round(((s?.fontScale ?? 1) - 0.05) * 100) / 100) })} aria-label="Smaller text">A−</button>
                <input type="range" min={0.85} max={1.4} step={0.05} value={s?.fontScale ?? 1} onChange={(e) => set({ fontScale: Number(e.target.value) })} aria-valuetext={`${pct} percent`} data-autofocus />
                <button type="button" className="btn btn-sm" onClick={() => set({ fontScale: Math.min(1.4, Math.round(((s?.fontScale ?? 1) + 0.05) * 100) / 100) })} aria-label="Bigger text">A+</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ fontScale: 1 })}>Reset</button>
              </div>
            </label>
            <fieldset className="nl-fontpick">
              <legend>Font</legend>
              {FONTS.map((f) => (
                <label key={f.id} className={`nl-fontopt${s?.font === f.id ? ' is-on' : ''}`}>
                  <input type="radio" name="font" checked={s?.font === f.id} onChange={() => set({ font: f.id })} />
                  <span style={{ fontFamily: f.family }}>
                    <strong>{f.label}</strong>
                    <span className="muted"> — {f.sample}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <Toggle checked={!!s?.reduceMotion} onChange={(v) => set({ reduceMotion: v })} label="Reduce motion" help="No animations or sliding. Everything appears at once." />
          </section>

          <section className="nl-set-sec" aria-labelledby="set-term">
            <h3 id="set-term">Terminal</h3>
            <label className="field">
              <span>Terminal text size: <b>{s?.terminalFontPx ?? 14} px</b></span>
              <div className="row nl-range-row">
                <input type="range" min={11} max={24} step={1} value={s?.terminalFontPx ?? 14} onChange={(e) => set({ terminalFontPx: Number(e.target.value) })} />
                <code className="nl-term-sample" style={{ fontSize: `${s?.terminalFontPx ?? 14}px` }}>R1(config)#</code>
              </div>
            </label>
            <Toggle checked={!!s?.terminalPaging} onChange={(v) => set({ terminalPaging: v })} label="Pause long output (--More--)" help="Respects this session’s terminal length (24 by default, 0 disables paging). Press Space for the next page." />
          </section>

          <section className="nl-set-sec" aria-labelledby="set-bench">
            <h3 id="set-bench">Bench rules</h3>
            <Toggle
              checked={!!s?.strictCables}
              onChange={(v) => set({ strictCables: v })}
              disabled={exam}
              lockedText="Locked during an exam."
              label="Strict cable rules"
              help="On: the classroom rule requires straight-through for PC/router to switch, and crossover for direct PC-to-router or like ports. Off: compatible copper jacks accept either lead. Neither setting makes a copper plug fit an empty SFP cage."
            />
            <label className="field">
              <span>WAN QoS profile <span className="muted">· {inLab ? 'Active in this lab' : 'Default for new labs'}</span></span>
              <select
                value={courseQos ? 'course' : 'after-encryption'}
                onChange={(e) => set({ qosClassifiesInnerHeader: e.target.value === 'course' })}
                disabled={exam}
                aria-describedby="qos-profile-help"
              >
                <option value="course">Course compatible (default)</option>
                <option value="after-encryption">WAN after encryption (practice)</option>
              </select>
            </label>
            <div id="qos-profile-help" className="muted">
              {exam ? (
                <p className="nl-locked"><Icon name="lock" /> The WAN QoS profile is locked during an exam.</p>
              ) : (
                <>
                  {courseQos ? (
                    <p>The WAN policy can classify the original packet headers even when IPsec protects the traffic. This matches the course exercises.</p>
                  ) : (
                    <p>The WAN policy sees the outer ESP packet instead of the original ports and protocol. Use <code>qos pre-classify</code> on the active crypto-map entries to match the original headers, or match visible outer fields if the task allows it. Matching ESP alone does not distinguish pings from application traffic in the same tunnel.</p>
                  )}
                  <p>{inLab ? 'Changing this updates this lab and the default for new labs. Run Check again for a score under the new profile.' : 'New labs use this choice. Saved labs keep their own profile.'}</p>
                </>
              )}
              <p>These are simulator profiles, not a claim about every ISR or IOS XE release.</p>
            </div>
          </section>

          <section className="nl-set-sec" aria-labelledby="set-save">
            <h3 id="set-save">Save and open</h3>
            <p className={`note ${state.storage?.available ? 'ok' : 'warn'}`}>
              {state.storage?.available
                ? 'Saving works. Your lab is saved in this browser when you leave it.'
                : 'Saving is switched off in this window (the browser blocks storage). Export your lab to keep a copy.'}
            </p>
            <div className="row">
              <button type="button" className="btn" disabled={!inLab} onClick={() => setExportText(safeCall(() => lab.exportLab(), ''))}><Icon name="download" /> Export lab</button>
              <button type="button" className="btn" onClick={() => fileRef.current?.click()}><Icon name="upload" /> Import lab</button>
              <input ref={fileRef} type="file" accept=".json,application/json,text/plain" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => doImport(e.target.files?.[0])} />
            </div>
            {!inLab ? <p className="muted">Export is available while a lab is open.</p> : null}
            {inLab ? <p className="muted">Importing a lab replaces the lab that is open now.</p> : null}
            {importMsg ? <p className={`note ${importMsg.ok ? 'ok' : 'bad'}`} role="status">{importMsg.text}</p> : null}
          </section>
        </div>
      </Modal>
      {exportText !== null ? (
        <ExportDialog
          title="Export lab"
          intro="Save this file somewhere safe. Open it again later with Import lab."
          filename={`kss-netlab-${fileSlug(state.scenario?.summary.title ?? 'lab')}-${todayStamp()}.json`}
          text={exportText || '{}'}
          mime="application/json"
          onClose={() => setExportText(null)}
        />
      ) : null}
    </>
  );
}
