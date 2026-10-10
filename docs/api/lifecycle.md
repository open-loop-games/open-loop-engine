# Lifecycle

Anything that crosses a session boundary or a prestige reset — `withPersistentContext` namespacing, `createSaveManager` slots and migration, `createReset` with retention policies, offline catch-up.

## Canonical entrypoints

- `withPersistentContext` / `persistent` — create save-owned refs under stable namespaces.
- `createReset` with `resetModules` — reset module/category scopes without manually listing every ref.
- `createRetentionPolicy`, `keep`, and `retain` — carry values across prestige resets.
- `createSaveManager` — multi-slot save/load, migration, validation, import, and export.
- `processOfflineTime` — replay elapsed time through the game loop in bounded chunks.
- `createTimeBank` with `createBankedAcceleration` / `burstDischarge` — bank time into a reservoir and spend it as a live speed boost or an instant fast-forward (the banking offline-progress family).

## Offline

catch-up progress by replaying elapsed seconds through the TickDriver in chunks

- `interface OfflineProgressOptions` — Options for processOfflineTime — caps the catch-up window and the per-step chunk size. `src/core/offline.ts:8`
- `function processOfflineTime(tickDriver: TickDriver, elapsedSeconds: number, options?: OfflineProgressOptions): number` — Process offline elapsed time by feeding it through the TickDriver in chunks. `src/core/offline.ts:23`

## Persistence

auto-saved refs with context-scoped registration

- `function createDefinitionStates<D, K, S>(contextId: string, definitions: readonly D[], stateFactory: (def: D) => S, keyAccessor?: (def: D) => K): Map<K, S>` — Create a Map of per-definition persistent state, where each `stateFactory` result must be an *object* of persistent refs (property keys become the stable save names). `src/core/persistence.ts:1023`
- `function deletePersistent(persistentRef: Persistent): void` — Mark a persistent ref as deleted, so it won't be saved or loaded. `src/core/persistence.ts:768`
- `function deserializePersistents(refs: Map<string, Persistent>, save: Record<string, unknown>): void` — Load save data into persistent refs. `src/core/persistence.ts:1201`
- `function filterDefaultedRefs(refs: Map<string, Persistent>): Map<string, Persistent>` — Return a new Map with refs whose value equals their default removed. `src/core/persistence.ts:870`
- `function getAllPersistentRefs(namespace?: string): Map<string, Persistent>` — Build a Map of all persistent refs across all contexts, keyed by a stable name when one was assigned, or by iteration order as a legacy fallback. `src/core/persistence.ts:1104`
- `function getModulePersistentRefs(moduleId: string): Set<Persistent>` — Get all persistent refs belonging to a module, including refs created in nested child contexts (categories, per-definition states, etc.). `src/core/persistence.ts:901`
- `type IfState<T, Ok> = [T] extends [StateConstraint<T>] ? Ok : never` — Resolves to `Ok` when `T` is serializable state and to `never` otherwise, so a parameter typed through it rejects a non-state value at the call. `src/core/persistence.ts:588`
- `function isAtDefault<T>(persistentRef: Persistent<T>): boolean` — True when a persistent ref's current value equals its default. `src/core/persistence.ts:804`
- `function isPersistent(value: unknown): value is Persistent` — Check if a value is a persistent ref. `src/core/persistence.ts:720`
- `const NonPersistent: unique symbol` — Symbol for the non-persistent computed wrapper. `src/core/persistence.ts:92`
- `function noPersist<T extends Persistent<S>, S>(persistentRef: T): T[typeof NonPersistent]` — Get the non-persistent computed wrapper for a persistent ref. `src/core/persistence.ts:730`
- `function noPersist<T extends object>(obj: T): T` `src/core/persistence.ts:731`
- `function persistent<T>(defaultValue: T | Ref<T>, ...[options]: IfState<T, [options?: PersistentOptions<T>]>): Persistent<T>` — Create a persistent ref that will be saved/loaded automatically. `src/core/persistence.ts:596`
- `type Persistent<T = State> = Ref<T> & { readonly [PersistentState]: Ref<T>; readonly [DefaultValue]: T; readonly [StackTrace]: string; [Deleted]: boolean; readonly [NonPersistent]: NonPersistent<T>; [SaveDataPath]: string[] | undefined; readonly [CheckNaN]: boolean; [PersistentName]: string | undefined; readonly [PersistentSchema]: unknown; readonly [PersistentDecimal]: boolean; readonly [Lifetime]: boolean; }` — A ref that is automatically saved and loaded. `src/core/persistence.ts:133`
- `const PersistentDecimal: unique symbol` — Marks a ref as Decimal-valued for schema derivation. `src/core/persistence.ts:119`
- `const PersistentName: unique symbol` — Stable name of this persistent ref inside its context. `src/core/persistence.ts:105`
- `interface PersistentOptions<T = unknown>` — Options for creating a persistent ref. `src/core/persistence.ts:536`
- `const PersistentSchema: unique symbol` — Explicit Zod schema for this ref's runtime save validation. `src/core/persistence.ts:112`
- `function resetPersistent<T>(persistentRef: Persistent<T>): void` — Reset a persistent ref to its default value. `src/core/persistence.ts:779`
- `function serializePersistents(refs: Map<string, Persistent>): Record<string, unknown>` — Serialize collected persistent refs to a save object. `src/core/persistence.ts:1056`
- `function setPersistentName(ref: Persistent, name: string): void` — Assign a stable save-data name to a persistent ref inside its context. `src/core/persistence.ts:693`
- `type State` — Serializable state types that can be saved/loaded safely. `src/core/persistence.ts:35`
- `type StateConstraint<T>` — Compile-time constraint that validates T is serializable without requiring explicit index signatures on interfaces. `src/core/persistence.ts:63`
- `type StatePrimitive = string | number | boolean | null | undefined` — Primitive subset of State for use in conditional type branches. `src/core/persistence.ts:47`
- `function withPersistentContext<T>(id: string, fn: () => T): T` — Run a block inside a persistent context, guaranteeing the context is closed even if the block throws. `src/core/persistence.ts:426`

