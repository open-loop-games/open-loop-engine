/**
 * Transition-distance primitives — "when does X happen?" math over current engine state.
 *
 * Pure synchronous functions that compose condition evaluation (`@/core/conditions`),
 * accessor-read state (`getResource`, `getRate`), and Decimal arithmetic into
 * structured distances. Callers bind the result into reactive views with `computed()`
 * if they need reactivity; this module itself has no Vue dependency.
 *
 * Three entry points:
 *
 * - {@link timeUntilResource} — distance until a resource reaches an upward threshold.
 * - {@link timeUntilAffordable} — distance until a purchasable's next level is buyable.
 * - {@link timeUntilConditionFlip} — distance until an {@link ICondition} changes truth value.
 *
 * Consumed by the content-walker family — each walker leaf wraps one of these
 * per entity and emits `{ source, kind, currentValue, distance }` snapshots for
 * stasis analyzers, devtools panels, unlock hints, and tutorial-reachability tools.
 *
 * Rate semantics are accessor-owned: games implement {@link GameStateAccessor.getRate}
 * in terms of their own economy (gross production, net of drains, tunable overrides).
 * This module never walks `CategoriesKey` or reads producer internals directly —
 * that aggregation is a harness-layer concern.
 */

import { Decimal, type DecimalSource, toNumber } from '@/primitives/decimal';
import type { GameStateAccessor, ICondition, ResourceCondition } from '@/primitives/types';
import { evaluateCondition } from './conditions';
import type { Resource } from './resource';

/**
 * Distance until a state transition occurs, with a reason when the distance is uncomputable.
 *
 * - `reason: 'computed'` — distance was determined from rates and current state. `seconds ≥ 0`.
 * - `reason: 'no-rate'` — transition requires motion but the rate is zero or wrong-signed.
 * - `reason: 'opaque-predicate'` — the predicate (unlock, state path, custom) has no
 *   mechanical distance — it flips when something else writes to it.
 * - `reason: 'uncomputable'` — the transition may happen, but its distance can't be settled
 *   from current state and rates (e.g., point-crossing for an `eq` operator, no actionable
 *   children in a combinator, or a lifetime total the net rate can't bound).
 */
export type TransitionDistance =
  | { seconds: number; reason: 'computed' }
  | { seconds: null; reason: 'no-rate' | 'opaque-predicate' | 'uncomputable' };

/**
 * Accessor slots a transition's distance arithmetic reads.
 *
 * Produced by `collectGateDeps` (in `systems/gate.ts`, for Gate trees) and by the
 * content walker's per-leaf dep emitters (for cost-resource transitions).
 * Used by incremental-snapshot caches: when any id in a dep set changes, the
 * consumer re-runs the distance calc for transitions that named it.
 *
 * Dep scope is deliberately narrow — only the slots the *distance* math reads,
 * not every reactive slot the walker touches for gating or current-value snapshots.
 * Those transitive reads invalidate through whatever upstream primitive writes
 * them (e.g. purchase-delta for count-derived gates), and including them here
 * would make the dep set over-broad without catching anything the narrow set misses.
 */
export interface TransitionDeps {
  /**
   * Resource ids whose amount the distance reads: the balance via
   * `accessor.getResource(id)`, or the lifetime total a `cumulative-gte` gate reads.
   */
  resources: ReadonlySet<string>;
  /**
   * Resource ids whose rate the distance reads: `accessor.getRate(id)`, and
   * `accessor.getInflowRate(id)` where the accessor serves it.
   */
  rates: ReadonlySet<string>;
  /** Unlock ids read via `accessor.isUnlocked(id)`. */
  unlocks: ReadonlySet<string>;
  /** Dot-paths read via `accessor.getState(path)`. */
  states: ReadonlySet<string>;
}

/**
 * Minimal shape satisfied by {@link Purchasable}. Declared structurally in core so
 * this module doesn't reach into the systems layer.
 */
export interface AffordableLike {
  /** The resource that pays for this purchasable */
  resource: Resource;
  /** Cost to buy the next `amount` levels (defaults to 1) */
  getCost: (amount?: DecimalSource) => DecimalSource;
}

/**
 * Distance until `resource` reaches `target`, in seconds, assuming current rate holds.
 *
 * - Returns `{ seconds: 0, reason: 'computed' }` when `current ≥ target`.
 * - Returns `{ seconds: null, reason: 'no-rate' }` when rate ≤ 0 and current < target.
 * - Otherwise returns `{ seconds: (target - current) / rate, reason: 'computed' }`.
 *
 * Unidirectional (upward only). For downward crossings use {@link timeUntilConditionFlip}
 * with a `lte` / `lt` resource condition.
 *
 * @param resourceId - The resource's id (as keyed in the accessor).
 * @param target - The threshold value. Reached when `current ≥ target`.
 * @param accessor - Reads current amount and rate.
 */
