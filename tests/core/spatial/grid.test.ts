import { describe, it, expect } from 'vitest';
import { isReactive } from 'vue';
import { beginPersistentContext, endPersistentContext, persistent } from '@/core/persistence';
import { seedRNG } from '@/primitives/rng';
import {
  createSpatialGrid,
  DIAGONAL_DELTAS,
  HEX_AXIAL_DELTAS,
  type GridCoord,
  type SpatialGridSnapshot,
} from '@/core/spatial';

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

describe('createSpatialGrid — fill', () => {
  it('overwrites every cell via the mapper, passing coordinates and current value', () => {
    const grid = createSpatialGrid<number>({ width: 3, height: 2, initializer: () => 1 });
    grid.fill((x, y, current) => current + x + y * 10);
    expect(grid.at(0, 0)).toBe(1);
    expect(grid.at(2, 0)).toBe(3);
    expect(grid.at(0, 1)).toBe(11);
    expect(grid.at(2, 1)).toBe(13);
  });

  it('emits one bulkChanged and zero cellChanged per call', () => {
    const grid = createSpatialGrid<number>({ width: 4, height: 4, initializer: () => 0 });
    let bulk = 0;
    let perCell = 0;
    grid.on('bulkChanged', () => bulk++);
    grid.on('cellChanged', () => perCell++);
    grid.fill(() => 7);
    grid.fill((_x, _y, v) => v * 2);
    expect(bulk).toBe(2);
    expect(perCell).toBe(0);
    expect(grid.at(3, 3)).toBe(14);
  });
});

