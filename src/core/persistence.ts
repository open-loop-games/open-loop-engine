/**
 * Persistence — auto-saved refs, registered per persistent context.
 *
 * Key features:
 * - NaN detection to prevent corrupted saves
 * - Stack traces for debugging orphaned persistent refs
 * - Persistent aliases, so the save holds a value once
 * - Deleted flag for conditional persistence
 */

import {
  ref,
  computed,
  isRef,
  watch,
  getCurrentScope,
  onScopeDispose,
  type Ref,
  type WritableComputedRef,
} from 'vue';
import { Decimal } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import { isTracing, recordTrace } from './trace';
import type { Resource } from './resource';
import { isDev } from './common';
import { getNested, setNested } from './save-migrations';

// === STATE TYPES ===

/**
 * The serializable values a persistent ref may hold, which save and load safely.
 * `DecimalSource` admits a `Decimal`: the save writes it as a string, and the
 * load revives it against the ref default.
 */
export type Serializable =
  | string
  | number
  | boolean
  | DecimalSource
  | null
  | undefined
  | Serializable[]
  | { [key: string]: Serializable }
  | { [key: number]: Serializable };

/** The primitive subset of {@link Serializable}, for conditional type branches */
export type SerializablePrimitive = string | number | boolean | null | undefined;

/**
 * Compile-time constraint that checks T is a serializable value without
 * explicit index signatures on interfaces. Use it in generic bounds instead of
 * `T extends Serializable`: it accepts `{ name: string; count: number }` directly.
 *
 * The object branch uses a mapped type (`{ [K in keyof T]: ... }`) which
 * checks each property structurally rather than demanding an index signature.
 * DecimalSource is checked before object so Decimal class instances pass
 * without mapped-type introspection of internal fields. A function, or an
 * object holding one (a Map, a class instance with methods), resolves to
 * `never`: a save cannot hold it. A field declared `unknown` passes as
 * opaque state the consumer vouches for; save validation still checks it at
 * load.
 */
export type SerializableConstraint<T> = unknown extends T
  ? T
  : T extends SerializablePrimitive
    ? T
    : T extends DecimalSource
      ? T
      : T extends readonly (infer U)[]
        ? readonly SerializableConstraint<U>[]
        : T extends (...args: never[]) => unknown
          ? never
          : T extends object
            ? { [K in keyof T]: SerializableConstraint<T[K]> }
            : never;

// === SYMBOLS ===

/** Symbol for the backing ref of a persistent ref */
export const PersistentState = Symbol('PersistentState');

/** Symbol for the ref default, which a reset restores */
export const DefaultValue = Symbol('DefaultValue');

/** Symbol for the stack trace of where this persistent ref was created */
export const StackTrace = Symbol('StackTrace');

/** Symbol that marks a persistent ref as deleted, so it is not saved */
export const Deleted = Symbol('Deleted');

/** Symbol for the persistent alias: a writable computed the save walk skips */
export const PersistentAlias = Symbol('PersistentAlias');

/** Symbol for the save path */
export const SaveDataPath = Symbol('SaveDataPath');

/** Symbol to check if NaN checking is enabled */
export const CheckNaN = Symbol('CheckNaN');

/**
 * Stable id of this persistent ref inside its persistent context. When set, it
 * decides the save key in {@link getAllPersistentRefs}. When unset, the key
 * falls back to iteration order, and a dev-mode warning reports the gap.
 */
export const PersistentId = Symbol('PersistentId');

/**
 * Explicit Zod schema for this ref's runtime save validation. When unset, the
 * validator in `save-validation.ts` auto-derives from {@link DefaultValue}.
 * Typed `unknown` so `persistence.ts` stays Zod-agnostic.
 */
export const PersistentSchema = Symbol('PersistentSchema');

/**
 * Marks a ref as Decimal-valued for schema derivation. It is needed when the
 * default is a `number`/`string` DecimalSource rather than a Decimal instance.
 * At runtime, nothing else tells those apart from plain numeric refs.
 */
export const PersistentDecimal = Symbol('PersistentDecimal');

/** Symbol that marks an object for the reset walk to skip */
export const SkipPersistence = Symbol('SkipPersistence');

/** Marks a persistent ref as lifetime — see {@link PersistentOptions.lifetime}. */
export const Lifetime = Symbol('Lifetime');

// === REF TYPES ===

/**
 * A ref that is automatically saved and loaded.
 * Includes metadata for debugging and save management.
 */
export type Persistent<T = Serializable> = Ref<T> & {
  readonly [PersistentState]: Ref<T>;
  readonly [DefaultValue]: T;
  readonly [StackTrace]: string;
  [Deleted]: boolean;
  readonly [PersistentAlias]: PersistentAlias<T>;
  [SaveDataPath]: string[] | undefined;
  readonly [CheckNaN]: boolean;
  [PersistentId]: string | undefined;
  readonly [PersistentSchema]: unknown;
  readonly [PersistentDecimal]: boolean;
  readonly [Lifetime]: boolean;
};

/**
 * A writable computed over a persistent ref, which the save walk skips.
 * Pass it to other features, so the save holds the value once.
 */
export type PersistentAlias<T = Serializable> = WritableComputedRef<T> & {
  readonly [DefaultValue]: T;
};

// === FILE STATE ===

/**
 * True while a save load or a reset writes persistent refs. Watchers that
 * react to player actions skip these writes: they restore state, they don't
 * change it. Written only by {@link withSettling}.
 */
