/**
 * InfluenceLayer — utility-function layer over `SpatialGrid<number>`.
 *
 * @cluster spatial-influence-layer
 *
 * Adds the per-frame propagation/decay lifecycle that turns a numeric grid
 * into a working "influence map" without introducing a new storage primitive.
 * The cell values live in the caller-supplied `SpatialGrid<number>`; the
 * layer owns only the source registry and the update loop. Persistence is
 * delegated to the grid; the source registry is session-lived and
 * re-registered at game start from the consumer's authoritative entity list.
 *
 * Field shape: BWAPI bots, 0 A.D., OpenRA, Spring AIs, CircuitAI's
 * `CThreatMap` 5-layer stratified threat. Cross-axis use (decision scoring
 * + spatial classification + opponent density) consumes a single layer's
 * `read()` reader so all three axes share one storage substrate.
 *
 * Distance metric: chosen by the falloff function. Accumulation iterates
 * the grid's Chebyshev `inRange` (square bounding box) and hands each cell's
 * `(dx, dy, radius)` to the falloff — the falloff decides how to collapse
 * the coordinate delta into a scalar. Built-in falloffs are Euclidean
 * (`Math.hypot(dx, dy)`); custom falloffs are free to pick Chebyshev
 * (`Math.max(|dx|, |dy|)`), Manhattan (`|dx| + |dy|`), or hex-axial
 * (`(|dx| + |dy| + |dx + dy|) / 2`). Built-ins clamp or asymptote past
 * `radius`; custom falloffs are responsible for their own cutoff.
 *
 * Update order: evaporate → accumulate. `decay` is the *retention* factor
 * (1.0 = no decay; 0.95 = lose 5% per tick; 0 / undefined = full reset).
 * Full reset is the default — cheapest and fully reactive to source
 * movement, matching the most common field shape.
 *
 * Bulk-write fallback: until `SpatialGrid<T>.fill(mapper)` lands, `reset()`
 * and the evaporation pass write per-cell via `grid.set()` and emit one
 * `cellChanged` per cell. Documented event-storm risk on large grids;
 * switches to the batched form internally once `grid.fill` is available.
 *
 * Diagnostics: throws on illegal ops (duplicate source id, NaN strength,
 * out-of-bounds source coords) so misuse surfaces synchronously.
 */

import type { SpatialGrid } from './grid';

/**
 * A point source contributing influence to the layer.
 *
 * Held by reference: callers may mutate `x`, `y`, `strength`, or `radius`
 * directly between frames and the next `update()` will use the current
 * values. Source identity is the caller-assigned `id` — re-using an id
 * across `addSource` calls throws.
 */
export interface InfluenceSource {
  /** Stable identifier for source removal/lookup. */
  id: string;
  /** Grid coordinate of the source. Mutable by reference. */
  x: number;
  y: number;
  /** Source strength at origin; falls off via the configured falloff function. */
  strength: number;
  /**
   * Per-source radius cap (Euclidean) override. Sources stop contributing
   * past it. Omit to use the layer's `defaultRadius`.
   */
  radius?: number;
}

/**
 * Falloff curve applied per cell during accumulation.
 *
 * Receives the cell-to-source coordinate delta (`dx`, `dy`) and the source's
 * effective radius (per-source override or `defaultRadius`). Returns a
 * scalar multiplier applied to the source's `strength`. The falloff owns
 * the choice of distance metric — collapse `(dx, dy)` to whatever scalar
 * fits the grid topology:
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
 * @example Chebyshev lookup table for a roguelike danger map
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
   * Falloff curve. Built-ins: {@link linearFalloff}, {@link gaussianFalloff},
   * {@link exponentialFalloff} (all Euclidean). Custom curves are plain
   * `(dx, dy, radius) => number` functions and may use any distance metric —
   * see {@link FalloffFunction} for Chebyshev / Manhattan / hex examples.
   */
  falloff: FalloffFunction;
  /**
   * Per-tick retention multiplier applied before accumulation.
   * - `1.0` — no decay; sources accumulate on top of prior-tick values.
   * - `0.95` — lose 5% per tick (partial evaporation).
   * - `0` or omitted — zero-fill each tick (full reset; cheapest, fully
   *   reactive to source movement). This is the most common field shape.
   */
  decay?: number;
  /**
   * When true, accumulation skips cells where `grid.passable[idx] === 0`.
   * Default false — RTS threat maps typically allow walls to receive
   * threat values so units can score "inside the firing arc but behind
   * cover" positions.
   *
   * Caller must populate `grid.passable` before the first `update()`;
   * otherwise this gate excludes every cell.
   */
  respectPassability?: boolean;
  /**
   * Fired once per `update()` with the count of cells touched during
   * accumulation. Hook into a profiler to track influence-map cost on
   * large maps. No per-cell overhead.
   */
  profileHook?: (samples: number) => void;
}

