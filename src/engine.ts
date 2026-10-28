/**
 * Engine assembly — the module-system façade that composes core + systems into
 * a runnable game: {@link createEngine}, {@link EngineContext},
 * {@link EngineModule}, {@link EngineOptions}, and the built-in injection keys.
 *
 * It is its own file, not part of the root barrel, so the balance harness can
 * import `createEngine` without an import back through `@/index`. That barrel
 * re-exports `./harness`, so such an import would close an import cycle at
 * runtime. This file imports only from lower source layers (primitives, core,
 * systems), never from the harness.
 *
 * @cluster engine
 */

// === MODULE SYSTEM ===

import { effectScope } from 'vue';
import { createTickDriver, type TickHandler } from './core/tick-driver';
import { createSaveManager } from './core/save-manager';
import {
  withPersistentContext,
  withPersistenceNamespace,
  deletePersistenceNamespace,
  hasLivePersistentRefs,
} from './core/persistence';
import { isDev } from './primitives/dev';
import { createEmitHandle } from './core/events';
import {
  ChainRegistryKey,
  EffectSystemRegistryKey,
  FlagRegistryKey,
  ResourceRegistryKey,
  createChainRegistry,
  createEffectSystemRegistry,
  createFlagRegistry,
  createResourceRegistry,
  withChainRegistry,
  withEffectSystemRegistry,
  withFlagRegistry,
  withResourceRegistry,
} from './core/registries';
import {
  TuningRegistriesKey,
  withTuningRegistries,
  type TuningRegistry,
} from './core/override-registry';
import {
  GameStateAccessorKey,
  withGameStateAccessor,
  type AccessorServices,
  type GameStateAccessorMutator,
} from './core/game-state-accessor';
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

export type { TickHandler } from './core/tick-driver';
/**
 * A handler called before live state is serialized, so it can write derived
 * state into persistent refs. `engine.save()`, the autosave, and the save
 * manager's `save`, `saveToSlot` and `exportSave` call it.
 */
export type SaveHandler = () => void;
/**
 * A handler called after a save loads successfully, by any entry point. The
 * entry points are `engine.load()`, the save manager's `load` or `importSave`,
 * and a balance-harness engine loaded from a save. It receives the `SaveLoadResult`
 * (always `success: true`, with the save's timestamp), not the decoded save data.
 *
 * Every `onLoad` runs before the engine's own hydration: a challenge's scoped
 * overrides, a latched achievement or automation tier, a loadout's selection.
 * So a watcher of hydration's writes sees the state `onLoad` rebuilt. A reset
 * runs hydration and no `onLoad`.
 */
export type LoadHandler = (result: SaveLoadResult) => void;

// `InjectionKey<T>` is in `./primitives/types` so the systems and harness
// subpaths can import it without an import back through the root file.
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

// `EngineCategories` and `CategoriesKey` are beside the category factories
// in `./systems/engine-categories` and reach the API surface through the
// systems barrel. Imported at the top of this file for the `createEngine`
// self-publish wiring.

/**
 * The engine context: the object each {@link EngineModule}'s `install` and
 * `connect` receive. It registers tick, save and load handlers, and it
 * subscribes to and emits engine-wide events. Its {@link provide} /
 * {@link inject} pair lets modules share APIs.
 */
export interface EngineContext {
  /** Register a handler called every tick with its dt in seconds. */
  onTick(handler: TickHandler): () => void;
  /** Register a handler called before live state is serialized; see {@link SaveHandler}. */
  onSave(callback: SaveHandler): void;
  /** Register a handler called after a save loads, by any entry point; see {@link LoadHandler}. */
  onLoad(callback: LoadHandler): void;

  /**
   * Subscribe to an engine-wide event. Returns an unsubscribe function.
   *
   * `engine.dispose()` unsubscribes every subscription made during
   * `install()` / `connect()`.
   *
   * @example
   * ```ts
   * engine.on('playerDied', () => { showReincarnation(); });
   * ```
   */
  on<K extends keyof EngineEvents>(event: K, handler: EngineEvents[K]): () => void;

