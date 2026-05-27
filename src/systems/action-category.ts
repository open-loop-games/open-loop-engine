/**
 * Action Category — batch-registered ordered-execution queue with per-execution state machine.
 *
 * Wraps `createSequencer` with engine-managed per-execution slots (lifecycle,
 * progress, attempt, error, timing) on each enqueued item. Polymorphism via
 * per-mapping `tick` closures supplied at register time — mirrors
 * {@link createProducerCategory}'s per-mapping discriminator discipline.
 *
 * Three-way state split:
 * - Per-def state → `entry.state` (createCategoryBase per-def slot, persistent
 *   across enqueues, resets per loop/prestige via `[Resettable]`)
 * - Per-enqueue consumer payload → typed `Payload` generic on item metadata
 * - Per-execution engine slots → `lifecycle`, `progress`, `attempt`, `error`,
 *   `timing` on item metadata
 *
 * ID-addressed verbs (`setItemState` / `tickItemProgress` / `setItemError` /
 * `patchItemPayload`) target the current item if its defId matches, else
 * linear-scan `sequencer.items.value` for the first match. Queues <~20 per
 * consumer annotation — indexed lookup is a `TODO(expansion)`.
 *
 * Not a worker bundle — `TimedProgress` is not a hardcoded dependency.
 * Consumers wanting "single-active execution with duration-driven progress"
 * keep the documented Worker Bundle composition (`consumer-guide.md` §
 * Indirect-control worker pools). ActionCategory is the higher-opinion
 * sibling shape for the per-execution state machine pattern.
 *
 * @cluster action-category
 */

import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { createEmitHandle, type Emittable } from '@/core/events';
import { createModifierChain, type ModifierChain } from '@/core/modifier';
import { profile } from '@/core/profiler';
import {
  createSequencer,
  type RegisterTick,
  type Sequencer,
  type SequencerItem,
  type StartResult,
} from '@/core/sequencer';
import { createCategoryBase, type CategoryBase, type CategoryEntrySignals } from './category-base';
import { type ContentRegistry } from './content-registry';
import { Resettable, type ResettableObject } from './resettable';
import { getCurrentEngineCategories } from './engine-categories';

// === TYPES ===

/**
 * Per-execution lifecycle state. Set by the engine on sequencer events and via
 * the `setItemState` verb. No `cancelled` terminal — cancellation removes the
 * entry from the queue (observable via `onCancel`).
 */
export type ActionItemState = 'pending' | 'running' | 'waiting' | 'completed' | 'failed';

/**
 * Sequencer-item metadata shape for an ActionCategory. Engine-managed slots
 * (lifecycle, progress, attempt, error, timing) sit alongside the consumer's
 * typed `Payload`. All fields are plain JSON-serializable — large Decimal
 * quantities stay in sibling `Persistent<DecimalSource>` refs accessed via
 * `entry.state`.
 */
export interface ActionItemMetadata<Payload> {
  readonly defId: string;
  payload: Payload;
  lifecycle: ActionItemState;
  /** Single value or named-bars record. Plain number; Decimal stays in `entry.state`. */
  progress: number | Record<string, number>;
  attempt: number;
  error?: { message: string; at: number };
  timing: { startedAt?: number; completedAt?: number };
}

/** Context passed to a mapping's `tick` closure. */
export interface ActionTickContext<Def extends { id: string }, State, Payload> {
  readonly entry: ActionCategoryEntry<Def, State, Payload>;
  readonly dt: number;
  readonly category: ActionCategory<Def, State, Payload>;
}

/**
 * A registered entry: definition + per-def state + the current per-execution
 * metadata when this def is the running item.
 */
export interface ActionCategoryEntry<Def extends { id: string }, State, Payload> {
  readonly def: Def;
  readonly state: State;
  /** Per-execution metadata when this def is the currently dispatched item, else null. */
  readonly current: ActionItemMetadata<Payload> | null;
  readonly signals: CategoryEntrySignals;
  /** Optional per-entry modifier chain (when `mapping.rateChain` is true). */
  readonly rateChain?: ModifierChain;
}

