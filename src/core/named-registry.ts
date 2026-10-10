/**
 * Named registry — engine-internal id-keyed collection helper shared by
 * the chain, effect-system, and resource registries.
 *
 * Each of those three registries is auto-populated by its corresponding
 * factory (`createModifierChain`, `createTemporaryEffectSystem` /
 * `createConditionalEffectSystem`, `createResource`) via an ambient
 * registry-target that {@link createEngine} sets up around `install()` /
 * `connect()`. The mechanism — module-private ambient slot, `with*` scope,
 * `getCurrent*` reader, id-keyed Map plus insertion-order array — is
 * identical across all three, and growing a fourth registry of the same
 * shape would duplicate the pattern again. This helper extracts it.
 *
 * `register(entity)` throws on a duplicate id — in every one of the three
 * registries a repeated id is an authoring mistake, and answering either
 * entity for it would silently hide the other.
 *
 * The ambient half is factored separately as {@link createAmbientValue}
 * because the resource registry pairs its NamedRegistry with a wrapper-
 * typed ambient (the public ResourceRegistry surface differs from the
 * underlying NamedRegistry), so the two halves don't always travel
 * together.
 *
 * @cluster registries
 * @internal Engine-internal — not part of the consumer surface.
 */

/**
 * Id-keyed registry with strict registration, id lookup, and insertion-order
 * enumeration.
 *
 * @typeParam T - Entity type. Entities don't need an `id` field directly;
 *   the id is extracted via {@link CreateNamedRegistryOptions.idOf}.
 */
export interface NamedRegistry<T> {
  /**
   * Strict registration — throws if the entity's id is already registered.
   *
   * @internal Called by entity factories under an ambient scope; consumer
   *   code reads via `get` / `has` / `all`.
   */
  register(entity: T): void;
  /** The entity registered under `id`, or `undefined` if none matches. */
  get(id: string): T | undefined;
  /** Whether an entity with the given id is registered. */
  has(id: string): boolean;
  /** Snapshot of all registered entities in insertion order. */
  all(): readonly T[];
  /** Number of registered entities. */
  readonly size: number;
}

export interface CreateNamedRegistryOptions<T> {
  /** Class-style label used as the duplicate-id error prefix (e.g. `'ChainRegistry'`). */
  label: string;
  /** Lowercase noun used in the duplicate-id error message (e.g. `'chain'`, `'effect-system'`). */
  noun: string;
  /** Extract the registry id from an entity. The resource registry projects through its entry wrapper; chain and effect-system entities expose `id` directly. */
  idOf: (entity: T) => string;
}

/**
 * Create a fresh, empty {@link NamedRegistry}. Each engine instance gets
 * its own — scratch-engine forks never cross-contaminate.
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
 * Module-private ambient slot paired with `with` / `getCurrent` accessors.
 * Each call to {@link createAmbientValue} returns an isolated slot —
 * different scopes never share state, so chain / effect / resource ambients
 * stay independent even when minted from the same helper.
 */
export interface AmbientValue<T> {
  /**
   * Run `fn` with `value` set as the ambient target. Nested calls save
   * and restore the previous ambient so concurrent setups (e.g. multiple
   * engines starting simultaneously) don't stomp each other. The previous
   * ambient is also restored if `fn` throws.
   *
   * @internal Consumer code should not call this directly.
   */
  with<R>(value: T, fn: () => R): R;
  /**
   * Read the current ambient value, or `undefined` if outside a `with`
   * block (tests, throwaway scripts).
   *
   * @internal Used by entity factories to auto-register into the current
   *   engine's registries.
   */
  getCurrent(): T | undefined;
}

/**
 * Create a fresh ambient-scope slot. The slot is closure-captured, so
 * each call returns an independent ambient — chain and effect-system
 * scopes can never alias even though they share this helper.
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
