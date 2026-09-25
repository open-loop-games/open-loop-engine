# Harness

Headless-sim substrate: runners, probes, content walkers, the picker, solvers, perturbation, analyzers. Separable — game code never imports harness; balance tooling does.

## Canonical entrypoints

- `runHeadless` / `runUntil` — deterministic fixed-tick and predicate-bounded simulations.
- `replayLive` / `createTickCounter` — replay live-play dt cadence (speed-scaled) deterministically; count sub-ticks for fixed-mode speed-invariance assertions.
- `runMatrix`, `runMatrixUntil`, `runSensitivity` — multi-cell, multi-seed balance sweeps.
- `createPickerSnapshot` / `applyPerturbation` — enumerate and perturb tunables/modifiers.
- `createTransitionSnapshot` / `createIncrementalSnapshot` — find upcoming content transitions.
- `bisectTuner` — tune a single parameter until an event fires at a target time.

## Analyzers

Reusable in-run trackers (resource peaks, loop finalize, default pack).

- `function createCycleFinalizeTracker(): Analyzer` — Create an Analyzer that counts finalized cycles and snapshots the most recent cycle's deltas into the summary. `src/harness/analyzers/cycle-finalize.ts:28`
- `function createResourcePeakTracker(resource: Resource): Analyzer` — Create an Analyzer that samples a single resource every tick and emits `{ peak, final, avg }` at the end of the run. `src/harness/analyzers/resource-peak.ts:68`
- `function createSeriesTracker(resource: Resource): Analyzer` — Create an Analyzer that records a single resource's value at every tick and emits it as `series:{displayName}.t{i}` (zero-based tick index). `src/harness/analyzers/series.ts:47`
- `function defaultAnalyzerPack(engine: Engine): Analyzer[]` — Build a fresh analyzer pack for the given engine. `src/harness/analyzers/default-pack.ts:43`
- `function seriesAnalyzerPack(engine: Engine): Analyzer[]` — Build one createSeriesTracker per entry in the engine's resource registry — the trajectory-capturing counterpart to defaultAnalyzerPack. `src/harness/analyzers/series.ts:85`

## Flow-channel classification

maps beat duration to Csikszentmihalyi's Flow Theory engagement bands. Opinionated balance-tooling surface: lives in harness because the bands encode player-engagement theory, which the mechanics-tier kernel deliberately avoids

- `function classifyFlowChannel(beatTimeSeconds: number): FlowChannel` — Classify a beat duration (in seconds) into its flow channel. `src/harness/flow-channel.ts:52`
- `type FlowChannel = 'arousal' | 'flow' | 'flow-upper' | 'boredom' | 'frustration' | 'breakdown'` — Flow-channel classification based on Csikszentmihalyi's Flow Theory (1990). `src/harness/flow-channel.ts:27`
- `function getFlowChannelBoundaries(): Record<FlowChannel, [number, number]>` — Get flow-channel threshold boundaries as `[min, max)` pairs in seconds. `src/harness/flow-channel.ts:68`

## Headless runner

synchronous tick loop for deterministic simulation and tests

- `interface HeadlessConfig` — Configuration for a synchronous headless simulation run. `src/core/headless.ts:11`
- `interface HeadlessResult` — Results returned after a completed headless simulation run. `src/core/headless.ts:30`
- `function runHeadless(config: HeadlessConfig): HeadlessResult` — Run a fixed-tick-count headless simulation, threading each analyzer's `onStart` / `onTick` / `onEnd` callbacks around the consumer's `tick` function. `src/core/headless.ts:45`

## Perturbation applier

address→override mechanism for the balance workbench

- `function applyPerturbation(engine: Engine, entry: PickerEntry, perturbation: Perturbation): () => void` — Apply `perturbation` to the surface identified by `entry` and return an idempotent cleanup that reverses the mutation. `src/harness/perturbation.ts:105`
- `type Perturbation` — Scalar transform applied on top of an existing modifier or tunable value. `src/harness/perturbation.ts:55`

## Picker

Walk engine state to enumerate addressable choices for solvers / UIs.

