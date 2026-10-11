import type { Decimal, DecimalSource } from './decimal';

/** Changes a resource's amount by adding, subtracting, multiplying, or setting it. */
export interface ResourceEffect {
  kind: 'resource';
  target: string;
  /** Arithmetic operation to apply to the resource's current amount. */
  operation: 'add' | 'subtract' | 'multiply' | 'set';
  /** Amount to use in the operation. May be a Formula with an `evaluate()` method. */
  value: DecimalSource | { evaluate(): DecimalSource };
}

/** Sets a flag to true or false, for example to control whether content is available. */
export interface FlagEffect {
  kind: 'flag';
  target: string;
  /** The value the flag is set to. */
  value: boolean;
}

/** Writes any value at a state path in game state (e.g. `"player.phase"`). */
export interface StateEffect {
  kind: 'state';
  /** State path, dot-separated (e.g. `"player.phase"`). */
  path: string;
  value: unknown;
}

/** Groups multiple effects into one, applied in order as a single unit. */
export interface CompositeEffect {
  kind: 'composite';
  effects: IEffect[];
}

/**
 * Applies one of two effects, chosen by whether its condition IR holds when the effect is resolved.
 *
 * Engine-internal IR: consumers construct via `E.branch(gate, then, otherwise?)`
 * which returns the public {@link IEffect} opaquely, so the embedded
 * {@link ICondition} is unreachable through the public type system.
 *
 * @internal
 */
export interface BranchEffect {
  kind: 'branch';
  condition: ICondition;
  /** Effect applied when `condition` holds. */
  then: IEffect;
  /** Effect applied when `condition` does not hold. Omit to do nothing then. */
  else?: IEffect;
}

/**
 * Tagged-union root for declarative effects — the data shape consumers hand
 * to category factories. Resolved via {@link resolveEffect} and
 * applied through a {@link GameStateMutator}.
 *
 * Branch effects (built via `E.branch`) are part of the internal IR
 * ({@link IEffectInternal}) and aren't members of this public union — consumers
 * receive them opaquely typed as `IEffect`, so the embedded ICondition can't
 * be reached through union narrowing.
 */
export type IEffect = ResourceEffect | FlagEffect | StateEffect | CompositeEffect;

/**
 * Engine-internal effect IR — the full union including {@link BranchEffect}.
 * Used by `resolveEffect` / `applyEffect` / walker machinery that needs to
 * narrow on `kind: 'branch'`. Not part of the public API surface.
 *
 * @internal
 */
export type IEffectInternal = IEffect | BranchEffect;

/**
 * Tests a resource amount against a threshold using a comparison operator.
 * @internal
 */
export interface ResourceCondition {
  kind: 'resource';
  target: string;
  /** Comparison applied as `resource.amount <operator> value`. */
  operator: 'gte' | 'lte' | 'gt' | 'lt' | 'eq';
  /** Threshold value to compare the resource amount against. */
  value: DecimalSource;
}

/**
 * True when the named flag is set. Used to block content until prior progress.
 * @internal
 */
export interface FlagCondition {
  kind: 'flag';
  target: string;
}

/**
 * Compares the game-state value at a state path against an expected value.
 * @internal
 */
export interface StateCondition {
  kind: 'state';
  /** State path, dot-separated (e.g. `"player.phase"`). */
  path: string;
  /** Comparison operator applied as `getStateAt(path) <operator> value`. */
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
  value: unknown;
}

/**
 * True only when every child holds (short-circuits on first false).
 * @internal
 */
export interface AllCondition {
  kind: 'all';
  conditions: ICondition[];
}

/**
 * True when at least one child holds (short-circuits on first true).
 * @internal
 */
export interface AnyCondition {
  kind: 'any';
  conditions: ICondition[];
}

/**
 * Inverts its child: true when the child does not hold, and vice versa.
 * @internal
 */
export interface NotCondition {
  kind: 'not';
  condition: ICondition;
}

