# Runtime

The runtime substrate every engine carries. `createEngine` and the module/event/save wiring; the game loop (variable-dt and fixed-step modes); typed per-instance event emitter; throttle, time tracking, transition-distance math; the ambient game-state-accessor context. Start here to understand how an engine assembles and ticks.

## Canonical entrypoints

Start with these public symbols before scanning the full inventory below.

- `createEngine` — assemble modules, loop, persistence, events, registries, and mods.
- `EngineModule` / `EngineContext` — install/connect game content and share engine services.
- `createGameLoop` — standalone tick scheduler when not using the full engine facade.
- `createEmitHandle` — typed per-instance events for systems and categories.
- `timeUntilResource` / `timeUntilConditionFlip` / `timeUntilAffordable` — transition-distance math for previews and walkers.

## Engine entrypoint

top-level facade composing every layer

- `const computed: typeof computed$1` — _(no summary)_ `src/index.ts`
- `function createEngine(config: EngineConfig): Engine` — Creates the top-level engine orchestrator that wires together the game loop, save manager, module system, and mod support. `src/index.ts:381`
- `function effect<T = any>(fn: () => T, options?: ReactiveEffectOptions): ReactiveEffectRunner<T>` — _(no summary)_ `src/index.ts`
- `function effectScope(detached?: boolean): EffectScope` — Creates an effect scope object which can capture the reactive effects (i.e. `src/index.ts`
- `interface Engine` — The assembled engine instance returned by createEngine. `src/index.ts:300`
- `interface EngineConfig` — Configuration passed to createEngine. `src/index.ts:230`
- `interface EngineContext` — Per-module collaboration surface, handed to each EngineModule's `install` and `connect` callbacks. `src/index.ts:122`
- `interface EngineEvents` — Engine-wide event map — extend via declaration merging to add game events. `src/index.ts:98`
- `interface EngineModule` — A registerable unit of game content. `src/index.ts:186`
- `const GameLoopKey: InjectionKey<GameLoop>` — Inject the game loop instance. `src/index.ts:104`
- `function isRef<T>(r: Ref<T> | unknown): r is Ref<T>` — Checks if a value is a ref object. `src/index.ts`
- `type LoadHandler = (data: unknown) => void` — Callback invoked after a save is loaded, receiving the raw decoded payload. `src/index.ts:74`
- `interface ModDef` — A selectable game mod — metadata plus the module to install when active. `src/index.ts:208`
- `function reactive<T extends object>(target: T): Reactive<T>` — Returns a reactive proxy of the object. `src/index.ts`
- `function ref<T>(value: T): [T] extends [Ref] ? IfAny<T, Ref<T>, T> : Ref<UnwrapRef<T>, UnwrapRef<T> | T>` — Takes an inner value and returns a reactive and mutable ref object, which has a single property `.value` that points to the inner value. `src/index.ts`
- `type ResetHandler = () => void` — Callback invoked when the engine resets, before persistent refs are restored. `src/index.ts:76`
- `type SaveHandler = () => void` — Callback invoked when the engine flushes a save, before storage is written. `src/index.ts:72`
- `const SaveManagerKey: InjectionKey<SaveManager>` — Inject the save manager. `src/index.ts:107`
- `function shallowRef<T>(value: T): Ref extends T ? T extends Ref ? IfAny<T, ShallowRef<T>, T> : ShallowRef<T> : ShallowRef<T>` — Shallow version of ref. `src/index.ts`
- `type TickHandler = (dt: number) => void` — Callback invoked every game tick with the elapsed delta time in seconds. `src/index.ts:70`
- `function unref<T>(ref: MaybeRef<T> | ComputedRef<T>): T` — Returns the inner value if the argument is a ref, otherwise return the argument itself. `src/index.ts`
- `function watch<T, Immediate extends Readonly<boolean> = false>(source: WatchSource<T>, cb: WatchCallback<T, MaybeUndefined<T, Immediate>>, options?: WatchOptions<Immediate>): WatchHandle` — _(no summary)_ `src/index.ts`
- `function watchEffect(effect: WatchEffect, options?: WatchEffectOptions): WatchHandle` — _(no summary)_ `src/index.ts`

## Events

Typed per-instance event emitter primitive

- `function createEmitHandle<E>(options?: EmitHandleOptions): EmitHandle<E>` — Create a typed event handle for use inside a factory closure. `src/core/events.ts:57`
- `interface EmitHandle<E>` — Internal event interface held inside factory closures — subscribe and emit. `src/core/events.ts:25`
- `interface EmitHandleOptions` — Options for createEmitHandle. `src/core/events.ts:36`
- `interface Emittable<E>` — Public event interface exposed on system instances — subscribe only, emit is internal. `src/core/events.ts:19`

## Game Loop

worker-timer scheduled loop with EWMA lag compensation. Two dt modes: variable (default, genre-standard) and fixed-step accumulator (opt-in, for source-faithful ports with clamp-on-overshoot tick math)

- `function createGameLoop(config?: GameLoopConfig): GameLoop` — Creates a game loop with EWMA lag compensation, speed control, named phase hooks, and a choice of variable-dt (default) or fixed-step accumulator mode. `src/core/game-loop.ts:201`
- `interface GameLoop` — The game loop instance returned by createGameLoop. `src/core/game-loop.ts:125`
- `interface GameLoopConfig` — Configuration accepted by createGameLoop. `src/core/game-loop.ts:62`
- `interface PhaseHooks` — Lifecycle hooks for a named game phase, registered via `loop.registerPhase()`. `src/core/game-loop.ts:110`
- `type TickCallback = (dt: number) => void` — Tick-handler signature for `loop.onTick`: receives the elapsed dt in seconds. `src/core/game-loop.ts:117`
- `interface TimerProvider` — Timer functions for scheduling. `src/core/game-loop.ts:52`

## Ambient game-state-accessor context

the fifth cross-cutting ambient scope alongside chain registry, effect-system registry, resource registry, and persistence namespace

- `type GameStateAccessorMutator = GameStateAccessor & GameStateMutator` — Combined accessor + mutator — every consumer unifies these into one object. `src/core/game-state-accessor.ts:28`

## Throttle

lightweight tick-callback rate limiter

- `function createThrottle(options: ThrottleOptions): Throttle` — Create a throttle gate for rate-limiting tick callbacks. `src/core/throttle.ts:66`
- `interface Throttle` — A gate that rate-limits execution within a tick callback. `src/core/throttle.ts:35`
- `interface ThrottleOptions` — Options for createThrottle. `src/core/throttle.ts:24`

## Time tracking

persistent elapsed/total play time and reactive speed multiplier

- `function createTimeSystem(config?: TimeSystemConfig): TimeSystem` — Creates a time tracking system with persistent elapsed/total play time, speed multiplier, and formatted display. `src/systems/time.ts:65`
- `function isTimeSystem(value: unknown): value is TimeSystem` — Type guard: returns `true` if the value is a TimeSystem instance. `src/systems/time.ts:91`
- `interface TimeSystem` — Time tracking system with persistent elapsed and total play time. `src/systems/time.ts:31`
- `interface TimeSystemConfig` — Configuration for createTimeSystem. `src/systems/time.ts:25`
- `const TimeSystemType: unique symbol` — Symbol identifying TimeSystem features. `src/systems/time.ts:22`

## Transition-distance primitives

"when does X happen?" math over current engine state

- `interface AffordableLike` — Minimal shape satisfied by Purchasable. `src/core/transitions.ts:75`
- `interface ChildFlipResult` — One child's contribution to a combinator flip-distance calculation: its current truth value plus its individual flip distance. `src/core/transitions.ts:258`
- `function collectConditionDeps(condition: ICondition): TransitionDeps` — Collect every accessor slot read by `condition`'s truth evaluation and flip-distance arithmetic. `src/core/transitions.ts:214`
- `function combineFlipDistances(children: ChildFlipResult[], kind: 'and' | 'or'): TransitionDistance` — Truth-table dispatch over `{ currentlyTrue, distance }` tuples for `and` / `or` combinators. `src/core/transitions.ts:278`
- `function timeUntilAffordable(purchasable: AffordableLike, accessor: GameStateAccessor): TransitionDistance` — Distance until the next level of a purchasable becomes affordable — delegates to timeUntilResource using `purchasable.resource` and `purchasable.getCost(1)`. `src/core/transitions.ts:121`
- `function timeUntilConditionFlip(condition: ICondition, accessor: GameStateAccessor): TransitionDistance` — Distance until `condition` changes truth value, assuming current rates hold. `src/core/transitions.ts:146`
- `function timeUntilResource(resourceId: string, target: DecimalSource, accessor: GameStateAccessor): TransitionDistance` — Distance until `resource` reaches `target`, in seconds, assuming current rate holds. `src/core/transitions.ts:96`
- `interface TransitionDeps` — Accessor slots a transition's distance arithmetic reads. `src/core/transitions.ts:60`
- `type TransitionDistance` — Distance until a state transition occurs, with a reason when the distance is uncomputable. `src/core/transitions.ts:42`
