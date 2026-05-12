/**
 * Content Registry — generic typed registry for game content definitions
 *
 * Provides a central store for typed content entries (actions, zones, skills, etc.)
 * that base game modules populate and mod modules can extend or patch.
 *
 * Key features:
 * - Type-safe generic registry constrained to `{ id: string }`
 * - Atomic batch registration (all-or-nothing on arrays)
 * - Shallow patching for mod overrides
 * - Insertion-order preservation
 *
 * Use with the engine's provide/inject system to share registries across modules.
 *
 * @example
 * ```ts
 * const zones = createContentRegistry<ZoneDef>('zones');
 * zones.register([
 *   { id: 'forest', name: 'Forest', difficulty: 1 },
 *   { id: 'cave', name: 'Dark Cave', difficulty: 3 },
 * ]);
 *
 * // Mod module patches existing content
 * zones.patch('forest', { name: 'Enchanted Forest', difficulty: 2 });
 *
 * // Systems read content
 * const allZones = zones.getAll(); // insertion order
 * ```
 */

// === TYPES ===

/**
 * A typed, Map-backed registry for game content definitions.
 *
 * Content is static after module installation — no Vue reactivity.
 * Entries are stored by `id` and returned by reference (no cloning).
 */
export interface ContentRegistry<T extends { id: string }> {
  /** Human-readable name, included in error messages */
  readonly name: string;

  /**
   * Register a single entry or an array of entries.
   *
   * Array registration is atomic: if any entry has a duplicate or empty id,
   * none of the entries in the batch are added.
   *
   * @throws If any entry's id is empty or already exists in the registry
   */
  register(entry: T): void;
  register(entries: T[]): void;

  /**
   * Shallow-patch an existing entry's fields (Object.assign semantics).
   * The `id` field cannot be changed.
   *
   * @throws If the id does not exist in the registry
   */
  patch(id: string, partial: Partial<Omit<T, 'id'>>): void;

  /** Retrieve an entry by id, or undefined if not found */
  get(id: string): T | undefined;

  /** Return all entries in insertion order */
  getAll(): T[];

  /** Check whether an entry with the given id exists */
  has(id: string): boolean;

  /**
   * Push temporary patches onto entries. Returns a cleanup function
   * that reverts all patched entries to their pre-patch state.
   *
   * Patches are shallow-merged (Object.assign semantics), same as patch().
   * Multiple pushPatches calls stack — cleanup functions are independent.
   *
   * @param patches - Map of entry id → partial fields to override
   * @returns Idempotent cleanup function that reverts all patches
   * @throws If any id does not exist in the registry
   */
  pushPatches(patches: Record<string, Partial<Omit<T, 'id'>>>): () => void;

  /** Number of registered entries */
  readonly size: number;
}

// === FACTORIES ===

/**
 * Create a new content registry for a specific content type.
 *
 * @param name - Human-readable name for error messages (e.g., "zones", "actions")
 * @returns A new empty {@link ContentRegistry}
 *
 * @example
 * ```ts
 * interface SkillDef { id: string; name: string; maxLevel: number }
 * const skills = createContentRegistry<SkillDef>('skills');
 * skills.register({ id: 'mining', name: 'Mining', maxLevel: 99 });
 * ```
 */
export function createContentRegistry<T extends { id: string }>(name: string): ContentRegistry<T> {
  const store = new Map<string, T>();

  const registry: ContentRegistry<T> = {
    name,

    register(entryOrEntries: T | T[]): void {
      const entries = Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries];

      // Validate all before inserting any (atomic batch)
      const seen = new Set<string>();
      for (const entry of entries) {
        if (entry.id === '') {
          throw new Error(`[${name}] Cannot register entry with empty id`);
        }
        if (seen.has(entry.id)) {
          throw new Error(`[${name}] Duplicate entry id in batch: "${entry.id}"`);
        }
        if (store.has(entry.id)) {
          throw new Error(`[${name}] Duplicate entry id: "${entry.id}"`);
        }
        seen.add(entry.id);
      }

      for (const entry of entries) {
        store.set(entry.id, entry);
      }
    },

    patch(id: string, partial: Partial<Omit<T, 'id'>>): void {
      const existing = store.get(id);
      if (!existing) {
        throw new Error(`[${name}] Cannot patch unknown id: "${id}"`);
      }
      Object.assign(existing, partial);
    },

    get(id: string): T | undefined {
      return store.get(id);
    },

    getAll(): T[] {
      return Array.from(store.values());
    },

    has(id: string): boolean {
      return store.has(id);
    },

    pushPatches(patches: Record<string, Partial<Omit<T, 'id'>>>): () => void {
      // Validate all IDs exist before applying any patches
      for (const id of Object.keys(patches)) {
        if (!store.has(id)) {
          throw new Error(`[${name}] Cannot pushPatches unknown id: "${id}"`);
        }
      }

      // Snapshot original values for each patched field, then apply
      const snapshots = new Map<string, Record<string, unknown>>();
      for (const [id, partial] of Object.entries(patches)) {
        const entry = store.get(id)!;
        const snapshot: Record<string, unknown> = {};
        for (const key of Object.keys(partial as object)) {
          snapshot[key] = (entry as Record<string, unknown>)[key];
        }
        snapshots.set(id, snapshot);
        Object.assign(entry, partial);
      }

      let reverted = false;
      return () => {
        if (reverted) return;
        reverted = true;
        for (const [id, snapshot] of snapshots) {
          const entry = store.get(id);
          if (entry) Object.assign(entry, snapshot);
        }
      };
    },

    get size(): number {
      return store.size;
    },
  };

  return registry;
}
