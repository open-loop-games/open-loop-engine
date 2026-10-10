/**
 * Resource bag — fixed-capacity holder backed by reactive {@link Resource}s.
 *
 * Wraps a set of named resource slots whose totals fit under a shared capacity
 * cap. Useful for inventories, stat pools, and any "budget across N labelled
 * pots" pattern where the cap is a first-class quantity (static or reactive).
 *
 * @cluster resource
 */

import { reactive, shallowRef, toRaw, watch } from 'vue';
import { Decimal, renormIfLayer0, toFinalDecimal } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import { settling } from './persistence';
import { registerResourceClamp, type Resource } from './resource';

/** A capacity value that can be static or a reactive getter */
export type CapacitySource = DecimalSource | (() => DecimalSource);

/**
 * Sum a set of amounts into a single Decimal. Renormalizes the accumulator
 * between iterations so the typeof fast path on `Decimal.add` fires on every
 * step, then wraps once at the boundary to honor the `Decimal` return contract
 * for callers that chain instance methods on the result.
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
  const raw = typeof cap === 'function' ? cap() : cap;
  return toFinalDecimal(raw);
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
   * - `'discard'` — adds up to the remaining capacity and discards the rest
   * Default: `'block'`.
   */
  overflow?: 'block' | 'discard';
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
   * Returns zero when overflow is 'block' and the add would exceed capacity,
   * and for a non-positive amount, which is a no-op.
   */
  add(typeId: string, amount: DecimalSource): Decimal;
  /**
   * Subtract from a type. Returns the amount actually subtracted.
   * Pass `allowNegative: true` to allow the balance to go below zero.
   * A non-positive amount is a no-op and returns zero.
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
   * The map reference is stable across `clear()` and `restore()` —
   * entries are rewritten in place. The bag's mutation funnel deletes any
   * entry whose amount reaches zero, so iterating this map visits only
   * non-zero types (matching `entries()` semantics) without the per-call
   * zero-filter pass.
   *
   * Callers must not mutate the map directly — writes bypass capacity
   * clamping, `Resource` link sync, and the cached total used by
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
   * function that tears down the watchers. A resource links into one bag at a
   * time; linking it into a second throws.
   */
  link(typeId: string, resource: Resource<DecimalSource>): () => void;
  /** Serialize all non-zero amounts to a plain string-keyed record for persistence. */
  serialize(): Record<string, string>;
  /** Replace all current amounts with a record {@link serialize} produced. */
  restore(data: Record<string, string>): void;
  /** Human-readable label used by UIs and debug output. */
  displayName: string;
}

/**
 * Creates a multi-type resource container with optional per-type and total
 * capacity limits.
 *
 * @param options - Bag configuration including initial amounts, capacity limits,
 *   and overflow behavior ('block' rejects additions, 'discard' truncates to cap)
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
  // any slot ~1e16 below another for good.
  let cachedTotal: Decimal = Decimal.dZero;
  let totalDirty = false;
  // The cache reads the raw map, so it tracks nothing; every write bumps this
  // for effects to track the total through. A write marks the cache dirty
  // before touching the map, because a link's sync watcher runs inside the
  // map write and may read the total, and bumps the version after, because a
  // sync effect re-reading the total on the bump must sum the written map.
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
   * Single mutation funnel. All writes to `amounts` must go through this
   * so the cached total is invalidated. Zero values drop the entry to keep
   * the map sparse (preserving prior behavior of `storeAmount`).
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

    add(typeId: string, amount: DecimalSource): Decimal {
      const toAdd = toFinalDecimal(amount);
      // `!gt(0)` also turns NaN away.
      if (!toAdd.gt(0)) return Decimal.dZero;
      const remaining = computeRemainingForType(typeId);

      if (overflow === 'block') {
        if (toAdd.gt(remaining)) return Decimal.dZero;
        writeAmount(typeId, toFinalDecimal(Decimal.add(getAmount(typeId), toAdd)));
        return toAdd;
      } else {
        // destroy: add up to remaining
        const actualAdd = toFinalDecimal(Decimal.min(toAdd, remaining));
        // `!gt(0)` rather than `lte(0)`: a NaN written here would poison the
        // slot and every total read after it. `lte` admits NaN, `gt` rejects it.
        if (!actualAdd.gt(0)) return Decimal.dZero;
        writeAmount(typeId, toFinalDecimal(Decimal.add(getAmount(typeId), actualAdd)));
        return actualAdd;
      }
    },

    subtract(typeId: string, amount: DecimalSource, allowNegative = false): Decimal {
      const toSub = toFinalDecimal(amount);
      if (!toSub.gt(0)) return Decimal.dZero;
      const current = getAmount(typeId);

      if (allowNegative) {
        const newVal = toFinalDecimal(Decimal.sub(current, toSub));
        writeAmount(typeId, newVal);
        return toSub;
      }

      const actual = toFinalDecimal(Decimal.min(toSub, current));
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
      // watcher installs.
      const unregisterClamp = registerResourceClamp(resource, (amount) =>
        clampToCapacity(typeId, toFinalDecimal(amount)),
      );

      let syncing = false;

      // Resource → bag, clamped to capacity, with any clamp written back so
      // the two can't diverge with the resource reading over-cap. A save load
      // (or reset) writes linked refs one at a time, so clamping then would
      // measure each slot against the other slots' pre-load amounts, or
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

      // Initial sync, before either watcher installs.
      syncFromResource(resource.value);

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
        // A superseded link's cleanup, run late, must not drop its successor.
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
 * clamped by both the source's available stock and the destination's
 * remaining capacity. Returns the amount actually transferred.
 */
export function transferBetweenBags(
  from: ResourceBag,
  to: ResourceBag,
  typeId: string,
  amount: DecimalSource,
): Decimal {
  const toTransfer = toFinalDecimal(amount);
  const available = from.get(typeId);
  const canTake = toFinalDecimal(Decimal.min(toTransfer, available));

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
export function transferAmountsBetweenBags(
  from: ResourceBag,
  to: ResourceBag,
  amounts: Record<string, DecimalSource>,
  allOrNothing = false,
): Record<string, Decimal> {
  if (allOrNothing) {
    for (const [typeId, amount] of Object.entries(amounts)) {
      if (!from.has(typeId, amount)) return {};
      const toAdd = toFinalDecimal(amount);
      if (toAdd.gt(to.remainingCapacityForType(typeId))) return {};
    }
    const totalToAdd = sumAmountsAsDecimal(Object.values(amounts));
    if (Decimal.gt(totalToAdd, to.remainingCapacity())) return {};

    const result: Record<string, Decimal> = {};
    for (const [typeId, amount] of Object.entries(amounts)) {
      from.subtract(typeId, amount);
      to.add(typeId, amount);
      result[typeId] = toFinalDecimal(amount);
    }
    return result;
  }

  const result: Record<string, Decimal> = {};
  for (const [typeId, amount] of Object.entries(amounts)) {
    result[typeId] = transferBetweenBags(from, to, typeId, amount);
  }
  return result;
}
