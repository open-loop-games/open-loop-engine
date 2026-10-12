# Harness

The balance harness: runners, probes, transition walkers, the picker, solvers, perturbation and analyzers. Game code never imports it; probes and balance workbenches do.

## Canonical entrypoints

- `runHeadless` / `runUntil` — deterministic headless runs over a fixed tick count, or bounded by an until-predicate.
- `replayLive` / `createTickCounter` — replay the live loop's dt cadence, scaled by game speed, deterministically. Count ticks to assert that fixed tick mode is invariant to game speed.
- `runMatrix`, `runMatrixUntil`, `runSensitivity` — multi-cell, multi-seed balance sweeps.
- `createPickerSnapshot` / `applyPerturbation` — enumerate and perturb tunables/modifiers.
- `createTransitionSnapshot` / `createIncrementalSnapshot` — find upcoming content transitions.
- `bisectTuner` — tune one value until its fire time meets a target.

## Analyzers

Reusable analyzers (resource peaks, run finalize, time series, the default pack).

- `function createResourcePeakAnalyzer(resource: Resource): Analyzer` — Create an Analyzer that samples a single resource every tick and reports `{ peak, final, avg }` at the end of the headless run. `src/harness/analyzers/resource-peak.ts:68`
- `function createRunFinalizeAnalyzer(): Analyzer` — Create an Analyzer that counts finalized runs and copies the most recent run's deltas into the summary. `src/harness/analyzers/run-finalize.ts:28`
- `function createTimeSeriesAnalyzer(resource: Resource): Analyzer` — Create an Analyzer that records a single resource's value at every tick and reports it as `time-series:{id}.t{i}` (zero-based tick index). `src/harness/analyzers/time-series.ts:48`
- `function defaultAnalyzerPack(engine: Engine): Analyzer[]` — Build a new analyzer pack for the given engine. `src/harness/analyzers/default-pack.ts:42`
- `function timeSeriesAnalyzerPack(engine: Engine): Analyzer[]` — Build one createTimeSeriesAnalyzer per entry in the engine's resource registry — the trajectory-capturing counterpart to defaultAnalyzerPack. `src/harness/analyzers/time-series.ts:86`

## Flow-channel classification

maps beat time to Csikszentmihalyi's Flow Theory engagement classes. An opinionated balance-harness utility: it is in the balance harness because the classes encode player-engagement theory, which the Mechanics API tier avoids on purpose

- `function classifyFlowChannel(beatTimeSeconds: number): FlowChannel` — Classify a beat time (in seconds) into its flow channel. `src/harness/flow-channel.ts:52`
- `type FlowChannel = 'arousal' | 'flow' | 'flow-upper' | 'boredom' | 'frustration' | 'breakdown'` — Flow-channel classification based on Csikszentmihalyi's Flow Theory (1990). `src/harness/flow-channel.ts:27`
- `function getFlowChannelBoundaries(): Record<FlowChannel, [number, number]>` — Get flow-channel threshold boundaries as `[min, max)` pairs in seconds. `src/harness/flow-channel.ts:68`

## Headless runner

synchronous tick loop for deterministic simulation and tests

- `interface HeadlessOptions` — Options for one synchronous headless run. `src/core/headless.ts:11`
- `interface HeadlessResult` — What a completed headless run returns. `src/core/headless.ts:37`
- `function runHeadless(options: HeadlessOptions): HeadlessResult` — Run a fixed number of iterations headless. `src/core/headless.ts:53`

## Perturbation applier

address→override mechanism for the balance workbench

- `function applyPerturbation(engine: Engine, entry: PickerEntry, perturbation: Perturbation): () => void` — Apply `perturbation` to the address identified by `entry` and return an idempotent cleanup that reverses the mutation. `src/harness/perturbation.ts:111`
- `type Perturbation` — Scalar transform applied on top of an existing modifier or tunable value. `src/harness/perturbation.ts:61`

## Picker

Walk the engine to enumerate perturbable addresses for solvers and UIs.