export function timeUntilResource(
  resourceId: string,
  target: DecimalSource,
  accessor: GameStateAccessor,
): TransitionDistance {
  const current = accessor.getResource(resourceId);
  const targetDec = Decimal.fromValue(target);
  if (Decimal.gte(current, targetDec)) {
    return { seconds: 0, reason: 'computed' };
  }
  const rate = accessor.getRate(resourceId);
  if (Decimal.lte(rate, Decimal.dZero)) {
    return { seconds: null, reason: 'no-rate' };
  }
  return secondsToCover(Decimal.sub(targetDec, current), rate);
}

/**
 * Distance until the next level of a purchasable becomes affordable — delegates to
 * {@link timeUntilResource} using `purchasable.resource` and `purchasable.getCost(1)`.
 *
 * Single-unit cost only. Bulk-aware affordability distance would be a separate primitive.
 */
export function timeUntilAffordable(
  purchasable: AffordableLike,
  accessor: GameStateAccessor,
): TransitionDistance {
  return timeUntilResource(purchasable.resource.id, purchasable.getCost(1), accessor);
}

/**
 * Distance until `condition` changes truth value, assuming current rates hold.
 *
 * Dispatches on `condition.type`:
 *
 * - `resource` — six-way truth table over `operator × sign(rate)`; returns `'uncomputable'`
 *   for `eq` (point-crossing); returns `'no-rate'` when rate is zero or wrong-signed.
 * - `and` / `or` — combinator semantics keyed on current truth:
 *   - AND currently-true → min over children's flip-to-false distances.
 *   - AND currently-false → max over currently-false children's flip-to-true distances.
 *     (Currently-true children assumed stable over the horizon — monotonicity).
 *   - OR currently-true → max over currently-true children's flip-to-false distances.
 *   - OR currently-false → min over children's flip-to-true distances.
 *   - Null children follow {@link combineFlipDistances}: `'no-rate'` drops out of a min,
 *     and any other null propagates with its reason. A lower-bound variant (use computable
 *     children as a floor) is a separate candidate primitive.
 * - `not` — recurse on the inner condition (NOT flips iff inner flips).
 * - `unlock`, `state` — always `'opaque-predicate'` (no mechanical distance).
 *
 * @internal Consumers ask `timeUntilGateFlip`, which answers the same question over a Gate.
 */
export function timeUntilConditionFlip(
  condition: ICondition,
  accessor: GameStateAccessor,
): TransitionDistance {
  switch (condition.type) {
    case 'resource':
      return timeUntilResourceFlip(condition, accessor);
    case 'all':
      return timeUntilCombinatorFlip(condition.conditions, accessor, 'all');
    case 'any':
      return timeUntilCombinatorFlip(condition.conditions, accessor, 'any');
    case 'not':
      return timeUntilConditionFlip(condition.condition, accessor);
    case 'unlock':
    case 'state':
      return { seconds: null, reason: 'opaque-predicate' };
  }
}

// === PRIVATE HELPERS ===
function timeUntilResourceFlip(
  condition: ResourceCondition,
  accessor: GameStateAccessor,
): TransitionDistance {
  if (condition.operator === 'eq') {
    return { seconds: null, reason: 'uncomputable' };
  }
  const current = accessor.getResource(condition.target);
  const targetDec = Decimal.fromValue(condition.value);
  const rate = accessor.getRate(condition.target);
  const currentlyTrue = evaluateCondition(condition, accessor);

  // Determine required motion direction for the flip.
  // - gte/gt currently-false → need upward crossing (rate > 0).
  // - gte/gt currently-true  → need downward crossing (rate < 0).
  // - lte/lt currently-false → need downward crossing (rate < 0).
  // - lte/lt currently-true  → need upward crossing (rate > 0).
  const isGteGt = condition.operator === 'gte' || condition.operator === 'gt';
  const needsUp = isGteGt ? !currentlyTrue : currentlyTrue;

  if (needsUp && Decimal.lte(rate, Decimal.dZero)) {
    return { seconds: null, reason: 'no-rate' };
  }
  if (!needsUp && Decimal.gte(rate, Decimal.dZero)) {
    return { seconds: null, reason: 'no-rate' };
  }

  const distance = needsUp ? Decimal.sub(targetDec, current) : Decimal.sub(current, targetDec);
  return secondsToCover(distance, needsUp ? rate : Decimal.neg(rate));
}

