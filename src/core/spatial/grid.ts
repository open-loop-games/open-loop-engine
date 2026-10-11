/**
 * SpatialGrid<T> — bounded 2D grid primitive.
 *
 * @cluster spatial-grid
 *
 * Plain data: dense `T[]` cell storage plus three `Uint8Array` bitmaps
 * (passable / explored / visible). Adjacency, range, traversal, and an FOV
 * commit handle that lets external libraries (rot.js shadowcasting) write
 * visibility back without the engine importing them.
 *
 * Rectangular *storage*, not rectangular *adjacency*: the `neighborhood`
 * option is the board's adjacency as a set of offsets. So 4-connected,
 * 8-connected, and hex-at-an-axial-offset are the same container with a
 * different neighborhood, and every traversal verb follows it.
 *
 * Two traversal queries, split by what the caller does with the answer:
 * `bfs()` for reachability and path reconstruction (parent links, hop order),
 * `distanceField()` for routing and gradient descent (least-cost distance per
 * cell, weighted, multi-source).
 *
 * Persistence is structure-level: `serialize()` returns the grid's
 * serialized form, and `restore(serialized)` rebuilds from it. The consumer
 * wraps the serialized form in a single `persistent()` ref; the engine
 * never creates a ref per cell.
 *
 * Events:
 * - `cellChanged(x, y, prev, next)` — game-logic mutations via `set()`.
 * - `gridChanged()` — one coarse event per `fill()` or `restore()`.
 * - `fovUpdated(deltaIn, deltaOut)` — one batched event per `commit()`.
 * - `maskChanged(mask)` — coarse event that a whole bitmap may have
 *   changed outside the FOV path: once per `markMaskChanged(mask)`, and once
 *   per bitmap on `restore()`.
 */

import { toRaw } from 'vue';
import { createEmitHandle } from '../events';
import { randomItem } from '@/primitives/rng';
import type { GridCoord, GridOffset, PassabilityFn, TraversalCostFn, Unsubscribe } from './types';

/** Options accepted by {@link createSpatialGrid}. */
export interface SpatialGridOptions<T> {
  readonly width: number;
  readonly height: number;
  /** Cell value factory. Called once per cell at construction. */
  readonly initializer: (x: number, y: number) => T;
  /**
   * The board's adjacency, as the set of offsets from a cell to its
   * neighbors. Drives `neighbors()` and every traversal query (`bfs`,
   * `flood`, `distanceField`). So a board's adjacency is stated once, at
   * construction, and the traversal verbs follow.
   *
   * Defaults to {@link ORTHOGONAL_DELTAS} (4-connected). Ships
   * {@link DIAGONAL_DELTAS} (8-connected) and {@link HEX_AXIAL_DELTAS}
   * (6-connected hex under axial-offset storage); any other adjacency —
   * knight moves, directed one-way lattices — is an array literal.
   *
   * Iteration order follows this array, and traversal tie-breaks follow
   * iteration order, so the order is part of the board's contract.
   */
  readonly neighborhood?: readonly GridOffset[];
}

/** 4-connected orthogonal adjacency: E, W, N, S. The `neighborhood` default. */
export const ORTHOGONAL_DELTAS: readonly GridOffset[] = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: -1 },
  { dx: 0, dy: 1 },
];

/** 8-connected adjacency: the four orthogonals plus the four diagonals. */
export const DIAGONAL_DELTAS: readonly GridOffset[] = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: -1 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: -1 },
  { dx: 1, dy: 1 },
  { dx: -1, dy: -1 },
  { dx: -1, dy: 1 },
];

/**
 * 6-connected hex adjacency, clockwise from east, for a hex board stored at
 * an axial offset. Axial `(q, r)` is stored at grid `(q + radius, r + radius)`,
 * which makes axial offsets equal grid offsets. That storage convention is what
 * lets a hex board keep the whole rectangular-grid API surface (events,
 * serialized forms, `createInfluenceLayer`) instead of dropping to
 * `createGraph`.
 *
 * The engine knows nothing else about hexes: no axial or cube coordinate
 * type, no hex distance, no pixel layout. Those stay consumer-side, where the
 * storage offset and the display convention already are.
 */
