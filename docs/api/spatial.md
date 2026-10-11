# Spatial

Coordinate primitives for adjacency-driven games: grid, graph, scope stack and influence layer. Headless: adjacency and traversal, no rendering. Rank influence through advisors.md to steer a unit.

## Canonical entrypoints

- `createSpatialGrid` — bounded coordinate grids with adjacency, BFS, FOV updates and a serialized form.
- `createGraph` — arbitrary node/edge topology with nested child graphs.
- `createScopeStack` — track the graph scope entered in a nested graph.
- `createInfluenceLayer` — propagation and decay over a numeric grid.

## Grid

Bounded 2D grid with FOV updates and a serialized form. Rectangular storage, configurable neighborhood: the `neighborhood` offset set makes 4-connected, 8-connected and hex-at-axial-offset the same container. Every traversal verb follows it. Two traversal queries split by use: `bfs()` for reachability and parent links, `distanceField()` for weighted multi-source routing distance. The shared coordinate types (`GridCoord`, `GridOffset`, `PassabilityFn`, `TraversalCostFn`, `Unsubscribe`) are here.

- `function createSpatialGrid<T>(options: SpatialGridOptions<T>): SpatialGrid<T>` — Create a bounded 2D grid sized `width × height`, populated by calling `initializer(x, y)` for every cell. `src/core/spatial/grid.ts:414`
- `const DIAGONAL_DELTAS: readonly GridOffset[]` — 8-connected adjacency: the four orthogonals plus the four diagonals. `src/core/spatial/grid.ts:72`
- `interface FovUpdateHandle` — Handle returned by SpatialGrid.beginFovUpdate. `src/core/spatial/grid.ts:156`
- `interface GridCoord` — A 2D integer coordinate. `src/core/spatial/types.ts:12`
- `interface GridOffset` — A 2D integer offset from a cell to one of its neighbors. `src/core/spatial/types.ts:23`
- `const HEX_AXIAL_DELTAS: readonly GridOffset[]` — 6-connected hex adjacency, clockwise from east, for a hex board stored at an axial offset. `src/core/spatial/grid.ts:95`
- `const ORTHOGONAL_DELTAS: readonly GridOffset[]` — 4-connected orthogonal adjacency: E, W, N, S. `src/core/spatial/grid.ts:64`
- `type PassabilityFn<T> = (cell: T, x: number, y: number) => boolean` — Caller-supplied passability test for grid traversal queries (BFS, flood). `src/core/spatial/types.ts:36`
- `interface SerializedSpatialGrid<T>` — Serialized form of a grid's full state. `src/core/spatial/grid.ts:134`
- `interface SpatialGrid<T>` — Bounded 2D grid with configurable adjacency, BFS and weighted distance fields, an FOV commit handle, and persistence through a serialized form. `src/core/spatial/grid.ts:167`
- `interface SpatialGridEvents<T>` — Events emitted by a SpatialGrid. `src/core/spatial/grid.ts:105`
- `interface SpatialGridOptions<T>` — Options accepted by createSpatialGrid. `src/core/spatial/grid.ts:41`
- `type TraversalCostFn<T> = (cell: T, x: number, y: number) => number` — Caller-supplied cost to *enter* a cell, for weighted traversal queries (`distanceField`). `src/core/spatial/types.ts:52`
- `type Unsubscribe = () => void` — Function returned by event subscriptions; call it to unsubscribe the handler. `src/core/spatial/types.ts:29`

## Graph

Keyed node/edge container with nested child-graph composition — the substrate `ScopeStack` walks.

- `function createGraph<N, E>(options?: GraphOptions): Graph<N, E>` — Create a keyed graph container with nested child-graph support. `src/core/spatial/graph.ts:223`
- `interface Graph<N, E>` — Keyed node/edge container with nested child-graph composition. `src/core/spatial/graph.ts:95`
- `interface GraphEdge<E>` — An edge in a Graph. `src/core/spatial/graph.ts:48`
- `interface GraphEvents<N, E>` — Events emitted by a Graph. `src/core/spatial/graph.ts:71`
- `interface GraphNode<N>` — A node in a Graph. `src/core/spatial/graph.ts:41`
- `interface GraphOptions` — Options accepted by createGraph. `src/core/spatial/graph.ts:56`
- `interface SerializedGraph<N, E>` — Serialized form of a graph's full state, child graphs included recursively. `src/core/spatial/graph.ts:86`

## Scope stack

Stack navigator over a recursive `Graph` — tracks the graph scope it has entered.

- `function createScopeStack<N, E>(options: ScopeStackOptions<N, E>): ScopeStack<N, E>` — Create a stack navigator over a `Graph`'s recursive child-graph tree. `src/core/spatial/scope-stack.ts:188`
- `interface ScopeStack<N, E>` — Navigation cursor over a recursive graph-of-graphs. `src/core/spatial/scope-stack.ts:98`
- `interface ScopeStackEvents` — Events emitted by a ScopeStack. `src/core/spatial/scope-stack.ts:91`
- `interface ScopeStackOptions<N, E>` — Options accepted by createScopeStack. `src/core/spatial/scope-stack.ts:67`
- `type ScopeStatus = string` — Caller-owned scope status. `src/core/spatial/scope-stack.ts:64`
- `interface SerializedScopeStack` — Serialized form of the stack's navigation state. `src/core/spatial/scope-stack.ts:85`

## Influence layer

An influence layer over `SpatialGrid<number>` — the propagation and decay steps that turn a numeric grid into per-cell influence.

- `function composeInfluenceLayers(views: readonly InfluenceLayerView[], combine: (values: readonly number[], x: number, y: number) => number): InfluenceLayerView` — Combine multiple influence-layer views into a derived view. `src/core/spatial/influence-layer.ts:481`
- `function createInfluenceLayer(grid: SpatialGrid<number>, options: InfluenceLayerOptions): InfluenceLayer` — Build an influence layer over a `SpatialGrid<number>`. `src/core/spatial/influence-layer.ts:290`
- `const exponentialFalloff: FalloffFunction` — Exponential falloff `exp(-d/r)`, Euclidean `d`. `src/core/spatial/influence-layer.ts:252`
- `type FalloffFunction = (dx: number, dy: number, radius: number) => number` — Falloff function applied per cell during accumulation. `src/core/spatial/influence-layer.ts:100`
- `const gaussianFalloff: FalloffFunction` — Gaussian falloff `exp(-(d/r)^2 * 2)`, Euclidean `d`. `src/core/spatial/influence-layer.ts:245`
- `interface InfluenceLayer` — Lifecycle handle for an influence layer. `src/core/spatial/influence-layer.ts:188`
- `interface InfluenceLayerOptions` — Options accepted by createInfluenceLayer. `src/core/spatial/influence-layer.ts:103`
- `interface InfluenceLayerView` — Read-only view over an influence layer's grid. `src/core/spatial/influence-layer.ts:146`
- `interface InfluenceSource` — An influence source: a point that adds influence to the layer. `src/core/spatial/influence-layer.ts:56`
- `const linearFalloff: FalloffFunction` — Linear falloff `(1 - d/r)`, clamped to `[0, 1]`, Euclidean `d`. `src/core/spatial/influence-layer.ts:238`
