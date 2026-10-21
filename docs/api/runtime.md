# Runtime

How an engine instance is assembled and ticks: `createEngine` and its module, event and save wiring. Also TickDriver (variable and fixed tick modes), the typed event emitter, throttle, play time, transition-distance math and the game-state accessor.

## Canonical entrypoints

- `createEngine` — assemble modules, TickDriver, persistence, events, registries, and mods.
- `EngineModule` / `EngineContext` — install/connect game content and share engine services.
- `createTickDriver` — standalone tick scheduler when not using the full engine facade.
- `createEmitHandle` — typed per-instance events for systems and categories.
- `timeUntilResource` / `timeUntilGateFlip` / `timeUntilAffordable` — transition-distance math for previews and walkers.
- `createGameStateAccessor` — an accessor over the resource registry plus your flags, state paths and rates; pass it to `createEngine({ accessor })`.
- `ref` / `computed` / `watch` / `effect` — Vue's reactivity API, re-exported. Import it from the engine, not from `vue`, so subscriptions share the engine's `activeEffect`.

## Engine assembly

the module-system façade that composes core + systems into a runnable game: _createEngine_, _EngineContext_, _EngineModule_, _EngineOptions_, and the built-in injection keys

- `function createEngine(options: EngineOptions): Engine` — Creates the top-level engine orchestrator that wires together the TickDriver, save manager, module system, and mod support. `src/engine.ts:469`
- `interface Engine` — The assembled engine instance returned by createEngine. `src/engine.ts:334`
- `interface EngineContext` — The engine context: the object each EngineModule's `install` and `connect` receive. `src/engine.ts:127`
- `interface EngineEvents` — Engine-wide event map — extend via declaration merging to add game events. `src/engine.ts:105`
- `interface EngineModule` — A registerable unit of game content. `src/engine.ts:191`
- `interface EngineOptions` `src/engine.ts:234`
- `type LoadHandler = (result: SaveLoadResult) => void` — A handler called after a save loads successfully, by any entry point. `src/engine.ts:83`
- `interface ModDef` — A mod: a whole-game ruleset the player selects when a new game starts, with its metadata and its modules. `src/engine.ts:213`
- `type SaveHandler = () => void` — A handler called before live state is serialized, so it can write derived state into persistent refs. `src/engine.ts:71`
- `const SaveManagerKey: InjectionKey<SaveManager>` — Inject the save manager. `src/engine.ts:114`
- `const TickDriverKey: InjectionKey<TickDriver>` — Inject the TickDriver instance. `src/engine.ts:111`

## Reactivity re-exports

Vue's reactivity API, re-exported by the engine. Import these from `@open-loop/engine`, not from `vue`. A separately resolved `vue` does not subscribe to engine refs, so updates are missed silently. Signatures and semantics are Vue's own; read them in Vue's docs.

`computed` · `ComputedRef` · `effect` · `effectScope` · `EffectScope` · `isRef` · `onScopeDispose` · `reactive` · `ref` · `Ref` · `shallowRef` · `ShallowRef` · `triggerRef` · `unref` · `watch` · `watchEffect` · `WatchStopHandle` · `WritableComputedRef`

## Events

Typed per-instance event emitter primitive

- `function createEmitHandle<E>(options?: EmitHandleOptions): EmitHandle<E>` — Create a typed event handle for use inside a factory closure. `src/core/events.ts:60`
- `interface EmitHandle<E>` — Internal event interface held inside factory closures — subscribe and emit. `src/core/events.ts:25`
- `interface EmitHandleOptions` `src/core/events.ts:39`
- `interface Emittable<E>` — Public event interface exposed on system instances — subscribe only, emit is internal. `src/core/events.ts:19`

## TickDriver

the game loop: timer-driven ticks with EWMA lag compensation. Two tick modes: variable (the default and the genre standard) and a fixed-dt accumulator (opt-in, for faithful ports of tick math that clamps on overshoot)

