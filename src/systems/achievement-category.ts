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
import {
  setupDeclarativeBindings,
  createCategoryBase,
  type CategoryBase,
  type CategoryEntrySignals,
} from './category-base';
import { type ContentRegistry } from './content-registry';
import { Resettable, type ResettableObject } from './resettable';
import { createAchievement, type Achievement, type AchievementOptions } from './achievement';
import { getCurrentEngineCategories } from './engine-categories';
import type { Grant } from '@/core/modifier';

// === TYPES ===

/** Symbol identifying AchievementCategory features */
export const AchievementCategoryType = Symbol('AchievementCategory');

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
 * An achievement category — batch-registered Achievements with a shared shape.
 *
 * @typeParam Def - Content definition type
 * @typeParam State - Per-instance state type (void if none)
 */
export interface AchievementCategory<
  Def extends { id: string },
  State = void,
> extends ResettableObject {
  /** Feature type discriminator. */
  type: typeof AchievementCategoryType;
  /** Persistence context id this category was constructed under. */
  readonly id: string;
  /** The content registry — mods can call `registry.register()` or `registry.patch()` */
  readonly registry: ContentRegistry<Def>;

  /**
   * Register definitions and create their Achievement instances.
   * Can be called multiple times (base game + mods).
   */
  register(defs: Def | Def[]): void;

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
  const { id, mapAchievement, mapState } = options;

  const base: CategoryBase<Def, Achievement, State> = createCategoryBase({
    id,
    buildInstance: (def) => {
      const { grants, ...opts } = mapAchievement(def);
      const achievement = createAchievement({ ...opts, id: def.id });
      setupDeclarativeBindings(grants, achievement.earned);
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
    type: AchievementCategoryType,
    id: base.id,
    registry: base.registry,
    register: base.register,
    getDef: base.getDef,

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
