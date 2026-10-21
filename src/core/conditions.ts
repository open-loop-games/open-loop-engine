/**
 * Conditions — condition IR evaluation over `GameStateAccessor`
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
import type { GameStateAccessorMethod } from './game-state-accessor';

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
 * Compare a value at a state path against an expected value with a
 * `StateCondition` operator. `eq` / `neq` use strict equality. The ordering
 * operators coerce both sides to `number`, so the caller must point them at
 * state paths that hold numbers.
 *
 * {@link evaluateCondition}'s `state` branch and the Gate `state` kind share
 * it, so the operator meaning is defined in one place.
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
 * Evaluate an {@link ICondition}, the condition IR, against the given game-state
 * accessor. Recurses through `all` / `any` / `not` nodes; leaves read the
 * accessor's `getAmount` / `getFlag` / `getStateAt`.
 *
 * @internal
 */
export function evaluateCondition(condition: ICondition, accessor: GameStateAccessor): boolean {
  switch (condition.kind) {
    case 'resource':
      return compareDecimal(
        accessor.getAmount(condition.target),
        condition.operator,
        new Decimal(condition.value),
      );
    case 'flag':
      return accessor.getFlag(condition.target);
    case 'state':
      return compareState(accessor.getStateAt(condition.path), condition.operator, condition.value);
    case 'all':
      return condition.conditions.every((c) => evaluateCondition(c, accessor));
    case 'any':
      return condition.conditions.some((c) => evaluateCondition(c, accessor));
    case 'not':
      return !evaluateCondition(condition.condition, accessor);
  }
}

function collectDependencies(condition: ICondition, deps: string[]): void {
  switch (condition.kind) {
    case 'resource':
      deps.push(`resources.${condition.target}.amount`);
      break;
    case 'flag':
      deps.push(`flags.${condition.target}`);
      break;
    case 'state':
      deps.push(condition.path);
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
 * Add the accessor methods evaluating `condition` calls to `into`.
 *
 * @internal
 */
export function collectConditionMethods(
  condition: ICondition,
  into: Set<GameStateAccessorMethod>,
): void {
  switch (condition.kind) {
    case 'resource':
      into.add('getAmount');
      return;
    case 'flag':
      into.add('getFlag');
      return;
    case 'state':
      into.add('getStateAt');
      return;
    case 'all':
    case 'any':
      for (const c of condition.conditions) collectConditionMethods(c, into);
      return;
    case 'not':
      collectConditionMethods(condition.condition, into);
      return;
  }
}

/**
 * Collect the dotted-path dependencies a condition IR tree reads —
 * `resources.<id>.amount`, `flags.<id>` and any state paths — deduped, as a
 * flat array. Reactivity-aware consumers use it to wire `computed`
 * subscriptions over any {@link ICondition} tree.
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
 * Ergonomic factories for constructing {@link ICondition} values, the
 * condition IR. Consumers author {@link Gate} literals on predicate fields
 * instead. Engine-internal code imports `C` from `@/core/conditions` when it
 * builds condition IR directly: tests, walker projection round-trips and
 * internal effect code.
 *
 * @internal
 */
export const C = {
  resource(
    target: string,
    operator: ResourceCondition['operator'],
    value: DecimalSource,
  ): ResourceCondition {
    return { kind: 'resource', target, operator, value };
  },
  flag(target: string): FlagCondition {
    return { kind: 'flag', target };
  },
  state(path: string, operator: StateCondition['operator'], value: unknown): StateCondition {
    return { kind: 'state', path: path, operator, value };
  },
  all(...conditions: ICondition[]): AllCondition {
    return { kind: 'all', conditions };
  },
  any(...conditions: ICondition[]): AnyCondition {
    return { kind: 'any', conditions };
  },
  not(condition: ICondition): NotCondition {
    return { kind: 'not', condition };
  },
};