- `function createTickDriver(options?: TickDriverOptions): TickDriver` — Creates the game loop: a TickDriver with EWMA lag compensation, game speed, tick phases, and a variable-dt (default) or fixed-dt tick mode. `src/core/tick-driver.ts:271`
- `interface PhaseHandlers` — Handlers for a tick phase, registered with `tickDriver.registerPhase()`. `src/core/tick-driver.ts:138`
- `interface TickDriver` — The TickDriver returned by createTickDriver. `src/core/tick-driver.ts:157`
- `interface TickDriverOptions` `src/core/tick-driver.ts:67`
- `type TickHandler = (dt: number) => void` — A tick handler for `tickDriver.onTick`. `src/core/tick-driver.ts:149`
- `interface TimerProvider` — Timer functions for scheduling. `src/core/tick-driver.ts:57`

## Game-state accessor

the opt-in builder over the resource registry, the record of the methods an accessor implements, and the ambient accessor `createEngine` sets around `install()` / `connect()`

- `const AccessorMethods: unique symbol` — Keys the record of the methods an accessor implements, a `ReadonlySet<GameStateAccessorMethod>`. `src/core/game-state-accessor.ts:46`
- `interface AccessorServices` — The engine services an accessor factory receives from `createEngine`. `src/core/game-state-accessor.ts:62`
- `function createGameStateAccessor(services: AccessorServices, options?: GameStateAccessorOptions): GameStateAccessorMutator` — Build a game-state accessor and mutator over the engine's resource registry. `src/core/game-state-accessor.ts:182`
- `const GameStateAccessorKey: InjectionKey<GameStateAccessorMutator>` — Injection key for the accessor `createEngine` was given or built. `src/core/game-state-accessor.ts:84`
- `type GameStateAccessorMethod = keyof GameStateAccessor | keyof GameStateMutator` — A method name of GameStateAccessor or GameStateMutator. `src/core/game-state-accessor.ts:30`
- `type GameStateAccessorMutator` — Combined accessor + mutator — every consumer unifies these into one object. `src/core/game-state-accessor.ts:59`
- `interface GameStateAccessorOptions` — What the consumer supplies to createGameStateAccessor. `src/core/game-state-accessor.ts:67`

## Throttle

lightweight rate limiter for tick handlers

- `function createThrottle(options: ThrottleOptions): Throttle` — Create a throttle that rate-limits work inside a tick handler. `src/core/throttle.ts:66`
- `interface Throttle` — A rate limiter for work inside a tick handler. `src/core/throttle.ts:35`
- `interface ThrottleOptions` `src/core/throttle.ts:24`

## Time tracking

persistent elapsed and total play time

- `function createTimeSystem(options?: TimeSystemOptions): TimeSystem` — Creates a time tracking system with persistent elapsed/total play time and a formatted display. `src/systems/time.ts:69`
- `interface TimeSystem` — Time tracking system with persistent elapsed and total play time. `src/systems/time.ts:35`
- `interface TimeSystemOptions` `src/systems/time.ts:26`

## Transition-distance primitives

"when does X happen?" math over current game state

- `interface AffordableLike` — Minimal shape satisfied by Purchasable. `src/core/transitions.ts:80`
- `function timeUntilAffordable(purchasable: AffordableLike, accessor: GameStateAccessor): TransitionDistance` — Distance until a purchasable's next purchase becomes affordable — delegates to timeUntilResource using `purchasable.resource` and `purchasable.getCost(1)`. `src/core/transitions.ts:124`
- `function timeUntilResource(resourceId: string, target: DecimalSource, accessor: GameStateAccessor): TransitionDistance` — Distance until `resource` reaches `target`, in seconds, assuming current rate holds. `src/core/transitions.ts:101`
- `interface TransitionDeps` — The ids and paths a transition's distance arithmetic reads through the accessor. `src/core/transitions.ts:59`
- `type TransitionDistance` — Distance until a state transition occurs, with a reason when the distance is uncomputable. `src/core/transitions.ts:41`
