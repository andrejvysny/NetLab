/**
 * Front-panel layouts. Every device face is drawn from these numbers, and cables end exactly at the socket centres,
 * so nothing is measured from the DOM. Units are logical bench pixels (zoom 1).
 * A device's x/y is the CENTRE of its face.
 */
import type { Device, PortSpec } from '../../engine/types.ts';

export type SocketShape = 'rj45' | 'sfp' | 'serial' | 'db9';
export interface PortGeom {
  spec: PortSpec;
  /** Socket centre, relative to the face's top-left corner. */
  cx: number;
  cy: number;
  sw: number;
  sh: number;
  /** Clickable box, relative to the face's top-left corner. */
  bx: number;
  by: number;
  bw: number;
  bh: number;
  shape: SocketShape;
  /** Printed next to the socket. */
  text: string;
  labelSide: 'above' | 'below';
}
export interface Box { x: number; y: number; w: number; h: number }
export interface FaceGeom {
  style: 'router' | 'switch' | 'pc';
  w: number;
  h: number;
  ports: PortGeom[];
  byName: Record<string, PortGeom>;
  /** Named bays/banks and decorative connectors. The combo SFP is not a separate IOS port. */
  banks?: (Box & { text: string; empty?: boolean; labelBelow?: boolean })[];
  comboCage?: Box;
  /** Switch: e.g. "Gi1/0/1 – Gi1/0/24". */
  legend?: string;
  /** PC: the screen. */
  screen?: Box;
}

const cache = new Map<string, FaceGeom>();

function shapeOf(p: PortSpec): SocketShape {
  return p.media === 'sfp' ? 'sfp' : p.kind === 'serial' ? 'serial' : p.kind === 'rs232' ? 'db9' : 'rj45';
}

function routerFace(ports: PortSpec[]): FaceGeom {
  const out: PortGeom[] = [];
  const ser = ports.filter((p) => p.kind === 'serial');
  // Fig. 1-23, viewed from the I/O side: RJ-45 column at left, SFP at right.
  const combo = ports.find((p) => p.media === 'combo');
  for (const p of ports.filter((p) => p.kind === 'ethernet')) {
    const cx = p.media === 'sfp' ? 141 : 54;
    const cy = p === combo ? 91 : 146;
    out.push({ spec: p, cx, cy, sw: 42, sh: p.media === 'sfp' ? 21 : 25, bx: cx - 41, by: cy - 14, bw: 82, bh: 53,
      shape: shapeOf(p), text: p === combo ? 'RJ-45' : p.short.replace('Gi', 'GE '), labelSide: 'below' });
  }
  ser.forEach((p, i) => {
    const cx = 225 + i * 67;
    out.push({ spec: p, cx, cy: 116, sw: 44, sh: 19, bx: cx - 33, by: 91, bw: 66, bh: 62,
      shape: 'serial', text: p.short, labelSide: 'below' });
  });
  for (const p of ports.filter((p) => p.kind !== 'ethernet' && p.kind !== 'serial')) {
    out.push({ spec: p, cx: 472, cy: 116, sw: 42, sh: 25, bx: 438, by: 91, bw: 68, bh: 62,
      shape: shapeOf(p), text: p.short, labelSide: 'below' });
  }
  return finish({
    style: 'router', w: 514, h: 186, ports: out, byName: {},
    comboCage: combo ? { x: 120, y: 80, w: 42, h: 21 } : undefined,
    banks: [
      { x: 12, y: 64, w: 171, h: 116, text: 'GE 0/0/0 · shared' },
      { x: 190, y: 85, w: 137, h: 77, text: ser.length ? 'NIM 1 (0/1) · NIM-2T' : 'NIM 1 (0/1) · empty', empty: ser.length === 0 },
      { x: 336, y: 85, w: 91, h: 77, text: 'NIM 2 (0/2)', empty: true },
      { x: 438, y: 85, w: 67, h: 77, text: 'Bezel' },
    ],
  });
}

