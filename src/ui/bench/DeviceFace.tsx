/** One device on the bench, drawn as a front panel with labelled sockets. Pure presentation + pointer hooks. */
import type React from 'react';
import type { PortStatus } from '../../engine/labapi.ts';
import type { Cable, CableKind, Device, PortRef, World } from '../../engine/types.ts';
import { CABLE_META } from '../features.ts';
import type { FaceGeom, PortGeom, Pt } from './geometry.ts';
import { findCableAt, modelName, otherEnd, portText, refKey } from './util.ts';

export type PortMark = 'none' | 'fit' | 'nofit' | 'first' | 'over';

export function ledWord(st: PortStatus | undefined, cabled: boolean): string {
  if (st?.led === 'green') return 'link up';
  if (st?.led === 'amber') return 'cable in, link down';
  return cabled ? 'cable in, no link' : 'empty';
}

function portTitle(world: World, dev: Device, g: PortGeom, st: PortStatus | undefined, cable: Cable | undefined): string {
  const ref = { deviceId: dev.id, port: g.spec.name };
  const parts = [`${dev.label} ${g.spec.short}`];
  if (g.spec.media === 'sfp') parts.push('SFP cage; transceivers are not simulated');
  if (g.spec.media === 'combo') parts.push('RJ-45 side of shared GE 0/0/0');
  if (g.spec.kind === 'serial') parts.push('Smart Serial');
  if (g.spec.kind === 'console' && dev.kind === 'switch') parts.push('rear RJ-45 console');
  if (cable) {
    const far = otherEnd(cable, ref);
    parts.push(`${CABLE_META[cable.kind]?.label ?? cable.kind} cable to ${portText(world, far)}`);
    if (cable.kind === 'serial' && st?.dce !== undefined) parts.push(st.dce ? 'DCE end' : 'DTE end');
  }
  parts.push(ledWord(st, !!cable));
  if (st?.status) parts.push(st.status);
  return parts.join(' — ');
}

export interface DeviceFaceProps {
  world: World;
  device: Device;
  geom: FaceGeom;
  origin: Pt;
  statuses: Record<string, PortStatus>;
  selected: boolean;
  dragging: boolean;
  /** Cable in the user's hand: ports become tab stops and show where the plug fits. */
  cabling: boolean;
  markOf: (ref: PortRef) => PortMark;
  consolePc: string | null;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  onDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
  onPortPointerDown: (e: React.PointerEvent<HTMLButtonElement>, ref: PortRef) => void;
  onPortClick: (e: React.MouseEvent<HTMLButtonElement>, ref: PortRef) => void;
  /** Pointer or keyboard focus is on this port (null: it left). Used for the name bubble. */
  onPortHover: (ref: PortRef | null) => void;
}

