/**
 * Dialog Session — wraps a {@link DialogAdapter} in a persistent envelope
 * with lifecycle event emission.
 *
 * The session is the public surface a UI subscribes to:
 * - `start`/`choose`/`advance`/`finish` delegate to the adapter, then write
 *   its serialized form into a {@link Persistent} ref, so a save round-trips it.
 * - `presented` / `chosen` / `finished` events are emitted by the session
 *   itself (not the adapter), so adapters that don't expose events still
 *   produce a clean event stream.
 * - On a load, when save data writes the persistent ref, the session
 *   restores the adapter from it. Call sites don't need to know whether the
 *   game is new or loaded.
 *
 * The adapter is private to the session. The default factory is
 * {@link createNativeDialogAdapter}; pass `adapterFactory` for an external
 * adapter (Ink, Yarn, Ren'Py).
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
  disownPersistent,
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
  /** Emitted each time the session stops on a presentable node (after start, choose or advance). */
  presented: (snapshot: DialogPresentation) => void;
  /**
   * Emitted once a choice has fully resolved: its outcomes have applied, the
   * pointer has advanced, and every node it entered has run its onEnter.
   * Precedes the `presented` or `finished` that choice leads to.
   */
  chosen: (info: { graphId: string; nodeId: string; choiceId: string }) => void;
  /**
   * Emitted when the conversation ends: `finish()`, or a choice with no
   * `next` or whose `next` node's `when` does not hold. Stopping on a line
   * presented with `terminal: true` does not emit it; the UI calls
   * `finish()` to close it.
   */
  finished: (info: { graphId: string }) => void;
}

/** Factory signature for alternative DialogAdapter implementations (Ink, Yarn, etc.). */
export type DialogAdapterFactory = (
  graphs: DialogGraph[],
  accessor: GameStateAccessor,
  mutator: GameStateMutator,
) => DialogAdapter;

/**
 * Options for {@link createDialogSession} — the persistent context id, the
 * authored graphs, and an optional adapter factory and accessor for another
 * dialog backend.
 */
export interface DialogSessionOptions {
  /**
   * Persistent context id under `dialog-sessions/`. The session's state ref
   * has the save key `dialog-sessions/{id}.state`.
   */
  id: string;
  /** Authored graphs available to this session. Typically `category.getAll().flatMap(e => e.graphs)`. */
  graphs: DialogGraph[];
  /**
   * Builds the adapter. Defaults to {@link createNativeDialogAdapter}. Pass
   * an Ink or Yarn adapter factory to change backends without changing call
   * sites.
   */
  adapterFactory?: DialogAdapterFactory;
  /**
   * Replaces the ambient {@link GameStateAccessor} + {@link GameStateMutator}.
   * Most consumers leave this unset and rely on the engine's ambient accessor.
   */
  accessor?: GameStateAccessor & GameStateMutator;
}

/** A dialog session — the public surface for driving conversations from a UI / module. */
export interface DialogSession extends Emittable<DialogSessionEvents> {
  /**
   * Start a graph at its entry node (or an explicit node id). Replaces an
   * active conversation without emitting `finished` for it. When the entry
   * node's `when` does not hold, no conversation starts, and an active one
   * continues without presenting again.
   */
  start(graphId: string, entryNode?: string): void;
  /** Return the current presentation snapshot, or null when no graph is active. */
  present(): DialogPresentation | null;
  /** Apply the chosen choice's outcomes and advance the pointer. */
  choose(choiceId: string): void;
  /**
   * Continue past a line whose choices were blocked after it presented them:
   * the line `present()` reports with no choices and `terminal: false`.
   * Enters `next` and presents the node it stops on; throws on any other line.
   */
  advance(): void;
  /** End the conversation; clears the active pointer. */
  finish(): void;
  isActive(): boolean;
  /** How many times a node has been entered across the saved history; 0 for a never-visited node. */
  getVisitCount(graphId: string, nodeId: string): number;
  /**
   * Stop the state-sync watcher. The saved state becomes unowned: it keeps
   * saving, and a session built with the same id in the same persistent context
   * takes it over and resumes, visit counts included.
   */
  dispose(): void;
}

// === CONSTANTS ===

const defaultAdapterFactory: DialogAdapterFactory = (graphs, accessor, mutator) =>
  createNativeDialogAdapter({ graphs, accessor, mutator });

// === FACTORIES ===

/**
 * Create a dialog session — the envelope that drives a UI through a
 * {@link DialogGraph}. Wraps a {@link DialogAdapter} with persistent state,
 * which a save round-trips, and lifecycle events.
 *
 * @param options - Persistent context id, the authored `graphs` available to
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

  // --- Adapter build + restore ---

  const factory = options.adapterFactory ?? defaultAdapterFactory;
  const adapter = factory(options.graphs, accessorMutator, accessorMutator);

  // Restore the adapter from the persistent ref on creation. This covers a
  // session that took over a disposed session's state, and a new game, where
  // the restore writes the defaults back harmlessly.
  adapter.restore(stateRef.value);

  // Restore again on a load. The typical engine start order is
  // createEngine → module install (where sessions are built) → saveManager.load,
  // so deserializePersistents writes stateRef *after* the eager restore
  // above. The flush:sync watch and the `settling` check mirror resource.ts,
  // inverted: this acts *during* a load's writes, where resource.ts holds back.
  // snapshot() writes stateRef outside any load, so the check skips those
  // writes.
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

  // An adapter throw (an authored next-only cycle) can come after effects have
  // applied and the pointer has moved. So the write runs regardless, and the
  // saved state never disagrees with the adapter.
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
    // Capture the active graph and node *before* delegating: adapter.choose
    // advances the pointer (or finishes), so the state after it lacks the source nodeId.
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
      // Stop the sync watch on stateRef; without this, a disposed session
      // leaks a watcher that restores save state into a stale adapter on
      // every later load.
      scope.stop();
      disownPersistent(stateRef);
    },
  };
  return attachPersistentContextReset(session, contextId);
}
