# Introspection

The cross-cutting "walk every X" surface external tools read — devtools, mods, balance workbenches. `EngineCategories`, per-engine registries, `tunable()` plus the override/tuning registries, profiler and safeguards. All reachable through injection keys.

## Canonical entrypoints

- `EngineCategories` / `CategoriesKey` — discover auto-registered content categories.
- `createOverrideRegistry` / `createTuningRegistry` / `tunable` — expose designer-approved balance knobs.
- `ChainRegistryKey`, `ResourceRegistryKey`, `EffectSystemRegistryKey` — per-engine enumerable surfaces for tools, read through `engine.tryInject` or `ctx.inject`.
- `enableProfiling` / `getProfileReport` — runtime timing instrumentation.
- `enableDevMode` / `getDiagnostics` — development safeguards and diagnostics.

## Engine categories

the typed cross-category accumulator the engine self-publishes for external introspection tools (sim pickers, devtools, balance workbenches, harness walkers)

- `const CategoriesKey: InjectionKey<EngineCategories>` — Discovery key for external introspection tools (sim, devtools). `src/systems/engine-categories.ts:96`
- `interface EngineCategories` — Discovery map for external introspection tools (sim, devtools, balance workbenches). `src/systems/engine-categories.ts:62`
- `function findCategoryEntrySignals(categories: EngineCategories, categoryId: string, defId: string): CategoryEntrySignals | undefined` — Resolve `(categoryId, defId)` to the entry's introspection signals across every typed slot in EngineCategories. `src/systems/engine-categories.ts:165`

## Override Registry

generic typed registry with scoped push/pop, plus the typed `TuningRegistry` narrow that opts a registry into the picker's tuning-surface enumeration

- `function createOverrideRegistry<T extends { [K in keyof T]: (...args: never[]) => unknown; }>(id: string): OverrideRegistry<T>` — Create a new override registry. `src/core/override-registry.ts:173`
- `function createTuningRegistry(id: string): TuningRegistry` — Create a tuning registry — typed narrow over OverrideRegistry for `Record<string, () => DecimalSource>`-shaped registries that opt into the picker's tuning-surface enumeration. `src/core/override-registry.ts:274`
- `interface OverrideRegistry<T extends { [K in keyof T]: (...args: never[]) => unknown; }>` — A typed, scoped override registry for named functions. `src/core/override-registry.ts:81`
- `function tunable<T extends { [P in keyof T]: (...args: never[]) => unknown; }, K extends NullaryKeys<T>, F extends T[K] & (() => unknown)>(registry: OverrideRegistry<T>, key: K, defaultFn: F): ComputedRef<Widen<ReturnType<F>>>` — Bind a default implementation to `key` on `registry` and return a reactive `ComputedRef` that re-evaluates when the scope stack changes or the key is overridden. `src/core/override-registry.ts:402`
- `const TuningRegistriesKey: InjectionKey<Set<TuningRegistry>>` — Per-engine collection of tuning registries — the picker's `walkTunables` reads this. `src/core/override-registry.ts:158`
- `type TuningRegistry = OverrideRegistry<Record<string, () => DecimalSource>>` — Typed narrow over OverrideRegistry for "values intentionally declared as tuning surface." Every key resolves to a zero-arg reader returning a `DecimalSource`. `src/core/override-registry.ts:145`

## Profiler

- `function enableProfiling(): () => void` — Subscribe to the profiler. `src/core/profiler.ts:45`
- `function formatProfileReport(report: ProfileReport): string` — Format a ProfileReport as a console table. `src/core/profiler.ts:229`
- `function getProfileReport(): ProfileReport` — Build a structured report of accumulated timings. `src/core/profiler.ts:196`
- `function isProfilingEnabled(): boolean` — Whether any caller currently holds a profile subscription. `src/core/profiler.ts:59`
- `function profile<T>(label: string, fn: () => T): T` — Wrap a function call with profiling. `src/core/profiler.ts:67`
- `function profileEnd(label: string, start: number): void` — End a manual timer started with profileStart. `src/core/profiler.ts:91`
- `interface ProfileEntry` — A single row in a ProfileReport. `src/core/profiler.ts:147`
- `interface ProfileReport` — Structured profiling report produced by getProfileReport. `src/core/profiler.ts:176`
- `function profileStart(): number` — Start a manual timer. `src/core/profiler.ts:83`
- `function resetProfile(): void` — Clear all accumulated timings. `src/core/profiler.ts:250`

## Engine-internal registries

three per-engine enumerable collections that external introspection tools (balance workbenches, sim pickers, devtools) read to walk "every X this engine knows about":

- `type ChainRegistry = NamedRegistry<ModifierChain>` — Enumerable registry of ModifierChains for a single engine. `src/core/registries.ts:53`
- `const ChainRegistryKey: InjectionKey<ChainRegistry>` — Injection key for the per-engine ChainRegistry. `src/core/registries.ts:61`
- `interface EffectDefLike` — Structural shape shared by `TemporaryEffectDef` and `ConditionalEffectDef` that the picker needs. `src/core/registries.ts:119`
- `type EffectSystemRegistry = NamedRegistry<EnumerableEffectSystem>` — Enumerable registry of effect systems for a single engine. `src/core/registries.ts:128`
- `const EffectSystemRegistryKey: InjectionKey<EffectSystemRegistry>` — Injection key for the per-engine EffectSystemRegistry. `src/core/registries.ts:131`
- `interface EnumerableEffectSystem` — Minimal shape an effect system must expose to be enumerable. `src/core/registries.ts:105`
- `interface ResourceRegistry` — Enumerable registry of Resources for a single engine. `src/core/registries.ts:191`
- `interface ResourceRegistryEntry<T = DecimalSource>` — One entry in a ResourceRegistry. `src/core/registries.ts:174`
- `const ResourceRegistryKey: InjectionKey<ResourceRegistry>` — Injection key for the per-engine ResourceRegistry. `src/core/registries.ts:214`

## Engine safeguards

iteration caps, depth limits, and dev diagnostics

- `function disableDevMode(): void` — Disable dev-mode diagnostics. `src/core/safeguards.ts:23`
- `function enableDevMode(): void` — Enable dev-mode diagnostics: a console warning on every safeguard trip. `src/core/safeguards.ts:18`
- `function getDiagnostics(): Readonly<SafeguardDiagnostics>` — Read-only snapshot of safeguard diagnostics counters. `src/core/safeguards.ts:57`
- `function isDevMode(): boolean` — Check whether dev mode is active. `src/core/safeguards.ts:28`
- `function resetDiagnostics(): void` — Reset all diagnostics counters to zero. `src/core/safeguards.ts:62`
- `interface SafeguardDiagnostics` — Diagnostic counters captured by the runtime safeguards — how often the emit-depth cap and sequencer advance cap have tripped, plus the last offender of each. `src/core/safeguards.ts:38`
