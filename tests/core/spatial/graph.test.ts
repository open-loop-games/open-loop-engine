import { describe, it, expect } from 'vitest';
import { beginPersistentContext, endPersistentContext, persistent } from '@/core/persistence';
import { createSpatialGraph, type GraphEdge, type SerializedGraph } from '@/core/spatial';

interface Pkg {
  name: string;
}

interface Wire {
  kind: 'dependency' | 'symlink' | 'sibling';
}

const pkg = (name: string): Pkg => ({ name });

describe('createSpatialGraph — construction & basic CRUD', () => {
  it('starts empty and generates ids monotonically by default', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    expect(graph.nodes.size).toBe(0);
    expect(graph.edges.size).toBe(0);
    const a = graph.addNode(pkg('a'));
    const b = graph.addNode(pkg('b'));
    expect(a.id).toBe('1');
    expect(b.id).toBe('2');
    expect(a.parentId).toBeNull();
  });

  it('addNode respects explicit id and rejects collisions', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    const a = graph.addNode(pkg('a'), { id: 'pkg-a' });
    expect(a.id).toBe('pkg-a');
    expect(() => graph.addNode(pkg('dup'), { id: 'pkg-a' })).toThrow(/already exists/);
  });

  it('addEdge requires both endpoints and respects explicit id', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    const a = graph.addNode(pkg('a'), { id: 'a' });
    const b = graph.addNode(pkg('b'), { id: 'b' });
    expect(() => graph.addEdge('a', 'missing', { kind: 'dependency' })).toThrow(/does not exist/);
    const e = graph.addEdge(a.id, b.id, { kind: 'dependency' }, { id: 'e1' });
    expect(e.id).toBe('e1');
    expect(graph.edges.size).toBe(1);
    expect(() => graph.addEdge(a.id, b.id, { kind: 'symlink' }, { id: 'e1' })).toThrow(
      /already exists/,
    );
  });

  it('allows multigraph — parallel edges between the same pair', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('a'), { id: 'a' });
    graph.addNode(pkg('b'), { id: 'b' });
    const e1 = graph.addEdge('a', 'b', { kind: 'dependency' });
    const e2 = graph.addEdge('a', 'b', { kind: 'symlink' });
    expect(e1.id).not.toBe(e2.id);
    expect(Array.from(graph.edges.values())).toHaveLength(2);
  });

  it('injects a deterministic idGenerator when caller supplies one', () => {
    let counter = 100;
    const graph = createSpatialGraph<Pkg, Wire>({
      idGenerator: () => `x${counter++}`,
    });
    const a = graph.addNode(pkg('a'));
    const b = graph.addNode(pkg('b'));
    expect(a.id).toBe('x100');
    expect(b.id).toBe('x101');
  });

  it('removeNode throws when id is missing', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    expect(() => graph.removeNode('missing')).toThrow(/does not exist/);
  });

  it('removeEdge throws when id is missing', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    expect(() => graph.removeEdge('missing')).toThrow(/does not exist/);
  });
});

describe('createSpatialGraph — adjacency & traversal', () => {
  it('neighbors and edgesOf return all incident connections', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('a'), { id: 'a' });
    graph.addNode(pkg('b'), { id: 'b' });
    graph.addNode(pkg('c'), { id: 'c' });
    graph.addEdge('a', 'b', { kind: 'dependency' });
    graph.addEdge('a', 'c', { kind: 'dependency' });

    const ns = Array.from(graph.neighbors('a'))
      .map((n) => n.id)
      .sort();
    expect(ns).toEqual(['b', 'c']);
    expect(Array.from(graph.edgesOf('b'))).toHaveLength(1);
  });

  it('edgesBetween is undirected', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('a'), { id: 'a' });
    graph.addNode(pkg('b'), { id: 'b' });
    graph.addEdge('a', 'b', { kind: 'dependency' });
    expect(Array.from(graph.edgesBetween('a', 'b'))).toHaveLength(1);
    expect(Array.from(graph.edgesBetween('b', 'a'))).toHaveLength(1);
  });

  it('bfs returns parent-link map, start → self', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    for (const id of ['a', 'b', 'c', 'd']) graph.addNode(pkg(id), { id });
    graph.addEdge('a', 'b', { kind: 'dependency' });
    graph.addEdge('b', 'c', { kind: 'dependency' });
    // 'd' is disconnected

    const parents = graph.bfs('a');
    expect(parents.get('a')?.id).toBe('a');
    expect(parents.get('b')?.id).toBe('a');
    expect(parents.get('c')?.id).toBe('b');
    expect(parents.has('d')).toBe(false);
  });

  it('bfs allowEdge filters traversal', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    for (const id of ['a', 'b', 'c']) graph.addNode(pkg(id), { id });
    graph.addEdge('a', 'b', { kind: 'dependency' });
    graph.addEdge('b', 'c', { kind: 'sibling' });

    const onlyDeps = graph.bfs('a', (e: GraphEdge<Wire>) => e.data.kind === 'dependency');
    expect(onlyDeps.has('b')).toBe(true);
    expect(onlyDeps.has('c')).toBe(false);
  });

  it('isConnected reflects component membership', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    for (const id of ['a', 'b', 'c']) graph.addNode(pkg(id), { id });
    graph.addEdge('a', 'b', { kind: 'dependency' });
    expect(graph.isConnected('a', 'b')).toBe(true);
    expect(graph.isConnected('a', 'a')).toBe(true);
    expect(graph.isConnected('a', 'c')).toBe(false);
  });
});

