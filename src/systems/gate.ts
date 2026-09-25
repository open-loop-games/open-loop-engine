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
 * | cumulative-gte | registry.findById(id).cumulative.value >= value     | gap in the cumulative total ÷ inflow     |
 * | count-gte      | findCategoryEntrySignals(...).count >= value        | 'opaque-predicate'                       |
 * | unlock         | findCategoryEntrySignals(...).unlock                | 'opaque-predicate'                       |
 * | flag           | accessor.isUnlocked(id)                             | 'opaque-predicate'                       |
 * | state          | compareState(accessor.getState(...), op, val)       | 'opaque-predicate'                       |
 * | all/any/not    | recurse                                             | combineFlipDistances over Gate children  |
 *
 * `gateToCondition` partial-projects accessor-backed Gates (and their
 * combinators) to `ICondition`, the serializable IR `E.conditional` embeds.
 * Throws on category descendants and on `cumulative-gte`, whose values live
 * behind the categories and the registry rather than the accessor.
 * Predictors read every kind through {@link timeUntilGateFlip} instead.
 *
 * Predicate fields — where a Gate is one authoring form among several:
 * - Systems-layer predicate fields take {@link Predicate} (a boolean, ref,
 *   getter or Gate) and adopt it through a {@link PredicateResolver} the
 *   system builds once, at construction. A Gate's handles are asserted when
 *   the definition registers, so an unwired accessor fails at the authoring
 *   site rather than at first evaluation.
 * - Core-layer fields stay `Computable<boolean>`: core can name a Gate but
 *   cannot evaluate one.
 * - Dialog `condition` fields stay Gate-only, since a dialog graph is pure
 *   data; the runtime asserts their handles when it's built.
 * - The `requirement` an achievement category synthesizes for a tiered
 *   achievement stays a closure; the engine builds it, no author writes it.
 */

import { computed, unref, type ComputedRef } from 'vue';
import { Decimal } from '@/primitives/decimal';
import type { GameStateAccessor } from '@/primitives/types';
import { compareState } from '@/core/conditions';
import { processGetter, resolveComputable, type Computable } from '@/core/computed';
import {
  combineFlipDistances,
  secondsToCover,
  timeUntilConditionFlip,
  type ChildFlipResult,
  type TransitionDeps,
  type TransitionDistance,
} from '@/core/transitions';
import { getCurrentGameStateAccessor } from '@/core/game-state-accessor';
import { getCurrentResourceRegistry, type ResourceRegistry } from '@/core/registries';
import { createBooleanRequirement, type Requirement } from '@/core/requirements';
import {
  forEachGateLeaf,
  getRequiredGateHandles,
  isGate,
  type AllGate,
  type AnyGate,
  type CumulativeGteGate,
  type Gate,
  type GateHandle,
  type NotGate,
  type Predicate,
} from '@/core/gate';
import {
  findCategoryEntrySignals,
  getCurrentEngineCategories,
  type EngineCategories,
} from './engine-categories';

// === TYPE RE-EXPORTS ===
// Gate's pure-data shape (variant interfaces + Gate union + projection +
// type guard) lives in core/gate.ts so core-layer builders can accept Gate
// without a layer violation. Re-exported here so the public surface stays
// a single import path.
export type {
  ResourceGteGate,
  CumulativeGteGate,
  CountGteGate,
  UnlockGate,
  StateGate,
  FlagGate,
  AllGate,
  AnyGate,
  NotGate,
  Gate,
  GateHandle,
  Predicate,
} from '@/core/gate';
export { isGate, gateToCondition, getRequiredGateHandles } from '@/core/gate';

/**
 * The engine handles {@link evaluateGate} and {@link timeUntilGateFlip} read
 * through. Adoption sites typically build one via
 * {@link getAmbientGateRuntime} during a factory's install/connect call and
 * close over it for evaluation. The plain-data bundle is also useful for tests
 * (construct directly to drive `evaluateGate` without standing up an engine)
 * and for partial overrides in factory options.
 *
 * Every field is optional because the bundle describes what's *available*, not
 * what a given Gate needs — which handles are actually required is a function
 * of the gate's kinds ({@link getRequiredGateHandles}). A consumer whose gates
 * are all category-resolved owes no {@link GameStateAccessor} at all. Reads
 * are demand-checked per kind at evaluation, so a gate that does need a
 * missing handle throws naming both.
 *
 * Not auto-published under an injection key — the bundle is composition glue,
 * not a singleton.
 */
