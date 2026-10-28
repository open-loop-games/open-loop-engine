/**
 * Sequencer — core primitive for ordered execution of items with optional metadata.
 *
 * A persistent, ordered sequence of items with optional per-item typed metadata:
 * - Current item tracking (what's actively running)
 * - Manual mutation (enqueue, remove, reorder)
 * - Pluggable fill strategy for automation (priority, round-robin, etc.)
 * - Lifecycle events
 *
 * Two modes:
 * - **queue** (default) — items are removed on completion (pop from front)
 * - **list** — items stay, and a cursor advances through them. Call
 *   `resetCursor()` to replay from the start (e.g., when a run ends). It moves
 *   only the cursor: per-run state kept in item metadata stays as it is unless
 *   the consumer resets it first.
 *
 * Generic over metadata type M. When M = void the sequencer behaves like a
 * simple string-ID queue, but `metadata` is still a required field: write
 * items as `{ id, metadata: undefined }`.
 *
 * @cluster sequencer
 */

import { shallowRef, watch } from 'vue';
import { createEmitHandle } from './events';
import { persistent, withPersistentContext, type Persistent } from './persistence';
import { attachPersistentContextReset } from './resettable';
import { reportAdvanceCapTrip } from './safeguards';

// === TYPES ===

/**
 * A sequencer item: a string id plus typed metadata. `metadata` is required
 * even when `M` is `void` — pass `metadata: undefined`. Saves hold metadata as
 * JSON, so keep it JSON-plain: a `Decimal` in it loads back as its string.
 */
export interface SequencerItem<M = void> {
  id: string;
  metadata: M;
}

/**
 * Tri-state precondition result from a {@link SequencerOptions.canStart} check.
 *
 * - `'now'` — start the item
 * - `'never'` — it can never run: skip it and advance
 * - `'notNow'` — blocked for now: **hold** the item in place and retry next tick
 *
 * The `'notNow'` case is the point of this shape: it lets a sequencer
 * express "can't start right now, but check again later" distinct from
 * "can't ever start." When `'notNow'` is returned without a
 * {@link SequencerOptions.registerTick} function, it degrades to `'never'`.
 */
export type StartResult = 'now' | 'notNow' | 'never';

/**
 * Tick registration — subscribes a tick handler and returns its unsubscribe.
 * Matches `EngineContext.onTick`; pass `ctx.onTick` directly.
 *
 * The handler's `dt` is game seconds. A hand-built one must pass seconds too,
 * because the rates it drives are per second (`ProducerMapping.baseRate`, for
 * one). To fire on a game event such as a day boundary, pass the seconds since
 * the last call, or use a manual producer's `activate()` instead.
 *
 * It must accept any number of handlers and run every one each tick. A
 * factory may register several: `createActionCategory` registers its
 * sequencer's advance-cap reset and its own tick handler. A wrapper that keeps
 * only the latest handler type-checks, then silently ignores the rest. For a
 * sequencer the cap then never resets, and `advanceCapTrips` climbs while
 * nothing runs.
 */
export type RegisterTick = (callback: (dt: number) => void) => () => void;

/**
 * Fill strategy: the sequencer's next-item chooser when it has nothing to run.
 * Its closure captures whatever state it needs (candidates, priorities, a
 * persistent index for round-robin, etc.).
 */
export interface FillStrategy<M = void> {
  /** Return the next item to run, or null if nothing should fill. */
  next(): SequencerItem<M> | null;
}

/** Events emitted during sequencer lifecycle. Subscribe via `sequencer.on()`. */
export interface SequencerEvents<M = void> {
  enqueued: (item: SequencerItem<M>) => void;
  started: (item: SequencerItem<M>) => void;
  completed: (item: SequencerItem<M>) => void;
  cancelled: (item: SequencerItem<M>) => void;
  /** Emitted when the current item starts again via `repeat()` instead of `complete()`. */
  repeated: (item: SequencerItem<M>) => void;
  /**
   * Emitted when an item fails its `canStart` check with `'never'`. That comes
   * from `dequeueNext` walking the sequence, or from the retry tick when a held
   * item's check returns `'never'`.
   *
   * The skip is already done when this is emitted. In queue mode the item has
   * been popped, and in list mode `cursor` has advanced past it. A handler that
   * wants the skipped item's index reads `cursor - 1`.
   */
  skipped: (item: SequencerItem<M>) => void;
  /**
   * Emitted when dequeueNext holds on `'notNow'` — the held item stays in
   * `items` and the retry tick re-checks it each later tick. The hold ends
   * when canStart returns `'now'` (start) or `'never'` (skip).
   */
  held: (item: SequencerItem<M>) => void;
}

/** Default maximum advances per tick before the sequencer pauses advancement. */
export const DEFAULT_MAX_ADVANCES_PER_TICK = 1000;

/**
 * Options for {@link createSequencer}. `mode` picks queue (remove on complete)
 * or list (a cursor walks a persistent list). `canStart` and `registerTick` wire
 * the tri-state pre-start check (`now` / `notNow` / `never`) and its retry tick.
 */
