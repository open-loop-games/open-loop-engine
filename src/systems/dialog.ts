/**
 * Dialog — authored conversation graphs and the engine-native runtime that
 * walks them. The runtime composes engine substrate (Gate predicates, effects,
 * events) into a save-friendly conversation driver.
 *
 * Composes with:
 * - `Gate` + `evaluateGate` (resolved via the ambient Gate runtime) — both
 *   dialog node-entry conditions and per-choice visibility gates dispatch
 *   through Gate evaluation.
 * - `IEffect` + `applyEffect` for `onEnter` and choice `outcomes`.
 * - `createEmitHandle` for lifecycle events.
 *
 * State is held in-memory; persistence wraps externally via `createDialogSession`'s
 * persistent envelope.
 *
 * @cluster dialog
 */

import type { IEffect, GameStateAccessor } from '@/primitives/types';
import { applyEffect, type GameStateMutator } from '@/core/effects';
import { createEmitHandle, type Emittable } from '@/core/events';
import { evaluateGate, getAmbientGateRuntime, type Gate } from './gate';

// === TYPES ===

/**
 * A single line/branch in a dialog graph. Pure data — references to host
 * variables flow through {@link Gate} / {@link IEffect}, not closures, so
 * graphs serialize and survive save/load.
 */
export interface DialogNode {
  id: string;
  /** Displayed line. Template variables `{name}` are interpolated by the host. */
  text: string;
  /**
   * Skip this node when present and falsy. Evaluated as a {@link Gate}
   * through the ambient Gate runtime — typed predicate spec, no closures.
   */
  condition?: Gate;
  /** Player-facing choices. Empty (or omitted) = terminal node. */
  choices?: DialogChoice[];
  /** Effects emitted on node entry, before choice presentation. */
  onEnter?: IEffect[];
  /** Explicit fall-through pointer for non-choice advancement. */
  next?: string;
}

/** A single response option attached to a {@link DialogNode}. */
export interface DialogChoice {
  id: string;
  text: string;
  /**
   * Hide this choice from the presented list when present and falsy. Same
   * {@link Gate} contract as {@link DialogNode.condition}.
   */
  condition?: Gate;
  /** Effects emitted when this choice is selected. */
  outcomes?: IEffect[];
  /** Target node id. Omit for "end conversation". */
  next?: string;
}

/** A complete authored conversation: nodes plus an entry pointer. */
export interface DialogGraph {
  /** Stable graph id — also the persistence sub-context name. */
  id: string;
  /** First node id walked when a session starts. */
  entry: string;
  nodes: DialogNode[];
}

/** Snapshot of a presented line — what the UI binds to. */
export interface DialogPresentation {
  nodeId: string;
  text: string;
  /** Choices already filtered by condition evaluation. */
  choices: ReadonlyArray<{ id: string; text: string }>;
  /** True when the conversation has reached a terminal node (no further choices or fall-through). */
  finished: boolean;
}

/**
 * Persistable runtime state — engine-canonical fields that every DialogRuntime
 * implementation lowers into on `exportState()`. Adapters that need to persist
 * additional internal state (Ink JSON dump, Yarn VM state) can extend this
 * type via declaration merging in their package.
 *
 * TODO(expansion): when an external adapter needs to persist adapter-private
 * payload across save/load, add an `adapter?` field constrained to
 * StateConstraint-compatible shapes (not `unknown` — must be serializable).
 */
export interface DialogRuntimeState {
  activeGraphId?: string;
  activeNodeId?: string;
  /** Per-graph per-node visit counts. Survives sessions. */
  visitCounts: Record<string, Record<string, number>>;
}

/**
 * Adapter contract: anything that can drive a dialog conversation against
 * host state. The engine ships {@link createNativeDialogRuntime} which walks
 * `DialogGraph[]`. External adapters — Ink, Yarn Spinner, Ren'Py, Dialogic —
 * implement the same interface against their own content shape and runtime.
 *
 * Adapters MUST NOT hold typed refs to host state — they read/write through
 * the supplied accessor + mutator only. This keeps adapters host-agnostic and
 * lets `createDialogSession` swap implementations through its `runtimeFactory`
 * option without consumer changes.
 */
export interface DialogRuntime {
  /** Activate a graph at its entry node (or an explicit node). Runs onEnter outcomes. */
  start(graphId: string, entryNode?: string): void;
  /** Return the current presentation snapshot, or null when no graph is active. */
  present(): DialogPresentation | null;
  /** Apply the chosen choice's outcomes and advance the pointer. */
  choose(choiceId: string): void;
  /** End the conversation; clears the active pointer. */
  finish(): void;
  isActive(): boolean;
  /** Return persistable state for save inclusion. */
  exportState(): DialogRuntimeState;
  /** Restore from previously exported state. Replaces current state wholesale. */
  importState(state: DialogRuntimeState): void;
}

