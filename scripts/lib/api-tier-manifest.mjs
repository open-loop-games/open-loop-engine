/**
 * API tier manifest — maps cluster ids to API tier files for the docs generator.
 *
 * One entry per API tier. `clusters` lists the cluster ids (from `@cluster`
 * TSDoc tags or stem fallback) that belong in that API tier; `scope` is the
 * paragraph that opens the API tier file. Re-clustering a symbol is a one-line
 * edit here — no code changes elsewhere.
 *
 * The generator (`build-api-docs.mjs`) validates that every cluster present
 * in the parser output appears in exactly one API tier's `clusters` array;
 * unassigned clusters fail the build.
 */

export const TIER_MANIFEST = [
  {
    tier: 'resources',
    title: 'Resources',
    scope:
      'Numeric foundation and the named-quantity factory. `Decimal` arithmetic, formatting, and randomness underneath `createResource`; conversion and resource bags on top. Start here for any new countable quantity.',
    entrypoints: [
      '`createResource` — define a named game quantity with persistence and display text.',
      '`addResource` / `subtractResource` / `hasResource` / `formatResource` — change, check and present resources through the standard utilities.',
      '`Resource.cumulative` / `Resource.best` — read the lifetime gain and the high-water mark of a persistent resource. `Resource.sinceReset` (opt in with `trackSinceReset`) is the gain since the last reset.',
      "`addRateSource` / `getRate` / `getRateSources` — a resource's rate per second, the sum of labeled rate sources. Producer categories add theirs, converter draws included.",
      '`createResourceBag` — cap resources: per-type and total storage capacity, with `block` or `discard` overflow. `link` clamps a linked `Resource` on write. It reads the capacity at once, so the inputs of a capacity getter must exist before `link`. Use `createInventory` for item-facing gameplay.',
      '`randomItem` / `shuffle` / `weightedPick` / `chance` — random picks, draws and rolls, seedable through `seedRNG` or `createSeededRNG`.',
      '`createConversion` — model atomic recipes, trades, and prestige-style exchanges.',
    ],
    clusters: ['decimal', 'notations', 'rng', 'resource', 'conversion'],
  },
  {
    tier: 'mechanics',
    title: 'Mechanics',
    scope:
      'The composable evaluation primitives: modifier chains, requirements, formulas, computed values, effects, Gates and trace. Pure evaluation plus reactive wrappers; the substrate the content systems build on.',
    entrypoints: [
      '`createModifierChain` plus `chain.bind` — shared modifier chains and attributed conditional modifiers.',
      '`createCostRequirement` / `createBooleanRequirement` — requirements with a cost, and requirements that only test.',
      '`F` / `Formula` / `calculateMaxAffordable` — cost curves, inversion and purchase max previews. End a cost curve in `.floor()` for whole-unit costs; purchase max still works.',
      '`Gate` / `E` — declarative predicates and effects, where save, mod or balance-harness data needs a serializable shape.',
      '`createFlag` — a saved or derived named boolean, which `flag` Gates, conditions and effects reach by id.',
      '`createTimedProgress` — tick-driven progress for actions, workers, and staged costs.',
    ],
    clusters: [
      'common',
      'computed',
      'effects',
      'flag',
      'formulas',
      'gate',
      'modifier',
      'requirements',
      'timed-progress',
      'trace',
    ],
  },
  {
    tier: 'composition',
    title: 'Composition',
    scope:
      'The substrate the content systems build on. `CategoryBase` + `ContentRegistry` are the meta-shape every batch-registration category extends. `Sequencer` is the shared ordered-queue primitive.',
    entrypoints: [
      '`createCategoryBase` — build a custom batch-registration category when built-ins do not fit.',
      '`createContentRegistry` — hold patchable defs for mods and registration.',
      '`createSequencer` and fill strategies — ordered queues, rotations, persona rotation and task scheduling.',
    ],
    clusters: ['category-base', 'content-registry', 'sequencer'],
  },
  {
    tier: 'content-systems',
    title: 'Content Systems',
    scope:
      'The validated incremental primitives, each a typed registration contract over the Mechanics API tier. Purchasable / Producer / Achievement / Inventory / BestOf handle resource flow. Skill / Cycle / Challenge / Zone / Loadout / AutomationTiers / CycleLog give long-arc structure. RunPool holds many concurrent pool runs at once.',
    entrypoints: [
      '`createProducerCategory` — producers, such as buildings, whose ownership creates continuous resource flow.',
      '`createPurchasableCategory` — upgrades, unlocks, capped repeatables, perks and purchased effects, registered in batch.',
      '`createAchievementCategory` — achievements and achievement ladders, earned automatically when their goals hold.',
      '`createSkillCategory` — XP and level progression.',
      '`createCycle`, `createChallengeCategory`, `createInventory`, `createZoneSystem`, `createLoadout`, `createAutomationTiers` — runs, challenges, inventory, zones, loadouts and automation tiers.',
      '`createActionCategory` — ordered-execution queues with per-execution state machine.',
    ],
    clusters: [
      'achievement',
      'action-category',
      'automation',
      'best-of',
      'challenge-category',
      'cycle',
      'cycle-log',
      'inventory',
      'producer-category',
      'purchasable',
      'run-pool',
      'skill',
      'loadout',
      'zone',
    ],
  },
  {
    tier: 'content-narrative',
    title: 'Narrative',
    scope:
      'Character-interaction systems: Dialog (authored dialog graphs, a native adapter, a swappable adapter contract) and Subject (named subjects with typed multi-field state). Specialized in incremental games, near-default in narrative-adjacent ones.',
    entrypoints: [
      '`createDialogCategory` — batch-register authored dialog graphs.',
      '`createDialogSession` — the saved envelope over one dialog adapter, which a UI drives.',
      '`createNativeDialogAdapter` / `DialogAdapter` — the default adapter, and the adapter contract for external dialog tools.',
      '`createSubjectCategory` — addressable subjects (NPCs, factions, regions, single named things) with typed multi-field state (scalar / vector / ladder / flag / enum).',
    ],
    clusters: ['dialog', 'subject-category'],
  },
  {
    tier: 'lifecycle',
    title: 'Lifecycle',
    scope:
      'Anything kept across play sessions or prestige resets: `withPersistentContext`, `createSaveManager` slots and save migration, `createReset` with retention, and offline catch-up.',
    entrypoints: [
      '`withPersistentContext` / `persistent` — create persistent refs under stable persistent contexts.',
      "`createReset` with `resetPersistentContexts` — reset a module's or a category's persistent contexts without listing every ref.",
      '`createRetention`, `keep` and `retain` — keep values through prestige resets.',
      '`createSaveManager` — multi-slot save and load, save migration, validation, import and export.',
      '`processOfflineTime` — replay offline time through the game loop in bounded chunks.',
      '`createTimeBank` with `createBankedAcceleration` / `burstDischarge` — deposit seconds into a time bank. Spend them as faster game speed, or replay them at once in a burst discharge (the banking offline-progress family).',
    ],
    clusters: ['offline', 'persistence', 'reset', 'resettable', 'retention', 'save', 'time-bank'],
  },
  {
    tier: 'runtime',
    title: 'Runtime',
    scope:
      'How an engine instance is assembled and ticks: `createEngine` and its module, event and save wiring. Also TickDriver (variable and fixed tick modes), the typed event emitter, throttle, play time, transition-distance math and the game-state accessor.',
    entrypoints: [
      '`createEngine` — assemble modules, TickDriver, persistence, events, registries, and mods.',
      '`EngineModule` / `EngineContext` — install/connect game content and share engine services.',
      '`createTickDriver` — standalone tick scheduler when not using the full engine facade.',
      '`createEmitHandle` — typed per-instance events for systems and categories.',
      '`timeUntilResource` / `timeUntilGateFlip` / `timeUntilAffordable` — transition-distance math for previews and walkers.',
      '`createGameStateAccessor` — an accessor over the resource registry plus your flags, state paths and rates; pass it to `createEngine({ accessor })`.',
      "`ref` / `computed` / `watch` / `effect` — Vue's reactivity API, re-exported. Import it from the engine, not from `vue`, so subscriptions share the engine's `activeEffect`.",
    ],
    clusters: [
      'engine',
      'reactivity',
      'events',
      'tick-driver',
      'game-state-accessor',
      'throttle',
      'time',
      'transitions',
    ],
  },
  {
    tier: 'introspection',
    title: 'Introspection',
    scope:
      'The cross-cutting "walk every X" API surface that external tools read: devtools, mods, balance workbenches. `EngineCategories`, the per-engine registries, `tunable()` with the override and tuning registries, the profiler and safeguard diagnostics. All are reachable through injection keys.',
    entrypoints: [
      '`EngineCategories` / `CategoriesKey` — discover auto-registered content categories.',
      '`createOverrideRegistry` / `createTuningRegistry` / `tunable` — expose designer-approved tunables.',
      '`ChainRegistryKey`, `ResourceRegistryKey`, `EffectSystemRegistryKey`, `FlagRegistryKey` — the chain, resource, effect-system and flag registries for tools, read through `engine.tryInject` or `ctx.inject`.',
      '`enableProfiling` / `getProfileReport` — profile engine calls.',
      '`enableDevMode` / `getSafeguardDiagnostics` — dev-mode safeguards and safeguard diagnostics.',
    ],
    clusters: ['engine-categories', 'override-registry', 'profiler', 'registries', 'safeguards'],
  },
  {
    tier: 'advisors',
    title: 'Advisors',
    scope:
      'Decision-support systems that observe the engine and rank actions: rule advisor, goal picker, recommendation system, and the selection policies they share. Candidates are abstract. Build board-based ones from influence layer readings in spatial.md.',
    entrypoints: [
      '`selectionCheapest`, `selectionPaybackPeriod`, `selectionHybridPayback`, `selectionComposite` — choose among candidates.',
      '`createGoalPicker` — pick weighted goals from a candidate pool.',
      '`createRecommendationSystem` — rank recommenders between runs, and present the winner.',
      '`createRuleAdvisor` — reduce history to a digest, and present ranked suggestions.',
    ],
    clusters: ['goal-picker', 'policy', 'recommendation', 'rule-advisor'],
  },
  {
    tier: 'spatial',
    title: 'Spatial',
    scope:
      'Coordinate primitives for adjacency-driven games: grid, graph, scope stack and influence layer. Headless: adjacency and traversal, no rendering. Rank influence through advisors.md to steer a unit.',
    entrypoints: [
      '`createSpatialGrid` — bounded coordinate grids with adjacency, BFS, FOV updates and a serialized form. Cells are not reactive; a computed reads `grid.gridVersion` to recompute after each write. `findOpen` returns a random matching cell, from the seeded RNG.',
      '`createGraph` — arbitrary node/edge topology with nested child graphs.',
      '`createScopeStack` — track the graph scope entered in a nested graph.',
      '`createInfluenceLayer` — propagation and decay over a numeric grid.',
    ],
    clusters: ['spatial-grid', 'graph', 'spatial-scope-stack', 'spatial-influence-layer'],
  },
  {
    tier: 'harness',
    title: 'Harness',
    scope:
      'The balance harness: runners, probes, transition walkers, the picker, solvers, perturbation and analyzers. Game code never imports it; probes and balance workbenches do.',
    entrypoints: [
      '`runHeadless` / `runUntil` — deterministic headless runs over a fixed tick count, or bounded by an until-predicate.',
      "`replayLive` / `createTickCounter` — replay the live loop's dt cadence, scaled by game speed, deterministically. Count ticks to assert that fixed tick mode is invariant to game speed.",
      '`runMatrix`, `runMatrixUntil`, `runSensitivity` — multi-cell, multi-seed balance sweeps.',
      '`createPickerSnapshot` / `applyPerturbation` — enumerate and perturb tunables/modifiers.',
      '`createTransitionSnapshot` / `createIncrementalSnapshot` — find upcoming content transitions.',
      '`bisectTuner` — tune one value until its fire time meets a target.',
    ],
    clusters: [
      'analyzers',
      'flow-channel',
      'headless',
      'perturbation',
      'picker',
      'probe',
      'runners',
      'solve',
      'types',
      'walker',
    ],
  },
];
