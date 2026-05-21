import type { Decimal, DecimalSource } from './decimal';

/** Live snapshot of a tracked resource: its current amount and optional cap. */
export interface IResource {
  id: string;
  amount: Decimal;
  /** Maximum value the resource can reach. Absent means uncapped. */
  cap?: Decimal;
}

/** Modifies a numeric resource by adding, subtracting, multiplying, or setting its value. */
export interface ResourceEffect {
  type: 'resource';
  target: string;
  /** Arithmetic operation to apply to the resource's current amount. */
  operation: 'add' | 'subtract' | 'multiply' | 'set';
  /** Amount to use in the operation. May be a Formula with an `evaluate()` method. */
  value: DecimalSource | { evaluate(): DecimalSource };
}

/** Sets an unlock flag to true or false, controlling feature/content visibility. */
export interface UnlockEffect {
  type: 'unlock';
  target: string;
  /** Whether the target should become unlocked (`true`) or locked (`false`). */
  value: boolean;
}

/**
 * Writes an arbitrary value to a dot-path in game state (e.g. `"player.phase"`).
 *
 * **Reserved path conventions** (used by core/systems modules):
 * - `dialog.{graphId}.activeNode` — current node id (string | undefined)
 * - `dialog.{graphId}.visits.{nodeId}` — visit count (number)
 * - `rel.{categoryId}.{actor}.{dim}` — scalar / vector dim value (number)
 * - `rel.{categoryId}.{actor}.tier` — tier index (number)
 * - `rel.{categoryId}.{actor}.flags.{name}` — boolean flag
 */
export interface StateEffect {
  type: 'state';
  /** Dot-separated path into game state (e.g. `"player.phase"`). See StateEffect doc for reserved-path conventions. */
  target: string;
  value: unknown;
}

/** Groups multiple effects into one, applied in order as a single unit. */
export interface CompositeEffect {
  type: 'composite';
  effects: IEffect[];
}

/** Applies one of two effects depending on whether a condition holds at evaluation time. */
export interface ConditionalEffect {
  type: 'conditional';
  condition: ICondition;
  /** Effect applied when the condition is true. */
  then: IEffect;
  /** Effect applied when the condition is false. Omit to do nothing on false. */
  else?: IEffect;
}

/**
 * Tagged-union root for declarative effects — the data shape content
 * authors hand to category factories. Resolved via {@link resolveEffect} and
 * applied through a {@link GameStateMutator}.
 */
export type IEffect =
  | ResourceEffect
  | UnlockEffect
  | StateEffect
  | CompositeEffect
  | ConditionalEffect;

/**
 * Tests a resource amount against a threshold using a comparison operator.
 * @internal
 */
export interface ResourceCondition {
  type: 'resource';
  target: string;
  /** Comparison applied as `resource.amount <operator> value`. */
  operator: 'gte' | 'lte' | 'gt' | 'lt' | 'eq';
  /** Threshold value to compare the resource amount against. */
  value: DecimalSource;
}

/**
 * True when the named unlock flag is set. Used to gate content behind prior progression.
 * @internal
 */
export interface UnlockCondition {
  type: 'unlock';
  target: string;
}

/**
 * Compares an arbitrary game state value at a dot-path against an expected value.
 * @internal
 */
export interface StateCondition {
  type: 'state';
  /** Dot-separated path into game state (e.g. `"player.phase"`). */
  target: string;
  /** Comparison operator applied as `state[target] <operator> value`. */
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
  value: unknown;
}

/**
 * True only when every child condition holds (short-circuits on first false).
 * @internal
 */
export interface AndCondition {
  type: 'and';
  conditions: ICondition[];
}

/**
 * True when at least one child condition holds (short-circuits on first true).
 * @internal
 */
export interface OrCondition {
  type: 'or';
  conditions: ICondition[];
}

/**
 * Inverts a condition: true when the wrapped condition is false, and vice versa.
 * @internal
 */
export interface NotCondition {
  type: 'not';
  condition: ICondition;
}

