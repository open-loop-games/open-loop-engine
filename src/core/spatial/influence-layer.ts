/**
 * InfluenceLayer — utility-function layer over `SpatialGrid<number>`.
 *
 * @cluster spatial-influence-layer
 *
 * Adds the per-tick propagation/decay lifecycle that turns a numeric grid
 * into a working influence layer without introducing a new storage primitive.
 * The cell values are in the caller-supplied `SpatialGrid<number>`; the
 * layer owns only the source registry and the update pass. Persistence is
 * delegated to the grid. The source registry is ephemeral: the consumer
 * re-registers its sources at game start from its own authoritative list.
 *
 * Field shape: the threat layers of RTS AI opponents, including threat
 * stratified into several layers by unit class. Cross-axis use (decision
 * scoring + spatial classification + opponent density) reads one layer's
 * `read()` view, so all three axes share one storage.
 *
 * Distance metric: chosen by the falloff function. Accumulation iterates
 * the grid's `forEachInRange`, the Chebyshev square of `radius`. It hands
 * each cell's `(dx, dy, radius)` to the falloff, which decides how to
 * collapse the coordinate offset into a scalar. Built-in falloffs are Euclidean
 * (`Math.hypot(dx, dy)`); custom falloffs are free to pick Chebyshev
 * (`Math.max(|dx|, |dy|)`), Manhattan (`|dx| + |dy|`), or hex-axial
 * (`(|dx| + |dy| + |dx + dy|) / 2`). Built-ins clamp or asymptote past
 * `radius`; custom falloffs are responsible for their own cutoff.
 *
 * Update order: decay → accumulate. `retentionFactor` is the fraction kept
 * per tick (1.0 = no decay; 0.95 = lose 5% per tick; 0 / undefined = zero-fill).
 * Zero-fill is the default: the cheapest, it follows source movement at
 * once, and it matches the most common field shape.
 *
 * Events: the layer writes through the grid's silent/bulk paths, so no
 * per-cell `cellChanged` event is emitted on every tick. Reactive wrappers
 * subscribe to the layer's own `updated` event, emitted once per
 * `update()`/`reset()` after all cell writes are done.
 *
 * Validation: `addSource` throws on illegal input (duplicate source id, NaN
 * strength, a position off the grid's integer cells), so misuse throws at
 * the call. A source moved off the grid later is skipped by `update()`
 * rather than aborting the update.
 */

import { createEmitHandle } from '../events';
import type { SpatialGrid } from './grid';
import type { Unsubscribe } from './types';

/**
 * An influence source: a point that adds influence to the layer.
 *
 * Held by reference: callers may mutate `x`, `y`, `strength`, or `radius`
 * directly between updates, and the next `update()` uses the current
 * values. Source identity is the caller-assigned `id` — re-using an id
 * across `addSource` calls throws. A source whose position leaves the grid,
 * or is between cells, contributes nothing until it is back on a cell.
 */
export interface InfluenceSource {
  /** Stable id for source removal/lookup. */
  id: string;
  /** Integer grid coordinate of the source. Mutable by reference. */
  x: number;
  y: number;
  /** Source strength at origin; falls off via the configured falloff function. */
  strength: number;
  /**
   * Per-source radius override: the half-width of the square of cells the
   * source reaches (a Chebyshev reach). The falloff picks the metric inside
   * that square. Omit to use the layer's `defaultRadius`.
   */
  radius?: number;
}