describe('createSpatialGrid — setSilent', () => {
  it('writes the cell without emitting cellChanged', () => {
    const grid = createSpatialGrid<number>({ width: 2, height: 1, initializer: () => 0 });
    let fired = 0;
    grid.on('cellChanged', () => fired++);
    grid.setSilent(1, 0, 42);
    expect(grid.at(1, 0)).toBe(42);
    expect(fired).toBe(0);
  });

  it('throws out of bounds, matching set()', () => {
    const grid = createSpatialGrid<number>({ width: 2, height: 1, initializer: () => 0 });
    expect(() => grid.setSilent(2, 0, 1)).toThrow(RangeError);
    expect(() => grid.setSilent(0, -1, 1)).toThrow(RangeError);
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

  it('neighbors(DIAGONAL_DELTAS): 8-connected, clipped at corners', () => {
    expect([...grid.neighbors(1, 1, DIAGONAL_DELTAS)]).toHaveLength(8);
    expect([...grid.neighbors(0, 0, DIAGONAL_DELTAS)]).toHaveLength(3);
    expect([...grid.neighbors(2, 2, DIAGONAL_DELTAS)]).toHaveLength(3);
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

  it('forEachInRange(): visits the same cells as inRange, passing the flat index', () => {
    const viaIterator = sortCoords([...grid.inRange(0, 1, 1)]);
    const viaCallback: GridCoord[] = [];
    grid.forEachInRange(0, 1, 1, (x, y, index) => {
      expect(index).toBe(y * grid.width + x);
      viaCallback.push({ x, y });
    });
    expect(sortCoords(viaCallback)).toEqual(viaIterator);
    let count = 0;
    grid.forEachInRange(1, 1, 5, () => count++);
    expect(count).toBe(9);
  });
});

describe('createSpatialGrid — neighborhood topology', () => {
  it('yields the six hex neighbors when built with HEX_AXIAL_DELTAS', () => {
    // Axial (q, r) stored at grid (q + radius, r + radius), so axial deltas
    // are grid deltas — the storage convention both hex consumers landed on.
    const grid = createSpatialGrid<Tile>({
      width: 5,
      height: 5,
      neighborhood: HEX_AXIAL_DELTAS,
      initializer: floor,
    });
    expect(sortCoords([...grid.neighbors(2, 2)])).toEqual(
      sortCoords([
        { x: 3, y: 2 },
        { x: 3, y: 1 },
        { x: 2, y: 1 },
        { x: 1, y: 2 },
        { x: 1, y: 3 },
        { x: 2, y: 3 },
      ]),
    );
    // Clipped at the corner: of the six deltas only E and SE land in bounds.
    expect([...grid.neighbors(0, 0)]).toEqual([
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ]);
  });

  it('carries the topology into every traversal verb, not just neighbors()', () => {
    // radius-2 hex sector at axial offset: axial (0,0) sits at grid (2,2).
    const radius = 2;
    const grid = createSpatialGrid<Tile>({
      width: 2 * radius + 1,
      height: 2 * radius + 1,
      neighborhood: HEX_AXIAL_DELTAS,
      initializer: floor,
    });
    const hexDistance = (q: number, r: number): number =>
      (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;

    // Unit cost under hex adjacency must reproduce the hex metric exactly,
    // including at the bounding square's off-shape corners.
    const dist = grid.distanceField([{ x: radius, y: radius }], () => 1);
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        expect(dist[y * grid.width + x]).toBe(hexDistance(x - radius, y - radius));
      }
    }
    // The corner the square shares with the hex is 2 steps under Chebyshev
    // but 4 under hex adjacency — proof the traversal is not 8-connected.
    expect(dist[0]).toBe(4);

    // bfs and flood bind to the same topology.
    const reached = grid.bfs({ x: radius, y: radius }, () => true);
    expect(reached.size).toBe(grid.width * grid.height);
    expect([...grid.flood({ x: radius, y: radius }, () => true)]).toHaveLength(
      grid.width * grid.height,
    );
  });

  it('defaults to 4-connected orthogonal adjacency', () => {
    const grid = createSpatialGrid<Tile>({ width: 3, height: 3, initializer: floor });
    expect([...grid.neighbors(1, 1)]).toHaveLength(4);
  });

  it('accepts an ad-hoc delta set that overrides the configured neighborhood', () => {
    const grid = createSpatialGrid<Tile>({ width: 3, height: 3, initializer: floor });
    expect([...grid.neighbors(1, 1, DIAGONAL_DELTAS)]).toHaveLength(8);
    // The grid's own topology is unchanged by the ad-hoc query.
    expect([...grid.neighbors(1, 1)]).toHaveLength(4);
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

  it('uses 8-connected neighbors when built with DIAGONAL_DELTAS', () => {
    // Wall at (1,1) only — with diagonals you can still reach (2,2) from (0,0).
    const grid = createSpatialGrid<Tile>({
      width: 3,
      height: 3,
      neighborhood: DIAGONAL_DELTAS,
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

describe('createSpatialGrid — distanceField', () => {
  const openCost: (cell: Tile) => number = (c) => (c.kind === 'floor' ? 1 : Infinity);

  it('returns hop distance from a single source, Infinity where unreachable', () => {
    // Full vertical wall at x=1 — the x=2 column is cut off.
    const grid = createSpatialGrid<Tile>({
      width: 3,
      height: 3,
      initializer: (x) => ({ kind: x === 1 ? 'wall' : 'floor' }),
    });
    const dist = grid.distanceField([{ x: 0, y: 0 }], openCost);
    expect(dist[0]).toBe(0); // (0,0)
    expect(dist[3]).toBe(1); // (0,1)
    expect(dist[6]).toBe(2); // (0,2)
    expect(dist[1]).toBe(Infinity); // (1,0) wall
    expect(dist[2]).toBe(Infinity); // (2,0) severed
  });

  it('accumulates per-cell entry cost, preferring a longer cheap route', () => {
    // 5x2. Row 0 is a toll road (cost 5/cell), row 1 is cheap (0.1/cell).
    // Reaching (4,0) via row 1 and stepping up costs 5*0.1 + 5 = 5.5,
    // beating the straight 4*5 = 20 along row 0.
    const grid = createSpatialGrid<Tile>({
      width: 5,
      height: 2,
      initializer: () => ({ kind: 'floor' }),
    });
    const dist = grid.distanceField([{ x: 0, y: 0 }], (_c, _x, y) => (y === 0 ? 5 : 0.1));
    expect(dist[5]).toBeCloseTo(0.1, 12); // (0,1)
    expect(dist[9]).toBeCloseTo(0.5, 12); // (4,1) — five cheap steps
    expect(dist[4]).toBeCloseTo(5.5, 12); // (4,0) — cheap route then one toll
    // Every cell is reached: a non-dyadic weight must not strand a region.
    expect([...dist].every(Number.isFinite)).toBe(true);
  });

  it('seeds every source at zero and returns the distance to the nearest one', () => {
    const grid = createSpatialGrid<Tile>({
      width: 5,
      height: 1,
      initializer: () => ({ kind: 'floor' }),
    });
    const dist = grid.distanceField(
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
      ],
      openCost,
    );
    expect([...dist]).toEqual([0, 1, 2, 1, 0]);
  });

  it('drops sources that are out of bounds or standing on impassable terrain', () => {
    const grid = createSpatialGrid<Tile>({
      width: 3,
      height: 1,
      initializer: (x) => ({ kind: x === 2 ? 'wall' : 'floor' }),
    });
    const dist = grid.distanceField(
      [
        { x: -1, y: 0 }, // out of bounds
        { x: 2, y: 0 }, // impassable — not a zero-distance origin
        { x: 0, y: 0 },
      ],
      openCost,
    );
    expect([...dist]).toEqual([0, 1, Infinity]);
  });

  it('returns an all-Infinity field for an empty source set', () => {
    const grid = createSpatialGrid<Tile>({
      width: 2,
      height: 2,
      initializer: () => ({ kind: 'floor' }),
    });
    expect([...grid.distanceField([], openCost)]).toEqual([Infinity, Infinity, Infinity, Infinity]);
  });

  it('uses 8-connected neighbors when built with DIAGONAL_DELTAS', () => {
    const grid = createSpatialGrid<Tile>({
      width: 3,
      height: 3,
      neighborhood: DIAGONAL_DELTAS,
      initializer: () => ({ kind: 'floor' }),
    });
    const dist = grid.distanceField([{ x: 0, y: 0 }], openCost);
    expect(dist[8]).toBe(2); // (2,2) — Chebyshev, not Manhattan
  });

  it('fills a caller-supplied buffer in place and allocates nothing per recompute', () => {
    const grid = createSpatialGrid<Tile>({
      width: 3,
      height: 3,
      initializer: () => ({ kind: 'floor' }),
    });
    const buffer = new Float64Array(9);
    const first = grid.distanceField([{ x: 0, y: 0 }], openCost, buffer);
    expect(first).toBe(buffer);
    expect(buffer[8]).toBe(4);

    // Reused across recomputes, with stale values from the prior run cleared.
    const second = grid.distanceField([{ x: 2, y: 2 }], openCost, buffer);
    expect(second).toBe(buffer);
    expect(buffer[0]).toBe(4);
    expect(buffer[8]).toBe(0);
  });

  it('rejects an `into` buffer whose length does not match the grid', () => {
    const grid = createSpatialGrid<Tile>({
      width: 3,
      height: 3,
      initializer: () => ({ kind: 'floor' }),
    });
    expect(() => grid.distanceField([{ x: 0, y: 0 }], openCost, new Float64Array(8))).toThrow(
      RangeError,
    );
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

describe('createSpatialGrid — markMaskChanged', () => {
  it('after a hand write to passable, re-derives the passable counts and emits maskChanged', () => {
    const grid = createSpatialGrid<Tile>({ width: 3, height: 1, initializer: floor });
    grid.passable[0] = 1;
    const fov = grid.beginFovUpdate();
    fov.markVisible(0, 0);
    fov.markVisible(1, 0);
    fov.commit();
    expect(grid.passableCount).toBe(1);
    expect(grid.exploredPassableCount).toBe(1);

    const masks: string[] = [];
    grid.on('maskChanged', (mask) => masks.push(mask));
    // A door at (1, 0) opens.
    grid.passable[1] = 1;
    grid.markMaskChanged('passable');

    expect(grid.passableCount).toBe(2);
    expect(grid.exploredPassableCount).toBe(2);
    expect(masks).toEqual(['passable']);
  });

  it('after a hand write to explored, re-derives the explored counts', () => {
    const grid = createSpatialGrid<Tile>({ width: 3, height: 1, initializer: floor });
    grid.passable[0] = 1;
    grid.passable[1] = 1;
    // A revealed-map scroll marks the whole level explored.
    grid.explored.fill(1);
    grid.markMaskChanged('explored');
    expect(grid.exploredCount).toBe(3);
    expect(grid.exploredPassableCount).toBe(2);
  });

  it('for visible, only emits — no count reads it', () => {
    const grid = createSpatialGrid<Tile>({ width: 2, height: 1, initializer: floor });
    const masks: string[] = [];
    grid.on('maskChanged', (mask) => masks.push(mask));
    grid.visible[0] = 1;
    grid.markMaskChanged('visible');
    expect(masks).toEqual(['visible']);
    expect(grid.exploredCount).toBe(0);
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
  it('stamps its snapshot version 1, and restore reads an unversioned one as version 1', () => {
    const grid = createSpatialGrid<Tile>({
      width: 2,
      height: 1,
      initializer: () => ({ kind: 'floor' }),
    });
    const snapshot = grid.serialize();
    expect(snapshot.version).toBe(1);

    const { version: _, ...unversioned } = snapshot;
    expect(() => grid.restore(unversioned)).not.toThrow();
    expect(() => grid.restore({ ...snapshot, version: 2 as 1 })).toThrow(
      'unsupported snapshot version 2',
    );
  });

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

  it('restore() emits one bulkChanged and one maskChanged per bitmap, after state lands', () => {
    const source = createSpatialGrid<Tile>({ width: 2, height: 1, initializer: floor });
    source.passable[0] = 1;
    source.set(1, 0, { kind: 'wall' });
    const snapshot = source.serialize();

    const grid = createSpatialGrid<Tile>({ width: 2, height: 1, initializer: floor });
    const events: string[] = [];
    grid.on('cellChanged', () => events.push('cellChanged'));
    grid.on('fovUpdated', () => events.push('fovUpdated'));
    grid.on('bulkChanged', () => events.push(`bulkChanged:${grid.at(1, 0).kind}`));
    grid.on('maskChanged', (mask) => events.push(`maskChanged:${mask}:${grid.passableCount}`));
    grid.restore(snapshot);

    expect(events).toEqual([
      'bulkChanged:wall',
      'maskChanged:passable:1',
      'maskChanged:explored:1',
      'maskChanged:visible:1',
    ]);
  });

  it('rejects restore from a snapshot with mismatched dimensions', () => {
    const grid = createSpatialGrid<Tile>({ width: 2, height: 2, initializer: floor });
    const bad: SpatialGridSnapshot<Tile> = {
      width: 3,
      height: 3,
      cells: Array.from({ length: 9 }, floor),
      passable: new Array(9).fill(0),
      explored: new Array(9).fill(0),
      visible: new Array(9).fill(0),
    };
    expect(() => grid.restore(bad)).toThrow();
  });

  it('serialize() returns plain-array copies independent of the live grid', () => {
    const grid = createSpatialGrid<Tile>({ width: 2, height: 2, initializer: floor });
    grid.passable[0] = 1;
    const snapshot = grid.serialize();
    // Bitmaps are plain number[] so the snapshot survives JSON persistence.
    expect(Array.isArray(snapshot.passable)).toBe(true);
    expect(Array.isArray(snapshot.explored)).toBe(true);
    expect(Array.isArray(snapshot.visible)).toBe(true);
    // Mutating the live bitmap must not leak into an already-captured snapshot.
    grid.passable[1] = 1;
    expect(snapshot.passable[0]).toBe(1);
    expect(snapshot.passable[1]).toBe(0);
  });

  it('round-trips through a JSON save/load, wrapped in a single persistent() ref', () => {
    beginPersistentContext('spatial-grid-snapshot-test');
    try {
      const initial: SpatialGridSnapshot<Tile> = {
        width: 2,
        height: 2,
        cells: [floor(), floor(), floor(), floor()],
        passable: [1, 0, 0, 1],
        explored: [0, 0, 0, 0],
        visible: [0, 0, 0, 0],
      };
      const snapshotRef = persistent<SpatialGridSnapshot<Tile>>(initial);
      const grid = createSpatialGrid<Tile>({ width: 2, height: 2, initializer: floor });
      grid.restore(snapshotRef.value);
      grid.set(1, 1, { kind: 'wall' });
      // Simulate the real save boundary: the persisted snapshot goes through JSON.
      const reloaded = JSON.parse(JSON.stringify(grid.serialize())) as SpatialGridSnapshot<Tile>;
      const restored = createSpatialGrid<Tile>({ width: 2, height: 2, initializer: floor });
      restored.restore(reloaded);
      expect(reloaded.cells[3].kind).toBe('wall');
      expect(Array.from(restored.passable)).toEqual([1, 0, 0, 1]);
      expect(restored.at(1, 1).kind).toBe('wall');
    } finally {
      endPersistentContext();
    }
  });

  it('restoring from a persistent() ref stores raw cells, not reactive proxies', () => {
    beginPersistentContext('spatial-grid-raw-cells-test');
    try {
      const snapshotRef = persistent<SpatialGridSnapshot<Tile>>({
        width: 2,
        height: 1,
        cells: [floor(), { kind: 'wall' }],
        passable: [1, 0],
        explored: [0, 0],
        visible: [0, 0],
      });
      const grid = createSpatialGrid<Tile>({ width: 2, height: 1, initializer: floor });
      grid.restore(snapshotRef.value);
      expect(isReactive(grid.at(0, 0))).toBe(false);
      expect(isReactive(grid.at(1, 0))).toBe(false);
      expect(grid.at(1, 0).kind).toBe('wall');
    } finally {
      endPersistentContext();
    }
  });
});
