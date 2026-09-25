/**
 * Engine-internal registries — three per-engine enumerable collections that
 * external introspection tools (balance workbenches, sim pickers, devtools)
 * read to walk "every X this engine knows about":
 *
 * - **Chain registry** — every {@link ModifierChain} created via
 *   `createModifierChain`.
 * - **Effect-system registry** — every temporary or persistent effect
 *   system created via `createTemporaryEffectSystem` /
 *   `createPersistentEffectSystem`.
 * - **Resource registry** — every {@link Resource} created via
 *   `createResource`.
 *
 * Each is auto-populated by its corresponding factory under an ambient
 * scope that {@link createEngine} sets up around `install()` / `connect()`.
 * Entities constructed outside an engine (tests, throwaway scripts)
 * silently skip registration — the primitive still works, just isn't
 * discoverable.
 *
 * Scratch-engine forks each build their own registries at `start()` time,
 * so two engines in the same runtime never cross-contaminate.
 *
 * Consumers read the registries via the typed injection keys — `ctx.inject`
 * inside a module, `engine.tryInject` from outside once the engine has
 * started:
 * ```ts
 * const chains = engine.tryInject(ChainRegistryKey)!;
 * for (const chain of chains.all()) { ... }
 * ```
 *
 * Storage and the ambient triad are factored into {@link ./named-registry}.
 * Chain and effect-system are direct {@link NamedRegistry} aliases; the
 * resource registry wraps a NamedRegistry of entries because its public
 * lookup surface (`list` / `findByName` / `findById`) differs and a
 * resource id may repeat across persistence contexts.
 *
 * @cluster registries
 */

import type { DecimalSource } from '@/primitives/decimal';
import type { InjectionKey } from '@/primitives/types';
import type { ModifierChain } from './modifier';
import type { Resource } from './resource';
import { createAmbientScope, createNamedRegistry, type NamedRegistry } from './named-registry';

// === CHAIN REGISTRY ===
/**
 * Enumerable registry of {@link ModifierChain}s for a single engine.
 *
 * Shape is minimal on purpose: enumerate, look up by id, count. Per-chain
 * reactivity is handled by the chain itself via its `changed` event.
 */
export type ChainRegistry = NamedRegistry<ModifierChain>;

/**
 * Injection key for the per-engine {@link ChainRegistry}. The engine pre-
 * provides the registry under this key before any module installs, so
 * modules can look it up via `ctx.inject(ChainRegistryKey)`, and external
 * tools via `engine.tryInject(ChainRegistryKey)` after `start()`.
 */
export const ChainRegistryKey: InjectionKey<ChainRegistry> = Symbol('engine:chain-registry');

/**
 * Create a fresh, empty chain registry. Called once per engine instance in
 * {@link createEngine}.
 */
export function createChainRegistry(): ChainRegistry {
  return createNamedRegistry<ModifierChain>({
    label: 'ChainRegistry',
    entityNoun: 'chain',
    idOf: (chain) => chain.id,
  });
}

const chainAmbient = createAmbientScope<ChainRegistry>();

/**
 * Run `fn` with `registry` set as the ambient chain registry. Any
 * `createModifierChain` called inside `fn` auto-registers into `registry`.
 *
 * @internal Used by {@link createEngine} during `install()` / `connect()`.
 */
export const withChainRegistry = chainAmbient.with;

/**
 * Read the current ambient chain registry, or `undefined` outside a
 * `withChainRegistry` block.
 *
 * @internal Used by {@link createModifierChain} to auto-register.
 */
export const getCurrentChainRegistry = chainAmbient.getCurrent;

// === EFFECT-SYSTEM REGISTRY ===
/**
 * Minimal shape an effect system must expose to be enumerable. Both
 * {@link ../systems/temporary-effect.TemporaryEffectSystem} and
 * {@link ../systems/persistent-effect.PersistentEffectSystem} satisfy this.
 *
 * The picker's content walker reads `id` for addressing and `allDefs()` for
 * enumeration; everything else is system-specific and stays behind the
 * system's full interface.
 */
export interface EnumerableEffectSystem {
  /** System identifier, e.g. `'buffs'`, `'constructions-effects'`. */
  readonly id: string;
  /** Kind tag so walkers can distinguish temporary from persistent defs. */
  readonly kind: 'temporary' | 'persistent';
  /** Snapshot of every registered def — shape differs between kinds. */
  allDefs(): readonly EffectDefLike[];
}

/**
 * Structural shape shared by `TemporaryEffectDef` and `PersistentEffectDef`
 * that the picker needs. Narrow on purpose — full def types stay in their
 * home system files to avoid a circular import.
 */
export interface EffectDefLike {
  readonly id: string;
  readonly modifiers?: ReadonlyArray<unknown> | (() => ReadonlyArray<unknown>);
}

