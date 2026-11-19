/** The bench surface: pan/zoom view, device faces, cables and the rubber-band line while a cable is being dragged. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { CSSProperties } from 'react';
import type { PortStatus } from '../../engine/labapi.ts';
import type { Cable, CableKind, Device, PortRef, World } from '../../engine/types.ts';
import { CABLE_META } from '../features.ts';
import { DeviceFace, ledWord } from './DeviceFace.tsx';
import type { PortMark } from './DeviceFace.tsx';
import { BENCH_H, BENCH_W, cableCurve, faceFor, faceOrigin } from './geometry.ts';
import type { FaceGeom, Pt } from './geometry.ts';
import { clamp, findCableAt, findPort, portText, refKey, sameRef, secondEndFits, plugFits, serialRole } from './util.ts';

export type Selection = { type: 'device'; id: string; point?: Pt } | { type: 'cable'; id: string } | null;

export interface InspectorAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
  point: Pt;
}

export interface BenchCanvasProps {
  world: World;
  statuses: Record<string, PortStatus>;
  consolePcs: Record<string, string | null>;
  hand: CableKind | null;
  firstEnd: PortRef | null;
  selection: Selection;
  /** Height covered by the toolbar at the top (kept free when fitting the view). */
  insetTop: number;
  onSelect: (sel: Selection) => void;
  onPortClick: (ref: PortRef) => void;
  onConnect: (a: PortRef, b: PortRef) => void;
  onOpen: (deviceId: string) => void;
  onMenu: (deviceId: string, clientX: number, clientY: number) => void;
  onRemoveCable: (cableId: string) => void;
  onMoveDevice: (deviceId: string, x: number, y: number) => void;
  /** Render the inspector outside the canvas so it can scroll independently of pan/zoom. */
  renderInspector: (area: { w: number; h: number }, anchor: InspectorAnchor | null) => React.ReactNode;
}

interface View { s: number; tx: number; ty: number }
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;
/** The bench has no edge you can see; this only stops a device from being lost far away. */
const BENCH_LIMIT = 20000;
const GRID_MINOR = 20;
const GRID_MAJOR = 160;

