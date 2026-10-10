# Spatial

Coordinate primitives for adjacency-driven games — grid, graph, scope stack, influence layer. Headless: adjacency and traversal, no rendering. Rank the fields through advisors.md to steer an agent.

## Canonical entrypoints

- `createSpatialGrid` — bounded coordinate boards with adjacency, BFS, FOV adapter, and snapshots.
- `createSpatialGraph` — arbitrary node/edge topology with nested child graphs.
- `createScopeStack` — active-scope navigation over recursive graphs.
- `createInfluenceLayer` — propagation/decay over a numeric grid.

## Grid

Bounded 2D grid with FOV adapter and snapshot persistence. Rectangular storage, configurable topology: the `neighborhood` delta set makes 4-connected, 8-connected, and hex-at-axial-offset the same container, and every traversal verb follows it. Two traversal queries split by use: `bfs()` for reachability and parent links, `distanceField()` for weighted multi-source routing distance. Shared coordinate types (`GridCoord`, `GridDelta`, `PassabilityFn`, `TraversalCostFn`, `Unsubscribe`) sit here.

- `function createSpatialGrid<T>(options: SpatialGridOptions<T>): SpatialGrid<T>` — Create a bounded 2D grid sized `width × height`, populated by calling `initializer(x, y)` for every cell. `src/core/spatial/grid.ts:412`
- `const DIAGONAL_DELTAS: readonly GridDelta[]` — 8-connected adjacency: the four orthogonals plus the four diagonals. `src/core/spatial/grid.ts:71`
- `interface FovUpdateHandle` — Handle returned by SpatialGrid.beginFovUpdate. `src/core/spatial/grid.ts:154`
- `interface GridCoord` — A 2D integer coordinate. `src/core/spatial/types.ts:12`
- `interface GridDelta` — A 2D integer offset from a cell to one of its neighbors. `src/core/spatial/types.ts:23`
- `const HEX_AXIAL_DELTAS: readonly GridDelta[]` — 6-connected hex adjacency, clockwise from east, for a hex board stored at an axial offset — axial `(q, r)` at grid `(q + radius, r + radius)`, which makes axial deltas equal grid deltas. `src/core/spatial/grid.ts:93`
- `const ORTHOGONAL_DELTAS: readonly GridDelta[]` — 4-connected orthogonal adjacency: E, W, N, S. `src/core/spatial/grid.ts:63`
- `type PassabilityFn<T> = (cell: T, x: number, y: number) => boolean` — Caller-supplied passability test for grid traversal queries (BFS, flood). `src/core/spatial/types.ts:36`
- `interface SpatialGrid<T>` — Bounded 2D grid with configurable adjacency, BFS and weighted distance fields, an FOV adapter, and snapshot persistence. `src/core/spatial/grid.ts:165`
- `interface SpatialGridEvents<T>` — Events emitted by a SpatialGrid. `src/core/spatial/grid.ts:103`
- `interface SpatialGridOptions<T>` — Options accepted by createSpatialGrid. `src/core/spatial/grid.ts:40`
- `interface SpatialGridSnapshot<T>` — Plain-object snapshot of a grid's full state. `src/core/spatial/grid.ts:132`
- `type TraversalCostFn<T> = (cell: T, x: number, y: number) => number` — Caller-supplied cost to *enter* a cell, for weighted traversal queries (`distanceField`). `src/core/spatial/types.ts:52`
- `type Unsubscribe = () => void` — Function returned by event subscriptions; call to detach the handler. `src/core/spatial/types.ts:29`

## Graph

Keyed node/edge container with nested child-graph composition — the substrate `ScopeStack` walks.

- `function createSpatialGraph<N, E>(options?: SpatialGraphOptions): SpatialGraph<N, E>` — Create a keyed graph container with nested child-graph support. `src/core/spatial/graph.ts:225`
- `interface GraphEdge<E>` — An edge in a SpatialGraph. `src/core/spatial/graph.ts:48`
- `interface GraphNode<N>` — A node in a SpatialGraph. `src/core/spatial/graph.ts:41`
- `interface SpatialGraph<N, E>` — Keyed node/edge container with nested child-graph composition. `src/core/spatial/graph.ts:95`
- `interface SpatialGraphEvents<N, E>` — Events emitted by a SpatialGraph. `src/core/spatial/graph.ts:71`
- `interface SpatialGraphOptions` — Options accepted by createSpatialGraph. `src/core/spatial/graph.ts:56`
- `interface SpatialGraphSnapshot<N, E>` — Plain-object snapshot of a graph's full state, including recursively any child graphs. `src/core/spatial/graph.ts:86`

## Scope stack

Stack navigator over a recursive `SpatialGraph` — tracks which nested child graph is currently active.

- `function createScopeStack<N, E>(options: ScopeStackOptions<N, E>): ScopeStack<N, E>` — Create a stack navigator over a `SpatialGraph`'s recursive child-graph tree. `src/core/spatial/scope-stack.ts:187`
- `interface ScopeStack<N, E>` — Navigation cursor over a recursive graph-of-graphs. `src/core/spatial/scope-stack.ts:98`
- `interface ScopeStackEvents` — Events emitted by a ScopeStack. `src/core/spatial/scope-stack.ts:91`
- `interface ScopeStackOptions<N, E>` — Options accepted by createScopeStack. `src/core/spatial/scope-stack.ts:67`
- `interface ScopeStackSnapshot` — Plain-object snapshot of the stack's navigation state. `src/core/spatial/scope-stack.ts:85`
- `type ScopeState = string` — Caller-owned scope-state label. `src/core/spatial/scope-stack.ts:64`

## Influence layer

Utility-function layer over `SpatialGrid<number>` — the per-frame propagation/decay lifecycle that turns a numeric grid into an influence map.

- `function composeInfluenceLayers(readers: readonly InfluenceLayerReader[], combine: (values: readonly number[], x: number, y: number) => number): InfluenceLayerReader` — Combine multiple influence-layer readers into a derived reader. `src/core/spatial/influence-layer.ts:480`
- `function createInfluenceLayer(grid: SpatialGrid<number>, options: InfluenceLayerOptions): InfluenceLayer` — Wrap a `SpatialGrid<number>` with an influence-map lifecycle. `src/core/spatial/influence-layer.ts:288`
- `const exponentialFalloff: FalloffFunction` — Exponential falloff `exp(-d/r)`, Euclidean `d`. `src/core/spatial/influence-layer.ts:250`
- `type FalloffFunction = (dx: number, dy: number, radius: number) => number` — Falloff curve applied per cell during accumulation. `src/core/spatial/influence-layer.ts:99`
- `const gaussianFalloff: FalloffFunction` — Gaussian falloff `exp(-(d/r)^2 * 2)`, Euclidean `d`. `src/core/spatial/influence-layer.ts:243`
- `interface InfluenceLayer` — Lifecycle handle for an influence layer. `src/core/spatial/influence-layer.ts:186`
- `interface InfluenceLayerOptions` — Options accepted by createInfluenceLayer. `src/core/spatial/influence-layer.ts:102`
- `interface InfluenceLayerReader` — Read-only view over an influence layer's grid. `src/core/spatial/influence-layer.ts:144`
- `interface InfluenceSource` — A point source contributing influence to the layer. `src/core/spatial/influence-layer.ts:56`
- `const linearFalloff: FalloffFunction` — Linear falloff `(1 - d/r)`, clamped to `[0, 1]`, Euclidean `d`. `src/core/spatial/influence-layer.ts:236`