export interface SequencerOptions<M = void> {
  /** Unique id — also the persistent context id */
  id: string;
  /**
   * Sequencer behavior mode (default: 'queue').
   * - `'queue'` — items are removed on completion
   * - `'list'` — items stay, and a cursor advances through them
   */
  mode?: 'queue' | 'list';
  /** Maximum number of items in the waiting sequence (default: unlimited) */
  maxSize?: number;
  /**
   * Maximum number of complete→dequeueNext advances allowed per tick.
   * Prevents runaway loops when items complete instantly. This is the only cap
   * a cascade of starts hits. The chain is flattened rather than recursive, so
   * emit depth stays constant however long the cascade runs. Once the cap is
   * reached, advancement waits until the counter resets and continues on the
   * next tick. The running item is left fully started, never half-started.
   *
   * When {@link registerTick} is supplied the counter resets automatically at
   * each tick boundary, and the tick after the cap is reached starts items again.
   * A sequencer driven manually without `registerTick` must call
   * {@link resetAdvanceCount} at the start of each tick. Otherwise the cap
   * counts every advance since creation, and dequeueNext stalls once their
   * total passes it. After the cap is reached, it must also call
   * `dequeueNext()` itself to resume.
   * Default: {@link DEFAULT_MAX_ADVANCES_PER_TICK} (1000).
   */
  maxAdvancesPerTick?: number;
  /**
   * Pre-start check called by dequeueNext before starting an item. Returns a
   * tri-state {@link StartResult}:
   *
   * - `'now'` — start the item
   * - `'never'` — skip the item (emits `skipped`) and try the next one
   * - `'notNow'` — **hold the item** (emits `held`); the item remains in
   *   place and is re-checked by the retry tick next tick
   *
   * Fill-strategy results are checked lightly. A fill item that returns
   * anything other than `'now'` is discarded. Fill never enters a hold,
   * because fill strategies are expected to return runnable items.
   *
   * `'notNow'` requires {@link registerTick}. Without it, `'notNow'`
   * silently degrades to `'never'`.
   */
  canStart?: (item: SequencerItem<M>) => StartResult;
  /**
   * Tick registration, used twice: the per-tick advance-cap reset (see
   * {@link maxAdvancesPerTick}), and the `'notNow'` retry path. When a canStart
   * call returns `'notNow'`, the sequencer registers a retry handler through this
   * function. It then calls canStart each tick until it returns `'now'` or
   * `'never'`. Without this, `'notNow'` falls back to `'never'`.
   *
   * Must run every handler it is given — see {@link RegisterTick}.
   */
  registerTick?: RegisterTick;
  /**
   * Whether enqueue() auto-starts execution when the sequencer is empty and not paused.
   * Default: `true` — the first enqueued item starts immediately.
   *
   * Set to `false` for "planning mode" where items are queued without execution.
   * Use {@link Sequencer.start start()} to begin execution explicitly.
   */
  startOnEnqueue?: boolean;
}

/**
 * Sequencer instance produced by {@link createSequencer}. Holds the current
 * item plus the waiting list, both saved and loaded. It emits lifecycle events
 * (`started` / `completed` / `skipped` / `held`) that consumers wire to game flow.
 */
export interface Sequencer<M = void> {
  readonly id: string;
  /** The mode this sequencer was created with ('queue' or 'list'). */
  readonly mode: 'queue' | 'list';

  // --- Persistent state ---
  /** Raw persistent string for the current item. Prefer currentItem for typed access. */
  readonly current: Persistent<string>;
  /**
   * Waiting items (in list mode, the whole list). Reads are reactive, but
   * `items` is not a Ref: watch it through a getter, `() => seq.items.value`.
   *
   * Assigning `items.value = [...]` replaces the list wholesale and saves it.
   * It is a raw escape hatch. It skips `maxSize` and emits no events. It leaves
   * the running item alone, doesn't move or clamp the list-mode cursor, and
   * doesn't start anything. During a hold, the retry tick re-checks whichever item is
   * now at the head (or the cursor). Use `enqueue` / `remove` / `reorder` / `clear`
   * when those guarantees matter.
   */
  readonly items: { value: SequencerItem<M>[] };
  /** Whether the sequencer is paused. */
  readonly paused: Persistent<boolean>;

  // --- Typed accessors ---
  /** Current item with metadata, or null if nothing running. */
  readonly currentItem: SequencerItem<M> | null;
  /** Metadata of the current item, or undefined if nothing running. */
  readonly currentMetadata: M | undefined;

