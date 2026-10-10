import { describe, it, expect } from 'vitest';
import { beginPersistentContext, endPersistentContext, persistent } from '@/core/persistence';
import {
  createScopeStack,
  createSpatialGraph,
  type ScopeStack,
  type SerializedScopeStack,
  type ScopeStatus,
} from '@/core/spatial';

interface Pkg {
  name: string;
}
interface Wire {
  kind: 'dependency' | 'symlink';
}

const pkg = (name: string): Pkg => ({ name });

function makeNestedGraph(): {
  graph: ReturnType<typeof createSpatialGraph<Pkg, Wire>>;
  stack: ScopeStack<Pkg, Wire>;
} {
  // root:        a, b        (b has no child graph)
  // a.child:     a1, a2      (a2 has no child graph)
  // a1.child:    a1x         (a1x has a child graph)
  // a1x.child:   deep
  const graph = createSpatialGraph<Pkg, Wire>();
  graph.addNode(pkg('a'), { id: 'a' });
  graph.addNode(pkg('b'), { id: 'b' });
  const aChild = graph.createChildGraph('a');
  aChild.addNode(pkg('a1'), { id: 'a1' });
  aChild.addNode(pkg('a2'), { id: 'a2' });
  const a1Child = aChild.createChildGraph('a1');
  a1Child.addNode(pkg('a1x'), { id: 'a1x' });
  const a1xChild = a1Child.createChildGraph('a1x');
  a1xChild.addNode(pkg('deep'), { id: 'deep' });
  const stack = createScopeStack<Pkg, Wire>({ root: graph });
  return { graph, stack };
}

describe('createScopeStack — construction & basic navigation', () => {
  it('starts at root with empty path and null currentNodeId', () => {
    const { graph, stack } = makeNestedGraph();
    expect(stack.root).toBe(graph);
    expect(stack.depth).toBe(0);
    expect(stack.path).toEqual([]);
    expect(stack.current).toBe(graph);
    expect(stack.currentNodeId).toBeNull();
    expect(stack.breadcrumb).toEqual([]);
  });

  it('enter pushes a level and exposes the nested graph', () => {
    const { graph, stack } = makeNestedGraph();
    stack.enter('a');
    expect(stack.depth).toBe(1);
    expect(stack.path).toEqual(['a']);
    expect(stack.currentNodeId).toBe('a');
    expect(stack.current).toBe(graph.getChildGraph('a'));
    expect(stack.breadcrumb.map((n) => n.id)).toEqual(['a']);
  });

  it('enter stacks multiple levels', () => {
    const { stack } = makeNestedGraph();
    stack.enter('a');
    stack.enter('a1');
    expect(stack.path).toEqual(['a', 'a1']);
    expect(stack.currentNodeId).toBe('a1');
    expect(stack.breadcrumb.map((n) => n.data.name)).toEqual(['a', 'a1']);
  });

  it('exit pops one level', () => {
    const { stack } = makeNestedGraph();
    stack.enter('a');
    stack.enter('a1');
    stack.exit();
    expect(stack.path).toEqual(['a']);
  });

  it('exit at root is a no-op', () => {
    const { stack } = makeNestedGraph();
    stack.exit();
    expect(stack.depth).toBe(0);
  });

  it('exitToRoot pops all levels', () => {
    const { stack } = makeNestedGraph();
    stack.enter('a');
    stack.enter('a1');
    stack.enter('a1x');
    stack.exitToRoot();
    expect(stack.depth).toBe(0);
    expect(stack.path).toEqual([]);
  });

  it('enter throws if the node is missing in the current graph', () => {
    const { stack } = makeNestedGraph();
    expect(() => stack.enter('missing')).toThrow(/not found/);
  });

  it('enter throws if the node has no child graph', () => {
    const { stack } = makeNestedGraph();
    stack.enter('a');
    // a2 exists but has no child graph.
    expect(() => stack.enter('a2')).toThrow(/no child graph/);
  });
});

describe('createScopeStack — events', () => {
  it('emits scope:entered with the new depth', () => {
    const { stack } = makeNestedGraph();
    const events: Array<[string, number]> = [];
    stack.on('scope:entered', (nodeId, depth) => events.push([nodeId, depth]));
    stack.enter('a');
    stack.enter('a1');
    expect(events).toEqual([
      ['a', 1],
      ['a1', 2],
    ]);
  });

  it('emits scope:exited with the popped nodeId and shallower depth', () => {
    const { stack } = makeNestedGraph();
    stack.enter('a');
    stack.enter('a1');
    const events: Array<[string, number]> = [];
    stack.on('scope:exited', (nodeId, depth) => events.push([nodeId, depth]));
    stack.exit();
    stack.exit();
    expect(events).toEqual([
      ['a1', 1],
      ['a', 0],
    ]);
  });

  it('unsubscribe stops further deliveries', () => {
    const { stack } = makeNestedGraph();
    const seen: string[] = [];
    const off = stack.on('scope:entered', (id) => seen.push(id));
    stack.enter('a');
    off();
    stack.enter('a1');
    expect(seen).toEqual(['a']);
  });
});