export const HEX_AXIAL_DELTAS: readonly GridOffset[] = [
  { dx: 1, dy: 0 },
  { dx: 1, dy: -1 },
  { dx: 0, dy: -1 },
  { dx: -1, dy: 0 },
  { dx: -1, dy: 1 },
  { dx: 0, dy: 1 },
];

/** Events emitted by a {@link SpatialGrid}. Subscribe via `grid.on()`. */
export interface SpatialGridEvents<T> {
  cellChanged: (x: number, y: number, prev: T, next: T) => void;
  /** One coarse event per bulk mutation (`fill()`, `restore()`). No per-cell payload. */
  gridChanged: () => void;
  fovUpdated: (deltaIn: GridCoord[], deltaOut: GridCoord[]) => void;
  maskChanged: (mask: 'passable' | 'explored' | 'visible') => void;
}

/**
 * Serialized form of a grid's full state. Returned by `serialize()` and
 * accepted by `restore()`. Wrap it in a single `persistent()` ref to save
 * it; do not give each cell its own `persistent()` ref.
 *
 * Bitmap fields are plain `number[]`, not `Uint8Array`, because the
 * serialized form must round-trip through JSON. A `Uint8Array` stringifies to
 * `{"0":1,...}` and reloads as a lengthless object, which `restore()` rejects.
 * The live grid keeps `Uint8Array` for per-tick performance; `serialize()`
 * copies out to `number[]` and `restore()` bulk-loads via `.set()`, which
 * accepts a plain array.
 *
 * The bitmaps are fresh copies; `cells` is a shallow one. The array is new,
 * but its entries are the grid's own cell objects, and `restore()` stores the
 * serialized form's objects in turn. So with object cells, a mutation in place
 * (a tile's field, say) shows through in both directions. A copy kept for an
 * undo or a retry has to copy its cells first. Primitive cells,
 * and cells replaced through `set()`, never alias. `restore()` unwraps
 * reactive proxies, so restoring from a `persistent()` ref's `.value` keeps
 * the grid's cells raw.
 */
export interface SerializedSpatialGrid<T> {
  /** Format version. `serialize()` writes 1; `restore()` reads an absent one as 1. */
  version?: 1;
  width: number;
  height: number;
  /** Row-major dense cell array, length === width * height. */
  cells: T[];
  passable: number[];
  explored: number[];
  /**
   * Last committed FOV. Derivable, but only by a FOV pass the game runs when
   * its viewpoint moves, so it's kept: a reload shows the view it saved.
   */
  visible: number[];
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
  /** Apply staged visibility, OR into `explored`, and emit one `fovUpdated` event. */
  commit(): void;
}

/**
 * Bounded 2D grid with configurable adjacency, BFS and weighted distance
 * fields, an FOV commit handle, and persistence through a serialized form.
 */
export interface SpatialGrid<T> {
  readonly width: number;
  readonly height: number;

  /**
   * Number of cells whose `explored` bit is set. Maintained incrementally by
   * the FOV commit path and re-derived by `restore()` and
   * `markMaskChanged('explored')`, so callers skip an
   * O(width × height) scan to check exploration progress.
   *
   * A hand write to the `explored` typed array is invisible to the engine:
   * follow it with `markMaskChanged('explored')` or the count drifts. Trust
   * this count only once every write path goes through the FOV commit
   * handle or `markMaskChanged`.
   *
   * A snapshot: typed-array hot-path state, so a computed over it never
   * recomputes. Re-read it after the write that changed it, or watch the
   * mask writes you own. Same for `passableCount` and `exploredPassableCount`.
   */
  readonly exploredCount: number;

  /**
   * Number of cells whose `passable` bit is set. Computed lazily on first
   * read and cached; `restore()` and `markMaskChanged('passable')` re-derive
   * it.
   *
   * Same drift contract as `exploredCount`: once cached, a hand write to the
   * `passable` typed array needs a following `markMaskChanged('passable')`.
   */
  readonly passableCount: number;