export const settling = ref(false);

/** Open {@link withSettling} calls; the flag clears as the outermost closes. */
let loadDepth = 0;

const hydratedCallbacks = new Set<() => void>();
/** Open {@link deferHydration} calls; a settle inside one waits for the last to close. */
let hydrationDeferrals = 0;
let hydrationPending = false;

/**
 * Run `callback` each time a save load or a reset finishes writing persistent
 * refs, once the whole state is consistent. A reset runs it as its writes
 * settle. A save manager load runs it after `save:loaded`, and so after the
 * engine's `onLoad` handlers. A watcher that reacts to a hydration's write
 * therefore sees the state `onLoad` rebuilt. Every engine in the runtime shares the
 * handler set, so `callback` also runs after another engine's load and must
 * be idempotent. It stops with the Vue effect scope it was registered in.
 *
 * @internal
 */
export function onHydrated(callback: () => void): () => void {
  hydratedCallbacks.add(callback);
  const stop = () => void hydratedCallbacks.delete(callback);
  if (getCurrentScope()) onScopeDispose(stop);
  return stop;
}

/**
 * Call `fire` whenever `holds` is true outside a load or reset, and again as
 * each one settles if it holds then. Mid-load, a predicate can hold before
 * the state `fire` writes is restored, so the settled state decides. The
 * watch is sync, so `fire` runs on the tick where `holds` flips to true. That
 * holds even in a headless run that calls `tickOnce()` in a tight loop. `fire`
 * must be idempotent.
 *
 * @returns A stop for both the watch and the hydration handler
 * @internal
 */
export function latchWhenSettled(holds: Readonly<Ref<boolean>>, fire: () => void): () => void {
  const stopWatch = watch(
    holds,
    (held) => {
      if (held && !settling.value) fire();
    },
    { immediate: true, flush: 'sync' },
  );
  const stopHydrated = onHydrated(() => {
    if (holds.value) fire();
  });
  return () => {
    stopWatch();
    stopHydrated();
  };
}

/** Run every hydration handler, even past a throw; returns what they threw. */
function runHydrated(): unknown[] {
  const errors: unknown[] = [];
  for (const cb of [...hydratedCallbacks]) {
    try {
      cb();
    } catch (err) {
      errors.push(err);
    }
  }
  return errors;
}

/**
 * Run `fn` as a save load or a reset writing persistent refs, with
 * {@link settling} held throughout. A nested call keeps the outer's hold,
 * so the state settles once, as the outermost call closes. The
 * {@link onHydrated} handlers run then, or wait for an enclosing
 * {@link deferHydration}. Outside one, the first handler throw rethrows
 * from here once every handler has run.
 *
 * @internal
 */
export function withSettling<T>(fn: () => T): T {
  if (loadDepth++ === 0) settling.value = true;
  try {
    return fn();
  } finally {
    if (--loadDepth === 0) {
      settling.value = false;
      settleHydration();
    }
  }
}

/** Run the hydration handlers for a settled load, or hold them for a deferral. */
function settleHydration(): void {
  if (hydrationDeferrals > 0) {
    hydrationPending = true;
    return;
  }
  const errors = runHydrated();
  if (errors.length > 0) throw errors[0];
}

/**
 * Run `fn` with {@link onHydrated} handlers held until it returns or throws,
 * then run them once if a load or reset settled inside it. A throw from a
 * held handler goes to `onError` rather than out of this call: the load or
 * reset writes before it are already done. Nested calls hold until the
 * outermost closes, and report through its `onError`.
 *
 * @internal
 */
export function deferHydration<T>(fn: () => T, onError: (err: unknown) => void): T {
  hydrationDeferrals++;
  try {
    return fn();
  } finally {
    if (--hydrationDeferrals === 0 && hydrationPending) {
      hydrationPending = false;
      for (const err of runHydrated()) onError(err);
    }
  }
}

/** The stack of open persistent contexts; a new persistent ref registers under the top one */
const addingContexts: string[] = [];

/** The persistent-ref registry: the refs of each persistent context */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const persistentRefs: Record<string, Set<Persistent<any>>> = {};

/** Map from a persistent ref to the persistent context it was created in */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const refContextId: WeakMap<Persistent<any>, string> = new WeakMap();

/** Parent→child persistent context links. A persistent context opened while
 * another is open becomes a child of the enclosing one. {@link getPersistentContextRefs}
 * walks the links to collect every ref under a persistent context. */
const contextChildren: Record<string, Set<string>> = {};

/**
 * The persistence namespace applied to `beginPersistentContext` calls, an
 * ambient value. When set, persistent context ids are stored as
 * `${namespace}${NAMESPACE_SEP}${id}`, so engine instances sharing a runtime
 * don't collide on module or category ids. Undefined means unnamespaced.
 *
 * {@link withPersistenceNamespace} sets it. It needs no stack, because nested
 * persistence namespaces are not supported.
 */
let activeNamespace: string | undefined;

/** Separator between the persistence namespace and the raw persistent context
 * id. It avoids collision with the `/` that category-base puts in each def's
 * persistent context id. */
const NAMESPACE_SEP = '::';

/** Map from a full persistent context id to its persistence namespace, `''`
 * for an unnamespaced one. `getAllPersistentRefs` filters on it, so each
 * engine sees only its own refs. */
const contextNamespaces: Record<string, string> = {};

// === HELPERS ===

