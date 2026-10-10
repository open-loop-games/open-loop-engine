import type { Decimal, DecimalSource } from './decimal';

/** Modifies a numeric resource by adding, subtracting, multiplying, or setting its value. */
export interface ResourceEffect {
  kind: 'resource';
  target: string;
  /** Arithmetic operation to apply to the resource's current amount. */
  operation: 'add' | 'subtract' | 'multiply' | 'set';
  /** Amount to use in the operation. May be a Formula with an `evaluate()` method. */
  value: DecimalSource | { evaluate(): DecimalSource };
}

/** Sets an unlock flag to true or false, controlling feature/content visibility. */
export interface FlagEffect {
  kind: 'flag';
  target: string;
  /** Whether the target should become unlocked (`true`) or locked (`false`). */
  value: boolean;
}

/** Writes an arbitrary value to a dot-path in game state (e.g. `"player.phase"`). */
export interface StateEffect {
  kind: 'state';
  /** Dot-separated path into game state (e.g. `"player.phase"`). */
  path: string;
  value: unknown;
}

/** Groups multiple effects into one, applied in order as a single unit. */
export interface CompositeEffect {
  kind: 'composite';
  effects: IEffect[];
}

/**
 * Applies one of two effects depending on whether a condition holds at evaluation time.
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
  /** Effect applied when the condition is true. */
  then: IEffect;
  /** Effect applied when the condition is false. Omit to do nothing on false. */
  else?: IEffect;
}

/**
 * Tagged-union root for declarative effects — the data shape content
 * authors hand to category factories. Resolved via {@link resolveEffect} and
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
 * narrow on `type: 'branch'`. Not part of the public surface.
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
 * True when the named unlock flag is set. Used to gate content behind prior progression.
 * @internal
 */
export interface FlagCondition {
  kind: 'flag';
  target: string;
}

/**
 * Compares an arbitrary game state value at a dot-path against an expected value.
 * @internal
 */
export interface StateCondition {
  kind: 'state';
  /** Dot-separated path into game state (e.g. `"player.phase"`). */
  path: string;
  /** Comparison operator applied as `state[target] <operator> value`. */
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
  value: unknown;
}

/**
 * True only when every child condition holds (short-circuits on first false).
 * @internal
 */
export interface AllCondition {
  kind: 'all';
  conditions: ICondition[];
}

/**
 * True when at least one child condition holds (short-circuits on first true).
 * @internal
 */
export interface AnyCondition {
  kind: 'any';
  conditions: ICondition[];
}

/**
 * Inverts a condition: true when the wrapped condition is false, and vice versa.
 * @internal
 */
export interface NotCondition {
  kind: 'not';
  condition: ICondition;
}

/**
 * Engine-internal IR for declarative predicates. Consumers author {@link Gate}
 * literals on content-def fields; the engine projects accessor-backed Gate
 * leaves to ICondition via `gateToCondition`. Embedded by the internal
 * {@link BranchEffect} as the conditional-effect IR (unreachable from
 * the public {@link IEffect} union).
 *
 * Not part of the public surface — kept as a typed interchange shape between
 * the Gate projection and the IEffect / walker machinery that already speaks
 * it. Import from `@/primitives/types` for cross-module internal use.
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

/** Structured output produced by an {@link Analyzer} after a headless run completes. */
export interface AnalyzerSummary {
  id: string;
  /** Scalar measurements collected during the run (e.g. `{ "peakGold": 4200, "cycles": 12 }`). */
  metrics: Record<string, number | string | boolean>;
}

/** Observer attached to a headless run that collects metrics per tick and optionally per finalized cycle. */
export interface Analyzer {
  id: string;
  /** Called once before the first tick. Use to initialize accumulators. */
  onStart?(): void;
  /** Called after each tick. `tick` is the zero-based tick index. */
  onTick?(tick: number): void;
  /** Called once after the last tick. Use to finalize aggregated metrics. */
  onEnd?(): void;
  /**
   * Called once per finalized cycle when the analyzer is attached to a cell
   * whose engine publishes a CycleLog — `createSensitivityCell` discovers the
   * log via `engine.tryInject(CycleLogKey)` and auto-subscribes. The entry
   * shape is structurally compatible with `CycleLogEntry` from the cycle-log
   * system, so analyzers wired directly to `log.on('finalized', ...)` outside
   * a harness cell also satisfy this hook.
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
  /** Produces the final {@link AnalyzerSummary} after the run ends. */
  summarize(): AnalyzerSummary;
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
  getAmount(id: string): Decimal;
  /** Returns whether the named unlock flag is currently set. */
  getFlag(id: string): boolean;
  /** Returns the value at a dot-separated state path (e.g. `"player.phase"`). */
  getStateAt(path: string): unknown;
  /**
   * Returns the current net flow rate for the named resource, in resource-units per second.
   *
   * Games implement this in terms of their own economy — gross production, net of drains,
   * tunable overrides, or any mix. The transition-distance primitives
   * (`timeUntilResource`, `timeUntilAffordable`, `timeUntilGateFlip`) call this to
   * compute "when does X happen" without owning rate semantics themselves.
   *
   * Accessors without a rate concept should return `Decimal.dZero` — transition helpers
   * interpret a zero rate as "no-rate, uncomputable distance."
   */
  getRate(id: string): Decimal;
  /**
   * Returns the gross inflow rate for the named resource: what it gains per second before
   * any drain, so never less than {@link GameStateAccessor.getRate} and never negative.
   *
   * Optional. `timeUntilGateFlip` reads it to predict a `cumulative-gte` gate, since the
   * lifetime total grows by inflow alone. Without it the net rate stands in, which
   * overstates the time whenever something drains the resource.
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
