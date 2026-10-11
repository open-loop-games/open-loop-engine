/**
 * Auto-purchase utilities — player-facing automation over Purchasable / Producer.
 *
 * Two trigger shapes share this file, because both are auto-purchase with
 * different selection mechanisms:
 *
 * - {@link setupSweepAutoPurchase} — on each tick, or each interval when
 *   throttled, purchase every affordable purchasable, clamped by an optional
 *   reserve. A light utility for one-shot upgrades and purchasables with a
 *   limit, where candidates don't compete.
 * - {@link setupPolicyAutoPurchase} — pick one, then purchase it, under a
 *   {@link SelectionPolicy}, throttled by an interval and blocked by an
 *   optional reserve. The shape for competing candidates: producers with
 *   rising costs compete for one resource. So a naive purchase max spends the
 *   player's whole amount on the cheapest option, and a score-and-pick loop is
 *   needed instead.
 *
 * Names expose the trigger shape (sweep vs policy), not the input shape
 * (purchasable vs producer). The same policy primitive drives any candidate
 * type — see `core/policy.ts` for the built-in factories.
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
// is omitted; the utility's own filter guarantees every candidate has a
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
 * the formulas' whole-count search (`countAffordable`) finds its boundary.
 * Callers reach this through {@link reserveClampedAmount}, which passes an
 * `available` already reduced by the reserve. So the result is the most that
 * can be purchased without spending into it. A fractional `ceiling` admits the
 * whole counts below it, and an unbounded one is searched like any other:
 * every count returned has had its cost checked.
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
  // A cap of one was just checked above.
  if (cap.eq(1)) return cap;
  return countAffordable((n) => Decimal.lte(getCost(n), available), cap, null);
}

/**
 * Whether `req` is a top-level cost the purchase spends — the only requirement
 * the reserve measures and the only one `waitForCost` lets go unmet.
 * Costs nested inside `anyOf` / `allOf` are opaque here, so both treat them as
 * plain requirements: never held to the reserve, never waited on.
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
 * Persistent ref id for a utility's interval accumulator: the explicit id, else
 * the category it drives, else the bare kind inside the enclosing persistent context.
 */
function accumulatorName(kind: string, id: string | undefined, category?: { id: string }): string {
  const suffix = id ?? category?.id;
  return suffix === undefined ? kind : `${kind}:${suffix}`;
}

// === SWEEP AUTO-PURCHASE ===

/**
 * Options for {@link setupSweepAutoPurchase}.
 *
 * Option names mirror {@link SetupPolicyAutoPurchaseOptions} where the two
 * overlap, but the behavior differs where the trigger shapes differ — see
 * {@link SetupSweepAutoPurchaseOptions.interval}.
 */
export interface SetupSweepAutoPurchaseOptions {
  /**
   * The id of the interval accumulator this sweep saves, so it must be unique
   * among sweep auto-purchases in one persistent context. Defaults to the
   * category's id, or to the bare kind for a `Purchasable[]`. A second
   * unnamed array-form sweep with an `interval` in the same persistent context
   * then throws an id collision. Unused without an `interval`.
   */
  id?: string;
  /** Reactive toggle for the whole sweep */
  enabled: Computable<boolean>;
  /**
   * Throttle interval in seconds between sweeps. `0` (default) sweeps every
   * tick. Fractional values are allowed.
   *
   * Unlike {@link SetupPolicyAutoPurchaseOptions.interval}, elapsed attempts are
   * *not* replayed. A sweep purchases everything affordable, so one sweep after
   * a long `dt` ends in the same state as a thousand sweeps would. The
   * accumulator keeps its phase modulo `interval`, and the sweep runs once.
   * That's why there's no drain loop and no purchase-attempt cap here.
   *
   * Setting this field registers a persistent accumulator, so the call must
   * be inside a persistent context. Omit it and the sweep registers no
   * persistent ref at all.
   */
  interval?: Computable<number>;
  /**
   * The reserve: the amount of each cost resource the sweep leaves unspent.
   * Default: `0` (no reserve).
   *
   * Applied *per cost resource*: each candidate's cost requirements are
   * grouped by the resource they spend, costs summed within a group, and the
   * same reserve held against each. For a list with one currency (the common
   * case), it means "leave N unspent".
   *
   * Re-read once per candidate, not once per sweep. So a reserve that is a
   * fraction of the live amount (`() => 0.2 * gold.value`) holds
   * *cumulatively* as earlier candidates in the sweep spend.
   *
   * The reserve clamps rather than skips: a candidate that can afford three
   * units above the reserve but not ten purchases three.
   * `setupPolicyAutoPurchase` clamps too, but screens candidates on a single
   * unit first, because it purchases one winner rather than everything affordable.
   *
   * Only top-level cost requirements are seen. Costs nested inside `anyOf` /
   * `allOf` are opaque to the reserve — the same limitation `Purchasable.getCost`
   * has.
   */
  reserve?: Computable<DecimalSource>;
}