/**
 * Read-only view over an influence layer's grid. Decision systems pass
 * the reader to consumers that should not mutate sources or trigger
 * updates. {@link composeInfluenceLayers} also returns a reader, so a
 * composed multi-layer query is interchangeable with a single-layer one.
 */
export interface InfluenceLayerReader {
  /** Sample influence at a point. Returns 0 if out of bounds. */
  at(x: number, y: number): number;
  /**
   * Sum influence over a Chebyshev region centered at `(x, y)` with the
   * given radius. Out-of-bounds cells contribute 0. Composed readers walk
   * the same Chebyshev box; bounds are inferred from `at()` returning 0.
   */
  sum(x: number, y: number, radius: number): number;
  /**
   * Find the cell within a Chebyshev `radius` of `(x, y)` with the highest
   * influence. Ties broken by iteration order. Returns `null` only if no
   * cells fall in range (e.g. center far outside the grid).
   */
  peak(x: number, y: number, radius: number): { x: number; y: number; value: number } | null;
  /**
   * Whether `(x, y)` falls within the reader's domain. Composed readers defer
   * to their first underlying reader (all are assumed to share a grid, as
   * `cells()` also relies on). Lets `peak()` honour its in-bounds/null contract
   * without every consumer re-deriving grid dimensions.
   */
  inBounds(x: number, y: number): boolean;
  /**
   * Iterate the underlying grid's cells as `[x, y, value]` triples in
   * row-major order. Composed readers iterate the first underlying
   * reader's cell set, applying the combine function per cell.
   */
  cells(): Iterable<[number, number, number]>;
}

/** Lifecycle handle for an influence layer. */
export interface InfluenceLayer {
  /**
   * The underlying numeric grid the layer reads and writes through.
   * Exposed so reactive wrappers (e.g. `useInfluenceLayer`) can subscribe
   * to `cellChanged` events and so tight-loop consumers can read raw
   * cells without per-call bounds checks.
   */
  readonly grid: SpatialGrid<number>;

  /** Returns a stable read-only view over the layer. */
  read(): InfluenceLayerReader;

  // Source registry --------------------------------------------------------

  /**
   * Register a source. The returned reference is the same object the
   * caller passed in — mutating its `x`/`y`/`strength`/`radius` between
   * frames is the supported update path. Throws on duplicate id, NaN
   * strength, or out-of-bounds coords.
   */
  addSource(source: InfluenceSource): InfluenceSource;
  /** Remove a source by id. Returns true if a source was removed. */
  removeSource(id: string): boolean;
  /** Retrieve a source by id, or undefined if not registered. */
  getSource(id: string): InfluenceSource | undefined;

  // Lifecycle --------------------------------------------------------------

  /**
   * One propagation pass: evaporate (multiply by `decay`, or zero-fill if
   * `decay` is 0/undefined) → accumulate from each registered source.
   * Caller drives the tick; the layer has no internal timer.
   */
  update(): void;
  /**
   * Set every cell to zero without running accumulation. Useful on map
   * load or round reset. Per-cell writes until `grid.fill` lands.
   */
  reset(): void;
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
 * Wrap a `SpatialGrid<number>` with an influence-map lifecycle.
 *
 * @param grid Caller-owned numeric grid. The layer reads and writes via the
 *             grid's public API; persistence is the grid's concern.
 * @param options Layer-wide configuration (falloff, default radius, decay,
 *                passability gate, profile hook).
 * @returns A lifecycle handle exposing source registry, update/reset, and
 *          a stable {@link InfluenceLayerReader}.
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
 *   // decay omitted → full reset each tick (default)
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
  const { defaultRadius, falloff, decay, respectPassability = false, profileHook } = options;

  if (!Number.isFinite(defaultRadius) || defaultRadius <= 0) {
    throw new Error(
      `createInfluenceLayer: defaultRadius must be a positive finite number (got ${defaultRadius})`,
    );
  }

