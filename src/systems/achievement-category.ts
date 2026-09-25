/**
 * Achievement Category — batch-create Achievements from content definitions
 *
 * Games commonly have dozens to hundreds of achievements sharing a common
 * structure: a condition to check, display info, and optional rewards.
 * `createAchievementCategory` captures this pattern with a content registry
 * and batch registration.
 *
 * The auto-complete mechanism is built into `createAchievement` via Vue `watch`
 * on the requirement — no tick-based polling needed.
 *
 * @example
 * ```ts
 * interface MilestoneDef { id: string; name: string; threshold: number }
 *
 * const milestones = createAchievementCategory<MilestoneDef>({
 *   id: 'milestones',
 *   mapAchievement: (def) => ({
 *     display: { title: def.name, description: `Reach ${def.threshold}` },
 *     requirement: computed(() => Decimal.gte(points.value, def.threshold)),
 *   }),
 * });
 *
 * milestones.register(MILESTONE_DEFS);
 *
 * // Access
 * milestones.getAchievement('first-100');   // Achievement instance
 * milestones.earnedCount.value;             // reactive count
 * milestones.allEarned.value;               // true when all earned
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
import { Resettable, type ResettableObject } from './resettable';
import { createAchievement, type Achievement, type AchievementOptions } from './achievement';
import { getCurrentEngineCategories } from './engine-categories';
import { createPredicateResolver } from './gate';
import type { Grant } from '@/core/modifier';
import type { GameStateAccessor } from '@/primitives/types';

// === TYPES ===

/**
 * Options for {@link createAchievementCategory}.
 *
 * @typeParam Def - The content definition type (must have `id: string`)
 * @typeParam State - Per-instance state created alongside each Achievement.
 *   Use `void` if no extra state is needed.
 */
export interface AchievementCategoryOptions<Def extends { id: string }, State = void> {
  /** Persistence context name. Each definition gets a sub-context `{id}/{def.id}`. */
  id: string;

  /**
   * Accessor Gate-form requirements read through. Falls back to the ambient
   * accessor wired by `createEngine`. The category captures the Gate runtime
   * (accessor + categories + registry) once, at construction, so
   * achievements registered after install evaluate against it too.
   */
  accessor?: GameStateAccessor;

  /**
   * Map a content definition to AchievementOptions.
   *
   * Called once per definition during {@link AchievementCategory.register}.
   * The returned options are passed to `createAchievement()`.
   *
   * Note: `id` is provided by the category — don't include it in the
   * returned options (it will be overwritten).
   *
   * The optional `grants` field declares modifiers that bind to shared chains
   * while the achievement is `earned`. Each {@link Grant} is lowered to a
   * `chain.bind` call with `item.earned` as the implicit `active` predicate,
   * surfacing the contribution through `chain.bindings()` for balance-sim.
   */
  mapAchievement: (def: Def) => Omit<AchievementOptions, 'id'> & { grants?: Grant[] };

  /**
   * Create per-instance state alongside the Achievement.
   *
   * Called inside the definition's persistent context, so `persistent()` calls
   * here are scoped to `{categoryId}/{def.id}`.
   *
   * Omit if no extra state is needed.
   */
  mapState?: (def: Def, achievement: Achievement) => State;
}

/** A registered entry: definition + Achievement instance + optional state + introspection signals */
export interface AchievementCategoryEntry<Def extends { id: string }, State = void> {
  readonly def: Def;
  readonly achievement: Achievement;
  readonly state: State;
  readonly signals: CategoryEntrySignals;
}

/**
 * Minimum Def shape that {@link AchievementCategory.registerTiered}'s default
 * `buildDef` can synthesize without a consumer callback. Extend this when
 * authoring a Def type that participates in tier registration but doesn't
 * carry consumer-specific fields beyond the base authoring contract.
 *
 * @typeParam T - Type of the tier's `effect` value
 */
export interface BaseTieredAchievementDef<T = unknown> {
  id: string;
  title: string;
  description: string;
  requirement: () => boolean;
  /** The tier's {@link TieredAchievementTier.effect}, for `mapAchievement` to forward. */
  effect?: T;
}

/**
 * One tier in a {@link TieredAchievementSpec}. Each tier becomes one
 * Achievement registered into the category.
 */
export interface TieredAchievementTier<T = number> {
  /**
   * The value `getValue()` must reach to earn this tier.
   *
   * Accepts a plain `DecimalSource` for static thresholds or a
   * {@link FormulaSource} for dynamic thresholds that scale with other game
   * state. Formula thresholds are re-evaluated each time the tier is checked;
   * the default description formats the threshold once, at registration.
   */
  threshold: DecimalSource | FormulaSource;
  /** Appended to `baseName` for this tier's display title (e.g. `"I"`, `"II"`). */
  suffix: string;
  /** Override the auto-generated description for this tier. */
  description?: string;
  /** Bonus value applied when this tier is earned. */
  effect?: T;
}

