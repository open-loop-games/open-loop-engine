/**
 * Achievement Category — batch-create Achievements from defs
 *
 * Games often have many achievements that share a structure: a goal to
 * check, display text, and optional effect values.
 * `createAchievementCategory` captures this shape with a content registry
 * and batch registration.
 *
 * Automatic completion is built into `createAchievement` through a Vue `watch`
 * on the goal, so no tick polling is needed.
 *
 * @example
 * ```ts
 * interface PointsAchievementDef { id: string; name: string; threshold: number }
 *
 * const achievements = createAchievementCategory<PointsAchievementDef>({
 *   id: 'achievements',
 *   mapAchievement: (def) => ({
 *     display: { title: def.name, description: `Reach ${def.threshold}` },
 *     goal: computed(() => Decimal.gte(points.value, def.threshold)),
 *   }),
 * });
 *
 * achievements.register(ACHIEVEMENT_DEFS);
 *
 * // Access
 * achievements.getAchievement('first-100');   // Achievement instance
 * achievements.earnedCount.value;             // reactive count
 * achievements.allEarned.value;               // true when all earned
 * ```
 *
 * @cluster achievement
 */

import { computed, type ComputedRef } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import Formula from '@/core/formulas/formulas';
import type { FormulaSource } from '@/core/formulas/types';
import {
  setupDeclarativeBindings,
  createCategoryBase,
  type CategoryBase,
  type CategoryEntrySignals,
} from './category-base';
import { type ContentRegistryView } from './content-registry';
import { Resettable, type ResettableObject } from '@/core/resettable';
import { createAchievement, type Achievement, type AchievementOptions } from './achievement';
import { getCurrentEngineCategories } from './engine-categories';
import { createPredicateResolver } from './gate';
import type { Grant } from '@/core/modifier';
import type { GameStateAccessor } from '@/primitives/types';

// === TYPES ===

/**
 * Options for {@link createAchievementCategory}.
 *
 * @typeParam Def - The def type (must have `id: string`)
 * @typeParam DefState - Def state created beside each Achievement.
 *   Use `void` if no def state is needed.
 */
export interface AchievementCategoryOptions<Def extends { id: string }, DefState = void> {
  /** Persistent context id. Each def gets a child persistent context `{id}/{def.id}`. */
  id: string;

  /**
   * The accessor Gate-form goals read through. Falls back to the ambient
   * accessor `createEngine` sets. The category captures the Gate services
   * (accessor, categories, resource registry) once, at construction. So
   * achievements registered after install evaluate against them too.
   */
  accessor?: GameStateAccessor;

  /**
   * Map a def to AchievementOptions.
   *
   * Called once per def during {@link AchievementCategory.register}.
   * The returned options are passed to `createAchievement()`.
   *
   * Note: `id` is provided by the category — don't include it in the
   * returned options (it will be overwritten).
   *
   * The optional `grants` field declares modifiers that bind to shared chains
   * while the achievement is `earned`. Each {@link Grant} becomes a
   * `chain.bind` call with the achievement's `earned` as its `active`
   * predicate. So `chain.bindings()` shows the binding to the balance harness.
   */
  mapAchievement: (def: Def) => Omit<AchievementOptions, 'id'> & { grants?: Grant[] };

  /**
   * Create the def state beside the Achievement.
   *
   * Called inside the def's persistent context, so `persistent()` calls
   * here save under `{categoryId}/{def.id}`.
   *
   * Omit if no def state is needed.
   */
  mapState?: (def: Def, achievement: Achievement) => DefState;
}

/** A category entry: def, Achievement instance, def state and signals */
export interface AchievementCategoryEntry<Def extends { id: string }, DefState = void> {
  readonly def: Def;
  readonly achievement: Achievement;
  readonly state: DefState;
  readonly signals: CategoryEntrySignals;
}

/**
 * Minimum Def shape that {@link AchievementCategory.registerLadder}'s default
 * `buildDef` can synthesize without a consumer callback. Extend this when
 * authoring a Def type that takes part in ladder registration but has no
 * consumer-specific fields beyond the base authoring contract.
 *
 * @typeParam T - Type of the rung's `effect` value
 */
export interface BaseLadderAchievementDef<T = unknown> {
  id: string;
  title: string;
  description: string;
  goal: () => boolean;
  /** The rung's {@link AchievementRung.effect}, for `mapAchievement` to forward. */
  effect?: T;
}

/**
 * One rung of an {@link AchievementLadderOptions}. Each rung becomes one
 * Achievement registered into the category.
 */
export interface AchievementRung<T = number> {
  /**
   * The value `getValue()` must reach to earn this rung.
   *
   * Accepts a plain `DecimalSource` for a static threshold, or a
   * {@link FormulaSource} for a threshold that scales with other game
   * state. A Formula threshold is re-evaluated each time the rung is checked;
   * the default description formats the threshold once, at registration.
   */
  threshold: DecimalSource | FormulaSource;
  /** Appended to `baseName` for this rung's display title (e.g. `"I"`, `"II"`). */
  suffix: string;
  /** Override the auto-generated description for this rung. */
  description?: string;
  /** Effect value that applies once this rung is earned. */
  effect?: T;
}

