/**
 * Balance harness types — the cartesian `cells × seeds` plan over `runHeadless`.
 * It keeps the raw result of each headless run and produces numeric aggregates
 * under namespaced keys.
 *
 * Synchronous and pure: parallelism is in consumer code. See {@link WorkItem} and
 * the `createWorkPlan` seam.
 */

import type { Analyzer, GameStateAccessor } from '@/primitives/types';
import type { HeadlessResult } from '@/core/headless';
import type { Engine } from '@/engine';

/**
 * The run mode shared by {@link runUntil} and {@link runMatrixUntil}.
 *
 * - `'uniform'` (default) — a fixed-tick `advanceTime(tickDelta)` loop that
 *   evaluates the predicate each iteration. Content-blind.
 * - `'next-event'` — walker-visible event stepping. Builds an {@link createIncrementalSnapshot}
 *   per iteration and advances by the smallest finite transition distance. It falls
 *   back to a fixed tick on `'opaque-present'`, and to fast-ticks on `'no-finite-transition'`.
 *   {@link RunUntilOptions.bisectTolSec} can resolve the predicate's fire time
 *   within an advance. Requires an accessor, because modes other than `'uniform'`
 *   read content through the walker. Takes no analyzers, because advances vary in length.
 * - `'stasis-aware'` — a fixed-tick loop with a stasis check each iteration via
 *   {@link createTransitionSnapshot}. When the snapshot reports no finite or
 *   opaque-predicate transition, the headless run terminates with
 *   `terminated: 'unreachable'`. Requires an accessor.
 */
export type RunMode = 'uniform' | 'next-event' | 'stasis-aware';

/**
 * The context passed to a {@link Cell}'s `setup` function: the seed for this
 * headless run. `setup` builds the analyzers and returns the list, so
 * `runHeadless` can wire them to a newly built engine.
 */
export interface RunContext {
  seed: number;
}

/**
 * One named configuration in a matrix. Mirrors {@link HeadlessOptions} but
 * without the `seed` field: the balance harness supplies it per work item.
 * `setup` builds and returns the analyzer list for this headless run; metric-free cells
 * return `[]`.
 */
export interface Cell {
  id: string;
  setup: (ctx: RunContext) => Analyzer[];
  tick: (dt: number) => void;
  /** Total number of ticks to simulate for this cell. */
  ticks: number;
  /** Sim-seconds per tick. Defaults to `0.05`. */
  tickDelta?: number;
  /**
   * Called after the analyzers of each headless run have summarized, before
   * the next headless run sets up. Release what `setup` built here (e.g.
   * dispose its engine).
   */
  teardown?: () => void;
}

/**
 * One unit of work in a flat cell×seed plan. `createWorkPlan` returns an
 * array of these in stable iteration order. A consumer that spreads headless runs over
 * Web Workers maps over the array instead of reshaping the loop. Parameterized
 * by cell shape, so until-runners (with {@link UntilCell}) share the same
 * planner.
 */
export interface WorkItem<C = Cell> {
  cellIdx: number;
  seedIdx: number;
  seed: number;
  cell: C;
}

/**
 * Numeric summary of one metric across the headless runs of a cell. `count` reflects the
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
 * `overflow`. So the histogram loses no sample.
 */
export interface MetricHistogram {
  edges: number[];
  counts: number[];
  underflow: number;
  overflow: number;
}

/**
 * Histogram options for one metric. Keyed by the same
 * `${analyzerId}.${metricKey}` namespace that `CellAggregate.metrics`
 * uses. `edges` must have at least two entries in ascending order.
 */
export interface HistogramOptions {
  edges: number[];
}

/**
 * Options passed through {@link MatrixOptions} (and {@link SensitivityOptions})
 * to opt into histogram bucketing for specific metrics. Percentile outputs
 * (`p5`/`p50`/`p95`) are always computed, because they cost little next to
 * the sort already done for `median`. Histograms are opt-in because
 * edge choice is domain-specific.
 */
export interface AggregateOptions {
  /**
   * Histogram options per metric, keyed `${analyzerId}.${metricKey}`.
   * Metrics not listed produce no histogram output; metrics listed that
   * produced no numeric samples are omitted from {@link
   * CellAggregate.histograms}.
   */
  histograms?: Record<string, HistogramOptions>;
  /**
   * Opt into a histogram of predicate-termination times for
   * {@link runMatrixUntil}. Ignored by {@link runMatrix}. Edges are in
   * sim-seconds to match {@link CellAggregate.terminationTime}.
   */
  terminationTimeHistogram?: HistogramOptions;
}

