// === CONSUMER API ===
// What game modules typically import.

// === PRIMITIVES SURFACED BY CORE'S PUBLIC API ===
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
  AnalyzerResult,
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
  displayResource,
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

// === ENGINE-SCOPED REGISTRIES (CHAIN, EFFECT-SYSTEM, RESOURCE) ===
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
  State,
  StatePrimitive,
  StateConstraint,
  IfState,
  Persistent,
  NonPersistent,
  PersistentOptions,
} from './persistence';
export {
  persistent,
  isPersistent,
  noPersist,
  deletePersistent,
  resetPersistent,
  isAtDefault,
  filterDefaultedRefs,
  createDefStates,
  setPersistentName,
  getPersistentContextRefs,
  getAllPersistentRefs,
  serializePersistents,
  deserializePersistents,
  PersistentName,
  PersistentSchema,
  PersistentDecimal,
} from './persistence';

// === FORMULAS ===
export * from './formulas';

// === EFFECTS ===
// ICondition + C and ConditionalEffect + IEffectInternal are engine-internal
// IR — imported via `@/core/conditions` / `@/primitives/types` from tests and
// from systems-layer callers that need the projection target. Not part of
// the public surface.
export type { ResolvedEffect, GameStateMutator } from './effects';
export { resolveEffect, applyEffect, E } from './effects';

// === TRANSITIONS ===
export type { TransitionDistance, TransitionDeps, AffordableLike } from './transitions';
export { timeUntilResource, timeUntilAffordable } from './transitions';

// === GAME STATE ACCESSOR ===
export type { GameStateAccessorMutator } from './game-state-accessor';

// === TICK DRIVER ===
export type {
  TickDriverConfig,
  PhaseHooks,
  TickDriver,
  TimerProvider,
  TickCallback,
} from './tick-driver';
export { createTickDriver } from './tick-driver';

// === HEADLESS RUNNER ===
export type { HeadlessConfig, HeadlessResult } from './headless';
export { runHeadless } from './headless';

// === SAVE MANAGER ===
export type {
  StorageAdapter,
  SaveManagerConfig,
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
  dropField,
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
export { createResourceBag, transferBetweenBags, bulkTransfer } from './resource-bag';

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
  getDiagnostics,
  resetDiagnostics,
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
export { createTimedProgress, resourceConsumedAt, stepProgressiveCosts } from './timed-progress';

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
  GridDelta,
  PassabilityFn,
  TraversalCostFn,
  Unsubscribe,
  SpatialGrid,
  SpatialGridOptions,
  SpatialGridEvents,
  SpatialGridSnapshot,
  FovUpdateHandle,
  GraphNode,
  GraphEdge,
  SpatialGraph,
  SpatialGraphOptions,
  SpatialGraphEvents,
  SpatialGraphSnapshot,
  ScopeState,
  ScopeStack,
  ScopeStackOptions,
  ScopeStackEvents,
  ScopeStackSnapshot,
  InfluenceSource,
  FalloffFunction,
  InfluenceLayerOptions,
  InfluenceLayerReader,
  InfluenceLayer,
} from './spatial';
export { createSpatialGrid, createSpatialGraph, createScopeStack } from './spatial';
export { ORTHOGONAL_DELTAS, DIAGONAL_DELTAS, HEX_AXIAL_DELTAS } from './spatial';
export {
  createInfluenceLayer,
  composeInfluenceLayers,
  linearFalloff,
  gaussianFalloff,
  exponentialFalloff,
} from './spatial';

// === DEV TOOLS & ADVANCED CONSUMER HELPERS ===

// === COMPUTED / REACTIVITY HELPERS ===
export type { MaybeGetter, Computable } from './computed';
export { processGetter, resolveComputable } from './computed';

// === PERSISTENCE CONTEXT SCOPING ===
// withPersistentContext is the scoping entry point for custom category
// factories. The raw begin/end pair and the remaining persistence symbols stay
// engine-internal, reached by direct '@/core/persistence' imports from the
// systems layer; withPersistentContext pops its context even when its body throws.
export { withPersistentContext } from './persistence';

// === TRACE ===
export type { TraceEntry } from './trace';
export {
  withChain,
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
