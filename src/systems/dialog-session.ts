/**
 * Dialog Session — wraps a {@link DialogAdapter} in a persistent envelope
 * with lifecycle event emission.
 *
 * The session is the public surface a UI subscribes to:
 * - `start`/`choose`/`finish` delegate to the runtime, then snapshot its state
 *   into a {@link Persistent} ref so save round-trips automatically.
 * - `presented` / `chosen` / `finished` events are emitted by the session
 *   itself (not the runtime), so adapters that don't expose events still
 *   produce a clean event stream.
 * - On engine load (when the persistent ref hydrates from save data), the
 *   session imports the snapshot back into the runtime — call sites don't
 *   need to know whether they're in a fresh or restored game.
 *
 * The runtime is a private implementation detail. Default factory is
 * {@link createNativeDialogAdapter}; pass `adapterFactory` to swap in an
 * external adapter (Ink, Yarn, Ren'Py).
 *
 * @see ./dialog-category for the content-authoring surface that supplies `graphs`
 *
 * @cluster dialog
 */

import { effectScope, watch } from 'vue';
import type { GameStateAccessor } from '@/primitives/types';
import type { GameStateMutator } from '@/core/effects';
import {
  beginPersistentContext,
  deletePersistent,
  endPersistentContext,
  settling,
  persistent,
  type Persistent,
} from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { attachPersistentContextReset } from '@/core/resettable';
import { getCurrentGameStateAccessor } from '@/core/game-state-accessor';
import {
  createNativeDialogAdapter,
  type DialogAdapter,
  type DialogGraph,
  type DialogPresentation,
  type SerializedDialogAdapter,
} from './dialog';

// === TYPES ===

/** Lifecycle events emitted by a {@link DialogSession}. */
export interface DialogSessionEvents {
  /** Fired after each landing on a presentable node (post-start, post-choose, post-advance). */
  presented: (snapshot: DialogPresentation) => void;
  /**
   * Fired once a choice has fully resolved: its outcomes have applied, the
   * pointer has advanced, and every node it entered has run its onEnter.
   * Precedes the `presented` or `finished` that choice leads to.
   */
  chosen: (info: { graphId: string; nodeId: string; choiceId: string }) => void;
  /**
   * Fired when the conversation ends: `finish()`, or a choice with no `next`
   * or whose `next` is gated off. Landing on a line presented with
   * `terminal: true` does not fire it — the UI calls `finish()` to close it.
   */
  finished: (info: { graphId: string }) => void;
}

/** Factory signature for swapping in alternative DialogAdapter implementations (Ink, Yarn, etc.). */
export type DialogAdapterFactory = (
  graphs: DialogGraph[],
  accessor: GameStateAccessor,
  mutator: GameStateMutator,
) => DialogAdapter;

/**
 * Options for {@link createDialogSession} — the persistent id, the authored
 * graphs available in this session, and optional runtime-factory + accessor
 * overrides for swapping the dialog backend.
 */
export interface DialogSessionOptions {
  /** Persistence sub-context name. The session's state ref lives at `dialog-sessions/{id}/state`. */
  id: string;
  /** Authored graphs available to this session. Typically `category.getAll().flatMap(e => e.graphs)`. */
  graphs: DialogGraph[];
  /**
   * Optional alternative runtime implementation. Defaults to
   * {@link createNativeDialogAdapter}. Pass an Ink/Yarn adapter factory to
   * swap implementations without changing call sites.
   */
  adapterFactory?: DialogAdapterFactory;
  /**
   * Override the ambient {@link GameStateAccessor} + {@link GameStateMutator}.
   * Most consumers leave this unset and rely on the engine's ambient accessor.
   */
  accessor?: GameStateAccessor & GameStateMutator;
}

/** A dialog session — the public surface for driving conversations from a UI / module. */
export interface DialogSession extends Emittable<DialogSessionEvents> {
  /**
   * Activate a graph at its entry node (or an explicit node id). Replaces an
   * active conversation without emitting `finished` for it. When the entry
   * node's condition fails, no conversation starts and an active one
   * continues without presenting again.
   */
  start(graphId: string, entryNode?: string): void;
  /** Return the current presentation snapshot, or null when no graph is active. */
  present(): DialogPresentation | null;
  /** Apply the chosen choice's outcomes and advance the pointer. */
  choose(choiceId: string): void;
  /**
   * Continue past a line whose choices gated off after it presented them —
   * the one `present()` reports with no choices and `terminal: false`.
   * Enters `next` and presents where it lands; throws on any other line.
   */
  advance(): void;
  /** End the conversation; clears the active pointer. */
  finish(): void;
  isActive(): boolean;
  /** How many times a node has been entered across the saved history; 0 for a never-visited node. */
  getVisitCount(graphId: string, nodeId: string): number;
  /**
   * Discard the session: stops the state-sync watcher and drops the session's
   * saved state, so a later save omits it and the same id can be created again.
   */
  dispose(): void;
}

// === CONSTANTS ===

const defaultNativeFactory: DialogAdapterFactory = (graphs, accessor, mutator) =>
  createNativeDialogAdapter({ graphs, accessor, mutator });

// === FACTORIES ===

