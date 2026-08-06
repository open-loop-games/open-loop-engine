/**
 * Shared types for the spatial primitive family.
 *
 * @cluster spatial-grid
 *
 * Lives at the root of `core/spatial/` so sibling primitives (grid, graph,
 * scope-stack) can reuse `GridCoord`, `Unsubscribe`, and predicate shapes
 * without each defining its own.
 */

/** A 2D integer coordinate. */
export interface GridCoord {
  readonly x: number;
  readonly y: number;
}

/**
 * A 2D integer offset from a cell to one of its neighbors. Structurally a
 * {@link GridCoord} but semantically relative — a set of these is what a
 * `SpatialGrid` uses as its adjacency, so the distinction is what keeps an
 * absolute coordinate from being passed where an offset belongs.
 */
export interface GridDelta {
  readonly dx: number;
  readonly dy: number;
}

/** Function returned by event subscriptions; call to detach the handler. */
export type Unsubscribe = () => void;

/**
 * Caller-supplied passability test for grid traversal queries (BFS, flood).
 * Receives the cell value and its coordinates; returns true if traversal
 * may pass through.
 */
export type PassabilityFn<T> = (cell: T, x: number, y: number) => boolean;

/**
 * Caller-supplied cost to *enter* a cell, for weighted traversal queries
 * (`distanceField`). Receives the cell value and its coordinates; returns the
 * cost of stepping into it, or `Infinity` for impassable — the passability
 * gate folds into the weight rather than riding a second predicate.
 *
 * Cost is per entered cell, not per step, so every delta in the grid's
 * `neighborhood` costs the same regardless of its length — 8-connected
 * adjacency yields a Chebyshev metric, hex adjacency a hex metric. Games that
 * need step length to matter (a true Euclidean metric, say) scale the cost
 * themselves; the coordinates handed in are the entered cell's.
 */
export type TraversalCostFn<T> = (cell: T, x: number, y: number) => number;
