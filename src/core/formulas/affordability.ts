/**
 * Affordability — how many levels of a cost curve a resource can purchase, and
 * what purchasing them costs
 *
 * The "purchase max" question for repeatables and conversions, asked of any
 * {@link Formula} cost curve:
 * - {@link calculateMaxAffordable} counts the affordable levels, reactively
 * - {@link calculateCost} gives the cost of a given number of levels
 *
 * Both cost levels through the same operation: the series `Formula.sum` under
 * `sumLevels`, a single `evaluate` otherwise. So the count and the cost agree.
 * The formula algebra itself is in `formulas.ts`.
 */

import type { Resource } from '../resource';
import { Decimal } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import { toMaybeRef, type Computable } from '../computed';
import { profile, profileStart, profileEnd } from '../profiler';
import { computed, unref } from 'vue';
import { captureInversionFailures, representationFloor } from './inversion';
import { bracketMidpoint } from './root-find';
import type { GenericFormula } from './types';

/**
 * Relative slack when comparing a closed-form cost against an amount at
 * break_eternity layer 0.
 *
 * Matches the tolerance `createCostRequirement` applies to the ratio of amount
 * to a flat cost. Tight enough not to grant a level a player is meaningfully
 * short of (a 49.99 amount never affords a 50 cost). Wide enough to absorb the
 * ulp a closed form has where summing the same levels one at a time would be
 * exact.
 */
const AFFORDABILITY_TOLERANCE = 1e-12;

/**
 * Whether `price` is affordable out of `balance`.
 *
 * Non-finite costs are unaffordable rather than free. A cost curve that
 * evaluates to NaN must afford nothing. `Decimal`'s ordering comparisons
 * answer false against NaN in *both* directions, so a bare `gt` would read
 * "not more than the amount" and hand out levels without limit.
 *
 * The slack is relative to the cost, compared as the ratio `price / balance`.
 * Above break_eternity layer 0 it widens only to the ulp of the stored exponent.
 * `Decimal`'s own tolerance comparisons apply their tolerance to that stored
 * exponent, which makes it an absolute slack in orders of magnitude.
 */
function payable(price: DecimalSource, balance: DecimalSource): boolean {
  if (!Decimal.isFinite(price)) return false;
  if (Decimal.lte(price, balance)) return true;
  if (!Decimal.gt(balance, 0)) return false;
  return Decimal.lte(Decimal.div(price, balance), 1 + payableSlack(price));
}

/** The relative slack {@link payable} grants a finite cost. */
function payableSlack(price: DecimalSource): number {
  return Math.max(AFFORDABILITY_TOLERANCE, representationFloor(price));
}

/**
 * An amount below which {@link payable} certainly refuses `price`, so a caller
 * can reject in one comparison before running the ratio test. Twice the slack
 * clears the division's rounding by orders of magnitude. A cost with no
 * positive bound — zero, negative or NaN — gets `-∞`, which never shortcuts.
 */
function clearMissBound(price: DecimalSource): DecimalSource {
  if (!Decimal.gt(price, 0)) return Decimal.dNegInf;
  if (!Decimal.isFinite(price)) return price;
  return Decimal.div(price, 1 + 2 * payableSlack(price));
}

/**
 * Count how many levels a resource can currently afford on a cost curve — the
 * "purchase max" for repeatables and conversions.
 *
 * Answers the discrete question: the largest `n` whose cost, in the operation
 * {@link calculateCost} uses, fits the amount. That is exactly the count
 * sequential single purchases would reach, so the count and the cost agree.
 * Any curve works, including one with no inverse or no antiderivative. Where an
 * inverse exists, it seeds the answer in one step and a short exact walk finds
 * it. Otherwise, or when the seed is far off, a bracketed search over whole
 * counts finds it. The search needs the cost to rise with the count. A summed
 * cost does whenever no level costs less than nothing, and a single payment
 * does when the curve is non-decreasing. On a curve that breaks that, the
 * answer is still a count the amount can pay for, possibly short of the
 * largest.
 *
 * @param formula - Cost formula — the cost of the level at its variable
 * @param resource - The resource paying for the levels
 * @param sumLevels - If true, affordability is measured against `Σ f(a+i)` over the levels purchased. If false, against `f(a + n)` alone. Default: `true`
 * @param maxBulkCount - The most the returned count may be, for a "purchase max" button; a fractional maximum counts the whole levels below it. Default: unbounded
 * @returns Reactive count of affordable levels, recomputed as the resource, the
 * cost curve, and both options change — including reactive values the curve
 * reads from inside a `Formula.step` / `Formula.if` closure
 */
