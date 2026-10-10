/**
 * Requirements system for gating purchases, unlocks, and actions
 *
 * Requirements define conditions that must be met
 * before something can be purchased or activated.
 *
 * Key features:
 * - Cost requirements (spend resource to purchase)
 * - Boolean requirements (simple true/false conditions)
 * - Composable (multiple requirements can be combined)
 * - Supports bulk purchasing via formulas
 */

import { computed, unref, type MaybeRef } from 'vue';
import { Decimal, type DecimalSource, formatSmall, renormIfLayer0 } from '@/primitives/decimal';
import { toMaybeRef, type Computable } from './computed';
import { resetResource, type Resource } from './resource';
import { SkipPersistence } from './persistence';
import type { GenericFormula } from './formulas';
import { calculateCost, calculateMaxAffordable, isFormula } from './formulas';

// === CORE TYPES ===

/**
 * Base requirement interface.
 * All requirement types implement this.
 */
export interface Requirement {
  /**
   * Whether this requirement is currently met.
   * Can be boolean (met/not met) or a number (how many times it can be met).
   */
  met: MaybeRef<DecimalSource | boolean>;

  /**
   * Whether satisfying this requirement costs something.
   * If true, `pay()` will be called when the requirement is used.
   */
  requiresPay: MaybeRef<boolean>;

  /**
   * Whether this requirement supports buying multiple at once.
   * If true, `met` returns how many can be bought.
   */
  canMaximize?: MaybeRef<boolean>;

  /**
   * Pay the cost of this requirement.
   * Called when the requirement is consumed (e.g., purchasing an upgrade).
   *
   * @param count - Number of times to pay (for bulk purchases)
   */
  pay?: (count?: DecimalSource) => void;

  /**
   * Human-readable description of this requirement.
   */
  description?: MaybeRef<string>;

  /**
   * Mark as non-persistent (internal use)
   */
  [SkipPersistence]: true;
}

/**
 * Utility type for accepting one or more requirements
 */
export type Requirements = Requirement | Requirement[];

// === COST REQUIREMENT ===

/**
 * Options for creating a cost requirement
 */
export interface CostRequirementOptions {
  /** The resource to spend */
  resource: Resource;

  /**
   * The price of one purchase. Three shapes, and the choice decides whether
   * bulk purchasing is priced correctly:
   *
   * - **A static value** — bulk is exact. `n` purchases cost `n × cost`.
   * - **A getter or ref** — bulk is priced linearly off the *current* value,
   *   which is exact only while that value doesn't move as you buy. A
   *   level-independent getter (a tuning knob, a scoped override) is fine; a
   *   getter that reads the buyer's own level is **silently mispriced** — three
   *   rungs of a `1.15ⁿ` ladder charge `3c` rather than `c + 1.15c + 1.3225c`,
   *   and affordability is over-reported to match.
   * - **A {@link GenericFormula}** — bulk walks the real curve, via inversion
   *   (`calculateMaxAffordable`) and closed-form summation (`calculateCost`).
   *   The only correct shape for a cost that scales on what's being bought.
   *
   * The mispricing needs `maxBulkCount > 1` to bite, so it can't be reached
   * through `createPurchasableCategory` or `createScalingPurchasable` without
   * asking for it. When a cost scales on a purchasable's own level,
   * build it as a Formula over the level ref that
   * `PurchasableOptions.requirements` hands its factory form.
   */
  cost: Computable<DecimalSource> | GenericFormula;

  /** Whether this requirement requires payment (default: true) */
  requiresPay?: Computable<boolean>;

  /**
   * For a Formula cost `f` over the level `L`: whether buying `n` sums the
   * levels bought. If true, it costs `f(L) + f(L+1) + … + f(L+n−1)`. If
   * false, it costs one evaluation, `f(L+n)`, so even a single purchase is
   * priced one level ahead of the cumulative mode.
   * Default: true
   */
  cumulativeCost?: Computable<boolean>;

  /**
   * Ceiling on how many purchases one bulk buy may satisfy. Default: `1`,
   * which confines every cost shape to single purchases and is why a
   * mispriced getter cost stays inert until this is raised. Raise it (to
   * `Decimal.dInf` for uncapped) only alongside a Formula cost — see
   * {@link CostRequirementOptions.cost}.
   */
  maxBulkCount?: Computable<DecimalSource>;

  /** Custom pay function (overrides default resource subtraction) */
  pay?: (count?: DecimalSource) => void;

