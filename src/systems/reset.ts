/**
 * Reset system — prestige and layer mechanics
 *
 * A Reset zeroes a configurable scope of persistent refs back to their
 * default values, with optional retention transforms for refs that should
 * survive (or partially survive) the reset. Scope can be defined manually
 * (a list of objects to walk) or by module ID (resolved via the persistent
 * ref registry), and Reset objects compose — one Reset's resolved scope can
 * feed another's `resetPersistentContexts`.
 *
 * Factories:
 * - {@link createReset} — the reset mechanic itself (scope, retention, hooks)
 * - {@link createResetTimer} — satellite helper that creates a `Ref<number>`
 *   wired to a reset's `afterReset` event for tracking time-since-last-reset
 *
 * Inline `keep`/`retain` options on `createReset` are shorthand for
 * {@link createRetentionPolicy} — drop down to a standalone retention policy
 * when the policy needs to outlive any single Reset.
 */

import { ref, unref, type Ref } from 'vue';
import { Decimal } from '@/primitives/decimal';
import { processGetter, type Computable } from '@/core/computed';
import {
  Lifetime,
  SkipPersistence,
  type Persistent,
  isPersistent,
  resetPersistent,
  withLoadingSave,
  getPersistentContextRefs,
  getPersistentRefs,
  bindPersistenceNamespace,
} from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { isFormula } from '@/core/formulas';
import { Resettable } from '@/core/resettable';
import { createRetentionPolicy } from './retention';
import { createPredicateResolver, type Predicate } from './gate';

// === TYPES ===

/**
 * Any object exposing a resolved set of persistent refs for composable reset
 * scope. Both {@link Reset} and Cycle implement this — using a structural type
 * avoids circular imports between reset.ts and cycle.ts.
 */
export interface ScopedReset {
  readonly resolvedScope: ReadonlySet<Persistent>;
}

/**
 * A reset scope entry: either a module ID (string) resolved via the persistent
 * ref registry, or another Reset/Cycle whose resolved scope is unioned in.
 */
export type ResetScope = string | ScopedReset;

/**
 * Configuration for a reset mechanic
 */
export interface ResetOptions {
  /**
   * Things to reset via recursive object walking. Can include:
   * - Objects with persistent refs (recursively searched)
   * - Resources
   * - Individual persistent refs
   * - Categories and stateful systems, which reset what a module reset
   *   would reset of their own persistent context
   *
   * The walk skips lifetime refs, and a lifetime ref given here as its own
   * entry is reset (see `PersistentOptions.lifetime`).
   *
   * Optional when {@link resetPersistentContexts} is provided.
   */
  thingsToReset?: Computable<unknown[]>;

  /**
   * Module-scoped reset: declare which modules to reset by ID, or compose
   * with other Reset/Cycle objects to inherit their scope. The engine resolves
   * each module ID to all persistent refs created during that module's
   * install/connect phase (including nested category/definition contexts).
   *
   * Resolved each time the reset runs (and each time `resolvedScope` is
   * read), so refs a module creates after `createReset` — in `connect`, or
   * in a module installed later — are in scope. An id that names no
   * registered module resets nothing and logs a warning on the first
   * `reset()`.
   *
   * @example
   * ```ts
   * resetPersistentContexts: ['jobs', 'skills', 'economy']
   * resetPersistentContexts: [innerReset, 'rebirth']  // composable
   * ```
   */
  resetPersistentContexts?: ResetScope[];

  /**
   * Readiness gate. When supplied, {@link Reset.reset} returns `false`
   * without performing the reset whenever this evaluates falsy — matches the
   * `onBeforeReset: () => false` cancellation contract. A Gate is
   * also visible to the predictor and to UI hints (call
   * `timeUntilGateFlip(canReset, runtime)` for "time-until-prestige-ready").
   *
   * Evaluated when `reset()` is called; a Gate resolves through the runtime
   * captured at `createReset` time. Omit to default to "always allowed".
   *
   * Order of cancellation checks at `reset()`:
   * 1. `canReset` (if supplied) — short-circuits if falsy
   * 2. `onBeforeReset` (if supplied) — short-circuits if it returns `false`
   *
   * Both are opt-in and either can cancel; `canReset` is for declarative /
   * predictor visibility, `onBeforeReset` is for imperative side-effects
   * that may also want to veto.
   */
  canReset?: Predicate;

