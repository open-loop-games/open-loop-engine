/**
 * Engine-internal registries — four per-engine enumerable collections that
 * external introspection tools (balance workbenches, the picker, devtools)
 * read to walk "every X this engine knows about":
 *
 * - **Chain registry** — every {@link ModifierChain} created via
 *   `createModifierChain`.
 * - **Effect-system registry** — every temporary or conditional effect
 *   system created via `createTemporaryEffectSystem` /
 *   `createConditionalEffectSystem`.
 * - **Resource registry** — every {@link Resource} created via
 *   `createResource`.
 * - **Flag registry** — every {@link Flag} created via `createFlag`. A `flag`
 *   Gate and the game-state accessor read flags from it.
 *
 * Its factory fills each one while {@link createEngine} sets the registry as
 * an ambient value, during install/connect. An object built outside an
 * engine (tests, throwaway scripts) skips registration silently. The object
 * still works; it is just not discoverable.
 *
 * Each engine, scratch engines included, builds its own registries at
 * `start()`. So two engines in the same runtime never share one.
 *
 * Consumers read the registries via the typed injection keys — `ctx.inject`
 * inside a module, `engine.tryInject` from outside once the engine has
 * started:
 * ```ts
 * const chains = engine.tryInject(ChainRegistryKey)!;
 * for (const chain of chains.all()) { ... }
 * ```
 *
 * Storage and the ambient-value helper are in {@link ./named-registry}.
 * The chain and effect-system registries are direct {@link NamedRegistry}
 * aliases. The resource registry holds a NamedRegistry of entries instead,
 * for two reasons. Its public lookup methods (`list` / `findByDisplayName` /
 * `findById`) differ, and each entry records the persistent context it was
 * created in.
 *
 * @cluster registries
 */

import type { DecimalSource } from '@/primitives/decimal';
import type { InjectionKey } from '@/primitives/types';
import type { Grant, ModifierChain } from './modifier';
import type { Resource } from './resource';
import type { Flag } from './flag';
import { createAmbientValue, createNamedRegistry, type NamedRegistry } from './named-registry';

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
 *
 * @internal Read the engine's registry via `ChainRegistryKey`.
 */
export function createChainRegistry(): ChainRegistry {
  return createNamedRegistry<ModifierChain>({
    label: 'ChainRegistry',
    noun: 'chain',
    idOf: (chain) => chain.id,
  });
}

const chainAmbient = createAmbientValue<ChainRegistry>();

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
 * {@link ../systems/conditional-effect.ConditionalEffectSystem} satisfy this.
 *
 * The picker's effect-system walker, which walks lowered grants, reads `id` for
 * addressing and `allDefs()` for enumeration; everything else is system-specific and stays behind the
 * system's full interface.
 */
export interface EnumerableEffectSystem {
  /** System id, e.g. `'buffs'`, `'constructions-effects'`. */
  readonly id: string;
  /** The variant, so walkers can tell temporary from conditional effect systems. */
  readonly kind: 'temporary' | 'conditional';
  /** Snapshot of every registered def — shape differs between kinds. */
  allDefs(): readonly EffectDefLike[];
}

/**
 * Structural shape shared by `TemporaryEffectDef` and `ConditionalEffectDef`
 * that the picker needs. The full def types are in the systems layer, which
 * core doesn't import.
 */
