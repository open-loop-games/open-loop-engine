/**
 * Override Registry — generic typed registry with scoped push/pop, plus
 * the typed `TuningRegistry` narrow that opts a registry into the picker's
 * tuning-surface enumeration.
 *
 * Two purposes served by this module:
 *
 * - `createOverrideRegistry<T>(name)` is the general-purpose function-
 *   substitution primitive. Use for mod overrides, challenge takeovers,
 *   sim swap, and debug overlays. The generic `T` admits variadic-arg
 *   signatures and any return type. Registries created this way are
 *   **not** enumerated by the picker.
 *
 * - `createTuningRegistry(name)` is a typed narrow over
 *   `OverrideRegistry<Record<string, () => DecimalSource>>` that auto-
 *   registers itself into the ambient `TuningRegistriesKey` set when
 *   called within `withTuningRegistries(...)`. The picker's `walkTunables`
 *   enumerates every registered tuning registry's base-map keys — so
 *   `createTuningRegistry` is the boundary between "this registry holds
 *   designer-flagged tuning values" and "this registry holds general
 *   overrides."
 *
 * `tunable()` is the value-shaped construction primitive that sits on top.
 * Its registry argument should be a `TuningRegistry` (created via
 * `createTuningRegistry`) when you want the value to surface in the picker
 * / workbench / sensitivity analyzer; a plain `OverrideRegistry` works
 * for non-tuning function substitution.
 *
 * Resolution order: scope stack top-down → base map. Multiple scopes can
 * stack — each pushScope returns an independent cleanup function. Cleanup
 * is idempotent.
 *
 * `scopeVersion` is a reactive `Ref<number>` that bumps whenever a
 * resolution can change: every push and cleanup, every `override`, and a
 * `setDefault` that registers a new key. Read it from inside a Vue
 * `computed` to make the computed re-evaluate on those changes. Paired
 * with {@link tunable} for the sim-tunable-values pattern.
 *
 * @example
 * ```ts
 * // General-purpose override registry — not enumerated by picker.
 * interface CombatOverrides {
 *   getSelfCombat: () => number;
 *   calcBonus: (level: number) => number;
 * }
 * const combat = createOverrideRegistry<CombatOverrides>('combat');
 * combat.setDefault('getSelfCombat', () => 42);
 * combat.override('getSelfCombat', () => 99);        // permanent mod override
 *
 * const cleanup = combat.pushScope('challenge:zombie', {
 *   getSelfCombat: () => 0,                          // scoped override
 * });
 * combat.get('getSelfCombat')();  // 0
 * cleanup();
 * combat.get('getSelfCombat')();  // 99 (back to mod override)
 *
 * // Tuning registry — enumerated by picker, surfaced in workbench.
 * const tuning = createTuningRegistry('producer-tuning');
 * const effect = tunable(tuning, 'upgrades/double-gold/effect', () =>
 *   Decimal.mul(baseEffect, purchasable.amount.value),
 * );
 * ```
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { DecimalSource } from '../primitives/decimal';
import type { InjectionKey } from '../primitives/types';

// === TYPES ===
/** A scope pushed onto the override stack */
interface Scope<T> {
  readonly label: string;
  readonly overrides: Partial<T>;
}

/**
 * A typed, scoped override registry for named functions.
 *
 * @typeParam T - Record of named functions (e.g., `{ getSelfCombat: () => number }`)
 */
export interface OverrideRegistry<T extends { [K in keyof T]: (...args: never[]) => unknown }> {
  /** Human-readable registry name (passed to `createOverrideRegistry`). */
  readonly name: string;

  /**
   * Register a default implementation. No-op if the key already has a base value.
   * Called by vanilla modules during install.
   */
  setDefault<K extends keyof T & string>(name: K, fn: T[K]): void;

  /**
   * Permanently override a value (sets regardless of existing base).
   * Called by mod modules during install.
   */
  override<K extends keyof T & string>(name: K, fn: T[K]): void;