  // --- Mutation operations ---
  /**
   * Insert an item into the waiting sequence. Auto-starts if nothing running.
   *
   * @param item - The item to insert.
   * @param options - Optional. `at` selects an insert index:
   * - omitted or `>= items.value.length` → append (default)
   * - `0` → prepend (front-insert; covers interrupt / push-to-front)
   * - `0 < at < items.value.length` → arbitrary-position insert
   *
   * Negative `at` throws `RangeError`.
   *
   * Returns `false` when `maxSize` would be exceeded; the item is not inserted
   * and no event fires. Positional inserts run the same `maxSize`, `enqueued`
   * event emit, and auto-start guard as the append path.
   */
  enqueue(item: SequencerItem<M>, options?: { at?: number }): boolean;
  /**
   * Pop from items → set as current. Falls back to the fill strategy if items is empty.
   *
   * Returns the started item, or `null` when nothing started. Calling it
   * from inside a sequencer event handler always returns `null`. The start
   * is deferred to the call already in progress, which runs it once the emit
   * unwinds. A handler that needs the item should read {@link currentItem}
   * afterwards rather than the return value.
   */
  dequeueNext(): SequencerItem<M> | null;
  /** Mark current as completed, emit 'completed', then dequeueNext. */
  complete(): void;
  /** Start the current item again without advancing. Emits 'repeated', then dequeueNext. */
  repeat(): void;
  /**
   * Replace the metadata of the current item with the result of `patch(currentMetadata)`.
   * No-op when no current item. Both modes trigger reactive updates. In list mode
   * the updated metadata is copied to the cursor position in `items.value`. In
   * queue mode the running item is no longer in `items.value`, so the updated
   * metadata is serialized again into the underlying current persistent ref.
   *
   * @example
   * ```ts
   * seq.updateCurrentItem((m) => ({ ...m, ticks: m.ticks + 1 }));
   * ```
   */
  updateCurrentItem(patch: (metadata: M) => M): void;
  /**
   * Replace the metadata of the item at the given `items.value` index. No-op when
   * out of range. Triggers reactive updates on `items.value` by replacing the item
   * at that index; other items keep their object identity. In queue mode
   * the running item is no longer in `items.value` — use `updateCurrentItem` for
   * that case.
   *
   * @example
   * ```ts
   * seq.updateItem(3, (m) => ({ ...m, errorMessage: 'blocked' }));
   * ```
   */
  updateItem(index: number, patch: (metadata: M) => M): void;
  /**
   * Cancel the current execution without completing it and emit `cancelled`.
   * That is the running item or, while {@link holding}, the held one. Queue
   * mode removes it. List mode leaves the cursor on it, so a later start re-runs
   * it. Execution then stops — nothing starts until `start()`, `resume()`
   * or an auto-starting `enqueue()`.
   */
  cancel(): void;
  /** Remove an item from the waiting sequence by index. */
  remove(index: number): void;
  /** Reorder an item in the waiting sequence. */
  reorder(from: number, to: number): void;
  /**
   * Clear all items from the waiting sequence. Cancels the current (or held)
   * item first, so a completion can't advance the list cursor past items
   * enqueued afterwards. Execution stops until `start()`, `resume()` or an
   * auto-starting `enqueue()`.
   */
  clear(): void;

  // --- Direct current management ---
  /** Set a specific item as current (outside the sequence). Used for interrupts. */
  setCurrent(item: SequencerItem<M>): void;

  // --- Control ---
  pause(): void;
  resume(): void;
  togglePause(): void;
  /**
   * Explicitly begin execution from the sequence. Calls dequeueNext if nothing
   * is currently running and the sequencer is not paused.
   *
   * Use when `startOnEnqueue: false` — enqueue items first, then call `start()`
   * to begin execution (e.g., after planning is complete).
   */
  start(): void;

  // --- Fill strategy ---
  /** Pluggable fill strategy for automation. Default: null (no auto-fill). */
  fillStrategy: FillStrategy<M> | null;
  /** Manually trigger the fill strategy. Returns the filled item or null. */
  fill(): SequencerItem<M> | null;

  // --- Pre-start check ---
  /**
   * Optional tri-state pre-start check. Can be set or cleared after creation:
   * setting to `null` ends any hold. Setting to a new function
   * does not eagerly re-evaluate — the next retry tick (or dequeueNext call)
   * picks it up.
   */
  canStart: ((item: SequencerItem<M>) => StartResult) | null;

  /**
   * Whether the sequencer is currently holding on a `'notNow'` item. While
   * holding, `currentItem` is null, `items.value` is unchanged, and the
   * retry tick runs. Reactive, but ephemeral: not saved.
   */
  readonly holding: boolean;

  // --- List mode ---
  /**
   * Index of the currently running item in the list (list mode only).
   * Points AT the running item during execution. Equals `items.value.length`
   * when all items are complete (done sentinel).
   * In queue mode, always returns 0.
   */
  readonly cursor: number;
  /**
   * Cancel the current execution as {@link cancel} does, running or held,
   * then reset the cursor to 0 (list mode only). If not paused, auto-starts
   * from the beginning.
   * No-op in queue mode. Item metadata is left as it is, so per-run state kept
   * there (progress, say) must be reset before replaying.
   */
  // TODO(ergonomics): accept optional `toIndex: number` for arbitrary-position
  // cursor jumps (e.g. a repeat-from-marker jump). Deferred until
  // an in-repo consumer needs it.
  resetCursor(): void;

