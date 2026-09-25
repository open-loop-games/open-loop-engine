/**
 * Measurement harness types — cartesian `cells × seeds` plan over `runHeadless`,
 * preserving raw per-run results and producing namespaced numeric aggregates.
 *
 * Sync-pure — parallelism lives in consumer code; see {@link WorkItem} and
 * the `createWorkPlan` seam.
 */

import type { Analyzer, GameStateAccessor } from '@/primitives/types';
import type { HeadlessResult } from '@/core/headless';
import type { Engine } from '@/engine';

/**
 * Run-loop mode shared by {@link runUntil} and {@link runMatrixUntil}.
 *
 * - `'tick'` (default) — fixed-tick `simulateTick(tickDelta)` loop, predicate
 *   evaluated each iteration. Content-blind.
 * - `'event'` — walker-visible event-stepping. Builds an {@link createIncrementalSnapshot}
 *   per iteration, advances by the smallest finite transition distance, falls
 *   back to fixed-tick on `'opaque-present'` / fast-tick on `'no-finite-transition'`.
 *   Predicate fire-time can be resolved within an advance via
 *   {@link RunUntilConfig.bisectTolSec}. Requires an accessor — modes other
 *   than `'tick'` introspect content through the walker — and takes no
 *   analyzers, since advances are variable-length.
 * - `'stasis-aware-tick'` — fixed-tick loop with a per-tick stasis check via
 *   {@link createTransitionSnapshot}. When the snapshot reports no finite or
 *   opaque-predicate transition, the run terminates with `terminated: 'unreachable'`.
 *   Requires an accessor.
 */
export type RunMode = 'tick' | 'event' | 'stasis-aware-tick';

/**
 * Context passed to a {@link Cell}'s `setup` function. Carries the seed in
 * use for this run — setup owns analyzer construction and returns the list
 * itself, so runHeadless can wire them to a freshly-built engine.
 */
export interface RunContext {
  seed: number;
}

/**
 * One named configuration in a matrix. Mirrors {@link HeadlessConfig} but
 * without the `seed` field — the harness supplies that per work item. Setup
 * constructs and returns the analyzer list for this run; metric-free cells
 * return `[]`.
 */
export interface Cell {
  name: string;
  setup: (ctx: RunContext) => Analyzer[];
  tick: (dt: number) => void;
  /** Total number of ticks to simulate for this cell. */
  ticks: number;
  /** Seconds of simulated time per tick (default 0.05, i.e. 20 TPS). */
  tickDelta?: number;
  /**
   * Called after each run's analyzers have summarized, before the next run
   * sets up — release what `setup` built (e.g. dispose the run's engine).
   */
  teardown?: () => void;
}

/**
 * One unit of work in a flat cell×seed plan. `createWorkPlan` returns an
 * array of these in stable iteration order; consumers wiring a worker pool
 * map through the array instead of reshaping the loop. Parameterized by
 * cell shape so until-runners (with {@link UntilCell}) can share the same
 * planner.
 */
export interface WorkItem<C = Cell> {
  cellIdx: number;
  seedIdx: number;
  seed: number;
  cell: C;
}

/**
 * Numeric summary of one metric across a cell's runs. `count` reflects the
 * number of numeric samples observed — non-numeric samples (strings,
 * booleans) are dropped during aggregation, so a metric that produced four
 * numeric and two string samples reports `count: 4`.
 *
 * `stddev` is population standard deviation (`sqrt(Σ(x-µ)²/n)`), chosen so
 * single-sample cells return `0` cleanly rather than `NaN`. `p5`/`p50`/`p95`
 * use floor-index selection on the sorted sample (same convention as
 * `core/profiler.ts` and the bench runner), so `p50` is the upper middle
 * value of an even-sized sample. `median` is the true median, the mean of
 * the middle pair; the two differ for every even count, so pick one per
 * comparison and don't mix them across it.
 */
export interface MetricStats {
  min: number;
  max: number;
  avg: number;
  stddev: number;
  median: number;
  p5: number;
  p50: number;
  p95: number;
  count: number;
}

