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

import { computed, shallowRef, unref, type ComputedRef, type Ref, type ShallowRef } from 'vue';
import { toMaybeRef, type Computable } from '@/core/computed';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { createModifierChain, type ModifierChain } from '@/core/modifier';
import { addResource, getResourceClamp, type Resource } from '@/core/resource';
import {
  createCategoryBase,
  setupCategoryTick,
  type CategoryBase,
  type CategoryEntrySignals,
} from './category-base';
import { type ContentRegistryView } from './content-registry';
import { Resettable, type ResettableObject } from '@/core/resettable';
import {
  createScalingPurchasable,
  toPurchasableDisplay,
  type Purchasable,
  type PurchasableDisplay,
} from './purchasable';
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
  costRatio: Computable<DecimalSource>;
  /** The limit: the most purchases */
  limit?: Computable<DecimalSource>;
  /** Starting count (default 0) */
  initialCount?: DecimalSource;
  /** Option callback called after each purchase, with that purchase's bulk count, not the new `count` */
  onPurchase?: (bulkCount: DecimalSource) => void;
  /** Whether this producer is visible in the UI. Default: `true` */
  visible?: Predicate;
  /**
   * Whether a bare `repeatable.purchase()` purchases max rather than one;
   * `purchase(1)` purchases one either way. Default: `true` (`false` at `limit: 1`)
   */
  purchaseMaxByDefault?: Computable<boolean>;
}

/** A stock a converting producer draws for each unit of output. */
export interface ProducerInput {
  resource: Resource;
  /** Amount drawn per unit of output. Can be a ref or getter, for a tunable. */
  per: Computable<DecimalSource>;
}

/**
 * Return type of the {@link ProducerCategoryOptions.mapProducer} callback.
 * Describes how a def maps to a producer.
 */
export interface ProducerMapping {
  /** The resource this producer produces */
  resource: Resource;
  /**
   * Base production: per unit per second (continuous) or per activation
   * (manual). Can be a ref or getter, for a tunable or a scoped override.
   */
  baseRate: Computable<DecimalSource>;
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
  /**
   * The repeatable's display, when `purchase` is set: a {@link PurchasableDisplay},
   * or a string, ref or getter for its description. Default: the def's id.
   */
  display?: PurchasableDisplay | Computable<string>;
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
  // TODO(expansion): a declared claim priority, once a game needs an order other
  // than registration order for converters that share an input.
  /**
   * Turn the producer into a converter: each unit of output draws `per` of
   * each input. A tick makes `computedRate × count × dt`, or less when an
   * input holds too little or the output's linked bag is full, and debits the
   * inputs by what it made. Keyed by consumer-chosen key. Continuous producers
   * only, and not with `allowNegative`.
   *
   * A converter claims its inputs after the tick's gains and losses are
   * written. Converters that share an input claim it in registration order:
   * an earlier one takes its full draw first.
   */
  inputs?: Record<string, ProducerInput>;
  /**
   * Option callback run after each continuous tick that produced, once the
   * amount is written, with the amount it added. For a side credit beside the output, such as a count of
   * the input a converter drew.
   */
  onProduce?: (amount: DecimalSource) => void;
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
  /** The stocks a converter draws per unit of output; undefined for a plain producer */
  readonly inputs: Readonly<Record<string, ResolvedProducerInput>> | undefined;
  /**
   * A converter's output per second on its last tick, after its inputs bound
   * it. `computedRate × count` is what it would make unbounded. Present only
   * when `inputs` is set.
   */
  readonly realizedRate?: Readonly<Ref<DecimalSource>>;
  /** What bound a converter's last tick. Present only when `inputs` is set. */
  readonly limit?: Readonly<Ref<ProducerLimit>>;
  /** The `onProduce` option callback, if set */
  readonly onProduce?: (amount: DecimalSource) => void;
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

/**
 * What bound a converter's last tick: `'rate'` when it made what its rate
 * wants, `'input:<key>'` when that input ran short, `'room'` when the output's
 * resource bag was full.
 */
export type ProducerLimit = 'rate' | `input:${string}` | 'room';

/** A {@link ProducerInput} with its per-unit draw resolved to a ref. */
export interface ResolvedProducerInput {
  readonly resource: Resource;
  readonly per: ComputedRef<DecimalSource>;
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
   * is each producer's effective count, `owned + extraCount`. A converter
   * counts at that nominal rate, even when its inputs starve it; its
   * `realizedRate` is what it made. Its draws do not count against its inputs.
   */
  getTotalRate(resource: Resource): DecimalSource;

