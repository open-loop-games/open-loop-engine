/**
 * Action Category — batch-registered ordered-execution queue with per-execution state machine.
 *
 * Wraps `createSequencer` with engine-managed per-execution fields (`status`,
 * `progress`, `attempt`, `error`, `timing`) on each enqueued item. Polymorphism
 * comes from per-mapping `tick` closures supplied at register time. It is
 * like {@link createProducerCategory}, where each mapping picks its behavior
 * with a discriminant (`trigger`).
 *
 * Three-way state split:
 * - Def state → `entry.state` (saved, kept across enqueues, and reset by the
 *   category's `[Resettable]`)
 * - Per-enqueue consumer payload → typed `Payload` generic on item metadata
 * - Per-execution engine fields → `status`, `progress`, `attempt`, `error`,
 *   `timing` on item metadata
 *
 * Resetting: the category's `[Resettable]` (`thingsToReset: [category]`)
 * covers only def state. The player's queue or list, the running item and
 * its progress all survive it. Reset those explicitly: `replay()` for a list,
 * `sequencer.clear()` for a queue. A reset whose `resetPersistentContexts`
 * names the category's persistent context is different. It also resets the
 * internal sequencer's saved queue, current item, cursor and pause flag, and
 * emits no `cancelled`. So use it only where losing the queue is intended.
 *
 * Def-id-addressed verbs (`setItemStatus` / `tickItemProgress` /
 * `setItemError` / `updateItemPayload`) target the current item if its defId
 * matches, else linear-scan `sequencer.items.value` for the first match.
 * The queues seen so far hold under about 20 items; indexed lookup is a
 * `TODO(expansion)`.
 *
 * Not a worker bundle — `TimedProgress` is not a hardcoded dependency.
 * Consumers wanting "single-active execution with duration-driven progress"
 * keep the documented worker bundle composition (`consumer-guide-recipes.md`
 * § Indirect-control worker pools). ActionCategory is the higher-opinion
 * sibling shape for the per-execution state machine pattern.
 *
 * @cluster action-category
 */

import { createEmitHandle, type Emittable } from '@/core/events';
import { createModifierChain, type ModifierChain } from '@/core/modifier';
import { profileEnd, profileStart } from '@/core/profiler';
import {
  createSequencer,
  type RegisterTick,
  type Sequencer,
  type SequencerItem,
  type StartResult,
} from '@/core/sequencer';
import { createCategoryBase, type CategoryBase, type CategoryEntrySignals } from './category-base';
import { type ContentRegistryView } from './content-registry';
import { Resettable, type ResettableObject } from '@/core/resettable';
import { getCurrentEngineCategories } from './engine-categories';

// === TYPES ===

/**
 * Per-execution status. Set by the engine on sequencer events and via the
 * `setItemStatus` verb. No `cancelled` terminal — cancellation removes the
 * item from the queue (observable via the `cancelled` event).
 */
export type ActionItemStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed';

/**
 * Sequencer-item metadata shape for an ActionCategory. Engine-managed fields
 * (`status`, `progress`, `attempt`, `error`, `timing`) are beside the
 * consumer's typed `Payload`. All fields are plain JSON-serializable — large Decimal
 * quantities stay in sibling `Persistent<DecimalSource>` refs accessed via
 * `entry.state`.
 */
export interface ActionItemMetadata<Payload> {
  readonly defId: string;
  payload: Payload;
  status: ActionItemStatus;
  /** Single value or named-bars record. Plain number; Decimal stays in `entry.state`. */
  progress: number | Record<string, number>;
  attempt: number;
  error?: { message: string; at: number };
  timing: { startedAt?: number; completedAt?: number };
}

/** Context passed to a mapping's `tick` closure. */
export interface ActionTickContext<Def extends { id: string }, DefState, Payload> {
  readonly entry: ActionCategoryEntry<Def, DefState, Payload>;
  readonly dt: number;
  readonly category: ActionCategory<Def, DefState, Payload>;
}

