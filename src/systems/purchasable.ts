/**
 * Purchasable system — unified purchase primitives for incremental games
 *
 * A Purchasable represents anything the player buys: one-shot upgrades,
 * leveled generators, capped perks. The `limit` option determines shape:
 *
 * - `limit: 1` — one-shot upgrade (boolean `active` convenience, no amount display)
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

import { computed, ref, unref, watch, type ComputedRef, type MaybeRef, type Ref } from 'vue';
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

/** Events emitted by a {@link Purchasable} instance */
export interface PurchasableEvents {
  /** Fired after each purchase, with the number of levels bought in this transaction */
  purchased: (amount: DecimalSource) => void;
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
  /**
   * Save identity, unique among the purchasables created in the same context.
   * The owned amount saves under it, so it must not change between builds.
   */
  id: string;
  /** UI text — either a full {@link PurchasableDisplay} or a plain string/getter for description-only */
  display: PurchasableDisplay | Computable<string>;
  /**
   * What the player must have/spend per purchase (cost requirements, boolean gates, etc.).
   *
   * Pass a **factory** to build requirements over this purchasable's own level.
   * The callback receives the live `amount` ref, which doesn't exist yet when
   * the plain form is evaluated — so it's the only way to declare a cost that
   * scales on the thing being bought:
   *
   * ```ts
   * requirements: (level) =>
   *   createCostRequirement({
   *     resource: gold,
   *     cost: Formula.exponential(level, def.baseCost, 1.15),
   *     maxBulkAmount: Decimal.dInf,
   *   })
   * ```
   *
   * Prefer it over a `cost: () => …` getter that reads the level back out of a
   * category: a getter cost is priced linearly at the *current* level, so
   * buy-max silently undercharges a scaling ladder (see
   * {@link CostRequirementOptions.cost}). A Formula over `level` is invertible,
   * so bulk purchasing walks the real curve. Multiple resources work too —
   * return an array of cost requirements over the same `level`.
   */
  requirements: Requirements | ((amount: MaybeRef<DecimalSource>) => Requirements);
  /** Maximum number of purchases. Default: `Infinity` (uncapped) */
  limit?: Computable<DecimalSource>;
  /** Starting amount (useful for purchasables that begin pre-purchased). Default: `0` */
  initialAmount?: DecimalSource;
  /**
   * Effect value or function.
   *
   * - `Computable<DecimalSource>` — static/reactive value (typical for one-shot).
   *   Exposed directly and ungated: it reports the full bonus before the
   *   upgrade is bought, so read it behind `active` (or through `grants`,
   *   which gate) wherever it applies rather than previews.
   * - `(amount: DecimalSource) => DecimalSource` — computed from amount (typical for leveled).
   *
   * If omitted, effect defaults to `1` (identity for multiplication).
   */
  effect?: Computable<DecimalSource> | ((amount: DecimalSource) => DecimalSource);
  /** Callback fired after each purchase with the number of levels bought */
  onPurchase?: (amount: DecimalSource) => void;
  /** Whether this purchasable is visible to the player. Default: `true` */
  visibility?: Computable<boolean>;
  // TODO(expansion): widen to `Computable<boolean> | Gate` when a consumer wants declarative
  // visibility for devtools / balance-sim introspection. Gate already exists
  // (src/systems/gate.ts); only consumer demand is pending.
  /**
   * Whether bulk purchasing (buy-max) is enabled.
   * Default: `false` when limit is 1, `true` otherwise.
   */
  bulkPurchase?: Computable<boolean>;
}

/** Formula factory over a purchasable's level — receives the engine-owned level ref. */
type LevelCurve = (level: MaybeRef<DecimalSource>) => FormulaSource;

/**
 * Cost configuration for {@link ScalingPurchasableOptions}. Discriminated
 * union — provide exactly one shape:
 *
 * - **Geometric** (`baseCost + costScaling`) — closed-form `baseCost × costScaling^amount`.
 * - **Formula** (`costFormula`) — any curve the Formula vocabulary expresses.
 *   Invertible, so bulk purchasing walks the real curve.
 * - **Function** (`cost`) — arbitrary cost shape the Formula vocabulary can't
 *   express (super-exponential, piecewise, a table lookup). Single-purchase only.
 */
