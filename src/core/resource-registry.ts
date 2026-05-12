/**
 * Resource registry — enumerable collection of {@link Resource}s owned by
 * a single engine instance.
 *
 * Problem it solves: `createResource` is the canonical primitive for
 * introducing a named reactive quantity, but consumers scope each resource
 * in a closure (module const, category factory local). External introspection
 * tools — trace views, balance workbenches, sim pickers — have no way to walk
 * "every resource this engine knows about" without the game author manually
 * publishing each one. A process-wide global registry is a non-starter for
 * forkable scratch engines: per-run engines would pile stale refs into a
 * shared array and every analyzer that closed over the source engine's refs
 * would silently sample dead state.
 *
 * Mechanism: {@link createEngine} creates a per-engine registry and makes it
 * the ambient target during `install()` and `connect()`. Every
 * `createResource()` call under that ambient auto-registers. Resources
 * created outside an engine (tests, throwaway scripts) silently skip
 * registration — the primitive still works, just isn't discoverable.
 *
 * Scratch-engine forks each build their own registry at `start()` time, so
 * two engines in the same runtime never cross-contaminate.
 *
 * Consumers read the registry via the typed {@link ResourceRegistryKey}:
 * ```ts
 * const registry = engine.tryInject(ResourceRegistryKey);
 * for (const entry of registry?.list() ?? []) { ... }
 * ```
 *
 * @cluster registries
 */

import type { Resource } from './resource';
import type { DecimalSource } from '@/primitives/decimal';

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
 * Shape is minimal on purpose: enumerate, look up by display name, append.
 * Per-resource reactivity is handled by the underlying Vue ref.
 */
export interface ResourceRegistry {
  /**
   * Add a resource entry to the registry. Duplicate display names are
   * allowed — unlike chains, resources can legitimately share names across
   * persistence contexts (e.g. per-prestige-layer `points`), and the
   * context field lets consumers disambiguate.
   * @internal Called by {@link createResource} when the ambient registry is
   *   set. Consumers should not call this directly.
   */
  register(entry: ResourceRegistryEntry): void;
  /** Snapshot of all registered entries in insertion order. */
  list(): readonly ResourceRegistryEntry[];
  /**
   * Find the first registered resource with the given display name, or
   * `undefined` if none matches. O(n) — display-name lookup is a debug /
   * discovery convenience, not a hot path.
   */
  findByName(displayName: string): Resource | undefined;
  /**
   * Find the first registered resource whose `id` matches, or `undefined`
   * if none matches. `id` is the canonical save-key (set explicitly via
   * {@link ResourceOptions.id}, falling back to `displayName`), so this is
   * the right lookup for cross-module wiring where two resources could
   * share a display name but never an id.
   */
  findById(id: string): Resource | undefined;
}

/**
 * Injection key for the per-engine {@link ResourceRegistry}. The engine
 * pre-provides the registry under this key before any module installs, so
 * modules and external introspection tools can look it up via
 * `engine.tryInject(ResourceRegistryKey)`.
 *
 * Structurally compatible with `InjectionKey<ResourceRegistry>` from the top-
 * level engine barrel — declared here to avoid a circular import back into
 * `src/index.ts`.
 */
export const ResourceRegistryKey = Symbol('engine:resource-registry') as symbol & {
  __type?: ResourceRegistry;
};

/**
 * Create a fresh, empty resource registry. Called once per engine instance
 * in {@link createEngine}.
 */
export function createResourceRegistry(): ResourceRegistry {
  const entries: ResourceRegistryEntry[] = [];

  return {
    register(entry) {
      entries.push(entry);
    },
    list() {
      return entries;
    },
    findByName(displayName) {
      return entries.find((e) => e.resource.displayName === displayName)?.resource;
    },
    findById(id) {
      return entries.find((e) => e.resource.id === id)?.resource;
    },
  };
}

// === AMBIENT CONTEXT ===

let _currentRegistry: ResourceRegistry | undefined;

/**
 * Run `fn` with `registry` set as the ambient resource registry. Any
 * `createResource` called inside `fn` auto-registers into `registry`.
 *
 * Used by {@link createEngine} to scope resource registration to the current
 * engine during its `install()` / `connect()` phases. Nested calls save and
 * restore the previous ambient so multiple engines starting concurrently
 * don't stomp each other.
 *
 * @internal Consumer code should not call this directly.
 */
export function withResourceRegistry<T>(registry: ResourceRegistry, fn: () => T): T {
  const prev = _currentRegistry;
  _currentRegistry = registry;
  try {
    return fn();
  } finally {
    _currentRegistry = prev;
  }
}

/**
 * Read the current ambient resource registry, if any. Returns `undefined`
 * when called outside a `withResourceRegistry` block (e.g., tests,
 * throwaway scripts).
 *
 * @internal Used by {@link createResource} to auto-register.
 */
export function getCurrentResourceRegistry(): ResourceRegistry | undefined {
  return _currentRegistry;
}
