/**
 * Persistence — auto-saved refs with context-scoped registration.
 *
 * Key features:
 * - NaN detection to prevent corrupted saves
 * - Stack traces for debugging orphaned persistent refs
 * - PersistentAlias wrappers to avoid save duplication
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
 * Serializable state types that can be saved/loaded safely.
 * Note: Decimals aren't directly allowed because we need to know to parse them back.
 * DecimalSources (string/number) are allowed because they're valid Decimal inputs.
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

/** Primitive subset of State for use in conditional type branches */
export type SerializablePrimitive = string | number | boolean | null | undefined;

/**
 * Compile-time constraint that validates T is serializable without requiring
 * explicit index signatures on interfaces. Use in generic bounds instead of
 * `T extends State` — accepts `{ name: string; count: number }` directly.
 *
 * The object branch uses a mapped type (`{ [K in keyof T]: ... }`) which
 * checks each property structurally rather than demanding an index signature.
 * DecimalSource is checked before object so Decimal class instances pass
 * without mapped-type introspection of internal fields. A function, or an
 * object holding one (a Map, a class instance with methods), resolves to
 * `never`: it doesn't survive a save. A field declared `unknown` passes as
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

/** Symbol to access the underlying persistent state ref */
export const PersistentState = Symbol('PersistentState');

/** Symbol to access the default value for resets */
export const DefaultValue = Symbol('DefaultValue');

/** Symbol for the stack trace of where this persistent was created */
export const StackTrace = Symbol('StackTrace');

/** Symbol to mark a persistent as deleted (won't be saved) */
export const Deleted = Symbol('Deleted');

/** Symbol for the non-persistent computed wrapper */
export const PersistentAlias = Symbol('PersistentAlias');

/** Symbol for the save data path */
export const SaveDataPath = Symbol('SaveDataPath');

/** Symbol to check if NaN checking is enabled */
export const CheckNaN = Symbol('CheckNaN');

/**
 * Stable name of this persistent ref inside its context. When set, drives the
 * save-data key in {@link getAllPersistentRefs}. When unset, the key falls back
 * to iteration order — a dev-mode warning is emitted so the gap is observable.
 */
export const PersistentId = Symbol('PersistentId');

/**
 * Explicit Zod schema for this ref's runtime save validation. When unset, the
 * validator in `save-validation.ts` auto-derives from {@link DefaultValue}.
 * Carried as `unknown` so `persistence.ts` stays Zod-agnostic.
 */
export const PersistentSchema = Symbol('PersistentSchema');

/**
 * Marks a ref as Decimal-valued for schema derivation. Needed when the default
 * is a `number`/`string` DecimalSource rather than a Decimal instance, since
 * there's no runtime way to tell those apart from plain numeric refs.
 */
export const PersistentDecimal = Symbol('PersistentDecimal');

/** Symbol to skip persistence checks on an object */
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
 * A computed ref that reads/writes to a persistent ref.
 * Used to pass values without duplicating in save data.
 */
export type PersistentAlias<T = Serializable> = WritableComputedRef<T> & {
  readonly [DefaultValue]: T;
};

// === MODULE STATE ===

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
 * settle. A save manager load runs it after `save:loaded`, so after the
 * engine's `onLoad` callbacks: a watcher that reacts to a reconciler's write
 * sees the state `onLoad` rebuilt. The flag is shared by every engine in the
 * process, so the callback also runs after another engine's load and must be
 * idempotent. Stops with the effect scope it was registered in.
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
 * each one settles if it holds then. Mid-load, a condition can hold before
 * the state `fire` writes is restored, so the settled state decides. The
 * watch is sync so `fire` lands on the tick `holds` turns true, even under a
 * sim driving `tickOnce()` in a tight loop. `fire` must be idempotent.
 *
 * @returns A stop for both the watch and the hydration callback
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

/** Run every hydration callback, even past a throw; returns what they threw. */
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
 * so the state settles once, as the outermost call closes: the
 * {@link onHydrated} callbacks run then, or wait for an enclosing
 * {@link deferHydration}. Outside one, the first callback throw rethrows
 * from here once every callback has run.
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

