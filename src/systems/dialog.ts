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
import { createPredicateResolver, evaluateGate, type Gate } from './gate';

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
  when?: Gate;
  /**
   * Player-facing choices. A node with none visible falls through to `next`,
   * and is terminal without one.
   */
  choices?: DialogChoice[];
  /** Effects emitted on node entry, before choice presentation. */
  onEnter?: IEffect[];
  /**
   * Fall-through target, entered when this node has no visible choice — on
   * arrival, or through `advance()` once its presented choices gate off. When
   * the target's condition fails, the conversation stops at this node.
   */
  next?: string;
}

/** A single response option attached to a {@link DialogNode}. */
export interface DialogChoice {
  id: string;
  text: string;
  /**
   * Hide this choice from the presented list when present and falsy. Same
   * {@link Gate} contract as {@link DialogNode.when}.
   */
  visible?: Gate;
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
  /**
   * True when the line offers no visible choice and no enterable `next`. The
   * conversation stays active until the UI calls `finish()`. False with no
   * visible choice means the choices gated off after the line presented and
   * `next` can be entered: the UI offers a continue that calls `advance()`.
   */
  terminal: boolean;
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
  /**
   * Activate a graph at its entry node (or an explicit node), running onEnter
   * effects and falling through `next` until a node presents. Replaces an
   * active conversation without finishing it. Does nothing when the entry
   * node's condition fails, and returns `false` to say so; a return of
   * nothing reads as started, so adapters written before it still conform.
   */
  start(graphId: string, entryNode?: string): boolean | void;
  /** Return the current presentation snapshot, or null when no graph is active. */
  present(): DialogPresentation | null;
  /** Apply the chosen choice's outcomes and advance the pointer. */
  choose(choiceId: string): void;
  /**
   * Fall through `next` from a line that presents no visible choice and isn't
   * finished — its choices gated off after it presented them. Throws on any
   * other line. Optional so adapters written before it still conform; a
   * session over one without it throws from its own `advance()`.
   */
  advance?(): void;
  /** End the conversation; clears the active pointer. */
  finish(): void;
  isActive(): boolean;
  /**
   * How many times a node has been entered, across the full persisted history
   * (survives save/load). Returns 0 for a never-visited node. No Gate kind
   * reads it: a consumer that branches on "first time here" / "seen N times"
   * reads it here and publishes it through its own accessor or flags.
   */
  getVisitCount(graphId: string, nodeId: string): number;
  /** Return persistable state for save inclusion. */
  exportState(): DialogRuntimeState;
  /** Restore from previously exported state. Replaces current state wholesale. */
  importState(state: DialogRuntimeState): void;
}

/** Lifecycle events emitted by a {@link NativeDialogRuntime} instance. */
export interface DialogRuntimeEvents {
  /** Fired whenever the runtime lands on a presentable node (after start, choose or advance). */
  presented: (snapshot: DialogPresentation) => void;
  /** Fired immediately after a choice's outcomes apply, before pointer advancement. */
  chosen: (info: { graphId: string; nodeId: string; choiceId: string }) => void;
  /**
   * Fired when the runtime clears its active pointer: `finish()`, or a choice
   * with no `next` or whose `next` is gated off. Landing on a line presented
   * with `terminal: true` does not fire it.
   */
  finished: (info: { graphId: string }) => void;
}

/**
 * Options for {@link createNativeDialogRuntime} — the authored graphs plus
 * the read/write side ({@link GameStateAccessor} for predicates,
 * {@link GameStateMutator} for outcome dispatch).
 */
export interface NativeDialogRuntimeOptions {
  /**
   * Authored graphs available to this runtime, looked up by graph.id on
   * start(). A graph id repeated across the list, or a node id repeated within
   * one graph, throws at construction.
   */
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
 * through {@link evaluateGate} against a {@link GateRuntime} captured once here
 * at construction, where every condition's handles are asserted. Construct
 * inside `createEngine`'s install/connect, where the ambient handles are wired:
 * dialog is driven from player input long after that scope closes, so a
 * lazily-resolved runtime would come back empty.
 *
 * Standard composition path: register dialog content via `createDialogCategory`,
 * then pass `category.getAll().flatMap(e => e.graphs)` as `graphs`. For tests
 * or one-off use, construct graphs inline.
 *
 * @param options Graphs + accessor/mutator. The runtime captures these for
 *   outcome dispatch and condition read-back; `accessor` also seeds the
 *   captured Gate runtime.
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
  // Capture the Gate runtime now, not per evaluation: start/choices/choose are
  // player-driven and run long after the engine's install/connect ambient
  // closes. Mirrors the eager capture in createReset.
  const predicates = createPredicateResolver({ accessor });
  const gateRuntime = predicates.runtime;
  const graphsById = new Map<string, DialogGraph>();
  const nodesByGraph = new Map<string, Map<string, DialogNode>>();
  for (const g of graphs) {
    if (graphsById.has(g.id)) {
      throw new Error(`Dialog runtime: duplicate dialog graph id "${g.id}"`);
    }
    graphsById.set(g.id, g);
    const nodes = new Map<string, DialogNode>();
    nodesByGraph.set(g.id, nodes);
    for (const node of g.nodes) {
      if (nodes.has(node.id)) {
        throw new Error(`Dialog runtime: duplicate node id "${node.id}" in dialog graph "${g.id}"`);
      }
      nodes.set(node.id, node);
      const label = `dialog '${g.id}' node '${node.id}'`;
      if (node.when) predicates.assert(node.when, `${label} condition`);
      for (const choice of node.choices ?? []) {
        if (choice.visible) {
          predicates.assert(choice.visible, `${label} choice '${choice.id}' condition`);
        }
      }
    }
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
    return evaluateGate(predicate, gateRuntime);
  }

