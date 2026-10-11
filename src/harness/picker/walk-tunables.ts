/**
 * Tunables walker — return one {@link TunablePickerEntry} per `tunable()`
 * key registered into a {@link TuningRegistry} auto-registered with the
 * engine's {@link TuningRegistriesKey}.
 *
 * This walker reflects the **designer-flagged tunables**: only values
 * explicitly declared via `tunable()` against a `TuningRegistry` appear
 * here. Implementation constants, derived values and structural modifier
 * identities (which the chain-registry walker already finds) stay out
 * of it. The principle is in `override-registry.ts`, under `tunable()`
 * and `createTuningRegistry()`.
 *
 * Keys that only a scoped override sets (`pushOverrides`) are excluded on
 * purpose: `getBaseKeys()` returns the base map only. See the
 * `OverrideRegistry.getBaseKeys` TSDoc for the rationale.
 *
 * A missing registry (e.g. an engine built outside the standard
 * `createEngine` flow) gives an empty array, not a crash.
 *
 * @internal
 */

import type { Engine } from '@/engine';
import { TuningRegistriesKey } from '@/core/override-registry';
import type { TunablePickerEntry } from './types';

/** @internal */
export function walkTunables(engine: Engine): TunablePickerEntry[] {
  const registries = engine.tryInject(TuningRegistriesKey);
  if (!registries) return [];

  const entries: TunablePickerEntry[] = [];
  for (const registry of registries) {
    for (const key of registry.getBaseKeys()) {
      entries.push({
        kind: 'tunable',
        registryId: registry.id,
        key,
        address: {
          walker: 'tunable',
          registryId: registry.id,
          key,
        },
        label: `${registry.id}/${key}`,
      });
    }
  }
  return entries;
}