/**
 * A category entry: def, def state, and the per-execution metadata while this
 * def is the running item.
 */
export interface ActionCategoryEntry<Def extends { id: string }, DefState, Payload> {
  readonly def: Def;
  readonly state: DefState;
  /** Per-execution metadata when this def is the sequencer's current item, else null. */
  readonly current: ActionItemMetadata<Payload> | null;
  readonly signals: CategoryEntrySignals;
  /** Optional per-entry modifier chain (when `mapping.rateChain` is true). */
  readonly rateChain?: ModifierChain;
}

/** What the `mapAction` callback returns: per-def behavior and signals. */
export interface ActionMapping<Def extends { id: string }, DefState, Payload> {
  /**
   * Per-def tick body. Called once per engine tick when this def is the
   * sequencer's current item. Mutate engine fields via the verbs on `ctx.category`;
   * call `ctx.category.sequencer.complete()` (or `.repeat()`) when this execution finishes.
   */
  tick?: (ctx: ActionTickContext<Def, DefState, Payload>) => void;
  /**
   * Per-def start check, composed into the internal sequencer's `canStart`.
   * The engine looks up the entry by the candidate item's `metadata.defId`
   * and calls this if present, defaulting to `'now'` otherwise.
   */
  canStart?: (entry: ActionCategoryEntry<Def, DefState, Payload>) => StartResult;
  /** Required: unlock/count signals for the engine's CategoryEntrySignals cross-cut. */
  signals: CategoryEntrySignals;
  /**
   * When `true`, the engine creates a per-entry ModifierChain named
   * `${categoryId}/${def.id}/rate`. Exposed via `entry.rateChain` and
   * `category.getRateChain(defId)`. Mirrors Producer's rate-chain convention.
   */
  rateChain?: boolean;
}

/** Context passed to `mapAction` at registration time. */
export interface ActionCategoryContext {
  registerTick: RegisterTick;
}

/** Events emitted by an {@link ActionCategory}. Subscribe via `category.on()`. */
export interface ActionCategoryEvents<Def extends { id: string }, DefState, Payload> {
  /**
   * Fired once per execution when an item reaches `'completed'`, through
   * `setItemStatus` or `sequencer.complete()`, whichever comes first.
   */
  completed: (entry: ActionCategoryEntry<Def, DefState, Payload>) => void;
  /** Fired on every status change of any item. */
  itemStatusChanged: (
    entry: ActionCategoryEntry<Def, DefState, Payload>,
    from: ActionItemStatus,
    to: ActionItemStatus,
  ) => void;
  /** Fired when an item is cancelled via `cancel()` (the item leaves the queue). */
  cancelled: (entry: ActionCategoryEntry<Def, DefState, Payload>) => void;
}

/** Options for {@link createActionCategory}. */
export interface ActionCategoryOptions<
  Def extends { id: string },
  DefState = void,
  Payload = void,
> {
  /** Persistent context id. Each def's persistent context is `{id}/{def.id}`. */
  id: string;
  /**
   * Sequencer mode. Default `'queue'`; `'list'` for shapes where a cursor
   * walks a list, which replay the list with `replay()`.
   */
  mode?: 'queue' | 'list';
  /**
   * Map a def to its tick/canStart/signals/rateChain mapping. Called at
   * registration time, in the caller's persistent context — unlike `mapState`,
   * not the def's.
   */
  mapAction: (def: Def, ctx: ActionCategoryContext) => ActionMapping<Def, DefState, Payload>;
  /** Optional builder of each def's def state. Called inside the def's persistent context. */
  mapState?: (def: Def) => DefState;
  /** Tick registration (typically `ctx.onTick`). */
  registerTick: RegisterTick;
  /**
   * Sequencer `startOnEnqueue` passthrough. Default `true`. Set `false` for
   * "planning mode" categories where the consumer explicitly calls `start()`.
   */
  startOnEnqueue?: boolean;
  /**
   * Sequencer `maxSize` passthrough. Default unlimited.
   */
  maxSize?: number;
}

