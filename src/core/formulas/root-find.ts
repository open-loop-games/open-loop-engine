/**
 * Root finding — the numeric fallback for inversions with no closed form.
 *
 * One monotone-crossing search, shared by everything in the formula layer that
 * has to answer "smallest x where f(x) reaches target" without an algebraic
 * pre-image — an integral inverse whose shape has no closed form, an op
 * inverted in an argument that has none (`tetrate`'s base), or a first-passage
 * query, which asks the question of the forward function directly.
 *
 * Two properties it exists to get right once instead of per-caller:
 *
 * - **The search coordinate follows the bracket.** A bracket spanning
 *   magnitudes is halved geometrically, not arithmetically: resolving an answer
 *   near 1e10 inside `0 … 1e1000` takes ~3300 arithmetic halvings and ~40
 *   geometric ones. Once the bracket narrows past a factor of two the search
 *   switches to arithmetic, so it still converges exactly on small values.
 * - **No relative-tolerance early-out.** At tetration scale `f` has enormous
 *   slope, so a value-space "close enough" can fire while `x` is still far from
 *   the root in input space. Termination is by bracket collapse — `x` values
 *   that no longer differ — which is a statement about the answer rather than
 *   about `f`.
 *
 * @cluster formulas
 */

import { Decimal, type DecimalSource } from '@/primitives/decimal';

/** Tuning for {@link findCrossing}. Every field has a defensible default; pass one only when the shape of the problem gives a better starting point. */
export interface FindCrossingOptions {
  /** Bottom of the search domain, and the answer when `target` is already reached there. Defaults to 0. */
  lower?: DecimalSource;
  /**
   * First guess for the top of the bracket — ideally a closed form for a
   * simplified version of the same problem, so the expansion loop rarely runs.
   * Defaults to `lower + 1`, which is also what a non-finite guess falls back to.
   */
  upper?: DecimalSource;
  /** Expansions allowed while growing `upper` until it brackets `target`, each at least squaring it. Defaults to 32. */
  expansions?: number;
  /** Cap on halvings once bracketed. Defaults to 120 — the search normally stops earlier, on bracket collapse. */
  iterations?: number;
}

/** Default bracket expansions — 32 squarings reach past any magnitude a game stores. */
const DEFAULT_EXPANSIONS = 32;

/**
 * Default halving cap. A bracket spanning many magnitudes spends ~40 halvings
 * narrowing in log space before the search switches to arithmetic and another
 * ~35 converging there, so the cap sits well above both. Brackets that start
 * tight — the common case, where the caller passes a closed-form `upper` — stop
 * far earlier on collapse.
 */
const DEFAULT_ITERATIONS = 120;

/**
 * Midpoint of `[lo, hi]`, chosen in whichever coordinate the bracket is wide in.
 *
 * `max(lo, 1)` folds the whole `[0, 1]` region into one geometric step, which
 * keeps the geometric mean strictly inside the bracket even when `lo` is 0 or
 * negative.
 *
 * @internal — also used by the first-passage probe, which wants an interior
 * sample in the same coordinate the search itself would have picked.
 */
export function bracketMidpoint(lo: Decimal, hi: Decimal): Decimal {
  const geometricFloor = Decimal.max(lo, 1);
  if (Decimal.gt(hi, 1) && Decimal.gte(Decimal.div(hi, geometricFloor), 2)) {
    return new Decimal(Decimal.sqrt(Decimal.mul(geometricFloor, hi)));
  }
  return new Decimal(Decimal.div(Decimal.add(lo, hi), 2));
}

/**
 * Smallest `x ≥ lower` where `f(x)` reaches `target`, found by bisection.
 *
 * `f` must be monotone non-decreasing over the search domain — the whole method
 * rests on it, and a non-monotone `f` gets *an* answer rather than a wrong-answer
 * report, because bisection cannot detect the violation. Callers own that
 * precondition (restricting to a monotone region, usually by choosing `lower`).
 *
 * @param f - The function to cross. Monotone non-decreasing on `[lower, ∞)`.
 * @param target - The value to reach.
 * @param options - Bracket and iteration tuning. See {@link FindCrossingOptions}.
 * @returns The crossing point — always an `x` with `f(x) ≥ target`, so a stepped
 *   curve answers on the far side of the step rather than the last input before
 *   it. `lower` when `target` is already reached there, or `null` when the target
 *   could not be bracketed — the one case where the returned number would be
 *   meaningless, so it isn't returned.
 *
 * @example
 * ```ts
 * // Solve x³/3 + 2x = 100 for x.
 * const x = findCrossing((v) => Decimal.add(Decimal.pow(v, 3).div(3), Decimal.mul(2, v)), 100);
 * ```
 */
export function findCrossing(
  f: (x: Decimal) => DecimalSource,
  target: DecimalSource,
  options: FindCrossingOptions = {},
): Decimal | null {
  const {
    lower = 0,
    expansions = DEFAULT_EXPANSIONS,
    iterations = DEFAULT_ITERATIONS,
    upper = Decimal.add(lower, 1),
  } = options;

  let lo = new Decimal(lower);
  let hi = new Decimal(upper);

  // Already reached at the domain floor: `lower` *is* the first passage, and
  // bisecting below it would answer outside the domain the caller declared.
  if (Decimal.gte(f(lo), target)) return lo;

  // A non-finite guess is no guess: callers derive `upper` from a closed form
  // that can divide by a zero slope, and neither Infinity nor NaN is ever
  // `lte` the floor, so it would otherwise be kept and never bracket.
  if (!Decimal.isFinite(hi) || Decimal.lte(hi, lo)) hi = new Decimal(Decimal.add(lo, 1));
  // Every `hi` is tested, including the last one the loop produces — and the
  // test is "did we reach it", not "are we still short". A non-comparable `f`
  // (NaN past some magnitude) therefore falls through to `null` rather than
  // leaving an unbracketed range to bisect and answer from.
  let bracketed = Decimal.gte(f(hi), target);
  for (let i = 0; !bracketed && i < expansions; i++) {
    // Expansion grows in log space too, for the same reason the bisection does:
    // doubling adds ~0.3 to the exponent per step, so bracketing a target whose
    // answer sits at 1e10 takes 33 steps and one at 1e300 takes a thousand.
    // Squaring reaches any representable magnitude in a few dozen, and
    // overshooting is free because the bisection is geometric.
    hi = new Decimal(
      Decimal.max(Decimal.add(Decimal.mul(hi, 2), 1), Decimal.pow(Decimal.abs(hi), 2)),
    );
    bracketed = Decimal.gte(f(hi), target);
  }
  if (!bracketed) return null;

  // Loop invariant: `f(lo) < target ≤ f(hi)`. Both bounds are returnable
  // numbers, and `hi` is the side that satisfies the contract — so the answer is
  // always `hi`, never the collapse midpoint. On a continuous curve the two
  // differ by an ulp and the distinction is cosmetic; on a *stepped* one it is
  // the whole answer, because `lo` is the last input before the step and
  // reports a value the caller was asking to get past.
  for (let i = 0; i < iterations; i++) {
    const mid = bracketMidpoint(lo, hi);
    // Bracket collapse — `mid` is no longer strictly inside, so further halving
    // cannot move the answer and the loop would spin.
    if (Decimal.eq(mid, lo) || Decimal.eq(mid, hi)) return hi;
    if (Decimal.lt(f(mid), target)) lo = mid;
    else hi = mid;
  }
  return hi;
}
