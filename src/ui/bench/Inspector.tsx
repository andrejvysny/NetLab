/** Compact inspector for the selected device or cable: ports, the cable on each port, link state in words. */
import type { CSSProperties } from 'react';
import type { PortStatus } from '../../engine/labapi.ts';
import type { CableKind, Device, PortRef, World } from '../../engine/types.ts';
import { CABLE_META } from '../features.ts';
import type { InspectorAnchor, Selection } from './BenchCanvas.tsx';
import { ledWord } from './DeviceFace.tsx';
import { findCableAt, kindWord, modelName, otherEnd, portText, refKey, serialRole } from './util.ts';

function Led({ st, cabled }: { st: PortStatus | undefined; cabled: boolean }) {
  const led = st?.led === 'green' ? 'green' : st?.led === 'amber' ? 'amber' : 'off';
  const word = ledWord(st, cabled);
  return (
    <span className={`wb-linkstate wb-linkstate--${led}`}>
      <span className={`wb-led wb-led--${led} wb-led--inline`} aria-hidden="true" />
      {word.charAt(0).toUpperCase() + word.slice(1)}
    </span>
  );
}

/** Keep the selected face in reach without re-fitting or shifting the bench when selection changes. */
function panelStyle({ w, h }: { w: number; h: number }, top: number, anchor: InspectorAnchor | null): CSSProperties {
  const edge = 12;
  const gap = 8;
  const bottom = h - 62; // Leave the dock and zoom controls accessible.
  const width = Math.max(0, Math.min(350, w - 2 * edge));
  const height = Math.max(0, bottom - top);
  const standard = { right: edge, top, width, maxHeight: height };
  if (!anchor) return standard;

  const spaces = (r: Omit<InspectorAnchor, 'point'>) => {
    const below = Math.max(top, r.bottom + gap);
    return [
      { ...standard, width: Math.min(width, w - edge - r.right - gap) },
      { left: edge, top, width: Math.min(width, r.left - gap - edge), maxHeight: height },
      { ...standard, top: below, maxHeight: bottom - below },
      { ...standard, maxHeight: Math.min(height, r.top - gap - top) },
    ];
  };
  const fit = (r: Omit<InspectorAnchor, 'point'>) => {
    if (r.top >= bottom + gap || r.bottom <= top - gap) return standard;
    const [right, left, below, above] = spaces(r);
    // Prefer the usual right-hand panel at full width, then a usable panel beside the face.
    for (const side of [right, left]) if (side.width >= width) return side;
    for (const side of [right, left]) if (side.width >= Math.min(250, width)) return side;
    return [below, above].sort((a, b) => b.maxHeight - a.maxHeight)
      .find((p) => p.maxHeight >= Math.min(160, height));
  };
  const fullFace = fit(anchor);
  if (fullFace) return fullFace;
  // At high zoom the face may fill the view. Keep at least the activation point clear.
  const { x, y } = anchor.point;
  const point = { left: x, right: x, top: y, bottom: y };
  return fit(point) ?? spaces(point).filter((p) => p.width > 0 && p.maxHeight > 0)
    .sort((a, b) => b.width * b.maxHeight - a.width * a.maxHeight)[0] ?? standard;
}

export interface InspectorProps {
  world: World;
  statuses: Record<string, PortStatus>;
  selection: Selection;
  hand: CableKind | null;
  consolePcs: Record<string, string | null>;
  consoleTargets: Record<string, string | null>;
  /** Distance from the top of the bench (below the cable tray and the status line). */
  top: number;
  area: { w: number; h: number };
  anchor: InspectorAnchor | null;
  onClose: () => void;
  onOpen: (deviceId: string) => void;
  onConfig: (deviceId: string) => void;
  onUnplug: (cableId: string) => void;
  onSelect: (sel: Selection) => void;
  onPortClick: (ref: PortRef) => void;
}

