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

- `function bn(x: DecimalSource): Decimal` — Create a Decimal from a number, string, or Decimal. `src/primitives/decimal.ts:169`
- `type Decimal = OrigDecimal` — Instance type of break_eternity's `Decimal`, re-exported under the engine's canonical name. `src/primitives/decimal.ts:32`
- `type DecimalSource = OrigDecimal | number | string` — Anything toDecimal accepts — a live `Decimal`, a `number`, or a numeric string. `src/primitives/decimal.ts:30`
- `function format(num: DecimalSource, precision?: number, small?: boolean): string` — Smart format that chooses the best representation based on magnitude. `src/primitives/decimal.ts:259`
- `function formatSmall(num: DecimalSource, precision?: number): string` — Format a number, always showing very small numbers. `src/primitives/decimal.ts:388`
- `function formatTime(seconds: DecimalSource): string` — Format a duration in seconds to a human-readable string. `src/primitives/decimal.ts:338`
- `function formatWhole(num: DecimalSource): string` — Format a number as a whole number (no decimals unless small). `src/primitives/decimal.ts:310`
- `function toNumber(x: DecimalSource): number` — Coerce a DecimalSource to a native number. `src/primitives/decimal.ts:179`

## Notation

re-exports eternal_notations as the engine's notation layer

- `const HTMLPresets` — This object is where all of the notation presets are stored. `src/primitives/notations.ts`
- `const Notation: typeof _Notation` — Abstract base class for notation formats — re-exported from `eternal_notations`. `src/primitives/notations.ts:18`
- `const notationManager: NotationManager` — Global notation manager instance. `src/primitives/notation-manager.ts:92`
- `class NotationManager` — Singleton-style registry that controls which Notation `format()` uses for `Decimal` rendering. `src/primitives/notation-manager.ts:31`
- `const Presets` — This object is where all of the notation presets are stored. `src/primitives/notations.ts`

## RNG

seedable pseudo-random number generator and weighted-item picker

- `function chance(probability: number): boolean` — Return `true` with the given probability (clamped 0..1 by RNG output). `src/primitives/rng.ts:176`
- `function createSeededRNG(seed: number): () => number` — Returns an independent seeded RNG closure. `src/primitives/rng.ts:124`
- `function getRNGState(): RNGState` — Capture the module-global RNG state. `src/primitives/rng.ts:96`
- `function getSeed(): number` — Return the seed last passed to seedRNG (0 before any call). `src/primitives/rng.ts:129`
- `function random(): number` — Draw the next value in [0, 1) from the module-global RNG. `src/primitives/rng.ts:134`
- `function randomInt(min: number, max: number): number` — Draw an integer in `[min, max]` inclusive from the module-global RNG. `src/primitives/rng.ts:139`
- `function randomItem<T>(array: readonly T[]): T | undefined` — Pick one element uniformly at random from `array`, or `undefined` if empty. `src/primitives/rng.ts:144`
- `interface RNGState` — Opaque snapshot of the module-global RNG's internal state. `src/primitives/rng.ts:82`
- `function seedRNG(seed: number): void` — Reseed the module-global RNG. `src/primitives/rng.ts:72`
- `function setRNGState(state: RNGState): void` — Restore the module-global RNG to a previously captured state. `src/primitives/rng.ts:111`
- `function shuffle<T>(array: readonly T[]): T[]` — Return a new array with `array`'s elements in random order (Fisher–Yates). `src/primitives/rng.ts:150`
- `function weightedPick<T>(items: readonly WeightedItem<T>[]): T | undefined` — Pick one item from a weighted list. `src/primitives/rng.ts:163`

## Resource

the fundamental currency of incremental games

