/**
 * Purchasable Category — batch-create Purchasables from defs
 *
 * Captures the shape of many purchasables that share a structure: cost
 * requirements, effects and visibility predicates. Handles both one-shot
 * upgrades and repeatable purchases through the one {@link Purchasable}
 * primitive.
 *
 * @example
 * ```ts
 * interface PerkDef { id: string; name: string; baseCost: number; maxCount: number }
 *
 * const perks = createPurchasableCategory<PerkDef>({
 *   id: 'perks',
 *   mapPurchasable: (def) => ({
 *     display: { title: def.name, description: `Upgrade ${def.name}` },
 *     // `count` is the perk's own count ref — a Formula over it stays
 *     // invertible, so purchase max costs each unit at its own step.
 *     // `.floor()` keeps every cost a whole number of gold.
 *     requirements: (count) =>
 *       createCostRequirement({
 *         resource: gold,
 *         cost: Formula.exponential(count, def.baseCost, 1.15).floor(),
 *         maxBulkCount: Decimal.dInf,
 *       }),
 *     limit: def.maxCount,
 *     effect: (count) => Decimal.pow(1.1, count),
 *   }),
 * });
 *
 * perks.register(PERK_DEFS);
 *
 * // Access
 * perks.getPurchasable('dmgReduce');               // Purchasable instance
 * perks.getPurchasable('dmgReduce')!.purchase(1);  // purchase one
 * // (a bare `purchase()` purchases max, up to `maxBulkCount`)
 * perks.purchasedCount.value;                      // how many are purchased at least once
 * perks.totalCount.value;                          // sum of all purchase counts
 * perks.purchaseAffordable();                      // purchase max on every affordable one
 * ```
 *
 * @cluster purchasable
 */

import { computed, type ComputedRef } from 'vue';
import { Decimal, type DecimalSource, renormIfLayer0 } from '@/primitives/decimal';
import {
  setupDeclarativeBindings,
  createCategoryBase,
  type CategoryBase,
  type CategoryEntrySignals,
} from './category-base';
import { createPredicateResolver } from './gate';
import { type ContentRegistryView } from './content-registry';
import { Resettable, type ResettableObject } from '@/core/resettable';
import { createPurchasable, type Purchasable, type PurchasableOptions } from './purchasable';
import { getCurrentEngineCategories } from './engine-categories';
import type { Grant } from '@/core/modifier';

// === TYPES ===

/**
 * Options for {@link createPurchasableCategory}.
 *
 * @typeParam Def - The def type (must have `id: string`)
 * @typeParam DefState - Def state created beside each Purchasable.
 *   Use `void` if no def state is needed.
 */
export interface PurchasableCategoryOptions<Def extends { id: string }, DefState = void> {
  /** Persistent context id. Each def gets a child persistent context `{id}/{def.id}`. */
  id: string;

  /**
   * Map a def to PurchasableOptions.
   *
   * Called once per def during {@link PurchasableCategory.register}.
   * The returned options are passed to `createPurchasable()`.
   *
   * Note: `id` is provided by the category — don't include it in the
   * returned options (it will be overwritten).
   *
   * For a cost that scales on the purchasable's own count, return
   * `requirements` in its function form. The function receives the live
   * `count` ref, which a Formula cost needs and `def` alone cannot supply. See
   * {@link PurchasableOptions.requirements}. Reading the count back out of the
   * category with `getPurchasable(def.id)?.count.value` is the shape to avoid:
   * it works forwards, but costs every unit of a bulk purchase at the current count.
   *
   * The optional `grants` field declares modifiers that bind to shared chains
   * while the purchasable is active. Each {@link Grant} becomes a `chain.bind`
   * call with the purchasable's `active` as its predicate. So the balance
   * harness and devtools can attribute the binding to this category and
   * purchasable, with no wiring per binding.
   */
  mapPurchasable: (def: Def) => Omit<PurchasableOptions, 'id'> & { grants?: Grant[] };

  /**
   * Create the def state beside the Purchasable.
   *
   * Called inside the def's persistent context, so `persistent()` calls
   * here save under `{categoryId}/{def.id}`.
   *
   * Omit if no def state is needed.
   */
  mapState?: (def: Def, purchasable: Purchasable) => DefState;
}

/** A category entry: def, Purchasable instance, def state and signals */
export interface PurchasableCategoryEntry<Def extends { id: string }, DefState = void> {
  readonly def: Def;
  readonly purchasable: Purchasable;
  readonly state: DefState;
  readonly signals: CategoryEntrySignals;
}

/**
 * A purchasable category — batch-registered Purchasables with a shared shape.
 *
 * @typeParam Def - The def type
 * @typeParam DefState - The def state type (void if none)
 */
