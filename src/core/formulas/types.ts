/**
 * Type definitions for the formula system
 *
 * The formula type hierarchy reflects capability levels:
 * - {@link GenericFormula} — any formula (evaluate only)
 * - {@link InvertibleFormula} — can run backward ("what input gives this output?")
 * - {@link IntegrableFormula} — can compute cumulative cost via integration
 * - {@link InvertibleIntegralFormula} — full capability: evaluate, invert, integrate, invert-integral
 *
 * Most consumers only need {@link FormulaSource} (a formula or a raw value) and
 * {@link GenericFormula}. The narrower types matter when using {@link calculateMaxAffordable}
 * or {@link calculateCost}, which require invertibility/integrability.
 */

import type { DecimalSource } from '@/primitives/decimal';
import type { MaybeRef } from 'vue';
import type Formula from './formulas';
import type { Series } from './series';

/** Any Formula instance, regardless of capability. The base type for formula parameters. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GenericFormula = Formula<any>;

/** A formula or a raw Decimal value — the universal input type for formula operations */
export type FormulaSource = MaybeRef<DecimalSource> | GenericFormula;

/** A formula that supports backward evaluation (invert) */
export type InvertibleFormula = GenericFormula & {
  invert: NonNullable<GenericFormula['invert']>;
};

/** A formula that supports cumulative cost calculation via integration */
export type IntegrableFormula = InvertibleFormula & {
  evaluateIntegral: NonNullable<GenericFormula['evaluateIntegral']>;
  getIntegralFormula: NonNullable<GenericFormula['getIntegralFormula']>;
  calculateConstantOfIntegration: NonNullable<GenericFormula['calculateConstantOfIntegration']>;
};

/** A formula with full capability: evaluate, invert, integrate, and invert the integral */
export type InvertibleIntegralFormula = IntegrableFormula & {
  invertIntegral: NonNullable<GenericFormula['invertIntegral']>;
};

/** Forward evaluation function signature — used in {@link GeneralFormulaOptions} */
export type EvaluateFunction<T extends FormulaSource[]> = (
  this: Formula<T>,
  ...inputs: GuardedFormulasToDecimals<T>
) => DecimalSource;

/** Inversion function signature — used in {@link GeneralFormulaOptions} */
export type InvertFunction<T extends FormulaSource[]> = (
  this: Formula<T>,
  value: DecimalSource,
  ...inputs: T
) => DecimalSource;

/** Integration function signature — used in {@link GeneralFormulaOptions} */
export type IntegrateFunction<T extends FormulaSource[]> = (
  this: Formula<T>,
  stack: SubstitutionStack | undefined,
  ...inputs: T
) => GenericFormula;

/**
 * Summation function signature — used in {@link GeneralFormulaOptions}.
 *
 * Unlike {@link IntegrateFunction} this returns a value rather than a formula:
 * summation composes only through the linear identities, so there is no series
 * *formula* to hand back up the chain, only a graded number.
 */
export type SumFunction<T extends FormulaSource[]> = (
  this: Formula<T>,
  from: DecimalSource,
  count: DecimalSource,
  ...inputs: T
) => Series;

/** Substitution function signature (for nested integration) — used in {@link GeneralFormulaOptions} */
export type SubstitutionFunction<T extends FormulaSource[]> = (
  this: Formula<T>,
  variable: GenericFormula,
  ...inputs: T
) => GenericFormula;

/** Options for creating a variable formula (the "x" in a cost function) */
export type VariableFormulaOptions = {
  variable: MaybeRef<DecimalSource>;
  description?: string;
};

/** Options for creating a constant formula (a fixed numeric value) */
export type ConstantFormulaOptions = {
  inputs: [FormulaSource];
  description?: string;
};

/** Options for creating a formula with custom evaluate/invert/integrate functions */
export type GeneralFormulaOptions<T extends [FormulaSource] | FormulaSource[]> = {
  inputs: T;
  evaluate: EvaluateFunction<T>;
  invert?: InvertFunction<T>;
  integrate?: IntegrateFunction<T>;
  integrateInner?: IntegrateFunction<T>;
  sum?: SumFunction<T>;
  applySubstitution?: SubstitutionFunction<T>;
  description?: string;
};

/** Union of all formula constructor option shapes */
export type FormulaOptions<T extends [FormulaSource] | FormulaSource[]> =
  | VariableFormulaOptions
  | ConstantFormulaOptions
  | GeneralFormulaOptions<T>;

/** @internal Resolved properties stored on a Formula instance */
export type FormulaProperties<T extends [FormulaSource] | FormulaSource[]> = {
  inputs: T;
  internalVariables: number;
  internalEvaluate?: EvaluateFunction<T>;
  internalInvert?: InvertFunction<T>;
  internalIntegrate?: IntegrateFunction<T>;
  internalIntegrateInner?: IntegrateFunction<T>;
  internalSum?: SumFunction<T>;
  applySubstitution?: SubstitutionFunction<T>;
  innermostVariable?: MaybeRef<DecimalSource>;
  description?: string;
};

/** Stack of substitution functions used during nested integration */
export type SubstitutionStack = ((value: GenericFormula) => GenericFormula)[] | undefined;

/**
 * Map a tuple of {@link FormulaSource} inputs to a tuple of {@link DecimalSource}
 * outputs — the value shape `internalEvaluate` / `internalInvert` see at
 * runtime. Mostly type plumbing; consumers rarely write this directly.
 */
export type FormulasToDecimals<T extends FormulaSource[]> = {
  [K in keyof T]: DecimalSource;
};

/**
 * Conditional wrapper that preserves the tuple shape through mapped-type
 * inference. Used internally by {@link GuardedFormulasToDecimals}; mostly type
 * plumbing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TupleGuard<T extends any[]> = T extends any[] ? FormulasToDecimals<T> : never;

/**
 * Inference-friendly alias of {@link FormulasToDecimals} that keeps tuple
 * positions intact under TypeScript's mapped-type rules. Mostly type plumbing.
 */
export type GuardedFormulasToDecimals<T extends FormulaSource[]> = TupleGuard<T>;