- `function addResource(resource: Resource<DecimalSource>, amount: DecimalSource, chain?: Modifier): void` — Add an amount to a resource. `src/core/resource.ts:306`
- `function bulkTransfer(from: ResourceBag, to: ResourceBag, amounts: Record<string, DecimalSource>, allOrNothing?: boolean): Record<string, Decimal>` — Transfer multiple resource types between bags in one operation. `src/core/resource-bag.ts:441`
- `type CapacitySource = DecimalSource | (() => DecimalSource)` — A capacity value that can be static or a reactive getter. `src/core/resource-bag.ts:17`
- `function createResource<T>(defaultValue: T & StateConstraint<T>, options?: ResourceOptions): Resource<T> & Persistent<T> & { [NonPersistent]: Resource<T>; }` — Create a persistent resource — the standard way to define a game currency. `src/core/resource.ts:131`
- `function createResourceBag(options?: ResourceBagOptions): ResourceBag` — Creates a multi-type resource container with optional per-type and total capacity limits. `src/core/resource-bag.ts:154`
- `function displayResource(resource: Resource, overrideAmount?: DecimalSource): string` — Format a resource value with its configured precision. `src/core/resource.ts:277`
- `function hasResource(resource: Resource<DecimalSource>, amount: DecimalSource): boolean` — Check if a resource has at least a certain amount. `src/core/resource.ts:369`
- `function resetResource<T extends DecimalSource>(resource: Resource<T>): void` — Reset a resource to its default value (or zero). `src/core/resource.ts:378`
- `interface Resource<T = DecimalSource> extends Ref<T>` — A named, quantifiable game value backed by a Vue ref. `src/core/resource.ts:48`
- `interface ResourceBag` — A multi-type resource container with optional capacity limits and reactive Resource linking. `src/core/resource-bag.ts:69`
- `interface ResourceBagOptions` — Options for configuring a resource bag at creation time. `src/core/resource-bag.ts:50`
- `interface ResourceOptions` — Configuration for createResource. `src/core/resource.ts:90`
- `function subtractResource(resource: Resource<DecimalSource>, amount: DecimalSource, options?: SubtractResourceOptions): boolean` — Subtract an amount from a resource, failing gracefully if insufficient. `src/core/resource.ts:340`
- `interface SubtractResourceOptions` — Options for subtractResource. `src/core/resource.ts:321`
- `function transferBetweenBags(from: ResourceBag, to: ResourceBag, typeId: string, amount: DecimalSource): Decimal` — Move up to `amount` of `typeId` from one ResourceBag to another, clamped by both the source's available stock and the destination's remaining capacity. `src/core/resource-bag.ts:416`
- `function unwrapResource(resource: Resource | Ref<Resource>): Resource` — Unwrap a resource that may or may not be inside a ref. `src/core/resource.ts:292`

## Conversion

atomic multi-resource transformation

- `interface Conversion` — A conversion instance returned by createConversion. `src/systems/conversion.ts:73`
- `interface ConversionOptions<I extends Record<string, Requirement> = Record<string, Requirement>, O extends Record<string, ConversionOutput> = Record<string, ConversionOutput>>` — Options for createConversion. `src/systems/conversion.ts:52`
- `interface ConversionOutput` — One output of a conversion: which Resource gets the gain, and how much. `src/systems/conversion.ts:44`
- `const ConversionType: unique symbol` — Symbol identifying Conversion features. `src/systems/conversion.ts:35`
- `function createConversion<I extends Record<string, Requirement>, O extends Record<string, ConversionOutput>>(options: ConversionOptions<I, O>): Conversion` — Create a conversion that atomically transforms input resources into output resources. `src/systems/conversion.ts:140`
- `function createLogFormula(base?: DecimalSource, scale?: DecimalSource): (x: DecimalSource) => DecimalSource` — Create a logarithmic formula: `floor(log_base(x / scale))`. `src/systems/conversion.ts:240`
- `function createPolynomialFormula(exponent?: DecimalSource, scale?: DecimalSource): (x: DecimalSource) => DecimalSource` — Create a polynomial formula: `floor((x / scale) ^ exponent)`. `src/systems/conversion.ts:256`
- `function createSqrtFormula(scale?: DecimalSource): (x: DecimalSource) => DecimalSource` — Create a square-root formula: `floor(√(x / scale))`. `src/systems/conversion.ts:228`
- `function isConversion(value: unknown): value is Conversion` — Type guard: returns `true` if the value is a Conversion instance. `src/systems/conversion.ts:268`