  /**
   * Number of cells where both `passable === 1` and `explored === 1`.
   * The denominator for exploration-progress UIs that only care about
   * reachable terrain. Maintained incrementally alongside
   * `exploredCount` on FOV commit, and re-derived by `restore()` and by
   * `markMaskChanged` of either bitmap.
   *
   * Same drift contract as `exploredCount`.
   */
  readonly exploredPassableCount: number;

  /** Returns the cell at (x, y). Throws if out of bounds or not integers. */
  at(x: number, y: number): T;
  /** Returns the cell at (x, y), or undefined if out of bounds or not integers. */
  tryAt(x: number, y: number): T | undefined;
  /**
   * Writes a value to (x, y) and emits `cellChanged` with the prior value.
   * Always emits, even when `prev === next` — the engine has no equality
   * contract for `T`. Throws if out of bounds.
   */
  set(x: number, y: number, value: T): void;
  /**
   * Writes a value to (x, y) without emitting `cellChanged`. For per-tick
   * internal writers (influence-layer accumulation and similar) where an
   * event per cell write is pure overhead. Pair it with a coarser event the
   * consumer owns (an influence-layer event, or `fill()`'s `gridChanged`).
   * Bounds-checked like `set()`. Throws if out of bounds.
   */
  setSilent(x: number, y: number, value: T): void;
  /**
   * Overwrites every cell in one row-major pass: each cell becomes
   * `mapper(x, y, current)`. Emits a single `gridChanged` event instead of
   * one `cellChanged` per cell — the batch counterpart to `set()` for
   * full-grid mutations (zero-fill, decay passes, board generation).
   */
  fill(mapper: (x: number, y: number, current: T) => T): void;
  /**
   * Whether (x, y) names a cell: both coordinates integers inside
   * width × height. A fractional coordinate is never in bounds, so `at`,
   * `set` and `setSilent` throw on one rather than address a non-cell.
   */
  inBounds(x: number, y: number): boolean;

  /**
   * In-bounds neighbors of (x, y) under the grid's configured
   * `neighborhood`, in that array's order.
   *
   * @param neighborhood - Ad-hoc neighborhood for this call only, overriding
   *   the grid's own. For the query that wants a different adjacency than the
   *   board — an 8-connected scan on a 4-connected board, say — without
   *   changing what traversal does.
   */
  neighbors(x: number, y: number, neighborhood?: readonly GridOffset[]): Iterable<GridCoord>;
  /** All cells within Chebyshev `radius` of (x, y), within bounds. */
  inRange(x: number, y: number, radius: number): Iterable<GridCoord>;
  /**
   * Per-cell `fn` form of `inRange` for hot paths: visits the same cells
   * without allocating a coordinate object (or generator result) per cell.
   * It passes `fn` the flat `y * width + x` index for direct `cells` access.
   * Prefer `inRange` outside per-tick loops, because `for…of` is clearer.
   */
  forEachInRange(
    x: number,
    y: number,
    radius: number,
    fn: (x: number, y: number, index: number) => void,
  ): void;

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

  /**
   * Passability bitmap. Length = width * height. 1 = passable, 0 = blocked.
   * Written by hand; follow a batch of writes with `markMaskChanged('passable')`.
   */
  readonly passable: Uint8Array;
  /** Explored bitmap. 1 = ever-seen, 0 = unseen. Written by the FOV commit. */
  readonly explored: Uint8Array;
  /** Currently-visible bitmap. 1 = visible right now, 0 = not visible. */
  readonly visible: Uint8Array;

  /**
   * Breadth-first reachability from `start`, over the grid's configured
   * `neighborhood`. Returns a parent-
   * link map: key is `"x,y"` of a reachable cell, value is the predecessor
   * coordinate on the BFS path. The start cell maps to itself.
   */
  bfs(start: GridCoord, isPassable: PassabilityFn<T>): Map<string, GridCoord>;