/** Run the hydration callbacks for a settled load, or hold them for a deferral. */
function settleHydration(): void {
  if (hydrationDeferrals > 0) {
    hydrationPending = true;
    return;
  }
  const errors = runHydrated();
  if (errors.length > 0) throw errors[0];
}

/**
 * Run `fn` with {@link onHydrated} callbacks held until it returns or throws,
 * then run them once if a load or reset settled inside it. A throw from a
 * held callback goes to `onError` rather than out of this call: the writes
 * it reconciles have already landed. Nested calls hold until the outermost
 * closes, and report through its `onError`.
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

/** Track if we're currently in a context where persistent creation is expected */
const addingContexts: string[] = [];

/** Registry of persistent refs per context for validation */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const persistentRefs: Record<string, Set<Persistent<any>>> = {};

/** Map from a persistent ref to the context it was created in */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const refContextId: WeakMap<Persistent<any>, string> = new WeakMap();

/** Parent→child context relationships. When a context is pushed while another
 * is already on the stack, the new context becomes a child of the current top.
 * Used by {@link getPersistentContextRefs} to walk all refs owned by a module. */
const contextChildren: Record<string, Set<string>> = {};

/**
 * Ambient namespace applied to `beginPersistentContext` calls. When set,
 * context ids are stored as `${namespace}${NAMESPACE_SEP}${id}` so forkable
 * engine instances sharing a runtime don't collide on module/category ids.
 * Null = default/unnamespaced (legacy behavior, bit-for-bit compatible).
 *
 * Managed via {@link withPersistenceNamespace}. A stack is unnecessary —
 * nested namespaces aren't a supported use case.
 */
let activeNamespace: string | undefined;

/** Separator between namespace and raw context id. Colon avoids collision
 * with the `/` used by category-base for per-definition contexts. */
const NAMESPACE_SEP = '::';

/** Map from full (namespaced) contextId → originating namespace. Keyed with
 * `''` for default/unnamespaced contexts. Drives `getAllPersistentRefs`
 * filtering so each engine only sees its own refs. */
const contextNamespaces: Record<string, string> = {};

// === HELPERS ===

/**
 * Deep-clone a persistent ref's default so `DefaultValue` never aliases the
 * live state. Without this, in-place mutation of the ref's value (e.g. a
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

/** A raw context id as registered under the active namespace. */
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
 * Check for NaN and write to persistent state, with error handling
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

// === CONTEXT API ===

/**
 * Begin a context where persistent refs can be created.
 * All persistent refs created during this context will be tracked.
 *
 * When an ambient namespace is active (see {@link withPersistenceNamespace}),
 * the stored context id is prefixed with `${namespace}${NAMESPACE_SEP}` so
 * two engines in the same runtime can share module ids without collision.
 *
 * @param id - Unique identifier for this context (e.g., node ID). Must not contain `.`,
 *   which save paths split on — it throws.
 */
