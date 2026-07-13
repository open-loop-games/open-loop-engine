/**
 * Big number utilities using break_eternity.js
 * Provides Decimal type and formatting functions for large/small numbers.
 *
 * Large number formatting delegates to the active notation via notationManager
 * (powered by eternal_notations). Small numbers use regular decimal display.
 *
 * Arithmetic statics (add/sub/mul/div/min/max) are patched onto the imported
 * break_eternity class with typeof-dispatched fast paths: when both operands
 * are raw `number` and the result fits within IEEE 754 double precision, the
 * math runs in number-space and the result is promoted to a fresh `Decimal`
 * via `new OrigDecimal(r)` before return. Otherwise the call falls through to
 * the original static. Promotion preserves the `Decimal` return contract —
 * consumers can chain-call (`.clamp().toNumber()`, etc.) without needing to
 * know the fast path exists. Promotion to a fresh `Decimal` before return
 * preserves the chain contract regardless of whether the fast path fires.
 *
 * Predicates (eq/gt/gte/lt/lte) stay boolean-returning — no promotion needed,
 * no chain form to preserve.
 */

import OrigDecimal from 'break_eternity.js';
import { notationManager } from './notation-manager';

// Re-export under the engine's canonical names. The runtime value `Decimal`
// below is the same class that break_eternity default-exports; the `type`
// namespace points at the instance type so `const d: Decimal = new Decimal(…)`
// and `x instanceof Decimal` both read naturally.
/** Anything {@link toDecimal} accepts — a live `Decimal`, a `number`, or a numeric string. */
export type DecimalSource = OrigDecimal | number | string;
/** Instance type of break_eternity's `Decimal`, re-exported under the engine's canonical name. */
export type Decimal = OrigDecimal;

// OVERFLOW_ABS caps below IEEE 754 double precision (2^53 ≈ 9e15). Arithmetic
// results under this magnitude stay as native number; larger magnitudes
// promote to Decimal via the original static.
const OVERFLOW_ABS = 1e15;

/**
 * Coerce a layer-0, small-magnitude Decimal back to native `number`. For
 * accumulator chains (`acc = Decimal.add(acc, x)` in a loop), the
 * wrap-as-Decimal return preserves single-call chain form but promotes the
 * accumulator out of number-space after iter 0 — every subsequent iteration
 * then misses the typeof fast path. Calling this at each reduce boundary (and
 * between chained Decimal ops in multi-step accumulator bodies) keeps the
 * accumulator renormalized so the fast path fires on every iteration.
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
 * {@link renormIfLayer0} at reduce sites: renorm between steps for fast-path
 * firing, `toFinalDecimal` once at the return so callers can chain instance
 * methods on the result. Honors the single-call Decimal return contract
 * at aggregation boundaries.
 *
 * @internal
 */
export function toFinalDecimal(x: DecimalSource): Decimal {
  return x instanceof OrigDecimal ? x : new OrigDecimal(x);
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
// statics must keep their original identifiers to avoid surfacing `fastAdd`
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
    if (r < OVERFLOW_ABS && r > -OVERFLOW_ABS) return new OrigDecimal(r);
  }
  return origMul(a, b);
};

OrigDecimal.div = function div(a: DecimalSource, b: DecimalSource): Decimal {
  if (typeof a === 'number' && typeof b === 'number' && b !== 0) {
    const r = a / b;
    if (r < OVERFLOW_ABS && r > -OVERFLOW_ABS) return new OrigDecimal(r);
  }
  return origDiv(a, b);
};

OrigDecimal.min = function min(a: DecimalSource, b: DecimalSource): Decimal {
  if (typeof a === 'number' && typeof b === 'number') return new OrigDecimal(a < b ? a : b);
  return origMin(a, b);
};