/**
 * Falloff function applied per cell during accumulation.
 *
 * Receives the cell-to-source coordinate offset (`dx`, `dy`) and the source's
 * effective radius (per-source override or `defaultRadius`). Returns a
 * scalar multiplier applied to the source's `strength`. The falloff owns
 * the choice of distance metric — collapse `(dx, dy)` to whatever scalar
 * fits the grid's neighborhood:
 *
 * - Euclidean: `Math.hypot(dx, dy)` (built-in default)
 * - Chebyshev: `Math.max(Math.abs(dx), Math.abs(dy))` (square / diagonal-equal grids)
 * - Manhattan: `Math.abs(dx) + Math.abs(dy)` (4-connected boards)
 * - Hex axial: `(Math.abs(dx) + Math.abs(dy) + Math.abs(dx + dy)) / 2`
 *
 * Implementations are responsible for clamping at distance ≥ radius if a
 * hard cutoff is desired; built-in falloffs do this where it makes sense
 * (`linearFalloff` clamps; `gaussianFalloff` and `exponentialFalloff`
 * asymptote).
 *
 * @example Chebyshev lookup table for a roguelike danger layer
 * ```ts
 * const DANGER = [2.0, 1.0, 0.6, 0.35, 0.2];
 * const dangerFalloff: FalloffFunction = (dx, dy, _r) => {
 *   const d = Math.max(Math.abs(dx), Math.abs(dy));
 *   return d < DANGER.length ? DANGER[d] : 0;
 * };
 * ```
 */
export type FalloffFunction = (dx: number, dy: number, radius: number) => number;

/** Options accepted by {@link createInfluenceLayer}. */
export interface InfluenceLayerOptions {
  /** Default radius for sources that do not specify one. */
  defaultRadius: number;
  /**
   * Falloff function. Built-ins: {@link linearFalloff}, {@link gaussianFalloff},
   * {@link exponentialFalloff} (all Euclidean). Custom falloffs are plain
   * `(dx, dy, radius) => number` functions and may use any distance metric —
   * see {@link FalloffFunction} for Chebyshev / Manhattan / hex examples.
   */
  falloff: FalloffFunction;
  /**
   * Retention factor: the fraction of each cell kept per tick, applied
   * before accumulation.
   * - `1.0` — no decay; sources accumulate on top of prior-tick values.
   * - `0.95` — lose 5% per tick (partial decay).
   * - `0` or omitted — zero-fill each tick (cheapest, and follows source
   *   movement at once). This is the most common field shape.
   */
  retentionFactor?: number;
  /**
   * When true, accumulation skips cells where `grid.passable[idx] === 0`.
   * Default false — RTS threat layers typically allow walls to receive
   * threat values so units can score "inside the firing arc but behind
   * cover" positions.
   *
   * Caller must populate `grid.passable` before the first `update()`;
   * otherwise this check excludes every cell.
   */
  respectPassability?: boolean;
  /**
   * Called once per `update()` with the count of cells touched during
   * accumulation. Pass the count to a profiler to track influence-layer
   * cost on large boards. No per-cell overhead.
   */
  onProfile?: (samples: number) => void;
}

/**
 * Read-only view over an influence layer's grid. Decision systems pass
 * the view to consumers that should not mutate sources or trigger
 * updates. {@link composeInfluenceLayers} also returns a view, so a
 * composed multi-layer query is interchangeable with a single-layer one.
 */
export interface InfluenceLayerView {
  /** Sample influence at a point. Returns 0 if out of bounds. */
  at(x: number, y: number): number;
  /**
   * Sum influence over the range of `radius` around `(x, y)`. Only
   * in-bounds cells contribute, and an out-of-bounds center sums to 0.
   * Composed views walk the same range under the first view's `inBounds`.
   */
  sum(x: number, y: number, radius: number): number;
  /**
   * Find the cell within a Chebyshev `radius` of `(x, y)` with the highest
   * influence. Ties broken by iteration order. Returns `null` only if no
   * cell is in range, which is the case for an out-of-bounds center.
   */
  peak(x: number, y: number, radius: number): { x: number; y: number; value: number } | null;
  /**
   * Whether `(x, y)` is within the view's domain. Composed views defer
   * to their first underlying view (all are assumed to share a grid, as
   * `cells()` also relies on). Lets `sum()` and `peak()` honour their bounds
   * contract without every consumer re-deriving grid dimensions.
   */
  inBounds(x: number, y: number): boolean;
  /**
   * Iterate the underlying grid's cells as `[x, y, value]` triples in
   * row-major order. Composed views iterate the first underlying
   * view's cell set, applying the combine function per cell.
   */
  cells(): Iterable<[number, number, number]>;
}

