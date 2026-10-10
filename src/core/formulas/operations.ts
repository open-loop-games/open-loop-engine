/**
 * Formula operations — inversion, integration, and substitution implementations
 *
 * @internal This module provides the math behind Formula's chainable operations.
 * Consumers should use the Formula class API, not these functions directly.
 *
 * Most operations follow structural patterns handled by factory functions
 * (`makeUnaryInvert`, `makeBinaryInvert`, `makeUnaryIntegrate`, `makeBinaryIntegrate`).
 * Operations with unique math (log integrals, tetration, etc.) are hand-written.
 */

import { Decimal } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import { F as Formula, hasVariable, unrefFormulaSource } from './formulas';
import { reportInversionFailure } from './inversion';
import { solveMonotone } from './root-find';
import { NOT_SUMMABLE, exactSeries, geometricSeries, powerSeries, type Series } from './series';
import type { FormulaSource, GenericFormula, InvertFunction, SubstitutionStack } from './types';

const ln10 = Decimal.ln(10);

// === FACTORY HELPERS ===

function makeUnaryInvert(transform: (value: DecimalSource) => DecimalSource) {
  return (value: DecimalSource, lhs: FormulaSource) => {
    if (hasVariable(lhs)) return lhs.invert(transform(value));
    reportInversionFailure('not-invertible', 'Could not invert due to no input being a variable');
    return 0;
  };
}

function makeBinaryInvert(
  lhsTransform: (value: DecimalSource, other: DecimalSource) => DecimalSource,
  rhsTransform?: (value: DecimalSource, other: DecimalSource) => DecimalSource,
) {
  return (value: DecimalSource, lhs: FormulaSource, rhs: FormulaSource) => {
    if (hasVariable(lhs)) {
      return lhs.invert(lhsTransform(value, unrefFormulaSource(rhs)));
    } else if (hasVariable(rhs) && rhsTransform) {
      return rhs.invert(rhsTransform(value, unrefFormulaSource(lhs)));
    }
    reportInversionFailure('not-invertible', 'Could not invert due to no input being a variable');
    return 0;
  };
}

function makeUnaryIntegrate(formulaOp: (x: GenericFormula) => GenericFormula) {
  return (stack: SubstitutionStack, lhs: FormulaSource) => {
    if (hasVariable(lhs)) {
      if (!lhs.isIntegrable()) {
        console.error('Could not integrate due to variable not being integrable');
        return Formula.constant(0);
      }
      return formulaOp(lhs.getAntiderivative(stack));
    }
    console.error('Could not integrate due to no input being a variable');
    return Formula.constant(0);
  };
}

/**
 * Build an integrate op from per-orientation antiderivative constructors.
 *
 * **Precondition — the op must be linear in the antiderivative.** These
 * constructors receive `∫f`, not `f`, and the substitution stack composes them
 * as though `op(∫f) = ∫op(f)`. That identity holds for the linear ops (`neg`,
 * `add`/`sub` by a constant, `mul`/`div` by a constant) and for nothing else.
 * Wiring a non-linear op through here yields the integrand reshaped rather than
 * an antiderivative, and the result is plausible enough to pass a smoke test:
 * `k/x` routed this way returned `k/(x²/2)`, making `∫2.5/x` over [1,10] come
 * out as −4.95 against a true 5.756. `integrateDiv` is hand-written and guarded
 * to a bare-variable denominator because of it. An op that isn't linear here
 * needs its own hand-written integrate, as the log family and `root` have.
 */
function makeBinaryIntegrate(
  lhsOp: (x: GenericFormula, other: FormulaSource, variable: GenericFormula) => GenericFormula,
  rhsOp?: (x: GenericFormula, other: FormulaSource, variable: GenericFormula) => GenericFormula,
) {
  return (stack: SubstitutionStack, lhs: FormulaSource, rhs: FormulaSource) => {
    if (hasVariable(lhs)) {
      if (!lhs.isIntegrable()) {
        console.error('Could not integrate due to variable not being integrable');
        return Formula.constant(0);
      }
      return lhsOp(lhs.getAntiderivative(stack), rhs, lhs);
    } else if (hasVariable(rhs) && rhsOp) {
      if (!rhs.isIntegrable()) {
        console.error('Could not integrate due to variable not being integrable');
        return Formula.constant(0);
      }
      return rhsOp(rhs.getAntiderivative(stack), lhs, rhs);
    }
    console.error('Could not integrate due to no input being a variable');
    return Formula.constant(0);
  };
}

function makeBinarySubstitution(
  lhsOp: (value: GenericFormula, other: FormulaSource) => GenericFormula,
  rhsOp?: (value: GenericFormula, other: FormulaSource) => GenericFormula,
) {
  return (value: GenericFormula, lhs: FormulaSource, rhs: FormulaSource) => {
    if (hasVariable(lhs)) return lhsOp(value, rhs);
    if (hasVariable(rhs)) return (rhsOp ?? lhsOp)(value, lhs);
    console.error('Could not apply substitution due to no input being a variable');
    return Formula.constant(0);
  };
}