  /**
   * Least-cost distance from a set of sources to every cell, as a dense
   * `Float64Array` indexed `y * width + x` — the same layout as the
   * `passable` / `explored` / `visible` bitmaps. Unreachable cells hold
   * `Infinity`; every source reachable at all holds `0`.
   *
   * This is the query for routing and gradient-descent movement, where
   * `bfs()` is the query for reachability and path reconstruction. `bfs()`
   * returns parent links and no distances; this returns distances and no
   * parent links. Units descend the field, and deriving the step direction
   * consumer-side keeps routing and display from disagreeing on tie-breaks.
   *
   * Expands the grid's configured `neighborhood`, matching `bfs()` and
   * `flood()` — so a hex board routes over hex adjacency without this query
   * knowing what a hex is. Sources out of bounds, or whose own
   * `cost` is `Infinity`, are dropped rather than seeded — a source standing
   * on impassable terrain is not a zero-distance origin.
   *
   * Storage is `Float64Array`, so accumulated cost keeps the full precision
   * of the caller's `cost` values. Quantize on the way out if you need a
   * narrower field. This is a precision choice, not what makes the traversal
   * sound. Soundness comes from the queue holding the *stored* distance
   * rather than the computed one, so the staleness check compares like with
   * like. Narrowing the store without that would round a distance below its
   * queue key and drop nodes unexpanded, leaving whole areas at
   * `Infinity`. Integer costs hide the fault; any non-dyadic cost triggers it.
   *
   * @param sources - Seed cells, all at distance 0. A single-source query is
   *   a one-element set.
   * @param cost - Cost to enter each cell, ≥ 0; `Infinity` means impassable,
   *   and a negative cost throws a `RangeError`. Must not call
   *   `distanceField` on this grid — the query reuses a per-grid scratch
   *   queue.
   * @param into - Optional destination array of length `width * height`,
   *   filled in place and returned. For per-tick callers that keep one
   *   field buffer instead of allocating one per recompute.
   *
   * @example
   * ```ts
   * // Distance to the nearest of several supply depots, with roads cheap.
   * const supply = grid.distanceField(depots, (cell) =>
   *   cell.kind === 'wall' ? Infinity : cell.road ? 0.5 : 1,
   * );
   * const here = supply[y * grid.width + x];
   * ```
   */
  distanceField(
    sources: Iterable<GridCoord>,
    cost: TraversalCostFn<T>,
    into?: Float64Array,
  ): Float64Array;

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

  /**
   * Declare that `mask` was written by hand, outside `beginFovUpdate()` and
   * `restore()`: re-derives the counts that bitmap feeds and emits
   * `maskChanged(mask)`. The write path for terrain that changes in play — a
   * door opening, a wall going up — and for board generation that fills
   * `passable` after construction. Costs one scan of the grid, so call it
   * once per batch of writes rather than once per cell.
   *
   * @example
   * ```ts
   * grid.passable[y * grid.width + x] = 1; // the door opens
   * grid.markMaskChanged('passable');
   * ```
   */
  markMaskChanged(mask: 'passable' | 'explored' | 'visible'): void;

  /** Subscribe to a grid event. Returns an unsubscribe function. */
  on<K extends keyof SpatialGridEvents<T>>(event: K, handler: SpatialGridEvents<T>[K]): Unsubscribe;

