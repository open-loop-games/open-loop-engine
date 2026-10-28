/**
 * Purchasable system — unified purchase primitives for incremental games
 *
 * A Purchasable represents anything the player purchases: one-shot upgrades,
 * repeatable upgrades, perks with a limit. The `limit` option decides the shape:
 *
 * - `limit: 1` — one-shot upgrade (a boolean `active` read, no count shown)
 * - `limit: N` — repeatable purchase with a limit (the count tracks purchases, maxed at N)
 * - `limit: Infinity` — unlimited repeatable purchase (the default)
 *
 * Consumers build purchasables through the category factory
 * {@link createPurchasableCategory} (L2). {@link createScalingPurchasable}
 * is the L3 factory for one customized repeatable purchase that doesn't fit
 * a category's map shape. It sets up a Formula-aware cost and effect that
 * the raw factory can't express cleanly. {@link createPurchasable} is
 * engine-internal.
 *
 * For auto-purchase, see {@link setupSweepAutoPurchase} /
 * {@link setupPolicyAutoPurchase} in `./auto-purchase`.
 */

import { computed, isRef, unref, type ComputedRef, type MaybeRef, type Ref } from 'vue';
import { Decimal, type DecimalSource, formatOperand } from '@/primitives/decimal';
import { toMaybeRef, type Computable } from '@/core/computed';
import {
  persistent,
  type Persistent,
  DefaultValue,
  cloneDefault,
  withPersistentContext,
  getCurrentPersistentContext,
  SkipPersistence,
} from '@/core/persistence';
import {
  type Requirements,
  type Requirement,
  requirementsMet,
  maxRequirementsMet,
  payRequirements,
  createCostRequirement,
} from '@/core/requirements';
import type { Resource } from '@/core/resource';
import { createEmitHandle, type Emittable } from '@/core/events';
import { attachPersistentContextReset } from '@/core/resettable';
import Formula, { toFormula } from '@/core/formulas/formulas';
import type { FormulaSource, GenericFormula } from '@/core/formulas/types';
import { createPredicateResolver, type Predicate, type PredicateResolver } from './gate';

// === TYPES ===

/** Events emitted by a {@link Purchasable} instance */
export interface PurchasableEvents {
  /** Emitted after each purchase, with that purchase's bulk count, not the new `count` */
  purchased: (bulkCount: DecimalSource) => void;
}

/** UI text for a purchasable. Each text field can be a ref or getter for reactive text. */
export interface PurchasableDisplay {
  /** Title shown at the top of the purchasable card */
  title?: Computable<string>;
  /** Main description explaining what this purchasable does. Default: `''` */
  description?: Computable<string>;
  /** Formatted current effect (e.g., "×8 production"). Shown below description. */
  effectDescription?: Computable<string>;
  /**
   * Whether to show the current count (e.g., "5 owned").
   * Default: `false` when limit is 1, `true` otherwise.
   */
  showCount?: boolean;
}

/**
 * Full options for {@link createPurchasable} — the engine-internal raw
 * factory. Consumers build this shape through `mapPurchasable` on
 * {@link createPurchasableCategory}; this field set types what it returns.
 *
 * For a scaling cost outside a category, use
 * {@link ScalingPurchasableOptions} on {@link createScalingPurchasable}.
 */
