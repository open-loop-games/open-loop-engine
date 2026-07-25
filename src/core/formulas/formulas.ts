/**
 * Formula system — invertible, integrable cost and scaling functions
 *
 * Formulas are composable math expressions that support three operations:
 * - **Evaluate**: compute the output for a given input (e.g., cost at level N)
 * - **Invert**: find the input that produces a given output ("how many can I afford?")
 * - **Integrate**: compute cumulative cost over a range (bulk purchase pricing)
 *
 * Build formulas by chaining operations on a variable:
 * ```ts
 * const cost = Formula.variable(level).pow(2).mul(10).add(100);
 * cost.evaluate(5);   // 10 * 5^2 + 100 = 350
 * cost.invert(350);   // ≈ 5
 * ```
 *
 * For consumer-facing affordability, see {@link calculateMaxAffordable} and {@link calculateCost}.
 * Ported from Profectus/TMG with significant refactoring.
 */

import { NonPersistent } from '../persistence';
import type { Resource } from '../resource';
import { Decimal, format, toNumber } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import { processGetter, type Computable } from '../computed';
import { profile, profileStart, profileEnd } from '../profiler';
import { computed, ref, unref, type MaybeRef } from 'vue';
import * as ops from './operations';
import {
  captureInversionFailures,
  inversionTolerance,
  landsOnTarget,
  reportInversionFailure,
  type Inversion,
} from './inversion';
import { findFirstPassage, type FirstPassageOptions, type Passage } from './passage';
import type {
  EvaluateFunction,
  FormulaOptions,
  FormulaSource,
  GeneralFormulaOptions,
  GenericFormula,
  IntegrableFormula,
  IntegrateFunction,
  FormulaProperties,
  InvertFunction,
  InvertibleFormula,
  InvertibleIntegralFormula,
  SubstitutionFunction,
  SubstitutionStack,
} from './types';

/** Type guard for Formula instances. Use this over `instanceof Formula` at call sites that don't already import the class. */
export function isFormula(value: unknown): value is GenericFormula {
  return value instanceof Formula;
}

/** Check if a formula source contains exactly one variable (required for inversion) */
export function hasVariable(value: FormulaSource): value is InvertibleFormula {
  return value instanceof Formula && value.hasVariable();
}

/** Evaluate a FormulaSource to a DecimalSource — unwraps refs and evaluates formulas */
export function unrefFormulaSource(value: FormulaSource, variable?: DecimalSource) {
  return value instanceof Formula ? value.evaluate(variable) : (unref(value) as DecimalSource);
}

function integrateVariable(this: GenericFormula) {
  return F.pow(this, 2).div(2);
}

function integrateVariableInner(this: GenericFormula) {
  return this;
}

// === DYNAMIC OP TYPES ===

/** Signature of a one-argument formula op (e.g. `F.neg`, `F.log10`). */
export type UnaryFormulaOp = (value: FormulaSource) => GenericFormula;
/** Signature of a two-argument formula op (e.g. `F.add`, `F.pow`). */
export type BinaryFormulaOp = (value: FormulaSource, other: FormulaSource) => GenericFormula;

/** Instance-side signature of a unary op (`formula.neg()`). */
export type UnaryFormulaInstanceOp = () => GenericFormula;
/** Instance-side signature of a binary op (`formula.add(other)`). */
export type BinaryFormulaInstanceOp = (other: FormulaSource) => GenericFormula;

/**
 * Type of the static methods `registerOps` adds to {@link F}. Each property is
 * either a {@link UnaryFormulaOp} or a {@link BinaryFormulaOp}; the aliases
 * (`add`/`plus`, `mul`/`multiply`/`times`, …) point at the same operation.
 */
export interface FormulaStaticOps {
  // Unary
  neg: UnaryFormulaOp;
  negate: UnaryFormulaOp;
  negated: UnaryFormulaOp;
  sign: UnaryFormulaOp;
  sgn: UnaryFormulaOp;
  round: UnaryFormulaOp;
  floor: UnaryFormulaOp;
  ceil: UnaryFormulaOp;
  trunc: UnaryFormulaOp;
  abs: UnaryFormulaOp;
  recip: UnaryFormulaOp;
  reciprocal: UnaryFormulaOp;
  reciprocate: UnaryFormulaOp;
  pLog10: UnaryFormulaOp;
  absLog10: UnaryFormulaOp;
  log10: UnaryFormulaOp;
  log2: UnaryFormulaOp;
  ln: UnaryFormulaOp;
  pow10: UnaryFormulaOp;
  exp: UnaryFormulaOp;
  factorial: UnaryFormulaOp;
  gamma: UnaryFormulaOp;
  lngamma: UnaryFormulaOp;
  sin: UnaryFormulaOp;
  cos: UnaryFormulaOp;
  tan: UnaryFormulaOp;
  asin: UnaryFormulaOp;
  acos: UnaryFormulaOp;
  atan: UnaryFormulaOp;
  sinh: UnaryFormulaOp;
  cosh: UnaryFormulaOp;
  tanh: UnaryFormulaOp;
  asinh: UnaryFormulaOp;
  acosh: UnaryFormulaOp;
  atanh: UnaryFormulaOp;
  // Binary
  add: BinaryFormulaOp;
  plus: BinaryFormulaOp;
  sub: BinaryFormulaOp;
  subtract: BinaryFormulaOp;
  minus: BinaryFormulaOp;
  mul: BinaryFormulaOp;
  multiply: BinaryFormulaOp;
  times: BinaryFormulaOp;
  div: BinaryFormulaOp;
  divide: BinaryFormulaOp;
  divideBy: BinaryFormulaOp;
  dividedBy: BinaryFormulaOp;
  log: BinaryFormulaOp;
  logarithm: BinaryFormulaOp;
  pow: BinaryFormulaOp;
  pow_base: BinaryFormulaOp;
  root: BinaryFormulaOp;
}

/**
 * Instance-side mirror of {@link FormulaStaticOps} — the methods `registerOps`
 * adds to `Formula.prototype`. Merged into the {@link Formula} class via
 * declaration merging so `formula.add(other)` type-checks without an `any`
 * escape hatch.
 */
export interface FormulaInstanceOps {
  // Unary
  neg: UnaryFormulaInstanceOp;
  negate: UnaryFormulaInstanceOp;
  negated: UnaryFormulaInstanceOp;
  sign: UnaryFormulaInstanceOp;
  sgn: UnaryFormulaInstanceOp;
  round: UnaryFormulaInstanceOp;
  floor: UnaryFormulaInstanceOp;
  ceil: UnaryFormulaInstanceOp;
  trunc: UnaryFormulaInstanceOp;
  abs: UnaryFormulaInstanceOp;
  recip: UnaryFormulaInstanceOp;
  reciprocal: UnaryFormulaInstanceOp;
  reciprocate: UnaryFormulaInstanceOp;
  pLog10: UnaryFormulaInstanceOp;
  absLog10: UnaryFormulaInstanceOp;
  log10: UnaryFormulaInstanceOp;
  log2: UnaryFormulaInstanceOp;
  ln: UnaryFormulaInstanceOp;
  pow10: UnaryFormulaInstanceOp;
  exp: UnaryFormulaInstanceOp;
  factorial: UnaryFormulaInstanceOp;
  gamma: UnaryFormulaInstanceOp;
  lngamma: UnaryFormulaInstanceOp;
  sin: UnaryFormulaInstanceOp;
  cos: UnaryFormulaInstanceOp;
  tan: UnaryFormulaInstanceOp;
  asin: UnaryFormulaInstanceOp;
  acos: UnaryFormulaInstanceOp;
  atan: UnaryFormulaInstanceOp;
  sinh: UnaryFormulaInstanceOp;
  cosh: UnaryFormulaInstanceOp;
  tanh: UnaryFormulaInstanceOp;
  asinh: UnaryFormulaInstanceOp;
  acosh: UnaryFormulaInstanceOp;
  atanh: UnaryFormulaInstanceOp;
  // Binary
  add: BinaryFormulaInstanceOp;
  plus: BinaryFormulaInstanceOp;
  sub: BinaryFormulaInstanceOp;
  subtract: BinaryFormulaInstanceOp;
  minus: BinaryFormulaInstanceOp;
  mul: BinaryFormulaInstanceOp;
  multiply: BinaryFormulaInstanceOp;
  times: BinaryFormulaInstanceOp;
  div: BinaryFormulaInstanceOp;
  divide: BinaryFormulaInstanceOp;
  divideBy: BinaryFormulaInstanceOp;
  dividedBy: BinaryFormulaInstanceOp;
  log: BinaryFormulaInstanceOp;
  logarithm: BinaryFormulaInstanceOp;
  pow: BinaryFormulaInstanceOp;
  pow_base: BinaryFormulaInstanceOp;
  root: BinaryFormulaInstanceOp;
}

