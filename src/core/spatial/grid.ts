/**
 * SpatialGrid<T> — bounded 2D grid primitive.
 *
 * @cluster spatial-grid
 *
 * Plain-data, Vue-free. Dense `T[]` cell storage plus three `Uint8Array`
 * bitmaps (passable / explored / visible). Adjacency, range, BFS, and an
 * FOV commit adapter that lets external libraries (rot.js shadowcasting)
 * write visibility back without the engine importing them.
 *
 * Persistence is structure-level: `serialize()` returns a snapshot,
 * `restore(snapshot)` rebuilds. The consumer wraps the snapshot in a
 * single `persistent()` ref — the engine never spawns per-cell refs.
 *
 * Events:
 * - `cellChanged(x, y, prev, next)` — game-logic mutations via `set()`.
 * - `fovUpdated(deltaIn, deltaOut)` — one batched event per `commit()`.
 * - `maskChanged(mask)` — coarse signal for direct bitmap mutations
 *   outside the FOV path.
 */

import { createEmitHandle } from '../events';
import { randomItem } from '@/primitives/rng';
import type { GridCoord, PassabilityFn, Unsubscribe } from './types';

/** Options accepted by {@link createSpatialGrid}. */
export interface SpatialGridOptions<T> {
  readonly width: number;
  readonly height: number;
  /** Cell value factory. Called once per cell at construction. */
  readonly initializer: (x: number, y: number) => T;
  /**
   * Whether traversal queries (BFS, flood) treat 8-connected neighbors as
   * adjacent. `neighbors()` and `neighborsDiag()` are always available
   * regardless; this only affects the default for traversal helpers.
   * Defaults to false (4-connected).
   */
  readonly allowDiagonals?: boolean;
}

/** Events emitted by a {@link SpatialGrid}. Subscribe via `grid.on()`. */
export interface SpatialGridEvents<T> {
  cellChanged: (x: number, y: number, prev: T, next: T) => void;
  fovUpdated: (deltaIn: GridCoord[], deltaOut: GridCoord[]) => void;
  maskChanged: (mask: 'passable' | 'explored' | 'visible') => void;
}

/**
 * Plain-object snapshot of a grid's full state. Returned by `serialize()`
 * and accepted by `restore()`. Wrap in a single `persistent()` ref to
 * persist across saves; per-cell `persistent()` is explicitly rejected.
 *
 * Bitmap fields are `Uint8Array` to match the live grid's shape — no
 * shim when building a snapshot from in-memory data, and `restore()`
 * can use `.set()` in bulk rather than an element loop. `serialize()`
 * returns fresh typed-array copies, so mutating the live grid after a
 * serialize never corrupts the snapshot.
 */
export interface SpatialGridSnapshot<T> {
  width: number;
  height: number;
  /** Row-major dense cell array, length === width * height. */
  cells: T[];
  passable: Uint8Array;
  explored: Uint8Array;
  visible: Uint8Array;
}

/**
 * Handle returned by {@link SpatialGrid.beginFovUpdate}. Call
 * `markVisible(x, y)` for each cell the visibility algorithm reaches,
 * then `commit()` to apply atomically and emit one `fovUpdated` event
 * with the changeset.
 */
export interface FovUpdateHandle {
  /** Stage a cell as visible in the upcoming commit. Out-of-bounds is a no-op. */
  markVisible(x: number, y: number): void;
  /** Apply staged visibility, OR into `explored`, and emit one delta event. */
  commit(): void;
}

/** Bounded 2D grid with adjacency, BFS, FOV adapter, and snapshot persistence. */
export interface SpatialGrid<T> {
  readonly width: number;
  readonly height: number;

  /**
   * Number of cells whose `explored` bit was set via the FOV commit path
   * or `restore()`. Maintained incrementally so callers don't pay an
   * O(width × height) scan to check exploration progress.
   *
   * Direct mutation of the `explored` typed array bypasses this counter
   * (the engine has no way to observe it). If you write to `explored`
   * outside the FOV adapter, the count will drift; treat it as
   * authoritative only when commit/restore are the sole write paths.
   *
   * During a consumer port, reading this before every legacy write path
   * routes through the FOV adapter is the classic counter-drift trap.
   * See [migration-notes.md](../../docs/migration-notes.md) §
   * Counter drift during consumer migration.
   */
  readonly exploredCount: number;