/**
 * Engine-internal IR for declarative predicates. Consumers author {@link Gate}
 * literals on content-def fields; the engine projects rate-aware Gate leaves
 * to ICondition via `gateToCondition` for walker / predictor reuse. Embedded
 * by {@link ConditionalEffect} as the conditional-effect IR.
 *
 * Not part of the public surface — kept as a typed interchange shape between
 * the Gate projection and the IEffect / walker machinery that already speaks
 * it. Import from `@/primitives/types` for cross-module internal use.
 *
 * @internal
 */
export type ICondition =
  | ResourceCondition
  | UnlockCondition
  | StateCondition
  | AndCondition
  | OrCondition
  | NotCondition;

/** A single step in a modifier chain: transforms a Decimal value and optionally inverts it. */
export interface IModifier {
  /** Forward transformation — applies the modifier's effect to `value`. */
  apply(value: Decimal): Decimal;
  /** Inverse transformation — recovers the pre-modifier value from a post-modifier result. Required for "how much do I need" calculations. */
  invert?(value: Decimal): Decimal;
  enabled: boolean;
  /** Human-readable label shown in modifier breakdowns (e.g. `"+10% from upgrades"`). */
  description?: string;
}

/** Structured output produced by an {@link Analyzer} after a headless run completes. */
export interface AnalyzerResult {
  name: string;
  /** Scalar measurements collected during the run (e.g. `{ "peakGold": 4200, "loops": 12 }`). */
  metrics: Record<string, number | string | boolean>;
}

/** Observer attached to a headless run that collects metrics per tick and optionally per finalized loop. */
export interface Analyzer {
  name: string;
  /** Called once before the first tick. Use to initialize accumulators. */
  onStart?(): void;
  /** Called after each tick. `tick` is the zero-based tick index. */
  onTick?(tick: number): void;
  /** Called once after the last tick. Use to finalize aggregated metrics. */
  onEnd?(): void;
  /**
   * Called once per finalized loop when the analyzer is attached to a cell
   * whose engine publishes a LoopLog — `createSensitivityCell` discovers the
   * log via `engine.tryInject(LoopLogKey)` and auto-subscribes. The entry
   * shape is structurally compatible with `LoopLogEntry` from the loop-log
   * system, so analyzers wired directly to `log.on('finalize', ...)` outside
   * a harness cell also satisfy this hook.
   */
  onLoopFinalize?(entry: {
    loopNumber: number;
    elapsed: number;
    timestamp: number;
    deltas: ReadonlyArray<{
      key: string;
      start: Decimal;
      end: Decimal;
      delta: Decimal;
    }>;
    context: Record<string, unknown>;
  }): void;
  /** Produces the final {@link AnalyzerResult} after the run ends. */
  summarize(): AnalyzerResult;
}

/** A candidate value paired with a relative probability weight for weighted random selection. */
export interface WeightedItem<T> {
  item: T;
  /** Relative probability weight. Higher values make this item more likely to be chosen. */
  weight: number;
}

/** Read-only view of game state used when evaluating conditions and resolving effects. */
export interface GameStateAccessor {
  /** Returns the current amount of the named resource. */
  getResource(id: string): Decimal;
  /** Returns whether the named unlock flag is currently set. */
  isUnlocked(id: string): boolean;
  /** Returns the value at a dot-separated state path (e.g. `"player.phase"`). */
  getState(path: string): unknown;
  /**
   * Returns the current net flow rate for the named resource, in resource-units per second.
   *
   * Games implement this in terms of their own economy — gross production, net of drains,
   * tunable overrides, or any mix. The transition-distance primitives
   * (`timeUntilResource`, `timeUntilAffordable`, `timeUntilConditionFlip`) call this to
   * compute "when does X happen" without owning rate semantics themselves.
   *
   * Accessors without a rate concept should return `Decimal.dZero` — transition helpers
   * interpret a zero rate as "no-rate, uncomputable distance."
   */
  getRate(id: string): Decimal;
}

/**
 * Typed symbol key for module provide/inject — mirrors Vue's InjectionKey pattern.
 *
 * Create keys as typed symbols:
 * ```ts
 * export const HealthKey: InjectionKey<HealthAPI> = Symbol('health');
 * ```
 */
export type InjectionKey<T> = symbol & { __type?: T };
