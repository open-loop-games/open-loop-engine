export * from './types';
export { createWorkPlan } from './work-plan';
export { computeMetricStats, diffAggregates } from './aggregate';
export { runMatrix } from './run-matrix';
export { runBatch } from './run-batch';
export { runSensitivity } from './run-sensitivity';
export { runUntil } from './run-until';
export { runMatrixUntil } from './run-matrix-until';
export { replayLive, createTickCounter } from './replay';
export type { ReplayLiveOptions, TickCounter } from './replay';
export { createSensitivityCell } from './create-sensitivity-cell';
export type { CreateSensitivityCellOptions } from './create-sensitivity-cell';
export {
  createResourcePeakTracker,
  createCycleFinalizeTracker,
  defaultAnalyzerPack,
  createSeriesTracker,
  seriesAnalyzerPack,
} from './analyzers';
export {
  createPickerSnapshot,
  type PickerSource,
  type PickerAddress,
  type ModifierPickerAddress,
  type TunablePickerAddress,
  type PickerEntry,
  type ModifierPickerEntry,
  type TunablePickerEntry,
  type PickerSnapshot,
} from './picker';
export { applyPerturbation, type Perturbation } from './perturbation';
export { classifyFlowChannel, getFlowChannelBoundaries, type FlowChannel } from './flow-channel';
export { runProbe, runWaypointProbe } from './probe';
export type {
  BeatProbe,
  BeatResult,
  ProbeConfig,
  Waypoint,
  WaypointSnapshot,
  WaypointProbeConfig,
} from './probe';
export { bisectTuner } from './solve';
export type { TunerConfig, TunerResult, Tuner } from './solve';
export { createTransitionSnapshot, createIncrementalSnapshot } from './walker';
export type {
  Transition,
  TransitionSource,
  TransitionSnapshot,
  IncrementalSnapshot,
  IncrementalSnapshotEntityRef,
} from './walker';

// === CROSS-LAYER TYPE RE-EXPORTS ===
// Harness surfaces types from every lower layer (engine build helpers,
// perturbation targets, sensitivity analyzers). Selective re-exports only;
// values live in their owning layer.

export type {
  DecimalSource,
  Analyzer,
  AnalyzerResult,
  InjectionKey,
  IEffect,
  UnlockEffect,
  StateEffect,
  CompositeEffect,
  State,
  Persistent,
  NonPersistent,
  Resource,
  ResourceEffect,
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
  IntegrableFormula,
  InvertibleFormula,
  InvertibleIntegralFormula,
  EvaluateFunction,
  InvertFunction,
  IntegrateFunction,
  SubstitutionFunction,
  SubstitutionStack,
  Computable,
  Formula,
  Modifier,
  ModifierDescription,
  ModifierChain,
  ModifierChainEvents,
  BindOptions,
  BindingRecord,
  Grant,
  MaybeGetter,
  Emittable,
  TickDriver,
  PhaseHooks,
  TickCallback,
  TimerProvider,
  GameStateAccessor,
  GameStateMutator,
  SaveManager,
  SaveLoadResult,
  SavePeek,
  SaveSlot,
  SaveEvents,
  SaveLoadFailureReason,
  StorageAdapter,
  HeadlessResult,
} from '../core';
export type {
  Achievement,
  AchievementDisplay,
  AchievementEvents,
  AchievementCategory,
  AchievementCategoryEntry,
  Challenge,
  ChallengeDef,
  ChallengeCategory,
  ChallengeCategoryEntry,
  ContentRegistry,
  EngineCategories,
  Producer,
  ProducerCategory,
  ProducerCategoryEntry,
  Purchasable,
  PurchasableEvents,
  PurchasableCategory,
  PurchasableCategoryEntry,
  Skill,
  SkillBase,
  SkillEvents,
  AccumulatorSkill,
  LevelDrivenSkill,
  SkillCategory,
  SkillCategoryEntry,
  CycleLogEntry,
  CycleLogDelta,
} from '../systems';
export type {
  Engine,
  EngineConfig,
  EngineContext,
  EngineEvents,
  EngineModule,
  ModDef,
  TickHandler,
  SaveHandler,
  LoadHandler,
  ResetHandler,
} from '../engine';
export { Decimal } from '../primitives/decimal';
export type { ResettableObject } from '../systems/resettable';
