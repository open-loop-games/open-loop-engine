/**
 * Save Manager — persistent game state with multi-slot support
 *
 * Manages save/load, import/export, and multiple save slots.
 * Each slot stores a versioned {@link SaveEnvelope} with automatic migration.
 *
 * Key features:
 * - Multiple named save slots with auto-increment IDs
 * - Active slot selection (save/load operate on active slot)
 * - Peek any slot's metadata without full deserialization
 * - Export/import for save sharing
 * - Backwards-compatible migration from single-slot format
 *
 * @example
 * ```ts
 * const mgr = createSaveManager({ gameId: 'my-game' });
 * mgr.createSlot('Manual Save');  // slot 1
 * mgr.selectSlot(1);
 * mgr.save();
 * mgr.peekSlot(0);  // peek the autosave without switching
 * ```
 *
 * @cluster save
 */

import {
  getAllPersistentRefs,
  serializePersistents,
  deserializePersistents,
  filterDefaultedRefs,
  PersistentName,
  DefaultValue,
  SaveDataPath,
  type Persistent,
} from './persistence';
import { createEmitHandle, type Emittable } from './events';
import { validateSaveData, type ValidationIssue } from './save-validation';
import { isDev } from './common';
import LZString from 'lz-string';
const { compressToBase64, decompressFromBase64 } = LZString;

/**
 * Engine-internal save-format version, stored in the envelope under `_engine.version`.
 *
 * Bumped when the engine changes how it writes save data in a way that isn't
 * driven by consumer content. Decoupled from `SaveManagerConfig.version` so
 * consumers don't have to bump their game version every time the engine
 * upgrades its envelope format.
 *
 * Version history:
 * - `1` (implicit, absent `_engine`): original iteration-order keys (`contextId.0`, `contextId.1`, …)
 * - `2`: stable named keys (`contextId.name` or `contextId.defId.field`) plus legacy migration from v1
 * - `3`: `data` is an lz-string base64-compressed JSON string when `_engine.compression === 'lz'`.
 *   Pruning of defaulted leaves is also active. Auto-detect on read via the
 *   `_engine.compression` discriminator; `compressSave: false` opts out at write time.
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
 * Use for scratch engines, Vitest fixtures, headless runs, and any consumer
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

/** Configuration for creating a save manager. */
export interface SaveManagerConfig {
  /** Unique game identifier — prefixes all storage keys to avoid conflicts. */
  gameId: string;
  /**
   * Forkable-instance namespace. When set, storage keys carry the namespace
   * (`${gameId}:${namespace}-slot-${id}`) and `getAllPersistentRefs` is
   * walked filtered to contexts opened under the same namespace. Undefined
   * = legacy single-engine path, bit-for-bit compatible.
   *
   * Normally passed through from `EngineConfig.persistenceNamespace`; the
   * engine is the expected caller. Direct `createSaveManager` consumers
   * only need this when manually wiring a scratch engine.
   */
  persistenceNamespace?: string;
  /** Current save format version. Used to drive migration on load. Default: 1. */
  version?: number;
  /** Pluggable storage backend. Defaults to localStorage when available. */
  storageAdapter?: StorageAdapter;
  /**
   * Migration functions keyed by the version they migrate FROM.
   * Each receives the raw data object and should return the transformed data.
   * Migrations run sequentially up to the current version on every load.
   */
  migrations?: Record<number, (data: unknown) => unknown>;
  /** Display name for the default slot (id 0). Default: 'Autosave' */
  defaultSlotName?: string;
  /** Maximum number of save slots. Default: 10 */
  maxSlots?: number;
  /**
   * When true, any save validation failure aborts the load with
   * `save:load-failed { reason: 'validation' }`. When false, failing leaves
   * are self-healed to their persistent ref's default value and the load
   * proceeds. `save:validation-error` is emitted per field in both modes.
   *
   * Defaults to dev-mode detection: fail-loud in development (so bugs surface
   * early), self-heal in production (so player saves stay protected).
   */
  strictValidation?: boolean;
  /**
   * Compress the envelope's `data` field with lz-string before write. Reads
   * always auto-detect via `_engine.compression`, so this only affects new
   * saves. Default `true` — the size win is large (3-5×) and consumer code
   * is unaffected.
   *
   * Set `false` for dev-mode tooling that wants to inspect raw envelope JSON
   * without decompressing. Test fixtures asserting on-disk shape also use
   * this opt-out.
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
  /** Active mod ID at time of save, if any */
  modId?: string;
  /** Game-provided metadata for display (e.g. playtime, loop count) */
  metadata?: Record<string, unknown>;
}

