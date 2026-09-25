/**
 * Resource system — the fundamental currency of incremental games
 *
 * A resource is a named, persistent, reactive Decimal value. Everything in an
 * incremental game revolves around resources: earning points, spending gold,
 * converting prestige currency. This module provides:
 *
 * - {@link createResource} — create a named value with auto-persistence,
 *   engine-scoped registration, and the lifetime `cumulative` / `best`
 *   trackers (built when the resource is created inside a persistent context)
 * - {@link addResource} / {@link subtractResource} / {@link hasResource} — arithmetic helpers
 * - {@link displayResource} — formatted string using the resource's precision settings
 * - {@link unwrapResource} — dereference a `Resource | Ref<Resource>` to the underlying Resource
 * - {@link resetResource} — set a resource's value back to its persisted default (or 0)
 *
 * Resources created inside an engine's `install()` / `connect()` phase are
 * automatically added to that engine's {@link ResourceRegistry} via the
 * ambient pattern established by `withResourceRegistry`. External tools read
 * the registry via `engine.tryInject(ResourceRegistryKey)`.
 */

import { isRef, unref, watch, type Ref } from 'vue';
import { Decimal, format, formatWhole } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import {
  persistent,
  loadingSave,
  getCurrentContext,
  withPersistentContext,
  type Persistent,
  type StateConstraint,
  NonPersistent,
  DefaultValue,
  cloneDefault,
} from './persistence';
import { withChain } from './trace';
import { getCurrentResourceRegistry } from './registries';
import type { Modifier } from './modifier';

export type { ResourceRegistryEntry } from './registries';

/**
 * A named, quantifiable game value backed by a Vue ref.
 *
 * Because Resource extends Ref, it can be used directly in Vue templates,
 * computed properties, and watchers — `resource.value` reads and writes
 * the current amount.
 */
export interface Resource<T = DecimalSource> extends Ref<T> {
  /**
   * Stable identifier for save-data and accessor lookups. Falls back to
   * `displayName` when {@link ResourceOptions.id} is unset. Use this (not
   * `displayName`) as the key when forwarding to {@link GameStateAccessor}
   * methods like `getResource`/`getRate`.
   */
  id: string;
  /** Human-readable name shown in UI and used for resource-registry lookups by name */
  displayName: string;
  /** Number of decimal places to show when formatting (0 = whole numbers only) */
  precision: number;
  /** If true, very small values are displayed as-is instead of rounding to 0 */
  small?: boolean;
  /**
   * Cumulative-gain accumulator — sums every strictly-increasing motion of
   * the resource over its full life. Decreases don't subtract; refunds
   * (a decrease followed by a re-increase) count as new gain. Starts at the
   * resource's default, so a starting balance counts as earned. Present on a
   * persistent resource created inside a persistent context (any engine
   * module); absent outside one, and for derived/computed resources created
   * via the {@link createResource} ref-wrapping overload.
   *
   * Persistent under a per-resource sub-context, so two resources in the
   * same module don't collide on the tracker name. Tagged `lifetime: true`
   * so module-scoped resets ignore it — `cumulative` survives every prestige,
   * transcend, etc. by default, matching its "full life" semantic. Read by
   * Gate's `cumulative-gte` kind via the ambient resource registry. To wipe
   * cumulative on a hard reset, target it explicitly via
   * `createReset({ thingsToReset: [resource.cumulative] })`.
   */
  cumulative?: Ref<DecimalSource> & Persistent<DecimalSource>;
  /**
   * High-water mark. Monotonically non-decreasing over the resource's full
   * life. Present and absent exactly as {@link Resource.cumulative} is.
   * Persistent under a per-resource sub-context, tagged
   * `lifetime: true` so module-scoped resets pass it over (same opt-out
   * shape as {@link Resource.cumulative}).
   */
  best?: Ref<DecimalSource> & Persistent<DecimalSource>;
}

/** Configuration for {@link createResource} */
export interface ResourceOptions {
  /** Display name for the resource. Used in UI and registry lookups. Default: `"points"` */
  displayName?: string;
  /** Number of decimal places to show when formatting. Default: `0` (whole numbers) */
  precision?: number;
  /** If true, display very small values as-is instead of rounding to 0. Off by default. */
  small?: boolean;
  /**
   * Save and registry identity — the key Gates and the resource registry
   * look the resource up by. Required for a persistent resource, whose value
   * saves under it; a wrapped ref saves nothing and falls back to
   * `displayName`. Collision within a persistent context throws at creation,
   * and so does a `.` in a persistent resource's id, since save paths split on it.
   */
  id?: string;
}

/** Configuration for a persistent {@link createResource}: `id` is required. */
export type PersistentResourceOptions = ResourceOptions & { id: string };

