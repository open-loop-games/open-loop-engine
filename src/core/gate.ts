/**
 * Gate — typed predicate-spec data shape. Type union and pure-data projection
 * live at core layer so `E.conditional` and other core-layer builders can
 * accept Gate without a layer violation. The runtime side (evaluator,
 * predictor, ambient-runtime resolution, requirement adapter) lives in
 * `systems/gate.ts` — it depends on EngineCategories and ResourceRegistry,
 * which are systems-layer concerns.
 *
 * The public surface re-exports everything from `systems/gate.ts`.
 *
 * @cluster gate
 */

import type { DecimalSource } from '@/primitives/decimal';
import type { ICondition, ResourceCondition, StateCondition } from '@/primitives/types';

// === GATE TYPE UNION ===

/** True when `accessor.getResource(resource) >= value`. Rate-aware. */
export interface ResourceGteGate {
  kind: 'resource-gte';
  resource: string;
  value: DecimalSource;
}

/**
 * True when `resource.cumulative.value >= value`. Rate-aware via the
 * underlying cumulative ref (cumulative accumulates strictly; flip distance
 * equals the canonical resource-gte distance over the cumulative ref). The
 * `cumulative` slot is intrinsic to every persistent resource, so no
 * tracker setup is required.
 */
export interface CumulativeGteGate {
  kind: 'cumulative-gte';
  resource: string;
  value: DecimalSource;
}

/**
 * True when the entity's `count` signal is `>= value`. Reads through
 * `CategoryEntrySignals` so the same kind covers Purchasable.amount,
 * Producer.count, Skill.level, Achievement.earned, Challenge.completions
 * uniformly.
 */
export interface CountGteGate {
  kind: 'count-gte';
  category: string;
  entity: string;
  value: DecimalSource;
}

/**
 * True when the entity's `unlock` signal is true. Same `CategoryEntrySignals`
 * cross-cut as `count-gte` — "is this entity active / owned / earned" without
 * consumer-side path conventions.
 */
export interface UnlockGate {
  kind: 'unlock';
  category: string;
  entity: string;
}

/**
 * True when the comparison `accessor.getState(key) <op> value` holds. Mirrors
 * `StateCondition` — same operator vocabulary, same coercion rules.
 * Consumer-supplied state-path escape hatch for predicates the typed kinds
 * don't cover (engine doesn't define what state paths mean).
 */
export interface StateGate {
  kind: 'state';
  key: string;
  operator: StateCondition['operator'];
  value: unknown;
}

/**
 * True when `accessor.isUnlocked(id)` returns true. Escape hatch for
 * progression flags the engine doesn't model as category entries
 * (knowledge-discovery IDs, UI-panel reveals, info-reveals). Peer to
 * {@link StateGate} for the unlock namespace — projects 1:1 to
 * `UnlockCondition` via {@link gateToCondition}. Predictor-opaque,
 * matching how flat unlocks already behave at the ICondition layer.
 *
 * Use the category-aware {@link UnlockGate} when the unlock you're gating
 * on *is* a registered category entry — that path gets
 * `CategoryEntrySignals`-backed introspection. Use this when the
 * unlock is a consumer-side progression flag with no category structure.
 */
export interface FlagGate {
  kind: 'flag';
  id: string;
}

/** True when every child Gate is true. Short-circuits on first false. */
export interface AllGate {
  kind: 'all';
  of: Gate[];
}

/** True when at least one child Gate is true. Short-circuits on first true. */
export interface AnyGate {
  kind: 'any';
  of: Gate[];
}

/** True when the wrapped Gate is false. */
export interface NotGate {
  kind: 'not';
  of: Gate;
}

/**
 * Typed declarative predicate spec. String-id-keyed (resolved through engine
 * registries), category-aware, predictor-friendly for rate-aware kinds.
 *
 * Authored as plain data in content definitions; evaluated through
 * `evaluateGate` (systems-layer) or projected to `ICondition` (the internal
 * IR) via {@link gateToCondition}.
 */
export type Gate =
  | ResourceGteGate
  | CumulativeGteGate
  | CountGteGate
  | UnlockGate
  | StateGate
  | FlagGate
  | AllGate
  | AnyGate
  | NotGate;

// === GUARDS / PROJECTIONS ===

/**
 * Type guard for {@link Gate}. Discriminates a Gate object from
 * `Computable<boolean>` (boolean / Ref / getter) and from `ICondition`
 * (which has a `type` discriminant, not `kind`).
 *
 * Used by adoption sites that accept `Computable<boolean> | Gate` union
 * fields to dispatch on the Gate arm before falling through to the
 * computable branch.
 */
export function isGate(value: unknown): value is Gate {
  if (value === null || typeof value !== 'object') return false;
  if (typeof (value as { kind?: unknown }).kind !== 'string') return false;
  switch ((value as { kind: string }).kind) {
    case 'resource-gte':
    case 'cumulative-gte':
    case 'count-gte':
    case 'unlock':
    case 'state':
    case 'flag':
    case 'all':
    case 'any':
    case 'not':
      return true;
    default:
      return false;
  }
}

/**
 * Project a Gate AST to {@link ICondition}. Pure data → data; no runtime
 * needed. Rate-aware kinds map directly; combinators recurse.
 *
 * **Throws on category kinds** (`count-gte`, `unlock`) and on combinators
 * with any category descendant. The projection is partial by design — there
 * is no `ICondition` equivalent for category-aware predicates, and a
 * synthetic-path encoding would just relocate the consumer-side tax Gate is
 * meant to retire.
 *
 * Used internally by walkers and the predictor that operate on the
 * ICondition IR: for rate-aware Gate fields the projection is the bridge;
 * for fields that mix rate-aware and category leaves, the walker degrades
 * to opaque-predicate semantics on the throw and treats the Gate as it
 * would any other non-projectable predicate.
 *
 * @internal
 */
export function gateToCondition(gate: Gate): ICondition {
  switch (gate.kind) {
    case 'resource-gte':
      return { type: 'resource', target: gate.resource, operator: 'gte', value: gate.value };
    case 'cumulative-gte':
      return {
        type: 'resource',
        target: `${gate.resource}:cumulative`,
        operator: 'gte',
        value: gate.value,
      };
    case 'state':
      return { type: 'state', target: gate.key, operator: gate.operator, value: gate.value };
    case 'flag':
      return { type: 'unlock', target: gate.id };
    case 'all':
      return { type: 'and', conditions: gate.of.map(gateToCondition) };
    case 'any':
      return { type: 'or', conditions: gate.of.map(gateToCondition) };
    case 'not':
      return { type: 'not', condition: gateToCondition(gate.of) };
    case 'count-gte':
    case 'unlock':
      throw new Error(
        `gateToCondition: ${gate.kind} has no ICondition projection (category-aware kinds only resolve through GateRuntime).`,
      );
  }
}

// `ResourceCondition` is re-imported here so the systems-layer barrel can
// type-check the rate-aware projection without circular imports.
export type { ResourceCondition };