export interface PurchasableOptions {
  /**
   * Save identity, unique among the purchasables in the same persistent context.
   * The purchase count saves under it, so it must not change between game builds.
   */
  id: string;
  /** UI text — either a full {@link PurchasableDisplay} or a plain string/getter for description-only */
  display: PurchasableDisplay | Computable<string>;
  /**
   * What the player must have or spend per purchase (cost requirements, boolean predicates, etc.).
   *
   * Pass a **function** to build requirements over this purchasable's own count.
   * The function receives the live `count` ref, which doesn't exist yet when
   * the plain form is evaluated. So it's the only way to declare a cost that
   * scales on the thing being purchased:
   *
   * ```ts
   * requirements: (count) =>
   *   createCostRequirement({
   *     resource: gold,
   *     cost: Formula.exponential(count, def.baseCost, 1.15).floor(),
   *     maxBulkCount: Decimal.dInf,
   *   })
   * ```
   *
   * Prefer it over a `cost: () => …` getter that reads the count back out of a
   * category. A getter cost treats every unit of a bulk purchase as costing
   * what the next unit costs now. So purchase max undercharges a scaling cost
   * (see {@link CostRequirementOptions.cost}). A Formula over `count` is invertible,
   * so bulk purchasing walks the real curve. Multiple resources work too:
   * return an array of cost requirements over the same `count`.
   */
  requirements: Requirements | ((count: MaybeRef<DecimalSource>) => Requirements);
  /** The limit: the most purchases. Default: `Infinity` (no limit) */
  limit?: Computable<DecimalSource>;
  /** Starting count (useful for purchasables that begin purchased). Default: `0` */
  initialCount?: DecimalSource;
  /**
   * Effect value or function.
   *
   * - `Computable<DecimalSource>` — static or reactive value (typical for one-shot).
   *   Exposed directly and not blocked: it reports the full effect value before
   *   the upgrade is purchased. So read it behind `active` (or through `grants`,
   *   which apply only while active) wherever it applies rather than previews.
   * - `(count: DecimalSource) => DecimalSource` — computed from the count (typical for repeatable).
   *
   * If omitted, effect defaults to `1` (identity for multiplication).
   */
  effect?: Computable<DecimalSource> | ((count: DecimalSource) => DecimalSource);
  /** Option callback called after each purchase, with that purchase's bulk count, not the new `count` */
  onPurchase?: (bulkCount: DecimalSource) => void;
  /** Whether this purchasable is visible to the player. Default: `true` */
  visible?: Predicate;
  /**
   * Whether a purchase purchases max. Off, every `purchase()` and
   * `purchaseMax()` takes one unit.
   * Default: `false` when limit is 1, `true` otherwise.
   */
  purchaseMaxByDefault?: Computable<boolean>;
}

/** Curve factory over a purchasable's count — receives the engine-owned count ref. */
type CountCurve = (count: MaybeRef<DecimalSource>) => FormulaSource;

/**
 * Cost options for {@link ScalingPurchasableOptions}. A discriminated
 * union: provide exactly one shape.
 *
 * - **Geometric** (`baseCost + costRatio`) — closed-form `baseCost × costRatio^count`,
 *   not rounded. For whole-unit costs, use `costFormula` with
 *   `Formula.exponential(count, baseCost, costRatio).floor()`.
 * - **Formula** (`costFormula`) — any curve the Formula vocabulary expresses.
 *   Invertible, so bulk purchasing walks the real curve, a `.floor()`ed one included.
 * - **Function** (`cost`) — any cost shape the Formula vocabulary can't
 *   express (super-exponential, piecewise, a table lookup). One unit per purchase only.
 */
export type ScalingPurchasableCost =
  | {
      /** Cost of the first purchase. Can be a ref or getter, for a tunable or a scoped override. */
      baseCost: Computable<DecimalSource>;
      /**
       * The cost ratio (e.g., `1.15` for a 15% rise per purchase).
       * Can be a ref or getter, for a tunable or a scoped override.
       */
      costRatio: Computable<DecimalSource>;
      costFormula?: never;
      cost?: never;
    }
  | {
      /**
       * Curve factory for the cost of the next purchase. Called once at
       * creation with the count ref. The returned Formula supports `.invert()`,
       * so `calculateMaxAffordable` can do bulk-purchase math. A plain value
       * returned instead is the cost of every purchase.
       */
      costFormula: CountCurve;
      baseCost?: never;
      costRatio?: never;
      cost?: never;
    }
  | {
      /**
       * Cost of the next purchase as a plain function of the current count,
       * re-read whenever the count changes. One unit per purchase only: bulk
       * math needs a Formula.
       */
      cost: (count: DecimalSource) => DecimalSource;
      baseCost?: never;
      costRatio?: never;
      costFormula?: never;
    };

/**
 * Effect options for {@link ScalingPurchasableOptions} — at most one of
 * `effect` (a static base or a plain function) or `effectFormula` (a curve
 * factory). With neither, the purchasable has no effect.
 */
