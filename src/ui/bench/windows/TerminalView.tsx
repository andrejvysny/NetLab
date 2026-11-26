/** The terminal screen: scrollback + inline input line. All behaviour lives in TermModel; this file is keys and pixels. */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type React from 'react';
import type { GuideBlock } from '../../../engine/labapi.ts';
import { useLab, useLabState } from '../../labContext.tsx';
import { clamp, copyText, hasTextSelection } from '../util.ts';
import type { TermChunk, TermItem, TermModel } from './termModel.ts';

export function GuideCard({ block, line, dark }: { block: GuideBlock; line?: string; dark?: boolean }) {
  const stepNo = block?.stepNo;
  return (
    <div className={`wb-guide${dark ? ' wb-guide--in-term' : ''}`} role="note" aria-label="Message from the guide">
      <div className="wb-guide-head">
        <span className="wb-guide-tag">Guide</span>
        <span className="wb-guide-step">
          {stepNo != null ? `Step ${stepNo}` : 'Current step'}{block?.stepTitle ? `: ${block.stepTitle}` : ''}
        </span>
      </div>
      <p className="wb-guide-text">{block?.reason || 'This action belongs to another step.'}</p>
      {line ? <p className="wb-guide-foot">Not sent to the device: <span className="wb-guide-line">{line}</span></p> : null}
    </div>
  );
}

function ItemView({ item }: { item: TermItem }) {
  switch (item.t) {
    case 'out': return <div className="wb-tl">{item.text || '\u200b'}</div>;
    case 'sys': return <div className="wb-tl wb-tl--sys">{item.text || '\u200b'}</div>;
    case 'note': return <div className="wb-tl wb-tl--note"><span className="wb-tl-tag">Simulator note</span> {item.text}</div>;
    case 'guide': return <GuideCard block={item.block} line={item.line} dark />;
  }
}
const ChunkView = memo(function ChunkView({ chunk }: { chunk: TermChunk }) {
  return <div className="wb-tchunk">{chunk.items.map((it) => <ItemView key={it.id} item={it} />)}</div>;
});

export interface TerminalViewProps {
  model: TermModel;
  /** 'ios' = PuTTY-like console, 'cmd' = PC command prompt. */
  variant?: 'ios' | 'cmd';
  /** Changes when the surrounding window is activated: the terminal takes the keyboard. */
  focusToken?: number;
  /** False while the terminal sits in a hidden tab. */
  visible?: boolean;
  /** Console only: open the console session again. */
  onReopen?: () => void;
  label: string;
}