  /**
   * Emit an engine-wide event, calling every handler subscribed to it.
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
   * Throws on a key the engine provides itself: the registry and service
   * `*Key` exports, such as {@link TickDriverKey}.
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
   * Use it for wiring that needs every module's APIs. Examples are handlers
   * that break a dependency cycle, set-up that reads another module, and
   * subscriptions across modules. Called in the same topological order as install(), with the full
   * EngineContext.
   */
  connect?(engine: EngineContext): void;
}

/**
 * A mod: a whole-game ruleset the player selects when a new game starts, with
 * its metadata and its modules.
 *
 * A save has at most one active mod. `selectMod()` adds the mod's full module
 * list to the modules `start()` installs, beside the modules `use()` added.
 */
export interface ModDef {
  /** The id stored in the save */
  id: string;
  /** Display name in the UI that selects a mod */
  displayName: string;
  /** Optional description shown in the UI that selects a mod */
  description?: string;
  /** Highlight this mod in that UI (e.g., "Recommended") */
  recommended?: boolean;
  /**
   * The full module set installed while this mod is active. It holds every
   * module the game needs under this mod: shared modules, game content and the
   * mod's own modules. It is never an add-on delta over an implicit base game.
   */
  modules: EngineModule[];
}

/**
 * Options for {@link createEngine}. `gameId` is required. The other options
 * set the interval rate and tick mode, saving, mods and the persistence namespace.
 */
export interface EngineOptions {
  gameId: string;
  intervalRate?: number;
  maxDeltaTime?: number;
  /** Initial game speed (default 1). It scales dt in live play. */
  speedMultiplier?: number;
  /**
   * Tick mode. `'variable'` (default) runs one tick per interval, with the raw dt
   * capped and scaled by game speed. `'fixed'` accumulates that dt and runs ticks
   * of `fixedDt` from it, for faithful ports of tick math that clamps on overshoot.
   * See `createTickDriver` for details.
   */
  tickMode?: 'variable' | 'fixed';
  /** The dt of every fixed-mode tick. Defaults to `1 / intervalRate`. */
  fixedDt?: number;
  /**
   * Cap on the fixed-mode ticks one interval runs (default 100). It protects
   * live play from overflow.
   */
  maxTicksPerInterval?: number;
  /** Called when a fixed-mode interval discards ticks. */
  onTicksOverflow?: (droppedTicks: number) => void;
  /**
   * Called when a variable-mode interval's raw dt exceeds `maxDeltaTime`. It
   * receives the discarded seconds, so they can be deposited in a time bank.
   */
  onDeltaOverflow?: (droppedSeconds: number) => void;
  /**
   * Custom timer functions for scheduling the TickDriver and autosave.
   * Pass `worker-timers` functions for background-tab immunity.
   * Defaults to native setInterval/clearInterval.
   */
  timerProvider?: TimerProvider;
  /**
   * Interval in ms between autosaves; 0 disables autosave. Default 30000 when
   * persistence is on. The autosave writes the save manager's active slot,
   * whichever that is, and holds until a load has run, so it never writes
   * defaults over a save a later `load()` would read.
   */
  autoSaveInterval?: number;
  /** Set to false to skip save manager creation. Default true. */
  persistence?: boolean;
  /** The save version: the consumer's save-format number. Passed to the save manager. */
  saveVersion?: number;
  /** Save migrations keyed by the save version they migrate from. Passed to the save manager. */
  saveMigrations?: Record<number, SaveMigration>;
  /** Custom storage backend. Defaults to localStorage. */
  storageAdapter?: StorageAdapter;
  /** Maximum number of save slots. Default: 10 */
  maxSaveSlots?: number;
  /**
   * When true, any save validation failure aborts the load with
   * `save:load-failed { reason: 'validation' }`. When false, each failing leaf
   * takes its ref default and the load proceeds. `save:validation-failed` is
   * emitted per field in both modes.
   *
   * Defaults to dev-mode detection in the underlying save manager: fail loudly
   * in development (so bugs appear early), self-heal in production (so player
   * saves stay protected).
   */
  strictValidation?: boolean;
  /**
   * Available game mods. One may be selected with `selectMod()` before
   * `start()`. An unselected mod installs nothing.
   */
  mods?: ModDef[];
  /**
   * Keep this engine instance's persistent refs apart from any other engine in
   * the same runtime. When set, the persistence namespace prefixes every module
   * and category persistent context. The save manager then walks only this
   * persistence namespace. Storage keys contain it too, so two engines with the
   * same `gameId` never share a save.
   *
   * Leave it undefined for a single-engine app; its saves then have no
   * persistence namespace prefix. A second live engine in the same persistence
   * namespace throws at `createEngine`.
   *
   * The main use is scratch engines: for balance workbenches, override
   * comparisons and A/B predictive displays.
   */
  persistenceNamespace?: string;
  /**
   * The game-state accessor and mutator: an object, or a factory the engine
   * calls once at `start()`, before any module installs, with the engine's
   * services. Pass `(services) => createGameStateAccessor(services, { … })` to
   * build one over this engine's resource and flag registries. Category factories
   * (`createChallengeCategory`, etc.) read it as an ambient value when a
   * category has no `accessor` option. After `start()`, read it with
   * `engine.tryInject(GameStateAccessorKey)`. Its methods are called only
   * during play, not during install/connect.
   */
  accessor?: GameStateAccessorMutator | ((services: AccessorServices) => GameStateAccessorMutator);
}

