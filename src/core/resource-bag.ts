/**
 * Resource bag — amounts per item type under shared capacities, linkable to {@link Resource}s.
 *
 * Holds an amount for each item type, under an optional total capacity and
 * optional per-type capacities. Use it for held goods, stat totals, or any set
 * of amounts that share a capacity, static or reactive.
 *
 * @cluster resource
 */

import { reactive, shallowRef, toRaw, watch } from 'vue';
import { Decimal, renormIfLayer0, toFinalDecimal } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import { resolveComputable, type Computable } from './computed';
import { settling } from './persistence';
import { registerResourceClamp, type Resource } from './resource';

/** A capacity: a value, or a ref or getter for a reactive capacity */
export type CapacitySource = Computable<DecimalSource>;

/**
 * Sum a set of amounts into a single Decimal. Renormalizes the running sum
 * between iterations so the typeof fast path on `Decimal.add` fires on every
 * addition, then wraps once at the boundary to honor the `Decimal` return
 * contract for callers that chain instance methods on the result.
 *
 * @internal
 */
export function sumAmountsAsDecimal(amounts: Iterable<DecimalSource>): Decimal {
  let sum: DecimalSource = Decimal.dZero;
  for (const a of amounts) sum = renormIfLayer0(Decimal.add(sum, a));
  return toFinalDecimal(sum);
}

function resolveCapacity(cap: CapacitySource | undefined): Decimal | undefined {
  if (cap == null) return undefined;
  return toFinalDecimal(resolveComputable(cap));
}

/** Options for configuring a resource bag at creation time. */
export interface ResourceBagOptions {
  /** Starting amounts per item type. An item type not listed starts at zero. */
  initial?: Record<string, DecimalSource>;
  /** Combined capacity across all item types. Can be a ref or getter, for a reactive capacity. */
  capacity?: CapacitySource;
  /** Capacity per item type. Each can be a ref or getter, for a reactive capacity. */
  capacityPerType?: Record<string, CapacitySource>;
  /**
   * Behavior when an add operation would exceed capacity.
   * - `'block'` — rejects the entire add and returns zero
   * - `'discard'` — adds up to the remaining capacity and discards the rest
   * Default: `'block'`.
   */
  overflow?: 'block' | 'discard';
  /** Text the player sees for the bag. Default: `''` */
  displayName?: string;
}

/** Amounts by item type, with optional capacities and reactive links to Resources. */
export interface ResourceBag {
  /** Return the current amount for an item type (Decimal zero if absent). */
  get(typeId: string): Decimal;
  /** Set the amount for an item type, clamped to capacity. */
  set(typeId: string, amount: DecimalSource): void;
  /**
   * Add to an item type. Returns the amount actually added, or `0` when none
   * was: when overflow is 'block' and the add would exceed capacity, and for a
   * non-positive amount, which is a no-op. So `if (bag.add(...))` reads as
   * "something went in".
   */
  add(typeId: string, amount: DecimalSource): Decimal | 0;
  /**
   * Subtract from an item type. Returns the amount actually subtracted, or `0`
   * when none was. Pass `allowNegative: true` to allow the amount to go below
   * zero. A non-positive amount is a no-op.
   */
  subtract(typeId: string, amount: DecimalSource, allowNegative?: boolean): Decimal | 0;
  /** Return true if the bag holds at least `amount` of the given item type. */
  has(typeId: string, amount: DecimalSource): boolean;
  /** Return true if the bag holds at least every listed amount at once. */
  hasAll(requirements: Record<string, DecimalSource>): boolean;
  /** Sum of all amounts. */
  total(): Decimal;
  /** All item types with a non-zero amount. */
  types(): string[];
  /** All [typeId, amount] pairs with non-zero amounts. */
  entries(): [string, Decimal][];
  /**
   * Reactive map of non-zero amounts by item type. Exposed for hot-path
   * consumers that iterate all amounts every tick. They cannot afford the
   * per-call allocation of `types()` / `entries()`, which each build a fresh
   * array.
   *
   * The map reference is stable across `clear()` and `restore()` —
   * entries are rewritten in place. The bag's single write path deletes any
   * entry whose amount reaches zero. So iterating this map visits only
   * non-zero item types, as `entries()` does, without a per-call zero filter.
   *
   * Callers must not mutate the map directly — writes bypass capacity
   * clamping, `Resource` link sync, and the cached total used by
   * `total()` / `remainingCapacity()`. Use `add` / `set` / `subtract` for
   * writes. The underlying map is Vue-reactive: reads inside a Vue effect
   * track dependencies as expected, and reads outside are plain
   * proxy-forwarded lookups.
   */
  readonly amounts: ReadonlyMap<string, Decimal>;
  /** True when every amount is zero. */
  isEmpty(): boolean;
  /** Remove all amounts from the bag. */
  clear(): void;
  /** Remaining combined capacity (Infinity if no total capacity is set). */
  remainingCapacity(): Decimal;
  /** Remaining capacity for one item type, under both its own capacity and the total. */
  remainingCapacityForType(typeId: string): Decimal;
  /**
   * Keep this bag's amount for an item type and a Resource ref in two-way
   * reactive sync. Writes to the resource are clamped to capacity, except
   * during a save load or reset, when the written value is taken as saved.
   * Returns the cleanup, which removes the watchers and the link. A resource
   * links into one bag at a time; linking it into a second throws.
   */
  link(typeId: string, resource: Resource<DecimalSource>): () => void;
  /** Serialize all non-zero amounts to a plain string-keyed record for persistence. */
  serialize(): Record<string, string>;
  /** Replace all current amounts with a record {@link serialize} produced. */
  restore(data: Record<string, string>): void;
  /** Text the player sees for the bag. */
  displayName: string;
}