// === OPERATION DESCRIPTOR TABLES ===

type OpDescriptor = {
  evaluate: (...args: any[]) => any;
  invert?: (...args: any[]) => any;
  integrate?: (...args: any[]) => any;
  integrateInner?: (...args: any[]) => any;
  applySubstitution?: (...args: any[]) => any;
  aliases?: string[];
};

const unaryOps: Record<string, OpDescriptor> = {
  neg: {
    evaluate: Decimal.neg,
    invert: ops.invertNeg,
    integrate: ops.integrateNeg,
    applySubstitution: ops.applySubstitutionNeg,
    aliases: ['negate', 'negated'],
  },
  sign: { evaluate: Decimal.sign, aliases: ['sgn'] },
  round: { evaluate: Decimal.round, invert: ops.invertPassthrough },
  floor: { evaluate: Decimal.floor, invert: ops.invertPassthrough },
  ceil: { evaluate: Decimal.ceil, invert: ops.invertPassthrough },
  trunc: { evaluate: Decimal.trunc, invert: ops.invertPassthrough },
  abs: { evaluate: Decimal.abs },
  recip: {
    evaluate: Decimal.recip,
    invert: ops.invertRecip,
    integrate: ops.integrateRecip,
    aliases: ['reciprocal', 'reciprocate'],
  },
  pLog10: { evaluate: Decimal.pLog10 },
  absLog10: { evaluate: Decimal.absLog10 },
  log10: { evaluate: Decimal.log10, invert: ops.invertLog10, integrate: ops.integrateLog10 },
  log2: { evaluate: Decimal.log2, invert: ops.invertLog2, integrate: ops.integrateLog2 },
  ln: { evaluate: Decimal.ln, invert: ops.invertLn, integrate: ops.integrateLn },
  pow10: { evaluate: Decimal.pow10, invert: ops.invertPow10, integrate: ops.integratePow10 },
  exp: { evaluate: Decimal.exp, invert: ops.invertExp, integrate: ops.integrateExp },
  factorial: { evaluate: Decimal.factorial },
  gamma: { evaluate: Decimal.gamma },
  lngamma: { evaluate: Decimal.lngamma },
  // `invertX` means "the inverse of X" — so each op binds its like-named
  // invert. Upstream crossed the whole block (`sin` bound `invertAsin`, whose
  // body is `Decimal.sin`), which applied the op twice instead of undoing it.
  sin: { evaluate: Decimal.sin, invert: ops.invertSin, integrate: ops.integrateSin },
  cos: { evaluate: Decimal.cos, invert: ops.invertCos, integrate: ops.integrateCos },
  tan: { evaluate: Decimal.tan, invert: ops.invertTan, integrate: ops.integrateTan },
  asin: { evaluate: Decimal.asin, invert: ops.invertAsin, integrate: ops.integrateAsin },
  acos: { evaluate: Decimal.acos, invert: ops.invertAcos, integrate: ops.integrateAcos },
  atan: { evaluate: Decimal.atan, invert: ops.invertAtan, integrate: ops.integrateAtan },
  sinh: { evaluate: Decimal.sinh, invert: ops.invertSinh, integrate: ops.integrateSinh },
  cosh: { evaluate: Decimal.cosh, invert: ops.invertCosh, integrate: ops.integrateCosh },
  tanh: { evaluate: Decimal.tanh, invert: ops.invertTanh, integrate: ops.integrateTanh },
  asinh: { evaluate: Decimal.asinh, invert: ops.invertAsinh, integrate: ops.integrateAsinh },
  acosh: { evaluate: Decimal.acosh, invert: ops.invertAcosh, integrate: ops.integrateAcosh },
  atanh: { evaluate: Decimal.atanh, invert: ops.invertAtanh, integrate: ops.integrateAtanh },
};

const binaryOps: Record<string, OpDescriptor> = {
  add: {
    evaluate: Decimal.add,
    invert: ops.invertAdd,
    integrate: ops.integrateAdd,
    integrateInner: ops.integrateInnerAdd,
    applySubstitution: ops.passthrough,
    aliases: ['plus'],
  },
  sub: {
    evaluate: Decimal.sub,
    invert: ops.invertSub,
    integrate: ops.integrateSub,
    integrateInner: ops.integrateInnerSub,
    applySubstitution: ops.passthrough,
    aliases: ['subtract', 'minus'],
  },
  mul: {
    evaluate: Decimal.mul,
    invert: ops.invertMul,
    integrate: ops.integrateMul,
    applySubstitution: ops.applySubstitutionMul,
    aliases: ['multiply', 'times'],
  },
  div: {
    evaluate: Decimal.div,
    invert: ops.invertDiv,
    integrate: ops.integrateDiv,
    applySubstitution: ops.applySubstitutionDiv,
    aliases: ['divide', 'divideBy', 'dividedBy'],
  },
  log: {
    evaluate: Decimal.log,
    invert: ops.invertLog,
    integrate: ops.integrateLog,
    aliases: ['logarithm'],
  },
  pow: { evaluate: Decimal.pow, invert: ops.invertPow, integrate: ops.integratePow },
  pow_base: {
    evaluate: (value: DecimalSource, base: DecimalSource) => Decimal.pow(base, value),
    invert: ops.invertPowBase,
    integrate: ops.integratePowBase,
  },
  root: { evaluate: Decimal.root, invert: ops.invertRoot, integrate: ops.integrateRoot },
};

// === FORMULA CLASS ===

