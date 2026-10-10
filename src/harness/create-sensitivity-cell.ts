/**
 * Harness cell factory for the balance workbench cycle.
 *
 * Bridges `createEngineFromSave` (per-run engine construction from a save
 * blob) with the harness `Cell` contract. The matrix runner rebuilds the
 * engine fresh per `(cell × seed)` via `Cell.setup`, so this factory
 * returns a cell whose setup closure owns the engine and whose tick
 * closure drives it.
 *
 * Ordering inside `setup`: build engine from save → apply perturb →
 * build analyzers → auto-subscribe `onRunFinalize` to any published
 * CycleLog → cycle runs to `ticks × tickDelta`.
 *
 * @cluster runners
 */

import type { Analyzer } from '@/primitives/types';
import type { Engine, EngineConfig, EngineModule } from '@/engine';
import { CycleLogKey } from '@/systems/cycle-log';
import { createEngineFromSave } from './create-engine';
import type { Cell, RunContext } from './types';

/**
 * Options for {@link createSensitivityCell} — bundles the immutable
 * save-blob baseline, the per-run module-instance factory, an optional
 * `perturb` hook, and the analyzer factory used by every run of this cell.
 */
export interface CreateSensitivityCellOptions {
  name: string;
  /** Exported save string — treated as an immutable snapshot across runs. */
  saveText: string;
  /**
   * Factory returning a fresh set of module instances per run. Returning
   * fresh instances prevents persistent-ref aliasing across sequential
   * matrix runs — module closures that hold `persistent()` refs would
   * otherwise overwrite each other as setup() is re-entered.
   */
  modules: () => EngineModule[];
  /**
   * Optional mutation applied to the engine after build, before analyzer
   * construction and the first tick. Receives the harness `RunContext` so
   * stochastic consumers can route `ctx.seed` into per-run RNG seeding
   * (e.g. `seedRNG(ctx.seed)`) without smuggling globals. The canonical
   * use case otherwise is pushing an `OverrideRegistry` scope to rewrite
   * a binding for the variant run.
   */
  perturb?: (engine: Engine, ctx: RunContext) => void;
  /**
   * Optional factory producing this run's analyzer instances. Called with
   * the freshly-built (and perturbed) engine, inside the harness `setup()`
   * seam — so analyzers can close over live per-run refs. The workbench
   * default is `(engine) => defaultAnalyzerPack(engine)`; omit for
   * metric-free runs.
   *
   * Analyzers exposing `onRunFinalize` are auto-subscribed to the engine's
   * `CycleLogKey` (when any module publishes one) inside `setup()`. No
   * extra wiring step is required for the run-finalize hook.
   */
  buildAnalyzers?: (engine: Engine) => Analyzer[];
  /**
   * Drives the engine one tick. Receives the engine built in this run
   * plus the harness-provided dt. Typical shapes:
   * `(engine) => engine.tickDriver.stepOnce()` or a consumer-specific handler.
   */
  tick: (engine: Engine, dt: number) => void;
  ticks: number;
  tickDelta?: number;
  /**
   * Base namespace for the per-run scratch engine. The harness appends a
   * monotonic counter so concurrent/sequential runs never alias.
   * Defaults to `workbench-<cell name>`.
   */
  persistenceNamespace?: string;
  /** Forwarded to `createEngineFromSave` — same restrictions apply. */
  config?: Omit<
    EngineConfig,
    'gameId' | 'persistence' | 'persistenceNamespace' | 'storageAdapter' | 'autoSaveInterval'
  >;
}

let runCounter = 0;

/**
 * Build a harness `Cell` backed by a per-run engine constructed from a
 * save blob. Composable with {@link runMatrix}, {@link runBatch}, and
 * {@link runSensitivity}.
 *
 * The returned cell holds the current run's engine in closure and its
 * `teardown` disposes it, so a matrix runner leaves no engine live behind a
 * run. A caller driving `setup` by hand gets the same through re-entry:
 * setup disposes the previous run's engine before building the next.
 * Multiple concurrent invocations of a single cell are not supported —
 * matrix execution is sync-sequential by design.
 *
 * @param options - {@link CreateSensitivityCellOptions} — save blob, module
 *   factory, tick handler, optional perturb / analyzer hooks.
 * @returns A harness {@link Cell} whose `setup` rebuilds a fresh engine
 *   per run, whose `tick` drives that engine and whose `teardown`
 *   disposes it. Caller passes this into
 *   any matrix runner.
 *
 * @example
 * ```ts
 * const blob = live.saveManager!.exportSave();
 * const baseline = createSensitivityCell({
 *   name: 'baseline',
 *   saveText: blob,
 *   modules: () => [createGoldModule()],
 *   tick: (engine) => engine.tickDriver.stepOnce(),
 *   ticks: 1000,
 * });
 * ```
 */
export function createSensitivityCell(options: CreateSensitivityCellOptions): Cell {
  const {
    name,
    saveText,
    modules,
    perturb,
    buildAnalyzers,
    tick,
    ticks,
    tickDelta,
    persistenceNamespace: namespace = `workbench-${name}`,
    config,
  } = options;

  let currentEngine: Engine | undefined;
  let loopFinalizeUnsubs: (() => void)[] = [];

  const teardown = (): void => {
    for (const unsub of loopFinalizeUnsubs) unsub();
    loopFinalizeUnsubs = [];
    currentEngine?.dispose();
    currentEngine = undefined;
  };

  const setup = (ctx: RunContext): Analyzer[] => {
    teardown();
    const engine = createEngineFromSave({
      saveText,
      modules: modules(),
      persistenceNamespace: `${namespace}-${runCounter++}`,
      config,
    });
    perturb?.(engine, ctx);
    const analyzers: Analyzer[] = buildAnalyzers?.(engine) ?? [];
    const log = engine.tryInject(CycleLogKey);
    if (log) {
      for (const analyzer of analyzers) {
        const hook = analyzer.onRunFinalize;
        if (hook) loopFinalizeUnsubs.push(log.on('finalized', (entry) => hook(entry)));
      }
    }
    currentEngine = engine;
    return analyzers;
  };

  const tickAdapter = (dt: number): void => {
    if (!currentEngine) {
      throw new Error(
        `createSensitivityCell[${name}]: tick called before setup — harness ordering violated`,
      );
    }
    tick(currentEngine, dt);
  };

  return {
    name,
    setup,
    tick: tickAdapter,
    teardown,
    ticks,
    ...(tickDelta !== undefined && { tickDelta }),
  };
}
