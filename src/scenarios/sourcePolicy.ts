/** First-match source ACL audit for one service header. Uses wildcard cubes, not a few sample IPs. */
import { intToIp, ipToInt } from '../engine/ip.ts';
import { aceMatches } from '../engine/sim/index.ts';
import type { Acl, AddrMatch, Packet } from '../engine/types.ts';

interface Cube { fixed: number; value: number }
const ANY: Cube = { fixed: 0, value: 0 };
function cube(m: AddrMatch): Cube {
  if (m.kind === 'any') return ANY;
  const fixed = m.kind === 'net' ? ~ipToInt(m.wildcard) : -1;
  return { fixed, value: ipToInt(m.address) & fixed };
}
function intersect(a: Cube, b: Cube): Cube | undefined {
  if (((a.value ^ b.value) & a.fixed & b.fixed) !== 0) return undefined;
  return { fixed: a.fixed | b.fixed, value: a.value | b.value };
}
function subtract(a: Cube, b: Cube): Cube[] {
  if (!intersect(a, b)) return [a];
  const out: Cube[] = [];
  let bits = b.fixed & ~a.fixed;
  let { fixed, value } = a;
  while (bits) {
    const bit = bits & -bits;
    fixed |= bit;
    value |= b.value & bit;
    out.push({ fixed, value: value ^ bit });
    bits ^= bit;
  }
  return out;
}
export function sourceHost(address: string): AddrMatch { return { kind: 'host', address }; }

/** Return a counterexample, or no discrepancy. `outside` checks over-permissiveness, `inside` checks coverage.
 * Missing/empty ACL semantics are deliberately explicit per consumer (interface/management/NAT vs selectors). */
export function sourceMismatch(
  acl: Acl | undefined, allowed: AddrMatch[], packet: Packet,
  mode: 'inside' | 'outside', emptyPermits = true,
): { address: string } | { tooComplex: true } | undefined {
  const entries = (acl?.entries ?? []).filter((e) => e.action !== 'remark');
  const standard = acl?.type === 'standard';
  let pending = mode === 'inside' ? allowed.map(cube) : [ANY];
  const subtractAll = (from: Cube[], by: Cube): Cube[] => {
    const out: Cube[] = [];
    for (const c of from) {
      out.push(...subtract(c, by));
      if (out.length > 4096) throw new Error('ACL search limit');
    }
    return out;
  };
  const witness = (c: Cube) => ({ address: intToIp(c.value >>> 0) });
  try {
    if (mode === 'outside') for (const c of allowed) pending = subtractAll(pending, cube(c));
    for (const e of entries) {
      if (!aceMatches({ ...e, src: { kind: 'any' } }, packet, standard)) continue;
      const area = cube(e.src);
      if ((e.action === 'permit') === (mode === 'outside')) {
        for (const c of pending) {
          const hit = intersect(c, area);
          if (hit) return witness(hit);
        }
      }
      pending = subtractAll(pending, area);
      if (!pending.length) return undefined;
    }
    return pending.length && ((entries.length === 0 && emptyPermits) === (mode === 'outside')) ? witness(pending[0]) : undefined;
  } catch {
    return { tooComplex: true };
  }
}
