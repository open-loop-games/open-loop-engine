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
    console.error('Could not invert due to no input being a variable');
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
    console.error('Could not invert due to no input being a variable');
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
    console.error('Could not invert due to no input being a variable');
    return 0;
  }
  return variable.invert(value);
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
        console.error('Could not invert integrateAdd: integral lhs is not invertible');
        return 0;
      }
      const F = F_input as InvertibleFormula;
      // Coarse bracket from F⁻¹(target) (the answer if c=0). Expansion via
      // geometric ×2 — 32 doublings cover 2^32, far beyond any sane target.
      let hi = Decimal.fromValue(F.invert(target));
      let lo = Decimal.fromValue(0);
      for (let i = 0; i < 32; i++) {
        const v = Decimal.add(F.evaluate(hi), Decimal.mul(c, hi));
        if (Decimal.gte(v, target)) break;
        hi = Decimal.add(Decimal.mul(hi, 2), 1);
      }
      // Binary search — fixed 30 iterations. No eq_tolerance early-out: at
      // tetration scale, a relative-tolerance early-out can fire when `mid` is
      // still far from truth in level-space (large dv/dx amplifies value diff
      // for small mid diff, making the value "close" while mid is not).
      for (let i = 0; i < 30; i++) {
        const mid = Decimal.div(Decimal.add(lo, hi), 2);
        const v = Decimal.add(F.evaluate(mid), Decimal.mul(c, mid));
        if (Decimal.lt(v, target)) lo = mid;
        else hi = mid;
      }
      return Decimal.div(Decimal.add(lo, hi), 2);
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
        console.error('Could not invert integrateSub: integral lhs is not invertible');
        return 0;
      }
      const F = F_input as InvertibleFormula;
      const compute = (x: DecimalSource): DecimalSource => {
        const cx = Decimal.mul(c, x);
        return variableOnLhs ? Decimal.sub(F.evaluate(x), cx) : Decimal.sub(cx, F.evaluate(x));
      };
      let hi = Decimal.fromValue(F.invert(variableOnLhs ? target : Decimal.neg(target)));
      let lo = Decimal.fromValue(0);
      for (let i = 0; i < 32; i++) {
        if (Decimal.gte(compute(hi), target)) break;
        hi = Decimal.add(Decimal.mul(hi, 2), 1);
      }
      // No eq_tolerance early-out — see integrateAdd's bisection rationale.
      for (let i = 0; i < 30; i++) {
        const mid = Decimal.div(Decimal.add(lo, hi), 2);
        const v = compute(mid);
        if (Decimal.lt(v, target)) lo = mid;
        else hi = mid;
      }
      return Decimal.div(Decimal.add(lo, hi), 2);
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
  (x, other) => Formula.times(x, other),
  (x, other) => Formula.times(x, other),
);

export const applySubstitutionMul = makeBinarySubstitution((value, other) =>
  Formula.div(value, other),
);

export const invertDiv = makeBinaryInvert(
  (value, other) => Decimal.mul(value, other),
  (value, other) => Decimal.div(other, value),
);

export const integrateDiv = makeBinaryIntegrate(
  (x, other) => Formula.div(x, other),
  (x, other) => Formula.div(other, x),
);

export const applySubstitutionDiv = makeBinarySubstitution((value, other) =>
  Formula.mul(value, other),
);

// === RECIPROCAL ===

export const invertRecip = makeUnaryInvert(Decimal.recip);
export const integrateRecip = makeUnaryIntegrate((x) => Formula.ln(x));

// === LOGARITHMS ===

export const invertLog10 = makeUnaryInvert(Decimal.pow10);

function internalIntegrateLog10(lhs: DecimalSource) {
  return Decimal.ln(lhs).sub(1).times(lhs).div(ln10);
}

function internalInvertIntegralLog10(value: DecimalSource, lhs: FormulaSource) {
  if (hasVariable(lhs)) {
    const numerator = ln10.times(value);
    return lhs.invert(numerator.div(numerator.div(Math.E).lambertw()));
  }
  console.error('Could not invert due to no input being a variable');
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
  return Decimal.ln(lhs).sub(1).times(lhs).div(Decimal.ln(rhs));
}

