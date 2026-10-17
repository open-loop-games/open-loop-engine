/**
 * Decimal — big-number arithmetic and formatting on break_eternity.js
 *
 * Provides the Decimal type and formatting functions for large and small
 * numbers. Large numbers are formatted by the active notation through
 * notationManager (from eternal_notations). Small numbers use the regular format.
 *
 * Arithmetic statics (add/sub/mul/div/min/max, and break_eternity's aliases of
 * them) are patched onto the imported break_eternity class with
 * typeof-dispatched fast paths. When both operands
 * are raw `number` and the result fits within IEEE 754 double precision, the
 * math runs in number-space. The result is then promoted to a fresh `Decimal`
 * via `new OrigDecimal(r)` before return. Otherwise the call falls through to
 * the original static. Promotion preserves the `Decimal` return contract, so
 * consumers can chain-call (`.clamp().toNumber()`, etc.) whether or not the
 * fast path is taken.
 *
 * Predicates (eq/gt/gte/lt/lte) stay boolean-returning — no promotion needed,
 * no chain form to preserve.
 *
 * Four prototype methods are additionally *corrected* rather than accelerated —
 * `gte`, `lte`, `max`, `min` — because break_eternity derives each from a strict
 * comparison in a way that only holds under trichotomy, and NaN breaks it. See
 * the ORDERING CORRECTIONS section below.
 *
 * The `"number"` conversion hint answers `toNumber()`, so a relational operator
 * between two Decimals compares magnitudes, not strings. See NUMBER CONVERSION.
 */

import OrigDecimal from 'break_eternity.js';
import { isDev } from './dev';
import { notationManager } from './notation-manager';

// Re-export under the engine's canonical names. The runtime value `Decimal`
// below is the same class that break_eternity default-exports; the `type`
// namespace points at the instance type so `const d: Decimal = new Decimal(…)`
// and `x instanceof Decimal` both read naturally.
// break_eternity's .d.ts says `export default class` over a CJS `module.exports`,
// so under `nodenext` a default import types as the module namespace; reading
// `default` off the namespace type names the class under every resolution.
type DecimalClass = typeof import('break_eternity.js') extends { default: infer C } ? C : never;
/** Instance type of break_eternity's `Decimal`, re-exported under the engine's canonical name. */
export type Decimal = InstanceType<DecimalClass>;
/** Anything {@link bn} accepts — a live `Decimal`, a `number`, or a numeric string. */
export type DecimalSource = Decimal | number | string;

// OVERFLOW_ABS caps below IEEE 754 double precision (2^53 ≈ 9e15). The static
// fast paths compute in number-space only when the result falls under this
// magnitude; larger magnitudes fall through to the original static.
const OVERFLOW_ABS = 1e15;

// Smallest normal float64. A product or quotient under it has underflowed to a
// subnormal or to 0 in number-space, where the Decimal answer is still exact.
const MIN_NORMAL = 2.2250738585072014e-308;

/**
 * Coerce a small-magnitude Decimal at break_eternity layer 0 back to native
 * `number`. Take a running sum (`acc = Decimal.add(acc, x)` in a loop). The
 * wrap-as-Decimal return preserves single-call chain form. But it promotes the
 * sum out of number-space after iter 0, so every later iteration misses the
 * typeof fast path. Call this at each reduce boundary, and between chained
 * Decimal ops in multi-step loop bodies. The running sum then stays
 * renormalized, and the fast path is taken on every iteration.
 *
 * Contract mirrors the fast-path promotion threshold — values the fast path
 * would have kept in number-space get coerced back here. Anything with
 * `layer > 0`, or `|mag| >= OVERFLOW_ABS`, passes through unchanged so XL
 * precision is preserved. Reduces honoring a `Decimal` return contract should
 * wrap once at the final return via {@link toFinalDecimal}, not inside the body.
 *
 * @internal
 */
export function renormIfLayer0(x: DecimalSource): DecimalSource {
  if (typeof x === 'number') return x;
  if (typeof x === 'string') return x;
  if (x.layer === 0 && Math.abs(x.mag) < OVERFLOW_ABS) {
    return x.sign * x.mag;
  }
  return x;
}

