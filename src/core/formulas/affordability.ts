/**
 * Affordability — how many levels of a cost curve a resource can buy, and what
 * buying them charges
 *
 * The "buy max" question for repeatables and conversions, asked of any
 * {@link Formula} cost curve:
 * - {@link calculateMaxAffordable} counts the affordable levels, reactively
 * - {@link calculateCost} prices a given number of levels
 *
 * Both price levels through the same operation — the series `Formula.sum`
 * under a cumulative cost, a single `evaluate` otherwise — so the count and the
 * charge agree. The formula algebra itself lives in `formulas.ts`.
 */

import type { Resource } from '../resource';
import { Decimal } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import { processGetter, type Computable } from '../computed';
import { profile, profileStart, profileEnd } from '../profiler';
import { computed, unref } from 'vue';
import { captureInversionFailures, representationFloor } from './inversion';
import { bracketMidpoint } from './root-find';
import type { GenericFormula } from './types';

/**
 * Relative slack when comparing a closed-form price against a balance at
 * layer 0.
 *
 * Matches the tolerance `createCostRequirement` applies to the ratio of balance
 * to a flat cost. Tight enough not to grant a level a player is meaningfully
 * short of (a 49.99 balance never affords a 50 cost), wide enough to absorb the
 * ulp a closed form carries where summing the same levels one at a time would
 * land exactly.
 */
const AFFORDABILITY_TOLERANCE = 1e-12;

/**
 * Whether `price` can be met out of `balance`.
 *
 * Non-finite prices are unaffordable rather than free. A cost curve that
 * evaluates to NaN must afford nothing, and `Decimal`'s ordering comparisons
 * answer false against NaN in *both* directions, so a bare `gt` would read
 * "not more than the balance" and hand out levels without limit.
 *
 * The slack is relative to the price, compared as the ratio `price / balance`,
 * and widens above layer 0 only to the ulp the stored exponent carries.
 * `Decimal`'s own tolerance comparisons apply their tolerance to that stored
 * exponent, which makes it an absolute slack in orders of magnitude.
 *
 * @internal
 */
function payable(price: DecimalSource, balance: DecimalSource): boolean {
  if (!Decimal.isFinite(price)) return false;
  if (Decimal.lte(price, balance)) return true;
  if (!Decimal.gt(balance, 0)) return false;
  const slack = Math.max(AFFORDABILITY_TOLERANCE, representationFloor(price));
  return Decimal.lte(Decimal.div(price, balance), 1 + slack);
}

/**
 * Count how many levels a resource can currently afford on a cost curve — the
 * "buy max" for repeatables and conversions.
 *
 * Answers the discrete question: the largest `n` whose price, in the operation
 * {@link calculateCost} charges, fits the balance. That is exactly the count
 * sequential single purchases would reach, so the count and the charge agree.
 * Any curve works, including one with no inverse or no integral. Where an
 * inverse exists it seeds the answer in one step and a short exact walk lands
 * it; otherwise, or when the seed is far off, a bracketed search over whole
 * counts finds it. The search needs the price to rise with the count, which a
 * cumulative price does whenever no level costs less than nothing, and a single
 * payment does when the curve is non-decreasing. On a curve that breaks that,
 * the answer is still a count the balance can pay for, possibly short of the
 * largest.
 *
 * @param formula - Cost formula — the price of the level at its variable
 * @param resource - The resource paying for the levels
 * @param cumulativeCost - If true, affordability is measured against `Σ f(a+i)` over the levels bought. If false, against `f(a + n)` alone. Default: `true`
 * @param maxBulkAmount - Ceiling on the returned count, for "buy max" caps; a fractional cap counts the whole levels below it. Default: unbounded
 * @returns Reactive count of affordable levels, recomputed as the resource, the
 * cost curve, and both options change — including reactive values the curve
 * reads from inside a `Formula.step` / `Formula.if` closure
 */
