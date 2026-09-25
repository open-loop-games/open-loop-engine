/**
 * Formula system — invertible, integrable cost and scaling functions
 *
 * Formulas are composable math expressions that support four operations:
 * - **Evaluate**: compute the output for a given input (e.g., cost at level N)
 * - **Invert**: find the input that produces a given output ("which level costs 350?")
 * - **Sum**: the discrete series `Σ f(from + i)` — what buying levels costs (`sum`)
 * - **Integrate**: the continuous area across a span (`cumulative`) — what a
 *   rate accrues over time, a different number from the sum over the same span
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
import { computed, unref, type MaybeRef } from 'vue';
import * as ops from './operations';
import {
  captureInversionFailures,
  inversionTolerance,
  landsOnTarget,
  representationFloor,
  reportInversionFailure,
  type Inversion,
} from './inversion';
import { findFirstPassage, type FirstPassageOptions, type Passage } from './passage';
import { bracketMidpoint } from './root-find';
import { NOT_SUMMABLE, arithmeticSeries, exactSeries, type Series } from './series';
import type {
  EvaluateFunction,
  FormulaOptions,
  FormulaSource,
  GeneralFormulaOptions,
  GenericFormula,
  IntegrateFunction,
  FormulaProperties,
  InvertFunction,
  SubstitutionFunction,
  SubstitutionStack,
  SumFunction,
} from './types';

/** Type guard for Formula instances. Use this over `instanceof Formula` at call sites that don't already import the class. */
export function isFormula(value: unknown): value is GenericFormula {
  return value instanceof Formula;
}

/** Check if a formula source contains exactly one variable (required for inversion) */
export function hasVariable(value: FormulaSource): value is GenericFormula {
  return value instanceof Formula && value.hasVariable();
}

/** Evaluate a FormulaSource to a DecimalSource — unwraps refs and evaluates formulas */
export function unrefFormulaSource(value: FormulaSource, variable?: DecimalSource) {
  return value instanceof Formula ? value.evaluate(variable) : unref(value);
}

function integrateVariable(this: GenericFormula) {
  return F.pow(this, 2).div(2);
}

function integrateVariableInner(this: GenericFormula) {
  return this;
}

/**
 * Longest span {@link Formula.sum} adds term by term when no closed form
 * applies. Past it the sum is corrected from the integral or reported, rather
 * than run as a loop long enough to stall a tick.
 */
const DIRECT_SUM_LIMIT = 1000;

