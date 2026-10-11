/**
 * Producer Category — batch-create Producers from defs.
 *
 * Captures the producer shape shared by buildings (continuous, every tick)
 * and manual click sources: a base rate, a modifier chain, an optional
 * Purchasable for the count, and a target resource. Two trigger modes
 * (`'continuous'`, `'manual'`); each def gets its own persistent context.
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
 * Purchase options for a producer purchased more than once.
 * Builds a {@link Purchasable} through `createScalingPurchasable`.
 */
export interface ProducerPurchaseOptions {
  /** Resource spent to purchase */
  costResource: Resource;
  /** Cost of the first purchase. Can be a ref or getter, for a tunable or a scoped override. */
  baseCost: Computable<DecimalSource>;
  /** The cost ratio each purchase multiplies the next cost by. Can be a ref or getter, for a tunable or a scoped override. */
  costScaling: Computable<DecimalSource>;
  /** The limit: the most purchases */
  limit?: Computable<DecimalSource>;
  /** Starting count (default 0) */
  initialCount?: DecimalSource;
  /** Option callback called after each purchase */
  onPurchase?: (count: DecimalSource) => void;
  /** Whether this producer is visible in the UI. Default: `true` */
  visible?: Predicate;
  /**
   * Whether a bare `repeatable.purchase()` purchases max rather than one;
   * `purchase(1)` purchases one either way. Default: `true` (`false` at `limit: 1`)
   */
  purchaseMaxByDefault?: Computable<boolean>;
}

/**
 * Return type of the {@link ProducerCategoryOptions.mapProducer} callback.
 * Describes how a def maps to a producer.
 */
export interface ProducerMapping {
  /** The resource this producer produces */
  resource: Resource;
  /** Base production: per unit per second (continuous) or per activation (manual) */
  baseRate: DecimalSource;
  /**
   * `'continuous'` runs every tick; `'manual'` exposes `.activate()`, which
   * credits `computedRate × count` once per call.
   */
  trigger: 'continuous' | 'manual';
  /**
   * If present, builds a scaling purchasable (`createScalingPurchasable`) for
   * the purchase count. The policy auto-purchase (`setupPolicyAutoPurchase`)
   * skips a `'manual'` producer's purchase.
   */
  purchase?: ProducerPurchaseOptions;
  /** Description text for the repeatable (when `purchase` is set) */
  display?: string;
  /**
   * Extra count beyond the purchasable's owned count, added into
   * `Producer.count` as `owned + extra`. Use it in a production cascade, where
   * a cascade tier reads a consumer-kept "generated" count (typically a
   * {@link Resource}). Its tick output is then `(owned + generated) × rate × dt`.
   * Can be a ref or getter for reactive values.
   *
   * With no purchasable, count is `extraCount` alone. With neither, count is 1.
   *
   * Resetting the generated source is the consumer's job; the engine does
   * nothing here.
   */
  extraCount?: Computable<DecimalSource>;
  /**
   * Let the resource fall below zero when the composed rate is net-negative.
   *
   * A rate chain with consumption modifiers can evaluate negative. Then the
   * tick subtracts instead of producing. By default the subtraction stops at
   * zero, taking whatever remains. {@link subtractResource} instead refuses a
   * shortfall outright, but a continuous rate has no atomic purchase to
   * reject. Set `true` when the deficit is itself game information (e.g.
   * starvation detectors that read a negative amount).
   */
  allowNegative?: boolean;
}

/**
 * Options for {@link createProducerCategory}.
 *
 * @typeParam Def - The def type (must have `id: string`)
 * @typeParam DefState - Def state created beside each Producer.
 *   Use `void` if no def state is needed.
 */
export interface ProducerCategoryOptions<Def extends { id: string }, DefState = void> {
  /** Persistent context id. Each def gets a child persistent context `{id}/{def.id}`. */
  id: string;

  /**
   * Map a def to a {@link ProducerMapping}.
   *
   * Called once per def during {@link ProducerCategory.register}.
   * The returned mapping decides which primitives are built.
   */
  mapProducer: (def: Def, ctx: ProducerCategoryContext) => ProducerMapping;

  /**
   * Create the def state beside the Producer.
   *
   * Called inside the def's persistent context, so `persistent()` calls
   * here save under `{categoryId}/{def.id}`.
   */
  mapState?: (def: Def, producer: Producer) => DefState;

  /** Tick registration function (typically ctx.onTick from the engine) */
  registerTick: RegisterTick;
}

/**
 * A producer instance — produces resources continuously or when activated.
 *
 * The `rateChain` is the main extension point: upgrades and synergies
 * add modifiers here to raise production.
 */