/** A named save slot */
export interface SaveSlot {
  id: number;
  name: string;
}

/**
 * Reason a load or import operation failed. Surfaces the failure mode that
 * the catch-all `{success: false}` return cannot express.
 *
 * - `not-found`: no envelope exists at the target storage key
 * - `parse-error`: raw data was not valid JSON
 * - `wrong-game-id`: envelope parsed but its `gameId` doesn't match this manager
 * - `future-version`: envelope's version exceeds this manager's current version
 * - `validation`: runtime Zod validation failed in strict mode
 * - `unknown`: any other thrown error during load/migration/deserialize
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
 * the call. `importSave` writes into the active slot, so it carries the same id.
 */
export interface SaveEvents {
  /** A save was successfully loaded or imported. */
  'save:loaded': (meta: { slotId: number; timestamp: number; version: number }) => void;
  /** A load or import failed. `detail` carries the underlying error when available. */
  'save:load-failed': (err: {
    slotId: number;
    reason: SaveLoadFailureReason;
    detail?: unknown;
  }) => void;
  /** An envelope's `version` exceeded the current `SaveManagerConfig.version`. */
  'save:future-version': (err: {
    slotId: number;
    saveVersion: number;
    currentVersion: number;
  }) => void;
  /**
   * A persistent ref's leaf value failed Zod validation. `action` reflects
   * the policy applied: `self-heal` means the leaf was dropped and the ref
   * will fall back to its default; `fail` means strict mode aborted the load.
   */
  'save:validation-error': (err: {
    path: string;
    expected: string;
    received: unknown;
    action: 'self-heal' | 'fail';
  }) => void;
  /** A consumer-provided migration step ran during load. */
  'save:migration-step': (info: { from: number; to: number }) => void;
}

/** Multi-slot save manager: persists, loads, imports, and exports versioned game state. */
export interface SaveManager extends Emittable<SaveEvents> {
  // --- Active slot operations ---
  save(): void;
  load(): SaveLoadResult;
  exportSave(): string;
  importSave(data: string): SaveLoadResult;
  hasSave(): boolean;
  deleteSave(): void;
  /** Peek the active slot's metadata */
  peek(): SavePeek | null;
  /** Mod ID to include in the next save envelope. Set by the engine. */
  modId: string | undefined;

  // --- Slot management ---
  /** ID of the currently active slot */
  readonly activeSlotId: number;
  /** All save slots (id + name) */
  readonly slots: readonly SaveSlot[];
  /** Create a new slot. Returns the new slot's ID. */
  createSlot(name?: string): number;
  /** Delete a slot by ID. Throws if it's the active slot. */
  deleteSlot(slotId: number): void;
  /** Rename a slot */
  renameSlot(slotId: number, name: string): void;
  /** Switch the active slot. save/load/peek/etc. will operate on this slot. */
  selectSlot(slotId: number): void;
  /** Peek any slot's metadata without switching or deserializing */
  peekSlot(slotId: number): SavePeek | null;
  /** Save current state to a specific slot without changing the active slot */
  saveToSlot(slotId: number): void;
  /** Find a slot by name. Returns the slot or undefined if not found. */
  findSlotByName(name: string): SaveSlot | undefined;
  /** Set a callback that provides metadata to include in save envelopes. */
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
   * Return the raw on-disk envelope JSON for `slotId`, or `null` if the slot
   * has no saved data. Slot must exist. Unlike `exportSave()`, this does not
   * serialize live state — it reads what's currently persisted for that slot,
   * regardless of whether it is the active slot.
   */
  exportSlot(slotId: number): string | null;
  /**
   * Write a raw envelope into a slot's storage entry without deserializing it
   * into the live engine. Validates that the envelope parses and that its
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
   * Persistent state. Object when uncompressed (engine v1, v2, or v3 with
   * `compressSave: false`); lz-string base64 string when v3 with
   * `_engine.compression === 'lz'`. `applyEnvelope` normalizes to object
   * before the migration / validate / deserialize chain runs.
   */
  data: Record<string, unknown> | string;
  modId?: string;
  metadata?: Record<string, unknown>;
  /**
   * Engine-side envelope metadata. Added in ENGINE_SAVE_VERSION 2 for stable
   * named persistent keys. Absence means pre-2, triggers legacy migration.
   */
  _engine?: {
    version: number;
    /** Compression algorithm applied to `data`. Absent = uncompressed. */
    compression?: 'lz';
  };
}

