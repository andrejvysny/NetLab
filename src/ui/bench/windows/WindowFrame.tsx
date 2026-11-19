/** A draggable, resizable window that stays inside the workbench, plus the dock that lists all open windows. */
import { useRef } from 'react';
import type React from 'react';
import type { Area, Win, WmAction } from './windows.ts';
import { DOCK_H, WIN_MIN_H, WIN_MIN_W } from './windows.ts';

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export function Glyph({ name }: { name: 'min' | 'max' | 'restore' | 'close' | 'term' | 'pc' | 'file' | 'tile' }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <svg className="wb-glyph" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
      {name === 'min' && <path d="M4 14h12" {...p} />}
      {name === 'max' && <rect x="4" y="4" width="12" height="12" rx="2" {...p} />}
      {name === 'restore' && <><rect x="3.5" y="7" width="9.5" height="9.5" rx="2" {...p} /><path d="M7 7V5.5a2 2 0 0 1 2-2h5.5a2 2 0 0 1 2 2V11a2 2 0 0 1-2 2H13" {...p} /></>}
      {name === 'close' && <path d="M5 5l10 10M15 5L5 15" {...p} />}
      {name === 'term' && <><rect x="2.5" y="3.5" width="15" height="13" rx="2.5" {...p} /><path d="M6 8l3 2.5L6 13M11 13h3" {...p} /></>}
      {name === 'pc' && <><rect x="2.5" y="3.5" width="15" height="10" rx="2" {...p} /><path d="M7 17h6M10 13.5V17" {...p} /></>}
      {name === 'file' && <><path d="M5.5 2.5h6l3.5 3.5v11.5h-9.5z" {...p} /><path d="M8 10h4.5M8 13.5h4.5" {...p} /></>}
      {name === 'tile' && <><rect x="2.5" y="3.5" width="6.5" height="13" rx="1.5" {...p} /><rect x="11" y="3.5" width="6.5" height="13" rx="1.5" {...p} /></>}
    </svg>
  );
}

export interface WindowFrameProps {
  win: Win;
  active: boolean;
  title: string;
  area: Area;
  dispatch: (a: WmAction) => void;
  children: React.ReactNode;
}