/**
 * A composable math expression that supports forward evaluation, backward
 * inversion, and cumulative integration.
 *
 * **Building formulas**: chain operations on a variable or constant:
 * ```ts
 * const cost = Formula.variable(level).mul(10).add(5);  // 10x + 5
 * const gain = Formula.variable(points).div(100).sqrt(); // √(x/100)
 * ```
 *
 * **Capabilities**: not all operations are invertible or integrable. Use
 * `formula.isInvertible()` / `formula.isIntegrable()` to check at runtime,
 * or {@link findNonInvertible} to debug which operation breaks the chain.
 *
 * @see {@link calculateMaxAffordable} for bulk purchase affordability
 * @see {@link calculateCost} for total cost of N purchases
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
class Formula<T extends [FormulaSource] | FormulaSource[] = FormulaSource[]> {
  readonly inputs: T;

  protected readonly internalEvaluate: EvaluateFunction<T> | undefined;
  protected readonly internalInvert: InvertFunction<T> | undefined;
  protected readonly internalIntegrate: IntegrateFunction<T> | undefined;
  protected readonly internalIntegrateInner: IntegrateFunction<T> | undefined;
  protected readonly applySubstitution: SubstitutionFunction<T> | undefined;
  protected readonly description: string | undefined;
  protected readonly internalVariables: number;

  public readonly innermostVariable: MaybeRef<DecimalSource> | undefined;

  private integralFormula: GenericFormula | undefined;

  constructor(options: FormulaOptions<T>) {
    let readonlyProperties: FormulaProperties<T>;
    if ('inputs' in options) {
      options.inputs = options.inputs.map((input) =>
        typeof input === 'object' && NonPersistent in input ? input[NonPersistent] : input,
      ) as T | [FormulaSource];
    }
    if ('variable' in options) {
      if (typeof options.variable === 'object' && NonPersistent in options.variable) {
        options.variable = options.variable[NonPersistent] as MaybeRef<DecimalSource>;
      }
      readonlyProperties = this.setupVariable(options);
    } else if (!('evaluate' in options)) {
      readonlyProperties = this.setupConstant(options);
    } else {
      readonlyProperties = this.setupFormula(options);
    }
    this.inputs = readonlyProperties.inputs;
    this.internalVariables = readonlyProperties.internalVariables;
    this.innermostVariable = readonlyProperties.innermostVariable;
    this.internalEvaluate = readonlyProperties.internalEvaluate;
    this.internalInvert = readonlyProperties.internalInvert;
    this.internalIntegrate = readonlyProperties.internalIntegrate;
    this.internalIntegrateInner = readonlyProperties.internalIntegrateInner;
    this.applySubstitution = readonlyProperties.applySubstitution;
    this.description = options.description;
  }

  private setupVariable({ variable }: { variable: MaybeRef<DecimalSource> }): FormulaProperties<T> {
    return {
      inputs: [variable] as T,
      internalVariables: 1,
      innermostVariable: variable,
      internalIntegrate: integrateVariable,
      internalIntegrateInner: integrateVariableInner,
      applySubstitution: ops.passthrough as unknown as SubstitutionFunction<T>,
    };
  }

  private setupConstant({ inputs }: { inputs: [FormulaSource] }): FormulaProperties<T> {
    if (inputs.length !== 1) {
      console.error('Evaluate function is required if inputs is not length 1');
    }
    return {
      inputs: inputs as T,
      internalVariables: 0,
    };
  }

  private setupFormula(options: GeneralFormulaOptions<T>): FormulaProperties<T> {
    const { inputs, evaluate, invert, integrate, integrateInner, applySubstitution } = options;
    const numVariables = inputs.reduce<number>(
      (acc, input) => acc + (input instanceof Formula ? input.internalVariables : 0),
      0,
    );
    const variable = inputs.find((input) => input instanceof Formula && input.hasVariable()) as
      | GenericFormula
      | undefined;

    const innermostVariable = numVariables === 1 ? variable?.innermostVariable : undefined;

    const invertible = variable?.isInvertible() ?? false;
    const integrable = variable?.isIntegrable() ?? false;

    return {
      inputs,
      internalEvaluate: evaluate,
      internalInvert: invertible ? invert : undefined,
      internalIntegrate: integrable ? integrate : undefined,
      internalIntegrateInner: integrateInner,
      applySubstitution,
      innermostVariable,
      internalVariables: numVariables,
    };
  }

  // === TYPE PREDICATES ===

  /**
   * Whether this *chain* has an inverse — every op in it binds one, and there
   * is exactly one variable to solve for.
   *
   * Chain capability only. It deliberately says nothing about whether inverting
   * a *particular target* is sound, because that isn't a property of the chain:
   * a curve ending in `.floor()` inverts exactly for integer targets and has no
   * pre-image at all for 3.5. For that question use {@link tryInvert}, which
   * grades the answer against the target it was given.
   */
  isInvertible(): this is InvertibleFormula {
    return this.hasVariable() && (this.internalInvert != null || this.internalEvaluate == null);
  }

  isIntegrable(): this is IntegrableFormula {
    return this.hasVariable() && this.internalIntegrate != null;
  }

  isIntegralInvertible(): this is InvertibleIntegralFormula {
    if (!this.isIntegrable()) return false;
    return this.getIntegralFormula().isInvertible();
  }

  hasVariable(): boolean {
    return this.internalVariables === 1;
  }

  // === CORE EVALUATION ===

  evaluate(variable?: DecimalSource): DecimalSource {
    // Arity-switched dispatch: every formula eval used to allocate an args
    // array via `inputs.map(...)` plus a spread. For a 3-level exponential
    // cost formula (Formula.exponential → mul → pow_base → variable), that's
    // 2 array allocations every call × every purchasable × every tick. The
    // 1/2/3-input fast paths cover every op in the table; the default branch
    // handles the rare >3-input ops (tetrate/iteratedexp/pentate/clamp).
    const fn = this.internalEvaluate as
      | ((...args: DecimalSource[]) => DecimalSource | null | undefined)
      | undefined;
    const inputs = this.inputs;
    if (fn !== undefined) {
      let result: DecimalSource | null | undefined;
      switch (inputs.length) {
        case 1:
          result = fn.call(this, unrefFormulaSource(inputs[0], variable));
          break;
        case 2:
          result = fn.call(
            this,
            unrefFormulaSource(inputs[0], variable),
            unrefFormulaSource(inputs[1], variable),
          );
          break;
        case 3:
          result = fn.call(
            this,
            unrefFormulaSource(inputs[0], variable),
            unrefFormulaSource(inputs[1], variable),
            unrefFormulaSource(inputs[2], variable),
          );
          break;
        default: {
          const args = inputs.map((input) => unrefFormulaSource(input, variable));
          result = fn.apply(this, args);
        }
      }
      if (result != null) return result;
    }
    return (this.hasVariable() ? variable : null) ?? unrefFormulaSource(inputs[0]);
  }

  /**
   * Algebraic pre-image: the input this formula maps to `value`.
   *
   * Unchecked by design — this is the shape the op table composes with
   * recursively, and it returns the algebra's answer whether or not that answer
   * is reachable. When the target may lie outside the formula's image (anything
   * with an interior `.floor()`, a `step`/`if` splice, or a `min`/`max`/`clamp`)
   * use {@link tryInvert}, which grades the answer.
   *
   * Reports and returns `0` when no inverse exists at all.
   */
  invert(value: DecimalSource): DecimalSource {
    if (this.internalInvert && this.hasVariable()) {
      return this.internalInvert.call(this, value, ...this.inputs);
    } else if (this.inputs.length === 1 && this.internalEvaluate == null && this.hasVariable()) {
      // A bare variable is its own inverse. The guard has to include
      // `internalEvaluate == null` or it also catches the unary ops that bind no
      // invert (`sign`, `abs`, `factorial`, …) and answers `value` for them —
      // formulas whose own `isInvertible()` correctly reports false. Matches the
      // condition `getIntegralFormula` already uses for the same case.
      return value;
    }
    reportInversionFailure('not-invertible', 'Cannot invert non-invertible formula');
    return 0;
  }

  /**
   * Invert `value` and say whether the answer is usable — the checked
   * counterpart to {@link invert}.
   *
   * Runs the algebra, then evaluates the candidate forward: an inverse is only
   * meaningful if it maps back onto the target. That one check covers every way
   * an inversion goes quietly wrong — a fractional target through an interior
   * `.floor()`, a target inside a `step` splice's jump discontinuity, a
   * saturated `clamp` — because they are all the same failure, a target outside
   * the function's image.
   *
   * @param value - The output to solve for.
   * @param tolerance - Relative tolerance for the image check. Defaults to
   *   {@link inversionTolerance} at `value`'s magnitude, which relaxes past
   *   layer 0 because the representation cannot do better there.
   * @returns An {@link Inversion}: `exact`, `outside-image` (with the value it
   *   does reach), or a failure reason with no value.
   *
   * @example
   * ```ts
   * const xpToLevel = Formula.variable(xp).div(50).sqrt().floor();
   * xpToLevel.tryInvert(3);    // { value: 450, reason: 'exact' }
   * xpToLevel.tryInvert(3.5);  // { value: 450, reason: 'outside-image', evaluatesTo: 3 }
   * ```
   */
  tryInvert(value: DecimalSource, tolerance?: number): Inversion {
    return this.gradeInversion(value, (target) => this.invert(target), tolerance);
  }

  /**
   * Smallest input at which this formula *reaches* `target` — the question a
   * time axis asks, as opposed to the algebraic pre-image {@link invert} answers.
   *
   * Searches the forward function rather than running the op table backward, so
   * it stays correct through the rounding and splicing that make an algebraic
   * inverse unsound: an interior `.floor()`, a `step` whose modifier jumps at the
   * breakpoint, a saturated `clamp`. For the same reason it needs no inverse at
   * all — a chain reporting `isInvertible() === false` still answers here.
   *
   * Reach for {@link invert} / {@link tryInvert} when you want the input that
   * *maps to* the target (the XP at which a level begins); reach for this when
   * you want the input at which the target is *first met* (when the burn
   * overtakes production, when a wave breaches the wall).
   *
   * The curve must be non-decreasing over the search domain. Where it isn't, the
   * two cases that would otherwise return a plausible number report
   * `not-monotone` instead.
   *
   * @param target - The value to reach.
   * @param options - Domain bounds. See {@link FirstPassageOptions}.
   * @returns A {@link Passage}: `crossed`, `already-reached` at the domain floor,
   *   or a reason with no value.
   *
   * @example
   * ```ts
   * // Burn steps ×g every Tg seconds — an interior floor, so the algebra
   * // lands mid-step while the player crosses at the boundary.
   * const burn = F.variable(0).div(15).floor().add(0.5).pow_base(2).mul(b0);
   * burn.invert(pMax);          // 37.5 — inside a step nothing evaluates into
   * burn.firstPassage(pMax);    // { value: 45, reason: 'crossed' }
   * ```
   */
  firstPassage(target: DecimalSource, options?: FirstPassageOptions): Passage {
    return findFirstPassage((x) => this.evaluate(x), target, options);
  }

  /**
   * Invert this formula's integral and say whether the answer is usable — the
   * checked counterpart to {@link invertIntegral}, graded the same way
   * {@link tryInvert} grades a forward inversion.
   */
  tryInvertIntegral(value: DecimalSource, tolerance?: number): Inversion {
    return this.gradeInversion(value, (target) => this.invertIntegral(target), tolerance, true);
  }

  /**
   * Shared body of {@link tryInvert} / {@link tryInvertIntegral}: capture any
   * reported failure, then grade the candidate by mapping it forward.
   */
  private gradeInversion(
    value: DecimalSource,
    run: (target: DecimalSource) => DecimalSource,
    tolerance?: number,
    viaIntegral = false,
  ): Inversion {
    const { value: candidate, failure } = captureInversionFailures(() => run(value));
    if (failure !== null) return { value: null, reason: failure };
    const forward = viaIntegral ? this.evaluateIntegral(candidate) : this.evaluate(candidate);
    const tol = tolerance ?? inversionTolerance(value);
    if (landsOnTarget(forward, value, tol)) return { value: candidate, reason: 'exact' };
    return { value: candidate, reason: 'outside-image', evaluatesTo: forward };
  }

  evaluateIntegral(variable?: DecimalSource): DecimalSource {
    if (!this.isIntegrable()) {
      console.error('Cannot evaluate integral of formula without integral');
      return 0;
    }
    return this.getIntegralFormula().evaluate(variable);
  }

  invertIntegral(value: DecimalSource): DecimalSource {
    if (!this.isIntegrable() || !this.getIntegralFormula().isInvertible()) {
      reportInversionFailure(
        'not-invertible',
        'Cannot invert integral of formula without invertible integral',
      );
      return 0;
    }
    return (this.getIntegralFormula() as InvertibleFormula).invert(value);
  }

  calculateConstantOfIntegration() {
    const integral = this.getIntegralFormula().evaluate(1);
    const actualCost = Decimal.div(Decimal.add(this.evaluate(0), this.evaluate(1)), 2);
    return Decimal.sub(actualCost, integral);
  }

  getIntegralFormula(stack?: SubstitutionStack): GenericFormula {
    if (this.integralFormula != null && stack == null) {
      return this.integralFormula;
    }
    if (stack == null) {
      if (this.applySubstitution == null) {
        stack = [];
        if (this.internalIntegrate == null) {
          console.error('Cannot integrate formula with non-integrable operation');
          return Formula.constant(0);
        }
        let value = this.internalIntegrate.call(this, stack, ...this.inputs);
        stack.forEach((func) => (value = func(value)));
        this.integralFormula = value;
      } else {
        if (this.internalIntegrate) {
          this.integralFormula = this.internalIntegrate.call(this, undefined, ...this.inputs);
        } else if (
          this.inputs.length === 1 &&
          this.internalEvaluate == null &&
          this.hasVariable()
        ) {
          this.integralFormula = this;
        } else {
          console.error('Cannot integrate formula without variable');
          return Formula.constant(0);
        }
      }
      return this.integralFormula;
    } else {
      if (this.applySubstitution == null) {
        console.error('Cannot have two complex operations in an integrable formula');
        return Formula.constant(0);
      }
      stack.push((variable: GenericFormula) =>
        this.applySubstitution!.call(this, variable, ...this.inputs),
      );
      if (this.internalIntegrateInner) {
        return this.internalIntegrateInner.call(this, stack, ...this.inputs);
      } else if (this.internalIntegrate) {
        return this.internalIntegrate.call(this, stack, ...this.inputs);
      } else if (this.inputs.length === 1 && this.internalEvaluate == null && this.hasVariable()) {
        return this;
      } else {
        console.error('Cannot integrate formula without variable');
        return Formula.constant(0);
      }
    }
  }

  /**
   * Structural equality on the formula AST.
   *
   * Compares input arity, recursively-equal Formula inputs, Decimal-equal
   * leaf values, and `===` identity of the operation functions
   * (`internalEvaluate` / `internalInvert` / `internalIntegrate`). Equal nodes
   * share the same operation, so their `integrateInner` / `applySubstitution`
   * are also `===` by construction — those fields are not re-checked.
   * `description` is decorative and intentionally ignored.
   */
  equals(other: GenericFormula): boolean {
    return (
      this.inputs.length === other.inputs.length &&
      this.inputs.every((input, i) =>
        input instanceof Formula && other.inputs[i] instanceof Formula
          ? input.equals(other.inputs[i] as GenericFormula)
          : !(input instanceof Formula) &&
            !(other.inputs[i] instanceof Formula) &&
            Decimal.eq(unref(input), unref(other.inputs[i] as DecimalSource)),
      ) &&
      this.internalEvaluate === other.internalEvaluate &&
      this.internalInvert === other.internalInvert &&
      this.internalIntegrate === other.internalIntegrate &&
      this.internalVariables === other.internalVariables
    );
  }

  // === STATIC CONSTRUCTORS ===

  /**
   * Create a constant formula — a fixed value with no variable.
   * Constants are always invertible and integrable (they pass through).
   */
  public static constant(value: MaybeRef<DecimalSource>): InvertibleIntegralFormula {
    return new Formula({ inputs: [value] });
  }

  /**
   * Create a variable formula — the "x" in a cost function.
   *
   * Pass a reactive ref (e.g., `repeatable.amount`) to make the formula
   * evaluate against live game state. Every formula chain needs exactly
   * one variable for inversion to work.
   *
   * @example
   * ```ts
   * const level = persistent<DecimalSource>(0);
   * const cost = Formula.variable(level).pow(2).mul(10);
   * cost.evaluate();  // evaluates at current level
   * cost.invert(40);  // what level costs 40?
   * ```
   */
  public static variable(value: MaybeRef<DecimalSource>): InvertibleIntegralFormula {
    return new Formula({ variable: value });
  }

  // === COST SCALING CONSTRUCTORS ===

  /**
   * Exponential cost curve: `base * mult^x`. The canonical incremental cost scaling.
   *
   * Fully invertible and integrable — powers "buy max" via {@link calculateMaxAffordable}
   * and closed-form bulk pricing via {@link calculateCost} (no O(n) loop).
   *
   * @param variable - Level input — typically a reactive ref (e.g., `purchasable.amount`),
   *   or a raw `DecimalSource` for ad-hoc evaluation via `.evaluate(level)`.
   * @param base - Cost at level 0. Can be a ref/getter for scoped tuning.
   * @param mult - Per-level multiplier (e.g., `1.15` = +15% per level)
   *
   * @example
   * ```ts
   * const cost = Formula.exponential(purchasable.amount, 10, 1.15);
   * cost.evaluate();           // reactive — cost at current level
   * cost.invert(100);          // what level costs 100?
   * cost.evaluateIntegral(5);  // closed-form sum of costs 0..5
   * ```
   */
  public static exponential(
    variable: MaybeRef<DecimalSource>,
    base: MaybeRef<DecimalSource>,
    mult: DecimalSource,
  ): InvertibleIntegralFormula {
    return (Formula.variable(variable) as GenericFormula)
      .pow_base(mult)
      .mul(base) as InvertibleIntegralFormula;
  }

  /**
   * Linear cost curve: `base + coef * x`.
   *
   * Fully invertible and integrable. Useful for flat-step costs where each level
   * adds a constant amount.
   *
   * @param variable - Level input (ref or raw DecimalSource)
   * @param base - Cost at level 0
   * @param coef - Per-level increment
   */
  public static linear(
    variable: MaybeRef<DecimalSource>,
    base: DecimalSource,
    coef: DecimalSource,
  ): InvertibleIntegralFormula {
    return (Formula.variable(variable) as GenericFormula)
      .mul(coef)
      .add(base) as InvertibleIntegralFormula;
  }

  /**
   * Polynomial cost curve: `base * x^exp`.
   *
   * Fully invertible and integrable. Softer growth than exponential — good for
   * stat upgrades where you want noticeable-but-not-runaway scaling.
   *
   * @param variable - Level input (ref or raw DecimalSource)
   * @param base - Coefficient
   * @param exp - Exponent
   */
  public static polynomial(
    variable: MaybeRef<DecimalSource>,
    base: DecimalSource,
    exp: DecimalSource,
  ): InvertibleIntegralFormula {
    return (Formula.variable(variable) as GenericFormula)
      .pow(exp)
      .mul(base) as InvertibleIntegralFormula;
  }

  /**
   * Named exponential scaling preset — sugar over {@link Formula.exponential}.
   *
   * Presets: `'gentle'` (1.07x), `'moderate'` (1.15x), `'aggressive'` (1.30x).
   *
   * @param variable - Level input (ref or raw DecimalSource)
   * @param preset - Curve aggressiveness
   * @param base - Cost at level 0
   *
   * @example
   * ```ts
   * const cost = Formula.preset(upgrade.amount, 'moderate', 10);
   * // equivalent to Formula.exponential(upgrade.amount, 10, 1.15)
   * ```
   */
  public static preset(
    variable: MaybeRef<DecimalSource>,
    preset: 'gentle' | 'moderate' | 'aggressive',
    base: DecimalSource,
  ): InvertibleIntegralFormula {
    const mult = preset === 'gentle' ? 1.07 : preset === 'aggressive' ? 1.3 : 1.15;
    return Formula.exponential(variable, base, mult);
  }

  // === STRINGIFY ===

  public static stringify(formula: FormulaSource): string {
    if (formula instanceof Formula) {
      if (formula.description != null) return formula.description;
      if (formula.internalEvaluate == null) {
        return formula.hasVariable() ? 'x' : format(formula.inputs[0] ?? 0);
      }
      return `${formula.internalEvaluate.name}(${formula.inputs.map(Formula.stringify).join(', ')})`;
    }
    return format(unref(formula));
  }

  public stringify() {
    return Formula.stringify(this);
  }

  // === STEP & CONDITIONAL ===

  /**
   * Apply a formula transformation only above a threshold.
   *
   * Below `start`, the value passes through unchanged. Above `start`,
   * `formulaModifier` is applied to `(value - start)` and `start` is added back.
   * Useful for softcaps that only kick in past a breakpoint.
   *
   * @param value - The input formula or value
   * @param start - Threshold below which the value passes through
   * @param formulaModifier - Transformation to apply above the threshold
   */
  public static step(
    value: FormulaSource,
    start: Computable<DecimalSource>,
    formulaModifier: (value: InvertibleIntegralFormula) => GenericFormula,
  ) {
    const formula = formulaModifier(Formula.variable(0));
    const processedStart = processGetter(start);
    function evalStep(lhs: DecimalSource) {
      if (Decimal.lt(lhs, unref(processedStart))) return lhs;
      return Decimal.add(
        formula.evaluate(Decimal.sub(lhs, unref(processedStart))),
        unref(processedStart),
      );
    }
    function invertStep(value: DecimalSource, lhs: FormulaSource) {
      if (hasVariable(lhs) && formula.isInvertible()) {
        if (Decimal.gt(value, unref(processedStart))) {
          value = Decimal.add(
            formula.invert(Decimal.sub(value, unref(processedStart))),
            unref(processedStart),
          );
        }
        return lhs.invert(value);
      }
      reportInversionFailure('not-invertible', 'Could not invert due to no input being a variable');
      return 0;
    }
    return new Formula({
      inputs: [value],
      evaluate: evalStep,
      invert: formula.isInvertible() && formula.hasVariable() ? invertStep : undefined,
      description: 'indeterminate',
    });
  }

  public step(
    start: Computable<DecimalSource>,
    formulaModifier: (value: InvertibleIntegralFormula) => GenericFormula,
  ) {
    return Formula.step(this, start, formulaModifier);
  }

  /**
   * Conditionally apply a formula transformation based on a boolean.
   *
   * When `condition` is true, applies `formulaModifier`. When false, applies
   * `elseFormulaModifier` (or passes through unchanged if omitted).
   * Invertible when the active branch is invertible.
   *
   * @param value - The input formula or value
   * @param condition - Reactive boolean controlling which branch applies
   * @param formulaModifier - Transformation when condition is true
   * @param elseFormulaModifier - Transformation when condition is false (optional)
   */
  public static if(
    value: FormulaSource,
    condition: Computable<boolean>,
    formulaModifier: (value: InvertibleIntegralFormula) => GenericFormula,
    elseFormulaModifier?: (value: InvertibleIntegralFormula) => GenericFormula,
  ) {
    const lhsRef = ref<DecimalSource>(0);
    const variable = Formula.variable(lhsRef);
    const formula = formulaModifier(variable);
    const elseFormula = elseFormulaModifier?.(variable);
    const processedCondition = processGetter(condition);
    function evalStep(lhs: DecimalSource) {
      if (unref(processedCondition)) {
        lhsRef.value = lhs;
        return formula.evaluate();
      } else if (elseFormula) {
        lhsRef.value = lhs;
        return elseFormula.evaluate();
      } else {
        return lhs;
      }
    }
    function invertStep(value: DecimalSource, lhs: FormulaSource) {
      if (hasVariable(lhs)) {
        if (unref(processedCondition)) {
          if (formula.isInvertible()) {
            return lhs.invert(formula.invert(value));
          }
          reportInversionFailure(
            'not-invertible',
            'Could not invert due to no input being a variable',
          );
          return 0;
        } else if (elseFormula) {
          if (elseFormula.isInvertible()) {
            return lhs.invert(elseFormula.invert(value));
          }
          reportInversionFailure(
            'not-invertible',
            'Could not invert due to no input being a variable',
          );
          return 0;
        }
        return lhs.invert(value);
      }
      reportInversionFailure('not-invertible', 'Could not invert due to no input being a variable');
      return 0;
    }
    return new Formula({
      inputs: [value],
      evaluate: evalStep,
      invert: formula.isInvertible() && formula.hasVariable() ? invertStep : undefined,
      description: 'indeterminate',
    });
  }

  public if(
    condition: Computable<boolean>,
    formulaModifier: (value: InvertibleIntegralFormula) => GenericFormula,
    elseFormulaModifier?: (value: InvertibleIntegralFormula) => GenericFormula,
  ) {
    return Formula.if(this, condition, formulaModifier, elseFormulaModifier);
  }

  public static conditional = Formula.if;

  public conditional(
    condition: Computable<boolean>,
    formulaModifier: (value: InvertibleIntegralFormula) => GenericFormula,
    elseFormulaModifier?: (value: InvertibleIntegralFormula) => GenericFormula,
  ): GenericFormula {
    return Formula.if(this, condition, formulaModifier, elseFormulaModifier);
  }

  // === COMPOUND SHORTCUTS ===

  public static sqr(value: FormulaSource) {
    return F.pow(value, 2);
  }
  public sqr() {
    return F.pow(this, 2);
  }

  public static sqrt(value: FormulaSource) {
    return F.root(value, 2);
  }
  public sqrt() {
    return F.root(this, 2);
  }

  public static cube(value: FormulaSource) {
    return F.pow(value, 3);
  }
  public cube() {
    return F.pow(this, 3);
  }

  public static cbrt(value: FormulaSource) {
    return F.root(value, 3);
  }
  public cbrt() {
    return F.root(this, 3);
  }

  // === SPECIAL OPERATIONS ===

  public static tetrate(
    value: FormulaSource,
    height: FormulaSource = 2,
    payload: FormulaSource = Decimal.fromComponents_noNormalize(1, 0, 1),
  ) {
    return new Formula({
      inputs: [value, height, payload],
      evaluate: ops.tetrate,
      invert: ops.invertTetrate,
    });
  }

  public tetrate(
    height: FormulaSource = 2,
    payload: FormulaSource = Decimal.fromComponents_noNormalize(1, 0, 1),
  ) {
    return Formula.tetrate(this, height, payload);
  }

  public static iteratedexp(
    value: FormulaSource,
    height: FormulaSource = 2,
    payload: FormulaSource = Decimal.fromComponents_noNormalize(1, 0, 1),
  ) {
    return new Formula({
      inputs: [value, height, payload],
      evaluate: ops.iteratedexp,
      invert: ops.invertIteratedExp,
    });
  }

  public iteratedexp(
    height: FormulaSource = 2,
    payload: FormulaSource = Decimal.fromComponents_noNormalize(1, 0, 1),
  ) {
    return Formula.iteratedexp(this, height, payload);
  }

  public static iteratedlog(
    value: FormulaSource,
    base: FormulaSource = 10,
    times: FormulaSource = 1,
  ) {
    return new Formula({ inputs: [value, base, times], evaluate: ops.iteratedLog });
  }

  public iteratedlog(base: FormulaSource = 10, times: FormulaSource = 1) {
    return Formula.iteratedlog(this, base, times);
  }

  public static slog(value: FormulaSource, base: FormulaSource = 10) {
    return new Formula({ inputs: [value, base], evaluate: ops.slog, invert: ops.invertSlog });
  }

  public slog(base: FormulaSource = 10) {
    return Formula.slog(this, base);
  }

  public static layeradd10(value: FormulaSource, diff: FormulaSource) {
    return new Formula({ inputs: [value, diff], evaluate: Decimal.layeradd10 });
  }

  public layeradd10(diff: FormulaSource) {
    return Formula.layeradd10(this, diff);
  }

  public static layeradd(value: FormulaSource, diff: FormulaSource, base: FormulaSource = 10) {
    return new Formula({
      inputs: [value, diff, base],
      evaluate: ops.layeradd,
      invert: ops.invertLayeradd,
    });
  }

  public layeradd(diff: FormulaSource, base: FormulaSource = 10) {
    return Formula.layeradd(this, diff, base);
  }

  public static lambertw(value: FormulaSource) {
    return new Formula({
      inputs: [value],
      evaluate: (v: DecimalSource) => Decimal.lambertw(v, true),
      invert: ops.invertLambertw,
    });
  }

  public lambertw() {
    return Formula.lambertw(this);
  }

  public static ssqrt(value: FormulaSource) {
    return new Formula({ inputs: [value], evaluate: Decimal.ssqrt, invert: ops.invertSsqrt });
  }

  public ssqrt() {
    return Formula.ssqrt(this);
  }

  public static pentate(
    value: FormulaSource,
    height: FormulaSource = 2,
    payload: FormulaSource = Decimal.fromComponents_noNormalize(1, 0, 1),
  ) {
    return new Formula({ inputs: [value, height, payload], evaluate: ops.pentate });
  }

  public pentate(
    height: FormulaSource = 2,
    payload: FormulaSource = Decimal.fromComponents_noNormalize(1, 0, 1),
  ) {
    return Formula.pentate(this, height, payload);
  }

  // === PASSTHROUGH BINARY OPS ===

  public static max = ops.createPassthroughBinaryFormula(Decimal.max);
  public static min = ops.createPassthroughBinaryFormula(Decimal.min);
  public static minabs = ops.createPassthroughBinaryFormula(Decimal.minabs);
  public static maxabs = ops.createPassthroughBinaryFormula(Decimal.maxabs);
  public static clampMin = ops.createPassthroughBinaryFormula(Decimal.clampMin);
  public static clampMax = ops.createPassthroughBinaryFormula(Decimal.clampMax);

  public max(value: FormulaSource) {
    return Formula.max(this, value);
  }
  public min(value: FormulaSource) {
    return Formula.min(this, value);
  }
  public maxabs(value: FormulaSource) {
    return Formula.maxabs(this, value);
  }
  public minabs(value: FormulaSource) {
    return Formula.minabs(this, value);
  }
  public clampMin(value: FormulaSource) {
    return Formula.clampMin(this, value);
  }
  public clampMax(value: FormulaSource) {
    return Formula.clampMax(this, value);
  }

  public static clamp(value: FormulaSource, min: FormulaSource, max: FormulaSource) {
    return new Formula({
      inputs: [value, min, max],
      evaluate: Decimal.clamp,
      invert: ops.invertPassthrough,
    });
  }

  public clamp(min: FormulaSource, max: FormulaSource) {
    return Formula.clamp(this, min, max);
  }
}

