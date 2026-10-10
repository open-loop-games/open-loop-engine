/**
 * Producer Category — batch-create Producers from content definitions.
 *
 * Captures the resource-generator pattern shared by buildings (continuous,
 * per-tick) and manual click sources: base rate + modifier chain + optional
 * Purchasable for count + resource target. Two trigger modes (`'continuous'`,
 * `'manual'`); persistent context is scoped per-definition automatically.
 *
 * See {@link createProducerCategory} for a worked example.
 */

import { computed, unref, type ComputedRef } from 'vue';
import { toMaybeRef, type Computable } from '@/core/computed';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { createModifierChain, type ModifierChain } from '@/core/modifier';
import { addResource, type Resource } from '@/core/resource';
import {
  createCategoryBase,
  setupCategoryTick,
  type CategoryBase,
  type CategoryEntrySignals,
} from './category-base';
import { type ContentRegistryView } from './content-registry';
import { Resettable, type ResettableObject } from '@/core/resettable';
import { createScalingPurchasable, type Purchasable } from './purchasable';
import { getCurrentEngineCategories } from './engine-categories';
import { createPredicateResolver, type Predicate, type PredicateResolver } from './gate';
import type { RegisterTick } from '@/core/sequencer';

// === TYPES ===

/**
 * Context passed to the {@link ProducerCategoryOptions.mapProducer} callback.
 */
export interface ProducerCategoryContext {
  /** Tick registration function (typically ctx.onTick from the engine) */
  registerTick: RegisterTick;
}

/**
 * Purchase configuration for producers that can be bought multiple times.
 * Creates a {@link Purchasable} via `createScalingPurchasable` under the hood.
 */
export interface ProducerPurchaseOptions {
  /** Resource spent to purchase */
  costResource: Resource;
  /** Cost of the first purchase. Can be a ref/getter for scoped tuning. */
  baseCost: Computable<DecimalSource>;
  /** Multiplicative cost increase per level. Can be a ref/getter for scoped tuning. */
  costScaling: Computable<DecimalSource>;
  /** Maximum purchasable count */
  limit?: Computable<DecimalSource>;
  /** Starting count (default 0) */
  initialCount?: DecimalSource;
  /** Called after each purchase */
  onPurchase?: (count: DecimalSource) => void;
  /** Whether this producer is visible in the UI. Default: `true` */
  visible?: Predicate;
  /**
   * Whether a bare `repeatable.purchase()` buys as many as affordable rather
   * than one; `purchase(1)` buys one either way. Default: `true`
   */
  purchaseMaxByDefault?: Computable<boolean>;
}

/**
 * Return type of the {@link ProducerCategoryOptions.mapProducer} callback.
 * Describes how a content definition maps to a producer.
 */
export interface ProducerMapping {
  /** The resource this producer generates */
  resource: Resource;
  /** Base production: per unit per second (continuous) or per activation (manual) */
  baseRate: DecimalSource;
  /**
   * `'continuous'` runs every tick; `'manual'` exposes `.activate()`, which
   * credits `computedRate × count` once per call.
   */
  trigger: 'continuous' | 'manual';
  /**
   * If present, creates a ScalingPurchasable for purchase count. The policy
   * auto-buyer (`setupPolicyAutoPurchase`) skips a `'manual'`
   * producer's purchase.
   */
  purchase?: ProducerPurchaseOptions;
  /** Display description for the repeatable (if purchase config present) */
  display?: string;
  /**
   * Additional count contribution beyond the purchasable's owned amount,
   * folded into `Producer.count` as `owned + extra`. Use for cascade-feed
   * patterns where T(N) reads a consumer-maintained "generated" tally
   * (typically a {@link Resource}) so its tick output reflects
   * `(owned + generated) × rate × dt`. Can be a ref or getter for dynamic
   * values.
   *
   * When no purchasable is present, count = `extraCount` alone. When neither
   * is present, count = 1 (existing default).
   *
   * Reset semantics for the underlying generated source are the consumer's
   * responsibility — engine does nothing here.
   */
  extraCount?: Computable<DecimalSource>;
  /**
   * Let the resource fall below zero when the composed rate is net-negative.
   *
   * A rate chain carrying consumption modifiers can resolve negative, in which
   * case the tick drains instead of producing. By default the drain stops at
   * zero, taking whatever remains — unlike {@link subtractResource}, which
   * refuses a shortfall outright, since a continuous rate has no atomic
   * purchase to reject. Set `true` when the deficit is itself a game signal
   * (starvation detectors reading a negative balance).
   */
  allowNegative?: boolean;
}