/**
 * Counts of samples falling into consumer-declared buckets for one metric.
 * `edges` has N+1 entries defining N buckets; `counts[i]` is the number of
 * samples in `[edges[i], edges[i+1])` for `i < N-1`, and `[edges[N-1],
 * edges[N]]` (closed on both sides) for the final bucket. Samples below
 * `edges[0]` count into `underflow`; samples above `edges[N]` count into
 * `overflow` — so the histogram is lossless by construction.
 */
export interface MetricHistogram {
  edges: number[];
  counts: number[];
  underflow: number;
  overflow: number;
}

/**
 * Consumer-supplied histogram spec for one metric. Keyed by the same
 * `${analyzerName}.${metricKey}` namespace that `CellAggregate.metrics`
 * uses. `edges` must have at least two entries in ascending order.
 */
export interface HistogramSpec {
  edges: number[];
}

/**
 * Options threaded through {@link MatrixConfig} (and the batch/sensitivity
 * wrappers) to opt into histogram bucketing for specific metrics. Percentile
 * outputs (`p5`/`p50`/`p95`) are always computed — they're cheap relative
 * to the sort already done for `median`. Histograms are opt-in because
 * edge choice is domain-specific.
 */
export interface AggregateOptions {
  /**
   * Per-metric histogram specs, keyed `${analyzerName}.${metricKey}`.
   * Metrics not listed produce no histogram output; metrics listed that
   * produced no numeric samples are omitted from {@link
   * CellAggregate.histograms}.
   */
  histograms?: Record<string, HistogramSpec>;
  /**
   * Opt into a histogram of predicate-termination times for
   * {@link runMatrixUntil}. Ignored by {@link runMatrix}. Edges are in
   * sim-seconds to match {@link CellAggregate.terminationTime}.
   */
  terminationTimeHistogram?: HistogramSpec;
}

/**
 * Per-cell aggregated metrics, keyed `${analyzerName}.${metricKey}` to
 * prevent cross-analyzer collisions. Numeric-only — string/boolean metric
 * aggregation (mode, distribution) is deferred until a consumer demands
 * it. `histograms` is present only when the matrix config opts in via
 * {@link AggregateOptions.histograms}.
 *
 * The `termination*` fields are populated only by {@link runMatrixUntil};
 * `runMatrix` leaves them `undefined`. They describe *when* the
 * per-run predicate fired across the seed sweep — the headline metric for
 * beat-timing probes that assert distributions of sim-time-to-condition
 * rather than presence at a fixed tick budget.
 */
export interface CellAggregate {
  metrics: Record<string, MetricStats>;
  histograms?: Record<string, MetricHistogram>;
  /**
   * Stats over `elapsedSimulated` for runs that ended with
   * `terminated: 'predicate'`. Runs that hit `maxSimTime` are excluded so
   * the distribution isn't polluted by the ceiling. Absent when no runs
   * terminated on the predicate.
   */
  terminationTime?: MetricStats;
  /**
   * Count of runs by termination reason. `predicate + maxSimTime + unreachable`
   * always equals the seed count for a {@link runMatrixUntil} cell.
   * `unreachable` is non-zero only for runs in `'event'` or
   * `'stasis-aware-tick'` mode that observed stasis.
   */
  terminationCounts?: { predicate: number; maxSimTime: number; unreachable: number };
  /**
   * Histogram of predicate-terminated runs' `elapsedSimulated`, present
   * only when {@link AggregateOptions.terminationTimeHistogram} is
   * supplied and at least one run terminated on the predicate.
   */
  terminationTimeHistogram?: MetricHistogram;
}

/**
 * A completed cell's output. Raw per-run results are preserved — consumers
 * that need medians, filtering, or per-run end-reason access read `runs`
 * directly; `aggregate` is a convenience layer. `R` is the per-run result:
 * {@link RunUntilResult} from the until-runners, which carries `terminated`.
 */
export interface CellResult<R extends HeadlessResult = HeadlessResult> {
  name: string;
  runs: R[];
  aggregate: CellAggregate;
}

/**
 * Top-level matrix runner config — N cells × M seeds, run synchronously in
 * deterministic order. The runner re-runs each cell against every seed and
 * surfaces both raw per-run results (via `runs`) and namespaced numeric
 * aggregates (via `aggregate`). Callback fields fire in iteration order;
 * histogram opt-in lives on `aggregate`.
 */