  // --- Safeguards ---
  /**
   * Reset the per-tick advance counter so the sequencer can advance again after
   * hitting its cap. Called automatically each tick when {@link registerTick} is
   * supplied; call it manually at the start of each game tick when driving the
   * sequencer without `registerTick`.
   */
  resetAdvanceCount(): void;

  // --- Events ---
  on<K extends keyof SequencerEvents<M>>(event: K, handler: SequencerEvents<M>[K]): () => void;
}

// === SERIALIZATION HELPERS ===

function serializeItem<M>(item: SequencerItem<M>): string {
  if ((item.metadata as unknown) === undefined || (item.metadata as unknown) === null) {
    return item.id;
  }
  return JSON.stringify({ id: item.id, m: item.metadata });
}

function deserializeItem<M>(raw: string): SequencerItem<M> {
  if (raw === '') return { id: '', metadata: undefined as M };
  // Try JSON object format first
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { id: string; m: M };
      return { id: parsed.id, metadata: parsed.m };
    } catch {
      // Fall through to plain string
    }
  }
  return { id: raw, metadata: undefined as M };
}

// === FACTORY ===

/**
 * Creates a persistent sequencer that manages ordered execution of items,
 * supporting both FIFO queue mode and repeating list mode with cursor.
 *
 * @param options - Sequencer options: mode, size limits, and optional
 *   pre-start checks via `canStart`
 * @returns A sequencer with enqueue/dequeue/reorder operations, pause/resume control,
 *   pluggable fill strategies, and persistent state
 *
 * @example
 * ```ts
 * const seq = createSequencer<{ kind: string }>({
 *   id: 'combat-queue',
 *   mode: 'queue',
 *   maxSize: 10,
 * });
 * seq.enqueue({ id: 'slash', metadata: { kind: 'melee' } });
 * seq.on('completed', (item) => console.log(`Finished ${item.id}`));
 * ```
 */
