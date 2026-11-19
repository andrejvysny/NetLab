/** Small deterministic random generator for seeded scenarios (no Math.random). Owned by the scenario agent. */

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
  /** `n` different items, in random order. */
  sample<T>(items: readonly T[], n: number): T[];
}

function hashText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** mulberry32 seeded from a stream name and a seed number. */
export function rngFor(stream: string, seed: number): Rng {
  let a = (hashText(stream) ^ Math.imul((seed | 0) + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // warm up
  next(); next();
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.min(items.length - 1, Math.floor(next() * items.length))];
  return {
    next, int, pick,
    chance: (p) => next() < p,
    sample<T>(items: readonly T[], n: number): T[] {
      const pool = [...items];
      const out: T[] = [];
      while (out.length < n && pool.length) out.push(pool.splice(Math.floor(next() * pool.length), 1)[0]);
      return out;
    },
  };
}