  /** Return the grid's current state as its serialized form. */
  serialize(): SerializedSpatialGrid<T>;
  /**
   * Replace the grid's state from a serialized form. Width/height must
   * match construction; a format version other than 1 throws. Once every
   * cell, bitmap and count is written, emits one `gridChanged` and then one
   * `maskChanged` per bitmap (passable, explored, visible). So UI code
   * redraws a loaded board the same way it redraws after a `fill()`, with
   * no per-cell `cellChanged`.
   */
  restore(serialized: SerializedSpatialGrid<T>): void;
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
 * grid.markMaskChanged('passable');
 * ```
 */
export function createSpatialGrid<T>(options: SpatialGridOptions<T>): SpatialGrid<T> {
  const { width, height, initializer, neighborhood = ORTHOGONAL_DELTAS } = options;

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
  // Uint8Array per beginFovUpdate churns GC on every tick.
  // In-flight flag enforces the one-handle-at-a-time contract (same
  // shape as FovUpdateHandle's `committed` invariant).
  const fovStaging = new Uint8Array(size);
  let fovInFlight = false;

  const handle = createEmitHandle<SpatialGridEvents<T>>();
  // Skip change-list computation in commit() when no fovUpdated handler is
  // attached — headless consumers (no display) would otherwise run an
  // O(w × h) scan per FOV update for arrays that nothing reads.
  let fovSubscribers = 0;

  const idx = (x: number, y: number): number => y * width + x;
  const inBounds = (x: number, y: number): boolean =>
    Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height;

  function checkBounds(x: number, y: number): void {
    if (!inBounds(x, y)) {
      throw new RangeError(`SpatialGrid: (${x}, ${y}) out of bounds (${width}×${height})`);
    }
  }

  // Re-derive every bitmap count with one scan, for the write paths that
  // replace a bitmap wholesale instead of flipping bits one at a time.
  function recountMasks(): void {
    let eCount = 0;
    let pCount = 0;
    let epCount = 0;
    for (let i = 0; i < size; i++) {
      if (explored[i]) eCount++;
      if (passable[i]) {
        pCount++;
        if (explored[i]) epCount++;
      }
    }
    exploredCount = eCount;
    passableCountCache = pCount;
    exploredPassableCount = epCount;
  }

  function* neighborsOf(
    x: number,
    y: number,
    offsets: readonly GridOffset[],
  ): Generator<GridCoord> {
    for (let i = 0; i < offsets.length; i++) {
      const nx = x + offsets[i].dx;
      const ny = y + offsets[i].dy;
      if (inBounds(nx, ny)) yield { x: nx, y: ny };
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

  const bfsNeighbors = (x: number, y: number): Generator<GridCoord> =>
    neighborsOf(x, y, neighborhood);
  const posKey = (x: number, y: number): string => `${x},${y}`;

  // Binary min-heap over parallel key/payload arrays, retained across
  // `distanceField` calls — a fresh heap per recompute churns GC on every tick,
  // which is the whole reason `into` exists on the same query. Reuse is what
  // makes the query non-reentrant; the TSDoc states that contract.
  const heapKey: number[] = [];
  const heapIdx: number[] = [];

  function heapPush(key: number, payload: number): void {
    heapKey.push(key);
    heapIdx.push(payload);
    let c = heapKey.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heapKey[p] <= heapKey[c]) break;
      [heapKey[p], heapKey[c]] = [heapKey[c], heapKey[p]];
      [heapIdx[p], heapIdx[c]] = [heapIdx[c], heapIdx[p]];
      c = p;
    }
  }

  function heapPop(): number {
    const top = heapIdx[0];
    const lastKey = heapKey.pop()!;
    const lastIdx = heapIdx.pop()!;
    if (heapKey.length > 0) {
      heapKey[0] = lastKey;
      heapIdx[0] = lastIdx;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1;
        const r = l + 1;
        let m = p;
        if (l < heapKey.length && heapKey[l] < heapKey[m]) m = l;
        if (r < heapKey.length && heapKey[r] < heapKey[m]) m = r;
        if (m === p) break;
        [heapKey[p], heapKey[m]] = [heapKey[m], heapKey[p]];
        [heapIdx[p], heapIdx[m]] = [heapIdx[m], heapIdx[p]];
        p = m;
      }
    }
    return top;
  }

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

    setSilent(x, y, value) {
      checkBounds(x, y);
      cells[idx(x, y)] = value;
    },

    fill(mapper) {
      for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
          const i = row + x;
          cells[i] = mapper(x, y, cells[i]);
        }
      }
      handle.emit('gridChanged');
    },

    inBounds,

    neighbors(x, y, offsets = neighborhood) {
      checkBounds(x, y);
      return neighborsOf(x, y, offsets);
    },

    inRange(x, y, radius) {
      checkBounds(x, y);
      return inRangeIter(x, y, radius);
    },

    forEachInRange(cx, cy, radius, fn) {
      checkBounds(cx, cy);
      const r = Math.max(0, Math.floor(radius));
      const x0 = Math.max(0, cx - r);
      const y0 = Math.max(0, cy - r);
      const x1 = Math.min(width - 1, cx + r);
      const y1 = Math.min(height - 1, cy + r);
      for (let y = y0; y <= y1; y++) {
        const row = y * width;
        for (let x = x0; x <= x1; x++) {
          fn(x, y, row + x);
        }
      }
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

    distanceField(sources, cost, into) {
      let dist: Float64Array;
      if (into) {
        if (into.length !== size) {
          throw new RangeError(
            `SpatialGrid.distanceField: 'into' must have length ${size} (got ${into.length})`,
          );
        }
        dist = into;
      } else {
        dist = new Float64Array(size);
      }
      dist.fill(Infinity);
      heapKey.length = 0;
      heapIdx.length = 0;

      for (const s of sources) {
        if (!inBounds(s.x, s.y)) continue;
        const i = idx(s.x, s.y);
        if (!Number.isFinite(cost(cells[i], s.x, s.y))) continue;
        if (dist[i] === 0) continue;
        dist[i] = 0;
        heapPush(0, i);
      }

      while (heapKey.length > 0) {
        const d = heapKey[0];
        const u = heapPop();
        // Lazy deletion: a cell already relaxed to something better has a
        // stale entry still sitting in the heap.
        if (d > dist[u]) continue;
        const ux = u % width;
        const uy = (u - ux) / width;
        // Offset walk inlined rather than routed through `neighbors()`: this is
        // the one traversal whose inner loop runs per relaxation, and the
        // generator would box a coordinate object per neighbor per pop.
        for (let k = 0; k < neighborhood.length; k++) {
          const nx = ux + neighborhood[k].dx;
          const ny = uy + neighborhood[k].dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          const step = cost(cells[ni], nx, ny);
          if (!Number.isFinite(step)) continue;
          // A negative step makes a cycle that relaxes forever.
          if (step < 0) {
            throw new RangeError(
              `SpatialGrid.distanceField: cost at (${nx}, ${ny}) is negative (${step}); costs must be ≥ 0`,
            );
          }
          const nd = d + step;
          if (nd < dist[ni]) {
            dist[ni] = nd;
            // Push what was *stored*, not what was computed, so the pop-time
            // staleness check compares like with like.
            heapPush(dist[ni], ni);
          }
        }
      }
      return dist;
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

    markMaskChanged(mask) {
      if (mask !== 'visible') recountMasks();
      handle.emit('maskChanged', mask);
    },

    serialize() {
      return {
        version: 1,
        width,
        height,
        cells: cells.slice(),
        passable: Array.from(passable),
        explored: Array.from(explored),
        visible: Array.from(visible),
      };
    },

    restore(serialized) {
      if (serialized.version !== undefined && serialized.version !== 1) {
        throw new Error(
          `SpatialGrid.restore: unsupported format version ${String(serialized.version)}`,
        );
      }
      if (serialized.width !== width || serialized.height !== height) {
        throw new Error(
          `SpatialGrid.restore: serialized dimensions (${serialized.width}×${serialized.height}) do not match grid (${width}×${height})`,
        );
      }
      if (
        serialized.cells.length !== size ||
        serialized.passable.length !== size ||
        serialized.explored.length !== size ||
        serialized.visible.length !== size
      ) {
        throw new Error(`SpatialGrid.restore: serialized array lengths do not match grid size`);
      }
      passable.set(serialized.passable);
      explored.set(serialized.explored);
      visible.set(serialized.visible);
      for (let i = 0; i < size; i++) {
        // A serialized form read back through a `persistent()` ref yields reactive
        // proxies; the grid holds the raw objects so per-tick reads skip proxy traps.
        cells[i] = toRaw(serialized.cells[i]);
      }
      recountMasks();
      handle.emit('gridChanged');
      handle.emit('maskChanged', 'passable');
      handle.emit('maskChanged', 'explored');
      handle.emit('maskChanged', 'visible');
    },
  };

  return grid;
}
