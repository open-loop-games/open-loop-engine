/**
 * RunPool — core primitive for managing a collection of opaque, addressable
 * "runs" with independent lifecycle state.
 *
 * A pool holds N runs, each with a stable `id`, a reactive `alive` flag, and
 * an opaque `step()` method. The pool does not drive ticks — consumers invoke
 * `handle.step()` on their own cadence (per-run interval, shared game loop,
 * batch catch-up, etc.). On step returning false, the pool applies its
 * `deathPolicy` (or the per-run `onDeath` override) and fires lifecycle
 * events:
 *
 * - `'destroyed'` — handle leaves the pool (borglike shape).
 * - `'parked'` — handle stays with `alive=false` until explicit restart or
 *   `pool.reset()` (Cavernous shape).
 * - `{ restartedWith: step }` — swaps the step in-place; alive stays true
 *   (borglike's in-flight auto-restart shape).
 *
 * Pool persists its per-id aliveness map under context `${poolId}`, not
 * which ids exist: step closures can't be saved, so the game keeps its own
 * record of its runs and recreates them post-load via `addInstance` — the
 * saved aliveness map is consulted so previously-dead
 * instances stay dead across save/load regardless of when they're
 * recreated, fixing the lazy-context gap an earlier per-instance layout
 * had with dynamically-spawned runs (borglike clones, Cavernous loops).
 * The map is tagged `lifetime`: the in-memory handles are the authority,
 * so a module reset leaves them alone and `pool.reset()` stays the seam.
 */

import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import { createEmitHandle, type Emittable } from './events';
import { onHydrated, persistent, withPersistentContext } from './persistence';
import { attachContextReset } from './resettable';

// === TYPES ===
/**
 * One step of a run. Returns `true` if the run is still alive after the step,
 * `false` if it died. The pool interprets the return value — the step
 * function itself never needs to know the death policy.
 */
export type RunStep = () => boolean;

/**
 * Outcome of a run's death, returned synchronously from a per-instance
 * `onDeath` callback. When no callback is registered, the pool applies its
 * `deathPolicy` (`'destroy'` → `'destroyed'`; `'park'` → `'parked'`).
 */
export type RunDeathOutcome = 'destroyed' | 'parked' | { readonly restartedWith: RunStep };

/**
 * Opaque handle to one run inside the pool. Handles are identity-stable
 * across pool operations; consumers may store the reference.
 */
export interface RunHandle<Id = string> {
  readonly id: Id;
  /**
   * Reactive aliveness flag. Backed by the pool's persisted `aliveStates`
   * map; reads and internal flips both route through that map so the value
   * round-trips through save/load regardless of when this handle was
   * created. Flipped to `false` on `'destroyed'` or `'parked'` outcomes;
   * stays `true` through a `restartedWith` outcome.
   */
  readonly alive: Ref<boolean>;
  /**
   * Invoke one step of this run. Routes through the pool's death pipeline —
   * on a `false` return, the outcome is resolved and events fire before
   * `step()` returns. Silent no-op returning `false` on a parked or
   * destroyed handle.
   */
  step(): boolean;
  /**
   * Re-arm a parked handle with a new step function. No-op if the handle
   * is alive or already destroyed. Fires `instance:restarted`.
   */
  restart(nextStep: RunStep): void;
  /**
   * Force-destroy this handle. Fires `instance:died` with outcome
   * `'destroyed'`, then `instance:removed`. Idempotent.
   */
  destroy(): void;
}

/**
 * Registration payload for {@link RunPool.addInstance}: a stable id, the
 * per-tick `step` function, and an optional `onDeath` override that
 * supersedes the pool's `deathPolicy` for this specific instance.
 */
export interface RunRegistration<Id = string> {
  readonly id: Id;
  readonly step: RunStep;
  /**
   * Optional per-instance death override. When present, its return value
   * wins over the pool's `deathPolicy`.
   */
  readonly onDeath?: () => RunDeathOutcome;
}

