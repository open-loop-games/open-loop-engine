/**
 * Auto-purchase helpers — player-facing automation over Purchasable / Producer.
 *
 * Two trigger shapes share this file because they bridge the same conceptual
 * surface (automation auto-buy) to different selection mechanics:
 *
 * - {@link setupSweepAutoPurchase} — on each (optionally throttled) beat, buy
 *   every affordable purchasable, clamped by an optional reserve floor. Light
 *   helper for one-shot upgrades and capped levels where there's no contention
 *   between candidates.
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
import { isCostRequirement, type CostRequirement, type Requirement } from '@/core/requirements';
import { selectionCheapest, type SelectionPolicy } from '@/core/policy';
import type { Purchasable } from './purchasable';
import type { Producer, ProducerCategory } from './producer-category';

// === CONSTANTS ===

// Monotonic counter used to generate unique persistent-ref names for the
// policy auto-purchase accumulator. Multiple setup calls inside the same
// persistent context (e.g., two categories in one module install) each get
// a distinct key so `importSave` can round-trip them.
let policyAutoPurchaseAccumulatorCounter = 0;

// Same, for the sweep helper's throttle accumulator. Sweep only allocates one
// when `interval` is supplied, so the two counters advance independently.
let sweepAutoPurchaseAccumulatorCounter = 0;

// Iteration bound on the reserve clamp's binary search. Exact for ceilings up
// to 2^64; past that the search returns its current lower bound — an
// under-buy, never a floor breach — and the residual is picked up by the next
// beat, so the clamp converges rather than stalling.
const MAX_RESERVE_CLAMP_STEPS = 64;

// Default policy: cheapest by `repeatable.getCost(1)`. Module-level singleton
// so identity is stable across `processGetter` calls when `options.policy`
// is omitted; the helper-side filter guarantees every candidate has a
// `repeatable` by the time the policy sees it.
const defaultCheapestPolicy: SelectionPolicy<Producer> = selectionCheapest<Producer>((p) =>
  p.repeatable!.getCost(1),
);

// === SHARED BUILDERS ===

/**
 * Largest `n` in `[1, ceiling]` whose total cost fits in `available`, or `0`
 * when even a single unit doesn't.
 *
 * Total cost is non-decreasing in `n`, so "fits" is a monotone predicate and a
 * binary search finds its boundary. Both helpers reach this through a reserve:
 * each passes an `available` already reduced by the floor, so the result is the
 * most that can be bought without breaching it.
 *
 * A `ceiling` of 1 needs no search, and a non-finite one means this cost can't
 * bind (free or unbounded) — both return `ceiling` unchanged.
 *
 * @internal
 */
function largestAffordable(
  getCost: (amount: DecimalSource) => DecimalSource,
  available: Decimal,
  ceiling: DecimalSource,
): DecimalSource {
  if (Decimal.lt(available, getCost(1))) return Decimal.dZero;
  if (Decimal.lte(ceiling, 1) || !Decimal.isFinite(ceiling)) return ceiling;

  let lo: DecimalSource = 1;
  let hi: DecimalSource = ceiling;
  for (let step = 0; step < MAX_RESERVE_CLAMP_STEPS && Decimal.lt(lo, hi); step++) {
    const mid = Decimal.add(lo, hi).add(1).div(2).floor();
    if (Decimal.lte(getCost(mid), available)) lo = mid;
    else hi = Decimal.sub(mid, 1);
  }
  return lo;
}

// === SWEEP AUTO-PURCHASE ===

/**
 * Options for {@link setupSweepAutoPurchase}.
 *
 * Knob names mirror {@link SetupPolicyAutoPurchaseOptions} where the two
 * overlap, but the internals differ where the trigger shapes differ — see
 * {@link SetupSweepAutoPurchaseOptions.interval}.
 */
export interface SetupSweepAutoPurchaseOptions {
  /** Reactive toggle for the whole sweep */
  enabled: Computable<boolean>;
  /**
   * Throttle interval in seconds between sweeps. `0` (default) sweeps every
   * tick. Fractional values are allowed.
   *
   * Unlike {@link SetupPolicyAutoPurchaseOptions.interval}, elapsed beats are
   * *not* replayed. A sweep buys everything affordable, so one sweep after a
   * long `dt` lands in the same state as a thousand sweeps would — the
   * accumulator keeps its phase modulo `interval` and the sweep fires once.
   * That's why there's no drain loop and no iteration cap here.
   *
   * Supplying this field registers a persistent accumulator, so the call must
   * sit inside a persistent context. Omit it and the helper registers no
   * state at all.
   */
  interval?: Computable<number>;
  /**
   * Spending-discipline floor — the sweep will not drive a cost-resource
   * below this value. Default: `0` (no reserve).
   *
   * Applied *per cost-resource*: each candidate's cost requirements are
   * grouped by the resource they spend, and the same floor is held against
   * each. Single-currency lists (the common case) see exactly the "leave N in
   * the bank" semantic {@link SetupPolicyAutoPurchaseOptions.reserve}
   * describes.
   *
   * Re-read once per candidate, not once per beat, so a floor expressed as a
   * fraction of the live bank (`() => 0.2 * bank.value`) holds *cumulatively*
   * as earlier candidates in the sweep spend.
   *
   * The floor clamps rather than skips: a candidate that can afford three
   * levels under the floor but not ten buys three. This is the one place the
   * sweep is stricter than its policy sibling, which filters on the cost of a
   * single unit.
   *
   * Only top-level cost requirements are seen. Costs nested inside `anyOf` /
   * `allOf` are opaque to the floor — the same limitation `Purchasable.getCost`
   * has.
   */
  reserve?: Computable<DecimalSource>;
}

