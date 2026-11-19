/**
 * Logical topology from a DiagramSpec (0..1000 × 0..600), drawn as a clean SVG.
 * Compact mode (task panel): big labels, no per-node notes inside the picture (they are listed below it as text).
 * Large mode (dialog): notes drawn under each node. Owned by the app-shell agent.
 */
import { useId } from 'react';
import type { DiagramSpec } from '../../engine/types.ts';

type DNode = DiagramSpec['nodes'][number];

function RouterIcon() {
  return (
    <g>
      <ellipse cx={0} cy={6} rx={40} ry={14} fill="#c9d7f5" stroke="#1d4ed8" strokeWidth={3} />
      <rect x={-40} y={-10} width={80} height={16} fill="#e3edff" stroke="none" />
      <line x1={-40} y1={-10} x2={-40} y2={6} stroke="#1d4ed8" strokeWidth={3} />
      <line x1={40} y1={-10} x2={40} y2={6} stroke="#1d4ed8" strokeWidth={3} />
      <ellipse cx={0} cy={-10} rx={40} ry={14} fill="#e3edff" stroke="#1d4ed8" strokeWidth={3} />
      <path d="M-22 -10 h16 m-6 -5 l6 5 l-6 5 M22 -10 h-16 m6 -5 l-6 5 l6 5" stroke="#1d4ed8" strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}
function SwitchIcon() {
  return (
    <g>
      <rect x={-44} y={-22} width={88} height={40} rx={8} fill="#eef1f5" stroke="#475569" strokeWidth={3} />
      <path d="M-26 -8 h40 m-7 -5 l7 5 l-7 5 M26 6 h-40 m7 -5 l-7 5 l7 5" stroke="#475569" strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}
function PcIcon() {
  return (
    <g>
      <rect x={-30} y={-26} width={60} height={40} rx={6} fill="#fde7f0" stroke="#9d174d" strokeWidth={3} />
      <rect x={-22} y={-19} width={44} height={26} rx={3} fill="#fff" stroke="none" />
      <path d="M-6 14 v8 M6 14 v8 M-18 24 h36" stroke="#9d174d" strokeWidth={3} strokeLinecap="round" />
    </g>
  );
}

/** Rough text width for Lexend-like fonts. */
const tw = (s: string, fs: number) => s.length * fs * 0.58;

function areaLines(label: string, w: number, fs: number): string[] {
  if (tw(label, fs) <= w - 30) return [label];
  const parts = label.split(/\s{2,}/);
  if (parts.length > 1) return [parts[0], parts.slice(1).join(' ')];
  const i = label.indexOf(' ');
  return i > 0 ? [label.slice(0, i), label.slice(i + 1)] : [label];
}

export function Diagram(props: { spec: DiagramSpec | null | undefined; title?: string; large?: boolean; onEnlarge?: () => void }) {
  const id = useId();
  const spec = props.spec;
  if (!spec || !Array.isArray(spec.nodes) || spec.nodes.length === 0) {
    return <p className="muted">No topology picture for this assignment.</p>;
  }
  const large = !!props.large;
  const byId = new Map<string, DNode>(spec.nodes.map((n) => [n.id, n]));
  const links = Array.isArray(spec.links) ? spec.links : [];
  const groups = new Map<string, number[]>();
  links.forEach((l, i) => {
    const k = [l.a, l.b].sort().join('|');
    groups.set(k, [...(groups.get(k) ?? []), i]);
  });
  const F = large ? { node: 30, note: 24, link: 24, area: 24, icon: 1 } : { node: 46, note: 0, link: 30, area: 30, icon: 1.2 };
  const words = links.map((l) => `${byId.get(l.a)?.label ?? l.a} to ${byId.get(l.b)?.label ?? l.b}${l.label ? ` (${l.label})` : ''}${l.dashed ? ', dashed' : ''}`);

  const linkGeom = links.map((l, i) => {
    const a = byId.get(l.a);
    const b = byId.get(l.b);
    if (!a || !b) return null;
    const group = [...(groups.get([l.a, l.b].sort().join('|')) ?? [i])].sort((x, y) => Number(!!links[x].dashed) - Number(!!links[y].dashed));
    const k = group.indexOf(i);
    // first (solid) link straight, the others alternate above and below
    const off = k === 0 ? 0 : (k % 2 ? -1 : 1) * Math.ceil(k / 2) * (large ? 58 : 70);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const mx = (a.x + b.x) / 2 + nx * off * 2, my = (a.y + b.y) / 2 + ny * off * 2;
    const lx = (a.x + b.x) / 2 + nx * off, ly = (a.y + b.y) / 2 + ny * off;
    const d = off === 0 ? `M${a.x} ${a.y} L${b.x} ${b.y}` : `M${a.x} ${a.y} Q${mx} ${my} ${b.x} ${b.y}`;
    return { l, d, lx, ly };
  });

  const svg = (
    <svg viewBox="-10 -40 1020 670" role="img" aria-labelledby={`${id}-t ${id}-d`} preserveAspectRatio="xMidYMid meet">
      <title id={`${id}-t`}>{props.title ?? 'Topology'}</title>
      <desc id={`${id}-d`}>Connections: {words.join('; ')}.</desc>
      {(spec.areas ?? []).map((a, i) => {
        // Label as a pill sitting on the top border of the frame, so it never covers a device.
        const maxW = Math.max(80, a.w - 32);
        let lines = [a.label];
        let fs = Math.min(F.area, Math.floor(maxW / Math.max(1, a.label.length * 0.58)));
        if (fs < F.area * 0.8) {
          lines = areaLines(a.label, 0, F.area);
          const widest = Math.max(...lines.map((l) => l.length));
          fs = Math.max(14, Math.min(F.area, Math.floor(maxW / (widest * 0.58))));
        }
        const pw = Math.max(...lines.map((l) => tw(l, fs))) + 24;
        const ph = lines.length * (fs + 4) + 10;
        const color = i % 2 ? '#15703a' : '#0b4f8a';
        return (
          <g key={`a${i}`}>
            <rect x={a.x} y={a.y} width={a.w} height={a.h} rx={6} fill={i % 2 ? '#f1f8f3' : '#f1f5fa'} stroke={color} strokeOpacity={0.5} strokeWidth={2} strokeDasharray="8 6" />
            <rect x={a.x + 16} y={a.y - ph / 2} width={pw} height={ph} rx={3} fill="#ffffff" stroke={color} strokeWidth={1.5} />
            {lines.map((t, j) => (
              <text key={j} x={a.x + 28} y={a.y - ph / 2 + 5 + (j + 1) * (fs + 4) - 4} fontSize={fs} fontWeight={j === 0 ? 700 : 500} fill={color}>{t}</text>
            ))}
          </g>
        );
      })}
      {linkGeom.map((g, i) => g ? (
        <path key={`l${i}`} d={g.d} fill="none" stroke={g.l.dashed ? '#7a22c4' : '#18202c'} strokeWidth={g.l.dashed ? 4 : 5} strokeDasharray={g.l.dashed ? '16 10' : undefined} strokeLinecap="round" />
      ) : null)}
      {spec.nodes.map((n) => (
        <g key={n.id} transform={`translate(${n.x} ${n.y})`}>
          <g transform={`scale(${F.icon})`}>{n.kind === 'router' ? <RouterIcon /> : n.kind === 'switch' ? <SwitchIcon /> : <PcIcon />}</g>
          <text y={36 * F.icon + F.node * 0.8} fontSize={F.node} textAnchor="middle" fontWeight={700} fill="#18202c" stroke="#ffffff" strokeWidth={7} paintOrder="stroke">{n.label}</text>
          {large ? (n.notes ?? []).map((t, j) => (
            <text key={j} y={36 + F.node * 0.8 + (j + 1) * (F.note + 6)} fontSize={F.note} textAnchor="middle" fill="#4d5868" stroke="#ffffff" strokeWidth={6} paintOrder="stroke">{t}</text>
          )) : null}
        </g>
      ))}
      {linkGeom.map((g, i) => {
        if (!g || !g.l.label) return null;
        const fs = F.link;
        const lw = tw(g.l.label, fs) + 22;
        return (
          <g key={`ll${i}`}>
            <rect x={g.lx - lw / 2} y={g.ly - fs * 0.8} width={lw} height={fs * 1.5} rx={3} fill="#fff" stroke={g.l.dashed ? '#7a22c4' : '#b4bcc8'} strokeWidth={1.5} />
            <text x={g.lx} y={g.ly + fs * 0.33} fontSize={fs} textAnchor="middle" fontWeight={600} fill={g.l.dashed ? '#7a22c4' : '#18202c'}>{g.l.label}</text>
          </g>
        );
      })}
    </svg>
  );

  const notes = spec.nodes.filter((n) => n.notes && n.notes.length);
  return (
    <figure className={`nl-diagram${large ? ' is-large' : ''}`}>
      {props.onEnlarge ? (
        <button type="button" className="nl-diagram-btn" onClick={props.onEnlarge} aria-label="Show the topology bigger">{svg}</button>
      ) : svg}
      {!large && notes.length ? (
        <figcaption className="nl-diagram-notes">
          {notes.map((n) => (
            <span key={n.id} className="nl-diagram-note"><b>{n.label}</b> {(n.notes ?? []).join(' · ')}</span>
          ))}
        </figcaption>
      ) : null}
    </figure>
  );
}

/** The same topology as a plain list (for reading, and for screen readers). */
export function DiagramList(props: { spec: DiagramSpec | null | undefined }) {
  const spec = props.spec;
  if (!spec) return null;
  const label = (id: string) => spec.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <ul className="nl-diagram-list">
      {(spec.links ?? []).map((l, i) => (
        <li key={i}>
          <b>{label(l.a)}</b> — <b>{label(l.b)}</b>
          {l.label ? <span className="muted"> · {l.label}</span> : null}
          {l.dashed ? <span className="muted"> (dashed: logical link)</span> : null}
        </li>
      ))}
      {spec.nodes.filter((n) => n.notes && n.notes.length).map((n) => (
        <li key={`n-${n.id}`}><b>{n.label}</b>: {(n.notes ?? []).join(', ')}</li>
      ))}
    </ul>
  );
}