// === EXACT SQUARES ===

// Decimal.pow and Decimal.root run a float pow even at exponent 2, landing an
// ulp off on integers: pow(41, 2) = 1680.9999999999998, root(1681, 2) =
// 40.99999999999999 (91k of the first 100k perfect squares miss). A floored
// curve then reads an exact threshold one step low, so exponent 2 takes the
// exact paths. Decimal.sqrt returns NaN below 1e-16 (sqrt(1e-16) = NaN), where
// root still answers, so the root path stays the fallback.
function isTwo(n: DecimalSource): boolean {
  return typeof n === 'number' ? n === 2 : Decimal.eq(n, 2);
}

/** `value ^ exponent`, exact for squares. */
export function powExact(value: DecimalSource, exponent: DecimalSource): Decimal {
  return isTwo(exponent) ? Decimal.mul(value, value) : Decimal.pow(value, exponent);
}

/** The `degree`th root of `value`, exact for square roots of perfect squares. */
export function rootExact(value: DecimalSource, degree: DecimalSource): Decimal {
  if (isTwo(degree)) {
    const exact = Decimal.sqrt(value);
    if (!exact.isNan()) return exact;
  }
  return Decimal.root(value, degree);
}

// === PASSTHROUGH UTILITIES ===

export function passthrough<T extends GenericFormula | DecimalSource>(value: T): T {
  return value;
}

export function invertPassthrough(value: DecimalSource, ...inputs: FormulaSource[]) {
  const variable = inputs.find((input) => hasVariable(input));
  if (variable == null) {
    reportInversionFailure('not-invertible', 'Could not invert due to no input being a variable');
    return 0;
  }
  return variable.invert(value);
}

// === SUMMATION ===

/**
 * `Σ` over a formula source. A raw `DecimalSource` (or a variable-free formula,
 * which {@link Formula.sum} handles) is constant across the span, so its series
 * is just `count` copies of it.
 *
 * @internal
 */
export function sumSource(
  source: FormulaSource,
  from: DecimalSource,
  count: DecimalSource,
): Series {
  if (source instanceof Formula) return source.sum(from, count);
  return exactSeries(Decimal.mul(count, unrefFormulaSource(source)));
}

/**
 * Combine two series under an exact linear identity — `Σ(f ± g) = Σf ± Σg`.
 *
 * The weakest arm wins: `not-summable` anywhere makes the whole thing
 * unanswerable, and an approximate part makes the result approximate with the
 * errors added, since the identity carries both through unchanged.
 *
 * @internal
 */
function combineSeries(
  a: Series,
  b: Series,
  combine: (x: DecimalSource, y: DecimalSource) => DecimalSource,
): Series {
  if (a.value == null || b.value == null) return NOT_SUMMABLE;
  const value = combine(a.value, b.value);
  const error =
    (a.reason === 'approximate' ? a.error : 0) + (b.reason === 'approximate' ? b.error : 0);
  return error > 0 ? { value, reason: 'approximate', error } : exactSeries(value);
}

/** Apply an exact scalar map to a series, preserving its grade. @internal */
function mapSeries(series: Series, transform: (x: DecimalSource) => DecimalSource): Series {
  if (series.value == null) return series;
  const value = transform(series.value);
  return series.reason === 'approximate'
    ? { value, reason: 'approximate', error: series.error }
    : exactSeries(value);
}

/**
 * Split a binary node into its variable-bearing side and its constant side, or
 * `null` when that isn't the shape — the constant side is what the linearity
 * identities factor out, so an op that can't find one has no rule to apply.
 *
 * @internal
 */
function splitByVariable(
  lhs: FormulaSource,
  rhs: FormulaSource,
): { variable: FormulaSource; constant: DecimalSource; variableOnLeft: boolean } | null {
  if (hasAnyVariable(lhs) && !hasAnyVariable(rhs)) {
    return { variable: lhs, constant: unrefFormulaSource(rhs), variableOnLeft: true };
  }
  if (hasAnyVariable(rhs) && !hasAnyVariable(lhs)) {
    return { variable: rhs, constant: unrefFormulaSource(lhs), variableOnLeft: false };
  }
  return null;
}

export function sumNeg(from: DecimalSource, count: DecimalSource, lhs: FormulaSource): Series {
  return mapSeries(sumSource(lhs, from, count), Decimal.neg);
}

export function sumAdd(
  from: DecimalSource,
  count: DecimalSource,
  lhs: FormulaSource,
  rhs: FormulaSource,
): Series {
  return combineSeries(sumSource(lhs, from, count), sumSource(rhs, from, count), Decimal.add);
}

export function sumSub(
  from: DecimalSource,
  count: DecimalSource,
  lhs: FormulaSource,
  rhs: FormulaSource,
): Series {
  return combineSeries(sumSource(lhs, from, count), sumSource(rhs, from, count), Decimal.sub);
}

