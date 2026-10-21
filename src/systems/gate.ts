/**
 * Gate — evaluation, prediction and predicate adoption for the typed,
 * serializable yes/no test. A Gate is the form of a predicate field that a
 * predictor can read. Consumer code writes Gates, not the engine-internal
 * `C.*` builders, and an opaque `Computable<boolean>` closure hides its test
 * from the predictor.
 *
 * Gate composes four existing pieces:
 * - `ICondition` + {@link evaluateCondition} / {@link timeUntilConditionFlip} —
 *   rate-aware leaves project to the condition IR, and the predictor reuses it.
 * - {@link CategoryEntrySignals} via {@link findCategoryEntrySignals} — the
 *   signals every category factory builds for each category entry. The
 *   `count-gte` and `active` kinds read through it, with no consumer-side
 *   path conventions and no synthetic state paths.
 * - {@link ResourceRegistry} via `findById` — `cumulative-gte` reads the
 *   resource's `cumulative` ref, and `resource-gte` reads its value when no
 *   accessor is wired.
 * - {@link GameStateAccessor} — the `state` and `flag` kinds read through it
 *   (consumer-defined path and value meaning, as in `StateCondition`), and
 *   `resource-gte` reads `getAmount` when it is wired. A prediction of
 *   `resource-gte` or `cumulative-gte` reads the accessor's rates.
 *
 * Per-kind dispatch:
 *
 * | Kind           | Evaluator                                           | Predictor                                |
 * |----------------|-----------------------------------------------------|------------------------------------------|
 * | resource-gte   | getAmount(id), else findById(id).value, >= value    | timeUntilConditionFlip over projection   |
 * | cumulative-gte | registry.findById(id).cumulative.value >= value     | gap in the cumulative total ÷ inflow     |
 * | count-gte      | findCategoryEntrySignals(...).count >= value        | 'opaque-predicate'                       |
 * | active         | findCategoryEntrySignals(...).active                | 'opaque-predicate'                       |
 * | flag           | accessor.getFlag(id)                                | 'opaque-predicate'                       |
 * | state          | compareState(accessor.getStateAt(...), op, val)     | 'opaque-predicate'                       |
 * | all/any/not    | recurse                                             | combineFlipDistances over Gate children  |
 *
 * `gateToCondition` partially projects accessor-backed Gates (and their
 * combinators) to `ICondition`, the serializable condition IR `E.branch`
 * embeds. It throws on category descendants and on `cumulative-gte`, whose
 * values are behind the categories and the resource registry rather than the
 * accessor. Predictors read every kind through {@link timeUntilGateFlip} instead.
 *
 * Predicate fields — where a Gate is one authoring form among several:
 * - Predicate fields in systems take {@link Predicate} (a boolean, ref,
 *   getter or Gate). They adopt it through a {@link PredicateResolver} the
 *   system builds once, at construction. The Gate services a Gate reads are
 *   asserted when its def registers. So a missing accessor fails at the
 *   authoring site rather than at first evaluation.
 * - Core fields stay `Computable<boolean>`: core can name a Gate but
 *   cannot evaluate one.
 * - A dialog node's `when` and a choice's `visible` stay Gate-only, since a
 *   dialog graph is pure data. The dialog adapter asserts their Gate services
 *   when it is built.
 * - The `goal` an achievement category synthesizes for each ladder rung
 *   stays a closure; the engine builds it, and no author writes it.
 */