/**
 * Per-cell aggregated metrics, keyed `${analyzerId}.${metricKey}` to
 * prevent cross-analyzer collisions. Numeric-only: string and boolean metric
 * aggregation (statistical mode, distribution) is deferred until a consumer
 * needs it. `histograms` is present only when the matrix options opt in via
 * {@link AggregateOptions.histograms}.
 *
 * The `termination*` fields are populated only by {@link runMatrixUntil};
 * `runMatrix` leaves them `undefined`. They describe *when* the
 * predicate of each headless run held across the seed sweep: the headline metric for
 * beat-timing probes that assert distributions of sim-time-to-condition
 * rather than presence at a fixed tick count.
 */
export interface CellAggregate {
  metrics: Record<string, MetricStats>;
  histograms?: Record<string, MetricHistogram>;
  /**
   * Stats over `elapsedSimulated` for headless runs that ended with
   * `terminated: 'predicate'`. Headless runs that hit `maxSimTime` are
   * excluded, so the sim-time cap does not distort the distribution. Absent
   * when no headless run terminated on the predicate.
   */
  terminationTime?: MetricStats;
  /**
   * Count of headless runs by termination reason. `predicate + maxSimTime + unreachable`
   * always equals the seed count for a {@link runMatrixUntil} cell.
   * `unreachable` is non-zero only for headless runs in `'next-event'` or
   * `'stasis-aware'` mode that observed stasis.
   */
  terminationCounts?: { predicate: number; maxSimTime: number; unreachable: number };
  /**
   * Histogram of the `elapsedSimulated` of predicate-terminated headless
   * runs. It is present only when
   * {@link AggregateOptions.terminationTimeHistogram} is supplied and at
   * least one headless run terminated on the predicate.
   */
  terminationTimeHistogram?: MetricHistogram;
}

/**
 * A completed cell's output. The raw result of each headless run is kept.
 * Consumers that need medians, filtering, or the end reason of each headless
 * run read `runs` directly; `aggregate` is a convenience over them. `R` is
 * the result of one headless run:
 * {@link RunUntilResult} from the until-runners, which has `terminated`.
 */
export interface CellResult<R extends HeadlessResult = HeadlessResult> {
  id: string;
  runs: R[];
  aggregate: CellAggregate;
}

/**
 * Options for the matrix runner: N cells × M seeds, run synchronously in
 * deterministic order. The runner runs each cell against every seed. It
 * returns both the raw headless-run results (via `runs`) and namespaced numeric
 * aggregates (via `aggregate`). Option callbacks fire in iteration order;
 * histogram opt-in is on `aggregate`.
 */