/**
 * Options for {@link createProducerCategory}.
 *
 * @typeParam Def - The content definition type (must have `id: string`)
 * @typeParam State - Per-instance state created alongside each Producer.
 *   Use `void` if no extra state is needed.
 */
export interface ProducerCategoryOptions<Def extends { id: string }, DefState = void> {
  /** Persistence context name. Each definition gets a sub-context `{id}/{def.id}`. */
  id: string;

  /**
   * Map a content definition to producer configuration.
   *
   * Called once per definition during {@link ProducerCategory.register}.
   * The returned mapping drives what primitives are created.
   */
  mapProducer: (def: Def, ctx: ProducerCategoryContext) => ProducerMapping;

  /**
   * Create per-instance state alongside the Producer.
   *
   * Called inside the definition's persistent context, so `persistent()` calls
   * here are scoped to `{categoryId}/{def.id}`.
   */
  mapState?: (def: Def, producer: Producer) => DefState;

  /** Tick registration function (typically ctx.onTick from the engine) */
  registerTick: RegisterTick;
}

/**
 * A producer instance — generates resources continuously or on demand.
 *
 * The `rateChain` is the primary extension point: upgrades and synergies
 * add modifiers here to boost production.
 */
export interface Producer {
  /** The id of the definition this producer was registered from */
  readonly id: string;
  /**
   * Modifier chain for this producer's rate — the seam where upgrades,
   * synergies and headline multipliers reach its output. A shared chain
   * counts only once bound in (`producer.rateChain.bind({ modifier: shared })`,
   * typically from `mapState`, which also runs for producers a mod registers).
   *
   * Applies to `baseRate` per unit, before `count` multiplies in, so a flat
   * `+5` here yields `5 × count`. A flat production-wide bonus belongs on the
   * resource side, e.g. a producer with no purchase config, whose count is 1.
   */
  readonly rateChain: ModifierChain;
  /**
   * Per-unit rate: `baseRate` after `rateChain`, per second (continuous) or
   * per activation (manual). The producer's output is this × `count`.
   */
  readonly computedRate: ComputedRef<DecimalSource>;
  /** The resource this producer generates */
  readonly resource: Resource;
  /** Whether a net-negative rate may drain the resource below zero */
  readonly allowNegative: boolean;
  /** Trigger mode */
  readonly trigger: 'continuous' | 'manual';
  /** The Purchasable, if purchase config was provided */
  readonly repeatable: Purchasable | undefined;
  /** For manual producers: fire one production event */
  readonly activate: (() => void) | undefined;
  /**
   * Owned count: the purchasable's `amount`, or 0 when no purchase config is
   * set. Bind this — not `count` — for effects and costs that apply only to
   * what the player has purchased (e.g. "+10% per owned T1",
   * next-tier-cost-scales-with-owned).
   */
  readonly ownedCount: ComputedRef<DecimalSource>;
  /**
   * Resolved extra count contribution from the mapping's `extraCount` source,
   * or 0 when not set. In cascade-feed shapes this is the consumer-maintained
   * "generated" tally (typically a {@link Resource} fed by an upstream
   * tier's tick output). Exposed separately from `ownedCount` so effects
   * and costs that apply to one axis don't conflate the two — `ownedCount`
   * tracks purchases, `extraCount` tracks accumulation.
   */
  readonly extraCount: ComputedRef<DecimalSource>;
  /**
   * Effective production count: `ownedCount + extraCount`, falling back to 1
   * when neither is configured (the click-clicker default). Drives the tick
   * body, `activate`, `purchaseBeatSeconds`, total-rate aggregation, and the
   * entry's `count` signal. For effects or costs that should
   * apply to a single axis, bind `ownedCount` or `extraCount` directly instead.
   */
  readonly count: ComputedRef<DecimalSource>;
  /**
   * Seconds this producer's whole stack takes to earn the price of its next
   * unit: `getCost(1) / (computedRate * max(1, count))`. Returns `Infinity`
   * when nothing is buyable, rate is zero or the producer is manual.
   *
   * A stack-amortized beat, not a payback period. The next unit adds only
   * `computedRate`, so its own payback is `getCost(1) / computedRate`, longer
   * than this by the stack height: a tall stack reads as a short beat even
   * when its marginal unit pays back slowly. Compute marginal payback inline
   * when that is the question.
   *
   * Not a prediction of when the producer will become buyable from the
   * player's funding sources — that distinction is documented inline at
   * `harness/walker/walk-producer-transitions.ts`.
   *
   * When `extraCount` is wired (cascade-feed), the denominator's `count`
   * carries the cascade-amplified `(owned + generated)`.
   */
  readonly purchaseBeatSeconds: ComputedRef<number>;
}