/**
 * Enumerable registry of effect systems for a single engine. Same minimal
 * enumerate / lookup / count shape as {@link ChainRegistry}.
 */
export type EffectSystemRegistry = NamedRegistry<EnumerableEffectSystem>;

/** Injection key for the per-engine {@link EffectSystemRegistry}. */
export const EffectSystemRegistryKey: InjectionKey<EffectSystemRegistry> = Symbol(
  'engine:effect-system-registry',
);

/**
 * Create a fresh, empty effect-system registry. Called once per engine
 * instance in {@link createEngine}.
 */
export function createEffectSystemRegistry(): EffectSystemRegistry {
  return createNamedRegistry<EnumerableEffectSystem>({
    label: 'EffectSystemRegistry',
    entityNoun: 'effect-system',
    idOf: (system) => system.id,
  });
}

const effectSystemAmbient = createAmbientScope<EffectSystemRegistry>();

/**
 * Run `fn` with `registry` set as the ambient effect-system registry. Any
 * `createTemporaryEffectSystem` / `createPersistentEffectSystem` called
 * inside `fn` auto-registers into `registry`.
 *
 * @internal Used by {@link createEngine} during `install()` / `connect()`.
 */
export const withEffectSystemRegistry = effectSystemAmbient.with;

/**
 * Read the current ambient effect-system registry, or `undefined` outside a
 * `withEffectSystemRegistry` block.
 *
 * @internal Used by the effect-system factories to auto-register.
 */
export const getCurrentEffectSystemRegistry = effectSystemAmbient.getCurrent;

// === RESOURCE REGISTRY ===
/**
 * One entry in a {@link ResourceRegistry}. Carries the live resource and
 * the persistence-context id it was created under (namespace-stripped —
 * i.e. the raw module id the author passed).
 */
export interface ResourceRegistryEntry<T = DecimalSource> {
  /** The resource instance */
  resource: Resource<T>;
  /** Persistence context ID the resource was created in, or undefined if created at top level */
  context: string | undefined;
}

/**
 * Enumerable registry of {@link Resource}s for a single engine.
 *
 * Shape is minimal on purpose: enumerate, look up by display name or id,
 * append. Per-resource reactivity is handled by the underlying Vue ref.
 *
 * Unlike chain and effect-system registries, resources are appended
 * permissively — ids are unique only within a persistence context, so two
 * modules can each own a resource with the same id and display name (e.g.
 * per-prestige-layer `points`). Both lookups answer the first registered
 * match; the `context` field on each entry lets consumers disambiguate.
 */
export interface ResourceRegistry {
  /**
   * Add a resource entry to the registry.
   * @internal Called by {@link createResource} under the ambient scope;
   *   consumers should not call this directly.
   */
  register(entry: ResourceRegistryEntry): void;
  /** Snapshot of all registered entries in insertion order. */
  list(): readonly ResourceRegistryEntry[];
  /**
   * First registered resource with the given display name, or `undefined`.
   * O(n) — display-name lookup is a debug / discovery convenience, not a
   * hot path.
   */
  findByName(displayName: string): Resource | undefined;
  /**
   * First registered resource whose `id` matches, or `undefined`. Ids are
   * raw ({@link Resource.id}), not namespaced by module, so two modules can
   * register the same id — per-prestige-layer `points`, say — and this
   * answers whichever installed first. Walk {@link ResourceRegistry.list}
   * and match on `context` when the id alone is ambiguous.
   */
  findById(id: string): Resource | undefined;
}

/**
 * Injection key for the per-engine {@link ResourceRegistry}.
 */
export const ResourceRegistryKey: InjectionKey<ResourceRegistry> = Symbol(
  'engine:resource-registry',
);

/**
 * Create a fresh, empty resource registry. Called once per engine instance
 * in {@link createEngine}.
 */
export function createResourceRegistry(): ResourceRegistry {
  const inner = createNamedRegistry<ResourceRegistryEntry>({
    label: 'ResourceRegistry',
    entityNoun: 'resource',
    idOf: (entry) => entry.resource.id,
  });
  return {
    register(entry) {
      inner.append(entry);
    },
    list() {
      return inner.all();
    },
    findByName(displayName) {
      return inner.all().find((e) => e.resource.displayName === displayName)?.resource;
    },
    findById(id) {
      return inner.get(id)?.resource;
    },
  };
}

const resourceAmbient = createAmbientScope<ResourceRegistry>();

/**
 * Run `fn` with `registry` set as the ambient resource registry. Any
 * `createResource` called inside `fn` auto-registers into `registry`.
 *
 * @internal Used by {@link createEngine} during `install()` / `connect()`.
 */
export const withResourceRegistry = resourceAmbient.with;

/**
 * Read the current ambient resource registry, or `undefined` outside a
 * `withResourceRegistry` block.
 *
 * @internal Used by {@link createResource} to auto-register.
 */
export const getCurrentResourceRegistry = resourceAmbient.getCurrent;
