/**
 * Conditions — declarative predicate evaluation over `GameStateAccessor`
 */

import { Decimal } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import type {
  ICondition,
  GameStateAccessor,
  ResourceCondition,
  FlagCondition,
  StateCondition,
  AllCondition,
  AnyCondition,
  NotCondition,
} from '@/primitives/types';

function compareDecimal(
  a: Decimal,
  operator: 'gte' | 'lte' | 'gt' | 'lt' | 'eq',
  b: Decimal,
): boolean {
  switch (operator) {
    case 'gte':
      return a.gte(b);
    case 'lte':
      return a.lte(b);
    case 'gt':
      return a.gt(b);
    case 'lt':
      return a.lt(b);
    case 'eq':
      return a.eq(b);
    default:
      return false;
  }
}

/**
 * Compare an arbitrary state value against an expected value with a state-condition
 * operator. `eq` / `neq` use strict equality; ordering operators coerce both sides
 * to `number` (matches the inline dispatch this helper replaced — relies on the
 * caller to author state paths that hold numeric values when using ordering ops).
 *
 * Shared by {@link evaluateCondition}'s `state` branch and Gate's `state` kind so
 * the operator semantics stay canonical in one place.
 *
 * @internal
 */
export function compareState(
  actual: unknown,
  operator: StateCondition['operator'],
  expected: unknown,
): boolean {
  switch (operator) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'gt':
      return (actual as number) > (expected as number);
    case 'gte':
      return (actual as number) >= (expected as number);
    case 'lt':
      return (actual as number) < (expected as number);
    case 'lte':
      return (actual as number) <= (expected as number);
    default:
      return false;
  }
}

/**
 * Evaluate a declarative {@link ICondition} against the given game-state
 * accessor. Recurses through `and` / `or` / `not` nodes; leaves resolve via
 * the accessor's `getResource` / `getFlag` / `getState` lookups.
 *
 * @internal
 */
export function evaluateCondition(condition: ICondition, accessor: GameStateAccessor): boolean {
  switch (condition.type) {
    case 'resource':
      return compareDecimal(
        accessor.getResource(condition.target),
        condition.operator,
        new Decimal(condition.value),
      );
    case 'flag':
      return accessor.getFlag(condition.target);
    case 'state':
      return compareState(accessor.getState(condition.target), condition.operator, condition.value);
    case 'all':
      return condition.conditions.every((c) => evaluateCondition(c, accessor));
    case 'any':
      return condition.conditions.some((c) => evaluateCondition(c, accessor));
    case 'not':
      return !evaluateCondition(condition.condition, accessor);
  }
}

function collectDependencies(condition: ICondition, deps: string[]): void {
  switch (condition.type) {
    case 'resource':
      deps.push(`resources.${condition.target}.amount`);
      break;
    case 'flag':
      deps.push(`flags.${condition.target}`);
      break;
    case 'state':
      deps.push(condition.target);
      break;
    case 'all':
    case 'any':
      condition.conditions.forEach((c) => collectDependencies(c, deps));
      break;
    case 'not':
      collectDependencies(condition.condition, deps);
      break;
  }
}

/**
 * Collect the dotted-path dependencies referenced by a condition tree —
 * `resources.<id>.amount`, `unlocks.<id>`, and any state targets — deduped
 * and returned as a flat array. Used by reactivity-aware consumers to wire
 * `computed` subscriptions over arbitrary {@link ICondition} graphs.
 *
 * @internal
 */
export function extractDependencies(condition: ICondition): string[] {
  const deps: string[] = [];
  collectDependencies(condition, deps);
  return [...new Set(deps)];
}

// === CONDITION BUILDERS ===
/**
 * Ergonomic factories for constructing {@link ICondition} values — the
 * internal IR. Consumers author {@link Gate} literals on content fields
 * instead; engine-internal code reaches `C` via the `@/core/conditions`
 * import path when it needs to construct ICondition values directly (tests,
 * walker projection round-trips, internal-effect machinery).
 *
 * @internal
 */
export const C = {
  resource(
    target: string,
    operator: ResourceCondition['operator'],
    value: DecimalSource,
  ): ResourceCondition {
    return { type: 'resource', target, operator, value };
  },
  flag(target: string): FlagCondition {
    return { type: 'flag', target };
  },
  state(target: string, operator: StateCondition['operator'], value: unknown): StateCondition {
    return { type: 'state', target, operator, value };
  },
  all(...conditions: ICondition[]): AllCondition {
    return { type: 'all', conditions };
  },
  any(...conditions: ICondition[]): AnyCondition {
    return { type: 'any', conditions };
  },
  not(condition: ICondition): NotCondition {
    return { type: 'not', condition };
  },
};
