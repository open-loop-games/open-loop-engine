/**
 * Shared types for the transition walkers. Three leaf walkers —
 * {@link walkChallengeTransitions}, walkPurchasableTransitions,
 * walkProducerTransitions — return the same {@link Transition} shape. So
 * `createTransitionSnapshot` can concatenate, sort and group them uniformly.
 *
 * With one shape, every consumer treats each transition the same way,
 * whichever walker found it. The consumers are `runUntil`'s `'next-event'`
 * and `'stasis-aware'` modes inside the engine, and could include devtools
 * and UI hints.
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
 * A transition that a transition walker found.
 *
 * `kind` is narrowed per `walker`. The challenge walker returns
 * `visibility-reveal`, `becomes-enterable`, `goal-complete` and
 * `challenge-maxed`. The purchasable walker returns `becomes-affordable` and
 * `purchasable-maxed`. The producer walker returns
 * `producer-becomes-affordable`. For exhaustive narrowing, narrow on `walker`
 * first, then on `kind`.
 */
export interface Transition {
  /** Which transition walker produced this transition. */
  walker: TransitionWalker;
  /** The transition's kind, narrowed per walker; a `string` to keep the leaf walkers independent. */
  kind: string;
  /** Owning category's `registry.id` (e.g. `'challenges'`, `'buildings'`). */
  categoryId: string;
  /** The def's `def.id` within the category. */
  defId: string;
  /**
   * Snapshot of the value whose transition is predicted. Shape depends on
   * `kind`. It is a boolean for the visibility, enterable and goal flips,
   * and the purchase count or completion count for the `*-maxed` kinds. For
   * the affordability kinds it is the accessor-reported amount of the cost
   * resource the distance is metered against. On a def with several costs,
   * that is the first cost requirement's resource.
   */
  currentValue: DecimalSource | boolean | number;
  /** Distance to the predicted transition. See {@link TransitionDistance}. */
  distance: TransitionDistance;
  /**
   * Unique key, `{categoryId}.{defId}.{kind}`. It breaks sort ties, and the
   * incremental snapshot keys its cache by it.
   */
  key: string;
}
