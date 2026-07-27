# Resources

Numeric foundation and the named-quantity factory. `Decimal` arithmetic, formatting, randomness, and notations sit underneath `createResource`, which produces the reactive game values everything else reads. Conversion and resource bags layer on top. Start here when modelling a new countable quantity.

## Canonical entrypoints

Start with these public symbols before scanning the full inventory below.

- `createResource` — define a named game quantity with persistence and display metadata.
- `addResource` / `subtractResource` / `hasResource` / `displayResource` — mutate, check, and present resources through the standard helpers.
- `Resource.cumulative` / `Resource.best` — read lifetime gain and high-water trackers created with persistent resources.
- `createResourceBag` — manage a generic multi-resource container; use `createInventory` for item-facing gameplay.
- `createConversion` — model atomic recipes, trades, and prestige-style exchanges.

## Decimal

Big number utilities using break_eternity.js Provides Decimal type and formatting functions for large/small numbers

- `function bn(x: DecimalSource): Decimal` — Create a Decimal from a number, string, or Decimal. `src/primitives/decimal.ts:237`
- `type Decimal = OrigDecimal` — Instance type of break_eternity's `Decimal`, re-exported under the engine's canonical name. `src/primitives/decimal.ts:37`
- `type DecimalSource = OrigDecimal | number | string` — Anything toDecimal accepts — a live `Decimal`, a `number`, or a numeric string. `src/primitives/decimal.ts:35`
- `function format(num: DecimalSource, precision?: number, small?: boolean): string` — Smart format that chooses the best representation based on magnitude. `src/primitives/decimal.ts:556`
- `function formatSmall(num: DecimalSource, precision?: number): string` — Format a number, always showing very small numbers. `src/primitives/decimal.ts:685`
- `function formatTime(seconds: DecimalSource): string` — Format a duration in seconds to a human-readable string. `src/primitives/decimal.ts:635`
- `function formatWhole(num: DecimalSource): string` — Format a number as a whole number (no decimals unless small). `src/primitives/decimal.ts:607`
- `function integerRoot(x: DecimalSource, degree: number): Decimal` — The floored integer `degree`-th root of `x` — the largest integer `m` with `mᵈᵉᵍʳᵉᵉ ≤ x`, returned as a Decimal. `src/primitives/decimal.ts:476`
- `type IntegerRoot` — Diagnosed result of tryIntegerRoot. `src/primitives/decimal.ts:365`
- `function toNumber(x: DecimalSource): number` — Coerce a DecimalSource to a native number. `src/primitives/decimal.ts:247`
- `function tryIntegerRoot(x: DecimalSource, degree: number): IntegerRoot` — The floored integer `degree`-th root of `x`, **graded** — the same answer integerRoot returns, plus whether the representation could actually resolve it. `src/primitives/decimal.ts:403`

## Notation

re-exports eternal_notations as the engine's notation layer

- `const HTMLPresets` — This object is where all of the notation presets are stored. `src/primitives/notations.ts`
- `const Notation: typeof _Notation` — Abstract base class for notation formats — re-exported from `eternal_notations`. `src/primitives/notations.ts:18`
- `const notationManager: NotationManager` — Global notation manager instance. `src/primitives/notation-manager.ts:92`
- `class NotationManager` — Singleton-style registry that controls which Notation `format()` uses for `Decimal` rendering. `src/primitives/notation-manager.ts:31`
- `const Presets` — This object is where all of the notation presets are stored. `src/primitives/notations.ts`

## RNG

seedable pseudo-random number generator and weighted-item picker