/**
 * Wrap a DecimalSource into a Decimal instance at a reduce or chain boundary,
 * skipping the clone when it's already a Decimal. Pair with
 * {@link renormIfLayer0} at reduce sites: renorm between steps so the fast path
 * is taken, `toFinalDecimal` once at the return so callers can chain instance
 * methods on the result. Honors the single-call Decimal return contract
 * at aggregation boundaries.
 *
 * @internal
 */
export function toFinalDecimal(x: DecimalSource): Decimal {
  return x instanceof OrigDecimal ? x : new OrigDecimal(x);
}

// === ORDERING CORRECTIONS ===

// break_eternity derives four ordering methods from a strict comparison, each in
// a form that silently assumes trichotomy — that exactly one of `<`, `=`, `>`
// holds. NaN satisfies none of them, so every derivation inverts:
//
//   gte(v) { return !this.lt(v); }              NaN >= 5  ->  true
//   lte(v) { return !this.gt(v); }              NaN <= 5  ->  true
//   max(v) { return this.lt(v) ? v : this; }    5.max(NaN) -> 5   (NaN swallowed)
//   min(v) { return this.gt(v) ? v : this; }    5.min(NaN) -> 5
//
// The consequence is a guard that reads "have we already arrived?" as `true`
// against an undefined value, and answers with the domain's lower bound — silent,
// plausible, and wrong. `recip(0)` is NaN rather than Infinity in this library,
// so an ordinary chain reaches it without doing anything exotic.
//
// `lt`, `gt`, and `eq` need no correction: the first two test `cmp` against an
// exact value (`=== -1` / `=== 1`) and `eq` compares sign/layer/mag with `===`,
// so all three are already false against NaN in either operand position.
//
// INVARIANT: `gte`/`lte` must be built from `gt`/`lt`/`eq`, never from `cmp`
// directly. `Decimal(5).cmp(NaN)` is `0` — cmp reports NaN as *equal* when it is
// the right-hand operand — so the tempting one-call form `cmp(v) >= 0`
// reintroduces exactly this bug. Do not "simplify" these back to `!lt` / `!gt`.
//
// A NaN guard is not a domain check, so don't mistake one for the other. Two
// thirds of the op table reports a domain error as NaN (`recip(0)`, `ln(0)`,
// `sqrt(-1)`, `asin(2)`, `∞−∞`, …), but a second class answers with a plausible
// finite number instead: `pow(0, -1)` is `0`, `0 × Infinity` is `Infinity`,
// `factorial(-1)` is `Infinity`, `slog(-1)` is -1.8643…. Nothing downstream can
// detect those, which is why the standing remedy is to work in a coordinate
// where the value is defined rather than to evaluate into a domain edge and
// inspect the result afterward.
//
// Patched on the prototype, not just the statics: many of the engine's ordering
// callsites use the instance form, and the statics delegate down here anyway.
// break_eternity's own internals (tetrate/slog/lambertw) route through these too
// and are covered by the suite.
OrigDecimal.prototype.gte = function gte(this: Decimal, value: DecimalSource): boolean {
  return this.gt(value) || this.eq(value);
};

OrigDecimal.prototype.lte = function lte(this: Decimal, value: DecimalSource): boolean {
  return this.lt(value) || this.eq(value);
};

// `max`/`min` propagate NaN in both operand positions, matching `Math.max`/`Math.min`.
// `clamp`, `clampMin`, and `clampMax` are defined in terms of these upstream, so
// all five become NaN-correct together.
OrigDecimal.prototype.max = function max(this: Decimal, value: DecimalSource): Decimal {
  const decimal = new OrigDecimal(value);
  if (this.isNan() || decimal.isNan()) return new OrigDecimal(OrigDecimal.dNaN);
  return this.lt(decimal) ? new OrigDecimal(decimal) : new OrigDecimal(this);
};

OrigDecimal.prototype.min = function min(this: Decimal, value: DecimalSource): Decimal {
  const decimal = new OrigDecimal(value);
  if (this.isNan() || decimal.isNan()) return new OrigDecimal(OrigDecimal.dNaN);
  return this.gt(decimal) ? new OrigDecimal(decimal) : new OrigDecimal(this);
};

// === NUMBER CONVERSION ===