export function calculateMaxAffordable(
  formula: GenericFormula,
  resource: Resource,
  sumLevels: Computable<boolean> = true,
  maxBulkCount: Computable<DecimalSource> = Decimal.dInf,
) {
  const computedSumLevels = toMaybeRef(sumLevels);
  const computedMaxBulkCount = toMaybeRef(maxBulkCount);

  // Change token for the cost curve. Recomputes — and so returns a *fresh*
  // object — whenever any reactive value the formula reads changes, which makes
  // identity comparison an exact "has the curve moved?" test.
  //
  // Running `evaluate` is what makes it exact, and nothing cheaper is. A
  // signature built by walking `formula.inputs` cannot see the state that
  // `Formula.step` and `Formula.if` hold in a closure (their `inputs` hold
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
  // with a handful of comparisons instead of a full invertAntiderivative +
  // evaluateAntiderivative. See `scenarioF` in scripts/formula-hotpath-bench.ts.
  //
  // Every field here is part of the key, and the fast path must test all of
  // them: the band was computed at one level, in one cost operation, under
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
    floorCost: DecimalSource; // total cost of purchasing `affordable` levels (resource must be >= this)
    ceilCost: DecimalSource; // total cost of purchasing `affordable + 1` levels (resource must be < this)
    ceilClear: DecimalSource; // clearMissBound(ceilCost): below it, the `ceilCost` test needs one `lt`
    token: { at: DecimalSource }; // curve identity the band was computed against
    sumLevels: boolean; // the cost operation the band was computed in
    maxBulk: DecimalSource; // the cap the band was clamped to
  } | null = null;

  return computed(() =>
    profile('formula.calculateMaxAffordable', () => {
      // Read first, on every path: this is the subscription to every reactive
      // input the curve reads, not just the key it is compared by.
      const token = curveToken.value;
      const maxBulkCount = unref(computedMaxBulkCount);
      const sumLevels = unref(computedSumLevels);
      const currentVariable = unref(formula.innermostVariable) ?? 0;

      if (Decimal.eq(maxBulkCount, 1)) {
        guard = null;
        // Cost the level being purchased, in the operation `pay` will use. That
        // is the question `priceOf(1)` answers on the general path, and the
        // reason `sumLevels` is read above rather than below. A summed purchase
        // of one sums to `evaluate(A)`, which is `token.at`. An unsummed one
        // pays `evaluate(A + 1)` for the level it reaches. Comparing against
        // `token.at` in both cases would grant a level the amount cannot cover,
        // and `pay` does not re-check: it subtracts and clamps at zero.
        const price = sumLevels ? token.at : formula.evaluate(Decimal.add(currentVariable, 1));
        return payable(price, resource.value) ? Decimal.dOne : Decimal.dZero;
      }

      // --- Threshold guard fast path ---
      // Band membership is tested with the same predicate the answer was
      // decided by (`payable` below), so the cached answer and a recomputation
      // cannot disagree at the boundary — a plain `gte`/`lt` pair here would
      // reject an ulp-wide sliver the recomputation accepts, and return
      // stale-by-one for resource values in it. `ceilClear` only skips the
      // ratio test where `payable` is certain to refuse, so the sliver near
      // `ceilCost` still goes to the predicate.
      if (
        guard !== null &&
        guard.token === token &&
        guard.sumLevels === sumLevels &&
        // `maxBulkCount` defaults to `dInf`, and `toMaybeRef` hands back the
        // same object each run, so identity settles the common case before the
        // comparison that has to reason about infinities.
        (guard.maxBulk === maxBulkCount || Decimal.eq(guard.maxBulk, maxBulkCount)) &&
        Decimal.eq(currentVariable, guard.variable) &&
        payable(guard.floorCost, resource.value) &&
        (Decimal.lt(resource.value, guard.ceilClear) || !payable(guard.ceilCost, resource.value))
      ) {
        return guard.affordable;
      }

      // --- Full recomputation ---
      // Counts are whole levels, so a fractional cap admits the levels below it.
      const cap = Decimal.floor(maxBulkCount);

      // The search's last accepted and last refused counts are the answer and the
      // one past it. So the guard update below reads their costs instead of
      // computing them again, as does a search that re-probes its last refusal.
      type Priced = { n: DecimalSource; price: DecimalSource };
      let lastAccepted: Priced | undefined;
      let lastRefused: Priced | undefined;
      /** Total cost of purchasing `n` levels. */
      const priceOf = (n: DecimalSource): DecimalSource => {
        if (lastAccepted && Decimal.eq(lastAccepted.n, n)) return lastAccepted.price;
        if (lastRefused && Decimal.eq(lastRefused.n, n)) return lastRefused.price;
        return priceLevels(formula, currentVariable, n, sumLevels) ?? Decimal.dInf;
      };

      /** Whether purchasing `n` levels is affordable out of the current amount. */
      const canAfford = (n: DecimalSource): boolean => {
        const price = priceOf(n);
        const ok = payable(price, resource.value);
        if (ok) lastAccepted = { n, price };
        else lastRefused = { n, price };
        return ok;
      };

      const seed = profile('formula.affordable.seed', () =>
        seedAffordable(formula, resource.value, currentVariable, sumLevels, cap),
      );
      const correctionStart = profileStart();
      const affordable = countAffordable(canAfford, cap, seed);
      profileEnd('formula.affordable.refine', correctionStart);

      // --- Update threshold guard ---
      // The band is [cost(n), cost(n+1)) in the same operation the answer was
      // computed in. Both bounds are discrete, as the cost is. A band with one
      // continuous bound would disagree with the cost, and an amount in that
      // gap would read a stale-by-one answer out of the cache.
      //
      // `capped` asks whether a next level exists to cost, so it tests
      // `affordable + 1` *passing* the cap, not reaching it. At exactly the cap
      // that level is still real. Giving the band an infinite `ceilCost`
      // instead of its cost would freeze the answer one short.
      const capped = Decimal.gt(Decimal.add(affordable, 1), cap);
      const ceilCost = capped ? Decimal.dInf : priceOf(Decimal.add(affordable, 1));
      guard = {
        variable: currentVariable,
        affordable,
        floorCost: priceOf(affordable),
        ceilCost,
        ceilClear: clearMissBound(ceilCost),
        token,
        sumLevels,
        maxBulk: maxBulkCount,
      };

      return affordable;
    }),
  );
}

