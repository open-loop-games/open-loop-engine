/**
 * Achievement system — milestone tracking with auto-unlock and tiered rewards
 *
 * Achievements record once-and-stay-earned progress markers. Each instance
 * carries persistent `earned` + `earnedAt` state, an optional reactive
 * `effect` value granted while earned, and a `requirement` watch that
 * auto-completes the achievement the moment the requirement first holds.
 *
 * Factories:
 * - {@link createAchievement} — full-control factory with arbitrary requirement and effect
 * - {@link createSimpleAchievement} — positional shorthand for "earn when this boolean ref is true"
 * - {@link createTieredAchievement} — fan a single value-getter into N threshold-gated tiers
 *
 * Aggregator helpers ({@link getCombinedAchievementEffect} multiplicative)
 * live alongside the factory. {@link getVisibleAchievements} applies the
 * hidden+visible filter for tile rendering; {@link getEarnedCount} returns
 * a reactive count of earned achievements in a list.
 *
 * Batch-registration over a content registry lives in
 * `./achievement-category` ({@link createAchievementCategory}).
 *
 * Pattern reference:
 * `open-loop-research/patterns/tier-1-foundation/achievement-systems.md`.
 */

import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { computed, type Ref, unref, watch } from 'vue';
import { processGetter, type Computable } from '@/core/computed';
import { persistent, withPersistentContext } from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { isType } from '@/core/feature';
import Formula from '@/core/formulas/formulas';
import type { FormulaSource } from '@/core/formulas/types';
import { evaluateGate, getAmbientGateRuntime, isGate, type Gate } from './gate';

// === TYPES ===

/** Symbol to identify Achievement features */
export const AchievementType = Symbol('Achievement');

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
  type: typeof AchievementType;
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

/** Options for {@link createTieredAchievement} */
export interface TieredAchievementOptions<T = number> {
  /** Prefix for generated achievement IDs (e.g. `"gold-hoarder"` → `"gold-hoarder-1"`) */
  baseId: string;
  /** Display name prefix shared by all tiers */
  baseName: string;
  /** Reactive getter for the tracked value compared against each tier's threshold */
  getValue: () => DecimalSource;
  /** Ordered list of thresholds, each producing one achievement */
  tiers: Array<{
    /**
     * The value `getValue()` must reach to earn this tier.
     *
     * Accepts a plain `DecimalSource` for static thresholds or a
     * {@link FormulaSource} for dynamic thresholds that scale with other game
     * state (e.g. prestige count, unlock progression). Formula thresholds are
     * re-evaluated each time the tier is checked.
     */
    threshold: DecimalSource | FormulaSource;
    /** Appended to `baseName` for this tier's display title (e.g. `"I"`, `"II"`) */
    suffix: string;
    /** Override the auto-generated description for this tier */
    description?: string;
    /** Bonus value applied when this tier is earned */
    effect?: T;
  }>;
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
 * Create an achievement — a once-and-stay-earned milestone with optional
 * reactive effect and auto-completing requirement watch.
 *
 * @param options - {@link AchievementOptions} for display, requirement, effect, and visibility
 * @returns Achievement instance with persistent `earned`/`earnedAt` refs, a
 *   reactive `effect` (when configured), `complete()`, `canComplete`, and an
 *   `on('earned')` event subscription
 *
 * @example
 * ```ts
 * const gold = ref(new Decimal(0));
 *
 * const richMilestone = createAchievement({
 *   id: 'first-million',
 *   display: {
 *     title: 'Millionaire',
 *     description: 'Reach 1M gold',
 *     effectDescription: '+10% gold gain',
 *   },
 *   requirement: () => Decimal.gte(gold.value, 1e6),
 *   effect: 1.1,
 * });
 *
 * richMilestone.on('earned', () => console.log('Millionaire unlocked'));
 * ```
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

