/**
 * Engine categories — the typed cross-category accumulator the engine
 * self-publishes for external introspection tools (sim pickers, devtools,
 * balance workbenches, harness walkers).
 *
 * Problem it solves: every archetype that needed cross-category
 * enumeration grew the same `categories.ts` aggregator module — re-injecting
 * each owner module and re-publishing the union by hand. Four independent
 * archetypes shipped the same workaround before it became clear the engine
 * itself should fill {@link EngineCategories}, parallel to how
 * `createModifierChain` auto-registers into `ChainRegistry` and
 * `createResource` auto-registers into `ResourceRegistry`.
 *
 * Mechanism: {@link createEngine} creates a per-engine accumulator,
 * pre-provides it under {@link CategoriesKey}, and makes it the ambient
 * target during `install()` and `connect()`. Each of the five category
 * factories (`createProducerCategory`, `createPurchasableCategory`,
 * `createAchievementCategory`, `createChallengeCategory`,
 * `createSkillCategory`) appends itself to the appropriate slot at
 * construction time. Categories constructed outside an engine (tests,
 * throwaway scripts) silently skip registration — the primitive still
 * works, just isn't discoverable via `tryInject`.
 *
 * Consumer-side `engine.provide(CategoriesKey, ...)` continues to work via
 * the underlying `Map.set` overwrite — back-compat for archetypes that
 * still hand-publish.
 */

import type { InjectionKey } from '@/primitives/types';
import type { Resource } from '@/core/resource';
import type { AchievementCategory } from './achievement-category';
import type { ChallengeCategory } from './challenge-category';
import type { ProducerCategory } from './producer-category';
import type { PurchasableCategory } from './purchasable-category';
import type { SkillCategory } from './skill-category';
import type { CategoryEntrySignals } from './category-base';

/**
 * Discovery map for external introspection tools (sim, devtools, balance
 * workbenches). The engine self-publishes this object under
 * {@link CategoriesKey}: each of the five category factories appends to
 * the corresponding slot at construction time, so a consumer can read the
 * full inventory via `engine.tryInject(CategoriesKey)` without any
 * archetype-side publication step.
 *
 * Every field is optional — a slot is only present if at least one
 * category of that kind was constructed. A consumer that constructs no
 * categories sees an empty object.
 *
 * Extend via declaration merging when shipping custom category types
 * that shouldn't hide behind `any`:
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
  /** Purchasable upgrade/buyable categories */
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
  /** Producer categories (generators, pools) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  producers?: ProducerCategory<any, any>[];
  /**
   * Game-published resource list. Optional — the engine already maintains
   * a per-engine resource registry (see {@link ResourceRegistryKey}), so
   * most discovery consumers can skip this field and read the registry
   * directly. Not auto-populated by the engine; only present when a
   * consumer explicitly publishes via `provide(CategoriesKey, ...)`.
   */
  resources?: Resource[];
}

/**
 * Discovery key for external introspection tools (sim, devtools). The
 * engine pre-provides an {@link EngineCategories} accumulator under this
 * key and self-populates it as category factories run during `install()`
 * and `connect()`. Consume via `engine.tryInject(CategoriesKey)`.
 *
 * Consumer-side `engine.provide(CategoriesKey, value)` is supported as a
 * back-compat hatch — the underlying `Map.set` overwrites the engine's
 * pre-provide. Archetypes migrating off hand-rolled `categories.ts`
 * aggregators don't need to publish at all.
 *
 * @see {@link EngineCategories} — the published shape
 */
export const CategoriesKey: InjectionKey<EngineCategories> = Symbol(
  'engine:categories',
) as InjectionKey<EngineCategories>;

// ---------------------------------------------------------------------------
// Ambient current-accumulator context
// ---------------------------------------------------------------------------

let _current: EngineCategories | undefined;

/**
 * Run `fn` with `target` set as the ambient categories accumulator. Any
 * category-factory call inside `fn` appends itself to `target`'s
 * appropriate slot.
 *
 * Used by {@link createEngine} to scope category registration to the
 * current engine during its `install()` / `connect()` phases. Nested
 * calls save and restore the previous ambient so multiple engines
 * starting concurrently don't stomp each other.
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
 * Read the current ambient categories accumulator, if any. Returns
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
 * Resolve `(categoryId, entityId)` to the entry's introspection signals across
 * every typed slot in {@link EngineCategories}. The cohesive cross-cut over
 * heterogeneous category types — every category factory derives a uniform
 * {@link CategoryEntrySignals} view from its instance refs, so a Gate
 * primitive (or walker, devtool, UI hint) can read "is this entity active /
 * how many do I have" without consumer-side path conventions.
 *
 * Walks the five typed slots in order (`purchasables`, `skills`,
 * `achievements`, `challenges`, `producers`); the first category whose `id`
 * matches `categoryId` is consulted. Returns `undefined` if no matching
 * category is registered, or if the matching category has no entry under
 * `entityId`.
 *
 * @example
 * ```ts
 * const categories = engine.tryInject(CategoriesKey)!;
 * const signals = findCategoryEntrySignals(categories, 'pk/jobs', 'beggar');
 * signals?.count.value;   // current job level
 * signals?.unlock.value;  // is the job advanced past zero?
 * ```
 */
export function findCategoryEntrySignals(
  categories: EngineCategories,
  categoryId: string,
  entityId: string,
): CategoryEntrySignals | undefined {
  const buckets = [
    categories.purchasables,
    categories.skills,
    categories.achievements,
    categories.challenges,
    categories.producers,
  ];
  for (const bucket of buckets) {
    if (!bucket) continue;
    for (const cat of bucket) {
      if (cat.id !== categoryId) continue;
      return cat.getEntry(entityId)?.signals;
    }
  }
  return undefined;
}