describe('createScopeStack — dangling-path auto-exit', () => {
  it('exits a level when the owning node is removed from its parent graph', () => {
    const { graph, stack } = makeNestedGraph();
    stack.enter('a');
    const exited: Array<[string, number]> = [];
    stack.on('scope:exited', (nodeId, depth) => exited.push([nodeId, depth]));
    graph.removeNode('a');
    expect(stack.depth).toBe(0);
    expect(exited).toEqual([['a', 0]]);
  });

  it('cascades pop from deepest level up when an ancestor is removed', () => {
    const { graph, stack } = makeNestedGraph();
    stack.enter('a');
    stack.enter('a1');
    stack.enter('a1x');
    const exited: Array<[string, number]> = [];
    stack.on('scope:exited', (nodeId, depth) => exited.push([nodeId, depth]));
    graph.removeNode('a');
    expect(stack.depth).toBe(0);
    // Cascade destroys child graphs bottom-up, so a1x pops first, then a1,
    // then a when the root-level nodeRemoved fires.
    expect(exited).toEqual([
      ['a1x', 2],
      ['a1', 1],
      ['a', 0],
    ]);
  });

  it('subscription cleanup survives exit/re-enter cycles', () => {
    const { graph, stack } = makeNestedGraph();
    stack.enter('a');
    stack.exit();
    // Remove 'a' now — the subscription from the first enter must have
    // been torn down, otherwise we would auto-exit from an already-empty
    // stack (harmless but we also verify no spurious scope:exited fires).
    const spuriousExits: string[] = [];
    stack.on('scope:exited', (id) => spuriousExits.push(id));
    graph.removeNode('a');
    expect(stack.depth).toBe(0);
    expect(spuriousExits).toEqual([]);
  });

  it('removing a sibling does not trigger exit', () => {
    const { graph, stack } = makeNestedGraph();
    stack.enter('a');
    const exited: string[] = [];
    stack.on('scope:exited', (id) => exited.push(id));
    graph.removeNode('b');
    expect(stack.depth).toBe(1);
    expect(exited).toEqual([]);
  });
});

describe('createScopeStack — recalculate propagation', () => {
  it('caches the state returned by recalculate and emits scope:recalculated', () => {
    const { stack: basicStack } = makeNestedGraph();
    void basicStack; // unused — this test uses its own configured stack

    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('a'), { id: 'a' });
    graph.createChildGraph('a');
    const calls: Array<readonly string[]> = [];
    const stack = createScopeStack<Pkg, Wire>({
      root: graph,
      recalculate: (_g, p) => {
        calls.push([...p]);
        return p.length === 0 ? 'pristine' : 'stable';
      },
    });
    const events: Array<[readonly string[], ScopeStatus]> = [];
    stack.on('scope:recalculated', (p, s) => events.push([[...p], s]));
    stack.enter('a');
    stack.recalculateAt(stack.path);
    // Walks ['a'] then ['] — both cached + emitted.
    expect(stack.statusAt(['a'])).toBe('stable');
    expect(stack.statusAt([])).toBe('pristine');
    expect(events).toEqual([
      [['a'], 'stable'],
      [[], 'pristine'],
    ]);
    expect(calls).toEqual([['a'], []]);
  });

  it('stops bubbling when the cached state is unchanged', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('a'), { id: 'a' });
    graph.createChildGraph('a');
    const visited: Array<readonly string[]> = [];
    const stack = createScopeStack<Pkg, Wire>({
      root: graph,
      recalculate: (_g, p) => {
        visited.push([...p]);
        return p.length === 0 ? 'pristine' : 'unstable';
      },
    });
    stack.enter('a');

    stack.recalculateAt(stack.path);
    expect(visited).toEqual([['a'], []]);

    // Second call: 'a' returns 'unstable' again (unchanged), so propagation
    // must stop before touching the root.
    visited.length = 0;
    stack.recalculateAt(stack.path);
    expect(visited).toEqual([['a']]);
  });

  it('resumes bubbling when a cached state changes', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('a'), { id: 'a' });
    graph.createChildGraph('a');
    let aCallCount = 0;
    const visited: Array<readonly string[]> = [];
    const stack = createScopeStack<Pkg, Wire>({
      root: graph,
      recalculate: (_g, p) => {
        visited.push([...p]);
        if (p.length === 1) {
          aCallCount++;
          return aCallCount === 1 ? 'unstable' : 'stable';
        }
        return 'stable';
      },
    });
    stack.enter('a');

    stack.recalculateAt(stack.path);
    // First pass: 'a' → 'unstable' (new), bubbles; [] → 'stable' (new).
    expect(visited).toEqual([['a'], []]);

    visited.length = 0;
    stack.recalculateAt(stack.path);
    // Second pass: 'a' → 'stable' (changed), bubbles; [] → 'stable' (unchanged), halts.
    expect(visited).toEqual([['a'], []]);
    expect(stack.statusAt(['a'])).toBe('stable');
  });

  it('is a no-op when no recalculate option is provided', () => {
    const { stack } = makeNestedGraph();
    stack.enter('a');
    stack.recalculateAt(stack.path);
    expect(stack.statusAt(['a'])).toBeUndefined();
  });

  it('is silent when the path cannot be resolved', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('a'), { id: 'a' });
    graph.createChildGraph('a');
    let called = 0;
    const stack = createScopeStack<Pkg, Wire>({
      root: graph,
      recalculate: () => {
        called++;
        return 'stable';
      },
    });
    stack.recalculateAt(['ghost']);
    expect(called).toBe(0);
    expect(stack.statusAt(['ghost'])).toBeUndefined();
  });
});

