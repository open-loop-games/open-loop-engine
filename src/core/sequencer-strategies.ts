/**
 * Built-in fill strategies for Sequencer.
 *
 * These are sugar for common automation patterns found in incremental games:
 * - Conditional: evaluate rules top-to-bottom, first match wins
 * - Priority: always pick the highest-priority candidate
 * - Round-robin: cycle through candidates in rotation
 * - Composite: chain strategies with first-match semantics (goals, then hobbies)
 *
 * One of three sibling "choose one from a list" primitives. The axis is
 * shape, not lifecycle:
 * - `FillStrategy` (this file) — *stateful generator*. `next()` returns
 *   `SequencerItem<M> | null`. Round-robin binds a persistent cursor.
 *   Verb form (`create*Strategy`) signals that construction allocates state;
 *   the convention extends across the family for symmetry.
 * - `SelectionPolicy` ({@link ../core/policy}) — *stateless selector*.
 *   `pick(candidates) → T | undefined`. Noun form (`selection*`) per the
 *   constructor-as-data carve-out — call sites read as configuration
 *   (`policy: selectionHybridPayback({ ... })`).
 * - `Recommender` ({@link ../systems/recommendation}) — *scored
 *   candidate*. The recommendation system filters defs via `canApply`,
 *   scores them, and runs `recommend()` on the winner each loop boundary.
 *
 * @cluster sequencer
 */

import { persistent, withPersistentContext } from './persistence';
import { attachPersistentContextReset } from './resettable';
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
 * The Sequencer drives invocation by calling `next()` when its queue runs dry;
 * conditions close over reactive state directly and re-evaluate lazily on each
 * call, so referenced reactive state naturally reflects current values.
 *
 * Compose with {@link createCompositeStrategy} for fallback behavior:
 * ```ts
 * createCompositeStrategy(
 *   createConditionalStrategy(getRules),
 *   createPriorityStrategy(getCandidates),
 * )
 * ```
 *
 * @param getRules - Returns the current rule list. Called each time the
 *   sequencer runs dry and asks for its next item, so the list itself can
 *   change at runtime (e.g., player editing automation rules).
 *
 * @example
 * ```ts
 * const strategy = createConditionalStrategy(() => [
 *   { condition: () => health.value.lt(20), item: { id: 'heal', metadata: undefined } },
 *   { condition: () => mana.value.gt(50), item: { id: 'fireball', metadata: undefined } },
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
      return item;
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
  const contextId = `strategy:${id}`;
  const index = withPersistentContext(contextId, () => persistent<number>(0, { name: 'index' }));

  const strategy: FillStrategy<M> = {
    next() {
      const candidates = getCandidates();
      if (candidates.length === 0) return null;
      if (index.value >= candidates.length) index.value = 0;
      const item = candidates[index.value];
      index.value = (index.value + 1) % candidates.length;
      return item;
    },
  };
  return attachPersistentContextReset(strategy, contextId);
}

// === COMPOSITE STRATEGY ===

/**
 * Chain multiple strategies with first-match semantics.
 * Tries each strategy in order; returns the first non-null result.
 *
 * Common pattern: a higher-priority strategy first, then a round-robin
 * fallback — fill a free slot from its goals before walking a
 * hobbies list:
 * ```ts
 * createCompositeStrategy(
 *   goalStrategy,
 *   createRoundRobinStrategy('hobbies', getHobbies),
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
