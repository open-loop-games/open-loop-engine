/**
 * Engine assembly — the module-system façade that composes core + systems into
 * a runnable game: {@link createEngine}, {@link EngineContext},
 * {@link EngineModule}, {@link EngineConfig}, and the built-in injection keys.
 *
 * Lives in its own module rather than the root barrel so the harness can import
 * the engine builder without a back-edge through `@/index` — which re-exports
 * `./harness` and would otherwise close a runtime cycle. Imports only downward
 * (primitives, core, systems); never from harness.
 *
 * @cluster engine
 */

// === MODULE SYSTEM ===

import { effectScope } from 'vue';
import { createTickDriver } from './core/tick-driver';
import { createSaveManager } from './core/save-manager';
import {
  withPersistentContext,
  withPersistenceNamespace,
  clearPersistentNamespace,
} from './core/persistence';
import { createEmitHandle } from './core/events';
import {
  ChainRegistryKey,
  EffectSystemRegistryKey,
  ResourceRegistryKey,
  createChainRegistry,
  createEffectSystemRegistry,
  createResourceRegistry,
  withChainRegistry,
  withEffectSystemRegistry,
  withResourceRegistry,
} from './core/registries';
import {
  TuningRegistriesKey,
  withTuningRegistries,
  type TuningRegistry,
} from './core/override-registry';
import { withGameStateAccessor } from './core/game-state-accessor';
import type { GameStateAccessor } from './primitives/types';
import type { GameStateMutator } from './core/effects';
import {
  CategoriesKey,
  withEngineCategories,
  type EngineCategories,
} from './systems/engine-categories';

import type { TickDriver, TimerProvider } from './core/tick-driver';
import type {
  SaveManager,
  SaveLoadResult,
  SaveMigration,
  SavePeek,
  StorageAdapter,
} from './core/save-manager';

/** Callback invoked every game tick with the elapsed delta time in seconds. */
export type TickHandler = (dt: number) => void;
/**
 * Callback invoked before live state is serialized — by `engine.save()`, the
 * autosave, and the save manager's `save` / `saveToSlot` / `exportSave` —
 * so it can flush derived state into persistent refs.
 */
export type SaveHandler = () => void;
/**
 * Callback invoked after a save loads successfully through any entry point:
 * `engine.load()`, the save manager's `load` / `importSave`, or a harness
 * engine hydrated from a save. Receives the `SaveLoadResult` (always
 * `success: true`, with the save's timestamp) — not the decoded payload.
 *
 * Every `onLoad` runs before the engine's own post-load reconciles (a
 * challenge's scopes, a latching achievement or automation tier, a slot's
 * resync), so a watcher reacting to their writes sees the state `onLoad`
 * rebuilt. A reset runs those reconciles and no `onLoad`.
 */
export type LoadHandler = (result: SaveLoadResult) => void;

// `InjectionKey<T>` lives in `./primitives/types` so the systems and harness
// entry points can reach it without a back-edge to the root module.
import type { InjectionKey } from './primitives/types';

/**
 * Engine-wide event map — extend via declaration merging to add game events.
 *
 * Each key is an event name, each value is the handler signature.
 *
 * @example
 * ```ts
 * declare module '@open-loop/engine' {
 *   interface EngineEvents {
 *     playerDied: () => void;
 *     questCompleted: (id: string) => void;
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EngineEvents {}

// === BUILT-IN INJECTION KEYS ===
// Engine services pre-provided before any module installs.

/** Inject the TickDriver instance. Always available. */
export const TickDriverKey: InjectionKey<TickDriver> = Symbol('engine:tick-driver');

/** Inject the save manager. Available when `persistence` is not `false`. */
export const SaveManagerKey: InjectionKey<SaveManager> = Symbol('engine:save');

// `EngineCategories` and `CategoriesKey` live alongside the category
// factories in `./systems/engine-categories` and reach the public surface
// through the systems barrel. Imported at the top of this file for the
// `createEngine` self-publish wiring.