export type ScalingPurchasableEffect =
  | {
      /**
       * Effect per purchase. Two shapes:
       *
       * - `DecimalSource` — static base applied as `base^count`. Wrapped as an
       *   invertible, integrable `Formula` internally, and exposed on the result
       *   as `effectCurve` for inversion queries ("count required for ×100?").
       * - `(count: DecimalSource) => DecimalSource` — custom logic.
       *   Forward evaluation only; `effectCurve` is undefined.
       */
      effect?: DecimalSource | ((count: DecimalSource) => DecimalSource);
      effectFormula?: never;
    }
  | {
      /**
       * Curve factory for the effect. Receives the count ref; the returned
       * Formula becomes `effectCurve` on the result. Use this for
       * non-exponential curves (linear, polynomial, soft-capped) that still
       * need invertibility.
       */
      effectFormula: CountCurve;
      effect?: never;
    };

/**
 * Shorthand options for {@link createScalingPurchasable} — repeatable purchases
 * with a geometric, Formula or function cost. Defaults `limit: Infinity`.
 *
 * Cost and effect shapes each take their own key — see
 * {@link ScalingPurchasableCost} and {@link ScalingPurchasableEffect}.
 */
export type ScalingPurchasableOptions = {
  /** Save identity — see {@link PurchasableOptions.id}. */
  id: string;
  /** Display title */
  title?: Computable<string>;
  /** Description of what this purchasable does. Default: `''` */
  description?: Computable<string>;
  /** The resource spent to purchase */
  resource: Resource;
  /**
   * Formatted current effect, for effects a `×N` text misstates
   * (additive effects, flat amounts). Can be a ref or getter. Default: `×`
   * followed by the effect, when an effect is set.
   */
  effectDescription?: Computable<string>;
  /** Whether to show the current count. Default: `false` when limit is 1, `true` otherwise. */
  showCount?: boolean;
  /** The limit: the most purchases. Default: `Infinity` */
  limit?: Computable<DecimalSource>;
  /** Starting count. Default: `0` */
  initialCount?: DecimalSource;
  /** Option callback called after each purchase, with that purchase's bulk count, not the new `count` */
  onPurchase?: (bulkCount: DecimalSource) => void;
  /** Whether this purchasable is visible. Default: `true` */
  visible?: Predicate;
  /**
   * Whether a purchase purchases max; off, each purchase takes one unit.
   * Default: `false` when limit is 1, `true` otherwise.
   */
  purchaseMaxByDefault?: Computable<boolean>;
} & ScalingPurchasableCost &
  ScalingPurchasableEffect;

/**
 * A purchasable — the returned object from {@link createPurchasable}.
 *
 * Read `count.value` for the purchase count, or `active.value` for "is it on?" checks.
 * Call `purchase()` or `purchaseMax()` to purchase.
 */
export interface Purchasable {
  id: string;
  /** Purchase count (a persistent ref) */
  count: Persistent<DecimalSource>;
  /**
   * `true` when `count >= 1`, derived from the count. The status read for
   * callers that only ask whether this is "on" (one-shot upgrades, unlocks
   * behind a predicate). Repeatable purchasables read `count` instead.
   */
  active: ComputedRef<boolean>;
  /** `true` when the purchasable is visible, its requirements are met and its limit isn't reached */
  canPurchase: ComputedRef<boolean>;
  /** The count a `purchase()` call would take (respects `purchaseMaxByDefault`, bulk count and limit) */
  countToPurchase: ComputedRef<DecimalSource>;
  /** `true` when the count has reached the limit */
  maxed: ComputedRef<boolean>;
  /** The purchase limit */
  limit: MaybeRef<DecimalSource>;
  /** All requirements, the internal limit requirement included */
  requirements: Requirements;
  /** Resolved display text (reactive) */
  display: {
    title: MaybeRef<string | undefined>;
    description: MaybeRef<string>;
    effectDescription: MaybeRef<string | undefined>;
    showCount: boolean;
  };
  /** Current effect value — computed from the count for a function effect, or the static value */
  effect: ComputedRef<DecimalSource>;
  /**
   * The underlying effect Formula when one exists — present when
   * {@link ScalingPurchasableOptions} set `effectFormula` or a `DecimalSource`
   * `effect`. Use `.invert(target)` for "count required for effect ≥ target"
   * queries. Undefined when the effect is a plain function.
   */
  effectCurve?: GenericFormula;
  /** Whether this purchasable is currently visible */
  visible: ComputedRef<boolean>;
  /** Whether a purchase purchases max; off, each purchase takes one unit */
  purchaseMaxByDefault: MaybeRef<boolean>;
  /**
   * Purchase. A passed count caps the purchase. Omitted, it purchases max when
   * `purchaseMaxByDefault` is on (the default for anything but a one-shot), up
   * to the cost's `maxBulkCount`, and one when it's off.
   * Returns how many units this purchase took, or `0` when it took none. So
   * `if (p.purchase())` reads as "something was purchased".
   */
  purchase: (count?: DecimalSource) => Decimal | 0;
  /** Purchase max, or one unit when `purchaseMaxByDefault` is off. Returns the count purchased, or `0` for none. */
  purchaseMax: () => Decimal | 0;
  /**
   * Estimate the total cost of the next `count` purchases. Default count: `1`.
   * Sums every cost requirement, whatever resource each charges. So for a
   * cost in two or more resources, read each cost requirement's `getCost`
   * from `requirements` instead.
   */
  getCost: (count?: DecimalSource) => DecimalSource;
  /** The `onPurchase` option callback, if set */
  onPurchase?: (bulkCount: DecimalSource) => void;
  /** Subscribe to purchasable lifecycle events */
  on: Emittable<PurchasableEvents>['on'];
}