  /**
   * Resolve a key: check scope stack top-down, then base map.
   * @throws If the key is not found in any scope or the base map
   */
  get<K extends keyof T & string>(name: K): T[K];

  /** Check if a key exists in any scope or the base map */
  has(name: keyof T & string): boolean;

  /**
   * Snapshot of base-map keys — the design-time tuning surface declared
   * via `setDefault` / `override`. Scope-only keys (transient challenge,
   * prestige, or sim takeover overrides) are intentionally excluded:
   * they are engine *state*, not author-declared intent, and surfacing
   * them in pickers / introspection would produce transient entries
   * that vanish on scope cleanup. Future-you should resist the urge
   * to "fix" this to return base ∪ scopes.
   */
  getBaseKeys(): readonly string[];

  /**
   * Push a scoped set of overrides onto the stack.
   * Returns an idempotent cleanup function that removes this exact scope.
   *
   * @param label - Human-readable label for debugging (e.g., "challenge:zombie")
   * @param overrides - Partial map of keys to override while this scope is active
   */
  pushScope(label: string, overrides: Partial<T>): () => void;

  /** Number of active scopes on the stack */
  readonly scopeDepth: number;

  /**
   * Reactive version counter — bumps whenever a key's resolution can change:
   * every push and scope cleanup, every `override`, and a `setDefault` that
   * registers a new key (a no-op `setDefault` doesn't bump). Read from inside
   * a `computed` to make it re-evaluate on those changes. Paired with
   * {@link tunable} for the sim-tunable-values pattern.
   */
  readonly scopeVersion: Ref<number>;
}

/**
 * Typed narrow over {@link OverrideRegistry} for "values intentionally
 * declared as tuning surface." Every key resolves to a zero-arg reader
 * returning a `DecimalSource`. Picker enumeration walks instances of this
 * type via the ambient {@link TuningRegistriesKey}.
 */
export type TuningRegistry = OverrideRegistry<Record<string, () => DecimalSource>>;

/**
 * Per-engine collection of tuning registries — the picker's
 * `walkTunables` reads this. Pre-provided as an empty `Set<TuningRegistry>`
 * by `createEngine`; populated by `createTuningRegistry` callsites that
 * run inside the engine's `withTuningRegistries(...)` ambient (the
 * install / connect phases).
 *
 * Mirrors the {@link ChainRegistryKey} pattern: per-engine collection,
 * ambient auto-registration, picker enumerates without consumer-side
 * publication.
 */
export const TuningRegistriesKey = Symbol('engine:tuning-registries') as InjectionKey<
  Set<TuningRegistry>
>;

// === FACTORY ===
/** Whether a scope supplies its own, defined entry for `key`. */
function overridesKey<T>(scope: Scope<T>, key: keyof T & string): boolean {
  return Object.hasOwn(scope.overrides, key) && scope.overrides[key] !== undefined;
}

/**
 * Create a new override registry.
 *
 * @param name - Human-readable name for error messages (e.g., "game-overrides")
 */
export function createOverrideRegistry<T extends { [K in keyof T]: (...args: never[]) => unknown }>(
  name: string,
): OverrideRegistry<T> {
  const base = new Map<string, (...args: never[]) => unknown>();
  const scopes: Scope<T>[] = [];
  const scopeVersion = ref(0);

  return {
    name,
    scopeVersion,
    setDefault<K extends keyof T & string>(key: K, fn: T[K]): void {
      if (!base.has(key)) {
        base.set(key, fn);
        scopeVersion.value++;
      }
    },

    override<K extends keyof T & string>(key: K, fn: T[K]): void {
      base.set(key, fn);
      scopeVersion.value++;
    },

    get<K extends keyof T & string>(key: K): T[K] {
      // Walk scopes top-down
      for (let i = scopes.length - 1; i >= 0; i--) {
        const scope = scopes[i];
        if (overridesKey(scope, key)) return scope.overrides[key] as T[K];
      }

      const fn = base.get(key);
      if (fn === undefined) {
        throw new Error(`[${name}] Override "${key}" not registered`);
      }
      return fn as T[K];
    },

    has(key: keyof T & string): boolean {
      for (let i = scopes.length - 1; i >= 0; i--) {
        if (overridesKey(scopes[i], key)) return true;
      }
      return base.has(key);
    },

    getBaseKeys(): readonly string[] {
      return Array.from(base.keys());
    },

    pushScope(label: string, overrides: Partial<T>): () => void {
      const scope: Scope<T> = { label, overrides };
      scopes.push(scope);
      scopeVersion.value++;

      return () => {
        const idx = scopes.indexOf(scope);
        if (idx === -1) return;
        scopes.splice(idx, 1);
        scopeVersion.value++;
      };
    },

    get scopeDepth(): number {
      return scopes.length;
    },
  };
}

