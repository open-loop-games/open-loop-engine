# Runtime

How an engine assembles and ticks. `createEngine` and the module/event/save wiring, TickDriver (variable-dt and fixed-step), typed event emitter, throttle, play-clock, transition-distance math, the ambient accessor context.

## Canonical entrypoints

- `createEngine` — assemble modules, TickDriver, persistence, events, registries, and mods.
- `EngineModule` / `EngineContext` — install/connect game content and share engine services.
- `createTickDriver` — standalone tick scheduler when not using the full engine facade.
- `createEmitHandle` — typed per-instance events for systems and categories.
- `timeUntilResource` / `timeUntilGateFlip` / `timeUntilAffordable` — transition-distance math for previews and walkers.
- `ref` / `computed` / `watch` / `effect` (re-exported from Vue) — reactivity API; import via the engine, not directly from `vue`, so subscriptions share the engine's `activeEffect` scope.

## Engine assembly

the module-system façade that composes core + systems into a runnable game: _createEngine_, _EngineContext_, _EngineModule_, _EngineConfig_, and the built-in injection keys

- `function createEngine(config: EngineConfig): Engine` — Creates the top-level engine orchestrator that wires together the TickDriver, save manager, module system, and mod support. `src/engine.ts:440`
- `interface Engine` — The assembled engine instance returned by createEngine. `src/engine.ts:333`
- `interface EngineConfig` — Configuration passed to createEngine. `src/engine.ts:245`
- `interface EngineContext` — Per-module collaboration surface, handed to each EngineModule's `install` and `connect` callbacks. `src/engine.ts:136`
- `interface EngineEvents` — Engine-wide event map — extend via declaration merging to add game events. `src/engine.ts:100`
- `interface EngineModule` — A registerable unit of game content. `src/engine.ts:201`
- `type LoadHandler = (result: SaveLoadResult) => void` — Callback invoked after a save loads successfully through any entry point: `engine.load()`, the save manager's `load` / `importSave`, or a harness engine hydrated from a save. `src/engine.ts:78`
- `interface ModDef` — A selectable game mod — metadata plus the module to install when active. `src/engine.ts:223`
- `type SaveHandler = () => void` — Callback invoked before live state is serialized — by `engine.save()`, the autosave, and the save manager's `save` / `saveToSlot` / `exportSave` — so it can flush derived state into persistent refs. `src/engine.ts:66`
- `const SaveManagerKey: InjectionKey<SaveManager>` — Inject the save manager. `src/engine.ts:109`
- `const TickDriverKey: InjectionKey<TickDriver>` — Inject the TickDriver instance. `src/engine.ts:106`
- `type TickHandler = (dt: number) => void` — Callback invoked every game tick with the elapsed delta time in seconds. `src/engine.ts:60`

## Reactivity re-exports

Vue's reactivity API surfaced through the engine — import these from `@open-loop/engine`, not from `vue`: a separately-resolved `vue` won't subscribe to engine refs and updates silently miss. Signatures and semantics are Vue's own; read them in Vue's docs.

`computed` · `ComputedRef` · `effect` · `effectScope` · `EffectScope` · `isRef` · `onScopeDispose` · `reactive` · `ref` · `Ref` · `shallowRef` · `ShallowRef` · `triggerRef` · `unref` · `watch` · `watchEffect` · `WatchStopHandle` · `WritableComputedRef`

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

one of the cross-cutting ambient scopes `createEngine` sets around `install()` / `connect()`, alongside the chain, effect-system, resource and tuning registries, the engine categories, and the persistence namespace

- `type GameStateAccessorMutator = GameStateAccessor & GameStateMutator` — Combined accessor + mutator — every consumer unifies these into one object. `src/core/game-state-accessor.ts:29`

## Throttle

lightweight tick-callback rate limiter

- `function createThrottle(options: ThrottleOptions): Throttle` — Create a throttle gate for rate-limiting tick callbacks. `src/core/throttle.ts:66`
- `interface Throttle` — A gate that rate-limits execution within a tick callback. `src/core/throttle.ts:35`
- `interface ThrottleOptions` `src/core/throttle.ts:24`

## Time tracking

persistent elapsed/total play time and reactive speed multiplier

- `function createTimeSystem(config?: TimeSystemConfig): TimeSystem` — Creates a time tracking system with persistent elapsed/total play time, speed multiplier, and formatted display. `src/systems/time.ts:80`
- `interface TimeSystem` — Time tracking system with persistent elapsed and total play time. `src/systems/time.ts:39`
- `interface TimeSystemConfig` — Configuration for createTimeSystem. `src/systems/time.ts:22`

## Transition-distance primitives

"when does X happen?" math over current engine state

- `interface AffordableLike` — Minimal shape satisfied by Purchasable. `src/core/transitions.ts:82`
- `function timeUntilAffordable(purchasable: AffordableLike, accessor: GameStateAccessor): TransitionDistance` — Distance until the next level of a purchasable becomes affordable — delegates to timeUntilResource using `purchasable.resource` and `purchasable.getCost(1)`. `src/core/transitions.ts:132`
- `function timeUntilResource(resourceId: string, target: DecimalSource, accessor: GameStateAccessor): TransitionDistance` — Distance until `resource` reaches `target`, in seconds, assuming current rate holds. `src/core/transitions.ts:103`
- `interface TransitionDeps` — Accessor slots a transition's distance arithmetic reads. `src/core/transitions.ts:61`
- `type TransitionDistance` — Distance until a state transition occurs, with a reason when the distance is uncomputable. `src/core/transitions.ts:43`