export interface MatrixConfig {
  cells: Cell[];
  seeds: number[];
  /** Fires after each individual `(cell, seed)` run completes, in deterministic order. */
  onRunComplete?: (item: WorkItem, result: HeadlessResult) => void;
  /** Fires once a cell's full seed sweep is complete, in deterministic order. */
  onCellComplete?: (cell: CellResult) => void;
  /** Opt into histogram bucketing; percentile outputs are always computed. */
  aggregate?: AggregateOptions;
}

/** Output of a {@link runMatrix} sweep — one {@link CellResult} per input cell, in cell order. */
export interface MatrixResult {
  cells: CellResult[];
}

/**
 * N configurations × M seeds with no variant semantics. Thin wrapper around
 * {@link MatrixConfig} — provided separately so callers that just want a
 * batch run don't have to reach for the "cells" vocabulary.
 */
export interface BatchConfig {
  configs: Cell[];
  seeds: number[];
  onRunComplete?: (item: WorkItem, result: HeadlessResult) => void;
  onCellComplete?: (cell: CellResult) => void;
  aggregate?: AggregateOptions;
}

/**
 * A named config patch — the generic equivalent of borglike's domain-
 * specific `excludeUpgrades` axis. `patch` receives the baseline cell and
 * returns a new cell; the harness re-labels the returned cell with
 * `variant.name` so variant identity is stable regardless of what the patch
 * does to the underlying name.
 *
 * Generic over cell shape so the same shape carries fixed-tick
 * ({@link Cell}) and predicate-bounded ({@link UntilCell}) variant
 * sweeps. Defaults to `Cell` for source-compatible fixed-tick callers.
 */
export interface Variant<C extends Cell | UntilCell = Cell> {
  name: string;
  patch: (baseline: C) => C;
}

/**
 * One axis in a cartesian sensitivity sweep — a label, the values to try,
 * and a `(baseline, value)` patch. Each axis desugars to one variant per
 * `values[]` entry; multiple axes produce the cartesian product, named
 * `"${axis1}=${v1} × ${axis2}=${v2} × …"`.
 *
 * Authoring ergonomic for the common "sweep this knob across these values"
 * case — equivalent to manually emitting one {@link Variant} per `value`,
 * but keeps the axis identity legible at the call site.
 */
export interface SweepAxis<V, C extends Cell | UntilCell = Cell> {
  name: string;
  values: V[];
  /** Apply this axis's value to the baseline cell, producing a new cell. */
  patch: (baseline: C, value: V) => C;
}

/**
 * Baseline-plus-variants sweep config consumed by {@link runSensitivity}.
 * Mirrors {@link MatrixConfig}'s callback + aggregate shape, with the
 * cell list split into baseline + variant patches so the runner knows
 * which result to diff against.
 *
 * Generic over cell shape:
 * - `C extends Cell` (default) — fixed-tick sweep, runs via {@link runMatrix}.
 * - `C extends UntilCell` — predicate-bounded sweep, runs via
 *   {@link runMatrixUntil}. Requires {@link until} and {@link maxSimTime};
 *   `mode`/`bisectTolSec`/`stasisProbeInterval` opt-in per
 *   {@link MatrixUntilConfig}.
 *
 * Variants may be supplied flat (`variants[]`) or axis-grouped (`axes[]`,
 * each axis expanded to one variant per value). Both can be supplied at
 * once — axis-expanded variants are appended after flat ones. An empty
 * variant set is allowed (runs the baseline only) so consumers can
 * exercise per-run setup hooks like {@link createSensitivityCell}'s
 * `perturb` against the baseline alone.
 */
