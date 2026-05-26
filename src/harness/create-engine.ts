/**
 * Workbench engine builder — fresh `createEngine` under an isolated
 * persistence namespace backed by in-memory storage, hydrated from a save
 * blob. `createSensitivityCell` composes this into a harness `Cell` for
 * per-run scratch engines.
 */

import { createEngine } from '@/index';
import type { Engine, EngineConfig, EngineModule } from '@/index';
import { createMemoryStorage } from '@/core/save-manager';

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
 * The caller owns the engine — stop it when done so its tick timer is
 * released. Memory-backed storage and namespaced refs are GC'd when the
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