/**
 * Deep-clone a ref default so `DefaultValue` never aliases
 * the live value. Without this, in-place mutation of the ref's value (e.g. a
 * `Decimal.fromNumber()` call or direct `.sign`/`.mag`/`.layer` writes, or
 * `.push()` on an array default) silently rewrites the default and turns
 * {@link resetPersistent} into a no-op.
 *
 * Primitives pass through; Decimal instances are copied via `new Decimal(v)`
 * (break_eternity copies sign/mag/layer); arrays and plain objects recurse.
 *
 * @internal
 */
export function cloneDefault<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Decimal) return new Decimal(value) as T;
  if (Array.isArray(value)) return value.map((v) => cloneDefault(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value)) {
    out[k] = cloneDefault((value as Record<string, unknown>)[k]);
  }
  return out as T;
}

/** A raw persistent context id as registered under the active persistence namespace. */
function toFullContextId(contextId: string): string {
  return activeNamespace ? `${activeNamespace}${NAMESPACE_SEP}${contextId}` : contextId;
}

/**
 * Get a stack trace for debugging purposes
 */
function getStackTrace(): string {
  return (
    new Error().stack
      ?.split('\n')
      .slice(3, 5)
      .map((line) => line.trim())
      .join('\n') ?? ''
  );
}

/**
 * Check for NaN and write to the backing ref, with error handling
 */
function checkNaNAndWrite<T>(persistentRef: Persistent<T>, value: T): void {
  // Only check NaN on numeric/Decimal values — strings, booleans, arrays, etc. are never NaN
  if (typeof value === 'number' || value instanceof Decimal) {
    if (Decimal.isNaN(value)) {
      console.error(
        `Attempted to save NaN value to ${persistentRef[SaveDataPath]?.join('.') ?? 'unregistered persistent'}`,
        '\nCreated at:\n' + persistentRef[StackTrace],
      );
      return;
    }
  }
  persistentRef[PersistentState].value = value;
}

// === PERSISTENT CONTEXT API ===

/**
 * Open a persistent context. Every persistent ref created while it is open
 * registers under it.
 *
 * When a persistence namespace is active (see {@link withPersistenceNamespace}),
 * the stored persistent context id is prefixed with `${namespace}${NAMESPACE_SEP}`.
 * So two engines in one runtime can share module ids without collision.
 *
 * @param id - Unique id for this persistent context, such as a node id. It must
 *   not contain `.`, which save paths split on; such an id throws.
 */
export function beginPersistentContext(id: string): void {
  // Save keys are `${contextId}.${refId}` and split on "." into nested save
  // data, so a dotted persistent context id would save and validate at the wrong path.
  if (id.includes('.')) {
    throw new Error(`Persistent context id "${id}" contains ".", which save paths split on.`);
  }
  const fullId = toFullContextId(id);
  const parent = addingContexts[addingContexts.length - 1];
  addingContexts.push(fullId);
  if (!(fullId in persistentRefs)) {
    persistentRefs[fullId] = new Set();
    contextNamespaces[fullId] = activeNamespace ?? '';
  }
  if (parent !== undefined && parent !== fullId) {
    (contextChildren[parent] ??= new Set()).add(fullId);
  }
}

/**
 * Close the enclosing persistent context.
 */
export function endPersistentContext(): void {
  addingContexts.pop();
}

/**
 * Run a block inside a persistent context, and close it even if the block
 * throws. Prefer it over a manual begin and end pair.
 *
 * @param id - Persistent context id (as for {@link beginPersistentContext})
 * @param fn - Block to execute inside the context
 * @returns The return value of `fn`
 */
export function withPersistentContext<T>(id: string, fn: () => T): T {
  beginPersistentContext(id);
  try {
    return fn();
  } finally {
    endPersistentContext();
  }
}

/**
 * Run a block with a persistence namespace applied to every
 * `beginPersistentContext` call inside it. The engine uses it to isolate
 * engine instances that share module or category ids.
 *
 * @param namespace - Persistence namespace, or undefined to run unnamespaced
 * @param fn - Block to execute
 * @internal Consumer code should not call this directly — set
 *   {@link EngineOptions.persistenceNamespace} instead.
 */
export function withPersistenceNamespace<T>(namespace: string | undefined, fn: () => T): T {
  const prev = activeNamespace;
  activeNamespace = namespace;
  try {
    return fn();
  } finally {
    activeNamespace = prev;
  }
}

/**
 * Bind `fn` to the persistence namespace active now. Then a call after
 * install, such as a reset resolving its reset scope, still resolves
 * persistent context ids in the engine that built the caller.
 *
 * @internal
 */
export function bindPersistenceNamespace<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const namespace = activeNamespace;
  return (...args) => withPersistenceNamespace(namespace, () => fn(...args));
}

/**
 * Strip the persistence namespace prefix from a full persistent context id,
 * leaving the raw id the caller passed to `beginPersistentContext`. Code that
 * displays or routes on the id (such as system fallback ids) reads this, not
 * the raw stack entry.
 *
 * The prefix is sliced by the *recorded* namespace length, not by indexOf
 * on the separator. So an id that contains `::` for its own nesting keeps its
 * structure, instead of collapsing to whatever follows the first `::`. A
 * resource's lifetime trackers under `${parent}::${name}` are such ids.
 */
function stripNamespace(fullId: string): string {
  const ns = contextNamespaces[fullId];
  if (!ns) return fullId;
  return fullId.slice(ns.length + NAMESPACE_SEP.length);
}

