/**
 * Shared traversal helpers over the three discovery surfaces the engine
 * exposes to external introspection tools: `CategoriesKey` (opt-in),
 * `EffectSystemRegistry` (auto-registered), and `ChainRegistry`
 * (auto-registered).
 *
 * The picker walkers (`src/harness/picker/walk-*.ts`) and the content
 * walker family diverge only in emission shape — same iteration, different
 * per-visit projection. Pull the iteration out once so both projections share
 * one traversal.
 *
 * Helpers are opinion-free: they yield every entity / def / chain-entry
 * the registry knows about. Emitters decide which to skip, how to warn
 * about unhandled keys, and how to shape their output.
 */

import type {
  ChainRegistry,
  EffectDefLike,
  EffectSystemRegistry,
  EngineCategories,
  EnumerableEffectSystem,
  Modifier,
  ModifierChain,
} from '@/index';

// ============================================================================
// Category traversal
// ============================================================================

export interface CategoryEntityVisit {
  /** Which {@link EngineCategories} key the entity came from. */
  categoryKey: keyof EngineCategories;
  /** The owning category's `registry.name`. */
  categoryId: string;
  /** The entity's `def.id`. */
  entityId: string;
  /**
   * The `.getAll()[N]` object for this entity. Exact shape depends on
   * `categoryKey`:
   *
   * - `skills`: `{ def, skill, state }`
   * - `producers`: `{ def, producer, state }`
   * - `purchasables`: `{ def, purchasable, state }`
   * - `achievements`: `{ def, achievement, state }`
   * - `challenges`: `{ def, challenge, state }`
   *
   * Narrow via `categoryKey` at the call site.
   */
  entity: { readonly def: { readonly id: string } };
}

interface WalkableCategory {
  readonly registry: { readonly name: string };
  getAll(): ReadonlyArray<{ readonly def: { readonly id: string } }>;
}

function isWalkableCategory(value: unknown): value is WalkableCategory {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<WalkableCategory>;
  const registry = v.registry as { name?: unknown } | undefined;
  return (
    typeof registry === 'object' &&
    registry !== null &&
    typeof registry.name === 'string' &&
    typeof v.getAll === 'function'
  );
}

/**
 * Walk every entity across every category slice published under
 * {@link EngineCategories}. Yields `{ categoryKey, categoryId, entityId,
 * entity }` per entity.
 *
 * Duck-types each slice entry for `{ registry.name, getAll() }` — the
 * shared `CategoryBase` shape — so non-category keys like `resources`
 * (`Resource[]`) are silently skipped. Handled/unhandled filtering and
 * any per-key warnings are the emitter's responsibility.
 */
export function forEachCategoryEntity(
  categories: EngineCategories | undefined,
  visitor: (visit: CategoryEntityVisit) => void,
): void {
  if (!categories) return;
  for (const key of Object.keys(categories) as Array<keyof EngineCategories>) {
    const slice = categories[key];
    if (!Array.isArray(slice)) continue;
    for (const maybeCategory of slice) {
      if (!isWalkableCategory(maybeCategory)) continue;
      const categoryId = maybeCategory.registry.name;
      for (const entity of maybeCategory.getAll()) {
        visitor({ categoryKey: key, categoryId, entityId: entity.def.id, entity });
      }
    }
  }
}

// ============================================================================
// Effect-system def traversal
// ============================================================================

export interface EffectDefVisit {
  /** The owning system's id, e.g. `'buffs'`, `'auras'`. */
  systemId: string;
  /** `'temporary'` vs `'persistent'` — read from the system's `kind` tag. */
  systemKind: EnumerableEffectSystem['kind'];
  def: EffectDefLike;
}

/**
 * Walk every def across every auto-registered effect system (temporary
 * and persistent). Missing registry degrades to a no-op.
 */
export function forEachEffectDef(
  registry: EffectSystemRegistry | undefined,
  visitor: (visit: EffectDefVisit) => void,
): void {
  if (!registry) return;
  for (const system of registry.all()) {
    for (const def of system.allDefs()) {
      visitor({ systemId: system.id, systemKind: system.kind, def });
    }
  }
}

// ============================================================================
// Chain-registry traversal
// ============================================================================

export interface ChainRegistryVisit {
  chain: ModifierChain;
  /**
   * Present for per-modifier visits; absent for the chain-as-a-whole
   * visit that fires once per chain before any modifier visits.
   */
  modifier?: Modifier;
  /**
   * Position of `modifier` within `chain.modifiers`, iff `modifier` is
   * present.
   */
  indexInChain?: number;
}

/**
 * Walk every auto-registered {@link ModifierChain}. For each chain, emit
 * one chain-as-a-whole visit (no `modifier`) followed by one visit per
 * modifier currently in the chain.
 *
 * The chain-as-a-whole visit lets emitters target chains that are
 * registered empty and populated later — there's no modifier to perturb
 * or address yet, but the chain itself is a valid target.
 */
export function forEachChainRegistryEntry(
  registry: ChainRegistry | undefined,
  visitor: (visit: ChainRegistryVisit) => void,
): void {
  if (!registry) return;
  for (const chain of registry.all()) {
    visitor({ chain });
    chain.modifiers.forEach((modifier, indexInChain) => {
      visitor({ chain, modifier, indexInChain });
    });
  }
}
