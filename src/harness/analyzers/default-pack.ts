/**
 * Default analyzer pack — a zero-configuration `(engine) => Analyzer[]` the
 * balance workbench can wire without forcing consumers to hand-author per-game
 * analyzers before they see any numbers.
 *
 * Baseline behavior:
 * - One {@link createResourcePeakTracker} per entry in the engine's
 *   {@link ResourceRegistryKey} — the per-engine resource registry,
 *   auto-populated by every `createResource()` call during install/connect.
 * - A {@link createLoopFinalizeTracker} iff the engine has a canonical
 *   LoopLog published via {@link LoopLogKey}. Games without a loop cadence
 *   skip it automatically.
 *
 * Freshness comes from being called inside each harness `Cell.setup()` —
 * setup builds the engine and then produces its analyzer list, so every call
 * sees the live per-run resource set and constructs fresh tracker instances.
 */

import type { Analyzer } from '@/primitives/types';
import type { Engine } from '@/engine';
import { ResourceRegistryKey } from '@/core/registries';
import { LoopLogKey } from '@/systems/loop-log';
import { createLoopFinalizeTracker } from './loop-finalize';
import { createResourcePeakTracker } from './resource-peak';

/**
 * Build a fresh analyzer pack for the given engine. Intended to be called
 * from inside a harness `Cell.setup()` — the returned instances are stateful
 * and must not be reused across runs.
 *
 * @example
 * ```ts
 * const cell = createSensitivityCell({
 *   name: 'baseline',
 *   saveBlob,
 *   modules: () => [createGoldModule()],
 *   buildAnalyzers: (engine) => defaultAnalyzerPack(engine),
 *   tick: (engine) => engine.tickDriver.stepOnce(),
 *   ticks: 1000,
 * });
 * ```
 */
export function defaultAnalyzerPack(engine: Engine): Analyzer[] {
  const registry = engine.tryInject(ResourceRegistryKey);
  const pack: Analyzer[] = (registry?.list() ?? []).map((entry) =>
    createResourcePeakTracker(entry.resource),
  );
  if (engine.tryInject(LoopLogKey) !== undefined) {
    pack.push(createLoopFinalizeTracker());
  }
  return pack;
}
