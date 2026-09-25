/**
 * Modifier binding — how effect systems bind {@link Grant}s, and grant helpers.
 *
 * Effect systems (`createTemporaryEffectSystem`, `createPersistentEffectSystem`)
 * take `Grant[]` on their `modifiers` field — the vocabulary category
 * `grants` / `restricts` / `rewards` use. Categories bind a grant once, gated
 * on the owning item; effect systems bind it per activation into a reserved
 * chain slot, so they lower each grant to one factory per chain.
 * {@link replacementBinding} builds a common grant pair.
 *
 * @cluster effects
 */

import { unref, type ComputedRef } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { processGetter, type Computable } from '@/core/computed';
import {
  createAdditiveModifier,
  createExponentialModifier,
  createMultiplicativeModifier,
  gateModifier,
  type Grant,
  type Modifier,
  type ModifierChain,
  type ModifierDescription,
} from '@/core/modifier';
import type { PredicateResolver } from './gate';

// === TYPES ===

/**
 * One chain position an effect definition's grants lower to. Its index in the
 * lowered list is the binding's slot and its perturbation `bindingIndex`.
 *
 * @internal
 */
export interface LoweredGrant {
  chain: ModifierChain;
  /** The modifier one activation binds — a fresh one per call for the shorthands. */
  modifier: () => Modifier;
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
 * @returns Two grants (cancel + replacement) suitable for
 *   `PersistentEffectDef.modifiers` / `TemporaryEffectDef.modifiers`.
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
export function replacementBinding(options: ReplacementBindingOptions): Grant[] {
  const { chain, cancel, replacement, description } = options;
  const cancelSrc = processGetter(cancel);
  const replacementSrc = processGetter(replacement);

  return [
    {
      chain,
      mult: () => Decimal.recip(unref(cancelSrc)),
      description: `${description} (cancel)`,
    },
    {
      chain,
      mult: () => unref(replacementSrc),
      description: `${description} (replacement)`,
    },
  ];
}

// === GRANT LOWERING ===

/**
 * Build the Modifier a {@link Grant} describes: a fresh one for the
 * `mult` / `add` / `exp` shorthands, the resolved hand-built one otherwise.
 *
 * @internal
 */
export function buildGrantModifier(grant: Grant): Modifier {
  if ('mult' in grant) {
    return createMultiplicativeModifier({ multiplier: grant.mult, description: grant.description });
  }
  if ('add' in grant) {
    return createAdditiveModifier({ addend: grant.add, description: grant.description });
  }
  if ('exp' in grant) {
    return createExponentialModifier({ exponent: grant.exp, description: grant.description });
  }
  const resolved = typeof grant.modifier === 'function' ? grant.modifier() : grant.modifier;
  // Overlay an inline description onto a modifier that doesn't already carry
  // one — keeps `chain.bind` auto-id derivation working for the escape-hatch
  // variant without forcing consumers to wrap the modifier themselves.
  if (grant.description != null && resolved.description == null) {
    const text = grant.description;
    return {
      ...resolved,
      description: (): ModifierDescription => ({ text, formattedValue: '' }),
    };
  }
  return resolved;
}

/**
 * Each grant paired with each chain it targets, in order: a chain array
 * contributes one entry per chain. The position is a binding's index.
 *
 * @internal
 */
export function flattenGrants(grants: readonly Grant[]): { grant: Grant; chain: ModifierChain }[] {
  return grants.flatMap((grant) => grantChains(grant).map((chain) => ({ grant, chain })));
}

/**
 * The chains one grant targets, a single chain as a list of one.
 *
 * @internal
 */
export function grantChains(grant: Grant): readonly ModifierChain[] {
  return Array.isArray(grant.chain) ? grant.chain : [grant.chain];
}

/**
 * Adopt each grant's `when` through `predicates`, keyed by grant. A grant
 * without one has no entry.
 *
 * @param owner - names the definition in a `when` Gate's error, which then
 *   names the grant by its description, else its index
 * @internal
 */
export function adoptGrantWhens(
  grants: readonly Grant[],
  predicates: PredicateResolver,
  owner: string,
): Map<Grant, ComputedRef<boolean>> {
  const whens = new Map<Grant, ComputedRef<boolean>>();
  for (const [index, grant] of grants.entries()) {
    if (grant.when == null) continue;
    const name = grant.description == null ? `${index}` : `'${grant.description}'`;
    whens.set(grant, predicates.adopt(grant.when, true, `${owner} grant ${name} when`).holds);
  }
  return whens;
}

/**
 * Lower an effect definition's grants to one modifier factory per chain,
 * with each grant's `when` adopted through `predicates` and ANDed into the
 * modifier's `enabled`.
 *
 * @param owner - names the definition in a `when` Gate's error
 * @internal
 */
export function lowerGrants(
  grants: readonly Grant[],
  predicates: PredicateResolver,
  owner: string,
): LoweredGrant[] {
  const whenByGrant = adoptGrantWhens(grants, predicates, owner);
  return flattenGrants(grants).map(({ grant, chain }) => {
    const when = whenByGrant.get(grant);
    return {
      chain,
      modifier: () => {
        const modifier = buildGrantModifier(grant);
        return when == null ? modifier : gateModifier(modifier, when);
      },
    };
  });
}