- `function createPickerSnapshot(engine: Engine): PickerSnapshot` — Build a single PickerSnapshot by running all discovery walkers, deduplicating modifier-entry output by `Modifier` object identity, and grouping the result by discovery layer. `src/harness/picker/merge.ts:63`
- `type ModifierPickerAddress` — Address of a `ModifierPickerEntry`. `src/harness/picker/types.ts:42`
- `interface ModifierPickerEntry` — A perturbable modifier surface discovered by the picker. `src/harness/picker/types.ts:109`
- `type PickerAddress = ModifierPickerAddress | TunablePickerAddress` — Address of any PickerEntry. `src/harness/picker/types.ts:102`
- `type PickerEntry = ModifierPickerEntry | TunablePickerEntry` — Normalized picker output. `src/harness/picker/types.ts:155`
- `interface PickerSnapshot` `src/harness/picker/types.ts:166`
- `type PickerSource = 'content' | 'chain-registry' | 'tunable'` — Which discovery walker produced a given PickerEntry. `src/harness/picker/types.ts:35`
- `interface TunablePickerAddress` — Address of a `TunablePickerEntry`. `src/harness/picker/types.ts:88`
- `interface TunablePickerEntry` — A designer-flagged tunable value discovered by the picker. `src/harness/picker/types.ts:138`

## Probes

Seed-sweep runners. `runProbe` collects per-beat termination-time distributions (with optional `tuningWindow` → `inTuningWindow` classification for design-time balance tuning); `runWaypointProbe` returns consumer-shaped snapshots at scheduled waypoints. Both dispatch on `RunMode` (`tick` / `event` / `stasis-aware-tick`) inherited from `runMatrixUntil`.

- `interface BeatProbe` — One beat's predicate + identity. `src/harness/probe/types.ts:19`
- `interface BeatResult` — Per-beat termination-time distribution from a `seeds`-wide sweep. `src/harness/probe/types.ts:43`
- `interface ProbeConfig` — Configuration for runProbe. `src/harness/probe/types.ts:69`
- `function runProbe(config: ProbeConfig): BeatResult[]` — For each beat, drive `seeds.length` fresh engines until the beat predicate fires (or `maxSimTime` elapses, or — in non-tick modes — stasis is observed), aggregated into per-beat termination-time distributions. `src/harness/probe/tick.ts:55`
- `function runWaypointProbe<T>(config: WaypointProbeConfig<T>): WaypointSnapshot<T>[]` — For each waypoint × seed: build a fresh engine, advance via `runUntil` until `simTime >= waypoint.snapshotAtSec`, call `inspect(engine)`, return one WaypointSnapshot per `(waypoint, seed)` in iteration order. `src/harness/probe/waypoint.ts:98`
- `interface Waypoint` — One named time-anchored snapshot target. `src/harness/probe/waypoint.ts:24`
- `interface WaypointProbeConfig<T>` — Configuration for runWaypointProbe. `src/harness/probe/waypoint.ts:53`
- `interface WaypointSnapshot<T>` — Per-waypoint × per-seed inspector output. `src/harness/probe/waypoint.ts:31`

## Cell-aggregation kernel

reduces raw per-run results into per-metric stats, optional histograms, and (for until-runs) termination-time distributions. Also exports `diffAggregates`, the baseline-vs-variant delta primitive consumed directly by custom-sweep callers when the canned `runSensitivity` shape doesn't fit (see starter `sweep.ts`, `tug/balance/probes.ts`)