export function sumMul(
  from: DecimalSource,
  count: DecimalSource,
  lhs: FormulaSource,
  rhs: FormulaSource,
): Series {
  const split = splitByVariable(lhs, rhs);
  if (split == null) return NOT_SUMMABLE;
  return mapSeries(sumSource(split.variable, from, count), (x) => Decimal.mul(x, split.constant));
}

export function sumDiv(
  from: DecimalSource,
  count: DecimalSource,
  lhs: FormulaSource,
  rhs: FormulaSource,
): Series {
  // `Σ k/f(i)` is not linear in `Σ f` — only the variable-numerator orientation
  // factors out. Same asymmetry `integrateDiv` guards, for the same reason.
  const split = splitByVariable(lhs, rhs);
  if (split == null || !split.variableOnLeft) return NOT_SUMMABLE;
  return mapSeries(sumSource(split.variable, from, count), (x) => Decimal.div(x, split.constant));
}

export function sumPowBase(
  from: DecimalSource,
  count: DecimalSource,
  lhs: FormulaSource,
  rhs: FormulaSource,
): Series {
  // Geometric only when the exponent is the bare variable. `base^g(x)` is
  // geometric for affine `g` too, but proving that means pattern-matching the
  // chain, and an unproven claim here is exactly the silent wrongness the
  // conformance work removed from this file.
  if (!isPlainVariable(lhs) || hasAnyVariable(rhs)) return NOT_SUMMABLE;
  return exactSeries(geometricSeries(unrefFormulaSource(rhs), from, count));
}

export function sumPow(
  from: DecimalSource,
  count: DecimalSource,
  lhs: FormulaSource,
  rhs: FormulaSource,
): Series {
  if (!isPlainVariable(lhs) || hasAnyVariable(rhs)) return NOT_SUMMABLE;
  const value = powerSeries(unrefFormulaSource(rhs), from, count);
  return value == null ? NOT_SUMMABLE : exactSeries(value);
}

// === NEGATION ===

export const invertNeg = makeUnaryInvert(Decimal.neg);
export const integrateNeg = makeUnaryIntegrate((x) => Formula.neg(x));
export function applySubstitutionNeg(value: GenericFormula) {
  return Formula.neg(value);
}

// === ARITHMETIC ===

export const invertAdd = makeBinaryInvert(
  (value, other) => Decimal.sub(value, other),
  (value, other) => Decimal.sub(value, other),
);

type FormulaInternals = { internalEvaluate?: unknown; internalVariables?: number };

/** Whether `f` is a variable leaf, with no op between it and the input. */
export function isPlainVariable(f: unknown): boolean {
  if (!(f instanceof Formula)) return false;
  const fi = f as unknown as FormulaInternals;
  return fi.internalEvaluate === undefined && fi.internalVariables === 1;
}

function hasAnyVariable(f: unknown): boolean {
  if (!(f instanceof Formula)) return false;
  return ((f as unknown as FormulaInternals).internalVariables ?? 0) > 0;
}

/**
 * The coefficient *source* for a `K·x²/2` antiderivative — `lhs` is `var` or
 * `mul(var, k)`, so `F(x) + c·x = T` reduces to a quadratic with a closed-form
 * solve — or null when the shape needs bisection. Structural only — it never reads the value, because
 * the caller holds the result for the life of a memoized integral formula and
 * a coefficient is a `FormulaSource`, free to be a ref or a variable-free
 * sub-formula that moves afterwards.
 *
 * @internal
 */
function quadraticSlopeSource(lhs: FormulaSource): FormulaSource | null {
  if (!(lhs instanceof Formula)) return null;
  // Plain variable: ∫x dx = x²/2 → slope 1
  if (isPlainVariable(lhs)) return 1;
  if ((lhs as unknown as FormulaInternals).internalEvaluate === Decimal.mul) {
    // mul(var, k) or mul(k, var): ∫k·x dx = k·x²/2 → slope k
    const [a, b] = lhs.inputs;
    if (isPlainVariable(a) && !hasAnyVariable(b)) return b;
    if (isPlainVariable(b) && !hasAnyVariable(a)) return a;
  }
  return null;
}

/**
 * Read a {@link quadraticSlopeSource} for one evaluation, or null to decline
 * the closed form.
 *
 * Read per call rather than captured, because the caller holds this for the
 * life of a memoized integral formula and the coefficient can move under it.
 *
 * K = 0 collapses the antiderivative to a line, and the closed form divides by
 * K; a non-finite K has no usable root. The *sign* of K is not a reason to
 * decline — the callers gate on the discriminant instead, which is the thing
 * that actually decides whether a real pre-image exists.
 *
 * @internal
 */
function quadraticSlope(source: FormulaSource | null): DecimalSource | null {
  if (source == null) return null;
  const slope = unrefFormulaSource(source);
  if (!Decimal.isFinite(slope) || Decimal.eq(slope, 0)) return null;
  return slope;
}

