# Lifecycle

Save/load, reset cascades, persistent refs, offline catch-up, retention policies. Anything that crosses session boundaries or prestige resets. `withPersistentContext` is the namespacing primitive every save-touching factory uses; `createSaveManager` is the multi-slot envelope; `createReset` carries retention rules between prestige tiers.

## Canonical entrypoints

Start with these public symbols before scanning the full inventory below.

- `withPersistentContext` / `persistent` — create save-owned refs under stable namespaces.
- `createReset` with `resetModules` — reset module/category scopes without manually listing every ref.
- `createRetentionPolicy`, `keep`, and `retain` — carry values across prestige resets.
- `createSaveManager` — multi-slot save/load, migration, validation, import, and export.
- `processOfflineTime` — replay elapsed time through the game loop in bounded chunks.

## Offline

catch-up progress by replaying elapsed seconds through the game loop in chunks

- `interface OfflineProgressOptions` — Options for processOfflineTime — caps the catch-up window and the per-step chunk size. `src/core/offline.ts:8`
- `function processOfflineTime(loop: GameLoop, elapsedSeconds: number, options?: OfflineProgressOptions): number` — Process offline elapsed time by feeding it through the game loop in chunks. `src/core/offline.ts:24`

## Persistence

auto-saved refs with context-scoped registration

- `function createDefinitionStates<D, K, S>(contextId: string, definitions: readonly D[], stateFactory: (def: D) => S, keyAccessor?: (def: D) => K): Map<K, S>` — Create a Map of persistent state objects for an array of definitions. `src/core/persistence.ts:841`
- `function deletePersistent(persistentRef: Persistent): void` — Mark a persistent ref as deleted, so it won't be saved or loaded. `src/core/persistence.ts:577`
- `function filterDefaultedRefs(refs: Map<string, Persistent>): Map<string, Persistent>` — Return a new Map with refs whose value equals their default removed. `src/core/persistence.ts:673`
- `function isAtDefault<T>(persistentRef: Persistent<T>): boolean` — True when a persistent ref's current value equals its default. `src/core/persistence.ts:608`
- `function isPersistent(value: unknown): value is Persistent` — Check if a value is a persistent ref. `src/core/persistence.ts:533`
- `const NonPersistent: unique symbol` — Symbol for the non-persistent computed wrapper. `src/core/persistence.ts:74`
- `function noPersist<T extends Persistent<S>, S>(persistentRef: T): T[typeof NonPersistent]` — Get the non-persistent computed wrapper for a persistent ref. `src/core/persistence.ts:543`
- `function persistent<T>(defaultValue: (T & StateConstraint<T>) | Ref<T & StateConstraint<T>>, options?: PersistentOptions<T>): Persistent<T>` — Create a persistent ref that will be saved/loaded automatically. `src/core/persistence.ts:409`
- `type Persistent<T = State> = Ref<T> & { readonly [PersistentState]: Ref<T>; readonly [DefaultValue]: T; readonly [StackTrace]: string; [Deleted]: boolean; readonly [NonPersistent]: NonPersistent<T>; [SaveDataPath]: string[] | undefined; readonly [CheckNaN]: boolean; [PersistentName]: string | undefined; readonly [PersistentSchema]: unknown; readonly [PersistentDecimal]: boolean; readonly [Lifetime]: boolean; }` — A ref that is automatically saved and loaded. `src/core/persistence.ts:126`
- `const PersistentDecimal: unique symbol` — Marks a ref as Decimal-valued for schema derivation. `src/core/persistence.ts:101`
- `const PersistentName: unique symbol` — Stable name of this persistent ref inside its context. `src/core/persistence.ts:87`
- `interface PersistentOptions<T = unknown>` — Options for creating a persistent ref. `src/core/persistence.ts:354`
- `const PersistentSchema: unique symbol` — Explicit Zod schema for this ref's runtime save validation. `src/core/persistence.ts:94`
- `function resetPersistent<T>(persistentRef: Persistent<T>): void` — Reset a persistent ref to its default value. `src/core/persistence.ts:588`
- `function setPersistentName(ref: Persistent, name: string): void` — Assign a stable save-data name to a persistent ref inside its context. `src/core/persistence.ts:506`
- `type State` — Serializable state types that can be saved/loaded safely. `src/core/persistence.ts:25`
- `type StateConstraint<T>` — Compile-time constraint that validates T is serializable without requiring explicit index signatures on interfaces. `src/core/persistence.ts:49`
- `type StatePrimitive = string | number | boolean | null | undefined` — Primitive subset of State for use in conditional type branches. `src/core/persistence.ts:37`
- `function withPersistentContext<T>(id: string, fn: () => T): T` — Run a block inside a persistent context, guaranteeing the context is closed even if the block throws. `src/core/persistence.ts:285`

## Reset

prestige and layer mechanics

