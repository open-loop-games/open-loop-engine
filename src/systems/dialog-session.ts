/**
 * Dialog Session — wraps a {@link DialogRuntime} in a persistent envelope
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
 * {@link createNativeDialogRuntime}; pass `runtimeFactory` to swap in an
 * external adapter (Ink, Yarn, Ren'Py).
 *
 * @see ./dialog-category for the content-authoring surface that supplies `graphs`
 *
 * @cluster dialog
 */

import type { GameStateAccessor } from '@/primitives/types';
import type { GameStateMutator } from '@/core/effects';
import {
  beginPersistentContext,
  endPersistentContext,
  persistent,
  type Persistent,
} from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { getCurrentGameStateAccessor } from '@/core/game-state-accessor';
import {
  createNativeDialogRuntime,
  type DialogRuntime,
  type DialogGraph,
  type DialogPresentation,
  type DialogRuntimeState,
} from './dialog';

// === TYPES ===

/** Lifecycle events emitted by a {@link DialogSession}. */
export interface DialogSessionEvents {
  /** Fired after each landing on a presentable node (post-start, post-choose). */
  presented: (snapshot: DialogPresentation) => void;
  /** Fired immediately after a choice's outcomes apply, before pointer advancement. */
  chosen: (info: { graphId: string; nodeId: string; choiceId: string }) => void;
  /** Fired when the conversation ends — terminal node, finish(), or gate failure on next. */
  finished: (info: { graphId: string }) => void;
}

/** Factory signature for swapping in alternative DialogRuntime implementations (Ink, Yarn, etc.). */
export type DialogRuntimeFactory = (
  graphs: DialogGraph[],
  accessor: GameStateAccessor,
  mutator: GameStateMutator,
) => DialogRuntime;

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
   * {@link createNativeDialogRuntime}. Pass an Ink/Yarn adapter factory to
   * swap implementations without changing call sites.
   */
  runtimeFactory?: DialogRuntimeFactory;
  /**
   * Override the ambient {@link GameStateAccessor} + {@link GameStateMutator}.
   * Most consumers leave this unset and rely on the engine's ambient accessor.
   */
  accessor?: GameStateAccessor & GameStateMutator;
}

/** A dialog session — the public surface for driving conversations from a UI / module. */
export interface DialogSession extends Emittable<DialogSessionEvents> {
  /** Activate a graph at its entry node (or an explicit node id). */
  start(graphId: string, entryNode?: string): void;
  /** Return the current presentation snapshot, or null when no graph is active. */
  present(): DialogPresentation | null;
  /** Apply the chosen choice's outcomes and advance the pointer. */
  choose(choiceId: string): void;
  /** End the conversation; clears the active pointer. */
  finish(): void;
  isActive(): boolean;
  /** Release any session-held resources. Currently a no-op — present for interface uniformity with other stateful systems. */
  dispose(): void;
}

// === CONSTANTS ===

const defaultNativeFactory: DialogRuntimeFactory = (graphs, accessor, mutator) =>
  createNativeDialogRuntime({ graphs, accessor, mutator });

// === FACTORIES ===

/**
 * Create a dialog session — the runtime envelope that drives a UI through a
 * {@link DialogGraph}. Wraps a {@link DialogRuntime} with persistent state
 * (round-trips through save) and lifecycle event emission.
 *
 * @param options - Persistence-context id, the authored `graphs` available to
 *   this session, optional `runtimeFactory` for adapter swaps (Ink / Yarn /
 *   Ren'Py), and optional `accessor` override.
 * @returns A {@link DialogSession} with `start` / `present` / `choose` /
 *   `finish` / `isActive` / `dispose` methods and `presented` / `chosen` /
 *   `finished` events.
 *
 * @example
 * ```ts
 * const session = createDialogSession({
 *   id: 'main',
 *   graphs: dialogCategory.getAll().flatMap((e) => e.graphs),
 * });
 *
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

  beginPersistentContext(`dialog-sessions/${options.id}`);
  const stateRef: Persistent<DialogRuntimeState> = persistent<DialogRuntimeState>(
    { activeGraphId: undefined, activeNodeId: undefined, visitCounts: {} },
    { name: 'state' },
  );
  endPersistentContext();

  // --- Runtime instantiation + hydration ---

  const factory = options.runtimeFactory ?? defaultNativeFactory;
  const runtime = factory(options.graphs, accessorMutator, accessorMutator);

  // Hydrate runtime from the persistent state on creation. Covers post-load
  // engine init (the persistent ref auto-populated from save data), as well as
  // fresh-game init where the default snapshot lands harmlessly.
  runtime.importState(stateRef.value);

  const events = createEmitHandle<DialogSessionEvents>();

  // --- Internal helpers ---

  function snapshot(): void {
    stateRef.value = runtime.exportState();
  }

  function emitPresentedIfActive(): void {
    const snap = runtime.present();
    if (snap) events.emit('presented', snap);
  }

  // --- Public methods ---

  function start(graphId: string, entryNode?: string): void {
    runtime.start(graphId, entryNode);
    snapshot();
    emitPresentedIfActive();
  }

  function choose(choiceId: string): void {
    // Capture the active context *before* delegating — runtime.choose advances
    // the pointer (or finishes), so post-call state would lose the source nodeId.
    const before = runtime.exportState();
    runtime.choose(choiceId);
    snapshot();
    if (before.activeGraphId && before.activeNodeId) {
      events.emit('chosen', {
        graphId: before.activeGraphId,
        nodeId: before.activeNodeId,
        choiceId,
      });
    }
    if (runtime.isActive()) {
      emitPresentedIfActive();
    } else if (before.activeGraphId) {
      events.emit('finished', { graphId: before.activeGraphId });
    }
  }

  function finish(): void {
    const before = runtime.exportState();
    runtime.finish();
    snapshot();
    if (before.activeGraphId) {
      events.emit('finished', { graphId: before.activeGraphId });
    }
  }

  return {
    start,
    present: () => runtime.present(),
    choose,
    finish,
    isActive: () => runtime.isActive(),
    on: events.on,
    dispose() {},
  };
}

// === PUBLIC UTILITIES ===
