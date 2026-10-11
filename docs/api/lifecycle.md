# Lifecycle

Anything kept across play sessions or prestige resets: `withPersistentContext`, `createSaveManager` slots and save migration, `createReset` with retention, and offline catch-up.

## Canonical entrypoints

- `withPersistentContext` / `persistent` — create persistent refs under stable persistent contexts.
- `createReset` with `resetPersistentContexts` — reset a module's or a category's persistent contexts without listing every ref.
- `createRetention`, `keep` and `retain` — keep values through prestige resets.
- `createSaveManager` — multi-slot save and load, save migration, validation, import and export.
- `processOfflineTime` — replay offline time through the game loop in bounded chunks.
- `createTimeBank` with `createBankedAcceleration` / `burstDischarge` — deposit seconds into a time bank. Spend them as faster game speed, or replay them at once in a burst discharge (the banking offline-progress family).

## Offline

catch-up progress by replaying elapsed seconds through the TickDriver in chunks

- `interface OfflineProgressOptions` — Options for processOfflineTime: the catch-up window's cap and the chunk size of each `advanceTime` call. `src/core/offline.ts:8`
- `function processOfflineTime(tickDriver: TickDriver, elapsedSeconds: number, options?: OfflineProgressOptions): number` — Replay offline time through the TickDriver in chunks. `src/core/offline.ts:23`

## Persistence

auto-saved refs, registered per persistent context

- `function aliasPersistent<T extends Persistent<S>, S>(persistentRef: T): T[typeof PersistentAlias]` — Get the persistent alias of a persistent ref. `src/core/persistence.ts:732`
- `function aliasPersistent<T extends object>(obj: T): T` `src/core/persistence.ts:735`
- `function createDefStates<D, K, S>(contextId: string, definitions: readonly D[], stateFactory: (def: D) => S, keyAccessor?: (def: D) => K): Map<K, S>` — Create a Map of def states. `src/core/persistence.ts:1028`
- `function deletePersistent(persistentRef: Persistent): void` — Mark a persistent ref as deleted, so it won't be saved or loaded. `src/core/persistence.ts:774`
- `function deserializePersistents(refs: Map<string, Persistent>, save: Record<string, unknown>): void` — Load save data into persistent refs. `src/core/persistence.ts:1205`
- `function filterDefaultedRefs(refs: Map<string, Persistent>): Map<string, Persistent>` — Return a new Map without the refs whose value equals their ref default. `src/core/persistence.ts:876`
- `function getAllPersistentRefs(persistenceNamespace?: string): Map<string, Persistent>` — Build a Map of every persistent ref across every persistent context. `src/core/persistence.ts:1107`
- `function getPersistentContextRefs(contextId: string): Set<Persistent>` — Get every non-lifetime persistent ref under a persistent context, child persistent contexts included (categories, def states and the like). `src/core/persistence.ts:908`
- `type IfSerializable<T, Ok> = [T] extends [SerializableConstraint<T>] ? Ok : never` — Resolves to `Ok` when `T` is a serializable value and to `never` otherwise. `src/core/persistence.ts:590`
- `function isAtDefault<T>(persistentRef: Persistent<T>): boolean` — True when a persistent ref's value equals its ref default. `src/core/persistence.ts:810`
- `function isPersistent(value: unknown): value is Persistent` — Check if a value is a persistent ref. `src/core/persistence.ts:722`
- `function persistent<T>(defaultValue: T | Ref<T>, ...[options]: IfSerializable<T, [options?: PersistentOptions<T>]>): Persistent<T>` — Create a persistent ref, which the save manager saves and loads. `src/core/persistence.ts:598`
- `type Persistent<T = Serializable> = Ref<T> & { readonly [PersistentState]: Ref<T>; readonly [DefaultValue]: T; readonly [StackTrace]: string; [Deleted]: boolean; readonly [PersistentAlias]: PersistentAlias<T>; [SaveDataPath]: string[] | undefined; readonly [CheckNaN]: boolean; [PersistentId]: string | undefined; readonly [PersistentSchema]: unknown; readonly [PersistentDecimal]: boolean; readonly [Lifetime]: boolean; }` — A ref that is automatically saved and loaded. `src/core/persistence.ts:133`
- `const PersistentAlias: unique symbol` — Symbol for the persistent alias: a writable computed the save walk skips. `src/core/persistence.ts:92`
- `const PersistentDecimal: unique symbol` — Marks a ref as Decimal-valued for schema derivation. `src/core/persistence.ts:119`
- `const PersistentId: unique symbol` — Stable id of this persistent ref inside its persistent context. `src/core/persistence.ts:105`
- `interface PersistentOptions<T = unknown>` — Options for creating a persistent ref. `src/core/persistence.ts:538`
- `const PersistentSchema: unique symbol` — Explicit Zod schema for this ref's runtime save validation. `src/core/persistence.ts:112`
- `function resetPersistent<T>(persistentRef: Persistent<T>): void` — Reset a persistent ref to its ref default. `src/core/persistence.ts:785`
- `type Serializable` — The serializable values a persistent ref may hold, which save and load safely. `src/core/persistence.ts:35`
- `type SerializableConstraint<T>` — Compile-time constraint that checks T is a serializable value without explicit index signatures on interfaces. `src/core/persistence.ts:63`
- `type SerializablePrimitive = string | number | boolean | null | undefined` — The primitive subset of Serializable, for conditional type branches. `src/core/persistence.ts:47`
- `function serializePersistents(refs: Map<string, Persistent>): Record<string, unknown>` — Serialize the collected persistent refs to save data. `src/core/persistence.ts:1061`
- `function setPersistentId(ref: Persistent, id: string): void` — Assign a stable id to a persistent ref inside its persistent context; the id forms the ref's save key. `src/core/persistence.ts:695`
- `function withPersistentContext<T>(id: string, fn: () => T): T` — Run a block inside a persistent context, and close it even if the block throws. `src/core/persistence.ts:427`