export interface GateRuntime {
  accessor?: GameStateAccessor;
  categories?: EngineCategories;
  registry?: ResourceRegistry;
}

/**
 * Snapshot whichever ambient handles are currently wired into a
 * {@link GateRuntime} bundle.
 *
 * Reads from `getCurrentGameStateAccessor()` / `getCurrentEngineCategories()` /
 * `getCurrentResourceRegistry()` — the same install-time ambient triple every
 * other category factory already uses. Each piece can be overridden via
 * `override` for tests or for callers that want to thread a non-ambient
 * accessor (mirrors the option-then-ambient shape of `createChallengeCategory`).
 *
 * Never throws: a missing handle is only an error for a gate whose kinds
 * actually read it, which isn't knowable here. Evaluation demand-checks per
 * kind, and adoption sites holding the gate at construction can fail earlier
 * via {@link getRequiredGateHandles}.
 *
 * The ambient triple is only set during an engine `install()` / `connect()`,
 * so call this there and close over the result — resolving lazily from a
 * player-driven path gets an empty bundle.
 */
export function getAmbientGateRuntime(override?: GateRuntime): GateRuntime {
  return {
    accessor: override?.accessor ?? getCurrentGameStateAccessor(),
    categories: override?.categories ?? getCurrentEngineCategories(),
    registry: override?.registry ?? getCurrentResourceRegistry(),
  };
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
      return Decimal.gte(
        demand(runtime, 'accessor', gate.kind).getResource(gate.resource),
        gate.value,
      );
    case 'cumulative-gte': {
      const ref = cumulativeRefFor(gate.resource, runtime, gate.kind);
      return Decimal.gte(ref.value, gate.value);
    }
    case 'count-gte': {
      const categories = demand(runtime, 'categories', gate.kind);
      const signals = findCategoryEntrySignals(categories, gate.category, gate.entity);
      if (!signals) return false;
      return Decimal.gte(signals.count.value, gate.value);
    }
    case 'unlock': {
      const categories = demand(runtime, 'categories', gate.kind);
      const signals = findCategoryEntrySignals(categories, gate.category, gate.entity);
      return signals?.unlock.value ?? false;
    }
    case 'state':
      return compareState(
        demand(runtime, 'accessor', gate.kind).getState(gate.key),
        gate.operator,
        gate.value,
      );
    case 'flag':
      return demand(runtime, 'accessor', gate.kind).isUnlocked(gate.id);
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
 * - `resource-gte` — projects to `ResourceCondition` and delegates to
 *   {@link timeUntilConditionFlip}, which owns the rate × operator truth table.
 * - `cumulative-gte` — divides the gap in the cumulative total by the
 *   resource's inflow rate, since the total counts gains and ignores drains.
 *   With {@link GameStateAccessor.getInflowRate} the answer is exact under
 *   current rates, and `'no-rate'` means nothing flows in. Without it the net
 *   rate stands in: the seconds are an upper bound on the time to flip, exact
 *   when nothing drains the resource, and a net rate that isn't positive gives
 *   `'uncomputable'`, since inflow may still carry the total over. A gate
 *   already met gives `'no-rate'`: the total never falls, so only a reset
 *   flips it back.
 * - `count-gte` / `unlock` / `state` / `flag` — `'opaque-predicate'`. Category
 *   counts advance imperatively (purchases, achievement firings); `state` and
 *   `flag` are consumer-write surfaces. None has a mechanical distance.
 * - `all` / `any` / `not` — builds `{ currentlyTrue, distance }` per child via
 *   {@link evaluateGate} + recursive {@link timeUntilGateFlip}, then delegates
 *   to {@link combineFlipDistances} for the combinator truth-table dispatch.
 */
export function timeUntilGateFlip(gate: Gate, runtime: GateRuntime): TransitionDistance {
  switch (gate.kind) {
    case 'resource-gte':
      return timeUntilConditionFlip(
        { type: 'resource', target: gate.resource, operator: 'gte', value: gate.value },
        demand(runtime, 'accessor', gate.kind),
      );
    case 'cumulative-gte':
      return timeUntilCumulativeFlip(gate, runtime);
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

/**
 * The accessor slots whose change can move {@link timeUntilGateFlip}'s answer
 * for `gate`, for caches that re-predict only when one of them moves.
 * `cumulative-gte` names its base resource on both axes, standing for its
 * lifetime total and its inflow rate as well as its balance and net rate: a
 * drain that matches the inflow holds the latter two still while the total
 * climbs. Category kinds contribute nothing, since they move without any
 * accessor slot moving.
 *
 * @internal
 */
export function collectGateDeps(gate: Gate): TransitionDeps {
  const deps = {
    resources: new Set<string>(),
    rates: new Set<string>(),
    unlocks: new Set<string>(),
    states: new Set<string>(),
  };
  forEachGateLeaf(gate, (leaf) => {
    switch (leaf.kind) {
      case 'resource-gte':
      case 'cumulative-gte':
        deps.resources.add(leaf.resource);
        deps.rates.add(leaf.resource);
        return;
      case 'flag':
        deps.unlocks.add(leaf.id);
        return;
      case 'state':
        deps.states.add(leaf.key);
        return;
      case 'count-gte':
      case 'unlock':
        return;
    }
  });
  return deps;
}

function timeUntilCumulativeFlip(
  gate: CumulativeGteGate,
  runtime: GateRuntime,
): TransitionDistance {
  const total = cumulativeRefFor(gate.resource, runtime, gate.kind).value;
  const accessor = demand(runtime, 'accessor', gate.kind);
  if (Decimal.gte(total, gate.value)) return { seconds: null, reason: 'no-rate' };
  const inflow = accessor.getInflowRate?.(gate.resource);
  const rate = inflow ?? accessor.getRate(gate.resource);
  if (Decimal.lte(rate, Decimal.dZero)) {
    return { seconds: null, reason: inflow !== undefined ? 'no-rate' : 'uncomputable' };
  }
  return secondsToCover(Decimal.sub(gate.value, total), rate);
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

// === RUNTIME BINDING ===

const boundRuntimes = new WeakMap<object, GateRuntime>();

/**
 * Record the runtime a Gate-holding instance evaluates through, so a harness
 * predictor reading that instance's gates later resolves the same registry
 * and categories.
 *
 * @internal
 */
export function bindGateRuntime(owner: object, runtime: GateRuntime): void {
  boundRuntimes.set(owner, runtime);
}

/**
 * The runtime {@link bindGateRuntime} recorded for `owner`, if any.
 *
 * @internal
 */
export function getBoundGateRuntime(owner: object): GateRuntime | undefined {
  return boundRuntimes.get(owner);
}

// === HANDLE ASSERTION ===

/**
 * Throw unless `runtime` carries every handle evaluating `gate` will read.
 *
 * Turns what would be a first-evaluation throw (often inside a `computed`,
 * where the stack is far from the authoring mistake) into one at the
 * registration callsite. Systems reach it through a
 * {@link PredicateResolver}, per definition as it registers.
 *
 * @param label prefix for the error, normally the calling factory's name.
 *
 * @example
 * ```ts
 * const runtime = getAmbientGateRuntime();
 * assertGateHandles(def.requirement, runtime, 'createAchievement');
 * ```
 */
export function assertGateHandles(gate: Gate, runtime: GateRuntime, label: string): void {
  const missing = [...getRequiredGateHandles(gate)].filter((handle) => !runtime[handle]);
  if (missing.length === 0) return;
  const kinds = new Set<Gate['kind']>();
  forEachGateLeaf(gate, (leaf) => kinds.add(leaf.kind));
  throw new Error(
    `${label}: this gate reads the ${missing.join(' and ')}, which the runtime doesn't carry. ` +
      `Gate kinds in play: ${[...kinds].join(', ')}. ${missing.map(handleRemedy).join(' ')}`,
  );
}

// === PREDICATE ADOPTION ===

/** A {@link Predicate} adopted by a system at its register site. */
export interface AdoptedPredicate {
  /** The Gate, when the predicate was authored as one — what a predictor reads. */
  readonly gate: Gate | undefined;
  /** Whether the predicate holds, reactively; the fallback when none was authored. */
  readonly holds: ComputedRef<boolean>;
  /**
   * Whether the predicate holds, evaluated afresh. For sites that poll per
   * tick or per call, where a getter may read state Vue doesn't track.
   */
  read(): boolean;
}

/** Adopts a system's predicate fields against one captured {@link GateRuntime}. */
export interface PredicateResolver {
  /** The handles every adopted Gate evaluates through. */
  readonly runtime: GateRuntime;
  /**
   * Adopt one predicate field. A Gate's handles are asserted now, so an
   * unwired handle throws here, labelled, instead of at first evaluation.
   *
   * @param predicate - the authored field, or `undefined` when omitted
   * @param fallback - what an omitted field holds
   * @param label - names the field in the error, e.g. `"challenge 'ic1' goal"`
   */
  adopt(predicate: Predicate | undefined, fallback: boolean, label: string): AdoptedPredicate;
  /** Assert a Gate held outside a Predicate field — a dialog graph's conditions. */
  assert(gate: Gate, label: string): void;
}

/**
 * Build the resolver a system adopts its predicate fields through.
 *
 * Captures the runtime once, from the ambient handles `createEngine` wires
 * during install/connect plus any `override`, so definitions registered
 * after that scope closes (late content, mods) still resolve.
 *
 * @param override - handles that win over the ambient ones, typically a
 *   system's `accessor` option
 * @returns A {@link PredicateResolver} whose `adopt` turns each field into a
 *   reactive `holds`, keeping the Gate for predictors
 *
 * @example
 * ```ts
 * const predicates = createPredicateResolver(accessor ? { accessor } : undefined);
 * // per definition, at register:
 * const goal = predicates.adopt(def.goal, false, `challenge '${def.id}' goal`);
 * const canComplete = computed(() => active.value && goal.holds.value);
 * ```
 */
export function createPredicateResolver(override?: GateRuntime): PredicateResolver {
  const runtime = getAmbientGateRuntime(override);
  return {
    runtime,
    assert: (gate, label) => assertGateHandles(gate, runtime, label),
    adopt(predicate, fallback, label) {
      if (predicate === undefined) {
        return { gate: undefined, holds: computed(() => fallback), read: () => fallback };
      }
      if (isGate(predicate)) {
        assertGateHandles(predicate, runtime, label);
        return {
          gate: predicate,
          holds: computed(() => evaluateGate(predicate, runtime)),
          read: () => evaluateGate(predicate, runtime),
        };
      }
      const source = processGetter(predicate);
      return {
        gate: undefined,
        holds: computed(() => unref(source)),
        read: () => resolveComputable(predicate),
      };
    },
  };
}

/**
 * Evaluate a {@link Predicate} once against `runtime` — for consumer code
 * that reads a predicate field back off a definition.
 *
 * @example
 * ```ts
 * const runtime = getAmbientGateRuntime(); // inside install/connect
 * if (evaluatePredicate(def.goal, runtime)) celebrate();
 * ```
 */
export function evaluatePredicate(predicate: Predicate, runtime: GateRuntime): boolean {
  return isGate(predicate) ? evaluateGate(predicate, runtime) : resolveComputable(predicate);
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
  assertGateHandles(gate, runtime, 'createGateRequirement');
  return createBooleanRequirement({
    requirement: computed(() => evaluateGate(gate, runtime)),
    description,
  });
}

// === PRIVATE ===

/**
 * Read a handle the current gate kind needs, or throw naming both. The message
 * carries the kind because "missing accessor" alone doesn't tell an author
 * which of their gates is at fault — and category-only gates never reach here.
 */
function demand<K extends GateHandle>(
  runtime: GateRuntime,
  handle: K,
  kind: Gate['kind'],
): NonNullable<GateRuntime[K]> {
  const value = runtime[handle];
  if (!value) {
    throw new Error(
      `evaluateGate: '${kind}' gate needs the ${handle}, which was not available on the GateRuntime. ` +
        handleRemedy(handle),
    );
  }
  return value;
}

/** Where an author gets a missing handle from, for the error messages. */
function handleRemedy(handle: GateHandle): string {
  return handle === 'accessor'
    ? 'Wire the accessor via createEngine({ accessor }) or pass one explicitly, and resolve the runtime inside engine install/connect.'
    : `The ${handle} resolves only inside engine install/connect; build the runtime there.`;
}

function cumulativeRefFor(resourceId: string, runtime: GateRuntime, kind: Gate['kind']) {
  const resource = demand(runtime, 'registry', kind).findById(resourceId);
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
