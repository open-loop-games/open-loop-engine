# Introspection

The cross-cutting "walk every X" API surface that external tools read: devtools, mods, balance workbenches. `EngineCategories`, the per-engine registries, `tunable()` with the override and tuning registries, the profiler and safeguard diagnostics. All are reachable through injection keys.

## Canonical entrypoints

- `EngineCategories` / `CategoriesKey` — discover auto-registered content categories.
- `createOverrideRegistry` / `createTuningRegistry` / `tunable` — expose designer-approved tunables.
- `ChainRegistryKey`, `ResourceRegistryKey`, `EffectSystemRegistryKey`, `FlagRegistryKey` — the chain, resource, effect-system and flag registries for tools, read through `engine.tryInject` or `ctx.inject`.
- `enableProfiling` / `getProfileReport` — profile engine calls.
- `enableDevMode` / `getSafeguardDiagnostics` — dev-mode safeguards and safeguard diagnostics.

## Engine categories

the typed cross-category collection the engine self-publishes for external introspection tools (the picker, devtools, balance workbenches, balance-harness walkers)

- `const CategoriesKey: InjectionKey<EngineCategories>` — Injection key for external introspection tools (the balance harness, devtools). `src/systems/engine-categories.ts:94`
- `interface EngineCategories` — Discovery map for external introspection tools (the balance harness, devtools, balance workbenches). `src/systems/engine-categories.ts:60`
- `function findCategoryEntrySignals(categories: EngineCategories, categoryId: string, defId: string): CategoryEntrySignals | undefined` — Resolve `(categoryId, defId)` to the category entry's signals across every typed field in EngineCategories. `src/systems/engine-categories.ts:162`

## Override Registry

generic typed registry with scoped overrides, plus the typed `TuningRegistry` narrow that opts a registry into the picker's tunable enumeration

- `function createOverrideRegistry<T extends { [K in keyof T]: (...args: never[]) => unknown; }>(id: string): OverrideRegistry<T>` — Create a new override registry. `src/core/override-registry.ts:170`
- `function createTuningRegistry(id: string): TuningRegistry` — Create a tuning registry — typed narrow over OverrideRegistry for `Record<string, () => DecimalSource>`-shaped registries that opt into the picker's tunable enumeration. `src/core/override-registry.ts:270`
- `interface OverrideRegistry<T extends { [K in keyof T]: (...args: never[]) => unknown; }>` — A typed, scoped override registry for named functions. `src/core/override-registry.ts:79`
- `function tunable<T extends { [P in keyof T]: (...args: never[]) => unknown; }, K extends NullaryKeys<T>, F extends T[K] & (() => unknown)>(registry: OverrideRegistry<T>, key: K, defaultFn: F): ComputedRef<Widen<ReturnType<F>>>` — Register a registry default for `key` on `registry` and return a reactive `ComputedRef`. `src/core/override-registry.ts:398`
- `const TuningRegistriesKey: InjectionKey<Set<TuningRegistry>>` — Per-engine collection of tuning registries — the picker's `walkTunables` reads this. `src/core/override-registry.ts:155`
- `type TuningRegistry = OverrideRegistry<Record<string, () => DecimalSource>>` — Typed narrow over OverrideRegistry for values declared on purpose as tunables. `src/core/override-registry.ts:142`

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

four per-engine enumerable collections that external introspection tools (balance workbenches, the picker, devtools) read to walk "every X this engine knows about":

- `type ChainRegistry = NamedRegistry<ModifierChain>` — Enumerable registry of ModifierChains for a single engine. `src/core/registries.ts:56`
- `const ChainRegistryKey: InjectionKey<ChainRegistry>` — Injection key for the per-engine ChainRegistry. `src/core/registries.ts:64`
- `interface EffectDefLike` — Structural shape shared by `TemporaryEffectDef` and `ConditionalEffectDef` that the picker needs. `src/core/registries.ts:122`
- `type EffectSystemRegistry = NamedRegistry<EnumerableEffectSystem>` — Enumerable registry of effect systems for a single engine. `src/core/registries.ts:131`
- `const EffectSystemRegistryKey: InjectionKey<EffectSystemRegistry>` — Injection key for the per-engine EffectSystemRegistry. `src/core/registries.ts:134`
- `interface EnumerableEffectSystem` — Minimal shape an effect system must expose to be enumerable. `src/core/registries.ts:108`
- `type FlagRegistry = NamedRegistry<Flag>` — Registry of the Flags of a single engine, keyed by flag id. `src/core/registries.ts:281`
- `const FlagRegistryKey: InjectionKey<FlagRegistry>` — Injection key for the per-engine FlagRegistry. `src/core/registries.ts:287`
- `interface ResourceRegistry` — Enumerable registry of Resources for a single engine. `src/core/registries.ts:194`
- `interface ResourceRegistryEntry<T = DecimalSource>` — One entry in a ResourceRegistry. `src/core/registries.ts:177`
- `const ResourceRegistryKey: InjectionKey<ResourceRegistry>` — Injection key for the per-engine ResourceRegistry. `src/core/registries.ts:217`

## Engine safeguards

iteration caps, depth limits, and safeguard diagnostics

- `function disableDevMode(): void` — Disable dev mode. `src/core/safeguards.ts:23`
- `function enableDevMode(): void` — Enable dev mode: a console warning each time a safeguard cap is hit. `src/core/safeguards.ts:18`
- `function getSafeguardDiagnostics(): Readonly<SafeguardDiagnostics>` — Read-only snapshot of the safeguard diagnostics. `src/core/safeguards.ts:57`
- `function isDevMode(): boolean` — Check whether dev mode is active. `src/core/safeguards.ts:28`
- `function resetSafeguardDiagnostics(): void` — Reset every safeguard diagnostic to zero. `src/core/safeguards.ts:62`
- `interface SafeguardDiagnostics` — Safeguard diagnostics — how often the emit-depth cap and the sequencer advance cap were hit, plus the last offender of each. `src/core/safeguards.ts:38`
