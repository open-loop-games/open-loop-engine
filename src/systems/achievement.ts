/**
 * Achievement system — achievements earned automatically when their goal holds, with ladders and effect values
 *
 * Achievements record progress that stays earned once earned. Each instance
 * has persistent `earned` and `earnedAt` refs, an optional reactive `effect`
 * value that applies while earned, and a `goal` watch. The watch completes
 * the achievement whenever the goal holds and it isn't earned. A load sets
 * `earned` from the save: it calls no `onComplete`.
 *
 * Consumers batch-register achievements through the category factory
 * {@link createAchievementCategory}. Its `registerLadder` method fans one
 * tracked value into a ladder of rungs, each blocked by a threshold.
 * {@link createAchievement} is engine-internal.
 *
 * Utilities over a list ({@link getCombinedAchievementEffect}, a product;
 * {@link getEarnedCount}, a count) are beside the factory.
 *
 * Batch registration over a content registry is in
 * `./achievement-category` ({@link createAchievementCategory}).
 */

import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { computed, type Ref, unref } from 'vue';
import { toMaybeRef, type Computable } from '@/core/computed';
import {
  persistent,
  withPersistentContext,
  getCurrentPersistentContext,
  latchWhenSettled,
} from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { attachPersistentContextReset } from '@/core/resettable';
import { createPredicateResolver, type Gate, type Predicate, type PredicateResolver } from './gate';

// === TYPES ===

/** Display text shown on an achievement card */
export interface AchievementDisplay {
  title: string;
  /** Flavour text or goal hint shown before the achievement is earned */
  description?: string;
  /** Short description of the effect value that applies once the achievement is earned */
  effectDescription?: string;
}

/**
 * Options for {@link createAchievement}.
 *
 * `goal` and `effect` accept refs and getters, so they take part in Vue
 * reactivity. While the goal holds, the achievement completes on the next
 * sync flush, or once a load or reset settles. If `goal` is omitted, the
 * achievement is earned only through an explicit
 * {@link Achievement.complete} call.
 *
 * @typeParam T - Type of the reactive `effect` value exposed once earned
 */
export interface AchievementOptions<T = unknown> {
  /** Unique among the achievements in its persistent context; also part of its child persistent context id. */
  id: string;

  /** Display information */
  display: AchievementDisplay;

  /**
   * The goal: the predicate that earns the achievement when it holds.
   *
   * A boolean, ref or getter closes over consumer refs and is opaque to the
   * predictor. A {@link Gate} evaluates through the Gate services the
   * achievement category captured at construction. Predictor consumers read it
   * back as `Achievement.gate` and call `timeUntilGateFlip` for its transition distance.
   *
   * If omitted, the achievement is earned only through an explicit
   * {@link Achievement.complete} call.
   */
  goal?: Predicate;

  /** The effect value while this achievement is earned. */
  effect?: Computable<T>;

  /** Whether this achievement is hidden until earned. Default: `false` */
  hidden?: Predicate;

  /** Whether this achievement is visible. Default: `true` */
  visible?: Predicate;

  /** Optional image URL for the achievement */
  image?: Computable<string>;

  /** Whether to show the compact card */
  compact?: Computable<boolean>;

  /**
   * Option callback called when the achievement is earned. Never called for an
   * achievement a load sets as earned, so it can give a reward.
   */
  onComplete?: () => void;

  /** Whether to show a popup notification when earned. Defaults to true. */
  showPopup?: boolean;
}

/** A live achievement instance created by {@link createAchievement} */
export interface Achievement<T = unknown> {
  id: string;
  display: AchievementDisplay;
  /**
   * The {@link Gate} this achievement was built with, when its
   * `goal` was authored as a Gate. `undefined` for a Computable-form
   * goal (a closure opaque to the predictor) or no goal.
   * Predictor consumers call `timeUntilGateFlip(gate, services)` for the
   * remaining transition distance.
   */
  gate: Gate | undefined;
  /**
   * Whether the achievement has been earned (persistent). Tagged `lifetime`
   * with `earnedAt`, so no module reset or category walk un-earns it; a hard
   * reset names both refs in `thingsToReset`.
   */
  earned: Ref<boolean>;
  /** Unix timestamp (ms) when the achievement was earned, or null if not yet earned */
  earnedAt: Ref<number | null>;
  /** Reactive effect value, or undefined when no `effect` is set */
  effect: Ref<T> | undefined;
  /** Whether the achievement card is hidden until earned */
  hidden: Ref<boolean>;
  /** Whether the achievement card is shown in the achievements UI at all */
  visible: Ref<boolean>;
  /** Optional badge image URL, or undefined when none is set */
  image: Ref<string> | undefined;
  /** Whether to show the compact card */
  compact: Ref<boolean>;
  /** Whether to show a popup notification when this achievement is earned */
  showPopup: boolean;
  /** The `onComplete` option callback, if set */
  onComplete?: () => void;
  /** Imperatively award the achievement. No-op if already earned. */
  complete: () => void;
  /** `true` when the goal holds and the achievement is not yet earned */
  canComplete: Ref<boolean>;
  /** Subscribe to this achievement's events */
  on: Emittable<AchievementEvents>['on'];
}