export interface SensitivityConfig<C extends Cell | UntilCell = Cell> {
  baseline: C;
  /** Flat variant patches. Combined with {@link axes} if both supplied. */
  variants?: Variant<C>[];
  /**
   * Axis-grouped variants. Each axis expands to one variant per value;
   * multiple axes produce the cartesian product. Combined with
   * {@link variants} if both supplied.
   */
  axes?: SweepAxis<unknown, C>[];
  seeds: number[];
  onRunComplete?: (
    item: WorkItem<C>,
    result: C extends UntilCell ? RunUntilResult : HeadlessResult,
  ) => void;
  onCellComplete?: (cell: CellResult) => void;
  aggregate?: AggregateOptions;
  /**
   * Termination predicate. Set this to switch the sweep to predicate-bounded
   * mode — baseline + variants must all be {@link UntilCell}s, and
   * {@link maxSimTime} becomes required. Absent means fixed-tick.
   */
  until?: UntilPredicate;
  /** Sim-seconds ceiling per run. Required when {@link until} is set. */
  maxSimTime?: number;
  /**
   * Run mode applied uniformly to every cell. Defaults to `'tick'`.
   * Only meaningful when {@link until} is set; ignored otherwise. See
   * {@link RunMode}.
   */
  mode?: RunMode;
  /** See {@link RunUntilConfig.bisectTolSec}. Ignored when `mode !== 'event'`. */
  bisectTolSec?: number;
  /** See {@link RunUntilConfig.stasisProbeInterval}. Ignored when `mode !== 'event'`. */
  stasisProbeInterval?: number;
}

/**
 * Per-metric delta between a variant cell and the baseline. `absolute` is
 * `variant.avg − baseline.avg`; `relative` is `absolute / baseline.avg`, or
 * `0` when the baseline average is zero (avoids infinity without hiding the
 * sign of the delta).
 */
export interface MetricDelta {
  absolute: number;
  relative: number;
}

/**
 * One variant's contribution to a {@link SensitivityResult}. `name` is the
 * variant identity (forced from {@link Variant.name}, not whatever the
 * `patch` function chose). `cell` is the variant's raw matrix output;
 * `deltas` is the per-metric diff against the baseline cell.
 */
export interface SensitivityVariantResult {
  name: string;
  cell: CellResult;
  /**
   * Per-metric deltas vs the baseline cell, keyed by the same
   * `${analyzerName}.${metricKey}` namespace as {@link CellAggregate.metrics}.
   * A predicate-bounded sweep adds `'termination.time'`, the delta of the
   * mean predicate fire time, when both cells have one.
   */
  deltas: Record<string, MetricDelta>;
}

/**
 * Output of a sensitivity sweep — baseline cell plus one entry per variant,
 * in the same order as {@link SensitivityConfig.variants}. Each variant
 * carries its own {@link CellResult} and a metric-keyed delta map vs the
 * baseline.
 */
export interface SensitivityResult {
  baseline: CellResult;
  variants: SensitivityVariantResult[];
}

// =============================================================================
// Until-runners — predicate-driven alternatives to the fixed-tick primitives.
// Engine-aware (consume `Engine` directly and call
// `engine.tickDriver.simulateTick(tickDelta)`), in contrast to the decoupled
// `tick`-callback shape of {@link runHeadless} and {@link runMatrix}. The
// matrix variant's headline output is the distribution of *termination times*
// — when each seed's predicate fired — surfaced as first-class fields on
// {@link CellAggregate}.
// =============================================================================

/**
 * Snapshot passed to an `until` predicate each time it's evaluated. Carries
 * the running tick count and the derived `simTime` so predicates can assert
 * sim-time windows without closing over the tick counter themselves. Game
 * state is out of scope — consumers read it via closure over their own
 * engine or setup-captured refs.
 */
export interface UntilContext {
  /**
   * Loop iterations completed so far — one per `tickDelta` step in the tick
   * modes. In event mode it counts advances and fast-ticks, each of any length.
   */
  tick: number;
  /**
   * Simulated seconds elapsed so far. Equals `tick * tickDelta` in tick mode;
   * in event mode advances are variable-length (plus fast-ticks), so it tracks
   * actual advanced sim-time and the `tick * tickDelta` identity does not hold.
   */
  simTime: number;
}

/**
 * Predicate evaluated before each tick in a {@link runUntil} loop. Returning
 * `true` terminates the run with `terminated: 'predicate'`.
 */
export type UntilPredicate = (ctx: UntilContext) => boolean;

/**
 * Configuration for a single predicate-bounded run. The engine is consumed
 * directly — `runUntil` drives it via `engine.tickDriver.simulateTick(tickDelta)`
 * rather than a consumer-supplied tick callback. The engine must be started
 * (`engine.start()`) before calling `runUntil`.
 */
