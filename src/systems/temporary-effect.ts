/**
 * Temporary Effect System — timed effects with modifier integration
 *
 * Manages time-limited effects (buffs, debuffs, DoTs, status effects, power-ups).
 * Register definitions at startup, activate instances at runtime. Each instance
 * counts down per tick, applies modifiers while active, and auto-cleans up on expiry.
 *
 * Key features:
 * - Stacking: independent timers or duration refresh per definition
 * - Modifier integration: binds to `ModifierChain`s while active, auto-removes on expiry
 * - Query surface: reactive `isActive` / `activeCount`, tag-based filtering
 * - Persistence: summary-based save; every load and reset rebuilds the live instances
 * - Events: applied, expired, dispelled
 *
 * Interactions between effects (e.g., "if Burn and Frost both active, trigger Steam")
 * are intentionally consumer-side. The system provides queries; consumers wire logic.
 *
 * @see ./persistent-effect for predicate-driven effects (active while a condition holds, no timer)
 *
 * @example
 * ```ts
 * const effects = createTemporaryEffectSystem({
 *   id: 'echoes',
 *   registerTick: gameLoop.onTick,
 * });
 *
 * effects.register({
 *   id: 'burn',
 *   duration: 4,
 *   tags: ['echo', 'flame'],
 *   modifiers: [{ chain: damageChain, mult: 1.5, description: 'Burn' }],
 *   onTick: (inst, dt) => dealDamage(10 * dt),
 *   onExpire: () => clearBurnVisuals(),
 * });
 *
 * const inst = effects.apply('burn'); // starts 4s countdown
 * effects.isActive('burn').value;     // true
 * ```
 *
 * @cluster effects
 */

import {
  computed,
  effectScope,
  isRef,
  onScopeDispose,
  ref,
  shallowRef,
  type ComputedRef,
  type Ref,
} from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { resolveComputable, type Computable } from '@/core/computed';
import { onHydrated, persistent, withPersistentContext } from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { getCurrentEffectSystemRegistry } from '@/core/registries';
import { attachContextReset } from '@/core/resettable';
import type { RegisterTick } from '@/core/sequencer';
import type { Grant } from '@/core/modifier';
import { createPredicateResolver } from './gate';
import { createBindingSlots, registerBindingSlots, type BindingSlots } from './binding-slots';

// === TYPES ===

/** Definition for a temporary effect, registered at startup. */
export interface TemporaryEffectDef {
  id: string;
  name?: string;
  /**
   * Base duration in seconds. Can be reactive for dynamic durations. Must be
   * finite: `register` and `apply` throw otherwise, since the saved
   * countdown cannot hold `Infinity`. Use a persistent-effect system for an
   * effect that lasts until removed.
   */
  duration: Computable<DecimalSource>;
  /** Maximum concurrent instances of this effect. Default: 1 */
  maxStacks?: number;
  /**
   * How additional applications behave when an instance already exists.
   * - `'independent'`: each apply creates a new instance with its own timer (up to maxStacks)
   * - `'refresh'`: resets the existing instance's duration instead of creating a new one
   *
   * Default: `'independent'`
   */
  stackBehavior?: 'independent' | 'refresh';
  /** Tags for query filtering (e.g., `['echo', 'flame']`) */
  tags?: string[];
  /**
   * Grants to bind while this effect is active — the `grants` vocabulary,
   * with `when` ANDed onto the effect's own lifetime. Can be a static array
   * or a factory evaluated at each `apply()` — use a factory when bindings
   * depend on runtime state (e.g., which chain to target). The shorthands
   * build a fresh modifier per stack; a hand-built `modifier` must be a
   * factory when `maxStacks > 1`.
   *
   * Each binding evaluates at a fixed place in its chain, whatever order
   * effects are applied in: a static array claims its places at `register`,
   * a factory on its first apply. Stacks of one def sit together there, in
   * apply order.
   */
  modifiers?: Grant[] | (() => Grant[]);
  /** Called when the effect is applied */
  onApply?: (instance: TemporaryEffectInstance) => void;
  /** Called every tick while the effect is active */
  onTick?: (instance: TemporaryEffectInstance, dt: number) => void;
  /** Called when the effect expires naturally or is dispelled */
  onExpire?: (instance: TemporaryEffectInstance) => void;
  /**
   * Called instead of onApply for each instance a load rebuilds from the
   * save. Falls back to onApply if not defined.
   */
  onRehydrate?: (instance: TemporaryEffectInstance) => void;
}

