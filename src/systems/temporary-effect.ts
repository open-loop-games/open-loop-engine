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
 * - Persistence: summary-based save/load with explicit `restore()` for reconstruction
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
 *   modifiers: [{ chain: damageChain, modifier: () => createMultiplicativeModifier({ multiplier: 1.5 }) }],
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

import { computed, ref, shallowRef, unref, type ComputedRef, type Ref } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { processGetter, type Computable } from '@/core/computed';
import { persistent, withPersistentContext } from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { getCurrentEffectSystemRegistry } from '@/core/registries';
import type { Modifier } from '@/core/modifier';
import type { RegisterTick } from '@/core/sequencer';
import type { ModifierBinding } from './modifier-binding';

// === TYPES ===

/** Definition for a temporary effect, registered at startup. */
export interface TemporaryEffectDef {
  id: string;
  name?: string;
  /** Base duration in seconds. Can be reactive for dynamic durations. */
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
   * Modifiers to bind to chains while this effect is active.
   * Can be a static array or a factory evaluated at each `apply()` — use a factory
   * when bindings depend on runtime state (e.g., which chain to target).
   */
  modifiers?: ModifierBinding[] | (() => ModifierBinding[]);
  /** Called when the effect is applied */
  onApply?: (instance: TemporaryEffectInstance) => void;
  /** Called every tick while the effect is active */
  onTick?: (instance: TemporaryEffectInstance, dt: number) => void;
  /** Called when the effect expires naturally or is dispelled */
  onExpire?: (instance: TemporaryEffectInstance) => void;
  /** Called instead of onApply when reconstructing from a save. Falls back to onApply if not defined. */
  onRestore?: (instance: TemporaryEffectInstance) => void;
}

/** A live instance of a temporary effect, created by {@link TemporaryEffectSystem.apply}. */
export interface TemporaryEffectInstance {
  /** Unique instance identifier (`${defId}:${counter}`) */
  readonly id: string;
  /** The definition this instance was created from */
  readonly defId: string;
  /** Seconds remaining. Reactive — decreases every tick. */
  readonly timeRemaining: Ref<number>;
  /** The duration this instance was created with (snapshot at apply time) */
  readonly duration: number;
  /** Stack index (0-based) among active instances of the same def */
  readonly stackIndex: number;
  /** Remove this instance early (cleans up modifiers, fires onExpire) */
  dispose(): void;
}

/** Events emitted by the temporary effect system */
export interface TemporaryEffectEvents {
  /** Fired when an effect instance is applied */
  applied: (instance: TemporaryEffectInstance) => void;
  /** Fired when an effect instance expires or is disposed */
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
  /** Register one or more effect definitions */
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
  /** All currently active instances (snapshot copy) */
  getActive(): TemporaryEffectInstance[];
  /** Active instances whose def has the given tag */
  getByTag(tag: string): TemporaryEffectInstance[];
  /** Reconstruct active instances from saved state. Call after save load. */
  restore(): void;
  /** Subscribe to system events */
  on: Emittable<TemporaryEffectEvents>['on'];
  /** Unsubscribe tick and clean up all instances */
  dispose(): void;
}

// === PERSISTENCE SNAPSHOT SHAPE ===

interface EffectSnapshot {
  defId: string;
  timeRemaining: number;
}

// === INTERNAL CLEANUP TRACKING ===

