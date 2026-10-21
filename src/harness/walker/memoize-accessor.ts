/**
 * Per-build accessor memoization for {@link createTransitionSnapshot}.
 *
 * Wraps a {@link GameStateAccessor} so duplicate reads within a single
 * snapshot build collapse to one underlying call. Invariant: game state is
 * assumed stable across a single build — walker leaves are pure-read, and
 * the cache lifetime equals one wrap. Reuse the wrapper across builds only
 * if the caller can uphold that invariant; otherwise re-wrap each build.
 */

import type { GameStateAccessor } from '@/primitives/types';
import { AccessorMethods, type WithAccessorMethods } from '@/core/game-state-accessor';

/** Cache `read` per id; keyed on `has`, so an `undefined` read stays cached. */
function cached<V>(read: (id: string) => V): (id: string) => V {
  const cache = new Map<string, V>();
  return (id) => {
    if (cache.has(id)) return cache.get(id) as V;
    const value = read(id);
    cache.set(id, value);
    return value;
  };
}

export function memoizeAccessor(
  accessor: GameStateAccessor & WithAccessorMethods,
): GameStateAccessor & WithAccessorMethods {
  const memo: GameStateAccessor & WithAccessorMethods = {
    getAmount: cached((id) => accessor.getAmount(id)),
    getRate: cached((id) => accessor.getRate(id)),
    getFlag: cached((id) => accessor.getFlag(id)),
    getStateAt: cached((path) => accessor.getStateAt(path)),
    // The record too, so a partial accessor's construction checks see the same methods.
    [AccessorMethods]: accessor[AccessorMethods],
  };
  // Only where the wrapped accessor has it: an absent `getInflowRate` is what
  // tells a predictor to fall back to the net rate.
  const { getInflowRate } = accessor;
  if (getInflowRate) memo.getInflowRate = cached((id) => getInflowRate.call(accessor, id));
  return memo;
}