// break_eternity's `valueOf()` returns `toString()`, so a relational operator
// between two Decimals compares strings: `D(9) < D(10)` is false. TypeScript
// admits that form, unlike Decimal-vs-number or arithmetic. The `"number"` hint
// (relational operators, unary `+`, `Number()`) answers `toNumber()` instead,
// which is also what `Number(d)` callsites expect. Other hints keep the string,
// so interpolation and `String(d)` are unchanged.
//
// Two Decimals past float64 range still compare wrong: both convert to Infinity
// (or both underflow to 0). The hint cannot tell `<` from `Number()`, so dev
// builds warn once on the first conversion that loses magnitude.
let warnedLossyConversion = false;

Object.defineProperty(OrigDecimal.prototype, Symbol.toPrimitive, {
  configurable: true,
  writable: true,
  value: function toPrimitive(this: Decimal, hint: string): number | string {
    if (hint !== 'number') return this.toString();
    const n = this.toNumber();
    if (!warnedLossyConversion && losesMagnitude(this, n)) {
      warnedLossyConversion = true;
      if (isDev()) {
        console.warn(
          `Decimal ${this.toString()} converted to the number ${n}, which loses its magnitude. ` +
            `A relational operator between two such Decimals gives a wrong answer. ` +
            `Compare with .lt()/.gt(), or call .toNumber() to accept the loss.`,
        );
      }
    }
    return n;
  },
});

/** Whether `n`, the float64 conversion of `d`, has lost `d`'s magnitude. */
function losesMagnitude(d: Decimal, n: number): boolean {
  if (n === Infinity || n === -Infinity) return d.isFinite();
  return n === 0 && d.sign !== 0;
}

const origAdd = OrigDecimal.add;
const origSub = OrigDecimal.sub;
const origMul = OrigDecimal.mul;
const origDiv = OrigDecimal.div;
const origMin = OrigDecimal.min;
const origMax = OrigDecimal.max;
const origEq = OrigDecimal.eq;
const origGt = OrigDecimal.gt;
const origGte = OrigDecimal.gte;
const origLt = OrigDecimal.lt;
const origLte = OrigDecimal.lte;

// Fast-path bodies return `Decimal` directly — the native-math result is
// promoted via `new OrigDecimal(r)` before return. No widened type, no cast:
// the signature matches the original static exactly. Function names mirror
// the originals — formula DSL stringification reads `.name`, so the patched
// statics must keep their original identifiers to avoid showing `fastAdd`
// in user-facing output.

OrigDecimal.add = function add(a: DecimalSource, b: DecimalSource): Decimal {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a + b;
    if (r < OVERFLOW_ABS && r > -OVERFLOW_ABS) return new OrigDecimal(r);
  }
  return origAdd(a, b);
};

OrigDecimal.sub = function sub(a: DecimalSource, b: DecimalSource): Decimal {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a - b;
    if (r < OVERFLOW_ABS && r > -OVERFLOW_ABS) return new OrigDecimal(r);
  }
  return origSub(a, b);
};

OrigDecimal.mul = function mul(a: DecimalSource, b: DecimalSource): Decimal {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a * b;
    const abs = Math.abs(r);
    if (abs < OVERFLOW_ABS && (abs >= MIN_NORMAL || a === 0 || b === 0)) {
      return new OrigDecimal(r);
    }
  }
  return origMul(a, b);
};

OrigDecimal.div = function div(a: DecimalSource, b: DecimalSource): Decimal {
  if (typeof a === 'number' && typeof b === 'number' && b !== 0) {
    const r = a / b;
    const abs = Math.abs(r);
    if (abs < OVERFLOW_ABS && (abs >= MIN_NORMAL || a === 0)) return new OrigDecimal(r);
  }
  return origDiv(a, b);
};

// The `a < b ? a : b` form has the same trichotomy assumption the prototype
// methods did — a NaN operand fails the test and the *other* operand is returned,
// swallowing it. Testing `a <= b` instead of `a < b` would not help; NaN must be
// checked for. Native `<` is correctly false against NaN, so `!(a >= b) && !(a < b)`
// would also work, but the explicit test says what it means.
OrigDecimal.min = function min(a: DecimalSource, b: DecimalSource): Decimal {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) || Number.isNaN(b)) return new OrigDecimal(OrigDecimal.dNaN);
    return new OrigDecimal(a < b ? a : b);
  }
  return origMin(a, b);
};