/**
 * Per-module collaboration surface, handed to each {@link EngineModule}'s
 * `install` and `connect` callbacks. Exposes lifecycle hooks (tick / save /
 * load), engine-wide event pub/sub, and the
 * {@link provide} / {@link inject} channel modules use to share APIs.
 */
export interface EngineContext {
  /** Register a callback invoked every game tick with delta time in seconds */
  onTick(callback: TickHandler): () => void;
  /** Register a callback invoked before live state is serialized; see {@link SaveHandler}. */
  onSave(callback: SaveHandler): void;
  /** Register a callback invoked after a save loads, by any entry point; see {@link LoadHandler}. */
  onLoad(callback: LoadHandler): void;

  /**
   * Subscribe to an engine-wide event. Returns an unsubscribe function.
   *
   * Subscriptions made during `install()` / `connect()` are released by
   * `engine.dispose()`.
   *
   * @example
   * ```ts
   * engine.on('playerDied', () => { showReincarnation(); });
   * ```
   */
  on<K extends keyof EngineEvents>(event: K, handler: EngineEvents[K]): () => void;

  /**
   * Emit an engine-wide event, invoking all subscribers.
   *
   * @example
   * ```ts
   * engine.emit('playerDied');
   * engine.emit('questCompleted', 'tutorial');
   * ```
   */
  emit<K extends keyof EngineEvents>(
    event: K,
    ...args: EngineEvents[K] extends (...args: infer A) => any ? A : never
  ): void;

  /**
   * Publish a value for other modules to consume via {@link inject}.
   * Typically called during `install()` to expose a module's public API.
   */
  provide<T>(key: InjectionKey<T>, value: T): void;

  /**
   * Retrieve a value published by another module. Throws if the key has
   * not been provided — use {@link tryInject} for optional dependencies.
   *
   * Safe to call during `install()`: dependency ordering guarantees that
   * a module's dependencies have already been installed (and provided).
   */
  inject<T>(key: InjectionKey<T>): T;

  /**
   * Like {@link inject}, but returns `undefined` instead of throwing
   * when the key has not been provided. Use for optional dependencies.
   */
  tryInject<T>(key: InjectionKey<T>): T | undefined;
}

/**
 * A registerable unit of game content. The engine installs modules in
 * dependency order during `start()`, then runs every module's optional
 * `connect()` phase once every module's `install()` has completed.
 */
export interface EngineModule {
  id: string;
  dependencies?: string[];
  /** Create state, register handlers, provide APIs. Called in dependency order. */
  install(engine: EngineContext): void;
  /**
   * Cross-module wiring phase, called after ALL modules have installed.
   * Use for wiring that needs every module's APIs to exist — cycle-breaking
   * callbacks, runner initialization, cross-cutting subscriptions.
   * Called in the same topological order as install(). Full EngineContext available.
   */
  connect?(engine: EngineContext): void;
}

/**
 * A selectable game mod — metadata plus the module to install when active.
 *
 * Mods are game variants selected at new-game creation (à la AD NG+++).
 * Only one mod is active per save. `selectMod()` pushes the mod's full
 * module list into the engine's registration list; `start()` then installs
 * them alongside any modules the consumer added via `use()`.
 */
export interface ModDef {
  /** Unique identifier stored in the save */
  id: string;
  /** Display name for the mod picker UI */
  name: string;
  /** Optional description shown in the mod picker */
  description?: string;
  /** Highlight this mod in the picker (e.g., "Recommended") */
  recommended?: boolean;
  /**
   * The full module set installed when this mod is active. Includes every
   * module the game needs under this variant — shared base, game content,
   * and any mod-specific tail. Not a delta layered over an implicit base.
   */
  modules: EngineModule[];
}