/**
 * Total cost of `n` levels purchased from `from`, in the cost operation the
 * purchase pays, or `null` when a summed span has no cost. No levels cost
 * nothing, in either operation.
 */
function priceLevels(
  formula: GenericFormula,
  from: DecimalSource,
  n: DecimalSource,
  sumLevels: boolean,
): DecimalSource | null {
  if (Decimal.lte(n, 0)) return Decimal.dZero;
  if (!sumLevels) return formula.evaluate(Decimal.add(from, n));
  // One term is its own definition, and skips the closed form's pow and
  // division on the most common call. An undefined term has no sum.
  if (Decimal.lte(n, 1)) {
    const cost = formula.evaluate(from);
    return Decimal.isNaN(cost) ? null : cost;
  }
  return formula.sum(from, n).value;
}

/**
 * The continuous answer, as a whole count clamped to `[0, cap]`, or `null` when
 * the curve has no inverse to solve it with or the inverse has no answer here.
 */
function seedAffordable(
  formula: GenericFormula,
  balance: DecimalSource,
  currentVariable: DecimalSource,
  sumLevels: boolean,
  cap: DecimalSource,
): DecimalSource | null {
  // A seed is an accelerator, so an inverse that fails is a missing seed rather
  // than a report: the search answers without one.
  const { value: level, failure } = captureInversionFailures(() => {
    if (sumLevels) {
      if (!formula.isAntiderivativeInvertible()) return null;
      return formula.invertAntiderivative(Decimal.add(balance, formula.evaluateAntiderivative()));
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
 * the search. The seed solves the continuous equation, so it is within about a
 * level of the discrete answer. It is within half of one for every geometric
 * curve, since the two differ by the fixed factor ln(s)/(s−1). So the walk
 * takes a couple of steps. Past this bound the seed was not close, and
 * bisecting is cheaper.
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
 * it is never a count nobody costed: `pay` doesn't re-check it, it subtracts and
 * clamps at zero. So an uncosted count hands out free levels.
 *
 * @internal
 */
export function countAffordable(
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
    // A curve that never outgrows the amount — a flat single payment — is
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
 * Under `sumLevels` this is the **series** {@link Formula.sum}: what
 * purchasing the levels one at a time costs. It is not the continuous total
 * {@link Formula.cumulative} under the same curve. Companion to
 * {@link calculateMaxAffordable}, which counts levels through the same
 * operation, so the count and the cost agree.
 *
 * @param formula - Cost formula — the cost of the level at its variable
 * @param count - Number of levels to cost; a fractional count takes every whole level below it
 * @param sumLevels - If true, the cost is `Σ f(a+i)` over the levels purchased. If false, it is `f(a + count)` alone. Default: `true`
 * @returns The total cost, or 0 with a report when the span has no cost
 */
export function calculateCost(
  formula: GenericFormula,
  count: DecimalSource,
  sumLevels = true,
): DecimalSource {
  const origValue = unref(formula.innermostVariable) ?? 0;
  const price = priceLevels(formula, origValue, count, sumLevels);
  if (price != null) return price;
  console.error('Cannot sum the levels of a formula with no series and no antiderivative');
  return 0;
}
