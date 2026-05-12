import { describe, it, expect } from 'vitest';
import { beginPersistentContext, endPersistentContext, persistent } from '@/core/persistence';
import { seedRNG } from '@/primitives/rng';
import { createSpatialGrid, type GridCoord, type SpatialGridSnapshot } from '@/core/spatial';

interface Tile {
  kind: 'floor' | 'wall';
}

const floor = (): Tile => ({ kind: 'floor' });
const sortCoords = (coords: GridCoord[]): GridCoord[] =>
  [...coords].sort((a, b) => a.y - b.y || a.x - b.x);

describe('createSpatialGrid — construction & access', () => {
  it('initializes every cell via the provided initializer', () => {
    const grid = createSpatialGrid<Tile>({
      width: 3,
      height: 2,
      initializer: (x, y) => ({ kind: x === y ? 'wall' : 'floor' }),
    });
    expect(grid.at(0, 0).kind).toBe('wall');
    expect(grid.at(1, 0).kind).toBe('floor');
    expect(grid.at(2, 0).kind).toBe('floor');
    expect(grid.at(1, 1).kind).toBe('wall');
  });

  it('exposes width / height and zero-initialised bitmaps', () => {
    const grid = createSpatialGrid<Tile>({ width: 4, height: 5, initializer: floor });
    expect(grid.width).toBe(4);
    expect(grid.height).toBe(5);
    expect(grid.passable.length).toBe(20);
    expect(grid.explored.length).toBe(20);
    expect(grid.visible.length).toBe(20);
    expect(Array.from(grid.passable).every((b) => b === 0)).toBe(true);
  });

  it('rejects non-positive or non-integer dimensions', () => {
    expect(() => createSpatialGrid({ width: 0, height: 5, initializer: floor })).toThrow();
    expect(() => createSpatialGrid({ width: 3, height: -1, initializer: floor })).toThrow();
    expect(() => createSpatialGrid({ width: 3.5, height: 2, initializer: floor })).toThrow();
  });

  it('at() throws OOB; tryAt() returns undefined OOB', () => {
    const grid = createSpatialGrid<Tile>({ width: 2, height: 2, initializer: floor });
    expect(() => grid.at(2, 0)).toThrow(RangeError);
    expect(() => grid.at(-1, 0)).toThrow(RangeError);
    expect(grid.tryAt(2, 0)).toBeUndefined();
    expect(grid.tryAt(-1, 0)).toBeUndefined();
    expect(grid.tryAt(1, 1)?.kind).toBe('floor');
  });

  it('inBounds() reflects width × height', () => {
    const grid = createSpatialGrid<Tile>({ width: 3, height: 3, initializer: floor });
    expect(grid.inBounds(0, 0)).toBe(true);
    expect(grid.inBounds(2, 2)).toBe(true);
    expect(grid.inBounds(3, 0)).toBe(false);
    expect(grid.inBounds(-1, 0)).toBe(false);
  });

  it('set() always emits cellChanged, even when the value is equal', () => {
    const grid = createSpatialGrid<Tile>({ width: 2, height: 1, initializer: floor });
    const events: Array<[number, number, Tile, Tile]> = [];
    grid.on('cellChanged', (x, y, prev, next) => events.push([x, y, prev, next]));
    const a: Tile = { kind: 'wall' };
    grid.set(0, 0, a);
    grid.set(0, 0, a);
    expect(events).toHaveLength(2);
    expect(events[1][2]).toBe(a);
    expect(events[1][3]).toBe(a);
  });
});

