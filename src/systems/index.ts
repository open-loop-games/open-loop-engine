/**
 * Systems source layer — batteries-included assemblies of core primitives.
 *
 * Each file encodes a known incremental game pattern. If a system doesn't
 * fit your game, drop down to the core primitives it composes.
 */

// === RESETTABLE PROTOCOL ===
// Opt-in interface for objects (categories, stateful systems) that yield
// persistent refs for recursive reset. Used by resetObject in the reset system.
// Is in core so core primitives can implement it too; re-exported here by
// name (not `export *`) so the `@internal` `attachPersistentContextReset` stays internal.
export { Resettable, type ResettableObject } from '@/core/resettable';

// === CATEGORY BASE ===
// Generic registry + per-def persistent context + Resettable wiring. The
// primitive that the per-system category factories build on. Use directly
// for consumer registries that don't fit any built-in category shape (pass
// Instance = void and omit buildInstance for def state only).
export { createCategoryBase } from './category-base';
export type {
  CategoryBase,
  CategoryBaseOptions,
  CategoryEntry,
  CategoryEntrySignals,
} from './category-base';

// === ENGINE CATEGORIES ===
// EngineCategories collection + CategoriesKey injection. Self-populated by
// the category factories at construction time; tooling reads via
// `engine.tryInject(CategoriesKey)` without a publish step in any module.
// Explicit named re-exports keep the `@internal` `with*`/`getCurrent*` helpers
// out of the API surface, matching the resource/chain/effect-system
// registry pattern in core/index.ts.
export type { EngineCategories } from './engine-categories';
export { CategoriesKey, findCategoryEntrySignals } from './engine-categories';

// === GATE ===
// Gate: the typed, serializable yes/no test over CategoryEntrySignals + ResourceRegistry +
// GameStateAccessor. Authored as plain data in content defs; evaluated through
// evaluateGate, predicted through timeUntilGateFlip. `gateToCondition` is engine-internal
// (projects accessor-backed Gate leaves to the condition IR, `ICondition`, that E.branch embeds).
export type {
  Gate,
  ResourceGteGate,
  CumulativeGteGate,
  CountGteGate,
  ActiveGate,
  StateGate,
  FlagGate,
  AllGate,
  AnyGate,
  NotGate,
  GateServices,
  GateService,
  GateRequirementOptions,
  Predicate,
  AdoptedPredicate,
  PredicateResolver,
} from './gate';
export {
  evaluateGate,
  timeUntilGateFlip,
  getAmbientGateServices,
  getRequiredGateServices,
  assertGateServices,
  isGate,
  createGateRequirement,
  createPredicateResolver,
  evaluatePredicate,
} from './gate';

// === PRESTIGE & RESET ===
// Reset: zero persistent refs in bulk. Conversion: transform one resource into another.
export * from './reset';
export * from './conversion';

// === DECLARATIVE BINDINGS ===
// Types used by category `grants` / `restricts` / `rewards` fields and by
// `ModifierChain.bind` / `bindings()`. Re-exported here so the
// `@open-loop/engine/systems` subpath is self-contained for API extraction.
export type { BindOptions, BindingRecord, Grant } from '@/core/modifier';

// === PURCHASES ===
// Purchasable: unified purchase system (one-shot via limit:1, repeatable, infinite).
// PurchasableCategory: batch-register Purchasables from content defs.
// Raw `createPurchasable` is @internal — consumers use the category factory
// (L2 default) or `createScalingPurchasable` (L3) instead.
export {
  createScalingPurchasable,
  type Purchasable,
  type PurchasableDisplay,
  type PurchasableEvents,
  type PurchasableOptions,
  type ScalingPurchasableCost,
  type ScalingPurchasableEffect,
  type ScalingPurchasableOptions,
} from './purchasable';
export * from './purchasable-category';

// === ACHIEVEMENTS ===
// Achievements earned automatically when their goal holds, with ladder rewards.
// AchievementCategory: batch-register Achievements from content defs, with
// `registerLadder` turning one tracked value into the rungs of a ladder, one per threshold.
// Raw `createAchievement` is @internal — consumers use the category factory.
export {
  getCombinedAchievementEffect,
  getEarnedCount,
  type Achievement,
  type AchievementDisplay,
  type AchievementEvents,
  type AchievementOptions,
} from './achievement';
export * from './achievement-category';

// === PRODUCERS ===
// Producers: continuous (per-tick buildings) and manual (on-click).
// ProducerCategory: batch-register Producers from content defs.
export * from './producer-category';

// === ACTIONS ===
// Ordered-execution queues with per-execution state machine. ActionCategory:
// batch-register typed action defs onto a Sequencer with engine-managed
// lifecycle / progress / attempt / error / timing per enqueued item, plus
// per-mapping tick closures for polymorphic dispatch.
export * from './action-category';

// === AUTO-PURCHASE ===
// Tick-driven utilities that automate Purchasable / Producer purchases under
// a selection policy: `setupSweepAutoPurchase` for upgrade lists,
// `setupPolicyAutoPurchase` for producer chains. See `core/policy.ts` for the
// SelectionPolicy primitives these consume.
export * from './auto-purchase';

// === CYCLES AND RUNS ===
// Cycle: constrained-replay pattern
// Skill: XP and level per run, plus a lifetime bonus that accumulates across runs.
// SkillCategory: batch-register Skills from content defs.
// Retention: what a reset keeps or retains.
// CycleLog: a ring buffer of per-run tracked-metric changes, for analytics.
// BestOf: per-metric best-of-run tracking with configuration snapshots.
// Recommendation: score-based choice of a configuration between runs, over CycleLog + BestOf data.
export * from './cycle';
export * from './cycle-log';
export * from './best-of';
export * from './recommendation';
export * from './recommenders';
export * from './skill';
export * from './skill-category';
export * from './retention';