- `function createPickerSnapshot(engine: Engine): PickerSnapshot` — Build one PickerSnapshot: run all discovery walkers, deduplicate modifier entries by `Modifier` object identity, and group the result by walker. `src/harness/picker/merge.ts:61`
- `type ModifierPickerAddress` — Address of a `ModifierPickerEntry`: a tagged union whose discriminant is `walker`. `src/harness/picker/types.ts:41`
- `interface ModifierPickerEntry` — A perturbable modifier the picker found. `src/harness/picker/types.ts:110`
- `type PickerAddress = ModifierPickerAddress | TunablePickerAddress` — Address of any PickerEntry: the union of the modifier and tunable address shapes. `src/harness/picker/types.ts:103`
- `type PickerEntry = ModifierPickerEntry | TunablePickerEntry` — Normalized picker output, which balance workbenches, solvers and sensitivity analysis read. `src/harness/picker/types.ts:156`
- `interface PickerSnapshot` `src/harness/picker/types.ts:167`
- `type PickerWalker = 'effect-system' | 'chain-registry' | 'tunable'` — Which discovery walker produced a given PickerEntry. `src/harness/picker/types.ts:34`
- `interface TunablePickerAddress` — Address of a `TunablePickerEntry`. `src/harness/picker/types.ts:90`
- `interface TunablePickerEntry` — A designer-flagged tunable the picker found. `src/harness/picker/types.ts:139`

## Probes

Seed-sweep runners. `runBeatProbe` collects termination-time distributions per beat, with an optional `tuningWindow` → `inTuningWindow` classification for balance at design time. `runWaypointProbe` returns consumer-shaped snapshots at scheduled waypoints. `runBeatProbe` dispatches on the run mode (`RunMode`: `uniform` / `next-event` / `stasis-aware`), as `runMatrixUntil` does. `runWaypointProbe` always runs `uniform`.

- `interface Beat` — One beat's predicate + identity. `src/harness/probe/types.ts:19`
- `interface BeatProbeOptions` — Options for runBeatProbe. `src/harness/probe/types.ts:71`
- `interface BeatResult` — Per-beat termination-time distribution from a `seeds`-wide sweep. `src/harness/probe/types.ts:42`
- `function runBeatProbe(options: BeatProbeOptions): BeatResult[]` — For each beat, drive `seeds.length` new engines until the beat predicate holds, `maxSimTime` elapses, or stasis is observed outside `'uniform'` mode. `src/harness/probe/tick.ts:61`
- `function runWaypointProbe<T>(options: WaypointProbeOptions<T>): WaypointSnapshot<T>[]` — For each waypoint × seed: build a new engine, advance it until `simTime >= waypoint.snapshotAtSec`, call `inspect(engine)`, and return one WaypointSnapshot per `(waypoint, seed)` in iteration order. `src/harness/probe/waypoint.ts:109`
- `interface Waypoint` — One named time-anchored snapshot target. `src/harness/probe/waypoint.ts:22`
- `interface WaypointProbeOptions<T>` — Options for runWaypointProbe. `src/harness/probe/waypoint.ts:51`
- `interface WaypointSnapshot<T>` — Per-waypoint × per-seed inspector output. `src/harness/probe/waypoint.ts:29`

## Cell-aggregation kernel

reduces the raw results of headless runs into per-metric stats, optional histograms, and termination-time distributions for predicate-bounded headless runs. Also exports `diffAggregates`, the baseline-vs-variant delta primitive that custom-sweep callers use directly when the canned `runSensitivity` shape does not fit

