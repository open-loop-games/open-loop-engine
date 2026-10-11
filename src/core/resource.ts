/**
 * Resource — the reactive, saved quantities an incremental game is built on
 *
 * A resource is a named, persistent, reactive Decimal value. Everything in an
 * incremental game revolves around resources: gaining points, spending gold,
 * converting prestige currency. This file provides:
 *
 * - {@link createResource} — create a named value with auto-persistence,
 *   engine-scoped registration, and the lifetime `cumulative` / `best`
 *   trackers (built when the resource is created inside a persistent context)
 * - {@link addResource} / {@link subtractResource} / {@link hasResource} — arithmetic utilities
 * - {@link formatResource} — formatted string using the resource's `decimals` and `small` settings
 * - {@link unwrapResource} — dereference a `Resource | Ref<Resource>` to the underlying Resource
 * - {@link resetResource} — set a resource's value back to its ref default (or 0)
 *
 * A resource created during an engine's install/connect is added to that
 * engine's {@link ResourceRegistry}, an ambient value that
 * `withResourceRegistry` sets. External tools read the registry through
 * `engine.tryInject(ResourceRegistryKey)`.
 */

import { isRef, unref, watch, type Ref } from 'vue';
import { Decimal, format, formatWhole } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import {
  persistent,
  settling,
  getCurrentPersistentContext,
  withPersistentContext,
  type IfSerializable,
  type Persistent,
  type PersistentOptions,
  type SerializableConstraint,
  PersistentAlias,
  DefaultValue,
  resetPersistent,
} from './persistence';
import { withTraceChain } from './trace';
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
   * Stable id for save data and accessor lookups. It is the
   * {@link ResourceOptions.id} as passed, with no persistent-context prefix,
   * and unique per engine. A wrapped ref created without an id takes
   * its `displayName`. Pass this id, not `displayName`, to
   * {@link GameStateAccessor} methods such as `getAmount` and `getRate`.
   */
  id: string;
  /** Text the player sees, also matched by the resource registry's `findByDisplayName` */
  displayName: string;
  /** Number of decimal places to show when formatting (0 = whole numbers only) */
  decimals: number;
  /** If true, `formatResource` shows very small values instead of rounding them to 0 */
  small?: boolean;
  /**
   * Total gain — the sum of every increase of the resource over its full
   * life. Decreases don't subtract; refunds (a decrease followed by a
   * re-increase) count as new gain. A linked `ResourceBag`'s capacity clamps a
   * gain before it counts, so overflow the bag discards reaches neither this
   * nor `best`. Starts at the resource's ref default, so a starting amount
   * counts as gain. Present on a persistent resource created inside a
   * persistent context (any engine module). Absent outside one, and for
   * derived or computed resources created with the {@link createResource}
   * ref-wrapping overload.
   *
   * Saved under a child persistent context per resource, so two resources in
   * the same module don't collide on the tracker id. Tagged `lifetime: true`,
   * so a reset that names the module's persistent context leaves it alone:
   * `cumulative` survives every reset by default, as "full life" says. Gate's
   * `cumulative-gte` kind reads it through the ambient resource registry. To
   * clear it on a hard reset, name it:
   * `createReset({ thingsToReset: [resource.cumulative] })`.
   */
  cumulative?: Ref<DecimalSource> & Persistent<DecimalSource>;
  /**
   * High-water mark. Monotonically non-decreasing over the resource's full
   * life. Present and absent exactly as {@link Resource.cumulative} is.
   * Saved under a child persistent context per resource and tagged
   * `lifetime: true`. So a reset passes it over unless the reset names it, as
   * with {@link Resource.cumulative}.
   */
  best?: Ref<DecimalSource> & Persistent<DecimalSource>;
}

/** Options for {@link createResource} */
export interface ResourceOptions {
  /** Text the player sees, also matched by registry lookups. Default: `"points"` */
  displayName?: string;
  /** Number of decimal places to show when formatting. Default: `0` (whole numbers) */
  decimals?: number;
  /** If true, show very small values instead of rounding them to 0. Off by default. */
  small?: boolean;
  /**
   * Save and registry identity — the id Gates and the resource registry
   * look the resource up by. Required for a persistent resource, whose value
   * saves under it; a wrapped ref saves nothing and falls back to
   * `displayName`. Unique per engine: a repeat throws at creation, and so
   * does a `.` in a persistent resource's id, since save paths split on it.
   */
  id?: string;
}

/** Options for a persistent {@link createResource}: `id` is required. */
export type PersistentResourceOptions = ResourceOptions & { id: string };