  /** Number of registered entries */
  readonly size: number;
}

/** A converter's tick-side state: its inputs, and the refs it reports through. */
interface ConverterState {
  readonly inputs: readonly {
    readonly key: string;
    readonly resource: Resource;
    readonly per: ComputedRef<DecimalSource>;
  }[];
  readonly realizedRate: ShallowRef<DecimalSource>;
  readonly limit: ShallowRef<ProducerLimit>;
}

/** One tick's writes, collected by the walk and applied after it. */
interface ProducerTickBatch {
  dt: number;
  /** Summed gain per resource */
  readonly gains: Map<Resource, DecimalSource>;
  /** Gaining producers with an `onProduce`, and what each made */
  readonly produced: [Producer, Decimal][];
  readonly losses: [Producer, Decimal][];
  readonly converters: [Producer, ConverterState, Decimal][];
}

const converterStates = new WeakMap<Producer, ConverterState>();

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
  if (mapping.inputs && (mapping.trigger !== 'continuous' || mapping.allowNegative)) {
    throw new Error(
      `Producer "${def.id}" sets inputs, which need trigger 'continuous' and no allowNegative: a converter draws stock per tick and never debits below zero.`,
    );
  }

  const rateChain = createModifierChain(`${categoryId}/${def.id}/rate`);
  const baseRate = toMaybeRef(mapping.baseRate);
  const computedRate = computed(() => Decimal.fromValue(rateChain.apply(unref(baseRate))));