export function calculateMaxAffordable(
  formula: GenericFormula,
  resource: Resource,
  cumulativeCost: Computable<boolean> = true,
  maxBulkAmount: Computable<DecimalSource> = Decimal.dInf,
) {
  const computedCumulativeCost = processGetter(cumulativeCost);
  const computedmaxBulkAmount = processGetter(maxBulkAmount);

  // Change token for the cost curve. Recomputes — and so returns a *fresh*
  // object — whenever any reactive value the formula reads changes, which makes
  // identity comparison an exact "has the curve moved?" test.
  //
  // Running `evaluate` is what makes it exact, and nothing cheaper is. A
  // signature built by walking `formula.inputs` cannot see the state that
  // `Formula.step` and `Formula.if` hold in a closure (their `inputs` carry
  // only the value; the threshold, the condition and the whole modifier
  // sub-formula do not appear there), nor anything a consumer-built
  // `new Formula({ inputs, evaluate })` closes over. Evaluating reaches all of
  // it, because it runs it.
  //
  // Identity rather than value, because an input can move the curve somewhere
  // other than where it was sampled: a `step` threshold sliding from 100 to 200
  // leaves the value at level 0 untouched while changing what the levels above
  // it cost.
  const curveToken = computed<{ at: DecimalSource }>(() => ({ at: formula.evaluate() }));

  // Threshold guard: cache the affordability band [floorCost, ceilCost) so ticks
  // where the resource changes by a small amount (production) can short-circuit
  // with a handful of comparisons instead of a full invertIntegral +
  // evaluateIntegral. See `scenarioF` in scripts/formula-hotpath-bench.ts.
  //
  // Every field here is part of the key, and the fast path must test all of
  // them: the band was computed at one level, in one pricing operation, under
  // one cap, on one shape of curve, and it is stale if any of the four moved.
  //
  // The fast path must also *read* every reactive input on every run, which is
  // why `curveToken` is read before the early return below rather than inside
  // the test. Vue re-collects dependencies each run, so an input read only on
  // the recomputation path is dropped from the dependency set the first time
  // the guard hits — after which nothing invalidates this computed again and
  // the staleness is permanent, not one tick late.
  let guard: {
    variable: DecimalSource; // innermostVariable snapshot
    affordable: DecimalSource; // cached result
    floorCost: DecimalSource; // total cost of buying `affordable` levels (resource must be >= this)
    ceilCost: DecimalSource; // total cost of buying `affordable + 1` levels (resource must be < this)
    token: { at: DecimalSource }; // curve identity the band was computed against
    cumulative: boolean; // the pricing operation the band was computed in
    maxBulk: DecimalSource; // the cap the band was clamped to
  } | null = null;

  return computed(() =>
    profile('formula.calculateMaxAffordable', () => {
      // Read first, on every path: this is the subscription to every reactive
      // input the curve reads, not just the key it is compared by.
      const token = curveToken.value;
      const maxBulkAmount = unref(computedmaxBulkAmount);
      const cumulativeCost = unref(computedCumulativeCost);
      const currentVariable = unref(formula.innermostVariable) ?? 0;

      if (Decimal.eq(maxBulkAmount, 1)) {
        guard = null;
        // Price the level being bought, in the operation `pay` will charge it
        // in — the same question `priceOf(1)` answers on the general path, and
        // the reason `cumulativeCost` is read above rather than below. A
        // cumulative buy of one sums to `evaluate(A)`, which is `token.at`; a
        // non-cumulative one pays `evaluate(A + 1)` for the level it reaches.
        // Comparing against `token.at` in both granted a level the balance
        // could not cover, and `pay` does not re-check — it subtracts and
        // clamps at zero.
        const price = cumulativeCost ? token.at : formula.evaluate(Decimal.add(currentVariable, 1));
        return payable(price, resource.value) ? Decimal.dOne : Decimal.dZero;
      }

      // --- Threshold guard fast path ---
      // Band membership is tested with the same predicate the answer was
      // decided by (`payable` below), so the cached answer and a recomputation
      // cannot disagree at the boundary — a plain `gte`/`lt` pair here would
      // reject an ulp-wide sliver the recomputation accepts, and return
      // stale-by-one for resource values sitting in it.
      if (
        guard !== null &&
        guard.token === token &&
        guard.cumulative === cumulativeCost &&
        // `maxBulkAmount` defaults to `dInf`, and `processGetter` hands back the
        // same object each run, so identity settles the common case before the
        // comparison that has to reason about infinities.
        (guard.maxBulk === maxBulkAmount || Decimal.eq(guard.maxBulk, maxBulkAmount)) &&
        Decimal.eq(currentVariable, guard.variable) &&
        payable(guard.floorCost, resource.value) &&
        !payable(guard.ceilCost, resource.value)
      ) {
        return guard.affordable;
      }

      // --- Full recomputation ---
      // Counts are whole levels, so a fractional cap admits the levels below it.
      const cap = Decimal.floor(maxBulkAmount);

      // Total charged for buying `n` levels, memoized so the guard update below
      // reads the prices the search already paid for instead of re-pricing them.
      const prices = new Map<string, DecimalSource>();
      const priceOf = (n: DecimalSource): DecimalSource => {
        const d = new Decimal(n);
        const key = `${d.sign}:${d.layer}:${d.mag}`;
        let price = prices.get(key);
        if (price === undefined) {
          price = priceLevels(formula, currentVariable, n, cumulativeCost) ?? Decimal.dInf;
          prices.set(key, price);
        }
        return price;
      };

      /** Whether buying `n` levels is payable out of the current balance. */
      const canAfford = (n: DecimalSource): boolean => payable(priceOf(n), resource.value);

      const seed = profile('formula.affordable.integral', () =>
        seedAffordable(formula, resource.value, currentVariable, cumulativeCost, cap),
      );
      const correctionStart = profileStart();
      const affordable = countAffordable(canAfford, cap, seed);
      profileEnd('formula.affordable.refine', correctionStart);

      // --- Update threshold guard ---
      // The band is [price(n), price(n+1)) in the same operation the answer was
      // computed in. Both bounds discrete now that pricing is: the earlier
      // integral-floor / discrete-ceil mix existed only to paper over the two
      // coordinates disagreeing, and a resource landing in that gap read a
      // stale-by-one answer out of the cache.
      //
      // `capped` asks whether a next level exists to price, so it tests
      // `affordable + 1` *passing* the cap, not reaching it: at exactly the cap
      // that level is still real, and giving the band an infinite ceiling
      // instead of its price would freeze the answer one short.
      const capped = Decimal.gt(Decimal.add(affordable, 1), cap);
      guard = {
        variable: currentVariable,
        affordable,
        floorCost: priceOf(affordable),
        ceilCost: capped ? Decimal.dInf : priceOf(Decimal.add(affordable, 1)),
        token,
        cumulative: cumulativeCost,
        maxBulk: maxBulkAmount,
      };

      return affordable;
    }),
  );
}

