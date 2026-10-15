/**
 * Scratch engine from a save — a fresh `createEngine` engine in an isolated
 * persistence namespace with in-memory storage, loaded from save text.
 * Predictors, Web Workers and the balance workbench load a player's save
 * into one, to simulate ahead without touching the live game.
 * `createSensitivityCell` composes it into a `Cell` that builds one scratch
 * engine per headless run.
 *
 * @cluster runners
 */

import { createEngine } from '@/engine';
import type { Engine, EngineOptions, EngineModule, ModDef } from '@/engine';
import type { TimerProvider } from '@/core/tick-driver';
import { createMemoryStorage } from '@/core/save-manager';

/** `start()` arms no OS timer; callers step the scratch engine by hand. */
const NOOP_TIMER_PROVIDER: TimerProvider = {
  setInterval: () => 0,
  clearInterval: () => {},
};

/** Options for {@link createEngineFromSave}. */
export interface CreateEngineFromSaveOptions {
  /** Save text, as `saveManager.exportSave()` returns it. */
  saveText: string;
  /** Modules to install on the new engine, in order, beside a selected mod's. */
  modules?: EngineModule[];
  /**
   * The game's mods, as `createEngine` takes them. When the save names a mod,
   * the engine selects it from these, so its modules install too.
   */
  mods?: ModDef[];
  /**
   * Persistence namespace. Keep it unique among engines not yet disposed,
   * so persistent contexts and storage keys don't alias. Defaults to a fresh
   * `'workbench-scratch-<n>'` per call.
   */
  persistenceNamespace?: string;
  /**
   * Extra options for the inner `createEngine` call. This factory sets
   * `gameId`, `persistence`, `persistenceNamespace`, `storageAdapter` and
   * `autoSaveInterval` itself, and the caller cannot change them.
   */
  engineOptions?: Omit<
    EngineOptions,
    | 'gameId'
    | 'persistence'
    | 'persistenceNamespace'
    | 'storageAdapter'
    | 'autoSaveInterval'
    | 'mods'
  >;
}

let scratchCounter = 0;

/**
 * Load a save into a fresh, isolated engine running the given modules. The
 * result is a scratch copy of the game, to simulate or inspect without
 * touching the live one. It adopts the save's own `gameId`, so any save your
 * game exported loads. It selects the mod the save names, installs the
 * modules, starts the engine and imports the save.
 *
 * The engine gets a no-op timer, so `start()` arms no real `setInterval`.
 * Drive it with `tickDriver.tickOnce()` / `advanceTime`, or a balance-harness
 * runner. Pass `engineOptions.timerProvider` for a self-ticking one, and stop
 * it yourself. The caller owns the engine. Its namespaced persistent refs stay
 * in the persistent-ref registry until `engine.dispose()`, so dropping the
 * reference alone does not free them.
 *
 * @param options - The save text, the modules or mods to install, and
 *   optionally a persistence namespace and extra `createEngine` options.
 * @returns The started engine, with the save loaded.
 * @throws {Error} when the save text isn't valid JSON, when it names a mod
 *   `mods` doesn't hold, or when the import fails. On an import failure the
 *   engine is disposed first.
 *
 * @example
 * ```ts
 * const scratch = createEngineFromSave({
 *   saveText: engine.saveManager!.exportSave(),
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
    saveText,
    modules = [],
    mods,
    persistenceNamespace: namespace = `workbench-scratch-${scratchCounter++}`,
    engineOptions: config = {},
  } = options;

  // Adopt the envelope's gameId so saveManager.importSave's gameId guard
  // accepts the save text. Memory storage and a unique persistence namespace
  // isolate the scratch engine, so the gameId has no other meaning here.
  let envelope: { gameId: string; modId?: string };
  try {
    envelope = JSON.parse(saveText) as { gameId: string; modId?: string };
  } catch {
    throw new Error('createEngineFromSave: save text is not valid JSON');
  }
  const { gameId: envelopeGameId, modId } = envelope;
  if (modId !== undefined && !mods?.some((m) => m.id === modId)) {
    throw new Error(
      `createEngineFromSave: the save names mod "${modId}", which \`mods\` doesn't hold`,
    );
  }

  const engine = createEngine({
    timerProvider: NOOP_TIMER_PROVIDER,
    ...config,
    mods,
    gameId: envelopeGameId,
    persistence: true,
    persistenceNamespace: namespace,
    storageAdapter: createMemoryStorage(),
    autoSaveInterval: 0,
  });

  if (modId !== undefined) engine.selectMod(modId);
  for (const mod of modules) engine.use(mod);
  engine.start();

  const result = engine.saveManager!.importSave(saveText);
  if (!result.success) {
    engine.dispose();
    throw new Error('createEngineFromSave: failed to import save text');
  }

  return engine;
}