// Declaration merging: surfaces the dynamic instance methods written to
// Formula.prototype by `registerOps` below, so `formula.add(other)` etc.
// type-check without an `any` escape hatch. The empty body + unused `T` are
// load-bearing — merging requires matching type-parameter shape with the class.
/* eslint-disable @typescript-eslint/no-empty-object-type,
                  @typescript-eslint/no-unused-vars */
interface Formula<
  T extends [FormulaSource] | FormulaSource[] = FormulaSource[],
> extends FormulaInstanceOps {}
/* eslint-enable @typescript-eslint/no-empty-object-type,
                 @typescript-eslint/no-unused-vars */

export { Formula };
export default Formula;

/**
 * Formula constructor with full static typings for dynamically-registered operations.
 *
 * Use `F` instead of `Formula` when calling table-generated statics (`F.add`, `F.pow`, etc.)
 * from outside the class body. The default export `Formula` lacks these in its static type
 * because TypeScript can't merge statics onto default exports.
 *
 * @example
 * ```ts
 * import { F } from '@open-loop/engine/core';
 * const cost = F.add(F.pow(level, 2), 100);  // level^2 + 100
 * ```
 */
export const F = Formula as typeof Formula & FormulaStaticOps;

// === REGISTER OPERATIONS ===

function registerOps(table: Record<string, OpDescriptor>, arity: 'unary' | 'binary') {
  for (const [name, desc] of Object.entries(table)) {
    const { aliases, ...formulaProps } = desc;

    if (arity === 'unary') {
      (Formula as any)[name] = (value: FormulaSource) =>
        new Formula({ inputs: [value], ...formulaProps });
    } else {
      (Formula as any)[name] = (value: FormulaSource, other: FormulaSource) =>
        new Formula({ inputs: [value, other], ...formulaProps });
    }

    // Instance method delegates to static
    const proto = Formula.prototype as any;
    if (arity === 'unary') {
      proto[name] = function (this: Formula) {
        return (Formula as any)[name](this);
      };
    } else {
      proto[name] = function (this: Formula, ...args: FormulaSource[]) {
        return (Formula as any)[name](this, ...args);
      };
    }

    // Aliases
    for (const alias of aliases ?? []) {
      (Formula as any)[alias] = (Formula as any)[name];
      proto[alias] = proto[name];
    }
  }
}

