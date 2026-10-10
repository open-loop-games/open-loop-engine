/**
 * SpatialGraph<N, E> — keyed nodes/edges with nested child-graph support.
 *
 * @cluster spatial-graph
 *
 * Plain-data, Vue-free. Authoritative storage is two `Map`s (nodes, edges)
 * plus an adjacency index. Nodes may own a nested `SpatialGraph` accessed
 * via `createChildGraph` / `getChildGraph`, enabling recursive scope
 * structures (ScopeStack composes on top).
 *
 * Persistence is structure-level: `serialize()` returns a plain-object
 * snapshot whose `children` field is a recursive map of child-graph
 * snapshots. `restore(snapshot)` rebuilds in place. The consumer wraps the
 * snapshot in a single `persistent()` ref — the engine never spawns per-
 * node refs. Deeply-nested structures hit the JS engine's JSON depth limit
 * (~10k levels); current consumers sit at 2–5.
 *
 * Events (camelCase, matching grid.ts):
 * - `nodeAdded(node)`
 * - `nodeRemoved(id)`
 * - `edgeAdded(edge)`
 * - `edgeRemoved(id, fromId, toId)`
 * - `childGraphCreated(nodeId, child)`
 * - `childGraphDestroyed(nodeId)`
 *
 * `removeNode` cascades: all attached edges emit first, then any child
 * graph is destroyed (descendants emitted on the child's handle bottom-up),
 * then `childGraphDestroyed` fires on this graph, then `nodeRemoved`.
 *
 * Multigraph is permitted — `addEdge` does not dedupe. Undirected semantics:
 * `edgesBetween(a, b)` returns edges with either endpoint ordering.
 */

import { createEmitHandle } from '../events';
import type { Unsubscribe } from './types';

/**
 * A node in a {@link SpatialGraph}. `parentId` is the owning-node back-
 * pointer for nested child graphs — `null` for nodes in the root graph.
 */
export interface GraphNode<N> {
  readonly id: string;
  readonly data: N;
  readonly parentId: string | null;
}

/** An edge in a {@link SpatialGraph}. Undirected by convention; endpoints are symmetric. */
export interface GraphEdge<E> {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly data: E;
}

/** Options accepted by {@link createSpatialGraph}. */
export interface SpatialGraphOptions {
  /**
   * Stable ID generator used when `addNode` / `addEdge` are called without
   * an explicit `id`. Defaults to a closure-local monotonic counter. Child
   * graphs inherit the parent's generator, and a draw already held by any
   * node or edge anywhere in the tree is skipped, so auto ids stay unique
   * across levels, a restore included. After a reload the default counter
   * restarts, so a fresh id can reuse one a removed node or edge once held;
   * to keep the sequence an uninterrupted session would draw, inject a
   * counter and persist its position.
   */
  readonly idGenerator?: () => string;
}

/** Events emitted by a {@link SpatialGraph}. Subscribe via `graph.on()`. */
export interface SpatialGraphEvents<N, E> {
  nodeAdded: (node: GraphNode<N>) => void;
  nodeRemoved: (id: string) => void;
  edgeAdded: (edge: GraphEdge<E>) => void;
  edgeRemoved: (id: string, fromId: string, toId: string) => void;
  childGraphCreated: (nodeId: string, child: SpatialGraph<N, E>) => void;
  childGraphDestroyed: (nodeId: string) => void;
}

/**
 * Plain-object snapshot of a graph's full state, including recursively any
 * child graphs. Returned by `serialize()` and accepted by `restore()`. Wrap
 * in a single `persistent()` ref to persist across saves; per-node
 * `persistent()` is explicitly rejected.
 */
export interface SerializedGraph<N, E> {
  version: 1;
  nodes: Array<{ id: string; data: N }>;
  edges: Array<{ id: string; fromId: string; toId: string; data: E }>;
  /** nodeId → child graph snapshot. Keys must reference ids in `nodes`. */
  children: Record<string, SerializedGraph<N, E>>;
}

/** Keyed node/edge container with nested child-graph composition. */
export interface SpatialGraph<N, E> {
  // Node CRUD ----------------------------------------------------------------

  /**
   * Adds a node carrying `data`. If `opts.id` is provided, it is used as-is
   * and must be unique within this graph; otherwise the configured
   * `idGenerator` is called. The returned node's `parentId` reflects the
   * graph's owner — non-null for nodes in child graphs, null at root.
   *
   * Always emits `nodeAdded`; the engine has no equality contract for `N`.
   */
  addNode(data: N, opts?: { id?: string }): GraphNode<N>;

