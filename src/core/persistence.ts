/**
 * Persistence — auto-saved refs with context-scoped registration.
 *
 * Key features:
 * - NaN detection to prevent corrupted saves
 * - Stack traces for debugging orphaned persistent refs
 * - NonPersistent wrappers to avoid save duplication
 * - Deleted flag for conditional persistence
 */

import { ref, computed, isRef, type Ref, type WritableComputedRef } from 'vue';
import { Decimal } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import { isTracing, recordTrace } from './trace';
import type { Resource } from './resource';
import { isDev } from './common';

// === STATE TYPES ===

/**
 * Serializable state types that can be saved/loaded safely.
 * Note: Decimals aren't directly allowed because we need to know to parse them back.
 * DecimalSources (string/number) are allowed because they're valid Decimal inputs.
 */
export type State =
  | string
  | number
  | boolean
  | DecimalSource
  | null
  | undefined
  | State[]
  | { [key: string]: State }
  | { [key: number]: State };

/** Primitive subset of State for use in conditional type branches */
export type StatePrimitive = string | number | boolean | null | undefined;

/**
 * Compile-time constraint that validates T is serializable without requiring
 * explicit index signatures on interfaces. Use in generic bounds instead of
 * `T extends State` — accepts `{ name: string; count: number }` directly.
 *
 * The object branch uses a mapped type (`{ [K in keyof T]: ... }`) which
 * checks each property structurally rather than demanding an index signature.
 * DecimalSource is checked before object so Decimal class instances pass
 * without mapped-type introspection of internal fields.
 */
export type StateConstraint<T> = T extends StatePrimitive
  ? T
  : T extends DecimalSource
    ? T
    : T extends readonly (infer U)[]
      ? readonly StateConstraint<U>[]
      : T extends object
        ? { [K in keyof T]: StateConstraint<T[K]> }
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
export const NonPersistent = Symbol('NonPersistent');

/** Symbol for the save data path */
export const SaveDataPath = Symbol('SaveDataPath');

/** Symbol to check if NaN checking is enabled */
export const CheckNaN = Symbol('CheckNaN');

/**
 * Stable name of this persistent ref inside its context. When set, drives the
 * save-data key in {@link getAllPersistentRefs}. When unset, the key falls back
 * to iteration order — a dev-mode warning is emitted so the gap is observable.
 */
export const PersistentName = Symbol('PersistentName');

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

/**
 * Marks a persistent ref as "lifetime" — outside the reach of any
 * module-scoped reset. The flag is read by {@link getModulePersistentRefs},
 * which is the only path resets use to gather their scope.
 *
 * Default: absent / falsy. Set via `persistent(default, { lifetime: true })`
 * for trackers that model "full-life" state (cumulative gain, high-water
 * marks, lifetime statistics) rather than per-run state. Without the flag,
 * a tracker registered inside a module's persistent context would be
 * caught by every reset that names that module — silently zeroing the
 * "lifetime" field on every prestige.
 */
export const Lifetime = Symbol('Lifetime');

// === REF TYPES ===

/**
 * A ref that is automatically saved and loaded.
 * Includes metadata for debugging and save management.
 */
export type Persistent<T = State> = Ref<T> & {
  readonly [PersistentState]: Ref<T>;
  readonly [DefaultValue]: T;
  readonly [StackTrace]: string;
  [Deleted]: boolean;
  readonly [NonPersistent]: NonPersistent<T>;
  [SaveDataPath]: string[] | undefined;
  readonly [CheckNaN]: boolean;
  [PersistentName]: string | undefined;
  readonly [PersistentSchema]: unknown;
  readonly [PersistentDecimal]: boolean;
  readonly [Lifetime]: boolean;
};

/**
 * A computed ref that reads/writes to a persistent ref.
 * Used to pass values without duplicating in save data.
 */
export type NonPersistent<T = State> = WritableComputedRef<T> & {
  readonly [DefaultValue]: T;
};

// === MODULE STATE ===