OrigDecimal.max = function max(a: DecimalSource, b: DecimalSource): Decimal {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) || Number.isNaN(b)) return new OrigDecimal(OrigDecimal.dNaN);
    return new OrigDecimal(a > b ? a : b);
  }
  return origMax(a, b);
};

OrigDecimal.eq = function eq(a: DecimalSource, b: DecimalSource): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return origEq(a, b);
};

OrigDecimal.gt = function gt(a: DecimalSource, b: DecimalSource): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a > b;
  return origGt(a, b);
};

OrigDecimal.gte = function gte(a: DecimalSource, b: DecimalSource): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a >= b;
  return origGte(a, b);
};

OrigDecimal.lt = function lt(a: DecimalSource, b: DecimalSource): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a < b;
  return origLt(a, b);
};

OrigDecimal.lte = function lte(a: DecimalSource, b: DecimalSource): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a <= b;
  return origLte(a, b);
};

// break_eternity's aliases call its instance methods, never the statics above,
// so each is rebound to the patched static it names. A named wrapper rather than
// the same function keeps the alias's `.name` for formula stringification.
OrigDecimal.plus = function plus(a: DecimalSource, b: DecimalSource): Decimal {
  return OrigDecimal.add(a, b);
};
OrigDecimal.subtract = function subtract(a: DecimalSource, b: DecimalSource): Decimal {
  return OrigDecimal.sub(a, b);
};
OrigDecimal.minus = function minus(a: DecimalSource, b: DecimalSource): Decimal {
  return OrigDecimal.sub(a, b);
};
OrigDecimal.multiply = function multiply(a: DecimalSource, b: DecimalSource): Decimal {
  return OrigDecimal.mul(a, b);
};
OrigDecimal.times = function times(a: DecimalSource, b: DecimalSource): Decimal {
  return OrigDecimal.mul(a, b);
};
OrigDecimal.divide = function divide(a: DecimalSource, b: DecimalSource): Decimal {
  return OrigDecimal.div(a, b);
};
OrigDecimal.equals = function equals(a: DecimalSource, b: DecimalSource): boolean {
  return OrigDecimal.eq(a, b);
};

export const Decimal: DecimalClass = OrigDecimal;
export default Decimal;

/** Create a Decimal from a number, string, or Decimal */
export function bn(x: DecimalSource): Decimal {
  return new OrigDecimal(x);
}

/**
 * Coerce a DecimalSource to a native number. Fast path for `number` inputs
 * (identity); slow path routes through a Decimal for strings and instances.
 * Use it at the JS-iteration / native-math boundary. There a value typed
 * `DecimalSource` (a resource's value, an options field) has no `.toNumber()`
 * to call until it is known to be a Decimal.
 */
export function toNumber(x: DecimalSource): number {
  return typeof x === 'number' ? x : new OrigDecimal(x).toNumber();
}

/** float64 machine epsilon — the ulp of a mantissa, and of a stored exponent above break_eternity layer 0. */
const EPSILON = 2.220446049250313e-16;

/**
 * Safety factor over the measured `root` error, for {@link rootUncertainty}.
 *
 * Measured against an mpmath oracle over 2490 `(radicand, degree)` pairs —
 * degrees 2 through 10, roots from 1 to 9e15, exact powers included — the worst
 * observed error was **0.898×** the modelled budget. The model bounds reality
 * with little to spare, so 2× is headroom rather than the whole allowance.
 */
const ROOT_ERROR_HEADROOM = 2;

/**
 * Uncertainty, in integers, below which a root sitting near an integer is taken
 * to *be* that integer rather than merely close to it.
 *
 * This is the perfect-power snap, and it decides only which of two off-by-one
 * errors to risk — never the grade, which is `ambiguous` on both sides of it.
 * A root this close to an integer is either a perfect power the log/exp
 * path fell a few ulps short of, or a coincidence with about a 1-in-500 chance;
 * below the ceiling the perfect power is overwhelmingly likelier and rounding
 * to it wins, above it the bar is wide enough that flooring wins.
 *
 * The measured reason for reporting rather than trusting either way: over 3234
 * oracle-checked radicands, snapping produced three answers off by one — all of
 * them radicands built as `base^degree` at break_eternity layer 1, where the construction's
 * own rounding puts the stored value a hair *below* the perfect power it was
 * meant to be. Nothing available at that break_eternity layer distinguishes
 * that from the perfect power itself.
 */
