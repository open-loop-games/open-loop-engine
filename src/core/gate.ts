/**
 * Gate — the typed, serializable yes/no test, as data. The type union and
 * its pure-data projection are in core, so `E.branch` and other core
 * builders can accept a Gate without breaking the one-way imports. The
 * evaluator, predictor, ambient Gate services and requirement adapter are in
 * `systems/gate.ts`, because they read `EngineCategories`, which is in
 * systems.
 *
 * The public API surface reaches this file through `systems/gate.ts`'s re-exports.
 *
 * @cluster gate
 */

import type { DecimalSource } from '@/primitives/decimal';
import type { ICondition, ResourceCondition, StateCondition } from '@/primitives/types';
import type { Computable } from './computed';

// === GATE TYPE UNION ===

/** True when `accessor.getAmount(resource) >= value`. Rate-aware. */
export interface ResourceGteGate {
  kind: 'resource-gte';
  resource: string;
  value: DecimalSource;
}

/**
 * True when `resource.cumulative.value >= value`. Every persistent resource
 * has a `cumulative` ref, so this kind needs no setup.
 * Read through the resource registry, so it has no {@link gateToCondition}
 * projection; `timeUntilGateFlip` predicts it from the resource's inflow rate,
 * falling back to its net rate when the accessor reports no inflow.
 */
export interface CumulativeGteGate {
  kind: 'cumulative-gte';
  resource: string;
  value: DecimalSource;
}

/**
 * True when the category entry's `count` signal is `>= value`. Reads through
 * `CategoryEntrySignals`, so the one kind covers Purchasable.count,
 * Producer.count, Skill.level, Achievement.earned and Challenge.completions.
 */
export interface CountGteGate {
  kind: 'count-gte';
  category: string;
  entry: string;
  value: DecimalSource;
}

/**
 * True when the category entry's `active` signal is true. Reads through
 * `CategoryEntrySignals` like `count-gte`, so it needs no consumer-side path
 * conventions.
 */
export interface ActiveGate {
  kind: 'active';
  category: string;
  entry: string;
}

/**
 * True when the comparison `accessor.getStateAt(path) <op> value` holds. Mirrors
 * `StateCondition` — same operators, same coercion rules.
 * The state-path escape hatch, for tests the typed kinds don't cover. The
 * engine doesn't define what a state path means.
 */
export interface StateGate {
  kind: 'state';
  path: string;
  operator: StateCondition['operator'];
  value: unknown;
}

/**
 * True when `accessor.getFlag(id)` returns true. The escape hatch for
 * progression flags the engine doesn't model as category entries
 * (knowledge-discovery ids, UI-panel reveals, info-reveals). Peer to
 * {@link StateGate} for flags — projects 1:1 to `FlagCondition` via
 * {@link gateToCondition}. Predictor-opaque, as a flag is in the condition IR.
 *
 * Use the category-aware {@link ActiveGate} when the test reads a registered
 * category entry — that path gets introspection from
 * `CategoryEntrySignals`. Use this when the flag is a consumer-side
 * progression flag with no category structure.
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
 * The typed, serializable yes/no test. Keyed by string ids, which the
 * engine's registries look up; category-aware; predictable for rate-aware kinds.
 *
 * Authored as plain data in defs. Evaluated through `evaluateGate` (in
 * systems), or projected to `ICondition`, the condition IR, via
 * {@link gateToCondition}.
 */
export type Gate =
  | ResourceGteGate
  | CumulativeGteGate
  | CountGteGate
  | ActiveGate
  | StateGate
  | FlagGate
  | AllGate
  | AnyGate
  | NotGate;

/**
 * A yes/no test in any authoring form. It is a constant, a ref or getter over
 * state in reach, or a {@link Gate} the engine can introspect and predict.
 * Predicate fields in systems take this. Only systems can evaluate the Gate
 * arm, so core fields stay `Computable<boolean>`.
 */
export type Predicate = Computable<boolean> | Gate;

// === GUARDS / PROJECTIONS ===

/**
 * Type guard for {@link Gate}. Discriminates a Gate object from
 * `Computable<boolean>` (boolean / Ref / getter). An `ICondition` shares
 * several `kind` values, so this guard cannot tell the two apart; only a
 * {@link Predicate} reaches it, and an `ICondition` is never one.
 *
 * Used by adoption sites that accept {@link Predicate} fields to dispatch on
 * the Gate arm before falling through to the computable branch.
 */