/** Events emitted by an {@link InfluenceLayer}. Subscribe via `layer.on()`. */
export interface InfluenceLayerEvents {
  /**
   * Emitted once per `update()` / `reset()`, after all cell writes are
   * done. The layer's writes skip per-cell `cellChanged`, to avoid an event
   * per cell on every tick. So this is the event reactive wrappers
   * subscribe to.
   */
  updated: () => void;
}

/** Lifecycle handle for an influence layer. */
export interface InfluenceLayer {
  /**
   * The underlying numeric grid the layer reads and writes through.
   * Exposed so tight-loop consumers can read raw cells without per-call
   * bounds checks. The layer's own writes are silent at the grid level —
   * reactive wrappers subscribe to the layer's `updated` event, not
   * `grid.on('cellChanged')`.
   */
  readonly grid: SpatialGrid<number>;

  /** Returns a stable read-only view over the layer. */
  read(): InfluenceLayerView;

  // Source registry --------------------------------------------------------

  /**
   * Register a source. The returned reference is the same object the
   * caller passed in — mutating its `x`/`y`/`strength`/`radius` between
   * updates is the supported update path. Throws on duplicate id, NaN
   * strength, or coords that aren't an in-bounds integer cell.
   */
  addSource(source: InfluenceSource): InfluenceSource;
  /** Remove a source by id. Returns true if a source was removed. */
  removeSource(id: string): boolean;
  /** Retrieve a source by id, or undefined if not registered. */
  getSource(id: string): InfluenceSource | undefined;

  // Lifecycle --------------------------------------------------------------

  /**
   * One propagation pass: decay (multiply by `retentionFactor`, or zero-fill if
   * `retentionFactor` is 0/undefined) → accumulate from each registered source.
   * Caller drives the tick; the layer has no internal timer.
   */
  update(): void;
  /**
   * Set every cell to zero without running accumulation. Useful on board
   * load or at the start of a new round.
   */
  reset(): void;

  /** Subscribe to a layer event. Returns an unsubscribe function. */
  on<K extends keyof InfluenceLayerEvents>(event: K, handler: InfluenceLayerEvents[K]): Unsubscribe;
}

// === BUILT-IN FALLOFF FUNCTIONS ===
// All built-ins use Euclidean distance (`Math.hypot(dx, dy)`). Custom
// falloffs may pick any metric — see {@link FalloffFunction}.

/** Linear falloff `(1 - d/r)`, clamped to `[0, 1]`, Euclidean `d`. */
export const linearFalloff: FalloffFunction = (dx, dy, r) => {
  if (r <= 0) return 0;
  const v = 1 - Math.hypot(dx, dy) / r;
  return v > 0 ? v : 0;
};

/** Gaussian falloff `exp(-(d/r)^2 * 2)`, Euclidean `d`. Asymptotes; never zero. */
export const gaussianFalloff: FalloffFunction = (dx, dy, r) => {
  if (r <= 0) return 0;
  const x = Math.hypot(dx, dy) / r;
  return Math.exp(-(x * x) * 2);
};

/** Exponential falloff `exp(-d/r)`, Euclidean `d`. Asymptotes; never zero. */
export const exponentialFalloff: FalloffFunction = (dx, dy, r) => {
  if (r <= 0) return 0;
  return Math.exp(-Math.hypot(dx, dy) / r);
};

// === CREATEINFLUENCELAYER ===
/**
 * Build an influence layer over a `SpatialGrid<number>`.
 *
 * @param grid Caller-owned numeric grid. The layer reads and writes via the
 *             grid's public API; persistence is the grid's concern.
 * @param options Layer-wide options (falloff, default radius, retention factor,
 *                passability check, `onProfile`).
 * @returns A lifecycle handle exposing source registry, update/reset, and
 *          a stable {@link InfluenceLayerView}.
 *
 * @example
 * ```ts
 * const grid = createSpatialGrid<number>({
 *   width: 64,
 *   height: 64,
 *   initializer: () => 0,
 * });
 * const threat = createInfluenceLayer(grid, {
 *   defaultRadius: 6,
 *   falloff: linearFalloff,
 *   // retentionFactor omitted → zero-fill each tick (default)
 * });
 *
 * threat.addSource({ id: unit.id, x: unit.tileX, y: unit.tileY, strength: 10 });
 *
 * // each game tick:
 * threat.update();
 *
 * // decision scoring:
 * const score = -threat.read().at(myUnit.tileX, myUnit.tileY);
 * ```
 */
