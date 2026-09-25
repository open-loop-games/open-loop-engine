/**
 * Content walker — emit one {@link ModifierPickerEntry} per grant binding
 * on every effect-system def registered in {@link EffectSystemRegistryKey}.
 *
 * @internal
 */

import type { Engine } from '@/engine';
import type { Grant } from '@/core/modifier';
import { buildGrantModifier, flattenGrants } from '@/systems/modifier-binding';
import { EffectSystemRegistryKey } from '@/core/registries';
import { forEachEffectDef } from '../walk';
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
export function walkContent(engine: Engine): ModifierPickerEntry[] {
  const registry = engine.tryInject(EffectSystemRegistryKey);
  if (!registry) return [];

  const entries: ModifierPickerEntry[] = [];

  forEachEffectDef(registry, ({ systemId, def }) => {
    // Narrow: EffectDefLike carries `modifiers?: readonly unknown[] | (() => readonly unknown[])`
    // but the real defs (TemporaryEffectDef / PersistentEffectDef) both
    // carry `Grant[] | (() => Grant[])`.
    const raw = (def as { modifiers?: Grant[] | (() => Grant[]) }).modifiers;
    if (!raw) return;
    const grants: readonly Grant[] = typeof raw === 'function' ? raw() : raw;

    flattenGrants(grants).forEach(({ grant, chain }, bindingIndex) => {
      const modifier = buildGrantModifier(grant);
      entries.push({
        kind: 'modifier',
        modifier,
        chain,
        indexInChain: chain.modifiers.indexOf(modifier),
        address: {
          source: 'content',
          contentType: systemId,
          contentId: def.id,
          bindingIndex,
        },
        label: `${systemId}.${def.id}[${bindingIndex}]`,
      });
    });
  });

  return entries;
}