/**
 * Get the enclosing persistent context's id, if any.
 *
 * It returns the raw id, with the persistence namespace stripped. So consumer
 * code that compares it with module or category ids works under any engine
 * instance.
 */
export function getCurrentPersistentContext(): string | undefined {
  const top = addingContexts[addingContexts.length - 1];
  return top === undefined ? undefined : stripNamespace(top);
}

/** Per-kind counters behind {@link resolveSystemPersistentContextId}'s fallback. */
const systemFallbackCounts = new Map<string, number>();

/**
 * Persistent context id for a system a module usually builds once:
 * - the explicit `id` as given;
 * - else `${ambient}/${kind}`, under the enclosing persistent context;
 * - else `${kind}_${n}` from a per-kind counter, for a build outside any module (tests).
 *
 * The kind keeps two systems in one module from sharing a persistent context
 * and colliding on common ref ids like `unlocked`.
 *
 * @internal
 */
export function resolveSystemPersistentContextId(id: string | undefined, kind: string): string {
  if (id !== undefined) return id;
  const ambient = getCurrentPersistentContext();
  if (ambient !== undefined) return `${ambient}/${kind}`;
  const n = systemFallbackCounts.get(kind) ?? 0;
  systemFallbackCounts.set(kind, n + 1);
  return `${kind}_${n}`;
}

/**
 * The enclosing persistent context's full id, persistence namespace included:
 * the key in {@link persistentRefs}. Ref creation and lookup by ref use it, so
 * a ref registers under the right persistence namespace. Attribution (such as
 * a chain binding's) also uses it, for an id unique across engines, where
 * {@link getCurrentPersistentContext} strips the persistence namespace.
 */
export function getCurrentFullPersistentContext(): string | undefined {
  return addingContexts[addingContexts.length - 1];
}

// === FACTORY ===

/**
 * Options for creating a persistent ref.
 */
export interface PersistentOptions<T = unknown> {
  /** Check each write for NaN; a NaN write is logged and not written. Defaults to true. */
  checkNaN?: boolean;
  /**
   * Stable id for this ref inside its persistent context; it forms the save
   * key. Set it so the save key does not depend on creation order.
   */
  id?: string;
  /**
   * Mark the ref as Decimal-valued for schema derivation. Set this when the
   * default is a `number`/`string` DecimalSource rather than a Decimal instance.
   * Then the save validator accepts only valid Decimal inputs.
   * Without this, numeric refs get a lenient `number | string` schema that
   * still covers DecimalSource but doesn't construct-test the value.
   */
  decimal?: boolean;
  /**
   * Explicit runtime Zod schema override for save validation. When unset, the
   * save validator auto-derives a schema from the ref default's shape.
   * Typed as `unknown` here to keep persistence.ts Zod-agnostic — cast to
   * `z.ZodType<T>` at the call site.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema?: unknown extends T ? any : unknown;
  /**
   * Mark the ref as lifetime: a value that survives a reset, such as a
   * cumulative gain, a high-water mark or a lifetime counter. Only a reset that
   * names the ref itself writes it. A `resetPersistentContexts` reset scope
   * leaves it out, even with no `keep:` entry. A `thingsToReset` walk passes
   * over it inside any object or category it walks. Save, load and
   * `engine.dispose()` ignore the flag.
   *
   * The rule for engine systems: system-owned state that must survive a reset
   * is lifetime. Examples are cycle stats, best-of records, run pool aliveness,
   * automation unlocks and total play time. `Resource.cumulative` and
   * `Resource.best` are lifetime too; see {@link createResource}.
   *
   * To reset a lifetime ref, name it as a top-level entry, as in
   * `createReset({ thingsToReset: [resource.cumulative] })`, or call the
   * owning system's own reset method.
   *
   * Default: `false`.
   */
  lifetime?: boolean;
}

/**
 * Resolves to `Ok` when `T` is a serializable value and to `never` otherwise.
 * So a parameter typed through it rejects any other value at the call. Checking
 * here instead of intersecting the value parameter with {@link SerializableConstraint}
 * lets a literal default widen: `persistent(0)` is a `Persistent<number>`.
 */
export type IfSerializable<T, Ok> = [T] extends [SerializableConstraint<T>] ? Ok : never;

/**
 * Create a persistent ref, which the save manager saves and loads.
 *
 * @param defaultValue - The ref default, which a new save starts at, or an existing ref to wrap
 * @param options - Options; see {@link PersistentOptions}
 */