/** The bare variable's own series — `Σ(from + i)` is arithmetic and always exact. */
function sumVariable(from: DecimalSource, count: DecimalSource): Series {
  return exactSeries(arithmeticSeries(from, count));
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
 * either a {@link UnaryFormulaOp} or a {@link BinaryFormulaOp}, one name per
 * operation — `Decimal`'s alias sprawl (`times`, `plus`, `dividedBy`, …) stops
 * at the `Formula` boundary.
 */
export interface FormulaStaticOps {
  // Unary
  neg: UnaryFormulaOp;
  sign: UnaryFormulaOp;
  round: UnaryFormulaOp;
  floor: UnaryFormulaOp;
  ceil: UnaryFormulaOp;
  trunc: UnaryFormulaOp;
  abs: UnaryFormulaOp;
  recip: UnaryFormulaOp;
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
  sub: BinaryFormulaOp;
  mul: BinaryFormulaOp;
  div: BinaryFormulaOp;
  log: BinaryFormulaOp;
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
  sign: UnaryFormulaInstanceOp;
  round: UnaryFormulaInstanceOp;
  floor: UnaryFormulaInstanceOp;
  ceil: UnaryFormulaInstanceOp;
  trunc: UnaryFormulaInstanceOp;
  abs: UnaryFormulaInstanceOp;
  recip: UnaryFormulaInstanceOp;
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
  sub: BinaryFormulaInstanceOp;
  mul: BinaryFormulaInstanceOp;
  div: BinaryFormulaInstanceOp;
  log: BinaryFormulaInstanceOp;
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
  /**
   * Discrete series rule. Bound only for the ops that carry an exact identity
   * (linearity) or an exact closed form (geometric, Faulhaber) — an op with no
   * entry here reports `not-summable` rather than guessing, which is why the
   * table is short next to `integrate`.
   */
  sum?: (...args: any[]) => any;
  applySubstitution?: (...args: any[]) => any;
};

const unaryOps: Record<string, OpDescriptor> = {
  neg: {
    evaluate: Decimal.neg,
    invert: ops.invertNeg,
    integrate: ops.integrateNeg,
    sum: ops.sumNeg,
    applySubstitution: ops.applySubstitutionNeg,
  },
  sign: { evaluate: Decimal.sign },
  round: { evaluate: Decimal.round, invert: ops.invertPassthrough },
  floor: { evaluate: Decimal.floor, invert: ops.invertPassthrough },
  ceil: { evaluate: Decimal.ceil, invert: ops.invertPassthrough },
  trunc: { evaluate: Decimal.trunc, invert: ops.invertPassthrough },
  abs: { evaluate: Decimal.abs },
  recip: {
    evaluate: Decimal.recip,
    invert: ops.invertRecip,
    integrate: ops.integrateRecip,
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
    sum: ops.sumAdd,
    applySubstitution: ops.passthrough,
  },
  sub: {
    evaluate: Decimal.sub,
    invert: ops.invertSub,
    integrate: ops.integrateSub,
    integrateInner: ops.integrateInnerSub,
    sum: ops.sumSub,
    applySubstitution: ops.passthrough,
  },
  mul: {
    evaluate: Decimal.mul,
    invert: ops.invertMul,
    integrate: ops.integrateMul,
    sum: ops.sumMul,
    applySubstitution: ops.applySubstitutionMul,
  },
  div: {
    evaluate: Decimal.div,
    invert: ops.invertDiv,
    integrate: ops.integrateDiv,
    sum: ops.sumDiv,
    applySubstitution: ops.applySubstitutionDiv,
  },
  log: {
    evaluate: Decimal.log,
    invert: ops.invertLog,
    integrate: ops.integrateLog,
  },
  pow: {
    evaluate: Decimal.pow,
    invert: ops.invertPow,
    integrate: ops.integratePow,
    sum: ops.sumPow,
  },
  pow_base: {
    evaluate: (value: DecimalSource, base: DecimalSource) => Decimal.pow(base, value),
    invert: ops.invertPowBase,
    integrate: ops.integratePowBase,
    sum: ops.sumPowBase,
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
  protected readonly internalSum: SumFunction<T> | undefined;
  protected readonly applySubstitution: SubstitutionFunction<T> | undefined;
  protected readonly description: string | undefined;
  protected readonly internalVariables: number;
  /** Every op from here down to the variable has a substitution rule — see `setupFormula`. */
  protected readonly substitutable: boolean;

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
    this.substitutable = readonlyProperties.substitutable;
    this.innermostVariable = readonlyProperties.innermostVariable;
    this.internalEvaluate = readonlyProperties.internalEvaluate;
    this.internalInvert = readonlyProperties.internalInvert;
    this.internalIntegrate = readonlyProperties.internalIntegrate;
    this.internalIntegrateInner = readonlyProperties.internalIntegrateInner;
    this.internalSum = readonlyProperties.internalSum;
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
      internalSum: sumVariable as unknown as SumFunction<T>,
      applySubstitution: ops.passthrough as unknown as SubstitutionFunction<T>,
      substitutable: true,
    };
  }

  private setupConstant({ inputs }: { inputs: [FormulaSource] }): FormulaProperties<T> {
    if (inputs.length !== 1) {
      console.error('Evaluate function is required if inputs is not length 1');
    }
    return {
      inputs: inputs as T,
      internalVariables: 0,
      substitutable: false,
    };
  }

  private setupFormula(options: GeneralFormulaOptions<T>): FormulaProperties<T> {
    const { inputs, evaluate, invert, integrate, integrateInner, sum, applySubstitution } = options;
    const numVariables = inputs.reduce<number>(
      (acc, input) => acc + (input instanceof Formula ? input.internalVariables : 0),
      0,
    );
    const variable = inputs.find((input) => input instanceof Formula && input.hasVariable()) as
      | GenericFormula
      | undefined;

    const innermostVariable = numVariables === 1 ? variable?.innermostVariable : undefined;

    const invertible = variable?.isInvertible() ?? false;
    // An op with no substitution rule (`pow`, `pow_base`, `exp`, …) integrates
    // only by substituting through everything beneath it, so every op down to
    // the variable has to have one. Checked here, from structure, because the
    // integral is built lazily and a failed build hands back a constant that
    // every caller above would price as a real antiderivative.
    const substitutable = applySubstitution != null && (variable?.substitutable ?? false);
    const integrable =
      (variable?.isIntegrable() ?? false) &&
      (applySubstitution != null || (variable?.substitutable ?? false));

    return {
      inputs,
      internalEvaluate: evaluate,
      internalInvert: invertible ? invert : undefined,
      internalIntegrate: integrable ? integrate : undefined,
      internalIntegrateInner: integrateInner,
      // Bound unconditionally, unlike `integrate`: a sum op returns a graded
      // {@link Series} rather than a formula, so it reports `not-summable` for
      // itself. Gating it on the inner's capability would move that report into
      // a silent `undefined` and lose which op broke the chain.
      internalSum: sum,
      applySubstitution,
      substitutable,
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
  isInvertible(): boolean {
    return this.hasVariable() && (this.internalInvert != null || this.internalEvaluate == null);
  }

  isIntegrable(): boolean {
    return this.hasVariable() && this.internalIntegrate != null;
  }

  isIntegralInvertible(): boolean {
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
    // serves consumer-built formulas with more inputs.
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
   * with an interior `.floor()`, a `step`/`if` splice, or a saturating `min`/`max`)
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
   * saturated `min`/`max` — because they are all the same failure, a target outside
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
   * xpToLevel.tryInvert(3.5);  // { value: 612.5, reason: 'outside-image', evaluatesTo: 3 }
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
   * breakpoint, a saturated `min`/`max`. For the same reason it needs no inverse at
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
    // Below a curve's infimum the algebra answers NaN (`ln` of a non-positive
    // target), and `outside-image` promises a value the caller can use as-is.
    if (!Decimal.isFinite(candidate)) return { value: null, reason: 'no-solution' };
    const forward = viaIntegral ? this.evaluateIntegral(candidate) : this.evaluate(candidate);
    const tol = tolerance ?? inversionTolerance(value);
    if (landsOnTarget(forward, value, tol)) return { value: candidate, reason: 'exact' };
    return { value: candidate, reason: 'outside-image', evaluatesTo: forward };
  }

  /**
   * Antiderivative of this formula, evaluated at `variable`.
   *
   * **This is not `∫₀ˣ`.** It carries an arbitrary constant, so the value at a
   * single point is only meaningful relative to another one:
   * `Formula.exponential(0, 10, 1.15).evaluateIntegral(0)` is `71.55`, not 0.
   * For the area over a span use {@link cumulative}, which differences it; for
   * a level-indexed cost use {@link sum}, which is a different operation again.
   */
  evaluateIntegral(variable?: DecimalSource): DecimalSource {
    if (!this.isIntegrable()) {
      console.error('Cannot evaluate integral of formula without integral');
      return 0;
    }
    return this.getIntegralFormula().evaluate(variable);
  }

  /**
   * `∫ from→to` — the continuous area under this formula across a span.
   *
   * The rate-function lineage's *cumulative*: integrate a rate over time and
   * this is the total accrued, which is what {@link firstPassage} inverts. The
   * arbitrary constant {@link evaluateIntegral} carries cancels in the
   * difference, so unlike that method this answers a well-posed question.
   *
   * **Not the cost of buying levels.** A level-indexed cost curve is a series,
   * and the two differ by a boundary term that is 7.3% on the canonical
   * `1.15ⁿ` curve — use {@link sum} there.
   *
   * @example
   * ```ts
   * const rate = Formula.variable(0).pow_base(2).mul(5);  // 5·2ᵗ per second
   * rate.cumulative(0, 10);  // total produced over the first ten seconds
   * ```
   */
  cumulative(from: DecimalSource, to: DecimalSource): DecimalSource {
    if (!this.isIntegrable()) {
      console.error('Cannot take a cumulative of a formula without an integral');
      return 0;
    }
    const antiderivative = this.getIntegralFormula();
    return Decimal.sub(antiderivative.evaluate(to), antiderivative.evaluate(from));
  }

  /**
   * `Σ f(from + i)` for integer `i` in `[0, count)` — the discrete series. A
   * fractional `count` therefore takes `⌈count⌉` terms.
   *
   * What a level-indexed cost actually is: buying `count` levels starting at
   * level `from` costs this, and it is not {@link cumulative} over the same
   * span. Exact where a closed form exists (the shipped `exponential` /
   * `linear` / `polynomial` curves and anything built from them by `+`, `−`,
   * and constant `×`/`÷`), and exact term by term over a span of up to
   * `DIRECT_SUM_LIMIT` levels; beyond that `approximate` via
   * Euler–Maclaurin, or `not-summable` when there is no integral to correct.
   *
   * There is deliberately no unchecked twin the way {@link invert} sits under
   * {@link tryInvert}: `invert` is unchecked because the op table composes with
   * it recursively, whereas summation composes over graded results, so nothing
   * needs the bare number and no caller gets one by accident.
   *
   * @example
   * ```ts
   * const cost = Formula.exponential(level, 10, 1.15);
   * const price = cost.sum(level.value, 19);   // what 19 more levels cost
   * if (price.reason !== 'not-summable') charge(price.value);
   * ```
   */
  sum(from: DecimalSource, count: DecimalSource): Series {
    if (Decimal.lte(count, 0)) return exactSeries(Decimal.dZero);
    const terms = Decimal.ceil(count);
    if (this.internalVariables === 0) return exactSeries(Decimal.mul(terms, this.evaluate()));
    // Closed forms apply with several variable leaves too: `evaluate` reads
    // every leaf at the same level, and the linear identities split the chain
    // wherever that holds, reporting where it doesn't.
    if (this.internalSum != null) {
      const series = this.internalSum.call(this, from, terms, ...this.inputs);
      if (series.value != null) return series;
    }
    if (Decimal.lte(terms, DIRECT_SUM_LIMIT)) return this.directSum(from, terms);
    return this.correctedSum(from, terms);
  }

  /**
   * `Σ` by adding the terms — the definition, so `exact`. `not-summable` when a
   * term is undefined, since no total over it is.
   */
  private directSum(from: DecimalSource, count: DecimalSource): Series {
    // Count the terms, not the values: iterating a float over the *level* range
    // stalls forever past 2^53, where the float ULP exceeds 1 and `i++` stops
    // advancing. The span is bounded above, so the counter is safe.
    let total: DecimalSource = Decimal.dZero;
    const terms = toNumber(count);
    for (let i = 0; i < terms; i++) {
      total = Decimal.add(total, this.evaluate(Decimal.add(from, i)));
    }
    return Decimal.isNaN(total) ? NOT_SUMMABLE : exactSeries(total);
  }

  /**
   * Euler–Maclaurin fallback for chains with no closed-form series: the
   * continuous cumulative plus its first two boundary corrections,
   * `∫ₐᵇ f − [f(b)−f(a)]/2 + [f′(b)−f′(a)]/12`.
   *
   * On the exponential curve this cuts the error from 7.3% (raw cumulative) to
   * ~4e-4, which is why it beats reporting nothing. The reported `error` is the
   * relative size of the last correction applied — for the smooth monotone
   * curves this arm exists to serve, the omitted tail is smaller still, so read
   * it as an accuracy claim rather than a proof.
   *
   * Derivatives come from second-order one-sided differences at unit spacing,
   * the grid the sum is defined on, taken inward from each end so they sample
   * only `[from, to]`. A central difference at `from` reads `f(from − 1)`,
   * where a fractional power at level 0 is not real-valued.
   */
  private correctedSum(from: DecimalSource, count: DecimalSource): Series {
    if (!this.isIntegrable()) return NOT_SUMMABLE;
    const to = Decimal.add(from, count);
    const area = this.cumulative(from, to);
    const at = (x: DecimalSource, offset: number) => this.evaluate(Decimal.add(x, offset));
    const trapezoid = Decimal.div(Decimal.sub(at(to, 0), at(from, 0)), 2);

    // f′(x) ≈ ∓[3f(x) − 4f(x ± 1) + f(x ± 2)]/2, stepping into the span.
    const slopeFrom = Decimal.div(
      Decimal.add(
        Decimal.sub(Decimal.mul(4, at(from, 1)), Decimal.mul(3, at(from, 0))),
        Decimal.neg(at(from, 2)),
      ),
      2,
    );
    const slopeTo = Decimal.div(
      Decimal.add(Decimal.sub(Decimal.mul(3, at(to, 0)), Decimal.mul(4, at(to, -1))), at(to, -2)),
      2,
    );
    const curvature = Decimal.div(Decimal.sub(slopeTo, slopeFrom), 12);

    const value = Decimal.add(Decimal.sub(area, trapezoid), curvature);
    if (!Decimal.isFinite(value)) return NOT_SUMMABLE;
    const error = Decimal.eq(value, 0)
      ? Decimal.abs(curvature).toNumber()
      : Decimal.abs(Decimal.div(curvature, value)).toNumber();
    return { value, reason: 'approximate', error };
  }

  invertIntegral(value: DecimalSource): DecimalSource {
    if (!this.isIntegrable() || !this.getIntegralFormula().isInvertible()) {
      reportInversionFailure(
        'not-invertible',
        'Cannot invert integral of formula without invertible integral',
      );
      return 0;
    }
    return this.getIntegralFormula().invert(value);
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
   * Create a constant formula — a fixed value with no variable. With nothing to
   * solve for, it is neither invertible nor integrable.
   */
  public static constant(value: MaybeRef<DecimalSource>): GenericFormula {
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
  public static variable(value: MaybeRef<DecimalSource>): GenericFormula {
    return new Formula({ variable: value });
  }

  // === COST SCALING CONSTRUCTORS ===

  /**
   * Exponential cost curve: `base * mult^x`. The canonical incremental cost scaling.
   *
   * Fully invertible and integrable, with a closed-form series — powers "buy max"
   * via {@link calculateMaxAffordable} and bulk pricing via {@link calculateCost}
   * without an O(n) loop.
   *
   * @param variable - Level input — typically a reactive ref (e.g., `purchasable.amount`),
   *   or a raw `DecimalSource` for ad-hoc evaluation via `.evaluate(level)`.
   * @param base - Cost at level 0
   * @param mult - Per-level multiplier (e.g., `1.15` = +15% per level)
   *
   * Every parameter after `variable` can be a ref or a variable-free Formula,
   * for a value a modifier or a tuning knob moves at runtime.
   *
   * @example
   * ```ts
   * const cost = Formula.exponential(purchasable.amount, 10, 1.15);
   * cost.evaluate();   // reactive — cost at current level
   * cost.invert(100);  // what level costs 100?
   * cost.sum(0, 5);    // what levels 0..4 cost, bought one at a time
   * ```
   */
  public static exponential(
    variable: MaybeRef<DecimalSource>,
    base: FormulaSource,
    mult: FormulaSource,
  ): GenericFormula {
    return Formula.variable(variable).pow_base(mult).mul(base);
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
   *
   * `base` and `coef` can be a ref or a variable-free Formula, as on
   * {@link Formula.exponential}.
   */
  public static linear(
    variable: MaybeRef<DecimalSource>,
    base: FormulaSource,
    coef: FormulaSource,
  ): GenericFormula {
    return Formula.variable(variable).mul(coef).add(base);
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
   *
   * `base` and `exp` can be a ref or a variable-free Formula, as on
   * {@link Formula.exponential}.
   */
  public static polynomial(
    variable: MaybeRef<DecimalSource>,
    base: FormulaSource,
    exp: FormulaSource,
  ): GenericFormula {
    return Formula.variable(variable).pow(exp).mul(base);
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
    base: FormulaSource,
  ): GenericFormula {
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
    formulaModifier: (value: GenericFormula) => GenericFormula,
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
    formulaModifier: (value: GenericFormula) => GenericFormula,
  ) {
    return Formula.step(this, start, formulaModifier);
  }

  /**
   * Conditionally apply a formula transformation based on a boolean.
   *
   * When `condition` is true, applies `formulaModifier`. When false, applies
   * `elseFormulaModifier` (or passes through unchanged if omitted).
   * Invertible when every branch that can be live is — the condition can flip
   * at any time, so one non-invertible branch makes the chain non-invertible.
   *
   * @param value - The input formula or value
   * @param condition - Reactive boolean controlling which branch applies
   * @param formulaModifier - Transformation when condition is true
   * @param elseFormulaModifier - Transformation when condition is false (optional)
   */
  public static if(
    value: FormulaSource,
    condition: Computable<boolean>,
    formulaModifier: (value: GenericFormula) => GenericFormula,
    elseFormulaModifier?: (value: GenericFormula) => GenericFormula,
  ) {
    // Branches are built over a placeholder variable and evaluated at the
    // input, as `step` does. Writing the input into a ref instead would make
    // evaluation mutate state it reads, leaving every computed over it dirty.
    const formula = formulaModifier(Formula.variable(0));
    const elseFormula = elseFormulaModifier?.(Formula.variable(0));
    const processedCondition = processGetter(condition);
    const live = () => (unref(processedCondition) ? formula : elseFormula);
    function evalStep(lhs: DecimalSource) {
      return live()?.evaluate(lhs) ?? lhs;
    }
    function invertStep(value: DecimalSource, lhs: FormulaSource) {
      if (!hasVariable(lhs)) {
        reportInversionFailure(
          'not-invertible',
          'Could not invert due to no input being a variable',
        );
        return 0;
      }
      const branch = live();
      return lhs.invert(branch ? branch.invert(value) : value);
    }
    const invertible = [formula, elseFormula].every(
      (branch) => branch == null || (branch.isInvertible() && branch.hasVariable()),
    );
    return new Formula({
      inputs: [value],
      evaluate: evalStep,
      invert: invertible ? invertStep : undefined,
      description: 'indeterminate',
    });
  }

  public if(
    condition: Computable<boolean>,
    formulaModifier: (value: GenericFormula) => GenericFormula,
    elseFormulaModifier?: (value: GenericFormula) => GenericFormula,
  ) {
    return Formula.if(this, condition, formulaModifier, elseFormulaModifier);
  }

  public static conditional = Formula.if;

  public conditional(
    condition: Computable<boolean>,
    formulaModifier: (value: GenericFormula) => GenericFormula,
    elseFormulaModifier?: (value: GenericFormula) => GenericFormula,
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

  // Saturating floor/ceiling on a curve — `x.max(lo).min(hi)` is the clamp.
  // Both invert as the identity through the op, into the variable-bearing
  // input, which also answers for a target past the bound that the curve can
  // never produce; `tryInvert` grades that as `outside-image` and
  // `firstPassage` reports `no-crossing`, so the permissiveness is visible
  // rather than silent.
  public static max = ops.createPassthroughBinaryFormula(Decimal.max);
  public static min = ops.createPassthroughBinaryFormula(Decimal.min);

  public max(value: FormulaSource) {
    return Formula.max(this, value);
  }
  public min(value: FormulaSource) {
    return Formula.min(this, value);
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
    if (arity === 'unary') {
      (Formula as any)[name] = (value: FormulaSource) => new Formula({ inputs: [value], ...desc });
    } else {
      (Formula as any)[name] = (value: FormulaSource, other: FormulaSource) =>
        new Formula({ inputs: [value, other], ...desc });
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
  }
}

registerOps(unaryOps, 'unary');
registerOps(binaryOps, 'binary');

// === STANDALONE UTILITIES ===

/**
 * Debug helper: find the operation that breaks invertibility in a formula chain.
 *
 * Follows the variable down the chain and returns the deepest op that binds no
 * inverse — every op above it reports non-invertible too, but only because it
 * sits over this one. Returns `null` if the entire chain is invertible.
 *
 * @param formula - The formula to inspect
 * @returns The non-invertible node, or `null` if fully invertible
 */
export function findNonInvertible(formula: GenericFormula): GenericFormula | null {
  for (const input of formula.inputs) {
    if (hasVariable(input)) {
      const below = findNonInvertible(input);
      if (below != null) return below;
      break;
    }
  }
  return formula.isInvertible() ? null : formula;
}

/**
 * Relative slack when comparing a closed-form price against a balance at
 * layer 0.
 *
 * Matches the tolerance `createCostRequirement` applies to the ratio of balance
 * to a flat cost. Tight enough not to grant a level a player is meaningfully
 * short of (a 49.99 balance never affords a 50 cost), wide enough to absorb the
 * ulp a closed form carries where summing the same levels one at a time would
 * land exactly.
 */
const AFFORDABILITY_TOLERANCE = 1e-12;

/**
 * Whether `price` can be met out of `balance`.
 *
 * Non-finite prices are unaffordable rather than free. A cost curve that
 * evaluates to NaN must afford nothing, and `Decimal`'s ordering comparisons
 * answer false against NaN in *both* directions, so a bare `gt` would read
 * "not more than the balance" and hand out levels without limit.
 *
 * The slack is relative to the price, compared as the ratio `price / balance`,
 * and widens above layer 0 only to the ulp the stored exponent carries.
 * `Decimal`'s own tolerance comparisons apply their tolerance to that stored
 * exponent, which makes it an absolute slack in orders of magnitude.
 *
 * @internal
 */
function payable(price: DecimalSource, balance: DecimalSource): boolean {
  if (!Decimal.isFinite(price)) return false;
  if (Decimal.lte(price, balance)) return true;
  if (!Decimal.gt(balance, 0)) return false;
  const slack = Math.max(AFFORDABILITY_TOLERANCE, representationFloor(price));
  return Decimal.lte(Decimal.div(price, balance), 1 + slack);
}

/**
 * Count how many levels a resource can currently afford on a cost curve — the
 * "buy max" for repeatables and conversions.
 *
 * Answers the discrete question: the largest `n` whose price, in the operation
 * {@link calculateCost} charges, fits the balance. That is exactly the count
 * sequential single purchases would reach, so the count and the charge agree.
 * Any curve works, including one with no inverse or no integral. Where an
 * inverse exists it seeds the answer in one step and a short exact walk lands
 * it; otherwise, or when the seed is far off, a bracketed search over whole
 * counts finds it. The search needs the price to rise with the count, which a
 * cumulative price does whenever no level costs less than nothing, and a single
 * payment does when the curve is non-decreasing. On a curve that breaks that,
 * the answer is still a count the balance can pay for, possibly short of the
 * largest.
 *
 * @param formula - Cost formula — the price of the level at its variable
 * @param resource - The resource paying for the levels
 * @param cumulativeCost - If true, affordability is measured against `Σ f(a+i)` over the levels bought. If false, against `f(a + n)` alone. Default: `true`
 * @param maxBulkAmount - Ceiling on the returned count, for "buy max" caps; a fractional cap counts the whole levels below it. Default: unbounded
 * @returns Reactive count of affordable levels, recomputed as the resource, the
 * cost curve, and both options change — including reactive values the curve
 * reads from inside a `Formula.step` / `Formula.if` closure
 */
export function calculateMaxAffordable(
  formula: GenericFormula,
  resource: Resource,
  cumulativeCost: Computable<boolean> = true,
  maxBulkAmount: Computable<DecimalSource> = Decimal.dInf,
) {
  const computedCumulativeCost = processGetter(cumulativeCost);
  const computedmaxBulkAmount = processGetter(maxBulkAmount);

  // Change token for the cost curve. Recomputes — and so returns a *fresh*
  // object — whenever any reactive value the formula reads changes, which makes
  // identity comparison an exact "has the curve moved?" test.
  //
  // Running `evaluate` is what makes it exact, and nothing cheaper is. A
  // signature built by walking `formula.inputs` cannot see the state that
  // `Formula.step` and `Formula.if` hold in a closure (their `inputs` carry
  // only the value; the threshold, the condition and the whole modifier
  // sub-formula do not appear there), nor anything a consumer-built
  // `new Formula({ inputs, evaluate })` closes over. Evaluating reaches all of
  // it, because it runs it.
  //
  // Identity rather than value, because an input can move the curve somewhere
  // other than where it was sampled: a `step` threshold sliding from 100 to 200
  // leaves the value at level 0 untouched while changing what the levels above
  // it cost.
  const curveToken = computed<{ at: DecimalSource }>(() => ({ at: formula.evaluate() }));

  // Threshold guard: cache the affordability band [floorCost, ceilCost) so ticks
  // where the resource changes by a small amount (production) can short-circuit
  // with a handful of comparisons instead of a full invertIntegral +
  // evaluateIntegral. See `scenarioF` in scripts/formula-hotpath-bench.ts.
  //
  // Every field here is part of the key, and the fast path must test all of
  // them: the band was computed at one level, in one pricing operation, under
  // one cap, on one shape of curve, and it is stale if any of the four moved.
  //
  // The fast path must also *read* every reactive input on every run, which is
  // why `curveToken` is read before the early return below rather than inside
  // the test. Vue re-collects dependencies each run, so an input read only on
  // the recomputation path is dropped from the dependency set the first time
  // the guard hits — after which nothing invalidates this computed again and
  // the staleness is permanent, not one tick late.
  let guard: {
    variable: DecimalSource; // innermostVariable snapshot
    affordable: DecimalSource; // cached result
    floorCost: DecimalSource; // total cost of buying `affordable` levels (resource must be >= this)
    ceilCost: DecimalSource; // total cost of buying `affordable + 1` levels (resource must be < this)
    token: { at: DecimalSource }; // curve identity the band was computed against
    cumulative: boolean; // the pricing operation the band was computed in
    maxBulk: DecimalSource; // the cap the band was clamped to
  } | null = null;

  return computed(() =>
    profile('formula.calculateMaxAffordable', () => {
      // Read first, on every path: this is the subscription to every reactive
      // input the curve reads, not just the key it is compared by.
      const token = curveToken.value;
      const maxBulkAmount = unref(computedmaxBulkAmount);
      const cumulativeCost = unref(computedCumulativeCost);
      const currentVariable = unref(formula.innermostVariable) ?? 0;

      if (Decimal.eq(maxBulkAmount, 1)) {
        guard = null;
        // Price the level being bought, in the operation `pay` will charge it
        // in — the same question `priceOf(1)` answers on the general path, and
        // the reason `cumulativeCost` is read above rather than below. A
        // cumulative buy of one sums to `evaluate(A)`, which is `token.at`; a
        // non-cumulative one pays `evaluate(A + 1)` for the level it reaches.
        // Comparing against `token.at` in both granted a level the balance
        // could not cover, and `pay` does not re-check — it subtracts and
        // clamps at zero.
        const price = cumulativeCost ? token.at : formula.evaluate(Decimal.add(currentVariable, 1));
        return payable(price, resource.value) ? Decimal.dOne : Decimal.dZero;
      }

      // --- Threshold guard fast path ---
      // Band membership is tested with the same predicate the answer was
      // decided by (`payable` below), so the cached answer and a recomputation
      // cannot disagree at the boundary — a plain `gte`/`lt` pair here would
      // reject an ulp-wide sliver the recomputation accepts, and return
      // stale-by-one for resource values sitting in it.
      if (
        guard !== null &&
        guard.token === token &&
        guard.cumulative === cumulativeCost &&
        // `maxBulkAmount` defaults to `dInf`, and `processGetter` hands back the
        // same object each run, so identity settles the common case before the
        // comparison that has to reason about infinities.
        (guard.maxBulk === maxBulkAmount || Decimal.eq(guard.maxBulk, maxBulkAmount)) &&
        Decimal.eq(currentVariable, guard.variable) &&
        payable(guard.floorCost, resource.value) &&
        !payable(guard.ceilCost, resource.value)
      ) {
        return guard.affordable;
      }

      // --- Full recomputation ---
      // Counts are whole levels, so a fractional cap admits the levels below it.
      const cap = Decimal.floor(maxBulkAmount);

      /** Total charged for buying `n` levels — the same operation the purchase pays. */
      const priceOf = (n: DecimalSource): DecimalSource =>
        cumulativeCost
          ? (formula.sum(currentVariable, n).value ?? Decimal.dInf)
          : formula.evaluate(Decimal.add(currentVariable, n));

      /** Whether buying `n` levels is payable out of the current balance. */
      const canAfford = (n: DecimalSource): boolean => payable(priceOf(n), resource.value);

      const seed = profile('formula.affordable.integral', () =>
        seedAffordable(formula, resource.value, currentVariable, cumulativeCost, cap),
      );
      const correctionStart = profileStart();
      const affordable = countAffordable(canAfford, cap, seed);
      profileEnd('formula.affordable.refine', correctionStart);

      // --- Update threshold guard ---
      // The band is [price(n), price(n+1)) in the same operation the answer was
      // computed in. Both bounds discrete now that pricing is: the earlier
      // integral-floor / discrete-ceil mix existed only to paper over the two
      // coordinates disagreeing, and a resource landing in that gap read a
      // stale-by-one answer out of the cache.
      //
      // `capped` asks whether a next level exists to price, so it tests
      // `affordable + 1` *passing* the cap, not reaching it: at exactly the cap
      // that level is still real, and giving the band an infinite ceiling
      // instead of its price would freeze the answer one short.
      const capped = Decimal.gt(Decimal.add(affordable, 1), cap);
      guard = {
        variable: currentVariable,
        affordable,
        floorCost: priceOf(affordable),
        ceilCost: capped ? Decimal.dInf : priceOf(Decimal.add(affordable, 1)),
        token,
        cumulative: cumulativeCost,
        maxBulk: maxBulkAmount,
      };

      return affordable;
    }),
  );
}

/**
 * The continuous answer, as a whole count clamped to `[0, cap]`, or `null` when
 * the curve has no inverse to solve it with or the inverse has no answer here.
 *
 * @internal
 */
function seedAffordable(
  formula: GenericFormula,
  balance: DecimalSource,
  currentVariable: DecimalSource,
  cumulativeCost: boolean,
  cap: DecimalSource,
): DecimalSource | null {
  // A seed is an accelerator, so an inverse that fails is a missing seed rather
  // than a report: the search answers without one.
  const { value: level, failure } = captureInversionFailures(() => {
    if (cumulativeCost) {
      if (!formula.isIntegralInvertible()) return null;
      return formula.invertIntegral(Decimal.add(balance, formula.evaluateIntegral()));
    }
    // `invert(R)` is the level whose single payment is R, so the count is the
    // distance to it from here.
    return formula.isInvertible() ? formula.invert(balance) : null;
  });
  if (failure != null || level == null) return null;
  const count = Decimal.sub(Decimal.floor(level), currentVariable);
  return Decimal.isFinite(count) ? Decimal.clamp(count, 0, cap) : null;
}

/**
 * How far the walk from a seed goes in either direction before handing over to
 * the search. The seed solves the continuous equation, so it lands within about
 * a level of the discrete answer — half of one for every geometric curve, since
 * the two differ by the fixed factor ln(s)/(s−1) — and the walk takes a couple
 * of steps. Past this bound the seed was not close, and bisecting is cheaper.
 */
const CORRECTION_LIMIT = 64;

/** Bound on the bracket search's expansions and halvings. */
const SEARCH_LIMIT = 256;

/**
 * Largest whole count in `[0, cap]` that `canAfford` accepts, for a
 * `canAfford` that holds up to some count and fails above it.
 *
 * Every count returned has passed `canAfford` (or is zero), including when the
 * precondition fails or a budget runs out. The answer can then fall short, but
 * it is never a count nobody priced: `pay` doesn't re-check it, it subtracts and
 * clamps at zero, so an unpriced count hands out free levels.
 *
 * @internal
 */
function countAffordable(
  canAfford: (n: DecimalSource) => boolean,
  cap: DecimalSource,
  seed: DecimalSource | null,
): DecimalSource {
  if (Decimal.lt(cap, 1)) return Decimal.dZero;
  let lo: DecimalSource = Decimal.dZero;
  let hi: DecimalSource | null = null;

  if (seed != null) {
    let n = seed;
    let verified = false;
    for (let i = 0; i < CORRECTION_LIMIT; i++) {
      if (canAfford(n)) {
        verified = true;
        break;
      }
      hi = n;
      if (!Decimal.gt(n, 0)) return Decimal.dZero;
      n = Decimal.sub(n, 1);
    }
    if (verified) {
      lo = n;
      for (let i = 0; i < CORRECTION_LIMIT; i++) {
        if (!Decimal.lt(lo, cap)) return lo;
        const next = Decimal.add(lo, 1);
        if (!canAfford(next)) return lo;
        lo = next;
      }
    }
  }

  // Bracket `lo` (affordable) below `hi` (not), then halve on whole counts.
  if (hi == null) {
    // A curve that never outgrows the balance — a flat single payment — is
    // affordable at the cap itself, including an unbounded one.
    if (canAfford(cap)) return cap;
    if (Decimal.isFinite(cap)) {
      hi = cap;
    } else {
      let probe = Decimal.max(Decimal.add(Decimal.mul(lo, 2), 1), 1);
      for (let i = 0; i < SEARCH_LIMIT && hi == null; i++) {
        if (!canAfford(probe)) {
          hi = probe;
        } else {
          lo = probe;
          // Squaring reaches any magnitude in a few dozen steps, and the halving
          // below is geometric, so overshooting costs nothing.
          probe = Decimal.max(Decimal.add(Decimal.mul(probe, 2), 1), Decimal.pow(probe, 2));
        }
      }
      if (hi == null) return lo;
    }
  }
  for (let i = 0; i < SEARCH_LIMIT && Decimal.gt(Decimal.sub(hi, lo), 1); i++) {
    let mid: DecimalSource = Decimal.floor(bracketMidpoint(new Decimal(lo), new Decimal(hi)));
    if (Decimal.lte(mid, lo)) mid = Decimal.add(lo, 1);
    else if (Decimal.gte(mid, hi)) mid = Decimal.sub(hi, 1);
    // Past 2^53 a whole count has no neighbour to step to.
    if (Decimal.lte(mid, lo) || Decimal.gte(mid, hi)) break;
    if (canAfford(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Calculate the total cost of purchasing a specific number of levels.
 *
 * Under `cumulativeCost` this is the **series** {@link Formula.sum} — what
 * buying the levels one at a time charges — not the continuous area
 * {@link Formula.cumulative} under the same curve. Companion to
 * {@link calculateMaxAffordable}, which counts levels through the same
 * operation so the count and the charge agree.
 *
 * @param formula - Cost formula — the price of the level at its variable
 * @param amountToBuy - Number of levels to price; a fractional amount takes every whole level below it
 * @param cumulativeCost - If true, the cost is `Σ f(a+i)` over the levels bought. If false, it is `f(a + amountToBuy)` alone. Default: `true`
 * @returns The total cost, or 0 with a report when the span has no price
 */
export function calculateCost(
  formula: GenericFormula,
  amountToBuy: DecimalSource,
  cumulativeCost = true,
): DecimalSource {
  const origValue = unref(formula.innermostVariable) ?? 0;
  if (Decimal.lte(amountToBuy, 0)) return Decimal.dZero;
  if (!cumulativeCost) return formula.evaluate(Decimal.add(origValue, amountToBuy));

  const series = formula.sum(origValue, amountToBuy);
  if (series.value != null) return series.value;
  console.error('Cannot calculate cumulative cost of a formula with no series and no integral');
  return 0;
}