export function createInfluenceLayer(
  grid: SpatialGrid<number>,
  options: InfluenceLayerOptions,
): InfluenceLayer {
  const {
    defaultRadius,
    falloff,
    retentionFactor = 0,
    respectPassability = false,
    onProfile,
  } = options;

  if (!Number.isFinite(defaultRadius) || defaultRadius <= 0) {
    throw new Error(
      `createInfluenceLayer: defaultRadius must be a positive finite number (got ${defaultRadius})`,
    );
  }

  const sources = new Map<string, InfluenceSource>();
  const handle = createEmitHandle<InfluenceLayerEvents>();
  const { width, height } = grid;

  // Whether the source stands on a grid cell; the grid admits integer coordinates only.
  function onCell(source: InfluenceSource): boolean {
    return grid.inBounds(source.x, source.y);
  }

  function checkSource(source: InfluenceSource): void {
    if (!Number.isFinite(source.strength)) {
      throw new Error(
        `InfluenceLayer.addSource: source "${source.id}" has non-finite strength (${source.strength})`,
      );
    }
    if (source.radius !== undefined && (!Number.isFinite(source.radius) || source.radius < 0)) {
      throw new Error(
        `InfluenceLayer.addSource: source "${source.id}" has invalid radius (${source.radius})`,
      );
    }
    if (!onCell(source)) {
      throw new RangeError(
        `InfluenceLayer.addSource: source "${source.id}" position (${source.x}, ${source.y}) is not an integer cell within bounds (${width}×${height})`,
      );
    }
  }

  const zeroFill = (): number => 0;
  const decayFill = (_x: number, _y: number, v: number): number => v * retentionFactor;

  function evaporate(): void {
    if (retentionFactor === 0) {
      grid.fill(zeroFill);
      return;
    }
    if (retentionFactor === 1) return;
    grid.fill(decayFill);
  }

  function accumulate(): number {
    let samples = 0;
    for (const source of sources.values()) {
      const r = source.radius ?? defaultRadius;
      if (r <= 0 || source.strength === 0) continue;
      // Positions are mutable by reference, so a source can have left the
      // board since addSource checked it; off the board it contributes nothing.
      if (!onCell(source)) continue;
      // forEachInRange walks a Chebyshev square; the falloff function
      // chooses how to collapse (dx, dy) into a scalar distance for its
      // metric.
      grid.forEachInRange(source.x, source.y, r, (cx, cy, idx) => {
        if (respectPassability && grid.passable[idx] === 0) return;
        const dx = cx - source.x;
        const dy = cy - source.y;
        const contribution = source.strength * falloff(dx, dy, r);
        samples++;
        if (contribution === 0) return;
        grid.setSilent(cx, cy, grid.cells[idx] + contribution);
      });
    }
    return samples;
  }

  function makeView(): InfluenceLayerView {
    return {
      at(x, y) {
        const v = grid.tryAt(x, y);
        return v === undefined ? 0 : v;
      },
      sum(x, y, radius) {
        if (!grid.inBounds(x, y)) return 0;
        let total = 0;
        for (const cell of grid.inRange(x, y, radius)) {
          total += grid.cells[cell.y * width + cell.x];
        }
        return total;
      },
      peak(x, y, radius) {
        if (!grid.inBounds(x, y)) return null;
        let bestX = -1;
        let bestY = -1;
        let bestValue = -Infinity;
        for (const cell of grid.inRange(x, y, radius)) {
          const v = grid.cells[cell.y * width + cell.x];
          if (v > bestValue) {
            bestValue = v;
            bestX = cell.x;
            bestY = cell.y;
          }
        }
        if (bestX < 0) return null;
        return { x: bestX, y: bestY, value: bestValue };
      },
      inBounds(x, y) {
        return grid.inBounds(x, y);
      },
      *cells() {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            yield [x, y, grid.cells[y * width + x]] as [number, number, number];
          }
        }
      },
    };
  }

  const reader = makeView();

  return {
    grid,
    read() {
      return reader;
    },

    addSource(source) {
      if (sources.has(source.id)) {
        throw new Error(`InfluenceLayer.addSource: duplicate source id "${source.id}"`);
      }
      checkSource(source);
      sources.set(source.id, source);
      return source;
    },

    removeSource(id) {
      return sources.delete(id);
    },

    getSource(id) {
      return sources.get(id);
    },

    update() {
      evaporate();
      const samples = accumulate();
      onProfile?.(samples);
      handle.emit('updated');
    },

    reset() {
      grid.fill(zeroFill);
      handle.emit('updated');
    },

    on(event, handler) {
      return handle.on(event, handler);
    },
  };
}

