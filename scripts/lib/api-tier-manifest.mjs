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
      'Numeric foundation and the named-quantity factory. `Decimal` arithmetic, formatting, randomness, and notations sit underneath `createResource`, which produces the reactive game values everything else reads. Conversion and resource bags layer on top. Start here when modelling a new countable quantity.',
    entrypoints: [
      '`createResource` — define a named game quantity with persistence and display metadata.',
      '`addResource` / `subtractResource` / `hasResource` / `displayResource` — mutate, check, and present resources through the standard helpers.',
      '`Resource.cumulative` / `Resource.best` — read lifetime gain and high-water trackers created with persistent resources.',
      '`createResourceBag` — manage a generic multi-resource container; use `createInventory` for item-facing gameplay.',
      '`createConversion` — model atomic recipes, trades, and prestige-style exchanges.',
    ],
    clusters: ['decimal', 'notations', 'rng', 'resource', 'conversion'],
  },
  {
    tier: 'mechanics',
    title: 'Mechanics',
    scope:
      'The composable evaluation kernel. Modifier chains, requirements, formulas, computed bindings, conditions, effects, gates, and trace. Pure-function evaluation (no Vue dependency in the core) plus reactive wrappers — the substrate the content systems compose against.',
    entrypoints: [
      '`createModifierChain` plus `chain.bind` — shared bonus surfaces and attributed conditional modifiers.',
      '`createCostRequirement` / `createBooleanRequirement` — spend-bearing and predicate-only requirements.',
      '`F` / `Formula` / `calculateMaxAffordable` — cost curves, inversion, and max-buy previews.',
      '`Gate` / `E` — declarative predicates and effects when save/mod/sim data needs serializable shape.',
      '`createTimedProgress` — tick-driven progress for actions, workers, and staged costs.',
    ],
    clusters: [
      'beat-timing',
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
      'Substrate the content systems compose against. `CategoryBase` + `ContentRegistry` form the meta-shape every batch-registration category extends; `Sequencer` (with fill strategies) is the reusable composition primitive used by both engine and content layers. Start here when building a new category factory or composing a custom registration surface.',
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
      'Currency-flow and long-arc structure systems — the validated incremental-game primitives. Purchasable / Producer / Achievement / Inventory / BestOf for economy; Skill / Loop / Challenge / Zone / Slot / AutomationTiers / LoopLog for progression. Each is a typed registration surface over the mechanics kernel; category factories batch-register many definitions.',
    entrypoints: [
      '`createProducerCategory` — buildings/generators whose ownership creates continuous resource flow.',
      '`createPurchasableCategory` — upgrades, gates, capped repeatables, perks, and bought effects in batch.',
      '`createAchievementCategory` — observed milestones and tier ladders that auto-earn.',
      '`createSkillCategory` — XP/level progression surfaces.',
      '`createLoop`, `createChallengeCategory`, `createInventory`, `createZoneSystem`, `createSlot`, `createAutomationTiers` — progression, inventory, grouping, selection, and automation surfaces.',
      '`createActionCategory` — ordered-execution queues with per-execution state machine.',
    ],
    clusters: [
      'achievement',
      'action-category',
      'automation',
      'best-of',
      'challenge-category',
      'inventory',
      'loop',
      'loop-log',
      'producer-category',
      'purchasable',
      'skill',
      'slot',
      'zone',
    ],
  },
  {
    tier: 'content-narrative',
    title: 'Narrative',
    scope:
      'Tier-4 character-interaction systems — specialized in incremental games, near-default in narrative-adjacent codebases. Dialog (authored conversation graphs + native runtime + swappable adapter contract) and Subject (addressable named entities with typed multi-field state). Both compose engine substrate (conditions, effects, gates) into save-friendly drivers.',
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
      'Save/load, reset cascades, persistent refs, offline catch-up, retention policies. Anything that crosses session boundaries or prestige resets. `withPersistentContext` is the namespacing primitive every save-touching factory uses; `createSaveManager` is the multi-slot envelope; `createReset` carries retention rules between prestige tiers.',
    entrypoints: [
      '`withPersistentContext` / `persistent` — create save-owned refs under stable namespaces.',
      '`createReset` with `resetModules` — reset module/category scopes without manually listing every ref.',
      '`createRetentionPolicy`, `keep`, and `retain` — carry values across prestige resets.',
      '`createSaveManager` — multi-slot save/load, migration, validation, import, and export.',
      '`processOfflineTime` — replay elapsed time through the game loop in bounded chunks.',
    ],
    clusters: ['offline', 'persistence', 'reset', 'resettable', 'retention', 'save'],
  },
  {
    tier: 'runtime',
    title: 'Runtime',
    scope:
      'The runtime substrate every engine carries. `createEngine` and the module/event/save wiring; the TickDriver (variable-dt and fixed-step modes); typed per-instance event emitter; throttle, time tracking, transition-distance math; the ambient game-state-accessor context. Start here to understand how an engine assembles and ticks.',
    entrypoints: [
      '`createEngine` — assemble modules, TickDriver, persistence, events, registries, and mods.',
      '`EngineModule` / `EngineContext` — install/connect game content and share engine services.',
      '`createTickDriver` — standalone tick scheduler when not using the full engine facade.',
      '`createEmitHandle` — typed per-instance events for systems and categories.',
      '`timeUntilResource` / `timeUntilConditionFlip` / `timeUntilAffordable` — transition-distance math for previews and walkers.',
      '`ref` / `computed` / `watch` / `effect` (re-exported from Vue) — reactivity API; import via the engine, not directly from `vue`, so subscriptions share the engine\'s `activeEffect` scope.',
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
      'The cross-cutting "walk every X" surface external tools read — balance workbenches, sim pickers, devtools panels, mods. `EngineCategories` plus the per-engine registries (chain / resource / effect-system), the `OverrideRegistry` + `TuningRegistry` + `tunable()` pattern that exposes designer-flagged knobs, and the Profiler + Safeguards instrumentation. All discoverable via injection keys with no install-time coupling.',
    entrypoints: [
      '`EngineCategories` / `CategoriesKey` — discover auto-registered content categories.',
      '`createOverrideRegistry` / `createTuningRegistry` / `tunable` — expose designer-approved balance knobs.',
      '`createChainRegistry`, `createResourceRegistry`, `createEffectSystemRegistry` — per-engine enumerable surfaces for tools.',
      '`enableProfiling` / `getProfileReport` — runtime timing instrumentation.',
      '`enableDevMode` / `getDiagnostics` — development safeguards and diagnostics.',
    ],
    clusters: [
      'engine-categories',
      'override-registry',
      'profiler',
      'registries',
      'safeguards',
    ],
  },
  {
    tier: 'advisors',
    title: 'Advisors',
    scope:
      'Decision-support systems that observe the engine and rank or recommend actions. The rule advisor (aggregate history into ranked suggestions), goal picker (which goal to pursue next), recommendation system (curated next-actions for the player), and the selection policies they share.',
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
      'Coordinate-based primitives. Grid, graph, scope stack, influence layer. Used by board-state and adjacency-driven games — hex maps, dungeon layouts, factory grids. Headless: no rendering, just adjacency and traversal.',
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
      'Headless-sim substrate. Matrix and predicate-bounded runners, probes, content walkers, the picker for solver/UI enumeration, solvers (bisection), perturbation, analyzers, run pools, and typed harness contracts. Separable from the rest of the engine — game code never imports harness; balance tooling does.',
    entrypoints: [
      '`runHeadless` / `runUntil` — deterministic fixed-tick and predicate-bounded simulations.',
      '`replayLive` / `createTickCounter` — replay live-play dt cadence (speed-scaled) deterministically; count sub-ticks for fixed-mode speed-invariance assertions.',
      '`runMatrix`, `runMatrixUntil`, `runSensitivity` — multi-cell, multi-seed balance sweeps.',
      '`createPickerSnapshot` / `applyPerturbation` — enumerate and perturb tunables/modifiers.',
      '`createTransitionSnapshot` / `createIncrementalSnapshot` — find upcoming content transitions.',
      '`bisectTuner` — tune a single parameter against a predicate.',
    ],
    clusters: [
      'analyzers',
      'flow-channel',
      'headless',
      'perturbation',
      'picker',
      'probe',
      'run-pool',
      'runners',
      'solve',
      'types',
      'walker',
    ],
  },
]