  /** Whether a node's or choice's gate is absent or passes. */
  function passes(gate: Gate | undefined): boolean {
    return !gate || holds(gate);
  }

  function canEnter(graphId: string, nodeId: string): boolean {
    return passes(lookupNode(graphId, nodeId).when);
  }

  function recordVisit(graphId: string, nodeId: string): void {
    const visits = state.visitCounts[graphId] ?? (state.visitCounts[graphId] = {});
    visits[nodeId] = (visits[nodeId] ?? 0) + 1;
  }

  function getVisitCount(graphId: string, nodeId: string): number {
    return state.visitCounts[graphId]?.[nodeId] ?? 0;
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

  /** Whether a node's fall-through `next` exists and its gate passes. */
  function canEnterNext(graphId: string, node: DialogNode): boolean {
    return !!node.next && canEnter(graphId, node.next);
  }

  /**
   * Auto-advance through fall-through nodes — no visible choices and an
   * enterable `next` — until landing on a node with a visible choice or one
   * whose `next` is absent or gated off. Each entered node fires its onEnter
   * and increments its visit count.
   */
  function settle(): void {
    const graphId = state.activeGraphId;
    let nodeId = state.activeNodeId;
    if (!graphId || !nodeId) return;
    // Guard against an authored next-only cycle (a → b → a): without it the
    // fall-through walk spins forever. Checked before entering, so no node's
    // onEnter runs twice on the way to the throw.
    const seen = new Set<string>([nodeId]);
    for (;;) {
      const node = lookupNode(graphId, nodeId);
      if (gatedChoices(node).length > 0 || !canEnterNext(graphId, node)) return;
      nodeId = node.next!;
      if (seen.has(nodeId)) {
        throw new Error(`Dialog graph "${graphId}" has a next-only cycle through node "${nodeId}"`);
      }
      seen.add(nodeId);
      activate(graphId, nodeId);
    }
  }

  function gatedChoices(node: DialogNode): DialogChoice[] {
    return (node.choices ?? []).filter((c) => passes(c.visible));
  }

  function emitPresented(): void {
    const snap = present();
    if (snap) events.emit('presented', snap);
  }

  function start(graphId: string, entryNode?: string): boolean {
    const graph = lookupGraph(graphId);
    const targetId = entryNode ?? graph.entry;
    if (!canEnter(graphId, targetId)) return false;
    activate(graphId, targetId);
    settle();
    emitPresented();
    return true;
  }

  function present(): DialogPresentation | null {
    if (!state.activeGraphId || !state.activeNodeId) return null;
    const node = lookupNode(state.activeGraphId, state.activeNodeId);
    const choices = gatedChoices(node);
    return {
      nodeId: node.id,
      text: node.text,
      choices: choices.map((c) => ({ id: c.id, text: c.text })),
      terminal: choices.length === 0 && !canEnterNext(state.activeGraphId, node),
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
    if (!passes(choice.visible)) {
      throw new Error(`Choice ${choiceId} on node ${nodeId} is currently gated off`);
    }
    if (choice.outcomes) {
      for (const eff of choice.outcomes) applyEffect(eff, accessor, mutator);
    }
    events.emit('chosen', { graphId, nodeId, choiceId });

    if (!choice.next || !canEnter(graphId, choice.next)) {
      finish();
      return;
    }
    activate(graphId, choice.next);
    settle();
    emitPresented();
  }

  function advance(): void {
    const snap = present();
    if (!snap) throw new Error('No active dialog node — call start() first');
    if (snap.choices.length > 0 || snap.terminal) {
      throw new Error(`Dialog node ${snap.nodeId} has nothing to advance through`);
    }
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
    advance,
    finish,
    isActive,
    getVisitCount,
    exportState,
    importState,
    on: events.on,
  };
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