  /** Description for UI display */
  description?: Computable<string>;
}

/**
 * A requirement that costs a resource to satisfy
 */
export interface CostRequirement extends Requirement {
  /** How many purchases the resource covers: `1` when one is affordable, more when `canMaximize` allows bulk. */
  met: MaybeRef<DecimalSource>;

  /** The resource being spent */
  resource: Resource;

  /** The cost amount or formula */
  cost: MaybeRef<DecimalSource> | GenericFormula;

  /** Whether costs are cumulative for bulk purchases */
  cumulativeCost: MaybeRef<boolean>;

  /** Maximum bulk purchase amount */
  maxBulkCount: MaybeRef<DecimalSource>;

  /** Get the actual cost for a given amount */
  getCost: (count?: DecimalSource) => DecimalSource;
}

/**
 * Create a requirement based on spending a resource.
 *
 * @param options - Configuration for the cost requirement
 * @returns A cost requirement
 *
 * @example
 * ```ts
 * const pointCost = createCostRequirement({
 *   resource: points,
 *   cost: 100,
 *   description: "100 points"
 * })
 *
 * // Scaling cost for bulk purchases, over the level ref the purchasable
 * // hands its `requirements` factory
 * const scalingCost = createCostRequirement({
 *   resource: points,
 *   cost: Formula.variable(level).pow_base(2).mul(10), // 10 * 2^level
 *   maxBulkCount: 10
 * })
 * ```
 */
export function createCostRequirement(options: CostRequirementOptions): CostRequirement {
  const { resource, cost, requiresPay, cumulativeCost, maxBulkCount, pay, description } = options;

  const processedCost = isFormula(cost) ? cost : toMaybeRef(cost);
  const processedCumulativeCost = cumulativeCost != null ? toMaybeRef(cumulativeCost) : true;
  const processedMaxBulk = maxBulkCount != null ? toMaybeRef(maxBulkCount) : 1;

  // Precomputed formula affordability — reactive via calculateMaxAffordable's own computed.
  const formulaMaxAffordable = isFormula(processedCost)
    ? calculateMaxAffordable(processedCost, resource, processedCumulativeCost, processedMaxBulk)
    : null;

  function getCost(amount: DecimalSource = 1): DecimalSource {
    if (isFormula(processedCost)) {
      return calculateCost(processedCost, amount, unref(processedCumulativeCost));
    }
    return Decimal.mul(unref(processedCost), amount);
  }

  const met = computed((): DecimalSource => {
    if (formulaMaxAffordable) return unref(formulaMaxAffordable);

    const available = resource.value;
    const maxBulk = unref(processedMaxBulk);
    const singleCost = unref(processedCost as MaybeRef<DecimalSource>);
    if (Decimal.lte(singleCost, 0)) return maxBulk;

    // Tolerance-aware floor: Decimal.div(x, x) returns 0.999...9 for layer-0
    // inputs at certain scales, so a naive floor reports 0 affordable at exact
    // equality. Snap to ceil when within FP-precision tolerance of an integer.
    // Tolerance is tight (1e-12) — wide enough to catch the layer-0 div quirk
    // (~1e-16 absolute), narrow enough not to falsely snap user-fractional
    // balances (e.g., 49.99 vs 50). At higher layers, eq_tolerance compares
    // log-magnitudes, so this stays safe at tetration scale.
    const ratio = Decimal.div(available, singleCost);
    const ceilRatio = Decimal.ceil(ratio);
    const affordable = Decimal.eq_tolerance(ratio, ceilRatio, 1e-12)
      ? ceilRatio
      : Decimal.floor(ratio);
    return Decimal.min(affordable, maxBulk);
  });

  const requirement: CostRequirement = {
    resource,
    cost: processedCost,
    cumulativeCost: processedCumulativeCost,
    maxBulkCount: processedMaxBulk,
    getCost,

    met,
    requiresPay: requiresPay != null ? toMaybeRef(requiresPay) : true,

    canMaximize: computed(() => {
      const max = unref(processedMaxBulk);
      return Decimal.gt(max, 1);
    }),

    pay:
      pay ??
      ((amount: DecimalSource = 1) => {
        const costToPay = getCost(amount);
        resource.value = Decimal.max(Decimal.sub(resource.value, costToPay), 0);
      }),

    description:
      description != null
        ? toMaybeRef(description)
        : computed(() => {
            const costValue = getCost(1);
            return `${formatSmall(costValue)} ${resource.displayName}`;
          }),

    [SkipPersistence]: true,
  };

  return requirement;
}