  /**
   * Removes a node by id. Cascade order: every attached edge is removed
   * first (each emits `edgeRemoved`); any child graph is then destroyed
   * bottom-up (its own nodes/edges emit on the child's handle), followed
   * by `childGraphDestroyed(id)` on this graph; finally `nodeRemoved(id)`
   * fires. Throws if the node does not exist.
   */
  removeNode(id: string): void;

  getNode(id: string): GraphNode<N> | undefined;

  // Edge CRUD ----------------------------------------------------------------

  /**
   * Adds an edge between two existing nodes. Undirected by convention;
   * `fromId` / `toId` ordering is preserved but does not imply direction.
   * Multigraph is permitted — no deduplication against existing edges.
   * Throws if either endpoint is missing or `opts.id` collides.
   */
  addEdge(fromId: string, toId: string, data: E, opts?: { id?: string }): GraphEdge<E>;

  removeEdge(id: string): void;
  getEdge(id: string): GraphEdge<E> | undefined;

  // Raw access (hot path) ----------------------------------------------------

  /** Live authoritative node map. Safe to read directly from hot-path loops. */
  readonly nodes: ReadonlyMap<string, GraphNode<N>>;
  /** Live authoritative edge map. Safe to read directly from hot-path loops. */
  readonly edges: ReadonlyMap<string, GraphEdge<E>>;

  // Adjacency / traversal ----------------------------------------------------

  /** Nodes on the other end of any edge touching `nodeId`. Throws if node missing. */
  neighbors(nodeId: string): Iterable<GraphNode<N>>;
  /** Edges touching `nodeId`. Throws if node missing. */
  edgesOf(nodeId: string): Iterable<GraphEdge<E>>;
  /** Edges between `a` and `b` in either ordering (undirected). Throws if either node missing. */
  edgesBetween(a: string, b: string): Iterable<GraphEdge<E>>;

  /**
   * Breadth-first reachability from `startId`. Returns a parent-link map:
   * key is a reachable node id, value is the predecessor node on the BFS
   * path. The start node maps to itself. `allowEdge`, if provided, filters
   * which edges may be traversed — e.g. skipping 'sibling' edges.
   */
  bfs(startId: string, allowEdge?: (edge: GraphEdge<E>) => boolean): Map<string, GraphNode<N>>;

  /** True if `a` and `b` are in the same connected component. Throws if either node missing. */
  isConnected(a: string, b: string): boolean;

  // Duplicate scanning -------------------------------------------------------

  /**
   * Bucket nodes by a caller-supplied key. Returns only buckets with ≥ 2
   * entries — i.e. actual duplicates. O(n) over nodes; the caller owns any
   * dirty-flag caching (graph mutation shapes are domain-specific).
   */
  findDuplicateGroups<K>(keyFn: (node: GraphNode<N>) => K): Map<K, GraphNode<N>[]>;

  // Nested child graphs ------------------------------------------------------

  /** Child graph owned by `nodeId`, or `null` if none exists (or node missing). */
  getChildGraph(nodeId: string): SpatialGraph<N, E> | null;

  /**
   * Creates a new empty child graph under `nodeId`. The child inherits this
   * graph's `idGenerator` and its record of ids in use, so auto ids stay
   * unique across levels. Throws if the node is missing or a child already
   * exists — use `getChildGraph` for the conditional case.
   */
  createChildGraph(nodeId: string): SpatialGraph<N, E>;

  // Events -------------------------------------------------------------------

  on<K extends keyof SpatialGraphEvents<N, E>>(
    event: K,
    handler: SpatialGraphEvents<N, E>[K],
  ): Unsubscribe;

  // Persistence --------------------------------------------------------------

  serialize(): SerializedGraph<N, E>;
  /**
   * Replace this graph's state from a snapshot: clears nodes, edges, and
   * child graphs, then rebuilds from `snapshot`. Silent: no events fire, so
   * a view over the graph re-reads it after a restore.
   *
   * Every child graph is a new object afterwards, even under an owner id
   * that survives, so anything holding one points at a detached graph whose
   * writes never reach the next `serialize()`. Re-acquire held children via
   * `getChildGraph`, and call `restore` on a `ScopeStack` over this graph
   * after this restore, never before.
   *
   * Throws on a snapshot integrity violation anywhere in its tree (unknown
   * version, duplicate id, edge referencing missing node, child keyed on
   * missing node), before it changes anything: a rejected restore leaves the
   * graph and its children as they were.
   */
  restore(serialized: SerializedGraph<N, E>): void;
}

