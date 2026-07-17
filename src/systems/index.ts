/**
 * Systems Layer — batteries-included assemblies of core primitives.
 *
 * Each module encodes a known incremental game pattern. If a system doesn't
 * fit your game, drop down to the core primitives it composes.
 */

// === RESETTABLE PROTOCOL ===
// Opt-in interface for objects (categories, collections) that yield persistent
// refs for recursive reset. Used by resetObject in the reset system.
export * from './resettable';

// === CATEGORY BASE ===
// Generic registry + per-def persistent context + Resettable wiring. The
// primitive that the per-system category factories build on. Use directly
// for consumer registries that don't fit any built-in category shape (pass
// Instance = void and omit buildInstance for pure per-def state).
export { createCategoryBase } from './category-base';
export type {
  CategoryBase,
  CategoryBaseOptions,
  CategoryEntry,
  CategoryEntrySignals,
} from './category-base';

// === ENGINE CATEGORIES ===
// EngineCategories accumulator + CategoriesKey injection. Self-populated by
// the five category factories at construction time; tooling reads via
// `engine.tryInject(CategoriesKey)` without any archetype-side publish step.
// Explicit named re-exports keep the `@internal` `with*`/`getCurrent*` helpers
// out of the published surface, matching the resource/chain/effect-system
// registry pattern in core/index.ts.
export type { EngineCategories } from './engine-categories';
export { CategoriesKey, findCategoryEntrySignals } from './engine-categories';

// === GATE ===
// Consumer-facing predicate-spec data shape over CategoryEntrySignals + ResourceRegistry +
// GameStateAccessor. Authored as plain data in content definitions; evaluated through
// evaluateGate, predicted through timeUntilGateFlip. `gateToCondition` is engine-internal
// (projects rate-aware Gate leaves to the ICondition IR for walker / predictor reuse).
export type {
  Gate,
  ResourceGteGate,
  CumulativeGteGate,
  CountGteGate,
  UnlockGate,
  StateGate,
  FlagGate,
  AllGate,
  AnyGate,
  NotGate,
  GateRuntime,
  GateRequirementOptions,
} from './gate';
export {
  evaluateGate,
  timeUntilGateFlip,
  getAmbientGateRuntime,
  isGate,
  createGateRequirement,
} from './gate';

// === PRESTIGE & RESET ===
// Reset: zero persistent refs in bulk. Conversion: transform one resource into another.
export * from './reset';
export * from './conversion';

// === DECLARATIVE BINDINGS ===
// Types used by category `grants` / `restricts` / `rewards` fields and by
// `ModifierChain.bind` / `bindings()`. Re-exported here so the
// `open-loop-engine/systems` entry point is self-contained for API extraction.
export type { BindOptions, BindingRecord, Grant } from '@/core/modifier';

// === PURCHASES ===
// Purchasable: unified purchase system (one-shot via limit:1, leveled, infinite).
// PurchasableCategory: batch-register Purchasables from content definitions.
// Raw `createPurchasable` is @internal — consumers use the category factory
// (L2 default) or `createScalingPurchasable` (L3 escape) instead.
export {
  createScalingPurchasable,
  type Purchasable,
  type PurchasableDisplay,
  type PurchasableEvents,
  type PurchasableOptions,
  type ScalingPurchasableCost,
  type ScalingPurchasableOptions,
} from './purchasable';
export * from './purchasable-category';

// === ACHIEVEMENTS ===
// Milestone tracking with auto-unlock conditions and tiered rewards.
// AchievementCategory: batch-register Achievements from content definitions,
// with `registerTiered` for threshold-ladder fanout. Raw `createAchievement`
// is @internal — consumers use the category factory.
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
// Resource generators: continuous (per-tick buildings) and manual (on-click).
// ProducerCategory: batch-register Producers from content definitions.
export * from './producer-category';

// === ACTIONS ===
// Ordered-execution queues with per-execution state machine. ActionCategory:
// batch-register typed action defs onto a Sequencer with engine-managed
// lifecycle / progress / attempt / error / timing per enqueued item, plus
// per-mapping tick closures for polymorphic dispatch.
export * from './action-category';

// === AUTO-PURCHASE ===
// Tick-driven helpers that automate Purchasable / Producer purchases under
// a selection policy. Sweep variant for upgrade lists, policy variant for
// producer chains. See `core/policy.ts` for the SelectionPolicy primitives
// these consume.
export * from './auto-purchase';

// === LOOP INCREMENTALS ===
// Loop: constrained-replay pattern (Idle Loops, Increlution, etc.)
// Skill: dual-tier XP/level with permanent bonus accumulation across loops.
// SkillCategory: batch-register Skills from content definitions.
// Retention: policies for what persists between loops.
// LoopLog: per-loop metric delta ring buffer for analytics.
// BestOf: per-metric best-of-run tracking with strategy snapshots.
// Recommendation: score-based inter-loop strategy arbitration over LoopLog + BestOf data.
export * from './loop';
export * from './loop-log';
export * from './best-of';
export * from './recommendation';
export * from './recommendation-strategies';
export * from './skill';
export * from './skill-category';
export * from './retention';

