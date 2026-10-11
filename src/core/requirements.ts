/**
 * Requirements — the costs and tests that block purchases, unlocks and actions
 *
 * A requirement must be met before something can be purchased or activated.
 *
 * Key features:
 * - Cost requirements (spend a resource to purchase)
 * - Boolean requirements (simple true/false tests)
 * - Composable (requirements combine with `anyOf` / `allOf`)
 * - Bulk purchases via formulas
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
   * Whether this requirement supports a bulk purchase.
   * If true, `met` returns how many purchases are affordable.
   */
  canMaximize?: MaybeRef<boolean>;

  /**
   * Pay the cost of this requirement.
   * Called when the requirement is used (e.g., purchasing an upgrade).
   *
   * @param count - Number of times to pay (for bulk purchases)
   */
  pay?: (count?: DecimalSource) => void;

  /**
   * Human-readable description of this requirement.
   */
  description?: MaybeRef<string>;

  /**
   * Mark as ephemeral, so the save walk skips it (internal use)
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
   * The cost of one purchase. Three shapes, and the choice decides whether a
   * bulk purchase costs the right amount:
   *
   * - **A static value** — bulk is exact. `n` purchases cost `n × cost`.
   * - **A getter or ref** — bulk cost is linear in the *current* value. That
   *   is exact only while the value doesn't change as you purchase. A
   *   getter that ignores the purchase count (a tunable, a scoped override) is
   *   fine. A getter that reads the purchasable's own purchase count is
   *   **silently wrong**. Three purchases on a `1.15ⁿ` curve cost `3c` rather
   *   than `c + 1.15c + 1.3225c`, and affordability is over-reported to match.
   * - **A {@link GenericFormula}** — bulk walks the real curve, via inversion
   *   (`calculateMaxAffordable`) and closed-form summation (`calculateCost`).
   *   The only correct shape for a cost that scales on what's being purchased.
   *
   * The wrong cost appears only with `maxBulkCount > 1`. So
   * `createPurchasableCategory` and `createScalingPurchasable` reach it only
   * when asked to. When a cost scales on a purchasable's own purchase count,
   * build it as a Formula over the count ref that
   * `PurchasableOptions.requirements` hands its factory form.
   */
  cost: Computable<DecimalSource> | GenericFormula;

  /** Whether this requirement requires payment (default: true) */
  requiresPay?: Computable<boolean>;

  /**
   * For a Formula cost `f` over the purchase count `L`: whether purchasing
   * `n` sums the levels purchased. If true, it costs
   * `f(L) + f(L+1) + … + f(L+n−1)`. If false, it costs one evaluation,
   * `f(L+n)`, so even a single purchase costs one level ahead of the sum.
   * Default: true
   */
  sumLevels?: Computable<boolean>;

  /**
   * The most purchases one bulk purchase may cover. Default: `1`,
   * which confines every cost shape to single purchases. That is why a
   * wrong getter cost has no effect until this is raised. Raise it (to
   * `Decimal.dInf` for no maximum) only with a Formula cost — see
   * {@link CostRequirementOptions.cost}.
   */
  maxBulkCount?: Computable<DecimalSource>;

  /** Custom pay function (replaces the default resource subtraction) */
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

  /** The cost value or formula */
  cost: MaybeRef<DecimalSource> | GenericFormula;

  /** Whether a bulk purchase sums the levels purchased */
  sumLevels: MaybeRef<boolean>;

  /** Maximum bulk count */
  maxBulkCount: MaybeRef<DecimalSource>;

  /** Get the actual cost for a given purchase count */
  getCost: (count?: DecimalSource) => DecimalSource;
}

/**
 * Create a requirement based on spending a resource.
 *
 * @param options - Options for the cost requirement
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
 * // Scaling cost for bulk purchases, over the count ref the purchasable
 * // hands its `requirements` factory
 * const scalingCost = createCostRequirement({
 *   resource: points,
 *   cost: Formula.variable(count).pow_base(2).mul(10), // 10 * 2^count
 *   maxBulkCount: 10
 * })
 * ```
 */