/** A live instance of a temporary effect, created by {@link TemporaryEffectSystem.apply}. */
export interface TemporaryEffectInstance {
  /** Unique instance identifier (`${defId}:${counter}`) */
  readonly id: string;
  /** The definition this instance was created from */
  readonly defId: string;
  /** Seconds remaining. Reactive — decreases every tick. */
  readonly timeRemaining: Ref<number>;
  /** The duration of the current application: resolved at apply, re-resolved by a refresh, kept through a save */
  readonly duration: number;
  /**
   * Stack slot (0-based) among live instances of the same def: the lowest
   * index no other live stack holds when this one was applied, so a slot a
   * stack frees is reused. Not saved; a load reassigns slots from 0.
   */
  readonly stackIndex: number;
  /** End this instance now, the way expiry does: fires onExpire and `expired`, then unbinds its modifiers */
  expire(): void;
}

/** Events emitted by the temporary effect system */
export interface TemporaryEffectEvents {
  /** Fired when an effect instance is applied */
  applied: (instance: TemporaryEffectInstance) => void;
  /** Fired when an effect instance expires or is ended early */
  expired: (instance: TemporaryEffectInstance) => void;
  /** Fired when all instances of a def are dispelled */
  dispelled: (defId: string) => void;
}

/** Options for {@link createTemporaryEffectSystem} */
export interface TemporaryEffectSystemOptions {
  /** Unique identifier for persistence scoping */
  id: string;
  /** Tick registration function (typically `gameLoop.onTick`) */
  registerTick: RegisterTick;
}

/** Manages temporary effects: registration, activation, tick countdown, and cleanup. */
export interface TemporaryEffectSystem {
  /** System identifier (from {@link TemporaryEffectSystemOptions.id}) */
  readonly id: string;
  /** Kind tag used by the effect-system registry / picker discovery */
  readonly kind: 'temporary';
  /** Register one or more effect definitions. Throws on an id already registered. */
  register(def: TemporaryEffectDef | TemporaryEffectDef[]): void;
  /** Get a registered definition by ID */
  getDef(id: string): TemporaryEffectDef | undefined;
  /** Snapshot of every registered definition in insertion order. */
  allDefs(): readonly TemporaryEffectDef[];
  /** Activate an effect. Returns the instance, or null if at max stacks. */
  apply(defId: string): TemporaryEffectInstance | null;
  /** Remove all active instances of a definition */
  dispel(defId: string): void;
  /** Remove all active instances of all definitions */
  dispelAll(): void;
  /** Whether any instance of the given def is active (reactive) */
  isActive(defId: string): ComputedRef<boolean>;
  /** How many instances of the given def are active (reactive) */
  activeCount(defId: string): ComputedRef<number>;
  /** All currently active instances, as a fresh array each call (reactive) */
  getActive(): TemporaryEffectInstance[];
  /** Active instances whose def has the given tag (reactive) */
  getByTag(tag: string): TemporaryEffectInstance[];
  /** Subscribe to system events */
  on: Emittable<TemporaryEffectEvents>['on'];
  /**
   * Stop ticking and drop the live instances without firing events. The saved
   * instances stay registered and keep saving, so building the system under
   * the same id again takes a new engine.
   */
  dispose(): void;
}

// === PERSISTENCE SNAPSHOT SHAPE ===

interface EffectSnapshot {
  defId: string;
  timeRemaining: number;
  /** The duration applied; absent from saves written before it was recorded. */
  duration?: number;
}

// === PRIVATE BUILDERS ===

/** A duration in seconds, or a throw when the save's JSON could not hold it. */
function toFiniteDuration(defId: string, duration: DecimalSource): number {
  const seconds = new Decimal(duration).toNumber();
  if (!Number.isFinite(seconds)) {
    throw new Error(
      `TemporaryEffect '${defId}': duration must be finite, got ${String(duration)}. ` +
        `An effect that lasts until removed belongs in a persistent-effect system.`,
    );
  }
  return seconds;
}

// === FACTORIES ===

/**
 * Create a temporary effect system for managing time-limited effects.
 *
 * @param options - System ID (for persistence scoping) and tick registration function
 * @returns A {@link TemporaryEffectSystem} for registering, activating, and querying timed effects
 *
 * @example
 * ```ts
 * const effects = createTemporaryEffectSystem({
 *   id: 'buffs',
 *   registerTick: gameLoop.onTick,
 * });
 *
 * effects.register({
 *   id: 'haste',
 *   duration: 10,
 *   modifiers: [{ chain: speedChain, mult: 1.5, description: 'Haste' }],
 * });
 *
 * effects.apply('haste'); // +50% speed for 10 seconds
 * ```
 */
