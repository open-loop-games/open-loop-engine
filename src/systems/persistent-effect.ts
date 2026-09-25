/**
 * Persistent Effect System — condition-driven effects with modifier integration
 *
 * Manages effects whose lifecycle is a pure function of game state. Register a
 * definition with an `active` predicate; when it flips `false → true` the
 * system binds the modifiers to their chains, and on `true → false` it removes
 * them. No timers, no countdown, no save-state duplication.
 *
 * Symmetric to {@link createTemporaryEffectSystem} with one swap:
 * `duration` → `active: Computable<boolean>`. Same `ModifierBinding[]` shape,
 * so the two systems are drop-in compatible for consumers migrating between
 * time-limited and condition-driven lifecycles.
 *
 * Key features:
 * - Declarative condition — bindings track a reactive predicate
 * - Automatic load reconstruction — predicate re-evaluates on rehydrate, no `restore()` needed
 * - Zero save bloat — state is implicit in the game, nothing duplicated
 *
 * For prestige-style "N copies of an effect" scaling, prefer a single reactive
 * modifier (`multiplier: computed(() => 1 + k * level.value)`) over stacked
 * instances — cleaner and doesn't need this system.
 *
 * @example
 * ```ts
 * const persistent = createPersistentEffectSystem({ id: 'constructions-effects' });
 *
 * persistent.register({
 *   id: 'belt-maxhealth',
 *   active: computed(() => constructionsCategory.getState(sid(47))?.isFinished.value ?? false),
 *   modifiers: [{
 *     chain: maxHealthChain,
 *     modifier: () => createMultiplicativeModifier({ multiplier: 4, description: 'Belt' }),
 *   }],
 * });
 * ```
 *
 * @cluster effects
 */

import { computed, watch, unref, type ComputedRef, type WatchStopHandle } from 'vue';
import { processGetter, type Computable } from '@/core/computed';
import { createEmitHandle, type Emittable } from '@/core/events';
import { getCurrentEffectSystemRegistry } from '@/core/registries';
import type { Modifier } from '@/core/modifier';
import type { ModifierBinding } from './modifier-binding';
import { createBindingSlots, type BindingSlots } from './binding-slots';

// === TYPES ===

// TODO(ergonomics): string-keyed effect dict shorthand — Kittens Game-style
// `effects: { "goldPerTick": 0.01 }` mapped to ModifierBinding[].
// Consumer-side helper first; promote to engine if two consumers converge.

/** Definition for a persistent effect, registered at startup. */
export interface PersistentEffectDef {
  id: string;
  name?: string;
  /**
   * Reactive predicate controlling whether bindings are applied.
   * System watches this: `false → true` applies bindings, `true → false` removes them.
   * When an edge flips the predicate back (an `onActivate` that spends what
   * it reads), the opposite edge follows at once. A predicate that reads a
   * value the effect's own bindings change has no stable state and throws.
   */
  active: Computable<boolean>;
  /** Tags for query filtering */
  tags?: string[];
  /**
   * Modifiers to bind to chains while `active` is true.
   * Can be a static array or a factory evaluated on each activation — use a factory
   * when bindings depend on runtime state.
   *
   * Each binding evaluates at a fixed place in its chain, however often the
   * effect toggles: a static array claims its places at `register`, a
   * factory on its first activation.
   */
  modifiers?: ModifierBinding[] | (() => ModifierBinding[]);
  /** Called on the rising edge (`false → true`), including on registration if already active */
  onActivate?: (def: PersistentEffectDef) => void;
  /** Called on the falling edge (`true → false`) */
  onDeactivate?: (def: PersistentEffectDef) => void;
}

/** Events emitted by the persistent effect system */
export interface PersistentEffectEvents {
  /** Fired on the rising edge of a def's `active` predicate */
  activated: (def: PersistentEffectDef) => void;
  /** Fired on the falling edge of a def's `active` predicate */
  deactivated: (def: PersistentEffectDef) => void;
}