registerOps(unaryOps, 'unary');
registerOps(binaryOps, 'binary');

// === STANDALONE UTILITIES ===

/**
 * Debug helper: find the operation that breaks invertibility in a formula chain.
 *
 * Walk the formula tree and return the first node that has an evaluate function
 * but no invert function. Returns `null` if the entire chain is invertible.
 *
 * @param formula - The formula to inspect
 * @returns The non-invertible node, or `null` if fully invertible
 */
export function findNonInvertible(formula: GenericFormula): GenericFormula | null {
  if ((formula as any).internalInvert == null && (formula as any).internalEvaluate != null) {
    return formula;
  }
  for (const input of formula.inputs) {
    if (hasVariable(input)) {
      return findNonInvertible(input);
    }
  }
  return null;
}

/**
 * Calculate the maximum number of purchases affordable with the current resource amount.
 *
 * Uses formula inversion (and integration for cumulative costs) to compute the answer
 * efficiently, then refines with direct summation for the last `directSum` levels to
 * handle rounding. This is the main "buy max" calculation for repeatables and conversions.
 *
 * @param formula - Cost formula (must be invertible; must be integrable if `cumulativeCost` is true)
 * @param resource - The resource being spent
 * @param cumulativeCost - If true, total cost is the integral (sum of costs 0..N). If false, cost is just `formula(N)`. Default: `true`
 * @param directSum - Number of levels to verify by direct summation for rounding accuracy. Default: `10` (cumulative) or `0` (non-cumulative)
 * @param maxBulkAmount - Cap on the returned amount. Default: `Infinity`
 * @returns Reactive computed with the max affordable amount
 */