describe('createSpatialGrid — adjacency & range', () => {
  const grid = createSpatialGrid<Tile>({ width: 3, height: 3, initializer: floor });

  it('neighbors(): 4-connected, clipped at edges', () => {
    expect(sortCoords([...grid.neighbors(1, 1)])).toEqual(
      sortCoords([
        { x: 0, y: 1 },
        { x: 2, y: 1 },
        { x: 1, y: 0 },
        { x: 1, y: 2 },
      ]),
    );
    expect(sortCoords([...grid.neighbors(0, 0)])).toEqual(
      sortCoords([
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ]),
    );
  });

  it('neighborsDiag(): 8-connected, clipped at corners', () => {
    expect([...grid.neighborsDiag(1, 1)]).toHaveLength(8);
    expect([...grid.neighborsDiag(0, 0)]).toHaveLength(3);
    expect([...grid.neighborsDiag(2, 2)]).toHaveLength(3);
  });

  it('inRange(): Chebyshev radius, clipped at bounds', () => {
    const cells = [...grid.inRange(0, 0, 1)];
    expect(sortCoords(cells)).toEqual(
      sortCoords([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ]),
    );
    expect([...grid.inRange(1, 1, 5)]).toHaveLength(9);
    expect([...grid.inRange(1, 1, 0)]).toEqual([{ x: 1, y: 1 }]);
  });
});

describe('createSpatialGrid — bfs', () => {
  function wallGrid(): ReturnType<typeof createSpatialGrid<Tile>> {
    // 3x3 with a vertical wall at x=1 with a gap at (1,2):
    //   . W .
    //   . W .
    //   . . .
    const grid = createSpatialGrid<Tile>({
      width: 3,
      height: 3,
      initializer: (x, y) => ({ kind: x === 1 && y < 2 ? 'wall' : 'floor' }),
    });
    return grid;
  }

  const passable: (cell: Tile) => boolean = (c) => c.kind === 'floor';

  it('returns a parent-link map keyed by "x,y", including the start mapped to itself', () => {
    const grid = wallGrid();
    const visited = grid.bfs({ x: 0, y: 0 }, passable);
    expect(visited.get('0,0')).toEqual({ x: 0, y: 0 });
    expect(visited.has('2,2')).toBe(true);
    expect(visited.has('1,0')).toBe(false); // wall
    expect(visited.has('1,1')).toBe(false); // wall
    expect(visited.has('1,2')).toBe(true); // gap
  });

  it('omits unreachable cells when a wall fully blocks the path', () => {
    // Full vertical wall at x=1
    const grid = createSpatialGrid<Tile>({
      width: 3,
      height: 3,
      initializer: (x) => ({ kind: x === 1 ? 'wall' : 'floor' }),
    });
    const visited = grid.bfs({ x: 0, y: 0 }, passable);
    expect(visited.has('2,0')).toBe(false);
    expect(visited.has('2,1')).toBe(false);
    expect(visited.has('2,2')).toBe(false);
  });

  it('uses 8-connected neighbors when allowDiagonals is true', () => {
    // Wall at (1,1) only — with diagonals you can still reach (2,2) from (0,0).
    const grid = createSpatialGrid<Tile>({
      width: 3,
      height: 3,
      allowDiagonals: true,
      initializer: (x, y) => ({ kind: x === 1 && y === 1 ? 'wall' : 'floor' }),
    });
    const visited = grid.bfs({ x: 0, y: 0 }, passable);
    expect(visited.has('2,2')).toBe(true);
    expect(visited.get('2,2')).toBeDefined();
  });

  it('returns an empty map for an out-of-bounds start', () => {
    const grid = wallGrid();
    expect(grid.bfs({ x: -1, y: 0 }, passable).size).toBe(0);
  });
});

describe('createSpatialGrid — flood & findOpen', () => {
  it('flood yields every reachable matching cell, including start', () => {
    const grid = createSpatialGrid<Tile>({
      width: 3,
      height: 1,
      initializer: (x) => ({ kind: x === 1 ? 'wall' : 'floor' }),
    });
    const reached = [...grid.flood({ x: 0, y: 0 }, (c) => c.kind === 'floor')];
    expect(reached).toEqual([{ x: 0, y: 0 }]);
  });

  it('findOpen returns undefined when nothing matches', () => {
    seedRNG(1);
    const grid = createSpatialGrid<Tile>({ width: 2, height: 2, initializer: floor });
    expect(grid.findOpen((c) => c.kind === 'wall')).toBeUndefined();
  });

  it('findOpen draws from matches deterministically under a seeded RNG', () => {
    const grid = createSpatialGrid<Tile>({
      width: 3,
      height: 3,
      initializer: (x, y) => ({ kind: (x + y) % 2 === 0 ? 'floor' : 'wall' }),
    });
    seedRNG(42);
    const a = grid.findOpen((c) => c.kind === 'floor');
    seedRNG(42);
    const b = grid.findOpen((c) => c.kind === 'floor');
    expect(a).toEqual(b);
    expect(a).toBeDefined();
    expect(grid.at(a!.x, a!.y).kind).toBe('floor');
  });
});

