/**
 * Scratch engine from a save — a fresh `createEngine` under an isolated
 * persistence namespace backed by in-memory storage, hydrated from a save
 * blob. Predictors, workers and the balance workbench load a player's save
 * into one to simulate ahead without touching the live game;
 * `createSensitivityCell` composes it into a harness `Cell` for per-run
 * scratch engines.
 *
 * @cluster runners
 */

import { createEngine } from '@/engine';
import type { Engine, EngineConfig, EngineModule } from '@/engine';
import type { TimerProvider } from '@/core/tick-driver';
import { createMemoryStorage } from '@/core/save-manager';

/** `start()` arms no OS timer; callers step the scratch engine by hand. */
const NOOP_TIMER_PROVIDER: TimerProvider = {
  setInterval: () => 0,
  clearInterval: () => {},
};

/** Options for {@link createEngineFromSave}. */
export interface CreateEngineFromSaveOptions {
  /** Exported save string (from `saveManager.exportSave()`). */
  saveBlob: string;
  /** Modules to install on the new engine, in order. */
  modules: EngineModule[];
  /**
   * Persistence namespace. Must be unique among engines not yet disposed so
   * persistent-ref contexts and storage keys don't alias. Defaults to a
   * fresh `'workbench-scratch-<n>'` per call.
   */
  persistenceNamespace?: string;
  /**
   * Overrides for the inner `createEngine` call. `gameId`, `persistence`,
   * `persistenceNamespace`, `storageAdapter`, and `autoSaveInterval` are
   * fixed by this helper and cannot be overridden.
   */
  config?: Omit<
    EngineConfig,
    'gameId' | 'persistence' | 'persistenceNamespace' | 'storageAdapter' | 'autoSaveInterval'
  >;
}

let scratchCounter = 0;

/**
 * Load a save into a fresh, isolated engine running the given modules — a
 * scratch copy of the game to simulate or inspect without touching the live
 * one. It adopts the save's own `gameId`, so any save your game exported
 * loads, and it installs the modules, starts the engine and imports the save.
 *
 * The engine gets a no-op timer, so `start()` arms no real `setInterval`:
 * drive it with `tickDriver.stepOnce()` / `simulateTick`, or a harness
 * runner. Pass `config.timerProvider` for a self-ticking one (then stop it
 * yourself). The caller owns the engine: its namespaced persistent refs stay
 * in the process-wide registry until `engine.dispose()`, so dropping the
 * reference alone retains them.
 *
 * @param options - The save blob, the modules to install, and optionally a
 *   persistence namespace and extra `createEngine` config.
 * @returns The started engine, with the save applied.
 * @throws {Error} when the blob isn't valid JSON or the save fails to import;
 *   the half-built engine is disposed first.
 *
 * @example
 * ```ts
 * const scratch = createEngineFromSave({
 *   saveBlob: engine.saveManager!.exportSave(),
 *   modules: [economyModule, prestigeModule],
 * });
 * try {
 *   const result = runUntil({ engine: scratch, until: () => prestigeReady(), maxSimTime: 3600 });
 *   console.log(result.elapsedSimulated); // seconds until the player could prestige
 * } finally {
 *   scratch.dispose();
 * }
 * ```
 */
export function createEngineFromSave(options: CreateEngineFromSaveOptions): Engine {
  const {
    saveBlob,
    modules,
    persistenceNamespace: namespace = `workbench-scratch-${scratchCounter++}`,
    config = {},
  } = options;

  // Adopt the source envelope's gameId so saveManager.importSave's gameId
  // guard accepts the blob. The scratch engine is otherwise isolated via
  // memory storage and a unique persistence namespace, so the label itself
  // carries no further meaning here.
  let envelopeGameId: string;
  try {
    envelopeGameId = (JSON.parse(saveBlob) as { gameId: string }).gameId;
  } catch {
    throw new Error('createEngineFromSave: save blob is not valid JSON');
  }

  const engine = createEngine({
    timerProvider: NOOP_TIMER_PROVIDER,
    ...config,
    gameId: envelopeGameId,
    persistence: true,
    persistenceNamespace: namespace,
    storageAdapter: createMemoryStorage(),
    autoSaveInterval: 0,
  });

  for (const mod of modules) engine.use(mod);
  engine.start();

  const result = engine.saveManager!.importSave(saveBlob);
  if (!result.success) {
    engine.dispose();
    throw new Error('createEngineFromSave: failed to import save blob');
  }

  return engine;
}