/**
 * Create a container of amounts by item type, with an optional total capacity
 * and optional per-type capacities.
 *
 * @param options - Starting amounts, capacities and overflow behavior: `'block'`
 *   rejects an add that exceeds capacity, `'discard'` adds up to capacity and
 *   discards the rest
 * @returns A resource bag supporting add/subtract/has operations, two-way reactive
 *   linking to Resource refs, and serialization for persistence
 *
 * @example
 * ```ts
 * const bag = createResourceBag({
 *   capacity: 100,
 *   overflow: 'block',
 *   initial: { wood: 10, stone: 5 },
 * });
 * bag.add('wood', 20); // returns Decimal(20)
 * bag.has('wood', 30); // true
 * ```
 */
export function createResourceBag(options: ResourceBagOptions = {}): ResourceBag {
  const {
    initial = {},
    capacity,
    capacityPerType = {},
    overflow = 'block',
    displayName = '',
  } = options;

  const typeCapsSource = new Map<string, CapacitySource>();
  for (const [typeId, cap] of Object.entries(capacityPerType)) {
    typeCapsSource.set(typeId, cap);
  }

  const amounts: Map<string, Decimal> = reactive(new Map<string, Decimal>());
  const links = new Map<string, () => void>();
  // Sum of all amounts, re-summed from the map on the first read after a
  // write, so a burst of writes pays for one sum and an uncapped bag's writes
  // pay for none. Re-summing rather than folding each delta in keeps it
  // exact: an incremental total drifts under fractional churn and absorbs
  // any amount ~1e16 below another for good.
  let cachedTotal: Decimal = Decimal.dZero;
  let totalDirty = false;
  // The cache reads the raw map, so it tracks nothing; every write bumps this
  // for Vue effects to track the total through. A write marks the cache dirty
  // before touching the map, because a link's sync watcher runs inside the
  // map write and may read the total. It bumps the version after, because a
  // sync Vue effect re-reading the total on the bump must sum the written map.
  const totalVersion = shallowRef(0);

  function getTotal(): Decimal {
    void totalVersion.value;
    if (totalDirty) {
      cachedTotal = sumAmountsAsDecimal(toRaw(amounts).values());
      totalDirty = false;
    }
    return cachedTotal;
  }

  function getAmount(typeId: string): Decimal {
    return amounts.get(typeId) ?? Decimal.dZero;
  }

  /**
   * Single write path. All writes to `amounts` must go through this so the
   * cached total is invalidated. A zero amount removes its entry, which keeps
   * the map sparse.
   */
  function writeAmount(typeId: string, newVal: Decimal): void {
    const drop = newVal.eq(0);
    if (drop && !toRaw(amounts).has(typeId)) return;
    totalDirty = true;
    if (drop) amounts.delete(typeId);
    else amounts.set(typeId, newVal);
    totalVersion.value++;
  }

  for (const [typeId, value] of Object.entries(initial)) {
    const d = toFinalDecimal(value);
    if (!d.eq(0)) {
      writeAmount(typeId, d);
    }
  }

  function computeRemainingCapacity(): Decimal {
    const totalCap = resolveCapacity(capacity);
    if (totalCap == null) return Decimal.dInf;
    return toFinalDecimal(Decimal.max(Decimal.sub(totalCap, getTotal()), 0));
  }

  function computeRemainingForType(typeId: string): Decimal {
    const typeCap = resolveCapacity(typeCapsSource.get(typeId));
    const typeRemaining =
      typeCap != null
        ? toFinalDecimal(Decimal.max(Decimal.sub(typeCap, getAmount(typeId)), 0))
        : Decimal.dInf;
    return toFinalDecimal(Decimal.min(typeRemaining, computeRemainingCapacity()));
  }

  function clampToCapacity(typeId: string, amount: Decimal): Decimal {
    const typeCapSource = typeCapsSource.get(typeId);
    const typeCap = resolveCapacity(typeCapSource);
    let clamped: DecimalSource = amount;
    if (typeCap != null) {
      clamped = Decimal.min(clamped, typeCap);
    }
    const totalCap = resolveCapacity(capacity);
    if (totalCap != null) {
      const othersSum = Decimal.sub(getTotal(), getAmount(typeId));
      const maxForType = Decimal.sub(totalCap, othersSum);
      clamped = Decimal.min(clamped, maxForType);
    }
    return toFinalDecimal(Decimal.max(clamped, 0));
  }

  function setAmount(typeId: string, value: DecimalSource): void {
    const clamped = clampToCapacity(typeId, toFinalDecimal(value));
    writeAmount(typeId, clamped);
  }

  const bag: ResourceBag = {
    displayName,
    amounts,

    get(typeId: string): Decimal {
      return getAmount(typeId);
    },

    set: setAmount,

    add(typeId: string, amount: DecimalSource): Decimal | 0 {
      const toAdd = toFinalDecimal(amount);
      // `!gt(0)` also turns NaN away.
      if (!toAdd.gt(0)) return 0;
      const remaining = computeRemainingForType(typeId);

      if (overflow === 'block') {
        if (toAdd.gt(remaining)) return 0;
        writeAmount(typeId, toFinalDecimal(Decimal.add(getAmount(typeId), toAdd)));
        return toAdd;
      } else {
        // discard: add up to remaining
        const actualAdd = toFinalDecimal(Decimal.min(toAdd, remaining));
        // `!gt(0)` rather than `lte(0)`: a NaN written here would poison the
        // entry and every total read after it. `lte` admits NaN, `gt` rejects it.
        if (!actualAdd.gt(0)) return 0;
        writeAmount(typeId, toFinalDecimal(Decimal.add(getAmount(typeId), actualAdd)));
        return actualAdd;
      }
    },

    subtract(typeId: string, amount: DecimalSource, allowNegative = false): Decimal | 0 {
      const toSub = toFinalDecimal(amount);
      if (!toSub.gt(0)) return 0;
      const current = getAmount(typeId);

      if (allowNegative) {
        const newVal = toFinalDecimal(Decimal.sub(current, toSub));
        writeAmount(typeId, newVal);
        return toSub;
      }

      const actual = toFinalDecimal(Decimal.min(toSub, current));
      if (!actual.gt(0)) return 0;
      writeAmount(typeId, toFinalDecimal(Decimal.sub(current, actual)));
      return actual;
    },

    has(typeId: string, amount: DecimalSource): boolean {
      return Decimal.gte(getAmount(typeId), amount);
    },

    hasAll(requirements: Record<string, DecimalSource>): boolean {
      for (const [typeId, amount] of Object.entries(requirements)) {
        if (!Decimal.gte(getAmount(typeId), amount)) return false;
      }
      return true;
    },

    total: getTotal,

    types(): string[] {
      return [...amounts.keys()];
    },

    entries(): [string, Decimal][] {
      return [...amounts.entries()];
    },

    isEmpty(): boolean {
      return amounts.size === 0;
    },

    clear(): void {
      totalDirty = true;
      amounts.clear();
      totalVersion.value++;
    },

    remainingCapacity: computeRemainingCapacity,
    remainingCapacityForType: computeRemainingForType,

    link(typeId: string, resource: Resource<DecimalSource>): () => void {
      const existingCleanup = links.get(typeId);
      if (existingCleanup) existingCleanup();

      // First, so a resource already linked elsewhere throws before any
      // watcher is added.
      const unregisterClamp = registerResourceClamp(resource, (amount) =>
        clampToCapacity(typeId, toFinalDecimal(amount)),
      );

      let syncing = false;

      // Resource → bag, clamped to capacity, with any clamp written back so
      // the two can't diverge with the resource reading over-cap. A save load
      // (or reset) writes linked refs one at a time, so clamping then would
      // measure each amount against the others' pre-load amounts, or
      // against a capacity whose inputs haven't loaded yet. The loaded state
      // was valid when saved: take it unclamped.
      function syncFromResource(value: DecimalSource): void {
        syncing = true;
        const next = settling.value
          ? toFinalDecimal(value)
          : clampToCapacity(typeId, toFinalDecimal(value));
        writeAmount(typeId, next);
        if (!Decimal.eq(next, value)) resource.value = next;
        syncing = false;
      }

      // Initial sync, before either watcher is added.
      syncFromResource(resource.value);

      // Watch bag → resource. `flush: 'sync'` fires on every ref mutation
      // instead of coalescing via microtask. Required in fixed tick mode,
      // where one interval can run many ticks in a single macrotask. Later
      // cost and capacity checks read resource.value across those ticks and
      // must see the latest bag amount, not a stale pre-microtask value.
      const stopBagWatch = watch(
        () => amounts.get(typeId),
        (newVal) => {
          if (syncing) return;
          const bagVal = newVal ?? Decimal.dZero;
          if (!Decimal.eq(bagVal, resource.value)) {
            syncing = true;
            resource.value = bagVal;
            syncing = false;
          }
        },
        { flush: 'sync' },
      );

      const stopResourceWatch = watch(
        () => resource.value,
        (newVal) => {
          if (syncing || Decimal.eq(getAmount(typeId), newVal)) return;
          syncFromResource(newVal);
        },
        { flush: 'sync' },
      );

      const cleanup = () => {
        stopBagWatch();
        stopResourceWatch();
        unregisterClamp();
        // A superseded link's cleanup, run late, must not remove its successor.
        if (links.get(typeId) === cleanup) links.delete(typeId);
      };

      links.set(typeId, cleanup);
      return cleanup;
    },

    serialize(): Record<string, string> {
      const result: Record<string, string> = {};
      for (const [typeId, val] of amounts.entries()) {
        result[typeId] = val.toString();
      }
      return result;
    },

    restore(data: Record<string, string>): void {
      totalDirty = true;
      amounts.clear();
      totalVersion.value++;
      for (const [typeId, valStr] of Object.entries(data)) {
        const d = toFinalDecimal(valStr);
        if (!d.eq(0)) {
          writeAmount(typeId, d);
        }
      }
    },
  };

  return bag;
}

