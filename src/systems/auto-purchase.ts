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
 *   optional reserve floor. The contested-roster shape: producers with
 *   escalating costs compete for one resource, so naive max-buy wipes the
 *   player's resource on the cheapest option and we need a score-and-pick
 *   loop instead.
 *
 * Names expose the trigger-shape (sweep vs policy), not the input-shape
 * (purchasable vs producer). The same policy primitive drives any candidate
 * type — see `core/policy.ts` for the four built-in factories.
 *
 * @cluster purchasable
 */

import { unref } from 'vue';
import { toMaybeRef, type Computable } from '@/core/computed';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { persistent } from '@/core/persistence';
import { profile, profileStart, profileEnd } from '@/core/profiler';
import type { Resource } from '@/core/resource';
import type { RegisterTick } from '@/core/sequencer';
import {
  isCostRequirement,
  requirementsMet,
  type CostRequirement,
  type Requirement,
} from '@/core/requirements';
import { selectionCheapest, type SelectionPolicy } from '@/core/policy';
import { countAffordable } from '@/core/formulas/affordability';
import type { Purchasable } from './purchasable';
import type { PurchasableCategory } from './purchasable-category';
import type { Producer, ProducerCategory } from './producer-category';
import { cachedCategoryList } from './category-base';

// Default policy: cheapest by `repeatable.getCost(1)`. Module-level singleton
// so identity is stable across `toMaybeRef` calls when `options.policy`
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
 * Total cost is non-decreasing in `n`, so "fits" is a monotone predicate and
 * the formula layer's whole-count search finds its boundary. Callers reach this
 * through {@link reserveClampedAmount}, which passes an `available` already
 * reduced by the floor, so the result is the most that can be bought without
 * breaching it. A fractional `ceiling` admits the whole counts below it, and
 * an unbounded one is searched like any other: every count returned is priced.
 *
 * @internal
 */
function largestAffordable(
  getCost: (amount: DecimalSource) => DecimalSource,
  available: Decimal,
  ceiling: DecimalSource,
): DecimalSource {
  // Without a seed the search would bisect all the way down to find this.
  if (Decimal.lt(available, getCost(1))) return Decimal.dZero;
  const cap = Decimal.floor(ceiling);
  // A cap of one was just priced above.
  if (cap.eq(1)) return cap;
  return countAffordable((n) => Decimal.lte(getCost(n), available), cap, null);
}

/**
 * Whether `req` is a top-level cost the purchase spends — the only requirement
 * the reserve floor measures and the only one `waitForCost` lets go unmet.
 * Costs nested inside `anyOf` / `allOf` are opaque here, so both treat them as
 * plain requirements: never floored, never waited on.
 */
function isPayingCost(req: Requirement): req is CostRequirement {
  return isCostRequirement(req) && unref(req.requiresPay);
}

function topLevelRequirements(p: Purchasable): Requirement[] {
  return Array.isArray(p.requirements) ? p.requirements : [p.requirements];
}

/**
 * Whether `p` would be purchasable given enough of what it spends: visible, not
 * maxed, and every requirement but its paying costs met.
 */
function isUnlockedButForCost(p: Purchasable): boolean {
  if (p.maxed.value || !p.visible.value) return false;
  return topLevelRequirements(p).every((req) => isPayingCost(req) || requirementsMet(req));
}

/**
 * Save name for a helper's interval accumulator: the explicit id, else the
 * category it drives, else the bare kind inside the ambient context.
 */