// === BOOLEAN REQUIREMENT ===

/**
 * Options for creating a boolean requirement
 */
export interface BooleanRequirementOptions {
  /** The condition that must be true */
  met: Computable<boolean>;
  /** Description for UI display */
  description?: Computable<string>;
}

/**
 * Create a simple true/false requirement.
 *
 * @param options - Configuration for the boolean requirement
 * @returns A boolean requirement
 *
 * @example
 * ```ts
 * const unlockRequirement = createBooleanRequirement({
 *   met: () => upgrades.unlock.active.value,
 *   description: "Unlock upgrade purchased"
 * })
 * ```
 */
export function createBooleanRequirement(options: BooleanRequirementOptions): Requirement {
  const { met: requirement, description } = options;

  return {
    met: toMaybeRef(requirement),
    requiresPay: false,
    description: description != null ? toMaybeRef(description) : undefined,
    [SkipPersistence]: true,
  } satisfies Requirement;
}

// === COMBINATORS ===

// Combinators always expose boolean `met` and `canMaximize: false`.
// Bulk semantics across mixed children (cost + boolean, OR-gated branches) are
// not well-defined, and `maxRequirementsMet` returns `dInf`/`0` for boolean
// requirements — combinators are not bulk-aware. Use combinators where the
// caller pays `amount = 1` (the conversion case); for bulk-aware composition,
// stay on flat arrays of cost requirements.

/**
 * Compose requirements with OR semantics.
 *
 * The combinator is satisfied when any child is satisfied. At pay time, the
 * **first satisfied child** (in declaration order) is the satisfied branch:
 * if it's pay-bearing, it is charged; if it's a pure gate, no payment occurs.
 * Later children — even pay-bearing satisfied ones — are not charged.
 *
 * This matches the natural reading of "A OR B": when the earlier branch
 * satisfies, the later one is bypassed. Use it for cost-or-override gates
 * (e.g. `cost OR unlock-achievement`) where a pure-gate satisfaction should
 * waive the cost.
 *
 * @param children - Requirements to OR together
 * @returns A {@link Requirement} satisfied iff any child is satisfied
 *
 * @example
 * ```ts
 * // Prestige gates on accumulated source OR computed gain floor; the gain
 * // branch is a pure gate, so it doesn't trigger payment of the cost branch.
 * createConversion({
 *   inputs: {
 *     trigger: anyOf(
 *       createCostRequirement({ resource: coins, cost: 1e16 }),
 *       createBooleanRequirement({ met: () => Decimal.gte(prestigeGain.value, 100) }),
 *     ),
 *   },
 *   outputs: { … },
 * });
 * ```
 */
export function anyOf(...children: Requirement[]): Requirement {
  return {
    met: computed(() => children.some((c) => requirementsMet(c))),
    requiresPay: computed(() => {
      for (const child of children) {
        if (requirementsMet(child)) return unref(child.requiresPay);
      }
      return false;
    }),
    canMaximize: false,
    pay: (amount: DecimalSource = 1) => {
      for (const child of children) {
        if (requirementsMet(child)) {
          if (unref(child.requiresPay)) {
            child.pay?.(amount);
          }
          return;
        }
      }
    },
    description: computed(() => {
      const parts = children.map((c) => unref(c.description)).filter((d): d is string => !!d);
      return parts.length > 0 ? parts.join(' OR ') : undefined;
    }) as MaybeRef<string>,
    [SkipPersistence]: true,
  };
}

/**
 * Compose requirements with AND semantics.
 *
 * The combinator is satisfied when every child is satisfied. At pay time, all
 * pay-bearing children are charged — matching today's flat-array semantics in
 * `payRequirements`. Useful for nesting inside `anyOf` to regain symmetry,
 * since the top-level conversion-input map is already implicit-AND.
 *
 * @param children - Requirements to AND together
 * @returns A {@link Requirement} satisfied iff every child is satisfied
 *
 * @example
 * ```ts
 * // "(coins ≥ 1e16 AND tier-2-unlocked) OR computed-gain ≥ 100"
 * anyOf(
 *   allOf(
 *     createCostRequirement({ resource: coins, cost: 1e16 }),
 *     createBooleanRequirement({ met: () => tier2Unlocked.value }),
 *   ),
 *   createBooleanRequirement({ met: () => Decimal.gte(prestigeGain.value, 100) }),
 * );
 * ```
 */