export interface MatrixOptions {
  cells: Cell[];
  seeds: number[];
  /** Fires after each `(cell, seed)` headless run completes, in deterministic order. */
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
 * A named change to the baseline cell: the generic form of a domain-specific
 * axis such as excluding upgrades. `patch` receives the baseline cell and
 * returns a new cell. The balance harness sets the returned cell's id to
 * `variant.id`, so variant identity is stable whatever id `patch` sets.
 *
 * Generic over cell shape, so one type serves fixed-tick ({@link Cell}) and
 * predicate-bounded ({@link UntilCell}) variant sweeps. Defaults to `Cell`.
 */
export interface Variant<C extends Cell | UntilCell = Cell> {
  id: string;
  patch: (baseline: C) => C;
}

/**
 * One sweep axis of a cartesian sensitivity sweep: an id, the values to try,
 * and a `(baseline, value)` patch. Each axis expands to one variant per
 * `values[]` entry; multiple axes produce the cartesian product, named
 * `"${axis1}=${v1} × ${axis2}=${v2} × …"`.
 *
 * A shorthand for the common case "sweep this tunable across these values".
 * It equals writing one {@link Variant} per `value` by hand, but keeps the
 * axis identity legible at the call site.
 */
export interface SweepAxis<V, C extends Cell | UntilCell = Cell> {
  id: string;
  values: V[];
  /** Apply this axis's value to the baseline cell, producing a new cell. */
  patch: (baseline: C, value: V) => C;
}

/**
 * Options for {@link runSensitivity}, a baseline-plus-variants sweep.
 * Mirrors {@link MatrixOptions}'s option-callback + aggregate shape, with the
 * cell list split into baseline + variant patches so the runner knows
 * which result to diff against.
 *
 * Generic over cell shape:
 * - `C extends Cell` (default) — fixed-tick sweep, runs via {@link runMatrix}.
 * - `C extends UntilCell` — predicate-bounded sweep, runs via
 *   {@link runMatrixUntil}. Requires {@link until} and {@link maxSimTime};
 *   `mode`/`bisectTolSec`/`stasisCheckInterval` opt-in per
 *   {@link MatrixUntilOptions}.
 *
 * Variants may be supplied flat (`variants[]`) or axis-grouped (`axes[]`,
 * each axis expanded to one variant per value). Both can be supplied at
 * once: axis-expanded variants are appended after flat ones. An empty
 * variant set is allowed (it runs the baseline only), so consumers can
 * exercise the setup functions of a headless run, such as {@link createSensitivityCell}'s
 * `perturb` against the baseline alone.
 */
export interface SensitivityOptions<C extends Cell | UntilCell = Cell> {
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
   * Termination predicate. Set it to make the sweep predicate-bounded: the
   * baseline and variants must all be {@link UntilCell}s, and
   * {@link maxSimTime} becomes required. Absent means fixed-tick.
   */
  until?: UntilPredicate;
  /** Sim-time cap per headless run, in sim-seconds. Required when {@link until} is set. */
  maxSimTime?: number;
  /**
   * Run mode applied uniformly to every cell. Defaults to `'uniform'`.
   * Only meaningful when {@link until} is set; ignored otherwise. See
   * {@link RunMode}.
   */
  mode?: RunMode;
  /** See {@link RunUntilOptions.bisectTolSec}. Ignored when `mode !== 'next-event'`. */
  bisectTolSec?: number;
  /** See {@link RunUntilOptions.stasisCheckInterval}. Ignored when `mode !== 'next-event'`. */
  stasisCheckInterval?: number;
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
 * One variant's part of a {@link SensitivityResult}. `id` is the variant
 * identity, taken from {@link Variant.id}, not from what the `patch`
 * function set. `cell` is the variant's raw matrix output;
 * `deltas` is the per-metric diff against the baseline cell.
 */
export interface SensitivityVariantResult {
  id: string;
  cell: CellResult;
  /**
   * Per-metric deltas vs the baseline cell, from {@link diffAggregates}:
   * keyed by the same `${analyzerId}.${metricKey}` namespace as
   * {@link CellAggregate.metrics}, plus `'termination.time'` in a
   * predicate-bounded sweep.
   */
  deltas: Record<string, MetricDelta>;
}

/**
 * Output of a sensitivity sweep — baseline cell plus one entry per variant,
 * in the same order as {@link SensitivityOptions.variants}. Each variant
 * has its own {@link CellResult} and a metric-keyed delta map vs the
 * baseline.
 */
export interface SensitivityResult {
  baseline: CellResult;
  variants: SensitivityVariantResult[];
}

// =============================================================================
// Until-runners — predicate-driven alternatives to the fixed-tick primitives.
// Engine-aware (consume `Engine` directly and call
// `engine.tickDriver.advanceTime(tickDelta)`), in contrast to the decoupled
// `tick`-function shape of {@link runHeadless} and {@link runMatrix}. The
// matrix variant's headline output is the distribution of *termination times*
// (when each seed's predicate held), returned as first-class fields on
// {@link CellAggregate}.
// =============================================================================

/**
 * Snapshot passed to an `until` predicate each time it is evaluated. Contains
 * the iteration count and the derived `simTime`, so predicates can assert
 * sim-time windows without closing over a counter themselves. Game
 * state is out of scope: consumers read it via closure over their own
 * engine or setup-captured refs.
 */
export interface UntilContext {
  /**
   * Loop iterations completed so far: one per `tickDelta` advance in the
   * fixed-tick modes. In `'next-event'` mode it counts advances and fast-ticks,
   * each of any length.
   */
  iteration: number;
  /**
   * Sim-seconds elapsed so far. Equals `iteration * tickDelta` in the fixed-tick
   * modes. In `'next-event'` mode advances vary in length (plus fast-ticks), so
   * it tracks the sim-time actually advanced, and that identity does not hold.
   */
  simTime: number;
}

/**
 * Predicate evaluated before each iteration of a {@link runUntil} loop.
 * Returning `true` terminates the headless run with `terminated: 'predicate'`.
 */
export type UntilPredicate = (ctx: UntilContext) => boolean;

/**
 * Options for one predicate-bounded headless run. `runUntil` drives the
 * engine directly via `engine.tickDriver.advanceTime(tickDelta)`, not through
 * a consumer-supplied `tick` function. The engine must be started
 * (`engine.start()`) before calling `runUntil`.
 */
export interface RunUntilOptions {
  /** Engine to drive. Must be started before the call. */
  engine: Engine;
  /** Termination predicate. Evaluated once before every advanceTime, including iteration 0. */
  until: UntilPredicate;
  /**
   * The sim-time cap, in sim-seconds. Required, so a predicate that never
   * holds cannot hang the caller. A headless run that reaches it before the predicate
   * holds terminates with `terminated: 'maxSimTime'`.
   */
  maxSimTime: number;
  /**
   * Sim-seconds per iteration. Defaults to `0.05` (matches
   * {@link runHeadless}). The engine advances by exactly this amount per
   * iteration, independent of its live `intervalRate`. Variable-mode engines
   * process one tick at this dt, or equal ticks under `maxDeltaTime` when it
   * exceeds the cap. So coarsening is a real speedup only up to the cap.
   * Fixed-mode engines drain the accumulator at their internal `fixedDt`
   * until `tickDelta` is consumed. In `'next-event'` mode it is the shortest
   * advance and the fast-tick dt.
   */
  tickDelta?: number;
  /**
   * Builds the analyzers. Called once before the loop. In the fixed-tick modes
   * the analyzer lifecycle (`onStart`/`onTick`/`onEnd`) mirrors
   * {@link runHeadless}, and `onTick` receives the zero-based index of the
   * iteration just completed. `'next-event'` mode throws if it returns any analyzers.
   */
  setup?: () => Analyzer[];
  /** Optional RNG seed; seeds the global Alea instance before `setup`. */
  seed?: number;
  /**
   * Run mode. Defaults to `'uniform'`. See {@link RunMode}. Modes other than
   * `'uniform'` require {@link accessor} to be set; throws at entry otherwise.
   */
  mode?: RunMode;
  /**
   * Read-side accessor used by `'next-event'` and `'stasis-aware'` modes to
   * resolve resource amounts, rates, unlocks, and state paths into walker
   * transition distances. Must read the same state the engine ticks against.
   */
  accessor?: GameStateAccessor;
  /**
   * In `'next-event'` mode, resolve predicate fire time by bisecting within the
   * advance that crossed it. Checkpoints `engine.saveManager.exportSave()`
   * and RNG state before each advance; if the predicate flips during a
   * single advance, binary-searches `dt` in `[0, advanced]` until
   * `|high - low| <= bisectTolSec`. Requires the engine to have a
   * `saveManager` (i.e., `persistence !== false`); throws at entry otherwise,
   * and during the headless run if a checkpoint fails to restore. Without this option, the
   * predicate's fire time is accurate only to the advance length, which in
   * `'next-event'` mode can be hundreds of seconds. Ignored in other modes.
   */
  bisectTolSec?: number;
  /**
   * In `'next-event'` mode, rebuild the snapshot every Nth tick of the stasis
   * fast-tick loop, to detect an exit from stasis (clicks, `onTick` handlers).
   * Defaults to `100`. It trades about 1% worst-case wall-clock time for a
   * bounded delay before event stepping resumes.
   */
  stasisCheckInterval?: number;
}

/**
 * Result of a predicate-bounded headless run. Its shape is a superset of
 * {@link HeadlessResult}. It adds `terminated`, so consumers can tell a
 * predicate that held from a sim-time cap that was reached.
 */
export interface RunUntilResult {
  /**
   * Loop iterations completed (0 when the predicate held at iteration 0).
   * One iteration advances `tickDelta`, which the engine can run as several
   * ticks. In `'next-event'` mode, the count of advances and fast-ticks, which
   * vary in length.
   */
  totalTicks: number;
  /**
   * The sim-time of the headless run at termination. Equals `totalTicks * tickDelta` in the
   * fixed-tick modes. In `'next-event'` mode (advances of varying length, plus
   * fast-ticks) it is the accumulated advanced sim-time, not that product.
   */
  elapsedSimulated: number;
  /**
   * How the headless run ended.
   *
   * - `'predicate'` — the `until` predicate held.
   * - `'maxSimTime'` — the sim-time cap was reached before the predicate held.
   * - `'unreachable'` — `'next-event'` or `'stasis-aware'` mode observed
   *   stasis (no walker-visible transition can mechanically push state
   *   forward) before the predicate held or the cap was reached.
   *   Conservative: opaque-predicate transitions block this classification.
   *   `'next-event'` mode reports it when the cap is reached in stasis with
   *   every dependency the walker tracks unchanged across that stretch. If a
   *   source the walker cannot see moved one, the headless run is a plain
   *   `'maxSimTime'`.
   */
  terminated: 'predicate' | 'maxSimTime' | 'unreachable';
  /** One summary per analyzer, in setup order. */
  analyzerSummaries: HeadlessResult['analyzerSummaries'];
}

/**
 * One cell in a {@link runMatrixUntil} sweep. Each `(cell, seed)` pair gets
 * a newly built engine via `buildEngine(ctx)`. Analyzers close over that
 * engine per headless run, so no state leaks from one headless run to the
 * next.
 */
export interface UntilCell {
  id: string;
  /**
   * Build a fresh engine for this `(cell, seed)`. Consumers typically call
   * `createEngine` or `createEngineFromSave` here; the engine must be
   * started (the helper or consumer calls `engine.start()`). The global RNG
   * is seeded with `ctx.seed` just before the call, so construction draws
   * don't depend on sweep order, and reseeded before the first tick. The
   * runner stops the engine after its headless run, and disposes it unless
   * `teardown` is passed.
   */
  buildEngine: (ctx: RunContext) => Engine;
  /**
   * Read-side accessor factory. Required when {@link MatrixUntilOptions.mode}
   * is `'next-event'` or `'stasis-aware'` — those modes introspect content
   * through the walker. Called once per `(cell, seed)` alongside
   * `buildEngine`. The accessor must read the same state the engine ticks
   * against. Stasis detection and event stepping are only as sound as the
   * distances the walker computes from it.
   */
  buildAccessor?: (engine: Engine) => GameStateAccessor;
  /**
   * Builds the analyzers. It closes over the newly built engine, so analyzers
   * can read engine state without module-level refs.
   * Omit for metric-free cells. `'next-event'` mode throws if it returns any
   * analyzers; see {@link RunUntilOptions.setup}.
   */
  analyzers?: (engine: Engine, ctx: RunContext) => Analyzer[];
  /** Per-cell `tickDelta`. Defaults to `0.05`. */
  tickDelta?: number;
  /**
   * Called once per headless run after `onRunComplete`, and after a headless
   * run that throws —
   * release what `buildEngine` built. Defaults to `engine.dispose()`; pass a
   * no-op to keep the engine alive past the sweep.
   */
  teardown?: (engine: Engine, ctx: RunContext) => void;
}

/** One unit of work in a flat `cells × seeds` until-sweep. */
export type MatrixUntilWorkItem = WorkItem<UntilCell>;

/**
 * Options for {@link runMatrixUntil}, a `cells × seeds` predicate-bounded
 * sweep. The shared `until` predicate and `maxSimTime` cap apply to every
 * headless run; option callbacks mirror {@link MatrixOptions}.
 */
export interface MatrixUntilOptions {
  cells: UntilCell[];
  seeds: number[];
  /** Termination predicate shared across every `(cell, seed)` headless run. */
  until: UntilPredicate;
  /** Sim-time cap per headless run, in sim-seconds. Required. */
  maxSimTime: number;
  /** Fires after each `(cell, seed)` headless run completes, in deterministic order. */
  onRunComplete?: (item: MatrixUntilWorkItem, result: RunUntilResult) => void;
  /** Fires once a cell's full seed sweep is complete, in deterministic order. */
  onCellComplete?: (cell: CellResult<RunUntilResult>) => void;
  aggregate?: AggregateOptions;
  /**
   * Run mode applied uniformly to every cell. Defaults to `'uniform'`. When
   * `'next-event'` or `'stasis-aware'`, every {@link UntilCell} must supply
   * {@link UntilCell.buildAccessor}; the runner throws at entry otherwise.
   * See {@link RunMode}.
   */
  mode?: RunMode;
  /** See {@link RunUntilOptions.bisectTolSec}. Ignored when `mode !== 'next-event'`. */
  bisectTolSec?: number;
  /** See {@link RunUntilOptions.stasisCheckInterval}. Ignored when `mode !== 'next-event'`. */
  stasisCheckInterval?: number;
}

/** Output of a {@link runMatrixUntil} sweep — one {@link CellResult} per input cell. */
export interface MatrixUntilResult {
  cells: CellResult<RunUntilResult>[];
}