export interface PurchasableCategory<
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
   * Register defs and create their Purchasable instances.
   * Can be called more than once (base game, then a mod's content).
   */
  register(defs: Def | readonly Def[]): void;

  /** Get the Purchasable instance for a def id */
  getPurchasable(id: string): Purchasable | undefined;

  /** Get the def state for a def id */
  getState(id: string): DefState | undefined;

  /** Get the def for an id (delegates to registry.get) */
  getDef(id: string): Def | undefined;

  /** Get the category entry (def, purchasable, def state, signals) */
  getEntry(id: string): PurchasableCategoryEntry<Def, DefState> | undefined;

  /** All category entries in registration order */
  getAll(): PurchasableCategoryEntry<Def, DefState>[];

  /** Reactive count of purchasables purchased at least once (`count >= 1`) */
  readonly purchasedCount: ComputedRef<number>;

  /** Reactive sum of all purchasables' purchase counts */
  readonly totalCount: ComputedRef<DecimalSource>;

  /** Reactive product of the effects of every purchasable purchased at least once */
  readonly totalEffect: ComputedRef<DecimalSource>;

  /** `true` when every registered purchasable has reached its limit */
  readonly allMaxed: ComputedRef<boolean>;

  /** Return every purchasable whose `canPurchase` is true */
  getAffordable(): Purchasable[];

  /** Purchase max on every purchasable whose `canPurchase` is true. Returns the total count purchased, or `0` for none. */
  purchaseAffordable(): Decimal | 0;

  /** Number of registered entries */
  readonly size: number;
}

// === FACTORIES ===

/**
 * Create a purchasable category — batch registration of Purchasables from defs.
 *
 * @param options - Category id and `mapPurchasable`
 * @returns A {@link PurchasableCategory} with registry, lookup, and bulk purchase
 *
 * @example One-shot upgrades — a static cost is exact at `limit: 1`; scaling costs take the function form of `requirements`.
 * ```ts
 * const upgrades = createPurchasableCategory<UpgDef>({
 *   id: 'upgrades',
 *   mapPurchasable: (def) => ({
 *     display: { description: def.desc },
 *     requirements: createCostRequirement({ resource: gold, cost: def.cost }),
 *     effect: def.bonus,
 *     limit: 1,
 *   }),
 * });
 *
 * upgrades.register(UPGRADE_DEFS);
 * upgrades.purchaseAffordable(); // purchase all we can
 * ```
 */
export function createPurchasableCategory<Def extends { id: string }, DefState = void>(
  options: PurchasableCategoryOptions<Def, DefState>,
): PurchasableCategory<Def, DefState> {
  const { id, mapPurchasable, mapState } = options;
  const predicates = createPredicateResolver();

  const base: CategoryBase<Def, Purchasable, DefState> = createCategoryBase({
    id,
    buildInstance: (def) => {
      const { grants, ...opts } = mapPurchasable(def);
      const purchasable = createPurchasable({ ...opts, id: def.id }, predicates);
      setupDeclarativeBindings(grants, purchasable.active, predicates, `purchasable '${def.id}'`);
      return purchasable;
    },
    buildState: mapState,
    buildSignals: (_def, purchasable) => ({
      active: purchasable.active,
      count: computed(() => purchasable.count.value),
    }),
  });

  const list = (): readonly Purchasable[] => base.getAll().map((e) => e.instance);

  const purchasedCount = computed(() => list().filter((p) => p.active.value).length);

  const totalCount = computed((): DecimalSource =>
    list().reduce<DecimalSource>(
      (sum, p) => renormIfLayer0(Decimal.add(sum, p.count.value)),
      Decimal.dZero,
    ),
  );

  // Blocked by `active` here rather than on `Purchasable.effect`, which a UI
  // reads before purchase to preview an upgrade's effect value.
  const totalEffect = computed((): DecimalSource =>
    list().reduce<DecimalSource>(
      (product, p) =>
        p.active.value ? renormIfLayer0(Decimal.mul(product, p.effect.value)) : product,
      Decimal.dOne,
    ),
  );

  const allMaxed = computed(() => {
    const l = list();
    return l.length > 0 && l.every((p) => p.maxed.value);
  });

  const category: PurchasableCategory<Def, DefState> = {
    id: base.id,
    registry: base.registry,
    register: base.register,
    getDef: base.getDef,

    getPurchasable(id: string): Purchasable | undefined {
      return base.getEntry(id)?.instance;
    },

    getState(id: string): DefState | undefined {
      return base.getEntry(id)?.state;
    },

    getEntry(id: string): PurchasableCategoryEntry<Def, DefState> | undefined {
      const entry = base.getEntry(id);
      if (!entry) return undefined;
      return {
        def: entry.def,
        purchasable: entry.instance,
        state: entry.state,
        signals: entry.signals!,
      };
    },

    getAll(): PurchasableCategoryEntry<Def, DefState>[] {
      return base.getAll().map((e) => ({
        def: e.def,
        purchasable: e.instance,
        state: e.state,
        signals: e.signals!,
      }));
    },

    purchasedCount,
    totalCount,
    totalEffect,
    allMaxed,

    getAffordable(): Purchasable[] {
      return list().filter((p) => p.canPurchase.value);
    },

    purchaseAffordable(): Decimal | 0 {
      let total: Decimal | 0 = 0;
      for (const p of list()) {
        if (p.canPurchase.value) {
          const bought = p.purchaseMax();
          if (bought) total = Decimal.add(total, bought);
        }
      }
      return total;
    },

    get size(): number {
      return base.size;
    },

    [Resettable]: base[Resettable],
  };

  const ec = getCurrentEngineCategories();
  if (ec) (ec.purchasables ??= []).push(category);

  return category;
}