/**
 * Wrap an existing ref as a resource that saves nothing.
 *
 * Use this overload for derived or computed values that should look like a
 * resource (display name, formatting) but need no save of their own. An
 * example is a net rate shown from a computed ref.
 *
 * Declared before the default-value overload so an existing `Ref<T>` argument
 * binds here: the default-value overload's bare `T` parameter would also
 * swallow a ref (inferring `T = Ref<T>`), so with
 * the reverse order a ref would resolve to a bogus `Resource<Ref<T>> &
 * Persistent<...>`. Overload resolution is first-match, and a non-ref value
 * never matches `Ref<T>`, so this ordering is safe for both call shapes.
 *
 * @param existingRef - An existing Vue ref to wrap with resource metadata
 * @param options - Display name and formatting options
 * @returns The existing ref with resource metadata attached; it saves nothing
 *
 * @example
 * ```ts
 * const netIncome = computed(() => Decimal.sub(income.value, expenses.value));
 * const netIncomeResource = createResource(netIncome, { displayName: 'net income', decimals: 1 });
 * formatResource(netIncomeResource); // formatted string
 * ```
 */
export function createResource<T>(existingRef: Ref<T>, options?: ResourceOptions): Resource<T>;

/**
 * Create a persistent resource — the standard way to define a game resource.
 *
 * The returned value is both a Vue ref (reactive, watchable) and a persistent
 * ref (saved and loaded). When called during an engine's install/connect, it
 * is also registered in that engine's resource registry. Balance workbenches,
 * trace views and other introspection tools find it there.
 *
 * @param defaultValue - Starting value for new saves. Use `0` or `new Decimal(...)`.
 * @param options - The id, display name and formatting options
 * @returns A reactive, persistent resource with display metadata
 *
 * @example
 * ```ts
 * // Basic currency — whole-number display, starts at 0
 * const points = createResource(0, { id: 'points', displayName: 'Points' });
 *
 * // Fractional currency — 2 decimal places, starts at 100
 * const gold = createResource(new Decimal(100), { id: 'gold', displayName: 'Gold', decimals: 2 });
 *
 * // Use like any Vue ref
 * watch(points, (val) => console.log('Points changed:', val));
 * addResource(points, 10); // points.value is now Decimal(10)
 * ```
 */
export function createResource<T>(
  defaultValue: T,
  options: IfSerializable<T, PersistentResourceOptions>,
): Resource<T> & Persistent<T> & { [PersistentAlias]: Resource<T> };

export function createResource<T>(
  defaultValue: T | Ref<T>,
  options: ResourceOptions = {},
): Resource<T> {
  return buildResource(defaultValue, options);
}

/**
 * A persistent resource that saves under `persistentId` in the enclosing
 * persistent context but registers under `options.id`. It is for a system
 * that builds same-id resources in sibling persistent contexts, such as two
 * inventories that hold the same inventory item.
 *
 * @internal Used by createInventory.
 */
export function createPersistentContextScopedResource<T>(
  defaultValue: T & SerializableConstraint<T>,
  options: PersistentResourceOptions,
  persistentId: string,
): Resource<T> & Persistent<T> {
  return buildResource(defaultValue, options, persistentId) as Resource<T> & Persistent<T>;
}

// A capped ResourceBag linked to a resource clamps each write back to its cap,
// but only from its own watcher, which subscribes at link time and so runs
// after the cumulative/best trackers subscribed at creation. Both are
// `flush: 'sync'`, so the trackers would see the raw over-cap write first and
// count gain the bag then discards. Rather than depend on subscription order,
// the trackers apply the bag's clamp themselves, looked up here.
const resourceClamps = new WeakMap<
  Resource<DecimalSource>,
  (amount: DecimalSource) => DecimalSource
>();

/**
 * Register the clamp a linked bag applies to `resource`'s writes, so its
 * trackers count only the clamped amount. Returns the cleanup. Throws when
 * another clamp is already registered: one resource linked into two bags has
 * two caps fighting over its value.
 *
 * @internal Used by ResourceBag's `link`.
 */
export function registerResourceClamp(
  resource: Resource<DecimalSource>,
  clamp: (amount: DecimalSource) => DecimalSource,
): () => void {
  if (resourceClamps.has(resource)) {
    throw new Error(
      `Resource "${resource.id}" is already linked into a resource bag; unlink it before linking it again.`,
    );
  }
  resourceClamps.set(resource, clamp);
  return () => {
    if (resourceClamps.get(resource) === clamp) resourceClamps.delete(resource);
  };
}