/**
 * Spec for {@link AchievementCategory.registerTiered}. Fans a single
 * value-getter into N threshold-gated achievements, each registered into the
 * category via the standard `register()` path.
 */
export interface TieredAchievementBaseSpec<T = number> {
  /** Prefix for generated achievement IDs (e.g. `"gold-hoarder"` → `"gold-hoarder-1"`). */
  baseId: string;
  /** Display name prefix shared by all tiers. */
  baseName: string;
  /** Reactive getter for the tracked value compared against each tier's threshold. */
  getValue: () => DecimalSource;
  /** Ordered list of thresholds, each producing one achievement. */
  tiers: ReadonlyArray<TieredAchievementTier<T>>;
}

/**
 * Parameters passed to a {@link TieredAchievementSpec.buildDef} callback.
 * The base authoring fields (`id`/`title`/`description`/`requirement`) are
 * synthesized from the tier spec; tier metadata (`tierIndex`, `tier`) is
 * available for consumer Def fields that need it.
 */
export interface TieredAchievementBuildDefParams<T = number> {
  id: string;
  title: string;
  description: string;
  requirement: () => boolean;
  tierIndex: number;
  tier: TieredAchievementTier<T>;
}

/**
 * `buildDef` callback type for the `registerTiered` spec. Required when the
 * category's `Def` carries required fields beyond
 * {@link BaseTieredAchievementDef}; optional when `Def` is the base shape
 * (default builds a base-shape Def).
 */
export type TieredAchievementBuildDef<Def, T = number> = (
  params: TieredAchievementBuildDefParams<T>,
) => Def;

/**
 * `registerTiered` parameter type. Carries the spec plus a `buildDef` that
 * is *optional* (default = identity over base fields) only when `Def` is
 * the base shape, and *required* the moment `Def` widens beyond
 * {@link BaseTieredAchievementDef}.
 *
 * The test is mutual assignability, not one-way `extends`: a superset Def
 * still satisfies `Def extends Base`, so a one-way test leaves the callback
 * optional for a Def carrying required fields the default synthesizer
 * cannot populate — they resolve to `undefined` on every tier with no type
 * error, and the failure only surfaces when a tier is earned. A Def whose
 * extra fields are all optional stays on the optional branch, since nothing
 * is lost by omitting the callback.
 *
 * Known gap: a union Def with one widened member (`Base | Widened`) keeps
 * the optional form, because `Base` is assignable to the union. Defeating
 * distributivity does not close it — assignability holds either way.
 */
export type TieredAchievementSpec<Def, T = number> = TieredAchievementBaseSpec<T> &
  (Def extends BaseTieredAchievementDef
    ? BaseTieredAchievementDef<T> extends Def
      ? { buildDef?: TieredAchievementBuildDef<Def, T> }
      : { buildDef: TieredAchievementBuildDef<Def, T> }
    : { buildDef: TieredAchievementBuildDef<Def, T> });

/**
 * An achievement category — batch-registered Achievements with a shared shape.
 *
 * @typeParam Def - Content definition type
 * @typeParam State - Per-instance state type (void if none)
 */
export interface AchievementCategory<
  Def extends { id: string },
  State = void,
> extends ResettableObject {
  /** Persistence context id this category was constructed under. */
  readonly id: string;
  /**
   * The content registry. `registry.patch()` / `pushPatches()` change the def;
   * an instance sees the change only through a getter that reads `getDef(id)`
   * or `registry.get(id)`, since value fields and closures over `def` are
   * copied or frozen at register. The view has no `register`: add defs with the
   * category's `register`, which builds each def's instance and state.
   */
  readonly registry: ContentRegistryView<Def>;

  /**
   * Register definitions and create their Achievement instances.
   * Can be called multiple times (base game + mods).
   */
  register(defs: Def | Def[]): void;

  /**
   * Fan a single value-getter into N threshold-gated achievements, each
   * registered into this category through the standard `register()` path.
   *
   * Each tier becomes one `Def` (via the spec's `buildDef`, or a default
   * identity over `{id, title, description, requirement, effect}` when the
   * category's `Def` is the base shape). The category's `mapAchievement`
   * must forward `requirement` and `effect`, or the tiers never earn and
   * carry no bonus. The resulting achievements appear in `getAll()`,
   * `registry`, reset traversal, and EngineCategories walks just like normal
   * entries.
   *
   * @returns The tier achievements in tier order, suitable for binding
   *   directly (e.g. `getEarnedCount(tiers)`) without re-querying.
   */
  registerTiered<T = number>(spec: TieredAchievementSpec<Def, T>): Achievement<T>[];

  /** Get the Achievement instance for a definition ID */
  getAchievement(id: string): Achievement | undefined;

  /** Get the per-instance state for a definition ID */
  getState(id: string): State | undefined;

  /** Get the definition for an ID (delegates to registry.get) */
  getDef(id: string): Def | undefined;

  /** Get the full entry (def + achievement + state) */
  getEntry(id: string): AchievementCategoryEntry<Def, State> | undefined;

  /** All entries in registration order */
  getAll(): AchievementCategoryEntry<Def, State>[];

  /** Reactive count of earned achievements */
  readonly earnedCount: ComputedRef<number>;

  /** Total number of registered achievements */
  readonly totalCount: number;

  /** True when all registered achievements have been earned */
  readonly allEarned: ComputedRef<boolean>;

  /** Number of registered entries */
  readonly size: number;
}

