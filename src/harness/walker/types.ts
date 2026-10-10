/**
 * Shared types for the transition-walker family. Three leaf walkers —
 * {@link walkChallengeTransitions}, walkPurchasableTransitions,
 * walkProducerTransitions — emit the same {@link Transition} shape so
 * `createTransitionSnapshot` can concatenate, sort, and group uniformly.
 *
 * Unified shape so the canonical engine-internal consumers (`runUntil`'s
 * `'event'` and `'stasis-aware'` modes) and any future broader-adoption
 * consumer (`InfeasibilityOracle` graduation, devtools, UI hints) can treat
 * every discovered pending state change the same way regardless of which
 * subsystem produced it.
 */

import type { DecimalSource } from '@/primitives/decimal';
import type { TransitionDistance } from '@/core/transitions';

export type { TransitionDeps } from '@/core/transitions';

/**
 * Which transition walker produced a given {@link Transition}. Also used
 * by the merger as the group key for `TransitionSnapshot.{challenges,
 * purchasables, producers}`.
 */
export type TransitionWalker = 'challenge' | 'purchasable' | 'producer';

/**
 * A pending state change surfaced by the transition walkers.
 *
 * `kind` is narrowed per `source`: challenge emits `visibility-reveal`,
 * `becomes-enterable`, `goal-complete` and `challenge-maxed`; purchasable emits
 * `becomes-affordable` and `purchasable-maxed`; producer emits
 * `producer-becomes-affordable`. Consumers that need exhaustive narrowing
 * pattern-match on `source` first, then on `kind`.
 */
export interface Transition {
  /** Which transition walker produced this transition. */
  walker: TransitionWalker;
  /** Per-source kind tag; string-typed to keep leaves independent. */
  kind: string;
  /** Owning category's `registry.name` (e.g. `'challenges'`, `'buildings'`). */
  categoryId: string;
  /** Entity's `def.id` within the category. */
  defId: string;
  /**
   * Snapshot of the value whose transition is being predicted. Shape depends
   * on `kind`: boolean for visibility / unlock / goal flips, the owned level
   * or completion count for `*-maxed` thresholds, and for the affordability
   * kinds the accessor-reported amount of the cost resource the distance is
   * metered against (the first cost requirement's, on a multi-cost entity).
   */
  currentValue: DecimalSource | boolean | number;
  /** Distance to the predicted transition. See {@link TransitionDistance}. */
  distance: TransitionDistance;
  /** Display-ready label, conventionally `{categoryId}.{defId}.{kind}`. */
  label: string;
}