/**
 * Options for {@link AchievementCategory.registerLadder}. Fans a single
 * value-getter into N achievements, each blocked by a threshold and
 * registered into the category through the standard `register()` path.
 */
export interface AchievementLadderBaseOptions<T = number> {
  /** Prefix for generated achievement ids (e.g. `"gold-hoarder"` → `"gold-hoarder-1"`). */
  baseId: string;
  /** Display name prefix shared by all rungs. */
  baseName: string;
  /** Reactive getter for the tracked value compared against each rung's threshold. */
  getValue: () => DecimalSource;
  /** Ordered list of thresholds, each producing one achievement. */
  rungs: ReadonlyArray<AchievementRung<T>>;
}

/**
 * Parameters passed to a {@link AchievementLadderOptions.buildDef} callback.
 * The base authoring fields (`id`/`title`/`description`/`goal`) are
 * synthesized from the rung; rung metadata (`rungIndex`, `rung`) is
 * available for consumer Def fields that need it.
 */
export interface AchievementLadderBuildDefParams<T = number> {
  id: string;
  title: string;
  description: string;
  goal: () => boolean;
  rungIndex: number;
  rung: AchievementRung<T>;
}

/**
 * `buildDef` callback type for the `registerLadder` options. Required when the
 * category's `Def` has required fields beyond
 * {@link BaseLadderAchievementDef}; optional when `Def` is the base shape
 * (default builds a base-shape Def).
 */
export type AchievementLadderBuildDef<Def, T = number> = (
  params: AchievementLadderBuildDefParams<T>,
) => Def;

/**
 * `registerLadder` parameter type. Contains the ladder options plus a `buildDef`
 * that is *optional* (default = identity over base fields) only when `Def` is
 * the base shape, and *required* the moment `Def` widens beyond
 * {@link BaseLadderAchievementDef}.
 *
 * The test is mutual assignability, not one-way `extends`: a superset Def
 * still satisfies `Def extends Base`. So a one-way test leaves the callback
 * optional for a Def with required fields the default synthesizer
 * cannot populate. They are `undefined` on every rung with no type
 * error, and the failure only appears when a rung is earned. A Def whose
 * extra fields are all optional stays on the optional branch, since nothing
 * is lost by omitting the callback.
 *
 * Known gap: a union Def with one widened member (`Base | Widened`) keeps
 * the optional form, because `Base` is assignable to the union. Defeating
 * distributivity does not close it — assignability holds either way.
 */
export type AchievementLadderOptions<Def, T = number> = AchievementLadderBaseOptions<T> &
  (Def extends BaseLadderAchievementDef
    ? BaseLadderAchievementDef<T> extends Def
      ? { buildDef?: AchievementLadderBuildDef<Def, T> }
      : { buildDef: AchievementLadderBuildDef<Def, T> }
    : { buildDef: AchievementLadderBuildDef<Def, T> });

/**
 * An achievement category — batch-registered Achievements with a shared shape.
 *
 * @typeParam Def - The def type
 * @typeParam DefState - The def state type (void if none)
 */
export interface AchievementCategory<
  Def extends { id: string },
  DefState = void,
> extends ResettableObject {
  /** Persistent context id this category was built under. */
  readonly id: string;
  /**
   * The content registry (see {@link ContentRegistryView} for what a patch
   * reaches). Add defs with the category's `register`, which builds each
   * def's instance and def state.
   */
  readonly registry: ContentRegistryView<Def>;

  /**
   * Register defs and create their Achievement instances.
   * Can be called more than once (base game, then a mod's content).
   */
  register(defs: Def | Def[]): void;

  /**
   * Fan a single value-getter into N achievements, each blocked by a
   * threshold and registered into this category through the standard
   * `register()` path.
   *
   * Each rung becomes one `Def` (through the options' `buildDef`, or a default
   * identity over `{id, title, description, goal, effect}` when the
   * category's `Def` is the base shape). The category's `mapAchievement`
   * must forward `goal` and `effect`, or the rungs are never earned and
   * have no effect value. The resulting achievements appear in `getAll()`,
   * `registry`, reset traversal, and EngineCategories walks just like other
   * category entries.
   *
   * @returns The rung achievements in rung order, ready to pass on
   *   directly without querying again: e.g. `getEarnedCount(ladder)`, where
   *   `ladder` is the returned array.
   */
  registerLadder<T = number>(options: AchievementLadderOptions<Def, T>): Achievement<T>[];

  /** Get the Achievement instance for a def id */
  getAchievement(id: string): Achievement | undefined;

  /** Get the def state for a def id */
  getState(id: string): DefState | undefined;

  /** Get the def for an id (delegates to registry.get) */
  getDef(id: string): Def | undefined;

  /** Get the category entry (def, achievement, def state, signals) */
  getEntry(id: string): AchievementCategoryEntry<Def, DefState> | undefined;

  /** All category entries in registration order */
  getAll(): AchievementCategoryEntry<Def, DefState>[];

  /** Reactive count of earned achievements */
  readonly earnedCount: ComputedRef<number>;

  /** `true` when all registered achievements have been earned */
  readonly allEarned: ComputedRef<boolean>;

  /** Number of registered entries */
  readonly size: number;
}

