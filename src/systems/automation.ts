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
 *       requirement: () => upgrades.autoBuy.earned.value },
 *     { id: 'conditional', name: 'Conditionals', order: 2,
 *       requirement: () => Decimal.gte(prestige.count.value, 5) },
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

import { computed, unref, watch, type ComputedRef, type WatchStopHandle } from 'vue';
import {
  persistent,
  withPersistentContext,
  getCurrentContext,
  type Persistent,
} from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { processGetter, type Computable } from '@/core/computed';

// === TYPES ===

/** Definition for a single automation tier. */
export interface AutomationTierDef {
  /** Unique tier identifier (e.g., 'manual', 'basic', 'advanced'). */
  id: string;
  /** Display name for the tier. */
  name: string;
  /**
   * Numeric sort order. Lower = earlier tier. Must be unique across tiers.
   * Tier 0 is typically the "no automation" baseline.
   */
  order: number;
  /**
   * Condition for auto-unlock. When it becomes `true`, the tier unlocks
   * automatically (like achievements). Omit for tiers unlocked imperatively
   * via {@link AutomationTiers.unlock}.
   *
   * Can be a static boolean, Vue ref, or getter for reactive evaluation.
   */
  requirement?: Computable<boolean>;
}

/** Events emitted by an {@link AutomationTiers} instance. */
export interface AutomationTiersEvents {
  /** Fired when a tier is newly unlocked. */
  unlock: (tierId: string, tierOrder: number) => void;
}

/** Options for {@link createAutomationTiers}. */
export interface AutomationTiersOptions {
  /**
   * Persistence context ID. Falls back to surrounding context or auto-generated.
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

  /** Set of unlocked tier IDs (persistent). */
  readonly unlocked: Persistent<string[]>;

  /** Check whether a specific tier is unlocked. */
  isTierUnlocked(tierId: string): boolean;

  /**
   * Check whether automation has progressed to at least the given tier.
   * Equivalent to `currentTierOrder.value >= tier.order`.
   */
  hasReached(tierId: string): boolean;

  /** Imperatively unlock a tier by ID. No-op if already unlocked or unknown. */
  unlock(tierId: string): void;

  /**
   * Lock all tiers except those in the initially-unlocked set.
   * Intended for prestige/reset scenarios.
   */
  resetUnlocks(): void;

  /** Subscribe to tier lifecycle events. */
  on: Emittable<AutomationTiersEvents>['on'];

  /** Stop the auto-unlock watchers installed for tiers with `requirement`. */
  dispose(): void;
}

// === CONSTANTS ===

let tierSystemCounter = 0;

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
 *       requirement: () => stats.manualCasts.value >= 10 },
 *     { id: 'conditionals', name: 'Conditionals', order: 3,
 *       requirement: () => zones.isUnlocked('elemental_trials') },
 *   ],
 * });
 *
 * auto.on('unlock', (id, order) => {
 *   notify(`Automation unlocked: ${auto.tiers.find(t => t.id === id)?.name}`);
 * });
 * ```
 */
export function createAutomationTiers(options: AutomationTiersOptions): AutomationTiers {
  const autoId = `autoTiers_${tierSystemCounter++}`;
  const { id, tiers: rawTiers, initiallyUnlocked } = options;

  const tiers = [...rawTiers].sort((a, b) => a.order - b.order);

  const tierMap = new Map(tiers.map((t) => [t.id, t]));

  // Default initial unlocks: lowest-order tier
  const defaultUnlocked = initiallyUnlocked ?? (tiers.length > 0 ? [tiers[0].id] : []);

  // --- Persistent state ---
  const contextId = id ?? getCurrentContext() ?? autoId;
  const unlocked = withPersistentContext(contextId, () =>
    persistent<string[]>([...defaultUnlocked], { name: 'unlocked' }),
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

  const unsubs: WatchStopHandle[] = [];

  // --- Public API ---
  const automationTiers: AutomationTiers = {
    tiers,
    currentTierId,
    currentTierOrder,
    unlocked,

    isTierUnlocked(tierId: string): boolean {
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
      handle.emit('unlock', tierId, tier.order);
    },

    resetUnlocks(): void {
      unlocked.value = [...defaultUnlocked];
    },

    on: handle.on,

    dispose(): void {
      for (const unsub of unsubs) unsub();
      unsubs.length = 0;
    },
  };

  // --- Auto-unlock watchers for tiers with requirements ---
  for (const tier of tiers) {
    if (tier.requirement !== undefined) {
      const processed = processGetter(tier.requirement);
      unsubs.push(
        watch(
          () => unref(processed),
          (met) => {
            if (met && !unlocked.value.includes(tier.id)) {
              automationTiers.unlock(tier.id);
            }
          },
          { immediate: true },
        ),
      );
    }
  }

  return automationTiers;
}

// === TYPE GUARDS ===
