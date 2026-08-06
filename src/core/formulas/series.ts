/**
 * Series contract — the discrete sum of a formula over integer steps.
 *
 * A cost curve indexed by level is a **series**, not an integral. Buying `n`
 * levels from level `a` costs `Σ f(a+i)` for `i` in `[0, n)`, and that is a
 * different number from `∫ₐᵃ⁺ⁿ f` — for the canonical exponential curve they
 * differ by the factor `(s−1)/ln s`, which is 7.3% at `s = 1.15` and 44% at
 * `s = 2`. Neither is a rounding error and neither approximates the other.
 *
 * The two live side by side on {@link Formula}: {@link Formula.cumulative} is
 * the continuous one (the rate-function lineage's *cumulative*, the thing
 * `firstPassage` inverts), {@link Formula.sum} is this one. Callers indexing by
 * level want `sum`; callers integrating a rate over time want `cumulative`.
 *
 * **Exact where a closed form exists, reported where it doesn't.** Unlike
 * integration, summation has no general compositional rule — `Σ f(g(x))` does
 * not decompose from `Σ g`, so a substitution-style shortcut would be a
 * silently-wrong answer of exactly the kind this module exists to stop
 * returning. What does hold is linearity plus three base cases, and the op
 * table implements only those:
 *
 * - `Σ(f ± g) = Σf ± Σg`, `Σ(k·f) = k·Σf`, `Σ(f/k) = Σf/k` — exact identities
 * - a bare variable — {@link arithmeticSeries}
 * - `mᵛᵃʳ` — {@link geometricSeries}
 * - `varᵖ` at non-negative integer `p` — {@link powerSeries}
 *
 * Between them those cover `Formula.exponential`, `Formula.linear` and
 * `Formula.polynomial`, which is the cost-curve surface the engine ships.
 * Anything else reports `not-summable` and the caller decides what to do about
 * it — {@link calculateCost} sums a bounded span term by term and falls back to
 * an Euler–Maclaurin correction beyond it.
 */

import { Decimal, type DecimalSource } from '@/primitives/decimal';

// === CONTRACT ===

/**
 * Diagnosed result of {@link Formula.sum}.
 *
 * - `exact` — a closed form applied, or the span was summed term by term.
 * - `approximate` — no closed form; `value` is the continuous integral with
 *   Euler–Maclaurin boundary corrections applied. `error` is the relative size
 *   of the last correction term, which bounds the truncation from above in the
 *   smooth monotone regime cost curves live in — read it as "accurate to about
 *   this much", not as a proof.
 * - `not-summable` — no closed form and no usable fallback: the chain isn't
 *   integrable either, so there is nothing to correct.
 *
 * Shape follows {@link Inversion} in `./inversion` — a value plus a `reason`
 * discriminator, `value: null` on the arm with no answer. Same contract
 * question in a different operation, so it gets the same shape.
 */
export type Series =
  | { value: DecimalSource; reason: 'exact' }
  | { value: DecimalSource; reason: 'approximate'; error: number }
  | { value: null; reason: 'not-summable' };

/** The `not-summable` arm, which carries no payload and is returned from many places. */
export const NOT_SUMMABLE: Series = { value: null, reason: 'not-summable' };

/** Wrap an exact value. */
export function exactSeries(value: DecimalSource): Series {
  return { value, reason: 'exact' };
}

// === CLOSED FORMS ===

/**
 * `Σ (from + i)` for `i` in `[0, count)` — the bare variable's own series.
 *
 * `count·from + count(count−1)/2`. Exact for any real `from`.
 */
export function arithmeticSeries(from: DecimalSource, count: DecimalSource): DecimalSource {
  const pairs = Decimal.div(Decimal.mul(count, Decimal.sub(count, 1)), 2);
  return Decimal.add(Decimal.mul(count, from), pairs);
}

/**
 * `Σ base^(from + i)` for `i` in `[0, count)`.
 *
 * `base^from · (base^count − 1)/(base − 1)`, degenerating to `count · base^from`
 * at `base = 1` where that quotient is 0/0. Exact for any real `from`.
 */