/** Options for {@link createPersistentEffectSystem} */
export interface PersistentEffectSystemOptions {
  /** Unique identifier (for debugging / symmetry with temporary-effect) */
  id: string;
}

/** Manages persistent effects: registration, condition watching, and edge-triggered binding. */
export interface PersistentEffectSystem {
  /** System identifier (from {@link PersistentEffectSystemOptions.id}) */
  readonly id: string;
  /** Kind tag used by the effect-system registry / picker discovery */
  readonly kind: 'persistent';
  /** Register one or more effect definitions */
  register(def: PersistentEffectDef | PersistentEffectDef[]): void;
  /** Get a registered definition by ID */
  getDef(id: string): PersistentEffectDef | undefined;
  /** Snapshot of every registered definition in insertion order. */
  allDefs(): readonly PersistentEffectDef[];
  /** Whether the given def is currently active (reactive) */
  isActive(defId: string): ComputedRef<boolean>;
  /** All currently active definitions (snapshot copy) */
  getActive(): PersistentEffectDef[];
  /** Active definitions with the given tag */
  getByTag(tag: string): PersistentEffectDef[];
  /** Subscribe to system events */
  on: Emittable<PersistentEffectEvents>['on'];
  /** Stop all watchers and remove all bindings */
  dispose(): void;
}

// === INTERNAL TRACKING ===

interface DefEntry {
  def: PersistentEffectDef;
  activeRef: ComputedRef<boolean>;
  stopWatch: WatchStopHandle;
  slots: BindingSlots;
  modifierRemovers: (() => void)[];
  isApplied: boolean;
  /** True while {@link settle} runs this entry's edges. */
  settling: boolean;
}

// === CONSTANTS ===

/** Edges one predicate change may run before the effect is judged to feed back on itself. */
const MAX_SETTLE_EDGES = 8;

// === FACTORIES ===

/**
 * Create a persistent effect system for managing condition-driven effects.
 *
 * @param options - System ID
 * @returns A {@link PersistentEffectSystem} for registering and querying state-driven effects
 *
 * @example Basic conditional effect:
 * ```ts
 * const persistent = createPersistentEffectSystem({ id: 'buffs' });
 *
 * persistent.register({
 *   id: 'library-bonus',
 *   active: computed(() => library.isBuilt.value),
 *   modifiers: [{
 *     chain: xpChain,
 *     modifier: () => createMultiplicativeModifier({ multiplier: 2 }),
 *   }],
 * });
 * ```
 *
 * @example Per-action conditional modifiers on a surface-wide chain (the
 * idiomatic pattern for "item X boosts action Y"):
 * ```ts
 * const effects = createPersistentEffectSystem({ id: 'equipment-effects' });
 *
 * // Each registration is an affectedBy binding: "glasses boost wander progress"
 * effects.register({
 *   id: 'affected-by:wander:glasses',
 *   active: computed(() => equipment.has('glasses')),
 *   modifiers: [{
 *     chain: progressChain,  // surface-wide chain from createModifierChain
 *     modifier: () => createMultiplicativeModifier({ multiplier: 1.5 }),
 *   }],
 * });
 *
 * // Balance-sim walks the EffectSystemRegistry for full attribution:
 * const registry = engine.inject(EffectSystemRegistryKey);
 * for (const sys of registry.all()) {
 *   for (const def of sys.allDefs()) {
 *     // def.id → "affected-by:wander:glasses"
 *     // def.modifiers → [{ chain, modifier }] — full source attribution
 *   }
 * }
 * ```
 */
