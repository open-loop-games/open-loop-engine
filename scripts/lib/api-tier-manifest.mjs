/**
 * Tier manifest — maps cluster ids to tier files for the docs generator.
 *
 * One entry per tier. `clusters` lists the cluster ids (from `@cluster`
 * source tags or stem fallback) that belong in that tier; `scope` is the
 * paragraph that opens the tier file. Re-clustering a symbol is a one-line
 * edit here — no code changes elsewhere.
 *
 * The generator (`build-api-docs.mjs`) validates that every cluster present
 * in the parser output appears in exactly one tier's `clusters` array;
 * unassigned clusters fail the build.
 */

export const TIER_MANIFEST = [
  {
    tier: 'resources',
    title: 'Resources',
    scope:
      'Numeric foundation and the named-quantity factory. `Decimal` arithmetic, formatting, and randomness underneath `createResource`; conversion and resource bags on top. Start here for any new countable quantity.',
    entrypoints: [
      '`createResource` — define a named game quantity with persistence and display metadata.',
      '`addResource` / `subtractResource` / `hasResource` / `displayResource` — mutate, check, and present resources through the standard helpers.',
      '`Resource.cumulative` / `Resource.best` — read lifetime gain and high-water trackers created with persistent resources.',
      '`createResourceBag` — cap resources: per-type and total storage capacity with a block or destroy overflow, and `link` clamps a linked `Resource` on write. Use `createInventory` for item-facing gameplay.',
      '`randomItem` / `shuffle` / `weightedPick` / `chance` — random picks, draws and rolls, seedable through `seedRNG` or `createSeededRNG`.',
      '`createConversion` — model atomic recipes, trades, and prestige-style exchanges.',
    ],
    clusters: ['decimal', 'notations', 'rng', 'resource', 'conversion'],
  },
  {
    tier: 'mechanics',
    title: 'Mechanics',
    scope:
      'The composable evaluation kernel — modifier chains, requirements, formulas, computed bindings, effects, gates, trace. Pure evaluation plus reactive wrappers; the substrate content systems compose against.',
    entrypoints: [
      '`createModifierChain` plus `chain.bind` — shared bonus surfaces and attributed conditional modifiers.',
      '`createCostRequirement` / `createBooleanRequirement` — spend-bearing and predicate-only requirements.',
      '`F` / `Formula` / `calculateMaxAffordable` — cost curves, inversion, and max-buy previews.',
      '`Gate` / `E` — declarative predicates and effects when save/mod/sim data needs serializable shape.',
      '`createTimedProgress` — tick-driven progress for actions, workers, and staged costs.',
    ],
    clusters: [
      'common',
      'computed',
      'effects',
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
      'Substrate the content systems compose against. `CategoryBase` + `ContentRegistry` are the meta-shape every batch-registration category extends; `Sequencer` is the shared ordered-dispatch primitive.',
    entrypoints: [
      '`createCategoryBase` — build a custom batch-registration category when built-ins do not fit.',
      '`createContentRegistry` — hold patchable content definitions for mods and registration.',
      '`createSequencer` and fill strategies — ordered queues, rotations, persona dispatch, and task scheduling.',
    ],
    clusters: ['category-base', 'content-registry', 'sequencer'],
  },
  {
    tier: 'content-systems',
    title: 'Content Systems',
    scope:
      'The validated incremental primitives, each a typed registration surface over the mechanics kernel. Purchasable / Producer / Achievement / Inventory / BestOf carry currency flow; Skill / Cycle / Challenge / Zone / Slot / AutomationTiers / CycleLog carry long-arc structure; RunPool holds many concurrent runs at once.',
    entrypoints: [
      '`createProducerCategory` — buildings/generators whose ownership creates continuous resource flow.',
      '`createPurchasableCategory` — upgrades, gates, capped repeatables, perks, and bought effects in batch.',
      '`createAchievementCategory` — observed milestones and tier ladders that auto-earn.',
      '`createSkillCategory` — XP/level progression surfaces.',
      '`createCycle`, `createChallengeCategory`, `createInventory`, `createZoneSystem`, `createSlot`, `createAutomationTiers` — progression, inventory, grouping, selection, and automation surfaces.',
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
      'slot',
      'zone',
    ],
  },
  {
    tier: 'content-narrative',
    title: 'Narrative',
    scope:
      'Character-interaction systems: Dialog (authored conversation graphs, native runtime, swappable adapter contract) and Subject (named entities with typed multi-field state). Specialized in incremental games, near-default in narrative-adjacent ones.',
    entrypoints: [
      '`createDialogCategory` — batch-register authored conversation graphs.',
      '`createDialogSession` — persistent UI/runtime envelope for driving dialog.',
      '`createNativeDialogRuntime` / `DialogRuntime` — default runtime and adapter contract for external dialog tools.',
      '`createSubjectCategory` — addressable subjects (NPCs, factions, regions, single entities) with typed multi-field state (scalar / vector / tier / flag / enum).',
    ],
    clusters: ['dialog', 'subject-category'],
  },
  {
    tier: 'lifecycle',
    title: 'Lifecycle',
    scope:
      'Anything that crosses a session boundary or a prestige reset — `withPersistentContext` namespacing, `createSaveManager` slots and migration, `createReset` with retention policies, offline catch-up.',
    entrypoints: [
      '`withPersistentContext` / `persistent` — create save-owned refs under stable namespaces.',
      '`createReset` with `resetPersistentContexts` — reset module/category scopes without manually listing every ref.',
      '`createRetention`, `keep`, and `retain` — carry values across prestige resets.',
      '`createSaveManager` — multi-slot save/load, migration, validation, import, and export.',
      '`processOfflineTime` — replay elapsed time through the game loop in bounded chunks.',
      '`createTimeBank` with `createBankedAcceleration` / `burstDischarge` — bank time into a reservoir and spend it as a live speed boost or an instant fast-forward (the banking offline-progress family).',
    ],
    clusters: ['offline', 'persistence', 'reset', 'resettable', 'retention', 'save', 'time-bank'],
  },
  {
    tier: 'runtime',
    title: 'Runtime',
    scope:
      'How an engine assembles and ticks. `createEngine` and the module/event/save wiring, TickDriver (variable-dt and fixed-step), typed event emitter, throttle, play-clock, transition-distance math, the ambient accessor context.',
    entrypoints: [
      '`createEngine` — assemble modules, TickDriver, persistence, events, registries, and mods.',
      '`EngineModule` / `EngineContext` — install/connect game content and share engine services.',
      '`createTickDriver` — standalone tick scheduler when not using the full engine facade.',
      '`createEmitHandle` — typed per-instance events for systems and categories.',
      '`timeUntilResource` / `timeUntilGateFlip` / `timeUntilAffordable` — transition-distance math for previews and walkers.',
      "`ref` / `computed` / `watch` / `effect` (re-exported from Vue) — reactivity API; import via the engine, not directly from `vue`, so subscriptions share the engine's `activeEffect` scope.",
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
      'The cross-cutting "walk every X" surface external tools read — devtools, mods, balance workbenches. `EngineCategories`, per-engine registries, `tunable()` plus the override/tuning registries, profiler and safeguards. All reachable through injection keys.',
    entrypoints: [
      '`EngineCategories` / `CategoriesKey` — discover auto-registered content categories.',
      '`createOverrideRegistry` / `createTuningRegistry` / `tunable` — expose designer-approved balance knobs.',
      '`ChainRegistryKey`, `ResourceRegistryKey`, `EffectSystemRegistryKey` — per-engine enumerable surfaces for tools, read through `engine.tryInject` or `ctx.inject`.',
      '`enableProfiling` / `getProfileReport` — runtime timing instrumentation.',
      '`enableDevMode` / `getDiagnostics` — development safeguards and diagnostics.',
    ],
    clusters: ['engine-categories', 'override-registry', 'profiler', 'registries', 'safeguards'],
  },
  {
    tier: 'advisors',
    title: 'Advisors',
    scope:
      'Decision-support systems that observe the engine and rank actions: rule advisor, goal picker, recommendation system, and the selection policies they share. Candidates are abstract — build map-based ones from spatial.md influence readings.',
    entrypoints: [
      '`selectionCheapest`, `selectionPaybackPeriod`, `selectionHybridPayback`, `selectionComposite` — choose among candidates.',
      '`createGoalPicker` — pick weighted goals from a candidate pool.',
      '`createRecommendationSystem` — arbitrate and surface strategies between loop runs.',
      '`createRuleAdvisor` — aggregate history and surface ranked suggestions.',
    ],
    clusters: ['goal-picker', 'policy', 'recommendation', 'rule-advisor'],
  },
  {
    tier: 'spatial',
    title: 'Spatial',
    scope:
      'Coordinate primitives for adjacency-driven games — grid, graph, scope stack, influence layer. Headless: adjacency and traversal, no rendering. Rank the fields through advisors.md to steer an agent.',
    entrypoints: [
      '`createSpatialGrid` — bounded coordinate boards with adjacency, BFS, FOV adapter, and snapshots.',
      '`createSpatialGraph` — arbitrary node/edge topology with nested child graphs.',
      '`createScopeStack` — active-scope navigation over recursive graphs.',
      '`createInfluenceLayer` — propagation/decay over a numeric grid.',
    ],
    clusters: ['spatial-grid', 'spatial-graph', 'spatial-scope-stack', 'spatial-influence-layer'],
  },
  {
    tier: 'harness',
    title: 'Harness',
    scope:
      'Headless-sim substrate: runners, probes, content walkers, the picker, solvers, perturbation, analyzers. Separable — game code never imports harness; balance tooling does.',
    entrypoints: [
      '`runHeadless` / `runUntil` — deterministic fixed-tick and predicate-bounded simulations.',
      '`replayLive` / `createTickCounter` — replay live-play dt cadence (speed-scaled) deterministically; count sub-ticks for fixed-mode speed-invariance assertions.',
      '`runMatrix`, `runMatrixUntil`, `runSensitivity` — multi-cell, multi-seed balance sweeps.',
      '`createPickerSnapshot` / `applyPerturbation` — enumerate and perturb tunables/modifiers.',
      '`createTransitionSnapshot` / `createIncrementalSnapshot` — find upcoming content transitions.',
      '`bisectTuner` — tune a single parameter until an event fires at a target time.',
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
