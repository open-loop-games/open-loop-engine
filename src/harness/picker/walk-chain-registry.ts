/**
 * Chain-registry walker — return one {@link ModifierPickerEntry} per existing
 * modifier in every auto-registered {@link ModifierChain}, plus one
 * `chain-apply` entry per chain: a perturbation target that is the chain
 * itself rather than any one modifier.
 *
 * @internal
 */

import type { DecimalSource } from '@/primitives/decimal';
import type { Engine } from '@/engine';
import type { Modifier } from '@/core/modifier';
import { ChainRegistryKey } from '@/core/registries';
import { isSlotBound } from '@/systems/binding-slots';
import { forEachChainRegistryEntry } from '../walk';
import type { ModifierPickerEntry } from './types';

/**
 * Walk every {@link ModifierChain} auto-registered into the engine's
 * {@link ChainRegistryKey} and return:
 * - one `chain-apply` entry per chain. It targets the chain as a whole, and
 *   perturbation appends a scalar wrapper. So a chain empty at walk time
 *   stays perturbable once purchases or binds fill it.
 * - one `modifier-index` entry per existing modifier in each chain, except
 *   those an effect system placed there as lowered grants. The
 *   effect-system walker offers those, and a chain-side replacement would outlast the effect.
 *
 * A missing registry (e.g. an engine built outside the standard
 * `createEngine` flow) gives an empty array, not a crash.
 *
 * The `chain-apply` entry holds a fresh identity-passthrough marker as its
 * `modifier` field. Identity is snapshot-scoped and never collides with
 * real modifiers that other walkers reach, so deduplication stays correct.
 *
 * @internal
 */
export function walkChainRegistry(engine: Engine): ModifierPickerEntry[] {
  const registry = engine.tryInject(ChainRegistryKey);
  if (!registry) return [];

  const entries: ModifierPickerEntry[] = [];

  forEachChainRegistryEntry(registry, ({ chain, modifier, indexInChain }) => {
    if (modifier === undefined) {
      const marker: Modifier = { apply: (value: DecimalSource) => value };
      entries.push({
        kind: 'modifier',
        modifier: marker,
        chain,
        indexInChain: -1,
        address: {
          walker: 'chain-registry',
          chainId: chain.id,
          kind: 'chain-apply',
        },
        label: `${chain.id}[*]`,
      });
      return;
    }

    if (isSlotBound(modifier)) return;
    const modifierIndex = indexInChain as number;
    entries.push({
      kind: 'modifier',
      modifier,
      chain,
      indexInChain: modifierIndex,
      address: {
        walker: 'chain-registry',
        chainId: chain.id,
        kind: 'modifier-index',
        modifierIndex,
      },
      label: `${chain.id}[${modifierIndex}]`,
    });
  });

  return entries;
}
