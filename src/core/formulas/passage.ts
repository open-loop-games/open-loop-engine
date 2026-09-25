/**
 * First-passage contract — the smallest input at which a curve *reaches* a target.
 *
 * `invert` answers the algebraic question ("what input maps to this output");
 * this answers the one a time axis actually asks ("when do I get there"). They
 * coincide on continuous invertible curves and diverge exactly where the target
 * isn't in the function's image — an interior `.floor()`, a `step` splice that
 * jumps at its breakpoint, a saturated `min`/`max`. There the algebra returns a
 * plausible number from inside a gap nothing evaluates into, and the search
 * returns the boundary a player actually crosses.
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
 * curve that falls to its target (a drain, a decay) the question is a downward
 * crossing; negate the chain, or use `timeUntilConditionFlip` when the quantity
 * is a live resource rather than a formula.
 *
 * Accuracy above layer 0 is floored by the representation, not the search: a
 * value is stored as its base-10 logarithm in a float64, so a passage computed
 * up there carries roughly `16 − log₁₀(log₁₀ x)` significant digits.
 *
 * @cluster formulas
 */

import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { bracketMidpoint, findCrossing } from './root-find';

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
   * grows its own bracket when the target sits above this. Defaults to `lower + 1`.
   */
  upper?: DecimalSource;
}

/**
 * Result of {@link Formula.firstPassage}.
 *
 * - `crossed` — the search found it. `value` is the smallest input reaching the target.
 * - `already-reached` — the target is already met at the domain floor, so no
 *   crossing was searched for. `value` is that floor. A legitimate answer ("you
 *   already have it"), distinguished from `crossed` because callers driving a
 *   countdown usually want to say so rather than render a zero.
 * - `no-crossing` — nothing in the searchable domain reaches the target.
 * - `not-monotone` — the search domain is not one on which a first passage is
 *   defined: the curve descends across it, or it isn't real-valued at the floor.
 *   Either way the remedy is the same — restrict the domain with `lower`, or
 *   negate a descending chain. Reported rather than returned, because this
 *   failure otherwise reads as a confident answer.
 */
export type Passage =
  | { value: Decimal; reason: 'crossed' | 'already-reached' }
  | { value: null; reason: 'no-crossing' | 'not-monotone' };

// === MONOTONICITY PROBE ===

/**
 * Offsets above the domain floor used to sniff for a descending curve. One step,
 * one thousand, one billion — a level axis is exhausted by the first, a time
 * axis in seconds by the second, and the third catches a curve that stays flat
 * across both before turning over.
 */
const DESCENT_PROBES = [1, 1e3, 1e9];

/**
 * Whether `f` falls below `f(lower)` anywhere in {@link DESCENT_PROBES}.
 *
 * Cannot fire for a non-decreasing `f`, which is the property that makes it safe
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
 * Wraps {@link findCrossing} with the two checks that separate a real answer
 * from a plausible one, each aimed at a specific way a non-monotone curve
 * produces a number instead of a report:
 *
 * - **At the floor.** `f(lower) ≥ target` normally means the target is already
 *   met. For a *descending* curve it means the opposite — the crossing is still
 *   ahead — and the unguarded answer is a confident `lower`. So the floor case
 *   probes forward before claiming it. A curve undefined at the floor (`recip`
 *   at 0) is refused outright, rather than left to whichever way an ordering
 *   comparison against `NaN` happens to answer.
 * - **Below the answer.** A crossing found at `x` is only the *first* one if
 *   nothing below `x` already reached the target. One interior sample tests
 *   exactly the promise the name makes, and cannot fire on a monotone curve.
 *
 * @internal — the public surface is `Formula.firstPassage`.
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

  const crossing = findCrossing(f, target, { lower, upper: options.upper });
  if (crossing === null) return { value: null, reason: 'no-crossing' };

  const probe = bracketMidpoint(lower, crossing);
  if (Decimal.gt(probe, lower) && Decimal.lt(probe, crossing) && Decimal.gte(f(probe), target)) {
    return { value: null, reason: 'not-monotone' };
  }
  return { value: crossing, reason: 'crossed' };
}
