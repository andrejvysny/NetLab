/**
 * Workbench: the lab bench with devices and cables, plus terminal, PC and config-file windows.
 * Talks to the lab only through LabApi (useLab / useLabState).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type React from 'react';
import type { ActionResult, PortStatus } from '../../engine/labapi.ts';
import type { CableKind, PortRef } from '../../engine/types.ts';
import { CABLE_META } from '../features.ts';
import { useLab, useLabState } from '../labContext.tsx';
import { notify } from '../notify.ts';
import './bench.css';
import { BenchCanvas } from './BenchCanvas.tsx';
import type { Selection } from './BenchCanvas.tsx';
import { BenchContext, useBench } from './benchContext.ts';
import { Boundary } from './Boundary.tsx';
import type { BenchServices, ConfigDraft, ConsoleLink } from './benchContext.ts';
import { faceFor } from './geometry.ts';
import { Inspector } from './Inspector.tsx';
import { attempt, errText, findCableAt, findPort, modelName, portText, refKey, sameRef } from './util.ts';
import { ConfigWindow } from './windows/ConfigWindow.tsx';
import { PcWindow } from './windows/PcWindow.tsx';
import { TerminalView } from './windows/TerminalView.tsx';
import { TermRegistry } from './windows/termModel.ts';
import { Dock, WindowFrame } from './windows/WindowFrame.tsx';
import { initialWm, wmReducer } from './windows/windows.ts';
import type { WinKind } from './windows/windows.ts';

const CABLE_ORDER: CableKind[] = ['straight', 'crossover', 'serial', 'console'];

interface Message { kind: 'bad' | 'ok' | 'info'; text: string }
interface ConsoleAsk { deviceId: string; purpose: 'terminal' | 'config'; detail?: string }

export function Workbench() {
  const state = useLabState();
  if (!state.world) {
    return (
      <div className="wb-root wb-root--empty">
        <p className="muted">No lab is open. Choose an assignment to get a bench with devices.</p>
      </div>
    );
  }
  const sc = state.scenario;
  // A new assignment (or a restart) gives a fresh bench: windows, terminals and drafts start empty.
  const key = sc ? `${sc.summary?.id ?? ''}|${sc.seed ?? ''}|${sc.startedAt ?? ''}` : 'bench';
  return <Bench key={key} />;
}

/** Dialog shell used for the two small questions the bench asks. */
function BenchDialog({ title, children, onCancel }: { title: string; children: React.ReactNode; onCancel: () => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current?.querySelector<HTMLElement>('button');
    first?.focus();
    return () => { try { prev?.focus?.(); } catch { /* ignore */ } };
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
    if (e.key !== 'Tab') return;
    const items = Array.from(box.current?.querySelectorAll<HTMLElement>('button') ?? []);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 ? 0 : i + 1);
    e.preventDefault();
    items[next].focus();
  };
  return (
    <div className="wb-modal" onPointerDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="wb-modal-box" role="dialog" aria-modal="true" aria-label={title} ref={box} onKeyDown={onKeyDown}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

function ConsoleWindow({ deviceId, focusToken, onNeedCable }: { deviceId: string; focusToken: number; onNeedCable: (detail?: string) => void }) {
  const state = useLabState();
  const bench = useBench();
  const model = bench.registry.console(deviceId);
  const label = state.world?.devices[deviceId]?.label ?? deviceId;
  const reopen = () => {
    const r = bench.connectConsole(deviceId);
    if (!r.ok) onNeedCable(r.message);
  };
  return <TerminalView model={model} variant="ios" focusToken={focusToken} label={`Console of ${label}`} onReopen={reopen} />;
}

function Bench() {
  const lab = useLab();
  const state = useLabState();
  const world = state.world!;
  const mode = state.scenario?.mode;
  const exam = mode === 'exam';

  const rootRef = useRef<HTMLDivElement | null>(null);
  const trayRef = useRef<HTMLDivElement | null>(null);
  const [area, setArea] = useState({ w: 1000, h: 700 });
  const [trayH, setTrayH] = useState(64);
  const [fitKey, setFitKey] = useState(0);

  const [hand, setHand] = useState<CableKind | null>(null);
  const [firstEnd, setFirstEnd] = useState<PortRef | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [hoverCable, setHoverCable] = useState<CableKind | null>(null);
  const [dceAsk, setDceAsk] = useState<{ a: PortRef; b: PortRef } | null>(null);
  const [consoleAsk, setConsoleAsk] = useState<ConsoleAsk | null>(null);
  const [menu, setMenu] = useState<{ deviceId: string; x: number; y: number } | null>(null);

  const [wm, dispatch] = useReducer(wmReducer, undefined, initialWm);
  const insetTopRef = useRef(130);
  const registry = useMemo(() => new TermRegistry(lab), [lab]);
  const drafts = useRef(new Map<string, ConfigDraft>());
  useEffect(() => () => registry.dispose(), [registry]);
  // After every lab change the terminals pick up new prompts and lost sessions.
  useEffect(() => { registry.syncAll(); }, [registry, state]);

  // ───────── sizes ─────────
  useLayoutEffect(() => {
    const el = rootRef.current;
    const tb = trayRef.current;
    if (!el) return;
    const read = () => {
      setArea((cur) => (cur.w === el.clientWidth && cur.h === el.clientHeight ? cur : { w: el.clientWidth, h: el.clientHeight }));
      if (tb) setTrayH((cur) => (cur === tb.offsetHeight ? cur : tb.offsetHeight));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    if (tb) ro.observe(tb);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { dispatch({ type: 'fit', area }); }, [area]);

  // ───────── lab snapshots (never trust object identity: the lab may mutate the world in place) ─────────
  const statuses = useMemo(() => {
    const out: Record<string, PortStatus> = {};
    for (const id of Object.keys(world.devices)) {
      for (const pt of world.devices[id]?.ports ?? []) {
        const ref = { deviceId: id, port: pt.name };
        out[refKey(ref)] = attempt<PortStatus>(() => lab.portStatus(ref), { ref, kind: pt.kind, led: 'off' });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lab, state]);
  const { consolePcs, consoleTargets } = useMemo(() => {
    const pcs: Record<string, string | null> = {};
    const targets: Record<string, string | null> = {};
    for (const id of Object.keys(world.devices)) {
      const d = world.devices[id];
      if (!d) continue;
      if (d.kind === 'pc') targets[id] = attempt(() => lab.consoleTargetOf(id), null);
      else pcs[id] = attempt(() => lab.consolePcOf(id), null);
    }
    return { consolePcs: pcs, consoleTargets: targets };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lab, state]);

  // ───────── first look: devices must not lie on top of each other ─────────
  const tidied = useRef(false);
  useEffect(() => {
    if (tidied.current) return;
    tidied.current = true;
    const items = Object.values(world.devices).filter(Boolean).map((d) => {
      const g = faceFor(d);
      return { id: d.id, x: Number(d.x) || 0, y: Number(d.y) || 0, w: g.w, h: g.h, moved: false };
    });
    const gap = 26;
    for (let round = 0; round < 60; round++) {
      let any = false;
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const ox = (a.w + b.w) / 2 + gap - Math.abs(b.x - a.x);
        const oy = (a.h + b.h) / 2 + gap - Math.abs(b.y - a.y);
        if (ox <= 0 || oy <= 0) continue;
        any = true;
        if (ox / (a.w + b.w) < oy / (a.h + b.h)) { const dir = b.x >= a.x ? 1 : -1; a.x -= (dir * ox) / 2; b.x += (dir * ox) / 2; }
        else { const dir = b.y >= a.y ? 1 : -1; a.y -= (dir * oy) / 2; b.y += (dir * oy) / 2; }
        a.moved = b.moved = true;
      }
      if (!any) break;
    }
    const moved = items.filter((it) => it.moved);
    if (!moved.length) return;
    for (const it of moved) attempt(() => lab.moveDevice(it.id, Math.round(it.x), Math.round(it.y)), undefined);
    setFitKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ───────── cabling ─────────
  const pickCable = useCallback((kind: CableKind | null) => {
    setHand(kind); setFirstEnd(null); setMessage(null); setDceAsk(null);
  }, []);
  const report = useCallback((res: ActionResult | undefined, failText: string): boolean => {
    if (res?.blocked) {
      const b = res.blocked;
      notify({ kind: 'guide', title: b.stepNo != null ? `Step ${b.stepNo}${b.stepTitle ? `: ${b.stepTitle}` : ''}` : b.stepTitle || 'Not yet', text: b.reason, feature: 'cabling' });
      setMessage({ kind: 'info', text: `The guide stopped this${b.stepNo != null ? ` (step ${b.stepNo}${b.stepTitle ? `: ${b.stepTitle}` : ''})` : ''}. Read the guide message.` });
      return false;
    }
    if (!res?.ok) { setMessage({ kind: 'bad', text: res?.message || failText }); return false; }
    return true;
  }, []);
  const doConnect = useCallback((kind: CableKind, a: PortRef, b: PortRef, dceEnd?: 'a' | 'b') => {
    let res: ActionResult;
    try { res = lab.connectCable(kind, a, b, kind === 'serial' ? { dceEnd: dceEnd ?? 'a' } : undefined); }
    catch (e) { res = { ok: false, message: `The cable could not be connected: ${errText(e)}` }; }
    setFirstEnd(null);
    if (!report(res, 'This cable cannot be plugged in here.')) return;
    setHand(null);
    setMessage(null);
    const w = attempt(() => lab.getState().world, null);
    const cable = w ? findCableAt(w, a) : undefined;
    if (cable) setSelection({ type: 'cable', id: cable.id });
  }, [lab, report]);
  const tryConnect = useCallback((a: PortRef, b: PortRef) => {
    if (!hand || sameRef(a, b)) return;
    setMessage(null);
    if (hand === 'serial' && a.deviceId !== b.deviceId && findPort(world, a)?.kind === 'serial' && findPort(world, b)?.kind === 'serial'
      && !findCableAt(world, a) && !findCableAt(world, b)) { setDceAsk({ a, b }); return; }
    doConnect(hand, a, b);
  }, [hand, world, doConnect]);
  const onPortClick = useCallback((ref: PortRef) => {
    if (!hand) {
      const c = findCableAt(world, ref);
      if (c) { setSelection({ type: 'cable', id: c.id }); setMessage(null); }
      else { setSelection({ type: 'device', id: ref.deviceId }); setMessage({ kind: 'info', text: `To use ${portText(world, ref)}, pick a cable first. Then click this port.` }); }
      return;
    }
    if (!firstEnd) { setFirstEnd(ref); setMessage(null); return; }
    if (sameRef(firstEnd, ref)) { setFirstEnd(null); return; }
    tryConnect(firstEnd, ref);
  }, [hand, firstEnd, world, tryConnect]);
  const removeCable = useCallback((id: string) => {
    let res: ActionResult;
    try { res = lab.removeCable(id); } catch (e) { res = { ok: false, message: `The cable could not be unplugged: ${errText(e)}` }; }
    if (report(res, 'This cable cannot be unplugged right now.')) { setSelection((s) => (s?.type === 'cable' && s.id === id ? null : s)); setMessage(null); }
  }, [lab, report]);

  // ───────── opening devices ─────────
  const openWindow = useCallback((kind: WinKind, deviceId: string) => {
    const el = rootRef.current;
    dispatch({ type: 'open', kind, deviceId, area: el ? { w: el.clientWidth, h: el.clientHeight } : area, top: insetTopRef.current });
  }, [area]);
  const connectConsole = useCallback((deviceId: string): ConsoleLink => {
    let res;
    try { res = lab.openConsole(deviceId); } catch (e) { return { ok: false, message: `The console could not be opened: ${errText(e)}` }; }
    if (!res || !res.ok) return { ok: false, message: (res && 'message' in res && res.message) || '' };
    if (!res.session || typeof res.session.id !== 'string') return { ok: false, message: 'The lab did not return a session.' };
    const model = registry.console(deviceId);
    model.attach(res.session, res.banner);
    return { ok: true, model };
  }, [lab, registry]);
  const openDevice = useCallback((deviceId: string) => {
    const d = world.devices[deviceId];
    if (!d) return;
    setMenu(null);
    if (d.kind === 'pc') { openWindow('pc', deviceId); return; }
    const r = connectConsole(deviceId);
    if (!r.ok) { setConsoleAsk({ deviceId, purpose: 'terminal', detail: r.message }); return; }
    openWindow('terminal', deviceId);
  }, [world, connectConsole, openWindow]);
  const openConfig = useCallback((deviceId: string) => {
    setMenu(null);
    const pc = attempt(() => lab.consolePcOf(deviceId), null);
    if (!pc) { setConsoleAsk({ deviceId, purpose: 'config' }); return; }
    openWindow('config', deviceId);
  }, [lab, openWindow]);

  const services = useMemo<BenchServices>(() => ({
    registry,
    connectConsole,
    configDrafts: drafts.current,
    pickConsoleCable: () => { setHand('console'); setFirstEnd(null); setMessage(null); },
  }), [registry, connectConsole]);

  // ───────── keyboard: Escape steps back, Delete unplugs the selected cable ─────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const root = rootRef.current;
      if (!root || !t) return;
      if (t !== document.body && !root.contains(t)) return;
      const inWindow = !!t.closest?.('.wb-win');
      const editable = !!t.closest?.('input, textarea, select, [contenteditable="true"]');
      if (e.key === 'Escape') {
        if (menu) { setMenu(null); return; }
        if (dceAsk || consoleAsk || inWindow) return; // dialogs handle it themselves; windows never close on Escape
        if (firstEnd) setFirstEnd(null);
        else if (hand) setHand(null);
        else if (message) setMessage(null);
        else if (selection) setSelection(null);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection?.type === 'cable' && !inWindow && !editable && !dceAsk && !consoleAsk) {
        e.preventDefault();
        removeCable(selection.id);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menu, dceAsk, consoleAsk, firstEnd, hand, message, selection, removeCable]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest?.('.wb-menu')) setMenu(null); };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [menu]);

  // Selection that points at something that no longer exists is dropped.
  const sel: Selection = selection && (selection.type === 'device' ? world.devices[selection.id] : (world.cables ?? []).some((c) => c.id === selection.id)) ? selection : null;

  // ───────── status line: one sentence about what to do next ─────────
  const handMeta = hand ? CABLE_META[hand] : null;
  let status: { kind: Message['kind'] | 'hint'; text: string };
  if (message) status = message;
  else if (hoverCable && !hand) status = { kind: 'hint', text: exam ? CABLE_META[hoverCable].label : `${CABLE_META[hoverCable].label}. ${CABLE_META[hoverCable].hint}` };
  else if (handMeta && firstEnd) status = { kind: 'hint', text: `First end: ${portText(world, firstEnd)}. Now click the port for the other end. Esc cancels.` };
  else if (handMeta) status = { kind: 'hint', text: `${handMeta.label} cable in your hand. Drag from one port to another port. Or click the first port, then the second. Esc puts the cable back.` };
  else if (sel?.type === 'cable') {
    const c = (world.cables ?? []).find((x) => x.id === sel.id);
    status = { kind: 'hint', text: c ? `Cable selected: ${portText(world, c.a)} to ${portText(world, c.b)}. Press Delete to unplug it.` : 'Cable selected.' };
  } else if (sel?.type === 'device') status = { kind: 'hint', text: `${world.devices[sel.id]?.label} is selected. Double-click it or press Enter to open it. Drag it to move it.` };
  else status = { kind: 'hint', text: 'Pick a cable. Then drag it from one port to another port. Double-click a device to open it.' };

  // Space kept free at the top: the tray (it only grows when the bench gets narrower) plus one status line.
  const insetTop = 12 + trayH + 8 + 46 + 8;
  insetTopRef.current = insetTop;

  const titles: Record<string, string> = {};
  for (const w of wm.wins) {
    const d = world.devices[w.deviceId];
    const label = d?.label ?? w.deviceId;
    if (w.kind === 'terminal') {
      const s = registry.console(w.deviceId).session;
      const live = s ? (state.sessions ?? []).find((x) => x && x.id === s.id) : undefined;
      titles[w.id] = live?.title || s?.title || `${label} — console`;
    } else if (w.kind === 'pc') titles[w.id] = `${label} — ${modelName(d)}`;
    else titles[w.id] = `${label} — configuration file`;
  }

  const menuDev = menu ? world.devices[menu.deviceId] : undefined;
  const rootRect = rootRef.current?.getBoundingClientRect();
  const askDev = consoleAsk ? world.devices[consoleAsk.deviceId] : undefined;

  return (
    <BenchContext.Provider value={services}>
      <div className="wb-root" ref={rootRef} tabIndex={-1} data-mode={mode ?? ''}>
        <div className="wb-toolbar">
          <div className="wb-tray" ref={trayRef} role="group" aria-label="Cables. Pick one, then connect two ports.">
            <span className="wb-tray-title">Cables</span>
            {CABLE_ORDER.map((k) => {
              const meta = CABLE_META[k];
              const on = hand === k;
              return (
                <button
                  key={k}
                  type="button"
                  className={`wb-tray-item wb-tray-item--${k}${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  title={exam ? meta.label : `${meta.label}. ${meta.hint}`}
                  onClick={() => pickCable(on ? null : k)}
                  onPointerEnter={() => setHoverCable(k)}
                  onPointerLeave={() => setHoverCable((c) => (c === k ? null : c))}
                  onFocus={() => setHoverCable(k)}
                  onBlur={() => setHoverCable((c) => (c === k ? null : c))}
                >
                  <svg className="wb-tray-sample" viewBox="0 0 64 18" width="64" height="18" aria-hidden="true">
                    <path d="M5 9 C 20 1, 44 17, 59 9" fill="none" stroke={`var(${meta.cssVar})`} strokeWidth={meta.width + 0.5} strokeDasharray={meta.dash} strokeLinecap="round" />
                    <rect x="0" y="5" width="7" height="8" rx="2" fill={`var(${meta.cssVar})`} />
                    <rect x="57" y="5" width="7" height="8" rx="2" fill={`var(${meta.cssVar})`} />
                  </svg>
                  <span className="wb-tray-name">{meta.label}</span>
                  {on && <span className="wb-tray-state">in hand</span>}
                </button>
              );
            })}
          </div>
          <div className={`wb-status wb-status--${status.kind}`} role="status" aria-live="polite">
            <span className="wb-status-text">{status.text}</span>
            {hand && <button type="button" className="btn btn-sm wb-status-btn" onClick={() => pickCable(null)}>Put cable back</button>}
            {message && <button type="button" className="wb-status-x" onClick={() => setMessage(null)} aria-label="Hide this message">×</button>}
          </div>
        </div>

        <Boundary what="The bench">
          <BenchCanvas
            key={fitKey}
            world={world}
            statuses={statuses}
            consolePcs={consolePcs}
            hand={hand}
            firstEnd={firstEnd}
            selection={sel}
            insetTop={insetTop}
            onSelect={(s) => { setSelection(s); if (s) setMessage(null); }}
            onPortClick={onPortClick}
            onConnect={tryConnect}
            onOpen={openDevice}
            onMenu={(deviceId, x, y) => setMenu({ deviceId, x, y })}
            onRemoveCable={removeCable}
            onMoveDevice={(id, x, y) => attempt(() => lab.moveDevice(id, x, y), undefined)}
            renderInspector={(canvasArea, anchor) => (
              <Inspector
                world={world}
                statuses={statuses}
                selection={sel}
                hand={hand}
                consolePcs={consolePcs}
                consoleTargets={consoleTargets}
                top={insetTop}
                area={canvasArea}
                anchor={anchor}
                onClose={() => setSelection(null)}
                onOpen={openDevice}
                onConfig={openConfig}
                onUnplug={removeCable}
                onSelect={setSelection}
                onPortClick={onPortClick}
              />
            )}
          />
        </Boundary>

        <div className="wb-windows">
          {wm.wins.map((w) => (
            <WindowFrame key={w.id} win={w} active={wm.activeId === w.id} title={titles[w.id]} area={area} dispatch={dispatch}>
              <Boundary what="This window">
                {w.kind === 'terminal' ? <ConsoleWindow deviceId={w.deviceId} focusToken={w.focus} onNeedCable={(detail) => setConsoleAsk({ deviceId: w.deviceId, purpose: 'terminal', detail })} />
                  : w.kind === 'pc' ? <PcWindow pcId={w.deviceId} focusToken={w.focus} />
                  : <ConfigWindow deviceId={w.deviceId} focusToken={w.focus} />}
              </Boundary>
            </WindowFrame>
          ))}
        </div>
        <Dock wins={wm.wins} activeId={wm.activeId} titles={titles} dispatch={dispatch} area={area} />

        {menu && menuDev && (
          <div
            className="wb-menu"
            role="menu"
            aria-label={`Actions for ${menuDev.label}`}
            style={{
              left: Math.max(8, Math.min(menu.x - (rootRect?.left ?? 0), area.w - 230)),
              top: Math.max(8, Math.min(menu.y - (rootRect?.top ?? 0), area.h - 130)),
            }}
          >
            <div className="wb-menu-title">{menuDev.label}</div>
            <button type="button" role="menuitem" className="wb-menu-item" autoFocus onClick={() => openDevice(menuDev.id)}>{menuDev.kind === 'pc' ? 'Open PC' : 'Open terminal'}</button>
            {menuDev.kind !== 'pc' && <button type="button" role="menuitem" className="wb-menu-item" onClick={() => openConfig(menuDev.id)}>Config file…</button>}
          </div>
        )}

        {dceAsk && (
          <BenchDialog title="Serial cable: which end is DCE?" onCancel={() => { setDceAsk(null); setFirstEnd(null); }}>
            <p>This represents a back-to-back Smart Serial lead. Place its <strong>DCE</strong> end on the router that supplies the clock. The <strong>DTE</strong> end receives the clock.</p>
            <div className="wb-modal-choices">
              <button type="button" className="btn btn-lg" data-autofocus onClick={() => { const q = dceAsk; setDceAsk(null); doConnect('serial', q.a, q.b, 'a'); }}>
                <span className="wb-role wb-role--dce">DCE</span> at {portText(world, dceAsk.a)}
              </button>
              <button type="button" className="btn btn-lg" onClick={() => { const q = dceAsk; setDceAsk(null); doConnect('serial', q.a, q.b, 'b'); }}>
                <span className="wb-role wb-role--dce">DCE</span> at {portText(world, dceAsk.b)}
              </button>
            </div>
            <div className="row wb-modal-foot"><button type="button" className="btn btn-ghost" onClick={() => { setDceAsk(null); setFirstEnd(null); }}>Cancel</button></div>
          </BenchDialog>
        )}

        {consoleAsk && askDev && (
          <BenchDialog title={`${askDev.label} needs a console cable`} onCancel={() => setConsoleAsk(null)}>
            <p>{consoleAsk.purpose === 'config'
              ? `A configuration file is sent to ${askDev.label} through a console cable, the same way as a terminal.`
              : `A terminal on ${askDev.label} only opens through a console cable.`} Do this:</p>
            <ol className="wb-steps">
              <li>Pick the <strong>Console (rollover)</strong> cable.</li>
              <li>Connect a PC's <strong>COM1</strong> port to the <strong>CON</strong> port of {askDev.label}.</li>
              <li>Open {askDev.label} again.</li>
            </ol>
            {consoleAsk.detail && consoleAsk.detail.trim() && <p className="muted wb-modal-detail">The lab says: {consoleAsk.detail}</p>}
            <div className="row wb-modal-foot">
              <button type="button" className="btn btn-primary" data-autofocus onClick={() => { setConsoleAsk(null); services.pickConsoleCable(); }}>Pick up the console cable</button>
              <button type="button" className="btn" onClick={() => setConsoleAsk(null)}>OK</button>
            </div>
          </BenchDialog>
        )}
      </div>
    </BenchContext.Provider>
  );
}