export function calculateMaxAffordable(
  formula: GenericFormula,
  resource: Resource,
  cumulativeCost: Computable<boolean> = true,
  directSum?: Computable<number>,
  maxBulkAmount: Computable<DecimalSource> = Decimal.dInf,
) {
  const computedCumulativeCost = processGetter(cumulativeCost);
  const computedDirectSum = processGetter(directSum);
  const computedmaxBulkAmount = processGetter(maxBulkAmount);

  // Threshold guard: cache the affordability band [floorCost, ceilCost) so ticks
  // where the resource changes by a small amount (production) can short-circuit
  // with a pair of Decimal comparisons (~53ns each) instead of a full
  // invertIntegral (~1.6µs) + evaluateIntegral (~1.9µs).
  //
  // The guard is only valid while the formula's innermostVariable (current level)
  // hasn't changed. A purchase changes the level, which shifts the cost curve —
  // the cached band no longer applies.
  let guard: {
    variable: DecimalSource; // innermostVariable snapshot
    affordable: DecimalSource; // cached result
    floorCost: DecimalSource; // total cost of buying `affordable` levels (resource must be >= this)
    ceilCost: DecimalSource; // total cost of buying `affordable + 1` levels (resource must be < this)
    inputSig: string; // signature of non-variable formula inputs (detects base/mult changes, e.g. scope-pushed tunables)
  } | null = null;

  // Build a cheap signature of the formula's non-variable inputs. Used to
  // invalidate the guard when scoped overrides (tunables, dynamic base
  // costs) change the cost curve without changing `innermostVariable`.
  // Non-Formula inputs are unwrapped; Formula inputs are represented by
  // identity (not recursed) — a fully-resolved signature would defeat the
  // guard's whole purpose.
  function computeInputSignature(): string {
    const parts: string[] = [];
    for (const input of formula.inputs) {
      if (input instanceof Formula) {
        parts.push('f');
        continue;
      }
      const v = unref(input as MaybeRef<DecimalSource>);
      parts.push(String(v));
    }
    return parts.join('|');
  }

  return computed(() =>
    profile('formula.calculateMaxAffordable', () => {
      const maxBulkAmount = unref(computedmaxBulkAmount);
      if (Decimal.eq(maxBulkAmount, 1)) {
        guard = null;
        return Decimal.gte(resource.value, formula.evaluate()) ? Decimal.dOne : Decimal.dZero;
      }

      const cumulativeCost = unref(computedCumulativeCost);
      // Default directSum=10 for cumulative cost: integral inversion under-reports
      // discrete affordability by up to 1 level for monotone-convex curves
      // (boundary gap log_s((s-1)/ln(s)) ≈ 0.5 for exponential), and the tail
      // refinement closes that gap. ds=10 covers known boundary cases for
      // exponential / linear / polynomial. Non-cumulative path stays ds=0 since
      // single-level cost has no integral-vs-discrete ambiguity.
      const directSum = unref(computedDirectSum) ?? (cumulativeCost ? 10 : 0);

      // Compute input signature once — also registers reactive deps on any
      // ref-based inputs so the outer computed invalidates when they change.
      const inputSig = computeInputSignature();

      // --- Threshold guard fast path ---
      const currentVariable = unref(formula.innermostVariable) ?? 0;
      if (
        guard !== null &&
        guard.inputSig === inputSig &&
        Decimal.eq(currentVariable, guard.variable) &&
        Decimal.gte(resource.value, guard.floorCost) &&
        Decimal.lt(resource.value, guard.ceilCost)
      ) {
        return guard.affordable;
      }

      // --- Full recomputation ---
      let affordable: DecimalSource = 0;
      const integralRan = Decimal.gt(maxBulkAmount, directSum);
      // Capture integral at current variable for guard band computation.
      // evaluateIntegral() is already called in the main path — reuse it.
      let integralAtCurrent: DecimalSource = 0;
      if (integralRan) {
        if (!formula.isInvertible()) {
          console.error(
            'Cannot calculate max affordable of non-invertible formula with more maxBulkAmount than directSum',
          );
          return 0;
        }
        if (cumulativeCost) {
          if (!formula.isIntegralInvertible()) {
            console.error(
              'Cannot calculate max affordable of formula with non-invertible integral',
            );
            return 0;
          }
          affordable = profile('formula.affordable.integral', () => {
            integralAtCurrent = formula.evaluateIntegral();
            return Decimal.floor(
              formula.invertIntegral(Decimal.add(resource.value, integralAtCurrent)),
            ).sub(currentVariable);
          });
        } else {
          // invert(R) returns the absolute variable level at which evaluate
          // equals R; for non-cumulative cost (a single payment of
          // evaluate(targetLevel) covers reaching that level), the buyable
          // count is invert(R) − currentVariable. Mirrors the cumulative
          // branch's `.sub(currentVariable)` above. Clamped to 0 because
          // invert can drop below currentVariable when even the current
          // level's cost exceeds R.
          affordable = Decimal.max(
            Decimal.floor(formula.invert(resource.value)).sub(currentVariable),
            0,
          );
        }
      }
      affordable = Decimal.clampMax(affordable, maxBulkAmount);
      if (directSum > 0) {
        // directSum > 0 only when the caller explicitly requested it.
        // When the integral path ran, the estimate is trusted (TMT/Profectus
        // pattern: closed-form inversion is authoritative for invertible
        // formulas). The refinement loop only fires for non-invertible
        // formulas where maxBulkAmount <= directSum skipped the integral.
        const preSumAffordable = affordable;
        const refinementCeiling = integralRan ? Decimal.add(preSumAffordable, 1) : maxBulkAmount;
        affordable = Decimal.max(Decimal.sub(affordable, directSum), 0);
        let summedCost = profile('formula.affordable.seed', () => {
          if (cumulativeCost) {
            return calculateCost(formula as InvertibleFormula, affordable, true, 0);
          } else {
            return formula.evaluate(Decimal.add(currentVariable, affordable));
          }
        });
        const loopStart = profileStart();
        while (
          Decimal.lt(affordable, maxBulkAmount) &&
          Decimal.lt(affordable, Number.MAX_SAFE_INTEGER) &&
          Decimal.gte(refinementCeiling, affordable)
        ) {
          const nextCost = formula.evaluate(Decimal.add(affordable, currentVariable));
          if (Decimal.lte(Decimal.add(summedCost, nextCost), resource.value)) {
            affordable = Decimal.add(affordable, 1);
            summedCost = Decimal.add(summedCost, nextCost);
          } else {
            break;
          }
        }
        profileEnd('formula.affordable.refine', loopStart);
      }

      // --- Update threshold guard ---
      // Build the cost band [floorCost, ceilCost) reusing integralAtCurrent
      // from the main path. floorCost is integral-based (one evaluateIntegral);
      // ceilCost is the discrete next-level cost (one evaluate) so the band's
      // upper bound matches the post-directSum discrete `affordable` instead of
      // the looser integral ceiling — without this, resource values in the
      // integral-vs-discrete gap hit the cache and return a stale-by-1 answer.
      if (integralRan && cumulativeCost) {
        const targetLevel = Decimal.add(currentVariable, affordable);
        const integralAtFloor = formula.evaluateIntegral(targetLevel);
        const floorCost = Decimal.sub(integralAtFloor, integralAtCurrent);
        const capped = Decimal.gte(Decimal.add(affordable, 1), maxBulkAmount);
        const ceilCost = capped
          ? Decimal.dInf
          : Decimal.add(floorCost, formula.evaluate(targetLevel));
        guard = { variable: currentVariable, affordable, floorCost, ceilCost, inputSig };
      } else if (integralRan && !cumulativeCost) {
        // Non-cumulative: cost is just formula(level), not a sum
        const targetLevel = Decimal.add(currentVariable, affordable);
        const floorCost = formula.evaluate(targetLevel);
        const ceilCost = Decimal.gte(Decimal.add(affordable, 1), maxBulkAmount)
          ? Decimal.dInf
          : formula.evaluate(Decimal.add(targetLevel, 1));
        guard = { variable: currentVariable, affordable, floorCost, ceilCost, inputSig };
      } else {
        guard = null;
      }

      return affordable;
    }),
  );
}