export interface EffectDefLike {
  readonly id: string;
  readonly grants?: readonly Grant[] | (() => readonly Grant[]);
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
 *
 * @internal Read the engine's registry via `EffectSystemRegistryKey`.
 */
export function createEffectSystemRegistry(): EffectSystemRegistry {
  return createNamedRegistry<EnumerableEffectSystem>({
    label: 'EffectSystemRegistry',
    noun: 'effect-system',
    idOf: (system) => system.id,
  });
}

const effectSystemAmbient = createAmbientValue<EffectSystemRegistry>();

/**
 * Run `fn` with `registry` set as the ambient effect-system registry. Any
 * `createTemporaryEffectSystem` / `createConditionalEffectSystem` called
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
 * One entry in a {@link ResourceRegistry}. Records the live resource and
 * the id of the enclosing persistent context it was created in, without
 * the persistence namespace.
 */
export interface ResourceRegistryEntry<T = DecimalSource> {
  /** The resource instance */
  resource: Resource<T>;
  /** Persistent context id the resource was created in, or undefined outside any persistent context */
  persistentContextId: string | undefined;
}

/**
 * Enumerable registry of {@link Resource}s for a single engine.
 *
 * Shape is minimal on purpose: enumerate, look up by display name or id,
 * register. Per-resource reactivity is handled by the underlying Vue ref.
 *
 * A resource id is unique per engine, as chain and effect-system ids are:
 * registering a repeat throws, naming both persistent contexts. Per-prestige-layer
 * resources (each prestige layer's `points`) take distinct ids.
 */
export interface ResourceRegistry {
  /**
   * Add a resource entry to the registry. Throws if its id is already
   * registered.
   * @internal Called by {@link createResource} while this registry is the
   *   ambient value; consumers should not call this directly.
   */
  register(entry: ResourceRegistryEntry): void;
  /** Snapshot of all registered entries in insertion order. */
  list(): readonly ResourceRegistryEntry[];
  /**
   * First registered resource with the given display name, or `undefined`.
   * O(n) — display-name lookup is a debug / discovery convenience, not a
   * hot path.
   */
  findByDisplayName(displayName: string): Resource | undefined;
  /** The resource registered under `id` ({@link Resource.id}), or `undefined`. */
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
 *
 * @internal Read the engine's registry via `ResourceRegistryKey`.
 */
export function createResourceRegistry(): ResourceRegistry {
  const inner = createNamedRegistry<ResourceRegistryEntry>({
    label: 'ResourceRegistry',
    noun: 'resource',
    idOf: (entry) => entry.resource.id,
  });
  return {
    register(entry) {
      const prior = inner.get(entry.resource.id);
      if (prior) {
        const where = (e: ResourceRegistryEntry) =>
          e.persistentContextId === undefined ? 'top level' : `"${e.persistentContextId}"`;
        throw new Error(
          `ResourceRegistry: duplicate resource id "${entry.resource.id}" — ${where(prior)} and ${where(entry)} both create it. ` +
            'Resource ids are unique per engine; pass each resource a distinct `id` (a wrapped ref without one takes its displayName).',
        );
      }
      inner.register(entry);
    },
    list() {
      return inner.all();
    },
    findByDisplayName(displayName) {
      return inner.all().find((e) => e.resource.displayName === displayName)?.resource;
    },
    findById(id) {
      return inner.get(id)?.resource;
    },
  };
}

const resourceAmbient = createAmbientValue<ResourceRegistry>();

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

// === FLAG REGISTRY ===
/**
 * Registry of the {@link Flag}s of a single engine, keyed by flag id. Flag ids
 * are flat: unique across the engine, whatever module created them.
 */
export type FlagRegistry = NamedRegistry<Flag>;

/**
 * Injection key for the per-engine {@link FlagRegistry}. The engine provides
 * it before any module installs.
 */
export const FlagRegistryKey: InjectionKey<FlagRegistry> = Symbol('engine:flag-registry');

/**
 * Create a fresh, empty flag registry. Called once per engine instance in
 * {@link createEngine}.
 *
 * @internal Read the engine's registry via `FlagRegistryKey`.
 */
export function createFlagRegistry(): FlagRegistry {
  return createNamedRegistry<Flag>({
    label: 'FlagRegistry',
    noun: 'flag',
    idOf: (flag) => flag.id,
  });
}

const flagAmbient = createAmbientValue<FlagRegistry>();

/**
 * Run `fn` with `registry` set as the ambient flag registry. Any `createFlag`
 * called inside `fn` registers into `registry`.
 *
 * @internal Used by {@link createEngine} during `install()` / `connect()`, and
 *   by tests that create flags without an engine.
 */
export const withFlagRegistry = flagAmbient.with;

/**
 * Read the current ambient flag registry, or `undefined` outside a
 * `withFlagRegistry` block.
 *
 * @internal Used by {@link createFlag} to register, and by the Gate services.
 */
export const getCurrentFlagRegistry = flagAmbient.getCurrent;
