/**
 * Conditional Effect System — predicate-driven effects with modifier integration
 *
 * Manages effects whose lifecycle is a pure function of game state. Register a
 * def with an `active` predicate. On its activation the system binds the
 * def's grants to their chains, and on its deactivation it removes them. No
 * timers, no countdown, and nothing saved twice.
 *
 * Symmetric to {@link createTemporaryEffectSystem}, with `active: Predicate`
 * in place of `duration`. Same `Grant[]` shape, so a consumer can move an
 * effect between a time-limited and a predicate-driven lifecycle unchanged.
 *
 * Key features:
 * - Declarative test — grants follow a reactive predicate
 * - Automatic hydration — the reactive predicate re-evaluates after a load
 * - Nothing saved — the effect's state follows from game state
 *
 * For prestige-style "N copies of an effect" scaling, prefer a single reactive
 * modifier (`multiplier: computed(() => 1 + k * level.value)`) over stacked
 * instances. It is cleaner, and it doesn't need this system.
 *
 * @example
 * ```ts
 * const effects = createConditionalEffectSystem({ id: 'constructions-effects' });
 *
 * effects.register({
 *   id: 'belt-maxhealth',
 *   active: computed(() => constructionsCategory.getState(sid(47))?.isFinished.value ?? false),
 *   grants: [{ chain: maxHealthChain, mult: 4, description: 'Belt' }],
 * });
 * ```
 *
 * @cluster effects
 */

import { computed, effectScope, ref, watch, type ComputedRef } from 'vue';
import { runInEffectScope } from '@/core/common';
import { createEmitHandle, type Emittable } from '@/core/events';
import { getCurrentEffectSystemRegistry } from '@/core/registries';
import type { Grant } from '@/core/modifier';
import { createPredicateResolver, type Predicate } from './gate';
import { createBindingSlots, registerBindingSlots, type BindingSlots } from './binding-slots';

// === TYPES ===

// TODO(ergonomics): string-keyed effect dict shorthand — string-keyed
// `effects: { "goldPerTick": 0.01 }` mapped to Grant[].
// Consumer-side helper first; promote to engine if two consumers converge.

/** A conditional effect's def, registered at startup. */
export interface ConditionalEffectDef {
  id: string;
  displayName?: string;
  /**
   * Reactive predicate that decides whether the grants are bound.
   * The system watches it: activation binds the grants, deactivation removes them.
   * When an activation or deactivation flips the predicate back (an
   * `onActivate` that spends what it reads), the opposite one follows at
   * once. A predicate that reads a value the effect's own grants change has
   * no stable state, and throws. A Gate is evaluated through the Gate
   * services captured when `createConditionalEffectSystem` runs.
   */
  active: Predicate;
  /** Tags for query filtering */
  tags?: string[];
  /**
   * Grants to bind while `active` holds, with each `when` ANDed onto the
   * effect's own lifecycle. Can be a static array, or a factory evaluated on
   * each activation — use a factory when the grants depend on live state.
   *
   * Each lowered grant evaluates at a fixed place in its chain, however often
   * the effect toggles. A static array claims its places at `register`, a
   * factory on its first activation.
   */
  grants?: Grant[] | (() => Grant[]);
  /** Called on activation (`false → true`), including on registration if the predicate already holds */
  onActivate?: (def: ConditionalEffectDef) => void;
  /** Called on deactivation (`true → false`) */
  onDeactivate?: (def: ConditionalEffectDef) => void;
}

/** Events emitted by the conditional effect system */
export interface ConditionalEffectEvents {
  /** Fired on the activation of a def's `active` predicate */
  activated: (def: ConditionalEffectDef) => void;
  /** Fired on the deactivation of a def's `active` predicate */
  deactivated: (def: ConditionalEffectDef) => void;
}

/** Options for {@link createConditionalEffectSystem} */
export interface ConditionalEffectSystemOptions {
  /** Unique id (for debugging, and symmetry with the temporary effect system) */
  id: string;
}

/** Manages conditional effects: registration, predicate watching, and binding on activation. */
export interface ConditionalEffectSystem {
  /** System id (from {@link ConditionalEffectSystemOptions.id}) */
  readonly id: string;
  /** The variant `kind` the effect-system registry and picker discovery read */
  readonly kind: 'conditional';
  /** Register one or more effect defs */
  register(def: ConditionalEffectDef | ConditionalEffectDef[]): void;
  /** Get a registered def by id */
  getDef(id: string): ConditionalEffectDef | undefined;
  /** Snapshot of every registered def in insertion order. */
  allDefs(): readonly ConditionalEffectDef[];
  /** Whether the given def is currently active (reactive) */
  isActive(defId: string): ComputedRef<boolean>;
  /** All currently active defs, as a fresh array each call (reactive) */
  getActive(): ConditionalEffectDef[];
  /** Active defs with the given tag (reactive) */
  getByTag(tag: string): ConditionalEffectDef[];
  /** Subscribe to system events */
  on: Emittable<ConditionalEffectEvents>['on'];
  /** Stop every watcher and unbind every grant. The system saves nothing, so nothing stays saved. */
  dispose(): void;
}

// === INTERNAL TRACKING ===

interface DefEntry {
  def: ConditionalEffectDef;
  activeRef: ComputedRef<boolean>;
  slots: BindingSlots;
  unbind: () => void;
  isApplied: boolean;
  /** True while {@link settle} activates or deactivates this entry. */
  settling: boolean;
}

// === CONSTANTS ===

/** Activations and deactivations one predicate change may run before the effect is judged to feed back on itself. */
const MAX_SETTLE_FLIPS = 8;

