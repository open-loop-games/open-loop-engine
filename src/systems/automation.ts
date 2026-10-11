/**
 * Automation tiers — progressive unlock of automation features
 *
 * Tracks automation tier progression (manual → basic → conditional →
 * priority → AI). The system manages unlock state; what each automation
 * tier *enables* is consumer wiring.
 *
 * Mirrors the {@link createZoneSystem} pattern: persistent unlocked set,
 * events on unlock, `resetUnlocks()` for a reset.
 *
 * - {@link createAutomationTiers} — sole factory
 *
 * @example
 * ```ts
 * const auto = createAutomationTiers({
 *   id: 'automation',
 *   tiers: [
 *     { id: 'manual', displayName: 'Manual', order: 0 },
 *     { id: 'basic', displayName: 'Auto-purchase', order: 1,
 *       unlockWhen: () => upgrades.autoPurchase.active.value },
 *     { id: 'conditional', displayName: 'Conditionals', order: 2,
 *       unlockWhen: () => Decimal.gte(prestige.count.value, 5) },
 *   ],
 * });
 *
 * // Consumer wiring — what each automation tier enables:
 * if (auto.hasReached('basic')) {
 *   queue.fillStrategy = basicStrategy;
 * }
 * if (auto.hasReached('conditional')) {
 *   queue.fillStrategy = createCompositeStrategy(conditionalStrategy, basicStrategy);
 * }
 * ```
 */

import { computed, effectScope, type ComputedRef } from 'vue';
import {
  persistent,
  withPersistentContext,
  resolveSystemPersistentContextId,
  latchWhenSettled,
  type Persistent,
} from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { attachPersistentContextReset } from '@/core/resettable';
import { createPredicateResolver, type Predicate } from './gate';

// === TYPES ===

/** Def for one automation tier. */
export interface AutomationTierDef {
  /** Automation tier id (e.g. 'manual', 'basic', 'advanced'); a repeat throws. */
  id: string;
  displayName: string;
  /**
   * Sort order; lower comes first. Must be unique across automation tiers.
   * Order 0 is typically the "no automation" baseline.
   */
  order: number;
  /**
   * Predicate that unlocks the automation tier. Whenever it holds, the
   * automation tier unlocks, as an achievement is earned: on activation,
   * once a load or reset settles, and in {@link AutomationTiers.resetUnlocks}.
   * Omit it for an automation tier unlocked only by {@link AutomationTiers.unlock}.
   *
   * A getter or ref is reactive. A Gate evaluates against the Gate services
   * captured when `createAutomationTiers` runs.
   */
  unlockWhen?: Predicate;
}

/** Events emitted by an {@link AutomationTiers} instance. */
export interface AutomationTiersEvents {
  /**
   * Emitted when an automation tier unlocks. A load that writes back an
   * unlocked automation tier emits nothing.
   */
  unlocked: (tierId: string, tierOrder: number) => void;
}

/** Options for {@link createAutomationTiers}. */
export interface AutomationTiersOptions {
  /**
   * Persistent context id. Defaults to `${module}/automation` inside a
   * module; pass one when a module builds more than one.
   */
  id?: string;
  /** Automation tier defs, sorted internally by `order`. */
  tiers: AutomationTierDef[];
  /**
   * Automation tier ids that start unlocked. Defaults to the lowest-order
   * automation tier alone.
   */
  initiallyUnlocked?: string[];
}

/**
 * The automation tier system {@link createAutomationTiers} returns.
 *
 * It tracks which automation tiers are unlocked. It does NOT decide what an
 * automation tier enables. Consumers connect automation tier checks to their
 * own automation (fill strategies, auto-purchase, conditional rules).
 */
export interface AutomationTiers {
  /** Every automation tier def, sorted by `order` ascending. */
  readonly tiers: readonly AutomationTierDef[];

  /** The highest unlocked automation tier's id (reactive). */
  readonly currentTierId: ComputedRef<string>;

  /** The highest unlocked automation tier's `order` (reactive). */
  readonly currentTierOrder: ComputedRef<number>;

  /**
   * Unlocked automation tier ids (persistent). It is a lifetime ref, so a
   * reset of the owning module keeps it; `resetUnlocks()` clears it.
   */
  readonly unlocked: Persistent<string[]>;

  /** Whether an automation tier is unlocked. */
  isUnlocked(tierId: string): boolean;

  /**
   * Whether automation has progressed to at least the given automation tier.
   * Equivalent to `currentTierOrder.value >= tier.order`.
   */
  hasReached(tierId: string): boolean;

  /** Unlock an automation tier by id. No-op if it is already unlocked or unknown. */
  unlock(tierId: string): void;

  /**
   * Lock every automation tier except the initially-unlocked set and those
   * whose `unlockWhen` still holds. Those stay unlocked without an
   * `unlocked` event. Intended for a reset.
   */
  resetUnlocks(): void;

  /** Subscribe to automation tier events. */
  on: Emittable<AutomationTiersEvents>['on'];

