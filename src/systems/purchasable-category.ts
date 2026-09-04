/**
 * Purchasable Category — batch-create Purchasables from content definitions
 *
 * Captures the common pattern of dozens to hundreds of purchasable items
 * sharing a structure: cost requirements, effects, visibility gating.
 * Handles both one-shot upgrades and leveled repeatables through the
 * unified {@link Purchasable} primitive.
 *
 * @example
 * ```ts
 * interface PerkDef { id: string; name: string; baseCost: number; maxLevel: number }
 *
 * const perks = createPurchasableCategory<PerkDef>({
 *   id: 'perks',
 *   mapPurchasable: (def) => ({
 *     display: { title: def.name, description: `Level up ${def.name}` },
 *     // `level` is the perk's own amount ref — a Formula over it stays
 *     // invertible, so buy-max prices each level at its own rung.
 *     requirements: (level) =>
 *       createCostRequirement({
 *         resource: gold,
 *         cost: Formula.exponential(level, def.baseCost, 1.15),
 *         maxBulkAmount: Decimal.dInf,
 *       }),
 *     limit: def.maxLevel,
 *     effect: (amount) => Decimal.pow(1.1, amount),
 *   }),
 * });
 *
 * perks.register(PERK_DEFS);
 *
 * // Access
 * perks.getPurchasable('dmgReduce');               // Purchasable instance
 * perks.getPurchasable('dmgReduce')!.purchase();   // buy a level
 * perks.purchasedCount.value;                      // how many have been bought at least once
 * perks.totalAmount.value;                         // sum of all levels
 * perks.purchaseAffordable();                      // buy-max on every affordable
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
import { type ContentRegistry } from './content-registry';
import { Resettable, type ResettableObject } from './resettable';
import { createPurchasable, type Purchasable, type PurchasableOptions } from './purchasable';
import { getCurrentEngineCategories } from './engine-categories';
import type { Grant } from '@/core/modifier';

// === TYPES ===

/**
 * Options for {@link createPurchasableCategory}.
 *
 * @typeParam Def - The content definition type (must have `id: string`)
 * @typeParam State - Per-instance state created alongside each Purchasable.
 *   Use `void` if no extra state is needed.
 */
export interface PurchasableCategoryOptions<Def extends { id: string }, State = void> {
  /** Persistence context name. Each definition gets a sub-context `{id}/{def.id}`. */
  id: string;

  /**
   * Map a content definition to PurchasableOptions.
   *
   * Called once per definition during {@link PurchasableCategory.register}.
   * The returned options are passed to `createPurchasable()`.
   *
   * Note: `id` is provided by the category — don't include it in the
   * returned options (it will be overwritten).
   *
   * For a cost that scales on the item's own level, return `requirements` in
   * its factory form — the callback receives the live `amount` ref, which is
   * what a Formula cost needs and what `def` alone cannot supply. See
   * {@link PurchasableOptions.requirements}. Reading the level back out of the
   * category with `getPurchasable(def.id)?.amount.value` is the shape to
   * avoid: it works forwards but prices bulk purchases linearly.
   *
   * The optional `grants` field declares modifiers that bind to shared chains
   * while the purchasable is active. Each {@link Grant} is lowered to a
   * `chain.bind` call with `item.active` as the implicit predicate, so
   * balance-sim and devtools can attribute the contribution back to this
   * category + item without any per-binding wiring.
   */
  mapPurchasable: (def: Def) => Omit<PurchasableOptions, 'id'> & { grants?: Grant[] };

  /**
   * Create per-instance state alongside the Purchasable.
   *
   * Called inside the definition's persistent context, so `persistent()` calls
   * here are scoped to `{categoryId}/{def.id}`.
   *
   * Omit if no extra state is needed.
   */
  mapState?: (def: Def, purchasable: Purchasable) => State;
}

/** A registered entry: definition + Purchasable instance + optional state + introspection signals */
export interface PurchasableCategoryEntry<Def extends { id: string }, State = void> {
  readonly def: Def;
  readonly purchasable: Purchasable;
  readonly state: State;
  readonly signals: CategoryEntrySignals;
}

/**
 * A purchasable category — batch-registered Purchasables with a shared shape.
 *
 * @typeParam Def - Content definition type
 * @typeParam State - Per-instance state type (void if none)
 */
export interface PurchasableCategory<
  Def extends { id: string },
  State = void,