## Reset

the reset mechanic behind prestige layers

- `function createReset(options: ResetOptions): Reset` — Create a reset mechanic. `src/systems/reset.ts:273`
- `function createResetTimer(reset: Reset): Ref<number>` — Create a reset-zeroed elapsed-time ref. `src/systems/reset.ts:455`
- `interface Reset extends ScopedReset` — A reset mechanic that can reset game progress. `src/systems/reset.ts:155`
- `interface ResetEvents` — Events emitted by a Reset instance. `src/systems/reset.ts:183`
- `interface ResetOptions` — Options for a reset mechanic. `src/systems/reset.ts:61`
- `type ResetScope = string | ScopedReset` — A reset scope entry, one of: - a persistent context id (string), which the persistent-ref registry resolves; - another Reset or Cycle, whose resolved scope is unioned in. `src/systems/reset.ts:56`
- `interface ScopedReset` — Any object exposing a resolved set of persistent refs for a composable reset scope. `src/systems/reset.ts:47`

## Resettable protocol

opt-in interface for objects that can yield their resettable contents to a reset's `thingsToReset` walk

- `const Resettable: unique symbol` — Symbol key for the Resettable protocol. `src/core/resettable.ts:20`
- `interface ResettableObject` — An object whose persistent contents can be yielded for recursive reset. `src/core/resettable.ts:29`

## Retention

declarative keep and retain of values through a reset

- `function createRetention(options: RetentionOptions): Retention` — Create a retention: a declarative keep and retain of values through resets. `src/systems/retention.ts:80`
- `function fractional(fraction: DecimalSource): (value: any) => any` — Create a fractional retention transform. `src/systems/retention.ts:49`
- `interface Retention` — A snapshot and restore pair that keeps chosen persistent refs through a reset. `src/systems/retention.ts:33`
- `interface RetentionOptions` — Options for createRetention — split refs into `keep` (verbatim) and `retain` (transformed). `src/systems/retention.ts:18`

## Save Manager

saves of live state, with multi-slot support