/**
 * Create a tuning registry — typed narrow over {@link OverrideRegistry} for
 * `Record<string, () => DecimalSource>`-shaped registries that opt into the
 * picker's tuning-surface enumeration.
 *
 * The factory name is the boundary: calling `createTuningRegistry`
 * declares "this registry holds designer-flagged tuning values, surface
 * them in the workbench." Calling `createOverrideRegistry` directly opts
 * out — appropriate for challenge takeover, mod fn replacement, sim swap,
 * and other general substitution uses.
 *
 * Auto-registration only fires when called within
 * `withTuningRegistries(...)` — the ambient `createEngine` sets up
 * around `install()` / `connect()`. Registries constructed outside that
 * ambient (tests, throwaway scripts) silently skip registration; the
 * primitive still works, just isn't picker-discoverable.
 *
 * @param name - Human-readable registry name. Used as the registry-name
 *   prefix in `TunablePickerEntry.label`.
 * @returns A {@link TuningRegistry} — same shape as `OverrideRegistry`
 *   with the value type narrowed to `() => DecimalSource`.
 *
 * @example
 * ```ts
 * // Typical archetype-install shape:
 * const tuning = createTuningRegistry('producer-tuning');
 * ctx.provide(ProducerTuningRegistryKey, tuning);
 *
 * // Consumer modules use tunable() to declare individual values:
 * const effect = tunable(tuning, 'upgrades/double-gold/effect', () =>
 *   Decimal.mul(baseEffect, purchasable.amount.value),
 * );
 * ```
 */
export function createTuningRegistry(name: string): TuningRegistry {
  const registry = createOverrideRegistry<Record<string, () => DecimalSource>>(name);
  const ambient = _currentTuningRegistries;
  if (ambient) ambient.add(registry);
  return registry;
}

// === AMBIENT TUNING-REGISTRIES CONTEXT ===
let _currentTuningRegistries: Set<TuningRegistry> | undefined;

/**
 * Run `fn` with `set` as the ambient tuning-registries collection. Any
 * `createTuningRegistry` called inside `fn` auto-registers into `set`.
 *
 * Used by {@link createEngine} to scope tuning-registry registration to
 * the current engine during its `install()` / `connect()` phases. Nested
 * calls save and restore the previous ambient so multiple engines
 * starting concurrently don't stomp each other.
 *
 * @internal Consumer code should not call this directly.
 */
export function withTuningRegistries<T>(set: Set<TuningRegistry>, fn: () => T): T {
  const prev = _currentTuningRegistries;
  _currentTuningRegistries = set;
  try {
    return fn();
  } finally {
    _currentTuningRegistries = prev;
  }
}

/**
 * Read the current ambient tuning-registries set, if any. Returns
 * `undefined` outside a `withTuningRegistries` block.
 *
 * @internal Used by {@link createTuningRegistry} to auto-register.
 */
export function getCurrentTuningRegistries(): Set<TuningRegistry> | undefined {
  return _currentTuningRegistries;
}

/** Keys of `T` whose function takes no arguments — the ones a `tunable` default can fill. */
type NullaryKeys<T> = { [P in keyof T]: T[P] extends () => unknown ? P : never }[keyof T] & string;

/** A literal return widened to its primitive, so a `let` holding a `tunable` stays reassignable. */
type Widen<R> = R extends number
  ? number
  : R extends string
    ? string
    : R extends boolean
      ? boolean
      : R;