- `function computeMetricStats(values: number[]): MetricStats` — Descriptive stats (min/max/avg/stddev/median/p5/p50/p95/count) over a numeric array. `src/harness/aggregate.ts:47`
- `function createEngineFromSave(options: CreateEngineFromSaveOptions): Engine` — Load a save into a fresh, isolated engine running the given modules — a scratch copy of the game to simulate or inspect without touching the live one. `src/harness/create-engine.ts:88`
- `interface CreateEngineFromSaveOptions` `src/harness/create-engine.ts:31`
- `function createSensitivityCell(options: CreateSensitivityCellOptions): Cell` — Build a harness `Cell` backed by a per-run engine constructed from a save blob. `src/harness/create-sensitivity-cell.ts:114`
- `interface CreateSensitivityCellOptions` — Options for createSensitivityCell — bundles the immutable save-blob baseline, the per-run module-instance factory, an optional `perturb` hook, and the analyzer factory used by every run of this cell. `src/harness/create-sensitivity-cell.ts:28`
- `function createTickCounter(driver: TickDriver): TickCounter` — Count `onTick` fires on `driver` — one per sub-tick in fixed mode, one per interval tick in variable mode. `src/harness/replay.ts:92`
- `function createWorkPlan<C>(config: { cells: C[]; seeds: number[]; }): WorkItem<C>[]` — Build the flat `(cellIdx, seedIdx, seed, cell)` array that runMatrix and runMatrixUntil iterate. `src/harness/work-plan.ts:38`
- `function diffAggregates(cell: CellAggregate, baseline: CellAggregate): Record<string, MetricDelta>` — Per-metric delta between a variant cell aggregate and the baseline. `src/harness/aggregate.ts:242`
- `function replayLive(driver: TickDriver, options: ReplayLiveOptions): Promise<number>` — Replay `seconds` of live play at `speed` through `driver`, reproducing `intervalTick`'s dt math deterministically. `src/harness/replay.ts:58`
- `interface ReplayLiveOptions` `src/harness/replay.ts:31`
- `function runBatch(config: BatchConfig): MatrixResult` — Run every config × seed pair via runMatrix. `src/harness/run-batch.ts:34`
- `function runMatrix(config: MatrixConfig): MatrixResult` — Run every `(cell, seed)` pair in deterministic cell-outer / seed-inner order. `src/harness/run-matrix.ts:45`
- `function runMatrixUntil(config: MatrixUntilConfig): MatrixUntilResult` — Sync cartesian run over `cells × seeds` where each run terminates on a shared predicate (or `maxSimTime`). `src/harness/run-matrix-until.ts:54`
- `function runSensitivity<C extends Cell | UntilCell = Cell>(config: SensitivityConfig<C>): SensitivityResult` — Run baseline plus every variant, then compute per-variant `{ absolute, relative }` deltas against the baseline per metric. `src/harness/run-sensitivity.ts:76`
- `function runUntil(config: RunUntilConfig): RunUntilResult` — Drive `config.engine` via `engine.tickDriver.simulateTick(tickDelta)` until `config.until` returns `true` or `config.maxSimTime` sim-seconds have elapsed, whichever comes first. `src/harness/run-until.ts:79`
- `interface TickCounter` — A live sub-tick counter returned by createTickCounter. `src/harness/replay.ts:78`

## Solvers

Tune a parameter to satisfy a predicate (bisection, etc.).

- `function bisectTuner(config: TunerConfig): TunerResult` — Binary-search 1-D tuner. `src/harness/solve/bisect.ts:41`
- `type Tuner = (config: TunerConfig) => TunerResult` — Runner-level swappable for 1-D parameter search. `src/harness/solve/types.ts:59`
- `interface TunerConfig` — Configuration for a Tuner call. `src/harness/solve/types.ts:16`
- `interface TunerResult` — Outcome of a tuner run. `src/harness/solve/types.ts:36`

## Measurement harness types

cartesian `cells × seeds` plan over `runHeadless`, preserving raw per-run results and producing namespaced numeric aggregates

