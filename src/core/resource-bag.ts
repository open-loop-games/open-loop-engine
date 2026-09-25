/**
 * Resource bag — fixed-capacity holder backed by reactive {@link Resource}s.
 *
 * Wraps a set of named resource slots whose totals fit under a shared capacity
 * cap. Useful for inventories, stat pools, and any "budget across N labelled
 * pots" pattern where the cap is a first-class quantity (static or reactive).
 *
 * @cluster resource
 */

import { reactive, toRaw, watch } from 'vue';
import { Decimal, renormIfLayer0 } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import { loadingSave } from './persistence';
import type { Resource } from './resource';

/** A capacity value that can be static or a reactive getter */
export type CapacitySource = DecimalSource | (() => DecimalSource);

// break_eternity Decimals are immutable — `new Decimal(d)` where d is already
// a Decimal allocates a pointless clone. Skip the clone on the hot paths that
// funnel DecimalSource arguments through to Decimal statics.
function toDecimal(x: DecimalSource): Decimal {
  return x instanceof Decimal ? x : new Decimal(x);
}

/**
 * Sum a set of amounts into a single Decimal. Renormalizes the accumulator
 * between iterations so the typeof fast path on `Decimal.add` fires on every
 * step, then wraps once at the boundary to honor the `Decimal` return contract
 * for callers that chain instance methods on the result.
 *
 * @internal
 */
export function sumAmountsAsDecimal(amounts: Record<string, DecimalSource>): Decimal {
  return toDecimal(
    Object.values(amounts).reduce<DecimalSource>(
      (sum, a) => renormIfLayer0(Decimal.add(sum, a)),
      Decimal.dZero,
    ),
  );
}

function resolveCapacity(cap: CapacitySource | undefined): Decimal | undefined {
  if (cap == null) return undefined;
  const raw = typeof cap === 'function' ? cap() : cap;
  return toDecimal(raw);
}

/** Options for configuring a resource bag at creation time. */
export interface ResourceBagOptions {
  /** Starting amounts per type ID. Types not listed start at zero. */
  initial?: Record<string, DecimalSource>;
  /** Total combined capacity across all types. Can be a getter for reactive limits. */
  capacity?: CapacitySource;
  /** Per-type capacity limits, keyed by type ID. Can be getters for reactive limits. */
  capacityPerType?: Record<string, CapacitySource>;
  /**
   * Behavior when an add operation would exceed capacity.
   * - `'block'` — rejects the entire add and returns zero
   * - `'destroy'` — adds up to the remaining capacity and discards the rest
   * Default: `'block'`.
   */
  overflow?: 'block' | 'destroy';
  /** Human-readable label used by UIs and debug output. */
  displayName?: string;
}

/** A multi-type resource container with optional capacity limits and reactive Resource linking. */
export interface ResourceBag {
  /** Return the current amount for a type (Decimal zero if absent). */
  get(typeId: string): Decimal;
  /** Set the amount for a type, clamped to capacity. */
  set(typeId: string, amount: DecimalSource): void;
  /**
   * Add to a type. Returns the amount actually added.
   * Returns zero when overflow is 'block' and the add would exceed capacity.
   */
  add(typeId: string, amount: DecimalSource): Decimal;
  /**
   * Subtract from a type. Returns the amount actually subtracted.
   * Pass `allowNegative: true` to allow the balance to go below zero.
   */
  subtract(typeId: string, amount: DecimalSource, allowNegative?: boolean): Decimal;
  /** Return true if the bag holds at least `amount` of the given type. */
  has(typeId: string, amount: DecimalSource): boolean;
  /** Return true if the bag satisfies all requirements simultaneously. */
  hasAll(requirements: Record<string, DecimalSource>): boolean;
  /** Sum of all type amounts. */
  total(): Decimal;
  /** All type IDs with a non-zero amount. */
  types(): string[];
  /** All [typeId, amount] pairs with non-zero amounts. */
  entries(): [string, Decimal][];
  /**
   * Live map of non-zero type amounts. Exposed for hot-path consumers that
   * iterate all holdings every tick and cannot afford the per-call
   * allocation of `types()` / `entries()`, which each build a fresh array.
   *
   * The map reference is stable across `clear()` and `deserialize()` —
   * entries are rewritten in place. The bag's mutation funnel deletes any
   * entry whose amount reaches zero, so iterating this map visits only
   * non-zero types (matching `entries()` semantics) without the per-call
   * zero-filter pass.
   *
   * Callers must not mutate the map directly — writes bypass capacity
   * clamping, `Resource` link sync, and the cached running total used by
   * `total()` / `remainingCapacity()`. Use `add` / `set` / `subtract` for
   * writes. The underlying map is Vue-reactive; reads inside a reactive
   * effect track dependencies as expected, reads outside are plain
   * proxy-forwarded lookups.
   */
  readonly amounts: ReadonlyMap<string, Decimal>;
  /** True when every type amount is zero. */
  isEmpty(): boolean;
  /** Remove all amounts from the bag. */
  clear(): void;
  /** Remaining combined capacity (Infinity if no total cap is set). */
  remainingCapacity(): Decimal;
  /** Remaining capacity for a specific type, accounting for both per-type and total caps. */
  remainingCapacityForType(typeId: string): Decimal;
  /**
   * Establish a two-way reactive sync between this bag's type slot and a Resource ref.
   * Writes to the resource are clamped to capacity, except during a save load or
   * reset, when the written value is taken as saved. Returns an unsubscribe
   * function that tears down the watchers.
   */
  link(typeId: string, resource: Resource<DecimalSource>): () => void;
  /** Serialize all non-zero amounts to a plain string-keyed record for persistence. */
  serialize(): Record<string, string>;
  /** Restore amounts from a serialized record, replacing all current amounts. */
  deserialize(data: Record<string, string>): void;
  /** Human-readable label used by UIs and debug output. */
  displayName: string;
}

