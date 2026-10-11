/**
 * Shared types for the spatial primitive family.
 *
 * @cluster spatial-grid
 *
 * Is at the root of `core/spatial/` so sibling primitives (grid, graph,
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
 * {@link GridCoord} but semantically relative. A set of these is a
 * `SpatialGrid`'s neighborhood, and the distinction keeps an absolute
 * coordinate from being passed where an offset belongs.
 */
export interface GridOffset {
  readonly dx: number;
  readonly dy: number;
}

/** Function returned by event subscriptions; call it to unsubscribe the handler. */
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
 * cost of stepping into it, or `Infinity` for impassable. Passability is
 * part of the weight, not a second predicate. Costs are ≥ 0: a bonus
 * terrain is a cost below the base, never below zero, since a negative
 * cost has no shortest path.
 *
 * Cost is per entered cell, not per step. So every offset in the grid's
 * `neighborhood` costs the same regardless of its length. 8-connected
 * adjacency yields a Chebyshev metric, and hex adjacency a hex metric. Games that
 * need step length to matter (a true Euclidean metric, say) scale the cost
 * themselves; the coordinates handed in are the entered cell's.
 */
export type TraversalCostFn<T> = (cell: T, x: number, y: number) => number;