/** Return type of the `mapAction` callback. Describes per-def behavior + signals. */
export interface ActionMapping<Def extends { id: string }, State, Payload> {
  /**
   * Per-def tick body. Called once per engine tick when this def is the
   * sequencer's current item. Mutate engine slots via the verbs on `ctx.category`;
   * call `ctx.category.sequencer.complete()` (or `.repeat()`) when this execution finishes.
   */
  tick?: (ctx: ActionTickContext<Def, State, Payload>) => void;
  /**
   * Per-def pre-run gate. Composed into the internal sequencer's `canRun` —
   * the engine looks up the entry by `currentItem.metadata.defId` and invokes
   * this if present, defaulting to `'now'` otherwise.
   */
  canRun?: (entry: ActionCategoryEntry<Def, State, Payload>) => StartResult;
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
export interface ActionCategoryEvents<Def extends { id: string }, State, Payload> {
  /** Fired when an item transitions to `'completed'` (terminal lifecycle for queue mode). */
  complete: (entry: ActionCategoryEntry<Def, State, Payload>) => void;
  /** Fired on every lifecycle transition for any item. */
  itemStateChange: (
    entry: ActionCategoryEntry<Def, State, Payload>,
    from: ActionItemState,
    to: ActionItemState,
  ) => void;
  /** Fired when an item is cancelled via `cancel()` (entry exits the queue). */
  cancel: (entry: ActionCategoryEntry<Def, State, Payload>) => void;
}

/** Options for {@link createActionCategory}. */
export interface ActionCategoryOptions<Def extends { id: string }, State = void, Payload = void> {
  /** Persistence context id. Each def gets `{id}/{def.id}` via createCategoryBase. */
  id: string;
  /** Sequencer mode. Default `'queue'`; `'list'` for cursor-walks-list shapes (looper, etc.). */
  mode?: 'queue' | 'list';
  /** Map a def to its tick/canRun/signals/rateChain configuration. Called at registration time. */
  mapAction: (def: Def, ctx: ActionCategoryContext) => ActionMapping<Def, State, Payload>;
  /** Optional per-def state factory. Called inside the def's persistent context. */
  mapState?: (def: Def) => State;
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
export interface ActionCategory<Def extends { id: string }, State = void, Payload = void>
  extends ResettableObject, Emittable<ActionCategoryEvents<Def, State, Payload>> {
  readonly id: string;
  readonly registry: ContentRegistry<Def>;

  // --- Registration ---

  register(defs: Def | Def[]): void;
  getDef(id: string): Def | undefined;
  getEntry(id: string): ActionCategoryEntry<Def, State, Payload> | undefined;
  getAll(): ActionCategoryEntry<Def, State, Payload>[];
  getState(id: string): State | undefined;
  readonly size: number;

  // --- Queue surface (defId-addressed wrappers) ---

  /**
   * Enqueue an instance of `defId` onto the internal sequencer.
   * `options.payload` is required when `Payload != void`.
   *
   * @returns `false` when `maxSize` would be exceeded.
   * @throws If `defId` is not registered.
   */
  enqueue(defId: string, options?: { at?: number; payload: Payload }): boolean;

  /**
   * Cancel the current enqueue of `defId` if it's running, else remove the
   * first matching pending instance. Fires `cancel` event.
   */
  cancel(defId: string): void;

  /** Current per-execution metadata if any def is running, else null. */
  readonly currentItem: ActionItemMetadata<Payload> | null;

  /**
   * The internal sequencer. Exposed for ordering operations (`reorder`,
   * `clear`, `pause`, `resume`, `setCurrent`, `start`) and event subscription
   * (`on`). Consumers reach for the sequencer for queue-shape ops; for
   * per-execution state mutation use the ID-addressed verbs below.
   */
  readonly sequencer: Sequencer<ActionItemMetadata<Payload>>;

  // --- ID-addressed engine-slot verbs ---
  // TODO(expansion): replace linear-scan lookup with Map<defId, index> when a
  // consumer surfaces a queue routinely > 100. Today corpus queues <~20.

  setItemState(defId: string, state: ActionItemState): void;
  setItemProgress(defId: string, value: number | Record<string, number>): void;
  tickItemProgress(defId: string, delta: number | Record<string, number>): void;
  setItemError(defId: string, error: { message: string } | null): void;
  patchItemPayload(defId: string, update: Partial<Payload> | ((p: Payload) => Payload)): void;

  // --- Scoped subscriptions ---

  /**
   * Subscribe to changes on a specific def's per-execution metadata. Fires
   * after any engine-slot or payload mutation that targets `defId`. Items
   * stay value-semantics internally; entity-style per-row observation is
   * simulated through subscription discipline (Akka / Temporal pattern).
   */
  onItemChange(
    defId: string,
    fn: (entry: ActionCategoryEntry<Def, State, Payload>) => void,
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
    lifecycle: 'pending',
    progress: initialProgress,
    attempt: 0,
    error: undefined,
    timing: { ...NO_TIMING },
  };
}

function defaultProgressFor(
  hint: number | Record<string, number> | undefined,
): number | Record<string, number> {
  if (hint === undefined) return 0;
  if (typeof hint === 'number') return 0;
  // Multi-bar hint: zero out the same keys so accumulators have stable shape.
  const seed: Record<string, number> = {};
  for (const key of Object.keys(hint)) seed[key] = 0;
  return seed;
}

// === FACTORIES ===

/**
 * Create an action category — batch registration of typed action defs into an
 * ordered-execution queue with per-execution state machine.
 *
 * @param options - Category id, mode, mapAction, mapState, tick registration
 * @returns An {@link ActionCategory} with registry, queue surface, ID-addressed verbs, events
 *
 * @example
 * ```ts
 * interface SpellDef { id: string; baseCastTime: number }
 * interface SpellState { timesCast: Persistent<number> }
 *
 * const spells = createActionCategory<SpellDef, SpellState>({
 *   id: 'spells',
 *   mode: 'queue',
 *   registerTick: ctx.onTick,
 *   mapAction: (def, ctx) => ({
 *     signals: {
 *       unlock: computed(() => true),
 *       count: spells.getEntry(def.id)!.state.timesCast,
 *     },
 *     tick: ({ entry, dt, category }) => {
 *       category.tickItemProgress(def.id, dt);
 *       const progress = category.currentItem!.progress as number;
 *       if (progress >= def.baseCastTime) {
 *         entry.state.timesCast.value++;
 *         category.sequencer.complete();
 *       }
 *     },
 *   }),
 *   mapState: () => ({ timesCast: persistent(0) }),
 * });
 *
 * spells.register({ id: 'fireball', baseCastTime: 2 });
 * spells.enqueue('fireball');
 * ```
 */
export function createActionCategory<Def extends { id: string }, State = void, Payload = void>(
  options: ActionCategoryOptions<Def, State, Payload>,
): ActionCategory<Def, State, Payload> {
  const {
    id: categoryId,
    mode = 'queue',
    mapAction,
    mapState,
    registerTick,
    startOnEnqueue,
    maxSize,
  } = options;

  const mappings = new Map<string, ActionMapping<Def, State, Payload>>();
  const rateChains = new Map<string, ModifierChain>();
  const mapCtx: ActionCategoryContext = { registerTick };

  const handle = createEmitHandle<ActionCategoryEvents<Def, State, Payload>>();
  const itemChangeHandlers = new Map<
    string,
    Set<(entry: ActionCategoryEntry<Def, State, Payload>) => void>
  >();

  // --- Build base + per-def wiring -----------------------------------------

  const base: CategoryBase<Def, void, State> = createCategoryBase<Def, void, State>({
    id: categoryId,
    buildState: mapState ? (def) => mapState(def) : undefined,
    buildSignals: (def, _instance, _state) => {
      const mapping = mappings.get(def.id);
      if (!mapping) {
        // mapAction is invoked below per-def; signals are read after mapping
        // is cached. This branch is defensive — `buildSignals` runs inside the
        // per-def context immediately after `buildState`, before this
        // registerOne call returns, so the mapping must already exist.
        throw new Error(
          `createActionCategory: mapping for ${categoryId}/${def.id} missing during buildSignals`,
        );
      }
      return mapping.signals;
    },
  });

  // Override base.register to install the mapping (and optional rateChain)
  // before createCategoryBase's buildSignals runs, since buildSignals reads
  // from the mappings map.
  const baseRegister = base.register;
  function registerWithMapping(defs: Def | Def[]): void {
    const arr = Array.isArray(defs) ? defs : [defs];
    for (const def of arr) {
      // Build mapping in the def's persistent sub-context so any modifier
      // chains created inside `mapAction` get auto-attribution paths.
      // createCategoryBase opens that context during registerOne; we open
      // a parallel scope here just for the mapping call.
      const mapping = mapAction(def, mapCtx);
      mappings.set(def.id, mapping);
      if (mapping.rateChain) {
        rateChains.set(def.id, createModifierChain(`${categoryId}/${def.id}/rate`));
      }
    }
    baseRegister(arr);
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
    canRun: (item) => {
      const mapping = mappings.get(item.metadata.defId);
      if (!mapping?.canRun) return 'now';
      const entry = makeEntry(item.metadata.defId, item.metadata);
      if (!entry) return 'never';
      return mapping.canRun(entry);
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

  function patchByDefId(
    defId: string,
    patch: (m: ActionItemMetadata<Payload>) => ActionItemMetadata<Payload>,
  ): boolean {
    const cur = sequencer.currentItem;
    if (cur && cur.metadata.defId === defId) {
      sequencer.patchCurrentItem(patch);
      fireItemChange(defId);
      return true;
    }
    const idx = findItemIndexByDefId(defId);
    if (idx >= 0) {
      sequencer.patchItem(idx, patch);
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
  ): ActionCategoryEntry<Def, State, Payload> | undefined {
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

  function getEntry(defId: string): ActionCategoryEntry<Def, State, Payload> | undefined {
    return makeEntry(defId, getCurrentMetadataIfDefId(defId));
  }

  // --- Lifecycle transition helper -----------------------------------------

  function transitionLifecycle(
    defId: string,
    next: ActionItemState,
    extra?: (m: ActionItemMetadata<Payload>) => Partial<ActionItemMetadata<Payload>>,
  ): void {
    patchByDefId(defId, (m) => {
      const from = m.lifecycle;
      if (from === next && !extra) return m;
      const patched: ActionItemMetadata<Payload> = {
        ...m,
        lifecycle: next,
        ...(extra ? extra(m) : {}),
      };
      if (from !== next) {
        const entry = makeEntry(defId, patched);
        if (entry) handle.emit('itemStateChange', entry, from, next);
        if (next === 'completed') handle.emit('complete', entry!);
      }
      return patched;
    });
  }

  // --- Wire sequencer events to lifecycle transitions ----------------------

  sequencer.on('start', (item) => {
    transitionLifecycle(item.metadata.defId, 'running', () => ({
      timing: { startedAt: Date.now() },
    }));
  });

  sequencer.on('hold', (item) => {
    transitionLifecycle(item.metadata.defId, 'waiting');
  });

  sequencer.on('complete', (item) => {
    // `transitionLifecycle` runs the patch + emits 'complete' + 'itemStateChange'.
    // In queue mode the item is already popped from items.value by complete()
    // before this event fires; the patch falls back to the current item path,
    // which has been cleared. Re-construct the entry manually so observers
    // still see the terminal state.
    const meta = item.metadata;
    const terminal: ActionItemMetadata<Payload> = {
      ...meta,
      lifecycle: 'completed',
      timing: { ...meta.timing, completedAt: Date.now() },
    };
    const entry = makeEntry(meta.defId, terminal);
    if (!entry) return;
    if (meta.lifecycle !== 'completed') {
      handle.emit('itemStateChange', entry, meta.lifecycle, 'completed');
    }
    handle.emit('complete', entry);
    fireItemChange(meta.defId);
  });

  sequencer.on('cancel', (item) => {
    const entry = makeEntry(item.metadata.defId, item.metadata);
    if (entry) handle.emit('cancel', entry);
    fireItemChange(item.metadata.defId);
  });

  sequencer.on('skip', (item) => {
    // Skip means canRun returned 'never'. Surface as terminal 'failed' so UI
    // can show the skip in the same channel as explicit setItemError.
    const meta = item.metadata;
    const terminal: ActionItemMetadata<Payload> = { ...meta, lifecycle: 'failed' };
    const entry = makeEntry(meta.defId, terminal);
    if (!entry) return;
    if (meta.lifecycle !== 'failed') {
      handle.emit('itemStateChange', entry, meta.lifecycle, 'failed');
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
    profile(`${categoryId}/${defId}/tick`, () => mapping.tick!({ entry, dt, category }));
  });

  // --- Public category surface ---------------------------------------------

  const category: ActionCategory<Def, State, Payload> = {
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
      const meta = buildInitialMetadata(defId, payload, defaultProgressFor(undefined));
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
        if (entry) handle.emit('cancel', entry);
        fireItemChange(defId);
      }
    },

    get currentItem() {
      return sequencer.currentItem?.metadata ?? null;
    },

    setItemState(defId, state) {
      transitionLifecycle(defId, state);
    },

    setItemProgress(defId, value) {
      patchByDefId(defId, (m) => ({ ...m, progress: value }));
    },

    tickItemProgress(defId, delta) {
      patchByDefId(defId, (m) => {
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
        patchByDefId(defId, (m) => (m.error === undefined ? m : { ...m, error: undefined }));
        return;
      }
      patchByDefId(defId, (m) => ({
        ...m,
        error: { message: error.message, at: Date.now() },
        attempt: m.attempt + 1,
      }));
      transitionLifecycle(defId, 'failed');
    },

    patchItemPayload(defId, update) {
      patchByDefId(defId, (m) => {
        const nextPayload =
          typeof update === 'function'
            ? (update as (p: Payload) => Payload)(m.payload)
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

  // Engine-categories discovery hook.
  const ec = getCurrentEngineCategories();
  if (ec) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ec.actions ??= [] as ActionCategory<any, any, any>[]).push(category);
  }

  return category;
}

// === PUBLIC UTILITIES ===

/**
 * Type guard: a Decimal-ish accumulator on a multi-bar progress slot.
 * Helper for consumers that mix engine-managed progress (plain number) with
 * sibling Decimal accumulators in `entry.state`. Not used internally.
 *
 * @internal
 */
export function isMultiBarProgress(
  progress: number | Record<string, number>,
): progress is Record<string, number> {
  return typeof progress !== 'number';
}

/** Coerce a plain progress value to Decimal for downstream rate-math composition. */
export function progressToDecimal(
  progress: number | Record<string, number>,
  key?: string,
): DecimalSource {
  if (typeof progress === 'number') return progress;
  if (key !== undefined) return progress[key] ?? 0;
  // Sum named bars when no key specified.
  let total: DecimalSource = 0;
  for (const v of Object.values(progress)) total = Decimal.add(total, v);
  return total;
}
