/**
 * Grant lowering — how effect systems lower {@link Grant}s into chain slots, and grant utilities.
 *
 * Effect systems (`createTemporaryEffectSystem`, `createConditionalEffectSystem`)
 * take `Grant[]` on their defs' `grants` field — the shape category
 * `grants` / `restricts` / `rewards` use. A category binds a grant once,
 * in force only while its owner's `active` signal holds. An effect system
 * binds it per activation into a reserved chain slot, so it lowers each
 * grant to one factory per chain. {@link replacementGrants} builds a common grant pair.
 *
 * @cluster effects
 */

import { unref, type ComputedRef } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { toMaybeRef, type Computable } from '@/core/computed';
import {
  createAdditiveModifier,
  createExponentialModifier,
  createMultiplicativeModifier,
  delegateModifier,
  type Grant,
  type Modifier,
  type ModifierChain,
  type ModifierDescription,
} from '@/core/modifier';
import type { PredicateResolver } from './gate';

// === TYPES ===

/**
 * One chain position an effect-system def's grants lower to. Its index in the
 * lowered list picks its slot and is its perturbation `grantIndex`.
 *
 * @internal
 */
export interface LoweredGrant {
  chain: ModifierChain;
  /** The modifier one activation binds — a fresh one per call for the shorthands. */
  modifier: () => Modifier;
}

/** Options for {@link replacementGrants} */
export interface ReplacementGrantsOptions {
  /** Chain the cancel + replacement modifiers are added to */
  chain: ModifierChain;
  /**
   * Current value being cancelled. `replacementGrants` applies
   * `×(1/cancel())`, so the rest of the chain sees the target's multiplier
   * cancelled.
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
 * Build a cancel-then-replace grant pair for a modifier chain.
 *
 * The cancel-then-replace pattern ("while active, replace the existing `×1.1^n`
 * multiplier from `speed` purchases with `×(1.05+0.005·b)^n`") expands to two
 * correlated chain entries. A cancel multiplier `× 1/cancel()` cancels the
 * existing value, and a replacement multiplier `× replacement()` supplies the
 * new one. Both must follow the same predicate — typically one
 * {@link createConditionalEffectSystem} def's `active`.
 *
 * Chain-level introspection still works: both entries stay distinct modifiers
 * in the chain (descriptions suffixed `"(cancel)"` / `"(replacement)"`). So
 * balance workbenches and modifier-breakdown UIs keep full attribution.
 *
 * Uses a value-based target — callers pass the current cancelled value as a
 * getter, not an id pointer to an existing modifier. This fits intrinsic
 * targets, such as a `1.1^n` built into the production formula. Such a target
 * has no chain entry to point at. It also fits targets that are chain entries.
 *
 * @param options - Cancel/replacement value sources + target chain + description
 * @returns Two grants (cancel + replacement) suitable for
 *   `ConditionalEffectDef.grants` / `TemporaryEffectDef.grants`.
 *
 * @example
 * ```ts
 * effects.register({
 *   id: 'challenge:geared-down:speed-rewire',
 *   active: () => gearedDown.entered.value && Decimal.gt(speed.count.value, 0),
 *   grants: replacementGrants({
 *     chain: productionChain,
 *     cancel: () => Decimal.pow(1.1, speed.count.value),
 *     replacement: () =>
 *       Decimal.pow(
 *         Decimal.add(1.05, Decimal.mul(boosters.value, 0.005)),
 *         speed.count.value,
 *       ),
 *     description: 'Geared Down speed rewire',
 *   }),
 * });
 * ```
 */
export function replacementGrants(options: ReplacementGrantsOptions): Grant[] {
  const { chain, cancel, replacement, description } = options;
  const cancelSrc = toMaybeRef(cancel);
  const replacementSrc = toMaybeRef(replacement);

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
  // Add an inline description to a modifier that has none — keeps
  // `chain.bind` auto-id derivation working for the escape-hatch variant,
  // without forcing consumers to wrap the modifier themselves.
  if (grant.description != null && resolved.description == null) {
    const text = grant.description;
    return delegateModifier(resolved, {
      description: (): ModifierDescription => ({ text, formattedValue: '' }),
    });
  }
  return resolved;
}

/**
 * Each grant paired with each chain it targets, in order: a chain array
 * contributes one entry per chain. The position is a lowered grant's index.
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
 * @param owner - names the def in a `when` Gate's error, which then
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
 * Lower an effect-system def's grants to one modifier factory per chain,
 * with each grant's `when` adopted through `predicates` and ANDed into the
 * modifier's `enabled`.
 *
 * @param owner - names the def in a `when` Gate's error
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
        return when == null ? modifier : delegateModifier(modifier, { when });
      },
    };
  });
}
