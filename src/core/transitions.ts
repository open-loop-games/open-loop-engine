/**
 * Transition-distance primitives — "when does X happen?" math over current game state.
 *
 * Pure synchronous functions that compose condition evaluation (`@/core/conditions`),
 * accessor-read state (`getAmount`, `getRate`), and Decimal arithmetic into
 * structured distances. Callers bind the result into reactive views with `computed()`
 * if they need reactivity; this file itself has no Vue dependency.
 *
 * Three functions:
 *
 * - {@link timeUntilResource} — distance until a resource reaches an upward threshold.
 * - {@link timeUntilAffordable} — distance until a purchasable's next purchase is affordable.
 * - {@link timeUntilConditionFlip} — distance until an {@link ICondition} changes truth value.
 *
 * Consumed by the transition-walker family. Each walker leaf wraps one of these per
 * category entry and emits `{ source, kind, currentValue, distance }` snapshots. Stasis
 * analyzers, devtools panels, unlock hints and tutorial-reachability tools read them.
 *
 * Rate semantics are accessor-owned: games implement {@link GameStateAccessor.getRate}
 * in terms of their own economy (gross production, net rate, tunable overrides).
 * This file never walks `CategoriesKey` or reads producer internals directly —
 * that aggregation is a balance-harness concern.
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
 * - `reason: 'opaque-predicate'` — the predicate (flag, state path, custom) has no
 *   mechanical distance — it flips when something else writes to it.
 * - `reason: 'uncomputable'` — the transition may happen, but its distance can't be computed
 *   from current state and rates. Examples are point-crossing for an `eq` operator, no
 *   actionable children in a combinator, and a lifetime total the net rate can't bound.
 */
export type TransitionDistance =
  | { seconds: number; reason: 'computed' }
  | { seconds: null; reason: 'no-rate' | 'opaque-predicate' | 'uncomputable' };

/**
 * The ids and paths a transition's distance arithmetic reads through the accessor.
 *
 * Produced by `collectGateDeps` (in `systems/gate.ts`, for Gate trees) and by the
 * transition walker's per-leaf dep emitters (for cost-resource transitions).
 * Used by incremental-snapshot caches: when any id in a dep set changes, the
 * consumer re-runs the distance calc for transitions that named it.
 *
 * The dep set is deliberately narrow. It holds only what the *distance* math reads,
 * not every reactive value the walker reads for its predicates or current-value snapshots.
 * Those transitive reads invalidate through whatever upstream primitive writes
 * them, such as purchase-delta for count-derived Gates. Including them here would
 * make the dep set over-broad without catching anything the narrow set misses.
 */
export interface TransitionDeps {
  /**
   * Resource ids whose amount the distance reads: the amount via
   * `accessor.getAmount(id)`, or the lifetime total a `cumulative-gte` Gate reads.
   */
  resources: ReadonlySet<string>;
  /**
   * Resource ids whose rate the distance reads: `accessor.getRate(id)`, and
   * `accessor.getInflowRate(id)` where the accessor serves it.
   */
  rates: ReadonlySet<string>;
  /** Flag ids read via `accessor.getFlag(id)`. */
  flags: ReadonlySet<string>;
  /** Dot-paths read via `accessor.getStateAt(path)`. */
  states: ReadonlySet<string>;
}

/**
 * Minimal shape satisfied by {@link Purchasable}. Declared structurally in core so
 * this file doesn't import from the systems source layer.
 */
export interface AffordableLike {
  /** The resource this purchasable's cost is paid in */
  resource: Resource;
  /** Cost of the next `count` purchases (defaults to 1) */
  getCost: (count?: DecimalSource) => DecimalSource;
}

/**
 * Distance until `resource` reaches `target`, in seconds, assuming current rate holds.
 *
 * - Returns `{ seconds: 0, reason: 'computed' }` when `current ≥ target`.
 * - Returns `{ seconds: null, reason: 'no-rate' }` when rate ≤ 0 and current < target.
 * - Otherwise returns `{ seconds: (target - current) / rate, reason: 'computed' }`.
 *
 * Unidirectional (upward only). For downward crossings use {@link timeUntilConditionFlip}
 * with a `lte` / `lt` resource `ICondition`.
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
  const current = accessor.getAmount(resourceId);
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
 * Distance until a purchasable's next purchase becomes affordable — delegates to
 * {@link timeUntilResource} using `purchasable.resource` and `purchasable.getCost(1)`.
 *
 * One purchase only. A bulk-purchase affordability distance would be a separate primitive.
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
 * Dispatches on `condition.kind`:
 *
 * - `resource` — six-way truth table over `operator × sign(rate)`; returns `'uncomputable'`
 *   for `eq` (point-crossing); returns `'no-rate'` when rate is zero or wrong-signed.
 * - `all` / `any` — combinator semantics keyed on current truth:
 *   - ALL currently-true → min over children's flip-to-false distances.
 *   - ALL currently-false → max over currently-false children's flip-to-true distances.
 *     (Currently-true children assumed stable over the horizon — monotonicity).
 *   - ANY currently-true → max over currently-true children's flip-to-false distances.
 *   - ANY currently-false → min over children's flip-to-true distances.
 *   - Null children follow {@link combineFlipDistances}: `'no-rate'` drops out of a min,
 *     and any other null propagates with its reason. A lower-bound form (computable
 *     children as a lower bound) is a separate candidate primitive.
 * - `not` — recurse on the inner condition IR (NOT flips iff the inner one flips).
 * - `flag`, `state` — always `'opaque-predicate'` (no mechanical distance).
 *
 * @internal Consumers ask `timeUntilGateFlip`, which answers the same question over a Gate.
 */
export function timeUntilConditionFlip(
  condition: ICondition,
  accessor: GameStateAccessor,
): TransitionDistance {
  switch (condition.kind) {
    case 'resource':
      return timeUntilResourceFlip(condition, accessor);
    case 'all':
      return timeUntilCombinatorFlip(condition.conditions, accessor, 'all');
    case 'any':
      return timeUntilCombinatorFlip(condition.conditions, accessor, 'any');
    case 'not':
      return timeUntilConditionFlip(condition.condition, accessor);
    case 'flag':
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
  const current = accessor.getAmount(condition.target);
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
 * One child's input to a combinator flip-distance calculation: its
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
 * Truth-table dispatch over `{ currentlyTrue, distance }` tuples for `all` / `any`
 * combinators. Pure — no accessor reads, no condition IR recursion. Used by
 * {@link timeUntilConditionFlip} for `ICondition` combinators and by
 * `timeUntilGateFlip` (in `systems/gate.ts`) for `Gate` combinators, so both
 * share the same flip-distance semantics.
 *
 * Semantics:
 * - ALL currently-true → min over children's flip-to-false distances.
 * - ALL currently-false → max over currently-false children's flip-to-true distances.
 * - ANY currently-true → max over currently-true children's flip-to-false distances.
 * - ANY currently-false → min over children's flip-to-true distances.
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

  // ALL true → any child flips false (min). ALL false → all false-children flip true (max).
  // ANY true → all true-children flip false (max). ANY false → any child flips true (min).
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