function track(onMove: (ev: PointerEvent) => void, onUp: (ev: PointerEvent) => void): void {
  const move = (ev: PointerEvent) => onMove(ev);
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    onUp(ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
function portAtPoint(x: number, y: number): PortRef | null {
  const el = document.elementFromPoint(x, y)?.closest('[data-port]') as HTMLElement | null;
  if (!el || !el.dataset.port || !el.dataset.portDevice) return null;
  return { deviceId: el.dataset.portDevice, port: el.dataset.port };
}

/** Endless grid paper: the canvas background follows pan and zoom, so it never runs out. */
function gridStyle(v: View): CSSProperties {
  const minor = GRID_MINOR * v.s;
  const major = GRID_MAJOR * v.s;
  return {
    '--grid-minor': `${minor}px`,
    '--grid-major': `${major}px`,
    // Fade the fine lines out when they would be closer than 8 screen pixels.
    '--grid-minor-alpha': minor < 8 ? '0' : '.04',
    backgroundPosition: `${v.tx}px ${v.ty}px`,
  } as CSSProperties;
}

export function BenchCanvas(p: BenchCanvasProps) {
  const { world, statuses, hand, firstEnd, selection } = p;
  const root = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ s: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const auto = useRef(true);
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null);
  const [band, setBand] = useState<{ from: PortRef; to: Pt; over: PortRef | null } | null>(null);
  const [panning, setPanning] = useState(false);
  const [tip, setTip] = useState<PortRef | null>(null);

  const devices: Device[] = useMemo(
    () => (world.order ?? Object.keys(world.devices)).map((id) => world.devices[id]).filter(Boolean),
    // world may be mutated in place by the lab, so recompute on every render of a new snapshot
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [world, statuses],
  );
  const faces = new Map<string, { g: FaceGeom; o: Pt }>();
  for (const d of devices) {
    const g = faceFor(d);
    faces.set(d.id, { g, o: faceOrigin(d, g, dragPos && dragPos.id === d.id ? dragPos : undefined) });
  }

  const content = useMemo(() => {
    if (!devices.length) return { x0: 0, y0: 0, x1: BENCH_W, y1: BENCH_H };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const d of devices) {
      const g = faceFor(d);
      const o = faceOrigin(d, g);
      x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y); x1 = Math.max(x1, o.x + g.w); y1 = Math.max(y1, o.y + g.h);
    }
    return { x0: x0 - 26, y0: y0 - 16, x1: x1 + 26, y1: y1 + 44 };
  }, [devices]);

  const fit = useCallback(() => {
    if (size.w < 50 || size.h < 50) return;
    const padX = 12;
    const padT = p.insetTop;
    const padB = 56;
    const bw = content.x1 - content.x0;
    const bh = content.y1 - content.y0;
    const availW = Math.max(120, size.w - padX * 2);
    const availH = Math.max(120, size.h - padT - padB);
    const s = clamp(Math.min(availW / bw, availH / bh), MIN_ZOOM, 1.15);
    setView({ s, tx: padX + (availW - bw * s) / 2 - content.x0 * s, ty: padT + (availH - bh * s) / 2 - content.y0 * s });
  }, [size.w, size.h, content, p.insetTop]);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const read = () => setSize((cur) => (cur.w === el.clientWidth && cur.h === el.clientHeight ? cur : { w: el.clientWidth, h: el.clientHeight }));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Fit automatically until the user pans or zooms by hand. Moving a device does not re-fit.
  const deviceCount = devices.length;
  useLayoutEffect(() => { if (auto.current) fit(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [size.w, size.h, p.insetTop, deviceCount]);
  // (insetTop only changes when the cable tray wraps to another row, that is, when the bench itself is resized.)

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    auto.current = false;
    setView((v) => {
      const s = clamp(v.s * factor, MIN_ZOOM, MAX_ZOOM);
      const px = cx ?? size.w / 2;
      const py = cy ?? size.h / 2;
      return { s, tx: px - ((px - v.tx) * s) / v.s, ty: py - ((py - v.ty) * s) / v.s };
    });
  }, [size.w, size.h]);

  // Wheel: scroll pans, Ctrl/Cmd + wheel (or pinch) zooms. Needs a non-passive listener to stop the page from zooming.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top);
      else { auto.current = false; setView((v) => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY })); }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const toLogical = (clientX: number, clientY: number): Pt => {
    const r = root.current?.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - (r?.left ?? 0) - v.tx) / v.s, y: (clientY - (r?.top ?? 0) - v.ty) / v.s };
  };

  // ───────── pointer: pan the bench ─────────
  const onBackgroundDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    const t = e.target as HTMLElement;
    if (t.closest('[data-device], .wb-cable, .wb-zoom')) return;
    const start = { x: e.clientX, y: e.clientY, tx: viewRef.current.tx, ty: viewRef.current.ty };
    let moved = false;
    track((ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved) { moved = true; setPanning(true); auto.current = false; }
      setView((v) => ({ ...v, tx: start.tx + dx, ty: start.ty + dy }));
    }, () => {
      setPanning(false);
      if (!moved) p.onSelect(null);
    });
  };

  // ───────── pointer: move a device ─────────
  const clampDevice = (d: Device, x: number, y: number): Pt => {
    const g = faceFor(d);
    return {
      x: clamp(x, -BENCH_LIMIT + g.w / 2, BENCH_LIMIT - g.w / 2),
      y: clamp(y, -BENCH_LIMIT + g.h / 2, BENCH_LIMIT - g.h / 2),
    };
  };
  const onDeviceDown = (e: React.PointerEvent<HTMLDivElement>, d: Device) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-port]')) return;
    const start = { x: e.clientX, y: e.clientY, dx: Number(d.x) || 0, dy: Number(d.y) || 0 };
    let moved = false;
    let last: Pt = { x: start.dx, y: start.dy };
    track((ev) => {
      const dx = (ev.clientX - start.x) / viewRef.current.s;
      const dy = (ev.clientY - start.y) / viewRef.current.s;
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      if (!moved) { moved = true; p.onSelect({ type: 'device', id: d.id }); }
      last = clampDevice(d, start.dx + dx, start.dy + dy);
      setDragPos({ id: d.id, x: last.x, y: last.y });
    }, () => {
      if (moved) p.onMoveDevice(d.id, Math.round(last.x), Math.round(last.y));
      setDragPos(null);
    });
  };
  const onDeviceClick = (e: React.MouseEvent<HTMLDivElement>, d: Device) => {
    if ((e.target as HTMLElement).closest('[data-port]')) return;
    // A plain click (including activation without a pointer sequence) selects. The browser
    // still decides whether two clicks count as a double-click; no timer or capture needed.
    const f = faces.get(d.id)!;
    const point = e.detail ? toLogical(e.clientX, e.clientY) : undefined;
    p.onSelect({ type: 'device', id: d.id, point: point && { x: point.x - f.o.x, y: point.y - f.o.y } });
  };
  const onDeviceKey = (e: React.KeyboardEvent<HTMLDivElement>, d: Device) => {
    if (e.target !== e.currentTarget) return;
    const step = e.shiftKey ? 4 : 20;
    const x = Number(d.x) || 0;
    const y = Number(d.y) || 0;
    const moveTo = (nx: number, ny: number) => { e.preventDefault(); const c = clampDevice(d, nx, ny); p.onMoveDevice(d.id, Math.round(c.x), Math.round(c.y)); };
    switch (e.key) {
      case 'Enter': e.preventDefault(); p.onOpen(d.id); break;
      case ' ': e.preventDefault(); p.onSelect({ type: 'device', id: d.id }); break;
      case 'ArrowLeft': moveTo(x - step, y); break;
      case 'ArrowRight': moveTo(x + step, y); break;
      case 'ArrowUp': moveTo(x, y - step); break;
      case 'ArrowDown': moveTo(x, y + step); break;
      case 'ContextMenu':
      case 'F10': {
        if (e.key === 'F10' && !e.shiftKey) break;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        p.onMenu(d.id, r.left + r.width / 2, r.top + r.height / 2);
        break;
      }
      default: break;
    }
  };

  // ───────── pointer: drag a cable from port to port ─────────
  const onPortDown = (e: React.PointerEvent<HTMLButtonElement>, ref: PortRef) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!hand) return;
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    track((ev) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      moved = true;
      const over = portAtPoint(ev.clientX, ev.clientY);
      setBand({ from: ref, to: toLogical(ev.clientX, ev.clientY), over: over && !sameRef(over, ref) ? over : null });
    }, (ev) => {
      setBand(null);
      if (!moved) return; // a plain click: handled by onClick (click-then-click path)
      const over = portAtPoint(ev.clientX, ev.clientY);
      if (over && !sameRef(over, ref)) p.onConnect(ref, over);
    });
  };

  const anchor = (ref: PortRef): Pt | null => {
    const f = faces.get(ref.deviceId);
    const pg = f?.g.byName[ref.port];
    if (!f || !pg) return null;
    return { x: f.o.x + pg.cx, y: f.o.y + pg.cy + 2 };
  };

  // Which ports does the cable in hand fit? (Only a visual aid. The lab decides what really happens.)
  const startRef = band?.from ?? firstEnd;
  const startSpec = startRef ? findPort(world, startRef) : undefined;
  const markOf = (ref: PortRef): PortMark => {
    if (!hand) return 'none';
    const spec = findPort(world, ref);
    if (!spec) return 'none';
    if (findCableAt(world, ref) || !plugFits(hand, spec)) return 'nofit';
    if (!startRef) return 'fit';
    if (sameRef(startRef, ref)) return 'first';
    if (ref.deviceId === startRef.deviceId || !startSpec || !secondEndFits(hand, startSpec, spec)) return 'nofit';
    return sameRef(band?.over, ref) ? 'over' : 'fit';
  };

  const cables: Cable[] = Array.isArray(world.cables) ? world.cables : [];
  const selectedCable = selection?.type === 'cable' ? selection.id : null;
  const ordered = selectedCable ? [...cables.filter((c) => c.id !== selectedCable), ...cables.filter((c) => c.id === selectedCable)] : cables;
  const bandFrom = band ? anchor(band.from) : null;
  const bandTo = band ? (band.over ? anchor(band.over) ?? band.to : band.to) : null;

  let inspectorAnchor: InspectorAnchor | null = null;
  if (selection?.type === 'device') {
    const f = faces.get(selection.id);
    if (f) {
      const { o, g } = f;
      const left = view.tx + o.x * view.s, top = view.ty + o.y * view.s;
      // Include the rack ears and any socket hit boxes that protrude from the face.
      const ears = g.style === 'pc' ? 0 : 14;
      const x0 = Math.min(-ears, ...g.ports.map((p) => p.bx));
      const x1 = Math.max(g.w + ears, ...g.ports.map((p) => p.bx + p.bw));
      const y0 = Math.min(0, ...g.ports.map((p) => p.by));
      const y1 = Math.max(g.h, ...g.ports.map((p) => p.by + p.bh));
      const point = selection.point ?? { x: g.w / 2, y: g.h / 2 };
      inspectorAnchor = {
        left: left + x0 * view.s, right: left + x1 * view.s,
        top: top + y0 * view.s, bottom: top + y1 * view.s,
        point: { x: left + point.x * view.s, y: top + point.y * view.s },
      };
    }
  }

  return <>
    <div
      ref={root}
      className={`wb-canvas${hand ? ' is-cabling' : ''}${panning ? ' is-panning' : ''}`}
      style={gridStyle(view)}
      onPointerDown={onBackgroundDown}
    >
      <div className="wb-layer" style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})` }}>
        {devices.map((d) => {
          const f = faces.get(d.id)!;
          return (
            <DeviceFace
              key={d.id}
              world={world}
              device={d}
              geom={f.g}
              origin={f.o}
              statuses={statuses}
              selected={selection?.type === 'device' && selection.id === d.id}
              dragging={dragPos?.id === d.id}
              cabling={!!hand}
              markOf={markOf}
              consolePc={p.consolePcs[d.id] ?? null}
              onPointerDown={(e) => onDeviceDown(e, d)}
              onClick={(e) => onDeviceClick(e, d)}
              onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('[data-port]')) p.onOpen(d.id); }}
              onKeyDown={(e) => onDeviceKey(e, d)}
              onContextMenu={(e) => { e.preventDefault(); p.onSelect({ type: 'device', id: d.id }); p.onMenu(d.id, e.clientX, e.clientY); }}
              onPortPointerDown={onPortDown}
              onPortClick={(_e, ref) => p.onPortClick(ref)}
              onPortHover={setTip}
            />
          );
        })}
        <svg className="wb-cables" width="1" height="1" aria-label="Cables">
          {ordered.map((c) => {
            const a = anchor(c.a);
            const b = anchor(c.b);
            if (!a || !b) return null;
            const idx = cables.indexOf(c);
            const curve = cableCurve(a, b, (idx % 3) * 18);
            const meta = CABLE_META[c.kind] ?? CABLE_META.straight;
            const mid = curve.at(0.5);
            const sel = c.id === selectedCable;
            const sa = statuses[refKey(c.a)];
            // Keep an impossible cable from an older save removable, but don't draw it as a usable connection.
            const legacySfp = [c.a, c.b].some((end) => findPort(world, end)?.media === 'sfp');
            const text = legacySfp ? 'Incompatible saved cable' : meta.short;
            const tw = text.length * 7.4 + (c.kind === 'serial' ? 34 : 20);
            const linkWord = legacySfp ? 'incompatible SFP cage' : ledWord(sa, true);
            const dceA = serialRole(sa?.dce);
            const dceB = serialRole(statuses[refKey(c.b)]?.dce);
            const ta = curve.at(0.22);
            const tb = curve.at(0.78);
            return (
              <g
                key={c.id}
                className={`wb-cable wb-cable--${c.kind}${sel ? ' is-selected' : ''}`}
                tabIndex={0}
                role="button"
                aria-label={`${meta.label} cable from ${portText(world, c.a)} to ${portText(world, c.b)}, ${linkWord}. Press Enter to select, Delete to unplug.`}
                onPointerDown={(e) => { e.stopPropagation(); }}
                onClick={(e) => { e.stopPropagation(); p.onSelect({ type: 'cable', id: c.id }); (e.currentTarget as SVGGElement).focus?.(); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onSelect({ type: 'cable', id: c.id }); }
                  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); p.onRemoveCable(c.id); }
                }}
              >
                <title>{`${meta.label}: ${portText(world, c.a)} ↔ ${portText(world, c.b)} — ${linkWord}`}</title>
                <path className="wb-cable-hit" d={curve.d} />
                <path className="wb-cable-casing" d={curve.d} strokeWidth={meta.width + (sel ? 9 : 4)} />
                <path className="wb-cable-line" d={curve.d} stroke={`var(${meta.cssVar})`} strokeWidth={meta.width} strokeDasharray={legacySfp ? '6 8' : meta.dash} />
                <circle className="wb-cable-end" cx={a.x} cy={a.y} r={4.5} fill={`var(${meta.cssVar})`} />
                <circle className="wb-cable-end" cx={b.x} cy={b.y} r={4.5} fill={`var(${meta.cssVar})`} />
                <g transform={`translate(${Math.round(mid.x)}, ${Math.round(mid.y)})`} className="wb-cable-tag">
                  <rect x={-tw / 2} y={-11} width={tw} height={22} rx={11} stroke={`var(${meta.cssVar})`} />
                  {c.kind === 'serial' && <path d={`M ${-tw / 2 + 12} -6 l 6 5 l -7 2 l 6 5`} className="wb-cable-zig" stroke={`var(${meta.cssVar})`} />}
                  <text x={c.kind === 'serial' ? 8 : 0} y={4}>{text}</text>
                </g>
                {dceA && dceB && (
                  <>
                    <g transform={`translate(${Math.round(ta.x)}, ${Math.round(ta.y)})`} className={`wb-cable-tag wb-cable-tag--${dceA.toLowerCase()}`}>
                      <rect x={-19} y={-10} width={38} height={20} rx={6} stroke={`var(${meta.cssVar})`} /><text y={4}>{dceA}</text>
                    </g>
                    <g transform={`translate(${Math.round(tb.x)}, ${Math.round(tb.y)})`} className={`wb-cable-tag wb-cable-tag--${dceB.toLowerCase()}`}>
                      <rect x={-19} y={-10} width={38} height={20} rx={6} stroke={`var(${meta.cssVar})`} /><text y={4}>{dceB}</text>
                    </g>
                  </>
                )}
              </g>
            );
          })}
          {band && bandFrom && bandTo && hand && (() => {
            const meta = CABLE_META[hand];
            const curve = cableCurve(bandFrom, bandTo);
            return (
              <g className="wb-band">
                <path className="wb-cable-casing" d={curve.d} strokeWidth={meta.width + 4} />
                <path className="wb-cable-line" d={curve.d} stroke={`var(${meta.cssVar})`} strokeWidth={meta.width} strokeDasharray={meta.dash} />
                <circle cx={bandTo.x} cy={bandTo.y} r={6} fill={`var(${meta.cssVar})`} className="wb-cable-end" />
              </g>
            );
          })()}
        </svg>
      </div>

      {(() => {
        // Port name in normal-size type, however far the bench is zoomed out.
        const ref = band?.over ?? tip;
        if (!ref || dragPos) return null;
        const f = faces.get(ref.deviceId);
        const pg = f?.g.byName[ref.port];
        const dev = world.devices[ref.deviceId];
        if (!f || !pg || !dev) return null;
        const cable = findCableAt(world, ref);
        const word = ledWord(statuses[refKey(ref)], !!cable);
        return (
          <div className="wb-tip" style={{ left: view.tx + (f.o.x + pg.cx) * view.s, top: view.ty + (f.o.y + pg.by) * view.s }} aria-hidden="true">
            <span className="wb-tip-name">{dev.label} {pg.spec.short}</span>
            <span className="wb-tip-state">{pg.spec.media === 'sfp' ? (cable ? 'SFP cage · incompatible saved cable' : 'SFP cage · no transceiver in this lab') : cable ? `${(CABLE_META[cable.kind] ?? CABLE_META.straight).short} cable · ${word}` : 'free'}</span>
          </div>
        );
      })()}

      <div className="wb-zoom" role="group" aria-label="View">
        <button type="button" className="wb-zoom-btn" onClick={() => zoomAt(1 / 1.2)} aria-label="Zoom out" title="Zoom out">−</button>
        <span className="wb-zoom-val" aria-live="off">{Math.round(view.s * 100)}%</span>
        <button type="button" className="wb-zoom-btn" onClick={() => zoomAt(1.2)} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" className="wb-zoom-btn wb-zoom-fit" onClick={() => { auto.current = true; fit(); }} title="Show the whole bench">Fit</button>
      </div>
    </div>
    {!dragPos && p.renderInspector(size, inspectorAnchor)}
  </>;
}
