/**
 * Picker merge — run the discovery walkers and deduplicate modifier output
 * by `Modifier` object identity. The `createPickerSnapshot` factory is the
 * single public entry point for the picker subsystem.
 */

import type { Engine } from '@/engine';
import type { ModifierPickerEntry, PickerEntry, PickerSnapshot, TunablePickerEntry } from './types';
import { walkChainRegistry } from './walk-chain-registry';
import { walkContent } from './walk-content';
import { walkTunables } from './walk-tunables';

/**
 * Priority order for deduplication of modifier entries: when the same
 * `Modifier` instance is reachable via multiple walkers, the entry with
 * the higher-priority source wins. `content` is most specific
 * (user-intuitive), `chain-registry` is the derived auto-registration
 * path. Tunable entries don't compete with modifier identity and skip
 * this dedup.
 */
const MODIFIER_SOURCE_PRIORITY: Record<'content' | 'chain-registry', number> = {
  content: 2,
  'chain-registry': 1,
};

/**
 * Build a single {@link PickerSnapshot} by running all discovery walkers,
 * deduplicating modifier-entry output by `Modifier` object identity, and
 * grouping the result by discovery layer.
 *
 * Modifier dedup: a `Map<Modifier, ModifierPickerEntry>` collects one
 * canonical entry per modifier. Walkers run in content → chain-registry
 * order; ties are broken by priority (see {@link MODIFIER_SOURCE_PRIORITY}).
 * Because the map keys on object identity, this is snapshot-scoped — a
 * later `createPickerSnapshot` call rebuilds the map from scratch and a
 * modifier that's been replaced in-place will naturally miss the old
 * identity.
 *
 * Tunable entries are emitted directly into the `tunables` group, keyed
 * by `(registryName, key)` at construction time. They never collide with
 * modifier entries — perturbation dispatches by `entry.kind` so the two
 * layers stay independent.
 *
 * @param engine - The engine to enumerate. Walkers read auto-registered
 *   content from `ChainRegistryKey`, `EffectSystemRegistryKey`, and
 *   `TuningRegistriesKey` via `engine.tryInject` — engines without those
 *   keys produce empty groups rather than crashing.
 * @returns {@link PickerSnapshot} with entries grouped by discovery layer
 *   (`content`, `chains`, `tunables`) plus a flat `all` list.
 *
 * @example
 * ```ts
 * const snapshot = createPickerSnapshot(engine);
 * for (const entry of snapshot.all) {
 *   if (entry.kind === 'modifier') {
 *     render(entry.label, entry.chain.id);
 *   } else {
 *     render(entry.label, entry.registryName);
 *   }
 * }
 * ```
 */
export function createPickerSnapshot(engine: Engine): PickerSnapshot {
  const contentEntries = walkContent(engine);
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
      MODIFIER_SOURCE_PRIORITY[entry.address.source] >
      MODIFIER_SOURCE_PRIORITY[existing.address.source]
    ) {
      canonical.set(entry.modifier, entry);
    }
  }

  // Offer in priority order so the first write already matches the tie-breaker.
  for (const e of contentEntries) offer(e);
  for (const e of chainEntries) offer(e);

  const all: PickerEntry[] = [];
  const content: ModifierPickerEntry[] = [];
  const chains: ModifierPickerEntry[] = [];

  for (const entry of canonical.values()) {
    all.push(entry);
    if (entry.address.source === 'content') content.push(entry);
    else chains.push(entry);
  }

  for (const entry of tunableEntries) all.push(entry);

  return { all, content, chains, tunables: tunableEntries };
}