  /**
   * Stop the watchers that unlock automation tiers with `unlockWhen`.
   * `unlocked` stays registered and keeps saving, so a rebuild under the
   * same id needs a new engine.
   */
  dispose(): void;
}

// === FACTORIES ===

/**
 * Create an automation tier system for progressive automation unlocks.
 *
 * @param options - Automation tier defs, initial unlocks and the persistent context id
 * @returns An {@link AutomationTiers} with persistent unlock tracking and events
 *
 * @example
 * ```ts
 * const auto = createAutomationTiers({
 *   id: 'automation',
 *   tiers: [
 *     { id: 'none', displayName: 'Manual', order: 0 },
 *     { id: 'sequencer', displayName: 'Sequencer', order: 1,
 *       unlockWhen: () => stats.manualCasts.value >= 10 },
 *     { id: 'conditionals', displayName: 'Conditionals', order: 3,
 *       unlockWhen: () => zones.isUnlocked('elemental_trials') },
 *   ],
 * });
 *
 * auto.on('unlocked', (id, order) => {
 *   notify(`Automation unlocked: ${auto.tiers.find(t => t.id === id)?.displayName}`);
 * });
 * ```
 */
export function createAutomationTiers(options: AutomationTiersOptions): AutomationTiers {
  const { id, tiers: rawTiers, initiallyUnlocked } = options;

  const tiers = [...rawTiers].sort((a, b) => a.order - b.order);

  const tierMap = new Map<string, AutomationTierDef>();
  for (const tier of tiers) {
    if (tierMap.has(tier.id)) {
      throw new Error(
        `AutomationTiers: duplicate automation tier id "${tier.id}". Automation tier ids must be unique.`,
      );
    }
    tierMap.set(tier.id, tier);
  }

  // Default initial unlocks: the lowest-order automation tier
  const defaultUnlocked = initiallyUnlocked ?? (tiers.length > 0 ? [tiers[0].id] : []);

  // --- Persistent state ---
  const contextId = resolveSystemPersistentContextId(id, 'automation');
  const unlocked = withPersistentContext(contextId, () =>
    persistent<string[]>([...defaultUnlocked], { id: 'unlocked', lifetime: true }),
  );

  const handle = createEmitHandle<AutomationTiersEvents>();

  // --- Derived computeds ---
  const currentTierOrder = computed(() => {
    let maxOrder = -Infinity;
    for (const tierId of unlocked.value) {
      const tier = tierMap.get(tierId);
      if (tier && tier.order > maxOrder) {
        maxOrder = tier.order;
      }
    }
    return maxOrder === -Infinity ? 0 : maxOrder;
  });

  const currentTierId = computed(() => {
    const order = currentTierOrder.value;
    for (let i = tiers.length - 1; i >= 0; i--) {
      const tier = tiers[i];
      if (tier.order === order && unlocked.value.includes(tier.id)) {
        return tier.id;
      }
    }
    return defaultUnlocked[0] ?? '';
  });

  const predicates = createPredicateResolver();
  const requirements = tiers.flatMap((tier) =>
    tier.unlockWhen === undefined
      ? []
      : [
          {
            tier,
            met: predicates.adopt(tier.unlockWhen, false, `automation tier '${tier.id}' unlockWhen`)
              .holds,
          },
        ],
  );

  const scope = effectScope();

  // --- Public API ---
  const automationTiers: AutomationTiers = {
    tiers,
    currentTierId,
    currentTierOrder,
    unlocked,

    isUnlocked(tierId: string): boolean {
      return unlocked.value.includes(tierId);
    },

    hasReached(tierId: string): boolean {
      const tier = tierMap.get(tierId);
      if (!tier) return false;
      return currentTierOrder.value >= tier.order;
    },

    unlock(tierId: string): void {
      if (unlocked.value.includes(tierId)) return;
      const tier = tierMap.get(tierId);
      if (!tier) return;
      unlocked.value = [...unlocked.value, tierId];
      handle.emit('unlocked', tierId, tier.order);
    },

    resetUnlocks(): void {
      const before = new Set(unlocked.value);
      unlocked.value = [...defaultUnlocked];
      // Re-latch every automation tier whose `unlockWhen` still holds; one
      // unlocked before the reset comes back without an `unlocked` event.
      for (const { tier, met } of requirements) {
        if (!met.value || unlocked.value.includes(tier.id)) continue;
        if (before.has(tier.id)) unlocked.value = [...unlocked.value, tier.id];
        else automationTiers.unlock(tier.id);
      }
    },

    on: handle.on,

    dispose(): void {
      scope.stop();
    },
  };

  // --- Auto-unlock latches for automation tiers with `unlockWhen` ---
  scope.run(() => {
    for (const { tier, met } of requirements) {
      latchWhenSettled(met, () => automationTiers.unlock(tier.id));
    }
  });

  return attachPersistentContextReset(automationTiers, contextId);
}