/** A registered entry: definition + Producer instance + optional state + introspection signals */
export interface ProducerCategoryEntry<Def extends { id: string }, DefState = void> {
  readonly def: Def;
  readonly producer: Producer;
  readonly state: DefState;
  readonly signals: CategoryEntrySignals;
}

/**
 * A producer category — batch-registered Producers with a shared production shape.
 *
 * @typeParam Def - Content definition type
 * @typeParam State - Per-instance state type (void if none)
 */
export interface ProducerCategory<
  Def extends { id: string },
  DefState = void,
> extends ResettableObject {
  /** Persistence context id this category was constructed under. */
  readonly id: string;
  /**
   * The content registry (see {@link ContentRegistryView} for what a patch
   * reaches). Add defs with the category's `register`, which builds each
   * def's instance and state.
   */
  readonly registry: ContentRegistryView<Def>;

  /**
   * Register definitions and create their Producer instances.
   *
   * Can be called multiple times (base game + mods).
   */
  register(defs: Def | Def[]): void;

  /** Get the Producer instance for a definition ID */
  getProducer(id: string): Producer | undefined;

  /** Get the per-instance state for a definition ID */
  getState(id: string): DefState | undefined;

  /** Get the definition for an ID (delegates to registry.get) */
  getDef(id: string): Def | undefined;

  /** Get the full entry (def + producer + state) */
  getEntry(id: string): ProducerCategoryEntry<Def, DefState> | undefined;

  /** All entries in registration order */
  getAll(): ProducerCategoryEntry<Def, DefState>[];

  /**
   * Aggregate production rate across all continuous producers targeting a resource.
   * Returns `sum(computedRate * count)` for matching producers, where `count`
   * reflects each producer's effective `(owned + extraCount)` per its mapping.
   */
  getTotalRate(resource: Resource): DecimalSource;

  /** Number of registered entries */
  readonly size: number;
}

// === PRIVATE BUILDERS ===

/**
 * Build a Producer instance from a content definition. Module-private; called
 * by `createProducerCategory` inside the per-definition persistent context
 * opened by {@link createCategoryBase}.
 */
function buildProducer<Def extends { id: string }>(
  def: Def,
  categoryId: string,
  mapProducer: ProducerCategoryOptions<Def>['mapProducer'],
  ctx: ProducerCategoryContext,
  predicates: PredicateResolver,
): Producer {
  const mapping = mapProducer(def, ctx);

  const rateChain = createModifierChain(`${categoryId}/${def.id}/rate`);
  const computedRate = computed(() => Decimal.fromValue(rateChain.apply(mapping.baseRate)));

  let repeatable: Purchasable | undefined;
  if (mapping.purchase) {
    const pc = mapping.purchase;
    repeatable = createScalingPurchasable(
      {
        id: def.id,
        description: mapping.display ?? def.id,
        resource: pc.costResource,
        baseCost: pc.baseCost,
        costScaling: pc.costScaling,
        limit: pc.limit,
        initialCount: pc.initialCount,
        onPurchase: pc.onPurchase,
        visible: pc.visible,
        purchaseMaxByDefault: pc.purchaseMaxByDefault,
      },
      predicates,
    );
  }

  const processedExtraCount =
    mapping.extraCount !== undefined ? toMaybeRef(mapping.extraCount) : undefined;

  const ownedCount = computed<DecimalSource>(() =>
    repeatable ? repeatable.count.value : Decimal.dZero,
  );
  const extraCount = computed<DecimalSource>(() =>
    processedExtraCount ? unref(processedExtraCount) : Decimal.dZero,
  );
  const count = computed<DecimalSource>(() => {
    if (!repeatable && !processedExtraCount) return 1;
    return Decimal.add(ownedCount.value, extraCount.value);
  });

  let activate: (() => void) | undefined;
  if (mapping.trigger === 'manual') {
    activate = () => {
      addResource(mapping.resource, Decimal.mul(computedRate.value, count.value));
    };
  }

  // Stack-amortized beat: cost / (rate * max(1, count)). Infinity when nothing
  // is buyable, the rate is zero or the producer is manual (no rate per
  // second to amortize against) so consumers can branch on a finite check
  // without wrapping the call.
  const purchaseBeatSeconds = computed<number>(() => {
    if (!repeatable || mapping.trigger !== 'continuous') return Infinity;
    const rate = Decimal.fromValue(computedRate.value);
    if (!rate.gt(0)) return Infinity;
    const effCount = Decimal.max(1, count.value);
    const cost = Decimal.fromValue(repeatable.getCost(1));
    return cost.div(rate.mul(effCount)).toNumber();
  });

  return {
    id: def.id,
    rateChain,
    computedRate,
    resource: mapping.resource,
    allowNegative: mapping.allowNegative ?? false,
    trigger: mapping.trigger,
    repeatable,
    activate,
    ownedCount,
    extraCount,
    count,
    purchaseBeatSeconds,
  };
}