const SNAP_CEILING = 1e-3;

/**
 * The ceiling past which break_eternity cannot tell an integer from its
 * successor: `9e15`, its break_eternity layer-0 boundary. At or above it a Decimal stores its
 * base-10 logarithm and `m.add(1).eq(m)`, so "the largest integer `m` with
 * `m^degree ≤ x`" has no representable answer. `8999999999999999` is the last
 * integer that still works.
 *
 * Measured, not `Number.MAX_SAFE_INTEGER` — that is 9007199254740991, already
 * past this ceiling and already indistinguishable from its successor.
 */
const MAX_DISTINGUISHABLE_INTEGER = 9e15;

/**
 * How far, in integers, `value.root(degree)` can sit from the true root.
 *
 * The root is the coordinate to work in, and by a factor of `degree`. Both
 * `root` and `pow` route through log/exp, so both have the ulp error of a stored
 * logarithm — but `pow` *multiplies* the exponent by `degree` while `root`
 * divides it, so at 1e27 the raw square root is accurate to ±0.2 integers while
 * a `m² ≤ x` comparison is only good to ±0.44. Comparing powers is the less
 * precise instrument at every magnitude, which is why the floor is settled here
 * and never by raising a candidate back.
 *
 * The `max(…, 1)` floor covers break_eternity layer 0, where the radicand is stored directly
 * and the error is the ordinary ulp of the root's own mantissa.
 *
 * Deliberately *not* `inversionTolerance` from `core/formulas`, and not only
 * because `primitives/` is below `core/`: that function floors at 1e-10
 * relative, which at 1e28 is 1e18 absolute against a one-integer step of 2e14 —
 * four orders too loose to floor anything. The shape transfers (a floor plus a
 * magnitude term); the constant does not.
 */
function rootUncertainty(value: Decimal, root: Decimal, degree: number): Decimal | null {
  const magnitude = Math.abs(value.log10().toNumber());
  if (!Number.isFinite(magnitude)) return null;
  const relative = Math.max(1, (Math.LN10 * magnitude) / degree);
  return root.mul(ROOT_ERROR_HEADROOM * EPSILON * relative);
}

/**
 * The floored root of a radicand at break_eternity layer 0, settled in exact integer arithmetic.
 *
 * Below {@link MAX_DISTINGUISHABLE_INTEGER} a Decimal *is* an exact integer, so
 * the question has an exact answer and no float reasoning is needed to reach
 * it: flooring the radicand loses nothing (`mᵈ ≤ x` and `mᵈ ≤ ⌊x⌋` agree when
 * `mᵈ` is an integer), and BigInt settles the comparisons outright. This is
 * what makes `∛8 = 2` a proof rather than a snap.
 *
 * `root` seeds the search and is within one integer of the answer, so the
 * corrections below run at most a step or two.
 */
function exactIntegerRoot(value: Decimal, root: Decimal, degree: number): Decimal {
  const radicand = BigInt(value.floor().toNumber());
  const power = BigInt(degree);
  let m = BigInt(Math.max(0, Math.floor(root.toNumber())));
  while (m > 0n && m ** power > radicand) m -= 1n;
  while ((m + 1n) ** power <= radicand) m += 1n;
  return new OrigDecimal(Number(m));
}

/**
 * Graded result of {@link tryIntegerRoot}.
 *
 * - `exact` — `value` is the true `⌊x^(1/degree)⌋`: `value^degree ≤ x <
 *   (value+1)^degree` holds in exact arithmetic.
 * - `ambiguous` — the representation cannot resolve an integer here, so `value`
 *   is the best estimate available rather than a verified floor. `value` is
 *   within `max(1, width)` of the true root, measured across 573 ambiguous
 *   results with no violation. So a caller can judge whether the imprecision
 *   matters at its scale. A width below 1 means "possibly off by one", while
 *   1e6 means the integer part contains no information at all.
 *
 * A radicand that is an exact perfect power still reports `ambiguous` once it
 * passes break_eternity layer 0. Past that point nothing distinguishes it from
 * a value a hair below it. The answer is usually right there; it just isn't
 * provable, and `exact` is reserved for what is.
 *
 * Shape follows `Inversion` in `@/core/formulas`: a value plus a `reason`
 * discriminant. It does not invent a second vocabulary for "the answer is
 * there, but you should know something about it".
 */
