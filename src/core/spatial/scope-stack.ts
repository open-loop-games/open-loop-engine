/**
 * ScopeStack<N, E> — stack navigator over a recursive `SpatialGraph`.
 *
 * @cluster spatial-scope-stack
 *
 * Plain-data, Vue-free. Tracks which nested child graph the player is
 * currently inside, given a caller-owned tree of graphs-within-graphs built
 * via `SpatialGraph.createChildGraph`. The active path (e.g. `[pkgA, pkgB,
 * pkgC]`) is a list of the node ids whose child graphs have been entered in
 * order; `current` resolves to the innermost graph, `breadcrumb` resolves it
 * to the owning nodes.
 *
 * Ownership split:
 * - Caller owns the graph tree and the `recalculate` policy (what "stable"
 *   or "unstable" means in-game). Caller decides when to trigger recalculation.
 * - Stack owns navigation state: the active path, a per-path derived-state
 *   cache, and enter/exit events.
 *
 * Event coupling:
 * - The stack does NOT subscribe to graph events for recalculate propagation
 *   — callers drive `recalculateAt` explicitly from their own event bus.
 *   This keeps the primitive a passive state holder and avoids a circular
 *   import between the stack and the graph event bus.
 * - The stack DOES subscribe to each ancestor graph's `nodeRemoved` for
 *   dangling-path detection: when a node in the active path is removed from
 *   its parent graph, the stack auto-exits all affected levels bottom-up and
 *   emits `scope:exited` for each.
 *
 * Events (namespaced, per the Phase 2 design sketch):
 * - `scope:entered(nodeId, depth)` — after `enter` pushes, depth is the new
 *   (deeper) depth.
 * - `scope:exited(nodeId, depth)` — after `exit` pops, depth is the new
 *   (shallower) depth.
 * - `scope:recalculated(path, state)` — after `recalculateAt` stores a label
 *   at the given path.
 *
 * Recalculate propagation: `recalculateAt(p)` calls `options.recalculate`,
 * caches the returned state, emits `scope:recalculated`, then recursively
 * invokes `recalculateAt` on the parent path. Propagation stops when the
 * returned state is equal to the previously-cached state at that path —
 * i.e. "no change here, so no ancestor needs to re-evaluate." This is a
 * heuristic, not a formal convergence guarantee; callers whose recalc is
 * non-idempotent may see surprising behavior.
 *
 * Persistence: `serialize()` returns the active path only. The state cache
 * is ephemeral — cleared on `restore` and rebuilt as callers drive
 * `recalculateAt` after load. No events fire during restore, matching
 * graph's silent bulk-load contract.
 */

import { createEmitHandle } from '../events';
import type { SpatialGraph, GraphNode } from './graph';
import type { Unsubscribe } from './types';

/**
 * Caller-owned scope-state label. The three defaults are conventional; any
 * string is valid so consumers can widen the vocabulary without engine churn.
 */
export type ScopeState = 'pristine' | 'unstable' | 'stable' | string;

/** Options accepted by {@link createScopeStack}. */
export interface ScopeStackOptions<N, E> {
  /** Root graph the stack navigates from. The stack never mutates it. */
  readonly root: SpatialGraph<N, E>;
  /**
   * Invoked by `recalculateAt`. Caller computes the scope's state label from
   * the graph at the given path and returns it. The stack caches the result
   * and bubbles up to ancestors until the returned label stops changing.
   * Omit to make `recalculateAt` a no-op — useful for consumers that only
   * want navigation without derived state.
   */
  readonly recalculate?: (graph: SpatialGraph<N, E>, path: readonly string[]) => ScopeState;
}

/**
 * Plain-object snapshot of the stack's navigation state. The state cache is
 * not serialized; consumers re-drive `recalculateAt` after restore as their
 * game state demands.
 */
export interface ScopeStackSnapshot {
  version: 1;
  path: string[];
}

/** Events emitted by a {@link ScopeStack}. Subscribe via `stack.on()`. */
export interface ScopeStackEvents {
  'scope:entered': (nodeId: string, depth: number) => void;
  'scope:exited': (nodeId: string, depth: number) => void;
  'scope:recalculated': (path: readonly string[], state: ScopeState) => void;
}

