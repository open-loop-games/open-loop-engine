/**
 * Tunables walker — emit one {@link TunablePickerEntry} per `tunable()`
 * key registered into a {@link TuningRegistry} auto-registered with the
 * engine's {@link TuningRegistriesKey}.
 *
 * This walker reflects the **designer-flagged tuning surface**: only
 * values explicitly declared via `tunable()` against a `TuningRegistry`
 * surface here. Implementation constants, derived values, and structural
 * modifier identities (already discoverable via chain-registry) stay
 * invisible — the principle lives in `override-registry.ts` under
 * `tunable()` and `createTuningRegistry()`.
 *
 * Scope-only keys (transient `pushScope` overrides) are intentionally
 * excluded — `getBaseKeys()` returns the base map only. See the
 * `OverrideRegistry.getBaseKeys` TSDoc for the rationale.
 *
 * Missing registry (e.g. an engine constructed outside the standard
 * `createEngine` flow) degrades to an empty array — not a crash.
 *
 * @internal
 */

import type { Engine } from '@/index';
import { TuningRegistriesKey } from '@/index';
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
        registryName: registry.name,
        key,
        address: {
          source: 'tunable',
          registryName: registry.name,
          key,
        },
        label: `${registry.name}/${key}`,
      });
    }
  }
  return entries;
}