export function WindowFrame({ win, active, title, area, dispatch, children }: WindowFrameProps) {
  const drag = useRef<{ kind: 'move' | Edge; px: number; py: number; x: number; y: number; w: number; h: number } | null>(null);

  const rect = win.maximized
    ? { x: 6, y: 6, w: Math.max(200, area.w - 12), h: Math.max(160, area.h - DOCK_H - 8) }
    : { x: win.x, y: win.y, w: win.w, h: win.h };

  const begin = (kind: 'move' | Edge) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || win.maximized) return;
    if (kind === 'move' && (e.target as HTMLElement).closest('button')) return;
    drag.current = { kind, px: e.clientX, py: e.clientY, x: win.x, y: win.y, w: win.w, h: win.h };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (kind !== 'move') e.preventDefault();
  };
  const move = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (d.kind === 'move') { dispatch({ type: 'rect', id: win.id, area, x: d.x + dx, y: d.y + dy }); return; }
    let { x, y, w, h } = d;
    if (d.kind.includes('e')) w = Math.max(WIN_MIN_W, d.w + dx);
    if (d.kind.includes('s')) h = Math.max(WIN_MIN_H, d.h + dy);
    if (d.kind.includes('w')) { w = Math.max(WIN_MIN_W, d.w - dx); x = d.x + (d.w - w); }
    if (d.kind.includes('n')) { h = Math.max(WIN_MIN_H, d.h - dy); y = Math.max(8, d.y + (d.h - h)); h = d.y + d.h - y; }
    dispatch({ type: 'rect', id: win.id, area, x, y, w, h });
  };
  const end = (e: React.PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    const wasMove = drag.current.kind === 'move';
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    // Like a desktop window: after a click or drag on the title bar, typing goes to the window's content.
    if (wasMove && e.type === 'pointerup') dispatch({ type: 'focus', id: win.id, take: true });
  };

  const onTitleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const step = 24;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    if (win.maximized) return;
    if (e.shiftKey) dispatch({ type: 'nudge', id: win.id, area, dw: dx, dh: dy });
    else dispatch({ type: 'nudge', id: win.id, area, dx, dy });
  };

  return (
    <section
      className={`wb-win wb-win--${win.kind}${active ? ' is-active' : ''}${win.maximized ? ' is-max' : ''}`}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: win.z, display: win.minimized ? 'none' : undefined }}
      role="dialog"
      aria-label={title}
      data-win={win.id}
      onPointerDownCapture={() => { if (!active) dispatch({ type: 'focus', id: win.id }); }}
      onFocusCapture={() => { if (!active) dispatch({ type: 'focus', id: win.id }); }}
    >
      <div
        className="wb-win-title"
        tabIndex={0}
        aria-label={`${title}. Window title bar. Arrow keys move the window. Shift and arrow keys change its size.`}
        onPointerDown={begin('move')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('button')) dispatch({ type: 'toggleMax', id: win.id }); }}
        onKeyDown={onTitleKey}
      >
        <span className="wb-win-icon"><Glyph name={win.kind === 'terminal' ? 'term' : win.kind === 'pc' ? 'pc' : 'file'} /></span>
        <span className="wb-win-name" title={title}>{title}</span>
        <span className="wb-win-btns">
          <button type="button" className="wb-win-btn" aria-label="Minimise window to the dock" title="Minimise" onClick={() => dispatch({ type: 'minimize', id: win.id })}><Glyph name="min" /></button>
          <button type="button" className="wb-win-btn" aria-label={win.maximized ? 'Restore window size' : 'Make window as large as the bench'} title={win.maximized ? 'Restore size' : 'Maximise'} onClick={() => dispatch({ type: 'toggleMax', id: win.id })}><Glyph name={win.maximized ? 'restore' : 'max'} /></button>
          <button type="button" className="wb-win-btn wb-win-btn--close" aria-label="Close window. Your text is kept." title="Close (your text is kept)" onClick={() => dispatch({ type: 'close', id: win.id })}><Glyph name="close" /></button>
        </span>
      </div>
      <div className="wb-win-body">{children}</div>
      {!win.maximized && EDGES.map((edge) => (
        <div
          key={edge}
          className={`wb-win-rs wb-win-rs--${edge}`}
          onPointerDown={begin(edge)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          aria-hidden="true"
        />
      ))}
    </section>
  );
}

export function Dock({ wins, activeId, titles, dispatch, area }: {
  wins: Win[]; activeId: string | null; titles: Record<string, string>; dispatch: (a: WmAction) => void; area: Area;
}) {
  if (!wins.length) return null;
  const visible = wins.filter((w) => !w.minimized).length;
  return (
    <nav className="wb-dock" aria-label="Open windows">
      <span className="wb-dock-label">Windows</span>
      {wins.map((w) => {
        const active = w.id === activeId && !w.minimized;
        return (
          <button
            key={w.id}
            type="button"
            className={`wb-dock-chip${active ? ' is-active' : ''}${w.minimized ? ' is-min' : ''}`}
            aria-pressed={active}
            title={w.minimized ? `${titles[w.id]} (minimised). Click to show.` : titles[w.id]}
            onClick={() => (active ? dispatch({ type: 'minimize', id: w.id }) : dispatch({ type: 'focus', id: w.id, take: true }))}
          >
            <Glyph name={w.kind === 'terminal' ? 'term' : w.kind === 'pc' ? 'pc' : 'file'} />
            <span className="wb-dock-name">{titles[w.id]}</span>
            {w.minimized && <span className="wb-dock-state">hidden</span>}
          </button>
        );
      })}
      {visible >= 2 && (
        <button type="button" className="wb-dock-chip wb-dock-tile" onClick={() => dispatch({ type: 'tile', area })} title="Place the open windows side by side">
          <Glyph name="tile" /><span className="wb-dock-name">Side by side</span>
        </button>
      )}
    </nav>
  );
}