- `function computeMetricStats(values: number[]): MetricStats` — Descriptive stats (min/max/avg/stddev/median/p5/p50/p95/count) over a numeric array. `src/harness/aggregate.ts:46`
- `function createEngineFromSave(options: CreateEngineFromSaveOptions): Engine` — Load a save into a fresh, isolated engine running the given modules. `src/harness/create-engine.ts:82`
- `interface CreateEngineFromSaveOptions` `src/harness/create-engine.ts:24`
- `function createSensitivityCell(options: CreateSensitivityCellOptions): Cell` — Build a harness `Cell` backed by an engine per headless run, constructed from save text. `src/harness/create-sensitivity-cell.ts:116`
- `interface CreateSensitivityCellOptions` — Options for createSensitivityCell: the immutable baseline save text. `src/harness/create-sensitivity-cell.ts:29`
- `function createTickCounter(driver: TickDriver): TickCounter` — Count `onTick` fires on `driver`, one per tick. `src/harness/replay.ts:93`
- `function createWorkPlan<C>(options: { cells: C[]; seeds: number[]; }): WorkItem<C>[]` — Build the flat `(cellIdx, seedIdx, seed, cell)` array that runMatrix and runMatrixUntil iterate. `src/harness/work-plan.ts:38`
- `function diffAggregates(cell: CellAggregate, baseline: CellAggregate): Record<string, MetricDelta>` — Per-metric delta between a variant cell aggregate and the baseline. `src/harness/aggregate.ts:249`
- `function replayLive(driver: TickDriver, options: ReplayLiveOptions): Promise<number>` — Replay `seconds` of live play at `speed` through `driver`, reproducing `intervalTick`'s dt math deterministically. `src/harness/replay.ts:59`
- `interface ReplayLiveOptions` `src/harness/replay.ts:31`
- `function runMatrix(options: MatrixOptions): MatrixResult` — Run every `(cell, seed)` pair in deterministic cell-outer / seed-inner order. `src/harness/run-matrix.ts:45`
- `function runMatrixUntil(options: MatrixUntilOptions): MatrixUntilResult` — Sync cartesian sweep over `cells × seeds` where each headless run terminates on a shared predicate (or `maxSimTime`). `src/harness/run-matrix-until.ts:58`
- `function runSensitivity<C extends Cell | UntilCell = Cell>(options: SensitivityOptions<C>): SensitivityResult` — Run baseline plus every variant, then compute per-variant `{ absolute, relative }` deltas against the baseline per metric. `src/harness/run-sensitivity.ts:76`
- `function runUntil(options: RunUntilOptions): RunUntilResult` — Drive `options.engine` via `engine.tickDriver.advanceTime(tickDelta)` until `options.until` returns `true` or `options.maxSimTime` sim-seconds have elapsed, whichever comes first. `src/harness/run-until.ts:78`
- `interface TickCounter` — A live tick counter returned by createTickCounter. `src/harness/replay.ts:79`

## Solvers

Tune a value until a predicate holds (bisection, and others).

- `function bisectTuner(options: TunerOptions): TunerResult` — Binary-search 1-D tuner. `src/harness/solve/bisect.ts:41`
- `type Tuner = (config: TunerOptions) => TunerResult` — A replaceable 1-D parameter search. `src/harness/solve/types.ts:59`
- `interface TunerOptions` — Options for a Tuner call. `src/harness/solve/types.ts:16`
- `interface TunerResult` — Outcome of a tuner call. `src/harness/solve/types.ts:36`

## Balance harness types

the cartesian `cells × seeds` plan over `runHeadless`. It keeps the raw result of each headless run and produces numeric aggregates under namespaced keys