/**
 * Total charged for `n` levels bought from `from`, in the pricing operation the
 * purchase pays, or `null` when a cumulative span has no price. No levels cost
 * nothing, in either operation.
 *
 * @internal
 */
function priceLevels(
  formula: GenericFormula,
  from: DecimalSource,
  n: DecimalSource,
  cumulativeCost: boolean,
): DecimalSource | null {
  if (Decimal.lte(n, 0)) return Decimal.dZero;
  if (!cumulativeCost) return formula.evaluate(Decimal.add(from, n));
  return formula.sum(from, n).value;
}

/**
 * The continuous answer, as a whole count clamped to `[0, cap]`, or `null` when
 * the curve has no inverse to solve it with or the inverse has no answer here.
 *
 * @internal
 */
function seedAffordable(
  formula: GenericFormula,
  balance: DecimalSource,
  currentVariable: DecimalSource,
  cumulativeCost: boolean,
  cap: DecimalSource,
): DecimalSource | null {
  // A seed is an accelerator, so an inverse that fails is a missing seed rather
  // than a report: the search answers without one.
  const { value: level, failure } = captureInversionFailures(() => {
    if (cumulativeCost) {
      if (!formula.isIntegralInvertible()) return null;
      return formula.invertIntegral(Decimal.add(balance, formula.evaluateIntegral()));
    }
    // `invert(R)` is the level whose single payment is R, so the count is the
    // distance to it from here.
    return formula.isInvertible() ? formula.invert(balance) : null;
  });
  if (failure != null || level == null) return null;
  const count = Decimal.sub(Decimal.floor(level), currentVariable);
  return Decimal.isFinite(count) ? Decimal.clamp(count, 0, cap) : null;
}

/**
 * How far the walk from a seed goes in either direction before handing over to
 * the search. The seed solves the continuous equation, so it lands within about
 * a level of the discrete answer — half of one for every geometric curve, since
 * the two differ by the fixed factor ln(s)/(s−1) — and the walk takes a couple
 * of steps. Past this bound the seed was not close, and bisecting is cheaper.
 */
