/**
 * Small shared UI primitives for the app shell: accessible modal dialog, confirm dialog, tabs, reveal,
 * feature/mode badges, export dialog. Owned by the app-shell agent.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Feature, LabMode } from '../../engine/types.ts';
import { FEATURE_META } from '../features.ts';
import { Icon } from '../icons.tsx';
import type { IconName } from '../icons.tsx';
import { copyText, downloadText, selectElementText } from './safe.ts';

// ───────────────────────── badges ─────────────────────────

export function featureLabel(f: string): string {
  return (FEATURE_META as Record<string, { label: string } | undefined>)[f]?.label ?? f;
}
/** Small colour swatch for a feature; always shown next to the feature's text label. */
export function featureIcon(f: string): ReactNode {
  return <span className="nl-fswatch" data-feature={f} />;
}

export function FeatureBadge(props: { feature: Feature | string; small?: boolean; label?: string }) {
  return (
    <span className={`badge nl-fbadge${props.small ? ' nl-fbadge-sm' : ''}`} data-feature={props.feature}>
      {props.label ?? featureLabel(props.feature)}
    </span>
  );
}

export const MODE_META: Record<LabMode, { label: string; icon: IconName; short: string }> = {
  guided: { label: 'Guided', icon: 'guided', short: 'One step at a time' },
  free: { label: 'Free practice', icon: 'free', short: 'Any order' },
  exam: { label: 'Exam', icon: 'exam', short: 'No hints' },
};

export function ModeBadge(props: { mode: LabMode }) {
  const m = MODE_META[props.mode] ?? MODE_META.free;
  return (
    <span className="badge nl-mode" data-mode={props.mode}>
      <Icon name={m.icon} />
      {m.label}
    </span>
  );
}

export type PassState = 'pass' | 'fail' | 'partial' | 'none';
export function StatusPill(props: { state: PassState; labels?: Partial<Record<PassState, string>> }) {
  const text: Record<PassState, string> = { pass: 'Passed', fail: 'Not yet', partial: 'Partly', none: 'Not checked', ...props.labels };
  const icon: Record<PassState, string> = { pass: '✓', fail: '✗', partial: '◐', none: '○' };
  return (
    <span className="nl-pill" data-state={props.state}>
      <span aria-hidden="true">{icon[props.state]}</span>
      {text[props.state]}
    </span>
  );
}

// ───────────────────────── modal dialog ─────────────────────────

const modalStack: string[] = [];
let inertCount = 0;
function setRootInert(on: boolean) {
  inertCount = Math.max(0, inertCount + (on ? 1 : -1));
  const root = document.getElementById('root');
  if (!root) return;
  if (inertCount > 0) root.setAttribute('inert', '');
  else root.removeAttribute('inert');
  document.body.classList.toggle('nl-has-modal', inertCount > 0);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

export interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'full';
  /** Short line under the title. */
  subtitle?: ReactNode;
  /** Text for the close button (default "Close"). */
  closeLabel?: string;
  /** Clicking the dimmed background closes the dialog (default true; false for the full-screen report). */
  closeOnBackdrop?: boolean;
  className?: string;
  /** Extra content placed in the header row (right side, before the close button). */
  headerExtra?: ReactNode;
}

/**
 * Modal dialog rendered into document.body. Focus moves inside (first [data-autofocus] or the first control),
 * Tab is kept inside, Escape closes the topmost dialog, focus returns to the opener on close, and the app
 * behind becomes inert.
 */