/** Navigation cursor over a recursive graph-of-graphs. */
export interface ScopeStack<N, E> {
  /** The graph the stack was constructed with. */
  readonly root: SpatialGraph<N, E>;

  // Navigation --------------------------------------------------------------

  /**
   * Dive into `nodeId`'s child graph. The node must exist in the current
   * graph and have a child graph (created via `SpatialGraph.createChildGraph`).
   * Throws otherwise — the stack does not invent the tree.
   */
  enter(nodeId: string): void;
  /** Pop one level. No-op at root. */
  exit(): void;
  /** Pop all levels back to root. */
  exitToRoot(): void;

  // Inspection --------------------------------------------------------------

  /** The active path: one id per level entered, innermost last. Live reference. */
  readonly path: readonly string[];
  /** `path.length`. */
  readonly depth: number;
  /** The graph at the innermost level — `root` at depth 0. */
  readonly current: SpatialGraph<N, E>;
  /** The id at the innermost level, or `null` at root. */
  readonly currentNodeId: string | null;
  /** The path resolved to owning nodes, root-to-leaf. Fresh array per read. */
  readonly breadcrumb: readonly GraphNode<N>[];

  // State propagation -------------------------------------------------------

  /**
   * Trigger `options.recalculate` at `path`, cache the result, and bubble
   * the call to the parent path until the cached state stops changing. No-op
   * if no `recalculate` option was provided, or if the path does not resolve
   * (e.g. a node has been removed since the caller captured the path).
   */
  recalculateAt(path: readonly string[]): void;
  /** Last cached state at `path`, or `undefined` if never recalculated. */
  stateAt(path: readonly string[]): ScopeState | undefined;

  // Events ------------------------------------------------------------------

  on<K extends keyof ScopeStackEvents>(event: K, handler: ScopeStackEvents[K]): Unsubscribe;

  // Persistence -------------------------------------------------------------

  serialize(): ScopeStackSnapshot;
  /**
   * Replace navigation state from `snapshot`. Clears the state cache, pops
   * any active path silently, then rebuilds by walking the snapshot path
   * from root. Throws if a path node (or its child graph) is missing. No
   * events fire during restore.
   */
  restore(snapshot: ScopeStackSnapshot): void;
}

/**
 * Create a stack navigator over a `SpatialGraph`'s recursive child-graph tree.
 *
 * @param options - Required `root` graph; optional `recalculate` callback
 *   wired to derive per-scope state labels.
 * @returns A fresh stack parked at the root (depth 0).
 *
 * @example
 * ```ts
 * interface Pkg { name: string }
 * interface Wire { kind: 'dependency' | 'symlink' }
 * const graph = createSpatialGraph<Pkg, Wire>();
 * graph.addNode({ name: 'outer' }, { id: 'outer' });
 * const inner = graph.createChildGraph('outer');
 * inner.addNode({ name: 'deep' }, { id: 'deep' });
 *
 * const stack = createScopeStack<Pkg, Wire>({
 *   root: graph,
 *   recalculate: (g) => (g.nodes.size > 0 ? 'stable' : 'pristine'),
 * });
 * stack.enter('outer');
 * stack.recalculateAt(stack.path); // caches 'stable' at ['outer']; bubbles to []
 * stack.exitToRoot();
 * ```
 */