OrigDecimal.max = function max(a: DecimalSource, b: DecimalSource): Decimal {
  if (typeof a === 'number' && typeof b === 'number') return new OrigDecimal(a > b ? a : b);
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

export const Decimal = OrigDecimal;
export default Decimal;

/** Create a Decimal from a number, string, or Decimal */
export function bn(x: DecimalSource): Decimal {
  return new OrigDecimal(x);
}

/**
 * Coerce a DecimalSource to a native number. Fast path for `number` inputs
 * (identity); slow path routes through a Decimal for strings and instances.
 * Use at the JS-iteration / native-math boundary where chain-calling
 * `.toNumber()` on a widened arithmetic return would be a type error.
 */
export function toNumber(x: DecimalSource): number {
  return typeof x === 'number' ? x : new OrigDecimal(x).toNumber();
}

/**
 * Relative tolerance for {@link integerRoot}'s perfect-power snapping. A value
 * within this fraction of a perfect `degree`-th power counts as that power.
 * 1e-9 sits far above break_eternity's log/exp error floor (~1e-15 relative)
 * and far below any game-meaningful distinction near an integer boundary.
 */
const INTEGER_ROOT_REL_TOL = 1e-9;

/**
 * The floored integer `degree`-th root of `x` — the largest integer `m` with
 * `mᵈᵉᵍʳᵉᵉ ≤ x`, returned as a Decimal. `integerRoot(x, 2)` is the integer
 * square root; `integerRoot(x, 3)` the integer cube root.
 *
 * Use this instead of `Decimal.floor(Decimal.root(x, n))`. break_eternity
 * computes both `root` and `pow` through log/exp, so each carries float error
 * in both directions (`root(8, 3)` = 1.999…, `pow(3, 3)` = 27.000…4). A plain
 * floor of the root under-counts at perfect powers (∛8 → 1), and a plain
 * `mⁿ ≤ x` comparison mis-floors for the same reason. This walks off the raw
 * root to the true integer using a magnitude-relative tolerance, so it is
 * correct at every scale rather than by luck of a fixed additive nudge.
 *
 * Snapping is relative: a value within {@link INTEGER_ROOT_REL_TOL} of a
 * perfect power rounds to that power (near an integer boundary the float error
 * already dominates, so this is the stable answer). `x ≤ 0` returns 0.
 *
 * Canonical use is sublinear per-source prestige payouts — `Σ integerRoot(
 * total / scale, 3)` — where pooling before the root would let one dominant
 * source mask the others (see consumer-guide § Sublinear per-source payouts).
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
  const value = x instanceof OrigDecimal ? x : new OrigDecimal(x);
  if (value.lte(0)) return new OrigDecimal(0);
  let m = value.root(degree).floor();
  if (m.lt(0)) m = new OrigDecimal(0);
  const tol = value.mul(INTEGER_ROOT_REL_TOL);
  while (m.gt(0) && m.pow(degree).sub(value).gt(tol)) m = m.sub(1);
  while (m.add(1).pow(degree).sub(value).lte(tol)) m = m.add(1);
  return m;
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
 * Threshold above which numbers are formatted by the active notation.
 * Below this, regularFormat/commaFormat are used for clean display.
 */
const NOTATION_THRESHOLD = new OrigDecimal(1000);

/**
 * Format a number with commas as thousands separators
 */
export function commaFormat(num: DecimalSource, precision: number): string {
  if (num == null) return 'NaN';

  if (typeof num === 'number') {
    if (Math.abs(num) < 0.001) return (0).toFixed(precision);
    const [intPart, fracPart] = num.toFixed(precision).split('.');
    const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return fracPart === undefined ? withCommas : withCommas + '.' + fracPart;
  }

  const d = new OrigDecimal(num);
  if (d.mag < 0.001) {
    return (0).toFixed(precision);
  }

  const init = d.toStringWithDecimalPlaces(precision);
  const portions = init.split('.');
  portions[0] = portions[0].replace(/(\d)(?=(\d\d\d)+(?!\d))/g, '$1,');

  return portions.length === 1 ? portions[0] : portions[0] + '.' + portions[1];
}

/**
 * Format a number in regular decimal notation
 */
export function regularFormat(num: DecimalSource, precision: number): string {
  if (num == null) return 'NaN';

  if (typeof num === 'number') {
    const abs = Math.abs(num);
    if (abs < 0.0001) return (0).toFixed(precision);
    let p = precision;
    if (abs < 0.1 && p !== 0) {
      p = Math.max(p, Math.ceil(-Math.log10(abs)), DEFAULT_DECIMALS);
    }
    return num.toFixed(p);
  }

  const d = new OrigDecimal(num);
  if (d.mag < 0.0001) {
    return (0).toFixed(precision);
  }

  if (d.mag < 0.1 && precision !== 0) {
    precision = Math.max(precision, d.log10().negate().ceil().toNumber(), DEFAULT_DECIMALS);
  }

  return d.toStringWithDecimalPlaces(precision);
}

/**
 * Smart format that chooses the best representation based on magnitude.
 *
 * Small numbers (< 1000) use regular decimal notation.
 * Large numbers delegate to the active eternal notation via notationManager.
 */
export function format(
  num: DecimalSource,
  precision: number = DEFAULT_DECIMALS,
  small: boolean = DEFAULT_SHOW_SMALL,
): string {
  if (typeof num === 'number') {
    if (Number.isNaN(num)) return 'NaN';
    if (num < 0) return '-' + format(-num, precision, small);
    if (num === Number.POSITIVE_INFINITY) return 'Infinity';
    if (num >= 1000) return notationManager.format(new OrigDecimal(num));
    if (num >= 0.001 || !small) return regularFormat(num, precision);
    if (num === 0) return (0).toFixed(precision);
    return notationManager.format(new OrigDecimal(num));
  }

  const d = new OrigDecimal(num);

  if (isNaN(d.sign) || isNaN(d.layer) || isNaN(d.mag)) {
    return 'NaN';
  }

  if (d.sign < 0) {
    return '-' + format(d.neg(), precision, small);
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
    return regularFormat(d, precision);
  }

  // Zero
  if (d.eq(ZERO)) {
    return (0).toFixed(precision);
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

  if (d.lt(0)) {
    return '-' + formatTime(d.neg());
  }

  if (d.gt(2 ** 51)) {
    return format(d.div(31536000)) + 'y';
  }

  const s = d.toNumber();

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
export function formatSmall(num: DecimalSource, precision?: number): string {
  return format(num, precision, true);
}
