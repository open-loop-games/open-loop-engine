/**
 * Transition-walker merger — engine-public introspection contract.
 *
 * Runs the three transition walkers (challenges, purchasables, producers).
 * Returns one {@link TransitionSnapshot}: the merged list sorted by
 * {@link TransitionDistance}, plus one group array per walker. The leaf
 * walkers stay internal to the balance harness. Consumers go through this
 * merger, so they get one ordering and never re-sort across walkers.
 *
 * The engine's own consumers are `runUntil`'s `'next-event'` mode (via
 * {@link createIncrementalSnapshot}) and its `'stasis-aware'` mode (via this
 * one-shot merger, called each iteration). `runBeatProbe` and `runMatrixUntil`
 * reach both. The walker is the substrate under the probes, not a generic
 * consumer-facing API.
 *
 * Wider uses (devtools panels, UI unlock hints, tutorial reachability, mod
 * testing) need a budget-bounded reachability search on top of this one.
 * The engine deliberately does not build it here.
 *
 * The consumer decides how to handle a null distance: `null` distances appear
 * unchanged at the end of `all`. A stasis analyzer treats null as "cannot
 * rule out this transition"; a countdown UI hides null rows. The walker does
 * not make that call.
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
 * `all` is the flat sorted list: finite seconds ascending, null distances
 * last, ties broken by {@link Transition.key}. The per-walker arrays keep
 * the order of `all`, so consumers can walk one group without re-sorting.
 */
export interface TransitionSnapshot {
  /** Sorted merged transitions — finite seconds asc, null last, `key` tie-break. */
  readonly all: readonly Transition[];
  /** Challenge transitions only, in the same order as `all`. */
  readonly challenges: readonly Transition[];
  /** Purchasable transitions only, in the same order as `all`. */
  readonly purchasables: readonly Transition[];
  /** Producer transitions only, in the same order as `all`. */
  readonly producers: readonly Transition[];
}

/**
 * Build one merged snapshot of the transitions across the engine's
 * auto-registered content.
 *
 * Runs each transition walker (challenges, purchasables, producers) against
 * `engine`, and concatenates the output into a sorted, grouped snapshot.
 *
 * A missing `CategoriesKey` or empty category slices give an empty result:
 * each leaf walker returns `[]`, and the merger returns an empty snapshot.
 * There's no failure mode. A fresh engine with no content produces
 * `{ all: [], challenges: [], purchasables: [], producers: [] }`.
 *
 * @param engine - Engine to introspect. Categories are read via
 *   `engine.tryInject(CategoriesKey)`.
 * @param accessor - The game-state accessor every leaf walker reads. It
 *   turns resource amounts, rates, flags and state paths into transition
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