/**
 * Create a keyed graph container with nested child-graph support.
 *
 * @example
 * ```ts
 * interface Package { name: string; }
 * interface Wire { kind: 'dependency' | 'symlink'; }
 * const graph = createSpatialGraph<Package, Wire>();
 * const a = graph.addNode({ name: 'root' }, { id: 'pkg-a' });
 * const b = graph.addNode({ name: 'lib' }, { id: 'pkg-b' });
 * graph.addEdge(a.id, b.id, { kind: 'dependency' });
 * const internals = graph.createChildGraph(a.id);
 * internals.addNode({ name: 'a/internal' });
 * ```
 */
export function createSpatialGraph<N, E>(options?: SpatialGraphOptions): SpatialGraph<N, E> {
  return makeGraph<N, E>(
    { idGenerator: options?.idGenerator ?? defaultIdGenerator(), takenIds: new Map() },
    null,
  );
}

/** What every graph in one tree shares: the id source and the ids in use. */
interface TreeOptions {
  readonly idGenerator: () => string;
  /**
   * Every node and edge id held anywhere in the tree, counted, since an
   * explicit id may repeat across levels. Auto ids skip these, so they stay
   * unique tree-wide after a restore reloads ids the generator will produce
   * again.
   */
  readonly takenIds: Map<string, number>;
}