- `function chance(probability: number, rng?: () => number): boolean` — Return `true` with the given probability (clamped 0..1 by RNG output). `src/primitives/rng.ts:201`
- `function createSeededRNG(seed: number): () => number` — Returns an independent seeded RNG closure. `src/primitives/rng.ts:131`
- `function getRNGState(): RNGState` — Capture the module-global RNG state. `src/primitives/rng.ts:103`
- `function getSeed(): number` — Return the seed last passed to seedRNG (0 before any call). `src/primitives/rng.ts:136`
- `function random(): number` — Draw the next value in [0, 1) from the module-global RNG. `src/primitives/rng.ts:141`
- `function randomInt(min: number, max: number, rng?: () => number): number` — Draw an integer in `[min, max]` inclusive. `src/primitives/rng.ts:150`
- `function randomItem<T>(array: readonly T[], rng?: () => number): T | undefined` — Pick one element uniformly at random from `array`, or `undefined` if empty. `src/primitives/rng.ts:158`
- `interface RNGState` — Opaque snapshot of the module-global RNG's internal state. `src/primitives/rng.ts:89`
- `function seedRNG(seed: number): void` — Reseed the module-global RNG. `src/primitives/rng.ts:79`
- `function setRNGState(state: RNGState): void` — Restore the module-global RNG to a previously captured state. `src/primitives/rng.ts:118`
- `function shuffle<T>(array: readonly T[], rng?: () => number): T[]` — Return a new array with `array`'s elements in random order (Fisher–Yates). `src/primitives/rng.ts:167`
- `function weightedPick<T>(items: readonly WeightedItem<T>[], rng?: () => number): T | undefined` — Pick one item from a weighted list. `src/primitives/rng.ts:182`

## Resource

the fundamental currency of incremental games

- `function addResource(resource: Resource<DecimalSource>, amount: DecimalSource, chain?: Modifier): void` — Add an amount to a resource. `src/core/resource.ts:313`
- `function bulkTransfer(from: ResourceBag, to: ResourceBag, amounts: Record<string, DecimalSource>, allOrNothing?: boolean): Record<string, Decimal>` — Transfer multiple resource types between bags in one operation. `src/core/resource-bag.ts:452`
- `type CapacitySource = DecimalSource | (() => DecimalSource)` — A capacity value that can be static or a reactive getter. `src/core/resource-bag.ts:17`
- `function createResource<T>(existingRef: Ref<T>, options?: ResourceOptions): Resource<T>` — Wrap an existing ref as a resource (non-persistent). `src/core/resource.ts:131`
- `function createResourceBag(options?: ResourceBagOptions): ResourceBag` — Creates a multi-type resource container with optional per-type and total capacity limits. `src/core/resource-bag.ts:154`
- `function displayResource(resource: Resource, overrideAmount?: DecimalSource): string` — Format a resource value with its configured precision. `src/core/resource.ts:284`
- `function hasResource(resource: Resource<DecimalSource>, amount: DecimalSource): boolean` — Check if a resource has at least a certain amount. `src/core/resource.ts:376`
- `function resetResource<T extends DecimalSource>(resource: Resource<T>): void` — Reset a resource to its default value (or zero). `src/core/resource.ts:385`
- `interface Resource<T = DecimalSource> extends Ref<T>` — A named, quantifiable game value backed by a Vue ref. `src/core/resource.ts:48`
- `interface ResourceBag` — A multi-type resource container with optional capacity limits and reactive Resource linking. `src/core/resource-bag.ts:69`
- `interface ResourceBagOptions` — Options for configuring a resource bag at creation time. `src/core/resource-bag.ts:50`
- `interface ResourceOptions` — Configuration for createResource. `src/core/resource.ts:90`
- `function subtractResource(resource: Resource<DecimalSource>, amount: DecimalSource, options?: SubtractResourceOptions): boolean` — Subtract an amount from a resource, failing gracefully if insufficient. `src/core/resource.ts:347`
- `interface SubtractResourceOptions` — Options for subtractResource. `src/core/resource.ts:328`
- `function transferBetweenBags(from: ResourceBag, to: ResourceBag, typeId: string, amount: DecimalSource): Decimal` — Move up to `amount` of `typeId` from one ResourceBag to another, clamped by both the source's available stock and the destination's remaining capacity. `src/core/resource-bag.ts:427`
- `function unwrapResource(resource: Resource | Ref<Resource>): Resource` — Unwrap a resource that may or may not be inside a ref. `src/core/resource.ts:299`

## Conversion

atomic multi-resource transformation

- `interface Conversion` — A conversion instance returned by createConversion. `src/systems/conversion.ts:92`
- `interface ConversionOptions<I extends Record<string, Requirement> = Record<string, Requirement>, O extends Record<string, ConversionOutput> = Record<string, ConversionOutput>>` — Options for createConversion. `src/systems/conversion.ts:71`
- `interface ConversionOutput` — One output of a conversion: which Resource gets the gain, and how much. `src/systems/conversion.ts:63`
- `function createConversion<I extends Record<string, Requirement>, O extends Record<string, ConversionOutput>>(options: ConversionOptions<I, O>): Conversion` — Create a conversion that atomically transforms input resources into output resources. `src/systems/conversion.ts:171`
