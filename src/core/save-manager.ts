/**
 * Save Manager — saves of live state, with multi-slot support
 *
 * Manages save and load, import and export, and multiple save slots.
 * Each slot stores a versioned {@link SaveEnvelope}, with automatic save migration.
 *
 * Key features:
 * - Multiple named save slots with auto-increment ids
 * - Active slot selection (save and load operate on the active slot)
 * - Peek any slot's metadata without full deserialization
 * - Export and import for save sharing
 * - An older single-slot save moves into slot 0
 *
 * @example
 * ```ts
 * const mgr = createSaveManager({ gameId: 'my-game' });
 * mgr.createSlot('Manual Save');  // slot 1
 * mgr.selectSlot(1);
 * mgr.save();       // save, and the engine's autosave, now write slot 1
 * mgr.peekSlot(0);  // peek slot 0 without switching
 * ```
 *
 * @cluster save
 */

import {
  getAllPersistentRefs,
  serializePersistents,
  deserializePersistents,
  deferHydration,
  filterDefaultedRefs,
  withPersistenceNamespace,
  PersistentId,
  DefaultValue,
  SaveDataPath,
  type Persistent,
} from './persistence';
import { setNested } from './save-migrations';
import { createEmitHandle, type Emittable } from './events';
import { validateSaveData, type ValidationIssue } from './save-validation';
import { isDev } from './common';
import { Decimal } from '@/primitives/decimal';
import { shallowRef } from 'vue';
import LZString from 'lz-string';
const { compressToBase64, decompressFromBase64 } = LZString;

/**
 * The engine save version, stored in the envelope under `_engine.version`.
 *
 * Bumped when the engine changes how it writes save data in a way consumer
 * content does not drive. It is separate from `SaveManagerOptions.saveVersion`,
 * so consumers don't bump their save version each time the engine changes its
 * envelope format. A save with a higher engine save version than this one is
 * refused with `future-version`.
 *
 * Engine save versions:
 * - `1` (implicit, absent `_engine`): iteration-order keys (`contextId.0`, `contextId.1`, …)
 * - `2`: keys by id (`contextId.refId` or `contextId.defId.field`), plus the key remap from v1
 * - `3`: `data` is an lz-string base64-compressed JSON string when `_engine.compression === 'lz'`.
 *   Pruning of defaulted leaves is also active. A read detects it by the
 *   `_engine.compression` field; `compressSave: false` opts out at write time.
 */
export const ENGINE_SAVE_VERSION = 3;

// === TYPES ===

/** Pluggable storage backend. Defaults to localStorage when available. */
export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Canonical in-memory {@link StorageAdapter} backed by a `Map`. Each call
 * returns a fresh, independent store — two invocations do not share state.
 *
 * Use for scratch engines, Vitest tests, headless runs, and any consumer
 * that wants save-manager semantics without touching `localStorage`. Matches
 * the localStorage contract: `getItem` returns `null` for missing keys,
 * `setItem` overwrites, `removeItem` is idempotent.
 *
 * @example
 * ```ts
 * const engine = createEngine({
 *   gameId: 'sandbox',
 *   storageAdapter: createMemoryStorage(),
 * });
 * ```
 */
