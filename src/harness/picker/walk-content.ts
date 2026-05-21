/**
 * Content walker — emit one {@link ModifierPickerEntry} per
 * `ModifierBinding` on every effect-system def registered in
 * {@link EffectSystemRegistryKey}.
 *
 * @internal
 */

import type { Engine, ModifierBinding } from '@/index';
import { EffectSystemRegistryKey } from '@/index';
import { forEachEffectDef } from '../walk';
import type { ModifierPickerEntry } from './types';

/**
 * Walk every effect system (temporary + persistent) auto-registered into
 * the engine's {@link EffectSystemRegistryKey} and emit one
 * {@link ModifierPickerEntry} per `ModifierBinding` on each def.
 *
 * Bindings whose `modifiers` field is a factory function are called once
 * at walk time — this is the same semantics the effect systems use
 * internally when they apply bindings. A factory that allocates fresh
 * `Modifier` objects on every call will produce new objects here too,
 * which is fine for a snapshot but means the picker entry's object
 * identity won't match the instance that actually lives in the chain.
 * Consumers needing perturbation against the live instance should prefer
 * the chain-registry walker for those cases.
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
