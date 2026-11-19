/** Config file window: edit a router's or switch's configuration as text and apply it through the console connection. */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { ApplyReport } from '../../../engine/labapi.ts';
import { useLab, useLabState } from '../../labContext.tsx';
import { consoleNeededText, useBench } from '../benchContext.ts';
import type { ConfigDraft } from '../benchContext.ts';
import { attempt, copyText, downloadText, errText, inIframe } from '../util.ts';
import { GuideCard } from './TerminalView.tsx';

type Which = 'running' | 'startup';
const WHICH_LABEL: Record<Which, string> = { running: 'Running config', startup: 'Startup config' };
const LINE_H = 22;

type Confirm =
  | { kind: 'replace' }
  | { kind: 'reload' }
  | { kind: 'import'; text: string; name: string; which: Which };

export function ConfigWindow({ deviceId, focusToken }: { deviceId: string; focusToken: number }) {
  const lab = useLab();
  const state = useLabState();
  const bench = useBench();
  const uid = useId();
  const dev = state.world?.devices[deviceId];
  const label = dev?.label ?? deviceId;

  const readDevice = (which: Which): string => {
    try { const t = lab.getConfigText(deviceId, which); return typeof t === 'string' ? t : ''; }
    catch { return ''; }
  };
  // The draft object survives closing the window (it is kept by the workbench).
  const draft = useMemo<ConfigDraft>(() => {
    let d = bench.configDrafts.get(deviceId);
    if (!d) {
      d = { which: 'running', running: { text: '', loaded: null }, startup: { text: '', loaded: null } };
      bench.configDrafts.set(deviceId, d);
    }
    return d;
  }, [bench, deviceId]);

  const [which, setWhichState] = useState<Which>(draft.which);
  const [, bump] = useState(0);
  const [report, setReport] = useState<{ report: ApplyReport; text: string; how: 'merge' | 'replace'; which: Which } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [onlyFailed, setOnlyFailed] = useState(true);
  const [exportBox, setExportBox] = useState<{ name: string; note: string } | null>(null);
  const [flash, setFlash] = useState('');
  const area = useRef<HTMLTextAreaElement | null>(null);
  const gutter = useRef<HTMLDivElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const importRequest = useRef(0);

  const consolePc = attempt(() => lab.consolePcOf(deviceId), null);
  const connected = !!consolePc;
  const pcLabel = consolePc ? state.world?.devices[consolePc]?.label ?? consolePc : '';
  const buf = draft[which];
  const deviceText = useMemo(() => connected ? readDevice(which) : null, [lab, deviceId, which, connected, state.rev]);
  // Keep a clean buffer in sync with terminal saves and edits; never load the disconnected-status comment as config.
  if (deviceText !== null && (buf.text === (buf.loaded ?? '') || buf.text === deviceText)) {
    buf.loaded = deviceText;
    buf.text = deviceText;
  }
  const text = buf.text;
  const dirty = text !== (buf.loaded ?? '');

  const setText = (t: string) => { buf.text = t; setFlash(''); setReport(null); setConfirm(null); bump((n) => n + 1); };
  const setWhich = (w: Which) => { draft.which = w; setWhichState(w); setConfirm(null); setFlash(''); setExportBox(null); };

  useEffect(() => { area.current?.focus({ preventScroll: true }); }, [focusToken]);

  const lineCount = useMemo(() => text.split('\n').length, [text]);
  const numbers = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'), [lineCount]);
  const failedLines = useMemo(() => {
    if (!report || report.which !== which || report.text !== text) return [];
    return (report.report.lines ?? []).filter((l) => l && !l.ok).map((l) => l.lineNo);
  }, [report, which, text]);

  const syncScroll = () => { if (gutter.current && area.current) gutter.current.scrollTop = area.current.scrollTop; };

  const apply = (how: 'merge' | 'replace') => {
    setConfirm(null);
    let r: ApplyReport;
    try {
      const got = lab.applyConfigText(deviceId, text, how);
      r = {
        ok: !!got?.ok, applied: Number(got?.applied) || 0, failed: Number(got?.failed) || 0,
        lines: Array.isArray(got?.lines) ? got.lines : [], blocked: got?.blocked, message: got?.message,
      };
    } catch (e) {
      r = { ok: false, applied: 0, failed: 0, lines: [], message: `The configuration could not be applied: ${errText(e)}` };
    }
    setReport({ report: r, text, how, which });
    setOnlyFailed(r.failed > 0);
  };
  const reload = () => { setConfirm(null); if (!lab.consolePcOf(deviceId)) return; const t = readDevice(which); buf.loaded = t; buf.text = t; setReport(null); bump((n) => n + 1); setFlash(`Loaded the ${WHICH_LABEL[which].toLowerCase()} from ${label}.`); };
  const jumpTo = (lineNo: number) => {
    const el = area.current;
    if (!el) return;
    const lines = text.split('\n');
    let start = 0;
    for (let i = 0; i < lineNo - 1 && i < lines.length; i++) start += lines[i].length + 1;
    const end = start + (lines[lineNo - 1]?.length ?? 0);
    el.focus();
    try { el.setSelectionRange(start, end); } catch { /* ignore */ }
    el.scrollTop = Math.max(0, (lineNo - 4) * LINE_H);
    syncScroll();
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const request = ++importRequest.current;
    const reader = new FileReader();
    reader.onload = () => {
      if (request !== importRequest.current) return;
      const t = String(reader.result ?? '').replace(/\r\n?/g, '\n');
      const target = draft[which];
      if (target.text !== (target.loaded ?? '') || target.text.trim() !== '') setConfirm({ kind: 'import', text: t, name: file.name, which });
      else {
        target.text = t;
        setReport(null);
        setFlash(`Loaded ${file.name} into the ${WHICH_LABEL[which].toLowerCase()} editor. Nothing is sent to ${label} until you apply it.`);
        bump((n) => n + 1);
      }
    };
    reader.onerror = () => { if (request === importRequest.current) setFlash('The file could not be read.'); };
    try { reader.readAsText(file); } catch { setFlash('The file could not be read.'); }
  };
  const doExport = () => {
    const name = `${label}-${which}-config.txt`.replace(/[^\w.-]+/g, '_');
    const ok = downloadText(name, text);
    if (!ok) setExportBox({ name, note: 'The browser did not allow a download here. Copy the text below instead.' });
    else if (inIframe()) setExportBox({ name, note: `Download started: ${name}. If no file was saved, copy the text below.` });
    else setFlash(`Download started: ${name}. No file? Use "Show text to copy".`);
  };

  const rep = report && report.which === which && report.text === text ? report : null;
  const lines = rep?.report.lines ?? [];
  const shownLines = onlyFailed ? lines.filter((l) => l && !l.ok) : lines;

  if (!dev || dev.kind === 'pc') return <div className="wb-pane"><p className="note warn">This device is not on the bench any more.</p></div>;

  return (
    <div className="wb-cfg">
      <div className="wb-cfg-top">
        <div className="wb-tabs" role="tablist" aria-label="Which configuration">
          {(['running', 'startup'] as Which[]).map((w) => (
            <button key={w} type="button" role="tab" aria-selected={which === w} className={`wb-tab${which === w ? ' is-on' : ''}`} onClick={() => setWhich(w)}>
              {WHICH_LABEL[w]}{draft[w].text !== (draft[w].loaded ?? '') ? <span className="wb-tab-count" title="Edited draft">edited</span> : null}
            </button>
          ))}
        </div>
        <div className="wb-cfg-tools">
          <button type="button" className="btn btn-sm" disabled={!connected} onClick={() => (dirty ? setConfirm({ kind: 'reload' }) : reload())} title={`Read the ${WHICH_LABEL[which].toLowerCase()} from ${label} again`}>Read from device</button>
          <button type="button" className="btn btn-sm" onClick={() => fileInput.current?.click()}>Import file…</button>
          <button type="button" className="btn btn-sm" onClick={doExport}>Export…</button>
          <input ref={fileInput} type="file" accept=".txt,.cfg,.conf,.config,text/plain" className="sr-only" tabIndex={-1} aria-label="Choose a configuration file to import" onChange={onFile} />
        </div>
      </div>

      {!connected && (
        <div className="note warn wb-cfg-note" role="status">
          <strong>No console cable to {label}.</strong> <span>{consoleNeededText(label)} Your text stays here.</span>
        </div>
      )}
      {connected && which === 'startup' && deviceText === '' && !dirty && (
        <p className="wb-cfg-hint muted">{label} has no saved startup configuration yet.</p>
      )}

      <p className="wb-cfg-hint muted">
        {which === 'startup' ? 'This tab reads the startup snapshot. Applying or replacing from either tab changes only the running configuration. ' : 'Changes go to the running configuration only. '}
        To keep changes after a restart, save from privileged EXEC with <code>copy running-config startup-config</code> and confirm the destination.
      </p>
      <div className="wb-cfg-main">
        <div className="wb-editor" style={{ ['--wb-line-h' as string]: `${LINE_H}px` }}>
          <div className="wb-editor-gutter" ref={gutter} aria-hidden="true">
            <div className="wb-editor-marks" style={{ height: lineCount * LINE_H }}>
              {failedLines.map((n) => <span key={n} className="wb-editor-mark" style={{ top: (n - 1) * LINE_H }} />)}
            </div>
            <pre className="wb-editor-nums">{numbers}</pre>
          </div>
          <textarea
            ref={area}
            id={`${uid}-editor`}
            className="wb-editor-text"
            value={text}
            wrap="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={`${WHICH_LABEL[which]} of ${label}, editable text`}
            onChange={(e) => setText(e.target.value)}
            onScroll={syncScroll}
          />
        </div>

        {(rep || exportBox) && (
          <aside className="wb-cfg-side" aria-live="polite">
            {exportBox && (
              <div className="wb-cfg-export stack wb-tight">
                <div className="row wb-list-head"><strong>Text to copy</strong><button type="button" className="btn btn-sm" onClick={() => setExportBox(null)}>Close</button></div>
                <p className="muted">{exportBox.note}</p>
                <textarea className="wb-cfg-copy mono" readOnly value={text} onFocus={(e) => e.currentTarget.select()} aria-label="Configuration text to copy" />
                <button type="button" className="btn btn-sm" onClick={async () => setFlash((await copyText(text)) ? 'Copied to the clipboard.' : 'Copying is blocked here. Click in the box and press Ctrl+C.')}>Copy to clipboard</button>
              </div>
            )}
            {rep && (
              <div className="wb-cfg-report stack wb-tight">
                <div className="row wb-list-head">
                  <strong>Result</strong>
                  <button type="button" className="btn btn-sm" onClick={() => setReport(null)}>Close</button>
                </div>
                {rep.report.blocked ? (
                  <GuideCard block={rep.report.blocked} />
                ) : (
                  <div className={`note ${rep.report.failed > 0 || !rep.report.ok ? 'bad' : 'ok'}`}>
                    <strong>
                      {rep.report.failed > 0
                        ? `${rep.report.failed} line${rep.report.failed === 1 ? '' : 's'} failed.`
                        : rep.report.ok ? 'All lines were accepted.' : 'The configuration was not applied.'}
                    </strong>{' '}
                    {rep.report.applied} line{rep.report.applied === 1 ? '' : 's'} applied{rep.how === 'replace' && rep.report.ok ? ' to replace the running configuration' : ''}.
                    {rep.report.message ? <p>{rep.report.message}</p> : null}
                  </div>
                )}
                {lines.length > 0 && (
                  <label className="wb-check">
                    <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} /> Show only failed lines
                  </label>
                )}
                <ol className="wb-cfg-lines">
                  {shownLines.map((l, i) => (
                    <li key={`${l.lineNo}-${i}`} className={l.ok ? 'is-ok' : 'is-bad'}>
                      <button type="button" className="wb-cfg-line" onClick={() => jumpTo(l.lineNo)} title="Show this line in the editor">
                        <span className="wb-cfg-lno">Line {l.lineNo}</span>
                        <span className="wb-cfg-state">{l.ok ? 'ok' : 'failed'}</span>
                        <span className="wb-cfg-ltext mono">{l.line}</span>
                      </button>
                      {l.output ? <pre className="wb-cfg-err mono">{String(l.output).replace(/\n+$/, '')}</pre> : null}
                    </li>
                  ))}
                  {lines.length > 0 && shownLines.length === 0 && <li className="muted">No failed lines.</li>}
                </ol>
              </div>
            )}
          </aside>
        )}
      </div>

      {confirm && (
        <div className="wb-confirm note warn" role="alertdialog" aria-label="Please confirm">
          {confirm.kind === 'replace' && <p><strong>Replace the running configuration of {label}?</strong> If every line is accepted, the current running configuration is replaced by this file. The startup configuration is not changed. Interface blocks without <code>shutdown</code> are treated as enabled.</p>}
          {confirm.kind === 'reload' && <p><strong>Throw away your changes?</strong> The editor text is replaced with the {WHICH_LABEL[which].toLowerCase()} from {label}.</p>}
          {confirm.kind === 'import' && <p><strong>Replace the {WHICH_LABEL[confirm.which].toLowerCase()} editor text with {confirm.name}?</strong> The text you have here now is removed from the editor. {label} is not changed.</p>}
          <div className="row">
            {confirm.kind === 'replace' && <button type="button" className="btn btn-danger" disabled={!connected || !text.trim()} onClick={() => apply('replace')}>Yes, replace running config</button>}
            {confirm.kind === 'reload' && <button type="button" className="btn btn-danger" disabled={!connected} onClick={reload}>Yes, read from device</button>}
            {confirm.kind === 'import' && <button type="button" className="btn btn-danger" onClick={() => { draft[confirm.which].text = confirm.text; setWhich(confirm.which); setReport(null); setFlash(`Loaded ${confirm.name} into the editor. No device settings were changed.`); bump((n) => n + 1); }}>Yes, use the file</button>}
            <button type="button" className="btn" autoFocus onClick={() => setConfirm(null)}>No, keep my text</button>
          </div>
        </div>
      )}

      <div className="wb-cfg-bar">
        <button type="button" className="btn btn-primary" disabled={!connected || text.trim() === ''} onClick={() => apply('merge')} title="Merge these lines into the running configuration">Apply to running config</button>
        <button type="button" className="btn btn-danger" disabled={!connected || !text.trim()} onClick={() => setConfirm({ kind: 'replace' })}>Replace running config…</button>
        <span className="wb-cfg-status muted" role="status">
          {flash || (connected ? `Console connected through ${pcLabel}. ${lineCount} line${lineCount === 1 ? '' : 's'}${dirty ? ', edited' : ''}.` : 'Connect a console cable to apply.')}
        </span>
        {!exportBox && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExportBox({ name: '', note: 'Select the text and copy it.' })}>Show text to copy</button>}
      </div>
    </div>
  );
}