/**
 * Configuration passed to {@link createEngine}. `gameId` is required; every
 * other field tunes tick cadence, save behavior, mod support, or persistence
 * namespacing.
 */
export interface EngineConfig {
  gameId: string;
  tickRate?: number;
  maxDeltaTime?: number;
  /** Initial speed multiplier (default 1). Scales dt during live play. */
  speedMultiplier?: number;
  /**
   * dt handling mode. `'variable'` (default) passes real elapsed dt to callbacks.
   * `'fixed'` accumulates and drains at `stepSize` per sub-tick — for source-faithful
   * ports with clamp-on-overshoot tick math. See `createTickDriver` for details.
   */
  tickMode?: 'variable' | 'fixed';
  /** Seconds per sub-tick in fixed mode. Defaults to `1 / tickRate`. */
  stepSize?: number;
  /** Cap on sub-ticks per `intervalTick` in fixed mode (default 100). Live-play overspill protection. */
  maxStepsPerTick?: number;
  /** Diagnostic callback when fixed-mode `intervalTick` drops sub-steps. */
  onStepsOverflow?: (droppedSteps: number) => void;
  /**
   * Diagnostic callback when a variable-mode tick's raw dt exceeds
   * `maxDeltaTime`; receives the dropped seconds, for banking them.
   */
  onDeltaOverflow?: (droppedSeconds: number) => void;
  /**
   * Custom timer functions for scheduling the TickDriver and autosave.
   * Pass `worker-timers` functions for background-tab immunity.
   * Defaults to native setInterval/clearInterval.
   */
  timerProvider?: TimerProvider;
  /**
   * Interval in ms between autosaves. 0 or omitted disables autosave. The
   * autosave writes the save manager's active slot, whichever that is.
   */
  autoSaveInterval?: number;
  /** Set to false to skip save manager creation. Default true. */
  persistence?: boolean;
  /** Save format version number. Passed to the save manager. */
  saveVersion?: number;
  /** Migration functions keyed by source version. Passed to the save manager. */
  saveMigrations?: Record<number, SaveMigration>;
  /** Custom storage backend. Defaults to localStorage. */
  storageAdapter?: StorageAdapter;
  /** Maximum number of save slots. Default: 10 */
  maxSaveSlots?: number;
  /**
   * When true, any save validation failure aborts the load with
   * `save:load-failed { reason: 'validation' }`. When false, failing leaves
   * are self-healed to their persistent ref's default value and the load
   * proceeds. `save:validation-error` is emitted per field in both modes.
   *
   * Defaults to dev-mode detection in the underlying save manager: fail-loud
   * in development (so bugs surface early), self-heal in production (so
   * player saves stay protected).
   */
  strictValidation?: boolean;
  /** Available game mods. One may be selected before start(). */
  mods?: ModDef[];
  /**
   * Isolate this engine instance's persistent state from any other engine
   * sharing the same runtime. When set, all module/category persistence
   * contexts are prefixed with the namespace, the save manager filters its
   * context walk to this namespace only, and storage keys carry the
   * namespace so two engines with the same `gameId` don't alias each other.
   *
   * Leave undefined for single-engine apps — behavior is bit-for-bit
   * identical to pre-namespacing saves.
   *
   * Primary use case: forkable "scratch" engine instances for sim/balance
   * workbenches, takeover compare, A/B predictive displays.
   */
  persistenceNamespace?: string;
  /**
   * Consumer-supplied game-state accessor + mutator. When provided, category
   * factories (`createChallengeCategory`, etc.) read it from the ambient
   * context as a fallback when no per-category `accessor` option is given.
   * The accessor is a stateless vtable constructed before any module
   * installs — its methods are only called at gameplay time, not during
   * install/connect.
   */
  accessor?: GameStateAccessor & GameStateMutator;
}

/**
 * The assembled engine instance returned by {@link createEngine}. Modules are
 * registered via `use()`, the game runs between `start()` and `stop()`, and
 * `dispose()` releases this engine's persistent contexts when a fresh
 * instance will reuse the same module ids in the same page lifetime.
 */
