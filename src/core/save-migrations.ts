/**
 * Save migrations — pure transforms for reshaping save data between save versions.
 *
 * Engine utilities that consumers compose into their `migrations[v]` function
 * bodies. Each utility mutates the same data object and returns it, so calls
 * chain. Every utility is a silent no-op when the target path doesn't exist.
 * So a save migration tolerates fields already absent (the player opted out
 * of a feature, loaded a fresh save, etc.).
 *
 * Path-key convention: `.` separates nested object keys, matching the
 * serialized shape produced by `serializePersistents`. Save data is the
 * nested object tree, never a flat dot-keyed record — `getNested(data,
 * 'jobs.warrior.progress')` reaches into `data.jobs.warrior.progress`, not a
 * literal `data['jobs.warrior.progress']`.
 *
 * Key features:
 * - `getNested` / `setNested` — foundation primitives shared with the
 *   serialize/deserialize paths
 * - `renameField`, `retypeField`, `deleteField`, `addField` — single-path
 *   transforms
 * - `forEachDef` — iterate over the def states in a persistent context's save data
 *
 * @cluster save
 */

// Internal alias for the raw save-data shape every utility accepts. Not exported —
// save migrations always operate on a plain `Record<string, unknown>` from the engine.
type SaveData = Record<string, unknown>;

// === FOUNDATION ===

/**
 * Read the value at a `.`-separated nested path in a save-data tree. Returns
 * `undefined` when any intermediate is missing or not a plain object — never
 * throws. Shared with `deserializePersistents`, so save migration code and the
 * deserialize path agree on what "missing" means.
 *
 * @example
 * ```ts
 * const progress = getNested(data, 'jobs.warrior.progress');
 * ```
 */
export function getNested(data: SaveData, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = data;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as SaveData)[part];
  }
  return cur;
}

/**
 * Write `value` at a `.`-separated nested path, creating intermediate objects
 * as needed. A non-object intermediate is replaced with a fresh `{}` — the
 * path is the source of truth at write time, matching the engine's v1 key
 * remap. Shared with `serializePersistents`.
 *
 * @example
 * ```ts
 * setNested(data, 'stats.totals.kills', 0);
 * ```
 */
export function setNested(data: SaveData, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: SaveData = data;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const next = cur[k];
    if (next == null || typeof next !== 'object') {
      const fresh: SaveData = {};
      cur[k] = fresh;
      cur = fresh;
    } else {
      cur = next as SaveData;
    }
  }
  cur[parts[parts.length - 1]] = value;
}

// === SAVE MIGRATION UTILITIES ===

/**
 * Move a value from `oldPath` to `newPath`. No-op when `oldPath` is absent
 * (including when any intermediate on the way is missing). Intermediates on
 * `newPath` are created as needed.
 *
 * @example
 * ```ts
 * 1: (data) => renameField(data as Record<string, unknown>, 'jobs.warrior', 'jobs.fighter'),
 * ```
 */
export function renameField(data: SaveData, oldPath: string, newPath: string): SaveData {
  const ref = parentRef(data, oldPath);
  if (ref === undefined) return data;
  const [parent, leaf] = ref;
  if (!(leaf in parent)) return data;
  const value = parent[leaf];
  delete parent[leaf];
  setNested(data, newPath, value);
  return data;
}

/**
 * Apply `transform` to the value at `path`. No-op when the path is absent.
 *
 * Useful when a field changes type. A field that held a `number` and now
 * holds a `Decimal` only needs `retypeField(data, path, (v) => String(v))`.
 * The engine's deserialize accepts string-encoded Decimals natively, so a
 * plain `String(v)` is the right shape.
 *
 * @example
 * ```ts
 * 2: (data) => retypeField(data as Record<string, unknown>, 'inventory.gold', (v) => String(v)),
 * ```
 */
export function retypeField(
  data: SaveData,
  path: string,
  transform: (oldValue: unknown) => unknown,
): SaveData {
  const ref = parentRef(data, path);
  if (ref === undefined) return data;
  const [parent, leaf] = ref;
  if (!(leaf in parent)) return data;
  parent[leaf] = transform(parent[leaf]);
  return data;
}

/**
 * Remove the value at `path`. No-op when the path or any intermediate is
 * missing.
 *
 * @example
 * ```ts
 * 3: (data) => deleteField(data as Record<string, unknown>, 'experimental.featureFlag'),
 * ```
 */
export function deleteField(data: SaveData, path: string): SaveData {
  const ref = parentRef(data, path);
  if (ref === undefined) return data;
  const [parent, leaf] = ref;
  delete parent[leaf];
  return data;
}

/** Options for {@link addField}. */
export interface AddFieldOptions {
  /**
   * When true, overwrite an existing non-nullish value. Default `false` —
   * matches the `??=` semantic of "set only if missing or nullish."
   */
  overwrite?: boolean;
}

/**
 * Write `defaultValue` at `path`. Default semantic is `??=` — only sets when
 * the existing value is missing or nullish. Pass `{ overwrite: true }` to
 * unconditionally replace. Intermediate objects are created as needed.
 *
 * @example
 * ```ts
 * 4: (data) => addField(data as Record<string, unknown>, 'stats.deaths', 0),
 * 5: (data) => addField(data as Record<string, unknown>, 'stats.chapterTimes', {}, { overwrite: true }),
 * ```
 */
export function addField(
  data: SaveData,
  path: string,
  defaultValue: unknown,
  opts?: AddFieldOptions,
): SaveData {
  if (!opts?.overwrite) {
    const existing = getNested(data, path);
    if (existing != null) return data;
  }
  setNested(data, path, defaultValue);
  return data;
}

/**
 * Iterate over each entry in a collection-shaped persistent context: a
 * top-level group of def states. `fn` receives the entry record and the def
 * id; mutate the entry in place. No-op when the persistent context is missing
 * or not an object; non-object entries in it are skipped.
 *
 * @example
 * ```ts
 * 6: (data) =>
 *   forEachDef(data as Record<string, unknown>, 'jobs', (entry) => {
 *     entry.genStartCompletions ??= entry.timesCompleted ?? 0;
 *   }),
 * ```
 */
export function forEachDef(
  data: SaveData,
  contextId: string,
  fn: (entry: SaveData, id: string) => void,
): SaveData {
  const section = data[contextId];
  if (section == null || typeof section !== 'object') return data;
  for (const id of Object.keys(section)) {
    const entry = (section as SaveData)[id];
    if (entry == null || typeof entry !== 'object') continue;
    fn(entry as SaveData, id);
  }
  return data;
}

// === INTERNAL ===

/**
 * Resolve `[parent, leaf]` for a `.`-separated path. Returns `undefined` when
 * any intermediate is missing or non-object — callers treat that as the
 * silent no-op signal. The parent is returned even when `leaf` itself is not
 * yet a key (callers check `leaf in parent` when presence matters).
 */
function parentRef(data: SaveData, path: string): [SaveData, string] | undefined {
  const parts = path.split('.');
  if (parts.length === 0) return undefined;
  let cur: SaveData = data;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (next == null || typeof next !== 'object') return undefined;
    cur = next as SaveData;
  }
  return [cur, parts[parts.length - 1]];
}
