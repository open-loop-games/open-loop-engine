/**
 * Inversion contract — the diagnosed result of running a formula backward.
 *
 * `Formula.invert` answers with a bare `DecimalSource`. That is the algebraic
 * pre-image, and it is the shape the op table composes with recursively, so it
 * stays. What it cannot say is whether the answer is *usable*, and there are
 * three ways it isn't:
 *
 * - the chain has no inverse at all — `sign`, `abs`, a multi-variable chain;
 * - no pre-image was found for this target, by closed form or by search — a
 *   `tetrate` height at which the base can't influence the result, an integral
 *   inverse whose target sits outside the searchable range;
 * - the target lies **outside the function's image**, so the pre-image the
 *   algebra hands back doesn't map forward onto it. An interior `.floor()`
 *   asked for a fractional level, a `step`/`if` splice whose modifier jumps at
 *   the breakpoint, a saturated `min`/`max`/`clamp` — one failure, not three.
 *
 * The third is the one that drove this contract. It is a property of *(chain,
 * target)*, not of the chain, which is why no chain-only boolean —
 * `isInvertible()` included — can answer it: the same skill curve is sound for
 * integer levels and unsound for 3.5. {@link Formula.tryInvert} settles it the
 * only way available, by evaluating the candidate forward and checking it lands
 * on the target.
 *
 * Shape follows `TransitionDistance` in `@/core/transitions` — a value plus a
 * `reason` discriminator, `value: null` on the arms with no answer. Same
 * question in a different coordinate ("when does X happen" against "what input
 * gives this output"), so it gets the same shape rather than a new one.
 */

import { Decimal, type DecimalSource } from '@/primitives/decimal';

// === CONTRACT ===

/**
 * Why an inversion has no usable answer. Reported from deep inside the op
 * table, where the specific cause is known, and surfaced on {@link Inversion}.
 */
export type InversionFailureReason =
  /**
   * No inverse exists for this chain — a non-invertible op, or no single
   * variable to solve for. Structural, so `isInvertible()` predicts it without
   * needing a target.
   */
  | 'not-invertible'
  /**
   * The chain has an inverse path, but no pre-image was found for *this* target
   * — no closed form applies and the numeric search couldn't bracket it either.
   * Target-dependent, so `isInvertible()` can be optimistic here: `tetrate` at
   * height 0 binds an inverse and is still constant in its base.
   */
  | 'no-solution';

/**
 * Diagnosed result of {@link Formula.tryInvert} / {@link Formula.tryInvertIntegral}.
 *
 * - `exact` — the pre-image evaluates back onto the target. Use `value`.
 * - `outside-image` — `value` is the correct algebraic pre-image but the target
 *   isn't in the function's image, so it maps to `evaluatesTo` instead. Callers
 *   wanting "smallest input that reaches the target" want a first-passage
 *   search, not this; callers wanting the breakpoint below the target (progress
 *   bars over a `.floor()`ed curve) can use `value` as-is.
 * - `not-invertible` / `no-solution` — no answer at all.
 */
export type Inversion =
  | { value: DecimalSource; reason: 'exact' }
  | { value: DecimalSource; reason: 'outside-image'; evaluatesTo: DecimalSource }
  | { value: null; reason: InversionFailureReason };

// === FAILURE REPORTING ===

/**
 * Active capture slot. Non-null only inside {@link captureInversionFailures},
 * i.e. for the duration of one `tryInvert` call.
 */
let capture: InversionFailureReason[] | null = null;

/**
 * Report that an inversion has no answer.
 *
 * The engine's convention is to report unsoundness by logging rather than
 * throwing, which keeps a mis-composed formula from taking down a running game.
 * That leaves the report observable only on the console, so this routes it to
 * an active capture when one is installed — which is what lets `tryInvert`
 * name the cause instead of inferring it. Uncaptured, it logs exactly as
 * before.
 *
 * @internal
 */
export function reportInversionFailure(reason: InversionFailureReason, message: string): void {
  if (capture !== null) {
    capture.push(reason);
    return;
  }
  console.error(message);
}

/**
 * Run `body` with inversion failures captured rather than logged, returning the
 * first reason reported (the deepest, hence most specific, cause).
 *
 * @internal
 */
export function captureInversionFailures<T>(body: () => T): {
  value: T;
  failure: InversionFailureReason | null;
} {
  const outer = capture;
  const own: InversionFailureReason[] = [];
  capture = own;
  try {
    return { value: body(), failure: own[0] ?? null };
  } finally {
    capture = outer;
  }
}

// === IMAGE CHECK ===

/** Default relative tolerance for the image check at layer 0. */
const BASE_TOLERANCE = 1e-10;

/** float64 machine epsilon — the ulp of a stored exponent above layer 0. */
const EPSILON = 2.220446049250313e-16;

/** Above this, break_eternity stores the logarithm, so value-space ratios stop meaning anything. */
const VALUE_SPACE_CEILING = '1e300';

/**
 * Relative tolerance the image check can honestly demand at `target`'s magnitude.
 *
 * Past layer 0 a value is stored as its base-10 logarithm in a float64, so the
 * exponent itself carries ulp error, and exponentiating back turns that
 * straight into relative error in value space. At 1e1000000 the floor is ~2.7e-10
 * — measured, and not improvable. Demanding {@link BASE_TOLERANCE} up there
 * would report "outside the image" for arithmetic that is as exact as the
 * representation allows.
 *
 * Consumer-facing consequence: an inversion at layer 1 carries roughly
 * `16 − log₁₀(log₁₀ x)` significant digits, not 16.
 */
export function inversionTolerance(target: DecimalSource): number {
  const exponent = Math.abs(Decimal.log10(Decimal.abs(target)).toNumber());
  if (!Number.isFinite(exponent) || exponent <= 308) return BASE_TOLERANCE;
  return Math.max(BASE_TOLERANCE, EPSILON * exponent * Math.LN10 * 4);
}

/**
 * Whether `achieved` counts as landing on `target`, graded in the coordinate
 * the values are actually stored in: relative in value space below
 * {@link VALUE_SPACE_CEILING}, absolute in log₁₀ above it.
 *
 * @internal
 */
export function landsOnTarget(
  achieved: DecimalSource,
  target: DecimalSource,
  tolerance: number,
): boolean {
  if (Decimal.eq(achieved, target)) return true;
  if (Decimal.gt(Decimal.abs(target), VALUE_SPACE_CEILING)) {
    if (Decimal.sign(achieved) !== Decimal.sign(target)) return false;
    const drift = Decimal.sub(
      Decimal.log10(Decimal.abs(achieved)),
      Decimal.log10(Decimal.abs(target)),
    );
    return Decimal.lt(Decimal.abs(drift), tolerance);
  }
  if (Decimal.eq(target, 0)) return Decimal.lt(Decimal.abs(achieved), tolerance);
  return Decimal.lt(Decimal.abs(Decimal.div(Decimal.sub(achieved, target), target)), tolerance);
}