const CORRECTION_LIMIT = 64;

/** Bound on the bracket search's expansions and halvings. */
const SEARCH_LIMIT = 256;

/**
 * Largest whole count in `[0, cap]` that `canAfford` accepts, for a
 * `canAfford` that holds up to some count and fails above it.
 *
 * Every count returned has passed `canAfford` (or is zero), including when the
 * precondition fails or a budget runs out. The answer can then fall short, but
 * it is never a count nobody priced: `pay` doesn't re-check it, it subtracts and
 * clamps at zero, so an unpriced count hands out free levels.
 *
 * @internal
 */
function countAffordable(
  canAfford: (n: DecimalSource) => boolean,
  cap: DecimalSource,
  seed: DecimalSource | null,
): DecimalSource {
  if (Decimal.lt(cap, 1)) return Decimal.dZero;
  let lo: DecimalSource = Decimal.dZero;
  let hi: DecimalSource | null = null;

  if (seed != null) {
    let n = seed;
    let verified = false;
    for (let i = 0; i < CORRECTION_LIMIT; i++) {
      if (canAfford(n)) {
        verified = true;
        break;
      }
      hi = n;
      if (!Decimal.gt(n, 0)) return Decimal.dZero;
      n = Decimal.sub(n, 1);
    }
    if (verified) {
      lo = n;
      for (let i = 0; i < CORRECTION_LIMIT; i++) {
        if (!Decimal.lt(lo, cap)) return lo;
        const next = Decimal.add(lo, 1);
        if (!canAfford(next)) return lo;
        lo = next;
      }
    }
  }

  // Bracket `lo` (affordable) below `hi` (not), then halve on whole counts.
  if (hi == null) {
    // A curve that never outgrows the balance — a flat single payment — is
    // affordable at the cap itself, including an unbounded one.
    if (canAfford(cap)) return cap;
    if (Decimal.isFinite(cap)) {
      hi = cap;
    } else {
      let probe = Decimal.max(Decimal.add(Decimal.mul(lo, 2), 1), 1);
      for (let i = 0; i < SEARCH_LIMIT && hi == null; i++) {
        if (!canAfford(probe)) {
          hi = probe;
        } else {
          lo = probe;
          // Squaring reaches any magnitude in a few dozen steps, and the halving
          // below is geometric, so overshooting costs nothing.
          probe = Decimal.max(Decimal.add(Decimal.mul(probe, 2), 1), Decimal.pow(probe, 2));
        }
      }
      if (hi == null) return lo;
    }
  }
  for (let i = 0; i < SEARCH_LIMIT && Decimal.gt(Decimal.sub(hi, lo), 1); i++) {
    let mid: DecimalSource = Decimal.floor(bracketMidpoint(new Decimal(lo), new Decimal(hi)));
    if (Decimal.lte(mid, lo)) mid = Decimal.add(lo, 1);
    else if (Decimal.gte(mid, hi)) mid = Decimal.sub(hi, 1);
    // Past 2^53 a whole count has no neighbour to step to.
    if (Decimal.lte(mid, lo) || Decimal.gte(mid, hi)) break;
    if (canAfford(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Calculate the total cost of purchasing a specific number of levels.
 *
 * Under `cumulativeCost` this is the **series** {@link Formula.sum} — what
 * buying the levels one at a time charges — not the continuous area
 * {@link Formula.cumulative} under the same curve. Companion to
 * {@link calculateMaxAffordable}, which counts levels through the same
 * operation so the count and the charge agree.
 *
 * @param formula - Cost formula — the price of the level at its variable
 * @param amountToBuy - Number of levels to price; a fractional amount takes every whole level below it
 * @param cumulativeCost - If true, the cost is `Σ f(a+i)` over the levels bought. If false, it is `f(a + amountToBuy)` alone. Default: `true`
 * @returns The total cost, or 0 with a report when the span has no price
 */
export function calculateCost(
  formula: GenericFormula,
  amountToBuy: DecimalSource,
  cumulativeCost = true,
): DecimalSource {
  const origValue = unref(formula.innermostVariable) ?? 0;
  const price = priceLevels(formula, origValue, amountToBuy, cumulativeCost);
  if (price != null) return price;
  console.error('Cannot calculate cumulative cost of a formula with no series and no integral');
  return 0;
}