> extends ResettableObject {
  /** Persistence context id this category was constructed under. */
  readonly id: string;
  /** The content registry — mods can call `registry.register()` or `registry.patch()` */
  readonly registry: ContentRegistry<Def>;

  /**
   * Register definitions and create their Purchasable instances.
   * Can be called multiple times (base game + mods).
   */
  register(defs: Def | Def[]): void;

  /** Get the Purchasable instance for a definition ID */
  getPurchasable(id: string): Purchasable | undefined;

  /** Get the per-instance state for a definition ID */
  getState(id: string): State | undefined;

  /** Get the definition for an ID (delegates to registry.get) */
  getDef(id: string): Def | undefined;

  /** Get the full entry (def + purchasable + state) */
  getEntry(id: string): PurchasableCategoryEntry<Def, State> | undefined;

  /** All entries in registration order */
  getAll(): PurchasableCategoryEntry<Def, State>[];

  /** Reactive count of purchasables that have been bought at least once (amount >= 1) */
  readonly purchasedCount: ComputedRef<number>;

  /** Reactive sum of all purchasables' amounts (total levels across all) */
  readonly totalAmount: ComputedRef<DecimalSource>;

  /** Reactive product of all purchasables' effects */
  readonly totalEffect: ComputedRef<DecimalSource>;

  /** True when every registered purchasable has reached its limit */
  readonly allMaxed: ComputedRef<boolean>;

  /** Return all purchasables that can currently be afforded */
  getAffordable(): Purchasable[];

  /** Buy-max on every affordable purchasable. Returns total levels bought across all. */
  purchaseAffordable(): DecimalSource;

  /** Number of registered entries */
  readonly size: number;
}

// === FACTORIES ===

/**
 * Create a purchasable category — batch registration of Purchasables from definitions.
 *
 * @param options - Category ID and mapping function
 * @returns A {@link PurchasableCategory} with registry, lookup, and bulk purchase
 *
 * @example One-shot upgrades — a static cost is exact at `limit: 1`; leveled costs take the factory form of `requirements`.
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
 * upgrades.purchaseAffordable(); // buy all we can
 * ```
 */
export function createPurchasableCategory<Def extends { id: string }, State = void>(
  options: PurchasableCategoryOptions<Def, State>,
): PurchasableCategory<Def, State> {
  const { id, mapPurchasable, mapState } = options;

  const base: CategoryBase<Def, Purchasable, State> = createCategoryBase({
    id,
    buildInstance: (def) => {
      const { grants, ...opts } = mapPurchasable(def);
      const purchasable = createPurchasable({ ...opts, id: def.id });
      setupDeclarativeBindings(grants, purchasable.active);
      return purchasable;
    },
    buildState: mapState,
    buildSignals: (_def, purchasable) => ({
      unlock: purchasable.active,
      count: computed(() => purchasable.amount.value),
    }),
  });

  const list = (): readonly Purchasable[] => base.getAll().map((e) => e.instance);

  const purchasedCount = computed(() => list().filter((p) => p.active.value).length);

  const totalAmount = computed(
    (): DecimalSource =>
      list().reduce<DecimalSource>(
        (sum, p) => renormIfLayer0(Decimal.add(sum, p.amount.value)),
        Decimal.dZero,
      ),
  );

  const totalEffect = computed(
    (): DecimalSource =>
      list().reduce<DecimalSource>(
        (product, p) => renormIfLayer0(Decimal.mul(product, p.effect.value)),
        Decimal.dOne,
      ),
  );

  const allMaxed = computed(() => {
    const l = list();
    return l.length > 0 && l.every((p) => p.maxed.value);
  });

  const category: PurchasableCategory<Def, State> = {
    id: base.id,
    registry: base.registry,
    register: base.register,
    getDef: base.getDef,

    getPurchasable(id: string): Purchasable | undefined {
      return base.getEntry(id)?.instance;
    },

    getState(id: string): State | undefined {
      return base.getEntry(id)?.state;
    },

    getEntry(id: string): PurchasableCategoryEntry<Def, State> | undefined {
      const entry = base.getEntry(id);
      if (!entry) return undefined;
      return {
        def: entry.def,
        purchasable: entry.instance,
        state: entry.state,
        signals: entry.signals!,
      };
    },

    getAll(): PurchasableCategoryEntry<Def, State>[] {
      return base.getAll().map((e) => ({
        def: e.def,
        purchasable: e.instance,
        state: e.state,
        signals: e.signals!,
      }));
    },

    purchasedCount,
    totalAmount,
    totalEffect,
    allMaxed,

    getAffordable(): Purchasable[] {
      return list().filter((p) => p.canPurchase.value);
    },

    purchaseAffordable(): DecimalSource {
      let total: DecimalSource = Decimal.dZero;
      for (const p of list()) {
        if (p.canPurchase.value) {
          total = Decimal.add(total, p.purchaseMax());
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
