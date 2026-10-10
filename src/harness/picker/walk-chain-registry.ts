/**
 * Chain-registry walker — emit one {@link ModifierPickerEntry} per existing
 * modifier in every auto-registered {@link ModifierChain}, plus one
 * `chain-apply` entry per chain (perturbation target that lives on the
 * chain itself rather than any individual modifier).
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
 * {@link ChainRegistryKey} and emit:
 * - one `chain-apply` entry per chain (targets the chain as a whole —
 *   perturbation appends a scalar wrapper, so empty-at-walk-time chains
 *   remain perturbable once they populate via purchases/binds).
 * - one `modifier-index` entry per existing modifier in each chain, except
 *   those an effect binding put there — the effect-system binding walker offers those,
 *   and a chain-side swap would outlive the effect.
 *
 * Missing registry (e.g. an engine constructed outside the standard
 * `createEngine` flow) degrades to an empty array — not a crash.
 *
 * The `chain-apply` entry carries a fresh identity-passthrough marker as
 * its `modifier` field. Identity is snapshot-scoped and never collides
 * with real modifiers reached by other walkers, so dedup behaves.
 *
 * @internal
 */
export function walkChainRegistry(engine: Engine): ModifierPickerEntry[] {
  const registry = engine.tryInject(ChainRegistryKey);
  if (!registry) return [];

  const entries: ModifierPickerEntry[] = [];

  forEachChainRegistryEntry(registry, ({ chain, modifier, indexInChain }) => {
    if (modifier === undefined) {
      const marker: Modifier = { apply: (gain: DecimalSource) => gain };
      entries.push({
        kind: 'modifier',
        modifier: marker,
        chain,
        indexInChain: -1,
        address: {
          walker: 'chain-registry',
          chainId: chain.id,
          variant: 'chain-apply',
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
        variant: 'modifier-index',
        modifierIndex,
      },
      label: `${chain.id}[${modifierIndex}]`,
    });
  });

  return entries;
}