export function TerminalView({ model, variant = 'ios', focusToken, visible = true, onReopen, label }: TerminalViewProps) {
  const lab = useLab();
  const state = useLabState();
  const version = useSyncExternalStore(model.subscribe, model.getVersion, model.getVersion);
  const scroller = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  /** True while a key handled by the terminal is being processed: the input's own caret report is stale then. */
  const selfMoved = useRef(false);

  const settingsPx = Number(state.settings?.terminalFontPx);
  const fontPx = Number.isFinite(settingsPx) && settingsPx > 0 ? clamp(settingsPx, 10, 32) : 0;

  // Keep the newest line in view. No smooth scrolling: output simply appears.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && visible) { el.scrollTop = el.scrollHeight; pinned.current = true; }
  }, [version, visible, fontPx]);
  // A resized window keeps showing the input line, unless the user has scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (pinned.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.clientHeight - el.scrollTop < 6;
  };

  // Keep the hidden input's caret where the model says it is.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || document.activeElement !== el) return;
    if (el.selectionStart !== model.cursor || el.selectionEnd !== model.cursor) {
      try { el.setSelectionRange(model.cursor, model.cursor); } catch { /* ignore */ }
    }
  }, [version, model]);

  const focusInput = useCallback(() => {
    const el = input.current;
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  }, []);
  useEffect(() => { if (focusToken !== undefined && visible) focusInput(); }, [focusToken, visible, focusInput]);

  const own = (fn: () => void): void => {
    selfMoved.current = true;
    try { fn(); } finally { setTimeout(() => { selfMoved.current = false; }, 0); }
  };
  const handleKey = (e: React.KeyboardEvent): void => {
    if (e.nativeEvent.isComposing) return;
    const key = e.key;
    if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta' || key === 'CapsLock') return;
    const copyCombo = (e.ctrlKey || e.metaKey) && key.toLowerCase() === 'c';
    if (copyCombo && hasTextSelection()) return; // let the browser copy
    if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'v') return; // paste arrives through onPaste

    if (model.phase === 'busy' || model.phase === 'more') {
      if (key === 'Tab' || e.metaKey || /^F\d+$/.test(key)) return;
      e.preventDefault();
      if (e.ctrlKey && ['c', 'z'].includes(key.toLowerCase())) model.interrupt(key.toLowerCase() === 'c' ? 'ctrl-c' : 'ctrl-z');
      else model.anyKey(key);
      return;
    }
    if (model.phase === 'closed') {
      if (key === 'Enter' && onReopen) { e.preventDefault(); onReopen(); }
      return;
    }
    if (model.phase !== 'input') return;

    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const k = key.toLowerCase();
      const map: Record<string, () => void> = {
        c: () => model.interrupt('ctrl-c'),
        z: () => model.interrupt('ctrl-z'),
        a: () => model.edit('home'),
        e: () => model.edit('end'),
        u: () => model.edit('kill-start'),
        k: () => model.edit('kill-end'),
        w: () => model.edit('kill-word'),
        b: () => model.edit('left'),
        f: () => model.edit('right'),
        d: () => model.edit('delete'),
        p: () => model.historyPrev(),
        n: () => model.historyNext(),
        l: () => undefined,
        r: () => undefined,
      };
      const fn = map[k];
      if (fn) { e.preventDefault(); own(fn); }
      return;
    }
    if (e.metaKey || e.altKey) return;
    switch (key) {
      case 'Enter': e.preventDefault(); own(() => model.enter()); return;
      case 'Tab': if (!e.shiftKey) own(() => { if (model.complete()) e.preventDefault(); }); return;
      case 'ArrowUp': e.preventDefault(); own(() => model.historyPrev()); return;
      case 'ArrowDown': e.preventDefault(); own(() => model.historyNext()); return;
      case '?': own(() => { if (model.help()) e.preventDefault(); }); return;
      default: return;
    }
  };

  const onContainerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t === input.current) return;
    if (t.closest('button, a, textarea, select')) return;
    const key = e.key;
    if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta' || key === 'Tab') return;
    if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'c' && hasTextSelection()) return;
    // Typing anywhere on the screen goes to the input line.
    focusInput();
    if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && model.phase === 'input') {
      e.preventDefault();
      if (key !== '?' || !model.help()) model.paste(key);
      return;
    }
    handleKey(e);
  };
  const onMouseUp = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, textarea')) return;
    if (!hasTextSelection()) focusInput();
  };
  const onPaste = (e: React.ClipboardEvent) => {
    let text = '';
    try { text = e.clipboardData.getData('text'); } catch { return; }
    // Always insert through the model: the paste may land on the screen instead of the hidden input.
    e.preventDefault();
    if (model.phase !== 'input' || !text) return;
    focusInput();
    model.paste(text);
  };

  const doCopy = async () => {
    const ok = await copyText(model.plainText());
    setCopied(ok ? 'yes' : 'failed');
    if (ok) setTimeout(() => setCopied('no'), 2500);
  };
  const setFont = (delta: number) => {
    const cur = fontPx || 14;
    try { lab.updateSettings({ terminalFontPx: clamp(cur + delta, 11, 26) }); } catch (err) { console.error(err); }
  };

  const { phase, prompt, secret, line, cursor } = model;
  const sessionId = model.session?.id;
  const sessionTitle = (sessionId ? (state.sessions ?? []).find((x) => x && x.id === sessionId)?.title : '') || model.session?.title || '';
  const echo = phase === 'input' ? model.inputEcho() : { kind: 'hidden' as const };
  const shown = echo.kind === 'hidden' ? '' : echo.text;
  const cur = echo.kind === 'plain' ? cursor : shown.length;
  const pendingInput = model.pendingInput;
  const before = shown.slice(0, cur);
  const at = shown.slice(cur, cur + 1);
  const after = shown.slice(cur + 1);
  const statusText =
    phase === 'more' ? 'Paused at --More--' : phase === 'busy' ? 'Waiting… press any key to skip' :
    phase === 'closed' ? 'Session closed' : phase === 'idle' ? 'Not connected' :
    secret ? 'Password: typing is hidden' :
    pendingInput ? (pendingInput.kind === 'confirm' ? 'Waiting for confirmation' : 'Waiting for a reply') :
    model.session ? (model.session.kind === 'telnet' ? sessionTitle || 'Telnet session' : 'Console session · connected') : 'Command prompt';

  return (
    <div
      className={`wb-term wb-term--${variant}${focused ? ' is-focused' : ''}`}
      style={fontPx ? { fontSize: `${fontPx}px` } : undefined}
      tabIndex={-1}
      onKeyDown={onContainerKeyDown}
      onMouseUp={onMouseUp}
      onPaste={onPaste}
      onFocus={() => setFocused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}
    >
      <div className="wb-term-scroll" ref={scroller} onScroll={onScroll}>
        <div role="log" aria-live="polite" aria-label="Terminal output">
          {model.chunks.map((c) => <ChunkView key={c.id} chunk={c} />)}
        </div>
        {phase === 'input' && (
          <div className="wb-tl wb-tl--live">
            {prompt}{before}<span className="wb-tcursor">{at || '\u00a0'}</span>{after}
          </div>
        )}
        {phase === 'busy' && <div className="wb-tl wb-tl--live"><span className="wb-tcursor">{'\u00a0'}</span></div>}
        {phase === 'more' && (
          <div className="wb-tl wb-tl--live">
            <span className="wb-tmore"> --More-- </span>
            <span className="wb-tmore-hint">Space = next page · Enter = one line · Q = stop</span>
          </div>
        )}
        {phase === 'closed' && (
          <div className="wb-tclosed">
            <p className="wb-tclosed-text">{model.closedReason || 'The session is closed.'}</p>
            {onReopen && <button type="button" className="btn btn-sm wb-tbtn" onClick={onReopen}>Open the session again (Enter)</button>}
          </div>
        )}
        {phase === 'idle' && <div className="wb-tl wb-tl--sys">Not connected.</div>}
        <input
          ref={input}
          className="wb-term-input"
          type={secret ? 'password' : 'text'}
          value={phase === 'input' ? line : ''}
          aria-label={`${label}. ${phase === 'more' ? 'Output is paused. Press Space for the next page, Enter for one line or Q to stop.' :
            secret ? 'Type the hidden password and press Enter.' : pendingInput ? 'Type a reply and press Enter.' :
            model.session ? 'Type a command and press Enter. Tab completes a command.' : 'Type a command and press Enter.'} Shift+Tab leaves the terminal.`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => {
            const v = e.target.value;
            const at = e.target.selectionStart ?? v.length;
            // A '?' that did not arrive as a key press (on-screen keyboards) still asks for help.
            if (v.length === model.line.length + 1 && v[at - 1] === '?' && v.slice(0, at - 1) + v.slice(at) === model.line) {
              model.setLine(model.line, at - 1);
              if (model.help()) return;
            }
            model.setLine(v, at);
          }}
          onSelect={(e) => {
            // Ignore a stale event that arrives after the line was changed by the terminal itself (Tab, history).
            const el = e.currentTarget;
            if (selfMoved.current) return;
            if (el.selectionStart != null && el.value === model.line) model.setCursor(el.selectionStart);
          }}
          onKeyDown={handleKey}
        />
      </div>
      <div className="wb-term-bar">
        <span className="wb-term-status" role="status">{statusText}</span>
        <span className="wb-term-tools">
          <button type="button" className="wb-term-tool" onClick={doCopy} title="Copy everything on this screen">
            {copied === 'yes' ? 'Copied' : 'Copy all'}
          </button>
          <button type="button" className="wb-term-tool" onClick={() => { model.clear(); focusInput(); }} title="Clear the screen. The device is not changed.">Clear</button>
          <button type="button" className="wb-term-tool" onClick={() => setFont(-1)} aria-label="Smaller terminal text" title="Smaller text">A−</button>
          <button type="button" className="wb-term-tool" onClick={() => setFont(1)} aria-label="Larger terminal text" title="Larger text">A+</button>
        </span>
      </div>
      {copied === 'failed' && (
        <div className="wb-term-copybox">
          <p>Copying is blocked here. Select the text below and press Ctrl+C.</p>
          <textarea readOnly value={model.plainText()} onFocus={(e) => e.currentTarget.select()} aria-label="Terminal text to copy" />
          <button type="button" className="btn btn-sm" onClick={() => setCopied('no')}>Close</button>
        </div>
      )}
    </div>
  );
}
