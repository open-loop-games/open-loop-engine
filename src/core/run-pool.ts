/**
 * RunPool — core primitive for managing a collection of opaque, addressable
 * pool runs with independent lifecycle state.
 *
 * A run pool holds N pool runs, each with a stable `id`, a reactive `alive`
 * flag, and an opaque `step()` method. The run pool does not drive ticks —
 * consumers call `handle.step()` on their own cadence (per-run interval,
 * shared game loop, batch catch-up, etc.). When a step returns false, the run
 * pool applies its `deathDisposition` (or the pool run's `onDeath` override)
 * and emits lifecycle events:
 *
 * - `'destroyed'` — the handle leaves the run pool (the `'destroy'` disposition).
 * - `'parked'` — the handle stays with `alive=false` until `handle.restart()`
 *   or `pool.reset()` (the `'park'` disposition).
 * - `{ restartedWith: step }` — swaps the step in place; alive stays true
 *   (in-flight auto-restart).
 *
 * The run pool saves its per-id aliveness map in the persistent context
 * `${poolId}`, but not which ids exist. Step closures can't be saved, so the
 * game keeps its own record of its pool runs and adds them again after a load
 * with `addRun`. `addRun` reads the saved map, so a pool run that died stays
 * dead across save and load, whenever it is added again.
 * The map is tagged `lifetime`, so a reset leaves it alone unless the reset
 * names it. The in-memory handles are the authority, and `pool.reset()` is
 * the reset path.
 */

import { computed, effectScope, ref, shallowRef, watch, type Ref } from 'vue';
import { runInEffectScope } from './common';
import { createEmitHandle, type Emittable } from './events';
import { disownPersistent, onHydrated, persistent, withPersistentContext } from './persistence';
import { attachPersistentContextReset } from './resettable';

// === TYPES ===
/**
 * One step of a pool run. Returns `true` if the pool run is still alive after
 * the step, `false` if it died. The run pool interprets the return value, so
 * the step function never needs to know the death disposition.
 */
export type RunStep = () => boolean;

/**
 * Outcome of a pool run's death, returned synchronously from its `onDeath`
 * option callback. Without one, the run pool applies its `deathDisposition`
 * (`'destroy'` → `'destroyed'`; `'park'` → `'parked'`).
 */
export type RunDeathOutcome = 'destroyed' | 'parked' | { readonly restartedWith: RunStep };

/**
 * Opaque handle to one pool run. Handles keep their identity across run pool
 * operations; consumers may store the reference.
 */
export interface RunHandle<Id = string> {
  readonly id: Id;
  /**
   * Reactive aliveness flag. A watcher mirrors it into the run pool's saved
   * `aliveStates` map, and a load sets it again from that map. So the value
   * round-trips through save and load, whenever this handle was created.
   * Set to `false` on a `'destroyed'` or `'parked'` outcome; stays `true`
   * through a `restartedWith` outcome.
   */
  readonly alive: Ref<boolean>;
  /**
   * Call one step of this pool run. On a `false` return, the run pool
   * resolves the death outcome and emits its events before `step()` returns.
   * A silent no-op that returns `false` on a parked or destroyed handle.
   */
  step(): boolean;
  /**
   * Re-arm a parked handle with a new step function. No-op if the handle
   * is alive or already destroyed. Emits `run:restarted`.
   */
  restart(nextStep: RunStep): void;
  /**
   * Force-destroy this handle. Emits `run:died` with outcome `'destroyed'`,
   * then `run:removed`. Idempotent.
   */
  destroy(): void;
}

/**
 * Registration payload for {@link RunPool.addRun}: a stable id, the `step`
 * function, and an optional `onDeath` override of the run pool's
 * `deathDisposition` for this pool run.
 */
export interface RunRegistration<Id = string> {
  readonly id: Id;
  readonly step: RunStep;
  /**
   * Optional death override for this pool run. When present, its return
   * value wins over the run pool's `deathDisposition`.
   */
  readonly onDeath?: () => RunDeathOutcome;
}