/** An action category — registered queue with per-execution state machine. */
export interface ActionCategory<Def extends { id: string }, DefState = void, Payload = void>
  extends ResettableObject, Emittable<ActionCategoryEvents<Def, DefState, Payload>> {
  readonly id: string;
  /**
   * The content registry (see {@link ContentRegistryView} for what a patch
   * reaches). Add defs with the category's `register`, which runs `mapAction`
   * and builds each def's state.
   */
  readonly registry: ContentRegistryView<Def>;

  // --- Registration ---

  register(defs: Def | Def[]): void;
  getDef(id: string): Def | undefined;
  getEntry(id: string): ActionCategoryEntry<Def, DefState, Payload> | undefined;
  getAll(): ActionCategoryEntry<Def, DefState, Payload>[];
  getState(id: string): DefState | undefined;
  readonly size: number;

  // --- Queue surface (defId-addressed wrappers) ---

  /**
   * Enqueue a sequencer item for `defId` onto the internal sequencer.
   * `options.payload` is required when `Payload != void`.
   *
   * @returns `false` when `maxSize` would be exceeded.
   * @throws If `defId` is not registered.
   */
  enqueue(defId: string, options?: { at?: number; payload: Payload }): boolean;

  /**
   * Cancel the current enqueue of `defId` if it's running, else remove the
   * first matching pending item. Emits the `cancelled` event.
   */
  cancel(defId: string): void;

  /**
   * List mode: replay the list from the start, as at the start of a new run.
   * Resets every item's execution fields (`status` to `'pending'`,
   * `progress`, `attempt`, `error`, `timing`) while keeping its payload,
   * cancels the running item, and starts from the first. A bare
   * `sequencer.resetCursor()` leaves the fields from the previous pass, so
   * every replayed item would finish on its first tick. No-op in queue mode.
   */
  replay(): void;

  /** Current per-execution metadata if any def is running, else null. */
  readonly currentItem: ActionItemMetadata<Payload> | null;

  /**
   * The internal sequencer. Exposed for ordering operations (`reorder`,
   * `clear`, `pause`, `resume`, `setCurrent`, `start`) and event subscription
   * (`on`). Consumers use the sequencer for queue-shape ops; for
   * per-execution state mutation use the def-id-addressed verbs below.
   */
  readonly sequencer: Sequencer<ActionItemMetadata<Payload>>;

  // --- Def-id-addressed engine-field verbs ---
  // TODO(expansion): replace linear-scan lookup with Map<defId, index> when a
  // consumer routinely holds a queue over 100. The queues seen so far stay under ~20.

  setItemStatus(defId: string, status: ActionItemStatus): void;
  setItemProgress(defId: string, value: number | Record<string, number>): void;
  tickItemProgress(defId: string, delta: number | Record<string, number>): void;
  setItemError(defId: string, error: { message: string } | null): void;
  updateItemPayload(defId: string, update: Partial<Payload> | ((p: Payload) => Payload)): void;

  // --- Scoped subscriptions ---

  /**
   * Subscribe to changes on a specific def's per-execution metadata. Fires
   * after any engine-field or payload mutation that targets `defId`. Items
   * stay value-semantics internally; per-item observation comes from
   * subscriptions instead (the Akka / Temporal pattern).
   */
  onItemChange(
    defId: string,
    fn: (entry: ActionCategoryEntry<Def, DefState, Payload>) => void,
  ): () => void;

  // --- Modifier chain access ---

  /** Optional per-entry rate chain (when `mapping.rateChain` was set). */
  getRateChain(defId: string): ModifierChain | undefined;
}

// === CONSTANTS ===

const NO_TIMING = Object.freeze({} as { startedAt?: number; completedAt?: number });

// === PRIVATE BUILDERS ===

function buildInitialMetadata<Payload>(
  defId: string,
  payload: Payload,
  initialProgress: number | Record<string, number>,
): ActionItemMetadata<Payload> {
  return {
    defId,
    payload,
    status: 'pending',
    progress: initialProgress,
    attempt: 0,
    error: undefined,
    timing: { ...NO_TIMING },
  };
}