/**
 * The bare variable at the bottom of a single-variable chain — the `x` an
 * antiderivative is taken in.
 *
 * @internal
 */
function variableLeaf(chain: FormulaSource): GenericFormula {
  let node = chain as GenericFormula;
  while (!isPlainVariable(node)) node = node.inputs.find(hasAnyVariable) as GenericFormula;
  return node;
}

// ∫(s_f·f(x) + s_c·c) dx = s_f·F(x) + s_c·c·x — `add` is (+,+), `sub` with the
// variable on the left (+,−) and on the right (−,+). For `variableSide` shapes
// whose antiderivative is K·x²/2 (variable or `mul(var, k)`), invert reduces to
// a quadratic and is closed-form; otherwise fall back to bisection.
//
// The node's input is `x` itself, with `F` evaluated at it, rather than `F(x)`
// with `x` recovered by inverting `F`: a flat `f` has a flat `F`, which says
// nothing about where `x` is.
function buildLinearIntegral(
  variableSide: FormulaSource,
  F: GenericFormula,
  other: FormulaSource,
  fSign: 1 | -1,
  cSign: 1 | -1,
  label: string,
): GenericFormula {
  const slopeSource = quadraticSlopeSource(variableSide);
  // Negation is exact in `Decimal`, so each orientation evaluates bit-for-bit
  // as its own hand-written `F ± c·x` would.
  const signed = (sign: 1 | -1, v: DecimalSource): DecimalSource =>
    sign === 1 ? v : Decimal.neg(v);
  const at = (x: DecimalSource, c: DecimalSource): DecimalSource =>
    Decimal.add(signed(fSign, F.evaluate(x)), signed(cSign, Decimal.mul(c, x)));

  return new Formula({
    inputs: [variableLeaf(variableSide), other],
    evaluate: at,
    invert: !F.isInvertible()
      ? undefined
      : (target: DecimalSource, _x: FormulaSource, c_input: FormulaSource): DecimalSource => {
          const c = unrefFormulaSource(c_input);
          const slope = quadraticSlope(slopeSource);

          if (slope != null) {
            // With K' = s_f·K and c' = s_c·c:
            // K'·x²/2 + c'·x = T  →  K'·x² + 2c'·x - 2T = 0
            // x = (-c' + √(c'² + 2K'T)) / K'  — the positive root for K' > 0, and
            // the smaller of the two for K' < 0, which is the first passage
            // either way.
            const k = signed(fSign, slope);
            const cs = signed(cSign, c);
            const disc = Decimal.add(Decimal.pow(cs, 2), Decimal.mul(2, Decimal.mul(k, target)));
            // A negative discriminant is a statement about the target, not the
            // shape: no real pre-image. Fall through and let the generic path
            // report it rather than rooting a negative and returning NaN. It
            // fires on an ordinary positive slope in the (−,+) orientation.
            if (Decimal.gte(disc, 0)) {
              return Decimal.div(Decimal.sub(Decimal.sqrt(disc), cs), k);
            }
          }

          // Generic shape (cubic and higher, or a flat slope): solve by
          // bisection. F⁻¹(s_f·target) is the answer when c = 0, so it makes a
          // tight starting bracket for the general case. `c·x - F(x)` rises then
          // falls, so it is only monotone up to its turning point; `solveMonotone`
          // cannot detect the violation and takes the first crossing it finds.
          const x = solveMonotone((v) => at(v, c), target, {
            upper: F.invert(signed(fSign, target)),
          });
          if (x == null) {
            reportInversionFailure(
              'no-solution',
              `Could not invert ${label}: target is out of the search range`,
            );
            return 0;
          }
          return x;
        },
  });
}

const integrateAddArm = (F: GenericFormula, c: FormulaSource, v: GenericFormula) =>
  buildLinearIntegral(v, F, c, 1, 1, 'integrateAdd');
export const integrateAdd = makeBinaryIntegrate(integrateAddArm, integrateAddArm);

export const integrateInnerAdd = makeBinaryIntegrate(
  (x, other) => Formula.add(x, other),
  (x, other) => Formula.add(x, other),
);

export const invertSub = makeBinaryInvert(
  (value, other) => Decimal.add(value, other),
  (value, other) => Decimal.sub(other, value),
);

export const integrateSub = makeBinaryIntegrate(
  (F, c, v) => buildLinearIntegral(v, F, c, 1, -1, 'integrateSub'),
  (F, c, v) => buildLinearIntegral(v, F, c, -1, 1, 'integrateSub'),
);

export const integrateInnerSub = makeBinaryIntegrate(
  (x, other) => Formula.sub(x, other),
  (x, other) => Formula.sub(other, x),
);

export const invertMul = makeBinaryInvert(
  (value, other) => Decimal.div(value, other),
  (value, other) => Decimal.div(value, other),
);