import { computed, type ComputedRef } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import type { GameStateAccessor } from '@/primitives/types';
import { compareState } from '@/core/conditions';
import { resolveComputable, type Computable } from '@/core/computed';
import {
  combineFlipDistances,
  secondsToCover,
  timeUntilConditionFlip,
  type ChildFlipResult,
  type TransitionDeps,
  type TransitionDistance,
} from '@/core/transitions';
import {
  ACCESSOR_METHOD_REMEDY,
  assertAccessorMethods,
  getCurrentGameStateAccessor,
  implementsAccessorMethod,
} from '@/core/game-state-accessor';
import { getCurrentResourceRegistry, type ResourceRegistry } from '@/core/registries';
import { createBooleanRequirement, type Requirement } from '@/core/requirements';
import {
  forEachGateLeaf,
  getLeafAccessorMethod,
  getLeafGateServices,
  isGate,
  type AllGate,
  type AnyGate,
  type CumulativeGteGate,
  type Gate,
  type GateService,
  type NotGate,
  type Predicate,
  type ResourceGteGate,
} from '@/core/gate';
import {
  findCategoryEntrySignals,
  getCurrentEngineCategories,
  type EngineCategories,
} from './engine-categories';

// === TYPE RE-EXPORTS ===
// Gate's pure-data shape (variant interfaces + Gate union + projection +
// type guard) is in core/gate.ts, so core builders can accept a Gate
// without breaking the one-way imports. Re-exported here so the public API
// surface keeps a single import path.
export type {
  ResourceGteGate,
  CumulativeGteGate,
  CountGteGate,
  ActiveGate,
  StateGate,
  FlagGate,
  AllGate,
  AnyGate,
  NotGate,
  Gate,
  GateService,
  Predicate,
} from '@/core/gate';
export { isGate, gateToCondition, getRequiredGateServices } from '@/core/gate';

/**
 * The Gate services {@link evaluateGate} and {@link timeUntilGateFlip} read.
 * Adoption sites typically build one via {@link getAmbientGateServices}
 * during a factory's install/connect call, and close over it for evaluation.
 * The plain-data bundle is also useful for tests: construct it directly to
 * drive `evaluateGate` without standing up an engine. It also serves partial
 * replacements in factory options.
 *
 * Every field is optional, because the bundle describes what's *available*,
 * not what a given Gate needs. The Gate services a Gate requires are a
 * function of its kinds ({@link getRequiredGateServices}). A consumer whose
 * Gates are all category or resource kinds needs no {@link GameStateAccessor}
 * to evaluate them.
 * Each kind checks its Gate services at evaluation, so a Gate that needs a
 * missing one throws, naming both.
 *
 * Not auto-published under an injection key — the bundle is composition glue,
 * not a singleton.
 */
export interface GateServices {
  accessor?: GameStateAccessor;
  categories?: EngineCategories;
  resourceRegistry?: ResourceRegistry;
}

/**
 * Snapshot the ambient Gate services wired now into a
 * {@link GateServices} bundle.
 *
 * Reads `getCurrentGameStateAccessor()` / `getCurrentEngineCategories()` /
 * `getCurrentResourceRegistry()` — the same ambient values every category
 * factory reads during install/connect. `override` replaces any of them, for
 * tests or for callers that pass a non-ambient accessor (the
 * option-then-ambient shape of `createChallengeCategory`).
 *
 * Never throws: a missing Gate service is only an error for a Gate whose
 * kinds read it, which isn't knowable here. Evaluation checks per kind, and
 * adoption sites that hold the Gate at construction can fail earlier via
 * {@link getRequiredGateServices}.
 *
 * The ambient values are set only during an engine `install()` / `connect()`.
 * So call this there and close over the result — a later call from a
 * player-driven path gets an empty bundle.
 */
export function getAmbientGateServices(override?: GateServices): GateServices {
  return {
    accessor: override?.accessor ?? getCurrentGameStateAccessor(),
    categories: override?.categories ?? getCurrentEngineCategories(),
    resourceRegistry: override?.resourceRegistry ?? getCurrentResourceRegistry(),
  };
}

// === EVALUATOR ===