export function Modal(props: ModalProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    modalStack.push(id);
    setRootInert(true);
    const el = ref.current;
    if (el) {
      const auto = el.querySelector<HTMLElement>('[data-autofocus]');
      const first = auto ?? el.querySelector<HTMLElement>('.nl-modal-body ' + FOCUSABLE.split(',').join(', .nl-modal-body ')) ?? el;
      try { first.focus({ preventScroll: false }); } catch { /* ignore */ }
    }
    return () => {
      const i = modalStack.lastIndexOf(id);
      if (i >= 0) modalStack.splice(i, 1);
      setRootInert(false);
      if (opener && document.contains(opener)) {
        try { opener.focus(); } catch { /* ignore */ }
      }
    };
  }, [id]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (modalStack[modalStack.length - 1] !== id) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      onCloseRef.current();
      return;
    }
    if (e.key === 'Tab' && ref.current) {
      const list = focusables(ref.current);
      if (list.length === 0) { e.preventDefault(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === ref.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }
  };

  const size = props.size ?? 'md';
  const node = (
    <div
      className={`nl-modal-backdrop nl-modal-backdrop-${size}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && props.closeOnBackdrop !== false && modalStack[modalStack.length - 1] === id) props.onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`nl-modal nl-modal-${size}${props.className ? ' ' + props.className : ''}`}
        onKeyDown={onKeyDown}
      >
        <div className="nl-modal-head">
          <div className="nl-modal-titles">
            <h2 id={titleId}>{props.title}</h2>
            {props.subtitle ? <p className="muted">{props.subtitle}</p> : null}
          </div>
          {props.headerExtra}
          <button type="button" className="btn btn-ghost nl-close" onClick={props.onClose}>
            <Icon name="x" /> {props.closeLabel ?? 'Close'}
          </button>
        </div>
        <div className="nl-modal-body">{props.children}</div>
        {props.footer ? <div className="nl-modal-foot">{props.footer}</div> : null}
      </div>
    </div>
  );
  return createPortal(node, document.body);
}

export function ConfirmDialog(props: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  extra?: ReactNode;
}) {
  return (
    <Modal
      title={props.title}
      onClose={props.onCancel}
      size="sm"
      footer={
        <>
          {props.extra}
          <button type="button" className="btn btn-lg" onClick={props.onCancel} data-autofocus>
            {props.cancelLabel ?? 'Cancel'}
          </button>
          <button type="button" className={`btn btn-lg ${props.danger ? 'btn-danger' : 'btn-primary'}`} onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <div className="stack">{props.children}</div>
    </Modal>
  );
}

// ───────────────────────── tabs ─────────────────────────

export interface TabDef<T extends string> { id: T; label: string; icon?: IconName; count?: string }

export function Tabs<T extends string>(props: { tabs: TabDef<T>[]; value: T; onChange: (id: T) => void; label: string; idBase: string; className?: string }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (dir: number) => {
    const i = props.tabs.findIndex((t) => t.id === props.value);
    const next = props.tabs[(i + dir + props.tabs.length) % props.tabs.length];
    if (!next) return;
    props.onChange(next.id);
    refs.current[next.id]?.focus();
  };
  return (
    <div className={`nl-tabs${props.className ? ' ' + props.className : ''}`} role="tablist" aria-label={props.label}>
      {props.tabs.map((t) => (
        <button
          key={t.id}
          ref={(el) => { refs.current[t.id] = el; }}
          type="button"
          role="tab"
          id={`${props.idBase}-tab-${t.id}`}
          aria-controls={`${props.idBase}-panel-${t.id}`}
          aria-selected={t.id === props.value}
          tabIndex={t.id === props.value ? 0 : -1}
          className="nl-tab"
          onClick={() => props.onChange(t.id)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
            else if (e.key === 'Home') { e.preventDefault(); const f = props.tabs[0]; props.onChange(f.id); refs.current[f.id]?.focus(); }
            else if (e.key === 'End') { e.preventDefault(); const l = props.tabs[props.tabs.length - 1]; props.onChange(l.id); refs.current[l.id]?.focus(); }
          }}
        >
          {t.icon ? <span aria-hidden="true"><Icon name={t.icon} /></span> : null}
          <span>{t.label}</span>
          {t.count ? <span className="nl-tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function TabPanel(props: { idBase: string; id: string; children: ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={`${props.idBase}-panel-${props.id}`} aria-labelledby={`${props.idBase}-tab-${props.id}`} className={props.className} tabIndex={0}>
      {props.children}
    </div>
  );
}

// ───────────────────────── reveal ─────────────────────────

export function Reveal(props: {
  label: string;
  openLabel?: string;
  icon?: IconName;
  children: ReactNode;
  onFirstOpen?: () => void;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(!!props.defaultOpen);
  const opened = useRef(!!props.defaultOpen);
  const id = useId();
  return (
    <div className={`nl-reveal${open ? ' is-open' : ''}${props.className ? ' ' + props.className : ''}`}>
      <button
        type="button"
        className="nl-reveal-btn"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && !opened.current) {
            opened.current = true;
            props.onFirstOpen?.();
          }
        }}
      >
        <span className="nl-reveal-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        {props.icon ? <span aria-hidden="true"><Icon name={props.icon} /></span> : null}
        <span>{open ? props.openLabel ?? props.label : props.label}</span>
      </button>
      {open ? <div id={id} className="nl-reveal-body">{props.children}</div> : null}
    </div>
  );
}

// ───────────────────────── copy button ─────────────────────────

export function CopyButton(props: { text: string; label?: string; className?: string; onBlocked?: () => void }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = window.setTimeout(() => setState('idle'), 2200);
    return () => window.clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      className={`btn btn-sm ${props.className ?? ''}`}
      onClick={async () => {
        const ok = await copyText(props.text);
        setState(ok ? 'ok' : 'fail');
        if (!ok) props.onBlocked?.();
      }}
    >
      {state === 'ok' ? '✓ Copied' : state === 'fail' ? 'Copy blocked' : props.label ?? 'Copy'}
    </button>
  );
}

// ───────────────────────── export dialog ─────────────────────────

/** Offers download, copy, and the raw text (for sandboxes where both are blocked). */
export function ExportDialog(props: { title: string; intro: ReactNode; filename: string; text: string; mime?: string; onClose: () => void }) {
  const [status, setStatus] = useState<string>('');
  const [showText, setShowText] = useState(false);
  const preRef = useRef<HTMLTextAreaElement>(null);
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      size="md"
      footer={<button type="button" className="btn btn-lg" onClick={props.onClose}>Done</button>}
    >
      <div className="stack">
        <p>{props.intro}</p>
        <div className="row">
          <button
            type="button"
            className="btn btn-primary btn-lg"
            data-autofocus
            onClick={() => {
              const ok = downloadText(props.filename, props.text, props.mime);
              setStatus(ok ? `Download started: ${props.filename}. If nothing appears, use Copy or Show the text.` : 'This window does not allow downloads. Use Copy or Show the text instead.');
            }}
          >
            <Icon name="download" /> Download file
          </button>
          <button
            type="button"
            className="btn btn-lg"
            onClick={async () => {
              const ok = await copyText(props.text);
              if (ok) setStatus('Copied. Paste it into a text file and save it.');
              else {
                setShowText(true);
                setStatus('Copy is blocked here. The text is shown below: click into it, press Ctrl+A, then Ctrl+C.');
                window.setTimeout(() => preRef.current?.select(), 50);
              }
            }}
          >
            <Icon name="copy" /> Copy
          </button>
          <button type="button" className="btn btn-lg" aria-expanded={showText} onClick={() => setShowText((v) => !v)}>
            {showText ? 'Hide the text' : 'Show the text'}
          </button>
        </div>
        {status ? <p className="note" role="status">{status}</p> : null}
        {showText ? (
          <textarea
            ref={preRef}
            className="input nl-export-text mono"
            readOnly
            value={props.text}
            rows={10}
            aria-label="Exported text"
            onFocus={(e) => e.currentTarget.select()}
          />
        ) : null}
      </div>
    </Modal>
  );
}

export { selectElementText };