- `function addField(data: SaveData, path: string, defaultValue: unknown, opts?: AddFieldOptions): SaveData` — Write `defaultValue` at `path`. `src/core/save-migrations.ts:167`
- `interface AddFieldOptions` `src/core/save-migrations.ts:148`
- `function createMemoryStorage(): StorageAdapter` — Canonical in-memory StorageAdapter backed by a `Map`. `src/core/save-manager.ts:91`
- `function createSaveManager(options: SaveManagerOptions): SaveManager` — Create a save manager: serialization, slot management, save migrations and validation over the persistent-ref registry. `src/core/save-manager.ts:535`
- `const decimalSchema: ZodType<DecimalSource>` — Zod schema that accepts the three concrete DecimalSource shapes a save can hold: - a live `Decimal` instance; - a `number`; - a numeric string, including the `"Infinity"` / `"NaN"` literals `serializePersistents` emits. `src/core/save-validation.ts:61`
- `function deleteField(data: SaveData, path: string): SaveData` — Remove the value at `path`. `src/core/save-migrations.ts:139`
- `function deriveSchema(defaultValue: unknown, decimal?: boolean): ZodType` — Derive a Zod schema from a ref default and options. `src/core/save-validation.ts:94`
- `const ENGINE_SAVE_VERSION = 3` — The engine save version, stored in the envelope under `_engine.version`. `src/core/save-manager.ts:63`
- `function forEachDef(data: SaveData, contextId: string, fn: (entry: SaveData, id: string) => void): SaveData` — Iterate over each entry in a collection-shaped persistent context: a top-level group of def states. `src/core/save-migrations.ts:195`
- `function getNested(data: SaveData, path: string): unknown` — Read the value at a `.`-separated nested path in a save-data tree. `src/core/save-migrations.ts:43`
- `function getSchemaForRef(ref: Persistent): ZodType` — Get the effective schema for a persistent ref — explicit override wins, else auto-derive. `src/core/save-validation.ts:143`
- `function renameField(data: SaveData, oldPath: string, newPath: string): SaveData` — Move a value from `oldPath` to `newPath`. `src/core/save-migrations.ts:93`
- `function retypeField(data: SaveData, path: string, transform: (oldValue: unknown) => unknown): SaveData` — Apply `transform` to the value at `path`. `src/core/save-migrations.ts:117`
- `interface SaveEvents` — Events emitted by a SaveManager. `src/core/save-manager.ts:214`
- `type SaveLoadFailureReason = 'not-found' | 'parse-error' | 'wrong-game-id' | 'future-version' | 'validation' | 'unknown'` — Reason a load or import operation failed. `src/core/save-manager.ts:199`
- `interface SaveLoadResult` — Result of a save load or import operation. `src/core/save-manager.ts:166`
- `interface SaveManager extends Emittable<SaveEvents>` — Multi-slot save manager: saves, loads, imports and exports live state, versioned. `src/core/save-manager.ts:284`
- `interface SaveManagerOptions` `src/core/save-manager.ts:113`
- `type SaveMigration = (data: Record<string, unknown>) => Record<string, unknown>` — One consumer save migration: it receives the save data written at save version N and returns it reshaped for save version N + 1. `src/core/save-manager.ts:110`
- `interface SavePeek` — Lightweight save metadata returned without full deserialization. `src/core/save-manager.ts:172`
- `interface SaveSlot` — A named save slot. `src/core/save-manager.ts:182`
- `function setNested(data: SaveData, path: string, value: unknown): void` — Write `value` at a `.`-separated nested path, creating intermediate objects as needed. `src/core/save-migrations.ts:64`
- `interface StorageAdapter` — Pluggable storage backend. `src/core/save-manager.ts:68`
- `function validateSaveData(refs: Map<string, Persistent>, data: Record<string, unknown>, options: ValidateSaveDataOptions): ValidateSaveDataResult` — Validate raw save data against the live persistent-ref registry. `src/core/save-validation.ts:208`
- `interface ValidateSaveDataOptions` `src/core/save-validation.ts:183`
- `interface ValidateSaveDataResult` `src/core/save-validation.ts:190`
- `interface ValidationIssue` — A single field-level validation failure, suitable for `save:validation-failed`. `src/core/save-validation.ts:75`

## Time bank

a store of banked seconds, spent as acceleration or a burst discharge

- `interface BankedAcceleration` — Spend-loop handle returned by createBankedAcceleration. `src/systems/time-bank.ts:180`
- `interface BankedAccelerationOptions` `src/systems/time-bank.ts:142`
- `function burstDischarge(bank: TimeBank, tickDriver: TickDriver, options?: BurstDischargeOptions): number` — Spend (a fraction of) a TimeBank as one immediate fast-forward: withdraw, then replay the seconds through processOfflineTime in a single burst. `src/systems/time-bank.ts:352`
- `interface BurstDischargeOptions` `src/systems/time-bank.ts:312`
- `function createBankedAcceleration(options: BankedAccelerationOptions): BankedAcceleration` — The live game speed spend loop over a TimeBank. `src/systems/time-bank.ts:227`
- `function createTimeBank(options?: TimeBankOptions): TimeBank` — Create a time bank: a saved store of seconds that consumer policy deposits. `src/systems/time-bank.ts:109`
- `interface TimeBank` — The time bank createTimeBank returns. `src/systems/time-bank.ts:70`
- `interface TimeBankOptions` `src/systems/time-bank.ts:49`
