# Composition

Substrate the content systems compose against. `CategoryBase` + `ContentRegistry` + `Feature` form the meta-shape every batch-registration category extends; `Sequencer` (with fill strategies) and `Worker` are reusable composition primitives used by both engine and content layers. Start here when building a new category factory or composing a custom registration surface.

## Canonical entrypoints

Start with these public symbols before scanning the full inventory below.

- `createCategoryBase` — build a custom batch-registration category when built-ins do not fit.
- `createContentRegistry` — hold patchable content definitions for mods and registration.
- `createSequencer` and fill strategies — ordered queues, rotations, persona dispatch, and task scheduling.
- `createWorker` — identity wrapper over a sequencer plus timed progress for indirect-control workers.

## Category Base

shared skeleton for batch-registration categories

- `interface CategoryBase<Def extends { id: string; }, Instance, State = void> extends ResettableObject` — The shared base returned by createCategoryBase. `src/systems/category-base.ts:119`
- `interface CategoryBaseOptions<Def extends { id: string; }, Instance, State = void>` — Options for createCategoryBase. `src/systems/category-base.ts:85`
- `interface CategoryEntry<Def extends { id: string; }, Instance, State = void>` — A registered entry in a category: definition + instance + optional state + optional signals. `src/systems/category-base.ts:77`
- `interface CategoryEntrySignals` — Uniform per-entry introspection axes — the engine's cohesive cross-cut over heterogeneous category types. `src/systems/category-base.ts:60`
- `function createCategoryBase<Def extends { id: string; }, Instance, State = void>(options: CategoryBaseOptions<Def, Instance, State>): CategoryBase<Def, Instance, State>` — Create the shared category base — registry + entry map + persistent context. `src/systems/category-base.ts:171`

## Content Registry

generic typed registry for game content definitions

- `interface ContentRegistry<T extends { id: string; }>` — A typed, Map-backed registry for game content definitions. `src/systems/content-registry.ts:39`
- `function createContentRegistry<T extends { id: string; }>(name: string): ContentRegistry<T>` — Create a new content registry for a specific content type. `src/systems/content-registry.ts:103`

## Feature

base types and utilities for game features

- `interface BaseFeature` — Base properties that all features have after creation. `src/core/feature.ts:177`
- `interface BaseFeatureOptions` — Base options that all features can have. `src/core/feature.ts:166`
- `function computeCondition(condition: Computable<boolean>): ComputedRef<boolean>` — Create a computed boolean indicating if a feature meets some condition. `src/core/feature.ts:279`
- `function computeVisibility(visibility: Computable<Visibility | boolean> | undefined): ComputedRef<boolean>` — Create a computed boolean indicating if a feature is visible. `src/core/feature.ts:262`
- `function createBaseFeature<T extends BaseFeatureOptions>(featureName: string, type: symbol, options: T): BaseFeature` — Create base feature properties from options. `src/core/feature.ts:195`
- `function excludeFeatures(obj: Record<string, unknown>, ...types: symbol[]): unknown[]` — Traverse an object recursively and collect all features that are NOT of the specified types. `src/core/feature.ts:133`
- `function findFeatures(obj: object, ...types: symbol[]): unknown[]` — Traverse an object recursively and collect all features of the specified types. `src/core/feature.ts:97`
- `interface FirstFeatureResult<T>` — Result of filtering features with getFirstFeature. `src/core/feature.ts:211`
- `type GenericFeature` — Generic feature with visibility that can be required or optional. `src/core/feature.ts:301`
- `function getFirstFeature<T extends { visibility?: MaybeRef<Visibility | boolean>; }>(features: T[], filter: (feature: T) => boolean): FirstFeatureResult<T>` — Filter features and get access to the first one separately. `src/core/feature.ts:239`
- `function getUniqueID(prefix?: string): string` — Gets a unique ID for a feature. `src/core/feature.ts:30`
- `function isFeature(value: unknown): value is BaseFeature` — Check if something is a feature (has a symbol type property). `src/core/feature.ts:288`
- `function isType<T extends symbol>(object: unknown, type: T): object is { type: T; }` — Check if an object is a specific type of feature. `src/core/feature.ts:78`
- `function resetUniqueID(): void` — Reset the ID counter. `src/core/feature.ts:37`
- `enum Visibility` — Visibility states for features and components. `src/core/feature.ts:46`
- `type WithRequired<T, K extends keyof T>` — Make certain properties of a type required. `src/core/feature.ts:309`

## Sequencer

core primitive for ordered execution of items with optional metadata

- `interface ConditionalRule<M = void>` — A rule mapping a boolean condition to a sequencer item. `src/core/sequencer-strategies.ts:22`
- `function createCompositeStrategy<M = void>(...strategies: FillStrategy<M>[]): FillStrategy<M>` — Chain multiple strategies with first-match semantics. `src/core/sequencer-strategies.ts:144`
- `function createConditionalStrategy<M = void>(getRules: () => ConditionalRule<M>[]): FillStrategy<M>` — Pick the first item whose condition evaluates to `true` (top-to-bottom). `src/core/sequencer-strategies.ts:61`
- `function createPriorityStrategy<M = void>(getCandidates: () => (SequencerItem<M> & { priority: number; })[]): FillStrategy<M>` — Pick the highest-priority candidate each time. `src/core/sequencer-strategies.ts:85`
- `function createRoundRobinStrategy<M = void>(id: string, getCandidates: () => SequencerItem<M>[]): FillStrategy<M>` — Cycle through candidates in round-robin order. `src/core/sequencer-strategies.ts:110`
- `function createSequencer<M = void>(options: SequencerOptions<M>): Sequencer<M>` — Creates a persistent sequencer that manages ordered execution of items, supporting both FIFO queue mode and repeating list mode with cursor. `src/core/sequencer.ts:295`
- `interface FillStrategy<M = void>` — Strategy for automatically filling the sequencer when it runs dry. `src/core/sequencer.ts:56`
- `type RegisterTick = (callback: (dt: number) => void) => () => void` — Tick registration function — matches `EngineContext.onTick` signature. `src/core/sequencer.ts:49`
- `interface Sequencer<M = void>` — Sequencer instance produced by createSequencer. `src/core/sequencer.ts:146`
- `interface SequencerEvents<M = void>` — Events emitted during sequencer lifecycle. `src/core/sequencer.ts:62`
- `interface SequencerItem<M = void>` — A sequencer entry: string ID plus optional typed metadata. `src/core/sequencer.ts:29`
- `interface SequencerOptions<M = void>` — Configuration for createSequencer. `src/core/sequencer.ts:86`
- `type StartResult = 'now' | 'notNow' | 'never'` — Tri-state precondition result from a SequencerOptions.canRun check. `src/core/sequencer.ts:46`

## Worker

pure identity container over a Sequencer + TimedProgress + task lookup

- `function createWorker<TaskDef extends { id: string; }>(options: WorkerOptions<TaskDef>): Worker<TaskDef>` — Creates a pure identity container binding a sequencer, a progress tracker, and a task lookup into one addressable unit. `src/systems/worker.ts:107`
- `function isWorker<TaskDef extends { id: string; } = { id: string; }>(value: unknown): value is Worker<TaskDef>` — Type guard for Worker instances. `src/systems/worker.ts:135`
- `interface Worker<TaskDef extends { id: string; }>` — A named execution unit built by createWorker. `src/systems/worker.ts:61`
- `interface WorkerOptions<TaskDef extends { id: string; }>` — Configuration for createWorker. `src/systems/worker.ts:45`
- `const WorkerType: unique symbol` — Symbol identifying Worker instances. `src/systems/worker.ts:42`