function accumulatorName(kind: string, id: string | undefined, category?: { id: string }): string {
  const suffix = id ?? category?.id;
  return suffix === undefined ? kind : `${kind}:${suffix}`;
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
  /**
   * Names the interval accumulator this helper saves, so it must be unique
   * among sweep auto-buyers in one persistent context. Defaults to the
   * category's id, or to the bare kind for a `Purchasable[]` — a second
   * unnamed array-form sweep with an `interval` in the same context then
   * throws a name collision. Unused without an `interval`.
   */
  id?: string;
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
   * grouped by the resource they spend, costs summed within a group, and the
   * same floor held against each. Single-currency lists (the common case) see
   * the plain "leave N in the bank" semantic.
   *
   * Re-read once per candidate, not once per beat, so a floor expressed as a
   * fraction of the live bank (`() => 0.2 * bank.value`) holds *cumulatively*
   * as earlier candidates in the sweep spend.
   *
   * The floor clamps rather than skips: a candidate that can afford three
   * levels under the floor but not ten buys three. Its policy sibling clamps
   * too, but screens candidates on a single unit first, since it buys one
   * winner rather than everything affordable.
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
 *
 * `ceiling` caps the search. It defaults to what a `purchase()` call would buy,
 * which is what the sweep wants; the policy helper passes its own bulk amount
 * instead. A `ceiling` of `1` answers the boolean "is one unit payable under
 * the floor" without running the search at all.
 */
function reserveClampedAmount(
  p: Purchasable,
  reserve: Decimal,
  ceilingArg: DecimalSource = p.countToPurchase.value,
): DecimalSource {
  let ceiling = ceilingArg;

  const byResource = new Map<Resource, CostRequirement[]>();
  for (const req of topLevelRequirements(p)) {
    if (!isPayingCost(req)) continue;
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
 * @param purchasables - A {@link PurchasableCategory}, whose later
 *   registrations join the sweep, or a fixed `Purchasable[]`
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
 *   upgrades,
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
  purchasables: PurchasableCategory<{ id: string }, unknown> | Purchasable[],
  options: SetupSweepAutoPurchaseOptions,
  registerTick: RegisterTick,
): () => void {
  const processedEnabled = toMaybeRef(options.enabled);
  const hasReserve = options.reserve !== undefined;
  const processedReserve = toMaybeRef<DecimalSource>(options.reserve ?? 0);

  const getList: () => Purchasable[] = Array.isArray(purchasables)
    ? () => purchasables
    : cachedCategoryList(purchasables, (e) => e.purchasable);

  const runSweep = (): void => {
    for (const p of getList()) {
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

  const processedInterval = toMaybeRef(options.interval);

  // Persistent for the same reason the policy helper's accumulator is: a
  // mid-run `importSave` would otherwise leave the throttle phase out of sync
  // with the resources and purchase counts it was just restored alongside.
  const accumulator = persistent<number>(0, {
    id: accumulatorName(
      'sweepAutoPurchaseAccumulator',
      options.id,
      Array.isArray(purchasables) ? undefined : purchasables,
    ),
  });

  return registerTick((dt: number) => {
    if (!unref(processedEnabled)) {
      accumulator.value = 0;
      return;
    }

    accumulator.value += dt;
    const interval = Math.max(0, unref(processedInterval) || 0);
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
  /**
   * Names the interval accumulator this helper saves, so it must be unique
   * among policy auto-buyers in one persistent context. Defaults to the
   * category's id, or to the bare kind for a `Producer[]` — a second unnamed
   * array-form buyer in the same context then throws a name collision.
   */
  id?: string;
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
   * The engine passes this straight to `repeatable.purchase(bulkCount)` —
   * it's up to the Purchasable to honor bulk semantics. Use `1` when you
   * want deterministic per-tick picks (policy testing, correctness).
   */
  bulkCount?: Computable<DecimalSource>;
  /**
   * Spending-discipline floor. The auto-buyer will not drive any resource a
   * purchase *spends* below this value: a candidate is screened out unless every
   * paying cost requirement admits a single unit above the floor, measured per
   * cost-resource. Under {@link waitForCost} the same test gates the pick
   * instead, so a pick the floor holds back buys nothing. Note this is the
   * resource the purchase costs, which is not necessarily the one the producer
   * makes. Orthogonal to policy, applied uniformly across every candidate.
   * Default: `0` (no reserve).
   *
   * Only top-level cost requirements are seen. Costs nested inside `anyOf` /
   * `allOf` are opaque to the floor — the same limitation `Purchasable.getCost`
   * has.
   *
   * The floor also clamps {@link bulkCount}: candidate selection screens on
   * the cost of a single unit, so the winning bulk buy is cut down to whatever
   * the floor admits rather than spending through it.
   *
   * Read once per tick, not once per drained slot — a floor expressed as a
   * fraction of the bank stays at its start-of-tick value for the whole drain,
   * which over-reserves slightly rather than under-reserving.
   *
   * Mirrors the "leave N in the bank" pattern shared by auto-buy
   * userscripts.
   *
   * Independent of any reserve a {@link SelectionPolicy} scores with —
   * {@link selectionHybridPayback}'s wait term reads whatever `getAmount`
   * the consumer wired, which is a ranking heuristic, not this floor. The two
   * can disagree when cost-resource and produce-resource differ.
   */
  reserve?: Computable<DecimalSource>;
  /**
   * Let the policy save up. When on, candidates the player can't yet afford
   * still reach `policy.pick`, and a pick that can't be paid — short of its
   * cost, or held back by {@link reserve} — buys nothing that slot rather than
   * falling through to something affordable. This is what makes
   * {@link selectionHybridPayback}'s wait term live. Default: `false`, where
   * only candidates payable right now are offered.
   *
   * Only cost is waited on: hidden, maxed and otherwise-locked producers stay
   * out of the candidate list either way. A cost nested inside `anyOf` /
   * `allOf` is opaque, so it gates like any other requirement.
   *
   * Can be a ref or getter, e.g. gated on an automation tier, and is read once
   * per tick.
   *
   * A sibling auto-buyer on the same wallet keeps spending what this one is
   * saving; to stop it, wrap the policy so it records its pick in a ref and
   * wire the sibling's `reserve` getter from that pick's cost.
   */
  waitForCost?: Computable<boolean>;
  /**
   * Safety cap on drain-loop iterations per tick handler invocation
   * (default `10000`). Mirrors {@link createTickDriver}'s `maxTicksPerInterval`:
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
 * This is the producer-roster counterpart to {@link setupSweepAutoPurchase}
 * (which covers leveled/one-shot upgrades). The two have different semantics
 * and coexist: upgrades use `purchaseMax()` uncontested, whereas producers
 * need a *pick-one-then-buy* loop because their costs grow into each other
 * and naive max-buy wipes the player's resource on the cheapest option.
 *
 * Behavior per tick:
 * 1. Accumulate `dt`. If below `interval`, return.
 * 2. If `enabled` is false, reset the accumulator and return.
 * 3. Filter continuous producers by `canPurchase.value && repeatable !== undefined`
 *    and, when `reserve > 0`, whether a single unit is payable with every
 *    cost-resource left at or above the floor. A manual producer yields only
 *    when clicked, so its purchase is the player's call. Under
 *    {@link SetupPolicyAutoPurchaseOptions.waitForCost | waitForCost}, the
 *    paying costs and the floor drop out of this filter.
 * 4. Pass the filtered list to `policy.pick()` and purchase the winner,
 *    clamping `bulkCount` to what the reserve admits. A winner that can't be
 *    paid buys nothing.
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
 * // Hybrid auto-buy behind an upgrade
 * setupPolicyAutoPurchase(
 *   buildings,
 *   {
 *     enabled: () => autoBuyUnlocked.value,
 *     policy: selectionHybridPayback({
 *       getCost: (p) => p.repeatable!.getCost(1),
 *       getRate: (p) => p.computedRate.value,
 *       getAmount: (p) => p.resource.value,
 *       getReserve: () => reserveRef.value,
 *       getTotalRate: (p) => buildings.getTotalRate(p.resource),
 *     }),
 *     waitForCost: true,
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
  const processedEnabled = toMaybeRef(options.enabled);
  const processedInterval = toMaybeRef(options.interval ?? 0);
  const processedPolicy = toMaybeRef<SelectionPolicy<Producer>>(
    options.policy ?? defaultCheapestPolicy,
  );
  const processedBulk = toMaybeRef<DecimalSource>(options.bulkCount ?? 1);
  const processedReserve = toMaybeRef<DecimalSource>(options.reserve ?? 0);
  const processedWaitForCost = toMaybeRef(options.waitForCost ?? false);
  const maxIterationsPerTick = options.maxIterationsPerTick ?? 10000;
  const onIterationsOverflow = options.onIterationsOverflow;

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
    getList = cachedCategoryList(category, (e) => e.producer);
    aggregateRate = (resource) => category.getTotalRate(resource);
  }

  // Time-integrated accumulator: drains by `dt` each tick, so it must
  // round-trip with the rest of engine state under `importSave`. Closure-local
  // `let` state survives `advanceTime` but not `importSave`, so a mid-run
  // snapshot restore (solver bisection, devtools time-rewind, deterministic
  // replay) would leave the accumulator out of sync with the resources and
  // purchase counts that were just restored.
  const accumulator = persistent<number>(0, {
    id: accumulatorName(
      'policyAutoPurchaseAccumulator',
      options.id,
      Array.isArray(producers) ? undefined : producers,
    ),
  });

  // Per-slot headline-rate cache, keyed by Resource identity. Lives outside
  // the policy so all policies share the optimization, and the cache
  // invalidation discipline (clear after each purchase) lives next to the
  // mutation that requires it. `selectionHybridPayback` is the only built-in
  // that reads it; consumer-defined policies can ignore the getter.
  const headlineRateByResource = new Map<Resource, Decimal>();
  const getTotalRate = (producer: Producer): Decimal => {
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
    const interval = Math.max(0, unref(processedInterval) || 0);
    if (accumulator.value < interval) return;

    const list = getList();
    if (list.length === 0) {
      accumulator.value = 0;
      return;
    }

    const policy = unref(processedPolicy);
    const reserve = Decimal.fromValue(unref(processedReserve));
    const useReserve = reserve.gt(0);
    const waitForCost = unref(processedWaitForCost);

    // Drain-while-≥-interval: one slot per iteration of simulated time,
    // re-scanning each slot so state changes between purchases (resource
    // spent, rates bumped, newly-unaffordable producers) are reflected. A
    // slot that finds no candidate is still a slot — sim time passes and
    // the accumulator drains regardless, matching the single-slot semantics
    // of the pre-drain implementation. `interval <= 0` collapses to one
    // purchase attempt per tick with the accumulator cleared.
    //
    // `iterations < maxIterationsPerTick` mirrors createTickDriver's
    // maxTicksPerInterval safety cap — pathological combos (tiny interval +
    // long offline catch-up dt) would otherwise drain millions of times
    // synchronously and freeze the thread.
    let iterations = 0;
    while (accumulator.value >= interval && iterations < maxIterationsPerTick) {
      headlineRateByResource.clear();

      const scanStart = profileStart();
      const candidates: Producer[] = [];
      for (const producer of list) {
        const { repeatable } = producer;
        if (!repeatable || producer.trigger !== 'continuous') continue;

        if (waitForCost) {
          // Affordability and the floor move to the pick, below.
          if (!isUnlockedButForCost(repeatable)) continue;
        } else {
          if (!repeatable.canPurchase.value) continue;
          // Screened through the same helper the bulk clamp uses, so filter
          // and clamp cannot disagree about what the floor admits.
          // `producer.resource` is the *produced* resource; the floor belongs
          // on whatever the purchase spends, which only the requirements know.
          if (useReserve && Decimal.lte(reserveClampedAmount(repeatable, reserve, 1), 0)) continue;
        }

        candidates.push(producer);
      }

      const best = candidates.length > 0 ? policy.pick(candidates, { getTotalRate }) : undefined;
      profileEnd('auto-purchase.decide', scanStart);

      // A pick that can't be paid — possible only under `waitForCost` — is
      // what the policy is saving toward, so the slot buys nothing: falling
      // through to an affordable runner-up would spend the savings. The floor
      // half of that check is the clamp below coming out at zero.
      if (best?.repeatable?.canPurchase.value) {
        const buyTarget = best.repeatable;
        const bulk = unref(processedBulk);

        // The candidate filter above only proved that a *single* unit fits
        // under the floor, and under `waitForCost` not even that. Buying
        // `bulk` on that evidence spends straight through the reserve
        // whenever `bulkCount > 1`, so clamp to what the floor actually
        // admits. Capping the ceiling at `countToPurchase` costs nothing —
        // `purchase()` re-clamps there anyway — and keeps a non-finite `bulk`
        // from making the clamp a no-op.
        const amount = useReserve
          ? reserveClampedAmount(
              buyTarget,
              reserve,
              Decimal.min(bulk, buyTarget.countToPurchase.value),
            )
          : bulk;

        if (Decimal.gt(amount, 0)) {
          profile('auto-purchase.purchase', () => buyTarget.purchase(amount));
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