export type IntegerRoot =
  | { value: Decimal; reason: 'exact' }
  | { value: Decimal; reason: 'ambiguous'; width: Decimal };

/**
 * The floored integer `degree`-th root of `x`, **graded** — the same answer
 * {@link integerRoot} returns, plus whether the representation could actually
 * resolve it.
 *
 * Two things put an integer root out of reach, and both are checked here:
 *
 * - **The root outgrows the representation.** Above
 *   {@link MAX_DISTINGUISHABLE_INTEGER} a Decimal stores its logarithm, `m` and
 *   `m + 1` are the same number, and no implementation can distinguish them.
 * - **The root's own error bar reaches an integer boundary.** See
 *   {@link rootUncertainty}: the raw root has the ulp error of a stored logarithm,
 *   which grows with magnitude and shrinks with `degree`. Once the bar spans a
 *   boundary, which integer the root falls between is not determined by the
 *   representation. The bar reaches one integer wide once the root passes about
 *   1e11: a square root at 1e22, a cube root at 1e33, a fifth root only at
 *   1e55. Whether it actually *straddles* a boundary depends on where the root
 *   is between integers. So a radicand well clear of a perfect power stays
 *   exact past that point, and one sitting on top of one does not.
 *
 * Use this over {@link integerRoot} where being silently off by one matters:
 * the balance harness, tests, and dev-mode asserts on a game whose
 * accumulators run long. Gameplay payout paths generally want the plain form.
 *
 * @param x - the radicand; sources accepted, coerced once
 * @param degree - the root degree (a positive integer: 2, 3, …)
 * @returns the root and how far to trust it. See {@link IntegerRoot}.
 *
 * @example
 * const r = tryIntegerRoot(runTotal, 3);
 * if (r.reason === 'ambiguous') {
 *   console.warn(`fragment payout is ±${format(r.width)} at this scale`);
 * }
 */
export function tryIntegerRoot(x: DecimalSource, degree: number): IntegerRoot {
  const value = x instanceof OrigDecimal ? x : new OrigDecimal(x);
  if (value.lte(0)) return { value: new OrigDecimal(0), reason: 'exact' };

  const root = OrigDecimal.max(value.root(degree), 0);

  // Exact arithmetic where it is available, which is every radicand a game is
  // likely to reach. A non-integer degree has no BigInt exponent and falls
  // through to the float path rather than throwing.
  if (value.lt(MAX_DISTINGUISHABLE_INTEGER) && Number.isInteger(degree) && degree >= 1) {
    return { value: exactIntegerRoot(value, root, degree), reason: 'exact' };
  }

  const uncertainty = rootUncertainty(value, root, degree);
  if (uncertainty === null || root.gte(MAX_DISTINGUISHABLE_INTEGER)) {
    // Past the ceiling `m` and `m + 1` are the same Decimal, so there is no
    // floor to find. Reached independently of the interval test below, which
    // would also fire here — stated separately because it is a different limit.
    return { value: root.floor(), reason: 'ambiguous', width: uncertainty ?? root };
  }

  // The whole answer, in one comparison: if `root ± uncertainty` floors to the
  // same integer, no other integer is in play and that floor is the answer.
  // O(1) at every magnitude — the unbounded stepping this replaces ran once per
  // integer inside a tolerance that grew with `x`, and stopped terminating
  // past ~1e32.
  const low = root.sub(uncertainty).floor();
  const high = root.add(uncertainty).floor();
  if (low.eq(high)) return { value: low, reason: 'exact' };

  // An integer is inside the error bar, so the floor is not provable and the
  // grade says so. Which value to hand back is a separate question from the
  // grade: below SNAP_CEILING a perfect power is the likelier explanation and
  // rounding to it beats flooring away from it, above it the reverse.
  return {
    value: uncertainty.lt(SNAP_CEILING) ? root.round() : root.floor(),
    reason: 'ambiguous',
    width: uncertainty.mul(2),
  };
}