// === PRIVATE BUILDERS ===

/**
 * Detect whether an effect option is a count function or a Computable.
 * Count functions have `length >= 1` (they take a `count` parameter).
 */
function isCountFunction(
  effect: Computable<DecimalSource> | ((count: DecimalSource) => DecimalSource),
): effect is (count: DecimalSource) => DecimalSource {
  return typeof effect === 'function' && effect.length >= 1;
}

/**
 * The display object a display option names; a string, ref or getter is the description.
 *
 * @internal Also read by the producer category.
 */
export function toPurchasableDisplay(
  display: PurchasableDisplay | Computable<string>,
): PurchasableDisplay {
  return typeof display === 'object' && !isRef(display) ? display : { description: display };
}

/** Resolve a display option into reactive fields. */
function buildPurchasableDisplay(
  display: PurchasableDisplay | Computable<string>,
  isOneShot: boolean,
): {
  title: MaybeRef<string | undefined>;
  description: MaybeRef<string>;
  effectDescription: MaybeRef<string | undefined>;
  showCount: boolean;
} {
  const disp = toPurchasableDisplay(display);
  return {
    title: toMaybeRef(disp.title),
    description: toMaybeRef(disp.description ?? ''),
    effectDescription: toMaybeRef(disp.effectDescription),
    showCount: disp.showCount ?? !isOneShot,
  };
}

/** Synthetic limit requirement that blocks purchases at the limit. */
function buildLimitRequirement(
  processedLimit: MaybeRef<DecimalSource>,
  count: Persistent<DecimalSource>,
): Requirement {
  return {
    met: computed((): DecimalSource => {
      const lim = unref(processedLimit);
      const current = count.value;
      return Decimal.max(Decimal.sub(lim, current), 0);
    }),
    requiresPay: false,
    canMaximize: true,
    [SkipPersistence]: true,
  };
}

/** Reactive active/maxed/canPurchase/countToPurchase computeds. */
function buildPurchasableComputeds(
  count: Persistent<DecimalSource>,
  processedLimit: MaybeRef<DecimalSource>,
  visible: ComputedRef<boolean>,
  processedPurchaseMaxByDefault: MaybeRef<boolean>,
  allRequirements: Requirements,
): {
  active: ComputedRef<boolean>;
  maxed: ComputedRef<boolean>;
  canPurchase: ComputedRef<boolean>;
  countToPurchase: ComputedRef<DecimalSource>;
} {
  const active = computed((): boolean => Decimal.gte(count.value, 1));

  const maxed = computed((): boolean => {
    const lim = unref(processedLimit);
    return Decimal.gte(count.value, lim);
  });

  const canPurchase = computed((): boolean => {
    if (maxed.value) return false;
    if (!visible.value) return false;
    return requirementsMet(allRequirements);
  });

  const countToPurchase = computed((): DecimalSource => {
    if (!unref(processedPurchaseMaxByDefault)) {
      return canPurchase.value ? 1 : 0;
    }
    return Decimal.max(1, maxRequirementsMet(allRequirements));
  });

  return { active, maxed, canPurchase, countToPurchase };
}

/** Resolve effect option (computable / count-fn / undefined) into a single computed. */
function buildEffectComputed(
  effect: PurchasableOptions['effect'],
  count: Persistent<DecimalSource>,
): ComputedRef<DecimalSource> {
  if (effect == null) {
    return computed(() => 1);
  }
  if (isCountFunction(effect)) {
    return computed(() => effect(count.value));
  }
  const processedEffect = toMaybeRef(effect);
  return computed(() => unref(processedEffect) ?? 1);
}