// === ECONOMY ===
// Inventory: typed item storage with capacity.
export * from './inventory';

// === TIME ===
// Play-time tracking.
export * from './time';

// === TIME BANK ===
// Time bank, an offline-progress family: the store of banked seconds. Deposit
// and withdraw, plus two ways to spend: live acceleration and burst discharge.
export * from './time-bank';

// === CHALLENGES ===
// Optional difficulty rules with enter/exit lifecycle and completion tracking.
// ChallengeCategory: batch-register Challenges from content defs.
export * from './challenge-category';

// === CONTENT ===
// Generic typed registry for game content defs (actions, zones, etc.).
// Named re-exports keep the `@internal` registry handle out of the API surface.
export {
  createContentRegistry,
  type ContentRegistry,
  type ContentRegistryView,
} from './content-registry';

// === TEMPORARY EFFECTS ===
// Time-limited effects (buffs, debuffs, DoTs, power-ups) with modifier integration.
export * from './temporary-effect';

// === CONDITIONAL EFFECTS ===
// Effects held while a predicate holds, with modifier integration. Their grants
// track a reactive predicate; their state follows from game state, so hydration
// is automatic.
export * from './conditional-effect';

// === REPLACEMENT GRANTS ===
// Factories that return `Grant[]` for common patterns. Sibling to
// temporary-effect / conditional-effect; consumers pass the factory output as
// the `grants` field on a def.
export { replacementGrants, type ReplacementGrantsOptions } from './replacement-grants';

// === LOADOUTS ===
// Constrained persistent selection from a candidate pool (equipment, spells, policy picks).
export * from './loadout';

// === GOAL PICKER ===
// Weighted-goal selection over a candidate pool: remove completed goals, score, fill the top N.
// Composes Loadout for persistence. Distinct from createConditionalStrategy (FillStrategy,
// sequencer-driven) and createRecommendationSystem (a choice between runs).
export * from './goal-picker';

// === RULE ADVISOR ===
// Within-play-session advisor: reduces CycleLog history to a digest, runs
// advisor analyzers over it, and presents a ranked, dismissable list of suggestions.
// Sibling to createRecommendationSystem along the time-horizon axis
// (RecommendationSystem = between runs; RuleAdvisor = within a play session).
export * from './rule-advisor';

// === CHARACTER INTERACTION ===
// Dialog: authored dialog graphs (DialogNode/DialogChoice/DialogGraph)
// + the native adapter that walks them (`createNativeDialogAdapter`). A node's
// or choice's `when` takes a Gate, evaluated against the ambient Gate services.
// Dialog category: batch-register DialogGraph content per NPC / scene.
// Dialog session: wraps a DialogAdapter with persistent state and lifecycle
// events. The default adapter is the native one; pass `adapterFactory` for an
// external adapter (Ink, Yarn, Ren'Py).
export * from './dialog';
export * from './dialog-category';
export * from './dialog-session';

// === SUBJECT CATEGORIES ===
// Addressable subjects (NPCs, factions, regions) with typed multi-field
// state under a shared schema. Field kinds: scalar / vector / ladder / flag /
// enum. `subject.fields.<name>` access is typed at the callsite, with no
// runtime narrowing. Auto-registers into `EngineCategories.subjects`.
export {
  createSubjectCategory,
  type SubjectCategory,
  type SubjectCategoryOptions,
  type SubjectCategoryEntry,
  type SubjectDef,
  type SubjectInstance,
  type FieldDef,
  type FieldSchema,
  type FieldInstance,
  type PerSubjectOverride,
  type ScalarFieldDef,
  type VectorFieldDef,
  type LadderFieldDef,
  type FlagFieldDef,
  type EnumFieldDef,
  type ScalarFieldInstance,
  type VectorFieldInstance,
  type LadderFieldInstance,
  type FlagFieldInstance,
  type EnumFieldInstance,
} from './subject-category';

// === ZONES ===
// Named content groupings (towns, chapters, eras) with progressive unlock.
export * from './zone';

// === AUTOMATION ===
// Automation tiers: an ordered unlock of automation features
// (manual → basic → conditional → priority).
export * from './automation';

// === TYPE RE-EXPORTS FROM LOWER SOURCE LAYERS ===

// Types from primitives and core that appear in systems' public API.
// Selective, not broad: `@open-loop/engine/systems` stays focused on
// systems symbols; consumers still import values from the source layer that
// owns them.

export type {
  DecimalSource,
  IEffect,
  ResourceEffect,
  FlagEffect,
  StateEffect,
  CompositeEffect,
  GameStateAccessor,
  Analyzer,
  AnalyzerSummary,
  InjectionKey,
  Resource,
  Modifier,
  ModifierDescription,
  ModifierChain,
  ModifierChainEvents,
  ResourceBag,
  Requirement,
  Requirements,
  GenericFormula,
  FormulaSource,
  FormulaOptions,
  VariableFormulaOptions,
  ConstantFormulaOptions,
  GeneralFormulaOptions,
  GuardedFormulasToDecimals,
  TupleGuard,
  FormulasToDecimals,
  Formula,
  EvaluateFunction,
  InvertFunction,
  IntegrateFunction,
  SubstitutionFunction,
  SubstitutionStack,
  Emittable,
  Computable,
  Serializable,
  Persistent,
  PersistentAlias,
  GameStateMutator,
  OverrideRegistry,
  RegisterTick,
  Sequencer,
  SequencerItem,
  SequencerEvents,
  StartResult,
  FillStrategy,
  SelectionPolicy,
  HybridPaybackOptions,
  HybridPaybackContext,
  TimedProgress,
  HeadlessResult,
} from '../core';
export { Decimal } from '../primitives/decimal';