export interface RunUntilConfig {
  /** Engine to drive. Must be started before the call. */
  engine: Engine;
  /** Termination predicate. Evaluated once before every simulateTick, including tick 0. */
  until: UntilPredicate;
  /**
   * Upper bound on simulated time, in seconds. Required — prevents runaway
   * predicates from hanging the caller. Runs that reach this bound without
   * predicate satisfaction terminate with `terminated: 'maxSimTime'`.
   */
  maxSimTime: number;
  /**
   * Seconds of sim-time per tick. Defaults to `0.05` (matches
   * {@link runHeadless}). The engine advances by exactly this amount per
   * iteration, independent of its live `tickRate`. Variable-mode engines
   * process one tick at this dt, or equal ticks under `maxDeltaTime` when it
   * exceeds the cap — so coarsening is a real speedup only up to the cap;
   * fixed-mode engines drain the accumulator at their internal `stepSize`
   * until `tickDelta` is consumed. In event mode it is the minimum advance
   * and the fast-tick step.
   */
  tickDelta?: number;
  /**
   * Analyzer factory. Called once before the tick loop. In the tick modes
   * the analyzer lifecycle (`onStart`/`onTick`/`onEnd`) mirrors
   * {@link runHeadless}, and `onTick` receives the tick index that was just
   * stepped. Event mode throws if it returns any analyzers.
   */
  setup?: () => Analyzer[];
  /** Optional RNG seed; seeds the global Alea instance before `setup`. */
  seed?: number;
  /**
   * Run mode. Defaults to `'tick'`. See {@link RunMode}. Modes other than
   * `'tick'` require {@link accessor} to be set; throws at entry otherwise.
   */
  mode?: RunMode;
  /**
   * Read-side accessor used by `'event'` and `'stasis-aware-tick'` modes to
   * resolve resource amounts, rates, unlocks, and state paths into walker
   * transition distances. Must read the same state the engine ticks against.
   */
  accessor?: GameStateAccessor;
  /**
   * In `'event'` mode, resolve predicate fire time by bisecting within the
   * advance that crossed it. Checkpoints `engine.saveManager.exportSave()`
   * and RNG state before each advance; if the predicate flips during a
   * single advance, binary-searches `dt` in `[0, advanced]` until
   * `|high - low| <= bisectTolSec`. Requires the engine to have a
   * `saveManager` (i.e., `persistence !== false`); throws at entry otherwise,
   * and mid-run if a checkpoint fails to restore. Without this option,
   * predicate-fire `simTime` is bounded by the advance distance, which for
   * event-mode runs can be hundreds of seconds. Ignored in other modes.
   */
  bisectTolSec?: number;
  /**
   * In `'event'` mode, rebuild the snapshot every Nth tick while inside the
   * stasis fast-tick loop to detect exit-from-stasis (clicks, onTick
   * subscriptions, future `TimedInput`). Default `100`. Trades ~1%
   * worst-case wall against bounded latency-to-resume for event-stepping.
   */
  stasisProbeInterval?: number;
}

/**
 * Result of a predicate-bounded run. Shape is a superset of
 * {@link HeadlessResult}, adding `terminated` so consumers can distinguish
 * predicate satisfaction from hitting the sim-time ceiling.
 */
export interface RunUntilResult {
  /**
   * Number of ticks actually stepped (0 when the predicate was true at tick 0).
   * In event mode, the count of advances and fast-ticks, which vary in length.
   */
  totalTicks: number;
  /**
   * The run's sim-time at termination. Equals `totalTicks * tickDelta` in tick
   * mode; in event mode (variable-length advances + fast-ticks) it is the
   * accumulated advanced sim-time, not that product.
   */
  elapsedSimulated: number;
  /**
   * How the run ended.
   *
   * - `'predicate'` — the `until` predicate fired.
   * - `'maxSimTime'` — the sim-time ceiling was reached without the predicate
   *   firing.
   * - `'unreachable'` — `'event'` or `'stasis-aware-tick'` mode observed
   *   stasis (no walker-visible transition can mechanically push state
   *   forward) before the predicate fired or the ceiling was reached.
   *   Conservative: opaque-predicate transitions block this classification.
   *   Event mode reports it when the budget runs out in stasis with every
   *   dependency the walker tracks unchanged across that stretch; if a source
   *   the walker can't see moved one, the run is a plain `'maxSimTime'`.
   */
  terminated: 'predicate' | 'maxSimTime' | 'unreachable';
  /** One result object per analyzer, in setup order. */
  analyzerResults: HeadlessResult['analyzerResults'];
}

