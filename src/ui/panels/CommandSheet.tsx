/** Commands drawer: course sheet by default; executed device-support audit in practice modes. */
import { Icon } from '../icons.tsx';
import { Fragment, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CommandSheetSection } from '../../engine/labapi.ts';
import type { LabMode } from '../../engine/types.ts';
import { useLab } from '../labContext.tsx';
import { notify } from '../notify.ts';
import { CopyButton, featureIcon, featureLabel } from './ui.tsx';
import { safeCall, selectElementText } from './safe.ts';
import { DeviceSupport } from './DeviceSupport.tsx';
import { deviceSupportAvailable, EXAM_COMMAND_SHEET } from './commandDrawerPolicy.ts';

/** Short chip text: "Management: Telnet…" → "Management", "Access lists (ACL)" → "ACL", else the feature name. */
function chipLabel(s: CommandSheetSection): string {
  if (s.title.includes(':')) return s.title.split(':')[0].trim();
  const paren = /\(([^)]+)\)/.exec(s.title);
  if (paren) return paren[1];
  return s.title.split(/\s+/).length <= 2 ? s.title : featureLabel(s.feature);
}

function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

function SheetLine(props: { line: CommandSheetSection['lines'][number]; q: string }) {
  const ref = useRef<HTMLElement>(null);
  const l = props.line;
  return (
    <li className="nl-cs-line">
      <div className="nl-cs-row">
        <code ref={ref} className="nl-cs-code">{highlight(l.text, props.q)}</code>
        <CopyButton
          text={l.text.trim()}
          className="nl-cs-copy"
          onBlocked={() => {
            selectElementText(ref.current);
            notify({ kind: 'warn', title: 'Copy is blocked in this window', text: 'The line is selected. Press Ctrl+C (or Cmd+C) to copy it.' });
          }}
        />
      </div>
      {l.note ? <p className="nl-cs-note"><span aria-hidden="true">ℹ</span> {highlight(l.note, props.q)}</p> : null}
      {l.warn ? <p className="nl-cs-warn"><Icon name="alert" /> <strong>Careful: </strong>{highlight(l.warn, props.q)}</p> : null}
    </li>
  );
}

function SheetReference({ paperOnly = false }: { paperOnly?: boolean }) {
  const lab = useLab();
  const sections = useMemo(() => paperOnly ? EXAM_COMMAND_SHEET : safeCall(() => lab.commandSheet(), [] as CommandSheetSection[]), [lab, paperOnly]);
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<string>('all');
  const query = q.trim();
  const filtered = sections
    .filter((s) => only === 'all' || s.id === only)
    .map((s) => ({
      ...s,
      lines: query ? s.lines.filter((l) => [l.text, l.note ?? '', l.warn ?? '', s.title].join(' ').toLowerCase().includes(query.toLowerCase())) : s.lines,
    }))
    .filter((s) => s.lines.length > 0);
  const count = filtered.reduce((n, s) => n + s.lines.length, 0);

  return (
    <div className="nl-cs">
      <div className="nl-cs-tools">
        <label className="field">
          <span>Find a command</span>
          <input type="search" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. nat, clock rate, show" data-autofocus={paperOnly || undefined} />
        </label>
        <div className="nl-cs-chips" role="group" aria-label="Topic">
          <button type="button" className="nl-chip" aria-pressed={only === 'all'} onClick={() => setOnly('all')}>All topics</button>
          {sections.map((s) => (
            <button key={s.id} type="button" className="nl-chip" data-feature={s.feature} aria-pressed={only === s.id} onClick={() => setOnly(only === s.id ? 'all' : s.id)}>
              <span aria-hidden="true">{featureIcon(s.feature)}</span> {chipLabel(s)}
            </button>
          ))}
        </div>
        <p className="muted nl-cs-count" role="status">{query || only !== 'all' ? `${count} ${count === 1 ? 'line' : 'lines'} found` : 'Words like name, ip-address or acl-number are placeholders. Type your own value there.'}</p>
      </div>
      <div className="nl-cs-list">
        {sections.length === 0 ? <p className="muted">The command sheet is not available.</p> : null}
        {filtered.map((s) => (
          <Fragment key={s.id}>
            <section className="nl-cs-sec" data-feature={s.feature} aria-labelledby={`cs-${s.id}`}>
              <h3 id={`cs-${s.id}`} className="nl-cs-title"><span aria-hidden="true">{featureIcon(s.feature)}</span> {s.title}</h3>
              <ul className="nl-cs-lines">{s.lines.map((l, i) => <SheetLine key={i} line={l} q={query} />)}</ul>
            </section>
          </Fragment>
        ))}
        {sections.length > 0 && filtered.length === 0 ? <p className="note">Nothing matches “{query}”. Try a shorter word.</p> : null}
      </div>
    </div>
  );
}

function PracticeCommands() {
  const [view, setView] = useState<'sheet' | 'support'>('sheet');
  return (
    <div className="nl-cs">
      <div className="nl-cs-chips" role="group" aria-label="Commands view">
        <button type="button" className="nl-chip" aria-pressed={view === 'sheet'} onClick={() => setView('sheet')} data-autofocus>Exam sheet</button>
        <button type="button" className="nl-chip" aria-pressed={view === 'support'} onClick={() => setView('support')}>Device support</button>
      </div>
      {view === 'sheet' ? <SheetReference /> : <DeviceSupport />}
    </div>
  );
}

export function CommandSheet({ mode }: { mode: LabMode }) {
  return deviceSupportAvailable(mode) ? <PracticeCommands /> : <SheetReference paperOnly />;
}
