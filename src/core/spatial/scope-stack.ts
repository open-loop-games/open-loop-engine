/**
 * ScopeStack<N, E> — stack navigator over a recursive `Graph`.
 *
 * @cluster spatial-scope-stack
 *
 * Plain-data, Vue-free. Tracks which nested child graph the player is
 * currently inside, given a caller-owned tree of graphs-within-graphs built
 * via `Graph.createChildGraph`. The active path (e.g. `[pkgA, pkgB,
 * pkgC]`) is a list of the node ids whose child graphs have been entered in
 * order; `current` resolves to the innermost graph, `breadcrumb` resolves it
 * to the owning nodes.
 *
 * Ownership split:
 * - Caller owns the graph tree and the `recalculate` function (what "stable"
 *   or "unstable" means in-game). Caller decides when to trigger recalculation.
 * - Stack owns navigation state: the active path, a per-path status cache,
 *   and enter/exit events.
 *
 * Event coupling:
 * - The stack does NOT subscribe to graph events for recalculate propagation
 *   — callers drive `recalculateAt` explicitly from their own event bus.
 *   This keeps the primitive a passive state holder and avoids an import
 *   cycle between the stack and the graph event bus.
 * - The stack DOES subscribe to each ancestor graph's `nodeRemoved` for
 *   dangling-path detection. A node in the active path can be removed from
 *   its parent graph. The stack then exits every affected graph scope,
 *   innermost first, and emits `scope:exited` for each.
 *
 * Events (the `scope:` family):
 * - `scope:entered(nodeId, depth)` — after `enter` pushes, depth is the new
 *   (deeper) depth.
 * - `scope:exited(nodeId, depth)` — after `exit` pops, depth is the new
 *   (shallower) depth.
 * - `scope:recalculated(path, status)` — after `recalculateAt` stores a
 *   status at the given path.
 *
 * Recalculate propagation: `recalculateAt(p)` calls `options.recalculate`,
 * caches the returned status, emits `scope:recalculated`, then recursively
 * invokes `recalculateAt` on the parent path. Propagation stops when the
 * returned status is equal to the previously-cached status at that path —
 * i.e. "no change here, so no ancestor needs to re-evaluate." This is a
 * heuristic, not a formal convergence guarantee; callers whose recalc is
 * non-idempotent may see surprising behavior.
 *
 * Persistence: `serialize()` returns the active path only. The status cache
 * is ephemeral — cleared on `restore` and rebuilt as callers drive
 * `recalculateAt` after load. No events are emitted during restore. Restore the
 * graph first, then the stack: `Graph.restore` replaces every child
 * graph, so a stack left standing over the old ones reads and writes
 * detached graphs, and a removal no longer exits it. `stack.restore`
 * re-resolves the path against the live tree.
 */

import { createEmitHandle } from '../events';
import type { Graph, GraphNode } from './graph';
import type { Unsubscribe } from './types';

/**
 * Caller-owned scope status. `'pristine'`, `'unstable'` and `'stable'` are
 * the conventional values; any string is valid so consumers can widen the
 * vocabulary without engine churn. Plain `string` rather than a literal union
 * plus `(string & {})`, so a consumer's `state === 'stable'` check narrows.
 */
export type ScopeStatus = string;

/** Options accepted by {@link createScopeStack}. */
export interface ScopeStackOptions<N, E> {
  /** Root graph the stack navigates from. The stack never mutates it. */
  readonly root: Graph<N, E>;
  /**
   * Invoked by `recalculateAt`. Caller computes the graph scope's status from
   * the graph at the given path and returns it. The stack caches the result
   * and bubbles up to ancestors until the returned status stops changing.
   * Omit to make `recalculateAt` a no-op — useful for consumers that only
   * want navigation without a derived status.
   */
  readonly recalculate?: (graph: Graph<N, E>, path: readonly string[]) => ScopeStatus;
}

/**
 * Serialized form of the stack's navigation state. The status cache is
 * not serialized; consumers re-drive `recalculateAt` after restore as their
 * game state demands.
 */
export interface SerializedScopeStack {
  version: 1;
  path: string[];
}

/** Events emitted by a {@link ScopeStack}. Subscribe via `stack.on()`. */
export interface ScopeStackEvents {
  'scope:entered': (nodeId: string, depth: number) => void;
  'scope:exited': (nodeId: string, depth: number) => void;
  'scope:recalculated': (path: readonly string[], status: ScopeStatus) => void;
}

/** Navigation cursor over a recursive graph-of-graphs. */
export interface ScopeStack<N, E> {
  /** The graph the stack was constructed with. */
  readonly root: Graph<N, E>;

  // Navigation --------------------------------------------------------------

