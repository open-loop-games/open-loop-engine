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

import { ref } from 'vue';

// === TYPES ===

/**
 * A typed, Map-backed registry for game content definitions.
 *
 * Entries are stored by `id` and returned by reference (no cloning). The
 * entries are plain objects, but the reads (`get`, `getAll`, `has`, `size`)
 * are reactive: a computed that reads an entry through them re-evaluates
 * after any `register`, `patch` or `pushPatches`. One that read a copied
 * field, or a field off an entry reference it held, does not.
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
   * The `id` field cannot be changed. Only the entry object changes: a value
   * copied out of it earlier keeps the old one. A field a {@link pushPatches} scope
   * covers keeps the scope's value until every covering scope reverts, and
   * then takes the patched value.
   *
   * @throws If the id does not exist in the registry, or the partial carries a different `id`
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
   * Multiple pushPatches calls stack, and cleanups may run in any order: a
   * field takes the value of the latest live scope that sets it, or its
   * unscoped value once none does.
   *
   * @param patches - Map of entry id → partial fields to override
   * @returns Idempotent cleanup function that reverts all patches
   * @throws If any id does not exist in the registry, or its partial carries a different
   *   `id`; no patch in the batch applies
   */
  pushPatches(patches: Record<string, Partial<Omit<T, 'id'>>>): () => void;

  /** Number of registered entries */
  readonly size: number;
}

/**
 * A {@link ContentRegistry} without `register` — what a category exposes as
 * its `registry`. Reads and patches go through it; a def is added through the
 * category's own `register`, which builds the def's instance and state
 * alongside it.
 */
export type ContentRegistryView<T extends { id: string }> = Omit<ContentRegistry<T>, 'register'>;

/**
 * A content registry plus the hooks an owner needs to keep it in step with
 * what it builds per entry.
 *
 * @internal
 */
export interface ContentRegistryHandle<T extends { id: string }> {
  readonly registry: ContentRegistry<T>;
  /** Throw exactly as `register(entries)` would, without adding anything. */
  assertRegistrable(entries: T[]): void;
  /** Drop an entry, for undoing a registration its owner failed to build. */
  remove(id: string): void;
}

// === CONSTANTS ===

/** Base-value marker for a key the entry didn't have before a scope set it. */
const ABSENT: unique symbol = Symbol('absent');

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
  return createContentRegistryHandle<T>(name).registry;
}

/**
 * Create a content registry together with its owner-side hooks.
 *
 * @internal
 */
export function createContentRegistryHandle<T extends { id: string }>(
  name: string,
): ContentRegistryHandle<T> {
  const store = new Map<string, T>();
  // Read barrier for the plain store: every read touches it, every write bumps it.
  const version = ref(0);
  // Pushed scopes in push order. Entries are patched in place, so for every key
  // a live scope covers, `bases` holds the value beneath all scopes; a revert
  // re-resolves each key it touched as that base overlaid by the scopes left.
  const liveScopes: Map<string, Record<string, unknown>>[] = [];
  const bases = new Map<string, Map<string, unknown>>();

  function resolveKeys(id: string, keys: string[]): void {
    const entry = store.get(id) as Record<string, unknown> | undefined;
    const base = bases.get(id);
    if (!entry || !base) return;
    for (const key of keys) {
      let value = base.get(key);
      let covered = false;
      for (const scope of liveScopes) {
        const partial = scope.get(id);
        if (partial && Object.hasOwn(partial, key)) {
          value = partial[key];
          covered = true;
        }
      }
      if (value === ABSENT) delete entry[key];
      else entry[key] = value;
      if (!covered) base.delete(key);
    }
    if (base.size === 0) bases.delete(id);
  }

  function assertRegistrable(entries: T[]): void {
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
  }

  // The store key is the entry's id, so a partial that renames it would leave
  // the entry filed under an id it no longer carries.
  function assertKeepsId(verb: string, id: string, partial: object): void {
    if (Object.hasOwn(partial, 'id') && (partial as { id?: unknown }).id !== id) {
      throw new Error(`[${name}] Cannot change the id of "${id}" by ${verb}`);
    }
  }

  function remove(id: string): void {
    if (!store.delete(id)) return;
    bases.delete(id);
    version.value++;
  }

  const registry: ContentRegistry<T> = {
    name,

    register(entryOrEntries: T | T[]): void {
      const entries = Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries];
      // Validate all before inserting any (atomic batch)
      assertRegistrable(entries);
      for (const entry of entries) {
        store.set(entry.id, entry);
      }
      version.value++;
    },

    patch(id: string, partial: Partial<Omit<T, 'id'>>): void {
      const existing = store.get(id);
      if (!existing) {
        throw new Error(`[${name}] Cannot patch unknown id: "${id}"`);
      }
      assertKeepsId('patch', id, partial);
      const base = bases.get(id);
      for (const [key, value] of Object.entries(partial)) {
        if (base?.has(key)) base.set(key, value);
        else (existing as Record<string, unknown>)[key] = value;
      }
      version.value++;
    },

    get(id: string): T | undefined {
      void version.value;
      return store.get(id);
    },

    getAll(): T[] {
      void version.value;
      return Array.from(store.values());
    },

    has(id: string): boolean {
      void version.value;
      return store.has(id);
    },

    pushPatches(patches: Record<string, Partial<Omit<T, 'id'>>>): () => void {
      // Validate every patch before applying any
      for (const [id, partial] of Object.entries(patches)) {
        if (!store.has(id)) {
          throw new Error(`[${name}] Cannot pushPatches unknown id: "${id}"`);
        }
        assertKeepsId('pushPatches', id, partial);
      }

      // The new scope is the top one, so applying it in place is its resolution.
      const scope = new Map<string, Record<string, unknown>>();
      for (const [id, partial] of Object.entries(patches)) {
        const entry = store.get(id) as Record<string, unknown>;
        let base = bases.get(id);
        if (!base) bases.set(id, (base = new Map()));
        for (const key of Object.keys(partial)) {
          if (!base.has(key)) base.set(key, Object.hasOwn(entry, key) ? entry[key] : ABSENT);
        }
        scope.set(id, { ...partial });
        Object.assign(entry, partial);
      }
      liveScopes.push(scope);
      version.value++;

      let reverted = false;
      return () => {
        if (reverted) return;
        reverted = true;
        liveScopes.splice(liveScopes.indexOf(scope), 1);
        for (const [id, partial] of scope) resolveKeys(id, Object.keys(partial));
        version.value++;
      };
    },

    get size(): number {
      void version.value;
      return store.size;
    },
  };

  return { registry, assertRegistrable, remove };
}
