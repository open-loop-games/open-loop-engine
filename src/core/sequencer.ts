/**
 * Sequencer — core primitive for ordered execution of items with optional metadata.
 *
 * A persistent, ordered sequence of items with optional per-item typed metadata:
 * - Current item tracking (what's actively running)
 * - Manual mutation (enqueue, remove, reorder)
 * - Pluggable fill strategy for automation (priority, round-robin, etc.)
 * - Events for lifecycle hooks
 *
 * Two modes:
 * - **queue** (default) — items are consumed on completion (pop from front)
 * - **list** — items persist, a cursor advances through them. Call
 *   `resetCursor()` to replay from the start (e.g., on loop restart).
 *
 * Generic over metadata type M. When M = void, items carry no metadata
 * and the sequencer behaves like a simple string-ID queue.
 *
 * @cluster sequencer
 */

import { shallowRef, watch } from 'vue';
import { createEmitHandle } from './events';
import { persistent, withPersistentContext, type Persistent } from './persistence';
import { reportAdvanceCapTrip } from './safeguards';

// === TYPES ===

/** A sequencer entry: string ID plus optional typed metadata. */
export interface SequencerItem<M = void> {
  id: string;
  metadata: M;
}

/**
 * Tri-state precondition result from a {@link SequencerOptions.canRun} check.
 *
 * - `'now'` — dispatch the item (identical to boolean `true`)
 * - `'never'` — permanently unrunnable, skip and advance
 * - `'notNow'` — temporarily blocked, **hold** the slot and retry next tick
 *
 * The `'notNow'` case is the point of this shape: it lets a sequencer
 * express "can't start right now, but check again later" distinct from
 * "can't ever start." When `'notNow'` is returned without a
 * {@link SequencerOptions.registerTick} callback, it degrades to `'never'`.
 */
export type StartResult = 'now' | 'notNow' | 'never';

/** Tick registration function — matches `EngineContext.onTick` signature. */
export type RegisterTick = (callback: (dt: number) => void) => () => void;

/**
 * Strategy for automatically filling the sequencer when it runs dry.
 * The strategy closure captures whatever state it needs (candidates,
 * priorities, persistent index for round-robin, etc.).
 */
export interface FillStrategy<M = void> {
  /** Return the next item to run, or null if nothing should fill. */
  next(): SequencerItem<M> | null;
}

/** Events emitted during sequencer lifecycle. Subscribe via `sequencer.on()`. */
export interface SequencerEvents<M = void> {
  enqueue: (item: SequencerItem<M>) => void;
  start: (item: SequencerItem<M>) => void;
  complete: (item: SequencerItem<M>) => void;
  cancel: (item: SequencerItem<M>) => void;
  /** Emitted when dequeueNext skips an item that failed the canRun check with `'never'`. */
  skip: (item: SequencerItem<M>) => void;
  /**
   * Emitted when dequeueNext holds on `'notNow'` — the held item stays in
   * `items` and is re-evaluated via the retry tick each subsequent tick,
   * transitioning out when canRun returns `'now'` (dispatch) or `'never'` (skip).
   */
  hold: (item: SequencerItem<M>) => void;
}

/** Default maximum advances per tick before the sequencer pauses advancement. */
export const DEFAULT_MAX_ADVANCES_PER_TICK = 1000;

/**
 * Configuration for {@link createSequencer}. Mode picks queue (consume on
 * complete) vs list (cursor walks a persistent list); `canRun` + `registerTick`
 * wire the tri-state pre-run gate (`now` / `notNow` / `never`) plus its retry
 * tick.
 */
