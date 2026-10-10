/**
 * Default analyzer pack — a zero-configuration `(engine) => Analyzer[]` the
 * balance workbench can wire without forcing consumers to hand-author per-game
 * analyzers before they see any numbers.
 *
 * Baseline behavior:
 * - One {@link createResourcePeakAnalyzer} per entry in the engine's
 *   {@link ResourceRegistryKey} — the per-engine resource registry,
 *   auto-populated by every `createResource()` call during install/connect.
 * - A {@link createRunFinalizeAnalyzer} iff the engine has a canonical
 *   CycleLog published via {@link CycleLogKey}. Games without a cycle cadence
 *   skip it automatically.
 *
 * Freshness comes from being called inside each harness `Cell.setup()` —
 * setup builds the engine and then produces its analyzer list, so every call
 * sees the live per-run resource set and constructs fresh tracker instances.
 */

import type { Analyzer } from '@/primitives/types';
import type { Engine } from '@/engine';
import { ResourceRegistryKey } from '@/core/registries';
import { CycleLogKey } from '@/systems/cycle-log';
import { createRunFinalizeAnalyzer } from './run-finalize';
import { createResourcePeakAnalyzer } from './resource-peak';

/**
 * Build a fresh analyzer pack for the given engine. Intended to be called
 * from inside a harness `Cell.setup()` — the returned instances are stateful
 * and must not be reused across runs.
 *
 * @example
 * ```ts
 * const cell = createSensitivityCell({
 *   name: 'baseline',
 *   saveText,
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
    createResourcePeakAnalyzer(entry.resource),
  );
  if (engine.tryInject(CycleLogKey) !== undefined) {
    pack.push(createRunFinalizeAnalyzer());
  }
  return pack;
}