  const sources = new Map<string, InfluenceSource>();
  const { width, height } = grid;

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
    if (!grid.inBounds(source.x, source.y)) {
      throw new RangeError(
        `InfluenceLayer.addSource: source "${source.id}" position (${source.x}, ${source.y}) is out of bounds (${width}×${height})`,
      );
    }
  }

  // TODO(ergonomics): switch evaporation/reset to a single grid.fill(mapper)
  // once SpatialGrid<T>.fill exists — currently emits one cellChanged per
  // cell, the documented event-storm risk on large grids (256×256 = 65k
  // events/frame). API shape does not change when the switch happens.

  function evaporate(): void {
    if (!decay) {
      // decay === 0 or undefined → full reset
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          grid.set(x, y, 0);
        }
      }
      return;
    }
    if (decay === 1) return;
    const d = decay;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        grid.set(x, y, grid.cells[y * width + x] * d);
      }
    }
  }

  function accumulate(): number {
    let samples = 0;
    for (const source of sources.values()) {
      const r = source.radius ?? defaultRadius;
      if (r <= 0 || source.strength === 0) continue;
      // grid.inRange iterates a Chebyshev square; the falloff function
      // chooses how to collapse (dx, dy) into a scalar distance for its
      // metric. For source positions clamped via checkSource at
      // registration time the iteration is in-bounds.
      for (const cell of grid.inRange(source.x, source.y, r)) {
        const idx = cell.y * width + cell.x;
        if (respectPassability && grid.passable[idx] === 0) continue;
        const dx = cell.x - source.x;
        const dy = cell.y - source.y;
        const contribution = source.strength * falloff(dx, dy, r);
        samples++;
        if (contribution === 0) continue;
        grid.set(cell.x, cell.y, grid.cells[idx] + contribution);
      }
    }
    return samples;
  }

  function makeReader(): InfluenceLayerReader {
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

  const reader = makeReader();

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
      profileHook?.(samples);
    },

    reset() {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          grid.set(x, y, 0);
        }
      }
    },
  };
}

// === COMPOSEINFLUENCELAYERS ===
/**
 * Combine multiple influence-layer readers into a derived reader. The
 * `combine` function receives per-cell values (one per input reader, in
 * input order) and returns the composed value for that cell.
 *
 * No caching — each call to `at` / `sum` / `peak` re-reads from each
 * underlying reader. This is intentional: composition is cheap and
 * staleness is impossible.
 *
 * `cells()` iterates the *first* reader's cell set, applying `combine` per
 * cell. Composed layers are expected to share a grid in §B5-style use,
 * making this safe.
 *
 * @example
 * ```ts
 * // CThreatMap-style: stratified per-unit-class threat layers, queried
 * // via a single composed "total threat" reader.
 * const total = composeInfluenceLayers(
 *   [airThreat.read(), surfThreat.read(), amphThreat.read()],
 *   (values) => values.reduce((a, b) => a + b, 0),
 * );
 * const score = total.at(target.x, target.y);
 * ```
 */
export function composeInfluenceLayers(
  readers: readonly InfluenceLayerReader[],
  combine: (values: readonly number[], x: number, y: number) => number,
): InfluenceLayerReader {
  if (readers.length === 0) {
    throw new Error('composeInfluenceLayers: readers array must not be empty');
  }
  const buf = new Array<number>(readers.length);

  function combinedAt(x: number, y: number): number {
    for (let i = 0; i < readers.length; i++) {
      buf[i] = readers[i].at(x, y);
    }
    return combine(buf, x, y);
  }

  return {
    at: combinedAt,
    sum(x, y, radius) {
      const r = Math.max(0, Math.floor(radius));
      let total = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          total += combinedAt(x + dx, y + dy);
        }
      }
      return total;
    },
    peak(x, y, radius) {
      // Match the single-layer contract: null for an out-of-bounds center, and
      // only in-bounds cells considered — otherwise an out-of-bounds coordinate
      // (whose combined value is a fabricated 0) can win and be returned.
      if (!readers[0].inBounds(x, y)) return null;
      const r = Math.max(0, Math.floor(radius));
      let bestX = -Infinity;
      let bestY = -Infinity;
      let bestValue = -Infinity;
      let any = false;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const cx = x + dx;
          const cy = y + dy;
          if (!readers[0].inBounds(cx, cy)) continue;
          const v = combinedAt(cx, cy);
          if (!any || v > bestValue) {
            bestX = cx;
            bestY = cy;
            bestValue = v;
            any = true;
          }
        }
      }
      if (!any) return null;
      return { x: bestX, y: bestY, value: bestValue };
    },
    inBounds(x, y) {
      return readers[0].inBounds(x, y);
    },
    *cells() {
      for (const [x, y] of readers[0].cells()) {
        yield [x, y, combinedAt(x, y)] as [number, number, number];
      }
    },
  };
}