// === ECONOMY ===
// Inventory: typed item storage with capacity.
export * from './inventory';

// === TIME ===
// Time tracking, speed multipliers, and calendar/day systems.
export * from './time';

// === TIME BANK ===
// Banked-time reservoir (the fourth offline-progress family): deposit/withdraw
// core plus the live-acceleration and burst-discharge spend surfaces.
export * from './time-bank';

// === CHALLENGES ===
// Optional difficulty modifiers with enter/exit lifecycle and completion tracking.
// ChallengeCategory: batch-register Challenges from content definitions.
export * from './challenge-category';

// === CONTENT ===
// Generic typed registry for game content definitions (actions, zones, etc.).
export * from './content-registry';

// === TEMPORARY EFFECTS ===
// Time-limited effects (buffs, debuffs, DoTs, power-ups) with modifier integration.
export * from './temporary-effect';

// === PERSISTENT EFFECTS ===
// Condition-driven effects with modifier integration. Bindings track a reactive
// predicate; state is implicit in the game so load reconstruction is automatic.
export * from './persistent-effect';

// === MODIFIER BINDING HELPERS ===
// `ModifierBinding` shape (internal — inferred at consumer call sites) plus
// public factories that return `ModifierBinding[]` for common patterns.
// Sibling to temporary-effect / persistent-effect; consumers pass the factory
// output as the `modifiers` field on a def.
export * from './modifier-binding';

// === SLOTS ===
// Constrained persistent selection from a pool (equipment slots, spell slots, policy picks).
export * from './slot';

// === GOAL PICKER ===
// Weighted-goal selection over a candidate pool: sweep-completed + score + top-N fill.
// Composes Slot for persistence. Distinct from createConditionalStrategy (FillStrategy,
// sequencer-driven) and createRecommendationSystem (between-loop arbitration).
export * from './goal-picker';

// === RULE ADVISOR ===
// Intra-session profile-history advisor: aggregates LoopLog history into a
// profile, runs analyzer heuristics, surfaces a ranked + dismissable list of
// suggestions. Sibling to createRecommendationSystem along the time-horizon
// axis (RecommendationSystem = inter-loop; RuleAdvisor = intra-session).
export * from './rule-advisor';

// === CHARACTER INTERACTION ===
// Dialog: authored conversation graphs (DialogNode/DialogChoice/DialogGraph)
// + the engine-native runtime that walks them. Choice/node conditions accept
// Gate — predicates resolve via the ambient triple at evaluation.
// Dialog category: batch-register DialogGraph content per NPC / scene.
// Dialog session: wraps a DialogRuntime in a persistent envelope with
// lifecycle event emission. Default runtime is the engine-native walker;
// pass `runtimeFactory` to swap in an external adapter (Ink, Yarn, Ren'Py).
export * from './dialog';
export * from './dialog-category';
export * from './dialog-session';

// === SUBJECT CATEGORIES ===
// Addressable subjects (NPCs, factions, regions, single entities) with typed
// multi-field state under a shared schema. Field kinds: scalar / vector /
// tier / flag / enum. Replaces the prior variant-dispatched relationship
// category; `subject.fields.<name>` access is typed at the callsite, no
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
  type TierFieldDef,
  type FlagFieldDef,
  type EnumFieldDef,
  type ScalarFieldInstance,
  type VectorFieldInstance,
  type TierFieldInstance,
  type FlagFieldInstance,
  type EnumFieldInstance,
} from './subject-category';

// === ZONES ===
// Named content groupings (towns, chapters, eras) with progressive unlock.
export * from './zone';

// === AUTOMATION ===
// Tiered progressive unlock of automation features (manual → basic → conditional → priority).
export * from './automation';

// === WORKERS ===
// Pure identity container binding Sequencer + TimedProgress + task lookup into
// one addressable unit ("player", "clone-0", "predictor"). No behavior — the
// struct exposes its inputs plus currentTaskId/currentTask computeds.

// === CROSS-LAYER TYPE RE-EXPORTS ===

// Types from primitives and core that leak through systems' public API.
// Selective, not broad: `open-loop-engine/systems` stays focused on
// systems-layer symbols; consumers still import values from the layer that
// owns them.

export type {
  DecimalSource,
  IEffect,
  ResourceEffect,
  UnlockEffect,
  StateEffect,
  CompositeEffect,
  GameStateAccessor,
  Analyzer,
  AnalyzerResult,
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
  IntegrableFormula,
  InvertibleFormula,
  InvertibleIntegralFormula,
  EvaluateFunction,
  InvertFunction,
  IntegrateFunction,
  SubstitutionFunction,
  SubstitutionStack,
  Emittable,
  Computable,
  MaybeGetter,
  State,
  Persistent,
  NonPersistent,
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
