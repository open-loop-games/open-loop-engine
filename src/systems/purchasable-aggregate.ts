/**
 * Purchasable aggregate accessors — shared between Group and Category.
 *
 * Both `createPurchasableGroup` (fixed list) and `createPurchasableCategory`
 * (registry-driven list) expose the same six aggregate accessors over a
 * collection of {@link Purchasable}s. This helper is the single source of
 * those bodies; each factory supplies its own list-getter and the helper
 * returns the slot bundle they wire into their result.
 *
 * @internal Not exported from the systems barrel.
 */

import { computed, type ComputedRef } from 'vue';
import { Decimal, type DecimalSource, renormIfLayer0 } from '@/primitives/decimal';
import type { Purchasable } from './purchasable';

export interface PurchasableAggregates {
  purchasedCount: ComputedRef<number>;
  totalAmount: ComputedRef<DecimalSource>;
  totalEffect: ComputedRef<DecimalSource>;
  allMaxed: ComputedRef<boolean>;
  getAffordable: () => Purchasable[];
  purchaseAffordable: () => DecimalSource;
}

/**
 * Get the shared aggregate accessors over a list of purchasables.
 *
 * `getList` is invoked inside each `computed`, so reactive reads inside it
 * (registry-driven lists, etc.) flow through to the resulting computeds.
 *
 * @internal
 */
export function getPurchasableAggregates(
  getList: () => readonly Purchasable[],
): PurchasableAggregates {
  const purchasedCount = computed(() => {
    return getList().filter((p) => p.active.value).length;
  });

  const totalAmount = computed(() => {
    return getList().reduce<DecimalSource>(
      (sum, p) => renormIfLayer0(Decimal.add(sum, p.amount.value)),
      Decimal.dZero,
    );
  });

  const totalEffect = computed(() => {
    return getList().reduce<DecimalSource>(
      (product, p) => renormIfLayer0(Decimal.mul(product, p.effect.value)),
      Decimal.dOne,
    );
  });

  const allMaxed = computed(() => {
    const list = getList();
    return list.length > 0 && list.every((p) => p.maxed.value);
  });

  return {
    purchasedCount,
    totalAmount,
    totalEffect,
    allMaxed,
    getAffordable(): Purchasable[] {
      return getList().filter((p) => p.canPurchase.value);
    },
    purchaseAffordable(): DecimalSource {
      let total: DecimalSource = Decimal.dZero;
      for (const p of getList()) {
        if (p.canPurchase.value) {
          total = Decimal.add(total, p.purchaseMax());
        }
      }
      return total;
    },
  };
}
