/**
 * Content walker — emit one {@link ModifierPickerEntry} per
 * `ModifierBinding` on every effect-system def registered in
 * {@link EffectSystemRegistryKey}.
 *
 * @internal
 */

import type { Engine } from '@/engine';
import type { ModifierBinding } from '@/systems/modifier-binding';
import { EffectSystemRegistryKey } from '@/core/registries';
import { forEachEffectDef } from '../walk';
import type { ModifierPickerEntry } from './types';

/**
 * Walk every effect system (temporary + persistent) auto-registered into
 * the engine's {@link EffectSystemRegistryKey} and emit one
 * {@link ModifierPickerEntry} per `ModifierBinding` on each def.
 *
 * Every declared binding is emitted, whether or not its effect is active.
 * Factory-form `modifiers` lists and modifier factories are called once at
 * walk time, as the effect systems do on activation, so a factory's entry
 * carries a fresh object that isn't the one living in the chain. That
 * only affects `modifier` identity and `indexInChain`: perturbation
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
    // carry `ModifierBinding[] | (() => ModifierBinding[])` per
    // src/systems/{temporary,persistent}-effect.ts.
    const raw = (
      def as {
        modifiers?: ModifierBinding[] | (() => ModifierBinding[]);
      }
    ).modifiers;
    if (!raw) return;
    const bindings: readonly ModifierBinding[] = typeof raw === 'function' ? raw() : raw;

    bindings.forEach((binding, bindingIndex) => {
      const modifier =
        typeof binding.modifier === 'function' ? binding.modifier() : binding.modifier;
      entries.push({
        kind: 'modifier',
        modifier,
        chain: binding.chain,
        indexInChain: binding.chain.modifiers.indexOf(modifier),
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