  /**
   * Refs that should survive the reset unchanged.
   * Inline shorthand for {@link createRetentionPolicy}'s `keep` option.
   */
  keep?: Persistent[];

  /**
   * Refs with custom retention transforms applied after reset.
   * The transform receives the pre-reset value and returns the post-reset value.
   * Inline shorthand for {@link createRetentionPolicy}'s `retain` option.
   *
   * @example retain: new Map([[skillLevel, fractional(0.1)]])
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retain?: Map<Persistent, (value: any) => any>;

  /**
   * Called before the reset happens.
   * Can return false to cancel the reset.
   */
  onBeforeReset?: () => boolean | void;

  /**
   * Called after the reset has written its refs, before `afterReset` fires.
   *
   * Runs under the same load guard as the reset itself, so resource writes
   * here never reach `cumulative` / `best` (nor a `cumulative-gte` Gate).
   * That suits scripted setup; grant earnings — prestige currency — after
   * `reset()` returns instead.
   */
  onReset?: () => void;
}

/**
 * A reset mechanic that can reset game progress
 */
export interface Reset extends ScopedReset {
  /** Things that will be reset (from thingsToReset option) */
  thingsToReset: Ref<unknown[]> | unknown[] | undefined;

  /**
   * The flattened set of persistent refs resolved from {@link ResetOptions.resetPersistentContexts},
   * re-resolved on every read. Empty when only `thingsToReset` is used.
   * Exposed so other resets/cycles can compose with this reset's scope via
   * `resetPersistentContexts: [thisReset]`.
   */
  readonly resolvedScope: ReadonlySet<Persistent>;

  /** Trigger the reset */
  reset: () => boolean;

  /** Pre-reset hook */
  onBeforeReset?: () => boolean | void;

  /** Post-reset hook */
  onReset?: () => void;

  /** Subscribe to this reset's events */
  on: Emittable<ResetEvents>['on'];
}

/**
 * Events emitted by a Reset instance
 */
export interface ResetEvents {
  /** Fired before this reset executes */
  beforeReset: () => void;
  /**
   * Fired after this reset completes, still under its load guard: resource
   * writes in a listener never reach `cumulative` / `best`. Grant earnings
   * after `reset()` returns.
   */
  afterReset: () => void;
}

// === RESET CREATION ===

/**
 * Each Reset's scope resolution with its own unknown-id warning attached, so a
 * reset composing it warns as running it alone would. The `resolvedScope`
 * getter stays silent: a read before every module has installed would warn
 * falsely.
 */
const warningResolvers = new WeakMap<object, () => Set<Persistent>>();

/**
 * Resolve a list of reset scope entries into a flat set of persistent refs.
 * Module IDs are resolved via the persistent ref registry (including nested
 * contexts); `onUnknown` hears each id with no registered context.
 * ScopedReset objects contribute their own resolved scope, and with
 * `onUnknown` given, warn about their own unknown ids.
 */
function resolveScope(
  modules: ResetScope[],
  onUnknown?: (moduleId: string) => void,
): Set<Persistent> {
  const result = new Set<Persistent>();
  for (const entry of modules) {
    if (typeof entry === 'string') {
      if (onUnknown && getPersistentRefs(entry) === undefined) onUnknown(entry);
      for (const ref of getPersistentContextRefs(entry)) result.add(ref);
    } else {
      // A Cycle's scope is its `reset`'s, so it warns through that entry.
      const inner = (entry as { reset?: object }).reset;
      const resolveWarning =
        onUnknown && (warningResolvers.get(entry) ?? (inner && warningResolvers.get(inner)));
      for (const ref of resolveWarning ? resolveWarning() : entry.resolvedScope) result.add(ref);
    }
  }
  return result;
}