  /**
   * Number of cells whose `passable` bit is set. Computed lazily on first
   * read and cached, recomputed eagerly in `restore()`.
   *
   * Same drift contract as `exploredCount`: direct mutation of the
   * `passable` typed array bypasses the cache. Treat as authoritative
   * only when `restore()` is the sole write path.
   */
  readonly passableCount: number;

  /**
   * Number of cells where both `passable === 1` and `explored === 1`.
   * The denominator for exploration-progress UIs that only care about
   * reachable terrain. Maintained incrementally alongside
   * `exploredCount` on FOV commit and recomputed in `restore()`.
   *
   * Same drift contract as `exploredCount`.
   */
  readonly exploredPassableCount: number;

  /** Returns the cell at (x, y). Throws if out of bounds. */
  at(x: number, y: number): T;
  /** Returns the cell at (x, y), or undefined if out of bounds. */
  tryAt(x: number, y: number): T | undefined;
  /**
   * Writes a value to (x, y) and emits `cellChanged` with the prior value.
   * Always emits, even when `prev === next` — the engine has no equality
   * contract for `T`. Throws if out of bounds.
   */
  set(x: number, y: number, value: T): void;
  inBounds(x: number, y: number): boolean;

  /** 4-connected neighbors of (x, y) within bounds. */
  neighbors(x: number, y: number): Iterable<GridCoord>;
  /** 8-connected neighbors of (x, y) within bounds. */
  neighborsDiag(x: number, y: number): Iterable<GridCoord>;
  /** All cells within Chebyshev `radius` of (x, y), within bounds. */
  inRange(x: number, y: number, radius: number): Iterable<GridCoord>;

  /**
   * Row-major flat cell array. Length = width * height, indexed by `y * width + x`.
   *
   * Exposed for hot-path consumers that iterate over every cell and cannot afford
   * the per-call bounds check overhead of `at`/`tryAt`. The array reference is
   * stable across `restore()` calls (entries are overwritten in place). Callers
   * must not mutate the array length; in-place cell mutation is fine for cell
   * types that support it (e.g. setting a field on a Tile object), but
   * replacing an entry bypasses `cellChanged` events — use `set()` if you have
   * subscribers.
   */
  readonly cells: readonly T[];

  /** Passability bitmap. Length = width * height. 1 = passable, 0 = blocked. */
  readonly passable: Uint8Array;
  /** Explored bitmap. 1 = ever-seen, 0 = unseen. */
  readonly explored: Uint8Array;
  /** Currently-visible bitmap. 1 = visible right now, 0 = hidden. */
  readonly visible: Uint8Array;

  /**
   * Breadth-first reachability from `start`. Uses 4- or 8-connected
   * neighbors per the grid's `allowDiagonals` option. Returns a parent-
   * link map: key is `"x,y"` of a reachable cell, value is the predecessor
   * coordinate on the BFS path. The start cell maps to itself.
   */
  bfs(start: GridCoord, isPassable: PassabilityFn<T>): Map<string, GridCoord>;

  /**
   * Returns a randomly-selected cell satisfying the predicate, or undefined
   * if none match. Uses the engine's seeded RNG; consumers control
   * determinism via `seedRNG()`.
   */
  findOpen(predicate: (cell: T, x: number, y: number) => boolean): GridCoord | undefined;

  /** All cells reachable from `start` via the passability test, including `start`. */
  flood(start: GridCoord, test: PassabilityFn<T>): Iterable<GridCoord>;

  /** Begin a batched FOV update. See {@link FovUpdateHandle}. */
  beginFovUpdate(): FovUpdateHandle;

  /** Subscribe to a grid event. Returns an unsubscribe function. */
  on<K extends keyof SpatialGridEvents<T>>(event: K, handler: SpatialGridEvents<T>[K]): Unsubscribe;

  /** Capture the grid's current state as a plain-object snapshot. */
  serialize(): SpatialGridSnapshot<T>;
  /** Replace the grid's state from a snapshot. Width/height must match construction. */
  restore(snapshot: SpatialGridSnapshot<T>): void;
}

/**
 * Create a bounded 2D grid sized `width × height`, populated by calling
 * `initializer(x, y)` for every cell.
 *
 * @example
 * ```ts
 * interface Tile { kind: 'floor' | 'wall'; }
 * const grid = createSpatialGrid<Tile>({
 *   width: 80,
 *   height: 25,
 *   initializer: () => ({ kind: 'floor' }),
 * });
 * for (let y = 0; y < grid.height; y++) {
 *   for (let x = 0; x < grid.width; x++) {
 *     if (grid.at(x, y).kind === 'floor') grid.passable[y * grid.width + x] = 1;
 *   }
 * }
 * ```
 */
