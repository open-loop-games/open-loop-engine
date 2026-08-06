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
import { findCrossing } from './root-find';
import { NOT_SUMMABLE, exactSeries, geometricSeries, powerSeries, type Series } from './series';
import type {
  FormulaSource,
  GenericFormula,
  InvertFunction,
  InvertibleFormula,
  SubstitutionStack,
} from './types';

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
      return formulaOp(lhs.getIntegralFormula(stack));
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
      return lhsOp(lhs.getIntegralFormula(stack), rhs, lhs);
    } else if (hasVariable(rhs) && rhsOp) {
      if (!rhs.isIntegrable()) {
        console.error('Could not integrate due to variable not being integrable');
        return Formula.constant(0);
      }
      return rhsOp(rhs.getIntegralFormula(stack), lhs, rhs);
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

// === PASSTHROUGH UTILITIES ===

export function passthrough<T extends GenericFormula | DecimalSource>(value: T): T {
  return value;
}

export function invertPassthrough(value: DecimalSource, ...inputs: FormulaSource[]) {
  const variable = inputs.find((input) => hasVariable(input)) as InvertibleFormula | undefined;
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

// Detect whether `lhs` is `var` or `mul(var, k)` shape — i.e., its antiderivative
// is `K·x²/2`, so `F(x) + c·x = T` reduces to a quadratic with closed-form solve.
// Returns the slope coefficient K (1 for plain variable, k for mul(var, k)), or
// null if the shape requires bisection.
type FormulaInternals = { internalEvaluate?: unknown; internalVariables?: number };

function isPlainVariable(f: unknown): boolean {
  if (!(f instanceof Formula)) return false;
  const fi = f as unknown as FormulaInternals;
  return fi.internalEvaluate === undefined && fi.internalVariables === 1;
}

function hasAnyVariable(f: unknown): boolean {
  if (!(f instanceof Formula)) return false;
  return ((f as unknown as FormulaInternals).internalVariables ?? 0) > 0;
}

function quadraticSlope(lhs: FormulaSource): DecimalSource | null {
  let slope: DecimalSource | null = null;
  if (!(lhs instanceof Formula)) return null;
  // Plain variable: ∫x dx = x²/2 → slope 1
  if (isPlainVariable(lhs)) {
    slope = 1;
  } else if ((lhs as unknown as FormulaInternals).internalEvaluate === Decimal.mul) {
    // mul(var, k) or mul(k, var): ∫k·x dx = k·x²/2 → slope k
    const [a, b] = lhs.inputs;
    if (isPlainVariable(a) && !hasAnyVariable(b)) slope = unrefFormulaSource(b);
    else if (isPlainVariable(b) && !hasAnyVariable(a)) slope = unrefFormulaSource(a);
  }
  // Closed-form invert is `(-c + √(c² + 2·K·T)) / K` — divide by K, sqrt of a
  // possibly-negative discriminant for K ≤ 0. Skip closed-form for non-positive
  // slopes; bisection handles those correctly (and they're rare in cost contexts).
  if (slope == null) return null;
  if (Decimal.lte(slope, 0)) return null;
  return slope;
}

// ∫(f(x) + c) dx = F(x) + c·x. For `lhs` shapes whose antiderivative is K·x²/2
// (variable or `mul(var, k)`), invert reduces to a quadratic and is closed-form;
// otherwise fall back to bisection. Evaluate recovers x via F's existing invert.
function buildIntegrateAdd(
  lhs: FormulaSource,
  F_integral: GenericFormula,
  other: FormulaSource,
): GenericFormula {
  const slope = quadraticSlope(lhs);

  return new Formula({
    inputs: [F_integral, other],
    evaluate: (F_val: DecimalSource, c_val: DecimalSource): DecimalSource => {
      if (slope != null) {
        // F_val = K·x²/2 → x = √(2·F_val/K)
        const x = Decimal.sqrt(Decimal.div(Decimal.mul(2, F_val), slope));
        return Decimal.add(F_val, Decimal.mul(c_val, x));
      }
      if (!F_integral.isInvertible()) return Decimal.add(F_val, c_val);
      const x = (F_integral as InvertibleFormula).invert(F_val);
      return Decimal.add(F_val, Decimal.mul(c_val, x));
    },
    invert: (
      target: DecimalSource,
      F_input: FormulaSource,
      c_input: FormulaSource,
    ): DecimalSource => {
      const c = unrefFormulaSource(c_input);

      if (slope != null) {
        // K·x²/2 + c·x = T  →  K·x² + 2c·x - 2T = 0
        // x = (-c + √(c² + 2KT)) / K  (positive root)
        const disc = Decimal.add(Decimal.pow(c, 2), Decimal.mul(2, Decimal.mul(slope, target)));
        return Decimal.div(Decimal.sub(Decimal.sqrt(disc), c), slope);
      }

      // Generic shape (cubic and higher): solve F(x) + c·x = target by bisection.
      if (!hasVariable(F_input) || !(F_input as InvertibleFormula).isInvertible()) {
        reportInversionFailure(
          'not-invertible',
          'Could not invert integrateAdd: integral lhs is not invertible',
        );
        return 0;
      }
      const F = F_input as InvertibleFormula;
      // F⁻¹(target) is the answer when c = 0, so it makes a tight starting
      // bracket for the general case.
      const x = findCrossing((v) => Decimal.add(F.evaluate(v), Decimal.mul(c, v)), target, {
        upper: F.invert(target),
      });
      if (x == null) {
        reportInversionFailure(
          'no-solution',
          'Could not invert integrateAdd: target is out of the search range',
        );
        return 0;
      }
      return x;
    },
  });
}

export function integrateAdd(stack: SubstitutionStack, lhs: FormulaSource, rhs: FormulaSource) {
  if (hasVariable(lhs)) {
    if (!lhs.isIntegrable()) {
      console.error('Could not integrate due to variable not being integrable');
      return Formula.constant(0);
    }
    return buildIntegrateAdd(lhs, lhs.getIntegralFormula(stack), rhs);
  }
  if (hasVariable(rhs)) {
    if (!rhs.isIntegrable()) {
      console.error('Could not integrate due to variable not being integrable');
      return Formula.constant(0);
    }
    return buildIntegrateAdd(rhs, rhs.getIntegralFormula(stack), lhs);
  }
  console.error('Could not integrate due to no input being a variable');
  return Formula.constant(0);
}

export const integrateInnerAdd = makeBinaryIntegrate(
  (x, other) => Formula.add(x, other),
  (x, other) => Formula.add(x, other),
);

export const invertSub = makeBinaryInvert(
  (value, other) => Decimal.add(value, other),
  (value, other) => Decimal.sub(other, value),
);

// ∫(f(x) - c) dx = F(x) - c·x; ∫(c - f(x)) dx = c·x - F(x).
// Same closed-form-vs-bisection split as integrateAdd, with sign flips.
function buildIntegrateSub(
  variableSide: FormulaSource,
  F_integral: GenericFormula,
  other: FormulaSource,
  variableOnLhs: boolean,
): GenericFormula {
  const slope = quadraticSlope(variableSide);

  return new Formula({
    inputs: [F_integral, other],
    evaluate: (F_val: DecimalSource, c_val: DecimalSource): DecimalSource => {
      let x: DecimalSource;
      if (slope != null) {
        x = Decimal.sqrt(Decimal.div(Decimal.mul(2, F_val), slope));
      } else if (F_integral.isInvertible()) {
        x = (F_integral as InvertibleFormula).invert(F_val);
      } else {
        return variableOnLhs ? Decimal.sub(F_val, c_val) : Decimal.sub(c_val, F_val);
      }
      const cx = Decimal.mul(c_val, x);
      return variableOnLhs ? Decimal.sub(F_val, cx) : Decimal.sub(cx, F_val);
    },
    invert: (
      target: DecimalSource,
      F_input: FormulaSource,
      c_input: FormulaSource,
    ): DecimalSource => {
      const c = unrefFormulaSource(c_input);

      if (slope != null) {
        // variableOnLhs:  K·x²/2 - c·x = T  →  K·x² - 2c·x - 2T = 0  →  x = (c + √(c² + 2KT)) / K
        // !variableOnLhs: c·x - K·x²/2 = T  →  K·x² - 2c·x + 2T = 0  →  x = (c - √(c² - 2KT)) / K
        if (variableOnLhs) {
          const disc = Decimal.add(Decimal.pow(c, 2), Decimal.mul(2, Decimal.mul(slope, target)));
          return Decimal.div(Decimal.add(c, Decimal.sqrt(disc)), slope);
        }
        const disc = Decimal.sub(Decimal.pow(c, 2), Decimal.mul(2, Decimal.mul(slope, target)));
        return Decimal.div(Decimal.sub(c, Decimal.sqrt(disc)), slope);
      }

      if (!hasVariable(F_input) || !(F_input as InvertibleFormula).isInvertible()) {
        reportInversionFailure(
          'not-invertible',
          'Could not invert integrateSub: integral lhs is not invertible',
        );
        return 0;
      }
      const F = F_input as InvertibleFormula;
      // `c·x - F(x)` rises then falls, so it is only monotone up to its turning
      // point. `findCrossing` cannot detect the violation, and this branch keeps
      // the pre-existing behaviour of taking the first crossing it finds.
      const x = findCrossing(
        (v) => {
          const cx = Decimal.mul(c, v);
          return variableOnLhs ? Decimal.sub(F.evaluate(v), cx) : Decimal.sub(cx, F.evaluate(v));
        },
        target,
        { upper: F.invert(variableOnLhs ? target : Decimal.neg(target)) },
      );
      if (x == null) {
        reportInversionFailure(
          'no-solution',
          'Could not invert integrateSub: target is out of the search range',
        );
        return 0;
      }
      return x;
    },
  });
}

export function integrateSub(stack: SubstitutionStack, lhs: FormulaSource, rhs: FormulaSource) {
  if (hasVariable(lhs)) {
    if (!lhs.isIntegrable()) {
      console.error('Could not integrate due to variable not being integrable');
      return Formula.constant(0);
    }
    return buildIntegrateSub(lhs, lhs.getIntegralFormula(stack), rhs, true);
  }
  if (hasVariable(rhs)) {
    if (!rhs.isIntegrable()) {
      console.error('Could not integrate due to variable not being integrable');
      return Formula.constant(0);
    }
    return buildIntegrateSub(rhs, rhs.getIntegralFormula(stack), lhs, false);
  }
  console.error('Could not integrate due to no input being a variable');
  return Formula.constant(0);
}

export const integrateInnerSub = makeBinaryIntegrate(
  (x, other) => Formula.sub(x, other),
  (x, other) => Formula.sub(x, other),
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
export function integrateDiv(stack: SubstitutionStack, lhs: FormulaSource, rhs: FormulaSource) {
  if (hasVariable(lhs)) {
    if (!lhs.isIntegrable()) {
      console.error('Could not integrate due to variable not being integrable');
      return Formula.constant(0);
    }
    return Formula.div(lhs.getIntegralFormula(stack), rhs);
  }
  if (hasVariable(rhs)) {
    // ∫k/g(x) dx is `k·ln(g(x))` only when g is the bare variable — otherwise
    // the chain rule contributes a factor the substitution stack can't supply.
    if (!isPlainVariable(rhs)) {
      console.error('Could not integrate k/f(x): closed form needs a bare variable denominator');
      return Formula.constant(0);
    }
    return Formula.mul(lhs, Formula.ln(rhs));
  }
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

function internalInvertIntegralLog10(value: DecimalSource, lhs: FormulaSource) {
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
      inputs: [lhs.getIntegralFormula(stack)],
      evaluate: internalIntegrateLog10,
      invert: internalInvertIntegralLog10,
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

function internalInvertIntegralLog(value: DecimalSource, lhs: FormulaSource, rhs: FormulaSource) {
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
      inputs: [lhs.getIntegralFormula(stack), rhs],
      evaluate: internalIntegrateLog,
      invert: internalInvertIntegralLog,
    });
  }
  console.error('Could not integrate due to no input being a variable');
  return Formula.constant(0);
}

export const invertLog2 = makeUnaryInvert((v) => Decimal.pow(2, v));

function internalIntegrateLog2(lhs: DecimalSource) {
  return Decimal.ln(lhs).sub(1).mul(lhs).div(Decimal.ln(2));
}

function internalInvertIntegralLog2(value: DecimalSource, lhs: FormulaSource) {
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
      inputs: [lhs.getIntegralFormula(stack)],
      evaluate: internalIntegrateLog2,
      invert: internalInvertIntegralLog2,
    });
  }
  console.error('Could not integrate due to no input being a variable');
  return Formula.constant(0);
}

