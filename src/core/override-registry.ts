/**
 * Override Registry — generic typed registry with scoped overrides, plus
 * the typed `TuningRegistry` narrow that opts a registry into the picker's
 * tunable enumeration.
 *
 * This file serves two purposes:
 *
 * - `createOverrideRegistry<T>(id)` is the general-purpose override
 *   primitive. Use it for mod overrides, challenge overrides, balance-harness
 *   perturbations and debug overrides. The generic `T` admits variadic-arg
 *   signatures and any return type. The picker does **not** enumerate
 *   registries created this way.
 *
 * - `createTuningRegistry(id)` is a typed narrow over
 *   `OverrideRegistry<Record<string, () => DecimalSource>>`. Inside
 *   `withTuningRegistries(...)`, it adds itself to the ambient
 *   `TuningRegistriesKey` set. The picker's `walkTunables` enumerates the
 *   base-map keys of every tuning registry in that set. So
 *   `createTuningRegistry` is the boundary between "this registry holds
 *   designer-flagged tuning values" and "this registry holds general
 *   overrides."
 *
 * `tunable()` is the value-shaped construction primitive built on top.
 * Give it a `TuningRegistry` (from `createTuningRegistry`) when the value
 * should appear in the picker, a balance workbench or sensitivity-analysis
 * tooling. A plain `OverrideRegistry` works for any other override.
 *
 * Resolution order: the scoped overrides, newest first, then the base map.
 * Several scoped overrides can be pushed at once. Each `pushOverrides`
 * returns its own cleanup, and a cleanup is idempotent.
 *
 * `overrideVersion` is a version ref that bumps whenever a resolution can
 * change. Those changes are every push and cleanup, every `override`, and a
 * `setDefault` that registers a new key. Read it inside a Vue `computed` to make the
 * computed re-evaluate on those changes. {@link tunable} reads it.
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
 * const cleanup = combat.pushOverrides('challenge:zombie', {
 *   getSelfCombat: () => 0,                          // scoped override
 * });
 * combat.get('getSelfCombat')();  // 0
 * cleanup();
 * combat.get('getSelfCombat')();  // 99 (back to mod override)
 *
 * // Tuning registry — enumerated by picker, shown in a balance workbench.
 * const tuning = createTuningRegistry('producer-tuning');
 * const effect = tunable(tuning, 'upgrades/double-gold/effect', () =>
 *   Decimal.mul(baseEffect, purchasable.count.value),
 * );
 * ```
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { DecimalSource } from '../primitives/decimal';
import type { InjectionKey } from '../primitives/types';

// === TYPES ===
/** One scoped override: a labelled set of overrides on the stack */
interface ScopedOverrides<T> {
  readonly label: string;
  readonly overrides: Partial<T>;
}

/**
 * A typed, scoped override registry for named functions.
 *
 * @typeParam T - Record of named functions (e.g., `{ getSelfCombat: () => number }`)
 */
export interface OverrideRegistry<T extends { [K in keyof T]: (...args: never[]) => unknown }> {
  /** Registry id passed to `createOverrideRegistry`, shown in error messages. */
  readonly id: string;

  /**
   * Register the registry default for a key. No-op if the key already has a base value.
   * Called by shared modules during install.
   */
  setDefault<K extends keyof T & string>(key: K, fn: T[K]): void;

  /**
   * Permanently override a key (sets regardless of an existing base value).
   * Called by a mod's modules during install.
   */
  override<K extends keyof T & string>(key: K, fn: T[K]): void;

  /**
   * Resolve a key: check the scoped overrides, newest first, then the base map.
   * @throws If no scoped override and no base-map entry holds the key
   */
  get<K extends keyof T & string>(key: K): T[K];

  /** Check if a key exists in any scoped override or the base map */
  has(key: keyof T & string): boolean;

  /**
   * Snapshot of the base-map keys: the design-time keys declared
   * through `setDefault` / `override`. Keys only a scoped override holds
   * are excluded on purpose. Those are temporary challenge, prestige or
   * perturbation overrides: engine *state*, not author-declared intent.
   * Showing them in a picker or introspection would add entries that
   * vanish on cleanup. Do not change this to return base ∪ scoped keys.
   */
  getBaseKeys(): readonly string[];

  /**
   * Push overrides: a scoped override onto the stack.
   * Returns an idempotent cleanup function that removes exactly this scoped override.
   *
   * @param label - Human-readable label for debugging (e.g., "challenge:zombie")
   * @param overrides - Partial map of keys to override while this scoped override is pushed
   */
  pushOverrides(label: string, overrides: Partial<T>): () => void;

  /** Number of scoped overrides on the stack. Reactive. */
  readonly overrideDepth: number;