/**
 * Create a dialog session — the runtime envelope that drives a UI through a
 * {@link DialogGraph}. Wraps a {@link DialogAdapter} with persistent state
 * (round-trips through save) and lifecycle event emission.
 *
 * @param options - Persistence-context id, the authored `graphs` available to
 *   this session, optional `adapterFactory` for adapter swaps (Ink / Yarn /
 *   Ren'Py), and optional `accessor` override.
 * @returns A {@link DialogSession} with `start` / `present` / `choose` /
 *   `advance` / `finish` / `isActive` / `getVisitCount` / `dispose` methods and
 *   `presented` / `chosen` / `finished` events.
 *
 * @example
 * ```ts
 * const session = createDialogSession({
 *   id: 'main',
 *   graphs: dialogCategory.getAll().flatMap((e) => e.graphs),
 * });
 *
 * // A line presented with `terminal: true` waits for the UI's session.finish().
 * session.on('presented', (snap) => renderDialog(snap));
 * session.on('finished', ({ graphId }) => closeDialogUI(graphId));
 *
 * session.start('mentor-rask-intro');
 * session.choose('agree-to-help');
 * ```
 */
export function createDialogSession(options: DialogSessionOptions): DialogSession {
  const accessorMutator = options.accessor ?? getCurrentGameStateAccessor();
  if (!accessorMutator) {
    throw new Error(
      `createDialogSession (${options.id}) requires an ambient GameStateAccessor — ` +
        'wire it through createEngine({ accessor }) or pass `accessor` explicitly.',
    );
  }

  // --- Persistent state ---

  const contextId = `dialog-sessions/${options.id}`;
  beginPersistentContext(contextId);
  const stateRef: Persistent<SerializedDialogAdapter> = persistent<SerializedDialogAdapter>(
    { activeGraphId: undefined, activeNodeId: undefined, visitCounts: {} },
    { id: 'state', lifetime: true },
  );
  endPersistentContext();

  // --- Runtime instantiation + hydration ---

  const factory = options.adapterFactory ?? defaultNativeFactory;
  const adapter = factory(options.graphs, accessorMutator, accessorMutator);

  // Hydrate runtime from the persistent state on creation. Covers the
  // session-created-after-load path (lazy-instantiated sessions, fresh-game
  // init where the snapshot lands harmlessly).
  adapter.restore(stateRef.value);

  // Re-import on save load. The typical engine init order is
  // createEngine → mod.install (where sessions are built) → saveManager.load,
  // so deserializePersistents writes stateRef *after* the eager import
  // above. The flush:sync + settling gate mirrors the resource.ts pattern
  // (inverted gate — we want to act *during* load, not avoid acting then).
  // snapshot() writes to stateRef outside any load, so the guard returns
  // immediately on those firings.
  const scope = effectScope();
  scope.run(() =>
    watch(
      stateRef,
      (newState) => {
        if (settling.value) adapter.restore(newState);
      },
      { flush: 'sync' },
    ),
  );

  const events = createEmitHandle<DialogSessionEvents>();

  // --- Internal helpers ---

  function snapshot(): void {
    stateRef.value = adapter.serialize();
  }

  // A runtime throw (an authored next-only cycle) can land after effects have
  // applied and the pointer has moved, so the snapshot runs regardless and the
  // saved state never disagrees with the runtime.
  function synced<T>(op: () => T): T {
    try {
      return op();
    } finally {
      snapshot();
    }
  }

  function emitPresentedIfActive(): void {
    const snap = adapter.present();
    if (snap) events.emit('presented', snap);
  }

  // --- Public methods ---

  function start(graphId: string, entryNode?: string): void {
    if (synced(() => adapter.start(graphId, entryNode)) !== false) emitPresentedIfActive();
  }

  function choose(choiceId: string): void {
    // Capture the active context *before* delegating — runtime.choose advances
    // the pointer (or finishes), so post-call state would lose the source nodeId.
    const before = adapter.serialize();
    synced(() => adapter.choose(choiceId));
    if (before.activeGraphId && before.activeNodeId) {
      events.emit('chosen', {
        graphId: before.activeGraphId,
        nodeId: before.activeNodeId,
        choiceId,
      });
    }
    if (adapter.isActive()) {
      emitPresentedIfActive();
    } else if (before.activeGraphId) {
      events.emit('finished', { graphId: before.activeGraphId });
    }
  }

  function advance(): void {
    const step = adapter.advance;
    if (!step) {
      throw new Error(`Dialog session ${options.id}: its adapter does not implement advance()`);
    }
    synced(() => step.call(adapter));
    emitPresentedIfActive();
  }

  function finish(): void {
    const before = adapter.serialize();
    synced(() => adapter.finish());
    if (before.activeGraphId) {
      events.emit('finished', { graphId: before.activeGraphId });
    }
  }

  const session: DialogSession = {
    start,
    present: () => adapter.present(),
    choose,
    advance,
    finish,
    isActive: () => adapter.isActive(),
    getVisitCount: (graphId, nodeId) => adapter.getVisitCount(graphId, nodeId),
    on: events.on,
    dispose() {
      // Stop the sync watch on stateRef; without this, a discarded session
      // leaks a live watcher that re-imports save state into a stale runtime on
      // every subsequent load (the per-conversation lazy-instantiation path).
      scope.stop();
      deletePersistent(stateRef as unknown as Persistent);
    },
  };
  return attachPersistentContextReset(session, contextId);
}