export function createSpatialGrid<T>(options: SpatialGridOptions<T>): SpatialGrid<T> {
  const { width, height, initializer, allowDiagonals = false } = options;

  if (width <= 0 || height <= 0 || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error(
      `createSpatialGrid: width and height must be positive integers (got ${width}, ${height})`,
    );
  }

  const size = width * height;
  const cells: T[] = new Array(size);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      cells[y * width + x] = initializer(x, y);
    }
  }

  const passable = new Uint8Array(size);
  const explored = new Uint8Array(size);
  const visible = new Uint8Array(size);
  let exploredCount = 0;
  let exploredPassableCount = 0;
  // `passableCount` is lazy to avoid scanning the bitmap before the
  // generator has finished writing it. `-1` is the dirty sentinel.
  let passableCountCache = -1;

  // Single FOV staging buffer reused across commits — a fresh
  // Uint8Array per beginFovUpdate churns GC at high tick rates.
  // In-flight flag enforces the one-handle-at-a-time contract (same
  // shape as FovUpdateHandle's `committed` invariant).
  const fovStaging = new Uint8Array(size);
  let fovInFlight = false;

  const handle = createEmitHandle<SpatialGridEvents<T>>();
  // Skip delta computation in commit() when no fovUpdated handler is
  // attached — headless consumers (no renderer) would otherwise pay an
  // O(w × h) scan per FOV update for arrays that nothing reads.
  let fovSubscribers = 0;

  const idx = (x: number, y: number): number => y * width + x;
  const inBounds = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height;

  function checkBounds(x: number, y: number): void {
    if (!inBounds(x, y)) {
      throw new RangeError(`SpatialGrid: (${x}, ${y}) out of bounds (${width}×${height})`);
    }
  }

  function* neighbors4(x: number, y: number): Generator<GridCoord> {
    if (x > 0) yield { x: x - 1, y };
    if (x < width - 1) yield { x: x + 1, y };
    if (y > 0) yield { x, y: y - 1 };
    if (y < height - 1) yield { x, y: y + 1 };
  }

  function* neighbors8(x: number, y: number): Generator<GridCoord> {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (inBounds(nx, ny)) yield { x: nx, y: ny };
      }
    }
  }

  function* inRangeIter(cx: number, cy: number, radius: number): Generator<GridCoord> {
    const r = Math.max(0, Math.floor(radius));
    const x0 = Math.max(0, cx - r);
    const y0 = Math.max(0, cy - r);
    const x1 = Math.min(width - 1, cx + r);
    const y1 = Math.min(height - 1, cy + r);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        yield { x, y };
      }
    }
  }

  const bfsNeighbors = allowDiagonals ? neighbors8 : neighbors4;
  const posKey = (x: number, y: number): string => `${x},${y}`;

  const grid: SpatialGrid<T> = {
    width,
    height,
    cells,
    passable,
    explored,
    visible,
    get exploredCount() {
      return exploredCount;
    },
    get passableCount() {
      if (passableCountCache < 0) {
        let n = 0;
        for (let i = 0; i < size; i++) if (passable[i] === 1) n++;
        passableCountCache = n;
      }
      return passableCountCache;
    },
    get exploredPassableCount() {
      return exploredPassableCount;
    },

    at(x, y) {
      checkBounds(x, y);
      return cells[idx(x, y)];
    },

    tryAt(x, y) {
      return inBounds(x, y) ? cells[idx(x, y)] : undefined;
    },

    set(x, y, value) {
      checkBounds(x, y);
      const i = idx(x, y);
      const prev = cells[i];
      cells[i] = value;
      handle.emit('cellChanged', x, y, prev, value);
    },

    inBounds,

    neighbors(x, y) {
      checkBounds(x, y);
      return neighbors4(x, y);
    },

    neighborsDiag(x, y) {
      checkBounds(x, y);
      return neighbors8(x, y);
    },

    inRange(x, y, radius) {
      checkBounds(x, y);
      return inRangeIter(x, y, radius);
    },

    bfs(start, isPassable) {
      const result = new Map<string, GridCoord>();
      if (!inBounds(start.x, start.y)) return result;
      const startCoord: GridCoord = { x: start.x, y: start.y };
      result.set(posKey(start.x, start.y), startCoord);
      const queue: GridCoord[] = [startCoord];
      let head = 0;
      while (head < queue.length) {
        const cur = queue[head++];
        for (const n of bfsNeighbors(cur.x, cur.y)) {
          const key = posKey(n.x, n.y);
          if (result.has(key)) continue;
          if (!isPassable(cells[idx(n.x, n.y)], n.x, n.y)) continue;
          result.set(key, cur);
          queue.push(n);
        }
      }
      return result;
    },

    findOpen(predicate) {
      const matches: GridCoord[] = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (predicate(cells[idx(x, y)], x, y)) matches.push({ x, y });
        }
      }
      return randomItem(matches);
    },

    *flood(start, test) {
      if (!inBounds(start.x, start.y)) return;
      if (!test(cells[idx(start.x, start.y)], start.x, start.y)) return;
      const seen = new Set<string>();
      const queue: GridCoord[] = [{ x: start.x, y: start.y }];
      seen.add(posKey(start.x, start.y));
      let head = 0;
      while (head < queue.length) {
        const cur = queue[head++];
        yield cur;
        for (const n of bfsNeighbors(cur.x, cur.y)) {
          const key = posKey(n.x, n.y);
          if (seen.has(key)) continue;
          if (!test(cells[idx(n.x, n.y)], n.x, n.y)) continue;
          seen.add(key);
          queue.push(n);
        }
      }
    },

    beginFovUpdate() {
      if (fovInFlight) {
        throw new Error(
          'SpatialGrid.beginFovUpdate: a prior FovUpdateHandle has not been committed',
        );
      }
      fovInFlight = true;
      fovStaging.fill(0);
      let committed = false;
      return {
        markVisible(x, y) {
          if (inBounds(x, y)) fovStaging[idx(x, y)] = 1;
        },
        commit() {
          if (committed) {
            throw new Error('FovUpdateHandle.commit: already committed');
          }
          committed = true;
          if (fovSubscribers > 0) {
            const deltaIn: GridCoord[] = [];
            const deltaOut: GridCoord[] = [];
            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                const i = idx(x, y);
                const was = visible[i];
                const now = fovStaging[i];
                if (was !== now) {
                  if (now === 1) deltaIn.push({ x, y });
                  else deltaOut.push({ x, y });
                }
                visible[i] = now;
                if (now === 1 && explored[i] === 0) {
                  explored[i] = 1;
                  exploredCount++;
                  if (passable[i] === 1) exploredPassableCount++;
                }
              }
            }
            handle.emit('fovUpdated', deltaIn, deltaOut);
          } else {
            visible.set(fovStaging);
            for (let i = 0; i < size; i++) {
              if (fovStaging[i] === 1 && explored[i] === 0) {
                explored[i] = 1;
                exploredCount++;
                if (passable[i] === 1) exploredPassableCount++;
              }
            }
          }
          fovInFlight = false;
        },
      };
    },

    on(event, handler) {
      const off = handle.on(event, handler);
      if (event !== 'fovUpdated') return off;
      fovSubscribers++;
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        fovSubscribers--;
        off();
      };
    },

    serialize() {
      return {
        width,
        height,
        cells: cells.slice(),
        passable: new Uint8Array(passable),
        explored: new Uint8Array(explored),
        visible: new Uint8Array(visible),
      };
    },

    restore(snapshot) {
      if (snapshot.width !== width || snapshot.height !== height) {
        throw new Error(
          `SpatialGrid.restore: snapshot dimensions (${snapshot.width}×${snapshot.height}) do not match grid (${width}×${height})`,
        );
      }
      if (
        snapshot.cells.length !== size ||
        snapshot.passable.length !== size ||
        snapshot.explored.length !== size ||
        snapshot.visible.length !== size
      ) {
        throw new Error(`SpatialGrid.restore: snapshot array lengths do not match grid size`);
      }
      passable.set(snapshot.passable);
      explored.set(snapshot.explored);
      visible.set(snapshot.visible);
      let eCount = 0;
      let pCount = 0;
      let epCount = 0;
      for (let i = 0; i < size; i++) {
        cells[i] = snapshot.cells[i];
        if (explored[i]) eCount++;
        if (passable[i]) {
          pCount++;
          if (explored[i]) epCount++;
        }
      }
      exploredCount = eCount;
      passableCountCache = pCount;
      exploredPassableCount = epCount;
    },
  };

  return grid;
}

// TODO(expansion): `createPlacementResolver<TCell, TBonus>(grid, scoring, onResolve)` sugar for Packer +
// Auto-battler grid-placement-auto-resolve substrate. Park until two consumers hand-roll the wrapper.
// Ref: open-loop-research/reports/studies/arcade-market-archetypes/arcade-market-archetypes-primitive-surface.md § 3.