export function geometricSeries(
  base: DecimalSource,
  from: DecimalSource,
  count: DecimalSource,
): DecimalSource {
  const first = Decimal.pow(base, from);
  if (Decimal.eq(base, 1)) return Decimal.mul(count, first);
  const ratio = Decimal.div(Decimal.sub(Decimal.pow(base, count), 1), Decimal.sub(base, 1));
  return Decimal.mul(first, ratio);
}

/**
 * `Σ (from + i)^power` for `i` in `[0, count)`, at non-negative integer `power`
 * and non-negative integer `from` — Faulhaber's formula, evaluated as the
 * difference of two prefix sums.
 *
 * Returns `null` where no closed form applies: a negative or fractional
 * exponent (the sum is a Hurwitz zeta, not elementary), a fractional offset
 * (Faulhaber indexes integers), or an exponent past {@link MAX_POWER}.
 */
export function powerSeries(
  power: DecimalSource,
  from: DecimalSource,
  count: DecimalSource,
): DecimalSource | null {
  if (!isNonNegativeInteger(power) || !isNonNegativeInteger(from) || !isNonNegativeInteger(count)) {
    return null;
  }
  const p = new Decimal(power).toNumber();
  if (p > MAX_POWER) return null;
  if (Decimal.lte(count, 0)) return Decimal.dZero;

  const last = Decimal.sub(Decimal.add(from, count), 1);
  if (Decimal.eq(from, 0)) {
    // `prefixPower` sums from 1, so the i=0 term is peeled off rather than
    // reached by a `prefixPower(-1)` that the recurrence does not define.
    // It vanishes for p ≥ 1 and is 0⁰ = 1 for p = 0.
    return Decimal.add(Decimal.pow(0, p), prefixPower(p, last));
  }
  return Decimal.sub(prefixPower(p, last), prefixPower(p, Decimal.sub(from, 1)));
}

/**
 * Highest exponent {@link powerSeries} will expand. Faulhaber's coefficients
 * grow without bound and the recurrence below is O(p²); cost curves in the
 * corpus top out around cubic, so this is generous rather than restrictive.
 */
const MAX_POWER = 12;

function isNonNegativeInteger(value: DecimalSource): boolean {
  return Decimal.gte(value, 0) && Decimal.eq(Decimal.floor(value), value);
}

/**
 * `Σ_{k=1}^{n} k^p` via the standard recurrence
 * `(p+1)·Sₚ(n) = (n+1)^(p+1) − 1 − Σ_{j<p} C(p+1, j)·S_j(n)`.
 *
 * Exact in exact arithmetic and stable here: every term on the right is the
 * same order as the result, so the alternating subtraction doesn't cancel.
 *
 * @internal
 */
function prefixPower(p: number, n: DecimalSource): DecimalSource {
  if (Decimal.lt(n, 1)) return Decimal.dZero;
  const sums: DecimalSource[] = [n]; // S₀(n) = n
  for (let q = 1; q <= p; q++) {
    let acc = Decimal.sub(integerPow(Decimal.add(n, 1), q + 1), 1);
    for (let j = 0; j < q; j++) {
      acc = Decimal.sub(acc, Decimal.mul(binomial(q + 1, j), sums[j]));
    }
    sums.push(Decimal.div(acc, q + 1));
  }
  return sums[p];
}

/**
 * `base^exponent` at small non-negative integer `exponent`, by repeated
 * multiplication.
 *
 * `Decimal.pow` routes through `exp(y·ln x)` even for integer arguments, so it
 * misses by an ulp where the true answer is an integer — `pow(3, 3)` is
 * `27.000000000000004`. Faulhaber's alternating sum then inherits that, and one
 * ulp is enough to make a cost curve report `50.00000000000001` for a level
 * that costs exactly 50, which refuses a purchase the player can afford.
 * Integer multiplication in float64 is exact below 2^53, so the naive loop is
 * the accurate one here. Exponents are bounded by {@link MAX_POWER}.
 *
 * @internal
 */
function integerPow(base: DecimalSource, exponent: number): DecimalSource {
  let result: DecimalSource = Decimal.dOne;
  for (let i = 0; i < exponent; i++) result = Decimal.mul(result, base);
  return result;
}

/** @internal */
function binomial(n: number, k: number): number {
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}
