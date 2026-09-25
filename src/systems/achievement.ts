/**
 * Achievement system — milestone tracking with auto-unlock and tiered rewards
 *
 * Achievements record once-and-stay-earned progress markers. Each instance
 * carries persistent `earned` + `earnedAt` state, an optional reactive
 * `effect` value granted while earned, and a `requirement` watch that
 * auto-completes the achievement the moment the requirement first holds.
 *
 * The category factory {@link createAchievementCategory} is the consumer
 * front door for batch-registering achievements; its `registerTiered`
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
import { computed, type Ref, unref, watch } from 'vue';
import { processGetter, type Computable } from '@/core/computed';
import { persistent, withPersistentContext, getCurrentContext } from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { evaluateGate, getAmbientGateRuntime, isGate, type Gate } from './gate';

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
 * reactivity — when the requirement transitions to `true` the achievement
 * auto-completes on the next sync flush. If `requirement` is omitted the
 * achievement only earns via an explicit {@link Achievement.complete} call.
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
   * Two forms accepted:
   * - `Computable<boolean>` — boolean / ref / getter. Closes over scope refs;
   *   opaque to the predictor.
   * - {@link Gate} — declarative typed predicate spec. Resolved through the
   *   ambient {@link GateRuntime} (categories + registry + accessor wired by
   *   `createEngine`). Predictor consumers read `Achievement.gate` to call
   *   `timeUntilGateFlip` for distance projection.
   *
   * If omitted, the achievement only earns via an explicit
   * {@link Achievement.complete} call.
   */
  requirement?: Computable<boolean> | Gate;

  /** The effect/reward value when this achievement is earned. */
  effect?: Computable<T>;

  /** Whether this achievement is hidden until earned. */
  hidden?: Computable<boolean>;

  /** Whether this achievement is visible. */
  visible?: Computable<boolean>;

  /** Optional image URL for the achievement */
  image?: Computable<string>;

  /** Use smaller display variant */
  small?: Computable<boolean>;

  /** Callback when achievement is earned */
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
  /** Whether the achievement has been earned (persistent) */
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
  small: Ref<boolean>;
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
 * through `category.registerTiered({...})`.
 *
 * A once-and-stay-earned milestone with optional reactive effect and
 * auto-completing requirement watch.
 *
 * @internal
 */
export function createAchievement<T = unknown>(options: AchievementOptions<T>): Achievement<T> {
  const {
    id,
    display,
    requirement,
    effect,
    hidden,
    visible,
    image,
    small,
    onComplete,
    showPopup = true,
  } = options;

  // Compose the ambient context with this achievement's id so save keys carry
  // the parent scope (the category's `${categoryId}/${def.id}`, matching every
  // sibling) while staying unique. A flat `achievement:${id}` dropped the scope
  // (two categories reusing a def id collided); collapsing onto the bare parent
  // instead collides when several achievements share one context. Mirrors
  // category-base / timed-progress `${parent}/${local}` nesting.
  const parent = getCurrentContext();
  const contextId = parent ? `${parent}/achievement:${id}` : `achievement:${id}`;
  const { earned, earnedAt } = withPersistentContext(contextId, () => ({
    earned: persistent<boolean>(false, { name: 'earned' }),
    earnedAt: persistent<number | null>(null, { name: 'earnedAt' }),
  }));

  const processedHidden = hidden !== undefined ? processGetter(hidden) : undefined;
  const processedVisible = visible !== undefined ? processGetter(visible) : undefined;
  const processedImage = image !== undefined ? processGetter(image) : undefined;
  const processedSmall = small !== undefined ? processGetter(small) : undefined;
  const processedEffect = effect !== undefined ? processGetter(effect) : undefined;

  // Gate-form requirements: capture the spec on the instance for predictor use,
  // and project to a reactive boolean via evaluateGate over the ambient runtime
  // (resolved at construction time so the watcher's later fires don't rely on
  // ambient still being set).
  let gateField: Gate | undefined;
  let processedRequirement: ReturnType<typeof processGetter<boolean>> | undefined;
  if (requirement !== undefined) {
    if (isGate(requirement)) {
      gateField = requirement;
      const runtime = getAmbientGateRuntime();
      processedRequirement = computed(() => evaluateGate(requirement, runtime));
    } else {
      processedRequirement = processGetter(requirement);
    }
  }

  const hiddenRef = computed(() =>
    processedHidden !== undefined ? unref(processedHidden) : false,
  );
  const visibleRef = computed(() =>
    processedVisible !== undefined ? unref(processedVisible) : true,
  );
  const imageRef = processedImage !== undefined ? computed(() => unref(processedImage)) : undefined;
  const smallRef = computed(() => (processedSmall !== undefined ? unref(processedSmall) : false));
  const effectRef =
    processedEffect !== undefined ? computed(() => unref(processedEffect)) : undefined;

  const canComplete = computed(() => {
    if (earned.value) return false;
    if (processedRequirement === undefined) return true;

    return unref(processedRequirement);
  });

  const handle = createEmitHandle<AchievementEvents>();

  const achievement: Achievement<T> = {
    id,
    display,
    gate: gateField,
    earned,
    earnedAt,
    effect: effectRef,
    hidden: hiddenRef,
    visible: visibleRef,
    image: imageRef,
    small: smallRef,
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

  if (requirement !== undefined) {
    // flush: 'sync' so achievements earn on the same tick their requirement
    // first holds true, even under sim harnesses driving stepOnce() in a
    // tight loop where Vue's async scheduler never flushes.
    watch(
      canComplete,
      (canNow) => {
        if (canNow && !earned.value) {
          achievement.complete();
        }
      },
      { immediate: true, flush: 'sync' },
    );
  }

  return achievement;
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
