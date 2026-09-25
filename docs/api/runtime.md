# Runtime

How an engine assembles and ticks. `createEngine` and the module/event/save wiring, TickDriver (variable-dt and fixed-step), typed event emitter, throttle, play-clock, transition-distance math, the ambient accessor context.

## Canonical entrypoints

- `createEngine` — assemble modules, TickDriver, persistence, events, registries, and mods.
- `EngineModule` / `EngineContext` — install/connect game content and share engine services.
- `createTickDriver` — standalone tick scheduler when not using the full engine facade.
- `createEmitHandle` — typed per-instance events for systems and categories.
- `timeUntilResource` / `timeUntilConditionFlip` / `timeUntilAffordable` — transition-distance math for previews and walkers.
- `ref` / `computed` / `watch` / `effect` (re-exported from Vue) — reactivity API; import via the engine, not directly from `vue`, so subscriptions share the engine's `activeEffect` scope.

## Engine assembly

the module-system façade that composes core + systems into a runnable game: _createEngine_, _EngineContext_, _EngineModule_, _EngineConfig_, and the built-in injection keys

- `function createEngine(config: EngineConfig): Engine` — Creates the top-level engine orchestrator that wires together the TickDriver, save manager, module system, and mod support. `src/engine.ts:390`
- `interface Engine` — The assembled engine instance returned by createEngine. `src/engine.ts:295`
- `interface EngineConfig` — Configuration passed to createEngine. `src/engine.ts:215`
- `interface EngineContext` — Per-module collaboration surface, handed to each EngineModule's `install` and `connect` callbacks. `src/engine.ts:107`
- `interface EngineEvents` — Engine-wide event map — extend via declaration merging to add game events. `src/engine.ts:85`
- `interface EngineModule` — A registerable unit of game content. `src/engine.ts:171`
- `type LoadHandler = (data: unknown) => void` — Callback invoked after a save is loaded, receiving the `SaveLoadResult` status object (success flag plus timestamp or failure reason) — not the decoded save payload. `src/engine.ts:61`
- `interface ModDef` — A selectable game mod — metadata plus the module to install when active. `src/engine.ts:193`
- `type ResetHandler = () => void` — Callback invoked when the engine resets, before persistent refs are restored. `src/engine.ts:63`
- `type SaveHandler = () => void` — Callback invoked when the engine flushes a save, before storage is written. `src/engine.ts:55`
- `const SaveManagerKey: InjectionKey<SaveManager>` — Inject the save manager. `src/engine.ts:94`
- `const TickDriverKey: InjectionKey<TickDriver>` — Inject the TickDriver instance. `src/engine.ts:91`
- `type TickHandler = (dt: number) => void` — Callback invoked every game tick with the elapsed delta time in seconds. `src/engine.ts:53`

## Reactivity re-exports

Vue's reactivity API surfaced through the engine — import these from `@open-loop/engine`, not from `vue`: a separately-resolved `vue` won't subscribe to engine refs and updates silently miss. Signatures and semantics are Vue's own; read them in Vue's docs.

`computed` · `ComputedRef` · `effect` · `effectScope` · `EffectScope` · `isRef` · `reactive` · `ref` · `Ref` · `shallowRef` · `ShallowRef` · `unref` · `watch` · `watchEffect` · `WatchStopHandle` · `WritableComputedRef`

## Events

Typed per-instance event emitter primitive

- `function createEmitHandle<E>(options?: EmitHandleOptions): EmitHandle<E>` — Create a typed event handle for use inside a factory closure. `src/core/events.ts:57`
- `interface EmitHandle<E>` — Internal event interface held inside factory closures — subscribe and emit. `src/core/events.ts:25`
- `interface EmitHandleOptions` `src/core/events.ts:36`
- `interface Emittable<E>` — Public event interface exposed on system instances — subscribe only, emit is internal. `src/core/events.ts:19`

## TickDriver

worker-timer scheduled tick dispatcher with EWMA lag compensation. Two dt modes: variable (default, genre-standard) and fixed-step accumulator (opt-in, for source-faithful ports with clamp-on-overshoot tick math)

