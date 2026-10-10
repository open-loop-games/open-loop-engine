/**
 * Achievement system — milestone tracking with auto-unlock and tiered rewards
 *
 * Achievements record once-and-stay-earned progress markers. Each instance
 * carries persistent `earned` + `earnedAt` state, an optional reactive
 * `effect` value granted while earned, and a `requirement` watch that
 * auto-completes the achievement whenever the requirement holds and it isn't
 * earned. A save load restores `earned` as state: it fires no `onComplete`.
 *
 * The category factory {@link createAchievementCategory} is the consumer
 * front door for batch-registering achievements; its `registerLadder`
 * method fans one tracked value into a run of threshold-gated tiers.
 * {@link createAchievement} is engine-internal.
 *
 * Aggregator helpers ({@link getCombinedAchievementEffect} multiplicative,
 * {@link getEarnedCount} reactive count) live alongside the factory.
 *
 * Batch-registration over a content registry lives in
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

/** Display text shown on an achievement tile */
export interface AchievementDisplay {
  title: string;
  /** Flavour text or requirement hint shown before the achievement is earned */
  description?: string;
  /** Short description of the bonus granted when the achievement is earned */
  effectDescription?: string;
}

/**
 * Configuration for {@link createAchievement}.
 *
 * `requirement` and `effect` accept refs/getters and so participate in Vue
 * reactivity — while the requirement holds the achievement auto-completes on
 * the next sync flush, or once a load or reset settles. If `requirement` is
 * omitted the achievement only earns via an explicit
 * {@link Achievement.complete} call.
 *
 * @typeParam T - Type of the reactive `effect` value exposed once earned
 */
export interface AchievementOptions<T = unknown> {
  /** Unique identifier; also the persistence sub-context name. */
  id: string;

  /** Display information */
  display: AchievementDisplay;

  /**
   * Requirement that must hold for the achievement to auto-earn.
   *
   * A boolean, ref or getter closes over scope refs and is opaque to the
   * predictor. A {@link Gate} resolves through the runtime the achievement
   * category captured at construction, and predictor consumers read it back
   * as `Achievement.gate` to call `timeUntilGateFlip` for distance projection.
   *
   * If omitted, the achievement only earns via an explicit
   * {@link Achievement.complete} call.
   */
  goal?: Predicate;

  /** The effect/reward value when this achievement is earned. */
  effect?: Computable<T>;

  /** Whether this achievement is hidden until earned. Default: `false` */
  hidden?: Predicate;

  /** Whether this achievement is visible. Default: `true` */
  visible?: Predicate;

  /** Optional image URL for the achievement */
  image?: Computable<string>;

  /** Use smaller display variant */
  compact?: Computable<boolean>;

  /**
   * Callback when the achievement is earned. Never fires for an achievement a
   * load restores as earned, so it can grant a reward.
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
   * The {@link Gate} this achievement was constructed with, when its
   * `requirement` was authored as a Gate. `undefined` for Computable-form
   * requirements (closures opaque to the predictor) or no requirement.
   * Predictor consumers call `timeUntilGateFlip(gate, runtime)` to project
   * remaining distance.
   */
  gate: Gate | undefined;
  /**
   * Whether the achievement has been earned (persistent). Tagged `lifetime`
   * with `earnedAt`, so no module reset or category walk un-earns it; a hard
   * wipe names both refs in `thingsToReset`.
   */
  earned: Ref<boolean>;
  /** Unix timestamp (ms) when the achievement was earned, or null if not yet earned */
  earnedAt: Ref<number | null>;
  /** Reactive bonus value, or undefined when no effect was configured */
  effect: Ref<T> | undefined;
  /** Whether the achievement tile is hidden until earned */
  hidden: Ref<boolean>;
  /** Whether the achievement tile is shown in the achievements UI at all */
  visible: Ref<boolean>;
  /** Optional badge image URL, or undefined when none was configured */
  image: Ref<string> | undefined;
  /** Whether to render the compact/small tile variant */
  compact: Ref<boolean>;
  /** Whether to emit a popup notification when this achievement is earned */
  showPopup: boolean;
  /** Callback invoked when the achievement is earned */
  onComplete?: () => void;
  /** Imperatively award the achievement. No-op if already earned. */
  complete: () => void;
  /** True when the requirement is satisfied and the achievement is not yet earned */
  canComplete: Ref<boolean>;
  /** Subscribe to this achievement's events */
  on: Emittable<AchievementEvents>['on'];
}

/**
 * Events emitted by an Achievement instance
 */
export interface AchievementEvents {
  /** Fired when the achievement transitions from unearned to earned */
  earned: () => void;
}

// === FACTORIES ===

/**
 * Engine-internal raw Achievement factory. Consumers reach this through
 * {@link createAchievementCategory} (the L2 front door); tier ladders go
 * through `category.registerLadder({...})`.
 *
 * A once-and-stay-earned milestone with optional reactive effect and
 * auto-completing requirement watch.
 *
 * @param predicates - resolver the predicate fields adopt through; the
 *   category passes the one it built, so content registered after install
 *   still resolves. Defaults to one over the ambient runtime.
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

  // Compose the ambient context with this achievement's id so save keys carry
  // the parent scope (the category's `${categoryId}/${def.id}`, matching every
  // sibling) while staying unique. A flat `achievement:${id}` dropped the scope
  // (two categories reusing a def id collided); collapsing onto the bare parent
  // instead collides when several achievements share one context. Mirrors
  // category-base / timed-progress `${parent}/${local}` nesting.
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

  // A requirement that holds when a load or reset settles earns too: one
  // added since the save, or one whose `earned` a reset wiped.
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

/** Reactive count of how many achievements in the list are currently earned. */
export function getEarnedCount(achievements: Achievement[]): number {
  return achievements.filter((a) => a.earned.value).length;
}