/** Events emitted during the run pool's lifecycle. Subscribe via `pool.on()`. */
export interface RunPoolEvents<Id = string> {
  'run:added': (handle: RunHandle<Id>) => void;
  'run:removed': (handle: RunHandle<Id>) => void;
  /**
   * Emitted whenever a pool run's step returns false. The handle's `alive`
   * already holds the post-death value (or stays `true` for `restartedWith`).
   * For `'destroyed'`, the handle is still in `runs.value` during this
   * event; `run:removed` follows.
   */
  'run:died': (handle: RunHandle<Id>, outcome: RunDeathOutcome) => void;
  /**
   * Emitted when a parked handle was re-armed via `handle.restart()`, or a
   * just-died handle was replaced via `{ restartedWith }`.
   */
  'run:restarted': (handle: RunHandle<Id>) => void;
  /**
   * Emitted on `pool.reset()`. Consumers handle it with the game-side reset
   * (re-arm parked handles, reset zones, etc.). The run pool does not change
   * aliveness itself; the handler does.
   */
  'pool:reset': () => void;
}

/**
 * Options for {@link createRunPool}. `deathDisposition` picks the post-death
 * disposition (`'destroy'` or `'park'`); the optional `capacity` is the most
 * pool runs it holds at once.
 */
export interface RunPoolOptions {
  /** Unique id; the run pool's persistent context id. */
  readonly id: string;
  /**
   * Pool-wide default applied when a pool run has no `onDeath`:
   *
   * - `'destroy'` — the handle is removed from the run pool (the pool run is gone).
   * - `'park'` — the handle stays with `alive=false` (the pool run can be restarted).
   */
  readonly deathDisposition: 'destroy' | 'park';
  /**
   * Optional capacity: the most pool runs held at once. `addRun` throws past
   * it. Default: unlimited. `0` is a valid empty capacity (always throws),
   * not "unlimited".
   */
  readonly capacity?: number;
}

/**
 * A run pool: concurrent pool runs, such as spawned clones, that share one
 * death disposition, each with its own step closure. Created by
 * {@link createRunPool}; emits lifecycle events for add, remove, death,
 * restart and reset.
 */
export interface RunPool<Id = string> extends Emittable<RunPoolEvents<Id>> {
  readonly id: string;
  readonly deathDisposition: 'destroy' | 'park';
  /**
   * Read-only view of all registered handles in insertion order. Array
   * identity changes on add/remove; stable between no-op reads.
   */
  readonly runs: { readonly value: readonly RunHandle<Id>[] };
  /** Reactive count of handles with `alive.value === true`. */
  readonly liveCount: Readonly<Ref<number>>;
  /**
   * Register a new pool run. Throws on an id collision or past `capacity`.
   * Emits `run:added`.
   */
  addRun(registration: RunRegistration<Id>): RunHandle<Id>;
  /** Look up by id. Returns `undefined` for an unknown id. */
  getRun(id: Id): RunHandle<Id> | undefined;
  /** Force-destroy by id. No-op if unknown. Equivalent to `handle.destroy()`. */
  removeRun(id: Id): void;
  /**
   * Atomic pool-wide reset. Emits `pool:reset`; consumers re-arm handles
   * in the handler. The run pool does not change aliveness itself.
   */
  reset(): void;
  /**
   * Stop the run pool's load re-seed and every handle's aliveness mirror. The
   * saved map becomes unowned: it keeps saving, and a run pool built with the
   * same id in the same persistent context takes it over. A run pool built
   * during `install()` stops with `engine.dispose()` without this call.
   */
  dispose(): void;
}

// === FACTORY ===
/**
 * Creates a run pool: opaque pool runs with saved aliveness and lifecycle events.
 *
 * @param options - Run pool options: `id`, `deathDisposition`, and the
 *   optional `capacity`
 * @returns A run pool with `addRun`/`getRun`/`removeRun`/`reset`
 *   operations, reactive `runs` and `liveCount`, and typed event
 *   subscription
 *
 * @example
 * ```ts
 * const pool = createRunPool({ id: 'runs', deathDisposition: 'destroy' });
 *
 * const handle = pool.addRun({
 *   id: 'run-1',
 *   step: () => runner.tick(),
 *   onDeath: () => {
 *     const next = maybeAutoRestart();
 *     return next ? { restartedWith: next } : 'destroyed';
 *   },
 * });
 *
 * setInterval(() => { if (handle.alive.value) handle.step(); }, 100);
 * ```
 */