// === COMPOSEINFLUENCELAYERS ===
/**
 * Combine multiple influence-layer views into a derived view. The
 * `combine` function receives per-cell values (one per input view, in
 * input order) and returns the composed value for that cell.
 *
 * No caching — each call to `at` / `sum` / `peak` re-reads from each
 * underlying view. This is intentional: composition is cheap and
 * staleness is impossible.
 *
 * `cells()` iterates the *first* view's cell set, applying `combine` per
 * cell. Composed layers are expected to share a grid, making this safe.
 *
 * @example
 * ```ts
 * // Stratified per-unit-class threat layers, queried
 * // via a single composed "total threat" view.
 * const total = composeInfluenceLayers(
 *   [airThreat.read(), surfThreat.read(), amphThreat.read()],
 *   (values) => values.reduce((a, b) => a + b, 0),
 * );
 * const score = total.at(target.x, target.y);
 * ```
 */
export function composeInfluenceLayers(
  views: readonly InfluenceLayerView[],
  combine: (values: readonly number[], x: number, y: number) => number,
): InfluenceLayerView {
  if (views.length === 0) {
    throw new Error('composeInfluenceLayers: views array must not be empty');
  }
  const buf = new Array<number>(views.length);

  function combinedAt(x: number, y: number): number {
    for (let i = 0; i < views.length; i++) {
      buf[i] = views[i].at(x, y);
    }
    return combine(buf, x, y);
  }

  // The Chebyshev walk under sum() and peak(), matching the single-layer
  // contract: an out-of-bounds center visits nothing (so 0 / null), and only
  // in-bounds cells are visited. An out-of-bounds coordinate reads a
  // fabricated 0 from each layer, which a combine need not map to 0, so
  // visiting it would skew the result.
  function forEachInBox(
    x: number,
    y: number,
    radius: number,
    fn: (cx: number, cy: number, value: number) => void,
  ): void {
    if (!views[0].inBounds(x, y)) return;
    const r = Math.max(0, Math.floor(radius));
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = x + dx;
        const cy = y + dy;
        if (views[0].inBounds(cx, cy)) fn(cx, cy, combinedAt(cx, cy));
      }
    }
  }

  return {
    at: combinedAt,
    sum(x, y, radius) {
      let total = 0;
      forEachInBox(x, y, radius, (_cx, _cy, v) => {
        total += v;
      });
      return total;
    },
    peak(x, y, radius) {
      let bestX = -Infinity;
      let bestY = -Infinity;
      let bestValue = -Infinity;
      let any = false;
      forEachInBox(x, y, radius, (cx, cy, v) => {
        if (!any || v > bestValue) {
          bestX = cx;
          bestY = cy;
          bestValue = v;
          any = true;
        }
      });
      if (!any) return null;
      return { x: bestX, y: bestY, value: bestValue };
    },
    inBounds(x, y) {
      return views[0].inBounds(x, y);
    },
    *cells() {
      for (const [x, y] of views[0].cells()) {
        yield [x, y, combinedAt(x, y)] as [number, number, number];
      }
    },
  };
}