describe('createScopeStack — serialize & restore', () => {
  it('round-trips the active path', () => {
    const { graph, stack } = makeNestedGraph();
    stack.enter('a');
    stack.enter('a1');

    const snap = stack.serialize();
    expect(snap.version).toBe(1);
    expect(snap.path).toEqual(['a', 'a1']);

    const fresh = createScopeStack<Pkg, Wire>({ root: graph });
    fresh.restore(snap);
    expect(fresh.depth).toBe(2);
    expect(fresh.currentNodeId).toBe('a1');
    expect(fresh.current).toBe(graph.getChildGraph('a')?.getChildGraph('a1'));
  });

  it('clears the state cache during restore', () => {
    const graph = createSpatialGraph<Pkg, Wire>();
    graph.addNode(pkg('a'), { id: 'a' });
    graph.createChildGraph('a');
    const stack = createScopeStack<Pkg, Wire>({
      root: graph,
      recalculate: () => 'stable',
    });
    stack.enter('a');
    stack.recalculateAt(stack.path);
    expect(stack.statusAt(['a'])).toBe('stable');

    stack.restore({ version: 1, path: [] });
    expect(stack.statusAt(['a'])).toBeUndefined();
  });

  it('emits no events during restore', () => {
    const { graph, stack } = makeNestedGraph();
    stack.enter('a');
    const spurious: string[] = [];
    stack.on('scope:entered', (id) => spurious.push(`enter:${id}`));
    stack.on('scope:exited', (id) => spurious.push(`exit:${id}`));
    const fresh = createScopeStack<Pkg, Wire>({ root: graph });
    fresh.on('scope:entered', (id) => spurious.push(`fresh-enter:${id}`));
    fresh.restore({ version: 1, path: ['a', 'a1'] });
    expect(spurious).toEqual([]);
  });

  it('rejects unknown snapshot version', () => {
    const { graph } = makeNestedGraph();
    const stack = createScopeStack<Pkg, Wire>({ root: graph });
    const bad = { version: 2, path: [] } as unknown as SerializedScopeStack;
    expect(() => stack.restore(bad)).toThrow(/unsupported format version/);
  });

  it('rejects paths that reference missing nodes', () => {
    const { graph } = makeNestedGraph();
    const stack = createScopeStack<Pkg, Wire>({ root: graph });
    expect(() => stack.restore({ version: 1, path: ['ghost'] })).toThrow(/not found/);
  });

  it('rejects paths that reference nodes without a child graph', () => {
    const { graph } = makeNestedGraph();
    // 'b' is a root node but has no child graph.
    const stack = createScopeStack<Pkg, Wire>({ root: graph });
    expect(() => stack.restore({ version: 1, path: ['b'] })).toThrow(/no child graph/);
  });

  it('restored path still auto-exits on dangling-node removal', () => {
    const { graph, stack } = makeNestedGraph();
    stack.restore({ version: 1, path: ['a', 'a1'] });
    expect(stack.depth).toBe(2);
    graph.removeNode('a');
    expect(stack.depth).toBe(0);
  });

  it('integrates with the persistent() consumer pattern', () => {
    const { graph, stack } = makeNestedGraph();
    beginPersistentContext('scope-test');
    const pathRef = persistent<SerializedScopeStack>({ version: 1, path: [] });
    endPersistentContext();

    stack.enter('a');
    stack.enter('a1');
    pathRef.value = stack.serialize();

    const loaded = createScopeStack<Pkg, Wire>({ root: graph });
    loaded.restore(pathRef.value);
    expect(loaded.path).toEqual(['a', 'a1']);
  });
});