/**
 * One cell in a {@link runMatrixUntil} sweep. Each `(cell, seed)` pair gets
 * a freshly-built engine via `buildEngine(ctx)`; analyzers close over that
 * engine per run so per-run state bleed can't happen.
 */
export interface UntilCell {
  name: string;
  /**
   * Build a fresh engine for this `(cell, seed)`. Consumers typically call
   * `createEngine` or `createEngineFromSave` here; the engine must be
   * started (the helper or consumer calls `engine.start()`). The global RNG
   * is seeded with `ctx.seed` just before the call, so construction draws
   * don't depend on sweep order, and reseeded before the first tick. The
   * runner stops the engine after its run; disposing it is `teardown`'s job.
   */
  buildEngine: (ctx: RunContext) => Engine;
  /**
   * Read-side accessor factory. Required when {@link MatrixUntilConfig.mode}
   * is `'event'` or `'stasis-aware-tick'` — those modes introspect content
   * through the walker. Called once per `(cell, seed)` alongside
   * `buildEngine`. The accessor must read the same state the engine ticks
   * against; stasis/event resolution is only as sound as the distances the
   * walker computes from it.
   */
  buildAccessor?: (engine: Engine) => GameStateAccessor;
  /**
   * Analyzer factory. Closes over the freshly-built engine so analyzers
   * can read engine state without reaching for module-level refs.
   * Omit for metric-free cells. Event mode throws if it returns any
   * analyzers — see {@link RunUntilConfig.setup}.
   */
  analyzers?: (engine: Engine, ctx: RunContext) => Analyzer[];
  /** Optional per-cell tick delta override. Defaults to `0.05`. */
  tickDelta?: number;
  /**
   * Called once per run after `onRunComplete`, and after a run that throws —
   * release what `buildEngine` built (typically `engine.dispose()`). The
   * runner only stops the engine, so without this every engine a sweep
   * builds stays reachable until the sweep returns.
   */
  teardown?: (engine: Engine, ctx: RunContext) => void;
}

/** One unit of work in a flat `cells × seeds` until-sweep. */
export type MatrixUntilWorkItem = WorkItem<UntilCell>;

/**
 * Configuration for {@link runMatrixUntil} — `cells × seeds` predicate-bounded
 * sweep. The shared `until` predicate and `maxSimTime` ceiling apply to every
 * run; callbacks mirror {@link MatrixConfig}.
 */
export interface MatrixUntilConfig {
  cells: UntilCell[];
  seeds: number[];
  /** Termination predicate shared across every `(cell, seed)` run. */
  until: UntilPredicate;
  /** Sim-seconds ceiling per run. Required. */
  maxSimTime: number;
  /** Fires after each individual `(cell, seed)` run completes, in deterministic order. */
  onRunComplete?: (item: MatrixUntilWorkItem, result: RunUntilResult) => void;
  /** Fires once a cell's full seed sweep is complete, in deterministic order. */
  onCellComplete?: (cell: CellResult<RunUntilResult>) => void;
  aggregate?: AggregateOptions;
  /**
   * Run mode applied uniformly to every cell. Defaults to `'tick'`. When
   * `'event'` or `'stasis-aware-tick'`, every {@link UntilCell} must supply
   * {@link UntilCell.buildAccessor}; the runner throws at entry otherwise.
   * See {@link RunMode}.
   */
  mode?: RunMode;
  /** See {@link RunUntilConfig.bisectTolSec}. Ignored when `mode !== 'event'`. */
  bisectTolSec?: number;
  /** See {@link RunUntilConfig.stasisProbeInterval}. Ignored when `mode !== 'event'`. */
  stasisProbeInterval?: number;
}

/** Output of a {@link runMatrixUntil} sweep — one {@link CellResult} per input cell. */
export interface MatrixUntilResult {
  cells: CellResult<RunUntilResult>[];
}