/**
 * Calculate the total cost of purchasing a specific number of levels.
 *
 * Combines integration (for the bulk) with direct summation (for the tail)
 * to balance performance and accuracy. Companion to {@link calculateMaxAffordable}.
 *
 * @param formula - Cost formula (must be invertible; must be integrable if cumulative)
 * @param amountToBuy - Number of levels to price
 * @param cumulativeCost - If true, sum all individual costs. If false, just `formula(current + amountToBuy)`. Default: `true`
 * @param directSum - Levels to sum directly for rounding accuracy
 * @returns The total cost as a DecimalSource
 */
export function calculateCost(
  formula: InvertibleFormula,
  amountToBuy: DecimalSource,
  cumulativeCost?: true,
  directSum?: number,
): DecimalSource;
export function calculateCost(
  formula: InvertibleIntegralFormula,
  amountToBuy: DecimalSource,
  cumulativeCost: boolean,
  directSum?: number,
): DecimalSource;
export function calculateCost(
  formula: InvertibleFormula,
  amountToBuy: DecimalSource,
  cumulativeCost = true,
  directSum?: number,
) {
  if (Decimal.eq(amountToBuy, 1)) {
    return formula.evaluate();
  }

  const origValue = unref(formula.innermostVariable) ?? 0;
  let newValue = Decimal.add(amountToBuy, origValue);
  const targetValue = newValue;
  directSum ??= 0;
  newValue = Decimal.max(Decimal.sub(newValue, directSum), origValue);
  let cost: DecimalSource = 0;

  if (Decimal.gt(amountToBuy, directSum)) {
    if (!formula.isInvertible()) {
      console.error('Cannot calculate cost with indirect sum of non-invertible formula');
      return 0;
    }
    if (cumulativeCost) {
      if (!formula.isIntegrable()) {
        console.error('Cannot calculate cost with cumulative cost of non-integrable formula');
        return 0;
      }
      cost = Decimal.sub(formula.evaluateIntegral(newValue), formula.evaluateIntegral());
      if (Decimal.gt(targetValue, 1e308)) {
        return Decimal.add(
          cost,
          Decimal.mul(Decimal.sub(targetValue, newValue), formula.evaluate(newValue)),
        );
      }
    } else {
      cost = formula.evaluate(newValue);
      newValue = Decimal.add(newValue, 1);
      if (Decimal.gt(targetValue, 1e308)) {
        return Decimal.mul(Decimal.add(Decimal.sub(targetValue, newValue), 1), cost);
      }
    }
  }

  // Sum the direct-computation tail by a bounded integer counter, evaluating at
  // Decimal offsets from newValue. Iterating a float `i` over the value range
  // itself stalls forever once a level reaches 2^53 — float ULP exceeds 1 there,
  // so `i++` is a no-op and the loop never advances. The tail is always small
  // (its span is min(directSum, amountToBuy)), so count the terms, not the values.
  const directCount = toNumber(Decimal.sub(targetValue, newValue));
  for (let i = 0; i < directCount; i++) {
    cost = Decimal.add(cost, formula.evaluate(Decimal.add(newValue, i)));
  }
  return cost;
}