export function createSequencer<M = void>(options: SequencerOptions<M>): Sequencer<M> {
  const {
    id,
    mode = 'queue',
    maxSize = Infinity,
    maxAdvancesPerTick = DEFAULT_MAX_ADVANCES_PER_TICK,
    startOnEnqueue = true,
    registerTick,
  } = options;
  const isList = mode === 'list';

  // === PERSISTENT STATE ===

  const { current, rawItems, paused, rawCursor } = withPersistentContext(id, () => ({
    current: persistent<string>('', { id: 'current' }),
    rawItems: persistent<string>('', { id: 'rawItems' }),
    paused: persistent<boolean>(false, { id: 'paused' }),
    rawCursor: isList ? persistent<number>(0, { id: 'rawCursor' }) : null,
  }));

  // === ITEMS VIEW + SERIALIZATION ===
  // `_liveItems` + `_head` is the canonical in-memory form; `rawItems` is the
  // JSON-serialized persistent-ref form used only for save/load. Dequeue pops
  // advance `_head` in O(1) instead of slicing a fresh array; mutations
  // batch-sync via `syncItems()` so bursts of pops or skips serialize once
  // instead of once per pop or skip.

  function deserializeItems(raw: string): SequencerItem<M>[] {
    if (raw === '') return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.map((entry: unknown) => {
        if (typeof entry === 'string') {
          // Older save shape: plain string array
          return deserializeItem<M>(entry);
        }
        // Current save shape: { id, m } objects
        const obj = entry as { id: string; m: M };
        return { id: obj.id, metadata: obj.m };
      });
    } catch {
      // Older save shape: comma-delimited
      return raw.split(',').map((s) => deserializeItem<M>(s));
    }
  }

  function serializeItems(arr: SequencerItem<M>[]): string {
    if (arr.length === 0) return '';
    return JSON.stringify(
      arr.map((item) => {
        if ((item.metadata as unknown) === undefined || (item.metadata as unknown) === null) {
          return item.id;
        }
        return { id: item.id, m: item.metadata };
      }),
    );
  }

  let _liveItems: SequencerItem<M>[] = deserializeItems(rawItems.value);
  let _head = 0;
  let _viewCache: SequencerItem<M>[] | null = null;
  let _viewVersion = 0;
  // Reactive so Vue computeds/watchers reading `items.value` register a
  // dependency on sequencer mutations. `bumpLive()` advances it; every
  // `currentView()` call reads it once to establish tracking.
  const _liveVersion = shallowRef(0);
  // Last string we wrote to `rawItems` via syncItems — lets the load watcher
  // below skip a no-op rebuild when our own sync echoes back.
  let _lastWritten = rawItems.value;

  function bumpLive(): void {
    _liveVersion.value++;
  }

  function currentView(): SequencerItem<M>[] {
    // Always return a fresh slice on version change so consumers get a new
    // reference after mutation (reactivity watchers, identity assertions).
    // Cached between reads when no mutation occurred so repeated reads are
    // referentially stable.
    const version = _liveVersion.value;
    if (_viewCache !== null && _viewVersion === version) return _viewCache;
    _viewCache = _liveItems.slice(_head);
    _viewVersion = version;
    return _viewCache;
  }

  function syncItems(): void {
    // Compact the head prefix once it's large enough to matter, so burst
    // pop sequences don't leak memory via a stale `_liveItems[0.._head]`.
    if (_head > 0 && _head * 2 > _liveItems.length) {
      _liveItems = _liveItems.slice(_head);
      _head = 0;
      bumpLive();
    }
    const serialized = serializeItems(currentView());
    _lastWritten = serialized;
    rawItems.value = serialized;
  }

  function updateItemInternal(index: number, patch: (metadata: M) => M): boolean {
    const viewLen = _liveItems.length - _head;
    if (index < 0 || index >= viewLen) return false;
    const liveIdx = _head + index;
    const existing = _liveItems[liveIdx];
    _liveItems[liveIdx] = { id: existing.id, metadata: patch(existing.metadata) };
    bumpLive();
    syncItems();
    return true;
  }

  // Load rebuild: when `rawItems` changes from outside our own `syncItems`
  // writes (i.e. the save manager loading a save), deserialize it again into
  // the live array. Flush sync so the new state is visible immediately.
  watch(
    () => rawItems.value,
    (newRaw) => {
      if (newRaw === _lastWritten) return;
      if (_holding.value) clearHold();
      _liveItems = deserializeItems(newRaw);
      _head = 0;
      bumpLive();
      _lastWritten = newRaw;

      // Hold state is ephemeral (see § HOLD STATE), so a save taken while
      // holding on a 'notNow' item loads with current='' and the held item
      // still queued — a silent permanent stall unless we re-drive. Start it
      // on the next tick via a one-shot registerTick: deferred so `paused` and
      // `rawCursor` (which deserialize *after* rawItems) are read at their
      // loaded values rather than mid-load, and self-unregistering so it leaves
      // no running watcher behind. Only when startOnEnqueue is set, so
      // explicit-control sequencers stay put until the consumer calls start();
      // the hold path requires registerTick, so its absence means no hold
      // stall can exist.
      if (startOnEnqueue && registerTick && current.value === '' && _liveItems.length > 0) {
        const unsubRedrive = registerTick(() => {
          unsubRedrive();
          dequeueNext();
        });
      }
    },
    { flush: 'sync' },
  );

  const items = {
    get value(): SequencerItem<M>[] {
      return currentView();
    },
    set value(arr: SequencerItem<M>[]) {
      _liveItems = arr;
      _head = 0;
      bumpLive();
      syncItems();
    },
  };

  // === RUNTIME STATE ===

  const handle = createEmitHandle<SequencerEvents<M>>();
  let _fillStrategy: FillStrategy<M> | null = null;
  let _canStart: ((item: SequencerItem<M>) => StartResult) | null = options.canStart ?? null;
  let _advancesThisTick = 0;
  let _advanceCapHit = false;

  // === HOLD STATE ===
  // Ephemeral, not saved. A save taken mid-hold loads with the held item
  // still queued and current=''; the rawItems load watch above re-drives it
  // on the next tick after the load.

  const _holding = shallowRef(false);
  let _unsubRetryTick: (() => void) | null = null;

  function peekHeldItem(): SequencerItem<M> | null {
    if (isList) {
      const arr = items.value;
      const pos = rawCursor!.value;
      return pos < arr.length ? arr[pos] : null;
    }
    const arr = items.value;
    return arr.length > 0 ? arr[0] : null;
  }

  function clearHold(): void {
    _holding.value = false;
    _unsubRetryTick?.();
    _unsubRetryTick = null;
  }

  function installRetryTick(): void {
    if (!registerTick || _unsubRetryTick) return;
    _unsubRetryTick = registerTick(() => {
      if (!_holding.value) return;
      if (paused.value) return;
      retryHeldItem();
    });
  }

  function popHead(): void {
    _head++;
    bumpLive();
  }

  function retryHeldItem(): void {
    const held = peekHeldItem();
    if (!held) {
      // Held item vanished (clear/remove/reorder removed it) — exit hold
      // and let the next dequeueNext call re-drive the state machine.
      clearHold();
      dequeueNext();
      return;
    }
    const result = _canStart ? _canStart(held) : 'now';
    if (result === 'now') {
      clearHold();
      // Consume the held item (pop in queue mode; cursor stays put in list
      // mode since the cursor already points AT this item).
      if (!isList) {
        popHead();
        syncItems();
      }
      setCurrentRaw(held);
      handle.emit('started', held);
    } else if (result === 'never') {
      clearHold();
      if (isList) {
        rawCursor!.value++;
        handle.emit('skipped', held);
      } else {
        popHead();
        syncItems();
        handle.emit('skipped', held);
      }
      dequeueNext();
    }
    // 'notNow' — stay held, retry again next tick.
  }

  // === CURRENT ITEM CACHE ===
  // Decoded form of `current.value`, kept stable across reads for referential
  // identity until the underlying string changes.

  let _cachedCurrentItem: SequencerItem<M> | null = null;
  let _cachedCurrentRaw = '';

  function getCurrentItem(): SequencerItem<M> | null {
    const raw = current.value;
    if (raw === '') {
      _cachedCurrentItem = null;
      _cachedCurrentRaw = '';
      return null;
    }
    if (_cachedCurrentItem !== null && raw === _cachedCurrentRaw) return _cachedCurrentItem;
    _cachedCurrentItem = deserializeItem<M>(raw);
    _cachedCurrentRaw = raw;
    return _cachedCurrentItem;
  }

  function setCurrentRaw(item: SequencerItem<M>): void {
    current.value = serializeItem(item);
  }

  // === FILL + DEQUEUE ===

  let _filling = false;

  function fill(): SequencerItem<M> | null {
    // Guard: if a fill-provided item fails to start, the runner calls
    // sequencer.complete() → dequeueNext() → fill() again synchronously.
    // Without this guard that's infinite recursion / stack overflow.
    if (_filling) return null;
    if (!_fillStrategy) return null;
    const item = _fillStrategy.next();
    if (item == null) return null;
    // Fill items are checked lightly: only 'now' starts. 'never' and
    // 'notNow' both discard the item — fill never enters a hold because fill
    // strategies are expected to return runnable items.
    if (_canStart) {
      const result = _canStart(item);
      if (result !== 'now') return null;
    }
    _filling = true;
    try {
      setCurrentRaw(item);
      handle.emit('started', item);
      return item;
    } finally {
      _filling = false;
    }
  }

  // Emits are synchronous, so a handler can start an item underneath a walk
  // that is already in progress, or ahead of a caller's trailing `dequeueNext()`
  // (complete/repeat/resetCursor all emit, then call). Starting a second
  // item over a set `current` overwrites it with no terminal event, orphaning
  // the running item. Every other emitter in the engine iterates a snapshot
  // taken before the first emit and so is necessarily immune; `dequeueNext`
  // is a cursor over live state and cannot be, so the invariant — never
  // start over a set current — is enforced here rather than at each
  // callsite. Checked at entry and again per pass of the loop: the two
  // re-entry shapes (a caller's trailing call, and a handler re-entering
  // from inside the loop) need both.
  const preempted = (): boolean => current.value !== '';

  // An instant-complete handler drives starts by recursion: `emit('started')`
  // → handler → `complete()` → `emit('completed')` → `dequeueNext()` →
  // `emit('started')`. Left recursive, each item costs a real JS stack level and
  // a level on the emit handle's depth counter, so the emit-depth cap ends the
  // cascade after ten items — mid-start, with `current` already set and its
  // `started` emit blocked, which is a permanent stall rather than a pause.
  // Trampolining the re-entrant call flattens the chain to constant depth: a
  // handler's `dequeueNext()` records the intent and returns, and the loop
  // below runs the start after the emit unwinds. That keeps depth near 1 for
  // any cascade length and leaves `maxAdvancesPerTick` as the only cap that
  // is reached, which is what its contract promises.
  //
  // Any unbounded cascade must re-enter *some* sequencer's `dequeueNext`, so
  // this also flattens chains routed through a second sequencer's handlers —
  // per-instance emit-depth counters cannot see those at all.
  let _dispatching = false;
  let _redispatch = false;

  function dequeueNext(): SequencerItem<M> | null {
    if (_dispatching) {
      _redispatch = true;
      return null;
    }
    _dispatching = true;
    try {
      // Return the first start, matching the recursive form: the outer
      // caller receives the item it caused, not whatever the cascade ended on.
      const first = dequeueOnce();
      while (_redispatch) {
        _redispatch = false;
        dequeueOnce();
      }
      return first;
    } finally {
      _dispatching = false;
      _redispatch = false;
    }
  }

  function dequeueOnce(): SequencerItem<M> | null {
    if (paused.value) return null;
    // While holding, the retry tick owns the start decision — anything
    // enqueued meanwhile waits behind the held item.
    if (_holding.value) return null;
    if (preempted()) return null;

    if (++_advancesThisTick > maxAdvancesPerTick) {
      if (!_advanceCapHit) {
        _advanceCapHit = true;
        reportAdvanceCapTrip(id, _advancesThisTick);
      }
      return null;
    }

    if (isList) {
      // List mode: cursor points AT the running item; peek, don't advance
      // past items on 'now' — advance only on 'never' (skip) or 'hold'
      // exit via the retry path.
      while (rawCursor!.value < items.value.length) {
        if (preempted()) return null;
        const next = items.value[rawCursor!.value];
        const result = _canStart ? _canStart(next) : 'now';

        if (result === 'now') {
          setCurrentRaw(next);
          handle.emit('started', next);
          return next;
        }

        if (result === 'never') {
          rawCursor!.value++;
          handle.emit('skipped', next);
          continue;
        }

        // 'notNow'
        if (registerTick) {
          _holding.value = true;
          installRetryTick();
          handle.emit('held', next);
          return null;
        }
        // No registerTick → degrade to 'never'
        rawCursor!.value++;
        handle.emit('skipped', next);
      }

      // Reached end of list — cursor is at items.length (done sentinel)
      return preempted() ? null : fill();
    }

    // Queue mode: peek live head; pop in-place via _head++. We sync to
    // rawItems at most once when the loop ends, so a burst of skips +
    // a single start costs O(n) serialization instead of O(n²).
    let dirty = false;
    try {
      while (_head < _liveItems.length) {
        if (preempted()) return null;
        const next = _liveItems[_head];
        const result = _canStart ? _canStart(next) : 'now';

        if (result === 'now') {
          popHead();
          dirty = true;
          setCurrentRaw(next);
          handle.emit('started', next);
          return next;
        }

        if (result === 'never') {
          popHead();
          dirty = true;
          handle.emit('skipped', next);
          continue;
        }

        // 'notNow'
        if (registerTick) {
          _holding.value = true;
          installRetryTick();
          handle.emit('held', next);
          return null;
        }
        // No registerTick → degrade to 'never'
        popHead();
        dirty = true;
        handle.emit('skipped', next);
      }
    } finally {
      if (dirty) syncItems();
    }

    // Queue empty — try fill strategy
    return preempted() ? null : fill();
  }

  // === PUBLIC INTERFACE ===

  const sequencer: Sequencer<M> = {
    id,
    mode,
    current,
    items,
    paused,

    get currentItem() {
      return getCurrentItem();
    },
    get currentMetadata() {
      return getCurrentItem()?.metadata;
    },

    enqueue(item: SequencerItem<M>, options?: { at?: number }): boolean {
      const viewLen = _liveItems.length - _head;
      if (viewLen >= maxSize) return false;

      const at = options?.at;
      if (at !== undefined && at < 0) {
        throw new RangeError(`Sequencer.enqueue: negative 'at' (${at}) not supported`);
      }
      const isAppend = at === undefined || at >= viewLen;

      // List-mode hold breaks only when the insert goes AT the cursor with
      // no running item (the cursor's "next start" position now points at the
      // new item rather than the held one). For at < cur the cursor shifts
      // and the held item stays tracked; for at > cur nothing changes.
      const heldBroken =
        _holding.value && !isAppend && (isList ? at === rawCursor!.value : at === 0);

      if (isAppend) {
        _liveItems.push(item);
      } else {
        // Splice into the live array offset by _head so the public view sees
        // the insert at the requested index. `at` here is 0..viewLen-1.
        _liveItems.splice(_head + at, 0, item);
        if (isList) {
          const cur = rawCursor!.value;
          // Cursor follows when the insert goes behind it (cursor's
          // already-passed prefix grew by one). At-cursor only shifts when a
          // running item must stay tracked; when current is empty, the
          // cursor is a "next start" pointer and the inserted item
          // should become next.
          if (at < cur || (at === cur && current.value !== '')) {
            rawCursor!.value = cur + 1;
          }
        }
      }
      bumpLive();
      syncItems();
      handle.emit('enqueued', item);

      if (heldBroken) {
        clearHold();
        dequeueNext();
        return true;
      }

      // Auto-start; dequeueNext owns the running/paused/holding preconditions.
      if (startOnEnqueue) {
        dequeueNext();
      }
      return true;
    },

    dequeueNext,

    complete(): void {
      const completed = getCurrentItem();
      if (!completed) return;
      current.value = '';
      // List mode: advance cursor past the completed item before dequeuing next
      if (isList) {
        rawCursor!.value++;
      }
      handle.emit('completed', completed);
      dequeueNext();
    },

    repeat(): void {
      const captured = getCurrentItem();
      if (!captured) return;
      current.value = '';
      // Queue mode: the item was popped via _head++ when it became current,
      // so restore it to the start position. List mode: cursor already
      // points AT this item; intentionally skip complete()'s `rawCursor++`.
      if (!isList) {
        _liveItems.splice(_head, 0, captured);
        bumpLive();
        syncItems();
      }
      handle.emit('repeated', captured);
      dequeueNext();
    },

    updateCurrentItem(patch: (metadata: M) => M): void {
      if (isList) {
        // Running item is also at _liveItems[head + cursor]; patch there
        // and mirror onto current.value so getCurrentItem()/currentMetadata
        // observers see the new metadata.
        const cur = rawCursor!.value;
        if (current.value === '') return;
        if (!updateItemInternal(cur, patch)) return;
        setCurrentRaw(_liveItems[_head + cur]);
        return;
      }
      // Queue mode: the started item is in current.value only (popped from
      // _liveItems via _head++ on start). Serialize again with the patched meta.
      const captured = getCurrentItem();
      if (!captured) return;
      setCurrentRaw({ id: captured.id, metadata: patch(captured.metadata) });
    },

    updateItem(index: number, patch: (metadata: M) => M): void {
      updateItemInternal(index, patch);
    },

    cancel(): void {
      // A held item is the execution in progress, so it is cancelled as a
      // running one would be: removed in queue mode, left under the cursor in
      // list mode. Nothing is running while holding.
      if (_holding.value) {
        const held = peekHeldItem();
        clearHold();
        if (!held) return;
        if (!isList) {
          popHead();
          syncItems();
        }
        handle.emit('cancelled', held);
        return;
      }
      const cancelled = getCurrentItem();
      if (!cancelled) return;
      current.value = '';
      handle.emit('cancelled', cancelled);
    },

    remove(index: number): void {
      const viewLen = _liveItems.length - _head;
      if (index < 0 || index >= viewLen) return;
      _liveItems.splice(_head + index, 1);
      bumpLive();
      syncItems();
      if (isList) {
        const cur = rawCursor!.value;
        if (index < cur) {
          rawCursor!.value--;
        } else if (index === cur && current.value !== '') {
          // Active item removed; predecrement so complete()'s cursor++ moves
          // to whatever shifted into that position.
          rawCursor!.value--;
        }
      }
      // If the removal affected the held position (queue head in queue mode,
      // or at-or-before cursor in list mode), end the hold and re-drive.
      if (_holding.value) {
        const affectsHeld = isList ? index <= rawCursor!.value : index === 0;
        if (affectsHeld) {
          clearHold();
          dequeueNext();
        }
      }
    },

    reorder(from: number, to: number): void {
      const viewLen = _liveItems.length - _head;
      if (from < 0 || from >= viewLen || to < 0 || to >= viewLen) return;
      const [item] = _liveItems.splice(_head + from, 1);
      _liveItems.splice(_head + to, 0, item);
      bumpLive();
      syncItems();
      if (isList) {
        const cur = rawCursor!.value;
        if (from === cur) {
          // Active item moved — cursor follows it.
          rawCursor!.value = to;
        } else if (from < cur && to >= cur) {
          rawCursor!.value--;
        } else if (from > cur && to <= cur) {
          rawCursor!.value++;
        }
      } else if (_holding.value && (from === 0 || to === 0)) {
        // Queue-mode hold is at index 0; moving that item invalidates
        // the held item identity. End the hold and re-drive.
        clearHold();
        dequeueNext();
      }
    },

    clear(): void {
      // Cancel any running item first so list-mode complete() can't bump the
      // cursor past subsequently-enqueued items. Reuses cancel()'s hold-exit +
      // emit semantics rather than duplicating them inline.
      sequencer.cancel();
      _liveItems = [];
      _head = 0;
      bumpLive();
      syncItems();
      if (isList) rawCursor!.value = 0;
    },

    setCurrent(item: SequencerItem<M>): void {
      if (_holding.value) clearHold();
      setCurrentRaw(item);
    },

    pause(): void {
      paused.value = true;
      // The retry tick checks paused.value each tick, so the hold
      // stays across a pause without needing to unregister.
    },

    resume(): void {
      paused.value = false;
      if (_holding.value) {
        // End the hold by running the retry path immediately instead of
        // waiting for the next tick, so the player sees the item start at once.
        retryHeldItem();
        return;
      }
      dequeueNext();
    },

    togglePause(): void {
      if (paused.value) sequencer.resume();
      else sequencer.pause();
    },

    start(): void {
      dequeueNext();
    },

    get fillStrategy() {
      return _fillStrategy;
    },
    set fillStrategy(s: FillStrategy<M> | null) {
      _fillStrategy = s;
    },

    get canStart() {
      return _canStart;
    },
    set canStart(fn: ((item: SequencerItem<M>) => StartResult) | null) {
      _canStart = fn;
      if (_holding.value && fn === null) {
        // Check removed while holding — start the held item through
        // dequeueNext.
        clearHold();
        dequeueNext();
      }
    },

    get holding(): boolean {
      return _holding.value;
    },

    fill,

    resetAdvanceCount(): void {
      _advancesThisTick = 0;
      _advanceCapHit = false;
    },

    get cursor(): number {
      return rawCursor?.value ?? 0;
    },

    resetCursor(): void {
      if (!isList) return;
      // List mode's cancel() never pops, so the cursor can move after it.
      sequencer.cancel();
      rawCursor!.value = 0;
      dequeueNext();
    },

    on(event, handler) {
      return handle.on(event, handler);
    },
  };

  // The advance cap guards against instant-complete runaway *within a single
  // tick*. When the consumer supplies registerTick, own the per-tick reset so
  // the cap can't silently become a budget for the sequencer's whole life:
  // without it the counter accumulates across every tick and dequeueNext
  // returns null forever once the total passes the cap. Registered once, run
  // at the tick boundary (never mid-cascade), so within-tick runaway still
  // reaches the cap. Sequencers driven without registerTick keep the manual
  // resetAdvanceCount() obligation. A reached cap left the rest of the queue
  // waiting with nothing running, so the reset also starts items again;
  // dequeueNext itself declines when paused, holding or already running.
  if (registerTick) {
    registerTick(() => {
      const capped = _advanceCapHit;
      sequencer.resetAdvanceCount();
      if (capped) dequeueNext();
    });
  }

  return attachPersistentContextReset(sequencer, id);
}