/**
 * Bind a default implementation to `key` on `registry` and return a
 * reactive `ComputedRef` that re-evaluates when the scope stack changes
 * or the key is overridden.
 *
 * **`tunable()` is the opt-in declaration that a value belongs in the
 * externally-controlled tuning surface.** It is neither a primitive of
 * last resort ("only for places others can't reach") nor a universal
 * naming layer ("name every value through tunable"). Grep `tunable(` to
 * find the auditable surface of values declared as tuning targets — that
 * grep is load-bearing, and is only useful when `tunable` stays opt-in.
 *
 * Criteria for adding a `tunable()` wrap:
 *
 * 1. The value is **designer-meaningful** — a balance dial, not an
 *    implementation detail.
 * 2. The designer wants it surfaced to workbench / solver / sensitivity-
 *    analysis tooling.
 * 3. The value doesn't already have a **better** identity. A `Modifier`
 *    in a `ModifierChain` has structural identity sufficient for external
 *    tools — wrapping in `tunable` would be redundant naming.
 *
 * Negative criteria — do **not** add `tunable()` for:
 *
 * - Implementation constants (loop tick interval, internal buffer sizes).
 * - Values that are functions of other tunables (those are *derived* —
 *   tune the upstream).
 * - Anything in a hot evaluation path where the per-read indirection
 *   cost compounds.
 * - Values that already have structural identity sufficient for the use
 *   case (chains, modifiers, resources).
 *
 * Pair with {@link createTuningRegistry} for the registry boundary that
 * opts the registry into picker enumeration. Using `tunable()` with a
 * plain `createOverrideRegistry` registry works for reactive read /
 * scope-override semantics but skips picker discoverability — appropriate
 * when the surface is internal to a subsystem and shouldn't appear in
 * the workbench.
 *
 * The default function is registered via `setDefault`, so it's a no-op if
 * another caller already claimed the key — that matches vanilla-vs-mod
 * resolution order and avoids silent clobber across installers.
 *
 * @param registry - The override registry to bind into. Use
 *   {@link TuningRegistry} (created via {@link createTuningRegistry}) when
 *   the value should surface in the picker.
 * @param key - Unique key within the registry (convention: namespaced
 *   path like `"upgrades/double-gold/effect"` so grep surfaces the
 *   category and the field together). A typed registry accepts only its
 *   zero-arg keys.
 * @param defaultFn - Default zero-arg reader. Typically a closure over
 *   the underlying persistent/computed state. Reads inside this function
 *   register their own reactive deps, so the returned computed also
 *   reacts to changes in the underlying state. Must fit the registry's
 *   type for `key`; its return type, with literals widened, types the result.
 * @returns A `ComputedRef` that reads through the registry's scope
 *   stack.
 *
 * @example
 * ```ts
 * const tuning = createTuningRegistry('producer-tuning');
 *
 * const effect = tunable(tuning, 'upgrades/double-gold/effect', () =>
 *   Decimal.mul(baseEffect, purchasable.amount.value),
 * );
 *
 * // Later, from a sim takeover UI:
 * const restore = tuning.pushScope('sim-takeover', {
 *   'upgrades/double-gold/effect': () => 9999,
 * });
 * // effect.value is now 9999; Vue re-renders dependents automatically.
 * restore();
 * // effect.value falls back to the closure over baseEffect + amount.
 * ```
 */
export function tunable<
  T extends { [P in keyof T]: (...args: never[]) => unknown },
  K extends NullaryKeys<T>,
  F extends T[K] & (() => unknown),
>(registry: OverrideRegistry<T>, key: K, defaultFn: F): ComputedRef<Widen<ReturnType<F>>> {
  registry.setDefault(key, defaultFn);
  return computed(() => {
    // Register a reactive dep on the registry so push/cleanup/override retriggers.
    // The default fn's own reads register deps on the underlying state.
    void registry.scopeVersion.value;
    return (registry.get(key) as () => Widen<ReturnType<F>>)();
  });
}
