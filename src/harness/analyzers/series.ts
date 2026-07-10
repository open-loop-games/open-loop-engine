/**
 * Per-tick series tracker — samples a single resource every tick and emits
 * one scalar metric per tick (`series:{displayName}.t{i}`) instead of a
 * reduced peak/final/avg trio.
 *
 * The design leans on the harness aggregator rather than adding a new
 * Decimal-array metric type. {@link AnalyzerResult.metrics} is scalar-only,
 * so a trajectory can't ride through as one value — but by fanning each tick
 * out to its own key, the `${analyzerName}.${metricKey}` aggregation scheme
 * computes min/mean/max/percentiles *per tick across seeds* automatically.
 * That per-tick distribution is exactly the variance band a balance UI wants
 * to chart, produced with no bespoke aggregation. The cost is `ticks` metric
 * keys per tracked resource — acceptable for dev balance tooling, which is
 * the only caller; the default analyzer pack stays scalar-only.
 *
 * Because every run in a fixed-tick sweep executes the same tick count, the
 * `t{i}` keyspace is identical across seeds, so each per-tick metric has a
 * full seed sample and the aggregate's `count` matches the seed count.
 *
 * Precision note: mirrors {@link createResourcePeakTracker} — samples convert
 * via `.toNumber()` at observation time; values beyond `Number.MAX_VALUE`
 * saturate to `Infinity`.
 */

import type { Analyzer, AnalyzerResult } from '@/primitives/types';
import type { Engine } from '@/engine';
import type { Resource } from '@/core/resource';
import { ResourceRegistryKey } from '@/core/registries';
import { Decimal } from '@/primitives/decimal';

/**
 * Create an {@link Analyzer} that records a single resource's value at every
 * tick and emits it as `series:{displayName}.t{i}` (zero-based tick index).
 *
 * The analyzer's `name` is `series:{displayName}` so multiple series trackers
 * coexist in one run without metric-key collisions under the harness's
 * `${analyzerName}.${metricKey}` aggregation scheme.
 *
 * @example
 * ```ts
 * const gold = createResource(0, { displayName: 'gold' });
 * const tracker = createSeriesTracker(gold);
 * runHeadless({ analyzers: [tracker], ticks: 200, ... });
 * // tracker.summarize().metrics → { 't0': …, 't1': …, …, 't199': … }
 * ```
 */
export function createSeriesTracker(resource: Resource): Analyzer {
  const name = `series:${resource.displayName}`;
  const samples: number[] = [];

  function sample(): void {
    samples.push(new Decimal(resource.value).toNumber());
  }

  return {
    name,
    onStart() {
      samples.length = 0;
    },
    onTick() {
      sample();
    },
    summarize(): AnalyzerResult {
      // Zero-tick runs still report a single-point series so the trajectory
      // is never empty — mirrors the resource-peak tracker's fallback.
      if (samples.length === 0) sample();
      const metrics: Record<string, number> = {};
      for (let i = 0; i < samples.length; i++) {
        metrics[`t${i}`] = samples[i]!;
      }
      return { name, metrics };
    },
  };
}

/**
 * Build one {@link createSeriesTracker} per entry in the engine's resource
 * registry — the trajectory-capturing counterpart to {@link defaultAnalyzerPack}.
 *
 * Kept separate from the default pack (rather than merged behind a flag)
 * because the per-tick fan-out is expensive relative to the scalar default,
 * so callers opt in explicitly. Intended to be called from inside a harness
 * `Cell.setup()` so it sees the live per-run resource set.
 */
export function seriesAnalyzerPack(engine: Engine): Analyzer[] {
  const registry = engine.tryInject(ResourceRegistryKey);
  return (registry?.list() ?? []).map((entry) => createSeriesTracker(entry.resource));
}