/**
 * Evaluate a Gate against the engine's live state now.
 *
 * @throws when a `cumulative-gte` names a resource id that's not
 *   registered in the resource registry, or a `resource-gte` does with no
 *   accessor wired. The throw catches the authoring error at first
 *   evaluation, rather than silently returning `false`.
 *
 * @example
 * ```ts
 * // Inside a factory called from engine install/connect:
 * const services = getAmbientGateServices();
 * const earned = computed(() =>
 *   evaluateGate({ kind: 'count-gte', category: 'buildings', entry: 'farm', value: 10 }, services)
 * );
 * ```
 */
export function evaluateGate(gate: Gate, services: GateServices): boolean {
  switch (gate.kind) {
    case 'resource-gte':
      return Decimal.gte(amountOf(gate, services), gate.value);
    case 'cumulative-gte': {
      const ref = cumulativeRefFor(gate.resource, services, 'evaluateGate');
      return Decimal.gte(ref.value, gate.value);
    }
    case 'count-gte': {
      const categories = demand(services, 'categories', gate.kind);
      const signals = findCategoryEntrySignals(categories, gate.category, gate.entry);
      if (!signals) return false;
      return Decimal.gte(signals.count.value, gate.value);
    }
    case 'active': {
      const categories = demand(services, 'categories', gate.kind);
      const signals = findCategoryEntrySignals(categories, gate.category, gate.entry);
      return signals?.active.value ?? false;
    }
    case 'state':
      return compareState(
        demand(services, 'accessor', gate.kind).getStateAt(gate.path),
        gate.operator,
        gate.value,
      );
    case 'flag':
      return demand(services, 'accessor', gate.kind).getFlag(gate.id);
    case 'all':
      return gate.of.every((g) => evaluateGate(g, services));
    case 'any':
      return gate.of.some((g) => evaluateGate(g, services));
    case 'not':
      return !evaluateGate(gate.of, services);
  }
}

// === PREDICTOR ===

/**
 * Transition distance until `gate` flips, at current rates. Per-kind dispatch:
 *
 * - `resource-gte` — projects to `ResourceCondition` and delegates to
 *   {@link timeUntilConditionFlip}, which owns the rate × operator truth table.
 *   It reads the accessor's amount and rate, so it needs an accessor even
 *   where evaluation falls back to the resource registry.
 * - `cumulative-gte` — divides the gap in the cumulative total by the
 *   resource's inflow rate, since the total counts gains and ignores
 *   subtractions. With {@link GameStateAccessor.getInflowRate} the answer is
 *   exact at current rates, and `'no-rate'` means nothing flows in. Without
 *   it the net rate stands in: the seconds are an upper bound on the time to
 *   flip, exact when nothing subtracts from the resource. A net rate that
 *   isn't positive gives `'uncomputable'`, since inflow may still raise the
 *   total past the threshold. A Gate that already holds gives `'no-rate'`: the
 *   total never falls, so only a reset flips it back.
 * - `count-gte` / `active` / `state` / `flag` — `'opaque-predicate'`. Category
 *   counts change by discrete events (purchases, earned achievements), and
 *   consumer code writes `state` and `flag` values. None has a transition
 *   distance the engine can compute.
 * - `all` / `any` / `not` — builds `{ currentlyTrue, distance }` per child via
 *   {@link evaluateGate} + recursive {@link timeUntilGateFlip}, then delegates
 *   to {@link combineFlipDistances} for the combinator truth-table dispatch.
 */
export function timeUntilGateFlip(gate: Gate, services: GateServices): TransitionDistance {
  switch (gate.kind) {
    case 'resource-gte':
      return timeUntilConditionFlip(
        { kind: 'resource', target: gate.resource, operator: 'gte', value: gate.value },
        demandRateAccessor(services, gate.kind),
      );
    case 'cumulative-gte':
      return timeUntilCumulativeFlip(gate, services);
    case 'count-gte':
    case 'active':
    case 'state':
    case 'flag':
      return { seconds: null, reason: 'opaque-predicate' };
    case 'all':
    case 'any':
    case 'not':
      return combinatorFlip(gate, services);
  }
}

