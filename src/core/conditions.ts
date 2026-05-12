/**
 * Conditions — declarative predicate evaluation over `GameStateAccessor`
 */

import { Decimal } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import type {
  ICondition,
  GameStateAccessor,
  ResourceCondition,
  UnlockCondition,
  StateCondition,
  AndCondition,
  OrCondition,
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
 * the accessor's `getResource` / `isUnlocked` / `getState` lookups.
 */
export function evaluateCondition(condition: ICondition, accessor: GameStateAccessor): boolean {
  switch (condition.type) {
    case 'resource':
      return compareDecimal(
        accessor.getResource(condition.target),
        condition.operator,
        new Decimal(condition.value),
      );
    case 'unlock':
      return accessor.isUnlocked(condition.target);
    case 'state':
      return compareState(accessor.getState(condition.target), condition.operator, condition.value);
    case 'and':
      return condition.conditions.every((c) => evaluateCondition(c, accessor));
    case 'or':
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
    case 'unlock':
      deps.push(`unlocks.${condition.target}`);
      break;
    case 'state':
      deps.push(condition.target);
      break;
    case 'and':
    case 'or':
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
 */
export function extractDependencies(condition: ICondition): string[] {
  const deps: string[] = [];
  collectDependencies(condition, deps);
  return [...new Set(deps)];
}

// === CONDITION BUILDERS ===
/**
 * Ergonomic factories for constructing {@link ICondition} values.
 *
 * Produces plain data objects (no classes, fully serializable). Use in content
 * definitions to declare visibility/unlock/start gates without closures.
 *
 * @example
 * ```ts
 * import { C } from '@open-loop/engine';
 *
 * const def = {
 *   visible: C.state('progressLevel:Wander', 'gte', 10),
 *   canStart: C.and(
 *     C.resource('gold', 'gte', 50),
 *     C.state('guild', 'eq', ''),
 *   ),
 * };
 * ```
 */
export const C = {
  resource(
    target: string,
    operator: ResourceCondition['operator'],
    value: DecimalSource,
  ): ResourceCondition {
    return { type: 'resource', target, operator, value };
  },
  unlock(target: string): UnlockCondition {
    return { type: 'unlock', target };
  },
  state(target: string, operator: StateCondition['operator'], value: unknown): StateCondition {
    return { type: 'state', target, operator, value };
  },
  and(...conditions: ICondition[]): AndCondition {
    return { type: 'and', conditions };
  },
  or(...conditions: ICondition[]): OrCondition {
    return { type: 'or', conditions };
  },
  not(condition: ICondition): NotCondition {
    return { type: 'not', condition };
  },
};