/**
 * The assembled engine instance returned by {@link createEngine}. Modules are
 * registered via `use()`, and the game runs between `start()` and `stop()`.
 * `dispose()` deletes this engine's persistent contexts, so a new engine
 * instance can reuse the same module ids in the same page lifetime.
 */
export interface Engine {
  /**
   * Register a module for `start()` to install.
   * @throws After `start()`, which installs the module set once.
   */
  use(module: EngineModule): Engine;
  /**
   * Install registered modules and begin ticking. Does not load a save —
   * call `load()` explicitly after `start()` (modules must install first, so
   * their persistent refs exist for the load to write).
   * @throws On a disposed engine, a circular or missing dependency, or two
   *   different module objects registered under one id. A module's
   *   `install()` or `connect()` throwing disposes the engine, then rethrows.
   */
  start(): void;
  stop(): void;
  /**
   * Dispose of the engine. Stop the TickDriver and every watcher and computed
   * that modules created during `install()` / `connect()`. Remove their tick
   * handlers, event subscriptions, and save and load handlers. Delete every
   * persistent context this engine registered under its `persistenceNamespace`.
   * It is safe to pass unbound, as in `onUnmounted(engine.dispose)`. Call it
   * before a new engine with the same module ids is built in the same page
   * lifetime. One case is a UI that remounts a game. Save storage (keyed by
   * `gameId`, plus `persistenceNamespace` when set) stays as it is, so a later
   * engine loads the same stored save.
   *
   * After dispose, `start()` throws. Discard the instance, and call
   * `createEngine()` for a new one.
   */
  dispose(): void;
  /** Save live state to the active slot. Every onSave handler runs first. */
  save(): void;
  /**
   * Load the active slot. Every onLoad handler runs after the load.
   * @throws Before `start()` (no module has created its refs yet) or after `dispose()`.
   */
  load(): SaveLoadResult;
  readonly tickDriver: TickDriver;
  readonly saveManager: SaveManager | undefined;
  /**
   * The module set registered via `use()` plus any mod modules appended by
   * `selectMod()`. A helper that builds a scratch engine, for a balance
   * workbench say, reads it. So it can build a second engine with the same
   * modules without tracking the list itself.
   */
  readonly registeredModules: readonly EngineModule[];
  /**
   * Read a value published by a module via `ctx.provide(key, value)`
   * during its `install()` / `connect()` phase. Returns `undefined` when
   * the key has not been provided or when called before `start()`.
   *
   * Introspection tools outside the engine (the picker, devtools, balance
   * workbenches) read opt-in injection keys with it, such as
   * {@link CategoriesKey}, {@link ChainRegistryKey},
   * {@link EffectSystemRegistryKey} and {@link GameStateAccessorKey}. They need no module installed only to
   * capture them.
   */
  tryInject<T>(key: InjectionKey<T>): T | undefined;