/**
 * Per-tick body for a continuous producer entry. Skips manual producers so
 * mixed-trigger categories don't double-credit on `activate()`.
 *
 * A rate chain carrying consumption modifiers can compose net-negative, so the
 * integration is signed: the same `rate × count × dt` that credits a positive
 * rate debits a negative one. The drain floors at zero unless the producer opts
 * into `allowNegative` — it takes what remains rather than refusing the whole
 * shortfall, since a continuous rate has no atomic purchase to reject.
 */
function tickContinuousProducer(entry: { instance: Producer }, dt: number): void {
  const producer = entry.instance;
  if (producer.trigger !== 'continuous') return;
  const amount = Decimal.mul(Decimal.mul(producer.computedRate.value, producer.count.value), dt);
  if (Decimal.gt(amount, 0)) {
    addResource(producer.resource, amount);
    return;
  }
  if (Decimal.gte(amount, 0)) return;
  const next = Decimal.add(producer.resource.value, amount);
  producer.resource.value = producer.allowNegative || Decimal.gte(next, 0) ? next : Decimal.dZero;
}

// === FACTORIES ===

/**
 * Create a producer category — batch registration of Producers from definitions.
 *
 * @param options - Category ID, mapping function, and tick registration
 * @returns A {@link ProducerCategory} with registry, lookup, and registration
 *
 * @example
 * ```ts
 * // Buildings that produce currency per second
 * const buildings = createProducerCategory<BuildingDef>({
 *   id: 'buildings',
 *   mapProducer: (def) => ({
 *     resource: gold,
 *     baseRate: def.baseRate,
 *     trigger: 'continuous',
 *     purchase: {
 *       costResource: gold,
 *       baseCost: def.baseCost,
 *       costScaling: 1.15,
 *     },
 *   }),
 *   registerTick: ctx.onTick,
 * });
 *
 * // The click itself: manual producer, no purchase count
 * const clicks = createProducerCategory<ClickDef>({
 *   id: 'clicks',
 *   mapProducer: (def) => ({
 *     resource: gold,
 *     baseRate: 1,
 *     trigger: 'manual',
 *   }),
 *   registerTick: ctx.onTick,
 * });
 * ```
 */
export function createProducerCategory<Def extends { id: string }, DefState = void>(
  options: ProducerCategoryOptions<Def, DefState>,
): ProducerCategory<Def, DefState> {
  const { id: categoryId, mapProducer, mapState, registerTick } = options;
  const ctx: ProducerCategoryContext = { registerTick };
  const predicates = createPredicateResolver();

  const base: CategoryBase<Def, Producer, DefState> = createCategoryBase({
    id: categoryId,
    buildInstance: (def) => buildProducer(def, categoryId, mapProducer, ctx, predicates),
    buildState: mapState,
    buildSignals: (_def, producer) => ({
      active: computed(() => Decimal.fromValue(producer.count.value).gt(0)),
      count: producer.count,
    }),
  });

  setupCategoryTick(base, registerTick, tickContinuousProducer, {
    profileLabel: 'producer.continuous.tick',
  });

  const category: ProducerCategory<Def, DefState> = {
    id: base.id,
    registry: base.registry,
    register: base.register,
    getDef: base.getDef,

    getProducer: (id) => base.getEntry(id)?.instance,
    getState: (id) => base.getEntry(id)?.state,

    getEntry(id) {
      const entry = base.getEntry(id);
      return (
        entry && {
          def: entry.def,
          producer: entry.instance,
          state: entry.state,
          signals: entry.signals!,
        }
      );
    },

    getAll() {
      return base.getAll().map((e) => ({
        def: e.def,
        producer: e.instance,
        state: e.state,
        signals: e.signals!,
      }));
    },

    getTotalRate(resource: Resource): DecimalSource {
      let total: DecimalSource = Decimal.dZero;
      for (const entry of base.getAll()) {
        const { instance: producer } = entry;
        if (producer.trigger !== 'continuous') continue;
        if (producer.resource !== resource) continue;
        total = Decimal.add(total, Decimal.mul(producer.computedRate.value, producer.count.value));
      }
      return total;
    },

    get size(): number {
      return base.size;
    },

    [Resettable]: base[Resettable],
  };

  const ec = getCurrentEngineCategories();
  if (ec) (ec.producers ??= []).push(category);

  return category;
}