/**
 * Migrate a v1 envelope (iteration-order keys) into v2 (named keys).
 *
 * v1 save data for a context looks like `{ jobs: { "0": …, "1": … } }`.
 * v2 expects `{ jobs: { progress: …, timesCompleted: … } }`. The registry's
 * iteration order is authoritative: the Nth ref in the current context's
 * Set owns the Nth slot in the old save.
 *
 * Best-effort: when the current ref's default value has an incompatible
 * runtime type with the old value, the old value is dropped and the ref will
 * fall back to its default on deserialize. A warning is logged per suspect
 * remap so the fragility is observable.
 */
function migrateIndexToNamed(
  data: Record<string, unknown>,
  refs: Map<string, Persistent>,
): Record<string, unknown> {
  // Bucket the live refs by contextId, preserving registry iteration order.
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
      const name = ref[PersistentName];
      if (name === undefined) continue; // fall back to numeric slot
      const oldVal = (bucket as Record<string, unknown>)[String(i)];
      if (oldVal === undefined) continue;
      if (!looseTypeMatch(ref[DefaultValue], oldVal)) {
        console.warn(
          `[save] Legacy key migration type mismatch at "${contextId}.${i}" → "${contextId}.${name}": ` +
            `expected ${describeType(ref[DefaultValue])}, got ${describeType(oldVal)}. Falling back to default.`,
        );
        continue;
      }
      writeNested(remapped, name.split('.'), oldVal);
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
  return false;
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function writeNested(target: Record<string, unknown>, parts: string[], value: unknown): void {
  let cur = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!(k in cur) || typeof cur[k] !== 'object' || cur[k] === null) {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

// === FACTORY ===

/** Sentinel thrown by `applyEnvelope` to signal a typed failure to callers. */
class LoadFailure extends Error {
  constructor(
    public readonly reason: SaveLoadFailureReason,
    public readonly detail?: unknown,
  ) {
    super(`Save load failed: ${reason}`);
  }
}

/**
 * Create a save manager — orchestrates serialization, slot management,
 * migrations, and validation around the persistent-ref tree. Wired into the
 * engine automatically unless {@link EngineConfig.persistence} is `false`;
 * call directly only when assembling a save layer outside `createEngine`.
 *
 * Storage keys are prefixed with `gameId` (and `persistenceNamespace`, if
 * given), so two engines sharing a runtime never collide. The returned manager
 * emits `save` / `load` / `validation-error` events for instrumentation.
 *
 * @param config - {@link SaveManagerConfig} carrying `gameId`, version,
 *   migrations, the optional storage adapter, and slot/compression knobs.
 * @returns A {@link SaveManager} exposing `save` / `load` / `peek`, slot
 *   operations, and the `on(...)` subscription handle.
 *
 * @example
 * ```ts
 * const saves = createSaveManager({
 *   gameId: 'my-game',
 *   version: 3,
 *   migrations: {
 *     1: (data) => migrateV1toV2(data),
 *     2: (data) => migrateV2toV3(data),
 *   },
 * });
 * saves.on('validation-error', (issue) => log('save issue', issue));
 * ```
 */
export function createSaveManager(config: SaveManagerConfig): SaveManager {
  const {
    gameId,
    persistenceNamespace,
    version = 1,
    migrations = {},
    defaultSlotName = 'Autosave',
    maxSlots = 10,
    strictValidation = isDev(),
    compressSave = true,
  } = config;

  // Storage key prefix carries the namespace so two engines with the same
  // gameId don't alias each other in localStorage. Undefined namespace
  // preserves the legacy `${gameId}-…` shape exactly.
  const storagePrefix = persistenceNamespace ? `${gameId}:${persistenceNamespace}` : gameId;

  const slotsKey = `${storagePrefix}-slots`;
  const storage: StorageAdapter = config.storageAdapter ?? {
    getItem: (key) => (typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null),
    setItem: (key, value) => {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    },
    removeItem: (key) => {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
    },
  };

  const handle = createEmitHandle<SaveEvents>();

  let _modId: string | undefined;
  let _activeSlotId = 0;
  const _slots: SaveSlot[] = [];
  let _metadataProvider: (() => Record<string, unknown>) | null = null;

  // === SLOT INDEX PERSISTENCE ===

  function loadSlotIndex(): SaveSlot[] {
    const raw = storage.getItem(slotsKey);
    if (raw) {
      try {
        return JSON.parse(raw) as SaveSlot[];
      } catch {
        // Corrupted index — fall through to default
      }
    }
    return [];
  }

  function saveSlotIndex(): void {
    storage.setItem(slotsKey, JSON.stringify(_slots));
  }

  function slotStorageKey(slotId: number): string {
    return `${storagePrefix}-slot-${slotId}`;
  }

  // === LEGACY MIGRATION ===
  // If old single-slot save exists but no slot index, migrate to slot 0
  function migrateLegacy(): void {
    const legacyKey = `${storagePrefix}-save`;
    const legacyData = storage.getItem(legacyKey);
    if (legacyData && _slots.length === 0) {
      _slots.push({ id: 0, name: defaultSlotName });
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
    _slots.push({ id: 0, name: defaultSlotName });
    saveSlotIndex();
  }

  // === ENVELOPE HELPERS ===

  function activeStorageKey(): string {
    return slotStorageKey(_activeSlotId);
  }

  function buildEnvelope(): SaveEnvelope {
    const dataObj = serializePersistents(
      filterDefaultedRefs(getAllPersistentRefs(persistenceNamespace)),
    );
    const base = {
      version,
      gameId,
      timestamp: Date.now(),
      modId: _modId,
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
    // Future-version guard: if the save was written by a newer build than
    // this manager knows how to handle, don't run migrations on unknown data.
    if (envelope.version > version) {
      handle.emit('save:future-version', {
        slotId,
        saveVersion: envelope.version,
        currentVersion: version,
      });
      throw new LoadFailure('future-version');
    }

    let data = decompressData(envelope);
    let v = envelope.version;
    while (v < version) {
      const m = migrations[v];
      if (m) {
        data = m(data) as Record<string, unknown>;
        handle.emit('save:migration-step', { from: v, to: v + 1 });
      }
      v++;
    }
    // Engine-internal legacy migration: iteration-order keys → stable named keys.
    // Runs after the user migration chain (which reshapes per game version)
    // but before deserialize, since only here do we have the registry context.
    const engineVersion = envelope._engine?.version ?? 1;
    const refs = getAllPersistentRefs(persistenceNamespace);
    if (engineVersion < ENGINE_SAVE_VERSION) {
      data = migrateIndexToNamed(data, refs);
    }

    // Runtime validation: single pass after migrations, before deserialize.
    // Field-level failures emit save:validation-error; in strict mode the
    // first failure aborts via LoadFailure, otherwise the failing leaves
    // are dropped from `data` and deserialize falls back to defaults.
    const validation = validateSaveData(refs, data, {
      strict: strictValidation,
      onIssue: (issue: ValidationIssue) => {
        handle.emit('save:validation-error', issue);
      },
    });
    if (!validation.ok) {
      throw new LoadFailure('validation');
    }

    deserializePersistents(refs, validation.data);
  }

  function peekRaw(key: string): SavePeek | null {
    const raw = storage.getItem(key);
    if (!raw) return null;
    try {
      const e = JSON.parse(raw) as SaveEnvelope;
      if (e.gameId !== gameId) return null;
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
    _slots.push({ id: nextId, name: slotName });
    saveSlotIndex();
    return nextId;
  }

  // === PUBLIC API ===

  return {
    on: handle.on,

    // === ACTIVE SLOT OPERATIONS ===

    save() {
      storage.setItem(activeStorageKey(), JSON.stringify(buildEnvelope()));
    },

    load(): SaveLoadResult {
      const slotId = _activeSlotId;
      const raw = storage.getItem(activeStorageKey());
      if (!raw) {
        handle.emit('save:load-failed', { slotId, reason: 'not-found' });
        return { success: false };
      }
      let e: SaveEnvelope;
      try {
        e = JSON.parse(raw) as SaveEnvelope;
      } catch (detail) {
        handle.emit('save:load-failed', { slotId, reason: 'parse-error', detail });
        return { success: false };
      }
      if (e.gameId !== gameId) {
        handle.emit('save:load-failed', { slotId, reason: 'wrong-game-id' });
        return { success: false };
      }
      try {
        applyEnvelope(e, slotId);
      } catch (err) {
        if (err instanceof LoadFailure) {
          handle.emit('save:load-failed', { slotId, reason: err.reason, detail: err.detail });
        } else {
          handle.emit('save:load-failed', { slotId, reason: 'unknown', detail: err });
        }
        return { success: false };
      }
      handle.emit('save:loaded', { slotId, timestamp: e.timestamp, version: e.version });
      return { success: true, timestamp: e.timestamp };
    },

    exportSave() {
      return JSON.stringify(buildEnvelope());
    },

    importSave(data): SaveLoadResult {
      const slotId = _activeSlotId;
      let e: SaveEnvelope;
      try {
        e = JSON.parse(data) as SaveEnvelope;
      } catch (detail) {
        handle.emit('save:load-failed', { slotId, reason: 'parse-error', detail });
        return { success: false };
      }
      try {
        applyEnvelope(e, slotId);
      } catch (err) {
        if (err instanceof LoadFailure) {
          handle.emit('save:load-failed', { slotId, reason: err.reason, detail: err.detail });
        } else {
          handle.emit('save:load-failed', { slotId, reason: 'unknown', detail: err });
        }
        return { success: false };
      }
      handle.emit('save:loaded', { slotId, timestamp: e.timestamp, version: e.version });
      return { success: true, timestamp: e.timestamp };
    },

    hasSave() {
      return storage.getItem(activeStorageKey()) !== null;
    },

    deleteSave() {
      storage.removeItem(activeStorageKey());
    },

    peek(): SavePeek | null {
      return peekRaw(activeStorageKey());
    },

    get modId() {
      return _modId;
    },
    set modId(id: string | undefined) {
      _modId = id;
    },

    // === SLOT MANAGEMENT ===

    get activeSlotId() {
      return _activeSlotId;
    },

    get slots(): readonly SaveSlot[] {
      return _slots;
    },

    createSlot(name?: string): number {
      return allocSlot(name);
    },

    deleteSlot(slotId: number): void {
      if (slotId === _activeSlotId) {
        throw new Error('Cannot delete the active save slot');
      }
      const idx = _slots.findIndex((s) => s.id === slotId);
      if (idx === -1) throw new Error(`Save slot ${slotId} not found`);
      _slots.splice(idx, 1);
      storage.removeItem(slotStorageKey(slotId));
      saveSlotIndex();
    },

    renameSlot(slotId: number, name: string): void {
      const slot = _slots.find((s) => s.id === slotId);
      if (!slot) throw new Error(`Save slot ${slotId} not found`);
      slot.name = name;
      saveSlotIndex();
    },

    selectSlot(slotId: number): void {
      const slot = _slots.find((s) => s.id === slotId);
      if (!slot) throw new Error(`Save slot ${slotId} not found`);
      _activeSlotId = slotId;
    },

    peekSlot(slotId: number): SavePeek | null {
      return peekRaw(slotStorageKey(slotId));
    },

    saveToSlot(slotId: number): void {
      const slot = _slots.find((s) => s.id === slotId);
      if (!slot) throw new Error(`Save slot ${slotId} not found`);
      storage.setItem(slotStorageKey(slotId), JSON.stringify(buildEnvelope()));
    },

    findSlotByName(name: string): SaveSlot | undefined {
      return _slots.find((s) => s.name === name);
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
      if (raw !== null) storage.setItem(slotStorageKey(destId), raw);
      return destId;
    },

    replaceSlot(srcId: number, destId: number): void {
      if (!_slots.find((s) => s.id === srcId)) {
        throw new Error(`Save slot ${srcId} not found`);
      }
      if (!_slots.find((s) => s.id === destId)) {
        throw new Error(`Save slot ${destId} not found`);
      }
      const raw = storage.getItem(slotStorageKey(srcId));
      if (raw !== null) {
        storage.setItem(slotStorageKey(destId), raw);
      } else {
        storage.removeItem(slotStorageKey(destId));
      }
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
        envelope = JSON.parse(data) as SaveEnvelope;
      } catch (detail) {
        const targetId = slotId ?? _activeSlotId;
        handle.emit('save:load-failed', { slotId: targetId, reason: 'parse-error', detail });
        return { success: false };
      }
      if (envelope.gameId !== gameId) {
        const targetId = slotId ?? _activeSlotId;
        handle.emit('save:load-failed', { slotId: targetId, reason: 'wrong-game-id' });
        return { success: false };
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
      storage.setItem(slotStorageKey(targetId), data);
      return { success: true, timestamp: envelope.timestamp, slotId: targetId };
    },
  };
}