export function createMemoryStorage(): StorageAdapter {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

/**
 * One consumer save migration: it receives the save data written at save
 * version N and returns it reshaped for save version N + 1. Mutating in place
 * is fine, but the step must still return the object. The save migration
 * utilities (`renameField` and friends) return it for the arrow shorthand.
 */
export type SaveMigration = (data: Record<string, unknown>) => Record<string, unknown>;

/** Options for creating a save manager. */
export interface SaveManagerOptions {
  /** Unique game identifier — prefixes all storage keys to avoid conflicts. */
  gameId: string;
  /**
   * The persistence namespace. When set, storage keys contain it
   * (`${gameId}:${namespace}-slot-${id}`), and the save walks only the
   * persistent contexts opened under it. Save event handlers and hydration
   * run inside it. Undefined means one engine with no persistence namespace.
   *
   * The engine passes it from `EngineOptions.persistenceNamespace`. A direct
   * `createSaveManager` consumer needs it only to wire a scratch engine by hand.
   */
  persistenceNamespace?: string;
  /** The consumer's save version. A load runs the save migrations up to it. Default: 1. */
  saveVersion?: number;
  /** Pluggable storage backend. Defaults to localStorage when available. */
  storageAdapter?: StorageAdapter;
  /**
   * Save migrations keyed by the save version they migrate from. Every load
   * runs them in order up to `saveVersion`. A step that returns anything but
   * an object fails the load with `unknown`.
   */
  migrations?: Record<number, SaveMigration>;
  /**
   * Display name for the default slot (id 0). Default: 'Autosave'. It is
   * only display text: the engine's autosave writes the active slot, not slot 0.
   */
  defaultSlotDisplayName?: string;
  /** Maximum number of save slots. Default: 10 */
  maxSlots?: number;
  /**
   * When true, any save validation failure aborts the load with
   * `save:load-failed { reason: 'validation' }`. When false, failing leaves
   * are self-healed to their ref default and the load
   * proceeds. `save:validation-failed` is emitted per field in both modes.
   *
   * Defaults to dev-mode detection: fail-loud in development (so bugs show
   * early), self-heal in production (so player saves stay protected).
   */
  strictValidation?: boolean;
  /**
   * Compress the envelope's `data` field with lz-string before write. Reads
   * always auto-detect via `_engine.compression`, so this only affects new
   * saves. Default `true` — the size win is large (3-5×) and consumer code
   * is unaffected.
   *
   * Set `false` for dev-mode tooling that inspects the envelope without
   * decompressing. Tests that assert on the stored shape also use this opt-out.
   */
  compressSave?: boolean;
}

/** Result of a save load or import operation. */
export interface SaveLoadResult {
  success: boolean;
  timestamp?: number;
}

/** Lightweight save metadata returned without full deserialization */
export interface SavePeek {
  timestamp: number;
  version: number;
  /** Id of the active mod when the save was written, if any */
  modId?: string;
  /** Game-provided metadata for display (e.g. play time, run count) */
  metadata?: Record<string, unknown>;
}

/** A named save slot */
export interface SaveSlot {
  id: number;
  displayName: string;
}

/**
 * Reason a load or import operation failed. It reports the failure mode that
 * the catch-all `{success: false}` return cannot express.
 *
 * - `not-found`: no envelope exists at the target storage key
 * - `parse-error`: raw data was not valid JSON
 * - `wrong-game-id`: envelope parsed but its `gameId` doesn't match this manager
 * - `future-version`: a newer game build or engine wrote the save: its save
 *   version exceeds this manager's, or its engine save version exceeds this engine's
 * - `validation`: runtime Zod validation failed in strict mode
 * - `unknown`: any other thrown error during a load, save migration or deserialize
 */
export type SaveLoadFailureReason =
  | 'not-found'
  | 'parse-error'
  | 'wrong-game-id'
  | 'future-version'
  | 'validation'
  | 'unknown';

/**
 * Events emitted by a SaveManager. Subscribe via `mgr.on(event, handler)`.
 *
 * `slotId` is the slot the operation targeted — the active slot at the time of
 * the call. `importSave` applies to the live state under the active slot, so
 * its events contain that id. It does not itself write storage until the next `save()`.
 */
export interface SaveEvents {
  /**
   * A save was successfully loaded or imported. Engine systems hydrate
   * their live state from it after every handler has run.
   */
  'save:loaded': (meta: { slotId: number; timestamp: number; version: number }) => void;
  /** A load or import failed. `detail` contains the underlying error when available. */
  'save:load-failed': (err: {
    slotId: number;
    reason: SaveLoadFailureReason;
    detail?: unknown;
  }) => void;
  /**
   * A newer game build or engine wrote the save. `kind: 'game'` compares the
   * envelope's `version` with `SaveManagerOptions.saveVersion`. `kind: 'engine'`
   * compares its engine save version with this engine's, and a game can't migrate that.
   */
  'save:future-version-refused': (err: {
    slotId: number;
    kind: 'game' | 'engine';
    writtenVersion: number;
    supportedVersion: number;
  }) => void;
  /**
   * A persistent ref's leaf value failed Zod validation. `action` names what
   * was done: `self-heal` means the leaf was deleted and the ref loads its ref
   * default; `fail` means strict mode aborted the load.
   */
  'save:validation-failed': (err: {
    path: string;
    expected: string;
    received: unknown;
    action: 'self-heal' | 'fail';
  }) => void;
  /**
   * An engine system's hydration threw after a load or import succeeded, or a
   * watcher reacting to one of its writes did. Hydration runs after
   * `save:loaded` and every `onLoad` handler. By then the refs hold the save,
   * so the load stands, the slot stays unprotected, and the remaining
   * hydration handlers still run. `detail` is the thrown error, also logged
   * with `console.error`.
   */
  'save:hydration-failed': (err: { slotId: number; detail: unknown }) => void;
  /** A consumer save migration ran during a load. */
  'save:migration-applied': (info: { from: number; to: number }) => void;
  /**
   * Live state is about to be serialized, by `save`, `saveToSlot` or
   * `exportSave`. Handlers run synchronously first, so one that flushes
   * derived state into persistent refs is in the written save.
   */
  'save:before-serialize': () => void;
  /**
   * A save was written to storage: `save`, `saveToSlot` or the engine's
   * autosave wrote `slotId`. The event for "Saved" feedback. Unlike
   * `save:before-serialize`, it never fires for `exportSave`, for a protected
   * slot that refused the write, or when the storage write threw.
   */
  'save:written': (info: { slotId: number; timestamp: number }) => void;
  /**
   * `load()` refused a slot for a reason other than `not-found`, so the slot
   * still holds a save the live state doesn't reflect. `save()` and
   * `saveToSlot()` skip it until {@link SaveManager.releaseSlot}, `deleteSave`,
   * a raw write (`importSlot` / `replaceSlot`) or a successful `load` /
   * `importSave` on it. Otherwise the next autosave would overwrite the save
   * the load just refused.
   */
  'save:slot-protected': (info: { slotId: number; reason: SaveLoadFailureReason }) => void;
}

/** Multi-slot save manager: saves, loads, imports and exports live state, versioned. */
export interface SaveManager extends Emittable<SaveEvents> {
  // --- Active slot operations ---
  /** Write live state to the active slot. Skipped while the slot is protected. */
  save(): void;
  /**
   * Load the active slot into live state. A failure other than `not-found`
   * protects the slot (see `save:slot-protected`).
   */
  load(): SaveLoadResult;
  exportSave(): string;
  importSave(data: string): SaveLoadResult;
  hasSave(): boolean;
  /** Remove the active slot's save, lifting its protection. */
  deleteSave(): void;
  /** Peek the active slot's metadata */
  peek(): SavePeek | null;
  /** Id of the mod to include in the next save envelope. Set by the engine. */
  modId: string | undefined;

  // --- Slot management ---
  /** Id of the active slot */
  readonly activeSlotId: number;
  /** All save slots (id and display name) */
  readonly slots: readonly SaveSlot[];
  /** Create a new slot. Returns the new slot's id. */
  createSlot(displayName?: string): number;
  /** Delete a slot by id. Throws if it's the active slot. */
  deleteSlot(slotId: number): void;
  /** Rename a slot */
  renameSlot(slotId: number, displayName: string): void;
  /** Switch the active slot. save/load/peek/etc. will operate on this slot. */
  selectSlot(slotId: number): void;
  /** Peek any slot's metadata without switching or deserializing */
  peekSlot(slotId: number): SavePeek | null;
  /**
   * Save live state to a specific slot without changing the active slot.
   * Skipped while that slot is protected.
   */
  saveToSlot(slotId: number): void;
  /**
   * Whether a failed load has protected `slotId` from writes of live state.
   * See `save:slot-protected`.
   */
  isSlotProtected(slotId: number): boolean;
  /**
   * Lift a failed load's protection from `slotId`, so the next `save()` or
   * `saveToSlot()` overwrites the save it refused. Call once the player has
   * chosen to discard that save.
   */
  releaseSlot(slotId: number): void;
  /** Find a slot by display name. Returns the slot or undefined if not found. */
  findSlotByDisplayName(name: string): SaveSlot | undefined;
  /** Set a function that provides metadata to include in save envelopes. */
  setMetadataProvider(fn: () => Record<string, unknown>): void;

  // --- Slot-to-slot copy (run-branching, accept-branch, portable snapshots) ---
  /**
   * Allocate a new slot and copy `srcId`'s on-disk envelope into it byte-for-byte.
   * Source slot must exist; if it has no saved data, the new slot is created
   * empty (mirroring `createSlot()` alone). Does not touch the active slot.
   * Returns the new slot's id.
   */
  duplicateSlot(srcId: number, name?: string): number;
  /**
   * Overwrite `destId`'s on-disk envelope with `srcId`'s. Both slots must exist.
   * If the source has no saved data, the destination is cleared. Does not touch
   * the active slot. Used by accept-branch flows that promote a branch slot's
   * state into the parent slot.
   */
  replaceSlot(srcId: number, destId: number): void;
  /**
   * Return the save text stored for `slotId`, or `null` if the slot has no
   * saved data. Slot must exist. Unlike `exportSave()`, this does not
   * serialize live state: it reads what the slot stores now, whether or not
   * it is the active slot.
   */
  exportSlot(slotId: number): string | null;
  /**
   * Write save text into a slot's storage entry without loading it into the
   * live engine. Validates that the envelope parses and that its
   * `gameId` matches; emits `save:load-failed` and returns failure otherwise.
   * When `slotId` is omitted, allocates a new slot and writes into it. Use
   * `selectSlot(id)` + `load()` to activate the imported slot afterwards.
   */
  importSlot(data: string, slotId?: number): SaveLoadResult & { slotId?: number };
}

// === INTERNAL TYPES ===

interface SaveEnvelope {
  version: number;
  gameId: string;
  timestamp: number;
  /**
   * The save data. Object when uncompressed (engine v1, v2, or v3 with
   * `compressSave: false`); lz-string base64 string when v3 with
   * `_engine.compression === 'lz'`. `applyEnvelope` normalizes to object
   * before the save migration / validate / deserialize chain runs.
   */
  data: Record<string, unknown> | string;
  modId?: string;
  metadata?: Record<string, unknown>;
  /**
   * Engine-side envelope metadata, present from engine save version 2. Its
   * absence means engine save version 1, which triggers the key remap.
   */
  _engine?: {
    version: number;
    /** Compression algorithm applied to `data`. Absent = uncompressed. */
    compression?: 'lz';
  };
}

/**
 * Remap a v1 envelope (iteration-order keys) to v2 (keys by id).
 *
 * v1 save data for a persistent context looks like `{ jobs: { "0": …, "1": … } }`.
 * v2 expects `{ jobs: { progress: …, timesCompleted: … } }`. The persistent-ref
 * registry's iteration order is authoritative: the Nth ref in the persistent
 * context's Set owns the Nth index in the old save. A ref that still has no
 * id moves to the key the loading build reads for it. That key is its index
 * among the persistent context's refs with no id.
 *
 * Best-effort: the ref's default may have a runtime type incompatible with the
 * old value. Then the old value is removed and the ref loads its ref default.
 * A warning is logged per suspect remap, so the fragility is observable.
 */
function migrateIndexToNamed(
  data: Record<string, unknown>,
  refs: Map<string, Persistent>,
): Record<string, unknown> {
  // Group the live refs by contextId, in registry iteration order.
  // getAllPersistentRefs has already populated SaveDataPath[0] = contextId.
  const byContext = new Map<string, Persistent[]>();
  for (const ref of refs.values()) {
    const contextId = ref[SaveDataPath]?.[0];
    if (!contextId) continue;
    if (!byContext.has(contextId)) byContext.set(contextId, []);
    byContext.get(contextId)!.push(ref);
  }

  const out: Record<string, unknown> = { ...data };
  for (const [contextId, contextRefs] of byContext) {
    const bucket = out[contextId];
    if (bucket == null || typeof bucket !== 'object') continue;
    // Only migrate buckets that look fully numeric-keyed (v1 shape). A single
    // non-numeric key means it's already v2 or hand-shaped and we skip.
    const keys = Object.keys(bucket);
    const allNumeric = keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
    if (!allNumeric) continue;

    const remapped: Record<string, unknown> = {};
    for (let i = 0; i < contextRefs.length; i++) {
      const ref = contextRefs[i];
      const oldVal = (bucket as Record<string, unknown>)[String(i)];
      if (oldVal === undefined) continue;
      const newKey = ref[PersistentId] ?? ref[SaveDataPath]![1];
      if (!looseTypeMatch(ref[DefaultValue], oldVal)) {
        console.warn(
          `[save] Version 1 key remap type mismatch at "${contextId}.${i}" → "${contextId}.${newKey}": ` +
            `expected ${describeType(ref[DefaultValue])}, got ${describeType(oldVal)}. Falling back to default.`,
        );
        continue;
      }
      setNested(remapped, newKey, oldVal);
    }
    out[contextId] = remapped;
  }

  return out;
}

function looseTypeMatch(expected: unknown, actual: unknown): boolean {
  if (expected === null || expected === undefined) return true;
  const et = typeof expected;
  const at = typeof actual;
  if (et === at) return true;
  // Decimal-encoded-as-string round-trips are common; accept string↔number↔boolean pairs loosely only when
  // the expected type is one that the existing deserialize path can coerce.
  if (et === 'number' && at === 'string') return true; // non-finite numbers serialize as strings
  if (expected instanceof Decimal && at === 'string') return true; // Decimal refs serialize via .toString()
  return false;
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// === FACTORY ===

/** Sentinel thrown by the load path to pass a typed failure to the one place that reports it. */
class LoadFailure extends Error {
  constructor(
    public readonly reason: SaveLoadFailureReason,
    public readonly detail?: unknown,
  ) {
    super(`Save load failed: ${reason}`);
  }
}

/**
 * Parse raw save text into an envelope, rejecting anything without a finite
 * numeric `version` and an object- or string-typed `data`. Throws
 * `LoadFailure('parse-error')` whose detail is the underlying error.
 */
function parseEnvelope(raw: string): SaveEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LoadFailure('parse-error', err);
  }
  const e = parsed as Partial<SaveEnvelope> | null;
  const dataOk = typeof e?.data === 'string' || (typeof e?.data === 'object' && e.data !== null);
  if (typeof e !== 'object' || e === null || !Number.isFinite(e.version) || !dataOk) {
    throw new LoadFailure('parse-error', new Error('not a save envelope'));
  }
  return e as SaveEnvelope;
}

