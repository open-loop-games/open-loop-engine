# Resources

Numeric foundation and the named-quantity factory. `Decimal` arithmetic, formatting, and randomness underneath `createResource`; conversion and resource bags on top. Start here for any new countable quantity.

## Canonical entrypoints

- `createResource` — define a named game quantity with persistence and display metadata.
- `addResource` / `subtractResource` / `hasResource` / `displayResource` — mutate, check, and present resources through the standard helpers.
- `Resource.cumulative` / `Resource.best` — read lifetime gain and high-water trackers created with persistent resources.
- `createResourceBag` — cap resources: per-type and total storage capacity with a block or destroy overflow, and `link` clamps a linked `Resource` on write. Use `createInventory` for item-facing gameplay.
- `randomItem` / `shuffle` / `weightedPick` / `chance` — random picks, draws and rolls, seedable through `seedRNG` or `createSeededRNG`.
- `createConversion` — model atomic recipes, trades, and prestige-style exchanges.

## Decimal

Big number utilities using break_eternity.js Provides Decimal type and formatting functions for large/small numbers

- `function bn(x: DecimalSource): Decimal` — Create a Decimal from a number, string, or Decimal. `src/primitives/decimal.ts:258`
- `type Decimal = InstanceType<DecimalClass>` — Instance type of break_eternity's `Decimal`, re-exported under the engine's canonical name. `src/primitives/decimal.ts:39`
- `type DecimalSource = Decimal | number | string` — Anything bn accepts — a live `Decimal`, a `number`, or a numeric string. `src/primitives/decimal.ts:41`
- `function format(num: DecimalSource, precision?: number, small?: boolean): string` — Smart format that chooses the best representation based on magnitude. `src/primitives/decimal.ts:578`
- `function formatSmall(num: DecimalSource, precision?: number): string` — Format a number, always showing very small numbers. `src/primitives/decimal.ts:711`
- `function formatTime(seconds: DecimalSource): string` — Format a duration in seconds to a human-readable string. `src/primitives/decimal.ts:657`
- `function formatWhole(num: DecimalSource): string` — Format a number as a whole number (no decimals unless small). `src/primitives/decimal.ts:629`
- `function integerRoot(x: DecimalSource, degree: number): Decimal` — The floored integer `degree`-th root of `x` — the largest integer `m` with `mᵈᵉᵍʳᵉᵉ ≤ x`, returned as a Decimal. `src/primitives/decimal.ts:498`
- `type IntegerRoot` — Diagnosed result of tryIntegerRoot. `src/primitives/decimal.ts:387`
- `function toNumber(x: DecimalSource): number` — Coerce a DecimalSource to a native number. `src/primitives/decimal.ts:269`
- `function tryIntegerRoot(x: DecimalSource, degree: number): IntegerRoot` — The floored integer `degree`-th root of `x`, **graded** — the same answer integerRoot returns, plus whether the representation could actually resolve it. `src/primitives/decimal.ts:425`

## Notation

re-exports eternal_notations as the engine's notation layer

- `const HTMLPresets` — This object is where all of the notation presets are stored. `src/primitives/notations.ts`
- `const Notation: typeof _Notation` — Abstract base class for notation formats — re-exported from `eternal_notations`. `src/primitives/notations.ts:18`
- `const notationManager: NotationManager` — Global notation manager instance. `src/primitives/notation-manager.ts:92`
- `class NotationManager` — Singleton-style registry that controls which Notation `format()` uses for `Decimal` rendering. `src/primitives/notation-manager.ts:31`
- `const Presets` — This object is where all of the notation presets are stored. `src/primitives/notations.ts`

## RNG

seedable pseudo-random number generator and weighted-item picker

- `function chance(probability: number, rng?: () => number): boolean` — Return `true` with the given probability (clamped 0..1 by RNG output). `src/primitives/rng.ts:215`
- `function createSeededRNG(seed: number): () => number` — Returns an independent seeded RNG closure. `src/primitives/rng.ts:138`
- `function getRNGState(): RNGState` — Capture the module-global RNG state. `src/primitives/rng.ts:110`
- `function getSeed(): number` — Return the seed last passed to seedRNG, or the entropy seed the stream started from before any call. `src/primitives/rng.ts:147`
- `function random(): number` — Draw the next value in [0, 1) from the module-global RNG, which is entropy-seeded until seedRNG is called. `src/primitives/rng.ts:155`
- `function randomInt(min: number, max: number, rng?: () => number): number` — Draw an integer in `[min, max]` inclusive. `src/primitives/rng.ts:164`
- `function randomItem<T>(array: readonly T[], rng?: () => number): T | undefined` — Pick one element uniformly at random from `array`, or `undefined` if empty. `src/primitives/rng.ts:172`
- `interface RNGState` — Opaque snapshot of the module-global RNG's internal state. `src/primitives/rng.ts:96`
- `function seedRNG(seed: number): void` — Reseed the module-global RNG. `src/primitives/rng.ts:86`
- `function setRNGState(state: RNGState): void` — Restore the module-global RNG to a previously captured state. `src/primitives/rng.ts:125`
- `function shuffle<T>(array: readonly T[], rng?: () => number): T[]` — Return a new array with `array`'s elements in random order (Fisher–Yates). `src/primitives/rng.ts:181`
- `function weightedPick<T>(items: readonly WeightedItem<T>[], rng?: () => number): T | undefined` — Pick one item from a weighted list. `src/primitives/rng.ts:196`