export interface Engine {
  /**
   * Register a module for `start()` to install.
   * @throws After `start()`, which installs the module set once.
   */
  use(module: EngineModule): Engine;
  /**
   * Install registered modules and begin ticking. Does not load a save —
   * call `load()` explicitly after `start()` (modules must install first so
   * their persistent refs exist to hydrate).
   * @throws On a disposed engine, a circular or missing dependency, or two
   *   different module objects registered under one id.
   */
  start(): void;
  stop(): void;
  /**
   * Tear down the engine: stop the TickDriver, stop every watcher and computed
   * modules created during `install()` / `connect()`, drop their tick
   * handlers, event subscriptions and save/load hooks, and release every
   * persistent context this engine registered under its
   * `persistenceNamespace`. Safe to pass detached, as in
   * `onUnmounted(engine.dispose)`. Required when a fresh engine sharing the same module ids will be constructed in the same
   * page-lifetime — e.g. the gallery sandbox remounting an archetype. Save
   * storage (keyed by `gameId`, plus `persistenceNamespace` when set) is
   * untouched, so a subsequent engine loads the same on-disk save.
   *
   * After dispose, calling `start()` throws. The engine instance must be
   * dropped; callers create a new engine via `createEngine()` to resume.
   */
  dispose(): void;
  /** Save game state to the active slot, firing all onSave callbacks first. */
  save(): void;
  /**
   * Load the active slot, firing all onLoad callbacks after.
   * @throws Before `start()` (no module has created its refs yet) or after `dispose()`.
   */
  load(): SaveLoadResult;
  readonly tickDriver: TickDriver;
  readonly saveManager: SaveManager | undefined;
  /**
   * The module set registered via `use()` plus any mod modules appended by
   * `selectMod()`. Exposed so forkable-instance helpers (scratch engines, sim
   * workbenches) can spin up a second engine with the same module shape
   * without the caller tracking the list externally.
   */
  readonly registeredModules: readonly EngineModule[];
  /**
   * Read a value published by a module via `ctx.provide(key, value)`
   * during its `install()` / `connect()` phase. Returns `undefined` when
   * the key has not been provided or when called before `start()`.
   *
   * External introspection tools (sim pickers, devtools, balance
   * workbenches) use this to read opt-in discovery keys like
   * {@link CategoriesKey}, {@link ChainRegistryKey}, and
   * {@link EffectSystemRegistryKey} without having to install a probe
   * module purely to capture them.
   */
  tryInject<T>(key: InjectionKey<T>): T | undefined;

  // === MOD SUPPORT ===
  /** Registered mod definitions (from config) */
  readonly mods: readonly ModDef[];
  /** Currently selected mod ID, or null if no mod selected */
  readonly activeModId: string | null;
  /**
   * Select a mod before calling start(). Pushes every module in the mod's
   * `modules` list into the engine's registration list (as if the consumer
   * had called `use()` on each) and tags the active save with the mod id.
   * Must be called before `start()`, and only once per engine instance.
   * @throws If the mod id is unknown, a mod is already selected, or the
   *   engine has already started.
   */
  selectMod(modId: string): void;
  /**
   * Read save metadata without full deserialization.
   * Use to determine which mod a save was created with before calling
   * selectMod() + start().
   */
  peekSave(): SavePeek | null;

  /**
   * Live interval in milliseconds between autosaves. Mirrors
   * {@link EngineConfig.autoSaveInterval} but is mutable at runtime —
   * setting it re-arms the autosave timer with the new period (or stops
   * it when set to 0). No effect when `persistence: false` was passed to
   * {@link createEngine}. Symmetric to `engine.tickDriver.tickRate`.
   */
  autoSaveInterval: number;
}