/**
 * Wrap an existing ref as a resource (non-persistent).
 *
 * Use this overload for derived or computed values that should look like a
 * resource (display name, formatting) but don't need their own persistence —
 * e.g., a "net income" display backed by a computed ref.
 *
 * Declared before the default-value overload so an existing `Ref<T>` argument
 * binds here: the default-value overload's `T & StateConstraint<T>` parameter
 * is structural enough to also swallow a ref (inferring `T = Ref<T>`), so with
 * the reverse order a ref would resolve to a bogus `Resource<Ref<T>> &
 * Persistent<...>`. Overload resolution is first-match, and a non-ref value
 * never matches `Ref<T>`, so this ordering is safe for both call shapes.
 *
 * @param existingRef - An existing Vue ref to wrap with resource metadata
 * @param options - Display name, precision, and formatting controls
 * @returns A resource view over the existing ref (not persisted)
 *
 * @example
 * ```ts
 * const netIncome = computed(() => Decimal.sub(income.value, expenses.value));
 * const netIncomeResource = createResource(netIncome, { displayName: 'net income', precision: 1 });
 * displayResource(netIncomeResource); // formatted string
 * ```
 */
export function createResource<T>(existingRef: Ref<T>, options?: ResourceOptions): Resource<T>;

/**
 * Create a persistent resource — the standard way to define a game currency.
 *
 * The returned value is both a Vue ref (reactive, watchable) and a persistent
 * ref (auto-saved/loaded). When called inside an engine's install/connect
 * phase, it is also registered in that engine's resource registry for
 * discovery by balance workbenches, trace views, and other introspection tools.
 *
 * @param defaultValue - Starting value for new saves. Use `0` or `new Decimal(...)`.
 * @param options - Display name, precision, and formatting controls
 * @returns A reactive, persistent resource with display metadata
 *
 * @example
 * ```ts
 * // Basic currency — whole-number display, starts at 0
 * const points = createResource(0, { id: 'points', displayName: 'Points' });
 *
 * // Fractional currency — 2 decimal places, starts at 100
 * const gold = createResource(new Decimal(100), { id: 'gold', displayName: 'Gold', precision: 2 });
 *
 * // Use like any Vue ref
 * watch(points, (val) => console.log('Points changed:', val));
 * addResource(points, 10); // points.value is now Decimal(10)
 * ```
 */
export function createResource<T>(
  defaultValue: T & StateConstraint<T>,
  options: PersistentResourceOptions,
): Resource<T> & Persistent<T> & { [NonPersistent]: Resource<T> };

export function createResource<T>(
  defaultValue: (T & StateConstraint<T>) | Ref<T>,
  options: ResourceOptions = {},
): Resource<T> {
  const { displayName = 'points', precision = 0, small = false, id } = options;
  // A display name is text, free to change or be translated; only a wrapped
  // ref, which saves nothing, may be keyed by it.
  const resolvedId = (isRef(defaultValue) ? (id ?? displayName) : id) as string;
  if (!isRef(defaultValue) && id?.includes('.')) {
    throw new Error(
      `Resource id "${resolvedId}" contains ".", which save paths split on. Use another separator, such as "-".`,
    );
  }

  // Create persistent or use existing ref. Use the resource's id as the
  // save-data name so round-trips survive field reorders inside a context.
  const resource: Partial<Resource<T>> = isRef(defaultValue)
    ? defaultValue
    : persistent(defaultValue, { name: resolvedId });

  // Attach resource metadata
  resource.id = resolvedId;
  resource.displayName = displayName;
  resource.precision = precision;
  resource.small = small;

  // Single ambient-context read shared by the tracker setup below and the
  // registry registration at the end. The two sites both need to know
  // whether we're inside an engine namespace; nothing between them changes
  // the ambient context.
  const parentContext = getCurrentContext();

  // If we created a persistent ref, also set metadata on the non-persistent wrapper
  if (!isRef(defaultValue)) {
    const nonPersistentResource = (resource as Persistent<T>)[NonPersistent] as unknown as Partial<
      Resource<T>
    >;
    nonPersistentResource.id = resolvedId;
    nonPersistentResource.displayName = displayName;
    nonPersistentResource.precision = precision;
    nonPersistentResource.small = small;

    // Cumulative + best trackers are intrinsic to a persistent resource —
    // their persistence path is identity-bound to the resource id, so two
    // resources in the same module each get their own sub-context for
    // 'cumulative' and 'best' without colliding on the tracker name.
    //
    // Skipped when the resource is created outside any persistent context
    // (raw test fixtures, throwaway scripts) — same convention as the
    // ResourceRegistry registration below.
    if (parentContext !== undefined) {
      // Persistent contexts are flat under the engine namespace, so we
      // qualify the tracker sub-context with the parent context id to
      // keep paths identity-bound: two modules with the same resource id
      // each get distinct tracker contexts under their own module path.
      withPersistentContext(`${parentContext}::${resolvedId}`, () => {
        const initial = defaultValue as DecimalSource;
        // `lifetime: true` so module-scoped resets pass over these trackers.
        // Without the flag, a `createReset({ resetModules: [moduleId] })`
        // would zero `cumulative` / `best` even when the underlying resource
        // was kept via `keep:[resource]`, contradicting the "full life"
        // semantic these refs advertise. To wipe lifetime stats on a hard
        // reset, hand the tracker ref to `thingsToReset` directly.
        const cumulative = persistent<DecimalSource>(initial, {
          name: 'cumulative',
          lifetime: true,
        });
        const best = persistent<DecimalSource>(initial, {
          name: 'best',
          lifetime: true,
        });

        // flush: 'sync' so sim harnesses driving engine.tickDriver.stepOnce()
        // in a tight loop (no microtask boundary between ticks) still observe
        // updates on the same tick the source resource changed.
        watch(
          resource as Ref<DecimalSource>,
          (amount, prevAmount) => {
            if (loadingSave.value) return;
            if (Decimal.gt(amount, prevAmount)) {
              cumulative.value = Decimal.add(cumulative.value, Decimal.sub(amount, prevAmount));
            }
          },
          { flush: 'sync' },
        );

        watch(
          resource as Ref<DecimalSource>,
          (amount) => {
            if (loadingSave.value) return;
            if (Decimal.gt(amount, best.value)) {
              best.value = amount;
            }
          },
          { flush: 'sync' },
        );

        resource.cumulative = cumulative;
        resource.best = best;
      });
    }
  }

  // Register in the ambient engine-scoped registry. Resources created
  // outside an engine (top-level tests, throwaway scripts) silently skip
  // registration — the primitive still works, just isn't discoverable.
  getCurrentResourceRegistry()?.register({
    resource: resource as Resource,
    context: parentContext,
  });

  return resource as Resource<T>;
}