export function createCostRequirement(options: CostRequirementOptions): CostRequirement {
  const { resource, cost, requiresPay, sumLevels, maxBulkCount, pay, description } = options;

  const processedCost = isFormula(cost) ? cost : toMaybeRef(cost);
  const processedSumLevels = sumLevels != null ? toMaybeRef(sumLevels) : true;
  const processedMaxBulkCount = maxBulkCount != null ? toMaybeRef(maxBulkCount) : 1;

  // Precomputed formula affordability — reactive via calculateMaxAffordable's own computed.
  const formulaMaxAffordable = isFormula(processedCost)
    ? calculateMaxAffordable(processedCost, resource, processedSumLevels, processedMaxBulkCount)
    : null;

  function getCost(amount: DecimalSource = 1): DecimalSource {
    if (isFormula(processedCost)) {
      return calculateCost(processedCost, amount, unref(processedSumLevels));
    }
    return Decimal.mul(unref(processedCost), amount);
  }

  const met = computed((): DecimalSource => {
    if (formulaMaxAffordable) return unref(formulaMaxAffordable);

    const available = resource.value;
    const maxBulk = unref(processedMaxBulkCount);
    const singleCost = unref(processedCost as MaybeRef<DecimalSource>);
    if (Decimal.lte(singleCost, 0)) return maxBulk;

    // Tolerance-aware floor: Decimal.div(x, x) returns 0.999...9 for break_eternity
    // layer-0 inputs at certain scales, so a naive floor reports 0 affordable at
    // exact equality. Snap to ceil when within FP-precision tolerance of an integer.
    // Tolerance is tight (1e-12) — wide enough to catch the break_eternity layer-0
    // div quirk (~1e-16 absolute), narrow enough not to falsely snap fractional
    // amounts (e.g., 49.99 vs 50). At higher break_eternity layers, eq_tolerance
    // compares log-magnitudes, so this stays safe at tetration scale.
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
    sumLevels: processedSumLevels,
    maxBulkCount: processedMaxBulkCount,
    getCost,

    met,
    requiresPay: requiresPay != null ? toMaybeRef(requiresPay) : true,

    canMaximize: computed(() => {
      const max = unref(processedMaxBulkCount);
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
  /** The test that must hold */
  met: Computable<boolean>;
  /** Description for UI display */
  description?: Computable<string>;
}

/**
 * Create a simple true/false requirement.
 *
 * @param options - Options for the boolean requirement
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
// Bulk meaning across mixed children (cost + boolean, OR branches) is
// not well-defined, and `maxRequirementsMet` returns `dInf`/`0` for boolean
// requirements — combinators are not bulk-aware. Use combinators where the
// caller pays `amount = 1` (the conversion case); for bulk-aware composition,
// stay on flat arrays of cost requirements.

/**
 * Compose requirements with OR semantics.
 *
 * The combinator is met when any child is met. At pay time, the **first met
 * child** (in declaration order) is the met branch: if it requires payment,
 * it pays; if it is a pure test, nothing is paid. Later children — even met
 * ones that require payment — do not pay.
 *
 * This matches the natural reading of "A OR B": when the earlier branch is
 * met, the later one is bypassed. Use it for a cost with a test that waives
 * it (e.g. `cost OR achievement earned`), where a met pure test should
 * waive the cost.
 *
 * @param children - Requirements to OR together
 * @returns A {@link Requirement} met iff any child is met
 *
 * @example
 * ```ts
 * // Prestige needs enough coins OR enough prestige gain; the gain
 * // branch is a pure test, so it doesn't make the cost branch pay.
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
 * The combinator is met when every child is met. At pay time, every child
 * that requires payment pays, as `payRequirements` does for a flat array.
 * Useful for nesting inside `anyOf` to regain symmetry, since the top-level
 * conversion-input map is already implicit-AND.
 *
 * @param children - Requirements to AND together
 * @returns A {@link Requirement} met iff every child is met
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
 * @returns true if all requirements are met
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
 * @returns Maximum times all requirements can be met
 */
export function maxRequirementsMet(requirements: Requirements): DecimalSource {
  if (Array.isArray(requirements)) {
    // Empty array is vacuously met (matches `requirementsMet([])`'s
    // `every` shape). Returning Decimal.dInf mirrors the boolean-true branch
    // below — "met any number of times" — and avoids the empty-reduce
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
 * Pay function: divide the resource instead of subtracting.
 * Useful for prestige mechanics where you keep a fraction.
 */
export function payByDivision(requirement: CostRequirement, amount: DecimalSource = 1): void {
  const cost = requirement.getCost(amount);
  requirement.resource.value = Decimal.div(requirement.resource.value, cost);
}

/**
 * Pay function: reset the resource to its ref default.
 * Standard prestige behavior.
 */
export function payByReset(requirement: CostRequirement, overrideValue?: DecimalSource): void {
  if (overrideValue !== undefined) requirement.resource.value = overrideValue;
  else resetResource(requirement.resource);
}

/**
 * Create a pay function that resets the resource to its ref default
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