/**
 * Move up to `amount` of `typeId` from one {@link ResourceBag} to another,
 * clamped by both the source's amount and the destination's remaining
 * capacity. Returns the amount actually transferred, or `0` when none was.
 */
export function transferBetweenBags(
  from: ResourceBag,
  to: ResourceBag,
  typeId: string,
  amount: DecimalSource,
): Decimal | 0 {
  const toTransfer = toFinalDecimal(amount);
  const available = from.get(typeId);
  const canTake = toFinalDecimal(Decimal.min(toTransfer, available));

  if (!canTake.gt(0)) return 0;

  const added = to.add(typeId, canTake);
  if (added) from.subtract(typeId, added);
  return added;
}

/**
 * Transfer several item types between bags in one call. With `allOrNothing`,
 * the transfer is atomic: if any item type can't move fully, or the total
 * exceeds the destination's capacity, nothing moves. Otherwise each item type
 * is clamped on its own through {@link transferBetweenBags}. Each item type's
 * entry is the amount it moved, or `0` when it moved none.
 */
export function transferAmountsBetweenBags(
  from: ResourceBag,
  to: ResourceBag,
  amounts: Record<string, DecimalSource>,
  allOrNothing = false,
): Record<string, Decimal | 0> {
  if (allOrNothing) {
    for (const [typeId, amount] of Object.entries(amounts)) {
      if (!from.has(typeId, amount)) return {};
      const toAdd = toFinalDecimal(amount);
      if (toAdd.gt(to.remainingCapacityForType(typeId))) return {};
    }
    const totalToAdd = sumAmountsAsDecimal(Object.values(amounts));
    if (Decimal.gt(totalToAdd, to.remainingCapacity())) return {};

    const result: Record<string, Decimal | 0> = {};
    for (const [typeId, amount] of Object.entries(amounts)) {
      from.subtract(typeId, amount);
      result[typeId] = to.add(typeId, amount);
    }
    return result;
  }

  const result: Record<string, Decimal | 0> = {};
  for (const [typeId, amount] of Object.entries(amounts)) {
    result[typeId] = transferBetweenBags(from, to, typeId, amount);
  }
  return result;
}