export function allOf(...children: Requirement[]): Requirement {
  return {
    met: computed(() => children.every((c) => requirementsMet(c))),
    requiresPay: computed(() => children.some((c) => unref(c.requiresPay))),
    canMaximize: false,
    pay: (amount: DecimalSource = 1) => {
      for (const child of children) {
        if (unref(child.requiresPay)) {
          child.pay?.(amount);
        }
      }
    },
    description: computed(() => {
      const parts = children.map((c) => unref(c.description)).filter((d): d is string => !!d);
      return parts.length > 0 ? parts.join(' AND ') : undefined;
    }) as MaybeRef<string>,
    [SkipPersistence]: true,
  };
}

// === UTILITY FUNCTIONS ===

/**
 * Check if all requirements are met
 *
 * @param requirements - One or more requirements to check
 * @returns true if all requirements are satisfied
 */
export function requirementsMet(requirements: Requirements): boolean {
  if (Array.isArray(requirements)) {
    return requirements.every(requirementsMet);
  }

  const met = unref(requirements.met);
  return typeof met === 'boolean' ? met : Decimal.gt(met, 0);
}

/**
 * Calculate the maximum number of times requirements can be met.
 * Used for bulk purchases.
 *
 * @param requirements - One or more requirements to check
 * @returns Maximum times all requirements can be satisfied
 */
export function maxRequirementsMet(requirements: Requirements): DecimalSource {
  if (Array.isArray(requirements)) {
    // Empty array is vacuously satisfied (matches `requirementsMet([])`'s
    // `every` shape). Returning Decimal.dInf mirrors the boolean-true branch
    // below — "satisfiable any number of times" — and avoids the empty-reduce
    // throw the public bulk-purchase callers would otherwise propagate.
    if (requirements.length === 0) return Decimal.dInf;
    // Return the minimum across all requirements. Renorm after each min so the
    // typeof fast path can fire on subsequent iterations. No initial
    // value — first-element type determines starting shape; renorm applies to
    // whatever Decimal.min returns.
    return requirements.map(maxRequirementsMet).reduce((a, b) => renormIfLayer0(Decimal.min(a, b)));
  }

  const met = unref(requirements.met);

  if (typeof met === 'boolean') {
    return met ? Decimal.dInf : 0;
  }

  // If requirement doesn't support maximizing, cap at 1
  if (Decimal.gt(met, 1) && unref(requirements.canMaximize) !== true) {
    return 1;
  }

  return met;
}

/**
 * Pay the costs for one or more requirements
 *
 * @param requirements - Requirements to pay for
 * @param amount - Number of times to pay (for bulk)
 */
export function payRequirements(requirements: Requirements, amount: DecimalSource = 1): void {
  if (Array.isArray(requirements)) {
    for (const req of requirements) {
      if (unref(req.requiresPay)) {
        req.pay?.(amount);
      }
    }
  } else if (unref(requirements.requiresPay)) {
    requirements.pay?.(amount);
  }
}

/**
 * Get descriptions for all requirements
 *
 * @param requirements - Requirements to describe
 * @returns Array of description strings
 */
export function getRequirementDescriptions(requirements: Requirements): string[] {
  const reqs = Array.isArray(requirements) ? requirements : [requirements];
  return reqs.map((r) => unref(r.description)).filter((d): d is string => d != null);
}

// === PAY FUNCTIONS ===

/**
 * Pay strategy: divide resource instead of subtract.
 * Useful for prestige mechanics where you keep a fraction.
 */
export function payByDivision(requirement: CostRequirement, amount: DecimalSource = 1): void {
  const cost = requirement.getCost(amount);
  requirement.resource.value = Decimal.div(requirement.resource.value, cost);
}

/**
 * Pay strategy: reset resource to default value.
 * Standard prestige behavior.
 */
export function payByReset(requirement: CostRequirement, overrideValue?: DecimalSource): void {
  if (overrideValue !== undefined) requirement.resource.value = overrideValue;
  else resetResource(requirement.resource);
}

/**
 * Create a pay function that resets to default
 */
export function createResetPay(overrideValue?: DecimalSource): (amount?: DecimalSource) => void {
  return function (this: CostRequirement) {
    payByReset(this, overrideValue);
  };
}

// === TYPE GUARDS ===

/**
 * Check if a requirement is a cost requirement
 */
export function isCostRequirement(req: Requirement): req is CostRequirement {
  return 'resource' in req && 'cost' in req;
}
