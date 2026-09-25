/**
 * Effects — declarative game-state mutations from `IEffect` ASTs
 */

import type { DecimalSource } from '@/primitives/decimal';
import type {
  IEffect,
  IEffectInternal,
  GameStateAccessor,
  ResourceEffect,
  UnlockEffect,
  StateEffect,
  CompositeEffect,
} from '@/primitives/types';
import { evaluateCondition } from './conditions';
import { gateToCondition, type Gate } from './gate';

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
  return v != null && typeof v === 'object' && 'evaluate' in v && typeof v.evaluate === 'function';
}

// === RESOLUTION & APPLICATION ===
/**
 * Flatten a declarative {@link IEffectInternal} into a list of concrete
 * {@link ResolvedEffect} steps. Recurses through `composite` and `conditional`
 * nodes (evaluating gates via the supplied accessor); evaluates
 * {@link Evaluable} value sources at resolution time.
 *
 * Every condition and value reads the state as it is when `resolveEffect`
 * runs, so a conditional inside a composite doesn't see what the steps
 * before it would write. {@link applyEffect} is the one that applies steps
 * in order.
 *
 * Accepts the full internal IR including {@link ConditionalEffect}; the
 * narrower public {@link IEffect} is a structural subtype and assigns freely.
 */
export function resolveEffect(
  effect: IEffectInternal,
  accessor: GameStateAccessor,
): ResolvedEffect[] {
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
 * Apply an effect to game state via the mutator.
 *
 * Steps apply in order: each composite child, conditional and formula value
 * is resolved just before it applies, so it reads what the steps before it
 * wrote. Leaves resolve through {@link resolveEffect}.
 */
export function applyEffect(
  effect: IEffectInternal,
  accessor: GameStateAccessor,
  mutator: GameStateMutator,
): void {
  switch (effect.type) {
    case 'composite':
      for (const child of effect.effects) applyEffect(child, accessor, mutator);
      return;
    case 'conditional': {
      const branch = evaluateCondition(effect.condition, accessor) ? effect.then : effect.else;
      if (branch) applyEffect(branch, accessor, mutator);
      return;
    }
  }
  for (const r of resolveEffect(effect, accessor)) {
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
  /**
   * Build a conditional effect — `then` applies when `gate` evaluates true,
   * `otherwise` (if provided) applies when false. The {@link Gate} is
   * projected to the internal `ICondition` IR via `gateToCondition` at build
   * time, so the returned effect is fully serializable and the resolution
   * path stays predictor-friendly.
   *
   * Returns `IEffect` opaquely — the internal `ConditionalEffect` shape isn't
   * part of the public union, so consumers can't narrow to it and the
   * embedded ICondition stays unreachable through the public type system.
   *
   * `gate` must read only through the accessor — `resource-gte`, `flag`,
   * `state` and combinators of those. Category-aware kinds (`count-gte`,
   * `unlock`), `cumulative-gte` and combinators containing them have no
   * `ICondition` projection, so building the effect throws. For those, gate
   * the application at the consumer (only build the effect inside the branch
   * you want), not via `E.conditional`.
   */
  conditional(gate: Gate, then: IEffect, otherwise?: IEffect): IEffect {
    return {
      type: 'conditional',
      condition: gateToCondition(gate),
      then,
      else: otherwise,
    } as unknown as IEffect;
  },
};
