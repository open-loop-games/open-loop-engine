/**
 * Purchasable system — unified purchase primitives for incremental games
 *
 * A Purchasable represents anything the player buys: one-shot upgrades,
 * leveled generators, capped perks. The `limit` option determines shape:
 *
 * - `limit: 1` — one-shot upgrade (boolean `bought` convenience, no amount display)
 * - `limit: N` — capped leveled purchase (amount tracks levels, maxes at N)
 * - `limit: Infinity` — uncapped repeatable (buy forever, default)
 *
 * The category factory {@link createPurchasableCategory} is the consumer
 * front door. {@link createScalingPurchasable} is the L3 escape hatch for
 * per-instance customized leveled purchases that don't fit a category's
 * map shape — it does Formula-aware cost+effect setup the raw factory
 * can't express cleanly. {@link createPurchasable} is engine-internal.
 *
 * For auto-buy, see {@link setupSweepAutoPurchase} /
 * {@link setupPolicyAutoPurchase} in `./auto-purchase`.
 */

import { computed, unref, watch, type ComputedRef, type MaybeRef } from 'vue';
import { Decimal, type DecimalSource, formatSmall } from '@/primitives/decimal';
import { processGetter, type Computable } from '@/core/computed';
import {
  persistent,
  type Persistent,
  DefaultValue,
  cloneDefault,
  withPersistentContext,
  getCurrentContext,
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
import Formula from '@/core/formulas/formulas';
import type { FormulaSource, GenericFormula } from '@/core/formulas/types';

// === TYPES ===

/** Symbol identifying Purchasable features */
export const PurchasableType = Symbol('Purchasable');

/** Events emitted by a {@link Purchasable} instance */
export interface PurchasableEvents {
  /** Fired after each purchase, with the number of levels bought in this transaction */
  purchase: (amount: DecimalSource) => void;
}

/** UI text for a purchasable. All fields accept refs/getters for dynamic content. */
export interface PurchasableDisplay {
  /** Title shown at the top of the purchasable card */
  title?: Computable<string>;
  /** Main description explaining what this purchasable does */
  description: Computable<string>;
  /** Formatted current effect (e.g., "×8 production"). Shown below description. */
  effectDisplay?: Computable<string>;
  /**
   * Whether to display the current amount (e.g., "Level 5").
   * Default: `false` when limit is 1, `true` otherwise.
   */
  showAmount?: boolean;
}

// TODO(expansion): staged definitions — a purchasable that transforms between
// N phases (Kittens Game stages[], AD charged overlays). Add optional `stages`
// array to options, expose `stage` ref on instance. Deferred: no consumer need yet.

/**
 * Full options for {@link createPurchasable} — the engine-internal raw
 * factory. Consumers reach this shape through `mapPurchasable` on
 * {@link createPurchasableCategory}; the field set is the contract that
 * shape returns.
 *
 * For leveled cost scaling outside a category, use
 * {@link ScalingPurchasableOptions} on {@link createScalingPurchasable}.
 */
export interface PurchasableOptions {
  /** Persistence ID. Auto-generated if omitted, but explicit IDs are safer for save compatibility. */
  id?: string;
  /** UI text — either a full {@link PurchasableDisplay} or a plain string/getter for description-only */
  display: PurchasableDisplay | Computable<string>;
  /** What the player must have/spend per purchase (cost requirements, boolean gates, etc.) */
  requirements: Requirements;
  /** Maximum number of purchases. Default: `Infinity` (uncapped) */
  limit?: Computable<DecimalSource>;
  /** Starting amount (useful for purchasables that begin pre-purchased). Default: `0` */
  initialAmount?: DecimalSource;
  /**
   * Effect value or function.
   *
   * - `Computable<DecimalSource>` — static/reactive value (typical for one-shot). Exposed directly.
   * - `(amount: DecimalSource) => DecimalSource` — computed from amount (typical for leveled).
   *
   * If omitted, effect defaults to `1` (identity for multiplication).
   */
  effect?: Computable<DecimalSource> | ((amount: DecimalSource) => DecimalSource);
  /** Callback fired after each purchase with the number of levels bought */
  onPurchase?: (amount: DecimalSource) => void;
  /** Whether this purchasable is visible to the player. Default: `true` */
  visibility?: Computable<boolean>;
  // TODO(expansion): widen to `Computable<boolean> | Gate` once OL-844 lands and a consumer
  // wants declarative visibility for devtools / balance-sim introspection.
  // Ref: docs/candidate-primitives.md `Gate` core primitive entry.
  /**
   * Whether bulk purchasing (buy-max) is enabled.
   * Default: `false` when limit is 1, `true` otherwise.
   */
  bulkPurchase?: Computable<boolean>;
}

/**
 * Cost configuration for {@link ScalingPurchasableOptions}. Discriminated
 * union — provide exactly one shape:
 *
 * - **Geometric** (`baseCost + costScaling`) — closed-form `baseCost × costScaling^amount`.
 * - **Closure** (`costFormula`) — arbitrary cost shape closing over the
 *   purchasable's level. Use for non-geometric scaling (super-exponential,
 *   piecewise, factorial-bumped) that the geometric form can't express.
 */
export type ScalingPurchasableCost =
  | {
      /** Cost of the first purchase. Can be a ref/getter for scoped tuning. */
      baseCost: Computable<DecimalSource>;
      /** Multiplicative cost increase per level (e.g., `1.15` for 15% increase) */
      costScaling: DecimalSource;
    }
  | {
      /**
       * Closure-form cost. Two shapes — same polymorphism as `effect`:
       *
       * - `(amount: MaybeRef<DecimalSource>) => FormulaSource` — Formula factory.
       *   Receives the engine's persistent level ref; returned Formula supports
       *   `.invert()` and bulk-purchase math via `calculateMaxAffordable`.
       * - `(amount: DecimalSource) => DecimalSource` — opaque value function.
       *   Single-purchase only (bulk-purchase math is unavailable for non-Formula costs).
       *   Use for cost shapes that aren't expressible as engine Formulas
       *   (super-exponential, piecewise, factorial-bumped).
       */
      costFormula:
        | ((amount: MaybeRef<DecimalSource>) => FormulaSource)
        | ((amount: DecimalSource) => DecimalSource);
    };

/**
 * Shorthand options for {@link createScalingPurchasable} — leveled purchases
 * with either geometric or closure-form cost scaling. Defaults `limit: Infinity`.
 *
 * Cost shape is supplied via the {@link ScalingPurchasableCost} discriminator.
 */
export type ScalingPurchasableOptions = {
  /** Persistence ID. Auto-generated if omitted. */
  id?: string;
  /** Display title */
  title?: Computable<string>;
  /** Description of what this purchasable does */
  description: Computable<string>;
  /** The resource spent to purchase */
  resource: Resource;
  /**
   * Effect per level. Three shapes:
   *
   * - `DecimalSource` — static base applied as `base^amount`. Auto-wrapped as
   *   an invertible/integrable `Formula` internally; exposed on the result as
   *   `effectCurve` for inversion queries ("level required for ×100?").
   * - `(amount: MaybeRef<DecimalSource>) => FormulaSource` — Formula factory.
   *   Receives the skill-owned amount ref; returned Formula becomes `effectCurve`
   *   on the result. Use this for non-exponential curves (linear, polynomial,
   *   soft-capped) that still need invertibility.
   * - `(amount: DecimalSource) => DecimalSource` — opaque escape hatch for
   *   genuinely custom logic. Forward evaluation only; `effectCurve` is undefined.
   */
  effect?:
    | DecimalSource
    | ((amount: MaybeRef<DecimalSource>) => FormulaSource)
    | ((amount: DecimalSource) => DecimalSource);
  /** Maximum number of purchases. Default: `Infinity` */
  limit?: Computable<DecimalSource>;
  /** Starting amount. Default: `0` */
  initialAmount?: DecimalSource;
  /** Callback fired after each purchase */
  onPurchase?: (amount: DecimalSource) => void;
  /** Whether this purchasable is visible. Default: `true` */
  visibility?: Computable<boolean>;
  /** Whether bulk purchasing is enabled. Default: `true` */
  bulkPurchase?: Computable<boolean>;
} & ScalingPurchasableCost;

/**
 * A purchasable — the returned object from {@link createPurchasable}.
 *
 * Read `amount.value` for the current level, or `active.value` for "is it on?" checks.
 * Call `purchase()` or `purchaseMax()` to buy.
 */
export interface Purchasable {
  /** Feature type discriminator. */
  type: typeof PurchasableType;
  /** Unique identifier */
  id: string;
  /** Current number of purchases (persistent, saved/loaded automatically) */
  amount: Persistent<DecimalSource>;
  /**
   * Latch — `true` when `amount >= 1`. The primary status read for callers
   * who only care whether this is "on" (one-shot upgrades, predicate-gated
   * unlocks). Leveled purchasables read `amount` directly instead.
   */
  active: ComputedRef<boolean>;
  /** Reactive flag — `true` when requirements are met and limit isn't reached */
  canPurchase: ComputedRef<boolean>;
  /** How many levels would be bought by a `purchase()` call (respects bulk and limit) */
  amountToPurchase: ComputedRef<DecimalSource>;
  /** True when amount has reached the configured limit */
  maxed: ComputedRef<boolean>;
  /** The configured purchase limit */
  limit: MaybeRef<DecimalSource>;
  /** Active requirements (includes the internal limit requirement) */
  requirements: Requirements;
  /** Resolved display text (reactive) */
  display: {
    title: MaybeRef<string | undefined>;
    description: MaybeRef<string>;
    effectDisplay: MaybeRef<string | undefined>;
    showAmount: boolean;
  };
  /** Current effect value — computed from amount for leveled, or static for one-shot */
  effect: ComputedRef<DecimalSource>;
  /**
   * The underlying effect Formula when one exists — present when effect was a
   * {@link Formula} factory or the `DecimalSource` shorthand in
   * {@link ScalingPurchasableOptions}. Use `.invert(target)` for
   * "level required for effect ≥ target" queries. Undefined when the effect
   * was configured as an opaque value function.
   */
  effectCurve?: GenericFormula;
  /** Whether this purchasable is currently visible */
  visibility: MaybeRef<boolean>;
  /** Whether bulk purchasing is enabled */
  bulkPurchase: MaybeRef<boolean>;
  /** Buy levels. Pass an amount to cap, or omit to use bulk/single logic. Returns levels bought. */
  purchase: (amount?: DecimalSource) => DecimalSource;
  /** Buy as many levels as affordable. Returns total levels bought. */
  purchaseMax: () => DecimalSource;
  /** Estimate the total cost for a given number of additional levels. Default: `1` */
  getCost: (amount?: DecimalSource) => DecimalSource;
  /** Callback from options, if provided */
  onPurchase?: (amount: DecimalSource) => void;
  /** Subscribe to purchasable lifecycle events */
  on: Emittable<PurchasableEvents>['on'];
}

// === CONSTANTS ===

let purchasableIdCounter = 0;

// === PRIVATE BUILDERS ===

/**
 * Detect whether an effect option is an amount-function or a Computable.
 * Amount-functions have `length >= 1` (they take an `amount` parameter).
 */
function isAmountFunction(
  effect: Computable<DecimalSource> | ((amount: DecimalSource) => DecimalSource),
): effect is (amount: DecimalSource) => DecimalSource {
  return typeof effect === 'function' && effect.length >= 1;
}

/** Resolve display option (full object vs description-shorthand) into reactive slots. */
function buildPurchasableDisplay(
  display: PurchasableDisplay | Computable<string>,
  isOneShot: boolean,
): {
  title: MaybeRef<string | undefined>;
  description: MaybeRef<string>;
  effectDisplay: MaybeRef<string | undefined>;
  showAmount: boolean;
} {
  if (typeof display === 'object' && display !== null && 'description' in display) {
    const disp = display as PurchasableDisplay;
    return {
      title: processGetter(disp.title),
      description: processGetter(disp.description),
      effectDisplay: processGetter(disp.effectDisplay),
      showAmount: disp.showAmount ?? !isOneShot,
    };
  }
  return {
    title: undefined,
    description: processGetter(display as Computable<string>),
    effectDisplay: undefined,
    showAmount: !isOneShot,
  };
}

/** Synthetic limit requirement that gates purchases at the configured cap. */
function buildLimitRequirement(
  processedLimit: MaybeRef<DecimalSource>,
  amount: Persistent<DecimalSource>,
): Requirement {
  return {
    requirementMet: computed((): DecimalSource => {
      const lim = unref(processedLimit);
      const current = amount.value;
      return Decimal.max(Decimal.sub(lim, current), 0);
    }),
    requiresPay: false,
    canMaximize: true,
    [SkipPersistence]: true,
  };
}

/** Reactive bought/maxed/canPurchase/amountToPurchase computeds. */
function buildPurchasableComputeds(
  amount: Persistent<DecimalSource>,
  processedLimit: MaybeRef<DecimalSource>,
  processedVisibility: MaybeRef<boolean>,
  processedBulkPurchase: MaybeRef<boolean>,
  allRequirements: Requirements,
): {
  active: ComputedRef<boolean>;
  maxed: ComputedRef<boolean>;
  canPurchase: ComputedRef<boolean>;
  amountToPurchase: ComputedRef<DecimalSource>;
} {
  const active = computed((): boolean => Decimal.gte(amount.value, 1));

  const maxed = computed((): boolean => {
    const lim = unref(processedLimit);
    return Decimal.gte(amount.value, lim);
  });

  const canPurchase = computed((): boolean => {
    if (maxed.value) return false;
    if (!unref(processedVisibility)) return false;
    return requirementsMet(allRequirements);
  });

  const amountToPurchase = computed((): DecimalSource => {
    if (!unref(processedBulkPurchase)) {
      return canPurchase.value ? 1 : 0;
    }
    return Decimal.max(1, maxRequirementsMet(allRequirements));
  });

  return { active, maxed, canPurchase, amountToPurchase };
}

/** Resolve effect option (computable / amount-fn / undefined) into a single computed. */
function buildEffectComputed(
  effect: PurchasableOptions['effect'],
  amount: Persistent<DecimalSource>,
): ComputedRef<DecimalSource> {
  if (effect == null) {
    return computed(() => 1);
  }
  if (isAmountFunction(effect)) {
    return computed(() => effect(amount.value));
  }
  const processedEffect = processGetter(effect);
  return computed(() => unref(processedEffect) ?? 1);
}

/** Cost-estimation closure that delegates to each requirement's own getCost. */
function buildGetCost(baseReqs: Requirement[]): (purchaseAmount?: DecimalSource) => DecimalSource {
  return function getCost(purchaseAmount: DecimalSource = 1): DecimalSource {
    let totalCost: DecimalSource = Decimal.dZero;
    for (const req of baseReqs) {
      if ('getCost' in req && typeof (req as { getCost?: unknown }).getCost === 'function') {
        totalCost = Decimal.add(
          totalCost,
          (req as { getCost: (n: DecimalSource) => DecimalSource }).getCost(purchaseAmount),
        );
      }
    }
    return totalCost;
  };
}

/**
 * Resolve the {@link ScalingPurchasableOptions} cost discriminator into a
 * {@link CostRequirement}. The closure variant is invoked once at creation
 * time; if it returns a {@link Formula}, the result is invertible and bulk
 * purchasing works via `calculateMaxAffordable`. Opaque value functions
 * become a `Computable<DecimalSource>` cost (single-purchase only).
 *
 * Either way, the cost reads through the engine's persistent `scalingAmount`
 * ref — the mirror+watch in the factory body keeps it synced with
 * `purchasable.amount`, so consumers don't need their own mirror.
 */
function buildScalingCostRequirement(
  options: ScalingPurchasableOptions,
  scalingAmount: Persistent<DecimalSource>,
  limit: Computable<DecimalSource> | undefined,
): Requirement {
  if ('costFormula' in options) {
    const factoryResult = (options.costFormula as (a: MaybeRef<DecimalSource>) => FormulaSource)(
      scalingAmount,
    );

    if (factoryResult instanceof Formula) {
      return createCostRequirement({
        resource: options.resource,
        cost: factoryResult as GenericFormula,
        maxBulkAmount: limit ?? Decimal.dInf,
      });
    }

    // Opaque value function — the factory returned a DecimalSource, not a
    // Formula. Re-shape as a getter so subsequent reads re-invoke the closure
    // against the live `scalingAmount.value`. Bulk math is unavailable
    // (createCostRequirement only supports it for Formula costs).
    const valueFn = options.costFormula as (a: DecimalSource) => DecimalSource;
    return createCostRequirement({
      resource: options.resource,
      cost: () => valueFn(scalingAmount.value),
      maxBulkAmount: 1,
    });
  }

  // Geometric path. processGetter so tunable()/ref baseCost flows reactively
  // into the Formula. Formula.mul accepts MaybeRef<DecimalSource> via
  // FormulaSource, so the exponential re-evaluates when the underlying ref
  // updates (e.g., OverrideRegistry scope push swapping a tuning knob).
  const processedBaseCost = processGetter(options.baseCost);
  return createCostRequirement({
    resource: options.resource,
    cost: Formula.exponential(scalingAmount, processedBaseCost, options.costScaling),
    maxBulkAmount: limit ?? Decimal.dInf,
  });
}

/**
 * Resolve the {@link ScalingPurchasableOptions.effect} option into a forward
 * function and (when possible) an invertible {@link Formula}.
 */
function buildScalingEffect(
  effectOption: ScalingPurchasableOptions['effect'],
  scalingAmount: Persistent<DecimalSource>,
): {
  effectFn: ((amount: DecimalSource) => DecimalSource) | undefined;
  effectCurve: GenericFormula | undefined;
} {
  if (effectOption === undefined) {
    return { effectFn: undefined, effectCurve: undefined };
  }

  if (typeof effectOption !== 'function') {
    // DecimalSource shorthand — auto-wrap `base^amount` as an invertible Formula.
    const curve = (Formula.variable(scalingAmount) as GenericFormula).pow_base(effectOption);
    return {
      effectCurve: curve,
      effectFn: (amount) => new Decimal(curve.evaluate(amount)),
    };
  }

  // Function — try as Formula factory first, fall back to opaque value function.
  let factoryResult: unknown;
  try {
    factoryResult = (effectOption as (a: MaybeRef<DecimalSource>) => FormulaSource)(scalingAmount);
  } catch {
    factoryResult = undefined;
  }
  if (factoryResult instanceof Formula) {
    const curve = factoryResult as GenericFormula;
    return {
      effectCurve: curve,
      effectFn: (amount) => new Decimal(curve.evaluate(amount)),
    };
  }
  const valueFn = effectOption as (a: DecimalSource) => DecimalSource;
  return { effectCurve: undefined, effectFn: (amount) => valueFn(amount) };
}

// === FACTORIES ===

/**
 * Engine-internal raw Purchasable factory. Consumers reach this through
 * {@link createPurchasableCategory} (the L2 front door) or
 * {@link createScalingPurchasable} (the L3 Formula-aware escape).
 *
 * State is always amount-based (`Persistent<DecimalSource>`). One-shot behavior
 * emerges from `limit: 1` — the `bought` computed provides boolean convenience.
 *
 * @internal
 * @param options - Configuration for the purchasable
 * @returns A {@link Purchasable} with `purchase()`, `amount`, `bought`, `effect`, and event hooks
 *
 * @example Leveled repeatable
 * ```ts
 * const generator = createPurchasable({
 *   display: { description: 'Point Generator' },
 *   requirements: createCostRequirement({
 *     resource: points,
 *     cost: () => Decimal.pow(10, generator.amount.value),
 *   }),
 *   effect: (amt) => Decimal.pow(2, amt),
 * });
 * generator.purchaseMax();
 * ```
 */
export function createPurchasable<T extends PurchasableOptions>(options: T): Purchasable {
  const purchasableId = `purchasable_${++purchasableIdCounter}`;

  const {
    id,
    display,
    requirements,
    limit,
    initialAmount,
    effect,
    onPurchase,
    visibility,
    bulkPurchase,
  } = options;

  const actualId = id ?? purchasableId;

  // Sub-context per purchasable so multiple purchasables grouped under the
  // same outer context (e.g. `layer0`) do not collide on the `amount` name.
  const parentContext = getCurrentContext() ?? purchasableId;
  const contextId = `${parentContext}:${actualId}`;
  const amount = withPersistentContext(contextId, () =>
    persistent<DecimalSource>(0, { name: 'amount' }),
  );

  if (initialAmount !== undefined) {
    (amount as { [DefaultValue]: DecimalSource })[DefaultValue] = cloneDefault(initialAmount);
    if (Decimal.eq(amount.value, 0)) {
      amount.value = cloneDefault(initialAmount);
    }
  }

  const processedLimit = limit != null ? processGetter(limit) : Decimal.dInf;
  const isOneShot = Decimal.eq(unref(processedLimit), 1);
  const processedVisibility = visibility != null ? processGetter(visibility) : true;
  const processedBulkPurchase = bulkPurchase != null ? processGetter(bulkPurchase) : !isOneShot;

  const resolvedDisplay = buildPurchasableDisplay(display, isOneShot);

  const baseReqs = Array.isArray(requirements) ? requirements : [requirements];
  const limitRequirement = buildLimitRequirement(processedLimit, amount);
  const allRequirements: Requirements = [...baseReqs, limitRequirement];

  const { active, maxed, canPurchase, amountToPurchase } = buildPurchasableComputeds(
    amount,
    processedLimit,
    processedVisibility,
    processedBulkPurchase,
    allRequirements,
  );

  const effectComputed = buildEffectComputed(effect, amount);
  const getCost = buildGetCost(baseReqs);
  const handle = createEmitHandle<PurchasableEvents>();

  const purchasable: Purchasable = {
    type: PurchasableType,
    id: actualId,
    amount,
    active,
    canPurchase,
    amountToPurchase,
    maxed,
    limit: processedLimit,
    requirements: allRequirements,
    display: resolvedDisplay,
    effect: effectComputed,
    visibility: processedVisibility,
    bulkPurchase: processedBulkPurchase,
    onPurchase,
    on: handle.on,
    getCost,

    purchase(purchaseAmount?: DecimalSource): DecimalSource {
      if (!canPurchase.value) return Decimal.dZero;

      let toPurchase: DecimalSource;
      if (purchaseAmount !== undefined) {
        toPurchase = Decimal.min(purchaseAmount, amountToPurchase.value);
      } else if (unref(processedBulkPurchase)) {
        toPurchase = amountToPurchase.value;
      } else {
        toPurchase = 1;
      }

      if (Decimal.lte(toPurchase, 0)) return Decimal.dZero;

      payRequirements(allRequirements, toPurchase);
      amount.value = Decimal.add(amount.value, toPurchase);
      onPurchase?.(toPurchase);
      handle.emit('purchase', toPurchase);

      return toPurchase;
    },

    purchaseMax(): DecimalSource {
      return purchasable.purchase(amountToPurchase.value);
    },
  };

  return purchasable;
}

/**
 * Create a purchasable with leveled cost scaling — the L3 escape hatch for
 * per-instance customized leveled purchases.
 *
 * Cost configuration is a discriminated union (see {@link ScalingPurchasableCost}):
 * - **Geometric**: `baseCost + costScaling` produces `baseCost * costScaling ^ amount`.
 * - **Closure**: `costFormula` accepts a Formula factory (invertible, bulk-aware) or
 *   an opaque `(level) => Decimal` value function (single-purchase) for cost shapes
 *   that don't fit geometric scaling.
 *
 * Defaults to `limit: Infinity`.
 *
 * @param options - Shorthand configuration with resource and a cost shape
 * @returns A {@link Purchasable} (same return type as createPurchasable)
 *
 * @example Geometric (most common)
 * ```ts
 * const pointGen = createScalingPurchasable({
 *   description: 'Point Generator',
 *   resource: points,
 *   baseCost: 10,
 *   costScaling: 1.15,
 *   effect: 2,            // ×2 per level (static base → 2^amount)
 * });
 * ```
 *
 * @example Closure cost (super-exponential, piecewise, factorial-bumped, etc.)
 * ```ts
 * const crystalUpgrade = createScalingPurchasable({
 *   description: 'Crystal upgrade',
 *   resource: prestigeShards,
 *   costFormula: (level) => Decimal.pow(10,
 *     baseLogCost + costIncrement * (0.5 * Math.pow(Decimal.sub(level, 0.5).toNumber(), 2) - 1/8)
 *   ),
 *   effect: (level) => Decimal.pow(2, level),
 * });
 * ```
 */
export function createScalingPurchasable<T extends ScalingPurchasableOptions>(
  options: T,
): Purchasable {
  const {
    id,
    title,
    description,
    effect: effectOption,
    limit,
    initialAmount,
    onPurchase,
    visibility,
    bulkPurchase,
  } = options;

  const scalingId = id ?? `scaling_purchasable_${++purchasableIdCounter}`;

  // Sub-context per scaling purchasable (see createPurchasable for rationale).
  const parentContext = getCurrentContext() ?? scalingId;
  const contextId = `${parentContext}:${scalingId}`;
  const scalingAmount = withPersistentContext(contextId, () =>
    persistent<DecimalSource>(initialAmount ?? 0, { name: 'scalingAmount' }),
  );

  const costRequirement = buildScalingCostRequirement(options, scalingAmount, limit);
  const { effectFn, effectCurve } = buildScalingEffect(effectOption, scalingAmount);

  const purchasable: Purchasable = {
    ...createPurchasable({
      id: scalingId,
      display: {
        title,
        description,
        effectDisplay: effectFn
          ? computed(() => `×${formatSmall(effectFn(scalingAmount.value), 2)}`)
          : undefined,
      },
      requirements: costRequirement,
      limit,
      initialAmount,
      effect: effectFn,
      onPurchase,
      visibility,
      bulkPurchase,
    }),
    effectCurve,
  };

  // Mirror the purchasable's internal `amount` into `scalingAmount`. The cost
  // Formula was captured at createCostRequirement time (before `purchasable`
  // existed), so it holds `scalingAmount` as its variable. Without this sync,
  // `purchase()` bumps `amount` but `getCost(1)` stays pinned at `baseCost`.
  //
  // `flush: 'sync'` is required: consumers call `getCost(1)` and read
  // `canPurchase.value` immediately after `purchase()` returns, well before
  // the default Vue scheduler flushes post-render. `immediate: true` keeps
  // post-load state consistent when persistence rehydrates a non-zero amount.
  watch(
    () => purchasable.amount.value,
    (v) => {
      scalingAmount.value = v;
    },
    { immediate: true, flush: 'sync' },
  );

  return purchasable;
}
