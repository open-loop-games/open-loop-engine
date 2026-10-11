/**
 * Shared traversal helpers over the three lookups the engine exposes to
 * external introspection tools: `CategoriesKey` (opt-in),
 * `EffectSystemRegistry` (auto-registered), and `ChainRegistry`
 * (auto-registered).
 *
 * The discovery walkers (`src/harness/picker/walk-*.ts`) and the transition
 * walkers differ only in output shape: same iteration, different per-visit
 * projection. The iteration is here once, so both projections share one
 * traversal.
 *
 * Helpers are opinion-free: they yield every category entry, def or chain
 * modifier the registry knows about. Callers decide which to skip, how to
 * warn about unhandled keys, and how to shape their output.
 */

import type {
  ChainRegistry,
  EffectDefLike,
  EffectSystemRegistry,
  EnumerableEffectSystem,
} from '@/core/registries';
import type { Grant, Modifier, ModifierChain } from '@/core/modifier';
import type { EngineCategories } from '@/systems/engine-categories';
import { flattenGrants } from '@/systems/replacement-grants';

// ============================================================================
// Category traversal
// ============================================================================

export interface CategoryEntryVisit {
  /** Which {@link EngineCategories} key the category entry came from. */
  categoryKey: keyof EngineCategories;
  /** The owning category's `registry.id`. */
  categoryId: string;
  /** The category entry's `def.id`. */
  defId: string;
  /**
   * The `.getAll()[N]` category entry. Exact shape depends on
   * `categoryKey`:
   *
   * - `skills`: `{ def, skill, state, signals }`
   * - `producers`: `{ def, producer, state, signals }`
   * - `purchasables`: `{ def, purchasable, state, signals }`
   * - `achievements`: `{ def, achievement, state, signals }`
   * - `challenges`: `{ def, challenge, state, signals }`
   *
   * Narrow via `categoryKey` at the call site.
   */
  entry: { readonly def: { readonly id: string } };
}

interface WalkableCategory {
  readonly registry: { readonly id: string };
  getAll(): ReadonlyArray<{ readonly def: { readonly id: string } }>;
}

function isWalkableCategory(value: unknown): value is WalkableCategory {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<WalkableCategory>;
  const registry = v.registry as { id?: unknown } | undefined;
  return (
    typeof registry === 'object' &&
    registry !== null &&
    typeof registry.id === 'string' &&
    typeof v.getAll === 'function'
  );
}

/**
 * Walk every category entry across every category slice published under
 * {@link EngineCategories}. Yields `{ categoryKey, categoryId, defId,
 * entry }` per category entry.
 *
 * Duck-types each slice element for `{ registry.id, getAll() }`, the shared
 * `CategoryBase` shape. So non-category keys like `resources`
 * (`Resource[]`) are silently skipped. Handled/unhandled filtering and any
 * per-key warnings are the caller's responsibility.
 */
export function forEachCategoryEntry(
  categories: EngineCategories | undefined,
  visitor: (visit: CategoryEntryVisit) => void,
): void {
  if (!categories) return;
  for (const key of Object.keys(categories) as Array<keyof EngineCategories>) {
    const slice = categories[key];
    if (!Array.isArray(slice)) continue;
    for (const maybeCategory of slice) {
      if (!isWalkableCategory(maybeCategory)) continue;
      const categoryId = maybeCategory.registry.id;
      for (const entity of maybeCategory.getAll()) {
        visitor({ categoryKey: key, categoryId, defId: entity.def.id, entry: entity });
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
  /** `'temporary'` vs `'conditional'` — read from the system's `kind` field. */
  systemKind: EnumerableEffectSystem['kind'];
  def: EffectDefLike;
}

/**
 * Walk every def across every auto-registered effect system (temporary
 * and conditional). A missing registry makes it a no-op.
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

/**
 * A def's lowered grants in `grantIndex` order — each grant paired with each
 * chain it targets, calling a factory-form `grants` once.
 */
export function effectDefGrants(def: EffectDefLike): { grant: Grant; chain: ModifierChain }[] {
  const raw = def.grants;
  if (raw == null) return [];
  return flattenGrants(typeof raw === 'function' ? raw() : raw);
}

// ============================================================================
// Chain-registry traversal
// ============================================================================

export interface ChainRegistryVisit {
  chain: ModifierChain;
  /**
   * Present for per-modifier visits; absent for the chain-as-a-whole
   * visit, which comes once per chain before any modifier visit.
   */
  modifier?: Modifier;
  /**
   * Position of `modifier` within `chain.modifiers`, iff `modifier` is
   * present.
   */
  indexInChain?: number;
}

/**
 * Walk every auto-registered {@link ModifierChain}. For each chain, visit
 * once for the chain as a whole (no `modifier`), then once per modifier
 * currently in the chain.
 *
 * The chain-as-a-whole visit lets callers target a chain that is registered
 * empty and filled later. It has no modifier to perturb or address yet, but
 * the chain itself is a valid target.
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
