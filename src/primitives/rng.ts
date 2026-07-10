/**
 * RNG — seedable pseudo-random number generator and weighted-item picker
 */

import type { WeightedItem } from './types';

interface AleaState {
  s0: number;
  s1: number;
  s2: number;
  c: number;
}

// Alea's mash is a stateful accumulator: `n` MUST persist across calls so the
// three `mash(' ')` seed lines below diverge. A stateless mash (resetting `n`
// per call) collapses s0 == s1 == s2 at init and makes draws 2 and 3 of every
// seeded stream bit-identical — see the non-degeneracy regression test.
function createMash(): (data: string) => number {
  let n = 0xefc8249d;
  return (data: string): number => {
    for (let i = 0; i < data.length; i++) {
      n += data.charCodeAt(i);
      let h = 0.02519603282416938 * n;
      n = h >>> 0;
      h -= n;
      h *= n;
      n = h >>> 0;
      h -= n;
      n += h * 0x100000000;
    }
    return (n >>> 0) * 2.3283064365386963e-10;
  };
}

function initAleaState(seed: number): AleaState {
  const mash = createMash();
  let s0 = mash(' ');
  let s1 = mash(' ');
  let s2 = mash(' ');
  const seedStr = seed.toString();
  s0 -= mash(seedStr);
  if (s0 < 0) s0 += 1;
  s1 -= mash(seedStr);
  if (s1 < 0) s1 += 1;
  s2 -= mash(seedStr);
  if (s2 < 0) s2 += 1;
  return { s0, s1, s2, c: 1 };
}

function nextAlea(state: AleaState): number {
  const t = 2091639 * state.s0 + state.c * 2.3283064365386963e-10;
  state.s0 = state.s1;
  state.s1 = state.s2;
  state.c = t | 0;
  state.s2 = t - state.c;
  return state.s2;
}

// Module-global RNG state. Held as a mutable object (not a closure) so
// `getRNGState`/`setRNGState` can snapshot and restore it — required for
// deterministic bisect in event-driven probes, where fire-time
// resolution replays a sub-advance from a checkpoint.
let currentSeed = 0;
const globalAlea: AleaState = initAleaState(0);

function assignState(target: AleaState, source: AleaState): void {
  target.s0 = source.s0;
  target.s1 = source.s1;
  target.s2 = source.s2;
  target.c = source.c;
}

/**
 * Reseed the module-global RNG. Resets the Alea state so subsequent
 * `random()` / `randomInt()` / etc. calls produce a deterministic stream
 * for the given seed. Does not affect closures returned by
 * {@link createSeededRNG}.
 */
export function seedRNG(seed: number): void {
  currentSeed = seed;
  assignState(globalAlea, initAleaState(seed));
}

/**
 * Opaque snapshot of the module-global RNG's internal state. Produced by
 * {@link getRNGState} and consumed by {@link setRNGState}. Treat as a black
 * box — the field shapes are internal to the Alea implementation.
 */
export interface RNGState {
  seed: number;
  s0: number;
  s1: number;
  s2: number;
  c: number;
}

/**
 * Capture the module-global RNG state. Pairs with {@link setRNGState} to
 * snapshot/restore an in-progress stream without re-seeding from scratch.
 * Used by bisect-style probes that need to replay a sub-advance from a
 * checkpoint while preserving RNG-sensitive determinism.
 */
export function getRNGState(): RNGState {
  return {
    seed: currentSeed,
    s0: globalAlea.s0,
    s1: globalAlea.s1,
    s2: globalAlea.s2,
    c: globalAlea.c,
  };
}

/**
 * Restore the module-global RNG to a previously captured state. After this
 * call, subsequent `random()` values match the sequence from the original
 * point. Does not reset `createSeededRNG` streams — those are independent.
 */
export function setRNGState(state: RNGState): void {
  currentSeed = state.seed;
  globalAlea.s0 = state.s0;
  globalAlea.s1 = state.s1;
  globalAlea.s2 = state.s2;
  globalAlea.c = state.c;
}

/**
 * Returns an independent seeded RNG closure. Use when a consumer needs a
 * self-contained stream that must not contaminate — or be contaminated by —
 * the module-level `seedRNG`/`random` shared state.
 */
export function createSeededRNG(seed: number): () => number {
  const state = initAleaState(seed);
  return () => nextAlea(state);
}
/** Return the seed last passed to {@link seedRNG} (0 before any call). */
export function getSeed(): number {
  return currentSeed;
}

/** Draw the next value in [0, 1) from the module-global RNG. */
export function random(): number {
  return nextAlea(globalAlea);
}

/** Draw an integer in `[min, max]` inclusive from the module-global RNG. */
export function randomInt(min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

/** Pick one element uniformly at random from `array`, or `undefined` if empty. */
export function randomItem<T>(array: readonly T[]): T | undefined {
  if (array.length === 0) return undefined;
  return array[randomInt(0, array.length - 1)];
}

/** Return a new array with `array`'s elements in random order (Fisher–Yates). */
export function shuffle<T>(array: readonly T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Pick one item from a weighted list. Returns `undefined` when the list is
 * empty or every weight is non-positive.
 */
export function weightedPick<T>(items: readonly WeightedItem<T>[]): T | undefined {
  if (items.length === 0) return undefined;
  const totalWeight = items.reduce((sum, i) => sum + i.weight, 0);
  if (totalWeight <= 0) return undefined;
  let roll = random() * totalWeight;
  for (const { item, weight } of items) {
    roll -= weight;
    if (roll < 0) return item;
  }
  return items[items.length - 1].item;
}

/** Return `true` with the given probability (clamped 0..1 by RNG output). */
export function chance(probability: number): boolean {
  return random() < probability;
}
