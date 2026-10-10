/**
 * Transition-walker merger — engine-public introspection contract.
 *
 * Runs the three transition walkers (challenges, purchasables, producers)
 * and returns a single {@link TransitionSnapshot} with the merged list sorted
 * by {@link TransitionDistance} plus per-source group arrays. The leaves
 * themselves stay internal to harness; consumers go through this merger so
 * they get consistent ordering and never have to re-sort across sources.
 *
 * Canonical consumers today are `runUntil`'s `'next-event'` mode (via
 * {@link createIncrementalSnapshot}) and `runUntil`'s `'stasis-aware'`
 * mode (via this one-shot merger, called per tick). Both flow through
 * `runBeatProbe` and `runMatrixUntil`. The walker is the substrate underneath
 * the probe ecosystem, not a generic consumer-facing API.
 *
 * Broader consumer adoption (devtools panels, UI unlock hints, tutorial
 * reachability, mod-QA) wants a budget-bounded reachability layer above
 * this one — deliberately not built here. The walker is the substrate.
 *
 * Null-distance handling is intentionally left to the consumer: `null`
 * distances surface as-is at the tail of `all`. A stasis analyzer treats null
 * as "cannot rule out this transition"; a countdown UI hides null rows
 * entirely. The walker does not make that call.
 */

import type { Engine } from '@/engine';
import type { GameStateAccessor } from '@/primitives/types';
import type { Transition, TransitionWalker } from './types';
import { walkChallengeTransitions } from './walk-challenge-transitions';
import { walkPurchasableTransitions } from './walk-purchasable-transitions';
import { walkProducerTransitions } from './walk-producer-transitions';
import { memoizeAccessor } from './memoize-accessor';
import { compareTransitions } from './compare-transitions';
import { profile } from '@/core/profiler';

export type { Transition, TransitionWalker } from './types';
export { createIncrementalSnapshot, type IncrementalSnapshot } from './incremental-snapshot';

/**
 * Merged output of {@link createTransitionSnapshot}.
 *
 * `all` is the flat sorted list (finite seconds ascending, null distances
 * last, tie-broken by {@link Transition.key}). The per-source arrays
 * preserve the same order as `all`, so consumers can walk one group
 * without needing to re-sort.
 */
export interface TransitionSnapshot {
  /** Sorted merged transitions — finite seconds asc, null last, label tie-break. */
  readonly all: readonly Transition[];
  /** Challenge transitions only, in the same order as `all`. */
  readonly challenges: readonly Transition[];
  /** Purchasable transitions only, in the same order as `all`. */
  readonly purchasables: readonly Transition[];
  /** Producer transitions only, in the same order as `all`. */
  readonly producers: readonly Transition[];
}

/**
 * Build a single merged snapshot of pending state transitions across the
 * engine's auto-registered content.
 *
 * Runs each transition walker (challenges, purchasables, producers) against
 * `engine` and concatenates the output into a sorted, grouped snapshot.
 *
 * Missing `CategoriesKey` or empty category slices degrade silently — each
 * leaf returns `[]` and the merger emits an empty snapshot. There's no
 * failure mode: a fresh engine with no content produces
 * `{ all: [], challenges: [], purchasables: [], producers: [] }`.
 *
 * @param engine - Engine to introspect. Categories are read via
 *   `engine.tryInject(CategoriesKey)`.
 * @param accessor - Read-side accessor used by every leaf to resolve
 *   resource amounts, rates, unlocks, and state paths into prediction
 *   distances.
 *
 * @example
 * ```ts
 * const snapshot = createTransitionSnapshot(engine, accessor);
 * const nextFinite = snapshot.all.find((t) => t.distance.seconds !== null);
 * if (!nextFinite) {
 *   // No computable transitions — stasis analyzer territory.
 * }
 * ```
 */
export function createTransitionSnapshot(
  engine: Engine,
  accessor: GameStateAccessor,
): TransitionSnapshot {
  return profile('walker.buildSnapshot', () => {
    // Memoize accessor reads across the three leaves: shared-rate-chain shapes
    // call getRate(r) once per transition and read the identical Decimal back.
    const memo = memoizeAccessor(accessor);
    const merged: Transition[] = [
      ...walkChallengeTransitions(engine, memo),
      ...walkPurchasableTransitions(engine, memo),
      ...walkProducerTransitions(engine, memo),
    ];
    merged.sort(compareTransitions);

    const groups: Record<TransitionWalker, Transition[]> = {
      challenge: [],
      purchasable: [],
      producer: [],
    };
    for (const t of merged) groups[t.walker].push(t);

    return {
      all: merged,
      challenges: groups.challenge,
      purchasables: groups.purchasable,
      producers: groups.producer,
    };
  });
}