  // === MOD SUPPORT ===
  /** The registered mods (from the `mods` option) */
  readonly mods: readonly ModDef[];
  /** The selected mod's id, or null if no mod is selected */
  readonly activeModId: string | null;
  /**
   * Select a mod before calling start(). It adds every module in the mod's
   * `modules` list to the modules `start()` installs, as if `use()` had been
   * called on each. It also tags the active save with the mod id. Call it
   * before `start()`, and at most once per engine instance.
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
   * {@link EngineOptions.autoSaveInterval}, but can be set while the game
   * runs. Setting it re-arms the autosave timer with the new period, or
   * stops it when set to 0. No effect when `persistence: false` was passed to
   * {@link createEngine}. Symmetric to `engine.tickDriver.intervalRate`.
   */
  autoSaveInterval: number;
}

/** Autosave period in ms when persistence is on and `autoSaveInterval` is omitted. */
const DEFAULT_AUTO_SAVE_INTERVAL = 30_000;

/** The TickDriver's persistent context id, a stable save key inside each persistence namespace. */
const TICK_DRIVER_CONTEXT_ID = 'tick-driver';

/**
 * Throw when a live engine already holds the active persistence namespace.
 * The TickDriver is the first persistent context an engine opens, so its
 * live refs mark the persistence namespace as taken.
 */
function assertPersistenceNamespaceFree(options: EngineOptions): void {
  if (!hasLivePersistentRefs(TICK_DRIVER_CONTEXT_ID)) return;
  const where =
    options.persistenceNamespace === undefined
      ? 'the unnamespaced persistent contexts'
      : `persistence namespace "${options.persistenceNamespace}"`;
  throw new Error(
    `[engine] createEngine("${options.gameId}"): another live engine already uses ${where}. ` +
      'Give each engine its own `persistenceNamespace`, or call `dispose()` on the first engine before creating this one.',
  );
}

/**
 * Creates the top-level engine orchestrator that wires together the TickDriver,
 * save manager, module system, and mod support.
 *
 * @param options - Engine options: the game id, TickDriver options, persistence options,
 *   and the available mods
 * @returns An engine instance that accepts modules via `use()`, then `start()` to begin
 *   ticking. Exposes the TickDriver, save manager, and mod selection. With persistence
 *   on (the default) the game autosaves every 30 s once a `load()` has run.
 * @throws When another live engine uses the same persistence namespace. Give each
 *   engine its own `persistenceNamespace`, or `dispose()` the first one.
 *
 * @example
 * ```ts
 * const engine = createEngine({ gameId: 'my-game', intervalRate: 20 });
 * engine.use(resourceModule);
 * engine.use(combatModule);
 * engine.start(); // installs modules, so their persistent refs exist
 * engine.load(); // loads the save into them; a first launch reports `not-found`
 * ```
 */