export function createPersistentEffectSystem(
  options: PersistentEffectSystemOptions,
): PersistentEffectSystem {
  const entries = new Map<string, DefEntry>();
  const handle = createEmitHandle<PersistentEffectEvents>();

  function resolveModifier(binding: ModifierBinding): Modifier {
    return typeof binding.modifier === 'function' ? binding.modifier() : binding.modifier;
  }

  function applyBindings(entry: DefEntry): void {
    const bindings =
      typeof entry.def.modifiers === 'function' ? entry.def.modifiers() : entry.def.modifiers;
    if (bindings) {
      for (const [index, binding] of bindings.entries()) {
        const slot = entry.slots.slotFor(index, binding.chain);
        entry.modifierRemovers.push(slot.add(resolveModifier(binding)));
      }
    }
    entry.isApplied = true;
  }

  function removeBindings(entry: DefEntry): void {
    for (const remover of entry.modifierRemovers) remover();
    entry.modifierRemovers = [];
    entry.isApplied = false;
  }

  /**
   * Run edges until the applied state matches the predicate. An edge can
   * flip the predicate itself (a hook spends what it reads); the watcher
   * call that flip triggers is swallowed by `settling`, and the loop
   * re-reads the predicate instead.
   */
  function settle(entry: DefEntry): void {
    if (entry.settling) return;
    entry.settling = true;
    try {
      for (let edges = 0; entry.activeRef.value !== entry.isApplied; edges++) {
        if (edges === MAX_SETTLE_EDGES) {
          throw new Error(
            `PersistentEffect '${entry.def.id}': 'active' keeps flipping as its own bindings ` +
              `apply and remove — the predicate reads a value its bindings change.`,
          );
        }
        const { def } = entry;
        if (entry.isApplied) {
          removeBindings(entry);
          def.onDeactivate?.(def);
          handle.emit('deactivated', def);
        } else {
          applyBindings(entry);
          def.onActivate?.(def);
          handle.emit('activated', def);
        }
      }
    } finally {
      entry.settling = false;
    }
  }

  function register(def: PersistentEffectDef | PersistentEffectDef[]): void {
    const list = Array.isArray(def) ? def : [def];
    for (const d of list) {
      if (entries.has(d.id)) {
        throw new Error(`PersistentEffect: duplicate definition '${d.id}'`);
      }

      const activeSource = processGetter(d.active);
      const activeRef = computed(() => unref(activeSource));

      const entry: DefEntry = {
        def: d,
        activeRef,
        stopWatch: () => {},
        slots: createBindingSlots(),
        modifierRemovers: [],
        isApplied: false,
        settling: false,
      };

      // Claim chain positions now, so a binding evaluates at the same place
      // whenever it activates. A factory-form list claims on first activation.
      if (Array.isArray(d.modifiers)) {
        for (const [index, binding] of d.modifiers.entries()) {
          entry.slots.slotFor(index, binding.chain);
        }
      }

      // flush: 'sync' so a predicate that flips mid-run binds/unbinds its
      // modifiers on the same synchronous step. Headless sims drive stepOnce()
      // in a tight loop with no microtask boundary, so a default (pre) flush
      // would leave the effect a step or more late. Mirrors achievement.ts /
      // automation.ts / resource-bag link watchers.
      entry.stopWatch = watch(activeRef, () => settle(entry), { immediate: true, flush: 'sync' });

      entries.set(d.id, entry);
    }
  }

  function getDef(id: string): PersistentEffectDef | undefined {
    return entries.get(id)?.def;
  }

  function allDefs(): readonly PersistentEffectDef[] {
    const out: PersistentEffectDef[] = [];
    for (const entry of entries.values()) out.push(entry.def);
    return out;
  }

  function isActive(defId: string): ComputedRef<boolean> {
    return computed(() => entries.get(defId)?.activeRef.value ?? false);
  }

  function getActive(): PersistentEffectDef[] {
    const out: PersistentEffectDef[] = [];
    for (const entry of entries.values()) {
      if (entry.isApplied) out.push(entry.def);
    }
    return out;
  }

  function getByTag(tag: string): PersistentEffectDef[] {
    return getActive().filter((d) => d.tags?.includes(tag) ?? false);
  }

  function dispose(): void {
    for (const entry of entries.values()) {
      entry.stopWatch();
      if (entry.isApplied) removeBindings(entry);
      entry.slots.release();
    }
    entries.clear();
  }

  const system: PersistentEffectSystem = {
    id: options.id,
    kind: 'persistent',
    register,
    getDef,
    allDefs,
    isActive,
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

  return system;
}