/** Events emitted during pool lifecycle. Subscribe via `pool.on()`. */
export interface RunPoolEvents<Id = string> {
  'instance:added': (handle: RunHandle<Id>) => void;
  'instance:removed': (handle: RunHandle<Id>) => void;
  /**
   * Fired whenever a run's step returns false. The handle's `alive` has
   * already been flipped to the post-death state (or left `true` for
   * `restartedWith`). For `'destroyed'`, the handle is still present in
   * `instances.value` during this event; `instance:removed` fires next.
   */
  'instance:died': (handle: RunHandle<Id>, outcome: RunDeathOutcome) => void;
  /**
   * Fired when a parked handle was re-armed via `handle.restart()` or a
   * just-died handle was replaced via `{ restartedWith }`.
   */
  'instance:restarted': (handle: RunHandle<Id>) => void;
  /**
   * Fired on `pool.reset()`. Consumers observe and run game-side reset
   * (re-arm parked handles, reset zones, etc.). The pool itself does not
   * touch aliveness — the handler is responsible.
   */
  'pool:reset': () => void;
}

/**
 * Configuration for {@link createRunPool}. `deathPolicy` picks the
 * post-death disposition (borglike "destroy" vs Cavernous "park"); the
 * optional `maxInstances` caps concurrent runs.
 */
export interface RunPoolOptions {
  /** Unique identifier; used as the persistence context name. */
  readonly id: string;
  /**
   * Pool-wide default applied when a run's `onDeath` is absent:
   *
   * - `'destroy'` — handle is removed from the pool (borglike shape).
   * - `'park'` — handle stays with `alive=false` (Cavernous shape).
   */
  readonly deathPolicy: 'destroy' | 'park';
  /**
   * Optional hard cap on concurrent runs. `addInstance` throws when
   * exceeding. Default: unlimited. `0` is treated as valid-but-empty
   * (always throws), not as "unlimited".
   */
  readonly maxInstances?: number;
}

/**
 * A pool of concurrent run instances — borglike clones, Cavernous loops, idle
 * factory loops — sharing one death policy but each carrying its own step
 * closure. Created by {@link createRunPool}; emit lifecycle events for
 * add/remove/death/restart/reset.
 */
export interface RunPool<Id = string> extends Emittable<RunPoolEvents<Id>> {
  readonly id: string;
  readonly deathPolicy: 'destroy' | 'park';
  /**
   * Read-only view of all registered handles in insertion order. Array
   * identity changes on add/remove; stable between no-op reads.
   */
  readonly instances: { readonly value: readonly RunHandle<Id>[] };
  /** Reactive count of handles with `alive.value === true`. */
  readonly liveCount: Readonly<Ref<number>>;
  /**
   * Register a new run. Throws on ID collision or when exceeding
   * `maxInstances`. Fires `instance:added`.
   */
  addInstance(registration: RunRegistration<Id>): RunHandle<Id>;
  /** Look up by ID. Returns `undefined` for unknown IDs. */
  getInstance(id: Id): RunHandle<Id> | undefined;
  /** Force-destroy by ID. No-op if unknown. Equivalent to `handle.destroy()`. */
  removeInstance(id: Id): void;
  /**
   * Atomic pool-wide reset. Fires `pool:reset`; consumers re-arm handles
   * in the handler. Seam, not a verb — the pool does not itself touch
   * aliveness.
   */
  reset(): void;
}