/**
 * Format a resource value with its configured precision.
 *
 * @param resource - The resource to display
 * @param overrideAmount - Optional value to display instead of current value
 * @returns Formatted string representation
 *
 * @example
 * ```ts
 * const gold = createResource(1234.567, { id: 'gold', displayName: 'Gold', precision: 2 })
 * displayResource(gold) // "1.235 k" — notation takes over above 1000; precision no longer digits-after-decimal
 * displayResource(gold, 999) // "999.00"
 * ```
 */
export function displayResource(resource: Resource, overrideAmount?: DecimalSource): string {
  const amount = overrideAmount ?? resource.value;
  if (resource.precision === 0) {
    return formatWhole(resource.small ? amount : Decimal.floor(amount));
  }
  return format(amount, resource.precision, resource.small);
}

/**
 * Unwrap a resource that may or may not be inside a ref.
 * Useful when accepting MaybeRef<Resource> parameters.
 *
 * @param resource - A resource or ref containing a resource
 * @returns The unwrapped resource
 */
export function unwrapResource(resource: Resource | Ref<Resource>): Resource {
  if ('displayName' in resource) {
    return resource;
  }
  return unref(resource);
}

/**
 * Add an amount to a resource. The most common operation in an incremental game.
 *
 * @param resource - The resource to increase
 * @param amount - The amount to add (Decimal or number)
 * @param chain - Optional modifier chain for trace attribution (see trace module)
 */
export function addResource(
  resource: Resource<DecimalSource>,
  amount: DecimalSource,
  chain?: Modifier,
): void {
  if (chain) {
    withChain(chain, () => {
      resource.value = Decimal.add(resource.value, amount);
    });
  } else {
    resource.value = Decimal.add(resource.value, amount);
  }
}

/** Options for {@link subtractResource} */
export interface SubtractResourceOptions {
  /** If true, the resource can go below zero. Default: `false` (subtraction fails instead) */
  allowNegative?: boolean;
  /** Modifier chain for trace attribution (see trace module) */
  chain?: Modifier;
}

/**
 * Subtract an amount from a resource, failing gracefully if insufficient.
 *
 * By default, returns `false` and leaves the resource unchanged if the
 * subtraction would go negative. Pass `allowNegative: true` to permit
 * negative values.
 *
 * @param resource - The resource to decrease
 * @param amount - The amount to subtract (Decimal or number)
 * @param options - Subtraction behavior (allowNegative, chain attribution)
 * @returns `true` if subtraction was applied, `false` if blocked by insufficient funds
 */
export function subtractResource(
  resource: Resource<DecimalSource>,
  amount: DecimalSource,
  options?: SubtractResourceOptions,
): boolean {
  const allowNegative = options?.allowNegative ?? false;
  const chain = options?.chain;

  const newValue = Decimal.sub(resource.value, amount);
  if (!allowNegative && Decimal.lt(newValue, 0)) {
    return false;
  }
  if (chain) {
    withChain(chain, () => {
      resource.value = newValue;
    });
  } else {
    resource.value = newValue;
  }
  return true;
}

/**
 * Check if a resource has at least a certain amount.
 *
 * @param resource - The resource to check
 * @param amount - The minimum amount required
 * @returns true if resource >= amount
 */
export function hasResource(resource: Resource<DecimalSource>, amount: DecimalSource): boolean {
  return Decimal.gte(resource.value, amount);
}

/**
 * Reset a resource to its default value (or zero).
 *
 * @param resource - The resource to reset
 */
export function resetResource<T extends DecimalSource>(resource: Resource<T>): void {
  const persistentResource = resource as Resource<T> & Partial<Persistent<T>>;
  if (persistentResource[DefaultValue] !== undefined) {
    resource.value = cloneDefault(persistentResource[DefaultValue]);
  } else {
    resource.value = 0 as T;
  }
}