/**
 * The floored integer `degree`-th root of `x` — the largest integer `m` with
 * `mᵈᵉᵍʳᵉᵉ ≤ x`, returned as a Decimal. `integerRoot(x, 2)` is the integer
 * square root; `integerRoot(x, 3)` the integer cube root.
 *
 * Use this instead of `Decimal.floor(Decimal.root(x, n))`. break_eternity
 * computes both `root` and `pow` through log/exp, so each has float error
 * in both directions (`root(8, 3)` = 1.999…, `pow(3, 3)` = 27.000…4). A plain
 * floor of the root under-counts at perfect powers (∛8 → 1). A plain
 * `mⁿ ≤ x` comparison mis-floors *worse*, since `pow` amplifies the same error
 * by `degree` where `root` divides it. This works in the root's own coordinate
 * instead, floored against break_eternity's measured error at that magnitude.
 *
 * **Exact up to a degree-dependent ceiling**: roughly 1e22 for degree 2 and
 * 1e33 for degree 3, where the root passes 1e11. Above it the representation
 * stops resolving consecutive integers, and the result is the best estimate
 * rather than a verified floor.
 * {@link tryIntegerRoot} returns the same value plus which of the two you got;
 * use it when being silently off by one would matter. `x ≤ 0` returns 0.
 *
 * Canonical use is sublinear per-source prestige payouts,
 * `Σ integerRoot(total / scale, 3)`. Pooling before the root would let one
 * dominant source mask the others. See consumer-guide-recipes § Sublinear
 * per-source prestige payouts.
 *
 * @param x - the radicand; sources accepted, coerced once
 * @param degree - the root degree (a positive integer: 2, 3, …)
 * @returns the largest integer `m` with `m^degree ≤ x`, as a Decimal
 *
 * @example
 * integerRoot(2240, 3);  // ⌊∛2240⌋ = 13
 * integerRoot(8, 3);     // 2, not 1 — the perfect-cube case a raw floor drops
 */
export function integerRoot(x: DecimalSource, degree: number): Decimal {
  return tryIntegerRoot(x, degree).value;
}

const ZERO = new OrigDecimal(0);
const NEAR_ONE = new OrigDecimal(0.98);
const THOUSANDTH = new OrigDecimal(0.001);
const E_9 = new OrigDecimal(1e9);

/** Default number of decimal places to show */
export const DEFAULT_DECIMALS = 2;

/** Whether to show very small numbers by default */
export const DEFAULT_SHOW_SMALL = true;

/**
 * The value at and above which `format` uses the active notation.
 * Below it, `format` uses `regularFormat`, except for the small-value cases
 * `format` describes.
 */
const NOTATION_THRESHOLD = new OrigDecimal(1000);

/**
 * Format a number with commas as thousands separators
 */
export function commaFormat(num: DecimalSource, decimals: number): string {
  if (num == null) return 'NaN';

  if (typeof num === 'number') {
    if (Math.abs(num) < 0.001) return (0).toFixed(decimals);
    const [intPart, fracPart] = num.toFixed(decimals).split('.');
    const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return fracPart === undefined ? withCommas : withCommas + '.' + fracPart;
  }

  const d = new OrigDecimal(num);
  if (d.mag < 0.001) {
    return (0).toFixed(decimals);
  }

  const init = d.toStringWithDecimalPlaces(decimals);
  const portions = init.split('.');
  portions[0] = portions[0].replace(/(\d)(?=(\d\d\d)+(?!\d))/g, '$1,');

  return portions.length === 1 ? portions[0] : portions[0] + '.' + portions[1];
}

/**
 * Format a number in regular decimal notation
 */
export function regularFormat(num: DecimalSource, decimals: number): string {
  if (num == null) return 'NaN';

  if (typeof num === 'number') {
    const abs = Math.abs(num);
    if (abs < 0.0001) return (0).toFixed(decimals);
    let p = decimals;
    if (abs < 0.1 && p !== 0) {
      p = Math.max(p, Math.ceil(-Math.log10(abs)), DEFAULT_DECIMALS);
    }
    return num.toFixed(p);
  }

  const d = new OrigDecimal(num);
  if (d.mag < 0.0001) {
    return (0).toFixed(decimals);
  }

  if (d.mag < 0.1 && decimals !== 0) {
    decimals = Math.max(decimals, d.log10().negate().ceil().toNumber(), DEFAULT_DECIMALS);
  }

  return d.toStringWithDecimalPlaces(decimals);
}