/** Flag to prevent watchers from triggering during save load */
export const loadingSave = ref(false);

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
 * Used by {@link getModulePersistentRefs} to walk all refs owned by a module. */
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
  for (const k of Object.keys(value as object)) {
    out[k] = cloneDefault((value as Record<string, unknown>)[k]);
  }
  return out as T;
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
    if (Decimal.isNaN(value as DecimalSource)) {
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
 * @param id - Unique identifier for this context (e.g., node ID)
 */
export function beginPersistentContext(id: string): void {
  const fullId = activeNamespace ? `${activeNamespace}${NAMESPACE_SEP}${id}` : id;
  const parent = addingContexts[addingContexts.length - 1];
  addingContexts.push(fullId);
  if (!(fullId in persistentRefs)) {
    persistentRefs[fullId] = new Set();
    contextNamespaces[fullId] = activeNamespace ?? '';
  }
  if (parent !== undefined) {
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
 *   {@link EngineConfig.persistenceNamespace} instead.
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
 * Strip the namespace prefix from a full context id, leaving the raw id the
 * caller passed to `beginPersistentContext`. Namespace-agnostic code that
 * needs to display or route on the context id (e.g. system fallback ids)
 * should read this, not the raw stack entry.
 */
function stripNamespace(fullId: string): string {
  const sep = fullId.indexOf(NAMESPACE_SEP);
  if (sep === -1) return fullId;
  return fullId.slice(sep + NAMESPACE_SEP.length);
}

/**
 * Get the current persistent context ID, if any.
 *
 * Returns the raw id (namespace stripped) so consumer code that compares
 * against module/category ids stays stable regardless of which engine
 * instance the context was opened under.
 */
export function getCurrentContext(): string | undefined {
  const top = addingContexts[addingContexts.length - 1];
  return top === undefined ? undefined : stripNamespace(top);
}

/**
 * Full (namespaced) context id used as the key in {@link persistentRefs}.
 * Ref creation and lookup-by-ref must use this so they land in the right
 * namespace bucket. Also used by attribution surfaces (e.g. chain bindings)
 * that want a globally-unique scope id rather than the namespace-stripped
 * {@link getCurrentContext} value.
 */
export function getCurrentFullContext(): string | undefined {
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
  name?: string;
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
   * Mark the ref as "lifetime" — invisible to module-scoped resets.
   *
   * `getModulePersistentRefs` (the sole scope-resolver for {@link createReset})
   * filters out lifetime refs while walking a module's persistent context
   * tree, so any reset declared via `resetModules: [moduleId]` will skip
   * lifetime refs registered under that module — even without an explicit
   * `keep:` exemption. Save / load and `engine.dispose()` paths ignore the
   * flag and serialize the ref as normal.
   *
   * Use this for trackers that model the resource's full life (cumulative
   * gain, high-water mark, lifetime counters) rather than per-run state.
   * The flag is the default for the trackers `Resource.cumulative` and
   * `Resource.best` — see {@link createResource}.
   *
   * Opt-out for a specific reset: pass the lifetime ref directly via
   * `createReset({ thingsToReset: [resource.cumulative] })`. The reset's
   * `thingsToReset` set bypasses `getModulePersistentRefs` and resets any ref
   * the consumer hands it.
   *
   * Default: `false`.
   */
  lifetime?: boolean;
}

/**
 * Create a persistent ref that will be saved/loaded automatically.
 *
 * @param defaultValue - Initial value for new saves, or an existing ref to wrap
 * @param options - Configuration — see {@link PersistentOptions}
 */
export function persistent<T>(
  defaultValue: (T & StateConstraint<T>) | Ref<T & StateConstraint<T>>,
  options: PersistentOptions<T> = {},
): Persistent<T> {
  const { checkNaN = true, schema, decimal = false, lifetime = false } = options;
  const persistentState: Ref<T> = isRef(defaultValue)
    ? defaultValue
    : (ref<T>(defaultValue) as Ref<T>);

  // Snapshot the default so later in-place mutation of the live value can't
  // corrupt it — see cloneDefault.
  const actualDefault: T = cloneDefault(isRef(defaultValue) ? defaultValue.value : defaultValue);

  // Create non-persistent computed wrapper
  const nonPersistent = computed({
    get: () => persistentState.value,
    set: (value: T) => {
      if (checkNaN) {
        checkNaNAndWrite(persistent, value);
      } else {
        persistent[PersistentState].value = value;
      }
    },
  }) as NonPersistent<T>;

  // Attach default value to non-persistent wrapper
  (nonPersistent as { [DefaultValue]: T })[DefaultValue] = actualDefault;

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
    [NonPersistent]: nonPersistent,
    [SaveDataPath]: undefined,
    [CheckNaN]: checkNaN,
    [PersistentName]: undefined,
    [PersistentSchema]: schema,
    [PersistentDecimal]: decimal,
    [Lifetime]: lifetime,
  } as unknown as Persistent<T>;

  // Track in current context if there is one
  const currentContext = getCurrentFullContext();
  if (currentContext) {
    persistentRefs[currentContext].add(persistent);
    refContextId.set(persistent, currentContext);
    if (options.name !== undefined) {
      setPersistentName(persistent as Persistent, options.name);
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
 * class of bug this refactor exists to prevent. Reassigning the same ref to
 * the same name is a no-op. Reassigning a ref from one name to another frees
 * the old name.
 *
 * Called directly with an explicit `name` on {@link persistent}'s options, or
 * by collector factories ({@link createDefinitionStates}, category `mapState`)
 * that know the enclosing field name after the factory returns.
 */
export function setPersistentName(ref: Persistent, name: string): void {
  const contextId = refContextId.get(ref);
  if (!contextId || !(contextId in persistentRefs)) {
    throw new Error(
      'setPersistentName: ref is not registered to a context. ' +
        'Call setPersistentName only on refs created inside a persistent context.',
    );
  }
  const existing = ref[PersistentName];
  if (existing === name) return;
  // Collision check: walk live refs in the context. Deriving on demand avoids
  // drift between a cached name set and the live refs Set when callers clear
  // the context (validatePersistentRefs, test teardown, etc.).
  for (const other of persistentRefs[contextId]) {
    if (other === ref || other[Deleted]) continue;
    if (other[PersistentName] === name) {
      throw new Error(
        `Persistent name collision in context "${contextId}": "${name}" is already in use.`,
      );
    }
  }
  ref[PersistentName] = name;
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
export function noPersist<T extends Persistent<S>, S>(persistentRef: T): T[typeof NonPersistent];
export function noPersist<T extends object>(obj: T): T;
export function noPersist<T extends Persistent<S> | object, S>(value: T): T | NonPersistent<S> {
  if (NonPersistent in value) {
    return (value as Persistent<S>)[NonPersistent];
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
  }) as T;
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
 * envelope; deserialize already restores absent keys to their default, so
 * dropping them is consumer-transparent.
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
 * ~5× size win on saves dominated by default-valued primitives.
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
 * Accepts the raw context id — namespace resolution uses the currently
 * active namespace (if any) so the default/unnamespaced lookup path keeps
 * working for consumers and tests that have no awareness of namespacing.
 */
export function getPersistentRefs(contextId: string): Set<Persistent> | undefined {
  const fullId = activeNamespace ? `${activeNamespace}${NAMESPACE_SEP}${contextId}` : contextId;
  return persistentRefs[fullId] ?? persistentRefs[contextId];
}

/**
 * Get all persistent refs belonging to a module, including refs created in
 * nested child contexts (categories, per-definition states, etc.).
 *
 * Unlike {@link getPersistentRefs} which returns only refs in one context,
 * this walks the parent→child context tree rooted at `moduleId` and collects
 * every ref reachable from that root. Used by the reset system to resolve
 * `resetModules` scope.
 *
 * @param moduleId - The raw context id (typically the module's `id` field)
 */
export function getModulePersistentRefs(moduleId: string): Set<Persistent> {
  const fullId = activeNamespace ? `${activeNamespace}${NAMESPACE_SEP}${moduleId}` : moduleId;
  const rootId = fullId in persistentRefs ? fullId : moduleId;
  const result = new Set<Persistent>();
  const stack = [rootId];
  while (stack.length > 0) {
    const ctx = stack.pop()!;
    const refs = persistentRefs[ctx];
    if (refs) {
      // Lifetime refs (cumulative trackers, high-water marks, anything
      // tagged `{ lifetime: true }`) sit inside a module's persistent
      // context tree but model state that should outlive any
      // module-scoped reset. They drop out of the scope walk so resets
      // with `resetModules: [moduleId]` don't sweep them — consumers can
      // still target one explicitly via `thingsToReset` when a hard
      // wipe is intentional.
      for (const r of refs) {
        if (r[Lifetime]) continue;
        result.add(r);
      }
    }
    const children = contextChildren[ctx];
    if (children) {
      for (const child of children) stack.push(child);
    }
  }
  return result;
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
export function clearPersistentNamespace(namespace?: string): void {
  const wantNs = namespace ?? '';
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
  // their child set; drop those edges so getModulePersistentRefs doesn't
  // walk into deleted entries.
  for (const children of Object.values(contextChildren)) {
    for (const fullId of cleared) children.delete(fullId);
  }
}

// === VALIDATION + COLLECTORS ===

/**
 * Validate that all persistent refs in a context were properly registered.
 * Call this after setting up a context to catch orphaned persistent refs.
 */
export function validatePersistentRefs(contextId: string, registeredRefs: Set<Persistent>): void {
  const contextRefs = persistentRefs[contextId];
  if (!contextRefs) return;

  for (const persistent of contextRefs) {
    if (persistent[Deleted]) continue;
    if (!registeredRefs.has(persistent)) {
      console.error(
        `Created persistent ref in "${contextId}" without registering it!`,
        'Make sure to include all persistent refs in the returned object.',
        '\nCreated at:\n' + persistent[StackTrace],
      );
    }
  }

  // Clear the tracking set after validation
  contextRefs.clear();
}

/**
 * Create a Map of persistent state objects for an array of definitions.
 *
 * Wraps `beginPersistentContext`/`endPersistentContext` and iterates
 * definitions, calling `stateFactory` for each to build the state object.
 * All `persistent()` calls inside the factory are tracked under `contextId`.
 *
 * @param contextId - Persistence context name (e.g. 'jobs', 'explorations')
 * @param definitions - Array of definition objects to create state for
 * @param stateFactory - Called once per definition, should return an object containing persistent refs
 * @param keyAccessor - Function to extract the map key from a definition (default: `def.id`)
 * @returns Map from key to state object
 *
 * @example
 * ```ts
 * const jobStates = createDefinitionStates('jobs', JOBS, (def) => ({
 *   progress: persistent<DecimalSource>(0),
 *   timesCompleted: persistent<DecimalSource>(0),
 *   automationPriority: persistent<AutomationPriority>(AutomationPriority.Disabled),
 * }));
 * ```
 */
export function createDefinitionStates<D, K, S>(
  contextId: string,
  definitions: readonly D[],
  stateFactory: (def: D) => S,
  keyAccessor: (def: D) => K = (def) => (def as { id: K }).id,
): Map<K, S> {
  const map = new Map<K, S>();
  beginPersistentContext(contextId);
  for (const def of definitions) {
    const state = stateFactory(def);
    const defKey = keyAccessor(def);
    // Auto-name every persistent field as `${defId}.${fieldName}` so save
    // keys stay stable across field reorders and new-field additions.
    if (state !== null && typeof state === 'object') {
      for (const [fieldName, value] of Object.entries(state as Record<string, unknown>)) {
        if (isPersistent(value) && value[PersistentName] === undefined) {
          setPersistentName(value, `${String(defKey)}.${fieldName}`);
        }
      }
    }
    map.set(defKey, state);
  }
  endPersistentContext();
  return map;
}

/**
 * Recursively collect all persistent refs from an object tree.
 * Handles nested objects and arrays.
 */
export function collectPersistentRefs(
  obj: Record<string, unknown>,
  path: string[] = [],
): Map<string, Persistent> {
  const refs = new Map<string, Persistent>();

  for (const [key, value] of Object.entries(obj)) {
    if (value == null || typeof value !== 'object') continue;

    // Skip objects marked to skip persistence
    if (SkipPersistence in value && value[SkipPersistence] === true) continue;

    if (isPersistent(value)) {
      if (value[Deleted]) continue;

      const savePath = [...path, key];
      value[SaveDataPath] = savePath;
      // Auto-name from walk path when the ref has no explicit name yet.
      // collectPersistentRefs is a consumer-side helper — this lets those
      // consumers get name-stable keys without touching every `persistent()`.
      if (value[PersistentName] === undefined && refContextId.has(value)) {
        try {
          setPersistentName(value, savePath.slice(1).join('.') || key);
        } catch {
          // Collision — ref already named elsewhere in this context; leave it.
        }
      }
      refs.set(savePath.join('.'), value);
    } else if (!isRef(value) && !(value instanceof Decimal)) {
      // Recurse into plain objects
      const nested = collectPersistentRefs(value as Record<string, unknown>, [...path, key]);
      for (const [nestedPath, nestedRef] of nested) {
        refs.set(nestedPath, nestedRef);
      }
    }
  }

  return refs;
}

// === SERIALIZATION ===

/**
 * Serialize collected persistent refs to a save object
 */
export function serializePersistents(refs: Map<string, Persistent>): Record<string, unknown> {
  const save: Record<string, unknown> = {};

  for (const [path, persistentRef] of refs) {
    const parts = path.split('.');
    let current = save;

    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current)) {
        current[parts[i]] = {};
      }
      current = current[parts[i]] as Record<string, unknown>;
    }

    const value = persistentRef.value;
    if (value instanceof Decimal) {
      current[parts[parts.length - 1]] = value.toString();
    } else if (typeof value === 'number' && !Number.isFinite(value)) {
      // JSON.stringify(Infinity|NaN) → null, so encode as string
      current[parts[parts.length - 1]] = String(value);
    } else {
      current[parts[parts.length - 1]] = value;
    }
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
 * @param namespace - When provided, only walks contexts that were opened
 *   under {@link withPersistenceNamespace} with the same namespace. When
 *   omitted, walks only unnamespaced (default) contexts. This lets two
 *   engines sharing a runtime each see only their own refs.
 *
 *   Context ids in the returned Map keys and in each ref's `SaveDataPath`
 *   have the namespace prefix stripped so envelope data is portable across
 *   engines with different namespaces.
 */
export function getAllPersistentRefs(namespace?: string): Map<string, Persistent> {
  const result = new Map<string, Persistent>();
  const dev = isDev();
  const wantNs = namespace ?? '';
  for (const [fullId, refs] of Object.entries(persistentRefs)) {
    if ((contextNamespaces[fullId] ?? '') !== wantNs) continue;
    const contextId = stripNamespace(fullId);
    let i = 0;
    let hadUnnamed = false;
    for (const ref of refs) {
      if (ref[Deleted]) continue;
      const name = ref[PersistentName];
      if (name !== undefined) {
        const key = `${contextId}.${name}`;
        ref[SaveDataPath] = [contextId, ...name.split('.')];
        result.set(key, ref);
      } else {
        hadUnnamed = true;
        const key = `${contextId}.${i}`;
        ref[SaveDataPath] = [contextId, String(i)];
        result.set(key, ref);
      }
      i++;
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

/**
 * Load save data into persistent refs
 */
export function deserializePersistents(
  refs: Map<string, Persistent>,
  save: Record<string, unknown>,
): void {
  loadingSave.value = true;

  try {
    for (const [path, persistentRef] of refs) {
      const parts = path.split('.');
      let current: unknown = save;

      for (const part of parts) {
        if (current == null || typeof current !== 'object') {
          current = undefined;
          break;
        }
        current = (current as Record<string, unknown>)[part];
      }

      if (current !== undefined) {
        // Recover non-finite numbers encoded as strings during serialization
        if (typeof current === 'string' && typeof persistentRef[DefaultValue] === 'number') {
          const numMap: Record<string, number> = { Infinity, '-Infinity': -Infinity, NaN };
          if (current in numMap) {
            current = numMap[current];
          }
        }
        persistentRef[PersistentState].value = current as State;
      } else {
        // Reset to default if not in save
        resetPersistent(persistentRef);
      }
    }
  } finally {
    loadingSave.value = false;
  }
}