/**
 * Create a reset mechanic.
 *
 * Supports two scoping modes (can be combined):
 * - **`thingsToReset`** — manual list of objects/refs, reset via recursive walking
 * - **`resetPersistentContexts`** — module IDs and/or other Reset/Cycle objects, resolved
 *   via the persistent ref registry
 *
 * Inline `keep`/`retain` options provide retention without a separate
 * {@link createRetentionPolicy} call.
 *
 * @param options - Configuration for the reset (scope, retention, hooks)
 * @returns A Reset object with `resolvedScope` for composable nesting
 *
 * @example
 * ```ts
 * // Module-scoped with retention:
 * const prestigeReset = createReset({
 *   resetPersistentContexts: ['gathering', 'economy'],
 *   keep: [lifetimeBonus],
 *   retain: new Map([[skillLevel, fractional(0.1)]]),
 * })
 *
 * function prestige() {
 *   const earned = pending.value // read before the reset zeroes its inputs
 *   if (!prestigeReset.reset()) return
 *   // Granted after reset() returns, so it counts toward cumulative / best
 *   prestigePoints.value = Decimal.add(prestigePoints.value, earned)
 * }
 *
 * // Composable:
 * const outerReset = createReset({
 *   resetPersistentContexts: [prestigeReset, 'prestige'],
 * })
 *
 * // Manual mode:
 * const manualReset = createReset({
 *   thingsToReset: [points, upgrades],
 * })
 * ```
 */
export function createReset(options: ResetOptions): Reset {
  const { thingsToReset, resetPersistentContexts, keep, retain, canReset, onBeforeReset, onReset } =
    options;

  const processedThingsToReset = thingsToReset != null ? processGetter(thingsToReset) : undefined;
  const handle = createEmitHandle<ResetEvents>();

  // Adopted now — reset() fires post-install, when the ambient runtime is no
  // longer set.
  const ready = createPredicateResolver().adopt(canReset, true, 'createReset canReset');

  // Build retention policy if keep/retain provided
  const hasRetention = (keep && keep.length > 0) || (retain && retain.size > 0);
  const retention = hasRetention ? createRetentionPolicy({ keep, retain }) : undefined;

  const warnedModules = new Set<string>();
  function warnUnknownModule(moduleId: string): void {
    if (warnedModules.has(moduleId)) return;
    warnedModules.add(moduleId);
    console.warn(
      `createReset: resetPersistentContexts names "${moduleId}", which has no registered module ` +
        `context — nothing under that id is reset. Check the id.`,
    );
  }
  const resolveModules = bindPersistenceNamespace(
    (onUnknown?: (moduleId: string) => void): Set<Persistent> =>
      resetPersistentContexts ? resolveScope(resetPersistentContexts, onUnknown) : new Set(),
  );

  // Refs to skip during module-scoped reset (kept or retained refs)
  const retainedRefs = new Set<Persistent>([...(keep ?? []), ...(retain ? retain.keys() : [])]);

  // A reset is a snapshot → wipe → restore sequence wrapped around synchronous
  // emits and hooks, so a listener re-entering it runs a whole second sequence
  // against half-reset state: the retain transforms compose (a 10% carry-over
  // becomes 1%) and onReset fires per entry rather than per reset. Depth is
  // never meaningful here — a reset already in progress will reach the same
  // end state — so re-entry is refused rather than queued.
  let _resetting = false;

  const reset: Reset = {
    thingsToReset: processedThingsToReset,
    get resolvedScope() {
      return resolveModules();
    },
    onBeforeReset,
    onReset,
    on: handle.on,

    reset(): boolean {
      if (_resetting) return false;

      // Declarative readiness gate fires before any side-effects. Predictor /
      // UI consumers read the same Gate, so the imperative gate matches the
      // declarative projection.
      if (!ready.read()) return false;

      // Pre-reset hook
      if (onBeforeReset) {
        const result = onBeforeReset();
        if (result === false) return false;
      }

      _resetting = true;
      try {
        handle.emit('beforeReset');

        // Snapshot retained values before reset
        retention?.snapshot();

        // Load-guarded so watchers that react to player actions skip these
        // writes, hooks and listeners included.
        withLoadingSave(() => {
          // Reset via recursive object walking (legacy thingsToReset path)
          if (processedThingsToReset) {
            const things = unref(processedThingsToReset);
            for (const thing of things) {
              if (isPersistent(thing)) resetPersistent(thing);
              else resetObject(thing);
            }
          }

          // Reset via module-scoped refs
          for (const ref of resolveModules(warnUnknownModule)) {
            if (!retainedRefs.has(ref)) resetPersistent(ref);
          }

          // Restore retained values
          retention?.restore();

          // Post-reset hook
          onReset?.();

          handle.emit('afterReset');
        });

        return true;
      } finally {
        _resetting = false;
      }
    },
  };
  warningResolvers.set(reset, () => resolveModules(warnUnknownModule));

  return reset;
}

