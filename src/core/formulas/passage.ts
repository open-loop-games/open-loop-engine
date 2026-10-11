/**
 * First-passage contract — the smallest input at which a curve *reaches* a target.
 *
 * `invert` answers the algebraic question ("what input maps to this output");
 * this answers the one a time axis actually asks ("when do I get there"). They
 * coincide on continuous invertible curves and diverge exactly where the target
 * isn't in the function's image — an interior `.floor()`, a `step` splice that
 * jumps at its breakpoint, a saturated `min`/`max`. There the algebra returns a
 * plausible number from inside a gap nothing evaluates into, and the search
 * returns the boundary a player actually reaches.
 *
 * The search never touches the op table — it only calls `evaluate` — which is
 * both why interior rounding cannot fool it and why it answers for chains that
 * have no inverse at all (`isInvertible() === false`: `sign`, `abs`, and the
 * forward-only `ceil`/`floor`/`min`/`max` compositions).
 *
 * **Upward only, and monotonicity is a precondition.** `f` must be non-decreasing
 * over the search domain. Bisection cannot detect a violation, so instead of
 * pushing the whole burden to the caller this module probes the two places a
 * violation produces a *plausible* answer — see {@link findFirstPassage}. For a
 * curve that falls to its target (a decay, an amount being spent), the question
 * is a downward first passage. Negate the chain, or use `timeUntilGateFlip` over
 * a `resource-gte` Gate when the quantity is a live resource, not a formula.
 *
 * Above break_eternity layer 0, the representation floor limits accuracy, not
 * the search. A value is stored as its base-10 logarithm in a float64, so a
 * passage computed up there has roughly `16 − log₁₀(log₁₀ x)` significant digits.
 *
 * @cluster formulas
 */

import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { bracketMidpoint, solveMonotone } from './root-find';

// === CONTRACT ===

/**
 * Bracket tuning for a first-passage search. Both fields are about the *domain*
 * — the search's own convergence is not a caller concern.
 */
export interface FirstPassageOptions {
  /** Bottom of the search domain — where the axis starts. Defaults to 0, which is right for level and time axes. */
  lower?: DecimalSource;
  /**
   * First guess for the top of the bracket, ideally a closed form for a
   * simplified version of the same problem. Purely an optimization: the search
   * grows its own bracket when the target is above this. Defaults to `lower + 1`.
   */
  upper?: DecimalSource;
}

/**
 * Result of {@link Formula.firstPassage}.
 *
 * - `reached` — the search found it. `value` is the smallest input reaching the target.
 * - `already-reached` — the target is already met at the lower bound, so no
 *   search ran. `value` is that lower bound. A legitimate answer ("you already
 *   have it"), distinguished from `reached` because callers driving a countdown
 *   usually want to say so rather than show a zero.
 * - `not-reached` — nothing in the searchable domain reaches the target.
 * - `not-monotone` — a first passage is not defined on the search domain. The
 *   curve descends across it, or it isn't real-valued at the lower bound.
 *   Either way the remedy is the same — restrict the domain with `lower`, or
 *   negate a descending chain. Reported rather than returned, because this
 *   failure otherwise looks like a confident answer.
 */
export type Passage =
  | { value: Decimal; reason: 'reached' | 'already-reached' }
  | { value: null; reason: 'not-reached' | 'not-monotone' };

// === MONOTONICITY PROBE ===

/**
 * Offsets above the lower bound used to test for a descending curve. One step,
 * one thousand, one billion — a level axis is exhausted by the first, a time
 * axis in seconds by the second, and the third catches a curve that stays flat
 * across both before turning over.
 */
const DESCENT_PROBES = [1, 1e3, 1e9];

/**
 * Whether `f` falls below `f(lower)` anywhere in {@link DESCENT_PROBES}.
 *
 * Cannot hold for a non-decreasing `f`, which is the property that makes it safe
 * to run unconditionally: a passing precondition is never reported as a failure.
 * A non-comparable `f` (NaN past some magnitude) fails the `lt` and is likewise
 * not reported.
 */
function descends(f: (x: Decimal) => DecimalSource, lower: Decimal, atFloor: Decimal): boolean {
  return DESCENT_PROBES.some((offset) => Decimal.lt(f(new Decimal(lower.add(offset))), atFloor));
}

// === SEARCH ===

/**
 * Smallest `x ≥ lower` where `f(x)` reaches `target`, graded.
 *
 * Wraps {@link solveMonotone} with the two checks that separate a real answer
 * from a plausible one, each aimed at a specific way a non-monotone curve
 * produces a number instead of a report:
 *
 * - **At the lower bound.** `f(lower) ≥ target` normally means the target is
 *   already met. For a *descending* curve it means the opposite: the first
 *   passage is still ahead, and the unguarded answer is a confident `lower`. So
 *   the lower-bound case probes forward before claiming it. A curve undefined at
 *   the lower bound (`recip` at 0) is refused outright. It is not left to
 *   whichever way an ordering comparison against `NaN` happens to answer.
 * - **Below the answer.** An answer found at `x` is the *first* passage only if
 *   nothing below `x` already reached the target. One interior sample tests
 *   exactly the promise the name makes, and cannot hold on a monotone curve.
 *
 * @internal — the public API surface is `Formula.firstPassage`.
 */
export function findFirstPassage(
  f: (x: Decimal) => DecimalSource,
  target: DecimalSource,
  options: FirstPassageOptions = {},
): Passage {
  const lower = new Decimal(options.lower ?? 0);

  const atFloor = new Decimal(f(lower));
  if (atFloor.isNan()) return { value: null, reason: 'not-monotone' };
  if (Decimal.gte(atFloor, target)) {
    if (descends(f, lower, atFloor)) return { value: null, reason: 'not-monotone' };
    return { value: lower, reason: 'already-reached' };
  }

  const crossing = solveMonotone(f, target, { lower, upper: options.upper });
  if (crossing === null) return { value: null, reason: 'not-reached' };

  const probe = bracketMidpoint(lower, crossing);
  if (Decimal.gt(probe, lower) && Decimal.lt(probe, crossing) && Decimal.gte(f(probe), target)) {
    return { value: null, reason: 'not-monotone' };
  }
  return { value: crossing, reason: 'reached' };
}
