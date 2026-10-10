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

export function memoizeAccessor(accessor: GameStateAccessor): GameStateAccessor {
  const memo: GameStateAccessor = {
    getResource: cached((id) => accessor.getResource(id)),
    getRate: cached((id) => accessor.getRate(id)),
    getFlag: cached((id) => accessor.getFlag(id)),
    getState: cached((path) => accessor.getState(path)),
  };
  // Only where the source serves it: an absent hook is what tells a
  // predictor to fall back to the net rate.
  const { getInflowRate } = accessor;
  if (getInflowRate) memo.getInflowRate = cached((id) => getInflowRate.call(accessor, id));
  return memo;
}