export const invertLn = makeUnaryInvert(Decimal.exp);

function internalIntegrateLn(lhs: DecimalSource) {
  return Decimal.ln(lhs).sub(1).mul(lhs);
}

function internalInvertIntegralLn(value: DecimalSource, lhs: FormulaSource) {
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
      inputs: [lhs.getIntegralFormula(stack)],
      evaluate: internalIntegrateLn,
      invert: internalInvertIntegralLn,
    });
  }
  console.error('Could not integrate due to no input being a variable');
  return Formula.constant(0);
}

// === POWERS ===

export const invertPow = makeBinaryInvert(
  (value, other) => Decimal.root(value, other),
  (value, other) => Decimal.ln(value).div(Decimal.ln(other)),
);

export const integratePow = makeBinaryIntegrate(
  (x, other) => {
    const pow = Formula.add(other, 1);
    return Formula.pow(x, pow).div(pow);
  },
  (x, other) => Formula.pow(other, x).div(Formula.ln(other)),
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
  (x, other) => Formula.pow(other, x).div(Formula.ln(other)),
  (x, other) => {
    const denominator = Formula.add(other, 1);
    return Formula.pow(x, denominator).div(denominator);
  },
);

export const invertRoot = makeBinaryInvert(
  (value, other) => Decimal.root(value, Decimal.recip(other)),
  (value, other) => Decimal.ln(other).div(Decimal.ln(value)),
);

export function integrateRoot(stack: SubstitutionStack, lhs: FormulaSource, rhs: FormulaSource) {
  if (hasVariable(lhs)) {
    if (!lhs.isIntegrable()) {
      console.error('Could not integrate due to variable not being integrable');
      return Formula.constant(0);
    }
    const x = lhs.getIntegralFormula(stack);
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
    const solved = findCrossing((b) => tetrate(b, heightValue, payloadValue), value, { lower: 1 });
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
    const solved = findCrossing((b) => iteratedexp(b, heightValue, payloadValue), value, {
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
      invert: passthrough as InvertFunction<[FormulaSource, FormulaSource]>,
    });
}
