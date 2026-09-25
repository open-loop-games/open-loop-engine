# Composition

Substrate the content systems compose against. `CategoryBase` + `ContentRegistry` are the meta-shape every batch-registration category extends; `Sequencer` is the shared ordered-dispatch primitive.

## Canonical entrypoints

- `createCategoryBase` — build a custom batch-registration category when built-ins do not fit.
- `createContentRegistry` — hold patchable content definitions for mods and registration.
- `createSequencer` and fill strategies — ordered queues, rotations, persona dispatch, and task scheduling.

## Category Base

shared skeleton for batch-registration categories

- `interface CategoryBase<Def extends { id: string; }, Instance, State = void> extends ResettableObject` — The shared base returned by createCategoryBase. `src/systems/category-base.ts:118`
- `interface CategoryBaseOptions<Def extends { id: string; }, Instance, State = void>` `src/systems/category-base.ts:84`
- `interface CategoryEntry<Def extends { id: string; }, Instance, State = void>` — A registered entry in a category: definition + instance + optional state + optional signals. `src/systems/category-base.ts:76`
- `interface CategoryEntrySignals` — Uniform per-entry introspection axes — the engine's cohesive cross-cut over heterogeneous category types. `src/systems/category-base.ts:59`
- `function createCategoryBase<Def extends { id: string; }, Instance, State = void>(options: CategoryBaseOptions<Def, Instance, State>): CategoryBase<Def, Instance, State>` — Create the shared category base — registry + entry map + persistent context. `src/systems/category-base.ts:170`

## Content Registry

generic typed registry for game content definitions

- `interface ContentRegistry<T extends { id: string; }>` — A typed, Map-backed registry for game content definitions. `src/systems/content-registry.ts:39`
- `function createContentRegistry<T extends { id: string; }>(name: string): ContentRegistry<T>` — Create a new content registry for a specific content type. `src/systems/content-registry.ts:103`

## Sequencer

core primitive for ordered execution of items with optional metadata

- `interface ConditionalRule<M = void>` — A rule mapping a boolean condition to a sequencer item. `src/core/sequencer-strategies.ts:36`
- `function createCompositeStrategy<M = void>(...strategies: FillStrategy<M>[]): FillStrategy<M>` — Chain multiple strategies with first-match semantics. `src/core/sequencer-strategies.ts:154`
- `function createConditionalStrategy<M = void>(getRules: () => ConditionalRule<M>[]): FillStrategy<M>` — Pick the first item whose condition evaluates to `true` (top-to-bottom). `src/core/sequencer-strategies.ts:71`
- `function createPriorityStrategy<M = void>(getCandidates: () => (SequencerItem<M> & { priority: number; })[]): FillStrategy<M>` — Pick the highest-priority candidate each time. `src/core/sequencer-strategies.ts:95`
- `function createRoundRobinStrategy<M = void>(id: string, getCandidates: () => SequencerItem<M>[]): FillStrategy<M>` — Cycle through candidates in round-robin order. `src/core/sequencer-strategies.ts:120`
- `function createSequencer<M = void>(options: SequencerOptions<M>): Sequencer<M>` — Creates a persistent sequencer that manages ordered execution of items, supporting both FIFO queue mode and repeating list mode with cursor. `src/core/sequencer.ts:388`
- `interface FillStrategy<M = void>` — Strategy for automatically filling the sequencer when it runs dry. `src/core/sequencer.ts:62`
- `type RegisterTick = (callback: (dt: number) => void) => () => void` — Tick registration function — matches `EngineContext.onTick` signature. `src/core/sequencer.ts:55`
- `interface Sequencer<M = void>` — Sequencer instance produced by createSequencer. `src/core/sequencer.ts:171`
- `interface SequencerEvents<M = void>` — Events emitted during sequencer lifecycle. `src/core/sequencer.ts:68`
- `interface SequencerItem<M = void>` — A sequencer entry: string ID plus typed metadata. `src/core/sequencer.ts:35`
- `interface SequencerOptions<M = void>` — Configuration for createSequencer. `src/core/sequencer.ts:102`
- `type StartResult = 'now' | 'notNow' | 'never'` — Tri-state precondition result from a SequencerOptions.canRun check. `src/core/sequencer.ts:52`