/**
 * Largest purchase count for `p` that leaves every cost resource it spends at
 * or above `reserve`. Returns `0` when even a single unit would spend into the
 * reserve.
 *
 * Requirements are grouped by the resource they spend and their costs summed
 * within a group, because a group spends from one amount. `Purchasable.getCost`
 * instead sums across *all* requirements regardless of currency, which is
 * meaningless for a per-resource reserve. The tightest group wins.
 *
 * Only top-level cost requirements are seen; costs nested inside `anyOf` /
 * `allOf` are opaque to the reserve, the same limitation `Purchasable.getCost`
 * has.
 *
 * `ceiling` caps the search. It defaults to what a `purchase()` call would take,
 * which is what the sweep wants; the policy utility passes its own bulk count
 * instead. A `ceiling` of `1` answers the boolean "is one unit affordable above
 * the reserve" without running the search at all.
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
 * Register a tick handler that sweeps a purchasable list, purchasing every
 * candidate whose `canPurchase` is true.
 *
 * For one-shot purchasables (`limit: 1`) each purchase is a single `purchase()`.
 * For repeatable purchasables the sweep spends as much as the resource
 * allows, less any {@link SetupSweepAutoPurchaseOptions.reserve}. A purchasable
 * whose `purchaseMaxByDefault` is off takes one unit per sweep.
 *
 * Use this for upgrades and perks whose candidates don't compete. For
 * producers whose costs compete, see {@link setupPolicyAutoPurchase} instead.
 *
 * @param purchasables - A {@link PurchasableCategory}, whose later
 *   registrations join the sweep, or a fixed `Purchasable[]`
 * @param options - Toggle, throttle, and reserve options
 * @param registerTick - Tick registration (typically `ctx.onTick`)
 * @returns Cleanup function that unregisters the tick handler
 *
 * @example
 * ```ts
 * // Purchase unlocks the moment their requirements are met
 * setupSweepAutoPurchase(
 *   unlocks.getAll().map((entry) => entry.purchasable),
 *   { enabled: true },
 *   ctx.onTick,
 * );
 *
 * // Purchase upgrades once a second, keeping 20% of the gold back for the
 * // producer auto-purchase to save toward
 * setupSweepAutoPurchase(
 *   upgrades,
 *   {
 *     enabled: () => autoPurchaseUnlocked.value,
 *     interval: 1,
 *     reserve: () => Decimal.mul(reserveFraction.value, gold.value),
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

      // Re-read per candidate: a reserve that is a fraction of the amount
      // moves as earlier candidates spend. It only holds cumulatively if each
      // candidate sees the amount after those spends.
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

  // Persistent for the same reason the policy utility's accumulator is: a
  // mid-run `importSave` would otherwise leave the throttle phase out of sync
  // with the resources and purchase counts loaded with it.
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
    // Keep the interval phase without replaying elapsed attempts — one sweep
    // covers any number of them.
    accumulator.value %= interval;
    runSweep();
  });
}

// === POLICY AUTO-PURCHASE ===

/**
 * Options for {@link setupPolicyAutoPurchase}.
 *
 * The switch and tuning options accept `Computable`s, so a game can wire them
 * to upgrades, automation tiers, or player settings refs directly.
 */