/**
 * Condition IR — the engine-internal form of a declarative predicate.
 * Consumers author {@link Gate} literals on predicate fields; the engine
 * projects accessor-backed Gate leaves to ICondition via `gateToCondition`.
 * The internal {@link BranchEffect} embeds it as its condition (unreachable
 * from the public {@link IEffect} union).
 *
 * Not part of the public API surface. It is kept as a typed interchange shape
 * between the Gate projection and the IEffect / walker machinery that already
 * reads it. Import from `@/primitives/types` for cross-file internal use.
 *
 * @internal
 */
export type ICondition =
  | ResourceCondition
  | FlagCondition
  | StateCondition
  | AllCondition
  | AnyCondition
  | NotCondition;

/**
 * What an {@link Analyzer} reports after one headless run; cell aggregation keeps only its number metrics.
 * A string or boolean metric stays in each run's summary, and no aggregate counts it.
 */
export interface AnalyzerSummary {
  id: string;
  /** Scalar analyzer metrics collected during the headless run (e.g. `{ "peakGold": 4200, "runs": 12 }`). */
  metrics: Record<string, number | string | boolean>;
}

/**
 * Observer of one headless run that collects metrics per tick, and optionally
 * per finalized cycle-log entry.
 */
export interface Analyzer {
  id: string;
  /** Called once before the first tick. Use it to initialize running totals. */
  onStart?(): void;
  /** Called after each tick. `tick` is the zero-based tick index. */
  onTick?(tick: number): void;
  /** Called once after the last tick. Use it to compute final metrics. */
  onEnd?(): void;
  /**
   * Called once per finalized cycle-log entry when the analyzer is attached
   * to a cell whose engine publishes a CycleLog. `createSensitivityCell` finds
   * the log via `engine.tryInject(CycleLogKey)` and subscribes to it. The
   * entry shape is structurally compatible with `CycleLogEntry` from the
   * cycle-log system. So an analyzer wired directly to
   * `log.on('finalized', ...)` outside a balance-harness cell also fits this
   * method.
   */
  onRunFinalize?(entry: {
    runNumber: number;
    elapsed: number;
    timestamp: number;
    deltas: ReadonlyArray<{
      key: string;
      start: Decimal;
      end: Decimal;
      delta: Decimal;
    }>;
    annotations: Record<string, unknown>;
  }): void;
  /** Produces the final {@link AnalyzerSummary} after the headless run ends. */
  summarize(): AnalyzerSummary;
}

/** A candidate value paired with a relative probability weight for weighted random selection. */
export interface WeightedItem<T> {
  item: T;
  /** Relative probability weight. Higher values make this item more likely to be chosen. */
  weight: number;
}

/** Read-only view of game state used when evaluating predicates and resolving effects. */
export interface GameStateAccessor {
  /** Returns the current amount of the named resource. */
  getAmount(id: string): Decimal;
  /** Returns whether the named flag is currently set. */
  getFlag(id: string): boolean;
  /** Returns the value at a dot-separated state path (e.g. `"player.phase"`). */
  getStateAt(path: string): unknown;
  /**
   * Returns the current net rate for the named resource, in resource units per second.
   *
   * Games implement this in terms of their own economy — gross production minus what is
   * subtracted, tunable overrides, or any mix. The transition-distance primitives
   * (`timeUntilResource`, `timeUntilAffordable`, `timeUntilGateFlip`) call this to
   * compute "when does X happen" without owning rate semantics themselves.
   *
   * Accessors without a rate concept should return `Decimal.dZero`. The transition-distance
   * utilities read a zero rate as "no rate, transition distance not computable."
   */
  getRate(id: string): Decimal;
  /**
   * Returns the gross inflow rate for the named resource: what it gains per second before
   * anything is subtracted. So it is never less than {@link GameStateAccessor.getRate}, and
   * never negative.
   *
   * Optional. `timeUntilGateFlip` reads it to predict a `cumulative-gte` Gate, since the
   * lifetime total grows by inflow alone. Without it the net rate stands in, which
   * overstates the time whenever something subtracts from the resource.
   */
  getInflowRate?(id: string): Decimal;
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