  /**
   * Version ref that bumps whenever a key's resolution can change. Those
   * changes are every push and cleanup, every `override`, and a `setDefault`
   * that registers a new key. A no-op `setDefault` doesn't bump it. Read it inside a
   * `computed` to make it re-evaluate on those changes. {@link tunable}
   * reads it.
   */
  readonly overrideVersion: Ref<number>;
}

/**
 * Typed narrow over {@link OverrideRegistry} for values declared on purpose
 * as tunables. Every key resolves to a zero-arg reader returning a
 * `DecimalSource`. The picker's discovery walker reads every tuning registry
 * through the ambient {@link TuningRegistriesKey} set.
 */
export type TuningRegistry = OverrideRegistry<Record<string, () => DecimalSource>>;

/**
 * Per-engine collection of tuning registries — the picker's
 * `walkTunables` reads this. `createEngine` provides it as an empty
 * `Set<TuningRegistry>`. Each `createTuningRegistry` call adds to it while
 * the engine's `withTuningRegistries(...)` sets it as the ambient value,
 * during install/connect.
 *
 * Mirrors the {@link ChainRegistryKey} pattern: per-engine collection,
 * ambient auto-registration, picker enumerates without consumer-side
 * publication.
 */
export const TuningRegistriesKey = Symbol('engine:tuning-registries') as InjectionKey<
  Set<TuningRegistry>
>;

// === FACTORY ===
/** Whether a scoped override supplies its own, defined entry for `key`. */
function overridesKey<T>(scope: ScopedOverrides<T>, key: keyof T & string): boolean {
  return Object.hasOwn(scope.overrides, key) && scope.overrides[key] !== undefined;
}

/**
 * Create a new override registry.
 *
 * @param id - Registry id, shown in error messages (e.g., "game-overrides")
 */
export function createOverrideRegistry<T extends { [K in keyof T]: (...args: never[]) => unknown }>(
  id: string,
): OverrideRegistry<T> {
  const base = new Map<string, (...args: never[]) => unknown>();
  const scopedOverrides: ScopedOverrides<T>[] = [];
  const overrideVersion = ref(0);

  return {
    id,
    overrideVersion,
    setDefault<K extends keyof T & string>(key: K, fn: T[K]): void {
      if (!base.has(key)) {
        base.set(key, fn);
        overrideVersion.value++;
      }
    },

    override<K extends keyof T & string>(key: K, fn: T[K]): void {
      base.set(key, fn);
      overrideVersion.value++;
    },

    get<K extends keyof T & string>(key: K): T[K] {
      // Check scoped overrides, newest first
      for (let i = scopedOverrides.length - 1; i >= 0; i--) {
        const scope = scopedOverrides[i];
        if (overridesKey(scope, key)) return scope.overrides[key] as T[K];
      }

      const fn = base.get(key);
      if (fn === undefined) {
        throw new Error(`[${id}] Override "${key}" not registered`);
      }
      return fn as T[K];
    },

    has(key: keyof T & string): boolean {
      for (let i = scopedOverrides.length - 1; i >= 0; i--) {
        if (overridesKey(scopedOverrides[i], key)) return true;
      }
      return base.has(key);
    },

    getBaseKeys(): readonly string[] {
      return Array.from(base.keys());
    },

    pushOverrides(label: string, overrides: Partial<T>): () => void {
      const scope: ScopedOverrides<T> = { label, overrides };
      scopedOverrides.push(scope);
      overrideVersion.value++;

      return () => {
        const idx = scopedOverrides.indexOf(scope);
        if (idx === -1) return;
        scopedOverrides.splice(idx, 1);
        overrideVersion.value++;
      };
    },

    get overrideDepth(): number {
      void overrideVersion.value;
      return scopedOverrides.length;
    },
  };
}

/**
 * Create a tuning registry — typed narrow over {@link OverrideRegistry} for
 * `Record<string, () => DecimalSource>`-shaped registries that opt into the
 * picker's tunable enumeration.
 *
 * The factory name is the boundary. Calling `createTuningRegistry`
 * declares "this registry holds designer-flagged tuning values; show
 * them in a balance workbench." Calling `createOverrideRegistry` directly
 * opts out. That fits challenge overrides, a mod's replacements,
 * balance-harness perturbations and other general overrides.
 *
 * Auto-registration happens only inside `withTuningRegistries(...)`, the
 * ambient value `createEngine` sets during install/connect. A registry
 * built outside it (tests, throwaway scripts) skips registration silently.
 * The registry still works; the picker just does not find it.
 *
 * @param id - Registry id. It is the prefix of each
 *   `TunablePickerEntry.label`.
 * @returns A {@link TuningRegistry} — same shape as `OverrideRegistry`
 *   with the value type narrowed to `() => DecimalSource`.
 *
 * @example
 * ```ts
 * // Typical install shape:
 * const tuning = createTuningRegistry('producer-tuning');
 * ctx.provide(ProducerTuningRegistryKey, tuning);
 *
 * // Consumer modules use tunable() to declare individual values:
 * const effect = tunable(tuning, 'upgrades/double-gold/effect', () =>
 *   Decimal.mul(baseEffect, purchasable.count.value),
 * );
 * ```
 */