## Reset

prestige and layer mechanics

- `function createReset(options: ResetOptions): Reset` — Create a reset mechanic. `src/systems/reset.ts:270`
- `function createResetTimer(reset: Reset): Ref<number>` — Create a reset-zeroed elapsed-time ref. `src/systems/reset.ts:451`
- `interface Reset extends ScopedReset` — A reset mechanic that can reset game progress. `src/systems/reset.ts:153`
- `interface ResetEvents` — Events emitted by a Reset instance. `src/systems/reset.ts:181`
- `interface ResetOptions` — Configuration for a reset mechanic. `src/systems/reset.ts:61`
- `type ResetScope = string | ScopedReset` — A reset scope entry: either a module ID (string) resolved via the persistent ref registry, or another Reset/Cycle whose resolved scope is unioned in. `src/systems/reset.ts:56`
- `interface ScopedReset` — Any object exposing a resolved set of persistent refs for composable reset scope. `src/systems/reset.ts:48`

## Resettable protocol

opt-in interface for objects that can yield their resettable contents to a reset's `thingsToReset` walk

- `const Resettable: unique symbol` — Symbol key for the Resettable protocol. `src/core/resettable.ts:19`
- `interface ResettableObject` — An object whose persistent contents can be yielded for recursive reset. `src/core/resettable.ts:28`

## Retention

Retention policy for declarative carryover across resets

- `function createRetentionPolicy(options: RetentionPolicyOptions): RetentionPolicy` — Creates a declarative retention policy for carrying values across resets. `src/systems/retention.ts:80`
- `function fractional(rate: DecimalSource): (value: any) => any` — Create a fractional retention transform. `src/systems/retention.ts:49`
- `interface RetentionPolicy` — Snapshot/restore pair that selectively preserves persistent refs across a reset. `src/systems/retention.ts:33`
- `interface RetentionPolicyOptions` — Options for createRetentionPolicy — split refs into `keep` (verbatim) and `retain` (transformed). `src/systems/retention.ts:18`

## Save Manager

persistent game state with multi-slot support

