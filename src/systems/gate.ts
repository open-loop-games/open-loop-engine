/**
 * Gate — consumer-facing predicate-spec data shape over the engine's existing
 * substrate. Cross-cuts every requirement-bearing field where today consumers
 * either reach for `C.*` (exposes engine-internal vocabulary) or fall back to
 * opaque `Computable<boolean>` closures (loses predictor introspection).
 *
 * Gate composes four pieces that already exist independently:
 * - `ICondition` + {@link evaluateCondition} / {@link timeUntilConditionFlip} —
 *   rate-aware leaves project to this substrate; predictor reuses it directly.
 * - {@link CategoryEntrySignals} via {@link findCategoryEntrySignals} — the
 *   uniform per-entry introspection axes shipped by every category factory.
 *   Gate's `count-gte` and `unlock` kinds read through it; no consumer-side
 *   path conventions, no synthetic state-paths.
 * - {@link ResourceRegistry} via `findById(...).cumulative` — `cumulative-gte`
 *   reads the resource's intrinsic cumulative-gain accumulator slot.
 * - {@link GameStateAccessor} — `state` kind delegates here (consumer-supplied
 *   path/value semantics, mirrors `StateCondition`).
 *
 * Per-kind dispatch:
 *
 * | Kind           | Evaluator                                           | Predictor                                |
 * |----------------|-----------------------------------------------------|------------------------------------------|
 * | resource-gte   | accessor.getResource(id) >= value                   | timeUntilConditionFlip over projection   |
 * | cumulative-gte | registry.findById(id).cumulative.value >= value     | same as resource-gte over cumulative ref |
 * | count-gte      | findCategoryEntrySignals(...).count >= value        | 'opaque-predicate'                       |
 * | unlock         | findCategoryEntrySignals(...).unlock                | 'opaque-predicate'                       |
 * | flag           | accessor.isUnlocked(id)                             | 'opaque-predicate'                       |
 * | state          | compareState(accessor.getState(...), op, val)       | 'opaque-predicate'                       |
 * | all/any/not    | recurse                                             | combineFlipDistances over Gate children  |
 *
 * `gateToCondition` partial-projects rate-aware Gates (and their combinators)
 * to `ICondition` for legacy interop — predictor reuse, walker compatibility,
 * Producer's `specToICondition` retirement. Throws on category descendants:
 * those have no `ICondition` equivalent under (D) and the projection is
 * deliberately partial.
 */

import { computed } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import type {
  ICondition,
  ResourceCondition,
  GameStateAccessor,
  StateCondition,
} from '@/primitives/types';
import { compareState } from '@/core/conditions';
import { type Computable } from '@/core/computed';
import {
  combineFlipDistances,
  timeUntilConditionFlip,
  type ChildFlipResult,
  type TransitionDistance,
} from '@/core/transitions';
import { getCurrentGameStateAccessor } from '@/core/game-state-accessor';
import { getCurrentResourceRegistry, type ResourceRegistry } from '@/core/registries';
import { createBooleanRequirement, type Requirement } from '@/core/requirements';
import {
  findCategoryEntrySignals,
  getCurrentEngineCategories,
  type EngineCategories,
} from './engine-categories';

// === TYPES ===

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
 * {@link CategoryEntrySignals} so the same kind covers Purchasable.amount,
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
 * {@link StateCondition} — same operator vocabulary, same coercion rules.
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
 * {@link UnlockCondition} via {@link gateToCondition}. Predictor-opaque,
 * matching how flat unlocks already behave at the ICondition layer.
 *
 * Use the category-aware {@link UnlockGate} when the unlock you're gating
 * on *is* a registered category entry — that path gets
 * {@link CategoryEntrySignals}-backed introspection. Use this when the
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
 * {@link evaluateGate} or projected to `ICondition` via {@link gateToCondition}.
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

/**
 * The three engine handles {@link evaluateGate} and {@link timeUntilGateFlip}
 * need at runtime. Adoption sites typically build one via
 * {@link getAmbientGateRuntime} during a factory's install/connect call and
 * close over it for evaluation. The plain-data bundle is also useful for tests
 * (construct directly to drive `evaluateGate` without standing up an engine)
 * and for partial overrides in factory options.
 *
 * Not auto-published under an injection key — the bundle is composition glue,
 * not a singleton.
 */
export interface GateRuntime {
  accessor: GameStateAccessor;
  categories: EngineCategories;
  registry: ResourceRegistry;
}

