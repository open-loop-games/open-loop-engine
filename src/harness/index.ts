export * from './types';
export { createWorkPlan } from './work-plan';
export { computeMetricStats, diffAggregates } from './aggregate';
export { runMatrix } from './run-matrix';
export { runSensitivity } from './run-sensitivity';
export { runUntil } from './run-until';
export { runMatrixUntil } from './run-matrix-until';
export { replayLive, createTickCounter } from './replay';
export type { ReplayLiveOptions, TickCounter } from './replay';
export { createSensitivityCell } from './create-sensitivity-cell';
export { createEngineFromSave } from './create-engine';
export type { CreateEngineFromSaveOptions } from './create-engine';
export type { CreateSensitivityCellOptions } from './create-sensitivity-cell';
export {
  createResourcePeakAnalyzer,
  createRunFinalizeAnalyzer,
  defaultAnalyzerPack,
  createTimeSeriesAnalyzer,
  timeSeriesAnalyzerPack,
} from './analyzers';
export {
  createPickerSnapshot,
  type PickerWalker,
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
export { runBeatProbe, runWaypointProbe } from './probe';
export type {
  Beat,
  BeatResult,
  BeatProbeOptions,
  Waypoint,
  WaypointSnapshot,
  WaypointProbeOptions,
} from './probe';
export { bisectTuner } from './solve';
export type { TunerOptions, TunerResult, Tuner } from './solve';
export { createTransitionSnapshot, createIncrementalSnapshot } from './walker';
export type {
  Transition,
  TransitionWalker,
  TransitionSnapshot,
  IncrementalSnapshot,
} from './walker';

// === CROSS-LAYER TYPE RE-EXPORTS ===
// The balance harness re-exports types from the lower source layers and
// `engine.ts`: engine build helpers, perturbation targets, analyzers. Each is
// re-exported by name. Values stay in their owning source layer, except `Decimal`.

export type {
  DecimalSource,
  Analyzer,
  AnalyzerSummary,
  InjectionKey,
  IEffect,
  FlagEffect,
  StateEffect,
  CompositeEffect,
  Serializable,
  Persistent,
  PersistentAlias,
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
  PhaseHandlers,
  TickHandler,
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
  EngineOptions,
  EngineContext,
  EngineEvents,
  EngineModule,
  ModDef,
  SaveHandler,
  LoadHandler,
} from '../engine';
export { Decimal } from '../primitives/decimal';
export type { ResettableObject } from '../core/resettable';
