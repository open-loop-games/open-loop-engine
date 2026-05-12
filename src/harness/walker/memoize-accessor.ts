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
import type { Decimal } from '@/primitives/decimal';

export function memoizeAccessor(accessor: GameStateAccessor): GameStateAccessor {
  const resourceCache = new Map<string, Decimal>();
  const rateCache = new Map<string, Decimal>();
  const unlockCache = new Map<string, boolean>();
  const stateCache = new Map<string, unknown>();

  return {
    getResource(id) {
      const hit = resourceCache.get(id);
      if (hit !== undefined) return hit;
      const value = accessor.getResource(id);
      resourceCache.set(id, value);
      return value;
    },
    getRate(id) {
      const hit = rateCache.get(id);
      if (hit !== undefined) return hit;
      const value = accessor.getRate(id);
      rateCache.set(id, value);
      return value;
    },
    isUnlocked(id) {
      const hit = unlockCache.get(id);
      if (hit !== undefined) return hit;
      const value = accessor.isUnlocked(id);
      unlockCache.set(id, value);
      return value;
    },
    getState(path) {
      if (stateCache.has(path)) return stateCache.get(path);
      const value = accessor.getState(path);
      stateCache.set(path, value);
      return value;
    },
  };
}