/**
 * Creates a multi-type resource container with optional per-type and total
 * capacity limits.
 *
 * @param options - Bag configuration including initial amounts, capacity limits,
 *   and overflow behavior ('block' rejects additions, 'destroy' truncates to cap)
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
  // Sum of all amounts, recomputed from the map on every write so clamp,
  // remaining-capacity and total() reads stay O(1). Recomputing rather than
  // folding each delta in keeps it exact: an incremental total drifts under
  // fractional churn and absorbs any slot ~1e16 below another for good.
  let cachedTotal: Decimal = Decimal.dZero;

  function recomputeTotal(): void {
    let sum: DecimalSource = Decimal.dZero;
    for (const a of toRaw(amounts).values()) sum = renormIfLayer0(Decimal.add(sum, a));
    cachedTotal = toDecimal(sum);
  }

  function getAmount(typeId: string): Decimal {
    return amounts.get(typeId) ?? Decimal.dZero;
  }

  /**
   * Single mutation funnel. All writes to `amounts` must go through this
   * so the running total stays in sync. Zero values drop the entry to keep
   * the map sparse (preserving prior behavior of `storeAmount`).
   */
  function writeAmount(typeId: string, newVal: Decimal): void {
    if (newVal.eq(0)) {
      if (!amounts.delete(typeId)) return;
    } else {
      amounts.set(typeId, newVal);
    }
    recomputeTotal();
  }

  for (const [typeId, value] of Object.entries(initial)) {
    const d = toDecimal(value);
    if (!d.eq(0)) {
      writeAmount(typeId, d);
    }
  }

  function computeRemainingCapacity(): Decimal {
    const totalCap = resolveCapacity(capacity);
    if (totalCap == null) return Decimal.dInf;
    return toDecimal(Decimal.max(Decimal.sub(totalCap, cachedTotal), 0));
  }

  function computeRemainingForType(typeId: string): Decimal {
    const typeCapSource = typeCapsSource.get(typeId);
    const typeCap = resolveCapacity(typeCapSource);
    const totalCap = resolveCapacity(capacity);
    if (typeCap == null && totalCap == null) return Decimal.dInf;
    const typeRemaining =
      typeCap != null
        ? toDecimal(Decimal.max(Decimal.sub(typeCap, getAmount(typeId)), 0))
        : Decimal.dInf;
    const totalRemaining =
      totalCap != null
        ? toDecimal(Decimal.max(Decimal.sub(totalCap, cachedTotal), 0))
        : Decimal.dInf;
    return toDecimal(Decimal.min(typeRemaining, totalRemaining));
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
      const othersSum = Decimal.sub(cachedTotal, getAmount(typeId));
      const maxForType = Decimal.sub(totalCap, othersSum);
      clamped = Decimal.min(clamped, maxForType);
    }
    return toDecimal(Decimal.max(clamped, 0));
  }

  function setAmount(typeId: string, value: DecimalSource): void {
    const clamped = clampToCapacity(typeId, toDecimal(value));
    writeAmount(typeId, clamped);
  }

  const bag: ResourceBag = {
    displayName,
    amounts,

    get(typeId: string): Decimal {
      return getAmount(typeId);
    },

    set: setAmount,

    add(typeId: string, amount: DecimalSource): Decimal {
      const toAdd = toDecimal(amount);
      const remaining = computeRemainingForType(typeId);

      if (overflow === 'block') {
        if (toAdd.gt(remaining)) return Decimal.dZero;
        writeAmount(typeId, toDecimal(Decimal.add(getAmount(typeId), toAdd)));
        return toAdd;
      } else {
        // destroy: add up to remaining
        const actualAdd = toDecimal(Decimal.min(toAdd, remaining));
        // `!gt(0)` rather than `lte(0)`: a NaN written here would poison the
        // slot and every total read after it. `lte` admits NaN, `gt` rejects it.
        if (!actualAdd.gt(0)) return Decimal.dZero;
        writeAmount(typeId, toDecimal(Decimal.add(getAmount(typeId), actualAdd)));
        return actualAdd;
      }
    },

    subtract(typeId: string, amount: DecimalSource, allowNegative = false): Decimal {
      const toSub = toDecimal(amount);
      const current = getAmount(typeId);

      if (allowNegative) {
        const newVal = toDecimal(Decimal.sub(current, toSub));
        // Use writeAmount so cachedTotal stays in sync even when the
        // resulting balance is negative or zero.
        writeAmount(typeId, newVal);
        return toSub;
      }

      const actual = toDecimal(Decimal.min(toSub, current));
      writeAmount(typeId, toDecimal(Decimal.sub(current, actual)));
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

    total(): Decimal {
      return cachedTotal;
    },

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
      amounts.clear();
      cachedTotal = Decimal.dZero;
    },

    remainingCapacity: computeRemainingCapacity,
    remainingCapacityForType: computeRemainingForType,

    link(typeId: string, resource: Resource<DecimalSource>): () => void {
      const existingCleanup = links.get(typeId);
      if (existingCleanup) existingCleanup();

      let syncing = false;

      // Initial sync: resource → bag. This runs before either watcher installs,
      // so if the bag clamps the value to capacity we must reconcile the
      // resource here too — nothing else will, and the two would diverge with
      // the resource reading over-cap forever (mirrors the steady-state
      // resource → bag clamp-back below).
      setAmount(typeId, resource.value);
      const afterInitial = getAmount(typeId);
      if (!Decimal.eq(afterInitial, resource.value)) {
        resource.value = afterInitial;
      }

      // Watch bag → resource. `flush: 'sync'` fires on every ref mutation
      // instead of coalescing via microtask. Required under the fixed-step
      // game loop where many sub-ticks can drain in a single macrotask —
      // downstream cost/cap checks read resource.value across sub-ticks and
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

      // Watch resource → bag. A save load (or reset) writes linked refs one
      // at a time, so clamping here would measure each slot against the other
      // slots' pre-load amounts, or against a capacity whose inputs haven't
      // loaded yet. The loaded state was valid when saved: take it unclamped.
      const stopResourceWatch = watch(
        () => resource.value,
        (newVal) => {
          if (syncing) return;
          const current = getAmount(typeId);
          if (!Decimal.eq(current, newVal)) {
            syncing = true;
            if (loadingSave.value) {
              writeAmount(typeId, toDecimal(newVal));
              syncing = false;
              return;
            }
            setAmount(typeId, newVal);
            // If bag clamped the value, sync back to resource
            const afterSet = getAmount(typeId);
            if (!Decimal.eq(afterSet, newVal)) {
              resource.value = afterSet;
            }
            syncing = false;
          }
        },
        { flush: 'sync' },
      );

      const cleanup = () => {
        stopBagWatch();
        stopResourceWatch();
        links.delete(typeId);
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

    deserialize(data: Record<string, string>): void {
      amounts.clear();
      cachedTotal = Decimal.dZero;
      for (const [typeId, valStr] of Object.entries(data)) {
        const d = toDecimal(valStr);
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
 * clamped by both the source's available stock and the destination's
 * remaining capacity. Returns the amount actually transferred.
 */
export function transferBetweenBags(
  from: ResourceBag,
  to: ResourceBag,
  typeId: string,
  amount: DecimalSource,
): Decimal {
  const toTransfer = toDecimal(amount);
  const available = from.get(typeId);
  const canTake = toDecimal(Decimal.min(toTransfer, available));

  if (!canTake.gt(0)) return Decimal.dZero;

  const added = to.add(typeId, canTake);
  if (added.gt(0)) {
    from.subtract(typeId, added);
  }
  return added;
}

/**
 * Transfer multiple resource types between bags in one operation. With
 * `allOrNothing`, the transfer is atomic — if any type can't move fully (or
 * total exceeds destination capacity), nothing moves. Otherwise each type is
 * clamped independently via {@link transferBetweenBags}.
 */
export function bulkTransfer(
  from: ResourceBag,
  to: ResourceBag,
  amounts: Record<string, DecimalSource>,
  allOrNothing = false,
): Record<string, Decimal> {
  if (allOrNothing) {
    for (const [typeId, amount] of Object.entries(amounts)) {
      if (!from.has(typeId, amount)) return {};
      const toAdd = toDecimal(amount);
      if (toAdd.gt(to.remainingCapacityForType(typeId))) return {};
    }
    const totalToAdd = sumAmountsAsDecimal(amounts);
    if (Decimal.gt(totalToAdd, to.remainingCapacity())) return {};

    const result: Record<string, Decimal> = {};
    for (const [typeId, amount] of Object.entries(amounts)) {
      from.subtract(typeId, amount);
      to.add(typeId, amount);
      result[typeId] = toDecimal(amount);
    }
    return result;
  }

  const result: Record<string, Decimal> = {};
  for (const [typeId, amount] of Object.entries(amounts)) {
    result[typeId] = transferBetweenBags(from, to, typeId, amount);
  }
  return result;
}