export const integrateMul = makeBinaryIntegrate(
  (x, other) => Formula.mul(x, other),
  (x, other) => Formula.mul(x, other),
);

export const applySubstitutionMul = makeBinarySubstitution((value, other) =>
  Formula.div(value, other),
);

export const invertDiv = makeBinaryInvert(
  (value, other) => Decimal.mul(value, other),
  (value, other) => Decimal.div(other, value),
);

// `x / k` is linear in the antiderivative, so the substitution shortcut applies
// and `F(x)/k` is correct. `k / x` is not: its antiderivative is `k·ln(x)`.
// Upstream ran both orientations through the shortcut, so the rhs branch
// returned `k/(x²/2)` — the integrand reshaped, not an antiderivative at all
// (∫2.5/x over [1,10] came out as -4.95 against a true 2.5·ln(10) = 5.756).
// The div descriptor binds this over `k / g(x)` only for a bare `g`.
export function integrateDiv(stack: SubstitutionStack, lhs: FormulaSource, rhs: FormulaSource) {
  if (hasVariable(lhs)) {
    if (!lhs.isIntegrable()) {
      console.error('Could not integrate due to variable not being integrable');
      return Formula.constant(0);
    }
    return Formula.div(lhs.getAntiderivative(stack), rhs);
  }
  if (hasVariable(rhs)) return Formula.mul(lhs, Formula.ln(rhs));
  console.error('Could not integrate due to no input being a variable');
  return Formula.constant(0);
}

export const applySubstitutionDiv = makeBinarySubstitution((value, other) =>
  Formula.mul(value, other),
);

// === RECIPROCAL ===

export const invertRecip = makeUnaryInvert(Decimal.recip);
export const integrateRecip = makeUnaryIntegrate((x) => Formula.ln(x));

// === LOGARITHMS ===

export const invertLog10 = makeUnaryInvert(Decimal.pow10);

function internalIntegrateLog10(lhs: DecimalSource) {
  return Decimal.ln(lhs).sub(1).mul(lhs).div(ln10);
}

function internalInvertAntiderivativeLog10(value: DecimalSource, lhs: FormulaSource) {
  if (hasVariable(lhs)) {
    const numerator = ln10.mul(value);
    return lhs.invert(numerator.div(numerator.div(Math.E).lambertw()));
  }
  reportInversionFailure('not-invertible', 'Could not invert due to no input being a variable');
  return 0;
}

export function integrateLog10(stack: SubstitutionStack, lhs: FormulaSource) {
  if (hasVariable(lhs)) {
    if (!lhs.isIntegrable()) {
      console.error('Could not integrate due to variable not being integrable');
      return Formula.constant(0);
    }
    return new Formula({
      inputs: [lhs.getAntiderivative(stack)],
      evaluate: internalIntegrateLog10,
      invert: internalInvertAntiderivativeLog10,
    });
  }
  console.error('Could not integrate due to no input being a variable');
  return Formula.constant(0);
}

export const invertLog = makeBinaryInvert(
  (value, other) => Decimal.pow(other, value),
  (value, other) => Decimal.root(other, value),
);

function internalIntegrateLog(lhs: DecimalSource, rhs: DecimalSource) {
  return Decimal.ln(lhs).sub(1).mul(lhs).div(Decimal.ln(rhs));
}

function internalInvertAntiderivativeLog(
  value: DecimalSource,
  lhs: FormulaSource,
  rhs: FormulaSource,
) {
  if (hasVariable(lhs)) {
    const numerator = Decimal.ln(unrefFormulaSource(rhs)).mul(value);
    return lhs.invert(numerator.div(numerator.div(Math.E).lambertw()));
  }
  reportInversionFailure('not-invertible', 'Could not invert due to no input being a variable');
  return 0;
}

export function integrateLog(stack: SubstitutionStack, lhs: FormulaSource, rhs: FormulaSource) {
  if (hasVariable(lhs)) {
    if (!lhs.isIntegrable()) {
      console.error('Could not integrate due to variable not being integrable');
      return Formula.constant(0);
    }
    return new Formula({
      inputs: [lhs.getAntiderivative(stack), rhs],
      evaluate: internalIntegrateLog,
      invert: internalInvertAntiderivativeLog,
    });
  }
  console.error('Could not integrate due to no input being a variable');
  return Formula.constant(0);
}

export const invertLog2 = makeUnaryInvert((v) => Decimal.pow(2, v));

function internalIntegrateLog2(lhs: DecimalSource) {
  return Decimal.ln(lhs).sub(1).mul(lhs).div(Decimal.ln(2));
}

function internalInvertAntiderivativeLog2(value: DecimalSource, lhs: FormulaSource) {
  if (hasVariable(lhs)) {
    const numerator = Decimal.ln(2).mul(value);
    return lhs.invert(numerator.div(numerator.div(Math.E).lambertw()));
  }
  reportInversionFailure('not-invertible', 'Could not invert due to no input being a variable');
  return 0;
}

