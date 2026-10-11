// === CONSUMER API ===
// What game modules typically import.

// === PRIMITIVES IN CORE'S PUBLIC API ===
export { Decimal } from '../primitives/decimal';
export type { DecimalSource } from '../primitives/decimal';
export type { RequiredKeys } from './common';
export type {
  IEffect,
  ResourceEffect,
  FlagEffect,
  StateEffect,
  CompositeEffect,
  GameStateAccessor,
  Analyzer,
  AnalyzerSummary,
  InjectionKey,
} from '../primitives/types';

// === RESOURCES ===
export type {
  Resource,
  ResourceOptions,
  PersistentResourceOptions,
  SubtractResourceOptions,
} from './resource';
export {
  createResource,
  formatResource,
  unwrapResource,
  addResource,
  subtractResource,
  hasResource,
  resetResource,
} from './resource';

// === MODIFIERS ===
export type {
  Modifier,
  ModifierDescription,
  OperationModifier,
  AdditiveModifierOptions,
  MultiplicativeModifierOptions,
  ExponentialModifierOptions,
  ModifierChainEvents,
  ModifierChain,
  ModifierChainSlot,
  BindOptions,
  BindingRecord,
  Grant,
} from './modifier';
export {
  createAdditiveModifier,
  createMultiplicativeModifier,
  createExponentialModifier,
  createSequentialModifier,
  createModifierChain,
  applyModifier,
  applyModifiers,
  invertModifier,
  computeModifiedValue,
} from './modifier';

// === PER-ENGINE REGISTRIES (CHAIN, EFFECT-SYSTEM, RESOURCE) ===
export type {
  ChainRegistry,
  EffectSystemRegistry,
  EnumerableEffectSystem,
  EffectDefLike,
  ResourceRegistry,
  ResourceRegistryEntry,
} from './registries';
export { ChainRegistryKey, EffectSystemRegistryKey, ResourceRegistryKey } from './registries';

// === REQUIREMENTS ===
export type {
  Requirement,
  Requirements,
  CostRequirementOptions,
  CostRequirement,
  BooleanRequirementOptions,
} from './requirements';
export {
  createCostRequirement,
  createBooleanRequirement,
  anyOf,
  allOf,
  requirementsMet,
  maxRequirementsMet,
  payRequirements,
  getRequirementDescriptions,
  payByDivision,
  payByReset,
  createResetPay,
  isCostRequirement,
} from './requirements';

// === PERSISTENCE ===
export type {
  Serializable,
  SerializablePrimitive,
  SerializableConstraint,
  IfSerializable,
  Persistent,
  PersistentAlias,
  PersistentOptions,
} from './persistence';
export {
  persistent,
  isPersistent,
  aliasPersistent,
  deletePersistent,
  disownPersistent,
  resetPersistent,
  isAtDefault,
  filterDefaultedRefs,
  createDefStates,
  setPersistentId,
  getPersistentContextRefs,
  getAllPersistentRefs,
  serializePersistents,
  deserializePersistents,
  PersistentId,
  PersistentSchema,
  PersistentDecimal,
} from './persistence';

// === FORMULAS ===
export * from './formulas';

// === EFFECTS ===
// ICondition + C (the condition IR) and BranchEffect + IEffectInternal are
// engine-internal — imported via `@/core/conditions` / `@/primitives/types` from
// tests and from systems callers that need the projection target. Not part of
// the API surface.
export type { ResolvedEffect, GameStateMutator } from './effects';
export { resolveEffect, applyEffect, E } from './effects';

// === TRANSITIONS ===
export type { TransitionDistance, TransitionDeps, AffordableLike } from './transitions';
export { timeUntilResource, timeUntilAffordable } from './transitions';

// === GAME STATE ACCESSOR ===
export type { GameStateAccessorMutator } from './game-state-accessor';

// === TICK DRIVER ===
export type {
  TickDriverOptions,
  PhaseHandlers,
  TickDriver,
  TimerProvider,
  TickHandler,
} from './tick-driver';
export { createTickDriver } from './tick-driver';

// === HEADLESS RUNNER ===
export type { HeadlessOptions, HeadlessResult } from './headless';
export { runHeadless } from './headless';

// === SAVE MANAGER ===
export type {
  StorageAdapter,
  SaveManagerOptions,
  SaveManager,
  SaveLoadResult,
  SavePeek,
  SaveSlot,
  SaveEvents,
  SaveLoadFailureReason,
  SaveMigration,
} from './save-manager';
export { createSaveManager, createMemoryStorage, ENGINE_SAVE_VERSION } from './save-manager';

// === SAVE MIGRATIONS ===
export type { AddFieldOptions } from './save-migrations';
export {
  getNested,
  setNested,
  renameField,
  retypeField,
  deleteField,
  addField,
  forEachDef,
} from './save-migrations';