- `function createReset<T extends ResetOptions>(options: T): Reset` — Create a reset mechanic. `src/systems/reset.ts:232`
- `function createResetTimer(reset: Reset): Ref<number>` — Create a reset-zeroed elapsed-time ref. `src/systems/reset.ts:388`
- `function isReset(value: unknown): value is Reset` — Check whether a value is a Reset instance. `src/systems/reset.ts:411`
- `interface Reset extends ScopedReset` — A reset mechanic that can reset game progress. `src/systems/reset.ts:141`
- `interface ResetEvents` — Events emitted by a Reset instance. `src/systems/reset.ts:171`
- `interface ResetOptions` — Configuration for a reset mechanic. `src/systems/reset.ts:65`
- `type ResetScope = string | ScopedReset` — A reset scope entry: either a module ID (string) resolved via the persistent ref registry, or another Reset/Loop whose resolved scope is unioned in. `src/systems/reset.ts:60`
- `const ResetType: unique symbol` — Symbol identifying Reset features. `src/systems/reset.ts:45`
- `interface ScopedReset` — Any object exposing a resolved set of persistent refs for composable reset scope. `src/systems/reset.ts:52`

## Resettable protocol

opt-in interface for objects that can yield their resettable contents to _resetObject_ in the reset system

- `const Resettable: unique symbol` — Symbol key for the Resettable protocol. `src/systems/resettable.ts:15`
- `interface ResettableObject` — An object whose persistent contents can be yielded for recursive reset. `src/systems/resettable.ts:24`

## Retention

Retention policy for declarative carryover across resets

- `function createRetentionPolicy(options: RetentionPolicyOptions): RetentionPolicy` — Creates a declarative retention policy for carrying values across resets. `src/systems/retention.ts:78`
- `function fractional(rate: DecimalSource): (value: any) => any` — Create a fractional retention transform. `src/systems/retention.ts:49`
- `interface RetentionPolicy` — Snapshot/restore pair that selectively preserves persistent refs across a reset. `src/systems/retention.ts:34`
- `interface RetentionPolicyOptions` — Options for createRetentionPolicy — split refs into `keep` (verbatim) and `retain` (transformed). `src/systems/retention.ts:19`

## Save Manager

persistent game state with multi-slot support

- `function createMemoryStorage(): StorageAdapter` — Canonical in-memory StorageAdapter backed by a `Map`. `src/core/save-manager.ts:85`
- `function createSaveManager(config: SaveManagerConfig): SaveManager` — Create a save manager — orchestrates serialization, slot management, migrations, and validation around the persistent-ref tree. `src/core/save-manager.ts:418`
- `const decimalSchema: ZodType<DecimalSource>` — Zod schema that accepts the three concrete DecimalSource shapes a save can hold: a live `Decimal` instance, a finite `number`, or a numeric string (including the `"Infinity"` / `"NaN"` literals `serializePersistents` emits). `src/core/save-validation.ts:58`
- `function deriveSchema(defaultValue: unknown, decimal?: boolean): ZodType` — Derive a Zod schema from a ref's default value and options. `src/core/save-validation.ts:86`
- `const ENGINE_SAVE_VERSION = 3` — Engine-internal save-format version, stored in the envelope under `_engine.version`. `src/core/save-manager.ts:57`
- `function getSchemaForRef(ref: Persistent): ZodType` — Get the effective schema for a persistent ref — explicit override wins, else auto-derive. `src/core/save-validation.ts:121`
- `interface SaveEvents` — Events emitted by a SaveManager. `src/core/save-manager.ts:197`
- `type SaveLoadFailureReason = 'not-found' | 'parse-error' | 'wrong-game-id' | 'future-version' | 'validation' | 'unknown'` — Reason a load or import operation failed. `src/core/save-manager.ts:183`
- `interface SaveLoadResult` — Result of a save load or import operation. `src/core/save-manager.ts:151`
- `interface SaveManager extends Emittable<SaveEvents>` — Multi-slot save manager: persists, loads, imports, and exports versioned game state. `src/core/save-manager.ts:228`
- `interface SaveManagerConfig` — Configuration for creating a save manager. `src/core/save-manager.ts:99`
- `interface SavePeek` — Lightweight save metadata returned without full deserialization. `src/core/save-manager.ts:157`
- `interface SaveSlot` — A named save slot. `src/core/save-manager.ts:167`
- `interface StorageAdapter` — Pluggable storage backend. `src/core/save-manager.ts:62`
- `function validateSaveData(refs: Map<string, Persistent>, data: Record<string, unknown>, options: ValidateSaveDataOptions): ValidateSaveDataResult` — Validate raw save data against the live persistent-ref registry. `src/core/save-validation.ts:186`
- `interface ValidateSaveDataOptions` — Options for validateSaveData. `src/core/save-validation.ts:161`
- `interface ValidateSaveDataResult` — Result of validateSaveData. `src/core/save-validation.ts:168`
- `interface ValidationIssue` — A single field-level validation failure, suitable for `save:validation-error`. `src/core/save-validation.ts:72`