export function createEngine(options: EngineOptions): Engine {
  const modules: EngineModule[] = [];
  const saveCallbacks: SaveHandler[] = [];
  const loadCallbacks: LoadHandler[] = [];
  const registeredMods: ModDef[] = [...(options.mods ?? [])];
  let selectedModId: string | null = null;

  const timers = options.timerProvider ?? {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };

  // Created inside the engine's persistence namespace under a stable
  // persistent context id, so the fixed-mode accumulator is part of this
  // engine's save, restores deterministically across play sessions, and is
  // deleted by `dispose()`'s `deletePersistenceNamespace`. Outside the
  // persistence namespace it would be in the default one, which this engine's
  // save excludes.
  const tickDriver = withPersistenceNamespace(options.persistenceNamespace, () => {
    assertPersistenceNamespaceFree(options);
    return createTickDriver({
      intervalRate: options.intervalRate,
      maxDeltaTime: options.maxDeltaTime,
      speedMultiplier: options.speedMultiplier,
      tickMode: options.tickMode,
      fixedDt: options.fixedDt,
      maxTicksPerInterval: options.maxTicksPerInterval,
      onTicksOverflow: options.onTicksOverflow,
      onDeltaOverflow: options.onDeltaOverflow,
      timerProvider: options.timerProvider,
      persistentContextId: TICK_DRIVER_CONTEXT_ID,
    });
  });
  const saveManager =
    options.persistence !== false
      ? createSaveManager({
          gameId: options.gameId,
          saveVersion: options.saveVersion,
          migrations: options.saveMigrations,
          storageAdapter: options.storageAdapter,
          maxSlots: options.maxSaveSlots,
          persistenceNamespace: options.persistenceNamespace,
          strictValidation: options.strictValidation,
        })
      : undefined;

  let autoSaveTimer: number | null = null;
  // Autosave holds until a load has run: before it, live state is defaults,
  // and writing them would overwrite the save a later load() would read.
  let loadRan = false;
  let autoSaveInterval = options.autoSaveInterval ?? (saveManager ? DEFAULT_AUTO_SAVE_INTERVAL : 0);
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
      autoSaveTimer = timers.setInterval(() => {
        if (loadRan) saveManager.save();
      }, autoSaveInterval);
    }
  }
  // The unsubscribe of every subscription made on the engine's behalf; dispose() runs them.
  const cleanups = new Set<() => void>();
  const moduleScope = effectScope(true);
  // Populated at start() with the per-engine injection map built from
  // install() / connect() `provide()` calls. Exposed via engine.tryInject
  // for external introspection tools.
  let publicInjections: Map<symbol, unknown> | undefined;

  // The save and load handlers run on the save manager's own events, so every
  // entry point runs them — consumers wire the manager's import/export/save/load
  // to their UI. The manager emits them inside the engine's persistence namespace.
  if (saveManager) {
    track(
      saveManager.on('save:before-serialize', () => {
        for (const cb of saveCallbacks) cb();
      }),
    );
    track(
      saveManager.on('save:loaded', ({ timestamp }) => {
        loadRan = true;
        for (const cb of loadCallbacks) cb({ success: true, timestamp });
      }),
    );
    track(
      saveManager.on('save:load-failed', () => {
        loadRan = true;
      }),
    );
    const offFirstTick = track(
      tickDriver.onTick(() => {
        offFirstTick();
        if (!loadRan && autoSaveInterval > 0 && isDev()) {
          console.warn(
            `[engine] "${options.gameId}" ticked before load(): call engine.load() after start() ` +
              '(a first launch reports not-found). Autosave holds until a load has run.',
          );
        }
      }),
    );
  }

  /** Keep `unsub` for dispose(); the returned unsubscribe also removes it from that set. */
  function track(unsub: () => void): () => void {
    const off = () => {
      cleanups.delete(off);
      unsub();
    };
    cleanups.add(off);
    return off;
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
      saveManager?.save();
    },
    load() {
      // Before start() no persistent ref exists for the load to write, so it
      // would report success, change nothing, and let the next save overwrite it.
      if (disposed) throw new Error('Cannot load into a disposed engine');
      if (!installed) throw new Error('Call start() before load(): modules must install first');
      return saveManager?.load() ?? { success: false };
    },
    use(module) {
      if (installed) throw new Error(`Cannot use("${module.id}") after start()`);
      modules.push(module);
      return engine;
    },
    start() {
      if (disposed) throw new Error('Cannot start a disposed engine');
      if (!installed) {
        if (
          registeredMods.length > 0 &&
          selectedModId === null &&
          modules.length === 0 &&
          isDev()
        ) {
          console.warn(
            `[engine] "${options.gameId}" started with no module: mods are registered, but an ` +
              'unselected mod installs nothing. Call engine.selectMod() before start().',
          );
        }
        const sorted = topologicalSort(modules);
        const injections = new Map<symbol, unknown>();
        publicInjections = injections;
        const eventBus = createEmitHandle<EngineEvents>();

        // Per-engine chain registry — auto-populated by createModifierChain
        // calls that run inside install()/connect() via the ambient set below.
        const chainRegistry = createChainRegistry();
        // Per-engine effect-system registry — auto-populated by
        // createTemporaryEffectSystem / createConditionalEffectSystem calls
        // via the ambient set below. Parallel to chainRegistry.
        const effectSystemRegistry = createEffectSystemRegistry();
        // Per-engine resource registry — auto-populated by createResource
        // calls via the ambient set below. Per-engine, so scratch engines never
        // see each other's resources.
        const resourceRegistry = createResourceRegistry();
        // Per-engine flag registry — auto-populated by createFlag calls via
        // the ambient set below.
        const flagRegistry = createFlagRegistry();
        // Built here, so a factory accessor reads this engine's registries and
        // no other. Its reads are lazy, so the registries may still be empty.
        const accessor =
          typeof options.accessor === 'function'
            ? options.accessor({ resourceRegistry, flagRegistry })
            : options.accessor;
        // Per-engine categories collection — auto-populated by the
        // category factories (createProducerCategory etc.) via the ambient
        // set below. Pre-provided under CategoriesKey so balance-harness tooling
        // and external consumers get the full category list without a publish
        // step in any module.
        const engineCategories: EngineCategories = {};
        // Per-engine tuning-registries set — auto-populated by
        // createTuningRegistry calls via the ambient set below. The picker's
        // walkTunables reads this set to list every tunable.
        const tuningRegistries = new Set<TuningRegistry>();

        // Engine services, pre-provided before any module installs. The engine
        // fills them as modules install, so a module's provide would detach
        // tooling from what the engine tracks: `provide` refuses these keys.
        // SaveManagerKey stays listed when persistence is off: its absence is
        // how a reader tells persistence is off.
        const engineServices = new Map<symbol, unknown>([
          [TickDriverKey, tickDriver],
          [SaveManagerKey, saveManager],
          [ChainRegistryKey, chainRegistry],
          [EffectSystemRegistryKey, effectSystemRegistry],
          [ResourceRegistryKey, resourceRegistry],
          [FlagRegistryKey, flagRegistry],
          [GameStateAccessorKey, accessor],
          [CategoriesKey, engineCategories],
          [TuningRegistriesKey, tuningRegistries],
        ]);
        for (const [key, service] of engineServices) {
          if (service !== undefined) injections.set(key, service);
        }

        const sharedContext: EngineContext = {
          onTick: (cb) => track(tickDriver.onTick(cb)),
          onSave: (cb) => saveCallbacks.push(cb),
          onLoad: (cb) => loadCallbacks.push(cb),
          on: (event, handler) => track(eventBus.on(event, handler)),
          emit: (event, ...args) => eventBus.emit(event, ...args),
          provide<T>(key: InjectionKey<T>, value: T) {
            if (engineServices.has(key)) {
              throw new Error(
                `ctx.provide(${key.toString()}) targets an engine-owned key; the engine provides it and fills it as modules install.`,
              );
            }
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

        // All install/connect work runs under the configured persistence
        // namespace, so module ids don't collide across engines sharing a
        // runtime. It also runs under the engine's chain / effect-system /
        // resource / categories ambient values, so every primitive call
        // registers into this engine's registries.
        // The Vue effect scope owns every watcher and computed a module creates,
        // so dispose() can stop them even when they watch state outliving
        // the engine.
        try {
          moduleScope.run(() =>
            withChainRegistry(chainRegistry, () =>
              withEffectSystemRegistry(effectSystemRegistry, () =>
                withResourceRegistry(resourceRegistry, () =>
                  withFlagRegistry(flagRegistry, () =>
                    withEngineCategories(engineCategories, () =>
                      withTuningRegistries(tuningRegistries, () =>
                        withGameStateAccessor(accessor, () =>
                          withPersistenceNamespace(options.persistenceNamespace, () => {
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
            ),
          );
        } catch (err) {
          // A half-installed engine can neither start again nor be reached by
          // a caller whose reference the throw unwound, so delete its
          // persistent contexts here — else the next engine collides on them.
          engine.dispose();
          throw err;
        }

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
      for (const unsub of [...cleanups]) unsub();
      // Delete this engine's persistence namespace from the persistent-ref
      // registry, so a new engine can install the same module set without
      // colliding on persistent-ref names. Save storage is untouched.
      deletePersistenceNamespace(options.persistenceNamespace);
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
      // and value > 0). Mirrors tickDriver.intervalRate's restart-when-running shape.
      const wasRunning = autoSaveTimer !== null;
      stopAutoSaveTimer();
      if (wasRunning || (installed && tickDriver.running)) {
        startAutoSaveTimer();
      }
    },
  };
  return engine;
}