// === FACTORIES ===

/**
 * Create an action category — batch registration of typed action defs into an
 * ordered-execution queue with per-execution state machine.
 *
 * @param options - Category id, mode, mapAction, mapState, tick registration
 * @returns An {@link ActionCategory} with registry, queue surface, def-id-addressed verbs, events
 *
 * @example
 * ```ts
 * interface SpellDef { id: string; baseCastTime: number }
 * interface SpellState { timesCast: Persistent<number> }
 *
 * // Annotated: the category is read inside its own mapAction.
 * const spells: ActionCategory<SpellDef, SpellState> = createActionCategory<
 *   SpellDef,
 *   SpellState
 * >({
 *   id: 'spells',
 *   registerTick: ctx.onTick,
 *   mapState: () => ({ timesCast: persistent(0) }),
 *   mapAction: (def) => ({
 *     signals: {
 *       unlock: computed(() => true),
 *       // Read state lazily: mapAction runs before the entry exists.
 *       count: computed(() => spells.getState(def.id)?.timesCast.value ?? 0),
 *     },
 *     tick: ({ entry, dt, category }) => {
 *       category.tickItemProgress(def.id, dt);
 *       if ((category.currentItem?.progress as number) >= def.baseCastTime) {
 *         entry.state.timesCast.value++;
 *         category.sequencer.complete();
 *       }
 *     },
 *   }),
 * });
 *
 * spells.register({ id: 'fireball', baseCastTime: 2 });
 * spells.enqueue('fireball');
 * ```
 */
