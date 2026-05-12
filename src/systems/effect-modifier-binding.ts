/**
 * Effect-modifier binding contract + helpers.
 *
 * The `EffectModifierBinding` interface is the contract both effect systems
 * (`createTemporaryEffectSystem`, `createPersistentEffectSystem`) accept on
 * their `modifiers` field. This module also hosts factories that produce
 * values of that contract for common patterns.
 *
 * @cluster effects
 */

import { unref } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { processGetter, type Computable } from '@/core/computed';
import { createMultiplicativeModifier, type Modifier, type ModifierChain } from '@/core/modifier';

// === TYPES ===

/** Binds a modifier to a `ModifierChain` while the effect is active. */
export interface EffectModifierBinding {
  /** Which modifier chain to target */
  chain: ModifierChain;
  /**
   * The modifier to add, or a factory that creates one.
   * A factory is **required** when `maxStacks > 1` (each stack needs its own modifier instance).
   */
  modifier: Modifier | (() => Modifier);
}

/** Options for {@link replacementBinding} */
export interface ReplacementBindingOptions {
  /** Chain the cancel + replacement modifiers land on */
  chain: ModifierChain;
  /**
   * Current value being cancelled. The helper applies `×(1/cancel())` so the
   * downstream chain sees the target's effect nullified.
   */
  cancel: Computable<DecimalSource>;
  /** New value to apply in place of the cancelled one — applied as `×replacement()`. */
  replacement: Computable<DecimalSource>;
  /**
   * Base description for UI attribution. Auto-suffixed to `"… (cancel)"` and
   * `"… (replacement)"` on the two chain entries.
   */
  description: string;
}

// === FACTORIES ===

/**
 * Build a cancel-then-replace binding pair for a modifier chain.
 *
 * The cancel-then-replace pattern ("while active, replace the existing `×1.1^n`
 * tickspeed multiplier with `×(1.05+0.005·g)^n`") expands to two correlated
 * chain entries: a cancel multiplier `× 1/cancel()` that nullifies the existing
 * value, and a replacement multiplier `× replacement()` that supplies the new
 * one. Both must be gated on the same predicate — typically via a
 * {@link createPersistentEffectSystem} binding.
 *
 * Chain-level introspection is preserved: both entries remain distinct modifiers
 * in the chain (descriptions suffixed `"(cancel)"` / `"(replacement)"`) so
 * BalanceWorkbench and modifier-breakdown UIs keep full source attribution.
 *
 * Uses a value-based target — callers pass the current cancelled value as a
 * getter, not an id pointer to an existing modifier. This fits intrinsic
 * targets (like AD's `1.1^n` baked into the production formula, which has no
 * corresponding chain entry to point at) as well as targets that are themselves
 * chain entries.
 *
 * @param options - Cancel/replacement value sources + target chain + description
 * @returns Two {@link EffectModifierBinding} entries (cancel + replacement)
 *   suitable for `PersistentEffectDef.modifiers` / `TemporaryEffectDef.modifiers`.
 *
 * @example
 * ```ts
 * effects.register({
 *   id: 'challenge:ic3:tickspeed-rewire',
 *   active: () => ic3.active.value && Decimal.gt(tickspeed.amount.value, 0),
 *   modifiers: replacementBinding({
 *     chain: productionChain,
 *     cancel: () => Decimal.pow(1.1, tickspeed.amount.value),
 *     replacement: () =>
 *       Decimal.pow(
 *         Decimal.add(1.05, Decimal.mul(galaxies.value, 0.005)),
 *         tickspeed.amount.value,
 *       ),
 *     description: 'IC3 Tickspeed Rewire',
 *   }),
 * });
 * ```
 */
export function replacementBinding(options: ReplacementBindingOptions): EffectModifierBinding[] {
  const { chain, cancel, replacement, description } = options;
  const cancelSrc = processGetter(cancel);
  const replacementSrc = processGetter(replacement);

  return [
    {
      chain,
      modifier: () =>
        createMultiplicativeModifier({
          multiplier: () => Decimal.recip(unref(cancelSrc)),
          description: `${description} (cancel)`,
        }),
    },
    {
      chain,
      modifier: () =>
        createMultiplicativeModifier({
          multiplier: () => unref(replacementSrc),
          description: `${description} (replacement)`,
        }),
    },
  ];
}