/** Lifecycle events emitted by a {@link NativeDialogRuntime} instance. */
export interface DialogRuntimeEvents {
  /** Fired whenever the runtime lands on a presentable node (after start, after choose). */
  presented: (snapshot: DialogPresentation) => void;
  /** Fired immediately after a choice's outcomes apply, before pointer advancement. */
  chosen: (info: { graphId: string; nodeId: string; choiceId: string }) => void;
  /** Fired when the runtime clears its active pointer (terminal node, finish(), or condition failure). */
  finished: (info: { graphId: string }) => void;
}

/**
 * Options for {@link createNativeDialogRuntime} — the authored graphs plus
 * the read/write side ({@link GameStateAccessor} for predicates,
 * {@link GameStateMutator} for outcome dispatch).
 */
export interface NativeDialogRuntimeOptions {
  /** Authored graphs available to this runtime. Looked up by graph.id on start(). */
  graphs: DialogGraph[];
  /** Read side — predicate evaluation and outcome read-back. */
  accessor: GameStateAccessor;
  /** Write side — outcome dispatch. */
  mutator: GameStateMutator;
}

/** Native dialog runtime instance — implements {@link DialogRuntime} plus event subscription. */
export interface NativeDialogRuntime extends DialogRuntime, Emittable<DialogRuntimeEvents> {}

// === FACTORIES ===

/**
 * Construct a native dialog runtime backed by the supplied graphs + accessor + mutator.
 *
 * `condition` fields on nodes and choices accept `Gate` — predicates dispatch
 * through {@link evaluateGate} against the ambient Gate runtime (resolved per
 * evaluation via {@link getAmbientGateRuntime}). The engine's ambient triple
 * (accessor / categories / registry) must be wired — standard inside
 * `createEngine`'s install/connect.
 *
 * Standard composition path: register dialog content via `createDialogCategory`,
 * then pass `category.getAll().flatMap(e => e.graphs)` as `graphs`. For tests
 * or one-off use, construct graphs inline.
 *
 * @param options Graphs + ambient accessor/mutator. The runtime captures these
 *   and uses them for outcome dispatch and condition read-back; Gate
 *   predicates resolve their own ambient triple at evaluation time.
 * @returns A {@link NativeDialogRuntime} — the {@link DialogRuntime} adapter
 *   contract plus an event subscription handle.
 *
 * @example
 * ```ts
 * const runtime = createNativeDialogRuntime({ graphs, accessor, mutator });
 * runtime.on('presented', (snap) => uiStore.setCurrentLine(snap));
 * runtime.start('rask-greeting');
 * ```
 */
