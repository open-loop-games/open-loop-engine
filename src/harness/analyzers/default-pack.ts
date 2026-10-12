/**
 * Default analyzer pack — a zero-configuration `(engine) => Analyzer[]` that a
 * balance workbench can wire before consumers write any per-game analyzers.
 *
 * Baseline behavior:
 * - One {@link createResourcePeakAnalyzer} per entry in the engine's
 *   {@link ResourceRegistryKey}: the per-engine resource registry, which
 *   every `createResource()` call during install/connect adds to.
 * - A {@link createRunFinalizeAnalyzer} iff the engine has a canonical
 *   CycleLog published via {@link CycleLogKey}. Games without a cycle cadence
 *   skip it automatically.
 *
 * Call it inside each harness `Cell.setup()`, after the engine is built. Then
 * every call sees the live resource set of its headless run and builds new
 * analyzer instances.
 */

import type { Analyzer } from '@/primitives/types';
import type { Engine } from '@/engine';
import { ResourceRegistryKey } from '@/core/registries';
import { CycleLogKey } from '@/systems/cycle-log';
import { createRunFinalizeAnalyzer } from './run-finalize';
import { createResourcePeakAnalyzer } from './resource-peak';

/**
 * Build a new analyzer pack for the given engine. Call it from inside a
 * harness `Cell.setup()`: the returned instances are stateful and must not
 * be reused across headless runs.
 *
 * @example
 * ```ts
 * const cell = createSensitivityCell({
 *   id: 'baseline',
 *   saveText,
 *   modules: () => [createGoldModule()],
 *   buildAnalyzers: (engine) => defaultAnalyzerPack(engine),
 *   tick: (engine) => engine.tickDriver.tickOnce(),
 *   iterations: 1000,
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
