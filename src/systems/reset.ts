/**
 * Reset system — prestige and layer mechanics
 *
 * A Reset zeroes a configurable scope of persistent refs back to their
 * default values, with optional retention transforms for refs that should
 * survive (or partially survive) the reset. Scope can be defined manually
 * (a list of objects to walk) or by module ID (resolved via the persistent
 * ref registry), and Reset objects compose — one Reset's resolved scope can
 * feed another's `resetModules`.
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
  DefaultValue,
  SkipPersistence,
  type Persistent,
  cloneDefault,
  isPersistent,
  loadingSave,
  getModulePersistentRefs,
} from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { isFormula } from '@/core/formulas';
import { Resettable } from './resettable';
import { createRetentionPolicy } from './retention';
import { evaluateGate, getAmbientGateRuntime, type Gate, type GateRuntime } from './gate';

// === TYPES ===

/**
 * Any object exposing a resolved set of persistent refs for composable reset
 * scope. Both {@link Reset} and Loop implement this — using a structural type
 * avoids circular imports between reset.ts and loop.ts.
 */
export interface ScopedReset {
  readonly resolvedScope: ReadonlySet<Persistent>;
}

/**
 * A reset scope entry: either a module ID (string) resolved via the persistent
 * ref registry, or another Reset/Loop whose resolved scope is unioned in.
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
   *
   * Optional when {@link resetModules} is provided.
   */
  thingsToReset?: Computable<unknown[]>;

  /**
   * Module-scoped reset: declare which modules to reset by ID, or compose
   * with other Reset/Loop objects to inherit their scope. The engine resolves
   * each module ID to all persistent refs created during that module's
   * install/connect phase (including nested category/definition contexts).
   *
   * @example
   * ```ts
   * resetModules: ['jobs', 'skills', 'economy']
   * resetModules: [innerReset, 'rebirth']  // composable
   * ```
   */
  resetModules?: ResetScope[];

  /**
   * Declarative readiness gate. When supplied, {@link Reset.reset} returns
   * `false` without performing the reset whenever this Gate evaluates falsy —
   * matches the existing `onBeforeReset: () => false` cancellation contract,
   * but visible to the predictor and to UI hints (call
   * `timeUntilGateFlip(canReset, runtime)` for "time-until-prestige-ready").
   *
   * Evaluated through the ambient {@link GateRuntime} captured at
   * `createReset` time. Omit to default to "always allowed" (no gate).
   *
   * Order of cancellation checks at `reset()`:
   * 1. `canReset` (if supplied) — short-circuits if falsy
   * 2. `onBeforeReset` (if supplied) — short-circuits if it returns `false`
   *
   * Both are opt-in and either can cancel; `canReset` is for declarative /
   * predictor visibility, `onBeforeReset` is for imperative side-effects
   * that may also want to veto.
   */
  canReset?: Gate;

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
   * Called after the reset completes.
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
   * The flattened set of persistent refs resolved from {@link ResetOptions.resetModules}.
   * Empty when only `thingsToReset` is used. Exposed so other resets/loops can
   * compose with this reset's scope via `resetModules: [thisReset]`.
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
  /** Fired after this reset completes */
  afterReset: () => void;
}

// === RESET CREATION ===

/**
 * Resolve a list of reset scope entries into a flat set of persistent refs.
 * Module IDs are resolved via the persistent ref registry (including nested
 * contexts). ScopedReset objects contribute their already-resolved scope.
 */
function resolveScope(modules: ResetScope[]): Set<Persistent> {
  const result = new Set<Persistent>();
  for (const entry of modules) {
    if (typeof entry === 'string') {
      for (const ref of getModulePersistentRefs(entry)) result.add(ref);
    } else {
      for (const ref of entry.resolvedScope) result.add(ref);
    }
  }
  return result;
}

/**
 * Create a reset mechanic.
 *
 * Supports two scoping modes (can be combined):
 * - **`thingsToReset`** — manual list of objects/refs, reset via recursive walking
 * - **`resetModules`** — module IDs and/or other Reset/Loop objects, resolved
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
 *   resetModules: ['gathering', 'economy'],
 *   keep: [permanentBonus],
 *   retain: new Map([[skillLevel, fractional(0.1)]]),
 *   onReset: () => { prestigePoints.value = Decimal.add(prestigePoints.value, pending.value) }
 * })
 *
 * // Composable:
 * const outerReset = createReset({
 *   resetModules: [prestigeReset, 'prestige'],
 * })
 *
 * // Legacy manual mode still works:
 * const manualReset = createReset({
 *   thingsToReset: [points, upgrades],
 * })
 * ```
 */
export function createReset<T extends ResetOptions>(options: T): Reset {
  const { thingsToReset, resetModules, keep, retain, canReset, onBeforeReset, onReset } = options;

  const processedThingsToReset = thingsToReset != null ? processGetter(thingsToReset) : undefined;
  const scope = resetModules ? resolveScope(resetModules) : new Set<Persistent>();
  const handle = createEmitHandle<ResetEvents>();

  // Capture the GateRuntime eagerly when canReset is supplied — reset() fires
  // post-install when the ambient triple is no longer set, so we resolve once
  // here (typically inside an engine install/connect call) and close over it.
  const canResetRuntime: GateRuntime | undefined =
    canReset !== undefined ? getAmbientGateRuntime() : undefined;

  // Build retention policy if keep/retain provided
  const hasRetention = (keep && keep.length > 0) || (retain && retain.size > 0);
  const retention = hasRetention ? createRetentionPolicy({ keep, retain }) : undefined;

  // Refs to skip during module-scoped reset (kept or retained refs)
  const retainedRefs = new Set<Persistent>([...(keep ?? []), ...(retain ? retain.keys() : [])]);

  const reset: Reset = {
    thingsToReset: processedThingsToReset,
    resolvedScope: scope,
    onBeforeReset,
    onReset,
    on: handle.on,

    reset(): boolean {
      // Declarative readiness gate fires before any side-effects. Predictor /
      // UI consumers read the same Gate, so the imperative gate matches the
      // declarative projection.
      if (canReset !== undefined && !evaluateGate(canReset, canResetRuntime!)) {
        return false;
      }

      // Pre-reset hook
      if (onBeforeReset) {
        const result = onBeforeReset();
        if (result === false) return false;
      }

      handle.emit('beforeReset');

      // Snapshot retained values before reset
      retention?.snapshot();

      // Set loading flag to prevent watchers from triggering
      loadingSave.value = true;

      try {
        // Reset via recursive object walking (legacy thingsToReset path)
        if (processedThingsToReset) {
          const things = unref(processedThingsToReset);
          for (const thing of things) {
            resetObject(thing);
          }
        }

        // Reset via module-scoped refs
        for (const ref of scope) {
          if (retainedRefs.has(ref)) continue;
          if (DefaultValue in ref) {
            ref.value = ref[DefaultValue];
          }
        }

        // Restore retained values
        retention?.restore();

        // Post-reset hook
        onReset?.();

        handle.emit('afterReset');

        return true;
      } finally {
        loadingSave.value = false;
      }
    },
  };

  return reset;
}

// === RESET IMPLEMENTATION ===

/**
 * Recursively reset all persistent refs in an object tree.
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
    const p = obj as Persistent;
    if (DefaultValue in p) {
      p.value = cloneDefault(p[DefaultValue]);
    }
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