export function createTuningRegistry(id: string): TuningRegistry {
  const registry = createOverrideRegistry<Record<string, () => DecimalSource>>(id);
  const ambient = _currentTuningRegistries;
  if (ambient) ambient.add(registry);
  return registry;
}

// === AMBIENT TUNING REGISTRIES ===
let _currentTuningRegistries: Set<TuningRegistry> | undefined;

/**
 * Run `fn` with `set` as the ambient tuning-registries collection. Any
 * `createTuningRegistry` called inside `fn` auto-registers into `set`.
 *
 * {@link createEngine} calls it to limit tuning-registry registration to
 * its own engine during install/connect. Nested calls save and restore
 * the previous ambient value. So engines built one inside another do not
 * overwrite each other's set.
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
 * Register a registry default for `key` on `registry` and return a
 * reactive `ComputedRef`. It re-evaluates when a scoped override is pushed
 * or popped, or when the key is overridden.
 *
 * **`tunable()` is the opt-in declaration that a value is tuned from
 * outside the game.** It is neither a primitive of last resort ("only for
 * places others can't reach") nor a universal naming convention ("name every
 * value through tunable"). Grep `tunable(` to find every value declared
 * as a tuning target. That grep is the audit, and it works only while
 * `tunable` stays opt-in.
 *
 * Criteria for declaring a value through `tunable()`:
 *
 * 1. The value is **designer-meaningful** — a balance constant, not an
 *    implementation detail.
 * 2. The designer wants it shown in a balance workbench, a solver or
 *    sensitivity-analysis tooling.
 * 3. The value doesn't already have a **better** identity. A `Modifier`
 *    in a `ModifierChain` has structural identity sufficient for external
 *    tools — declaring it through `tunable` would be redundant naming.
 *
 * Negative criteria — do **not** add `tunable()` for:
 *
 * - Implementation constants (the game-loop interval, internal buffer sizes).
 * - Values that are functions of other tunables (those are *derived* —
 *   tune the upstream).
 * - Anything in a hot evaluation path where the per-read indirection
 *   cost compounds.
 * - Values that already have structural identity sufficient for the use
 *   case (chains, modifiers, resources).
 *
 * Pair it with {@link createTuningRegistry}, the registry boundary that
 * opts the registry into picker enumeration. `tunable()` on a plain
 * `createOverrideRegistry` registry still gives reactive reads and scoped
 * overrides, but the picker does not find it. That fits values internal
 * to one subsystem, which should not appear in a balance workbench.
 *
 * The default function is registered through `setDefault`. So it is a
 * no-op if another caller already claimed the key. That matches the order
 * in which a shared module's `setDefault` yields to a mod's `override`, and
 * no install silently overwrites another.
 *
 * @param registry - The override registry to register into. Use a
 *   {@link TuningRegistry} (from {@link createTuningRegistry}) when the
 *   value should appear in the picker.
 * @param key - Unique key within the registry. By convention it is a
 *   slash path like `"upgrades/double-gold/effect"`, so a grep finds the
 *   category and the field together. A typed registry accepts only its
 *   zero-arg keys.
 * @param defaultFn - Default zero-arg reader. Typically a closure over
 *   the underlying persistent/computed state. Reads inside this function
 *   register their own reactive deps, so the returned computed also
 *   reacts to changes in the underlying state. Must fit the registry's
 *   type for `key`; its return type, with literals widened, types the result.
 * @returns A `ComputedRef` that reads through the registry's scoped
 *   overrides.
 *
 * @example
 * ```ts
 * const tuning = createTuningRegistry('producer-tuning');
 *
 * const effect = tunable(tuning, 'upgrades/double-gold/effect', () =>
 *   Decimal.mul(baseEffect, purchasable.count.value),
 * );
 *
 * // Later, from a balance workbench:
 * const restore = tuning.pushOverrides('workbench', {
 *   'upgrades/double-gold/effect': () => 9999,
 * });
 * // effect.value is now 9999; Vue re-renders dependents automatically.
 * restore();
 * // effect.value falls back to the closure over baseEffect + count.
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
    void registry.overrideVersion.value;
    return (registry.get(key) as () => Widen<ReturnType<F>>)();
  });
}
