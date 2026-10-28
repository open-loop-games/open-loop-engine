/**
 * Rate sources — a resource's rate per second, as the sum of labeled parts.
 *
 * A producer, an upkeep or any other change per second adds a rate source to
 * the resource it moves. The resource's rate is then a fact about the resource, read the
 * same way wherever it is shown or predicted:
 *
 * - {@link addRateSource} attaches a labeled rate and returns its cleanup.
 *   A source may be added after the resource exists.
 * - {@link getRate} is the net rate, and {@link getInflowRate} the sum of the
 *   positive sources. Both read zero where the amount cannot move: at a linked
 *   bag's capacity with a positive net, and at zero with a negative net that
 *   no source lets go below it.
 * - {@link getRateSources} lists the sources unclamped, for a breakdown that
 *   shows output wasted at capacity.
 *
 * Every read is reactive. Rate sources are derived each session, not saved.
 * Producer categories add theirs automatically.
 *
 * @cluster resource
 */

import { computed, ref, unref, type ComputedRef, type Ref } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { toMaybeRef, type Computable } from './computed';
import { getResourceClamp, type Resource } from './resource';

// === TYPES ===

/** What {@link addRateSource} attaches to a resource. */
export interface RateSourceOptions {
  /** The label a breakdown shows for this source. */
  text: string;
  /** Per second; negative to subtract. Can be a ref or a getter, for a reactive rate. */
  rate: Computable<DecimalSource>;
  /**
   * Whether this negative rate source may take the amount below zero, as a
   * producer's `allowNegative` does. Default `false`: at zero, a negative net reads zero.
   */
  allowNegative?: boolean;
}

/** One rate source on a resource, as {@link getRateSources} lists it. */
export interface RateSource {
  readonly text: string;
  /** The current rate per second, unclamped. */
  readonly rate: Decimal;
  readonly allowNegative: boolean;
}

interface RateSourceEntry {
  readonly text: string;
  readonly rate: ComputedRef<Decimal>;
  readonly allowNegative: boolean;
}

interface RateSourceList {
  readonly entries: RateSourceEntry[];
  /** Bumped on every add and remove, so reads over the list recompute. */
  readonly version: Ref<number>;
}

// === STATE ===

const lists = new WeakMap<Resource<DecimalSource>, RateSourceList>();

function listFor(resource: Resource<DecimalSource>): RateSourceList {
  let list = lists.get(resource);
  if (!list) {
    list = { entries: [], version: ref(0) };
    lists.set(resource, list);
  }
  return list;
}

/** The live entries, tracking the version so a reader recomputes on add and remove. */
function readEntries(resource: Resource<DecimalSource>): readonly RateSourceEntry[] {
  const list = listFor(resource);
  void list.version.value;
  return list.entries;
}

// === PUBLIC API ===

/**
 * Add a labeled rate to a resource's rate.
 *
 * @param resource the resource whose amount the rate changes.
 * @param options the label, the rate per second, and whether a negative rate
 *   may take the amount below zero.
 * @returns the cleanup, which removes the source.
 *
 * @example
 * ```ts
 * const removeUpkeep = addRateSource(food, {
 *   text: 'Upkeep',
 *   rate: () => Decimal.neg(workers.value).mul(0.5),
 * });
 * getRate(food); // net of every source on food
 * ```
 */
export function addRateSource(
  resource: Resource<DecimalSource>,
  options: RateSourceOptions,
): () => void {
  const { text, allowNegative = false } = options;
  const rate = toMaybeRef(options.rate);
  const entry: RateSourceEntry = {
    text,
    rate: computed(() => withoutNegativeZero(Decimal.fromValue(unref(rate)))),
    allowNegative,
  };
  const list = listFor(resource);
  list.entries.push(entry);
  list.version.value++;
  return () => {
    const at = list.entries.indexOf(entry);
    if (at < 0) return;
    list.entries.splice(at, 1);
    list.version.value++;
  };
}

/**
 * The net rate per second of `resource`: the sum of its rate sources. Reads
 * zero at a linked bag's capacity with a positive net, at zero with a negative
 * net that no source lets go below zero, and with no rate sources at all.
 */
export function getRate(resource: Resource<DecimalSource>): Decimal {
  const entries = readEntries(resource);
  let net = Decimal.dZero;
  for (const entry of entries) net = Decimal.add(net, entry.rate.value);
  return isHeld(resource, net, entries) ? Decimal.dZero : withoutNegativeZero(net);
}

/**
 * The gross inflow rate per second of `resource`: the sum of its positive rate
 * sources. Exact when each source only adds or only subtracts; a source
 * whose rate nets both understates it. Reads zero at a linked bag's capacity
 * with a positive net.
 */
export function getInflowRate(resource: Resource<DecimalSource>): Decimal {
  const entries = readEntries(resource);
  let net = Decimal.dZero;
  let inflow = Decimal.dZero;
  for (const entry of entries) {
    const rate = entry.rate.value;
    net = Decimal.add(net, rate);
    if (rate.gt(Decimal.dZero)) inflow = Decimal.add(inflow, rate);
  }
  return net.gt(Decimal.dZero) && isHeld(resource, net, entries) ? Decimal.dZero : inflow;
}

/** The rate sources on `resource`, unclamped, in the order they were added. */
export function getRateSources(resource: Resource<DecimalSource>): readonly RateSource[] {
  return readEntries(resource).map(({ text, rate, allowNegative }) => ({
    text,
    rate: rate.value,
    allowNegative,
  }));
}

/**
 * Whether `resource` has any rate source.
 *
 * @internal Used by the game-state accessor, whose `getRate` throws for a
 *   resource with none.
 */
export function hasRateSources(resource: Resource<DecimalSource>): boolean {
  return readEntries(resource).length > 0;
}

// === PRIVATE ===

/**
 * `value`, with a negative zero read as zero. Decimal subtraction and negation
 * of zero give -0, which a rate display would show as "-0/s".
 */
function withoutNegativeZero(value: Decimal): Decimal {
  return value.eq(Decimal.dZero) ? Decimal.dZero : value;
}

/** Whether the amount cannot move in the direction of `net`. */
function isHeld(
  resource: Resource<DecimalSource>,
  net: Decimal,
  entries: readonly RateSourceEntry[],
): boolean {
  const held = resource.value;
  if (net.gt(Decimal.dZero)) {
    const clamp = getResourceClamp(resource);
    return clamp !== undefined && Decimal.lte(clamp(Decimal.add(held, net)), held);
  }
  if (net.lt(Decimal.dZero) && Decimal.lte(held, Decimal.dZero)) {
    return !entries.some((e) => e.allowNegative && e.rate.value.lt(Decimal.dZero));
  }
  return false;
}