export function createTemporaryEffectSystem(
  options: TemporaryEffectSystemOptions,
): TemporaryEffectSystem {
  const defs = new Map<string, TemporaryEffectDef>();
  const slotsByDef = new Map<string, BindingSlots>();
  const predicates = createPredicateResolver();
  const instances = shallowRef<TemporaryEffectInstance[]>([]);
  /** Live instance id → the function that unbinds its modifiers. */
  const unbindByInstance = new Map<string, () => void>();
  const handle = createEmitHandle<TemporaryEffectEvents>();
  let instanceCounter = 0;

  // Persistence
  const contextId = `temp-effect:${options.id}`;
  const savedState = withPersistentContext(contextId, () =>
    persistent<EffectSnapshot[]>([], { name: 'savedState' }),
  );
  /** The array `syncSavedState` last wrote, so a hydration that left it alone is skipped. */
  let lastSynced = savedState.value;

  // --------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------

  function resolveDuration(def: TemporaryEffectDef): number {
    return toFiniteDuration(def.id, resolveComputable(def.duration));
  }

  function lowestFreeStackIndex(defId: string): number {
    const taken = new Set(
      instances.value.filter((i) => i.defId === defId).map((i) => i.stackIndex),
    );
    let index = 0;
    while (taken.has(index)) index++;
    return index;
  }

  function syncSavedState(): void {
    savedState.value = instances.value.map((i) => ({
      defId: i.defId,
      timeRemaining: i.timeRemaining.value,
      duration: i.duration,
    }));
    lastSynced = savedState.value;
  }

  function createInstance(
    def: TemporaryEffectDef,
    duration: number,
    timeRemaining: number,
    stackIndex: number,
  ): TemporaryEffectInstance {
    const id = `${def.id}:${instanceCounter++}`;
    const timeRef = ref(timeRemaining);

    const instance: TemporaryEffectInstance = {
      id,
      defId: def.id,
      timeRemaining: timeRef,
      duration,
      stackIndex,
      expire() {
        if (!unbindByInstance.has(id)) return;
        expireInstance(instance);
        syncSavedState();
      },
    };

    unbindByInstance.set(id, slotsByDef.get(def.id)!.bind());

    instances.value = [...instances.value, instance];

    return instance;
  }

  /** End a live instance the way expiry does: onExpire, `expired`, then cleanup. */
  function expireInstance(instance: TemporaryEffectInstance): void {
    defs.get(instance.defId)?.onExpire?.(instance);
    handle.emit('expired', instance);
    removeInstance(instance);
  }

  function unbindInstance(instance: TemporaryEffectInstance): void {
    unbindByInstance.get(instance.id)?.();
    unbindByInstance.delete(instance.id);
  }

  function removeInstance(instance: TemporaryEffectInstance): void {
    unbindInstance(instance);
    instances.value = instances.value.filter((i) => i.id !== instance.id);
  }

  // --------------------------------------------------------------------
  // Tick
  // --------------------------------------------------------------------

  function tickAll(dt: number): void {
    const snapshot = [...instances.value];
    let anyExpired = false;

    for (const instance of snapshot) {
      const def = defs.get(instance.defId);
      if (!def) continue;

      def.onTick?.(instance, dt);
      instance.timeRemaining.value = Math.max(0, instance.timeRemaining.value - dt);

      if (instance.timeRemaining.value <= 0) {
        expireInstance(instance);
        anyExpired = true;
      }
    }

    if (anyExpired || snapshot.length > 0) {
      syncSavedState();
    }
  }

  // --------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------

  function register(def: TemporaryEffectDef | TemporaryEffectDef[]): void {
    const list = Array.isArray(def) ? def : [def];
    for (const d of list) {
      if (defs.has(d.id)) {
        throw new Error(`TemporaryEffect: duplicate definition '${d.id}'`);
      }
      if (typeof d.duration !== 'function' && !isRef(d.duration)) {
        toFiniteDuration(d.id, d.duration);
      }
      const maxStacks = d.maxStacks ?? 1;
      if (maxStacks > 1 && d.modifiers && typeof d.modifiers !== 'function') {
        for (const grant of d.modifiers) {
          if ('modifier' in grant && typeof grant.modifier !== 'function') {
            throw new Error(
              `TemporaryEffect '${d.id}': modifier bindings must be factories (functions) when maxStacks > 1`,
            );
          }
        }
      }
      const slots = createBindingSlots(d.modifiers, predicates, `temporary effect '${d.id}'`);
      defs.set(d.id, d);
      slotsByDef.set(d.id, slots);
    }
  }

  function getDef(id: string): TemporaryEffectDef | undefined {
    return defs.get(id);
  }

  function allDefs(): readonly TemporaryEffectDef[] {
    return Array.from(defs.values());
  }

  function apply(defId: string): TemporaryEffectInstance | null {
    const def = defs.get(defId);
    if (!def) throw new Error(`TemporaryEffect: unknown definition '${defId}'`);

    const maxStacks = def.maxStacks ?? 1;
    const behavior = def.stackBehavior ?? 'independent';
    const currentCount = instances.value.filter((i) => i.defId === defId).length;
    const dur = resolveDuration(def);

    if (behavior === 'refresh' && currentCount > 0) {
      const existing = instances.value.find((i) => i.defId === defId)!;
      (existing as { duration: number }).duration = dur;
      existing.timeRemaining.value = dur;
      def.onApply?.(existing);
      handle.emit('applied', existing);
      syncSavedState();
      return existing;
    }

    if (currentCount >= maxStacks) return null;

    const instance = createInstance(def, dur, dur, lowestFreeStackIndex(defId));
    def.onApply?.(instance);
    handle.emit('applied', instance);
    syncSavedState();
    return instance;
  }

  function dispel(defId: string): void {
    const toRemove = instances.value.filter((i) => i.defId === defId);
    for (const instance of toRemove) expireInstance(instance);
    if (toRemove.length > 0) {
      handle.emit('dispelled', defId);
      syncSavedState();
    }
  }

  function dispelAll(): void {
    for (const instance of [...instances.value]) expireInstance(instance);
    syncSavedState();
  }

  function isActive(defId: string): ComputedRef<boolean> {
    return computed(() => instances.value.some((i) => i.defId === defId));
  }

  function activeCount(defId: string): ComputedRef<number> {
    return computed(() => instances.value.filter((i) => i.defId === defId).length);
  }

  function getActive(): TemporaryEffectInstance[] {
    return [...instances.value];
  }

  function getByTag(tag: string): TemporaryEffectInstance[] {
    return instances.value.filter((i) => {
      const def = defs.get(i.defId);
      return def?.tags?.includes(tag) ?? false;
    });
  }

  /** Replace the live instances with the saved ones, firing no expiry. */
  function rehydrate(): void {
    lastSynced = savedState.value;
    for (const instance of instances.value) unbindInstance(instance);
    instances.value = [];

    for (const snap of savedState.value) {
      const def = defs.get(snap.defId);
      if (!def) continue; // definition removed between versions
      const dur = snap.duration ?? Math.max(resolveDuration(def), snap.timeRemaining);
      const instance = createInstance(
        def,
        dur,
        snap.timeRemaining,
        lowestFreeStackIndex(snap.defId),
      );
      (def.onRehydrate ?? def.onApply)?.(instance);
    }
  }

  const scope = effectScope();
  scope.run(() => {
    onScopeDispose(options.registerTick(tickAll));
    // Every engine's load and reset settles through here, so rebuild only when
    // the saved array is no longer the one this system wrote.
    onHydrated(() => {
      if (savedState.value !== lastSynced) rehydrate();
    });
  });

  function dispose(): void {
    scope.stop();
    // Clean up all instances without firing events; releasing the slots unbinds them,
    // and an instance's expire() returns early once its handle is gone.
    unbindByInstance.clear();
    instances.value = [];
    for (const slots of slotsByDef.values()) slots.release();
    slotsByDef.clear();
  }

  const system: TemporaryEffectSystem = {
    id: options.id,
    kind: 'temporary',
    register,
    getDef,
    allDefs,
    apply,
    dispel,
    dispelAll,
    isActive,
    activeCount,
    getActive,
    getByTag,
    on: handle.on,
    dispose,
  };

  // Auto-register into the per-engine effect-system registry if this
  // factory is running inside withEffectSystemRegistry(...) — i.e., during
  // a module's install() or connect() phase. Systems constructed outside
  // an engine (tests, throwaway scripts) silently skip registration.
  getCurrentEffectSystemRegistry()?.register(system);
  registerBindingSlots(system, (defId) => slotsByDef.get(defId));

  return attachContextReset(system, contextId);
}