/**
 * The accessor values whose change can move {@link timeUntilGateFlip}'s answer
 * for `gate`, for caches that re-predict only when one of them moves.
 * `cumulative-gte` names its base resource on both axes. That stands for its
 * cumulative total and inflow rate, as well as its amount and net rate. A
 * subtraction that matches the inflow holds the latter two still while the
 * total climbs. Category kinds add nothing, since they change without any
 * accessor value changing.
 *
 * @internal
 */
export function collectGateDeps(gate: Gate): TransitionDeps {
  const deps = {
    resources: new Set<string>(),
    rates: new Set<string>(),
    flags: new Set<string>(),
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
        deps.flags.add(leaf.id);
        return;
      case 'state':
        deps.states.add(leaf.path);
        return;
      case 'count-gte':
      case 'active':
        return;
    }
  });
  return deps;
}

function timeUntilCumulativeFlip(
  gate: CumulativeGteGate,
  services: GateServices,
): TransitionDistance {
  const total = cumulativeRefFor(gate.resource, services, 'timeUntilGateFlip').value;
  const accessor = demandRateAccessor(services, gate.kind);
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
  services: GateServices,
): TransitionDistance {
  if (gate.kind === 'not') {
    return timeUntilGateFlip(gate.of, services);
  }
  const children: ChildFlipResult[] = gate.of.map((child) => ({
    currentlyTrue: evaluateGate(child, services),
    distance: timeUntilGateFlip(child, services),
  }));
  return combineFlipDistances(children, gate.kind === 'all' ? 'all' : 'any');
}

// === SERVICES BINDING ===

const boundServices = new WeakMap<object, GateServices>();

/**
 * Record the Gate services a Gate-holding instance evaluates through. So a
 * balance-harness predictor that later reads that instance's Gates uses the
 * same resource registry and categories.
 *
 * @internal
 */
export function bindGateServices(owner: object, services: GateServices): void {
  boundServices.set(owner, services);
}

/**
 * The Gate services {@link bindGateServices} recorded for `owner`, if any.
 *
 * @internal
 */
export function getBoundGateServices(owner: object): GateServices | undefined {
  return boundServices.get(owner);
}

// === SERVICE ASSERTION ===

/**
 * Throw unless `services` has every Gate service that evaluating `gate` reads.
 * A `resource-gte` leaf passes with either the accessor or the resource
 * registry. The accessor counts for a leaf only if it implements the method
 * the leaf calls, by its `AccessorMethods` record.
 *
 * This moves a first-evaluation throw to the registration callsite. The first
 * evaluation is often inside a `computed`, where the stack is far from the
 * authoring mistake. Systems call it through a
 * {@link PredicateResolver}, per def as it registers.
 *
 * @param label prefix for the error, normally the calling factory's name.
 *
 * @example
 * ```ts
 * const services = getAmbientGateServices();
 * assertGateServices(goalGate, services, 'createAchievement');
 * ```
 */