function internalInvertIntegralLog(value: DecimalSource, lhs: FormulaSource, rhs: FormulaSource) {
  if (hasVariable(lhs)) {
    const numerator = Decimal.ln(unrefFormulaSource(rhs)).times(value);
    return lhs.invert(numerator.div(numerator.div(Math.E).lambertw()));
  }
  console.error('Could not invert due to no input being a variable');
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
  return Decimal.ln(lhs).sub(1).times(lhs).div(Decimal.ln(2));
}

function internalInvertIntegralLog2(value: DecimalSource, lhs: FormulaSource) {
  if (hasVariable(lhs)) {
    const numerator = Decimal.ln(2).times(value);
    return lhs.invert(numerator.div(numerator.div(Math.E).lambertw()));
  }
  console.error('Could not invert due to no input being a variable');
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
  return Decimal.ln(lhs).sub(1).times(lhs);
}

function internalInvertIntegralLn(value: DecimalSource, lhs: FormulaSource) {
  if (hasVariable(lhs)) {
    return lhs.invert(Decimal.div(value, new Decimal(Decimal.div(value, Math.E)).lambertw()));
  }
  console.error('Could not invert due to no input being a variable');
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

export const invertPow10 = makeUnaryInvert((v) => Decimal.root(v, 10));

export const integratePow10 = makeUnaryIntegrate((x) => Formula.pow10(x).div(Formula.ln(10)));

export const invertPowBase = makeBinaryInvert(
  (value, other) => Decimal.ln(value).div(Decimal.ln(other)),
  (value, other) => Decimal.root(other, value),
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
    return Formula.pow(x, Formula.recip(rhs).add(1)).times(rhs).div(Formula.add(rhs, 1));
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
  _height: FormulaSource,
  _payload: FormulaSource,
) {
  if (hasVariable(base)) {
    return base.invert(Decimal.ssqrt(value));
  }
  console.error('Could not invert due to no input being a variable');
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
  _payload: FormulaSource,
) {
  if (hasVariable(lhs)) {
    return lhs.invert(
      Decimal.iteratedlog(
        value,
        Math.E,
        Decimal.minabs(1e308, unrefFormulaSource(height)).toNumber(),
      ),
    );
  }
  console.error('Could not invert due to no input being a variable');
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
    return lhs.invert(
      Decimal.tetrate(value, Decimal.minabs(1e308, unrefFormulaSource(rhs)).toNumber()),
    );
  }
  console.error('Could not invert due to no input being a variable');
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
  _base: FormulaSource,
) {
  if (hasVariable(lhs)) {
    return lhs.invert(
      Decimal.layeradd(value, Decimal.minabs(1e308, unrefFormulaSource(diff)).negate().toNumber()),
    );
  }
  console.error('Could not invert due to no input being a variable');
  return 0;
}

export const invertLambertw = makeUnaryInvert((v) => Decimal.pow(Math.E, v).times(v));
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
    .times(x)
    .add(Formula.sqrt(Formula.sub(1, Formula.pow(x, 2)))),
);

export const invertAcos = makeUnaryInvert(Decimal.cos);
export const integrateAcos = makeUnaryIntegrate((x) =>
  Formula.acos(x)
    .times(x)
    .sub(Formula.sqrt(Formula.sub(1, Formula.pow(x, 2)))),
);

export const invertAtan = makeUnaryInvert(Decimal.tan);
export const integrateAtan = makeUnaryIntegrate((x) =>
  Formula.atan(x)
    .times(x)
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
  Formula.asinh(x).times(x).sub(Formula.pow(x, 2).add(1).sqrt()),
);

export const invertAcosh = makeUnaryInvert(Decimal.cosh);
export const integrateAcosh = makeUnaryIntegrate((x) =>
  Formula.acosh(x)
    .times(x)
    .sub(Formula.add(x, 1).sqrt().times(Formula.sub(x, 1).sqrt())),
);

export const invertAtanh = makeUnaryInvert(Decimal.tanh);
export const integrateAtanh = makeUnaryIntegrate((x) =>
  Formula.atanh(x)
    .times(x)
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