export interface SetupPolicyAutoPurchaseOptions {
  /**
   * The id of the interval accumulator this auto-purchase saves, so it must be
   * unique among policy auto-purchases in one persistent context. Defaults to
   * the category's id, or to the bare kind for a `Producer[]`. A second unnamed
   * array-form auto-purchase in the same persistent context then throws an id
   * collision.
   */
  id?: string;
  /** Reactive toggle for the whole auto-purchase */
  enabled: Computable<boolean>;
  /**
   * Throttle interval in seconds between purchase attempts. `0` (default)
   * means "try every tick". Fractional values are allowed.
   */
  interval?: Computable<number>;
  /**
   * Selection policy used to pick one producer per attempt. Defaults
   * to {@link selectionCheapest} over `repeatable.getCost(1)`. Pass any
   * built-in factory ({@link selectionPaybackPeriod},
   * {@link selectionHybridPayback}, {@link selectionComposite}) or a
   * consumer-defined `SelectionPolicy<Producer>` for custom scoring.
   */
  policy?: Computable<SelectionPolicy<Producer>>;
  /**
   * Bulk count per selected producer. Default: `1`.
   *
   * The engine passes this to `repeatable.purchase(bulkCount)`, after any
   * {@link reserve} clamp; the Purchasable decides the bulk semantics. Use `1`
   * for one deterministic pick per attempt (policy testing, correctness).
   */
  bulkCount?: Computable<DecimalSource>;
  /**
   * The reserve: the auto-purchase leaves at least this much of each resource
   * a purchase *spends*. A candidate is screened out unless every paying cost
   * requirement admits a single unit above the reserve, measured per cost
   * resource. Under {@link waitForCost} the same test blocks the pick instead,
   * so a pick the reserve holds back purchases nothing. This is the resource
   * the purchase costs, which is not always the one the producer produces. It
   * is independent of the policy, and applies to every candidate.
   * Default: `0` (no reserve).
   *
   * Only top-level cost requirements are seen. Costs nested inside `anyOf` /
   * `allOf` are opaque to the reserve — the same limitation `Purchasable.getCost`
   * has.
   *
   * The reserve also clamps {@link bulkCount}. Candidate selection screens on
   * the cost of a single unit. So the winning bulk purchase is cut down to
   * whatever the reserve admits, rather than spending into it.
   *
   * Read once per tick, not once per attempt. So a reserve that is a fraction
   * of the amount keeps its start-of-tick value for every attempt in the tick.
   * That over-reserves slightly rather than under-reserving.
   *
   * Mirrors the "leave N unspent" pattern of auto-purchase userscripts.
   *
   * Independent of any reserve a {@link SelectionPolicy} scores with —
   * {@link selectionHybridPayback}'s wait term reads the `getAmount` and
   * `getReserve` the consumer wired, a ranking input, not this reserve. The two
   * can disagree when the cost resource and the produced resource differ.
   */
  reserve?: Computable<DecimalSource>;
  /**
   * Let the policy save up. When on, candidates the player can't yet afford
   * still reach `policy.pick`. A pick can be short of its cost, or held back
   * by {@link reserve}. Such a pick purchases nothing that attempt, rather than
   * falling through to something affordable. This is what makes
   * {@link selectionHybridPayback}'s wait term take effect. Default: `false`,
   * where only candidates affordable right now are offered.
   *
   * Only cost is waited on: hidden, maxed and otherwise-locked producers stay
   * out of the candidate list either way. A cost nested inside `anyOf` /
   * `allOf` is opaque, so it blocks like any other requirement.
   *
   * Can be a ref or getter, e.g. one an automation tier unlocks, and is read
   * once per tick.
   *
   * A second auto-purchase on the same resource keeps spending what this one
   * saves. To stop it, give this one a policy that delegates to the real one
   * and records its pick in a ref. Then wire the second one's `reserve` getter from
   * that pick's cost.
   */
  waitForCost?: Computable<boolean>;
  /**
   * Safety cap on purchase attempts per tick handler call
   * (default `10000`). Mirrors {@link createTickDriver}'s `maxTicksPerInterval`.
   * It protects against pathological combinations of tiny `interval` and large
   * `dt` (24h offline catch-up + 1e-6s interval = millions of purchase
   * attempts that would block the thread). When the cap is hit, the loop stops and
   * the remaining `accumulator` is set to zero; consumers observe it through
   * {@link onIterationsOverflow}.
   */
  maxIterationsPerTick?: number;
  /**
   * Diagnostic option callback called when the drain loop stops at the
   * {@link maxIterationsPerTick} cap. Receives the floor of the discarded
   * purchase-attempt count (`accumulator / interval` at the stop). The loop never
   * throws on overflow; the default does nothing. Use it to report
   * misconfiguration in dev mode, or to track overflow in telemetry.
   */
  onIterationsOverflow?: (droppedIterations: number) => void;
}