export function createScopeStack<N, E>(options: ScopeStackOptions<N, E>): ScopeStack<N, E> {
  const path: string[] = [];
  const graphStack: SpatialGraph<N, E>[] = [options.root];
  const subscriptions: Unsubscribe[] = [];
  const stateCache = new Map<string, ScopeState>();
  const handle = createEmitHandle<ScopeStackEvents>();

  function pathKey(p: readonly string[]): string {
    return JSON.stringify(p);
  }

  function resolveGraphAtPath(p: readonly string[]): SpatialGraph<N, E> | null {
    let g: SpatialGraph<N, E> = options.root;
    for (const id of p) {
      const child = g.getChildGraph(id);
      if (!child) return null;
      g = child;
    }
    return g;
  }

  function subscribeForLevel(
    parent: SpatialGraph<N, E>,
    levelIndex: number,
    nodeId: string,
  ): Unsubscribe {
    return parent.on('nodeRemoved', (removedId) => {
      if (removedId !== nodeId) return;
      if (path.length <= levelIndex) return;
      if (path[levelIndex] !== nodeId) return;
      while (path.length > levelIndex) {
        exitInternal();
      }
    });
  }

  function exitInternal(): string | null {
    if (path.length === 0) return null;
    const nodeId = path.pop()!;
    graphStack.pop();
    subscriptions.pop()?.();
    handle.emit('scope:exited', nodeId, path.length);
    return nodeId;
  }

  function enter(nodeId: string): void {
    const parent = graphStack[graphStack.length - 1];
    if (!parent.getNode(nodeId)) {
      throw new Error(`ScopeStack.enter: node '${nodeId}' not found in current graph`);
    }
    const child = parent.getChildGraph(nodeId);
    if (!child) {
      throw new Error(
        `ScopeStack.enter: node '${nodeId}' has no child graph — create one via SpatialGraph.createChildGraph first`,
      );
    }
    const levelIndex = path.length;
    path.push(nodeId);
    graphStack.push(child);
    subscriptions.push(subscribeForLevel(parent, levelIndex, nodeId));
    handle.emit('scope:entered', nodeId, path.length);
  }

  function recalculateAt(p: readonly string[]): void {
    if (!options.recalculate) return;
    const graph = resolveGraphAtPath(p);
    if (!graph) return;
    const snapshot = p.slice();
    const state = options.recalculate(graph, snapshot);
    const key = pathKey(snapshot);
    const prev = stateCache.get(key);
    stateCache.set(key, state);
    handle.emit('scope:recalculated', snapshot, state);
    if (prev === state) return;
    if (snapshot.length === 0) return;
    recalculateAt(snapshot.slice(0, -1));
  }

  const stack: ScopeStack<N, E> = {
    root: options.root,

    enter,

    exit(): void {
      exitInternal();
    },

    exitToRoot(): void {
      while (path.length > 0) {
        exitInternal();
      }
    },

    get path(): readonly string[] {
      return path;
    },

    get depth(): number {
      return path.length;
    },

    get current(): SpatialGraph<N, E> {
      return graphStack[graphStack.length - 1];
    },

    get currentNodeId(): string | null {
      return path.length === 0 ? null : path[path.length - 1];
    },

    get breadcrumb(): readonly GraphNode<N>[] {
      const trail: GraphNode<N>[] = [];
      let g: SpatialGraph<N, E> = options.root;
      for (const id of path) {
        const node = g.getNode(id);
        if (!node) break;
        trail.push(node);
        const child = g.getChildGraph(id);
        if (!child) break;
        g = child;
      }
      return trail;
    },

    recalculateAt,

    stateAt(p: readonly string[]): ScopeState | undefined {
      return stateCache.get(pathKey(p));
    },

    on(event, handler) {
      return handle.on(event, handler);
    },

    serialize(): ScopeStackSnapshot {
      return { version: 1, path: path.slice() };
    },

    restore(snapshot: ScopeStackSnapshot): void {
      if (snapshot.version !== 1) {
        throw new Error(
          `ScopeStack.restore: unsupported snapshot version ${String(snapshot.version)}`,
        );
      }

      while (path.length > 0) {
        path.pop();
        graphStack.pop();
        subscriptions.pop()?.();
      }
      stateCache.clear();

      let cur: SpatialGraph<N, E> = options.root;
      for (const id of snapshot.path) {
        if (!cur.getNode(id)) {
          throw new Error(`ScopeStack.restore: path node '${id}' not found`);
        }
        const child = cur.getChildGraph(id);
        if (!child) {
          throw new Error(`ScopeStack.restore: path node '${id}' has no child graph`);
        }
        const levelIndex = path.length;
        subscriptions.push(subscribeForLevel(cur, levelIndex, id));
        path.push(id);
        graphStack.push(child);
        cur = child;
      }
    },
  };

  return stack;
}