export function Inspector(p: InspectorProps) {
  const { world, statuses, selection } = p;
  if (!selection) return null;
  const style = panelStyle(p.area, p.top, p.anchor);

  if (selection.type === 'cable') {
    const c = (world.cables ?? []).find((x) => x.id === selection.id);
    if (!c) return null;
    const meta = CABLE_META[c.kind] ?? CABLE_META.straight;
    const sa = statuses[refKey(c.a)];
    const sb = statuses[refKey(c.b)];
    const problem = sa?.problem || sb?.problem;
    const ends: { ref: PortRef; st: PortStatus | undefined; role: string }[] = [
      { ref: c.a, st: sa, role: serialRole(sa?.dce) },
      { ref: c.b, st: sb, role: serialRole(sb?.dce) },
    ];
    return (
      <aside className="wb-insp" style={style} aria-label="Selected cable">
        <header className="wb-insp-head">
          <div>
            <h3>{meta.label} cable</h3>
            <p className="muted">Selected cable</p>
          </div>
          <button type="button" className="wb-insp-x" onClick={p.onClose} aria-label="Close this panel">×</button>
        </header>
        <svg className="wb-insp-sample" viewBox="0 0 200 16" aria-hidden="true">
          <path d="M4 8 H196" stroke={`var(${meta.cssVar})`} strokeWidth={meta.width + 1} strokeDasharray={meta.dash} strokeLinecap="round" fill="none" />
        </svg>
        <ul className="wb-insp-ends">
          {ends.map((e, i) => (
            <li key={i}>
              <button type="button" className="wb-insp-link" onClick={() => p.onSelect({ type: 'device', id: e.ref.deviceId })}>{portText(world, e.ref)}</button>
              {e.role && <span className={`wb-role wb-role--${e.role.toLowerCase()}`}>{e.role} end</span>}
              <Led st={e.st} cabled />
              {e.st?.status && <span className="mono wb-insp-status">{e.st.status}</span>}
            </li>
          ))}
        </ul>
        {c.kind === 'serial' && <p className="muted wb-insp-small">The DCE end sets the clock. Only that end accepts <span className="mono">clock rate</span>.</p>}
        {problem && <p className="note warn wb-insp-problem">{problem}</p>}
        <div className="row">
          <button type="button" className="btn btn-danger" onClick={() => p.onUnplug(c.id)}>Unplug this cable</button>
          <span className="muted wb-insp-small">or press Delete</span>
        </div>
      </aside>
    );
  }

  const d: Device | undefined = world.devices[selection.id];
  if (!d) return null;
  const ports = Array.isArray(d.ports) ? d.ports : [];
  const cabled = ports.filter((pt) => findCableAt(world, { deviceId: d.id, port: pt.name }));
  const unused = ports.filter((pt) => !findCableAt(world, { deviceId: d.id, port: pt.name }));
  const free = unused.filter((pt) => pt.media !== 'sfp');
  const emptyCages = unused.filter((pt) => pt.media === 'sfp');
  const isPc = d.kind === 'pc';
  const consolePc = p.consolePcs[d.id];
  const consoleTarget = p.consoleTargets[d.id];

  return (
    <aside className="wb-insp" style={style} aria-label={`Selected device ${d.label}`}>
      <header className="wb-insp-head">
        <div>
          <h3>{d.label}</h3>
          <p className="muted">{kindWord(d)} · {modelName(d)}</p>
        </div>
        <button type="button" className="wb-insp-x" onClick={p.onClose} aria-label="Close this panel">×</button>
      </header>

      <div className="row">
        <button type="button" className="btn btn-primary" onClick={() => p.onOpen(d.id)}>{isPc ? 'Open PC' : 'Open terminal'}</button>
        {!isPc && <button type="button" className="btn" onClick={() => p.onConfig(d.id)}>Config file…</button>}
      </div>

      {isPc ? (
        <p className="wb-insp-line">
          <strong>Address:</strong> <span className="mono">{d.nic?.address || 'none'}</span>{d.nic?.mask ? <span className="mono"> / {d.nic.mask}</span> : null}
          {' '}({d.nic?.mode === 'static' ? 'static' : 'DHCP'})
          <br />
          <strong>Console cable:</strong> {consoleTarget ? `goes to ${world.devices[consoleTarget]?.label ?? consoleTarget}` : 'not plugged in'}
        </p>
      ) : (
        <p className="wb-insp-line">
          <strong>Console:</strong> {consolePc ? `connected to ${world.devices[consolePc]?.label ?? consolePc}` : 'no console cable. A terminal cannot open yet.'}
        </p>
      )}

      <h4 className="wb-insp-sub">Cabled ports ({cabled.length})</h4>
      {cabled.length === 0 ? <p className="muted wb-insp-small">No cables on this device yet.</p> : (
        <ul className="wb-insp-ports">
          {cabled.map((pt) => {
            const ref = { deviceId: d.id, port: pt.name };
            const c = findCableAt(world, ref)!;
            const st = statuses[refKey(ref)];
            const meta = CABLE_META[c.kind] ?? CABLE_META.straight;
            const role = serialRole(st?.dce);
            return (
              <li key={pt.name} className="wb-insp-port">
                <div className="wb-insp-port-top">
                  <span className="mono wb-insp-pname">{pt.short}</span>
                  <Led st={st} cabled />
                  {st?.status && <span className="mono wb-insp-status">{st.status}</span>}
                </div>
                <button type="button" className="wb-insp-link" onClick={() => p.onSelect({ type: 'cable', id: c.id })} title="Select this cable">
                  <svg viewBox="0 0 34 10" width="34" height="10" aria-hidden="true"><path d="M2 5 H32" stroke={`var(${meta.cssVar})`} strokeWidth={meta.width} strokeDasharray={meta.dash} strokeLinecap="round" fill="none" /></svg>
                  {meta.short}{role ? ` (${role})` : ''} → {portText(world, otherEnd(c, ref))}
                </button>
                {st?.problem && <p className="note warn wb-insp-problem">{st.problem}</p>}
              </li>
            );
          })}
        </ul>
      )}

      <h4 className="wb-insp-sub">Free ports ({free.length})</h4>
      {free.length === 0 ? <p className="muted wb-insp-small">No free sockets for lab cables.</p> : (
        <div className="wb-insp-free">
          {free.map((pt) => (
            p.hand ? (
              <button key={pt.name} type="button" className="wb-chip wb-chip--btn mono" onClick={() => p.onPortClick({ deviceId: d.id, port: pt.name })} title={`Plug the cable into ${pt.short}`}>{pt.short}</button>
            ) : (
              <span key={pt.name} className="wb-chip mono">{pt.short}</span>
            )
          ))}
        </div>
      )}
      {p.hand && free.length > 0 && <p className="muted wb-insp-small">Click a free port here to plug in the {CABLE_META[p.hand].short.toLowerCase()} cable.</p>}
      {emptyCages.length > 0 && <p className="muted wb-insp-small">Empty SFP cages: {emptyCages.map((pt) => pt.short).join(', ')}. Transceivers are not simulated.</p>}
    </aside>
  );
}
