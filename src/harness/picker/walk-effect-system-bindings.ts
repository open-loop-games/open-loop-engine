/**
 * Effect-system grant walker — return one {@link ModifierPickerEntry} per
 * lowered grant on every effect-system def registered in
 * {@link EffectSystemRegistryKey}.
 *
 * @internal
 */

import type { Engine } from '@/engine';
import { buildGrantModifier } from '@/systems/replacement-grants';
import { EffectSystemRegistryKey } from '@/core/registries';
import { effectDefBindings, forEachEffectDef } from '../walk';
import type { ModifierPickerEntry } from './types';

/**
 * Walk every effect system (temporary and conditional) auto-registered into
 * the engine's {@link EffectSystemRegistryKey}. Return one
 * {@link ModifierPickerEntry} per lowered grant on each def: one per chain a grant
 * targets, so a chain array gives one entry per chain.
 *
 * The walker returns every declared lowered grant, whether or not its effect is
 * active. It builds factory-form `grants` lists, modifier factories and the
 * shorthands once at walk time, as the effect systems do on activation. So
 * such an entry holds a fresh object, not the one in the chain. That only
 * affects `modifier` identity and `indexInChain`. Perturbation addresses the
 * lowered grant by system, def and index, and wraps whatever each activation binds.
 *
 * A missing registry (e.g. an engine built outside the standard
 * `createEngine` flow) gives an empty array, not a crash.
 *
 * @internal
 */
export function walkEffectSystemBindings(engine: Engine): ModifierPickerEntry[] {
  const registry = engine.tryInject(EffectSystemRegistryKey);
  if (!registry) return [];

  const entries: ModifierPickerEntry[] = [];

  forEachEffectDef(registry, ({ systemId, def }) => {
    effectDefBindings(def).forEach(({ grant, chain }, grantIndex) => {
      const modifier = buildGrantModifier(grant);
      entries.push({
        kind: 'modifier',
        modifier,
        chain,
        indexInChain: chain.modifiers.indexOf(modifier),
        address: {
          walker: 'effect-system',
          effectSystemId: systemId,
          defId: def.id,
          grantIndex,
        },
        label: `${systemId}.${def.id}[${grantIndex}]`,
      });
    });
  });

  return entries;
}