export function assertGateServices(gate: Gate, services: GateServices, label: string): void {
  const missing = new Set<string>();
  const remedies = new Set<string>();
  const kinds = new Set<Gate['kind']>();
  const { accessor } = services;
  forEachGateLeaf(gate, (leaf) => {
    kinds.add(leaf.kind);
    const method = getLeafAccessorMethod(leaf);
    // An accessor whose record leaves out the leaf's method serves it no better than none.
    const accessorLacksMethod = Boolean(
      accessor && method && !implementsAccessorMethod(accessor, method),
    );
    const options = getLeafGateServices(leaf);
    const served = (service: GateService) =>
      service === 'accessor'
        ? Boolean(accessor) && !accessorLacksMethod
        : Boolean(services[service]);
    if (options.some(served)) return;
    const names: string[] = [];
    for (const service of options) {
      const lacksMethod = service === 'accessor' && accessorLacksMethod;
      names.push(lacksMethod ? `accessor's ${method}` : service);
      remedies.add(lacksMethod ? ACCESSOR_METHOD_REMEDY : serviceRemedy(service));
    }
    missing.add(names.join(' or '));
  });
  if (missing.size === 0) return;
  throw new Error(
    `${label}: this Gate reads the ${[...missing].join(' and ')}, which the GateServices bundle lacks. ` +
      `Gate kinds in play: ${[...kinds].join(', ')}. ${[...remedies].join(' ')}`,
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

/** Adopts a system's predicate fields against one captured {@link GateServices}. */
export interface PredicateResolver {
  /** The Gate services every adopted Gate evaluates through. */
  readonly services: GateServices;
  /**
   * Adopt one predicate field. The Gate services a Gate reads are asserted
   * now, so a missing one throws here, labelled, instead of at first evaluation.
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
 * Captures the Gate services once, from the ambient values `createEngine`
 * sets during install/connect plus any `override`. So defs registered after
 * install/connect ends (late content, mods) can still evaluate.
 *
 * @param override - Gate services that win over the ambient ones, typically
 *   a system's `accessor` option
 * @returns A {@link PredicateResolver} whose `adopt` turns each field into a
 *   reactive `holds`, keeping the Gate for predictors
 *
 * @example
 * ```ts
 * const predicates = createPredicateResolver({ accessor });
 * // per def, at register:
 * const goal = predicates.adopt(def.goal, false, `challenge '${def.id}' goal`);
 * const canComplete = computed(() => active.value && goal.holds.value);
 * ```
 */
export function createPredicateResolver(override?: GateServices): PredicateResolver {
  const services = getAmbientGateServices(override);
  return {
    services: services,
    assert: (gate, label) => assertGateServices(gate, services, label),
    adopt(predicate, fallback, label) {
      const gate = isGate(predicate) ? predicate : undefined;
      if (gate) assertGateServices(gate, services, label);
      const read =
        predicate === undefined ? () => fallback : () => evaluatePredicate(predicate, services);
      // Built on first access: sites that poll only ever call `read()`, and a
      // computed nothing reads is held for the owner's lifetime.
      let holds: ComputedRef<boolean> | undefined;
      return {
        gate,
        read,
        get holds() {
          return (holds ??= computed(read));
        },
      };
    },
  };
}

/**
 * Evaluate a {@link Predicate} once against `services` — for consumer code
 * that reads a predicate field back off a def.
 *
 * @example
 * ```ts
 * const services = getAmbientGateServices(); // inside install/connect
 * if (evaluatePredicate(def.goal, services)) celebrate();
 * ```
 */
export function evaluatePredicate(predicate: Predicate, services: GateServices): boolean {
  return isGate(predicate) ? evaluateGate(predicate, services) : resolveComputable(predicate);
}

// === REQUIREMENT ADAPTER ===

/** Options for {@link createGateRequirement}. */
export interface GateRequirementOptions {
  /** The Gate, evaluated through the ambient Gate services captured at call time. */
  gate: Gate;
  /** Optional UI-facing description (passed through to the underlying boolean requirement). */
  description?: Computable<string>;
}

/**
 * Build a {@link Requirement} that's met whenever its {@link Gate} holds.
 * The systems counterpart to `createBooleanRequirement` for Gate authoring:
 * it goes into `purchasable.requirements` arrays beside cost requirements,
 * with no consumer-side closures.
 *
 * Captures the {@link GateServices} eagerly via {@link getAmbientGateServices},
 * so call it inside an engine `install()` / `connect()`. The returned
 * Requirement is a plain core `Requirement`. Only the *factory* is in
 * systems, because evaluating a Gate reads `CategoryEntrySignals` and other
 * systems state.
 *
 * @example
 * ```ts
 * upgrades.register({
 *   id: 'fast-mode',
 *   requirements: [
 *     createCostRequirement({ resource: gold, cost: 100 }),
 *     createGateRequirement({
 *       gate: { kind: 'count-gte', category: 'producers', entry: 'farm', value: 5 },
 *       description: '5 farms owned',
 *     }),
 *   ],
 * });
 * ```
 */
export function createGateRequirement(options: GateRequirementOptions): Requirement {
  const { gate, description } = options;
  const services = getAmbientGateServices();
  assertGateServices(gate, services, 'createGateRequirement');
  return createBooleanRequirement({
    met: computed(() => evaluateGate(gate, services)),
    description,
  });
}

// === PRIVATE ===

/**
 * Read a Gate service the current Gate kind needs, or throw naming both. The
 * message names the kind, because "missing accessor" alone doesn't tell an
 * author which of their Gates is at fault.
 */
function demand<K extends GateService>(
  services: GateServices,
  service: K,
  kind: Gate['kind'],
  caller: GateCaller = 'evaluateGate',
): NonNullable<GateServices[K]> {
  const value = services[service];
  if (!value) throw missingServicesError(caller, kind, [service]);
  return value;
}

/** The public entry point a Gate service error names. */
type GateCaller = 'evaluateGate' | 'timeUntilGateFlip';

function missingServicesError(
  caller: GateCaller,
  kind: Gate['kind'],
  options: readonly GateService[],
  purpose = '',
): Error {
  return new Error(
    `${caller}: a '${kind}' Gate needs the ${options.join(' or ')}${purpose}, which the GateServices bundle lacks. ` +
      options.map(serviceRemedy).join(' '),
  );
}

/**
 * The accessor a prediction reads rates through, or throw saying so. Rates
 * have no registry source, so a Gate that evaluates without an accessor
 * still needs one to predict.
 */
function demandRateAccessor(services: GateServices, kind: Gate['kind']): GameStateAccessor {
  const { accessor } = services;
  if (!accessor) {
    throw missingServicesError('timeUntilGateFlip', kind, ['accessor'], ' to read its getRate');
  }
  assertAccessorMethods(accessor, ['getRate'], `timeUntilGateFlip ('${kind}' Gate)`);
  return accessor;
}

/** The registered resource a resource Gate names, or throw naming the id. */
function findResource(
  services: GateServices,
  resourceId: string,
  kind: Gate['kind'],
  caller: GateCaller,
) {
  const resource = demand(services, 'resourceRegistry', kind, caller).findById(resourceId);
  if (!resource) throw new Error(`Gate ${kind}: no resource '${resourceId}' registered`);
  return resource;
}

/**
 * A `resource-gte` amount: the wired accessor's when it implements
 * `getAmount`, else the registered resource's.
 */
function amountOf(gate: ResourceGteGate, services: GateServices): DecimalSource {
  const { accessor } = services;
  if (accessor && implementsAccessorMethod(accessor, 'getAmount')) {
    return accessor.getAmount(gate.resource);
  }
  if (!services.resourceRegistry) {
    throw missingServicesError('evaluateGate', gate.kind, getLeafGateServices(gate));
  }
  return findResource(services, gate.resource, gate.kind, 'evaluateGate').value;
}

/** Where an author gets a missing Gate service from, for the error messages. */
function serviceRemedy(service: GateService): string {
  return service === 'accessor'
    ? 'Pass the accessor to createEngine({ accessor }) or pass one explicitly, and collect the Gate services inside engine install/connect.'
    : `The ${service} is set only inside engine install/connect; build the predicate resolver there.`;
}

function cumulativeRefFor(resourceId: string, services: GateServices, caller: GateCaller) {
  const resource = findResource(services, resourceId, 'cumulative-gte', caller);
  // createResource builds a `cumulative` ref for every persistent resource.
  // A missing one means the resource came from the ref-wrapping overload
  // (derived/computed), which keeps no cumulative total.
  if (!resource.cumulative) {
    throw new Error(
      `Gate cumulative-gte: resource '${resourceId}' was created from an existing ref and has no cumulative ref`,
    );
  }
  return resource.cumulative;
}
