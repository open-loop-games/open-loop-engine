/**
 * Purchasable effect helpers — reusable amount→effect functions
 *
 * Pure functions that return effect closures suitable for
 * `PurchasableOptions.effect`. These are independent of the factory and live
 * separately so the factory file stays focused on construction.
 *
 * Aggregation utilities ({@link getPurchasableEffect}, {@link getPurchasableSum})
 * operate over arrays of purchasables and live here for the same reason.
 * {@link purchasableModifierBinding} extracts a single purchasable into a
 * modifier-binding shape (constructor-as-data, not an aggregator).
 *
 * @cluster purchasable
 */

import { computed, type ComputedRef } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import type { Purchasable } from './purchasable';

// === EFFECT BUILDERS ===

/**
 * Create an effect function where each level multiplies: `factor ^ amount`.
 *
 * @param factor - Multiplier per level (e.g., `2` for doubling each level)
 * @returns Effect function suitable for `PurchasableOptions.effect`
 *
 * @example
 * ```ts
 * createPurchasable({
 *   effect: multiplicativeEffect(2),  // level 3 → 2^3 = ×8
 *   ...
 * });
 * ```
 */
export function multiplicativeEffect(
  factor: DecimalSource,
): (amount: DecimalSource) => DecimalSource {
  return (amount: DecimalSource): DecimalSource => {
    return Decimal.pow(factor, amount);
  };
}

/**
 * Create an effect function where each level adds a flat amount: `base + perLevel * amount`.
 *
 * @param perLevel - Amount added per level
 * @param base - Starting value at level 0. Default: `0`
 * @returns Effect function suitable for `PurchasableOptions.effect`
 *
 * @example
 * ```ts
 * createPurchasable({
 *   effect: additiveEffect(5, 1),  // level 3 → 1 + 5*3 = 16
 *   ...
 * });
 * ```
 */
export function additiveEffect(
  perLevel: DecimalSource,
  base: DecimalSource = 0,
): (amount: DecimalSource) => DecimalSource {
  return (amount: DecimalSource): DecimalSource => {
    return Decimal.add(base, Decimal.mul(perLevel, amount));
  };
}

/**
 * Create an effect function with polynomial scaling: `base + scale * amount ^ power`.
 *
 * @param power - Exponent applied to amount
 * @param scale - Coefficient multiplied by the powered amount. Default: `1`
 * @param base - Constant offset. Default: `0`
 * @returns Effect function suitable for `PurchasableOptions.effect`
 *
 * @example
 * ```ts
 * createPurchasable({
 *   effect: polynomialEffect(2, 0.5),  // level 4 → 0.5 * 4^2 = 8
 *   ...
 * });
 * ```
 */
export function polynomialEffect(
  power: DecimalSource,
  scale: DecimalSource = 1,
  base: DecimalSource = 0,
): (amount: DecimalSource) => DecimalSource {
  return (amount: DecimalSource): DecimalSource => {
    return Decimal.add(base, Decimal.pow(amount, power).mul(scale));
  };
}

/**
 * Create an effect function with diminishing returns that asymptotically approaches a cap.
 *
 * Formula: `cap * (1 - (1 - rate) ^ amount)`. At level 0 the effect is 0;
 * as levels increase it approaches `cap` but never reaches it.
 *
 * @param cap - Maximum possible effect value
 * @param rate - How quickly the effect approaches the cap per level. Default: `0.1`
 * @returns Effect function suitable for `PurchasableOptions.effect`
 *
 * @example
 * ```ts
 * createPurchasable({
 *   effect: diminishingEffect(100, 0.05),  // approaches 100 as levels grow
 *   ...
 * });
 * ```
 */
export function diminishingEffect(
  cap: DecimalSource,
  rate: DecimalSource = 0.1,
): (amount: DecimalSource) => DecimalSource {
  return (amount: DecimalSource): DecimalSource => {
    const progress = Decimal.sub(1, Decimal.pow(Decimal.sub(1, rate), amount));
    return Decimal.mul(cap, progress);
  };
}

// === AGGREGATION UTILITIES ===

/**
 * Compute the multiplicative product of all purchasables' effects.
 *
 * @param purchasables - Purchasables to aggregate
 * @param base - Starting value. Default: `1`
 * @returns Reactive computed: `base * effect1 * effect2 * ...`
 *
 * @example
 * ```ts
 * const damageMultiplier = getPurchasableEffect(damageUpgrades.purchasables);
 * // Bind into a chain or read directly:
 * console.log(damageMultiplier.value.toString());
 * ```
 */
export function getPurchasableEffect(
  purchasables: Purchasable[],
  base: DecimalSource = 1,
): ComputedRef<DecimalSource> {
  return computed(() => {
    let total = new Decimal(base);
    for (const p of purchasables) {
      total = total.mul(p.effect.value);
    }
    return total;
  });
}

/**
 * Compute the additive sum of all purchasables' effects.
 *
 * @param purchasables - Purchasables to aggregate
 * @param base - Starting value. Default: `0`
 * @returns Reactive computed: `base + effect1 + effect2 + ...`
 *
 * @example
 * ```ts
 * const flatBonus = getPurchasableSum(perks.purchasables);
 * // 0 + perk1.effect + perk2.effect + ...
 * ```
 */
export function getPurchasableSum(
  purchasables: Purchasable[],
  base: DecimalSource = 0,
): ComputedRef<DecimalSource> {
  return computed(() => {
    let total = new Decimal(base);
    for (const p of purchasables) {
      total = total.add(p.effect.value);
    }
    return total;
  });
}

/**
 * Build a `{ multiplier, enabled }` binding from a purchasable, shaped for
 * direct hand-off to a modifier chain.
 *
 * Verb-less name fits the constructor-as-data convention (see
 * `src/systems/CLAUDE.md` § Naming verbs): the return value is a data shape
 * consumed declaratively, not an action performed.
 *
 * @param purchasable - The purchasable to bind
 * @param effectOverride - Override: use this value instead of the purchasable's own effect.
 *   For leveled purchasables, pass a per-level base to get `base^amount`.
 * @returns `{ multiplier, enabled }` — both reactive computeds
 *
 * @example
 * ```ts
 * damageChain.add(
 *   createMultiplicativeModifier({
 *     ...purchasableModifierBinding(damageUpgrade),
 *     description: 'Damage upgrade',
 *   }),
 * );
 * // Or with a per-level base for leveled purchasables (×1.05^level):
 * speedChain.add(
 *   createMultiplicativeModifier({
 *     ...purchasableModifierBinding(speedUpgrade, 1.05),
 *     description: 'Speed upgrade',
 *   }),
 * );
 * ```
 */
export function purchasableModifierBinding(
  purchasable: Purchasable,
  effectOverride?: DecimalSource,
): { multiplier: ComputedRef<DecimalSource>; enabled: ComputedRef<boolean> } {
  return {
    multiplier: computed(() => {
      if (effectOverride !== undefined) {
        return Decimal.pow(effectOverride, purchasable.amount.value);
      }
      return purchasable.effect.value;
    }),
    enabled: computed(() => purchasable.active.value),
  };
}