// === FACTORIES ===

/**
 * Create a conditional effect system for managing condition-driven effects.
 *
 * @param options - System id
 * @returns A {@link ConditionalEffectSystem} for registering and querying predicate-driven effects
 *
 * @example Basic conditional effect:
 * ```ts
 * const effects = createConditionalEffectSystem({ id: 'buffs' });
 *
 * effects.register({
 *   id: 'library-bonus',
 *   active: computed(() => library.isBuilt.value),
 *   grants: [{ chain: xpChain, mult: 2, description: 'Library' }],
 * });
 * ```
 *
 * @example Per-action modifiers on an engine-wide chain (the idiomatic
 * pattern for "item X multiplies action Y's progress"):
 * ```ts
 * const effects = createConditionalEffectSystem({ id: 'equipment-effects' });
 *
 * // Each registration is an affectedBy grant: "a pickaxe boosts mining progress"
 * effects.register({
 *   id: 'affected-by:mine:pickaxe',
 *   active: computed(() => equipment.has('pickaxe')),
 *   // engine-wide chain from createModifierChain
 *   grants: [{ chain: progressChain, mult: 1.5, description: 'Pickaxe' }],
 * });
 *
 * // The balance harness walks the effect-system registry for full attribution:
 * const registry = engine.tryInject(EffectSystemRegistryKey)!;
 * for (const sys of registry.all()) {
 *   for (const def of sys.allDefs()) {
 *     // def.id → "affected-by:mine:pickaxe"
 *     // def.grants → [{ chain, mult, description }] — full attribution
 *   }
 * }
 * ```
 */
export function createConditionalEffectSystem(
  options: ConditionalEffectSystemOptions,
): ConditionalEffectSystem {
  const entries = new Map<string, DefEntry>();
  const handle = createEmitHandle<ConditionalEffectEvents>();
  const predicates = createPredicateResolver();
  // Owns each def's watch, including those registered after install.
  const scope = effectScope();
  // Bumped on every activation and deactivation, so `getActive` / `getByTag` track the applied set.
  const appliedVersion = ref(0);

  function applyBindings(entry: DefEntry): void {
    entry.unbind = entry.slots.bind();
    entry.isApplied = true;
    appliedVersion.value++;
  }

  function removeBindings(entry: DefEntry): void {
    entry.unbind();
    entry.isApplied = false;
    appliedVersion.value++;
  }

  /**
   * Activate or deactivate until the applied state matches the predicate. An
   * activation can flip the predicate itself (an option callback spends what
   * it reads). `settling` swallows the watcher call that flip triggers, and
   * the loop re-reads the predicate instead.
   */
  function settle(entry: DefEntry): void {
    if (entry.settling) return;
    entry.settling = true;
    try {
      for (let flips = 0; entry.activeRef.value !== entry.isApplied; flips++) {
        if (flips === MAX_SETTLE_FLIPS) {
          throw new Error(
            `ConditionalEffect '${entry.def.id}': 'active' keeps flipping as its own grants ` +
              `are bound and removed — the predicate reads a value its grants change.`,
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

  function register(def: ConditionalEffectDef | ConditionalEffectDef[]): void {
    const list = Array.isArray(def) ? def : [def];
    for (const d of list) {
      if (entries.has(d.id)) {
        throw new Error(`ConditionalEffect: duplicate def '${d.id}'`);
      }

      const owner = `conditional effect '${d.id}'`;
      const activeRef = predicates.adopt(d.active, false, `${owner} active`).holds;

      const entry: DefEntry = {
        def: d,
        activeRef,
        slots: createBindingSlots(d.grants, predicates, owner),
        unbind: () => {},
        isApplied: false,
        settling: false,
      };

      // flush: 'sync' so a predicate that flips during a headless run
      // binds/unbinds its grants in the same tick. Headless runs drive tickOnce() in a tight
      // loop with no microtask boundary, so a default (pre) flush would leave
      // the effect a tick or more late. Mirrors achievement.ts /
      // automation.ts / resource-bag link watchers.
      runInEffectScope(scope, () =>
        watch(activeRef, () => settle(entry), { immediate: true, flush: 'sync' }),
      );

      entries.set(d.id, entry);
    }
  }

  function getDef(id: string): ConditionalEffectDef | undefined {
    return entries.get(id)?.def;
  }

  function allDefs(): readonly ConditionalEffectDef[] {
    const out: ConditionalEffectDef[] = [];
    for (const entry of entries.values()) out.push(entry.def);
    return out;
  }

  function isActive(defId: string): ComputedRef<boolean> {
    return computed(() => entries.get(defId)?.activeRef.value ?? false);
  }

  function getActive(): ConditionalEffectDef[] {
    void appliedVersion.value;
    const out: ConditionalEffectDef[] = [];
    for (const entry of entries.values()) {
      if (entry.isApplied) out.push(entry.def);
    }
    return out;
  }

  function getByTag(tag: string): ConditionalEffectDef[] {
    return getActive().filter((d) => d.tags?.includes(tag) ?? false);
  }

  function dispose(): void {
    scope.stop();
    for (const entry of entries.values()) entry.slots.release();
    entries.clear();
    appliedVersion.value++;
  }

  const system: ConditionalEffectSystem = {
    id: options.id,
    kind: 'conditional',
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
  // a module's install() or connect(). Systems constructed outside
  // an engine (tests, throwaway scripts) silently skip registration.
  getCurrentEffectSystemRegistry()?.register(system);
  registerBindingSlots(system, (defId) => entries.get(defId)?.slots);

  return system;
}
