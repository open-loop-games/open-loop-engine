# Spatial

Coordinate-based primitives. Grid, graph, scope stack, influence layer. Used by board-state and adjacency-driven games — hex maps, dungeon layouts, factory grids. Headless: no rendering, just adjacency and traversal.

## Canonical entrypoints

Start with these public symbols before scanning the full inventory below.

- `createSpatialGrid` — bounded coordinate boards with adjacency, BFS, FOV adapter, and snapshots.
- `createSpatialGraph` — arbitrary node/edge topology with nested child graphs.
- `createScopeStack` — active-scope navigation over recursive graphs.
- `createInfluenceLayer` — propagation/decay over a numeric grid.

## Grid

Bounded 2D grid with adjacency, BFS, FOV adapter, and snapshot persistence. Shared coordinate types (`GridCoord`, `PassabilityFn`, `Unsubscribe`) sit here.

- `function createSpatialGrid<T>(options: SpatialGridOptions<T>): SpatialGrid<T>` — Create a bounded 2D grid sized `width × height`, populated by calling `initializer(x, y)` for every cell. `src/core/spatial/grid.ts:212`
- `interface FovUpdateHandle` — Handle returned by SpatialGrid.beginFovUpdate. `src/core/spatial/grid.ts:77`
- `interface GridCoord` — A 2D integer coordinate. `src/core/spatial/types.ts:12`
- `type PassabilityFn<T> = (cell: T, x: number, y: number) => boolean` — Caller-supplied passability test for grid traversal queries (BFS, flood). `src/core/spatial/types.ts:25`
- `interface SpatialGrid<T>` — Bounded 2D grid with adjacency, BFS, FOV adapter, and snapshot persistence. `src/core/spatial/grid.ts:85`
- `interface SpatialGridEvents<T>` — Events emitted by a SpatialGrid. `src/core/spatial/grid.ts:42`
- `interface SpatialGridOptions<T>` — Options accepted by createSpatialGrid. `src/core/spatial/grid.ts:27`
- `interface SpatialGridSnapshot<T>` — Plain-object snapshot of a grid's full state. `src/core/spatial/grid.ts:61`
- `type Unsubscribe = () => void` — Function returned by event subscriptions; call to detach the handler. `src/core/spatial/types.ts:18`

## Graph

Keyed node/edge container with nested child-graph composition — the substrate `ScopeStack` walks.

- `function createSpatialGraph<N, E>(options?: SpatialGraphOptions): SpatialGraph<N, E>` — Create a keyed graph container with nested child-graph support. `src/core/spatial/graph.ts:212`
- `interface GraphEdge<E>` — An edge in a SpatialGraph. `src/core/spatial/graph.ts:48`
- `interface GraphNode<N>` — A node in a SpatialGraph. `src/core/spatial/graph.ts:41`
- `interface SpatialGraph<N, E>` — Keyed node/edge container with nested child-graph composition. `src/core/spatial/graph.ts:91`
- `interface SpatialGraphEvents<N, E>` — Events emitted by a SpatialGraph. `src/core/spatial/graph.ts:67`
- `interface SpatialGraphOptions` — Options accepted by createSpatialGraph. `src/core/spatial/graph.ts:56`
- `interface SpatialGraphSnapshot<N, E>` — Plain-object snapshot of a graph's full state, including recursively any child graphs. `src/core/spatial/graph.ts:82`

## Scope stack

Stack navigator over a recursive `SpatialGraph` — tracks which nested child graph is currently active.

- `function createScopeStack<N, E>(options: ScopeStackOptions<N, E>): ScopeStack<N, E>` — Create a stack navigator over a `SpatialGraph`'s recursive child-graph tree. `src/core/spatial/scope-stack.ts:178`
- `interface ScopeStack<N, E>` — Navigation cursor over a recursive graph-of-graphs. `src/core/spatial/scope-stack.ts:95`
- `interface ScopeStackEvents` — Events emitted by a ScopeStack. `src/core/spatial/scope-stack.ts:88`
- `interface ScopeStackOptions<N, E>` — Options accepted by createScopeStack. `src/core/spatial/scope-stack.ts:64`
- `interface ScopeStackSnapshot` — Plain-object snapshot of the stack's navigation state. `src/core/spatial/scope-stack.ts:82`
- `type ScopeState = 'pristine' | 'unstable' | 'stable' | string` — Caller-owned scope-state label. `src/core/spatial/scope-stack.ts:61`

## Influence layer

Utility-function layer over `SpatialGrid<number>` — the per-frame propagation/decay lifecycle that turns a numeric grid into an influence map.

- `function composeInfluenceLayers(readers: readonly InfluenceLayerReader[], combine: (values: readonly number[], x: number, y: number) => number): InfluenceLayerReader` — Combine multiple influence-layer readers into a derived reader. `src/core/spatial/influence-layer.ts:447`
- `function createInfluenceLayer(grid: SpatialGrid<number>, options: InfluenceLayerOptions): InfluenceLayer` — Wrap a `SpatialGrid<number>` with an influence-map lifecycle. `src/core/spatial/influence-layer.ts:261`
- `const exponentialFalloff: FalloffFunction` — Exponential falloff `exp(-d/r)`, Euclidean `d`. `src/core/spatial/influence-layer.ts:223`
- `type FalloffFunction = (dx: number, dy: number, radius: number) => number` — Falloff curve applied per cell during accumulation. `src/core/spatial/influence-layer.ts:94`
- `const gaussianFalloff: FalloffFunction` — Gaussian falloff `exp(-(d/r)^2 * 2)`, Euclidean `d`. `src/core/spatial/influence-layer.ts:216`
- `interface InfluenceLayer` — Lifecycle handle for an influence layer. `src/core/spatial/influence-layer.ts:163`
- `interface InfluenceLayerOptions` — Options accepted by createInfluenceLayer. `src/core/spatial/influence-layer.ts:97`
- `interface InfluenceLayerReader` — Read-only view over an influence layer's grid. `src/core/spatial/influence-layer.ts:139`
- `interface InfluenceSource` — A point source contributing influence to the layer. `src/core/spatial/influence-layer.ts:51`
- `const linearFalloff: FalloffFunction` — Linear falloff `(1 - d/r)`, clamped to `[0, 1]`, Euclidean `d`. `src/core/spatial/influence-layer.ts:209`
