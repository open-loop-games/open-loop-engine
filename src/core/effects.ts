/**
 * Effects — declarative game-state mutations from `IEffect` ASTs
 */

import type { DecimalSource } from '@/primitives/decimal';
import type {
  IEffect,
  IEffectInternal,
  GameStateAccessor,
  ResourceEffect,
  FlagEffect,
  StateEffect,
  CompositeEffect,
} from '@/primitives/types';
import { evaluateCondition } from './conditions';
import { gateToCondition, type Gate } from './gate';

// === TYPES ===
/** One concrete effect step, with every formula evaluated, ready to write. */
export interface ResolvedEffect {
  /** The source IEffect's `kind`: `'resource'`, `'flag'` or `'state'`. */
  kind: string;
  /** The id of the resource or flag, or the state path, that the step writes. */
  target: string;
  /** The operation to apply ('add', 'subtract', 'set', etc.). */
  operation: string;
  /** Concrete value after formula evaluation. */
  value: unknown;
}

/** The write side of game state, which applies resolved effects. */
export interface GameStateMutator {
  /** Apply an arithmetic or set operation to a resource by id. */
  applyResourceOp(id: string, op: ResourceEffect['operation'], value: DecimalSource): void;
  /** Set a flag by id to true or false. */
  setFlag(id: string, value: boolean): void;
  /** Write an arbitrary value to a state path (dot-notation or key). */
  setStateAt(path: string, value: unknown): void;
}

// === HELPERS ===
/** Duck-type check for objects with an evaluate() method (Formula, etc.) */
function isEvaluable(v: unknown): v is { evaluate(): DecimalSource } {
  return v != null && typeof v === 'object' && 'evaluate' in v && typeof v.evaluate === 'function';
}

/** A resource effect's amount, with a Formula evaluated now. */
function resolveValue(value: ResourceEffect['value']): DecimalSource {
  return isEvaluable(value) ? value.evaluate() : value;
}

// === RESOLUTION & APPLICATION ===
/**
 * Flatten a declarative {@link IEffectInternal} into a list of concrete
 * {@link ResolvedEffect} steps. Recurses through `composite` and `branch`
 * nodes, evaluating each branch condition through the supplied accessor.
 * Formula values are evaluated at resolution time.
 *
 * Every branch condition and value reads game state as it is when
 * `resolveEffect` runs. So a branch inside a composite doesn't see what the
 * steps before it would write. {@link applyEffect} applies steps in order.
 *
 * Accepts the full internal IR including {@link BranchEffect}; the
 * narrower public {@link IEffect} is a structural subtype and assigns freely.
 */
export function resolveEffect(
  effect: IEffectInternal,
  accessor: GameStateAccessor,
): ResolvedEffect[] {
  switch (effect.kind) {
    case 'resource':
      return [
        {
          kind: 'resource',
          target: effect.target,
          operation: effect.operation,
          value: resolveValue(effect.value),
        },
      ];
    case 'flag':
      return [{ kind: 'flag', target: effect.target, operation: 'set', value: effect.value }];
    case 'state':
      return [{ kind: 'state', target: effect.path, operation: 'set', value: effect.value }];
    case 'composite':
      return effect.effects.flatMap((e) => resolveEffect(e, accessor));
    case 'branch': {
      if (evaluateCondition(effect.condition, accessor))
        return resolveEffect(effect.then, accessor);
      if (effect.else) return resolveEffect(effect.else, accessor);
      return [];
    }
  }
}

/**
 * Apply an effect to game state via the mutator.
 *
 * Steps apply in order. Each composite child, branch and formula value is
 * resolved just before it applies, so it reads what the steps before it
 * wrote.
 */
export function applyEffect(
  effect: IEffectInternal,
  accessor: GameStateAccessor,
  mutator: GameStateMutator,
): void {
  switch (effect.kind) {
    case 'composite':
      for (const child of effect.effects) applyEffect(child, accessor, mutator);
      return;
    case 'branch': {
      const branch = evaluateCondition(effect.condition, accessor) ? effect.then : effect.else;
      if (branch) applyEffect(branch, accessor, mutator);
      return;
    }
    case 'resource':
      mutator.applyResourceOp(effect.target, effect.operation, resolveValue(effect.value));
      return;
    case 'flag':
      mutator.setFlag(effect.target, effect.value);
      return;
    case 'state':
      mutator.setStateAt(effect.path, effect.value);
      return;
  }
}

// === EFFECT BUILDERS ===
/**
 * Ergonomic factories for constructing {@link IEffect} values.
 *
 * Produces plain data objects (no classes, fully serializable). Use in defs
 * to declare completion rewards and costs without closures.
 *
 * @example
 * ```ts
 * import { E } from '@open-loop/engine';
 *
 * const def = {
 *   onFinish: [E.resource('gold', 'add', 100)],
 *   onCost: [E.resource('reputation', 'subtract', 2)],
 * };
 * ```
 */
export const E = {
  resource(
    target: string,
    operation: ResourceEffect['operation'],
    value: DecimalSource | { evaluate(): DecimalSource },
  ): ResourceEffect {
    return { kind: 'resource', target, operation, value };
  },
  flag(target: string, value = true): FlagEffect {
    return { kind: 'flag', target, value };
  },
  state(path: string, value: unknown): StateEffect {
    return { kind: 'state', path: path, value };
  },
  composite(...effects: IEffect[]): CompositeEffect {
    return { kind: 'composite', effects };
  },
  /**
   * Build a branch effect — `then` applies when `gate` holds, and
   * `otherwise` (if provided) applies when it doesn't. The {@link Gate} is
   * projected to the condition IR (`ICondition`) via `gateToCondition` at
   * build time. So the returned effect is fully serializable, and the
   * resolution path stays predictor-friendly.
   *
   * Returns `IEffect` opaquely — the internal `BranchEffect` shape isn't
   * part of the public union. So consumers can't narrow to it, and the
   * public type system never reaches the embedded condition IR.
   *
   * `gate` must read only through the accessor — `resource-gte`, `flag`,
   * `state` and combinators of those. Category-aware kinds (`count-gte`,
   * `active`), `cumulative-gte` and combinators containing them have no
   * condition IR projection, so building the effect throws. For those, block
   * the application in consumer code (build the effect only inside the
   * branch you want), not via `E.branch`.
   */
  branch(gate: Gate, then: IEffect, otherwise?: IEffect): IEffect {
    return {
      kind: 'branch',
      condition: gateToCondition(gate),
      then,
      else: otherwise,
    } as unknown as IEffect;
  },
};