  let repeatable: Purchasable | undefined;
  if (mapping.purchase) {
    const pc = mapping.purchase;
    const { title, description, effectDescription, showCount } = toPurchasableDisplay(
      mapping.display ?? def.id,
    );
    repeatable = createScalingPurchasable(
      {
        id: def.id,
        title,
        description,
        effectDescription,
        showCount,
        resource: pc.costResource,
        baseCost: pc.baseCost,
        costRatio: pc.costRatio,
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

  const converter: ConverterState | undefined = mapping.inputs && {
    inputs: Object.entries(mapping.inputs).map(([key, input]) => {
      const per = toMaybeRef(input.per);
      return { key, resource: input.resource, per: computed(() => unref(per)) };
    }),
    realizedRate: shallowRef<DecimalSource>(Decimal.dZero),
    limit: shallowRef<ProducerLimit>('rate'),
  };

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

  const producer: Producer = {
    id: def.id,
    rateChain,
    computedRate,
    resource: mapping.resource,
    allowNegative: mapping.allowNegative ?? false,
    inputs:
      converter &&
      Object.fromEntries(
        converter.inputs.map(({ key, resource, per }) => [key, { resource, per }]),
      ),
    onProduce: mapping.onProduce,
    ...(converter && { realizedRate: converter.realizedRate, limit: converter.limit }),
    trigger: mapping.trigger,
    repeatable,
    activate,
    ownedCount,
    extraCount,
    count,
    purchaseBeatSeconds,
  };
  if (converter) converterStates.set(producer, converter);
  return producer;
}

// === PRIVATE TICK ===

/**
 * Collect one continuous producer's tick into `batch`. Skips manual producers
 * so mixed-trigger categories don't double-credit on `activate()`. The walk
 * only reads, so every producer's rate reads the state from before the tick.
 */
function collectContinuousProducer(
  entry: { instance: Producer },
  dt: number,
  batch: ProducerTickBatch,
): void {
  const producer = entry.instance;
  if (producer.trigger !== 'continuous') return;
  const amount = Decimal.mul(Decimal.mul(producer.computedRate.value, producer.count.value), dt);
  batch.dt = dt;
  const converter = converterStates.get(producer);
  if (converter) {
    batch.converters.push([producer, converter, amount]);
    return;
  }
  if (amount.gt(Decimal.dZero)) {
    const held = batch.gains.get(producer.resource);
    batch.gains.set(producer.resource, held === undefined ? amount : Decimal.add(held, amount));
    if (producer.onProduce) batch.produced.push([producer, amount]);
    return;
  }
  if (amount.gte(Decimal.dZero)) return;
  batch.losses.push([producer, amount]);
}

/**
 * Apply a tick's writes: each resource's summed gain in one write, then the
 * losses, then the converters, each in registration order. One write per
 * resource matters because every write runs the resource's sync watchers.
 *
 * A rate chain with consumption modifiers can compose net-negative, so the
 * integration is signed: the same `rate × count × dt` that credits a positive
 * rate debits a negative one. The subtraction stops at zero unless the producer
 * opts into `allowNegative`. It takes what remains rather than refusing the
 * whole shortfall, because a continuous rate has no atomic purchase to reject.
 */
function applyProducerTick(batch: ProducerTickBatch): void {
  try {
    for (const [resource, gain] of batch.gains) addResource(resource, gain);
    for (const [producer, amount] of batch.produced) producer.onProduce!(amount);
    for (const [producer, amount] of batch.losses) {
      const next = Decimal.add(producer.resource.value, amount);
      producer.resource.value =
        producer.allowNegative || Decimal.gte(next, 0) ? next : Decimal.dZero;
    }
    for (const [producer, converter, want] of batch.converters) {
      tickConverter(producer, converter, want, batch.dt);
    }
  } finally {
    batch.gains.clear();
    batch.produced.length = 0;
    batch.losses.length = 0;
    batch.converters.length = 0;
  }
}

/** One converter's tick: make what the rate wants, bounded by the inputs. */
function tickConverter(
  producer: Producer,
  converter: ConverterState,
  want: Decimal,
  dt: number,
): void {
  let made = Decimal.max(want, Decimal.dZero);
  let limit: ProducerLimit = 'rate';
  for (const { key, resource, per } of converter.inputs) {
    const draw = Decimal.fromValue_noAlloc(per.value);
    if (!draw.gt(Decimal.dZero)) continue;
    const feeds = Decimal.div(resource.value, draw);
    if (feeds.lt(made)) {
      made = feeds;
      limit = `input:${key}`;
    }
  }
  // A full bin throttles the converter, so no input is burned into the overflow.
  const clamp = getResourceClamp(producer.resource);
  if (clamp && made.gt(Decimal.dZero)) {
    // Compare targets, not (held + made) − held, which float error can put an ulp short.
    const held = producer.resource.value;
    const target = Decimal.add(held, made);
    const landed = clamp(target);
    if (Decimal.lt(landed, target)) {
      made = Decimal.max(Decimal.sub(landed, held), Decimal.dZero);
      limit = 'room';
    }
  }
  converter.limit.value = limit;
  if (!made.gt(Decimal.dZero)) {
    converter.realizedRate.value = Decimal.dZero;
    return;
  }
  converter.realizedRate.value = Decimal.div(made, dt);
  for (const { resource, per } of converter.inputs) {
    const next = Decimal.sub(resource.value, Decimal.mul(made, per.value));
    resource.value = Decimal.max(next, Decimal.dZero);
  }
  addResource(producer.resource, made);
  producer.onProduce?.(made);
}

// === FACTORIES ===

/**
 * Create a producer category — batch registration of Producers from defs.
 *
 * Each tick, every continuous producer's rate reads the state from before
 * the tick, and each resource takes its producers' summed gain in one write.
 * So the tick's result does not depend on registration order, except where
 * converters share an input: they claim it in registration order.
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
 *       costRatio: 1.15,
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

  const batch: ProducerTickBatch = {
    dt: 0,
    gains: new Map(),
    produced: [],
    losses: [],
    converters: [],
  };
  setupCategoryTick(
    base,
    registerTick,
    (entry, dt) => collectContinuousProducer(entry, dt, batch),
    {
      profileLabel: 'producer.continuous.tick',
      afterWalk: () => applyProducerTick(batch),
    },
  );

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