export function persistent<T>(
  defaultValue: T | Ref<T>,
  ...[options = {}]: IfSerializable<T, [options?: PersistentOptions<T>]>
): Persistent<T> {
  const { checkNaN = true, schema, decimal = false, lifetime = false } = options;
  const persistentState: Ref<T> = isRef(defaultValue)
    ? defaultValue
    : (ref<T>(defaultValue) as Ref<T>);

  // Snapshot the default so later in-place mutation of the live value can't
  // corrupt it — see cloneDefault.
  const actualDefault: T = cloneDefault(isRef(defaultValue) ? defaultValue.value : defaultValue);

  // Create the persistent alias
  const alias = computed({
    get: () => persistentState.value,
    set: (value: T) => {
      if (checkNaN) {
        checkNaNAndWrite(persistent, value);
      } else {
        persistent[PersistentState].value = value;
      }
    },
  }) as PersistentAlias<T>;

  // Attach the ref default to the persistent alias
  (alias as { [DefaultValue]: T })[DefaultValue] = actualDefault;

  // Create the persistent ref object that mocks a Vue ref
  const persistent = {
    get value(): T {
      return persistentState.value;
    },
    set value(value: T) {
      // Trace resource mutations when inside a tick
      if (isTracing() && 'displayName' in persistent) {
        const oldVal = persistentState.value;
        const delta = Decimal.sub(value as DecimalSource, oldVal as DecimalSource);
        if (!Decimal.eq(delta, 0)) {
          recordTrace(persistent as unknown as Resource, delta);
        }
      }

      if (checkNaN) {
        checkNaNAndWrite(persistent, value);
      } else {
        persistent[PersistentState].value = value;
      }
    },
    // Vue ref compatibility
    __v_isRef: true,
    [PersistentState]: persistentState,
    [DefaultValue]: actualDefault,
    [StackTrace]: getStackTrace(),
    [Deleted]: false,
    [PersistentAlias]: alias,
    [SaveDataPath]: undefined,
    [CheckNaN]: checkNaN,
    [PersistentId]: undefined,
    [PersistentSchema]: schema,
    [PersistentDecimal]: decimal,
    [Lifetime]: lifetime,
  } as unknown as Persistent<T>;

  // Register under the enclosing persistent context, if one is open
  const currentContext = getCurrentFullPersistentContext();
  if (currentContext) {
    persistentRefs[currentContext].add(persistent);
    refContextId.set(persistent, currentContext);
    if (options.id !== undefined) {
      setPersistentId(persistent as Persistent, options.id);
    }
  } else {
    console.warn(
      'Creating a persistent ref outside a persistent context. It is not saved or loaded.',
      persistent,
      '\nCreated at:\n' + persistent[StackTrace],
    );
  }

  return persistent;
}

// === REF UTILITIES ===

/**
 * Assign a stable id to a persistent ref inside its persistent context; the
 * id forms the ref's save key.
 *
 * A collision inside one persistent context throws, because a silent
 * overwrite is the bug this guards against. Assigning a ref the id it already
 * has is a no-op. Assigning a ref a new id frees the old one.
 *
 * {@link persistent} calls it for an explicit `id` option. Collector factories
 * ({@link createDefStates}, a category's `mapState`) call it too, because they
 * know the field name only after the factory returns.
 */
export function setPersistentId(ref: Persistent, id: string): void {
  const contextId = refContextId.get(ref);
  if (!contextId || !(contextId in persistentRefs)) {
    throw new Error(
      'setPersistentId: ref is not registered to a persistent context. ' +
        'Call setPersistentId only on refs created inside a persistent context.',
    );
  }
  const existing = ref[PersistentId];
  if (existing === id) return;
  // Collision check: walk the live refs in the persistent context. Deriving on
  // demand avoids drift between a cached id set and the live refs Set when
  // callers clear the persistent context (test teardown, etc.).
  for (const other of persistentRefs[contextId]) {
    if (other === ref || other[Deleted]) continue;
    if (other[PersistentId] === id) {
      throw new Error(
        `Persistent id collision in persistent context "${contextId}": "${id}" is already in use.`,
      );
    }
  }
  ref[PersistentId] = id;
}

/**
 * Check if a value is a persistent ref
 */
export function isPersistent(value: unknown): value is Persistent {
  return value != null && typeof value === 'object' && PersistentState in value;
}

/**
 * Get the persistent alias of a persistent ref. Pass it to other features, so
 * the save holds the value once.
 *
 * For any other object, it returns a proxy that hides the persistence symbols.
 */
export function aliasPersistent<T extends Persistent<S>, S>(
  persistentRef: T,
): T[typeof PersistentAlias];
export function aliasPersistent<T extends object>(obj: T): T;
export function aliasPersistent<T extends Persistent<S> | object, S>(
  value: T,
): T | PersistentAlias<S> {
  if (PersistentAlias in value) {
    // TS 6 narrows `value` only to `T & Record<typeof PersistentAlias, unknown>`; TS 7,
    // which the type-aware linter runs on, narrows further. Drop the cast and this
    // disable when the engine compiles with TS 7.
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion
    return (value as Persistent<S>)[PersistentAlias];
  }

  // For an object that is not a persistent ref, return a proxy that hides persistence symbols
  return new Proxy(value, {
    get(target, p) {
      if (p === PersistentState) return undefined;
      if (p === SkipPersistence) return true;
      return target[p as keyof typeof target];
    },
    set(target, key, value) {
      (target as Record<PropertyKey, unknown>)[key] = value;
      return true;
    },
    has(target, key) {
      if (key === PersistentState) return false;
      if (key === SkipPersistence) return true;
      return Reflect.has(target, key);
    },
  });
}

/**
 * Mark a persistent ref as deleted, so it won't be saved or loaded.
 * Use this for conditionally created persistent refs.
 *
 * Removes the ref from its originating persistent context's registration set,
 * looked up through the WeakMap, not the persistent context stack. So a call
 * outside the persistent context that created the ref still removes it.
 */
export function deletePersistent(persistentRef: Persistent): void {
  const originContext = refContextId.get(persistentRef);
  if (originContext && persistentRefs[originContext]) {
    persistentRefs[originContext].delete(persistentRef);
  }
  persistentRef[Deleted] = true;
}

/**
 * Reset a persistent ref to its ref default
 */