/** Cost-estimation closure that delegates to each requirement's own getCost. */
function buildGetCost(baseReqs: Requirement[]): (purchaseCount?: DecimalSource) => DecimalSource {
  return function getCost(purchaseCount: DecimalSource = 1): DecimalSource {
    let totalCost: DecimalSource = Decimal.dZero;
    for (const req of baseReqs) {
      if ('getCost' in req && typeof (req as { getCost?: unknown }).getCost === 'function') {
        totalCost = Decimal.add(
          totalCost,
          (req as { getCost: (n: DecimalSource) => DecimalSource }).getCost(purchaseCount),
        );
      }
    }
    return totalCost;
  };
}

/**
 * Resolve the {@link ScalingPurchasableOptions} cost shape into a
 * {@link CostRequirement}. A `costFormula` curve factory is called once at
 * creation, and its Formula makes the cost invertible, so bulk purchasing works
 * through `calculateMaxAffordable`. A `cost` function becomes a getter cost
 * (one unit per purchase only).
 */
function buildScalingCostRequirement(
  options: ScalingPurchasableOptions,
  count: Ref<DecimalSource>,
  limit: Computable<DecimalSource> | undefined,
): Requirement {
  if (options.costFormula !== undefined) {
    return createCostRequirement({
      resource: options.resource,
      cost: toFormula(options.costFormula(count)),
      maxBulkCount: limit ?? Decimal.dInf,
    });
  }

  if (options.cost !== undefined) {
    // Re-read against the live count; bulk math is unavailable
    // (createCostRequirement only supports it for Formula costs).
    const costFn = options.cost;
    return createCostRequirement({
      resource: options.resource,
      cost: () => costFn(count.value),
      maxBulkCount: 1,
    });
  }

  // Geometric path. toMaybeRef so a tunable()/ref baseCost or costRatio
  // flows reactively into the Formula. Formula sources accept
  // MaybeRef<DecimalSource>, so the exponential re-evaluates when either
  // underlying ref changes (e.g., a scoped override pushed on a tunable).
  const processedBaseCost = toMaybeRef(options.baseCost);
  const processedCostRatio = toMaybeRef(options.costRatio);
  return createCostRequirement({
    resource: options.resource,
    cost: Formula.exponential(count, processedBaseCost, processedCostRatio),
    maxBulkCount: limit ?? Decimal.dInf,
  });
}

/**
 * Resolve the {@link ScalingPurchasableEffect} options into a forward
 * function and (when possible) an invertible {@link Formula}.
 */
function buildScalingEffect(
  options: ScalingPurchasableEffect,
  count: Ref<DecimalSource>,
): {
  effectFn: ((count: DecimalSource) => DecimalSource) | undefined;
  effectCurve: GenericFormula | undefined;
} {
  const { effect, effectFormula } = options;
  const fromCurve = (curve: GenericFormula) => ({
    effectCurve: curve,
    effectFn: (count: DecimalSource) => new Decimal(curve.evaluate(count)),
  });
  if (effectFormula !== undefined) return fromCurve(toFormula(effectFormula(count)));
  if (effect === undefined || typeof effect === 'function') {
    return { effectCurve: undefined, effectFn: effect };
  }
  // A static base becomes `base^count`, an invertible Formula.
  return fromCurve(Formula.variable(count).pow_base(effect));
}

/**
 * The purchasable's saved count, in a child persistent context of its own. So
 * purchasables under one enclosing persistent context (e.g. `layer0`) don't
 * collide on `count`.
 */
function buildPurchasableCount(
  id: string,
  initialCount: DecimalSource | undefined,
): { contextId: string; count: Persistent<DecimalSource> } {
  const parentContext = getCurrentPersistentContext();
  const contextId = parentContext ? `${parentContext}:${id}` : id;
  const count = withPersistentContext(contextId, () =>
    persistent<DecimalSource>(0, { id: 'count' }),
  );

  if (initialCount !== undefined) {
    (count as { [DefaultValue]: DecimalSource })[DefaultValue] = cloneDefault(initialCount);
    if (Decimal.eq(count.value, 0)) {
      count.value = cloneDefault(initialCount);
    }
  }
  return { contextId, count };
}

