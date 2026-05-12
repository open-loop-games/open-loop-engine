/**
 * Auto-purchase helpers — player-facing automation over Purchasable / Producer.
 *
 * Two trigger shapes share this file because they bridge the same conceptual
 * surface (automation auto-buy) to different selection mechanics:
 *
 * - {@link setupSweepAutoPurchase} — every tick, `purchaseMax()` on every
 *   affordable purchasable. Light helper for one-shot upgrades and capped
 *   levels where there's no contention between candidates.
 * - {@link setupPolicyAutoPurchase} — pick-one-then-buy under a
 *   {@link SelectionPolicy}, throttled by an interval and gated by an
 *   optional reserve floor. The producer-chain shape: costs grow into each
 *   other, so naive max-buy wipes the player's resource on the cheapest
 *   option and we need a score-and-pick loop instead.
 *
 * Names expose the trigger-shape (sweep vs policy), not the input-shape
 * (purchasable vs producer). The same policy primitive drives any candidate
 * type — see `core/policy.ts` for the four built-in factories.
 *
 * @cluster purchasable
 */

import { unref } from 'vue';
import { processGetter, type Computable } from '@/core/computed';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { persistent } from '@/core/persistence';
import { profile, profileStart, profileEnd } from '@/core/profiler';
import type { Resource } from '@/core/resource';
import type { RegisterTick } from '@/core/sequencer';
import { selectionCheapest, type SelectionPolicy } from '@/core/policy';
import type { Purchasable, PurchasableGroup } from './purchasable';
import type { Producer, ProducerCategory } from './producer-category';

// === CONSTANTS ===

// Monotonic counter used to generate unique persistent-ref names for the
// policy auto-purchase accumulator. Multiple setup calls inside the same
// persistent context (e.g., two categories in one module install) each get
// a distinct key so `importSave` can round-trip them.
let policyAutoPurchaseAccumulatorCounter = 0;

// Default policy: cheapest by `repeatable.getCost(1)`. Module-level singleton
// so identity is stable across `processGetter` calls when `options.policy`
// is omitted; the helper-side filter guarantees every candidate has a
// `repeatable` by the time the policy sees it.
const defaultCheapestPolicy: SelectionPolicy<Producer> = selectionCheapest<Producer>((p) =>
  p.repeatable!.getCost(1),
);

// === SWEEP AUTO-PURCHASE ===

/**
 * Register a tick handler that sweeps a purchasable list each frame, calling
 * `purchaseMax()` on every candidate whose `canPurchase` is true.
 *
 * For one-shot purchasables (`limit: 1`), `purchaseMax()` reduces to a single
 * `purchase()`. For leveled / uncapped purchasables, it spends as much as the
 * resource allows in a single call.
 *
 * Use this for upgrades and leveled perks where there's no contention between
 * candidates. For producer chains where costs grow into each other, see
 * {@link setupPolicyAutoPurchase} instead.
 *
 * @param purchasables - Purchasable list or group to auto-buy from
 * @param enabled - Reactive toggle for the auto-purchase behavior
 * @param registerTick - Function to register a per-tick callback (e.g., `ctx.onTick`)
 * @returns Cleanup function that unregisters the tick handler
 *
 * @example
 * ```ts
 * // Reveal unlocks the moment their requirement is met
 * setupSweepAutoPurchase(
 *   unlocks.getAll().map((entry) => entry.purchasable),
 *   () => true,
 *   ctx.onTick,
 * );
 * ```
 */
export function setupSweepAutoPurchase(
  purchasables: Purchasable[] | PurchasableGroup,
  enabled: Computable<boolean>,
  registerTick: (callback: (dt: number) => void) => () => void,
): () => void {
  const processedEnabled = processGetter(enabled);
  const list = Array.isArray(purchasables) ? purchasables : purchasables.purchasables;

  return registerTick(() => {
    if (!unref(processedEnabled)) return;

    for (const p of list) {
      if (p.canPurchase.value) {
        p.purchaseMax();
      }
    }
  });
}

// === POLICY AUTO-PURCHASE ===

/**
 * Options for {@link setupPolicyAutoPurchase}.
 *
 * All knobs accept `Computable`s so games can wire them to upgrades,
 * automation tiers, or player settings refs directly.
 */