function switchFace(ports: PortSpec[]): FaceGeom {
  const out: PortGeom[] = [];
  const copper = ports.filter((p) => p.kind === 'ethernet' && p.media !== 'sfp');
  const sfp = ports.filter((p) => p.kind === 'ethernet' && p.media === 'sfp');
  const pitch = 32;
  copper.forEach((p, i) => {
    const col = Math.floor(i / 2);
    const top = i % 2 === 0;
    const cx = 29 + col * pitch + Math.floor(col / 6) * 12;
    const num = /(\d+)$/.exec(p.name)?.[1] ?? p.short;
    out.push({
      spec: p, cx, cy: top ? 86 : 122, sw: 25, sh: 22, bx: cx - pitch / 2, by: top ? 49 : 104, bw: pitch, bh: top ? 55 : 53,
      shape: 'rj45', text: num, labelSide: top ? 'above' : 'below',
    });
  });
  sfp.forEach((p, i) => {
    const cx = 441 + i * 38;
    out.push({ spec: p, cx, cy: 112, sw: 30, sh: 20, bx: cx - 19, by: 95, bw: 38, bh: 57,
      shape: 'sfp', text: String(i + 1), labelSide: 'below' });
  });
  for (const p of ports.filter((p) => p.kind !== 'ethernet')) {
    out.push({ spec: p, cx: 614, cy: 112, sw: 42, sh: 25, bx: 583, by: 92, bw: 62, bh: 61,
      shape: shapeOf(p), text: p.short, labelSide: 'below' });
  }
  return finish({
    style: 'switch', w: 654, h: 180, ports: out, byName: {}, legend: 'Gi1/0/1 – Gi1/0/24',
    banks: [
      { x: 10, y: 70, w: 198, h: 90, text: '01X – 12X', labelBelow: true },
      { x: 214, y: 70, w: 198, h: 90, text: '13X – 24X', labelBelow: true },
      { x: 419, y: 83, w: 159, h: 74, text: '1G SFP · Gi1/1/x' },
      { x: 581, y: 83, w: 66, h: 74, text: 'Rear' },
    ],
  });
}

function pcFace(ports: PortSpec[]): FaceGeom {
  const out: PortGeom[] = [];
  const n = Math.max(2, ports.length);
  const w = Math.max(208, 56 + n * 76);
  const step = (w - 56) / n;
  ports.forEach((p, i) => {
    const cx = Math.round(28 + step * (i + 0.5));
    const shape = shapeOf(p);
    out.push({
      spec: p, cx, cy: 127, sw: shape === 'db9' ? 48 : 42, sh: shape === 'db9' ? 24 : 32, bx: cx - 36, by: 104, bw: 72, bh: 64,
      shape, text: p.short, labelSide: 'below',
    });
  });
  return finish({ style: 'pc', w, h: 172, ports: out, byName: {}, screen: { x: 16, y: 12, w: w - 32, h: 84 } });
}

function finish(g: FaceGeom): FaceGeom {
  for (const p of g.ports) g.byName[p.spec.name] = p;
  return g;
}

export function faceFor(device: Device): FaceGeom {
  const ports = Array.isArray(device.ports) ? device.ports : [];
  const key = `${device.model}|${device.kind}|${ports.map((p) => `${p.name}:${p.short}:${p.kind}:${p.media ?? ""}`).join(',')}`;
  let g = cache.get(key);
  if (!g) {
    g = device.kind === 'pc' ? pcFace(ports) : device.kind === 'switch' ? switchFace(ports) : routerFace(ports);
    cache.set(key, g);
  }
  return g;
}

export interface Pt { x: number; y: number }
/** Top-left corner of a device face on the bench. */
export function faceOrigin(device: Device, g: FaceGeom, override?: Pt): Pt {
  const x = override ? override.x : Number(device.x) || 0;
  const y = override ? override.y : Number(device.y) || 0;
  return { x: x - g.w / 2, y: y - g.h / 2 };
}

export interface Curve { d: string; at(t: number): Pt }
/** A cable hangs from its two sockets like a real patch lead. `slack` spreads cables that share a route. */
export function cableCurve(a: Pt, b: Pt, slack = 0): Curve {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Side by side: the cable hangs in a U. One above the other: it runs almost straight down into the lower socket.
  const sag = Math.min(150, Math.max(26, Math.abs(dx) * 0.26)) + slack;
  const lift = Math.abs(dy) * 0.42;
  const low = Math.max(sag - lift, -lift * 0.9);
  const high = sag + lift * 0.6;
  const c1 = { x: a.x + dx * 0.1, y: a.y + (dy < 0 ? low : high) };
  const c2 = { x: b.x - dx * 0.1, y: b.y + (dy < 0 ? high : low) };
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    d: `M ${r(a.x)} ${r(a.y)} C ${r(c1.x)} ${r(c1.y)}, ${r(c2.x)} ${r(c2.y)}, ${r(b.x)} ${r(b.y)}`,
    at(t: number): Pt {
      const u = 1 - t;
      return {
        x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
      };
    },
  };
}

export const BENCH_W = 1400;
export const BENCH_H = 800;