describe('createSpatialGrid — FOV adapter', () => {
  it('emits exactly one fovUpdated per commit with correct deltas', () => {
    const grid = createSpatialGrid<Tile>({ width: 4, height: 1, initializer: floor });
    const events: Array<{ in: GridCoord[]; out: GridCoord[] }> = [];
    grid.on('fovUpdated', (deltaIn, deltaOut) => events.push({ in: deltaIn, out: deltaOut }));

    const fov1 = grid.beginFovUpdate();
    fov1.markVisible(0, 0);
    fov1.markVisible(1, 0);
    fov1.commit();

    expect(events).toHaveLength(1);
    expect(sortCoords(events[0].in)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
    expect(events[0].out).toEqual([]);
    expect(grid.visible[0]).toBe(1);
    expect(grid.visible[1]).toBe(1);
    expect(grid.visible[2]).toBe(0);

    const fov2 = grid.beginFovUpdate();
    fov2.markVisible(1, 0);
    fov2.markVisible(2, 0);
    fov2.commit();

    expect(events).toHaveLength(2);
    expect(sortCoords(events[1].in)).toEqual([{ x: 2, y: 0 }]);
    expect(sortCoords(events[1].out)).toEqual([{ x: 0, y: 0 }]);
  });

  it('cumulatively ORs into explored across commits', () => {
    const grid = createSpatialGrid<Tile>({ width: 3, height: 1, initializer: floor });
    const a = grid.beginFovUpdate();
    a.markVisible(0, 0);
    a.commit();
    const b = grid.beginFovUpdate();
    b.markVisible(2, 0);
    b.commit();
    expect(Array.from(grid.explored)).toEqual([1, 0, 1]);
    expect(Array.from(grid.visible)).toEqual([0, 0, 1]);
  });

  it('ignores out-of-bounds markVisible calls', () => {
    const grid = createSpatialGrid<Tile>({ width: 2, height: 2, initializer: floor });
    const fov = grid.beginFovUpdate();
    fov.markVisible(-1, 0);
    fov.markVisible(0, 5);
    fov.markVisible(0, 0);
    fov.commit();
    expect(Array.from(grid.visible)).toEqual([1, 0, 0, 0]);
  });

  it('rejects double-commit on the same handle', () => {
    const grid = createSpatialGrid<Tile>({ width: 2, height: 1, initializer: floor });
    const fov = grid.beginFovUpdate();
    fov.commit();
    expect(() => fov.commit()).toThrow();
  });

  it('rejects a second beginFovUpdate() while the prior handle is uncommitted', () => {
    const grid = createSpatialGrid<Tile>({ width: 2, height: 1, initializer: floor });
    const fov = grid.beginFovUpdate();
    expect(() => grid.beginFovUpdate()).toThrow(/not been committed/);
    // After committing, a new update is permitted again.
    fov.commit();
    expect(() => grid.beginFovUpdate()).not.toThrow();
  });

  it('reuses its staging buffer — repeated commits allocate no Uint8Array', () => {
    const grid = createSpatialGrid<Tile>({ width: 16, height: 16, initializer: floor });
    // Warm up once so lazy caches and the first handle object materialize.
    const warm = grid.beginFovUpdate();
    warm.markVisible(0, 0);
    warm.commit();

    const OriginalUint8 = globalThis.Uint8Array;
    let allocations = 0;
    class CountingUint8 extends OriginalUint8 {
      constructor(...args: ConstructorParameters<typeof OriginalUint8>) {
        // @ts-expect-error forwarding variadic Uint8Array overloads
        super(...args);
        allocations++;
      }
    }
    globalThis.Uint8Array = CountingUint8 as unknown as typeof OriginalUint8;
    try {
      for (let i = 0; i < 100; i++) {
        const h = grid.beginFovUpdate();
        h.markVisible(i % 16, Math.floor(i / 16) % 16);
        h.commit();
      }
    } finally {
      globalThis.Uint8Array = OriginalUint8;
    }
    expect(allocations).toBe(0);
  });

  it('clears staging between commits so stale markers do not leak forward', () => {
    const grid = createSpatialGrid<Tile>({ width: 3, height: 1, initializer: floor });
    const a = grid.beginFovUpdate();
    a.markVisible(0, 0);
    a.markVisible(1, 0);
    a.commit();
    // Next update only marks (2, 0) — (0, 0) and (1, 0) must not carry over.
    const b = grid.beginFovUpdate();
    b.markVisible(2, 0);
    b.commit();
    expect(Array.from(grid.visible)).toEqual([0, 0, 1]);
  });

  it('headless commits (no fovUpdated subscriber) still mutate visible/explored correctly', () => {
    const grid = createSpatialGrid<Tile>({ width: 3, height: 2, initializer: floor });
    let fired = 0;
    grid.on('cellChanged', () => fired++); // unrelated subscriber, must not affect FOV path

    const fov = grid.beginFovUpdate();
    fov.markVisible(0, 0);
    fov.markVisible(2, 1);
    fov.commit();

    expect(Array.from(grid.visible)).toEqual([1, 0, 0, 0, 0, 1]);
    expect(Array.from(grid.explored)).toEqual([1, 0, 0, 0, 0, 1]);
    expect(fired).toBe(0);

    const fov2 = grid.beginFovUpdate();
    fov2.markVisible(0, 0);
    fov2.commit();
    expect(Array.from(grid.visible)).toEqual([1, 0, 0, 0, 0, 0]);
    expect(Array.from(grid.explored)).toEqual([1, 0, 0, 0, 0, 1]);
  });

  it('produces identical state with or without a fovUpdated subscriber', () => {
    const mark = (g: ReturnType<typeof createSpatialGrid<Tile>>) => {
      const a = g.beginFovUpdate();
      a.markVisible(0, 0);
      a.markVisible(1, 0);
      a.commit();
      const b = g.beginFovUpdate();
      b.markVisible(1, 0);
      b.markVisible(2, 0);
      b.commit();
    };
    const headless = createSpatialGrid<Tile>({ width: 3, height: 1, initializer: floor });
    const subscribed = createSpatialGrid<Tile>({ width: 3, height: 1, initializer: floor });
    subscribed.on('fovUpdated', () => {});
    mark(headless);
    mark(subscribed);
    expect(Array.from(headless.visible)).toEqual(Array.from(subscribed.visible));
    expect(Array.from(headless.explored)).toEqual(Array.from(subscribed.explored));
    expect(headless.exploredCount).toBe(subscribed.exploredCount);
  });
});

describe('createSpatialGrid — exploredCount', () => {
  it('starts at zero', () => {
    const grid = createSpatialGrid<Tile>({ width: 4, height: 4, initializer: floor });
    expect(grid.exploredCount).toBe(0);
  });

  it('increments only on first reveal of each cell', () => {
    const grid = createSpatialGrid<Tile>({ width: 3, height: 1, initializer: floor });
    const a = grid.beginFovUpdate();
    a.markVisible(0, 0);
    a.markVisible(1, 0);
    a.commit();
    expect(grid.exploredCount).toBe(2);

    // Re-revealing the same cells must not double-count.
    const b = grid.beginFovUpdate();
    b.markVisible(0, 0);
    b.markVisible(1, 0);
    b.commit();
    expect(grid.exploredCount).toBe(2);

    // New cell pushes the count by one.
    const c = grid.beginFovUpdate();
    c.markVisible(2, 0);
    c.commit();
    expect(grid.exploredCount).toBe(3);
  });

  it('is recomputed from the snapshot on restore', () => {
    const grid = createSpatialGrid<Tile>({ width: 2, height: 2, initializer: floor });
    grid.restore({
      width: 2,
      height: 2,
      cells: [floor(), floor(), floor(), floor()],
      passable: new Uint8Array([0, 0, 0, 0]),
      explored: new Uint8Array([1, 0, 1, 1]),
      visible: new Uint8Array([0, 0, 0, 0]),
    });
    expect(grid.exploredCount).toBe(3);
  });
});

describe('createSpatialGrid — passableCount', () => {
  it('reflects direct passable bitmap writes on first read', () => {
    const grid = createSpatialGrid<Tile>({ width: 3, height: 1, initializer: floor });
    grid.passable[0] = 1;
    grid.passable[2] = 1;
    expect(grid.passableCount).toBe(2);
  });

  it('drifts silently after direct writes once cached — matches exploredCount contract', () => {
    const grid = createSpatialGrid<Tile>({ width: 3, height: 1, initializer: floor });
    grid.passable[0] = 1;
    expect(grid.passableCount).toBe(1);
    // Cache is now populated; later direct writes bypass it.
    grid.passable[1] = 1;
    expect(grid.passableCount).toBe(1);
    // restore() recomputes.
    grid.restore({
      width: 3,
      height: 1,
      cells: [floor(), floor(), floor()],
      passable: new Uint8Array([1, 1, 1]),
      explored: new Uint8Array([0, 0, 0]),
      visible: new Uint8Array([0, 0, 0]),
    });
    expect(grid.passableCount).toBe(3);
  });

  it('is recomputed from the snapshot on restore', () => {
    const grid = createSpatialGrid<Tile>({ width: 2, height: 2, initializer: floor });
    grid.restore({
      width: 2,
      height: 2,
      cells: [floor(), floor(), floor(), floor()],
      passable: new Uint8Array([1, 0, 1, 1]),
      explored: new Uint8Array([0, 0, 0, 0]),
      visible: new Uint8Array([0, 0, 0, 0]),
    });
    expect(grid.passableCount).toBe(3);
  });
});

describe('createSpatialGrid — exploredPassableCount', () => {
  it('starts at zero', () => {
    const grid = createSpatialGrid<Tile>({ width: 4, height: 4, initializer: floor });
    expect(grid.exploredPassableCount).toBe(0);
  });

  it('increments only when the newly-explored cell is passable', () => {
    const grid = createSpatialGrid<Tile>({ width: 3, height: 1, initializer: floor });
    grid.passable[0] = 1;
    grid.passable[2] = 1;
    // (1, 0) is blocked terrain.

    const a = grid.beginFovUpdate();
    a.markVisible(0, 0);
    a.markVisible(1, 0);
    a.commit();
    expect(grid.exploredCount).toBe(2);
    expect(grid.exploredPassableCount).toBe(1); // only (0, 0) is passable + explored

    const b = grid.beginFovUpdate();
    b.markVisible(2, 0);
    b.commit();
    expect(grid.exploredCount).toBe(3);
    expect(grid.exploredPassableCount).toBe(2); // + (2, 0)
  });

  it('does not double-count cells re-revealed in later FOV updates', () => {
    const grid = createSpatialGrid<Tile>({ width: 2, height: 1, initializer: floor });
    grid.passable[0] = 1;
    grid.passable[1] = 1;
    const a = grid.beginFovUpdate();
    a.markVisible(0, 0);
    a.markVisible(1, 0);
    a.commit();
    const b = grid.beginFovUpdate();
    b.markVisible(0, 0);
    b.markVisible(1, 0);
    b.commit();
    expect(grid.exploredPassableCount).toBe(2);
  });

  it('tracks correctly under the headless (no subscriber) commit path', () => {
    const grid = createSpatialGrid<Tile>({ width: 3, height: 1, initializer: floor });
    grid.passable[0] = 1;
    grid.passable[2] = 1;
    const fov = grid.beginFovUpdate();
    fov.markVisible(0, 0);
    fov.markVisible(1, 0);
    fov.markVisible(2, 0);
    fov.commit();
    expect(grid.exploredPassableCount).toBe(2);
  });

  it('is recomputed from the snapshot on restore', () => {
    const grid = createSpatialGrid<Tile>({ width: 2, height: 2, initializer: floor });
    grid.restore({
      width: 2,
      height: 2,
      cells: [floor(), floor(), floor(), floor()],
      passable: new Uint8Array([1, 0, 1, 1]),
      explored: new Uint8Array([1, 1, 0, 1]),
      visible: new Uint8Array([0, 0, 0, 0]),
    });
    // passable ∩ explored: index 0 (1,1) and index 3 (1,1) → 2
    expect(grid.exploredPassableCount).toBe(2);
    expect(grid.passableCount).toBe(3);
    expect(grid.exploredCount).toBe(3);
  });
});

describe('createSpatialGrid — events & subscriptions', () => {
  it('on() returns an unsubscribe function that detaches the handler', () => {
    const grid = createSpatialGrid<Tile>({ width: 2, height: 1, initializer: floor });
    const events: number[] = [];
    const off = grid.on('cellChanged', (x) => events.push(x));
    grid.set(0, 0, { kind: 'wall' });
    off();
    grid.set(1, 0, { kind: 'wall' });
    expect(events).toEqual([0]);
  });
});

describe('createSpatialGrid — serialize / restore', () => {
  it('round-trips cells and all three bitmaps', () => {
    const original = createSpatialGrid<Tile>({
      width: 3,
      height: 2,
      initializer: (x, y) => ({ kind: x === y ? 'wall' : 'floor' }),
    });
    original.passable[0] = 1;
    original.passable[3] = 1;
    const fov = original.beginFovUpdate();
    fov.markVisible(2, 0);
    fov.commit();

    const snapshot = original.serialize();

    const restored = createSpatialGrid<Tile>({
      width: 3,
      height: 2,
      initializer: () => ({ kind: 'floor' }),
    });
    restored.restore(snapshot);

    expect(restored.at(0, 0).kind).toBe('wall');
    expect(restored.at(1, 1).kind).toBe('wall');
    expect(Array.from(restored.passable)).toEqual(Array.from(original.passable));
    expect(Array.from(restored.explored)).toEqual(Array.from(original.explored));
    expect(Array.from(restored.visible)).toEqual(Array.from(original.visible));
  });

  it('rejects restore from a snapshot with mismatched dimensions', () => {
    const grid = createSpatialGrid<Tile>({ width: 2, height: 2, initializer: floor });
    const bad: SpatialGridSnapshot<Tile> = {
      width: 3,
      height: 3,
      cells: Array.from({ length: 9 }, floor),
      passable: new Uint8Array(9),
      explored: new Uint8Array(9),
      visible: new Uint8Array(9),
    };
    expect(() => grid.restore(bad)).toThrow();
  });

  it('serialize() returns typed-array copies independent of the live grid', () => {
    const grid = createSpatialGrid<Tile>({ width: 2, height: 2, initializer: floor });
    grid.passable[0] = 1;
    const snapshot = grid.serialize();
    expect(snapshot.passable).toBeInstanceOf(Uint8Array);
    expect(snapshot.explored).toBeInstanceOf(Uint8Array);
    expect(snapshot.visible).toBeInstanceOf(Uint8Array);
    // Mutating the live bitmap must not leak into an already-captured snapshot.
    grid.passable[1] = 1;
    expect(snapshot.passable[0]).toBe(1);
    expect(snapshot.passable[1]).toBe(0);
    // And the snapshot's buffer must not alias the live one.
    expect(snapshot.passable.buffer).not.toBe(grid.passable.buffer);
  });

  it('integrates with the consumer pattern: snapshot wrapped in a single persistent() ref', () => {
    beginPersistentContext('spatial-grid-snapshot-test');
    try {
      const initial: SpatialGridSnapshot<Tile> = {
        width: 2,
        height: 2,
        cells: [floor(), floor(), floor(), floor()],
        passable: new Uint8Array([1, 0, 0, 1]),
        explored: new Uint8Array([0, 0, 0, 0]),
        visible: new Uint8Array([0, 0, 0, 0]),
      };
      const snapshotRef = persistent<SpatialGridSnapshot<Tile>>(initial);
      const grid = createSpatialGrid<Tile>({ width: 2, height: 2, initializer: floor });
      grid.restore(snapshotRef.value);
      grid.set(1, 1, { kind: 'wall' });
      snapshotRef.value = grid.serialize();
      expect(snapshotRef.value.cells[3].kind).toBe('wall');
      expect(Array.from(grid.passable)).toEqual([1, 0, 0, 1]);
    } finally {
      endPersistentContext();
    }
  });
});