/**
 * Seconds to close `gap` at a positive `rate`, floored at 0.
 *
 * @internal Shared by the resource and Gate flip-distance arithmetic.
 */
export function secondsToCover(gap: DecimalSource, rate: DecimalSource): TransitionDistance {
  const seconds = toNumber(Decimal.div(gap, rate));
  // An undefined amount or rate makes the distance indeterminate, not zero.
  // `computed` promises a real `seconds`, so the indeterminate case takes the
  // arm that already exists for it.
  if (Number.isNaN(seconds)) return { seconds: null, reason: 'uncomputable' };
  return { seconds: Math.max(0, seconds), reason: 'computed' };
}

/**
 * One child's contribution to a combinator flip-distance calculation: its
 * current truth value plus its individual flip distance. Callers build these
 * tuples per child and hand them to {@link combineFlipDistances}.
 *
 * @internal Used by the Gate flip-distance walk.
 */
export interface ChildFlipResult {
  currentlyTrue: boolean;
  distance: TransitionDistance;
}

/**
 * Truth-table dispatch over `{ currentlyTrue, distance }` tuples for `and` / `or`
 * combinators. Pure — no accessor reads, no condition recursion. Used by
 * {@link timeUntilConditionFlip} for `ICondition` combinators and by
 * `timeUntilGateFlip` (in `systems/gate.ts`) for `Gate` combinators, so both
 * surfaces share the same flip-distance semantics.
 *
 * Semantics:
 * - AND currently-true → min over children's flip-to-false distances.
 * - AND currently-false → max over currently-false children's flip-to-true distances.
 * - OR  currently-true → max over currently-true children's flip-to-false distances.
 * - OR  currently-false → min over children's flip-to-true distances.
 * - Under `min`, a `'no-rate'` child never flips, so it can't be the first
 *   to: it drops out, and the result is `'no-rate'` only when every child is.
 * - Otherwise strict-null: any child returning `null` propagates null with its
 *   reason — `'opaque-predicate'` and `'uncomputable'` under either mode, since
 *   such a child may flip at any time, and `'no-rate'` under `max`, since the
 *   combinator waits on a child that never flips.
 * - Empty `children` or no actionable subset → `'uncomputable'`.
 *
 * @internal Used by the Gate flip-distance walk.
 */
export function combineFlipDistances(
  children: ChildFlipResult[],
  kind: 'all' | 'any',
): TransitionDistance {
  if (children.length === 0) {
    return { seconds: null, reason: 'uncomputable' };
  }
  const combinatorTrue =
    kind === 'all' ? children.every((s) => s.currentlyTrue) : children.some((s) => s.currentlyTrue);

  // AND true → any child flips false (min). AND false → all false-children flip true (max).
  // OR  true → all true-children flip false (max). OR  false → any child flips true (min).
  const [mode, actionable] =
    kind === 'all'
      ? combinatorTrue
        ? (['min', children] as const)
        : (['max', children.filter((s) => !s.currentlyTrue)] as const)
      : combinatorTrue
        ? (['max', children.filter((s) => s.currentlyTrue)] as const)
        : (['min', children] as const);

  if (actionable.length === 0) {
    return { seconds: null, reason: 'uncomputable' };
  }

  // Under `min` a child that never flips can't be the first to, so it drops
  // out. Any other null leaves the answer open, and under `max` a child that
  // never flips means the combinator never does.
  const decisive =
    mode === 'min' ? actionable.filter((s) => s.distance.reason !== 'no-rate') : actionable;
  if (decisive.length === 0) {
    return { seconds: null, reason: 'no-rate' };
  }
  const firstNull = decisive.find((s) => s.distance.seconds === null);
  if (firstNull) {
    return firstNull.distance;
  }
  const seconds = decisive.map((s) => s.distance.seconds as number);
  const chosen = mode === 'min' ? Math.min(...seconds) : Math.max(...seconds);
  return { seconds: chosen, reason: 'computed' };
}

function timeUntilCombinatorFlip(
  children: ICondition[],
  accessor: GameStateAccessor,
  kind: 'all' | 'any',
): TransitionDistance {
  const results: ChildFlipResult[] = children.map((c) => ({
    currentlyTrue: evaluateCondition(c, accessor),
    distance: timeUntilConditionFlip(c, accessor),
  }));
  return combineFlipDistances(results, kind);
}