/**
 * Smart format that chooses the best representation based on magnitude.
 *
 * Numbers below 1000 use the regular format. Larger numbers use the active
 * notation through notationManager, as do non-zero numbers below 0.001 when
 * `small` is set.
 */
export function format(
  num: DecimalSource,
  decimals: number = DEFAULT_DECIMALS,
  small: boolean = DEFAULT_SHOW_SMALL,
): string {
  if (typeof num === 'number') {
    if (Number.isNaN(num)) return 'NaN';
    if (num < 0) return '-' + format(-num, decimals, small);
    if (num === Number.POSITIVE_INFINITY) return 'Infinity';
    if (num >= 1000) return notationManager.format(new OrigDecimal(num));
    if (num >= 0.001 || !small) return regularFormat(num, decimals);
    if (num === 0) return (0).toFixed(decimals);
    return notationManager.format(new OrigDecimal(num));
  }

  const d = new OrigDecimal(num);

  if (isNaN(d.sign) || isNaN(d.layer) || isNaN(d.mag)) {
    return 'NaN';
  }

  if (d.sign < 0) {
    return '-' + format(d.neg(), decimals, small);
  }

  if (d.mag === Number.POSITIVE_INFINITY) {
    return 'Infinity';
  }

  // Large numbers — delegate to eternal notation
  if (d.gte(NOTATION_THRESHOLD)) {
    return notationManager.format(d);
  }

  // Regular format for normal numbers
  if (d.gte(THOUSANDTH) || !small) {
    return regularFormat(d, decimals);
  }

  // Zero
  if (d.eq(ZERO)) {
    return (0).toFixed(decimals);
  }

  // Very small numbers — show in notation
  return notationManager.format(d);
}

/**
 * Format a number as a whole number (no decimals unless small)
 */
export function formatWhole(num: DecimalSource): string {
  if (typeof num === 'number') {
    if (num < 0) return '-' + formatWhole(-num);
    if (num >= 1e9) return format(num);
    if (num <= 0.98 && num !== 0) return format(num);
    return format(num, 0);
  }

  const d = new OrigDecimal(num);

  if (d.sign < 0) {
    return '-' + formatWhole(d.neg());
  }

  if (d.gte(E_9)) {
    return format(d);
  }

  if (d.lte(NEAR_ONE) && !d.eq(ZERO)) {
    return format(d);
  }

  return format(d, 0);
}

/**
 * Format a duration in seconds to a human-readable string
 */
export function formatTime(seconds: DecimalSource): string {
  const d = new OrigDecimal(seconds);

  if (d.isNan()) return 'NaN';

  if (d.lt(0)) {
    return '-' + formatTime(d.neg());
  }

  if (d.gt(2 ** 51)) {
    return format(d.div(31536000)) + 'y';
  }

  // Round to the displayed centiseconds before splitting into units, so a
  // seconds field can't round up to "60.00" instead of carrying.
  const s = Math.round(d.toNumber() * 100) / 100;

  if (s < 60) {
    return format(s) + 's';
  }
  if (s < 3600) {
    return formatWhole(Math.floor(s / 60)) + 'm ' + format(s % 60) + 's';
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor(s / 60) % 60;
    const sec = Math.floor(s % 60);
    return (
      formatWhole(h) + 'h ' + String(m).padStart(2, '0') + 'm ' + String(sec).padStart(2, '0') + 's'
    );
  }
  if (s < 31536000) {
    return (
      formatWhole(Math.floor(s / 86400) % 365) +
      'd ' +
      formatWhole(Math.floor(s / 3600) % 24) +
      'h ' +
      formatWhole(Math.floor(s / 60) % 60) +
      'm'
    );
  }
  return (
    formatWhole(Math.floor(s / 31536000)) +
    'y ' +
    formatWhole(Math.floor(s / 86400) % 365) +
    'd ' +
    formatWhole(Math.floor(s / 3600) % 24) +
    'h'
  );
}

/**
 * Format a number, always showing very small numbers
 */
export function formatSmall(num: DecimalSource, decimals?: number): string {
  return format(num, decimals, true);
}