/** Shared body of the resource factories; `persistentId` defaults to `options.id`. */
function buildResource<T>(
  defaultValue: T | Ref<T>,
  options: ResourceOptions,
  persistentId?: string,
): Resource<T> {
  const { displayName = 'points', decimals = 0, small = false, id } = options;
  // One read of the enclosing persistent context, shared by the tracker setup
  // below and the registration at the end. Both need to know whether a
  // persistent context is open; nothing between them changes it.
  const parentContext = getCurrentPersistentContext();

  let resource: Partial<Resource<T>>;
  if (isRef(defaultValue)) {
    // A display name is text, free to change or be translated; only a wrapped
    // ref, which saves nothing, may be keyed by it.
    resource = Object.assign(defaultValue, {
      id: id ?? displayName,
      displayName,
      decimals,
      small,
    });
  } else {
    const name = persistentId ?? id;
    if (name?.includes('.')) {
      throw new Error(
        `Resource id "${name}" contains ".", which save paths split on. Use another separator, such as "-".`,
      );
    }
    // Save under a stable id — the resource's id unless the caller passes
    // `persistentId` — so a save still loads after fields are reordered
    // within a persistent context. The persistent alias gets the same metadata.
    const metadata = { id, displayName, decimals, small };
    // The public overload checked `T` against IfSerializable; a generic body can't
    // resolve that check, so the call goes through the unchecked shape.
    const persistentResource = (persistent as (d: T, o: PersistentOptions<T>) => Persistent<T>)(
      defaultValue,
      { id: name },
    );
    Object.assign(persistentResource[PersistentAlias], metadata);
    resource = Object.assign(persistentResource, metadata);

    // The `cumulative` and `best` trackers belong to a persistent resource.
    // Their save path includes the resource's id, so two resources in one
    // module each get their own child persistent context, and the tracker
    // ids don't collide.
    //
    // Skipped when the resource is created outside any persistent context
    // (bare tests, throwaway scripts), like the resource registry
    // registration below.
    if (parentContext !== undefined) {
      // Persistent contexts are flat under the persistence namespace, so the
      // child persistent context's id starts with the enclosing one's. That
      // keeps the tracker's save path bound to the module that owns it.
      withPersistentContext(`${parentContext}::${name}`, () => {
        const initial = defaultValue as DecimalSource;
        // `lifetime: true`, so a reset that names the module's persistent
        // context passes over these trackers. Without the flag,
        // `createReset({ resetPersistentContexts: [contextId] })` would zero
        // `cumulative` / `best` even when the resource itself was kept with
        // `keep: [resource]`, against the "full life" these refs promise. To
        // clear lifetime refs on a hard reset, pass them to `thingsToReset`.
        const cumulative = persistent<DecimalSource>(initial, {
          id: 'cumulative',
          lifetime: true,
        });
        const best = persistent<DecimalSource>(initial, {
          id: 'best',
          lifetime: true,
        });

        // The last amount after a linked bag's clamp. `cumulative` diffs
        // against it rather than the raw previous write, which may be an
        // over-cap value the bag clamped back. So gain is always measured
        // between two clamped amounts.
        let landed = (resource as Ref<DecimalSource>).value;

        // flush: 'sync' so balance-harness runners driving
        // engine.tickDriver.tickOnce() in a tight loop (no microtask boundary
        // between ticks) still observe updates on the tick the resource changed.
        watch(
          resource as Ref<DecimalSource>,
          (amount) => {
            // A load is taken as saved, unclamped, and counts as no gain.
            if (settling.value) {
              landed = amount;
              return;
            }
            const clamp = resourceClamps.get(resource as Resource<DecimalSource>);
            const next = clamp ? clamp(amount) : amount;
            if (Decimal.gt(next, landed)) {
              cumulative.value = Decimal.add(cumulative.value, Decimal.sub(next, landed));
            }
            if (Decimal.gt(next, best.value)) best.value = next;
            landed = next;
          },
          { flush: 'sync' },
        );

        resource.cumulative = cumulative;
        resource.best = best;
      });
    }
  }

  // Register in the ambient resource registry. Resources created outside an
  // engine (top-level tests, throwaway scripts) silently skip registration;
  // the resource still works, but no tool can find it.
  getCurrentResourceRegistry()?.register({
    resource: resource as Resource,
    persistentContextId: parentContext,
  });

  return resource as Resource<T>;
}

/**
 * Format a resource's amount with its `decimals` and `small` settings.
 *
 * @param resource - The resource to format
 * @param overrideAmount - An amount to format instead of the current one
 * @returns Formatted string representation
 *
 * @example
 * ```ts
 * const gold = createResource(1234.567, { id: 'gold', displayName: 'Gold', decimals: 2 })
 * formatResource(gold) // "1.235 k" — the active notation formats 1000 and above
 * formatResource(gold, 999) // "999.00"
 * ```
 */
export function formatResource(resource: Resource, overrideAmount?: DecimalSource): string {
  const amount = overrideAmount ?? resource.value;
  if (resource.decimals === 0) {
    return formatWhole(resource.small ? amount : Decimal.floor(amount));
  }
  return format(amount, resource.decimals, resource.small);
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
 * @param chain - Optional modifier chain for trace attribution (see `withTraceChain`)
 */
export function addResource(
  resource: Resource<DecimalSource>,
  amount: DecimalSource,
  chain?: Modifier,
): void {
  if (chain) {
    withTraceChain(chain, () => {
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
  /** Modifier chain for trace attribution (see `withTraceChain`) */
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
 * @returns `true` if subtraction was applied, `false` if the amount held was too small
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
    withTraceChain(chain, () => {
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
 * Reset a resource to its ref default (or zero).
 *
 * @param resource - The resource to reset
 */
export function resetResource<T extends DecimalSource>(resource: Resource<T>): void {
  // The persistent alias holds the ref default too, so this also covers it.
  if (DefaultValue in resource) resetPersistent(resource as Resource<T> & Persistent<T>);
  else resource.value = 0 as T;
}