export function createActionCategory<Def extends { id: string }, DefState = void, Payload = void>(
  options: ActionCategoryOptions<Def, DefState, Payload>,
): ActionCategory<Def, DefState, Payload> {
  const {
    id: categoryId,
    mode = 'queue',
    mapAction,
    mapState,
    registerTick,
    startOnEnqueue,
    maxSize,
  } = options;

  const mappings = new Map<string, ActionMapping<Def, DefState, Payload>>();
  const rateChains = new Map<string, ModifierChain>();
  // The batch registerWithMapping is registering, keyed by def object.
  let stagedMappings: Map<Def, ActionMapping<Def, DefState, Payload>> | undefined;
  const mapCtx: ActionCategoryContext = { registerTick };

  const handle = createEmitHandle<ActionCategoryEvents<Def, DefState, Payload>>();
  const itemChangeHandlers = new Map<
    string,
    Set<(entry: ActionCategoryEntry<Def, DefState, Payload>) => void>
  >();

  // --- Build base + per-def wiring -----------------------------------------

  const base: CategoryBase<Def, void, DefState> = createCategoryBase<Def, void, DefState>({
    id: categoryId,
    buildState: mapState ? (def) => mapState(def) : undefined,
    buildSignals: (def, _instance, _state) => {
      const mapping = stagedMappings?.get(def);
      if (!mapping) {
        // Defensive: base registration is reachable only through
        // registerWithMapping, which stages every def's mapping first.
        throw new Error(
          `createActionCategory: mapping for ${categoryId}/${def.id} missing during buildSignals`,
        );
      }
      return mapping.signals;
    },
  });

  // Override base.register to map the batch before createCategoryBase's
  // buildSignals runs, since buildSignals reads the mapping. Mappings are staged
  // and installed only for defs that registered: a duplicate id or a throw later
  // in the batch must neither replace a live def's mapping nor leave one behind.
  const baseRegister = base.register;
  function registerWithMapping(defs: Def | Def[]): void {
    const arr = Array.isArray(defs) ? defs : [defs];
    const staged = new Map<Def, ActionMapping<Def, DefState, Payload>>();
    // `mapAction` runs in the caller's persistent context, not the def's:
    // opening the def's here would move the save keys of any refs it creates.
    for (const def of arr) staged.set(def, mapAction(def, mapCtx));
    const outer = stagedMappings;
    stagedMappings = staged;
    try {
      baseRegister(arr);
    } finally {
      stagedMappings = outer;
      for (const [def, mapping] of staged) {
        if (base.getDef(def.id) !== def) continue;
        mappings.set(def.id, mapping);
        if (mapping.rateChain) {
          rateChains.set(def.id, createModifierChain(`${categoryId}/${def.id}/rate`));
        }
      }
    }
  }

  // --- Sequencer wiring ----------------------------------------------------

  const sequencer: Sequencer<ActionItemMetadata<Payload>> = createSequencer<
    ActionItemMetadata<Payload>
  >({
    id: `${categoryId}/queue`,
    mode,
    maxSize,
    startOnEnqueue,
    registerTick,
    canStart: (item) => {
      const mapping = mappings.get(item.metadata.defId);
      if (!mapping?.canStart) return 'now';
      const entry = makeEntry(item.metadata.defId, item.metadata);
      if (!entry) return 'never';
      return mapping.canStart(entry);
    },
  });

  // --- Lookup --------------------------------------------------------------

  function findItemIndexByDefId(defId: string): number {
    const items = sequencer.items.value;
    for (let i = 0; i < items.length; i++) {
      if (items[i].metadata.defId === defId) return i;
    }
    return -1;
  }

  function getCurrentMetadataIfDefId(defId: string): ActionItemMetadata<Payload> | null {
    const cur = sequencer.currentItem;
    if (!cur || cur.metadata.defId !== defId) return null;
    return cur.metadata;
  }

  function updateByDefId(
    defId: string,
    patch: (m: ActionItemMetadata<Payload>) => ActionItemMetadata<Payload>,
  ): boolean {
    const cur = sequencer.currentItem;
    if (cur && cur.metadata.defId === defId) {
      sequencer.updateCurrentItem(patch);
      fireItemChange(defId);
      return true;
    }
    const idx = findItemIndexByDefId(defId);
    if (idx >= 0) {
      sequencer.updateItem(idx, patch);
      fireItemChange(defId);
      return true;
    }
    return false;
  }

  function fireItemChange(defId: string): void {
    const handlers = itemChangeHandlers.get(defId);
    if (!handlers || handlers.size === 0) return;
    const entry = getEntry(defId);
    if (!entry) return;
    for (const fn of handlers) fn(entry);
  }

  // --- Entry view assembly -------------------------------------------------

  function makeEntry(
    defId: string,
    currentMeta: ActionItemMetadata<Payload> | null,
  ): ActionCategoryEntry<Def, DefState, Payload> | undefined {
    const baseEntry = base.getEntry(defId);
    if (!baseEntry) return undefined;
    return {
      def: baseEntry.def,
      state: baseEntry.state,
      current: currentMeta,
      signals: baseEntry.signals!,
      rateChain: rateChains.get(defId),
    };
  }

  function getEntry(defId: string): ActionCategoryEntry<Def, DefState, Payload> | undefined {
    return makeEntry(defId, getCurrentMetadataIfDefId(defId));
  }

  // --- Status change helper ------------------------------------------------

  function transitionLifecycle(
    defId: string,
    next: ActionItemStatus,
    extra?: (m: ActionItemMetadata<Payload>) => Partial<ActionItemMetadata<Payload>>,
  ): void {
    // Emit only once the update is committed: a handler reading the category
    // must see the new status, and one that calls a verb must not have its
    // write overwritten by this update's spread of the stale metadata.
    const transition: { from?: ActionItemStatus; patched?: ActionItemMetadata<Payload> } = {};
    updateByDefId(defId, (m) => {
      const from = m.status;
      if (from === next && !extra) return m;
      const patched: ActionItemMetadata<Payload> = {
        ...m,
        status: next,
        ...(extra ? extra(m) : {}),
      };
      if (from !== next) {
        transition.from = from;
        transition.patched = patched;
      }
      return patched;
    });
    if (transition.from === undefined || !transition.patched) return;
    const entry = makeEntry(defId, transition.patched);
    if (!entry) return;
    handle.emit('itemStatusChanged', entry, transition.from, next);
    if (next === 'completed') handle.emit('completed', entry);
  }

  // --- Wire sequencer events to status changes -----------------------------

  sequencer.on('started', (item) => {
    transitionLifecycle(item.metadata.defId, 'running', () => ({
      timing: { startedAt: Date.now() },
    }));
  });

  sequencer.on('held', (item) => {
    transitionLifecycle(item.metadata.defId, 'waiting');
  });

  sequencer.on('completed', (item) => {
    // The sequencer has already cleared `current` (and popped the item in
    // queue mode), so the verbs can't reach it; build the terminal metadata by
    // hand. An item already set 'completed' through `setItemStatus` has emitted
    // both events, and `completed` fires once per execution.
    const meta = item.metadata;
    if (meta.status === 'completed') {
      fireItemChange(meta.defId);
      return;
    }
    const terminal: ActionItemMetadata<Payload> = {
      ...meta,
      status: 'completed',
      timing: { ...meta.timing, completedAt: Date.now() },
    };
    // A list keeps the item, one position behind the advanced cursor: record
    // the terminal status there too, or it shows 'running' until replayed.
    if (mode === 'list') {
      const slot = sequencer.cursor - 1;
      if (sequencer.items.value[slot]?.id === item.id) sequencer.updateItem(slot, () => terminal);
    }
    const entry = makeEntry(meta.defId, terminal);
    if (!entry) return;
    handle.emit('itemStatusChanged', entry, meta.status, 'completed');
    handle.emit('completed', entry);
    fireItemChange(meta.defId);
  });

  sequencer.on('cancelled', (item) => {
    const entry = makeEntry(item.metadata.defId, item.metadata);
    if (entry) handle.emit('cancelled', entry);
    fireItemChange(item.metadata.defId);
  });

  sequencer.on('skipped', (item) => {
    // Skip means canStart returned 'never'. Report it as terminal 'failed' so UI
    // can show the skip in the same channel as explicit setItemError.
    const meta = item.metadata;
    const terminal: ActionItemMetadata<Payload> = { ...meta, status: 'failed' };
    // A list keeps the skipped item one position behind the cursor, which advances
    // before `skipped` fires: record the terminal status there or it shows 'pending'.
    if (mode === 'list') {
      const slot = sequencer.cursor - 1;
      if (sequencer.items.value[slot]?.id === item.id) sequencer.updateItem(slot, () => terminal);
    }
    const entry = makeEntry(meta.defId, terminal);
    if (!entry) return;
    if (meta.status !== 'failed') {
      handle.emit('itemStatusChanged', entry, meta.status, 'failed');
    }
    fireItemChange(meta.defId);
  });

  // --- Dispatcher tick -----------------------------------------------------

  registerTick((dt) => {
    const cur = sequencer.currentItem;
    if (!cur) return;
    const defId = cur.metadata.defId;
    const mapping = mappings.get(defId);
    if (!mapping?.tick) return;
    const entry = makeEntry(defId, cur.metadata);
    if (!entry) return;
    const tick = mapping.tick;
    const t0 = profileStart();
    try {
      tick({ entry, dt, category });
    } finally {
      // Hot path: the label is only built while someone is profiling.
      if (t0 !== 0) profileEnd(`${categoryId}/${defId}/tick`, t0);
    }
  });

  // --- Public category surface ---------------------------------------------

  const category: ActionCategory<Def, DefState, Payload> = {
    id: categoryId,
    registry: base.registry,
    register: registerWithMapping,
    getDef: base.getDef,
    getEntry,
    getAll() {
      return base.getAll().map((e) => makeEntry(e.def.id, getCurrentMetadataIfDefId(e.def.id))!);
    },
    getState: (id) => base.getEntry(id)?.state,

    get size() {
      return base.size;
    },

    sequencer,

    enqueue(defId, opts): boolean {
      if (!base.getDef(defId)) {
        throw new Error(
          `createActionCategory: defId "${defId}" is not registered in ${categoryId}`,
        );
      }
      const payload = (opts?.payload ?? (undefined as unknown)) as Payload;
      // Multi-bar accumulators seed their per-key shape lazily via
      // tickItemProgress's runtime coercion; a scalar 0 is the right seed here.
      const meta = buildInitialMetadata(defId, payload, 0);
      const item: SequencerItem<ActionItemMetadata<Payload>> = { id: defId, metadata: meta };
      return sequencer.enqueue(item, opts?.at !== undefined ? { at: opts.at } : undefined);
    },

    cancel(defId) {
      const cur = sequencer.currentItem;
      if (cur && cur.metadata.defId === defId) {
        sequencer.cancel();
        return;
      }
      const idx = findItemIndexByDefId(defId);
      if (idx >= 0) {
        const meta = sequencer.items.value[idx].metadata;
        sequencer.remove(idx);
        const entry = makeEntry(defId, meta);
        if (entry) handle.emit('cancelled', entry);
        fireItemChange(defId);
      }
    },

    replay() {
      if (mode !== 'list') return;
      // Every item, not the first match per defId: a list may hold one def twice.
      const items = sequencer.items.value;
      sequencer.items.value = items.map((item) => ({
        id: item.id,
        metadata: buildInitialMetadata(item.metadata.defId, item.metadata.payload, 0),
      }));
      sequencer.resetCursor();
      for (const defId of new Set(items.map((item) => item.metadata.defId))) {
        fireItemChange(defId);
      }
    },

    get currentItem() {
      return sequencer.currentItem?.metadata ?? null;
    },

    setItemStatus(defId, status) {
      transitionLifecycle(defId, status);
    },

    setItemProgress(defId, value) {
      updateByDefId(defId, (m) => ({ ...m, progress: value }));
    },

    tickItemProgress(defId, delta) {
      updateByDefId(defId, (m) => {
        if (typeof delta === 'number') {
          const current = typeof m.progress === 'number' ? m.progress : 0;
          return { ...m, progress: current + delta };
        }
        // Multi-bar: accumulate per key. Current may be number or record;
        // coerce to record when accumulating with named bars.
        const current: Record<string, number> =
          typeof m.progress === 'number' ? {} : { ...m.progress };
        for (const [key, dv] of Object.entries(delta)) {
          current[key] = (current[key] ?? 0) + dv;
        }
        return { ...m, progress: current };
      });
    },

    setItemError(defId, error) {
      if (error === null) {
        updateByDefId(defId, (m) => (m.error === undefined ? m : { ...m, error: undefined }));
        return;
      }
      updateByDefId(defId, (m) => ({
        ...m,
        error: { message: error.message, at: Date.now() },
        attempt: m.attempt + 1,
      }));
      transitionLifecycle(defId, 'failed');
    },

    updateItemPayload(defId, update) {
      updateByDefId(defId, (m) => {
        const nextPayload =
          typeof update === 'function'
            ? update(m.payload)
            : ({ ...(m.payload as object), ...update } as Payload);
        return { ...m, payload: nextPayload };
      });
    },

    onItemChange(defId, fn) {
      let handlers = itemChangeHandlers.get(defId);
      if (!handlers) {
        handlers = new Set();
        itemChangeHandlers.set(defId, handlers);
      }
      handlers.add(fn);
      return () => {
        const h = itemChangeHandlers.get(defId);
        if (!h) return;
        h.delete(fn);
        if (h.size === 0) itemChangeHandlers.delete(defId);
      };
    },

    on: handle.on,

    getRateChain(defId) {
      return rateChains.get(defId);
    },

    [Resettable]: base[Resettable],
  };

  // Engine-categories registration, for discovery.
  const ec = getCurrentEngineCategories();
  if (ec) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ec.actions ??= [] as ActionCategory<any, any, any>[]).push(category);
  }

  return category;
}