export function integrateLog2(stack: SubstitutionStack, lhs: FormulaSource) {
  if (hasVariable(lhs)) {
    if (!lhs.isIntegrable()) {
      console.error('Could not integrate due to variable not being integrable');
      return Formula.constant(0);
    }
    return new Formula({
      inputs: [lhs.getAntiderivative(stack)],
      evaluate: internalIntegrateLog2,
      invert: internalInvertAntiderivativeLog2,
    });
  }
  console.error('Could not integrate due to no input being a variable');
  return Formula.constant(0);
}

export const invertLn = makeUnaryInvert(Decimal.exp);

function internalIntegrateLn(lhs: DecimalSource) {
  return Decimal.ln(lhs).sub(1).mul(lhs);
}

function internalInvertAntiderivativeLn(value: DecimalSource, lhs: FormulaSource) {
  if (hasVariable(lhs)) {
    return lhs.invert(Decimal.div(value, new Decimal(Decimal.div(value, Math.E)).lambertw()));
  }
  reportInversionFailure('not-invertible', 'Could not invert due to no input being a variable');
  return 0;
}

export function integrateLn(stack: SubstitutionStack, lhs: FormulaSource) {
  if (hasVariable(lhs)) {
    if (!lhs.isIntegrable()) {
      console.error('Could not integrate due to variable not being integrable');
      return Formula.constant(0);
    }
    return new Formula({
      inputs: [lhs.getAntiderivative(stack)],
      evaluate: internalIntegrateLn,
      invert: internalInvertAntiderivativeLn,
    });
  }
  console.error('Could not integrate due to no input being a variable');
  return Formula.constant(0);
}

// === POWERS ===

export const invertPow = makeBinaryInvert(
  (value, other) => rootExact(value, other),
  (value, other) => Decimal.ln(value).div(Decimal.ln(other)),
);

/**
 * `∫ bᵘ du = bᵘ/ln b` — shared by `pow(b, u)` and `pow_base(u, b)`.
 *
 * At `b = 1` that quotient is 0/0 and the antiderivative is its limit, `u`. The
 * base is read per evaluation rather than branched on at build, because the
 * integral is memoized and a ratio that is a ref can reach 1 afterwards.
 *
 * @internal
 */
function exponentialAntiderivative(u: GenericFormula, base: FormulaSource): GenericFormula {
  return new Formula({
    inputs: [u, base],
    evaluate: (uVal: DecimalSource, b: DecimalSource) =>
      Decimal.eq(b, 1) ? uVal : Decimal.div(Decimal.pow(b, uVal), Decimal.ln(b)),
    invert: (target: DecimalSource, uInput: FormulaSource, bInput: FormulaSource) => {
      const b = unrefFormulaSource(bInput);
      const inner = Decimal.eq(b, 1) ? target : Decimal.log(Decimal.mul(target, Decimal.ln(b)), b);
      return (uInput as GenericFormula).invert(inner);
    },
  });
}

export const integratePow = makeBinaryIntegrate(
  (x, other) => {
    const pow = Formula.add(other, 1);
    return Formula.pow(x, pow).div(pow);
  },
  (x, other) => exponentialAntiderivative(x, other),
);

// The inverse of `10ˣ` is `log₁₀`, not the 10th root — `root(v, 10)` inverts
// `x¹⁰`. Upstream had the latter, and no test round-tripped a unary op.
export const invertPow10 = makeUnaryInvert(Decimal.log10);

export const integratePow10 = makeUnaryIntegrate((x) => Formula.pow10(x).div(Formula.ln(10)));

export const invertPowBase = makeBinaryInvert(
  (value, other) => Decimal.ln(value).div(Decimal.ln(other)),
  // Solving `otherᵇ = value` for the base b gives `value^(1/other)`, i.e.
  // `root(value, other)`. Upstream passed these the other way round, which
  // computes `other^(1/value)` — only equal when value === other.
  (value, other) => Decimal.root(value, other),
);

export const integratePowBase = makeBinaryIntegrate(
  (x, other) => exponentialAntiderivative(x, other),
  (x, other) => {
    const denominator = Formula.add(other, 1);
    return Formula.pow(x, denominator).div(denominator);
  },
);

export const invertRoot = makeBinaryInvert(
  (value, other) => powExact(value, other),
  (value, other) => Decimal.ln(other).div(Decimal.ln(value)),
);

export function integrateRoot(stack: SubstitutionStack, lhs: FormulaSource, rhs: FormulaSource) {
  if (hasVariable(lhs)) {
    if (!lhs.isIntegrable()) {
      console.error('Could not integrate due to variable not being integrable');
      return Formula.constant(0);
    }
    const x = lhs.getAntiderivative(stack);
    return Formula.pow(x, Formula.recip(rhs).add(1)).mul(rhs).div(Formula.add(rhs, 1));
  }
  console.error('Could not integrate due to no input being a variable');
  return Formula.constant(0);
}

// === EXPONENTIAL ===