export interface SequencerOptions<M = void> {
  /** Unique identifier — also used as persistent context name */
  id: string;
  /**
   * Sequencer behavior mode (default: 'queue').
   * - `'queue'` — items are consumed (removed) on completion
   * - `'list'` — items persist, a cursor advances through them
   */
  mode?: 'queue' | 'list';
  /** Maximum number of items in the waiting sequence (default: unlimited) */
  maxSize?: number;
  /**
   * Maximum number of complete→dequeueNext advances allowed per tick.
   * Prevents runaway loops when items complete instantly.
   * Call `resetAdvanceCount()` at the start of each tick.
   * Default: {@link DEFAULT_MAX_ADVANCES_PER_TICK} (1000).
   */
  maxAdvancesPerTick?: number;
  /**
   * Pre-run check called by dequeueNext before starting an item. Returns a
   * tri-state {@link StartResult}:
   *
   * - `'now'` — dispatch the item
   * - `'never'` — skip the item (emits `skip`) and try the next one
   * - `'notNow'` — **hold the slot** (emits `hold`); the item remains in
   *   place and is re-checked by the retry tick next tick
   *
   * Fill-strategy results are lightly gated: a fill item that returns
   * anything other than `'now'` is dropped (fill never enters hold state,
   * since fill strategies are expected to return runnable items).
   *
   * `'notNow'` requires {@link registerTick}. Without it, `'notNow'`
   * silently degrades to `'never'`.
   */
  canRun?: (item: SequencerItem<M>) => StartResult;
  /**
   * Tick registration for the `'notNow'` retry path. When a canRun call
   * returns `'notNow'`, the sequencer installs a retry callback via this
   * function and re-evaluates canRun each tick until the item transitions
   * to `'now'` or `'never'`. Without this, `'notNow'` falls back to `'never'`
   * (same as today's boolean-false behavior).
   *
   * Matches `EngineContext.onTick` — pass `ctx.onTick` directly.
   */
  registerTick?: RegisterTick;
  /**
   * Whether enqueue() auto-starts execution when the sequencer is empty and not paused.
   * Default: `true` (existing behavior — first enqueued item starts immediately).
   *
   * Set to `false` for "planning mode" where items are queued without execution.
   * Use {@link Sequencer.start start()} to begin execution explicitly.
   */
  startOnEnqueue?: boolean;
}

/**
 * Sequencer instance produced by {@link createSequencer}. Holds the current
 * item plus the waiting list, persists across save/load, and emits lifecycle
 * events (`start` / `complete` / `skip` / `hold`) consumers wire to game flow.
 */
export interface Sequencer<M = void> {
  readonly id: string;
  /** The mode this sequencer was created with ('queue' or 'list'). */
  readonly mode: 'queue' | 'list';

  // --- Persistent state ---
  /** Raw persistent string for the current item. Prefer currentItem for typed access. */
  readonly current: Persistent<string>;
  /** Waiting items. */
  readonly items: { value: SequencerItem<M>[] };
  /** Whether the sequencer is paused. */
  readonly paused: Persistent<boolean>;

  // --- Typed accessors ---
  /** Current item with metadata, or null if nothing running. */
  readonly currentItem: SequencerItem<M> | null;
  /** Metadata of the current item, or undefined if nothing running. */
  readonly currentMetadata: M | undefined;

  // --- Mutation operations ---
  /** Append an item to the waiting sequence. Auto-starts if nothing running. */
  enqueue(item: SequencerItem<M>): boolean;
  /** Pop from items → set as current. Falls back to fill strategy if items empty. */
  dequeueNext(): SequencerItem<M> | null;
  /** Mark current as completed, emit 'complete', then dequeueNext. */
  complete(): void;
  /** Clear current without completing, emit 'cancel'. */
  cancel(): void;
  /** Remove an item from the waiting sequence by index. */
  remove(index: number): void;
  /** Reorder an item in the waiting sequence. */
  reorder(from: number, to: number): void;
  /** Clear all items from the waiting sequence (does not touch current). */
  clear(): void;

  // --- Direct current management ---
  /** Set a specific item as current (bypassing the sequence). Used for interrupts. */
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
  /** Pluggable automation strategy. Default: null (no auto-fill). */
  fillStrategy: FillStrategy<M> | null;
  /** Manually trigger the fill strategy. Returns the filled item or null. */
  fill(): SequencerItem<M> | null;

  // --- Pre-run check ---
  /**
   * Optional tri-state pre-run check. Can be set or cleared after creation:
   * setting to `null` clears any active hold state. Setting to a new function
   * does not eagerly re-evaluate — the next retry tick (or dequeueNext call)
   * picks it up.
   */
  canRun: ((item: SequencerItem<M>) => StartResult) | null;

  /**
   * Whether the sequencer is currently holding on a `'notNow'` item. While
   * holding, `currentItem` is null, `items.value` is unchanged, and the
   * retry tick is active.
   */
  readonly holding: boolean;

  // --- List mode ---
  /**
   * Index of the currently running item in the list (list mode only).
   * Points AT the running item during execution. Equals `items.value.length`
   * when all items have been completed (done sentinel).
   * In queue mode, always returns 0.
   */
  readonly cursor: number;
  /**
   * Reset the cursor to 0 and cancel the current item (list mode only).
   * If not paused, auto-starts from the beginning.
   * No-op in queue mode.
   */
  // TODO(ergonomics): accept optional `toIndex: number` for arbitrary-position
  // cursor jumps (e.g. Cavernous II's `<` repeat-from-marker). Deferred until
  // an in-repo consumer surfaces. Study: reports/studies/multi-run-orchestration/
  // multi-run-orchestration-primitive-surface.md § Part 2.
  resetCursor(): void;