export function resetPersistent<T>(persistentRef: Persistent<T>): void {
  persistentRef.value = cloneDefault(persistentRef[DefaultValue]);
}

/**
 * True when a persistent ref's value equals its ref default.
 * {@link filterDefaultedRefs} uses it to prune redundant leaves from the save
 * data; a load restores an absent leaf to its ref default.
 *
 * A load restores the loading build's default, but the leaf is absent because
 * it held the writing build's default. So a content update that changes a
 * default moves every saved value that held the old one. A save migration
 * that reads the leaf sees `undefined`. Changing a default therefore needs a
 * save migration.
 *
 * Equality rules, in order:
 * 1. NaN-vs-NaN (numeric primitives only) → equal.
 * 2. Strict `===` → covers all primitives (string, number, boolean, null, undefined).
 * 3. Decimal: when either side is a `Decimal` instance, or the ref is flagged
 *    via `{ decimal: true }`, comparison goes through `Decimal.eq`. So
 *    different `Decimal` instances of the same value still match.
 * 4. Plain objects/arrays: bounded-depth structural equality (cap 6).
 * 5. Anything else (functions, refs, class instances other than `Decimal`,
 *    `Map`, `Set`, etc.) → never equal; the ref stays in the save data.
 */
export function isAtDefault<T>(persistentRef: Persistent<T>): boolean {
  const current = persistentRef[PersistentState].value;
  const def = persistentRef[DefaultValue];
  const isDecimalRef =
    persistentRef[PersistentDecimal] || def instanceof Decimal || current instanceof Decimal;
  return isAtDefaultEq(current, def, isDecimalRef, 0);
}

const MAX_DEEP_EQ_DEPTH = 6;

function isAtDefaultEq(a: unknown, b: unknown, isDecimal: boolean, depth: number): boolean {
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  if (a === b) return true;

  if (isDecimal) {
    try {
      return Decimal.eq(a as DecimalSource, b as DecimalSource);
    } catch {
      return false;
    }
  }

  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (depth >= MAX_DEEP_EQ_DEPTH) return false;
  if (!isPlainContainer(a) || !isPlainContainer(b)) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isAtDefaultEq(a[i], b[i], false, depth + 1)) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!isAtDefaultEq(ao[k], bo[k], false, depth + 1)) return false;
  }
  return true;
}

function isPlainContainer(v: object): boolean {
  if (Array.isArray(v)) return true;
  if (v instanceof Decimal) return false;
  if (v instanceof Map || v instanceof Set || v instanceof Date || v instanceof RegExp)
    return false;
  if (typeof (v as { [k: PropertyKey]: unknown })[PersistentState] !== 'undefined') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
}

/**
 * Return a new Map without the refs whose value equals their ref default. The
 * save manager calls it between {@link getAllPersistentRefs} and
 * {@link serializePersistents}, so the save data omits redundant leaves. That
 * makes a save dominated by default-valued primitives about 5× smaller. A
 * pruned leaf loads as the loading build's default; see {@link isAtDefault}.
 */
export function filterDefaultedRefs(refs: Map<string, Persistent>): Map<string, Persistent> {
  const out = new Map<string, Persistent>();
  for (const [key, ref] of refs) {
    if (!isAtDefault(ref)) out.set(key, ref);
  }
  return out;
}

// === REGISTRY QUERIES ===

/**
 * Get every persistent ref of one persistent context.
 *
 * It takes the raw persistent context id and resolves it in the active
 * persistence namespace only. So an engine never reads another engine's
 * persistent context.
 */
export function getPersistentRefs(contextId: string): Set<Persistent> | undefined {
  return persistentRefs[toFullContextId(contextId)];
}

/**
 * Get every non-lifetime persistent ref under a persistent context, child
 * persistent contexts included (categories, def states and the like).
 *
 * {@link getPersistentRefs} returns the refs of one persistent context. This
 * walks the tree of child persistent contexts rooted at `contextId`, and
 * collects every non-lifetime ref in it. The reset system uses it to resolve
 * a `resetPersistentContexts` reset scope.
 *
 * @param contextId - The raw persistent context id, often a module's `id`
 */
export function getPersistentContextRefs(contextId: string): Set<Persistent> {
  const result = new Set<Persistent>();
  for (const r of walkContextTree(contextId)) {
    if (!r[Lifetime]) result.add(r);
  }
  return result;
}

/**
 * Delete every ref in a persistent context and in its child persistent
 * contexts, lifetime refs included. So a build that failed partway leaves no
 * refs to be saved or to collide with a retry's ids.
 *
 * @param contextId - The raw persistent context id, resolved in the active persistence namespace
 * @internal
 */
export function deletePersistentContextRefs(contextId: string): void {
  for (const r of [...walkContextTree(contextId)]) deletePersistent(r);
}

/** Every ref in a persistent context and its child persistent contexts. */
function* walkContextTree(contextId: string): Generator<Persistent> {
  const stack = [toFullContextId(contextId)];
  while (stack.length > 0) {
    const ctx = stack.pop()!;
    const refs = persistentRefs[ctx];
    if (refs) yield* refs;
    const children = contextChildren[ctx];
    if (children) {
      for (const child of children) stack.push(child);
    }
  }
}

/**
 * Clear every registered persistent context and its refs.
 *
 * @internal A test-only reset for suites that re-create the same persistent
 * contexts across cases. Production code never needs it, because each engine
 * creates its persistent contexts once. A call in engine code is almost
 * certainly a bug.
 */
