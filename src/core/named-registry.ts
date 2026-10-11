/**
 * Named registry — engine-internal id-keyed collection helper shared by
 * the chain registry, the effect-system registry and the resource registry.
 *
 * Each of those three registries is filled by the factory of what it holds
 * (`createModifierChain`, `createTemporaryEffectSystem` /
 * `createConditionalEffectSystem`, `createResource`). The factory finds its
 * registry through an ambient value that {@link createEngine} sets around
 * `install()` / `connect()`. The mechanism — a file-private ambient value, a `with*` call,
 * a `getCurrent*` reader, an id-keyed Map plus an insertion-order array — is
 * identical across all three. A fourth registry of the same shape would
 * duplicate it again, so this helper extracts it.
 *
 * `register(entity)` throws on a duplicate id. In each of the three
 * registries a repeated id is an authoring mistake, and answering either
 * entry for it would silently hide the other.
 *
 * The ambient half is a separate helper, {@link createAmbientValue}, because
 * the resource registry pairs its NamedRegistry with an ambient value of a
 * wrapper type. The public ResourceRegistry API differs from the underlying
 * NamedRegistry, so the two halves are not always used together.
 *
 * @cluster registries
 * @internal Engine-internal — not part of the consumer API surface.
 */

/**
 * Id-keyed collection with strict registration, id lookup, and insertion-order
 * enumeration.
 *
 * @typeParam T - Entry type. An entry needs no `id` field of its own;
 *   {@link CreateNamedRegistryOptions.idOf} extracts the id.
 */
export interface NamedRegistry<T> {
  /**
   * Strict registration — throws if the entry's id is already registered.
   *
   * @internal Called by the entries' factories while the ambient value is
   *   set; consumer code reads via `get` / `has` / `all`.
   */
  register(entity: T): void;
  /** The entry registered under `id`, or `undefined` if none matches. */
  get(id: string): T | undefined;
  /** Whether an entry with the given id is registered. */
  has(id: string): boolean;
  /** Snapshot of all registered entries in insertion order. */
  all(): readonly T[];
  /** Number of registered entries. */
  readonly size: number;
}

export interface CreateNamedRegistryOptions<T> {
  /** Class-style prefix for the duplicate-id error (e.g. `'ChainRegistry'`). */
  label: string;
  /** Lowercase noun used in the duplicate-id error message (e.g. `'chain'`, `'effect-system'`). */
  noun: string;
  /** Extract the registry id from an entry. The resource registry reads it through its entry wrapper; chains and effect systems expose `id` directly. */
  idOf: (entity: T) => string;
}

/**
 * Create a fresh, empty {@link NamedRegistry}. Each engine instance gets
 * its own, so scratch engines never share entries.
 */
export function createNamedRegistry<T>(options: CreateNamedRegistryOptions<T>): NamedRegistry<T> {
  const { label, noun, idOf } = options;
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);

  const byId = new Map<string, T>();
  const order: T[] = [];

  return {
    register(entity) {
      const id = idOf(entity);
      if (byId.has(id)) {
        throw new Error(
          `${label}: duplicate ${noun} id "${id}". ${Noun} ids must be unique within an engine instance.`,
        );
      }
      byId.set(id, entity);
      order.push(entity);
    },
    get(id) {
      return byId.get(id);
    },
    has(id) {
      return byId.has(id);
    },
    all() {
      return order.slice();
    },
    get size() {
      return order.length;
    },
  };
}

/**
 * A file-private ambient value with its `with` / `getCurrent` pair. Each
 * call to {@link createAmbientValue} returns an isolated one. So the chain,
 * effect-system and resource ambient values stay independent, though the
 * same helper builds them.
 */
export interface AmbientValue<T> {
  /**
   * Run `fn` with `value` set as the ambient value. Nested calls save and
   * restore the previous value, so nested setups (e.g. one engine built
   * while another starts) don't overwrite each other. The previous value is
   * also restored if `fn` throws.
   *
   * @internal Consumer code should not call this directly.
   */
  with<R>(value: T, fn: () => R): R;
  /**
   * Read the current ambient value, or `undefined` if outside a `with`
   * block (tests, throwaway scripts).
   *
   * @internal Used by the entries' factories to auto-register into the
   *   current engine's registries.
   */
  getCurrent(): T | undefined;
}

/**
 * Create a fresh ambient value. The closure holds it, so each call returns
 * an independent one — the chain and effect-system ambient values never
 * alias, though they share this helper.
 */
export function createAmbientValue<T>(): AmbientValue<T> {
  let current: T | undefined;

  return {
    with(value, fn) {
      const prev = current;
      current = value;
      try {
        return fn();
      } finally {
        current = prev;
      }
    },
    getCurrent() {
      return current;
    },
  };
}
