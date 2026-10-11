/**
 * Engine categories — the typed cross-category collection the engine
 * self-publishes for external introspection tools (the picker, devtools,
 * balance workbenches, balance-harness walkers).
 *
 * Problem it solves: without it, every consumer that needs cross-category
 * enumeration writes the same aggregator module. That module injects each
 * owner module's categories and publishes the union by hand. So the engine
 * fills {@link EngineCategories} itself, as `createModifierChain`
 * auto-registers into `ChainRegistry` and `createResource` auto-registers
 * into `ResourceRegistry`.
 *
 * Mechanism: {@link createEngine} creates a per-engine collection, provides
 * it under {@link CategoriesKey} in advance, and sets it as the ambient
 * value during install/connect. Each category factory appends itself to
 * the matching field at construction time. A category built outside an
 * engine (tests, throwaway scripts) skips registration silently. The
 * category still works; `tryInject` just does not find it.
 *
 * The key is engine-owned: `ctx.provide(CategoriesKey, ...)` throws, so
 * tooling, Gates and category factories always share the one collection.
 */

import type { InjectionKey } from '@/primitives/types';
import type { AchievementCategory } from './achievement-category';
import type { ActionCategory } from './action-category';
import type { ChallengeCategory } from './challenge-category';
import type { ProducerCategory } from './producer-category';
import type { PurchasableCategory } from './purchasable-category';
import type { SkillCategory } from './skill-category';
import type { SubjectCategory } from './subject-category';
import type { CategoryEntrySignals } from './category-base';

/**
 * Discovery map for external introspection tools (the balance harness,
 * devtools, balance workbenches). The engine self-publishes this object
 * under {@link CategoriesKey}. Each category factory appends to the
 * matching field at construction time. So a consumer reads every category
 * through `engine.tryInject(CategoriesKey)`, with no publication step of
 * its own.
 *
 * Every field is optional — a field is only present if at least one
 * category of that kind was constructed. A consumer that constructs no
 * categories sees an empty object.
 *
 * Extend via declaration merging when shipping custom category types
 * that shouldn't hide behind `any`. A merged field is for tooling only.
 * {@link findCategoryEntrySignals} walks the built-in fields only. So
 * `count-gte` and `active` Gates never see a category held in a merged one.
 * ```ts
 * declare module '@open-loop/engine' {
 *   interface EngineCategories {
 *     quests?: QuestCategory<any, any>[];
 *   }
 * }
 * ```
 *
 * @see {@link CategoriesKey} — the injection key
 */
export interface EngineCategories {
  /** Purchasable categories (one-shot upgrades and repeatable purchases) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  purchasables?: PurchasableCategory<any, any>[];
  /** Skill/leveling categories */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  skills?: SkillCategory<any, any>[];
  /** Achievement categories */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  achievements?: AchievementCategory<any, any>[];
  /** Challenge categories */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  challenges?: ChallengeCategory<any, any>[];
  /** Producer categories */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  producers?: ProducerCategory<any, any>[];
  /** Subject categories (subjects with typed schema fields — NPCs, factions, regions) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subjects?: SubjectCategory<any>[];
  /** Action categories (ordered-execution queues with per-execution state machine) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions?: ActionCategory<any, any, any>[];
}

/**
 * Injection key for external introspection tools (the balance harness,
 * devtools). The engine provides an {@link EngineCategories} collection
 * under this key in advance, and fills it as category factories run during
 * install/connect. Consume via `engine.tryInject(CategoriesKey)`. The key
 * is engine-owned — `ctx.provide(CategoriesKey, ...)` throws. Resources
 * are discovered through `ResourceRegistryKey`.
 *
 * @see {@link EngineCategories} — the published shape
 */
export const CategoriesKey: InjectionKey<EngineCategories> = Symbol('engine:categories');

// ---------------------------------------------------------------------------
// Ambient categories collection
// ---------------------------------------------------------------------------

let _current: EngineCategories | undefined;

/**
 * Run `fn` with `target` set as the ambient categories collection. Any
 * category-factory call inside `fn` appends itself to `target`'s
 * matching field.
 *
 * {@link createEngine} calls it to limit category registration to its own
 * engine during install/connect. Nested calls save and restore the
 * previous ambient value. So engines built one inside another do not
 * overwrite each other's collection.
 *
 * @internal Consumer code should not call this directly.
 */
export function withEngineCategories<T>(target: EngineCategories, fn: () => T): T {
  const prev = _current;
  _current = target;
  try {
    return fn();
  } finally {
    _current = prev;
  }
}

/**
 * Read the current ambient categories collection, if any. Returns
 * `undefined` when called outside a `withEngineCategories` block (e.g.
 * tests, throwaway scripts that build a category without an engine).
 *
 * @internal Used by category factories to auto-register.
 */
export function getCurrentEngineCategories(): EngineCategories | undefined {
  return _current;
}

// ---------------------------------------------------------------------------
// Cross-cut entry-signals lookup
// ---------------------------------------------------------------------------

/**
 * Resolve `(categoryId, defId)` to the category entry's signals across
 * every typed field in {@link EngineCategories}. The cohesive cross-cut over
 * heterogeneous category types — every category factory derives a uniform
 * {@link CategoryEntrySignals} view from its instance refs. So a Gate
 * (or walker, devtool, UI hint) can read "is this entry active / how many
 * do I have" without consumer-side path conventions.
 *
 * Walks the built-in fields in order (`purchasables`, `skills`,
 * `achievements`, `challenges`, `producers`, `subjects`, `actions`); the
 * first category whose `id` matches `categoryId` is consulted. Fields added
 * by declaration merging aren't walked, so Gates never see their
 * categories. Returns `undefined` if no matching category is registered,
 * or if the matching category has no entry under `defId`.
 *
 * @example
 * ```ts
 * const categories = engine.tryInject(CategoriesKey)!;
 * const signals = findCategoryEntrySignals(categories, 'crafting', 'smithing');
 * signals?.count.value;   // current skill level
 * signals?.active.value;  // is the skill's level above zero?
 * ```
 */
export function findCategoryEntrySignals(
  categories: EngineCategories,
  categoryId: string,
  defId: string,
): CategoryEntrySignals | undefined {
  const buckets = [
    categories.purchasables,
    categories.skills,
    categories.achievements,
    categories.challenges,
    categories.producers,
    categories.subjects,
    categories.actions,
  ];
  for (const bucket of buckets) {
    if (!bucket) continue;
    for (const cat of bucket) {
      if (cat.id !== categoryId) continue;
      return cat.getEntry(defId)?.signals;
    }
  }
  return undefined;
}