describe('createSpatialGraph — findDuplicateGroups', () => {
  it('returns only buckets with ≥ 2 nodes', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('react'), { id: '1' });
    graph.addNode(pkg('vue'), { id: '2' });
    graph.addNode(pkg('react'), { id: '3' });
    graph.addNode(pkg('react'), { id: '4' });

    const groups = graph.findDuplicateGroups((n) => n.data.name);
    expect(groups.has('vue')).toBe(false);
    expect(groups.get('react')).toHaveLength(3);
  });

  it('is empty when there are no duplicates', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('react'));
    graph.addNode(pkg('vue'));
    expect(graph.findDuplicateGroups((n) => n.data.name).size).toBe(0);
  });
});

describe('createSpatialGraph — nested child graphs', () => {
  it('createChildGraph stamps parentId on child nodes', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('root'), { id: 'r' });
    const child = graph.createChildGraph('r');
    const inner = child.addNode(pkg('inner'));
    expect(inner.parentId).toBe('r');
  });

  it('createChildGraph throws on missing node or double-create', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('r'), { id: 'r' });
    expect(() => graph.createChildGraph('missing')).toThrow(/does not exist/);
    graph.createChildGraph('r');
    expect(() => graph.createChildGraph('r')).toThrow(/already exists/);
  });

  it('getChildGraph returns null when no child exists', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('r'), { id: 'r' });
    expect(graph.getChildGraph('r')).toBeNull();
    expect(graph.getChildGraph('missing')).toBeNull();
  });

  it('child graphs inherit the parent idGenerator', () => {
    let counter = 0;
    const graph = createSpatialGraph<Pkg, Wire>({
      idGenerator: () => `g${++counter}`,
    });
    const r = graph.addNode(pkg('r'));
    expect(r.id).toBe('g1');
    const child = graph.createChildGraph(r.id);
    const inner = child.addNode(pkg('inner'));
    expect(inner.id).toBe('g2');
  });
});

describe('createSpatialGraph — cascade deletion ordering', () => {
  it('emits edgeRemoved for every attached edge before nodeRemoved', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('a'), { id: 'a' });
    graph.addNode(pkg('b'), { id: 'b' });
    graph.addNode(pkg('c'), { id: 'c' });
    graph.addEdge('a', 'b', { kind: 'dependency' }, { id: 'e1' });
    graph.addEdge('a', 'c', { kind: 'dependency' }, { id: 'e2' });

    const log: string[] = [];
    graph.on('edgeRemoved', (id) => log.push(`edge:${id}`));
    graph.on('nodeRemoved', (id) => log.push(`node:${id}`));

    graph.removeNode('a');
    expect(log[log.length - 1]).toBe('node:a');
    expect(log.filter((l) => l.startsWith('edge:')).sort()).toEqual(['edge:e1', 'edge:e2']);
    expect(graph.edges.size).toBe(0);
  });

  it('destroys a child graph and emits childGraphDestroyed before nodeRemoved', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('a'), { id: 'a' });
    const child = graph.createChildGraph('a');
    child.addNode(pkg('inner1'), { id: 'i1' });
    child.addNode(pkg('inner2'), { id: 'i2' });

    const log: string[] = [];
    graph.on('childGraphDestroyed', (id) => log.push(`destroyed:${id}`));
    graph.on('nodeRemoved', (id) => log.push(`node:${id}`));
    const innerLog: string[] = [];
    child.on('nodeRemoved', (id) => innerLog.push(id));

    graph.removeNode('a');

    expect(innerLog.sort()).toEqual(['i1', 'i2']);
    expect(log).toEqual(['destroyed:a', 'node:a']);
    expect(graph.getChildGraph('a')).toBeNull();
    expect(graph.nodes.has('a')).toBe(false);
  });

  it('cascades recursively through multiple nested levels', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('a'), { id: 'a' });
    const l1 = graph.createChildGraph('a');
    l1.addNode(pkg('b'), { id: 'b' });
    const l2 = l1.createChildGraph('b');
    l2.addNode(pkg('c'), { id: 'c' });

    graph.removeNode('a');
    expect(l2.nodes.size).toBe(0);
    expect(l1.nodes.size).toBe(0);
    expect(graph.nodes.size).toBe(0);
  });

  it('removeEdge emits and unindexes cleanly', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('a'), { id: 'a' });
    graph.addNode(pkg('b'), { id: 'b' });
    const e = graph.addEdge('a', 'b', { kind: 'dependency' });
    const seen: string[] = [];
    graph.on('edgeRemoved', (id) => seen.push(id));
    graph.removeEdge(e.id);
    expect(seen).toEqual([e.id]);
    expect(Array.from(graph.edgesOf('a'))).toHaveLength(0);
    expect(Array.from(graph.edgesOf('b'))).toHaveLength(0);
  });
});