export const invertExp = makeUnaryInvert(Decimal.ln);
export const integrateExp = makeUnaryIntegrate((x) => Formula.exp(x));

// === TETRATION / ITERATION / LAYERS ===

export function tetrate(
  value: DecimalSource,
  height: DecimalSource = 2,
  payload: DecimalSource = Decimal.fromComponents_noNormalize(1, 0, 1),
) {
  const heightNumber = Decimal.minabs(height, 1e308).toNumber();
  return Decimal.tetrate(value, heightNumber, payload);
}

export function invertTetrate(
  value: DecimalSource,
  base: FormulaSource,
  height: FormulaSource,
  payload: FormulaSource,
) {
  if (hasVariable(base)) {
    const heightValue = unrefFormulaSource(height);
    const payloadValue = unrefFormulaSource(payload);
    // `ssqrt` inverts `b ↑↑ 2` (that is, `b^b`) and nothing else. Upstream
    // applied it at every height and payload — silently returning `2.745` for
    // `tetrate(2, 3) = 16` instead of `2`.
    if (Decimal.eq(heightValue, 2) && Decimal.eq(payloadValue, 1)) {
      return base.invert(Decimal.ssqrt(value));
    }
    // No closed form elsewhere, so solve for the base numerically. `b ↑↑ h` is
    // monotone increasing in `b` only above 1 — below it the tower converges
    // instead of growing — so the search starts there and reports when the
    // target can't be bracketed above it.
    const solved = solveMonotone((b) => tetrate(b, heightValue, payloadValue), value, { lower: 1 });
    if (solved == null) {
      reportInversionFailure(
        'no-solution',
        'Could not invert tetrate: no base above 1 reaches the target',
      );
      return 0;
    }
    return base.invert(solved);
  }
  reportInversionFailure('not-invertible', 'Could not invert due to no input being a variable');
  return 0;
}

export function iteratedexp(
  value: DecimalSource,
  height: DecimalSource = 2,
  payload: DecimalSource = Decimal.fromComponents_noNormalize(1, 0, 1),
) {
  const heightNumber = Decimal.minabs(height, 1e308).toNumber();
  return Decimal.iteratedexp(value, heightNumber, new Decimal(payload));
}

export function invertIteratedExp(
  value: DecimalSource,
  lhs: FormulaSource,
  height: FormulaSource,
  payload: FormulaSource,
) {
  if (hasVariable(lhs)) {
    // The variable sits in the *base* position, so the inverse has to solve for
    // the base. Upstream applied `iteratedlog(value, e, height)`, which solves
    // for the payload and hardcodes base e — the wrong argument, and right only
    // where the base happens to be e.
    //
    // At height 1 the op degenerates to `base ^ payload`, whose inverse in the
    // base is `root(value, payload)`. Above that there is no closed form, so it
    // takes the same numeric fallback as `invertTetrate` — monotone in the base
    // only above 1, for the same reason.
    const heightValue = unrefFormulaSource(height);
    const payloadValue = unrefFormulaSource(payload);
    if (Decimal.eq(heightValue, 1)) {
      return lhs.invert(Decimal.root(value, payloadValue));
    }
    const solved = solveMonotone((b) => iteratedexp(b, heightValue, payloadValue), value, {
      lower: 1,
    });
    if (solved == null) {
      reportInversionFailure(
        'no-solution',
        'Could not invert iteratedexp: no base above 1 reaches the target',
      );
      return 0;
    }
    return lhs.invert(solved);
  }
  reportInversionFailure('not-invertible', 'Could not invert due to no input being a variable');
  return 0;
}

export function iteratedLog(
  value: DecimalSource,
  lhs: DecimalSource = 10,
  times: DecimalSource = 2,
) {
  const timesNumber = Decimal.minabs(times, 1e308).toNumber();
  return Decimal.iteratedlog(value, lhs, timesNumber);
}

export function slog(value: DecimalSource, lhs: DecimalSource = 10) {
  const baseNumber = Decimal.minabs(lhs, 1e308).toNumber();
  return Decimal.slog(value, baseNumber);
}

export function invertSlog(value: DecimalSource, lhs: FormulaSource, rhs: FormulaSource) {
  if (hasVariable(lhs)) {
    // Inverting `slog_base(x) = y` gives `x = base ↑↑ y`, so the base is
    // `tetrate`'s first argument and the target its second. Upstream passed
    // them the other way round, computing `y ↑↑ base`.
    return lhs.invert(
      Decimal.tetrate(unrefFormulaSource(rhs), Decimal.minabs(1e308, value).toNumber()),
    );
  }
  reportInversionFailure('not-invertible', 'Could not invert due to no input being a variable');
  return 0;
}

export function layeradd(value: DecimalSource, diff: DecimalSource, base: DecimalSource) {
  const diffNumber = Decimal.minabs(diff, 1e308).toNumber();
  return Decimal.layeradd(value, diffNumber, base);
}

