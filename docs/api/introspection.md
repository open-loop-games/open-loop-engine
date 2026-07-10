# Introspection

The cross-cutting "walk every X" surface external tools read — balance workbenches, sim pickers, devtools panels, mods. `EngineCategories` plus the per-engine registries (chain / resource / effect-system), the `OverrideRegistry` + `TuningRegistry` + `tunable()` pattern that exposes designer-flagged knobs, and the Profiler + Safeguards instrumentation. All discoverable via injection keys with no install-time coupling.

## Canonical entrypoints

Start with these public symbols before scanning the full inventory below.

- `EngineCategories` / `CategoriesKey` — discover auto-registered content categories.
- `createOverrideRegistry` / `createTuningRegistry` / `tunable` — expose designer-approved balance knobs.
- `createChainRegistry`, `createResourceRegistry`, `createEffectSystemRegistry` — per-engine enumerable surfaces for tools.
- `enableProfiling` / `getProfileReport` — runtime timing instrumentation.
- `enableDevMode` / `getDiagnostics` — development safeguards and diagnostics.

## Engine categories

the typed cross-category accumulator the engine self-publishes for external introspection tools (sim pickers, devtools, balance workbenches, harness walkers)

- `const CategoriesKey: InjectionKey<EngineCategories>` — Discovery key for external introspection tools (sim, devtools). `src/systems/engine-categories.ts:107`
- `interface EngineCategories` — Discovery map for external introspection tools (sim, devtools, balance workbenches). `src/systems/engine-categories.ts:62`
- `function findCategoryEntrySignals(categories: EngineCategories, categoryId: string, entityId: string): CategoryEntrySignals | undefined` — Resolve `(categoryId, entityId)` to the entry's introspection signals across every typed slot in EngineCategories. `src/systems/engine-categories.ts:176`

## Override Registry

generic typed registry with scoped push/pop, plus the typed `TuningRegistry` narrow that opts a registry into the picker's tuning-surface enumeration

- `function createOverrideRegistry<T extends Record<string, (...args: never[]) => unknown>>(name: string): OverrideRegistry<T>` — Create a new override registry. `src/core/override-registry.ts:166`
- `function createTuningRegistry(name: string): TuningRegistry` — Create a tuning registry — typed narrow over OverrideRegistry for `Record<string, () => DecimalSource>`-shaped registries that opt into the picker's tuning-surface enumeration. `src/core/override-registry.ts:267`
- `interface OverrideRegistry<T extends Record<string, (...args: never[]) => unknown>>` — A typed, scoped override registry for named functions. `src/core/override-registry.ts:81`
- `function tunable<R>(registry: OverrideRegistry<Record<string, (...args: never[]) => unknown>>, key: string, defaultFn: () => R): ComputedRef<R>` — Bind a default implementation to `key` on `registry` and return a reactive `ComputedRef` that re-evaluates when the scope stack changes. `src/core/override-registry.ts:380`
- `const TuningRegistriesKey: InjectionKey<Set<TuningRegistry>>` — Per-engine collection of tuning registries — the picker's `walkTunables` reads this. `src/core/override-registry.ts:156`
- `type TuningRegistry = OverrideRegistry<Record<string, () => DecimalSource>>` — Typed narrow over OverrideRegistry for "values intentionally declared as tuning surface." Every key resolves to a zero-arg reader returning a `DecimalSource`. `src/core/override-registry.ts:143`

## Profiler

- `function enableProfiling(): () => void` — Subscribe to the profiler. `src/core/profiler.ts:39`
- `function formatProfileReport(report: ProfileReport): string` — Format a ProfileReport as a borglike-style console table. `src/core/profiler.ts:220`
- `function getProfileReport(): ProfileReport` — Build a structured report of accumulated timings. `src/core/profiler.ts:187`
- `function isProfilingEnabled(): boolean` — Whether any caller currently holds a profile subscription. `src/core/profiler.ts:53`
- `function profile<T>(name: string, fn: () => T): T` — Wrap a function call with profiling. `src/core/profiler.ts:61`
- `function profileEnd(name: string, start: number): void` — End a manual timer started with profileStart. `src/core/profiler.ts:85`
- `interface ProfileEntry` — A single row in a ProfileReport. `src/core/profiler.ts:141`
- `interface ProfileReport` — Structured profiling report produced by getProfileReport. `src/core/profiler.ts:167`
- `function profileStart(): number` — Start a manual timer. `src/core/profiler.ts:77`
- `function resetProfile(): void` — Clear all accumulated timings. `src/core/profiler.ts:241`

## Engine-internal registries

three per-engine enumerable collections that external introspection tools (balance workbenches, sim pickers, devtools) read to walk "every X this engine knows about":

- `type ChainRegistry = NamedRegistry<ModifierChain>` — Enumerable registry of ModifierChains for a single engine. `src/core/registries.ts:51`
- `const ChainRegistryKey` — Injection key for the per-engine ChainRegistry. `src/core/registries.ts:59`
- `function createChainRegistry(): ChainRegistry` — Create a fresh, empty chain registry. `src/core/registries.ts:65`
- `function createEffectSystemRegistry(): EffectSystemRegistry` — Create a fresh, empty effect-system registry. `src/core/registries.ts:135`
- `function createResourceRegistry(): ResourceRegistry` — Create a fresh, empty resource registry. `src/core/registries.ts:222`
- `interface EffectDefLike` — Structural shape shared by `TemporaryEffectDef` and `PersistentEffectDef` that the picker needs. `src/core/registries.ts:115`
- `type EffectSystemRegistry = NamedRegistry<EnumerableEffectSystem>` — Enumerable registry of effect systems for a single engine. `src/core/registries.ts:124`
- `const EffectSystemRegistryKey` — Injection key for the per-engine EffectSystemRegistry. `src/core/registries.ts:127`
- `interface EnumerableEffectSystem` — Minimal shape an effect system must expose to be enumerable. `src/core/registries.ts:101`
- `interface ResourceRegistry` — Enumerable registry of Resources for a single engine. `src/core/registries.ts:186`
- `interface ResourceRegistryEntry<T = DecimalSource>` — One entry in a ResourceRegistry. `src/core/registries.ts:168`
- `const ResourceRegistryKey` — Injection key for the per-engine ResourceRegistry. `src/core/registries.ts:214`

## Engine safeguards

iteration caps, depth limits, and dev diagnostics

- `function disableDevMode(): void` — Disable dev-mode diagnostics. `src/core/safeguards.ts:20`
- `function enableDevMode(): void` — Enable dev-mode diagnostics (counters, console warnings with stack traces). `src/core/safeguards.ts:15`
- `function getDiagnostics(): Readonly<SafeguardDiagnostics>` — Read-only snapshot of safeguard diagnostics counters. `src/core/safeguards.ts:54`
- `function isDevMode(): boolean` — Check whether dev mode is active. `src/core/safeguards.ts:25`
- `function resetDiagnostics(): void` — Reset all diagnostics counters to zero. `src/core/safeguards.ts:59`
- `interface SafeguardDiagnostics` — Diagnostic counters captured by the runtime safeguards — how often the emit-depth cap and sequencer advance cap have tripped, plus the last offender of each. `src/core/safeguards.ts:35`
