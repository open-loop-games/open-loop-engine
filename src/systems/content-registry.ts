/**
 * Content Registry — generic typed registry for game content defs
 *
 * Provides a central store for typed content defs (actions, zones, skills, etc.)
 * that modules register and can patch.
 *
 * Key features:
 * - Type-safe generic registry constrained to `{ id: string }`
 * - Atomic batch registration (all-or-nothing on arrays)
 * - Shallow patching of def fields
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
 * // Another module patches existing content
 * zones.patch('forest', { name: 'Enchanted Forest', difficulty: 2 });
 *
 * // Systems read content
 * const allZones = zones.getAll(); // insertion order
 * ```
 */

import { ref } from 'vue';

// === TYPES ===

/**
 * A typed, Map-backed registry for game content defs.
 *
 * Defs are stored by `id` and returned by reference (no cloning). The
 * defs are plain objects, but the reads (`get`, `getAll`, `has`, `size`)
 * are reactive. A computed that reads a def through them re-evaluates
 * after any `register`, `patch` or `pushPatches`. One that read a copied
 * field, or a field off a def reference it held, does not.
 */
export interface ContentRegistry<T extends { id: string }> {
  /** Human-readable id, included in error messages */
  readonly id: string;

  /**
   * Register a single def or an array of defs.
   *
   * Array registration is atomic: if any def has a duplicate or empty id,
   * none of the defs in the batch are added.
   *
   * @throws If any def's id is empty or already exists in the registry
   */
  register(entry: T): void;
  register(entries: T[]): void;

  /**
   * Shallow-patch an existing def's fields (Object.assign semantics).
   * The `id` field cannot be changed. Only the def object changes: a value
   * copied out of it earlier keeps the old one. A field that a pushed patch
   * ({@link pushPatches}) covers keeps the pushed value. It takes the patched
   * value once every pushed patch covering it is cleaned up.
   *
   * @throws If the id does not exist in the registry, or the partial contains a different `id`
   */
  patch(id: string, partial: Partial<Omit<T, 'id'>>): void;

  /** Retrieve a def by id, or undefined if not found */
  get(id: string): T | undefined;

  /** Return all defs in insertion order */
  getAll(): T[];

  /** Check whether a def with the given id exists */
  has(id: string): boolean;

  /**
   * Push a set of patches onto defs, as one pushed patch. Returns a cleanup function
   * that reverts all patched defs to their pre-patch state.
   *
   * Patches are shallow-merged (Object.assign semantics), same as patch().
   * Multiple pushPatches calls stack, and cleanups may run in any order. A
   * field takes the value of the latest pushed patch that sets it and is not
   * yet cleaned up. Once no such patch is left, the field takes its unpushed
   * value.
   *
   * @param patches - Map of def id → partial fields to set
   * @returns Idempotent cleanup function that reverts all patches
   * @throws If any id does not exist in the registry, or its partial contains a different
   *   `id`; no patch in the batch applies
   */
  pushPatches(patches: Record<string, Partial<Omit<T, 'id'>>>): () => void;

  /** Number of registered defs */
  readonly size: number;
}

/**
 * A {@link ContentRegistry} without `register` — what a category exposes as
 * its `registry`. `registry.patch()` / `pushPatches()` change a def in
 * place, so code reading `def.x` when it runs sees the change. Defs aren't
 * reactive, though. A patch doesn't re-run a computed that reads `def.x`
 * directly, but it re-runs one that reads through `getDef(id)` or
 * `registry.get(id)`. A field given as a value is copied at register and keeps
 * its old one. The
 * view has no `register`: a def is added through the category's own
 * `register`, which builds the def's instance and def state beside it.
 */
export type ContentRegistryView<T extends { id: string }> = Omit<ContentRegistry<T>, 'register'>;

/**
 * A content registry plus the functions an owner needs to keep it in step with
 * what it builds per def.
 *
 * @internal
 */
export interface ContentRegistryHandle<T extends { id: string }> {
  readonly registry: ContentRegistry<T>;
  /** Throw exactly as `register(entries)` would, without adding anything. */
  assertRegistrable(entries: T[]): void;
  /** Remove a def, for undoing a registration its owner failed to build. */
  remove(id: string): void;
}

// === CONSTANTS ===

/** Base-value marker for a key the def didn't have before a pushed patch set it. */
const ABSENT: unique symbol = Symbol('absent');

// === FACTORIES ===

/**
 * Create a new content registry for a specific content type.
 *
 * @param registryId - Human-readable id for error messages (e.g., "zones", "actions")
 * @returns A new empty {@link ContentRegistry}
 *
 * @example
 * ```ts
 * interface SkillDef { id: string; name: string; maxLevel: number }
 * const skills = createContentRegistry<SkillDef>('skills');
 * skills.register({ id: 'mining', name: 'Mining', maxLevel: 99 });
 * ```
 */
export function createContentRegistry<T extends { id: string }>(
  registryId: string,
): ContentRegistry<T> {
  return createContentRegistryHandle<T>(registryId).registry;
}

/**
 * Create a content registry together with its owner-side functions.
 *
 * @internal
 */
export function createContentRegistryHandle<T extends { id: string }>(
  registryId: string,
): ContentRegistryHandle<T> {
  const store = new Map<string, T>();
  // Read barrier for the plain store: every read touches it, every write bumps it.
  const version = ref(0);
  // Pushed patches in push order. Defs are patched in place, so for every key
  // a pushed patch covers, `bases` holds the value beneath all of them; a revert
  // recomputes each key it touched as that base overlaid by the patches left.
  const liveScopedOverrides: Map<string, Record<string, unknown>>[] = [];
  const bases = new Map<string, Map<string, unknown>>();

  function resolveKeys(id: string, keys: string[]): void {
    const entry = store.get(id) as Record<string, unknown> | undefined;
    const base = bases.get(id);
    if (!entry || !base) return;
    for (const key of keys) {
      let value = base.get(key);
      let covered = false;
      for (const scope of liveScopedOverrides) {
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
        throw new Error(`[${registryId}] Cannot register a def with an empty id`);
      }
      if (seen.has(entry.id)) {
        throw new Error(`[${registryId}] Duplicate def id in batch: "${entry.id}"`);
      }
      if (store.has(entry.id)) {
        throw new Error(`[${registryId}] Duplicate def id: "${entry.id}"`);
      }
      seen.add(entry.id);
    }
  }

  // The store key is the def's id, so a partial that renames it would leave
  // the def filed under an id it no longer has.
  function assertKeepsId(verb: string, id: string, partial: object): void {
    if (Object.hasOwn(partial, 'id') && (partial as { id?: unknown }).id !== id) {
      throw new Error(`[${registryId}] Cannot change the id of "${id}" by ${verb}`);
    }
  }

  function remove(id: string): void {
    if (!store.delete(id)) return;
    bases.delete(id);
    version.value++;
  }

  const registry: ContentRegistry<T> = {
    id: registryId,

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
        throw new Error(`[${registryId}] Cannot patch unknown id: "${id}"`);
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
          throw new Error(`[${registryId}] Cannot pushPatches unknown id: "${id}"`);
        }
        assertKeepsId('pushPatches', id, partial);
      }

      // The new pushed patch is the top one, so applying it in place resolves it.
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
      liveScopedOverrides.push(scope);
      version.value++;

      let reverted = false;
      return () => {
        if (reverted) return;
        reverted = true;
        liveScopedOverrides.splice(liveScopedOverrides.indexOf(scope), 1);
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