/** Everything a purchasable builds over its count, once `count` exists. */
function assemblePurchasable(
  options: PurchasableOptions,
  count: Persistent<DecimalSource>,
  contextId: string,
  predicates: PredicateResolver,
): Purchasable {
  const { id, display, requirements, limit, effect, onPurchase, visible, purchaseMaxByDefault } =
    options;

  const processedLimit = limit != null ? toMaybeRef(limit) : Decimal.dInf;
  const isOneShot = Decimal.eq(unref(processedLimit), 1);
  const processedVisible = predicates.adopt(visible, true, `purchasable '${id}' visible`).holds;
  const processedPurchaseMaxByDefault =
    purchaseMaxByDefault != null ? toMaybeRef(purchaseMaxByDefault) : !isOneShot;

  const resolvedDisplay = buildPurchasableDisplay(display, isOneShot);

  // The function form resolves here, after `count` exists. That ordering is
  // the whole point: a cost scaling on this purchasable's own count can't be
  // declared before the ref it reads. `Requirements` is never a function, so
  // the typeof discriminates unambiguously.
  const resolvedRequirements =
    typeof requirements === 'function' ? requirements(count) : requirements;
  const baseReqs = Array.isArray(resolvedRequirements)
    ? resolvedRequirements
    : [resolvedRequirements];
  const limitRequirement = buildLimitRequirement(processedLimit, count);
  const allRequirements: Requirements = [...baseReqs, limitRequirement];

  const { active, maxed, canPurchase, countToPurchase } = buildPurchasableComputeds(
    count,
    processedLimit,
    processedVisible,
    processedPurchaseMaxByDefault,
    allRequirements,
  );

  const effectComputed = buildEffectComputed(effect, count);
  const getCost = buildGetCost(baseReqs);
  const handle = createEmitHandle<PurchasableEvents>();

  const purchasable: Purchasable = {
    id,
    count,
    active,
    canPurchase,
    countToPurchase,
    maxed,
    limit: processedLimit,
    requirements: allRequirements,
    display: resolvedDisplay,
    effect: effectComputed,
    visible: processedVisible,
    purchaseMaxByDefault: processedPurchaseMaxByDefault,
    onPurchase,
    on: handle.on,
    getCost,

    purchase(purchaseCount?: DecimalSource): Decimal | 0 {
      if (!canPurchase.value) return 0;

      let toPurchase: DecimalSource;
      if (purchaseCount !== undefined) {
        toPurchase = Decimal.min(purchaseCount, countToPurchase.value);
      } else if (unref(processedPurchaseMaxByDefault)) {
        toPurchase = countToPurchase.value;
      } else {
        toPurchase = 1;
      }

      // `!gt(0)` rather than `lte(0)`: this guard fronts `payRequirements`, so
      // admitting an indeterminate count would spend before the count could be
      // rejected downstream. `lte` admits NaN, `gt` rejects it.
      if (!Decimal.gt(toPurchase, 0)) return 0;

      payRequirements(allRequirements, toPurchase);
      count.value = Decimal.add(count.value, toPurchase);
      onPurchase?.(toPurchase);
      handle.emit('purchased', toPurchase);

      return new Decimal(toPurchase);
    },

    purchaseMax(): Decimal | 0 {
      return purchasable.purchase(countToPurchase.value);
    },
  };

  // A reset walk stops at the purchasable's own persistent context: a ref
  // passed as `limit`, `visible` or `purchaseMaxByDefault` belongs to whoever
  // created it.
  return attachPersistentContextReset(purchasable, contextId);
}

// === FACTORIES ===

/**
 * Engine-internal raw Purchasable factory. Consumers reach this through
 * {@link createPurchasableCategory} (L2) or
 * {@link createScalingPurchasable} (L3, Formula-aware).
 *
 * The saved state is always a count (`Persistent<DecimalSource>`). One-shot
 * behavior comes from `limit: 1`; the `active` computed gives the boolean read.
 *
 * @internal
 * @param options - The purchasable's options
 * @param predicates - resolver `visible` adopts through; a category passes
 *   its own, so content registered after install still resolves
 * @returns A {@link Purchasable} with `purchase()`, `count`, `active`, `effect`, and `on` for its events
 *
 * @example Repeatable purchase
 * ```ts
 * const generator = createPurchasable({
 *   id: 'generator',
 *   display: { description: 'Point Generator' },
 *   // Function form — `count` is this purchasable's own count ref, so the
 *   // cost is a Formula and `purchaseMax` walks the curve step by step.
 *   requirements: (count) =>
 *     createCostRequirement({
 *       resource: points,
 *       cost: Formula.exponential(count, 10, 1.15).floor(),
 *       maxBulkCount: Decimal.dInf,
 *     }),
 *   effect: (count) => Decimal.pow(2, count),
 * });
 * generator.purchaseMax();
 * ```
 */