export function createRunPool<Id = string>(options: RunPoolOptions): RunPool<Id> {
  const { id: poolId, deathDisposition, capacity = Infinity } = options;

  // Pool-level persistence: the per-id aliveness map, in the run pool's own
  // persistent context so it's in the persistent-ref registry when a save
  // loads. `addRun` reads the saved `aliveStates` whenever it runs, so pool
  // runs added after a load pick up their saved alive value (no resurrection
  // of dead clones).
  const { aliveStates } = withPersistentContext(poolId, () => ({
    aliveStates: persistent<Record<string, boolean>>({}, { id: 'aliveStates', lifetime: true }),
  }));

  // In-memory collection state: `handleArray` holds insertion order, and
  // `entries` everything else about a handle in the run pool. A handle is in
  // the run pool while `entries` maps its id to its own entry; after it
  // leaves, a new handle may reuse the id.
  interface Entry {
    readonly handle: RunHandle<Id>;
    step: RunStep;
    readonly onDeath: (() => RunDeathOutcome) | undefined;
    /** Stops the handle's `aliveStates` mirror, which would otherwise outlive it. */
    readonly stop: () => void;
  }
  const handleArray: RunHandle<Id>[] = [];
  const entries = new Map<Id, Entry>();

  function entryOf(h: RunHandle<Id>): Entry | undefined {
    const entry = entries.get(h.id);
    return entry?.handle === h ? entry : undefined;
  }

  // Owns the hydration handler and every handle's mirror watch, including
  // those of handles added after install, so all of them stop with the run pool.
  const scope = effectScope();

  // A load replaces `aliveStates` wholesale: re-seed each handle still in the
  // run pool from it. A handle that has left the run pool isn't walked, so a
  // load naming its id can't bring it back. A settle that left the map object
  // in place (a reset, another engine's load) has nothing to re-seed.
  let seededFrom = aliveStates.value;
  scope.run(() =>
    onHydrated(() => {
      if (aliveStates.value === seededFrom) return;
      seededFrom = aliveStates.value;
      for (const h of handleArray) {
        const v = aliveStates.value[String(h.id)];
        if (v !== undefined && v !== h.alive.value) h.alive.value = v;
      }
    }),
  );

  // Versioned view-cache for referentially-stable `runs.value` reads.
  // The same pattern as sequencer.ts: reads return the same slice until a
  // structural mutation bumps the version, then a fresh slice is handed out
  // so Vue watchers and identity assertions trigger.
  const _liveVersion = shallowRef(0);
  let _viewCache: readonly RunHandle<Id>[] | null = null;
  let _viewVersion = 0;

  function bumpLive(): void {
    _liveVersion.value++;
  }

  function currentView(): readonly RunHandle<Id>[] {
    const version = _liveVersion.value;
    if (_viewCache !== null && _viewVersion === version) return _viewCache;
    _viewCache = handleArray.slice();
    _viewVersion = version;
    return _viewCache;
  }

  const bus = createEmitHandle<RunPoolEvents<Id>>();

  const instances = {
    get value(): readonly RunHandle<Id>[] {
      return currentView();
    },
  };

  // Reactive on: (a) collection mutations via _liveVersion, (b) per-handle
  // alive ref flips (each is a Vue ref).
  const liveCount = computed(() => {
    void _liveVersion.value;
    let n = 0;
    for (const h of handleArray) {
      if (h.alive.value) n++;
    }
    return n;
  });

  function removeFromCollection(entry: Entry): void {
    const { handle } = entry;
    entry.stop();
    entries.delete(handle.id);
    handleArray.splice(handleArray.indexOf(handle), 1);
    delete aliveStates.value[String(handle.id)];
    bumpLive();
  }

  function resolveOutcome(entry: Entry): RunDeathOutcome {
    if (entry.onDeath) return entry.onDeath();
    return deathDisposition === 'destroy' ? 'destroyed' : 'parked';
  }

  function dispatchDeath(h: RunHandle<Id>, outcome: RunDeathOutcome): void {
    const entry = entryOf(h);
    if (!entry) return; // handle was already destroyed

    if (outcome === 'destroyed') return forceDestroy(h);

    if (outcome === 'parked') {
      h.alive.value = false;
      bus.emit('run:died', h, 'parked');
      return;
    }

    // { restartedWith } — swap step in-place, alive stays true.
    entry.step = outcome.restartedWith;
    bus.emit('run:died', h, outcome);
    bus.emit('run:restarted', h);
  }

  function forceDestroy(h: RunHandle<Id>): void {
    const entry = entryOf(h);
    if (!entry) return; // idempotent
    h.alive.value = false;
    bus.emit('run:died', h, 'destroyed');
    removeFromCollection(entry);
    bus.emit('run:removed', h);
  }

  function addRun(reg: RunRegistration<Id>): RunHandle<Id> {
    if (entries.has(reg.id)) {
      throw new Error(`RunPool(${poolId}): duplicate run id ${String(reg.id)}`);
    }
    if (handleArray.length >= capacity) {
      throw new Error(`RunPool(${poolId}): capacity (${capacity}) exceeded`);
    }

    // Take the initial aliveness from the run pool's saved map. A fresh id
    // defaults to `true`; an id present in `aliveStates` (e.g. one whose
    // entry `deserializePersistents` set when a save loaded) keeps whatever
    // value was loaded — including `false` for pool runs that died before the
    // save was taken. `alive` is a local per-handle ref so a destroyed
    // handle's `alive.value` stays at its last value after
    // `removeFromCollection` deletes the map entry. A watcher mirrors changes
    // into `aliveStates` so they are saved, and the run pool's `onHydrated`
    // re-seeds it after a load during play replaces the entire map.
    const idKey = String(reg.id);
    const initialAlive = aliveStates.value[idKey] ?? true;
    aliveStates.value[idKey] = initialAlive;
    const alive = ref(initialAlive);
    const stopMirror = runInEffectScope(scope, () =>
      watch(
        alive,
        (v) => {
          aliveStates.value[idKey] = v;
        },
        { flush: 'sync' },
      ),
    );

    const handle: RunHandle<Id> = {
      id: reg.id,
      alive,
      step(): boolean {
        if (!alive.value) return false;
        const entry = entryOf(handle);
        if (!entry) return false;
        const fn = entry.step;
        if (fn()) return true;
        dispatchDeath(handle, resolveOutcome(entry));
        return false;
      },
      restart(nextStep: RunStep): void {
        // Only parked handles re-arm. Live handles ignore; destroyed
        // handles are out of the run pool.
        const entry = entryOf(handle);
        if (!entry || alive.value) return;
        entry.step = nextStep;
        alive.value = true;
        bus.emit('run:restarted', handle);
      },
      destroy(): void {
        forceDestroy(handle);
      },
    };

    entries.set(reg.id, {
      handle,
      step: reg.step,
      onDeath: reg.onDeath,
      stop: stopMirror,
    });
    handleArray.push(handle);
    bumpLive();

    bus.emit('run:added', handle);
    return handle;
  }

  const pool: RunPool<Id> = {
    id: poolId,
    deathDisposition,
    runs: instances,
    liveCount,
    addRun,
    getRun(id: Id): RunHandle<Id> | undefined {
      return entries.get(id)?.handle;
    },
    removeRun(id: Id): void {
      const entry = entries.get(id);
      if (entry) forceDestroy(entry.handle);
    },
    reset(): void {
      bus.emit('pool:reset');
    },
    on: bus.on,
    dispose(): void {
      scope.stop();
      disownPersistent(aliveStates);
    },
  };

  return attachPersistentContextReset(pool, poolId);
}