## Resource

the fundamental currency of incremental games

- `function addResource(resource: Resource<DecimalSource>, amount: DecimalSource, chain?: Modifier): void` — Add an amount to a resource. `src/core/resource.ts:390`
- `function bulkTransfer(from: ResourceBag, to: ResourceBag, amounts: Record<string, DecimalSource>, allOrNothing?: boolean): Record<string, Decimal>` — Transfer multiple resource types between bags in one operation. `src/core/resource-bag.ts:456`
- `type CapacitySource = DecimalSource | (() => DecimalSource)` — A capacity value that can be static or a reactive getter. `src/core/resource-bag.ts:18`
- `function createResource<T>(existingRef: Ref<T>, options?: ResourceOptions): Resource<T>` — Wrap an existing ref as a resource (non-persistent). `src/core/resource.ts:142`
- `function createResource<T>(defaultValue: T, options: IfSerializable<T, PersistentResourceOptions>): Resource<T> & Persistent<T> & { [PersistentAlias]: Resource<T>; }` — Create a persistent resource — the standard way to define a game currency. `src/core/resource.ts:169`
- `function createResourceBag(options?: ResourceBagOptions): ResourceBag` — Creates a multi-type resource container with optional per-type and total capacity limits. `src/core/resource-bag.ts:150`
- `function displayResource(resource: Resource, overrideAmount?: DecimalSource): string` — Format a resource value with its configured precision. `src/core/resource.ts:361`
- `function hasResource(resource: Resource<DecimalSource>, amount: DecimalSource): boolean` — Check if a resource has at least a certain amount. `src/core/resource.ts:453`
- `type PersistentResourceOptions` — Configuration for a persistent createResource: `id` is required. `src/core/resource.ts:115`
- `function resetResource<T extends DecimalSource>(resource: Resource<T>): void` — Reset a resource to its default value (or zero). `src/core/resource.ts:462`
- `interface Resource<T = DecimalSource> extends Ref<T>` — A named, quantifiable game value backed by a Vue ref. `src/core/resource.ts:51`
- `interface ResourceBag` — A multi-type resource container with optional capacity limits and reactive Resource linking. `src/core/resource-bag.ts:60`
- `interface ResourceBagOptions` — Options for configuring a resource bag at creation time. `src/core/resource-bag.ts:41`
- `interface ResourceOptions` — Configuration for createResource. `src/core/resource.ts:97`
- `function subtractResource(resource: Resource<DecimalSource>, amount: DecimalSource, options?: SubtractResourceOptions): boolean` — Subtract an amount from a resource, failing gracefully if insufficient. `src/core/resource.ts:424`
- `interface SubtractResourceOptions` `src/core/resource.ts:405`
- `function transferBetweenBags(from: ResourceBag, to: ResourceBag, typeId: string, amount: DecimalSource): Decimal` — Move up to `amount` of `typeId` from one ResourceBag to another, clamped by both the source's available stock and the destination's remaining capacity. `src/core/resource-bag.ts:431`
- `function unwrapResource(resource: Resource | Ref<Resource>): Resource` — Unwrap a resource that may or may not be inside a ref. `src/core/resource.ts:376`

## Conversion

atomic multi-resource transformation

- `interface Conversion` — A conversion instance returned by createConversion. `src/systems/conversion.ts:92`
- `interface ConversionOptions<I extends Record<string, Requirement> = Record<string, Requirement>, O extends Record<string, ConversionOutput> = Record<string, ConversionOutput>>` `src/systems/conversion.ts:71`
- `interface ConversionOutput` — One output of a conversion: which Resource gets the gain, and how much. `src/systems/conversion.ts:63`
- `function createConversion<I extends Record<string, Requirement>, O extends Record<string, ConversionOutput>>(options: ConversionOptions<I, O>): Conversion` — Create a conversion that atomically transforms input resources into output resources. `src/systems/conversion.ts:171`