export interface Producer {
  /** The id of the def this producer was registered from */
  readonly id: string;
  /**
   * Modifier chain for this producer's rate — the seam where upgrades,
   * synergies and global multipliers reach its output. A shared chain
   * counts only once bound in (`producer.rateChain.bind({ modifier: shared })`,
   * typically from `mapState`, which also runs for producers a mod registers).
   *
   * Applies to `baseRate` per unit, before `count` multiplies in, so a flat
   * `+5` here gives `5 × count`. A flat addition to all production belongs on
   * the resource side, e.g. a producer with no `purchase`, whose count is 1.
   */
  readonly rateChain: ModifierChain;
  /**
   * Per-unit rate: `baseRate` after `rateChain`, per second (continuous) or
   * per activation (manual). The producer's output is this × `count`.
   */
  readonly computedRate: ComputedRef<DecimalSource>;
  /** The resource this producer produces */
  readonly resource: Resource;
  /** Whether a net-negative rate may take the resource below zero */
  readonly allowNegative: boolean;
  /** Trigger mode */
  readonly trigger: 'continuous' | 'manual';
  /** The Purchasable, when `purchase` was set */
  readonly repeatable: Purchasable | undefined;
  /** For manual producers: produce once (`computedRate × count`) */
  readonly activate: (() => void) | undefined;
  /**
   * Owned count: the purchasable's `count`, or 0 when no `purchase` is
   * set. Bind this — not `count` — for effects and costs that apply only to
   * what the player has purchased (e.g. "+10% per owned unit", a next
   * cascade tier's cost that scales with the owned count).
   */
  readonly ownedCount: ComputedRef<DecimalSource>;
  /**
   * The mapping's `extraCount`, resolved, or 0 when not set. In a production
   * cascade this is the consumer-kept "generated" count (typically a
   * {@link Resource} fed by the previous cascade tier's tick output). Exposed
   * apart from `ownedCount`, so effects and costs that apply to one of the two
   * don't mix them: `ownedCount` tracks purchases, `extraCount` tracks accumulation.
   */
  readonly extraCount: ComputedRef<DecimalSource>;
  /**
   * Effective count: `ownedCount + extraCount`, falling back to 1 when neither
   * is set (the default for a click source). Drives the tick body,
   * `activate`, `purchaseBeatSeconds`, the total rate, and the category
   * entry's `count` signal. For effects or costs that should apply to only
   * one of the two, bind `ownedCount` or `extraCount` directly instead.
   */
  readonly count: ComputedRef<DecimalSource>;
  /**
   * Seconds this producer's whole stack takes to produce the cost of its next
   * unit: `getCost(1) / (computedRate * max(1, count))`. Returns `Infinity`
   * when there is no purchase, the rate is zero or the producer is manual.
   *
   * A stack-amortized beat time, not a payback period. The next unit adds only
   * `computedRate`, so its own payback period is `getCost(1) / computedRate`,
   * longer than this by the stack height. So a tall stack shows a short beat
   * time even when its marginal unit's payback period is long. Compute the
   * marginal payback period inline when that is the question.
   *
   * Not a prediction of when the producer will become affordable from the
   * player's rates — that distinction is documented inline at
   * `harness/walker/walk-producer-transitions.ts`.
   *
   * When `extraCount` is wired (a production cascade), the denominator's `count`
   * contains the cascade's `(owned + generated)`.
   */
  readonly purchaseBeatSeconds: ComputedRef<number>;
}

/** A category entry: def, Producer instance, def state and signals */
export interface ProducerCategoryEntry<Def extends { id: string }, DefState = void> {
  readonly def: Def;
  readonly producer: Producer;
  readonly state: DefState;
  readonly signals: CategoryEntrySignals;
}

/**
 * A producer category — batch-registered Producers with a shared production shape.
 *
 * @typeParam Def - The def type
 * @typeParam DefState - The def state type (void if none)
 */
export interface ProducerCategory<
  Def extends { id: string },
  DefState = void,
> extends ResettableObject {
  /** Persistent context id this category was built under. */
  readonly id: string;
  /**
   * The content registry (see {@link ContentRegistryView} for what a patch
   * reaches). Add defs with the category's `register`, which builds each
   * def's instance and def state.
   */
  readonly registry: ContentRegistryView<Def>;

  /**
   * Register defs and create their Producer instances.
   *
   * Can be called more than once (base game, then a mod's content).
   */
  register(defs: Def | Def[]): void;

  /** Get the Producer instance for a def id */
  getProducer(id: string): Producer | undefined;

  /** Get the def state for a def id */
  getState(id: string): DefState | undefined;

  /** Get the def for an id (delegates to registry.get) */
  getDef(id: string): Def | undefined;

  /** Get the category entry (def, producer, def state, signals) */
  getEntry(id: string): ProducerCategoryEntry<Def, DefState> | undefined;

  /** All category entries in registration order */
  getAll(): ProducerCategoryEntry<Def, DefState>[];

  /**
   * The total rate of all continuous producers of a resource.
   * Returns `sum(computedRate * count)` for matching producers, where `count`
   * is each producer's effective count, `owned + extraCount`.
   */
  getTotalRate(resource: Resource): DecimalSource;

  /** Number of registered entries */
  readonly size: number;
}

// === PRIVATE BUILDERS ===

/**
 * Build a Producer instance from a def. Private to this file; called
 * by `createProducerCategory` inside the def's persistent context
 * that {@link createCategoryBase} opens.
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

  // Stack-amortized beat time: cost / (rate * max(1, count)). Infinity when there
  // is no purchase, the rate is zero or the producer is manual (no rate per
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
 * A rate chain with consumption modifiers can compose net-negative, so the
 * integration is signed: the same `rate × count × dt` that credits a positive
 * rate debits a negative one. The subtraction stops at zero unless the producer
 * opts into `allowNegative`. It takes what remains rather than refusing the
 * whole shortfall, because a continuous rate has no atomic purchase to reject.
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
 * Create a producer category — batch registration of Producers from defs.
 *
 * @param options - Category id, `mapProducer`, and tick registration
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
