# Resources

Numeric foundation and the named-quantity factory. `Decimal` arithmetic, formatting, and randomness underneath `createResource`; conversion and resource bags on top. Start here for any new countable quantity.

## Canonical entrypoints

- `createResource` — define a named game quantity with persistence and display text.
- `addResource` / `subtractResource` / `hasResource` / `formatResource` — change, check and present resources through the standard utilities.
- `Resource.cumulative` / `Resource.best` — read the lifetime gain and the high-water mark of a persistent resource.
- `createResourceBag` — cap resources: per-type and total storage capacity, with `block` or `discard` overflow. `link` clamps a linked `Resource` on write. Use `createInventory` for item-facing gameplay.
- `randomItem` / `shuffle` / `weightedPick` / `chance` — random picks, draws and rolls, seedable through `seedRNG` or `createSeededRNG`.
- `createConversion` — model atomic recipes, trades, and prestige-style exchanges.

## Decimal

big-number arithmetic and formatting on break_eternity.js

- `function bn(x: DecimalSource): Decimal` — Create a Decimal from a number, string, or Decimal. `src/primitives/decimal.ts:299`
- `type Decimal = InstanceType<DecimalClass>` — Instance type of break_eternity's `Decimal`, re-exported under the engine's canonical name. `src/primitives/decimal.ts:42`
- `type DecimalSource = Decimal | number | string` — Anything bn accepts — a live `Decimal`, a `number`, or a numeric string. `src/primitives/decimal.ts:44`
- `function format(num: DecimalSource, decimals?: number, small?: boolean): string` — Smart format that chooses the best representation based on magnitude. `src/primitives/decimal.ts:622`
- `function formatSmall(num: DecimalSource, decimals?: number): string` — Format a number, always showing very small numbers. `src/primitives/decimal.ts:755`
- `function formatTime(seconds: DecimalSource): string` — Format a duration in seconds to a human-readable string. `src/primitives/decimal.ts:701`
- `function formatWhole(num: DecimalSource): string` — Format a number as a whole number (no decimals unless small). `src/primitives/decimal.ts:673`
- `function integerRoot(x: DecimalSource, degree: number): Decimal` — The floored integer `degree`-th root of `x` — the largest integer `m` with `mᵈᵉᵍʳᵉᵉ ≤ x`, returned as a Decimal. `src/primitives/decimal.ts:540`
- `type IntegerRoot` — Graded result of tryIntegerRoot. `src/primitives/decimal.ts:428`
- `function toNumber(x: DecimalSource): number` — Coerce a DecimalSource to a native number. `src/primitives/decimal.ts:310`
- `function tryIntegerRoot(x: DecimalSource, degree: number): IntegerRoot` — The floored integer `degree`-th root of `x`, **graded** — the same answer integerRoot returns, plus whether the representation could actually resolve it. `src/primitives/decimal.ts:466`

## Notation

re-exports eternal_notations as the engine's number notations

- `const HTMLPresets` — This object is where all of the notation presets are stored. `src/primitives/notations.ts`
- `const Notation: typeof _Notation` — Abstract base class for notations — re-exported from `eternal_notations`. `src/primitives/notations.ts:18`
- `const notationManager: NotationManager` — Global notation manager instance. `src/primitives/notation-manager.ts:92`
- `class NotationManager` — Singleton that holds the named notations and controls which Notation `format()` uses for a `Decimal`. `src/primitives/notation-manager.ts:31`
- `const Presets` — This object is where all of the notation presets are stored. `src/primitives/notations.ts`

## RNG

seedable pseudo-random number generator and weighted random choice

- `function chance(probability: number, rng?: () => number): boolean` — Return `true` with the given probability (clamped 0..1 by RNG output). `src/primitives/rng.ts:215`
- `function createSeededRNG(seed: number): () => number` — Returns an independent seeded RNG closure. `src/primitives/rng.ts:138`
- `function getRNGState(): RNGState` — Capture the global RNG state. `src/primitives/rng.ts:110`
- `function getSeed(): number` — Return the seed last passed to seedRNG, or the entropy seed the stream started from before any call. `src/primitives/rng.ts:147`
- `function random(): number` — Draw the next value in [0, 1) from the global RNG, which is entropy-seeded until seedRNG is called. `src/primitives/rng.ts:155`
- `function randomInt(min: number, max: number, rng?: () => number): number` — Draw an integer in `[min, max]` inclusive. `src/primitives/rng.ts:164`
- `function randomItem<T>(array: readonly T[], rng?: () => number): T | undefined` — Pick one element uniformly at random from `array`, or `undefined` if empty. `src/primitives/rng.ts:172`
- `interface RNGState` — Opaque snapshot of the global RNG's internal state. `src/primitives/rng.ts:96`
- `function seedRNG(seed: number): void` — Reseed the global RNG. `src/primitives/rng.ts:86`
- `function setRNGState(state: RNGState): void` — Restore the global RNG to a previously captured state. `src/primitives/rng.ts:125`
- `function shuffle<T>(array: readonly T[], rng?: () => number): T[]` — Return a new array with `array`'s elements in random order (Fisher–Yates). `src/primitives/rng.ts:181`
- `function weightedPick<T>(items: readonly WeightedItem<T>[], rng?: () => number): T | undefined` — Pick one item from a weighted list. `src/primitives/rng.ts:196`

