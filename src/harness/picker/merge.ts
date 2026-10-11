/**
 * Picker merge — run the discovery walkers and deduplicate modifier output
 * by `Modifier` object identity. The `createPickerSnapshot` factory is the
 * picker's one public function.
 */

import type { Engine } from '@/engine';
import type { ModifierPickerEntry, PickerEntry, PickerSnapshot, TunablePickerEntry } from './types';
import { walkChainRegistry } from './walk-chain-registry';
import { walkEffectSystemGrants } from './walk-effect-system-grants';
import { walkTunables } from './walk-tunables';

/**
 * Priority order for deduplication of modifier entries. When several walkers
 * reach the same `Modifier` instance, the entry from the higher-priority
 * walker wins. `effect-system` is the most specific and the most intuitive;
 * `chain-registry` is the derived auto-registration path. Tunable entries
 * don't compete on modifier identity and skip this deduplication.
 */
const MODIFIER_SOURCE_PRIORITY: Record<'effect-system' | 'chain-registry', number> = {
  'effect-system': 2,
  'chain-registry': 1,
};

/**
 * Build one {@link PickerSnapshot}: run all discovery walkers, deduplicate
 * modifier entries by `Modifier` object identity, and group the result by
 * walker.
 *
 * Modifier deduplication: a `Map<Modifier, ModifierPickerEntry>` collects one
 * canonical entry per modifier. Walkers run in effect-system → chain-registry
 * order; priority breaks ties (see {@link MODIFIER_SOURCE_PRIORITY}). The map
 * keys on object identity, so it is snapshot-scoped. A later
 * `createPickerSnapshot` call rebuilds the map from scratch, and a modifier
 * replaced in place misses the old identity.
 *
 * Tunable entries go directly into the `tunables` group, keyed by
 * `(registryId, key)` when they are built. They never collide with modifier
 * entries: perturbation dispatches by `entry.kind`, so the two kinds stay
 * independent.
 *
 * @param engine - The engine to enumerate. Walkers read auto-registered
 *   entries from `ChainRegistryKey`, `EffectSystemRegistryKey`, and
 *   `TuningRegistriesKey` via `engine.tryInject` — engines without those
 *   keys produce empty groups rather than crashing.
 * @returns {@link PickerSnapshot} with entries grouped by walker
 *   (`effectSystem`, `chains`, `tunables`) plus a flat `all` list.
 *
 * @example
 * ```ts
 * const snapshot = createPickerSnapshot(engine);
 * for (const entry of snapshot.all) {
 *   if (entry.kind === 'modifier') {
 *     render(entry.label, entry.chain.id);
 *   } else {
 *     render(entry.label, entry.registryId);
 *   }
 * }
 * ```
 */
export function createPickerSnapshot(engine: Engine): PickerSnapshot {
  const effectSystemEntries = walkEffectSystemGrants(engine);
  const chainEntries = walkChainRegistry(engine);
  const tunableEntries: TunablePickerEntry[] = walkTunables(engine);

  const canonical = new Map<object, ModifierPickerEntry>();

  function offer(entry: ModifierPickerEntry): void {
    const existing = canonical.get(entry.modifier);
    if (!existing) {
      canonical.set(entry.modifier, entry);
      return;
    }
    if (
      MODIFIER_SOURCE_PRIORITY[entry.address.walker] >
      MODIFIER_SOURCE_PRIORITY[existing.address.walker]
    ) {
      canonical.set(entry.modifier, entry);
    }
  }

  // Offer in priority order so the first write already matches the tie-breaker.
  for (const e of effectSystemEntries) offer(e);
  for (const e of chainEntries) offer(e);

  const all: PickerEntry[] = [];
  const effectSystem: ModifierPickerEntry[] = [];
  const chains: ModifierPickerEntry[] = [];

  for (const entry of canonical.values()) {
    all.push(entry);
    if (entry.address.walker === 'effect-system') effectSystem.push(entry);
    else chains.push(entry);
  }

  for (const entry of tunableEntries) all.push(entry);

  return { all, effectSystem, chains, tunables: tunableEntries };
}
