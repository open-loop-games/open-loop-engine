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

/** Function returned by event subscriptions; call to detach the handler. */
export type Unsubscribe = () => void;

/**
 * Caller-supplied passability test for grid traversal queries (BFS, flood).
 * Receives the cell value and its coordinates; returns true if traversal
 * may pass through.
 */
export type PassabilityFn<T> = (cell: T, x: number, y: number) => boolean;