export function invertLayeradd(
  value: DecimalSource,
  lhs: FormulaSource,
  diff: FormulaSource,
  base: FormulaSource,
) {
  if (hasVariable(lhs)) {
    // The base has to travel with the inverse: `layeradd` counts layers in
    // base-b logarithms, so undoing it in base 10 (upstream dropped the
    // argument) recovers a different number for any other base.
    return lhs.invert(
      Decimal.layeradd(
        value,
        Decimal.minabs(1e308, unrefFormulaSource(diff)).neg().toNumber(),
        unrefFormulaSource(base),
      ),
    );
  }
  reportInversionFailure('not-invertible', 'Could not invert due to no input being a variable');
  return 0;
}

export const invertLambertw = makeUnaryInvert((v) => Decimal.pow(Math.E, v).mul(v));
export const invertSsqrt = makeUnaryInvert((v) => Decimal.tetrate(v, 2));

export function pentate(value: DecimalSource, height: DecimalSource, payload: DecimalSource) {
  const heightNumber = Decimal.minabs(height, 1e308).toNumber();
  return Decimal.pentate(value, heightNumber, payload);
}

// === TRIGONOMETRIC ===

export const invertSin = makeUnaryInvert(Decimal.asin);
export const integrateSin = makeUnaryIntegrate((x) => Formula.cos(x).neg());

export const invertCos = makeUnaryInvert(Decimal.acos);
export const integrateCos = makeUnaryIntegrate((x) => Formula.sin(x));

export const invertTan = makeUnaryInvert(Decimal.atan);
export const integrateTan = makeUnaryIntegrate((x) => Formula.cos(x).ln().neg());

export const invertAsin = makeUnaryInvert(Decimal.sin);
export const integrateAsin = makeUnaryIntegrate((x) =>
  Formula.asin(x)
    .mul(x)
    .add(Formula.sqrt(Formula.sub(1, Formula.pow(x, 2)))),
);

export const invertAcos = makeUnaryInvert(Decimal.cos);
export const integrateAcos = makeUnaryIntegrate((x) =>
  Formula.acos(x)
    .mul(x)
    .sub(Formula.sqrt(Formula.sub(1, Formula.pow(x, 2)))),
);

export const invertAtan = makeUnaryInvert(Decimal.tan);
export const integrateAtan = makeUnaryIntegrate((x) =>
  Formula.atan(x)
    .mul(x)
    .sub(Formula.ln(Formula.pow(x, 2).add(1)).div(2)),
);

// === HYPERBOLIC ===

// Accuracy ceiling inherited from the dependency, not from this table: upstream
// `asinh`/`atanh` are the naive closed forms — `ln(x + √(x²+1))` and
// `ln((1+x)/(1−x))/2` — which cancel catastrophically in the saturated tail. At
// x = -10, `x + √(x²+1)` is 4.5e-5, so ~9 digits are gone: `asinh` returns
// -10.000000133701262 where `Math.asinh` and mpmath give exactly -10. The error
// is sign-asymmetric (the positive half holds machine epsilon) and grows as
// ε·2x². Inverting `sinh`/`tanh` inherits it; a consumer needing the tail to
// full precision has to bind a stable inverse rather than tightening a law.
export const invertSinh = makeUnaryInvert(Decimal.asinh);
export const integrateSinh = makeUnaryIntegrate((x) => Formula.cosh(x));

export const invertCosh = makeUnaryInvert(Decimal.acosh);
export const integrateCosh = makeUnaryIntegrate((x) => Formula.sinh(x));

export const invertTanh = makeUnaryInvert(Decimal.atanh);
export const integrateTanh = makeUnaryIntegrate((x) => Formula.cosh(x).ln());

export const invertAsinh = makeUnaryInvert(Decimal.sinh);
export const integrateAsinh = makeUnaryIntegrate((x) =>
  Formula.asinh(x).mul(x).sub(Formula.pow(x, 2).add(1).sqrt()),
);

export const invertAcosh = makeUnaryInvert(Decimal.cosh);
export const integrateAcosh = makeUnaryIntegrate((x) =>
  Formula.acosh(x)
    .mul(x)
    .sub(Formula.add(x, 1).sqrt().mul(Formula.sub(x, 1).sqrt())),
);

export const invertAtanh = makeUnaryInvert(Decimal.tanh);
export const integrateAtanh = makeUnaryIntegrate((x) =>
  Formula.atanh(x)
    .mul(x)
    .add(Formula.sub(1, Formula.pow(x, 2)).ln().div(2)),
);

// === PASSTHROUGH BINARY FACTORY ===

export function createPassthroughBinaryFormula(
  operation: (a: DecimalSource, b: DecimalSource) => DecimalSource,
) {
  return (value: FormulaSource, other: FormulaSource) =>
    new Formula({
      inputs: [value, other],
      evaluate: operation,
      invert: invertPassthrough as InvertFunction<[FormulaSource, FormulaSource]>,
    });
}