export function createNativeDialogRuntime(
  options: NativeDialogRuntimeOptions,
): NativeDialogRuntime {
  const { graphs, accessor, mutator } = options;
  const graphsById = new Map<string, DialogGraph>(graphs.map((g) => [g.id, g]));
  const nodesByGraph = new Map<string, Map<string, DialogNode>>();
  for (const g of graphs) {
    nodesByGraph.set(g.id, new Map(g.nodes.map((n) => [n.id, n])));
  }

  const events = createEmitHandle<DialogRuntimeEvents>();
  const state: DialogRuntimeState = {
    activeGraphId: undefined,
    activeNodeId: undefined,
    visitCounts: {},
  };

  function lookupGraph(graphId: string): DialogGraph {
    const g = graphsById.get(graphId);
    if (!g) throw new Error(`Unknown dialog graph: ${graphId}`);
    return g;
  }

  function lookupNode(graphId: string, nodeId: string): DialogNode {
    const nodes = nodesByGraph.get(graphId);
    const n = nodes?.get(nodeId);
    if (!n) throw new Error(`Unknown dialog node: ${nodeId} in graph ${graphId}`);
    return n;
  }

  function holds(predicate: Gate): boolean {
    return evaluateGate(predicate, getAmbientGateRuntime());
  }

  function recordVisit(graphId: string, nodeId: string): void {
    const visits = state.visitCounts[graphId] ?? (state.visitCounts[graphId] = {});
    visits[nodeId] = (visits[nodeId] ?? 0) + 1;
  }

  function activate(graphId: string, nodeId: string): void {
    state.activeGraphId = graphId;
    state.activeNodeId = nodeId;
    const node = lookupNode(graphId, nodeId);
    recordVisit(graphId, nodeId);
    if (node.onEnter) {
      for (const eff of node.onEnter) applyEffect(eff, accessor, mutator);
    }
  }

  /**
   * Auto-advance through `next`-only fall-through nodes until landing on a
   * node with at least one (gated) choice or one with no `next` (terminal).
   * Each visited node fires its onEnter and increments its visit count.
   *
   * If a fall-through target's condition evaluates falsy, treat the chain as
   * ending at the current node (don't enter the gated node).
   */
  function settle(): void {
    // Guard against an authored next-only cycle (a → b → a): without it the
    // fall-through walk spins forever, hanging the game and inflating visitCounts.
    const seen = new Set<string>();
    while (state.activeGraphId && state.activeNodeId) {
      if (seen.has(state.activeNodeId)) {
        throw new Error(
          `Dialog graph "${state.activeGraphId}" has a next-only cycle through node "${state.activeNodeId}"`,
        );
      }
      seen.add(state.activeNodeId);
      const node = lookupNode(state.activeGraphId, state.activeNodeId);
      const hasChoices = (node.choices?.length ?? 0) > 0;
      if (hasChoices || !node.next) return;
      const nextNode = lookupNode(state.activeGraphId, node.next);
      if (nextNode.condition && !holds(nextNode.condition)) return;
      activate(state.activeGraphId, node.next);
    }
  }

  function gatedChoices(node: DialogNode): DialogChoice[] {
    return (node.choices ?? []).filter((c) => !c.condition || holds(c.condition));
  }

  function emitPresented(): void {
    const snap = present();
    if (snap) events.emit('presented', snap);
  }

  function start(graphId: string, entryNode?: string): void {
    const graph = lookupGraph(graphId);
    const targetId = entryNode ?? graph.entry;
    const targetNode = lookupNode(graphId, targetId);
    if (targetNode.condition && !holds(targetNode.condition)) {
      // Entry-node condition fails — conversation cannot start.
      return;
    }
    activate(graphId, targetId);
    settle();
    emitPresented();
  }

  function present(): DialogPresentation | null {
    if (!state.activeGraphId || !state.activeNodeId) return null;
    const node = lookupNode(state.activeGraphId, state.activeNodeId);
    const choices = gatedChoices(node);
    return {
      nodeId: node.id,
      text: node.text,
      choices: choices.map((c) => ({ id: c.id, text: c.text })),
      finished: choices.length === 0 && !node.next,
    };
  }

  function choose(choiceId: string): void {
    if (!state.activeGraphId || !state.activeNodeId) {
      throw new Error('No active dialog node — call start() first');
    }
    const graphId = state.activeGraphId;
    const nodeId = state.activeNodeId;
    const node = lookupNode(graphId, nodeId);
    const choice = node.choices?.find((c) => c.id === choiceId);
    if (!choice) {
      throw new Error(`Unknown choice ${choiceId} on dialog node ${nodeId}`);
    }
    if (choice.condition && !holds(choice.condition)) {
      throw new Error(`Choice ${choiceId} on node ${nodeId} is currently gated off`);
    }
    if (choice.outcomes) {
      for (const eff of choice.outcomes) applyEffect(eff, accessor, mutator);
    }
    events.emit('chosen', { graphId, nodeId, choiceId });

    if (!choice.next) {
      finish();
      return;
    }
    const nextNode = lookupNode(graphId, choice.next);
    if (nextNode.condition && !holds(nextNode.condition)) {
      finish();
      return;
    }
    activate(graphId, choice.next);
    settle();
    emitPresented();
  }

  function finish(): void {
    const graphId = state.activeGraphId;
    state.activeGraphId = undefined;
    state.activeNodeId = undefined;
    if (graphId) events.emit('finished', { graphId });
  }

  function isActive(): boolean {
    return state.activeGraphId !== undefined && state.activeNodeId !== undefined;
  }

  function exportState(): DialogRuntimeState {
    return {
      activeGraphId: state.activeGraphId,
      activeNodeId: state.activeNodeId,
      // JSON-clone visit counts so the consumer's persistent envelope owns its
      // snapshot. JSON (rather than structuredClone) handles Vue's reactive
      // proxies, which the structured-clone algorithm refuses.
      visitCounts: jsonClone(state.visitCounts),
    };
  }

  function importState(snapshot: DialogRuntimeState): void {
    state.activeGraphId = snapshot.activeGraphId;
    state.activeNodeId = snapshot.activeNodeId;
    state.visitCounts = jsonClone(snapshot.visitCounts ?? {});
  }

  return {
    start,
    present,
    choose,
    finish,
    isActive,
    exportState,
    importState,
    on: events.on,
  };
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