/**
 * Largest purchase amount for `p` that leaves every cost-resource it spends at
 * or above `reserve`. Returns `0` when even a single level would breach the
 * floor.
 *
 * Requirements are grouped by the resource they spend and their costs summed
 * within a group, because a group draws from one balance — `Purchasable.getCost`
 * instead sums across *all* requirements regardless of currency, which is
 * meaningless for a per-resource floor. The tightest group wins.
 *
 * Only top-level cost requirements are seen; costs nested inside `anyOf` /
 * `allOf` are opaque to the floor, the same limitation `Purchasable.getCost`
 * has.
 */
function reserveClampedAmount(p: Purchasable, reserve: Decimal): DecimalSource {
  const reqs: Requirement[] = Array.isArray(p.requirements) ? p.requirements : [p.requirements];
  let ceiling = p.amountToPurchase.value;

  const byResource = new Map<Resource, CostRequirement[]>();
  for (const req of reqs) {
    if (!isCostRequirement(req)) continue;
    if (!unref(req.requiresPay)) continue;
    const group = byResource.get(req.resource);
    if (group) group.push(req);
    else byResource.set(req.resource, [req]);
  }

  for (const [resource, group] of byResource) {
    const affordable = largestAffordable(
      (n) =>
        group.reduce<DecimalSource>((sum, req) => Decimal.add(sum, req.getCost(n)), Decimal.dZero),
      Decimal.sub(resource.value, reserve),
      ceiling,
    );
    if (Decimal.lte(affordable, 0)) return Decimal.dZero;
    ceiling = Decimal.min(ceiling, affordable);
  }

  return ceiling;
}

/**
 * Register a tick handler that sweeps a purchasable list, buying every
 * candidate whose `canPurchase` is true.
 *
 * For one-shot purchasables (`limit: 1`) each buy is a single `purchase()`.
 * For leveled / uncapped purchasables the sweep spends as much as the resource
 * allows, less any {@link SetupSweepAutoPurchaseOptions.reserve} floor.
 *
 * Use this for upgrades and leveled perks where there's no contention between
 * candidates. For producer chains where costs grow into each other, see
 * {@link setupPolicyAutoPurchase} instead.
 *
 * @param purchasables - Purchasable list to auto-buy from
 * @param options - Toggle, throttle, and reserve knobs
 * @param registerTick - Tick registration (typically `ctx.onTick`)
 * @returns Cleanup function that unregisters the tick handler
 *
 * @example
 * ```ts
 * // Reveal unlocks the moment their requirement is met
 * setupSweepAutoPurchase(
 *   unlocks.getAll().map((entry) => entry.purchasable),
 *   { enabled: true },
 *   ctx.onTick,
 * );
 *
 * // Buy upgrades once a second, holding 20% of the live bank back for the
 * // producer auto-buyer to accumulate against
 * setupSweepAutoPurchase(
 *   upgrades.getAll().map((entry) => entry.purchasable),
 *   {
 *     enabled: () => autoBuyUnlocked.value,
 *     interval: 1,
 *     reserve: () => Decimal.mul(reserveFraction.value, bank.value),
 *   },
 *   ctx.onTick,
 * );
 * ```
 */