- `function createTickDriver(config?: TickDriverConfig): TickDriver` — Creates a TickDriver with EWMA lag compensation, speed control, named phase hooks, and a choice of variable-dt (default) or fixed-step accumulator mode. `src/core/tick-driver.ts:233`
- `interface PhaseHooks` — Lifecycle hooks for a named game phase, registered via `tickDriver.registerPhase()`. `src/core/tick-driver.ts:126`
- `type TickCallback = (dt: number) => void` — Tick-handler signature for `tickDriver.onTick`: dt in seconds — the real (speed-scaled, capped) elapsed time in variable mode, always `stepSize` in fixed mode. `src/core/tick-driver.ts:137`
- `interface TickDriver` — The TickDriver instance returned by createTickDriver. `src/core/tick-driver.ts:145`
- `interface TickDriverConfig` — Configuration accepted by createTickDriver. `src/core/tick-driver.ts:62`
- `interface TimerProvider` — Timer functions for scheduling. `src/core/tick-driver.ts:52`

## Ambient game-state-accessor context

the fifth cross-cutting ambient scope alongside chain registry, effect-system registry, resource registry, and persistence namespace

- `type GameStateAccessorMutator = GameStateAccessor & GameStateMutator` — Combined accessor + mutator — every consumer unifies these into one object. `src/core/game-state-accessor.ts:28`

## Throttle

lightweight tick-callback rate limiter

- `function createThrottle(options: ThrottleOptions): Throttle` — Create a throttle gate for rate-limiting tick callbacks. `src/core/throttle.ts:66`
- `interface Throttle` — A gate that rate-limits execution within a tick callback. `src/core/throttle.ts:35`
- `interface ThrottleOptions` `src/core/throttle.ts:24`

## Time tracking

persistent elapsed/total play time and reactive speed multiplier

- `function createTimeSystem(config?: TimeSystemConfig): TimeSystem` — Creates a time tracking system with persistent elapsed/total play time, speed multiplier, and formatted display. `src/systems/time.ts:59`
- `interface TimeSystem` — Time tracking system with persistent elapsed and total play time. `src/systems/time.ts:27`
- `interface TimeSystemConfig` — Configuration for createTimeSystem. `src/systems/time.ts:21`

## Transition-distance primitives

"when does X happen?" math over current engine state

- `interface AffordableLike` — Minimal shape satisfied by Purchasable. `src/core/transitions.ts:75`
- `interface ChildFlipResult` — One child's contribution to a combinator flip-distance calculation: its current truth value plus its individual flip distance. `src/core/transitions.ts:263`
- `function collectConditionDeps(condition: ICondition): TransitionDeps` — Collect every accessor slot read by `condition`'s truth evaluation and flip-distance arithmetic. `src/core/transitions.ts:219`
- `function combineFlipDistances(children: ChildFlipResult[], kind: 'and' | 'or'): TransitionDistance` — Truth-table dispatch over `{ currentlyTrue, distance }` tuples for `and` / `or` combinators. `src/core/transitions.ts:283`
- `function timeUntilAffordable(purchasable: AffordableLike, accessor: GameStateAccessor): TransitionDistance` — Distance until the next level of a purchasable becomes affordable — delegates to timeUntilResource using `purchasable.resource` and `purchasable.getCost(1)`. `src/core/transitions.ts:125`
- `function timeUntilConditionFlip(condition: ICondition, accessor: GameStateAccessor): TransitionDistance` — Distance until `condition` changes truth value, assuming current rates hold. `src/core/transitions.ts:150`
- `function timeUntilResource(resourceId: string, target: DecimalSource, accessor: GameStateAccessor): TransitionDistance` — Distance until `resource` reaches `target`, in seconds, assuming current rate holds. `src/core/transitions.ts:96`
- `interface TransitionDeps` — Accessor slots a transition's distance arithmetic reads. `src/core/transitions.ts:60`
- `type TransitionDistance` — Distance until a state transition occurs, with a reason when the distance is uncomputable. `src/core/transitions.ts:42`