/**
 * Create a save manager: serialization, slot management, save migrations and
 * validation over the persistent-ref registry. The engine builds one unless
 * {@link EngineOptions.persistence} is `false`. Call it directly only to
 * assemble saving outside `createEngine`.
 *
 * Storage keys are prefixed with `gameId` (and `persistenceNamespace`, if
 * given), so two engines sharing a runtime never collide. The returned manager
 * emits the {@link SaveEvents} (`save:loaded`, `save:load-failed`,
 * `save:validation-failed` and the rest) for instrumentation.
 *
 * @param options - {@link SaveManagerOptions} with `gameId`, `saveVersion`,
 *   `migrations`, the optional storage adapter, and the slot and compression options.
 * @returns A {@link SaveManager} with `save` / `load` / `peek`, slot
 *   operations, and `on(...)` for its events.
 *
 * @example
 * ```ts
 * const saves = createSaveManager({
 *   gameId: 'my-game',
 *   saveVersion: 3,
 *   migrations: {
 *     1: (data) => migrateV1toV2(data),
 *     2: (data) => migrateV2toV3(data),
 *   },
 * });
 * saves.on('save:validation-failed', (issue) => log('save issue', issue));
 * ```
 */
export function createSaveManager(options: SaveManagerOptions): SaveManager {
  const {
    gameId,
    persistenceNamespace,
    saveVersion: version = 1,
    migrations = {},
    defaultSlotDisplayName = 'Autosave',
    maxSlots = 10,
    strictValidation = isDev(),
    compressSave = true,
  } = options;

  // The storage key prefix contains the persistence namespace, so two engines
  // with the same gameId don't alias each other in localStorage. With no
  // persistence namespace, the key keeps the plain `${gameId}-…` shape.
  const storagePrefix = persistenceNamespace ? `${gameId}:${persistenceNamespace}` : gameId;

  const slotsKey = `${storagePrefix}-slots`;
  const storage: StorageAdapter = options.storageAdapter ?? {
    getItem: (key) => (typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null),
    setItem: (key, value) => {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    },
    removeItem: (key) => {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
    },
  };

  const handle = createEmitHandle<SaveEvents>();

  const _modId = shallowRef<string | undefined>(undefined);
  const _activeSlotId = shallowRef(0);
  const _slots: SaveSlot[] = [];
  // `slots` hands out a copy rebuilt per mutation: the same array reference
  // would let a computed over it dedupe a rename away.
  const slotsVersion = shallowRef(0);
  let _slotsView: readonly SaveSlot[] | null = null;
  function bumpSlots(): void {
    _slotsView = null;
    slotsVersion.value++;
  }
  let _metadataProvider: (() => Record<string, unknown>) | null = null;
  // Slots whose load failed on a save that storage still holds.
  const _protectedSlots = new Set<number>();

  // === SLOT INDEX PERSISTENCE ===

  function loadSlotIndex(): SaveSlot[] {
    const raw = storage.getItem(slotsKey);
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed as SaveSlot[];
      } catch {
        // Corrupted index — fall through to default
      }
    }
    return [];
  }

  function saveSlotIndex(): void {
    bumpSlots();
    storage.setItem(slotsKey, JSON.stringify(_slots));
  }

  function slotStorageKey(slotId: number): string {
    return `${storagePrefix}-slot-${slotId}`;
  }

  // === SINGLE-SLOT LAYOUT ===
  // If an older single-slot save exists but no slot index, move it to slot 0
  function migrateLegacy(): void {
    const legacyKey = `${storagePrefix}-save`;
    const legacyData = storage.getItem(legacyKey);
    if (legacyData && _slots.length === 0) {
      _slots.push({ id: 0, displayName: defaultSlotDisplayName });
      storage.setItem(slotStorageKey(0), legacyData);
      storage.removeItem(legacyKey);
      saveSlotIndex();
    }
  }

  // === INITIALIZE ===
  _slots.push(...loadSlotIndex());
  migrateLegacy();

  // Ensure default slot exists
  if (_slots.length === 0) {
    _slots.push({ id: 0, displayName: defaultSlotDisplayName });
    saveSlotIndex();
  }

  // === ENVELOPE HELPERS ===

  function activeStorageKey(): string {
    return slotStorageKey(_activeSlotId.value);
  }

  /**
   * Run `fn` inside this manager's persistence namespace. So the save event
   * handlers and the hydration it triggers see it, whichever method a
   * consumer called.
   */
  function inNamespace<T>(fn: () => T): T {
    return withPersistenceNamespace(persistenceNamespace, fn);
  }

  function buildEnvelope(): SaveEnvelope {
    const dataObj = inNamespace(() => {
      handle.emit('save:before-serialize');
      return serializePersistents(filterDefaultedRefs(getAllPersistentRefs(persistenceNamespace)));
    });
    const base = {
      version,
      gameId,
      timestamp: Date.now(),
      modId: _modId.value,
      metadata: _metadataProvider?.() ?? undefined,
    };
    if (compressSave) {
      return {
        ...base,
        data: compressToBase64(JSON.stringify(dataObj)),
        _engine: { version: ENGINE_SAVE_VERSION, compression: 'lz' },
      };
    }
    return {
      ...base,
      data: dataObj,
      _engine: { version: ENGINE_SAVE_VERSION },
    };
  }

  /** Serialize live state into `slotId` unless it's protected, announcing the write. */
  function writeSlot(slotId: number): void {
    if (_protectedSlots.has(slotId)) return;
    const envelope = buildEnvelope();
    storage.setItem(slotStorageKey(slotId), JSON.stringify(envelope));
    handle.emit('save:written', { slotId, timestamp: envelope.timestamp });
  }

  /**
   * Write raw save text into `slotId`, or remove its save when `raw` is null.
   * Storage then no longer holds the save a failed load refused, so the
   * slot's protection lifts.
   */
  function writeRawSlot(slotId: number, raw: string | null): void {
    if (raw === null) storage.removeItem(slotStorageKey(slotId));
    else storage.setItem(slotStorageKey(slotId), raw);
    _protectedSlots.delete(slotId);
  }

  /**
   * Normalize an envelope's `data` field to an object: if v3 envelope marks
   * `_engine.compression === 'lz'`, decompress and JSON.parse. Throws
   * `LoadFailure('parse-error')` on any decompression / parse failure.
   */
  function decompressData(envelope: SaveEnvelope): Record<string, unknown> {
    if (envelope._engine?.compression === 'lz') {
      if (typeof envelope.data !== 'string') {
        throw new LoadFailure(
          'parse-error',
          new Error('compressed envelope: data must be a string'),
        );
      }
      const json = decompressFromBase64(envelope.data);
      if (json === null || json === '') {
        throw new LoadFailure('parse-error', new Error('lz-string decompression failed'));
      }
      try {
        return JSON.parse(json) as Record<string, unknown>;
      } catch (err) {
        throw new LoadFailure('parse-error', err);
      }
    }
    if (typeof envelope.data === 'string') {
      throw new LoadFailure(
        'parse-error',
        new Error('uncompressed envelope: data must be an object'),
      );
    }
    return envelope.data;
  }

  function applyEnvelope(envelope: SaveEnvelope, slotId: number): void {
    // Future-version guards: if the save was written by a newer build than
    // this manager knows how to handle, don't read or migrate unknown data.
    // The engine's comes first, since its format decides how `data` decodes.
    const engineVersion = envelope._engine?.version ?? 1;
    if (engineVersion > ENGINE_SAVE_VERSION) {
      handle.emit('save:future-version-refused', {
        slotId,
        kind: 'engine',
        writtenVersion: engineVersion,
        supportedVersion: ENGINE_SAVE_VERSION,
      });
      throw new LoadFailure('future-version');
    }
    if (envelope.version > version) {
      handle.emit('save:future-version-refused', {
        slotId,
        kind: 'game',
        writtenVersion: envelope.version,
        supportedVersion: version,
      });
      throw new LoadFailure('future-version');
    }

    let data = decompressData(envelope);
    let v = envelope.version;
    while (v < version) {
      const m = migrations[v];
      if (m) {
        const next: unknown = m(data);
        if (next === null || typeof next !== 'object' || Array.isArray(next)) {
          throw new LoadFailure(
            'unknown',
            new Error(
              `save migration from save version ${v} returned ${describeType(next)}, not an object`,
            ),
          );
        }
        data = next as Record<string, unknown>;
        handle.emit('save:migration-applied', { from: v, to: v + 1 });
      }
      v++;
    }
    // Engine key remap: iteration-order keys → keys by id. It runs after the
    // consumer's save migrations (which reshape per save version) and before
    // deserialize, because only here is the persistent-ref registry at hand.
    const refs = getAllPersistentRefs(persistenceNamespace);
    // v2 already wrote keys by id, so only a v1 envelope is remapped.
    if (engineVersion < 2) {
      data = migrateIndexToNamed(data, refs);
    }

    // Runtime validation: single pass after save migrations, before deserialize.
    // Field-level failures emit save:validation-failed; in strict mode the
    // first failure aborts via LoadFailure, otherwise the failing leaves
    // are deleted from `data` and deserialize falls back to ref defaults.
    const validation = validateSaveData(refs, data, {
      strict: strictValidation,
      onIssue: (issue: ValidationIssue) => {
        handle.emit('save:validation-failed', issue);
      },
    });
    if (!validation.ok) {
      throw new LoadFailure('validation');
    }

    deserializePersistents(refs, validation.data, persistenceNamespace);
  }

  /** Parse raw save text as an envelope of this game. Throws a `LoadFailure`. */
  function readEnvelope(raw: string): SaveEnvelope {
    const e = parseEnvelope(raw);
    if (e.gameId !== gameId) throw new LoadFailure('wrong-game-id');
    return e;
  }

  /** Announce a failed load or import of `slotId`, protecting the slot when asked. */
  function failLoad(slotId: number, err: unknown, protect: boolean): SaveLoadResult {
    const [reason, detail]: [SaveLoadFailureReason, unknown] =
      err instanceof LoadFailure ? [err.reason, err.detail] : ['unknown', err];
    handle.emit('save:load-failed', { slotId, reason, detail });
    if (protect) {
      _protectedSlots.add(slotId);
      handle.emit('save:slot-protected', { slotId, reason });
    }
    return { success: false };
  }

  /**
   * Parse, check and apply raw save text to live state under `slotId`, then
   * announce the outcome. `protectOnFail` decides whether a failure protects
   * the slot, which only a load from storage wants.
   */
  function applySaveText(raw: string, slotId: number, protectOnFail: boolean): SaveLoadResult {
    return inNamespace(() =>
      deferHydration(() => {
        let e: SaveEnvelope;
        try {
          e = readEnvelope(raw);
          applyEnvelope(e, slotId);
        } catch (err) {
          return failLoad(slotId, err, protectOnFail);
        }
        _protectedSlots.delete(slotId);
        handle.emit('save:loaded', { slotId, timestamp: e.timestamp, version: e.version });
        return { success: true, timestamp: e.timestamp };
      }, reportHydrationError(slotId)),
    );
  }

  /** Report a hydration throw without failing the load before it. */
  function reportHydrationError(slotId: number): (err: unknown) => void {
    return (err) => {
      console.error('A hydration after a successful save load threw; the load stands.', err);
      handle.emit('save:hydration-failed', { slotId, detail: err });
    };
  }

  function peekRaw(key: string): SavePeek | null {
    const raw = storage.getItem(key);
    if (!raw) return null;
    try {
      const e = readEnvelope(raw);
      return {
        timestamp: e.timestamp,
        version: e.version,
        modId: e.modId,
        metadata: e.metadata,
      };
    } catch {
      return null;
    }
  }

  function allocSlot(name?: string): number {
    if (_slots.length >= maxSlots) {
      throw new Error(`Maximum save slots (${maxSlots}) reached`);
    }
    const nextId = Math.max(..._slots.map((s) => s.id)) + 1;
    const slotName = name ?? `Save ${nextId}`;
    _slots.push({ id: nextId, displayName: slotName });
    saveSlotIndex();
    return nextId;
  }

  // === PUBLIC API ===

  return {
    on: handle.on,

    // === ACTIVE SLOT OPERATIONS ===

    save() {
      writeSlot(_activeSlotId.value);
    },

    load(): SaveLoadResult {
      const raw = storage.getItem(activeStorageKey());
      if (!raw) return failLoad(_activeSlotId.value, new LoadFailure('not-found'), false);
      return applySaveText(raw, _activeSlotId.value, true);
    },

    exportSave() {
      return JSON.stringify(buildEnvelope());
    },

    importSave(data): SaveLoadResult {
      return applySaveText(data, _activeSlotId.value, false);
    },

    hasSave() {
      return storage.getItem(activeStorageKey()) !== null;
    },

    deleteSave() {
      writeRawSlot(_activeSlotId.value, null);
    },

    peek(): SavePeek | null {
      return peekRaw(activeStorageKey());
    },

    get modId() {
      return _modId.value;
    },
    set modId(id: string | undefined) {
      _modId.value = id;
    },

    // === SLOT MANAGEMENT ===

    get activeSlotId() {
      return _activeSlotId.value;
    },

    get slots(): readonly SaveSlot[] {
      void slotsVersion.value;
      return (_slotsView ??= _slots.map((s) => ({ ...s })));
    },

    createSlot(displayName?: string): number {
      return allocSlot(displayName);
    },

    deleteSlot(slotId: number): void {
      if (slotId === _activeSlotId.value) {
        throw new Error('Cannot delete the active save slot');
      }
      const idx = _slots.findIndex((s) => s.id === slotId);
      if (idx === -1) throw new Error(`Save slot ${slotId} not found`);
      _slots.splice(idx, 1);
      writeRawSlot(slotId, null);
      saveSlotIndex();
    },

    renameSlot(slotId: number, name: string): void {
      const slot = _slots.find((s) => s.id === slotId);
      if (!slot) throw new Error(`Save slot ${slotId} not found`);
      slot.displayName = name;
      saveSlotIndex();
    },

    selectSlot(slotId: number): void {
      const slot = _slots.find((s) => s.id === slotId);
      if (!slot) throw new Error(`Save slot ${slotId} not found`);
      _activeSlotId.value = slotId;
    },

    peekSlot(slotId: number): SavePeek | null {
      return peekRaw(slotStorageKey(slotId));
    },

    saveToSlot(slotId: number): void {
      const slot = _slots.find((s) => s.id === slotId);
      if (!slot) throw new Error(`Save slot ${slotId} not found`);
      writeSlot(slotId);
    },

    isSlotProtected(slotId: number): boolean {
      return _protectedSlots.has(slotId);
    },

    releaseSlot(slotId: number): void {
      _protectedSlots.delete(slotId);
    },

    findSlotByDisplayName(name: string): SaveSlot | undefined {
      return _slots.find((s) => s.displayName === name);
    },

    setMetadataProvider(fn: () => Record<string, unknown>): void {
      _metadataProvider = fn;
    },

    // === SLOT-TO-SLOT COPY ===

    duplicateSlot(srcId: number, name?: string): number {
      if (!_slots.find((s) => s.id === srcId)) {
        throw new Error(`Save slot ${srcId} not found`);
      }
      const destId = allocSlot(name);
      const raw = storage.getItem(slotStorageKey(srcId));
      if (raw !== null) writeRawSlot(destId, raw);
      return destId;
    },

    replaceSlot(srcId: number, destId: number): void {
      if (!_slots.find((s) => s.id === srcId)) {
        throw new Error(`Save slot ${srcId} not found`);
      }
      if (!_slots.find((s) => s.id === destId)) {
        throw new Error(`Save slot ${destId} not found`);
      }
      writeRawSlot(destId, storage.getItem(slotStorageKey(srcId)));
    },

    exportSlot(slotId: number): string | null {
      if (!_slots.find((s) => s.id === slotId)) {
        throw new Error(`Save slot ${slotId} not found`);
      }
      return storage.getItem(slotStorageKey(slotId));
    },

    importSlot(data: string, slotId?: number): SaveLoadResult & { slotId?: number } {
      let envelope: SaveEnvelope;
      try {
        envelope = readEnvelope(data);
      } catch (err) {
        return failLoad(slotId ?? _activeSlotId.value, err, false);
      }
      let targetId: number;
      if (slotId === undefined) {
        targetId = allocSlot();
      } else {
        if (!_slots.find((s) => s.id === slotId)) {
          throw new Error(`Save slot ${slotId} not found`);
        }
        targetId = slotId;
      }
      writeRawSlot(targetId, data);
      return { success: true, timestamp: envelope.timestamp, slotId: targetId };
    },
  };
}
