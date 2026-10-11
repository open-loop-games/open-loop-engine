# Composition

The substrate the content systems build on. `CategoryBase` + `ContentRegistry` are the meta-shape every batch-registration category extends. `Sequencer` is the shared ordered-queue primitive.

## Canonical entrypoints

- `createCategoryBase` — build a custom batch-registration category when built-ins do not fit.
- `createContentRegistry` — hold patchable defs for mods and registration.
- `createSequencer` and fill strategies — ordered queues, rotations, persona rotation and task scheduling.

## Category Base

shared skeleton for batch-registration categories

- `interface CategoryBase<Def extends { id: string; }, Instance, DefState = void> extends ResettableObject` — The shared base returned by createCategoryBase. `src/systems/category-base.ts:114`
- `interface CategoryBaseOptions<Def extends { id: string; }, Instance, DefState = void>` `src/systems/category-base.ts:80`
- `interface CategoryEntry<Def extends { id: string; }, Instance, DefState = void>` — A category entry: the record a category keeps per def — its def, instance, optional def state and optional signals. `src/systems/category-base.ts:72`
- `interface CategoryEntrySignals` — Uniform per-entry introspection axes — the engine's cohesive cross-cut over heterogeneous category types. `src/systems/category-base.ts:55`
- `function createCategoryBase<Def extends { id: string; }, Instance, DefState = void>(options: CategoryBaseOptions<Def, Instance, DefState>): CategoryBase<Def, Instance, DefState>` — Create the shared category base — registry + category-entry map + persistent context. `src/systems/category-base.ts:174`

## Content Registry

generic typed registry for game content defs

- `interface ContentRegistry<T extends { id: string; }>` — A typed, Map-backed registry for game content defs. `src/systems/content-registry.ts:44`
- `type ContentRegistryView<T extends { id: string; }>` — A ContentRegistry without `register` — what a category exposes as its `registry`. `src/systems/content-registry.ts:111`
- `function createContentRegistry<T extends { id: string; }>(registryId: string): ContentRegistry<T>` — Create a new content registry for a specific content type. `src/systems/content-registry.ts:147`

## Sequencer

core primitive for ordered execution of items with optional metadata

- `interface ConditionalRule<M = void>` — A rule mapping a boolean condition to a sequencer item. `src/core/sequencer-strategies.ts:37`
- `function createCompositeStrategy<M = void>(...strategies: FillStrategy<M>[]): FillStrategy<M>` — Chain multiple strategies with first-match semantics. `src/core/sequencer-strategies.ts:157`
- `function createConditionalStrategy<M = void>(getRules: () => ConditionalRule<M>[]): FillStrategy<M>` — Pick the first item whose condition evaluates to `true` (top-to-bottom). `src/core/sequencer-strategies.ts:72`
- `function createPriorityStrategy<M = void>(getCandidates: () => (SequencerItem<M> & { priority: number; })[]): FillStrategy<M>` — Pick the highest-priority candidate each time. `src/core/sequencer-strategies.ts:96`
- `function createRoundRobinStrategy<M = void>(id: string, getCandidates: () => SequencerItem<M>[]): FillStrategy<M>` — Cycle through candidates in round-robin order. `src/core/sequencer-strategies.ts:121`
- `function createSequencer<M = void>(options: SequencerOptions<M>): Sequencer<M>` — Creates a persistent sequencer that manages ordered execution of items, supporting both FIFO queue mode and repeating list mode with cursor. `src/core/sequencer.ts:407`
- `interface FillStrategy<M = void>` — Fill strategy: the sequencer's next-item chooser when it has nothing to run. `src/core/sequencer.ts:74`
- `type RegisterTick = (callback: (dt: number) => void) => () => void` — Tick registration — subscribes a tick handler and returns its unsubscribe. `src/core/sequencer.ts:67`
- `interface Sequencer<M = void>` — Sequencer instance produced by createSequencer. `src/core/sequencer.ts:184`
- `interface SequencerEvents<M = void>` — Events emitted during sequencer lifecycle. `src/core/sequencer.ts:80`
- `interface SequencerItem<M = void>` — A sequencer item: a string id plus typed metadata. `src/core/sequencer.ts:37`
- `interface SequencerOptions<M = void>` `src/core/sequencer.ts:113`
- `type StartResult = 'now' | 'notNow' | 'never'` — Tri-state precondition result from a SequencerOptions.canStart check. `src/core/sequencer.ts:54`