// `initial` is a snapshot validateSerialized has already passed, loaded as the
// graph is built.
function makeGraph<N, E>(
  tree: TreeOptions,
  ownerNodeId: string | null,
  initial?: SerializedGraph<N, E>,
): SpatialGraph<N, E> {
  const { idGenerator, takenIds } = tree;

  const nodes = new Map<string, GraphNode<N>>();
  const edges = new Map<string, GraphEdge<E>>();
  // nodeId → set of edge ids touching it (both endpoints indexed).
  const adjacency = new Map<string, Set<string>>();
  const childGraphs = new Map<string, SpatialGraph<N, E>>();

  const handle = createEmitHandle<SpatialGraphEvents<N, E>>();

  function requireNode(id: string): GraphNode<N> {
    const node = nodes.get(id);
    if (!node) throw new Error(`SpatialGraph: node '${id}' does not exist`);
    return node;
  }

  // Resolve an id for a new node/edge. An explicit id passes through (the caller
  // still rejects collisions). An auto id skips every id taken in the tree,
  // because restore() reloads ids the generator will hand out again — the
  // default counter starts fresh at 0 while the tree already holds "1".."N", so
  // the next draw would clash. Bounded to surface a broken (non-advancing)
  // consumer idGenerator instead of spinning forever.
  function resolveId(explicit: string | undefined): string {
    if (explicit !== undefined) return explicit;
    for (let attempts = 0; attempts < 1_000_000; attempts++) {
      const candidate = idGenerator();
      if (!takenIds.has(candidate)) return candidate;
    }
    throw new Error('SpatialGraph: idGenerator failed to produce a free id after 1e6 attempts');
  }

  function takeId(id: string): void {
    takenIds.set(id, (takenIds.get(id) ?? 0) + 1);
  }

  function releaseId(id: string): void {
    const n = takenIds.get(id) ?? 0;
    if (n > 1) takenIds.set(id, n - 1);
    else takenIds.delete(id);
  }

  // Release every id this graph and its descendants hold, before a restore
  // replaces them.
  function releaseSubtree(g: SpatialGraph<N, E>): void {
    for (const id of g.edges.keys()) releaseId(id);
    for (const id of g.nodes.keys()) {
      releaseId(id);
      const child = g.getChildGraph(id);
      if (child) releaseSubtree(child);
    }
  }

  function indexEdge(edge: GraphEdge<E>): void {
    let fromSet = adjacency.get(edge.fromId);
    if (!fromSet) {
      fromSet = new Set();
      adjacency.set(edge.fromId, fromSet);
    }
    fromSet.add(edge.id);
    if (edge.fromId !== edge.toId) {
      let toSet = adjacency.get(edge.toId);
      if (!toSet) {
        toSet = new Set();
        adjacency.set(edge.toId, toSet);
      }
      toSet.add(edge.id);
    }
  }

  function unindexEdge(edge: GraphEdge<E>): void {
    adjacency.get(edge.fromId)?.delete(edge.id);
    if (edge.fromId !== edge.toId) {
      adjacency.get(edge.toId)?.delete(edge.id);
    }
  }

  function removeEdgeInternal(id: string): void {
    const edge = edges.get(id);
    if (!edge) throw new Error(`SpatialGraph: edge '${id}' does not exist`);
    edges.delete(id);
    releaseId(id);
    unindexEdge(edge);
    handle.emit('edgeRemoved', edge.id, edge.fromId, edge.toId);
  }

  function cascadeDestroy(child: SpatialGraph<N, E>): void {
    // Snapshot keys so iteration is stable while the child mutates itself.
    const childNodeIds = Array.from(child.nodes.keys());
    for (const childNodeId of childNodeIds) {
      child.removeNode(childNodeId);
    }
  }

  const graph: SpatialGraph<N, E> = {
    nodes,
    edges,

    addNode(data, opts) {
      const id = resolveId(opts?.id);
      if (nodes.has(id)) {
        throw new Error(`SpatialGraph.addNode: node id '${id}' already exists`);
      }
      const node: GraphNode<N> = { id, data, parentId: ownerNodeId };
      nodes.set(id, node);
      takeId(id);
      handle.emit('nodeAdded', node);
      return node;
    },

    removeNode(id) {
      const node = requireNode(id);
      const edgeIds = Array.from(adjacency.get(id) ?? []);
      for (const edgeId of edgeIds) {
        removeEdgeInternal(edgeId);
      }
      adjacency.delete(id);

      const child = childGraphs.get(id);
      if (child) {
        cascadeDestroy(child);
        childGraphs.delete(id);
        handle.emit('childGraphDestroyed', id);
      }

      nodes.delete(id);
      releaseId(id);
      handle.emit('nodeRemoved', node.id);
    },

    getNode(id) {
      return nodes.get(id);
    },

    addEdge(fromId, toId, data, opts) {
      requireNode(fromId);
      requireNode(toId);
      const id = resolveId(opts?.id);
      if (edges.has(id)) {
        throw new Error(`SpatialGraph.addEdge: edge id '${id}' already exists`);
      }
      const edge: GraphEdge<E> = { id, fromId, toId, data };
      edges.set(id, edge);
      takeId(id);
      indexEdge(edge);
      handle.emit('edgeAdded', edge);
      return edge;
    },

    removeEdge(id) {
      removeEdgeInternal(id);
    },

    getEdge(id) {
      return edges.get(id);
    },

    *neighbors(nodeId) {
      requireNode(nodeId);
      const edgeIds = adjacency.get(nodeId);
      if (!edgeIds) return;
      const seen = new Set<string>();
      for (const edgeId of edgeIds) {
        const edge = edges.get(edgeId);
        if (!edge) continue;
        const otherId = edge.fromId === nodeId ? edge.toId : edge.fromId;
        if (seen.has(otherId)) continue;
        seen.add(otherId);
        const other = nodes.get(otherId);
        if (other) yield other;
      }
    },

    *edgesOf(nodeId) {
      requireNode(nodeId);
      const edgeIds = adjacency.get(nodeId);
      if (!edgeIds) return;
      for (const edgeId of edgeIds) {
        const edge = edges.get(edgeId);
        if (edge) yield edge;
      }
    },

    *edgesBetween(a, b) {
      requireNode(a);
      requireNode(b);
      const edgeIds = adjacency.get(a);
      if (!edgeIds) return;
      for (const edgeId of edgeIds) {
        const edge = edges.get(edgeId);
        if (!edge) continue;
        const matches =
          (edge.fromId === a && edge.toId === b) || (edge.fromId === b && edge.toId === a);
        if (matches) yield edge;
      }
    },

    bfs(startId, allowEdge) {
      const result = new Map<string, GraphNode<N>>();
      const start = nodes.get(startId);
      if (!start) return result;
      result.set(start.id, start);
      const queue: GraphNode<N>[] = [start];
      let head = 0;
      while (head < queue.length) {
        const cur = queue[head++];
        const edgeIds = adjacency.get(cur.id);
        if (!edgeIds) continue;
        for (const edgeId of edgeIds) {
          const edge = edges.get(edgeId);
          if (!edge) continue;
          if (allowEdge && !allowEdge(edge)) continue;
          const otherId = edge.fromId === cur.id ? edge.toId : edge.fromId;
          if (result.has(otherId)) continue;
          const other = nodes.get(otherId);
          if (!other) continue;
          result.set(otherId, cur);
          queue.push(other);
        }
      }
      return result;
    },

    isConnected(a, b) {
      requireNode(a);
      requireNode(b);
      if (a === b) return true;
      return this.bfs(a).has(b);
    },

    findDuplicateGroups(keyFn) {
      const buckets = new Map<ReturnType<typeof keyFn>, GraphNode<N>[]>();
      for (const node of nodes.values()) {
        const key = keyFn(node);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(node);
        else buckets.set(key, [node]);
      }
      for (const [key, group] of buckets) {
        if (group.length < 2) buckets.delete(key);
      }
      return buckets;
    },

    getChildGraph(nodeId) {
      return childGraphs.get(nodeId) ?? null;
    },

    createChildGraph(nodeId) {
      requireNode(nodeId);
      if (childGraphs.has(nodeId)) {
        throw new Error(
          `SpatialGraph.createChildGraph: child graph already exists for '${nodeId}'`,
        );
      }
      const child = makeGraph<N, E>(tree, nodeId);
      childGraphs.set(nodeId, child);
      handle.emit('childGraphCreated', nodeId, child);
      return child;
    },

    on(event, handler) {
      return handle.on(event, handler);
    },

    serialize() {
      const children: Record<string, SerializedGraph<N, E>> = {};
      for (const [ownerId, child] of childGraphs) {
        children[ownerId] = child.serialize();
      }
      return {
        version: 1,
        nodes: Array.from(nodes.values(), (n) => ({ id: n.id, data: n.data })),
        edges: Array.from(edges.values(), (e) => ({
          id: e.id,
          fromId: e.fromId,
          toId: e.toId,
          data: e.data,
        })),
        children,
      };
    },

    restore(serialized) {
      validateSerialized(serialized);
      releaseSubtree(graph);
      nodes.clear();
      edges.clear();
      adjacency.clear();
      childGraphs.clear();
      load(serialized);
    },
  };

  // Build from a snapshot validateSerialized has passed, into an empty graph.
  function load(snapshot: SerializedGraph<N, E>): void {
    for (const entry of snapshot.nodes) {
      nodes.set(entry.id, { id: entry.id, data: entry.data, parentId: ownerNodeId });
      takeId(entry.id);
    }
    for (const entry of snapshot.edges) {
      const edge: GraphEdge<E> = {
        id: entry.id,
        fromId: entry.fromId,
        toId: entry.toId,
        data: entry.data,
      };
      edges.set(entry.id, edge);
      takeId(entry.id);
      indexEdge(edge);
    }
    for (const [ownerId, childSnap] of Object.entries(snapshot.children)) {
      childGraphs.set(ownerId, makeGraph<N, E>(tree, ownerId, childSnap));
    }
  }

  if (initial) load(initial);
  return graph;
}