// === FACTORY ===
/**
 * Creates a persistent pool of opaque runs with lifecycle events.
 *
 * @param options - Pool configuration including `id`, `deathPolicy`, and
 *   optional `maxInstances` cap
 * @returns A pool with `addInstance`/`getInstance`/`removeInstance`/`reset`
 *   operations, reactive `instances` and `liveCount`, and typed event
 *   subscription
 *
 * @example
 * ```ts
 * const pool = createRunPool({ id: 'runs', deathPolicy: 'destroy' });
 *
 * const handle = pool.addInstance({
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
  const { id: poolId, deathPolicy, maxInstances = Infinity } = options;

  // Pool-level persistence: the per-id aliveness map, in the pool's own
  // context so it's in the registry at save-load time — `addInstance` is
  // consulted against the saved `aliveStates` regardless of when it runs, so
  // dynamic instances created post-load pick up their saved alive state (no
  // resurrection of dead clones).
  const { aliveStates } = withPersistentContext(poolId, () => ({
    aliveStates: persistent<Record<string, boolean>>({}, { name: 'aliveStates', lifetime: true }),
  }));

  // In-memory collection state: `handleArray` holds insertion order, and
  // `entries` everything else about a handle in the pool. A handle is in the
  // pool while `entries` maps its id to its own entry; after it leaves, the
  // id may be reused by a new handle.
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

  // A load replaces `aliveStates` wholesale: re-seed each handle still in the
  // pool from it. A handle that has left the pool isn't walked, so a load
  // naming its id can't revive it.
  onHydrated(() => {
    for (const h of handleArray) {
      const v = aliveStates.value[String(h.id)];
      if (v !== undefined && v !== h.alive.value) h.alive.value = v;
    }
  });

  // Versioned view-cache for referentially-stable `instances.value` reads.
  // Pattern cribbed verbatim from sequencer.ts — reads return the same slice
  // until a structural mutation bumps the version, then a fresh slice is
  // handed out so Vue watchers and identity assertions trigger.
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
    return deathPolicy === 'destroy' ? 'destroyed' : 'parked';
  }

  function dispatchDeath(h: RunHandle<Id>, outcome: RunDeathOutcome): void {
    const entry = entryOf(h);
    if (!entry) return; // handle was already torn down

    if (outcome === 'destroyed') {
      h.alive.value = false;
      bus.emit('instance:died', h, 'destroyed');
      removeFromCollection(entry);
      bus.emit('instance:removed', h);
      return;
    }

    if (outcome === 'parked') {
      h.alive.value = false;
      bus.emit('instance:died', h, 'parked');
      return;
    }

    // { restartedWith } — swap step in-place, alive stays true.
    entry.step = outcome.restartedWith;
    bus.emit('instance:died', h, outcome);
    bus.emit('instance:restarted', h);
  }

  function forceDestroy(h: RunHandle<Id>): void {
    const entry = entryOf(h);
    if (!entry) return; // idempotent
    h.alive.value = false;
    bus.emit('instance:died', h, 'destroyed');
    removeFromCollection(entry);
    bus.emit('instance:removed', h);
  }

  function addInstance(reg: RunRegistration<Id>): RunHandle<Id> {
    if (entries.has(reg.id)) {
      throw new Error(`RunPool(${poolId}): duplicate instance id ${String(reg.id)}`);
    }
    if (handleArray.length >= maxInstances) {
      throw new Error(`RunPool(${poolId}): maxInstances (${maxInstances}) exceeded`);
    }

    // Resolve initial aliveness from the pool's persisted map. A fresh id
    // defaults to `true`; an id present in `aliveStates` (e.g. one whose
    // entry was set by `deserializePersistents` at save-load time) keeps
    // whatever value was loaded — including `false` for runs that died
    // before the save was taken. `alive` is a local per-handle ref so a
    // destroyed handle's `alive.value` stays at its last value after
    // `removeFromCollection` cleans the map entry; a watcher mirrors flips
    // into `aliveStates` for persistence, and the pool's `onHydrated`
    // re-seeds it after a mid-session load replaces the entire map.
    const idKey = String(reg.id);
    const initialAlive = aliveStates.value[idKey] ?? true;
    aliveStates.value[idKey] = initialAlive;
    const alive = ref(initialAlive);
    const stopMirror = watch(
      alive,
      (v) => {
        aliveStates.value[idKey] = v;
      },
      { flush: 'sync' },
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
        // handles are out of the pool.
        const entry = entryOf(handle);
        if (!entry || alive.value) return;
        entry.step = nextStep;
        alive.value = true;
        bus.emit('instance:restarted', handle);
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

    bus.emit('instance:added', handle);
    return handle;
  }

  const pool: RunPool<Id> = {
    id: poolId,
    deathPolicy,
    instances,
    liveCount,
    addInstance,
    getInstance(id: Id): RunHandle<Id> | undefined {
      return entries.get(id)?.handle;
    },
    removeInstance(id: Id): void {
      const entry = entries.get(id);
      if (entry) forceDestroy(entry.handle);
    },
    reset(): void {
      bus.emit('pool:reset');
    },
    on: bus.on,
  };

  return attachContextReset(pool, poolId);
}