- `function addField(data: SaveData, path: string, defaultValue: unknown, opts?: AddFieldOptions): SaveData` — Write `defaultValue` at `path`. `src/core/save-migrations.ts:167`
- `interface AddFieldOptions` `src/core/save-migrations.ts:148`
- `function createMemoryStorage(): StorageAdapter` — Canonical in-memory StorageAdapter backed by a `Map`. `src/core/save-manager.ts:91`
- `function createSaveManager(config: SaveManagerConfig): SaveManager` — Create a save manager — orchestrates serialization, slot management, migrations, and validation around the persistent-ref tree. `src/core/save-manager.ts:539`
- `const decimalSchema: ZodType<DecimalSource>` — Zod schema that accepts the three concrete DecimalSource shapes a save can hold: a live `Decimal` instance, a finite `number`, or a numeric string (including the `"Infinity"` / `"NaN"` literals `serializePersistents` emits). `src/core/save-validation.ts:58`
- `function deriveSchema(defaultValue: unknown, decimal?: boolean): ZodType` — Derive a Zod schema from a ref's default value and options. `src/core/save-validation.ts:91`
- `function dropField(data: SaveData, path: string): SaveData` — Remove the value at `path`. `src/core/save-migrations.ts:139`
- `const ENGINE_SAVE_VERSION = 3` — Engine-internal save-format version, stored in the envelope under `_engine.version`. `src/core/save-manager.ts:63`
- `function forEachDefinition(data: SaveData, contextId: string, fn: (entry: SaveData, id: string) => void): SaveData` — Iterate over each entry in a collection-shaped context (a top-level group of per-definition state). `src/core/save-migrations.ts:195`
- `function getNested(data: SaveData, path: string): unknown` — Read the value at a `.`-separated nested path in a save-data tree. `src/core/save-migrations.ts:43`
- `function getSchemaForRef(ref: Persistent): ZodType` — Get the effective schema for a persistent ref — explicit override wins, else auto-derive. `src/core/save-validation.ts:140`
- `function renameField(data: SaveData, oldPath: string, newPath: string): SaveData` — Move a value from `oldPath` to `newPath`. `src/core/save-migrations.ts:93`
- `function retypeField(data: SaveData, path: string, transform: (oldValue: unknown) => unknown): SaveData` — Apply `transform` to the value at `path`. `src/core/save-migrations.ts:117`
- `interface SaveEvents` — Events emitted by a SaveManager. `src/core/save-manager.ts:217`
- `type SaveLoadFailureReason = 'not-found' | 'parse-error' | 'wrong-game-id' | 'future-version' | 'validation' | 'unknown'` — Reason a load or import operation failed. `src/core/save-manager.ts:202`
- `interface SaveLoadResult` — Result of a save load or import operation. `src/core/save-manager.ts:169`
- `interface SaveManager extends Emittable<SaveEvents>` — Multi-slot save manager: persists, loads, imports, and exports versioned game state. `src/core/save-manager.ts:287`
- `interface SaveManagerConfig` — Configuration for creating a save manager. `src/core/save-manager.ts:113`
- `type SaveMigration = (data: Record<string, unknown>) => Record<string, unknown>` — One step of a consumer save migration: receives the save data written by version N and returns it reshaped for version N + 1. `src/core/save-manager.ts:110`
- `interface SavePeek` — Lightweight save metadata returned without full deserialization. `src/core/save-manager.ts:175`
- `interface SaveSlot` — A named save slot. `src/core/save-manager.ts:185`
- `function setNested(data: SaveData, path: string, value: unknown): void` — Write `value` at a `.`-separated nested path, creating intermediate objects as needed. `src/core/save-migrations.ts:64`
- `interface StorageAdapter` — Pluggable storage backend. `src/core/save-manager.ts:68`
- `function validateSaveData(refs: Map<string, Persistent>, data: Record<string, unknown>, options: ValidateSaveDataOptions): ValidateSaveDataResult` — Validate raw save data against the live persistent-ref registry. `src/core/save-validation.ts:205`
- `interface ValidateSaveDataOptions` `src/core/save-validation.ts:180`
- `interface ValidateSaveDataResult` `src/core/save-validation.ts:187`
- `interface ValidationIssue` — A single field-level validation failure, suitable for `save:validation-failed`. `src/core/save-validation.ts:72`

## Time bank

banked-time reservoir with acceleration and burst spend surfaces

- `interface BankedAcceleration` — Spend-loop handle returned by createBankedAcceleration. `src/systems/time-bank.ts:174`
- `interface BankedAccelerationConfig` — Configuration for createBankedAcceleration. `src/systems/time-bank.ts:136`
- `function burstDischarge(bank: TimeBank, tickDriver: TickDriver, options?: BurstDischargeOptions): number` — Spend (a fraction of) a TimeBank as one immediate fast-forward: withdraw, then replay the seconds through processOfflineTime in a single burst. `src/systems/time-bank.ts:341`
- `interface BurstDischargeOptions` `src/systems/time-bank.ts:301`
- `function createBankedAcceleration(config: BankedAccelerationConfig): BankedAcceleration` — The live-multiplier spend loop over a TimeBank: toggle a speed boost on the TickDriver, pay for it from the bank each tick, auto-stop at depletion. `src/systems/time-bank.ts:216`
- `function createTimeBank(config?: TimeBankConfig): TimeBank` — Create a banked-time reservoir: a persistent pool of seconds earned by consumer policy and spent through createBankedAcceleration, burstDischarge, or a bespoke consumer drain. `src/systems/time-bank.ts:103`
- `interface TimeBank` — Banked-time reservoir returned by createTimeBank. `src/systems/time-bank.ts:65`
- `interface TimeBankConfig` — Configuration for createTimeBank. `src/systems/time-bank.ts:44`