interface InstanceCleanup {
  modifierRemovers: (() => void)[];
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
 *   modifiers: [{ chain: speedChain, modifier: createMultiplicativeModifier({ multiplier: 1.5 }) }],
 * });
 *
 * effects.apply('haste'); // +50% speed for 10 seconds
 * ```
 */
export function createTemporaryEffectSystem(
  options: TemporaryEffectSystemOptions,
): TemporaryEffectSystem {
  const defs = new Map<string, TemporaryEffectDef>();
  const instances = shallowRef<TemporaryEffectInstance[]>([]);
  const cleanupMap = new Map<string, InstanceCleanup>();
  const handle = createEmitHandle<TemporaryEffectEvents>();
  let instanceCounter = 0;

  // Persistence
  const savedState = withPersistentContext(`temp-effect:${options.id}`, () =>
    persistent<EffectSnapshot[]>([], { name: 'savedState' }),
  );

  // --------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------

  function resolveDuration(def: TemporaryEffectDef): number {
    return new Decimal(unref(processGetter(def.duration))).toNumber();
  }

  function resolveModifier(binding: ModifierBinding): Modifier {
    return typeof binding.modifier === 'function' ? binding.modifier() : binding.modifier;
  }

  function syncSavedState(): void {
    savedState.value = instances.value.map((i) => ({
      defId: i.defId,
      timeRemaining: i.timeRemaining.value,
    }));
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
      dispose() {
        removeInstance(instance);
      },
    };

    const modifierRemovers: (() => void)[] = [];
    const bindings = typeof def.modifiers === 'function' ? def.modifiers() : def.modifiers;
    if (bindings) {
      for (const binding of bindings) {
        const modifier = resolveModifier(binding);
        modifierRemovers.push(binding.chain.add(modifier));
      }
    }
    cleanupMap.set(id, { modifierRemovers });

    instances.value = [...instances.value, instance];

    return instance;
  }

  function removeInstance(instance: TemporaryEffectInstance): void {
    const cleanup = cleanupMap.get(instance.id);
    if (cleanup) {
      for (const remover of cleanup.modifierRemovers) remover();
      cleanupMap.delete(instance.id);
    }
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
        def.onExpire?.(instance);
        handle.emit('expired', instance);
        removeInstance(instance);
        anyExpired = true;
      }
    }

    if (anyExpired || snapshot.length > 0) {
      syncSavedState();
    }
  }

  const unsubscribeTick = options.registerTick(tickAll);

  // --------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------

  function register(def: TemporaryEffectDef | TemporaryEffectDef[]): void {
    const list = Array.isArray(def) ? def : [def];
    for (const d of list) {
      const maxStacks = d.maxStacks ?? 1;
      if (maxStacks > 1 && d.modifiers && typeof d.modifiers !== 'function') {
        for (const binding of d.modifiers) {
          if (typeof binding.modifier !== 'function') {
            throw new Error(
              `TemporaryEffect '${d.id}': modifier bindings must be factories (functions) when maxStacks > 1`,
            );
          }
        }
      }
      defs.set(d.id, d);
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
      existing.timeRemaining.value = dur;
      def.onApply?.(existing);
      handle.emit('applied', existing);
      syncSavedState();
      return existing;
    }

    if (currentCount >= maxStacks) return null;

    const instance = createInstance(def, dur, dur, currentCount);
    def.onApply?.(instance);
    handle.emit('applied', instance);
    syncSavedState();
    return instance;
  }

  function dispel(defId: string): void {
    const toRemove = instances.value.filter((i) => i.defId === defId);
    for (const instance of toRemove) {
      const def = defs.get(instance.defId);
      def?.onExpire?.(instance);
      handle.emit('expired', instance);
      removeInstance(instance);
    }
    if (toRemove.length > 0) {
      handle.emit('dispelled', defId);
      syncSavedState();
    }
  }

  function dispelAll(): void {
    const all = [...instances.value];
    for (const instance of all) {
      const def = defs.get(instance.defId);
      def?.onExpire?.(instance);
      handle.emit('expired', instance);
      removeInstance(instance);
    }
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

  function restore(): void {
    // Clear any existing instances without firing events
    const existing = [...instances.value];
    for (const instance of existing) {
      const cleanup = cleanupMap.get(instance.id);
      if (cleanup) {
        for (const remover of cleanup.modifierRemovers) remover();
        cleanupMap.delete(instance.id);
      }
    }
    instances.value = [];

    for (const snap of savedState.value) {
      const def = defs.get(snap.defId);
      if (!def) continue; // definition removed between versions
      const dur = resolveDuration(def);
      const currentCount = instances.value.filter((i) => i.defId === snap.defId).length;
      const instance = createInstance(def, dur, snap.timeRemaining, currentCount);
      const restoreHook = def.onRestore ?? def.onApply;
      restoreHook?.(instance);
    }
  }

  function dispose(): void {
    unsubscribeTick();
    // Clean up all instances without firing events
    const all = [...instances.value];
    for (const instance of all) {
      const cleanup = cleanupMap.get(instance.id);
      if (cleanup) {
        for (const remover of cleanup.modifierRemovers) remover();
        cleanupMap.delete(instance.id);
      }
    }
    instances.value = [];
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
    restore,
    on: handle.on,
    dispose,
  };

  // Auto-register into the per-engine effect-system registry if this
  // factory is running inside withEffectSystemRegistry(...) — i.e., during
  // a module's install() or connect() phase. Systems constructed outside
  // an engine (tests, throwaway scripts) silently skip registration.
  getCurrentEffectSystemRegistry()?.register(system);

  return system;
}