export function resetAllPersistentContexts(): void {
  for (const key of Object.keys(persistentRefs)) {
    delete persistentRefs[key];
  }
  for (const key of Object.keys(contextNamespaces)) {
    delete contextNamespaces[key];
  }
  for (const key of Object.keys(contextChildren)) {
    delete contextChildren[key];
  }
  unnamedWarnedContexts.clear();
}

/**
 * Delete every persistent context registered under the given persistence
 * namespace.
 *
 * `engine.dispose()` calls it, so a later engine with the same module ids can
 * install without colliding on persistent ref ids. Save storage is keyed
 * separately (gameId, plus the persistence namespace when set), and this does
 * not touch it.
 *
 * Pass `undefined` to delete every unnamespaced persistent context. That suits
 * a page with one engine. Two unnamespaced engines in one runtime would
 * interfere, so concurrent engines must each set a `persistenceNamespace`.
 *
 * The refs registered under the deleted persistent contexts are not changed.
 * Their `refContextId` WeakMap entries still point at the deleted id. A caller,
 * usually a disposed engine, must give up its references to the refs before
 * garbage collection reclaims them.
 */
export function deletePersistenceNamespace(persistenceNamespace?: string): void {
  const wantNs = persistenceNamespace ?? '';
  const cleared: string[] = [];
  for (const [fullId, ns] of Object.entries(contextNamespaces)) {
    if (ns === wantNs) cleared.push(fullId);
  }
  for (const fullId of cleared) {
    delete persistentRefs[fullId];
    delete contextNamespaces[fullId];
    delete contextChildren[fullId];
    unnamedWarnedContexts.delete(fullId);
  }
  // Persistent contexts in another persistence namespace may still list
  // deleted ids as children; remove those edges so getPersistentContextRefs
  // doesn't walk into deleted entries.
  for (const children of Object.values(contextChildren)) {
    for (const fullId of cleared) children.delete(fullId);
  }
}

// === DEF STATE MAPS ===

/**
 * Create a Map of def states. Each `stateFactory` result must be an *object*
 * of persistent refs, whose property keys become their stable ids.
 *
 * It opens persistent context `contextId` and calls `stateFactory` once per
 * def to build its def state. Every `persistent()` call inside the factory
 * registers under `contextId`.
 *
 * @param contextId - Persistent context id (e.g. 'jobs', 'explorations')
 * @param definitions - The defs to create def states for
 * @param stateFactory - Called once per def. It must return an *object* whose
 *   properties are persistent refs; the property keys become their stable ids.
 *   A bare `Persistent` gets no stable id, and only a console warning reports it.
 * @param keyAccessor - Function to extract the map key from a def (default: `def.id`)
 * @returns Map from key to def state
 *
 * @example
 * ```ts
 * const jobStates = createDefStates('jobs', JOBS, (def) => ({
 *   progress: persistent<DecimalSource>(0),
 *   timesCompleted: persistent<DecimalSource>(0),
 *   automationPriority: persistent<AutomationPriority>(AutomationPriority.Disabled),
 * }));
 * ```
 */
export function createDefStates<D, K, S>(
  contextId: string,
  definitions: readonly D[],
  stateFactory: (def: D) => S,
  keyAccessor: (def: D) => K = (def) => (def as { id: K }).id,
): Map<K, S> {
  const map = new Map<K, S>();
  // withPersistentContext, not a bare begin/end pair: a throwing stateFactory
  // must not leave the persistent context open and misplace every later ref.
  withPersistentContext(contextId, () => {
    for (const def of definitions) {
      const state = stateFactory(def);
      const defKey = keyAccessor(def);
      // Give every persistent field the id `${defId}.${fieldName}`, so save
      // keys stay stable when fields are reordered or added.
      if (state !== null && typeof state === 'object') {
        for (const [fieldName, value] of Object.entries(state as Record<string, unknown>)) {
          if (isPersistent(value) && value[PersistentId] === undefined) {
            setPersistentId(value, `${String(defKey)}.${fieldName}`);
          }
        }
      }
      map.set(defKey, state);
    }
  });
  return map;
}

// === SERIALIZATION ===

/**
 * Serialize the collected persistent refs to save data
 */
export function serializePersistents(refs: Map<string, Persistent>): Record<string, unknown> {
  const save: Record<string, unknown> = {};

  for (const [path, persistentRef] of refs) {
    const value = persistentRef.value;
    let encoded: unknown;
    if (value instanceof Decimal) {
      encoded = value.toString();
    } else if (typeof value === 'number' && !Number.isFinite(value)) {
      // JSON.stringify(Infinity|NaN) → null, so encode as string
      encoded = String(value);
    } else {
      encoded = value;
    }
    setNested(save, path, encoded);
  }

  return save;
}

/** The persistent contexts that have already warned about refs with no id, in this runtime */
const unnamedWarnedContexts: Set<string> = new Set();

/**
 * Build a Map of every persistent ref across every persistent context. A ref
 * with an id is keyed by it; a ref with none falls back to its iteration order.
 *
 * A key with an id has the shape `${contextId}.${refId}`. A collector
 * factory's composite id may itself contain `.` (e.g. `"jobs.warrior.progress"`),
 * and the serializer splits the full key to build nested save data.
 *
 * A fallback key has the shape `${contextId}.${index}`, and dev mode warns
 * once per persistent context. The fallback lets a consumer add ids gradually
 * without breaking saves, and keeps older saves round-tripping.
 *
 * The save manager uses it to save and load all live state.
 *
 * @param persistenceNamespace - When provided, only walks persistent contexts
 *   opened under {@link withPersistenceNamespace} with the same persistence
 *   namespace. When omitted, walks only unnamespaced persistent contexts. So
 *   two engines sharing a runtime each see only their own refs.
 *
 *   Persistent context ids in the returned keys and in each ref's `SaveDataPath`
 *   have the persistence namespace stripped. So save data moves between
 *   engines with different persistence namespaces.
 */
