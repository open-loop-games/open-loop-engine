/**
 * Effect-system binding walker — emit one {@link ModifierPickerEntry} per grant binding
 * on every effect-system def registered in {@link EffectSystemRegistryKey}.
 *
 * @internal
 */

import type { Engine } from '@/engine';
import { buildGrantModifier } from '@/systems/replacement-grants';
import { EffectSystemRegistryKey } from '@/core/registries';
import { effectDefBindings, forEachEffectDef } from '../walk';
import type { ModifierPickerEntry } from './types';

/**
 * Walk every effect system (temporary + persistent) auto-registered into
 * the engine's {@link EffectSystemRegistryKey} and emit one
 * {@link ModifierPickerEntry} per binding on each def — one per chain a
 * grant targets, so a chain array contributes one entry per chain.
 *
 * Every declared binding is emitted, whether or not its effect is active.
 * Factory-form `modifiers` lists, modifier factories and the shorthands are
 * built once at walk time, as the effect systems do on activation, so such
 * an entry carries a fresh object that isn't the one living in the chain.
 * That only affects `modifier` identity and `indexInChain`: perturbation
 * addresses the binding by system, def and index, and wraps whatever each
 * activation binds.
 *
 * Missing registry (e.g. an engine constructed outside the standard
 * `createEngine` flow) degrades to an empty array — not a crash.
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