export type ScalingPurchasableCost =
  | {
      /** Cost of the first purchase. Can be a ref/getter for scoped tuning. */
      baseCost: Computable<DecimalSource>;
      /**
       * Multiplicative cost increase per level (e.g., `1.15` for 15% increase).
       * Can be a ref/getter for scoped tuning.
       */
      costScaling: Computable<DecimalSource>;
      costFormula?: never;
      cost?: never;
    }
  | {
      /**
       * Formula factory for the cost of the next level. Called once at
       * creation with the level ref; the returned Formula supports `.invert()`
       * and bulk-purchase math via `calculateMaxAffordable`. A plain value
       * returned instead prices every level at that value.
       */
      costFormula: LevelCurve;
      baseCost?: never;
      costScaling?: never;
      cost?: never;
    }
  | {
      /**
       * Cost of the next level as a plain function of the current level,
       * re-read whenever the level changes. Single-purchase only — bulk math
       * needs a Formula.
       */
      cost: (level: DecimalSource) => DecimalSource;
      baseCost?: never;
      costScaling?: never;
      costFormula?: never;
    };

/**
 * Effect configuration for {@link ScalingPurchasableOptions} — at most one of
 * `effect` (a static base or a plain function) or `effectFormula` (a Formula
 * factory). Omitted, the purchasable carries no effect.
 */
export type ScalingPurchasableEffect =
  | {
      /**
       * Effect per level. Two shapes:
       *
       * - `DecimalSource` — static base applied as `base^amount`. Auto-wrapped as
       *   an invertible/integrable `Formula` internally; exposed on the result as
       *   `effectCurve` for inversion queries ("level required for ×100?").
       * - `(amount: DecimalSource) => DecimalSource` — genuinely custom logic.
       *   Forward evaluation only; `effectCurve` is undefined.
       */
      effect?: DecimalSource | ((amount: DecimalSource) => DecimalSource);
      effectFormula?: never;
    }
  | {
      /**
       * Formula factory for the effect. Receives the level ref; the returned
       * Formula becomes `effectCurve` on the result. Use this for
       * non-exponential curves (linear, polynomial, soft-capped) that still
       * need invertibility.
       */
      effectFormula: LevelCurve;
      effect?: never;
    };

/**
 * Shorthand options for {@link createScalingPurchasable} — leveled purchases
 * with geometric, Formula or function cost scaling. Defaults `limit: Infinity`.
 *
 * Cost and effect shapes each take their own key — see
 * {@link ScalingPurchasableCost} and {@link ScalingPurchasableEffect}.
 */
export type ScalingPurchasableOptions = {
  /** Save identity — see {@link PurchasableOptions.id}. */
  id: string;
  /** Display title */
  title?: Computable<string>;
  /** Description of what this purchasable does */
  description: Computable<string>;
  /** The resource spent to purchase */
  resource: Resource;
  /**
   * Formatted current effect, for effects a `×N` readout misrenders
   * (additive bonuses, flat amounts). Can be a ref or getter. Default: `×`
   * followed by the effect, when an effect is set.
   */
  effectDisplay?: Computable<string>;
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
} & ScalingPurchasableCost &
  ScalingPurchasableEffect;

/**
 * A purchasable — the returned object from {@link createPurchasable}.
 *
 * Read `amount.value` for the current level, or `active.value` for "is it on?" checks.
 * Call `purchase()` or `purchaseMax()` to buy.
 */