- `interface AggregateOptions` — Options passed through MatrixOptions (and SensitivityOptions) to opt into histogram bucketing for specific metrics. `src/harness/types.ts:135`
- `interface Cell` — One named configuration in a matrix. `src/harness/types.ts:48`
- `interface CellAggregate` — Per-cell aggregated metrics, keyed `${analyzerId}.${metricKey}` to prevent cross-analyzer collisions. `src/harness/types.ts:164`
- `interface CellResult<R extends HeadlessResult = HeadlessResult>` — A completed cell's output. `src/harness/types.ts:197`
- `interface HistogramOptions` — Histogram options for one metric. `src/harness/types.ts:124`
- `interface MatrixOptions` — Options for the matrix runner: N cells × M seeds, run synchronously in deterministic order. `src/harness/types.ts:210`
- `interface MatrixResult` — Output of a runMatrix sweep — one CellResult per input cell, in cell order. `src/harness/types.ts:222`
- `interface MatrixUntilOptions` — Options for runMatrixUntil, a `cells × seeds` predicate-bounded sweep. `src/harness/types.ts:552`
- `interface MatrixUntilResult` — Output of a runMatrixUntil sweep — one CellResult per input cell. `src/harness/types.ts:578`
- `type MatrixUntilWorkItem = WorkItem<UntilCell>` — One unit of work in a flat `cells × seeds` until-sweep. `src/harness/types.ts:545`
- `interface MetricDelta` — Per-metric delta between a variant cell and the baseline. `src/harness/types.ts:320`
- `interface MetricHistogram` — Counts of samples falling into consumer-declared buckets for one metric. `src/harness/types.ts:112`
- `interface MetricStats` — Numeric summary of one metric across the headless runs of a cell. `src/harness/types.ts:92`
- `interface RunContext` — The seed of one headless run, passed to the option callbacks that build, perturb and tear down that run, such as a Cell's `setup` and an UntilCell's `buildEngine`. `src/harness/types.ts:38`
- `type RunMode = 'uniform' | 'next-event' | 'stasis-aware'` — The run mode shared by runUntil and runMatrixUntil. `src/harness/types.ts:30`
- `interface RunUntilOptions` — Options for one predicate-bounded headless run. `src/harness/types.ts:398`
- `interface RunUntilResult` — Result of a predicate-bounded headless run. `src/harness/types.ts:466`
- `interface SensitivityOptions<C extends Cell | UntilCell = Cell>` — Options for runSensitivity, a baseline-plus-variants sweep. `src/harness/types.ts:277`
- `interface SensitivityResult` — Output of a sensitivity sweep — baseline cell plus one entry per variant, in the same order as SensitivityOptions.variants. `src/harness/types.ts:349`
- `interface SensitivityVariantResult` — One variant's part of a SensitivityResult. `src/harness/types.ts:331`
- `interface SweepAxis<V, C extends Cell | UntilCell = Cell>` — One sweep axis of a cartesian sensitivity sweep: an id, the values to try, and a `(baseline, value)` patch. `src/harness/types.ts:250`
- `interface UntilCell` — One cell in a runMatrixUntil sweep. `src/harness/types.ts:505`
- `interface UntilContext` — Snapshot passed to an `until` predicate each time it is evaluated. `src/harness/types.ts:371`
- `type UntilPredicate = (ctx: UntilContext) => boolean` — Predicate evaluated before each iteration of a runUntil loop. `src/harness/types.ts:390`
- `interface Variant<C extends Cell | UntilCell = Cell>` — A named change to the baseline cell: the generic form of a domain-specific axis such as excluding upgrades. `src/harness/types.ts:235`
- `interface WorkItem<C = Cell>` — One unit of work in a flat cell×seed plan. `src/harness/types.ts:71`
- `interface Analyzer` — Observer of one headless run that collects metrics per iteration, and optionally per finalized cycle-log entry. `src/primitives/types.ts:171`
- `interface AnalyzerSummary` — What an Analyzer reports after one headless run; cell aggregation keeps only its number metrics. `src/primitives/types.ts:161`
- `interface CompositeEffect` — Groups multiple effects into one, applied in order as a single unit. `src/primitives/types.ts:30`
- `interface FlagEffect` — Sets a flag to true or false, for example to control whether content is available. `src/primitives/types.ts:14`
- `interface GameStateAccessor` — Read-only view of game state used when evaluating predicates and resolving effects. `src/primitives/types.ts:212`
- `type IEffect = ResourceEffect | FlagEffect | StateEffect | CompositeEffect` — Tagged-union root for declarative effects — the data shape consumers hand to category factories. `src/primitives/types.ts:63`
- `type InjectionKey<T>` — Typed symbol key for module provide/inject — mirrors Vue's InjectionKey pattern. `src/primitives/types.ts:251`
- `interface ResourceEffect` — Changes a resource's amount by adding, subtracting, multiplying, or setting it. `src/primitives/types.ts:4`
- `interface StateEffect` — Writes any value at a state path in game state (e.g. `src/primitives/types.ts:22`
- `interface WeightedItem<T>` — A candidate value paired with a relative probability weight for weighted random selection. `src/primitives/types.ts:205`

## Transition walker

Enumerate purchasables, producers and challenges, with the transition distance to each next transition.

- `function createIncrementalSnapshot(engine: Engine, accessor: GameStateAccessor): IncrementalSnapshot` — Build an incremental-snapshot cache over the given engine. `src/harness/walker/incremental-snapshot.ts:236`
- `function createTransitionSnapshot(engine: Engine, accessor: GameStateAccessor): TransitionSnapshot` — Build one merged snapshot of the transitions across the engine's auto-registered content. `src/harness/walker/index.ts:84`
- `interface IncrementalSnapshot` — Caching overlay on the transition-walker snapshot. `src/harness/walker/incremental-snapshot.ts:80`
- `interface Transition` — A transition that a transition walker found. `src/harness/walker/types.ts:35`
- `interface TransitionSnapshot` — Merged output of createTransitionSnapshot. `src/harness/walker/index.ts:46`
- `type TransitionWalker = 'challenge' | 'purchasable' | 'producer'` — Which transition walker produced a given Transition. `src/harness/walker/types.ts:23`