// Throw on the first integrity violation anywhere in the serialized tree, so a
// restore rejects a bad serialized form before it touches the graph.
function validateSerialized<N, E>(serialized: SerializedGraph<N, E>): void {
  if (serialized.version !== 1) {
    throw new Error(
      `SpatialGraph.restore: unsupported format version ${String(serialized.version)}`,
    );
  }
  const nodeIds = new Set<string>();
  for (const { id } of serialized.nodes) {
    if (nodeIds.has(id)) throw new Error(`SpatialGraph.restore: duplicate node id '${id}'`);
    nodeIds.add(id);
  }
  const edgeIds = new Set<string>();
  for (const { id, fromId, toId } of serialized.edges) {
    if (!nodeIds.has(fromId) || !nodeIds.has(toId)) {
      throw new Error(
        `SpatialGraph.restore: edge '${id}' references missing node '${nodeIds.has(fromId) ? toId : fromId}'`,
      );
    }
    if (edgeIds.has(id)) throw new Error(`SpatialGraph.restore: duplicate edge id '${id}'`);
    edgeIds.add(id);
  }
  for (const [ownerId, childSnap] of Object.entries(serialized.children)) {
    if (!nodeIds.has(ownerId)) {
      throw new Error(`SpatialGraph.restore: child graph keyed on missing node '${ownerId}'`);
    }
    validateSerialized(childSnap);
  }
}

function defaultIdGenerator(): () => string {
  let n = 0;
  return () => {
    n++;
    return String(n);
  };
}
