/**
 * Transition sort comparator — shared by the full-walk merger and the
 * incremental-snapshot cache, so both produce identical orderings.
 *
 * Contract: finite seconds ascending, null distances at the end, `key`
 * ascending as the deterministic tie-break. Consumers depend on this ordering
 * as contract, not as an implementation detail.
 *
 * @internal
 */

import type { Transition } from './types';

export function compareTransitions(a: Transition, b: Transition): number {
  const aNull = a.distance.seconds === null;
  const bNull = b.distance.seconds === null;
  if (aNull !== bNull) return aNull ? 1 : -1;
  if (!aNull && !bNull) {
    const as = a.distance.seconds as number;
    const bs = b.distance.seconds as number;
    if (as !== bs) return as - bs;
  }
  // `key` ascending as the deterministic tie-break (for finite equals AND
  // for the null group — V8's sort is stable, but consumers depend on this
  // ordering as contract, not as an implementation detail).
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  return 0;
}