// === SAVE VALIDATION ===
export type {
  ValidationIssue,
  ValidateSaveDataOptions,
  ValidateSaveDataResult,
} from './save-validation';
export { decimalSchema, deriveSchema, getSchemaForRef, validateSaveData } from './save-validation';

// === OFFLINE PROGRESS ===
export type { OfflineProgressOptions } from './offline';
export { processOfflineTime } from './offline';

// === RESOURCE BAG ===
export type { ResourceBag, ResourceBagOptions, CapacitySource } from './resource-bag';
export { createResourceBag, transferBetweenBags, transferAmountsBetweenBags } from './resource-bag';

// === OVERRIDE REGISTRY ===
export type { OverrideRegistry, TuningRegistry } from './override-registry';
export {
  createOverrideRegistry,
  createTuningRegistry,
  tunable,
  TuningRegistriesKey,
} from './override-registry';

// === EVENTS ===
export type { Emittable, EmitHandle, EmitHandleOptions } from './events';
export { createEmitHandle } from './events';

// === THROTTLE ===
export type { ThrottleOptions, Throttle } from './throttle';
export { createThrottle } from './throttle';

// === SAFEGUARDS ===
export type { SafeguardDiagnostics } from './safeguards';
export {
  enableDevMode,
  disableDevMode,
  isDevMode,
  getSafeguardDiagnostics,
  resetSafeguardDiagnostics,
} from './safeguards';

// === SEQUENCER ===
export type {
  SequencerItem,
  FillStrategy,
  SequencerEvents,
  SequencerOptions,
  Sequencer,
  StartResult,
  RegisterTick,
} from './sequencer';
export { createSequencer } from './sequencer';

// === RUN POOL ===
export type {
  RunStep,
  RunDeathOutcome,
  RunHandle,
  RunRegistration,
  RunPoolEvents,
  RunPoolOptions,
  RunPool,
} from './run-pool';
export { createRunPool } from './run-pool';

// === TIMED PROGRESS ===
export type {
  TimedProgressOptions,
  TimedProgressBaseOptions,
  TimedProgress,
  ProgressiveCostEntry,
  ProgressiveCostStep,
} from './timed-progress';
export { createTimedProgress, resourcePaidAt, stepProgressiveCosts } from './timed-progress';

// === SEQUENCER STRATEGIES ===
export type { ConditionalRule } from './sequencer-strategies';
export {
  createConditionalStrategy,
  createPriorityStrategy,
  createRoundRobinStrategy,
  createCompositeStrategy,
} from './sequencer-strategies';

// === SELECTION POLICIES ===
export type { SelectionPolicy, HybridPaybackOptions, HybridPaybackContext } from './policy';
export {
  selectionCheapest,
  selectionPaybackPeriod,
  selectionHybridPayback,
  selectionComposite,
} from './policy';

// === SPATIAL PRIMITIVES ===
export type {
  GridCoord,
  GridOffset,
  PassabilityFn,
  TraversalCostFn,
  Unsubscribe,
  SpatialGrid,
  SpatialGridOptions,
  SpatialGridEvents,
  SerializedSpatialGrid,
  FovUpdateHandle,
  GraphNode,
  GraphEdge,
  Graph,
  GraphOptions,
  GraphEvents,
  SerializedGraph,
  ScopeStatus,
  ScopeStack,
  ScopeStackOptions,
  ScopeStackEvents,
  SerializedScopeStack,
  InfluenceSource,
  FalloffFunction,
  InfluenceLayerOptions,
  InfluenceLayerView,
  InfluenceLayer,
} from './spatial';
export { createSpatialGrid, createGraph, createScopeStack } from './spatial';
export { ORTHOGONAL_OFFSETS, DIAGONAL_OFFSETS, HEX_AXIAL_OFFSETS } from './spatial';
export {
  createInfluenceLayer,
  composeInfluenceLayers,
  linearFalloff,
  gaussianFalloff,
  exponentialFalloff,
} from './spatial';

// === DEV TOOLS & ADVANCED CONSUMER UTILITIES ===

// === COMPUTED / REACTIVITY UTILITIES ===
export type { MaybeGetter, Computable } from './computed';
export { toMaybeRef, resolveComputable } from './computed';

// === PERSISTENT CONTEXTS ===
// withPersistentContext opens a persistent context for custom category
// factories. The raw begin/end pair and the remaining persistence symbols stay
// engine-internal, reached by direct '@/core/persistence' imports from the
// systems source layer; withPersistentContext pops its persistent context even
// when its body throws.
export { withPersistentContext } from './persistence';

// === TRACE ===
export type { TraceEntry } from './trace';
export {
  withTraceChain,
  enableTracing,
  getTraceTick,
  getCurrentTraceEntries,
  getPreviousTraceEntries,
} from './trace';

// === PROFILER ===
export type { ProfileEntry, ProfileReport } from './profiler';
export {
  enableProfiling,
  isProfilingEnabled,
  profile,
  profileStart,
  profileEnd,
  getProfileReport,
  formatProfileReport,
  resetProfile,
} from './profiler';