/**
 * Resolve the three ambient handles into a {@link GateRuntime} bundle.
 *
 * Reads from `getCurrentGameStateAccessor()` / `getCurrentEngineCategories()` /
 * `getCurrentResourceRegistry()` — the same install-time ambient triple every
 * other category factory already uses. Each piece can be overridden via
 * `override` for tests or for callers that want to thread a non-ambient
 * accessor (mirrors the option-then-ambient shape of `createChallengeCategory`).
 *
 * Throws when any of the three is missing — Gate evaluation requires all three
 * and silent-undefined would be a footgun. Call inside an engine
 * `install()` / `connect()` (where the ambient triple is wired by `createEngine`)
 * or pass explicit overrides.
 */
export function getAmbientGateRuntime(override?: Partial<GateRuntime>): GateRuntime {
  const accessor = override?.accessor ?? getCurrentGameStateAccessor();
  const categories = override?.categories ?? getCurrentEngineCategories();
  const registry = override?.registry ?? getCurrentResourceRegistry();
  if (!accessor || !categories || !registry) {
    const missing: string[] = [];
    if (!accessor) missing.push('accessor');
    if (!categories) missing.push('categories');
    if (!registry) missing.push('registry');
    throw new Error(
      `getAmbientGateRuntime: missing ambient ${missing.join(', ')}. Call inside engine install/connect, or pass explicit overrides.`,
    );
  }
  return { accessor, categories, registry };
}

/**
 * Type guard for {@link Gate}. Discriminates a Gate object from
 * `Computable<boolean>` (boolean / Ref / getter) and from {@link ICondition}
 * (which has a `type` discriminant, not `kind`).
 *
 * Used by adoption sites that accept `Computable<boolean> | ICondition | Gate`
 * union fields to dispatch on the Gate arm before falling through to the
 * existing computable / condition branches.
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

// === EVALUATOR ===

/**
 * Resolve a Gate to its current truth value against the engine's live state.
 *
 * @throws when a `cumulative-gte` references a resource id that's not
 *   registered in the resource registry. Loud-fail catches the authoring
 *   error at first evaluation rather than silently returning `false`.
 *
 * @example
 * ```ts
 * // Inside a factory called from engine install/connect:
 * const runtime = getAmbientGateRuntime();
 * const earned = computed(() =>
 *   evaluateGate({ kind: 'count-gte', category: 'jobs', entity: 'beggar', value: 10 }, runtime)
 * );
 * ```
 */
export function evaluateGate(gate: Gate, runtime: GateRuntime): boolean {
  switch (gate.kind) {
    case 'resource-gte':
      return Decimal.gte(runtime.accessor.getResource(gate.resource), gate.value);
    case 'cumulative-gte': {
      const ref = cumulativeRefFor(gate.resource, runtime);
      return Decimal.gte(ref.value, gate.value);
    }
    case 'count-gte': {
      const signals = findCategoryEntrySignals(runtime.categories, gate.category, gate.entity);
      if (!signals) return false;
      return Decimal.gte(signals.count.value, gate.value);
    }
    case 'unlock': {
      const signals = findCategoryEntrySignals(runtime.categories, gate.category, gate.entity);
      return signals?.unlock.value ?? false;
    }
    case 'state':
      return compareState(runtime.accessor.getState(gate.key), gate.operator, gate.value);
    case 'flag':
      return runtime.accessor.isUnlocked(gate.id);
    case 'all':
      return gate.of.every((g) => evaluateGate(g, runtime));
    case 'any':
      return gate.of.some((g) => evaluateGate(g, runtime));
    case 'not':
      return !evaluateGate(gate.of, runtime);
  }
}

// === PREDICTOR ===

/**
 * Distance until `gate` flips truth value at current rates. Per-kind dispatch:
 *
 * - `resource-gte` / `cumulative-gte` — projects to `ResourceCondition` and
 *   delegates to {@link timeUntilConditionFlip}, which owns the rate × operator
 *   truth table.
 * - `count-gte` / `unlock` / `state` — `'opaque-predicate'`. Category counts
 *   advance imperatively (purchases, achievement firings); `state` is a
 *   consumer-write surface. Neither has a mechanical distance.
 * - `all` / `any` / `not` — builds `{ currentlyTrue, distance }` per child via
 *   {@link evaluateGate} + recursive {@link timeUntilGateFlip}, then delegates
 *   to {@link combineFlipDistances} for the combinator truth-table dispatch.
 */
