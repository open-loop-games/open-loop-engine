/**
 * Harness cell factory for the balance loop.
 *
 * Bridges `createEngineFromSave` (engine construction from save text for
 * each headless run) with the harness `Cell` contract. The matrix runner builds a new
 * engine per `(cell × seed)` via `Cell.setup`, so this factory
 * returns a cell whose setup closure owns the engine and whose tick
 * closure drives it.
 *
 * Order inside `setup`: build the engine from the save → apply `perturb` →
 * build analyzers → subscribe `onRunFinalize` to any published
 * CycleLog. The cell then runs for `ticks × tickDelta` sim-seconds.
 *
 * @cluster runners
 */

import type { Analyzer } from '@/primitives/types';
import type { Engine, EngineOptions, EngineModule } from '@/engine';
import { CycleLogKey } from '@/systems/cycle-log';
import { createEngineFromSave } from './create-engine';
import type { Cell, RunContext } from './types';

/**
 * Options for {@link createSensitivityCell}: the immutable baseline save
 * text. They also hold the module-instance factory for each headless run, an
 * optional `perturb` function, and the analyzer factory every headless run of
 * this cell uses.
 */
export interface CreateSensitivityCellOptions {
  id: string;
  /** Save text, as `exportSave` returns it. Every headless run starts from it unchanged. */
  saveText: string;
  /**
   * Factory returning a fresh set of module instances per headless run.
   * Returning fresh instances prevents persistent-ref aliasing across
   * sequential headless runs of a matrix. Module closures that hold
   * `persistent()` refs would otherwise overwrite each other as setup() is
   * re-entered.
   */
  modules: () => EngineModule[];
  /**
   * Optional mutation applied to the engine after build, before analyzer
   * construction and the first tick. Receives the harness `RunContext`, so
   * stochastic consumers can route `ctx.seed` into the RNG seeding of each headless run
   * (e.g. `seedRNG(ctx.seed)`) without global variables. The other typical
   * use pushes scoped overrides onto an `OverrideRegistry` for the
   * variant's headless run.
   */
  perturb?: (engine: Engine, ctx: RunContext) => void;
  /**
   * Optional function that builds the analyzer instances of this headless run. Called with
   * the newly built (and perturbed) engine, inside the harness `setup()`
   * seam, so analyzers can close over the live refs of the headless run. A balance
   * workbench's typical value is `(engine) => defaultAnalyzerPack(engine)`;
   * omit it for metric-free headless runs.
   *
   * Analyzers that have `onRunFinalize` are subscribed to the engine's
   * `CycleLogKey` (when any module publishes one) inside `setup()`. So
   * `onRunFinalize` needs no extra wiring.
   */
  buildAnalyzers?: (engine: Engine) => Analyzer[];
  /**
   * Drives the engine one tick. Receives the engine built in this headless run
   * plus the harness-provided dt. Typical shapes:
   * `(engine) => engine.tickDriver.tickOnce()` or a consumer-specific handler.
   */
  tick: (engine: Engine, dt: number) => void;
  ticks: number;
  tickDelta?: number;
  /**
   * Base persistence namespace for the scratch engine of each headless run. The balance
   * harness appends a counter that only increases, so concurrent or
   * sequential headless runs never alias. Defaults to `workbench-<cell id>`.
   */
  persistenceNamespace?: string;
  /** Forwarded to `createEngineFromSave` — same restrictions apply. */
  engineOptions?: Omit<
    EngineOptions,
    'gameId' | 'persistence' | 'persistenceNamespace' | 'storageAdapter' | 'autoSaveInterval'
  >;
}

let runCounter = 0;

/**
 * Build a harness `Cell` backed by an engine per headless run, constructed
 * from save text. Composable with {@link runMatrix} and
 * {@link runSensitivity}.
 *
 * The returned cell holds the engine of the current headless run in closure,
 * and its `teardown` disposes it. So a matrix runner leaves no engine live
 * behind a headless run. A caller driving `setup` by hand gets the same
 * through re-entry: setup disposes the previous engine before building the
 * next.
 * Multiple concurrent invocations of a single cell are not supported —
 * matrix execution is sync-sequential by design.
 *
 * @param options - {@link CreateSensitivityCellOptions} — save text, module
 *   factory, tick function, optional `perturb` and `buildAnalyzers`.
 * @returns A harness {@link Cell} whose `setup` builds a new engine
 *   per headless run, whose `tick` drives that engine and whose `teardown`
 *   disposes it. The caller passes it into any matrix runner.
 *
 * @example
 * ```ts
 * const saveText = live.saveManager!.exportSave();
 * const baseline = createSensitivityCell({
 *   id: 'baseline',
 *   saveText,
 *   modules: () => [createGoldModule()],
 *   tick: (engine) => engine.tickDriver.tickOnce(),
 *   ticks: 1000,
 * });
 * ```
 */
export function createSensitivityCell(options: CreateSensitivityCellOptions): Cell {
  const {
    id: name,
    saveText,
    modules,
    perturb,
    buildAnalyzers,
    tick,
    ticks,
    tickDelta,
    persistenceNamespace: namespace = `workbench-${name}`,
    engineOptions: config,
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
      engineOptions: config,
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
    id: name,
    setup,
    tick: tickAdapter,
    teardown,
    ticks,
    ...(tickDelta !== undefined && { tickDelta }),
  };
}