export interface Purchasable {
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
   * The underlying effect Formula when one exists — present when
   * {@link ScalingPurchasableOptions} set `effectFormula` or a `DecimalSource`
   * `effect`. Use `.invert(target)` for "level required for effect ≥ target"
   * queries. Undefined when the effect was configured as a plain function.
   */
  effectCurve?: GenericFormula;
  /** Whether this purchasable is currently visible */
  visibility: MaybeRef<boolean>;
  /** Whether bulk purchasing is enabled */
  bulkPurchase: MaybeRef<boolean>;
  /**
   * Buy levels. Pass an amount to cap the purchase. Omitted, it buys as many
   * as are affordable when `bulkPurchase` is on (the default for anything but
   * a one-shot), up to the cost's `maxBulkAmount`, and one when it's off.
   * Returns levels bought.
   */
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
    const disp = display;
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

/** Reactive active/maxed/canPurchase/amountToPurchase computeds. */
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
 * {@link CostRequirement}. A `costFormula` factory is invoked once at creation
 * and its Formula makes the cost invertible, so bulk purchasing works via
 * `calculateMaxAffordable`. A `cost` function becomes a getter cost
 * (single-purchase only).
 *
 * Either way, the cost reads through the engine's persistent `scalingAmount`
 * ref — the mirror+watch in the factory body keeps it synced with
 * `purchasable.amount`, so consumers don't need their own mirror.
 */
function buildScalingCostRequirement(
  options: ScalingPurchasableOptions,
  scalingAmount: Ref<DecimalSource>,
  limit: Computable<DecimalSource> | undefined,
): Requirement {
  if (options.costFormula !== undefined) {
    return createCostRequirement({
      resource: options.resource,
      cost: toFormula(options.costFormula(scalingAmount)),
      maxBulkAmount: limit ?? Decimal.dInf,
    });
  }

  if (options.cost !== undefined) {
    // Re-read against the live level; bulk math is unavailable
    // (createCostRequirement only supports it for Formula costs).
    const costFn = options.cost;
    return createCostRequirement({
      resource: options.resource,
      cost: () => costFn(scalingAmount.value),
      maxBulkAmount: 1,
    });
  }

  // Geometric path. processGetter so a tunable()/ref baseCost or costScaling
  // flows reactively into the Formula. Formula sources accept
  // MaybeRef<DecimalSource>, so the exponential re-evaluates when either
  // underlying ref updates (e.g., OverrideRegistry scope push swapping a
  // tuning knob).
  const processedBaseCost = processGetter(options.baseCost);
  const processedCostScaling = processGetter(options.costScaling);
  return createCostRequirement({
    resource: options.resource,
    cost: Formula.exponential(scalingAmount, processedBaseCost, processedCostScaling),
    maxBulkAmount: limit ?? Decimal.dInf,
  });
}

/**
 * Resolve the {@link ScalingPurchasableEffect} options into a forward
 * function and (when possible) an invertible {@link Formula}.
 */
function buildScalingEffect(
  options: ScalingPurchasableEffect,
  scalingAmount: Ref<DecimalSource>,
): {
  effectFn: ((amount: DecimalSource) => DecimalSource) | undefined;
  effectCurve: GenericFormula | undefined;
} {
  const { effect, effectFormula } = options;
  const fromCurve = (curve: GenericFormula) => ({
    effectCurve: curve,
    effectFn: (amount: DecimalSource) => new Decimal(curve.evaluate(amount)),
  });
  if (effectFormula !== undefined) return fromCurve(toFormula(effectFormula(scalingAmount)));
  if (effect === undefined || typeof effect === 'function') {
    return { effectCurve: undefined, effectFn: effect };
  }
  // A static base auto-wraps as `base^amount`, an invertible Formula.
  return fromCurve(Formula.variable(scalingAmount).pow_base(effect));
}

/** Lift a factory's return to a Formula — a plain value becomes a constant. */
function toFormula(source: FormulaSource): GenericFormula {
  return source instanceof Formula ? source : Formula.constant(source);
}

// === FACTORIES ===

/**
 * Engine-internal raw Purchasable factory. Consumers reach this through
 * {@link createPurchasableCategory} (the L2 front door) or
 * {@link createScalingPurchasable} (the L3 Formula-aware escape).
 *
 * State is always amount-based (`Persistent<DecimalSource>`). One-shot behavior
 * emerges from `limit: 1` — the `active` computed provides boolean convenience.
 *
 * @internal
 * @param options - Configuration for the purchasable
 * @returns A {@link Purchasable} with `purchase()`, `amount`, `active`, `effect`, and event hooks
 *
 * @example Leveled repeatable
 * ```ts
 * const generator = createPurchasable({
 *   id: 'generator',
 *   display: { description: 'Point Generator' },
 *   // Factory form — `level` is this purchasable's own amount ref, so the
 *   // cost is a Formula and `purchaseMax` walks the curve rung by rung.
 *   requirements: (level) =>
 *     createCostRequirement({
 *       resource: points,
 *       cost: Formula.exponential(level, 10, 1.15),
 *       maxBulkAmount: Decimal.dInf,
 *     }),
 *   effect: (amt) => Decimal.pow(2, amt),
 * });
 * generator.purchaseMax();
 * ```
 */
export function createPurchasable(options: PurchasableOptions): Purchasable {
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

  // Sub-context per purchasable so multiple purchasables grouped under the
  // same outer context (e.g. `layer0`) do not collide on the `amount` name.
  const parentContext = getCurrentContext();
  const contextId = parentContext ? `${parentContext}:${id}` : id;
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

  // Factory form resolves here, after `amount` exists — that ordering is the
  // whole point: a cost scaling on this purchasable's own level can't be
  // declared before the ref it reads. `Requirements` is never a function, so
  // the typeof discriminates unambiguously.
  const resolvedRequirements =
    typeof requirements === 'function' ? requirements(amount) : requirements;
  const baseReqs = Array.isArray(resolvedRequirements)
    ? resolvedRequirements
    : [resolvedRequirements];
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
    id,
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

      // `!gt(0)` rather than `lte(0)`: this guard fronts `payRequirements`, so
      // admitting an indeterminate count would spend before the count could be
      // rejected downstream. `lte` admits NaN, `gt` rejects it.
      if (!Decimal.gt(toPurchase, 0)) return Decimal.dZero;

      payRequirements(allRequirements, toPurchase);
      amount.value = Decimal.add(amount.value, toPurchase);
      onPurchase?.(toPurchase);
      handle.emit('purchased', toPurchase);

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
 * - **Formula**: `costFormula` takes a Formula factory (invertible, bulk-aware).
 * - **Function**: `cost` takes a plain `(level) => Decimal` function
 *   (single-purchase) for cost shapes no Formula expresses.
 *
 * The effect follows the same split: `effect` takes a static base or a plain
 * function, `effectFormula` a Formula factory (see {@link ScalingPurchasableEffect}).
 *
 * Defaults to `limit: Infinity`.
 *
 * @param options - Shorthand configuration with resource and a cost shape
 * @returns A {@link Purchasable} (same return type as createPurchasable)
 *
 * @example Geometric (most common)
 * ```ts
 * const pointGen = createScalingPurchasable({
 *   id: 'pointGen',
 *   description: 'Point Generator',
 *   resource: points,
 *   baseCost: 10,
 *   costScaling: 1.15,
 *   effect: 2,            // ×2 per level (static base → 2^amount)
 * });
 * ```
 *
 * @example Formula cost and effect (invertible, bulk-aware)
 * ```ts
 * const forge = createScalingPurchasable({
 *   id: 'forge',
 *   description: 'Forge',
 *   resource: ore,
 *   costFormula: (level) => Formula.variable(level).pow(2).add(100),
 *   effectFormula: (level) => Formula.variable(level).mul(0.5).add(1),
 * });
 * ```
 *
 * @example Function cost (super-exponential, piecewise, factorial-bumped, etc.)
 * ```ts
 * const crystalUpgrade = createScalingPurchasable({
 *   id: 'crystal',
 *   description: 'Crystal upgrade',
 *   resource: prestigeShards,
 *   cost: (level) => Decimal.pow(10,
 *     baseLogCost + costIncrement * (0.5 * Math.pow(Decimal.sub(level, 0.5).toNumber(), 2) - 1/8)
 *   ),
 *   effect: (level) => Decimal.pow(2, level),
 * });
 * ```
 */
export function createScalingPurchasable(options: ScalingPurchasableOptions): Purchasable {
  const {
    id,
    title,
    description,
    effectDisplay,
    limit,
    initialAmount,
    onPurchase,
    visibility,
    bulkPurchase,
  } = options;

  // The cost and effect Formulas read the level before the purchasable (and
  // its saved `amount`) exists, so they close over this mirror instead. It is
  // derived state: the watch below keeps it equal to `amount`, load included.
  const scalingAmount = ref<DecimalSource>(initialAmount ?? 0) as Ref<DecimalSource>;

  const costRequirement = buildScalingCostRequirement(options, scalingAmount, limit);
  const { effectFn, effectCurve } = buildScalingEffect(options, scalingAmount);

  const purchasable: Purchasable = {
    ...createPurchasable({
      id,
      display: {
        title,
        description,
        effectDisplay:
          effectDisplay ??
          (effectFn
            ? computed(() => `×${formatSmall(effectFn(scalingAmount.value), 2)}`)
            : undefined),
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