describe('createSpatialGraph — events & subscriptions', () => {
  it('emits nodeAdded / edgeAdded with the new entities', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    const addedNodes: string[] = [];
    const addedEdges: string[] = [];
    graph.on('nodeAdded', (n) => addedNodes.push(n.id));
    graph.on('edgeAdded', (e) => addedEdges.push(e.id));
    graph.addNode(pkg('a'), { id: 'a' });
    graph.addNode(pkg('b'), { id: 'b' });
    graph.addEdge('a', 'b', { kind: 'dependency' }, { id: 'e' });
    expect(addedNodes).toEqual(['a', 'b']);
    expect(addedEdges).toEqual(['e']);
  });

  it('emits childGraphCreated with the new child', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('r'), { id: 'r' });
    let seenOwner = '';
    let seenChild: unknown = null;
    graph.on('childGraphCreated', (nodeId, child) => {
      seenOwner = nodeId;
      seenChild = child;
    });
    const child = graph.createChildGraph('r');
    expect(seenOwner).toBe('r');
    expect(seenChild).toBe(child);
  });

  it('unsubscribe stops further deliveries', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    const seen: string[] = [];
    const off = graph.on('nodeAdded', (n) => seen.push(n.id));
    graph.addNode(pkg('a'), { id: 'a' });
    off();
    graph.addNode(pkg('b'), { id: 'b' });
    expect(seen).toEqual(['a']);
  });
});