export function setupSweepAutoPurchase(
  purchasables: Purchasable[],
  options: SetupSweepAutoPurchaseOptions,
  registerTick: RegisterTick,
): () => void {
  const processedEnabled = processGetter(options.enabled);
  const hasReserve = options.reserve !== undefined;
  const processedReserve = processGetter<DecimalSource>(options.reserve ?? 0);

  const runSweep = (): void => {
    for (const p of purchasables) {
      if (!p.canPurchase.value) continue;

      if (!hasReserve) {
        p.purchaseMax();
        continue;
      }

      // Re-read per candidate: a bank-fraction floor moves as earlier
      // candidates spend, and the discipline only holds cumulatively if each
      // candidate sees the post-spend bank.
      const reserve = Decimal.fromValue(unref(processedReserve));
      if (reserve.lte(0)) {
        p.purchaseMax();
        continue;
      }

      const amount = reserveClampedAmount(p, reserve);
      if (Decimal.gt(amount, 0)) p.purchase(amount);
    }
  };

  if (options.interval === undefined) {
    return registerTick(() => {
      if (!unref(processedEnabled)) return;
      runSweep();
    });
  }

  const processedInterval = processGetter(options.interval);

  // Persistent for the same reason the policy helper's accumulator is: a
  // mid-run `importSave` would otherwise leave the throttle phase out of sync
  // with the resources and purchase counts it was just restored alongside.
  const accumulator = persistent<number>(0, {
    name: `sweepAutoPurchaseAccumulator_${++sweepAutoPurchaseAccumulatorCounter}`,
  });

  return registerTick((dt: number) => {
    if (!unref(processedEnabled)) {
      accumulator.value = 0;
      return;
    }

    accumulator.value += dt;
    const interval = Math.max(0, Number(unref(processedInterval)) || 0);
    if (interval <= 0) {
      accumulator.value = 0;
      runSweep();
      return;
    }

    if (accumulator.value < interval) return;
    // Keep beat phase without replaying elapsed beats — one sweep subsumes
    // any number of them.
    accumulator.value %= interval;
    runSweep();
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
   * The floor also clamps {@link bulkAmount}: candidate selection screens on
   * the cost of a single unit, so the winning bulk buy is cut down to whatever
   * the floor admits rather than spending through it.
   *
   * Read once per tick, not once per drained slot — a floor expressed as a
   * fraction of the bank stays at its start-of-tick value for the whole drain,
   * which over-reserves slightly rather than under-reserving.
   *
   * Mirrors the "leave N in the bank" pattern shared by Frozen Cookies
   * (Spontaneous Edifice / harvest bank), Cookie Monster (`PP` formula's
   * bank term), and AutoTrimps (`spendingPerc`). Kept in the same currency
   * as the producer's output; assumes cost-resource equals produce-resource
   * (the Cookie Clicker shape that {@link selectionHybridPayback} is
   * designed for).
   */
  reserve?: Computable<DecimalSource>;
  /**
   * Safety cap on drain-loop iterations per tick handler invocation
   * (default `10000`). Mirrors {@link createTickDriver}'s `maxStepsPerTick`:
   * protects against pathological combinations of tiny `interval` and large
   * `dt` (24h offline catch-up + 1e-6s interval = millions of iterations
   * that would freeze the thread). When the cap is hit, the loop bails and
   * the residual `accumulator` is dropped; consumers observe via
   * {@link onIterationsOverflow}.
   */
  maxIterationsPerTick?: number;
  /**
   * Diagnostic callback fired when the drain loop bails on the
   * {@link maxIterationsPerTick} cap. Receives the floor of the dropped
   * iteration count (`accumulator / interval` at the bail point). Never
   * throws on overflow; default is no-op. Useful for surfacing
   * misconfiguration in dev mode or telemetry-side overflow budgeting.
   */
  onIterationsOverflow?: (droppedIterations: number) => void;
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
 * 4. Pass the filtered list to `policy.pick()` and purchase the winner,
 *    clamping `bulkAmount` to what the reserve admits.
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
  const maxIterationsPerTick = options.maxIterationsPerTick ?? 10000;
  const onIterationsOverflow = options.onIterationsOverflow;

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
    //
    // `iterations < maxIterationsPerTick` mirrors createTickDriver's
    // maxStepsPerTick safety cap — pathological combos (tiny interval +
    // long offline catch-up dt) would otherwise drain millions of times
    // synchronously and freeze the thread.
    let iterations = 0;
    while (accumulator.value >= interval && iterations < maxIterationsPerTick) {
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
        const bulk = unref(processedBulk);

        // The candidate filter above only proved that a *single* unit fits
        // under the floor. Buying `bulk` on that evidence spends straight
        // through the reserve whenever `bulkAmount > 1`, so clamp to what the
        // floor actually admits.
        const amount = useReserve
          ? largestAffordable(
              (n) => buyTarget.getCost(n),
              Decimal.sub(best.resource.value, reserve),
              bulk,
            )
          : bulk;

        if (Decimal.gt(amount, 0)) {
          profile('autobuy.purchase', () => buyTarget.purchase(amount));
        }
      }

      if (interval <= 0) {
        accumulator.value = 0;
        break;
      }
      accumulator.value -= interval;
      iterations++;
    }

    if (iterations >= maxIterationsPerTick && interval > 0 && accumulator.value >= interval) {
      const dropped = Math.floor(accumulator.value / interval);
      accumulator.value = 0;
      onIterationsOverflow?.(dropped);
    }
  });
}
