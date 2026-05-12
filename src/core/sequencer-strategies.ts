/**
 * Built-in fill strategies for Sequencer.
 *
 * These are sugar for common automation patterns found in incremental games:
 * - Conditional: evaluate rules top-to-bottom, first match wins (Spell Compiler, Cavernous II)
 * - Priority: always pick the highest-priority candidate (Synergism, NGU Idle)
 * - Round-robin: cycle through candidates in rotation (Increlution)
 * - Composite: chain strategies with first-match semantics (emergency + round-robin)
 *
 * @cluster sequencer
 */

import { persistent, withPersistentContext } from './persistence';
import type { FillStrategy, SequencerItem } from './sequencer';

// === CONDITIONAL STRATEGY ===

/**
 * A rule mapping a boolean condition to a sequencer item.
 * Rules are evaluated in order — the first whose condition returns `true` wins.
 */
export interface ConditionalRule<M = void> {
  /** Returns `true` when this rule should match. Called each time `next()` runs. */
  condition: () => boolean;
  /** The sequencer item to return when the condition matches. */
  item: SequencerItem<M>;
}

/**
 * Pick the first item whose condition evaluates to `true` (top-to-bottom).
 *
 * This is the `FillStrategy` variant: the Sequencer drives invocation by calling
 * `next()` when its queue runs dry, and conditions close over reactive state
 * directly. For consumer-driven `evaluate(state) → action` with structured rule
 * attribution (mid-cycle preemption, profile-attributed firings), see
 * `createRuleEvaluator` — different lifecycle, same first-match semantics.
 *
 * Rules are evaluated lazily each call to `next()` — conditions that reference
 * reactive state naturally reflect current values.
 *
 * Compose with {@link createCompositeStrategy} for fallback behavior:
 * ```ts
 * createCompositeStrategy(
 *   createConditionalStrategy(getRules),
 *   createPriorityStrategy(getCandidates),
 * )
 * ```
 *
 * @param getRules - Returns the current rule list. Called each tick, so the list
 *   itself can change at runtime (e.g., player editing automation rules).
 *
 * @example
 * ```ts
 * const strategy = createConditionalStrategy(() => [
 *   { condition: () => health.value.lt(20), item: { id: 'heal' } },
 *   { condition: () => mana.value.gt(50), item: { id: 'fireball' } },
 * ]);
 * sequencer.fillStrategy = strategy;
 * ```
 */
export function createConditionalStrategy<M = void>(
  getRules: () => ConditionalRule<M>[],
): FillStrategy<M> {
  return {
    next() {
      const rules = getRules();
      for (const rule of rules) {
        if (rule.condition()) {
          return rule.item;
        }
      }
      return null;
    },
  };
}

// === PRIORITY STRATEGY ===

/**
 * Pick the highest-priority candidate each time.
 *
 * @param getCandidates - Returns available candidates with their priorities.
 *   Only candidates with priority > 0 are considered.
 */
export function createPriorityStrategy<M = void>(
  getCandidates: () => (SequencerItem<M> & { priority: number })[],
): FillStrategy<M> {
  return {
    next() {
      const candidates = getCandidates()
        .filter((c) => c.priority > 0)
        .sort((a, b) => b.priority - a.priority);
      if (candidates.length === 0) return null;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { priority: _, ...item } = candidates[0];
      return item as SequencerItem<M>;
    },
  };
}

// === ROUND-ROBIN STRATEGY ===

/**
 * Cycle through candidates in round-robin order.
 * The rotation index is a persistent ref so it survives save/load.
 *
 * @param id - Unique identifier for the persistent context
 * @param getCandidates - Returns available candidate items in desired order
 */
export function createRoundRobinStrategy<M = void>(
  id: string,
  getCandidates: () => SequencerItem<M>[],
): FillStrategy<M> {
  const index = withPersistentContext(`strategy:${id}`, () =>
    persistent<number>(0, { name: 'index' }),
  );

  return {
    next() {
      const candidates = getCandidates();
      if (candidates.length === 0) return null;
      if (index.value >= candidates.length) index.value = 0;
      const item = candidates[index.value];
      index.value = (index.value + 1) % candidates.length;
      return item;
    },
  };
}

// === COMPOSITE STRATEGY ===

/**
 * Chain multiple strategies with first-match semantics.
 * Tries each strategy in order; returns the first non-null result.
 *
 * Common pattern: emergency strategy first, then round-robin:
 * ```ts
 * createCompositeStrategy(
 *   emergencyFoodStrategy,
 *   createRoundRobinStrategy('auto', getCandidates),
 * )
 * ```
 */
export function createCompositeStrategy<M = void>(
  ...strategies: FillStrategy<M>[]
): FillStrategy<M> {
  return {
    next() {
      for (const s of strategies) {
        const item = s.next();
        if (item != null) return item;
      }
      return null;
    },
  };
}