  // --- Safeguards ---
  /**
   * Reset the per-tick advance counter. Call at the start of each game tick
   * so the sequencer can advance again after hitting its cap.
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
 * @param options - Sequencer configuration including mode, size limits, and optional
 *   pre-run gating via `canRun`
 * @returns A sequencer with enqueue/dequeue/reorder operations, pause/resume control,
 *   pluggable fill strategies, and persistent state that survives save/load
 *
 * @example
 * ```ts
 * const seq = createSequencer<{ type: string }>({
 *   id: 'combat-queue',
 *   mode: 'queue',
 *   maxSize: 10,
 * });
 * seq.enqueue({ id: 'slash', metadata: { type: 'melee' } });
 * seq.on('complete', (item) => console.log(`Finished ${item.id}`));
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
    current: persistent<string>('', { name: 'current' }),
    rawItems: persistent<string>('', { name: 'rawItems' }),
    paused: persistent<boolean>(false, { name: 'paused' }),
    rawCursor: isList ? persistent<number>(0, { name: 'rawCursor' }) : null,
  }));

  // === ITEMS VIEW + SERIALIZATION ===
  // `_liveItems` + `_head` is the canonical in-memory form; `rawItems` is the
  // JSON-serialized persistent-ref form used only for save/load. Dequeue pops
  // advance `_head` in O(1) instead of slicing a fresh array; mutations
  // batch-sync via `syncItems()` so bursts of pops or skips serialize once
  // instead of per-step.

  function deserializeItems(raw: string): SequencerItem<M>[] {
    if (raw === '') return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.map((entry: unknown) => {
        if (typeof entry === 'string') {
          // Legacy: plain string array
          return deserializeItem<M>(entry);
        }
        // New format: { id, m } objects
        const obj = entry as { id: string; m: M };
        return { id: obj.id, metadata: obj.m } as SequencerItem<M>;
      });
    } catch {
      // Legacy comma-delimited format
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
  // below skip no-op re-hydrations when our own sync echoes back.
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

  // Save-load re-hydration: when `rawItems` changes from outside our own
  // `syncItems` writes (i.e. save manager restoring state), re-deserialize
  // into the live array. Flush sync so the new state is visible immediately.
  watch(
    () => rawItems.value,
    (newRaw) => {
      if (newRaw === _lastWritten) return;
      if (_holding) clearHold();
      _liveItems = deserializeItems(newRaw);
      _head = 0;
      bumpLive();
      _lastWritten = newRaw;
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
  let _canRun: ((item: SequencerItem<M>) => StartResult) | null = options.canRun ?? null;
  let _advancesThisTick = 0;
  let _advanceCapHit = false;

  // === HOLD STATE ===
  // In-memory only; save/load re-enters the hold path via dequeueNext.

  let _holding = false;
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
    _holding = false;
    _unsubRetryTick?.();
    _unsubRetryTick = null;
  }

  function installRetryTick(): void {
    if (!registerTick || _unsubRetryTick) return;
    _unsubRetryTick = registerTick(() => {
      if (!_holding) return;
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
    const result = _canRun ? _canRun(held) : 'now';
    if (result === 'now') {
      clearHold();
      // Consume the held item (pop in queue mode; cursor stays put in list
      // mode since the cursor already points AT this item).
      if (!isList) {
        popHead();
        syncItems();
      }
      setCurrentRaw(held);
      handle.emit('start', held);
    } else if (result === 'never') {
      clearHold();
      if (isList) {
        handle.emit('skip', held);
        rawCursor!.value++;
      } else {
        popHead();
        syncItems();
        handle.emit('skip', held);
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
    // Fill items are lightly gated: only 'now' dispatches. 'never' and
    // 'notNow' both drop — fill never enters hold state because fill
    // strategies are expected to return runnable items.
    if (_canRun) {
      const result = _canRun(item);
      if (result !== 'now') return null;
    }
    _filling = true;
    try {
      setCurrentRaw(item);
      handle.emit('start', item);
      return item;
    } finally {
      _filling = false;
    }
  }

  function dequeueNext(): SequencerItem<M> | null {
    if (paused.value) return null;
    if (_holding) return null;

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
        const next = items.value[rawCursor!.value];
        const result = _canRun ? _canRun(next) : 'now';

        if (result === 'now') {
          setCurrentRaw(next);
          handle.emit('start', next);
          return next;
        }

        if (result === 'never') {
          handle.emit('skip', next);
          rawCursor!.value++;
          continue;
        }

        // 'notNow'
        if (registerTick) {
          _holding = true;
          installRetryTick();
          handle.emit('hold', next);
          return null;
        }
        // No registerTick → degrade to 'never'
        handle.emit('skip', next);
        rawCursor!.value++;
      }

      // Reached end of list — cursor sits at items.length (done sentinel)
      return fill();
    }

    // Queue mode: peek live head; pop in-place via _head++. We sync to
    // rawItems at most once when the loop settles, so a burst of skips +
    // a single dispatch pays O(n) serialization instead of O(n²).
    let dirty = false;
    try {
      while (_head < _liveItems.length) {
        const next = _liveItems[_head];
        const result = _canRun ? _canRun(next) : 'now';

        if (result === 'now') {
          popHead();
          dirty = true;
          setCurrentRaw(next);
          handle.emit('start', next);
          return next;
        }

        if (result === 'never') {
          popHead();
          dirty = true;
          handle.emit('skip', next);
          continue;
        }

        // 'notNow'
        if (registerTick) {
          _holding = true;
          installRetryTick();
          handle.emit('hold', next);
          return null;
        }
        // No registerTick → degrade to 'never'
        popHead();
        dirty = true;
        handle.emit('skip', next);
      }
    } finally {
      if (dirty) syncItems();
    }

    // Queue empty — try fill strategy
    return fill();
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

    enqueue(item: SequencerItem<M>): boolean {
      if (currentView().length >= maxSize) return false;
      _liveItems.push(item);
      bumpLive();
      syncItems();
      handle.emit('enqueue', item);

      // Auto-start if nothing running and not paused. Skip while holding —
      // the retry tick owns the current dispatch decision, and the new item
      // is appended behind the held one anyway.
      if (startOnEnqueue && !_holding && current.value === '' && !paused.value) {
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
      handle.emit('complete', completed);
      dequeueNext();
    },

    cancel(): void {
      // Cancel also exits any active hold state — the caller is asking the
      // sequencer to abandon whatever it was waiting on.
      if (_holding) {
        clearHold();
      }
      const cancelled = getCurrentItem();
      if (!cancelled) return;
      current.value = '';
      handle.emit('cancel', cancelled);
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
          // Active item removed; predecrement so complete()'s cursor++ lands
          // on whatever shifted into the slot.
          rawCursor!.value--;
        }
      }
      // If the removal affected the held position (queue head in queue mode,
      // or at-or-before cursor in list mode), drop the hold and re-drive.
      if (_holding) {
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
      } else if (_holding && (from === 0 || to === 0)) {
        // Queue-mode hold lives at index 0; disturbing that slot invalidates
        // the held item identity. Drop the hold and re-drive.
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
      if (_holding) clearHold();
      setCurrentRaw(item);
    },

    pause(): void {
      paused.value = true;
      // The retry tick checks paused.value on each firing, so holding
      // state is preserved across pause without needing to unregister.
    },

    resume(): void {
      paused.value = false;
      if (_holding) {
        // Snap out of hold by re-running the retry path immediately instead
        // of waiting for the next tick, so the user gets responsive dispatch.
        retryHeldItem();
        return;
      }
      if (current.value === '') {
        dequeueNext();
      }
    },

    togglePause(): void {
      if (paused.value) sequencer.resume();
      else sequencer.pause();
    },

    start(): void {
      if (current.value === '' && !paused.value) {
        dequeueNext();
      }
    },

    get fillStrategy() {
      return _fillStrategy;
    },
    set fillStrategy(s: FillStrategy<M> | null) {
      _fillStrategy = s;
    },

    get canRun() {
      return _canRun;
    },
    set canRun(fn: ((item: SequencerItem<M>) => StartResult) | null) {
      _canRun = fn;
      if (_holding && fn === null) {
        // Gate removed while holding — dispatch the held item on next
        // dequeueNext call path.
        clearHold();
        if (current.value === '' && !paused.value) dequeueNext();
      }
    },

    get holding(): boolean {
      return _holding;
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
      if (_holding) clearHold();
      rawCursor!.value = 0;
      // Cancel current item so replay starts fresh
      const cancelled = getCurrentItem();
      if (cancelled) {
        current.value = '';
        handle.emit('cancel', cancelled);
      }
      if (!paused.value) {
        dequeueNext();
      }
    },

    on(event, handler) {
      return handle.on(event, handler);
    },
  };

  return sequencer;
}