export function isGate(value: unknown): value is Gate {
  if (value === null || typeof value !== 'object') return false;
  if (typeof (value as { kind?: unknown }).kind !== 'string') return false;
  switch ((value as { kind: string }).kind) {
    case 'resource-gte':
    case 'cumulative-gte':
    case 'count-gte':
    case 'active':
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
 * A Gate service: a named engine service a Gate kind reads. Named here
 * rather than in `systems/gate.ts`, so the pure walker below can stay in
 * core. `GateServices` keys off this union.
 */
export type GateService = 'accessor' | 'categories' | 'resourceRegistry';

/**
 * The Gate services that evaluating `gate` reads. Pure data → data;
 * combinators union their children.
 *
 * The Gate services a Gate needs are a function of its kinds, not of the
 * union as a whole. Category-aware kinds (`count-gte`, `active`) read only
 * `EngineCategories` and never an accessor. So a consumer whose Gates are
 * all category kinds needs no `GameStateAccessor` at all. Adoption sites
 * that hold the Gate at construction call this to fail early and precisely,
 * instead of requiring every Gate service up front.
 *
 * These are the Gate services `evaluateGate` reads. For `cumulative-gte`,
 * `timeUntilGateFlip` also reads the resource's rate through the accessor,
 * and requires it when it runs.
 */
export function getRequiredGateServices(gate: Gate): ReadonlySet<GateService> {
  const out = new Set<GateService>();
  forEachGateLeaf(gate, (leaf) => {
    switch (leaf.kind) {
      case 'resource-gte':
      case 'state':
      case 'flag':
        out.add('accessor');
        return;
      case 'cumulative-gte':
        out.add('resourceRegistry');
        return;
      case 'count-gte':
      case 'active':
        out.add('categories');
        return;
    }
  });
  return out;
}

/**
 * Visit every non-combinator Gate under `gate`, depth-first, for walkers that
 * collect per leaf. Walkers that combine their children's answers
 * (evaluation, prediction) keep their own recursion.
 *
 * @internal
 */
export function forEachGateLeaf(
  gate: Gate,
  visit: (leaf: Exclude<Gate, AllGate | AnyGate | NotGate>) => void,
): void {
  switch (gate.kind) {
    case 'all':
    case 'any':
      for (const child of gate.of) forEachGateLeaf(child, visit);
      return;
    case 'not':
      forEachGateLeaf(gate.of, visit);
      return;
    default:
      visit(gate);
  }
}

/**
 * Project a Gate AST to {@link ICondition}, the condition IR. Pure data →
 * data; no Gate services needed. Accessor-backed kinds map directly;
 * combinators recurse.
 *
 * **Throws on kinds the condition IR can't read**: the category kinds
 * (`count-gte`, `active`) and `cumulative-gte`, whose value is on the
 * registered resource rather than behind the accessor. It also throws on
 * combinators with any such descendant. The projection is partial by design: a
 * synthetic-path encoding would hand the consumer's accessor an id it
 * doesn't serve.
 *
 * `E.branch` embeds the projection, so an unprojectable Gate fails when
 * the effect is built. Predictors read every kind through `timeUntilGateFlip`.
 *
 * @internal
 */
export function gateToCondition(gate: Gate): ICondition {
  switch (gate.kind) {
    case 'resource-gte':
      return { kind: 'resource', target: gate.resource, operator: 'gte', value: gate.value };
    case 'state':
      return { kind: 'state', path: gate.path, operator: gate.operator, value: gate.value };
    case 'flag':
      return { kind: 'flag', target: gate.id };
    case 'all':
      return { kind: 'all', conditions: gate.of.map(gateToCondition) };
    case 'any':
      return { kind: 'any', conditions: gate.of.map(gateToCondition) };
    case 'not':
      return { kind: 'not', condition: gateToCondition(gate.of) };
    case 'count-gte':
    case 'active':
    case 'cumulative-gte':
      throw new Error(
        `gateToCondition: ${gate.kind} has no ICondition projection (it evaluates only through evaluateGate and its Gate services).`,
      );
  }
}

// `ResourceCondition` is re-imported here so the systems barrel can
// type-check the rate-aware projection without circular imports.
export type { ResourceCondition };