- `interface AggregateOptions` — Options threaded through MatrixConfig (and the batch/sensitivity wrappers) to opt into histogram bucketing for specific metrics. `src/harness/types.ts:128`
- `interface BatchConfig` — N configurations × M seeds with no variant semantics. `src/harness/types.ts:222`
- `interface Cell` — One named configuration in a matrix. `src/harness/types.ts:47`
- `interface CellAggregate` — Per-cell aggregated metrics, keyed `${analyzerName}.${metricKey}` to prevent cross-analyzer collisions. `src/harness/types.ts:157`
- `interface CellResult<R extends HeadlessResult = HeadlessResult>` — A completed cell's output. `src/harness/types.ts:188`
- `interface HistogramSpec` — Consumer-supplied histogram spec for one metric. `src/harness/types.ts:117`
- `interface MatrixConfig` — Top-level matrix runner config — N cells × M seeds, run synchronously in deterministic order. `src/harness/types.ts:201`
- `interface MatrixResult` — Output of a runMatrix sweep — one CellResult per input cell, in cell order. `src/harness/types.ts:213`
- `interface MatrixUntilConfig` — Configuration for runMatrixUntil — `cells × seeds` predicate-bounded sweep. `src/harness/types.ts:546`
- `interface MatrixUntilResult` — Output of a runMatrixUntil sweep — one CellResult per input cell. `src/harness/types.ts:572`
- `type MatrixUntilWorkItem = WorkItem<UntilCell>` — One unit of work in a flat `cells × seeds` until-sweep. `src/harness/types.ts:539`
- `interface MetricDelta` — Per-metric delta between a variant cell and the baseline. `src/harness/types.ts:326`
- `interface MetricHistogram` — Counts of samples falling into consumer-declared buckets for one metric. `src/harness/types.ts:105`
- `interface MetricStats` — Numeric summary of one metric across a cell's runs. `src/harness/types.ts:85`
- `interface RunContext` — Context passed to a Cell's `setup` function. `src/harness/types.ts:37`
- `type RunMode = 'tick' | 'event' | 'stasis-aware-tick'` — Run-loop mode shared by runUntil and runMatrixUntil. `src/harness/types.ts:30`
- `interface RunUntilConfig` — Configuration for a single predicate-bounded run. `src/harness/types.ts:403`
- `interface RunUntilResult` — Result of a predicate-bounded run. `src/harness/types.ts:471`
- `interface SensitivityConfig<C extends Cell | UntilCell = Cell>` — Baseline-plus-variants sweep config consumed by runSensitivity. `src/harness/types.ts:283`
- `interface SensitivityResult` — Output of a sensitivity sweep — baseline cell plus one entry per variant, in the same order as SensitivityConfig.variants. `src/harness/types.ts:355`
- `interface SensitivityVariantResult` — One variant's contribution to a SensitivityResult. `src/harness/types.ts:337`
- `interface SweepAxis<V, C extends Cell | UntilCell = Cell>` — One axis in a cartesian sensitivity sweep — a label, the values to try, and a `(baseline, value)` patch. `src/harness/types.ts:256`
- `interface UntilCell` — One cell in a runMatrixUntil sweep. `src/harness/types.ts:507`
- `interface UntilContext` — Snapshot passed to an `until` predicate each time it's evaluated. `src/harness/types.ts:377`
- `type UntilPredicate = (ctx: UntilContext) => boolean` — Predicate evaluated before each tick in a runUntil loop. `src/harness/types.ts:395`
- `interface Variant<C extends Cell | UntilCell = Cell>` — A named config patch — the generic equivalent of borglike's domain- specific `excludeUpgrades` axis. `src/harness/types.ts:241`
- `interface WorkItem<C = Cell>` — One unit of work in a flat cell×seed plan. `src/harness/types.ts:64`
- `interface Analyzer` — Observer attached to a headless run that collects metrics per tick and optionally per finalized cycle. `src/primitives/types.ts:165`
- `interface AnalyzerResult` — Structured output produced by an Analyzer after a headless run completes. `src/primitives/types.ts:158`
- `interface CompositeEffect` — Groups multiple effects into one, applied in order as a single unit. `src/primitives/types.ts:30`
- `interface GameStateAccessor` — Read-only view of game state used when evaluating conditions and resolving effects. `src/primitives/types.ts:205`
- `type IEffect = ResourceEffect | UnlockEffect | StateEffect | CompositeEffect` — Tagged-union root for declarative effects — the data shape content authors hand to category factories. `src/primitives/types.ts:63`
- `type InjectionKey<T>` — Typed symbol key for module provide/inject — mirrors Vue's InjectionKey pattern. `src/primitives/types.ts:234`
- `interface ResourceEffect` — Modifies a numeric resource by adding, subtracting, multiplying, or setting its value. `src/primitives/types.ts:4`
- `interface StateEffect` — Writes an arbitrary value to a dot-path in game state (e.g. `src/primitives/types.ts:22`
- `interface UnlockEffect` — Sets an unlock flag to true or false, controlling feature/content visibility. `src/primitives/types.ts:14`
- `interface WeightedItem<T>` — A candidate value paired with a relative probability weight for weighted random selection. `src/primitives/types.ts:198`

## Content walker

Enumerate purchasables, producers, and challenges with their next-transition timing.

- `function createIncrementalSnapshot(engine: Engine, accessor: GameStateAccessor): IncrementalSnapshot` — Build an incremental-snapshot cache over the given engine. `src/harness/walker/incremental-snapshot.ts:148`
- `function createTransitionSnapshot(engine: Engine, accessor: GameStateAccessor): TransitionSnapshot` — Build a single merged snapshot of pending state transitions across the engine's auto-registered content. `src/harness/walker/index.ts:89`
- `interface IncrementalSnapshot` — Caching overlay on the content-walker snapshot. `src/harness/walker/incremental-snapshot.ts:69`
- `interface IncrementalSnapshotEntityRef` — Minimal reference to the source entity behind a cached transition. `src/harness/walker/incremental-snapshot.ts:58`
- `interface Transition` — A pending state change surfaced by the content walkers. `src/harness/walker/types.ts:35`
- `interface TransitionSnapshot` — Merged output of createTransitionSnapshot. `src/harness/walker/index.ts:51`
- `type TransitionSource = 'challenge' | 'purchasable' | 'producer'` — Which content-walker leaf produced a given Transition. `src/harness/walker/types.ts:24`