/**
 * Events emitted by an Achievement instance
 */
export interface AchievementEvents {
  /** Emitted when the achievement changes from unearned to earned */
  earned: () => void;
}

// === FACTORIES ===

/**
 * Engine-internal raw Achievement factory. Consumers reach this through
 * {@link createAchievementCategory} (L2); ladders go
 * through `category.registerLadder({...})`.
 *
 * An achievement that stays earned once earned, with an optional reactive
 * effect and a goal watch that completes it.
 *
 * @param predicates - resolver the predicate fields adopt through; the
 *   category passes the one it built, so content registered after install
 *   still resolves. Defaults to one over the ambient Gate services.
 *
 * @internal
 */
export function createAchievement<T = unknown>(
  options: AchievementOptions<T>,
  predicates: PredicateResolver = createPredicateResolver(),
): Achievement<T> {
  const {
    id,
    display,
    goal: requirement,
    effect,
    hidden,
    visible,
    image,
    compact: small,
    onComplete,
    showPopup = true,
  } = options;

  // Nest this achievement's id under the enclosing persistent context, so save
  // keys contain the category's `${categoryId}/${def.id}` like every sibling's
  // and stay unique. A flat `achievement:${id}` would collide when two
  // categories reuse a def id; the bare enclosing persistent context would
  // collide when several achievements share it. Same `${parent}/${local}`
  // nesting as category-base and timed-progress.
  const parent = getCurrentPersistentContext();
  const contextId = parent ? `${parent}/achievement:${id}` : `achievement:${id}`;
  const { earned, earnedAt } = withPersistentContext(contextId, () => ({
    earned: persistent<boolean>(false, { id: 'earned', lifetime: true }),
    earnedAt: persistent<number | null>(null, { id: 'earnedAt', lifetime: true }),
  }));

  const adoptedRequirement = predicates.adopt(requirement, true, `achievement '${id}' goal`);
  const hiddenRef = predicates.adopt(hidden, false, `achievement '${id}' hidden`).holds;
  const visibleRef = predicates.adopt(visible, true, `achievement '${id}' visible`).holds;
  const processedImage = image !== undefined ? toMaybeRef(image) : undefined;
  const processedSmall = small !== undefined ? toMaybeRef(small) : undefined;
  const processedEffect = effect !== undefined ? toMaybeRef(effect) : undefined;

  const imageRef = processedImage !== undefined ? computed(() => unref(processedImage)) : undefined;
  const smallRef = computed(() => (processedSmall !== undefined ? unref(processedSmall) : false));
  const effectRef =
    processedEffect !== undefined ? computed(() => unref(processedEffect)) : undefined;

  const canComplete = computed(() => !earned.value && adoptedRequirement.holds.value);

  const handle = createEmitHandle<AchievementEvents>();

  const achievement: Achievement<T> = {
    id,
    display,
    gate: adoptedRequirement.gate,
    earned,
    earnedAt,
    effect: effectRef,
    hidden: hiddenRef,
    visible: visibleRef,
    image: imageRef,
    compact: smallRef,
    showPopup,
    onComplete,
    canComplete,
    on: handle.on,

    complete() {
      if (earned.value) return;

      earned.value = true;
      earnedAt.value = Date.now();

      onComplete?.();
      handle.emit('earned');
    },
  };

  // A goal that holds when a load or reset settles earns too: one added
  // since the save, or one whose `earned` a reset cleared.
  if (requirement !== undefined) latchWhenSettled(canComplete, () => achievement.complete());

  return attachPersistentContextReset(achievement, contextId);
}

// === PUBLIC UTILITIES ===

/**
 * Multiply effect values across earned achievements onto a base.
 *
 * @param achievements - Achievements whose `effect` values to multiply when earned
 * @param base - Starting value (defaults to `1`, the multiplicative identity)
 * @returns `base * effect₁ * effect₂ * …` over earned achievements
 */
export function getCombinedAchievementEffect(
  achievements: Achievement<number>[],
  base: DecimalSource = 1,
): Decimal {
  let result = new Decimal(base);

  for (const achievement of achievements) {
    if (achievement.earned.value && achievement.effect) {
      result = result.mul(achievement.effect.value);
    }
  }

  return result;
}

/** Count of the earned achievements in the list; reactive when read inside a `computed`. */
export function getEarnedCount(achievements: Achievement[]): number {
  return achievements.filter((a) => a.earned.value).length;
}