export function getAllPersistentRefs(persistenceNamespace?: string): Map<string, Persistent> {
  const result = new Map<string, Persistent>();
  const dev = isDev();
  const wantNs = persistenceNamespace ?? '';
  for (const [fullId, refs] of Object.entries(persistentRefs)) {
    if ((contextNamespaces[fullId] ?? '') !== wantNs) continue;
    const contextId = stripNamespace(fullId);
    let i = 0;
    let hadUnnamed = false;
    for (const ref of refs) {
      if (ref[Deleted]) continue;
      const name = ref[PersistentId];
      if (name !== undefined) {
        const key = `${contextId}.${name}`;
        ref[SaveDataPath] = [contextId, ...name.split('.')];
        result.set(key, ref);
      } else {
        hadUnnamed = true;
        const key = `${contextId}.${i}`;
        ref[SaveDataPath] = [contextId, String(i)];
        result.set(key, ref);
        // Only refs with no id count, so giving a sibling an id never shifts this key.
        i++;
      }
    }
    if (dev && hadUnnamed && !unnamedWarnedContexts.has(fullId)) {
      unnamedWarnedContexts.add(fullId);
      console.warn(
        `[persistence] Persistent context "${contextId}" has persistent refs without stable ids. ` +
          'Reordering persistent() calls inside it silently remaps saved values. ' +
          'Assign ids with persistent(default, { id: "..." }) or a collector factory.',
      );
    }
  }
  return result;
}

/** Non-finite numbers serialize as strings; this maps them back on load. */
const NON_FINITE_NUMBERS: Record<string, number> = { Infinity, '-Infinity': -Infinity, NaN };

/**
 * Revive a loaded save leaf or tree against its persistent ref's default:
 * decode the Decimals the serializer flattened to strings.
 *
 * break_eternity's `Decimal.toJSON` emits a string, so a `Decimal` nested
 * inside an object- or array-valued ref comes through JSON only as a string.
 * Top-level revival alone would return it as `"99"` and break the first
 * `.add`/`.gte` call. The ref default holds the declared shape and guides
 * revival:
 * - where the default holds a `Decimal`, the loaded leaf is rebuilt with `new Decimal(...)`;
 * - where it holds a `number`, non-finite strings (`"Infinity"`, `"NaN"`) are
 *   recovered, and a Decimal's rendering (from a `DecimalSource` ref that held one) revives;
 * - plain objects and arrays recurse. An array uses `default[i]` (falling back
 *   to `default[0]`) as the per-element type witness, so homogeneous Decimal arrays revive.
 *
 * Fields present in the loaded value but absent from the default pass through
 * unrevived, because the default supplies no type witness for them. So a
 * dynamically keyed Decimal map (default `{}`, keys added while the game runs)
 * is not revived; store its values as separate refs. An explicit `schema` does
 * not help: validation never transforms a leaf.
 */
function reviveValue(loaded: unknown, defaultNode: unknown): unknown {
  if (defaultNode instanceof Decimal) {
    return typeof loaded === 'string' ? new Decimal(loaded) : loaded;
  }
  if (typeof defaultNode === 'number') {
    if (typeof loaded !== 'string') return loaded;
    if (loaded in NON_FINITE_NUMBERS) return NON_FINITE_NUMBERS[loaded];
    // Decimal's parser reads junk as 0, so only text that is exactly a
    // Decimal's own rendering revives; any other text stays text.
    const decimal = new Decimal(loaded);
    return decimal.toString() === loaded ? decimal : loaded;
  }
  if (Array.isArray(defaultNode) && Array.isArray(loaded)) {
    if (defaultNode.length === 0) return loaded;
    return loaded.map((el, i) => reviveValue(el, defaultNode[i] ?? defaultNode[0]));
  }
  if (isRevivableObject(defaultNode) && isRevivableObject(loaded)) {
    const dn = defaultNode;
    const ld = loaded;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(ld)) {
      out[k] = k in dn ? reviveValue(ld[k], dn[k]) : ld[k];
    }
    return out;
  }
  return loaded;
}

/** Plain, non-array object safe to recurse into (excludes arrays, Decimal,
 * Map/Set/Date/RegExp, and persistent refs via {@link isPlainContainer}). */
function isRevivableObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && isPlainContainer(v);
}

/**
 * Load save data into persistent refs
 */
export function deserializePersistents(
  refs: Map<string, Persistent>,
  save: Record<string, unknown>,
): void {
  withSettling(() => {
    for (const [path, persistentRef] of refs) {
      const current = getNested(save, path);

      if (current !== undefined) {
        // Revive Decimals the serializer flattened to strings, top level and
        // nested alike, guided by the ref default's shape.
        const revived = reviveValue(current, persistentRef[DefaultValue]);
        persistentRef[PersistentState].value = revived as Serializable;
      } else {
        // Reset to the ref default when the save data lacks the leaf
        resetPersistent(persistentRef);
      }
    }
  });
}