// === RESET IMPLEMENTATION ===

/**
 * Recursively reset the persistent refs in an object tree, skipping lifetime
 * refs.
 *
 * Supports the {@link Resettable} protocol: objects implementing
 * `[Resettable]()` yield their resettable contents for recursive walking.
 * A `WeakSet` visited guard prevents cycles (e.g. if a yielded item
 * references the container).
 */
function resetObject(obj: unknown, visited?: WeakSet<object>): void {
  if (obj == null || typeof obj !== 'object') return;

  // Skip Decimal and Formula instances
  if (obj instanceof Decimal) return;
  if (isFormula(obj)) return;

  // Check for skip flag
  if (SkipPersistence in obj && (obj as Record<symbol, unknown>)[SkipPersistence] === true) {
    return;
  }

  // If it's a persistent ref, reset it
  if (isPersistent(obj)) {
    if (!obj[Lifetime]) resetPersistent(obj);
    return;
  }

  // If it's a regular ref, don't recurse into it
  if (isRef(obj)) return;

  // Cycle guard — lazy init so the common flat-array path pays nothing
  visited ??= new WeakSet();
  if (visited.has(obj)) return;
  visited.add(obj);

  // Resettable protocol — categories, collections, etc.
  if (Resettable in obj) {
    for (const item of (obj as { [Resettable](): Iterable<unknown> })[Resettable]()) {
      resetObject(item, visited);
    }
    return;
  }

  // If it's a Map, iterate values (Object.values doesn't enumerate Map entries)
  if (obj instanceof Map) {
    for (const value of obj.values()) {
      resetObject(value, visited);
    }
    return;
  }

  // Recurse into object properties
  for (const value of Object.values(obj)) {
    resetObject(value, visited);
  }
}

// === RESET TIME TRACKING ===

/**
 * Create a reset-zeroed elapsed-time ref. Subscribes to the reset's
 * `afterReset` event and zeroes the ref each time it fires; the consumer is
 * responsible for advancing the ref each tick (`elapsed.value += dt`).
 *
 * Session-only: the ref isn't persisted, so it restarts at 0 on every load.
 * For a "time this prestige" that survives reloads, keep a `persistent(0)`
 * in the module and zero it from the reset's `afterReset` yourself. The
 * subscription lasts as long as the reset; build one timer per reset, not
 * one per view.
 *
 * @param reset - The reset whose `afterReset` event zeroes the timer
 * @returns A ref tracking seconds since the last reset
 */
export function createResetTimer(reset: Reset): Ref<number> {
  const resetTime = ref(0);

  reset.on('afterReset', () => {
    resetTime.value = 0;
  });

  return resetTime;
}

// === TYPE GUARDS ===

/**
 * Check if a value is a Vue ref
 */
function isRef(value: unknown): value is Ref {
  return value != null && typeof value === 'object' && '__v_isRef' in value;
}