/**
 * Creates the top-level engine orchestrator that wires together the TickDriver,
 * save manager, module system, and mod support.
 *
 * @param config - Engine configuration including game ID, TickDriver settings, persistence
 *   options, and available mods
 * @returns An engine instance that accepts modules via `use()`, then `start()` to begin
 *   ticking. Exposes the TickDriver, save manager, and mod selection.
 *
 * @example
 * ```ts
 * const engine = createEngine({ gameId: 'my-game', tickRate: 20 });
 * engine.use(resourceModule);
 * engine.use(combatModule);
 * engine.start();
 * ```
 */
export function createEngine(config: EngineConfig): Engine {
  const modules: EngineModule[] = [];
  const saveCallbacks: SaveHandler[] = [];
  const loadCallbacks: LoadHandler[] = [];
  const registeredMods: ModDef[] = [...(config.mods ?? [])];
  let selectedModId: string | null = null;

  const timers = config.timerProvider ?? {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };

  // Created inside the engine's namespace under a stable context id so the
  // fixed-mode accumulator joins this engine's namespaced save, restores
  // deterministically across sessions, and is evicted by `dispose()`'s
  // `clearPersistentNamespace`. Outside the namespace it would strand in the
  // default bucket — excluded from its own save (open-loop-engine#9).
  const tickDriver = withPersistenceNamespace(config.persistenceNamespace, () =>
    createTickDriver({
      tickRate: config.tickRate,
      maxDeltaTime: config.maxDeltaTime,
      speedMultiplier: config.speedMultiplier,
      tickMode: config.tickMode,
      stepSize: config.stepSize,
      maxStepsPerTick: config.maxStepsPerTick,
      onStepsOverflow: config.onStepsOverflow,
      onDeltaOverflow: config.onDeltaOverflow,
      timerProvider: config.timerProvider,
      persistentContextId: 'tick-driver',
    }),
  );
  const saveManager =
    config.persistence !== false
      ? createSaveManager({
          gameId: config.gameId,
          version: config.saveVersion,
          migrations: config.saveMigrations,
          storageAdapter: config.storageAdapter,
          maxSlots: config.maxSaveSlots,
          persistenceNamespace: config.persistenceNamespace,
          strictValidation: config.strictValidation,
        })
      : undefined;

  let autoSaveTimer: number | null = null;
  let autoSaveInterval = config.autoSaveInterval ?? 0;
  let installed = false;
  let disposed = false;

  function stopAutoSaveTimer(): void {
    if (autoSaveTimer !== null) {
      timers.clearInterval(autoSaveTimer);
      autoSaveTimer = null;
    }
  }

  function startAutoSaveTimer(): void {
    if (saveManager && autoSaveInterval > 0 && !autoSaveTimer) {
      autoSaveTimer = timers.setInterval(() => performSave(), autoSaveInterval);
    }
  }
  // Every subscription and effect made on the engine's behalf, released by dispose().
  const cleanups: (() => void)[] = [];
  const moduleScope = effectScope(true);
  // Populated at start() with the per-engine injection map built from
  // install() / connect() `provide()` calls. Exposed via engine.tryInject
  // for external introspection tools.
  let publicInjections: Map<symbol, unknown> | undefined;

  // The hooks ride the save manager's own events so every entry point runs
  // them — consumers wire the manager's import/export/save/load to their UI.
  if (saveManager) {
    cleanups.push(
      saveManager.on('save:before-serialize', () =>
        withPersistenceNamespace(config.persistenceNamespace, () => {
          for (const cb of saveCallbacks) cb();
        }),
      ),
      saveManager.on('save:loaded', ({ timestamp }) =>
        withPersistenceNamespace(config.persistenceNamespace, () => {
          for (const cb of loadCallbacks) cb({ success: true, timestamp });
        }),
      ),
    );
  }

  function track(unsub: () => void): () => void {
    cleanups.push(unsub);
    return unsub;
  }

  function performSave(): void {
    withPersistenceNamespace(config.persistenceNamespace, () => saveManager?.save());
  }

  function performLoad(): SaveLoadResult {
    return withPersistenceNamespace(
      config.persistenceNamespace,
      () => saveManager?.load() ?? { success: false },
    );
  }

  function topologicalSort(mods: EngineModule[]): EngineModule[] {
    const sorted: EngineModule[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const modMap = new Map<string, EngineModule>();
    for (const m of mods) {
      const seen = modMap.get(m.id);
      if (seen && seen !== m) throw new Error(`Two different modules share the id "${m.id}"`);
      modMap.set(m.id, m);
    }

    function visit(mod: EngineModule): void {
      if (visited.has(mod.id)) return;
      if (visiting.has(mod.id)) throw new Error(`Circular dependency detected: ${mod.id}`);
      visiting.add(mod.id);
      for (const dep of mod.dependencies ?? []) {
        const depMod = modMap.get(dep);
        if (!depMod)
          throw new Error(`Module "${mod.id}" depends on "${dep}" which is not registered`);
        visit(depMod);
      }
      visiting.delete(mod.id);
      visited.add(mod.id);
      sorted.push(mod);
    }

    for (const mod of mods) visit(mod);
    return sorted;
  }

  const engine: Engine = {
    tickDriver,
    saveManager,
    save() {
      performSave();
    },
    load() {
      // Before start() no persistent ref exists to hydrate, so the load would
      // report success, change nothing, and let the next save overwrite it.
      if (disposed) throw new Error('Cannot load into a disposed engine');
      if (!installed) throw new Error('Call start() before load(): modules must install first');
      return performLoad();
    },
    use(module) {
      if (installed) throw new Error(`Cannot use("${module.id}") after start()`);
      modules.push(module);
      return engine;
    },
    start() {
      if (disposed) throw new Error('Cannot start a disposed engine');
      if (!installed) {
        const sorted = topologicalSort(modules);
        const injections = new Map<symbol, unknown>();
        publicInjections = injections;
        const eventBus = createEmitHandle<EngineEvents>();

        const sharedContext: EngineContext = {
          onTick: (cb) => track(tickDriver.onTick(cb)),
          onSave: (cb) => saveCallbacks.push(cb),
          onLoad: (cb) => loadCallbacks.push(cb),
          on: (event, handler) => track(eventBus.on(event, handler)),
          emit: (event, ...args) => eventBus.emit(event, ...args),
          provide<T>(key: InjectionKey<T>, value: T) {
            injections.set(key, value);
          },
          inject<T>(key: InjectionKey<T>): T {
            if (!injections.has(key)) {
              throw new Error(`No provider found for injection key: ${key.toString()}`);
            }
            return injections.get(key) as T;
          },
          tryInject<T>(key: InjectionKey<T>): T | undefined {
            return injections.get(key) as T | undefined;
          },
        };

        // Per-engine chain registry — auto-populated by createModifierChain
        // calls that run inside install()/connect() via the ambient set below.
        const chainRegistry = createChainRegistry();
        // Per-engine effect-system registry — auto-populated by
        // createTemporaryEffectSystem / createPersistentEffectSystem calls
        // via the ambient set below. Parallel to chainRegistry.
        const effectSystemRegistry = createEffectSystemRegistry();
        // Per-engine resource registry — auto-populated by createResource
        // calls via the ambient set below. Replaces the former process-wide
        // global registry so per-run / scratch engines never cross-
        // contaminate each other's resource discovery.
        const resourceRegistry = createResourceRegistry();
        // Per-engine categories accumulator — auto-populated by the five
        // category factories (createProducerCategory etc.) via the ambient
        // set below. Pre-provided under CategoriesKey so harness tooling
        // and external consumers get the inventory without any
        // archetype-side publication step.
        const engineCategories: EngineCategories = {};
        // Per-engine tuning-registries set — auto-populated by
        // createTuningRegistry calls via the ambient below. Picker's
        // walkTunables reads this set to enumerate the designer-flagged
        // tuning surface.
        const tuningRegistries = new Set<TuningRegistry>();

        // Pre-provide engine services before any module installs
        sharedContext.provide(TickDriverKey, tickDriver);
        if (saveManager) sharedContext.provide(SaveManagerKey, saveManager);
        sharedContext.provide(ChainRegistryKey, chainRegistry);
        sharedContext.provide(EffectSystemRegistryKey, effectSystemRegistry);
        sharedContext.provide(ResourceRegistryKey, resourceRegistry);
        sharedContext.provide(CategoriesKey, engineCategories);
        sharedContext.provide(TuningRegistriesKey, tuningRegistries);

        // All install/connect work runs under the configured namespace so
        // module ids don't collide across engines sharing a runtime, and
        // under the engine's chain / effect-system / resource / categories
        // ambient targets so every primitive call auto-registers into this
        // engine's registries specifically.
        // The effect scope owns every watcher and computed a module creates,
        // so dispose() can stop them even when they watch state outliving
        // the engine.
        moduleScope.run(() =>
          withChainRegistry(chainRegistry, () =>
            withEffectSystemRegistry(effectSystemRegistry, () =>
              withResourceRegistry(resourceRegistry, () =>
                withEngineCategories(engineCategories, () =>
                  withTuningRegistries(tuningRegistries, () =>
                    withGameStateAccessor(config.accessor, () =>
                      withPersistenceNamespace(config.persistenceNamespace, () => {
                        for (const mod of sorted) {
                          withPersistentContext(mod.id, () => mod.install(sharedContext));
                        }
                        // Connect phase: all modules installed, now wire cross-module refs
                        for (const mod of sorted) {
                          if (mod.connect) {
                            withPersistentContext(mod.id, () => mod.connect!(sharedContext));
                          }
                        }
                      }),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );

        installed = true;
      }

      tickDriver.start();
      startAutoSaveTimer();
    },
    stop() {
      tickDriver.stop();
      stopAutoSaveTimer();
    },
    dispose() {
      if (disposed) return;
      engine.stop();
      moduleScope.stop();
      for (const unsub of cleanups.splice(0)) unsub();
      // Drop the in-memory persistent-context registry for this engine's
      // namespace so a fresh engine can install the same module set without
      // colliding on persistent-ref names. Save storage is untouched.
      clearPersistentNamespace(config.persistenceNamespace);
      disposed = true;
    },

    get registeredModules() {
      return modules;
    },

    tryInject<T>(key: InjectionKey<T>): T | undefined {
      return publicInjections?.get(key) as T | undefined;
    },

    // === MOD SUPPORT ===
    mods: registeredMods,

    get activeModId() {
      return selectedModId;
    },

    selectMod(modId: string) {
      const mod = registeredMods.find((m) => m.id === modId);
      if (!mod) throw new Error(`Unknown mod id: "${modId}"`);
      if (installed) throw new Error('Cannot select mod after start()');
      if (selectedModId) throw new Error(`Mod already selected: "${selectedModId}"`);
      selectedModId = modId;
      for (const m of mod.modules) modules.push(m);
      if (saveManager) saveManager.modId = modId;
    },

    peekSave(): SavePeek | null {
      return saveManager?.peek() ?? null;
    },

    get autoSaveInterval(): number {
      return autoSaveInterval;
    },
    set autoSaveInterval(value: number) {
      autoSaveInterval = value;
      // Re-arm the timer: stop the old (if any), start the new (if running
      // and value > 0). Mirrors tickDriver.tickRate's restart-when-running shape.
      const wasRunning = autoSaveTimer !== null;
      stopAutoSaveTimer();
      if (wasRunning || (installed && tickDriver.running)) {
        startAutoSaveTimer();
      }
    },
  };
  return engine;
}