export function createPurchasable(
  options: PurchasableOptions,
  predicates: PredicateResolver = createPredicateResolver(),
): Purchasable {
  const { contextId, count } = buildPurchasableCount(options.id, options.initialCount);
  return assemblePurchasable(options, count, contextId, predicates);
}

/**
 * Create a purchasable whose cost scales with its count — the L3 factory for
 * one customized repeatable purchase.
 *
 * The cost options are a discriminated union (see {@link ScalingPurchasableCost}):
 * - **Geometric**: `baseCost + costRatio` produces `baseCost * costRatio ^ count`,
 *   not rounded, so a cost can be fractional.
 * - **Formula**: `costFormula` takes a curve factory (invertible, bulk-aware).
 * - **Function**: `cost` takes a plain `(count) => Decimal` function
 *   (one unit per purchase) for cost shapes no Formula expresses.
 *
 * The effect follows the same split: `effect` takes a static base or a plain
 * function, `effectFormula` a curve factory (see {@link ScalingPurchasableEffect}).
 *
 * Defaults to `limit: Infinity`.
 *
 * @param options - Shorthand options with the resource and a cost shape
 * @param predicates - resolver `visible` adopts through. Defaults to one
 *   over the ambient Gate services, so build inside engine install/connect when
 *   `visible` is a Gate
 * @returns A {@link Purchasable} (same return type as createPurchasable)
 *
 * @example Geometric (most common)
 * ```ts
 * const pointGen = createScalingPurchasable({
 *   id: 'pointGen',
 *   description: 'Point Generator',
 *   resource: points,
 *   baseCost: 10,
 *   costRatio: 1.15,
 *   effect: 2,            // ×2 per purchase (static base → 2^count)
 * });
 * ```
 *
 * @example Formula cost and effect (invertible, bulk-aware)
 * ```ts
 * const forge = createScalingPurchasable({
 *   id: 'forge',
 *   description: 'Forge',
 *   resource: ore,
 *   costFormula: (count) => Formula.variable(count).pow(2).add(100),
 *   effectFormula: (count) => Formula.variable(count).mul(0.5).add(1),
 * });
 * ```
 *
 * @example Function cost (super-exponential, piecewise, factorial-bumped, etc.)
 * ```ts
 * const crystalUpgrade = createScalingPurchasable({
 *   id: 'crystal',
 *   description: 'Crystal upgrade',
 *   resource: prestigeShards,
 *   cost: (count) => Decimal.pow(10,
 *     baseLogCost + costIncrement * (0.5 * Math.pow(Decimal.sub(count, 0.5).toNumber(), 2) - 1/8)
 *   ),
 *   effect: (count) => Decimal.pow(2, count),
 * });
 * ```
 */
export function createScalingPurchasable(
  options: ScalingPurchasableOptions,
  predicates: PredicateResolver = createPredicateResolver(),
): Purchasable {
  const {
    id,
    title,
    description,
    effectDescription,
    showCount,
    limit,
    initialCount,
    onPurchase,
    visible,
    purchaseMaxByDefault,
  } = options;

  const { contextId, count } = buildPurchasableCount(id, initialCount);
  const costRequirement = buildScalingCostRequirement(options, count, limit);
  const { effectFn, effectCurve } = buildScalingEffect(options, count);

  const purchasable = assemblePurchasable(
    {
      id,
      display: {
        title,
        description,
        effectDescription:
          effectDescription ??
          (effectFn ? computed(() => `×${formatOperand(effectFn(count.value))}`) : undefined),
        showCount,
      },
      requirements: costRequirement,
      limit,
      effect: effectFn,
      onPurchase,
      visible,
      purchaseMaxByDefault,
    },
    count,
    contextId,
    predicates,
  );
  purchasable.effectCurve = effectCurve;
  return purchasable;
}