/**
 * Register a tick handler that auto-purchases one producer per attempt, as a
 * {@link SelectionPolicy} picks.
 *
 * This is the producer counterpart to {@link setupSweepAutoPurchase}
 * (which covers repeatable and one-shot upgrades). The two have different
 * semantics and coexist: upgrades use `purchaseMax()` without competing.
 * Producers need a *pick-one-then-purchase* loop, because their costs compete,
 * and a naive purchase max spends the player's whole amount on the cheapest option.
 *
 * Behavior per tick:
 * 1. If `enabled` is false, set the accumulator to zero and return.
 * 2. Add `dt` to the accumulator. If below `interval`, return.
 * 3. Filter continuous producers by `canPurchase.value && repeatable !== undefined`
 *    and, when `reserve > 0`, whether a single unit is affordable with every
 *    cost resource left at or above the reserve. A manual producer produces
 *    only when activated, so its purchase is the player's choice. Under
 *    {@link SetupPolicyAutoPurchaseOptions.waitForCost | waitForCost}, the
 *    paying costs and the reserve leave this filter.
 * 4. Pass the filtered list to `policy.pick()` and purchase the winner,
 *    clamping `bulkCount` to what the reserve admits. A winner that is not
 *    affordable purchases nothing.
 * 5. Subtract `interval` from the accumulator (so attempt timing stays stable),
 *    and scan again while the accumulator still holds a whole interval.
 *
 * @param producers - A {@link ProducerCategory} or a raw `Producer[]`
 * @param options - Policy, throttle and reserve options
 * @param registerTick - Tick registration (typically `ctx.onTick`)
 * @returns Cleanup function that unregisters the tick handler
 *
 * @example
 * ```ts
 * // Hybrid auto-purchase that an upgrade unlocks
 * setupPolicyAutoPurchase(
 *   buildings,
 *   {
 *     enabled: () => autoPurchaseUnlocked.value,
 *     policy: selectionHybridPayback({
 *       getCost: (p) => p.repeatable!.getCost(1),
 *       getRate: (p) => p.computedRate.value,
 *       getAmount: (p) => p.resource.value,
 *       getReserve: () => reserveRef.value,
 *       getTotalRate: (p) => buildings.getTotalRate(p.resource),
 *     }),
 *     waitForCost: true,
 *     interval: () => 5 / automationTier.value,
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

  // Time-integrated accumulator: it gains `dt` each tick and drains by
  // `interval` per attempt, so it must save and load with the rest of the
  // engine's state under `importSave`. A closure-local `let` keeps its value
  // through `advanceTime` but not `importSave`. So a mid-run load (solver
  // bisection, devtools time rewind, deterministic replay) would leave the
  // accumulator out of sync with the resources and purchase counts just loaded.
  const accumulator = persistent<number>(0, {
    id: accumulatorName(
      'policyAutoPurchaseAccumulator',
      options.id,
      Array.isArray(producers) ? undefined : producers,
    ),
  });

  // Per-attempt total-rate cache, keyed by Resource identity. It is outside
  // the policy so all policies share the optimization, and its invalidation
  // (cleared at the start of each attempt, after the last purchase) is next to
  // the loop that requires it. `selectionHybridPayback` is the only built-in
  // that reads it; consumer-defined policies can ignore the getter.
  const totalRateByResource = new Map<Resource, Decimal>();
  const getTotalRate = (producer: Producer): Decimal => {
    const cached = totalRateByResource.get(producer.resource);
    if (cached) return cached;
    const total = Decimal.fromValue(aggregateRate(producer.resource));
    totalRateByResource.set(producer.resource, total);
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

    // Drain while ≥ interval: one attempt per interval of game time, scanning
    // again each attempt so changes between purchases (resource spent, rates
    // raised, producers no longer affordable) count. An attempt that finds no
    // candidate is still an attempt: game time passes and the accumulator
    // drains regardless. `interval <= 0` collapses to one purchase attempt per
    // tick with the accumulator cleared.
    //
    // `iterations < maxIterationsPerTick` mirrors createTickDriver's
    // maxTicksPerInterval safety cap — pathological combos (tiny interval +
    // long offline catch-up dt) would otherwise drain millions of times
    // synchronously and block the thread.
    let iterations = 0;
    while (accumulator.value >= interval && iterations < maxIterationsPerTick) {
      totalRateByResource.clear();

      const scanStart = profileStart();
      const candidates: Producer[] = [];
      for (const producer of list) {
        const { repeatable } = producer;
        if (!repeatable || producer.trigger !== 'continuous') continue;

        if (waitForCost) {
          // Affordability and the reserve move to the pick, below.
          if (!isUnlockedButForCost(repeatable)) continue;
        } else {
          if (!repeatable.canPurchase.value) continue;
          // Screened through the same helper the bulk clamp uses, so filter
          // and clamp cannot disagree about what the reserve admits.
          // `producer.resource` is the *produced* resource; the reserve belongs
          // on whatever the purchase spends, which only the requirements know.
          if (useReserve && Decimal.lte(reserveClampedAmount(repeatable, reserve, 1), 0)) continue;
        }

        candidates.push(producer);
      }

      const best = candidates.length > 0 ? policy.pick(candidates, { getTotalRate }) : undefined;
      profileEnd('auto-purchase.decide', scanStart);

      // A pick that is not affordable — possible only under `waitForCost` — is
      // what the policy is saving toward, so the attempt purchases nothing:
      // falling through to an affordable runner-up would spend the savings.
      // The reserve half of that check is the clamp below coming out at zero.
      if (best?.repeatable?.canPurchase.value) {
        const buyTarget = best.repeatable;
        const bulk = unref(processedBulk);

        // The candidate filter above only proved that a *single* unit fits
        // above the reserve, and under `waitForCost` not even that. Purchasing
        // `bulk` on that evidence spends into the reserve whenever
        // `bulkCount > 1`, so clamp to what the reserve actually admits. Capping the ceiling at `countToPurchase` costs nothing —
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