export function beginPersistentContext(id: string): void {
  // Save keys are `${contextId}.${name}` and split on "." into the nested save
  // object, so a dotted context id would save and validate at the wrong path.
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
 * End the current persistent context.
 */
export function endPersistentContext(): void {
  addingContexts.pop();
}

/**
 * Run a block inside a persistent context, guaranteeing the context is closed
 * even if the block throws. Preferred over manual begin/end pairs for simple
 * single-context scopes.
 *
 * @param id - Context identifier (same as {@link beginPersistentContext})
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
 * Run a block with an ambient persistence namespace applied to any
 * `beginPersistentContext` calls underneath. Used by the engine to isolate
 * forkable instances that share module/category ids.
 *
 * @param namespace - Namespace string, or undefined to run unnamespaced
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
 * Bind `fn` to the persistence namespace active now, so a call made after
 * install has closed it (a reset resolving its scope) still resolves context
 * ids in the engine that built the caller.
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
 * Strip the namespace prefix from a full context id, leaving the raw id the
 * caller passed to `beginPersistentContext`. Namespace-agnostic code that
 * needs to display or route on the context id (e.g. system fallback ids)
 * should read this, not the raw stack entry.
 *
 * The prefix is sliced by the *recorded* namespace length, not by indexOf
 * on the separator — so context ids that legitimately contain `::` for their
 * own scoping (e.g. resource lifetime trackers under `${parent}::${id}`)
 * round-trip with their structure intact instead of collapsing to whatever
 * follows the first `::`.
 */
function stripNamespace(fullId: string): string {
  const ns = contextNamespaces[fullId];
  if (!ns) return fullId;
  return fullId.slice(ns.length + NAMESPACE_SEP.length);
}

/**
 * Get the current persistent context ID, if any.
 *
 * Returns the raw id (namespace stripped) so consumer code that compares
 * against module/category ids stays stable regardless of which engine
 * instance the context was opened under.
 */
export function getCurrentPersistentContext(): string | undefined {
  const top = addingContexts[addingContexts.length - 1];
  return top === undefined ? undefined : stripNamespace(top);
}

/** Per-kind counters behind {@link resolveSystemPersistentContextId}'s fallback. */
const systemFallbackCounts = new Map<string, number>();

/**
 * Context id for a system a module usually builds once: the explicit `id` as
 * given, else `${ambient}/${kind}`, else `${kind}_${n}` from a per-kind
 * counter (a build outside any module — tests). The kind keeps two systems in
 * one module from sharing a context and colliding on common ref names like
 * `unlocked`.
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
 * Full (namespaced) context id used as the key in {@link persistentRefs}.
 * Ref creation and lookup-by-ref must use this so they land in the right
 * namespace bucket. Also used by attribution surfaces (e.g. chain bindings)
 * that want a globally-unique scope id rather than the namespace-stripped
 * {@link getCurrentPersistentContext} value.
 */
export function getCurrentFullPersistentContext(): string | undefined {
  return addingContexts[addingContexts.length - 1];
}

// === FACTORY ===

/**
 * Options for creating a persistent ref.
 */
export interface PersistentOptions<T = unknown> {
  /** Skip NaN detection on writes. Defaults to true. */
  checkNaN?: boolean;
  /**
   * Stable name for this ref inside its persistent context, used as the
   * save-data key. Required when you want rename-safe saves.
   */
  id?: string;
  /**
   * Mark the ref as Decimal-valued for schema derivation. Set this when the
   * default is a `number`/`string` DecimalSource rather than a Decimal instance
   * and you want the save validator to accept only valid Decimal inputs.
   * Without this, numeric refs get a lenient `number | string` schema that
   * still covers DecimalSource but doesn't construct-test the value.
   */
  decimal?: boolean;
  /**
   * Explicit runtime Zod schema override for save validation. When unset, the
   * save validator auto-derives a schema from the default value's shape.
   * Typed as `unknown` here to keep persistence.ts Zod-agnostic — cast to
   * `z.ZodType<T>` at the call site.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema?: unknown extends T ? any : unknown;
  /**
   * Mark the ref as lifetime: state that outlives a run, such as cumulative
   * gain, a high-water mark or a lifetime counter. Only a reset that names
   * the ref itself writes it. A `resetPersistentContexts` scope drops it, even with no
   * `keep:` entry, and a `thingsToReset` walk passes over it inside any
   * object or category it walks. Save, load and `engine.dispose()` ignore
   * the flag.
   *
   * The rule for engine systems: system-owned cross-run state is lifetime
   * (cycle stats, best-of records, run-pool aliveness, automation unlocks,
   * total play time and the like). `Resource.cumulative` and `Resource.best`
   * carry it too — see {@link createResource}.
   *
   * To wipe a lifetime ref, name it as a top-level entry,
   * `createReset({ thingsToReset: [resource.cumulative] })`, or call the
   * owning system's own reset verb.
   *
   * Default: `false`.
   */
  lifetime?: boolean;
}

/**
 * Resolves to `Ok` when `T` is serializable state and to `never` otherwise, so
 * a parameter typed through it rejects a non-state value at the call. Checking
 * here instead of intersecting the value parameter with {@link SerializableConstraint}
 * lets a literal default widen: `persistent(0)` is a `Persistent<number>`.
 */
export type IfSerializable<T, Ok> = [T] extends [SerializableConstraint<T>] ? Ok : never;

/**
 * Create a persistent ref that will be saved/loaded automatically.
 *
 * @param defaultValue - Initial value for new saves, or an existing ref to wrap
 * @param options - Configuration — see {@link PersistentOptions}
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

  // Create non-persistent computed wrapper
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

  // Attach default value to non-persistent wrapper
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

  // Track in current context if there is one
  const currentContext = getCurrentFullPersistentContext();
  if (currentContext) {
    persistentRefs[currentContext].add(persistent);
    refContextId.set(persistent, currentContext);
    if (options.id !== undefined) {
      setPersistentId(persistent as Persistent, options.id);
    }
  } else {
    console.warn(
      'Creating a persistent ref outside of a context. This may cause save/load issues.',
      persistent,
      '\nCreated at:\n' + persistent[StackTrace],
    );
  }

  return persistent;
}

// === REF UTILITIES ===

/**
 * Assign a stable save-data name to a persistent ref inside its context.
 *
 * Collisions within the same context throw — silent overwrite is exactly the
 * class of bug this guards against. Reassigning the same ref to
 * the same name is a no-op. Reassigning a ref from one name to another frees
 * the old name.
 *
 * Called directly with an explicit `name` on {@link persistent}'s options, or
 * by collector factories ({@link createDefStates}, category `mapState`)
 * that know the enclosing field name after the factory returns.
 */
export function setPersistentId(ref: Persistent, id: string): void {
  const contextId = refContextId.get(ref);
  if (!contextId || !(contextId in persistentRefs)) {
    throw new Error(
      'setPersistentId: ref is not registered to a context. ' +
        'Call setPersistentId only on refs created inside a persistent context.',
    );
  }
  const existing = ref[PersistentId];
  if (existing === id) return;
  // Collision check: walk live refs in the context. Deriving on demand avoids
  // drift between a cached name set and the live refs Set when callers clear
  // the context (test teardown, etc.).
  for (const other of persistentRefs[contextId]) {
    if (other === ref || other[Deleted]) continue;
    if (other[PersistentId] === id) {
      throw new Error(
        `Persistent id collision in context "${contextId}": "${id}" is already in use.`,
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
 * Get the non-persistent computed wrapper for a persistent ref.
 * Use this when passing to other features to avoid duplication in save data.
 *
 * For objects, returns a proxy that hides persistence symbols.
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

  // For non-persistent objects, return a proxy that hides persistence symbols
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
 * Removes the ref from its originating context's registration set (looked up
 * via the WeakMap, not the active context stack — so calling this outside the
 * creating context still cleans up).
 */
export function deletePersistent(persistentRef: Persistent): void {
  const originContext = refContextId.get(persistentRef);
  if (originContext && persistentRefs[originContext]) {
    persistentRefs[originContext].delete(persistentRef);
  }
  persistentRef[Deleted] = true;
}

/**
 * Reset a persistent ref to its default value
 */
export function resetPersistent<T>(persistentRef: Persistent<T>): void {
  persistentRef.value = cloneDefault(persistentRef[DefaultValue]);
}

/**
 * True when a persistent ref's current value equals its default. Used by
 * {@link filterDefaultedRefs} to prune redundant entries from the save
 * envelope; deserialize restores absent keys to their default.
 *
 * That default is the loading build's, not the saving one's: an absent leaf
 * means "the writing build's default". A content update that changes a
 * default therefore moves every saved value that sat at the old one, and a
 * migration reading the leaf sees `undefined`. Changing a default is a save
 * migration.
 *
 * Equality rules, in order:
 * 1. NaN-vs-NaN (numeric primitives only) → equal.
 * 2. Strict `===` → covers all primitives (string, number, boolean, null, undefined).
 * 3. Decimal: when either side is a `Decimal` instance, or the ref is flagged
 *    via `{ decimal: true }`, comparison goes through `Decimal.eq` so different
 *    `Decimal` instances representing the same value still match.
 * 4. Plain objects/arrays: bounded-depth structural equality (cap 6).
 * 5. Anything else (functions, refs, class instances other than `Decimal`,
 *    `Map`, `Set`, etc.) → never equal; the ref is kept.
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
 * Return a new Map with refs whose value equals their default removed. Used
 * by the save manager between {@link getAllPersistentRefs} and
 * {@link serializePersistents} so the envelope omits redundant leaves —
 * ~5× size win on saves dominated by default-valued primitives. A pruned
 * leaf loads as the loading build's default — see {@link isAtDefault}.
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
 * Get all persistent refs for a given context.
 *
 * Accepts the raw context id and resolves it within the active namespace
 * only, so a forked engine never reads another engine's context.
 */
export function getPersistentRefs(contextId: string): Set<Persistent> | undefined {
  return persistentRefs[toFullContextId(contextId)];
}

/**
 * Get all persistent refs belonging to a module, including refs created in
 * nested child contexts (categories, per-definition states, etc.).
 *
 * Unlike {@link getPersistentRefs} which returns only refs in one context,
 * this walks the parent→child context tree rooted at `contextId` and collects
 * every non-lifetime ref reachable from that root. Used by the reset system
 * to resolve `resetPersistentContexts` scope.
 *
 * @param contextId - The raw context id (typically the module's `id` field)
 */
export function getPersistentContextRefs(contextId: string): Set<Persistent> {
  const result = new Set<Persistent>();
  for (const r of walkContextTree(contextId)) {
    if (!r[Lifetime]) result.add(r);
  }
  return result;
}

/**
 * Delete every ref in a context and in the contexts opened inside it,
 * lifetime refs included, so a build that failed partway leaves no refs to be
 * saved or to collide with a retry's names.
 *
 * @param contextId - The raw context id, resolved in the active namespace
 * @internal
 */
export function deletePersistentContextRefs(contextId: string): void {
  for (const r of [...walkContextTree(contextId)]) deletePersistent(r);
}

/** Every ref reachable from a context through the parent→child context tree. */
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
 * @internal Test-only reset used by suites that re-create the same contexts
 * across cases. Production code never needs this — contexts are created once
 * per engine lifetime. Using this in engine code is almost certainly a bug.
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
 * Drop every persistent context registered under the given namespace.
 *
 * Called by `engine.dispose()` when an engine instance is being torn down so
 * a subsequent engine using the same module ids can install without colliding
 * on persistent-ref names. Save storage is keyed independently (gameId, plus
 * namespace when set) and is not touched here.
 *
 * Pass `undefined` to clear unnamespaced contexts. With no namespace this
 * empties the entire default bucket — fine for single-engine pages (the
 * default case), but two unnamespaced engines coexisting in the same runtime
 * would interfere. Concurrent engines must use a `persistenceNamespace` for
 * isolation.
 *
 * Refs registered under the cleared contexts are not mutated; their
 * `refContextId` WeakMap entries remain pointing at the now-deleted context
 * id. Callers (typically a disposed engine being garbage-collected) must drop
 * external references for the refs themselves to be reclaimed.
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
  // Surviving contexts (different namespace) may still list cleared ids in
  // their child set; drop those edges so getPersistentContextRefs doesn't
  // walk into deleted entries.
  for (const children of Object.values(contextChildren)) {
    for (const fullId of cleared) children.delete(fullId);
  }
}

// === DEFINITION STATE MAPS ===

/**
 * Create a Map of per-definition persistent state, where each `stateFactory`
 * result must be an *object* of persistent refs (property keys become the
 * stable save names).
 *
 * Wraps `beginPersistentContext`/`endPersistentContext` and iterates
 * definitions, calling `stateFactory` for each to build the state object.
 * All `persistent()` calls inside the factory are tracked under `contextId`.
 *
 * @param contextId - Persistence context name (e.g. 'jobs', 'explorations')
 * @param definitions - Array of definition objects to create state for
 * @param stateFactory - Called once per definition. Must return an *object* whose
 *   properties are the persistent refs — property keys become the stable save
 *   names. Returning a bare `Persistent` loses stable naming (runtime console
 *   warning only).
 * @param keyAccessor - Function to extract the map key from a definition (default: `def.id`)
 * @returns Map from key to state object
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
  // must not leave the context stack pushed and mis-scope every later ref.
  withPersistentContext(contextId, () => {
    for (const def of definitions) {
      const state = stateFactory(def);
      const defKey = keyAccessor(def);
      // Auto-name every persistent field as `${defId}.${fieldName}` so save
      // keys stay stable across field reorders and new-field additions.
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
 * Serialize collected persistent refs to a save object
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

/** Tracks which contexts have already warned about unnamed refs this session */
const unnamedWarnedContexts: Set<string> = new Set();

/**
 * Build a Map of all persistent refs across all contexts, keyed by a stable
 * name when one was assigned, or by iteration order as a legacy fallback.
 *
 * Named keys have the shape `${contextId}.${name}` — for composite names set
 * by collector factories, the name may itself contain `.` (e.g.
 * `"jobs.warrior.progress"`), and the serializer splits the full key
 * accordingly to build nested save objects.
 *
 * Fallback keys for unnamed refs have the shape `${contextId}.${index}` and
 * emit a dev-mode warning once per context — this path exists so consumers
 * can adopt names incrementally without breaking save compatibility, and so
 * that legacy saves still round-trip.
 *
 * Used by the save manager to serialize/deserialize all game state.
 *
 * @param persistenceNamespace - When provided, only walks contexts that were opened
 *   under {@link withPersistenceNamespace} with the same namespace. When
 *   omitted, walks only unnamespaced (default) contexts. This lets two
 *   engines sharing a runtime each see only their own refs.
 *
 *   Context ids in the returned Map keys and in each ref's `SaveDataPath`
 *   have the namespace prefix stripped so envelope data is portable across
 *   engines with different namespaces.
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
        // Only unnamed refs count, so naming a sibling never shifts this key.
        i++;
      }
    }
    if (dev && hadUnnamed && !unnamedWarnedContexts.has(fullId)) {
      unnamedWarnedContexts.add(fullId);
      console.warn(
        `[persistence] Context "${contextId}" has persistent refs without stable names. ` +
          'Reordering persistent() calls inside this context will silently remap save values. ' +
          'Assign names via persistent(default, { name: "..." }) or a collector factory.',
      );
    }
  }
  return result;
}

/** Non-finite numbers serialize::string; this maps them back on load. */
const NON_FINITE_NUMBERS: Record<string, number> = { Infinity, '-Infinity': -Infinity, NaN };

/**
 * Rehydrate a loaded save leaf/tree against a persistent ref's default,
 * reviving the Decimals the serializer flattened to strings.
 *
 * break_eternity's `Decimal.toJSON` emits a string, so a `Decimal` nested
 * inside an object- or array-valued ref survives JSON serialization only as a
 * string — top-level revival alone would hand it back as `"99"` and break the
 * first `.add`/`.gte` call. The default value carries the declared shape and
 * drives revival: wherever the default holds a `Decimal`, the matching loaded
 * leaf is reconstructed via `new Decimal(...)`; wherever it holds a `number`,
 * non-finite strings (`"Infinity"`, `"NaN"`) are recovered and a Decimal's
 * rendering (a `DecimalSource` ref that held one) revives. Plain objects and
 * arrays recurse; arrays use `default[i]` (falling back to `default[0]`) as the
 * per-element type witness so homogeneous Decimal arrays revive.
 *
 * Fields present in the loaded value but absent from the default pass through
 * unrevived — the default supplies no type witness for them. A dynamically
 * keyed Decimal map (default `{}`, keys added at runtime) therefore isn't
 * revived; store those as separate refs or via an explicit schema.
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
        // Rehydrate Decimals the serializer flattened to strings — top level and
        // nested alike, guided by the ref's declared default shape.
        const revived = reviveValue(current, persistentRef[DefaultValue]);
        persistentRef[PersistentState].value = revived as Serializable;
      } else {
        // Reset to default if not in save
        resetPersistent(persistentRef);
      }
    }
  });
}
