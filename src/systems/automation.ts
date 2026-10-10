/**
 * Automation tiers — progressive unlock of automation features
 *
 * Tracks tiered automation progression (manual → basic → conditional →
 * priority → AI), a near-universal pattern across incremental games (95%+
 * prevalence). The system manages unlock state; what each tier *enables*
 * is entirely consumer-side wiring.
 *
 * Mirrors the {@link createZoneSystem} pattern: persistent unlocked set,
 * events on unlock, `resetUnlocks()` for prestige.
 *
 * - {@link createAutomationTiers} — sole factory
 *
 * @example
 * ```ts
 * const auto = createAutomationTiers({
 *   id: 'automation',
 *   tiers: [
 *     { id: 'manual', name: 'Manual', order: 0 },
 *     { id: 'basic', name: 'Auto-buy', order: 1,
 *       unlockWhen: () => upgrades.autoBuy.earned.value },
 *     { id: 'conditional', name: 'Conditionals', order: 2,
 *       unlockWhen: () => Decimal.gte(prestige.count.value, 5) },
 *   ],
 * });
 *
 * // Consumer wiring — what each tier enables:
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

/** Definition for a single automation tier. */
export interface AutomationTierDef {
  /** Unique tier identifier (e.g., 'manual', 'basic', 'advanced'); a repeat throws. */
  id: string;
  /** Display name for the tier. */
  name: string;
  /**
   * Numeric sort order. Lower = earlier tier. Must be unique across tiers.
   * Tier 0 is typically the "no automation" baseline.
   */
  order: number;
  /**
   * Condition for auto-unlock. Whenever it holds, the tier unlocks
   * automatically (like achievements): as it turns `true`, once a load or
   * reset settles, and through {@link AutomationTiers.resetUnlocks}. Omit for
   * tiers unlocked imperatively via {@link AutomationTiers.unlock}.
   *
   * A getter or ref re-evaluates reactively; a Gate resolves through the
   * runtime captured at `createAutomationTiers` time.
   */
  unlockWhen?: Predicate;
}

/** Events emitted by an {@link AutomationTiers} instance. */
export interface AutomationTiersEvents {
  /** Fired when a tier is newly unlocked. A load restoring a tier fires nothing. */
  unlocked: (tierId: string, tierOrder: number) => void;
}

/** Options for {@link createAutomationTiers}. */
export interface AutomationTiersOptions {
  /**
   * Save context. Defaults to `${module}/automation` inside a module; pass one
   * when a module builds more than one.
   */
  id?: string;
  /** Tier definitions (sorted internally by `order`). */
  tiers: AutomationTierDef[];
  /**
   * Tier IDs that start unlocked. Defaults to the single lowest-order tier.
   */
  initiallyUnlocked?: string[];
}

/**
 * An automation tiers instance — the returned object from {@link createAutomationTiers}.
 *
 * Manages tiered unlock progression for automation features. Does NOT dictate
 * what each tier enables — consumers wire tier checks to their specific
 * automation systems (strategies, auto-buy, conditional rules, etc.).
 */
export interface AutomationTiers {
  /** All tier definitions sorted by order (ascending). */
  readonly tiers: readonly AutomationTierDef[];

  /** The highest unlocked tier's ID (reactive). */
  readonly currentTierId: ComputedRef<string>;

  /** The highest unlocked tier's order value (reactive). */
  readonly currentTierOrder: ComputedRef<number>;

  /**
   * Set of unlocked tier IDs (persistent). Tagged `lifetime`, so a reset of
   * the owning module keeps it; `resetUnlocks()` is the wipe.
   */
  readonly unlocked: Persistent<string[]>;

  /** Check whether a specific tier is unlocked. */
  isUnlocked(tierId: string): boolean;

  /**
   * Check whether automation has progressed to at least the given tier.
   * Equivalent to `currentTierOrder.value >= tier.order`.
   */
  hasReached(tierId: string): boolean;

  /** Imperatively unlock a tier by ID. No-op if already unlocked or unknown. */
  unlock(tierId: string): void;

  /**
   * Lock all tiers except those in the initially-unlocked set and those whose
   * `unlockWhen` still holds, which stay unlocked without an `unlocked` event.
   * Intended for prestige/reset scenarios.
   */
  resetUnlocks(): void;

  /** Subscribe to tier lifecycle events. */
  on: Emittable<AutomationTiersEvents>['on'];

  /**
   * Stop the auto-unlock watchers installed for tiers with `unlockWhen`.
   * `unlocked` stays registered and keeps saving, so building tiers under the
   * same id again takes a new engine.
   */
  dispose(): void;
}

// === FACTORIES ===

/**
 * Create an automation tier system for progressive automation unlocks.
 *
 * @param options - Tier definitions, initial unlocks, persistence ID
 * @returns An {@link AutomationTiers} with persistent unlock tracking and events
 *
 * @example
 * ```ts
 * const auto = createAutomationTiers({
 *   id: 'automation',
 *   tiers: [
 *     { id: 'none', name: 'Manual', order: 0 },
 *     { id: 'sequencer', name: 'Sequencer', order: 1,
 *       unlockWhen: () => stats.manualCasts.value >= 10 },
 *     { id: 'conditionals', name: 'Conditionals', order: 3,
 *       unlockWhen: () => zones.isUnlocked('elemental_trials') },
 *   ],
 * });
 *
 * auto.on('unlocked', (id, order) => {
 *   notify(`Automation unlocked: ${auto.tiers.find(t => t.id === id)?.name}`);
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
        `AutomationTiers: duplicate automation tier id "${tier.id}". Tier ids must be unique.`,
      );
    }
    tierMap.set(tier.id, tier);
  }

  // Default initial unlocks: lowest-order tier
  const defaultUnlocked = initiallyUnlocked ?? (tiers.length > 0 ? [tiers[0].id] : []);

  // --- Persistent state ---
  const contextId = resolveSystemPersistentContextId(id, 'automation');
  const unlocked = withPersistentContext(contextId, () =>
    persistent<string[]>([...defaultUnlocked], { name: 'unlocked', lifetime: true }),
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
      // Re-latch every tier whose requirement still holds; one held before the
      // reset comes back without announcing itself again.
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

  // --- Auto-unlock latches for tiers with requirements ---
  scope.run(() => {
    for (const { tier, met } of requirements) {
      latchWhenSettled(met, () => automationTiers.unlock(tier.id));
    }
  });

  return attachPersistentContextReset(automationTiers, contextId);
}