export interface SetupPolicyAutoPurchaseOptions {
  /** Reactive toggle for the whole loop */
  enabled: Computable<boolean>;
  /**
   * Throttle interval in seconds between purchase attempts. `0` (default)
   * means "try every tick". Fractional values are allowed.
   */
  interval?: Computable<number>;
  /**
   * Selection policy used to pick one producer per drained slot. Defaults
   * to {@link selectionCheapest} over `repeatable.getCost(1)`. Pass any
   * built-in factory ({@link selectionPaybackPeriod},
   * {@link selectionHybridPayback}, {@link selectionComposite}) or a
   * consumer-defined `SelectionPolicy<Producer>` for custom scoring.
   */
  policy?: Computable<SelectionPolicy<Producer>>;
  /**
   * Bulk purchase amount per selected producer. Default: `1`.
   *
   * The engine passes this straight to `repeatable.purchase(bulkAmount)` —
   * it's up to the Purchasable to honor bulk semantics. Use `1` when you
   * want deterministic per-tick picks (policy testing, correctness).
   */
  bulkAmount?: Computable<DecimalSource>;
  /**
   * Spending-discipline floor. The auto-buyer will not drive the producer's
   * resource below this value — `canPurchase` is tightened to require
   * `resource.value − reserve ≥ cost`. Orthogonal to policy, applied
   * uniformly across every candidate. Default: `0` (no reserve).
   *
   * Mirrors the "leave N in the bank" pattern shared by Frozen Cookies
   * (Spontaneous Edifice / harvest bank), Cookie Monster (`PP` formula's
   * bank term), and AutoTrimps (`spendingPerc`). Kept in the same currency
   * as the producer's output; assumes cost-resource equals produce-resource
   * (the Cookie Clicker shape that {@link selectionHybridPayback} is
   * designed for).
   */
  reserve?: Computable<DecimalSource>;
}

/**
 * Register a tick handler that auto-buys one producer per throttled beat
 * according to a {@link SelectionPolicy}.
 *
 * This is the producer-chain counterpart to {@link setupSweepAutoPurchase}
 * (which covers leveled/one-shot upgrades). The two have different semantics
 * and coexist: upgrades use `purchaseMax()` uncontested, whereas producers
 * need a *pick-one-then-buy* loop because their costs grow into each other
 * and naive max-buy wipes the player's resource on the cheapest option.
 *
 * Behavior per tick:
 * 1. Accumulate `dt`. If below `interval`, return.
 * 2. If `enabled` is false, reset the accumulator and return.
 * 3. Filter producers by `canPurchase.value && repeatable !== undefined`
 *    and, when `reserve > 0`, `resource.value − reserve ≥ getCost(1)`.
 * 4. Pass the filtered list to `policy.pick()` and purchase the winner.
 * 5. Subtract `interval` from the accumulator (so beat timing stays stable)
 *    and re-scan if more drained slots remain.
 *
 * @param producers - A {@link ProducerCategory} or a raw `Producer[]`
 * @param options - Policy + throttle knobs
 * @param registerTick - Tick registration (typically `ctx.onTick`)
 * @returns Cleanup function that unregisters the tick handler
 *
 * @example
 * ```ts
 * // Cookie Clicker-style hybrid auto-buy behind an upgrade
 * setupPolicyAutoPurchase(
 *   buildings,
 *   {
 *     enabled: () => autoBuyUnlocked.value,
 *     policy: selectionHybridPayback({
 *       getCost: (p) => p.repeatable!.getCost(1),
 *       getRate: (p) => p.computedRate.value,
 *       getResource: (p) => p.resource.value,
 *       getReserve: () => reserveRef.value,
 *       getHeadlineRate: (p) => buildings.getTotalRate(p.resource),
 *     }),
 *     interval: () => 5 / tier.value,
 *     reserve: reserveRef,
 *   },
 *   ctx.onTick,
 * );
 * ```
 */