// === FACTORIES ===

/**
 * Create an achievement category — batch registration of Achievements from definitions.
 *
 * @param options - Category ID and mapping function
 * @returns An {@link AchievementCategory} with registry, lookup, and aggregate tracking
 *
 * @example
 * ```ts
 * const achievements = createAchievementCategory<AchDef>({
 *   id: 'achievements',
 *   mapAchievement: (def) => ({
 *     display: { title: def.name, description: def.desc },
 *     requirement: computed(() => checkCondition(def)),
 *     onComplete: () => grantReward(def),
 *   }),
 * });
 *
 * achievements.register(ACHIEVEMENT_DEFS);
 * achievements.earnedCount.value; // reactive
 * ```
 */
export function createAchievementCategory<Def extends { id: string }, State = void>(
  options: AchievementCategoryOptions<Def, State>,
): AchievementCategory<Def, State> {
  const { id, accessor, mapAchievement, mapState } = options;
  const predicates = createPredicateResolver(accessor ? { accessor } : undefined);

  const base: CategoryBase<Def, Achievement, State> = createCategoryBase({
    id,
    buildInstance: (def) => {
      const { grants, ...opts } = mapAchievement(def);
      const achievement = createAchievement({ ...opts, id: def.id }, predicates);
      setupDeclarativeBindings(grants, achievement.earned, predicates);
      return achievement;
    },
    buildState: mapState,
    buildSignals: (_def, achievement) => ({
      unlock: computed(() => achievement.earned.value),
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

  const category: AchievementCategory<Def, State> = {
    id: base.id,
    registry: base.registry,
    register: base.register,
    getDef: base.getDef,

    registerTiered<T = number>(spec: TieredAchievementSpec<Def, T>): Achievement<T>[] {
      const { baseId, baseName, getValue, tiers } = spec;
      const buildDef = (spec as { buildDef?: TieredAchievementBuildDef<Def, T> }).buildDef;

      const defs: Def[] = [];
      for (let index = 0; index < tiers.length; index++) {
        const tier = tiers[index];
        const tierId = `${baseId}-${index + 1}`;
        const isFormulaThreshold = tier.threshold instanceof Formula;
        const evalThreshold = (): DecimalSource =>
          isFormulaThreshold
            ? (tier.threshold as InstanceType<typeof Formula>).evaluate()
            : (tier.threshold as DecimalSource);
        const formatted = formatThreshold(new Decimal(evalThreshold()));

        const params: TieredAchievementBuildDefParams<T> = {
          id: tierId,
          title: `${baseName} ${tier.suffix}`,
          description: tier.description ?? `Reach ${formatted}`,
          requirement: () => Decimal.gte(getValue(), evalThreshold()),
          tierIndex: index,
          tier,
        };

        const def = buildDef
          ? buildDef(params)
          : ({
              id: params.id,
              title: params.title,
              description: params.description,
              requirement: params.requirement,
              effect: tier.effect,
            } as unknown as Def);
        defs.push(def);
      }

      base.register(defs);

      return defs.map((d) => base.getEntry(d.id)!.instance) as Achievement<T>[];
    },

    getAchievement(id: string): Achievement | undefined {
      return base.getEntry(id)?.instance;
    },

    getState(id: string): State | undefined {
      return base.getEntry(id)?.state;
    },

    getEntry(id: string): AchievementCategoryEntry<Def, State> | undefined {
      const entry = base.getEntry(id);
      if (!entry) return undefined;
      return {
        def: entry.def,
        achievement: entry.instance,
        state: entry.state,
        signals: entry.signals!,
      };
    },

    getAll(): AchievementCategoryEntry<Def, State>[] {
      return base.getAll().map((e) => ({
        def: e.def,
        achievement: e.instance,
        state: e.state,
        signals: e.signals!,
      }));
    },

    earnedCount,
    get totalCount(): number {
      return base.size;
    },
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
 * Format a {@link TieredAchievementTier} threshold for the default tier
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
