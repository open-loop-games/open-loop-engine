/**
 * Effects — declarative game-state mutations from `IEffect` ASTs
 */

import type { DecimalSource } from '@/primitives/decimal';
import type {
  ICondition,
  IEffect,
  GameStateAccessor,
  ResourceEffect,
  UnlockEffect,
  StateEffect,
  CompositeEffect,
  ConditionalEffect,
} from '@/primitives/types';
import { evaluateCondition } from './conditions';

// === TYPES ===
/** A fully resolved effect with all formulas evaluated — ready for mutation. */
export interface ResolvedEffect {
  /** Discriminant matching the source IEffect type ('resource', 'unlock', 'state'). */
  type: string;
  /** ID of the resource, flag, or state path being mutated. */
  target: string;
  /** The operation to apply ('add', 'subtract', 'set', etc.). */
  operation: string;
  /** Concrete value after formula evaluation. */
  value: unknown;
}

/** Mutation interface for applying resolved effects to game state. */
export interface GameStateMutator {
  /** Apply an arithmetic or set operation to a resource by ID. */
  applyResourceOp(id: string, op: ResourceEffect['operation'], value: DecimalSource): void;
  /** Set an unlock flag (feature gate) by ID to true or false. */
  setUnlocked(id: string, value: boolean): void;
  /** Write an arbitrary value to a state path (dot-notation or key). */
  setState(path: string, value: unknown): void;
}

// === HELPERS ===
/** Duck-type check for objects with an evaluate() method (Formula, etc.) */
function isEvaluable(v: unknown): v is { evaluate(): DecimalSource } {
  return (
    v != null &&
    typeof v === 'object' &&
    'evaluate' in v &&
    typeof (v as { evaluate: unknown }).evaluate === 'function'
  );
}

// === RESOLUTION & APPLICATION ===
/**
 * Flatten a declarative {@link IEffect} into a list of concrete
 * {@link ResolvedEffect} steps. Recurses through `composite` and `conditional`
 * nodes (evaluating gates via the supplied accessor); evaluates
 * {@link Evaluable} value sources at resolution time.
 */
export function resolveEffect(effect: IEffect, accessor: GameStateAccessor): ResolvedEffect[] {
  switch (effect.type) {
    case 'resource':
      return [
        {
          type: 'resource',
          target: effect.target,
          operation: effect.operation,
          value: isEvaluable(effect.value) ? effect.value.evaluate() : effect.value,
        },
      ];
    case 'unlock':
      return [{ type: 'unlock', target: effect.target, operation: 'set', value: effect.value }];
    case 'state':
      return [{ type: 'state', target: effect.target, operation: 'set', value: effect.value }];
    case 'composite':
      return effect.effects.flatMap((e) => resolveEffect(e, accessor));
    case 'conditional': {
      if (evaluateCondition(effect.condition, accessor))
        return resolveEffect(effect.then, accessor);
      if (effect.else) return resolveEffect(effect.else, accessor);
      return [];
    }
  }
}

/**
 * Resolve an effect and apply it to game state via the mutator.
 *
 * Layers cleanly: `resolveEffect` handles structural recursion (composite,
 * conditional) and formula evaluation → `ResolvedEffect[]` with concrete values.
 * `applyEffect` handles mutation via the mutator interface.
 */
export function applyEffect(
  effect: IEffect,
  accessor: GameStateAccessor,
  mutator: GameStateMutator,
): void {
  const resolved = resolveEffect(effect, accessor);
  for (const r of resolved) {
    switch (r.type) {
      case 'resource':
        mutator.applyResourceOp(
          r.target,
          r.operation as ResourceEffect['operation'],
          r.value as DecimalSource,
        );
        break;
      case 'unlock':
        mutator.setUnlocked(r.target, r.value as boolean);
        break;
      case 'state':
        mutator.setState(r.target, r.value);
        break;
    }
  }
}

// === EFFECT BUILDERS ===
/**
 * Ergonomic factories for constructing {@link IEffect} values.
 *
 * Produces plain data objects (no classes, fully serializable). Use in content
 * definitions to declare completion rewards and costs without closures.
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
    return { type: 'resource', target, operation, value };
  },
  unlock(target: string, value = true): UnlockEffect {
    return { type: 'unlock', target, value };
  },
  state(target: string, value: unknown): StateEffect {
    return { type: 'state', target, value };
  },
  composite(...effects: IEffect[]): CompositeEffect {
    return { type: 'composite', effects };
  },
  conditional(condition: ICondition, then: IEffect, otherwise?: IEffect): ConditionalEffect {
    return { type: 'conditional', condition, then, else: otherwise };
  },
};