export function setupPolicyAutoPurchase(
  producers: ProducerCategory<{ id: string }, unknown> | Producer[],
  options: SetupPolicyAutoPurchaseOptions,
  registerTick: RegisterTick,
): () => void {
  const processedEnabled = processGetter(options.enabled);
  const processedInterval = processGetter(options.interval ?? 0);
  const processedPolicy = processGetter<SelectionPolicy<Producer>>(
    options.policy ?? defaultCheapestPolicy,
  );
  const processedBulk = processGetter<DecimalSource>(options.bulkAmount ?? 1);
  const processedReserve = processGetter<DecimalSource>(options.reserve ?? 0);

  // Resolve the producer list lazily on each tick so late-registered
  // producers (mods, delayed content unlocks) participate automatically.
  // Category registration is additive-only, so `category.size` is a sound
  // cache key: when it matches the cached length, the underlying entries
  // are unchanged and we can skip allocating a fresh wrapper array.
  let getList: () => Producer[];
  let aggregateRate: (resource: Resource) => DecimalSource;
  if (Array.isArray(producers)) {
    getList = () => producers;
    aggregateRate = (resource) => {
      let total: DecimalSource = Decimal.dZero;
      for (const other of producers) {
        if (other.trigger !== 'continuous') continue;
        if (other.resource !== resource) continue;
        total = Decimal.add(total, Decimal.mul(other.computedRate.value, other.count.value));
      }
      return total;
    };
  } else {
    const category = producers;
    let cachedList: Producer[] = [];
    let cachedSize = -1;
    getList = () => {
      if (category.size !== cachedSize) {
        cachedList = category.getAll().map((e) => e.producer);
        cachedSize = category.size;
      }
      return cachedList;
    };
    aggregateRate = (resource) => category.getTotalRate(resource);
  }

  // Time-integrated accumulator: drains by `dt` each tick, so it must
  // round-trip with the rest of engine state under `importSave`. Closure-local
  // `let` state survives `simulateTick` but not `importSave`, so a mid-run
  // snapshot restore (solver bisection, devtools time-rewind, deterministic
  // replay) would leave the accumulator out of sync with the resources and
  // purchase counts that were just restored.
  const accumulator = persistent<number>(0, {
    name: `policyAutoPurchaseAccumulator_${++policyAutoPurchaseAccumulatorCounter}`,
  });

  // Per-slot headline-rate cache, keyed by Resource identity. Lives outside
  // the policy so all policies share the optimization, and the cache
  // invalidation discipline (clear after each purchase) lives next to the
  // mutation that requires it. `selectionHybridPayback` is the only built-in
  // that reads it; consumer-defined policies can ignore the getter.
  const headlineRateByResource = new Map<Resource, Decimal>();
  const getHeadlineRate = (producer: Producer): Decimal => {
    const cached = headlineRateByResource.get(producer.resource);
    if (cached) return cached;
    const total = Decimal.fromValue(aggregateRate(producer.resource));
    headlineRateByResource.set(producer.resource, total);
    return total;
  };

  return registerTick((dt: number) => {
    if (!unref(processedEnabled)) {
      accumulator.value = 0;
      return;
    }

    accumulator.value += dt;
    const interval = Math.max(0, Number(unref(processedInterval)) || 0);
    if (accumulator.value < interval) return;

    const list = getList();
    if (list.length === 0) {
      accumulator.value = 0;
      return;
    }

    const policy = unref(processedPolicy);
    const reserve = Decimal.fromValue(unref(processedReserve));
    const useReserve = reserve.gt(0);

    // Drain-while-≥-interval: one slot per iteration of simulated time,
    // re-scanning each slot so state changes between purchases (resource
    // spent, rates bumped, newly-unaffordable producers) are reflected. A
    // slot that finds no candidate is still a slot — sim time passes and
    // the accumulator drains regardless, matching the single-slot semantics
    // of the pre-drain implementation. `interval <= 0` collapses to one
    // purchase attempt per tick with the accumulator cleared.
    while (accumulator.value >= interval) {
      headlineRateByResource.clear();

      const scanStart = profileStart();
      const candidates: Producer[] = [];
      for (const producer of list) {
        const { repeatable } = producer;
        if (!repeatable) continue;
        if (!repeatable.canPurchase.value) continue;

        if (useReserve) {
          const cost = Decimal.fromValue(repeatable.getCost(1));
          const available = Decimal.fromValue(producer.resource.value);
          if (Decimal.sub(available, reserve).lt(cost)) continue;
        }

        candidates.push(producer);
      }

      const best = candidates.length > 0 ? policy.pick(candidates, { getHeadlineRate }) : undefined;
      profileEnd('autobuy.decide', scanStart);

      if (best && best.repeatable) {
        const buyTarget = best.repeatable;
        profile('autobuy.purchase', () => buyTarget.purchase(unref(processedBulk)));
      }

      if (interval <= 0) {
        accumulator.value = 0;
        break;
      }
      accumulator.value -= interval;
    }
  });
}