## Resource

the reactive, saved quantities an incremental game is built on

- `function addResource(resource: Resource<DecimalSource>, amount: DecimalSource, chain?: Modifier): void` — Add an amount to a resource. `src/core/resource.ts:390`
- `type CapacitySource = Computable<DecimalSource>` — A capacity: a value, or a ref or getter for a reactive capacity. `src/core/resource-bag.ts:19`
- `function createResource<T>(existingRef: Ref<T>, options?: ResourceOptions): Resource<T>` — Wrap an existing ref as a resource that saves nothing. `src/core/resource.ts:142`
- `function createResource<T>(defaultValue: T, options: IfSerializable<T, PersistentResourceOptions>): Resource<T> & Persistent<T> & { [PersistentAlias]: Resource<T>; }` — Create a persistent resource — the standard way to define a game resource. `src/core/resource.ts:169`
- `function createResourceBag(options?: ResourceBagOptions): ResourceBag` — Create a container of amounts by item type, with an optional total capacity and optional per-type capacities. `src/core/resource-bag.ts:151`
- `function formatResource(resource: Resource, overrideAmount?: DecimalSource): string` — Format a resource's amount with its `decimals` and `small` settings. `src/core/resource.ts:361`
- `function hasResource(resource: Resource<DecimalSource>, amount: DecimalSource): boolean` — Check if a resource has at least a certain amount. `src/core/resource.ts:453`
- `type PersistentResourceOptions` — Options for a persistent createResource: `id` is required. `src/core/resource.ts:115`
- `function resetResource<T extends DecimalSource>(resource: Resource<T>): void` — Reset a resource to its ref default (or zero). `src/core/resource.ts:462`
- `interface Resource<T = DecimalSource> extends Ref<T>` — A named, quantifiable game value backed by a Vue ref. `src/core/resource.ts:51`
- `interface ResourceBag` — Amounts by item type, with optional capacities and reactive links to Resources. `src/core/resource-bag.ts:60`
- `interface ResourceBagOptions` — Options for configuring a resource bag at creation time. `src/core/resource-bag.ts:41`
- `interface ResourceOptions` `src/core/resource.ts:97`
- `function subtractResource(resource: Resource<DecimalSource>, amount: DecimalSource, options?: SubtractResourceOptions): boolean` — Subtract an amount from a resource, failing gracefully if insufficient. `src/core/resource.ts:424`
- `interface SubtractResourceOptions` `src/core/resource.ts:405`
- `function transferAmountsBetweenBags(from: ResourceBag, to: ResourceBag, amounts: Record<string, DecimalSource>, allOrNothing?: boolean): Record<string, Decimal>` — Transfer several item types between bags in one call. `src/core/resource-bag.ts:457`
- `function transferBetweenBags(from: ResourceBag, to: ResourceBag, typeId: string, amount: DecimalSource): Decimal` — Move up to `amount` of `typeId` from one ResourceBag to another, clamped by both the source's amount and the destination's remaining capacity. `src/core/resource-bag.ts:432`
- `function unwrapResource(resource: Resource | Ref<Resource>): Resource` — Unwrap a resource that may or may not be inside a ref. `src/core/resource.ts:376`

## Conversion

atomic multi-resource transformation

- `interface Conversion` — The conversion createConversion returns. `src/systems/conversion.ts:93`
- `interface ConversionOptions<I extends Record<string, Requirement> = Record<string, Requirement>, O extends Record<string, ConversionOutput> = Record<string, ConversionOutput>>` `src/systems/conversion.ts:71`
- `interface ConversionOutput` — One output of a conversion: which Resource gets the gain, and how much. `src/systems/conversion.ts:63`
- `function createConversion<I extends Record<string, Requirement>, O extends Record<string, ConversionOutput>>(options: ConversionOptions<I, O>): Conversion` — Create a conversion that atomically transforms input resources into output resources. `src/systems/conversion.ts:172`