  /**
   * Enter `nodeId`'s child graph as a new graph scope. The node must exist
   * in the current graph and have a child graph (created via
   * `Graph.createChildGraph`). Throws otherwise — the stack does not invent
   * the tree.
   */
  enter(nodeId: string): void;
  /** Exit the innermost graph scope. No-op at root. */
  exit(): void;
  /** Exit every graph scope, back to root. */
  exitToRoot(): void;

  // Inspection --------------------------------------------------------------

  /**
   * The active path: one node id per graph scope entered, innermost last. Live reference.
   *
   * `path`, `depth`, `current`, `currentNodeId` and `breadcrumb` are snapshots:
   * a computed over them never recomputes. Watch `scope:entered` and
   * `scope:exited` and re-read.
   */
  readonly path: readonly string[];
  /** `path.length`. */
  readonly depth: number;
  /** The innermost graph scope's graph — `root` at scope depth 0. */
  readonly current: Graph<N, E>;
  /** The node id of the innermost graph scope, or `null` at root. */
  readonly currentNodeId: string | null;
  /** The path resolved to owning nodes, root-to-leaf. Fresh array per read. */
  readonly breadcrumb: readonly GraphNode<N>[];

  // Status propagation ------------------------------------------------------

  /**
   * Trigger `options.recalculate` at `path`, cache the result, and bubble
   * the call to the parent path until the cached status stops changing. No-op
   * if no `recalculate` option was provided, or if the path does not resolve
   * (e.g. a node has been removed since the caller captured the path).
   */
  recalculateAt(path: readonly string[]): void;
  /** Last cached status at `path`, or `undefined` if never recalculated. */
  statusAt(path: readonly string[]): ScopeStatus | undefined;

  // Events ------------------------------------------------------------------

  on<K extends keyof ScopeStackEvents>(event: K, handler: ScopeStackEvents[K]): Unsubscribe;

  // Persistence -------------------------------------------------------------

  serialize(): SerializedScopeStack;
  /**
   * Replace navigation state from `serialized`. Clears the status cache, pops
   * any active path silently, then rebuilds by walking the serialized path
   * from root. Throws if a path node (or its child graph) is missing. No
   * events are emitted during restore.
   */
  restore(serialized: SerializedScopeStack): void;
}

/**
 * Create a stack navigator over a `Graph`'s recursive child-graph tree.
 *
 * @param options - Required `root` graph; optional `recalculate` function
 *   that derives each graph scope's status.
 * @returns A fresh stack at the root (scope depth 0).
 *
 * @example
 * ```ts
 * interface Pkg { name: string }
 * interface Wire { kind: 'dependency' | 'symlink' }
 * const graph = createGraph<Pkg, Wire>();
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
  const graphStack: Graph<N, E>[] = [options.root];
  const subscriptions: Unsubscribe[] = [];
  const statusCache = new Map<string, ScopeStatus>();
  const handle = createEmitHandle<ScopeStackEvents>();

  function pathKey(p: readonly string[]): string {
    return JSON.stringify(p);
  }

  function resolveGraphAtPath(p: readonly string[]): Graph<N, E> | null {
    let g: Graph<N, E> = options.root;
    for (const id of p) {
      const child = g.getChildGraph(id);
      if (!child) return null;
      g = child;
    }
    return g;
  }

  function subscribeForLevel(parent: Graph<N, E>, levelIndex: number, nodeId: string): Unsubscribe {
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
        `ScopeStack.enter: node '${nodeId}' has no child graph — create one via Graph.createChildGraph first`,
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
    const prev = statusCache.get(key);
    statusCache.set(key, state);
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

    get current(): Graph<N, E> {
      return graphStack[graphStack.length - 1];
    },

    get currentNodeId(): string | null {
      return path.length === 0 ? null : path[path.length - 1];
    },

    get breadcrumb(): readonly GraphNode<N>[] {
      const trail: GraphNode<N>[] = [];
      let g: Graph<N, E> = options.root;
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

    statusAt(p: readonly string[]): ScopeStatus | undefined {
      return statusCache.get(pathKey(p));
    },

    on(event, handler) {
      return handle.on(event, handler);
    },

    serialize(): SerializedScopeStack {
      return { version: 1, path: path.slice() };
    },

    restore(serialized: SerializedScopeStack): void {
      if (serialized.version !== 1) {
        throw new Error(
          `ScopeStack.restore: unsupported format version ${String(serialized.version)}`,
        );
      }

      while (path.length > 0) {
        path.pop();
        graphStack.pop();
        subscriptions.pop()?.();
      }
      statusCache.clear();

      let cur: Graph<N, E> = options.root;
      for (const id of serialized.path) {
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
