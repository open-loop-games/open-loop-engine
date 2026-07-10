/**
 * Workbench engine builder — fresh `createEngine` under an isolated
 * persistence namespace backed by in-memory storage, hydrated from a save
 * blob. `createSensitivityCell` composes this into a harness `Cell` for
 * per-run scratch engines.
 */

import { createEngine } from '@/engine';
import type { Engine, EngineConfig, EngineModule } from '@/engine';
import type { TimerProvider } from '@/core/tick-driver';
import { createMemoryStorage } from '@/core/save-manager';

/**
 * No-op timer for scratch engines. The workbench drives every tick manually
 * (`cell.tick` → `tickDriver.stepOnce()`), so a live `setInterval` from
 * `engine.start()` is pure liability: it would race the manual stepping and,
 * because the harness never sees the per-run engine, leak on the final run —
 * ticking the imported save after the sweep returns. Defaulting the scratch
 * engine here means no real OS timer is ever armed, so nothing can leak.
 */
const NOOP_TIMER_PROVIDER: TimerProvider = {
  setInterval: () => 0,
  clearInterval: () => {},
};

/** @internal */
export interface CreateEngineFromSaveOptions {
  /** Exported save string (from `saveManager.exportSave()`). */
  saveBlob: string;
  /** Modules to install on the new engine, in order. */
  modules: EngineModule[];
  /**
   * Persistence namespace. Must be unique across concurrent/sequential
   * engines so persistent-ref contexts and storage keys don't alias.
   * Defaults to `'workbench-scratch'`.
   */
  namespace?: string;
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

/**
 * Create a fresh engine, install modules, start the loop, and hydrate from
 * the given save blob. Throws if the imported save fails to apply.
 *
 * The scratch engine defaults to a no-op timer provider, so `start()` arms no
 * real `setInterval` — the workbench drives ticks manually and a self-ticking
 * scratch engine would both race the manual stepping and leak. Pass
 * `config.timerProvider` to opt into a real timer (then the caller owns
 * stopping it). Memory-backed storage and namespaced refs are GC'd when the
 * reference is dropped.
 *
 * @internal
 */
export function createEngineFromSave(options: CreateEngineFromSaveOptions): Engine {
  const { saveBlob, modules, namespace = 'workbench-scratch', config = {} } = options;

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
    engine.stop();
    throw new Error('createEngineFromSave: failed to import save blob');
  }

  return engine;
}