describe('createSpatialGraph — serialize / restore', () => {
  it('round-trips a flat graph preserving ids and data', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('a'), { id: 'a' });
    graph.addNode(pkg('b'), { id: 'b' });
    graph.addEdge('a', 'b', { kind: 'dependency' }, { id: 'e' });

    const snap = graph.serialize();
    expect(snap.version).toBe(1);

    const restored = createSpatialGraph<Pkg, Wire>();
    restored.restore(snap);
    expect(restored.getNode('a')?.data.name).toBe('a');
    expect(Array.from(restored.edgesOf('a'))).toHaveLength(1);
    expect(restored.isConnected('a', 'b')).toBe(true);
  });

  it('auto-id after restore does not collide with restored auto ids', () => {
    // First session hands out auto ids "1", "2".
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('a'));
    graph.addNode(pkg('b'));
    const snap = graph.serialize();

    // Second session restores into a fresh graph whose id counter starts at 0.
    // Adding a node must skip the already-restored "1"/"2" instead of clashing.
    const restored = createSpatialGraph<Pkg, Wire>();
    restored.restore(snap);
    expect(() => restored.addNode(pkg('c'))).not.toThrow();
    expect(restored.nodes.size).toBe(3);
  });

  it('auto-id after a reload stays unique across the whole tree, not just its own level', () => {
    // Before the save, one shared counter makes ids unique across levels:
    // root holds "1", "2" and the child of "1" holds "3", "4".
    const graph = createSpatialGraph<Pkg, Wire>();
    const owner = graph.addNode(pkg('a'));
    graph.addNode(pkg('b'));
    const child = graph.createChildGraph(owner.id);
    child.addNode(pkg('c'));
    child.addNode(pkg('d'));
    const saved = JSON.parse(JSON.stringify(graph.serialize())) as SerializedGraph<Pkg, Wire>;

    const restored = createSpatialGraph<Pkg, Wire>();
    restored.restore(saved);
    const fresh = restored.addNode(pkg('e'));
    const freshChild = restored.getChildGraph(owner.id)!.addNode(pkg('f'));

    expect(['1', '2', '3', '4']).not.toContain(fresh.id);
    expect(['1', '2', '3', '4', fresh.id]).not.toContain(freshChild.id);
  });

  it('an explicit id repeated across levels stays taken until every holder is gone', () => {
    const draws = ['x', 'y'];
    const graph = createSpatialGraph<Pkg, Wire>({ idGenerator: () => draws.shift() ?? 'z' });
    graph.addNode(pkg('owner'), { id: 'owner' });
    graph.addNode(pkg('root x'), { id: 'x' });
    graph.createChildGraph('owner').addNode(pkg('child x'), { id: 'x' });
    graph.removeNode('x');
    // The child still holds "x", so the generator's "x" is skipped.
    expect(graph.addNode(pkg('fresh')).id).toBe('y');
  });

  it('round-trips nested child graphs', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('a'), { id: 'a' });
    const child = graph.createChildGraph('a');
    child.addNode(pkg('inner'), { id: 'i' });
    const deeper = child.createChildGraph('i');
    deeper.addNode(pkg('deepest'), { id: 'd' });

    const snap = graph.serialize();
    const restored = createSpatialGraph<Pkg, Wire>();
    restored.restore(snap);

    const restoredChild = restored.getChildGraph('a');
    expect(restoredChild).not.toBeNull();
    const restoredDeeper = restoredChild!.getChildGraph('i');
    expect(restoredDeeper).not.toBeNull();
    expect(restoredDeeper!.getNode('d')?.data.name).toBe('deepest');
    // parentId back-pointers rebuild correctly
    expect(restoredChild!.getNode('i')?.parentId).toBe('a');
    expect(restoredDeeper!.getNode('d')?.parentId).toBe('i');
  });

  it('restore clears prior state before loading', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('old'), { id: 'old' });

    const fresh = createSpatialGraph<Pkg, Wire>();
    fresh.addNode(pkg('a'), { id: 'a' });
    graph.restore(fresh.serialize());

    expect(graph.getNode('old')).toBeUndefined();
    expect(graph.getNode('a')?.data.name).toBe('a');
  });

  it('restore rejects unknown version', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    const badSnap = {
      version: 2,
      nodes: [],
      edges: [],
      children: {},
    } as unknown as SerializedGraph<Pkg, Wire>;
    expect(() => graph.restore(badSnap)).toThrow(/unsupported format version/);
  });

  it('restore rejects edges with missing endpoints', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    const snap: SerializedGraph<Pkg, Wire> = {
      version: 1,
      nodes: [{ id: 'a', data: pkg('a') }],
      edges: [{ id: 'e', fromId: 'a', toId: 'missing', data: { kind: 'dependency' } }],
      children: {},
    };
    expect(() => graph.restore(snap)).toThrow(/missing node/);
  });

  it('restore rejects child graphs keyed on missing nodes', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    const snap: SerializedGraph<Pkg, Wire> = {
      version: 1,
      nodes: [],
      edges: [],
      children: {
        ghost: { version: 1, nodes: [], edges: [], children: {} },
      },
    };
    expect(() => graph.restore(snap)).toThrow(/missing node/);
  });

  it('a rejected restore leaves the graph as it was, wherever in the tree it fails', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('a'), { id: 'a' });
    graph.addNode(pkg('b'), { id: 'b' });
    graph.addEdge('a', 'b', { kind: 'dependency' }, { id: 'e1' });
    const child = graph.createChildGraph('a');
    child.addNode(pkg('i'), { id: 'i' });
    const before = graph.serialize();

    const danglingEdge: SerializedGraph<Pkg, Wire> = {
      version: 1,
      nodes: [{ id: 'x', data: pkg('x') }],
      edges: [{ id: 'e9', fromId: 'x', toId: 'ghost', data: { kind: 'dependency' } }],
      children: {},
    };
    const nestedDuplicate: SerializedGraph<Pkg, Wire> = {
      version: 1,
      nodes: [{ id: 'x', data: pkg('x') }],
      edges: [],
      children: {
        x: {
          version: 1,
          nodes: [
            { id: 'y', data: pkg('y') },
            { id: 'y', data: pkg('y') },
          ],
          edges: [],
          children: {},
        },
      },
    };

    expect(() => graph.restore(danglingEdge)).toThrow(/missing node 'ghost'/);
    expect(() => graph.restore(nestedDuplicate)).toThrow(/duplicate node id 'y'/);
    expect(graph.serialize()).toEqual(before);
    expect(graph.getChildGraph('a')).toBe(child);
    // The tree still holds every id it held, so an explicit repeat is refused.
    expect(() => graph.addNode(pkg('a'), { id: 'a' })).toThrow(/already exists/);
  });

  it('integrates with the persistent() consumer pattern', () => {
    beginPersistentContext('graph-test');
    const snapRef = persistent<SerializedGraph<Pkg, Wire>>({
      version: 1,
      nodes: [],
      edges: [],
      children: {},
    });
    endPersistentContext();

    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('a'), { id: 'a' });
    graph.addNode(pkg('b'), { id: 'b' });
    graph.addEdge('a', 'b', { kind: 'dependency' });
    snapRef.value = graph.serialize();

    // Simulate a fresh session load.
    const loaded = createSpatialGraph<Pkg, Wire>();
    loaded.restore(snapRef.value);
    expect(loaded.isConnected('a', 'b')).toBe(true);
  });
});