export function DeviceFace(p: DeviceFaceProps) {
  const { world, device: d, geom: g, origin, statuses } = p;
  const pcInfo = d.kind === 'pc' ? d.nic : undefined;
  const hint = d.kind === 'pc' ? 'Press Enter to open this PC.' : 'Press Enter to open a terminal.';
  return (
    <div
      className={`wb-dev wb-dev--${g.style}${p.selected ? ' is-selected' : ''}${p.dragging ? ' is-dragging' : ''}`}
      style={{ left: origin.x, top: origin.y, width: g.w, height: g.h }}
      data-device={d.id}
      tabIndex={0}
      role="group"
      aria-label={`${d.label}, ${modelName(d)}. Press Space to select. ${hint} Arrow keys move it.`}
      onPointerDown={p.onPointerDown}
      onClick={p.onClick}
      onDoubleClick={p.onDoubleClick}
      onKeyDown={p.onKeyDown}
      onContextMenu={p.onContextMenu}
    >
      {g.style === 'pc' && g.screen ? (
        <>
          <div className="wb-pc-screen" style={{ left: g.screen.x, top: g.screen.y, width: g.screen.w, height: g.screen.h }}>
            <span className="wb-sticker">{d.label}</span>
            <span className="wb-pc-ip">{pcInfo?.address || 'No IP address'}</span>
            <span className="wb-pc-mode">{pcInfo?.mode === 'static' ? 'Static' : 'DHCP'} · {d.model === 'pc-macos' ? 'MacBook' : 'Windows PC'}</span>
          </div>
          <div className="wb-pc-base" />
        </>
      ) : (
        <>
          <div className="wb-dev-head">
            <span className="wb-sticker">{d.label}</span>
            <span className="wb-dev-model">{modelName(d)}</span>
            {g.legend && <span className="wb-dev-legend">{g.legend}</span>}
            {p.consolePc && <span className="wb-dev-con">Console: {world.devices[p.consolePc]?.label ?? p.consolePc}</span>}
          </div>
          {g.banks?.map((bank) => (
            <div key={bank.text} className={`wb-port-bank${bank.empty ? ' is-empty' : ''}${bank.labelBelow ? ' wb-port-bank--below' : ''}`} style={{ left: bank.x, top: bank.y, width: bank.w, height: bank.h }}>
              <span>{bank.text}</span>
            </div>
          ))}
          {g.comboCage && (
            <div className="wb-combo-cage wb-port--sfp" role="img" title="GE 0/0/0 SFP cage (transceiver not simulated)" aria-label="SFP side of shared GE 0/0/0; transceiver not simulated"
              style={{ left: g.comboCage.x, top: g.comboCage.y, width: g.comboCage.w, height: g.comboCage.h }}>
              <span className="wb-socket" /><span className="wb-combo-label">SFP</span>
            </div>
          )}
        </>
      )}
      {g.ports.map((pg) => {
        const ref = { deviceId: d.id, port: pg.spec.name };
        const st = statuses[refKey(ref)];
        const cable = findCableAt(world, ref);
        const mark = p.markOf(ref);
        const led = st?.led === 'green' ? 'green' : st?.led === 'amber' ? 'amber' : 'off';
        const kind: CableKind | undefined = cable?.kind;
        const title = portTitle(world, d, pg, st, cable);
        return (
          <button
            key={pg.spec.name}
            type="button"
            className={`wb-port wb-port--${pg.shape} wb-port--${pg.labelSide} wb-port--${pg.spec.kind}${cable ? ' is-cabled' : ''}${mark !== 'none' ? ` is-${mark}` : ''}`}
            style={{ left: pg.bx, top: pg.by, width: pg.bw, height: pg.bh }}
            data-port={pg.spec.name}
            data-port-device={d.id}
            tabIndex={p.cabling || p.selected ? 0 : -1}
            aria-label={title}
            onPointerDown={(e) => p.onPortPointerDown(e, ref)}
            onClick={(e) => p.onPortClick(e, ref)}
            onPointerEnter={() => p.onPortHover(ref)}
            onPointerLeave={() => p.onPortHover(null)}
            onFocus={() => p.onPortHover(ref)}
            onBlur={() => p.onPortHover(null)}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <span
              className="wb-socket"
              style={{ left: pg.cx - pg.bx - pg.sw / 2, top: pg.cy - pg.by - pg.sh / 2, width: pg.sw, height: pg.sh }}
            >
              {cable && pg.shape !== 'sfp' && <span className="wb-plug" style={{ background: `var(${CABLE_META[kind!]?.cssVar ?? '--cable-straight'})` }} />}
            </span>
            <span className={`wb-led wb-led--${led}`} style={{ left: pg.cx - pg.bx - pg.sw / 2 - 3, top: pg.cy - pg.by - pg.sh / 2 - 4 }} />
            <span className="wb-port-label">{pg.text}</span>
            {mark === 'first' && <span className="wb-port-badge">1st end</span>}
          </button>
        );
      })}
    </div>
  );
}