export function timeUntilGateFlip(gate: Gate, runtime: GateRuntime): TransitionDistance {
  switch (gate.kind) {
    case 'resource-gte':
      return timeUntilConditionFlip(
        { type: 'resource', target: gate.resource, operator: 'gte', value: gate.value },
        runtime.accessor,
      );
    case 'cumulative-gte': {
      // Cumulative is monotone-increasing; flip distance equals canonical
      // resource-gte distance over the underlying ref read through a synthetic
      // accessor that supplies the cumulative ref's value/rate.
      const ref = cumulativeRefFor(gate.resource, runtime);
      const cumulativeId = `${gate.resource}:cumulative`;
      const projected: ResourceCondition = {
        type: 'resource',
        target: cumulativeId,
        operator: 'gte',
        value: gate.value,
      };
      const cumulativeAccessor: GameStateAccessor = {
        getResource: (id) =>
          id === cumulativeId ? new Decimal(ref.value) : runtime.accessor.getResource(id),
        getRate: (id) => runtime.accessor.getRate(id === cumulativeId ? gate.resource : id),
        isUnlocked: (id) => runtime.accessor.isUnlocked(id),
        getState: (path) => runtime.accessor.getState(path),
      };
      return timeUntilConditionFlip(projected, cumulativeAccessor);
    }
    case 'count-gte':
    case 'unlock':
    case 'state':
    case 'flag':
      return { seconds: null, reason: 'opaque-predicate' };
    case 'all':
    case 'any':
    case 'not':
      return combinatorFlip(gate, runtime);
  }
}

function combinatorFlip(
  gate: AllGate | AnyGate | NotGate,
  runtime: GateRuntime,
): TransitionDistance {
  if (gate.kind === 'not') {
    return timeUntilGateFlip(gate.of, runtime);
  }
  const children: ChildFlipResult[] = gate.of.map((child) => ({
    currentlyTrue: evaluateGate(child, runtime),
    distance: timeUntilGateFlip(child, runtime),
  }));
  return combineFlipDistances(children, gate.kind === 'all' ? 'and' : 'or');
}

// === PROJECTION ===

/**
 * Project a Gate AST to {@link ICondition}. Pure data → data; no runtime
 * needed. Rate-aware kinds map directly; combinators recurse.
 *
 * **Throws on category kinds** (`count-gte`, `unlock`) and on combinators
 * with any category descendant. The projection is partial by design — under
 * (D) there is no `ICondition` equivalent for category-aware predicates,
 * and a synthetic-path encoding would just relocate the consumer-side tax
 * Gate is meant to retire.
 *
 * Used by walkers and consumer surfaces that today only speak `ICondition`:
 * for rate-aware Gate fields the projection is the bridge; for fields that
 * mix rate-aware and category leaves, the walker degrades to opaque-predicate
 * semantics on the throw and treats the Gate as it would any other
 * non-projectable predicate.
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

// === REQUIREMENT ADAPTER ===

/** Options for {@link createGateRequirement}. */
export interface GateRequirementOptions {
  /** Predicate spec; resolved through the ambient runtime captured at call time. */
  gate: Gate;
  /** Optional UI-facing description (passed through to the underlying boolean requirement). */
  description?: Computable<string>;
}

/**
 * Build a {@link Requirement} that's met whenever its {@link Gate} evaluates
 * truthy. Systems-layer counterpart to `createBooleanRequirement` for the
 * declarative-Gate authoring path — drops into `purchasable.requirements`
 * arrays alongside cost requirements without consumer-side closures.
 *
 * Resolves the {@link GateRuntime} eagerly via {@link getAmbientGateRuntime},
 * so call inside an engine `install()` / `connect()`. The returned
 * Requirement is layer-clean (a plain core-layer `Requirement` shape) — it's
 * the *factory* that lives at systems-layer because Gate composes
 * `CategoryEntrySignals` and friends.
 *
 * @example
 * ```ts
 * upgrades.register({
 *   id: 'fast-mode',
 *   requirements: [
 *     createCostRequirement({ resource: gold, cost: 100 }),
 *     createGateRequirement({
 *       gate: { kind: 'count-gte', category: 'producers', entity: 'farm', value: 5 },
 *       description: '5 farms owned',
 *     }),
 *   ],
 * });
 * ```
 */
export function createGateRequirement(options: GateRequirementOptions): Requirement {
  const { gate, description } = options;
  const runtime = getAmbientGateRuntime();
  return createBooleanRequirement({
    requirement: computed(() => evaluateGate(gate, runtime)),
    description,
  });
}

// === PRIVATE ===

function cumulativeRefFor(resourceId: string, runtime: GateRuntime) {
  const resource = runtime.registry.findById(resourceId);
  if (!resource) {
    throw new Error(`Gate cumulative-gte: no resource '${resourceId}' registered`);
  }
  // The cumulative slot is intrinsic to every persistent resource — created
  // by createResource. A missing slot means the resource was created via the
  // ref-wrapping overload (derived/computed), which can't host trackers.
  if (!resource.cumulative) {
    throw new Error(
      `Gate cumulative-gte: resource '${resourceId}' was created from an existing ref and has no cumulative slot`,
    );
  }
  return resource.cumulative;
}