  const { earned, earnedAt } = withPersistentContext(`achievement:${id}`, () => ({
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
    processedEffect !== undefined ? computed(() => unref(processedEffect) as T) : undefined;

  const canComplete = computed(() => {
    if (earned.value) return false;
    if (processedRequirement === undefined) return true;

    return unref(processedRequirement);
  });

  const handle = createEmitHandle<AchievementEvents>();

  const achievement: Achievement<T> = {
    type: AchievementType,
    id,
    display,
    gate: gateField,
    earned,
    earnedAt,
    effect: effectRef as Ref<T> | undefined,
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

/**
 * Positional shorthand over {@link createAchievement} for the common case of
 * a one-line title + description and a single boolean requirement. Equivalent
 * to calling `createAchievement({ id, display: { title, description },
 * requirement, effect })`.
 *
 * @param id - Unique identifier; also the persistence sub-context name
 * @param title - Display title shown on the tile
 * @param description - Flavour text or requirement hint
 * @param requirement - Boolean ref or getter; achievement auto-earns when true
 * @param effect - Optional reactive bonus value while earned
 * @returns The created Achievement instance
 *
 * @example
 * ```ts
 * const firstClick = createSimpleAchievement(
 *   'first-click',
 *   'First Click',
 *   'Click anything once',
 *   () => totalClicks.value >= 1,
 * );
 * ```
 */
export function createSimpleAchievement<T = unknown>(
  id: string,
  title: string,
  description: string,
  requirement: Computable<boolean> | Gate,
  effect?: T,
): Achievement<T> {
  return createAchievement({
    id,
    display: { title, description },
    requirement,
    effect,
  });
}

/**
 * Creates a series of achievements from threshold tiers, each auto-wired to
 * complete when `getValue()` reaches its tier's threshold.
 *
 * @param options - Base ID/name, a reactive value getter, and an array of tiers
 *   with thresholds, name suffixes, and optional effects
 * @returns An array of Achievement instances, one per tier, with IDs like
 *   `"${baseId}-1"`, `"${baseId}-2"`, etc.
 *
 * @example
 * ```ts
 * const goldAchievements = createTieredAchievement({
 *   baseId: 'gold-hoarder',
 *   baseName: 'Gold Hoarder',
 *   getValue: () => gold.value,
 *   tiers: [
 *     { threshold: 100, suffix: 'I' },
 *     { threshold: 1000, suffix: 'II', effect: 1.1 },
 *     { threshold: 1e6, suffix: 'III', effect: 1.5 },
 *   ],
 * });
 * ```
 */
export function createTieredAchievement<T = number>(
  options: TieredAchievementOptions<T>,
): Achievement<T>[] {
  const { baseId, baseName, getValue, tiers } = options;

  return tiers.map((tier, index) => {
    const isFormulaThreshold = tier.threshold instanceof Formula;
    const evalThreshold = (): DecimalSource =>
      isFormulaThreshold
        ? (tier.threshold as InstanceType<typeof Formula>).evaluate()
        : (tier.threshold as DecimalSource);
    // For display, use the current value (static literal or Formula snapshot at registration time).
    const formatted = formatThreshold(new Decimal(evalThreshold()));

    return createAchievement<T>({
      id: `${baseId}-${index + 1}`,
      display: {
        title: `${baseName} ${tier.suffix}`,
        description: tier.description ?? `Reach ${formatted}`,
      },
      requirement: () => Decimal.gte(getValue(), evalThreshold()),
      effect: tier.effect,
    });
  }) as Achievement<T>[];
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

/** Type guard for {@link Achievement} instances created by {@link createAchievement}. */
export function isAchievement(value: unknown): value is Achievement {
  return isType(value, AchievementType);
}

/**
 * Filter a list to the achievements that should be rendered in the UI.
 * Honours each entry's reactive `hidden` (suppress until earned) and
 * `visible` (suppress unconditionally) flags.
 */
export function getVisibleAchievements(achievements: Achievement[]): Achievement[] {
  return achievements.filter((a) => {
    if (a.earned.value) return a.visible.value;
    if (a.hidden.value) return false;
    return a.visible.value;
  });
}

// === INTERNAL HELPERS ===

/**
 * Format a {@link createTieredAchievement} threshold for display: exponential
 * for values ≥ 1e9, `"X.YM"` ≥ 1e6, `"X.YK"` ≥ 1e3, integer otherwise.
 */
function formatThreshold(value: Decimal): string {
  if (value.gte(1e9)) {
    return value.toExponential(2);
  } else if (value.gte(1e6)) {
    return (value.toNumber() / 1e6).toFixed(1) + 'M';
  } else if (value.gte(1e3)) {
    return (value.toNumber() / 1e3).toFixed(1) + 'K';
  }
  return value.toFixed(0);
}