// === FACTORIES ===

/**
 * Create an achievement category — batch registration of Achievements from defs.
 *
 * @param options - Category id and `mapAchievement`
 * @returns An {@link AchievementCategory} with registry, lookup, and earned counts
 *
 * @example
 * ```ts
 * const achievements = createAchievementCategory<AchDef>({
 *   id: 'achievements',
 *   mapAchievement: (def) => ({
 *     display: { title: def.name, description: def.desc },
 *     goal: computed(() => checkCondition(def)),
 *     onComplete: () => grantReward(def),
 *   }),
 * });
 *
 * achievements.register(ACHIEVEMENT_DEFS);
 * achievements.earnedCount.value; // reactive
 * ```
 */
export function createAchievementCategory<Def extends { id: string }, DefState = void>(
  options: AchievementCategoryOptions<Def, DefState>,
): AchievementCategory<Def, DefState> {
  const { id, accessor, mapAchievement, mapState } = options;
  const predicates = createPredicateResolver({ accessor });

  const base: CategoryBase<Def, Achievement, DefState> = createCategoryBase({
    id,
    buildInstance: (def) => {
      const { grants, ...opts } = mapAchievement(def);
      const achievement = createAchievement({ ...opts, id: def.id }, predicates);
      setupDeclarativeBindings(grants, achievement.earned, predicates, `achievement '${def.id}'`);
      return achievement;
    },
    buildState: mapState,
    buildSignals: (_def, achievement) => ({
      active: computed(() => achievement.earned.value),
      count: computed(() => (achievement.earned.value ? 1 : 0)),
    }),
  });

  const earnedCount = computed(() => {
    return base.getAll().filter((e) => e.instance.earned.value).length;
  });

  const allEarned = computed(() => {
    const all = base.getAll();
    return all.length > 0 && all.every((e) => e.instance.earned.value);
  });

  const category: AchievementCategory<Def, DefState> = {
    id: base.id,
    registry: base.registry,
    register: base.register,
    getDef: base.getDef,

    registerLadder<T = number>(spec: AchievementLadderOptions<Def, T>): Achievement<T>[] {
      const { baseId, baseName, getValue, rungs } = spec;
      const buildDef = (spec as { buildDef?: AchievementLadderBuildDef<Def, T> }).buildDef;

      const defs: Def[] = [];
      for (let index = 0; index < rungs.length; index++) {
        const rung = rungs[index];
        const rungId = `${baseId}-${index + 1}`;
        const isFormulaThreshold = rung.threshold instanceof Formula;
        const evalThreshold = (): DecimalSource =>
          isFormulaThreshold
            ? (rung.threshold as InstanceType<typeof Formula>).evaluate()
            : (rung.threshold as DecimalSource);
        const formatted = formatThreshold(new Decimal(evalThreshold()));

        const params: AchievementLadderBuildDefParams<T> = {
          id: rungId,
          title: `${baseName} ${rung.suffix}`,
          description: rung.description ?? `Reach ${formatted}`,
          goal: () => Decimal.gte(getValue(), evalThreshold()),
          rungIndex: index,
          rung,
        };

        const def = buildDef
          ? buildDef(params)
          : ({
              id: params.id,
              title: params.title,
              description: params.description,
              goal: params.goal,
              effect: rung.effect,
            } as unknown as Def);
        defs.push(def);
      }

      base.register(defs);

      return defs.map((d) => base.getEntry(d.id)!.instance) as Achievement<T>[];
    },

    getAchievement(id: string): Achievement | undefined {
      return base.getEntry(id)?.instance;
    },

    getState(id: string): DefState | undefined {
      return base.getEntry(id)?.state;
    },

    getEntry(id: string): AchievementCategoryEntry<Def, DefState> | undefined {
      const entry = base.getEntry(id);
      if (!entry) return undefined;
      return {
        def: entry.def,
        achievement: entry.instance,
        state: entry.state,
        signals: entry.signals!,
      };
    },

    getAll(): AchievementCategoryEntry<Def, DefState>[] {
      return base.getAll().map((e) => ({
        def: e.def,
        achievement: e.instance,
        state: e.state,
        signals: e.signals!,
      }));
    },

    earnedCount,
    allEarned,

    get size(): number {
      return base.size;
    },

    [Resettable]: base[Resettable],
  };

  const ec = getCurrentEngineCategories();
  if (ec) (ec.achievements ??= []).push(category);

  return category;
}

// === INTERNAL HELPERS ===

/**
 * Format an {@link AchievementRung} threshold for the default rung
 * description: exponential for values ≥ 1e9, `"X.YM"` ≥ 1e6, `"X.YK"`
 * ≥ 1e3, integer otherwise.
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
