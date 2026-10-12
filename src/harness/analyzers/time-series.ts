/**
 * Time-series analyzer — samples a single resource every iteration and reports
 * one scalar metric per iteration (`time-series:{id}.t{i}`) instead of a reduced
 * peak/final/avg trio. Keys use {@link Resource.id}, unique per engine, so
 * two resources sharing a display name never merge.
 *
 * The design depends on the harness aggregator rather than adding a new
 * Decimal-array metric type. {@link AnalyzerSummary.metrics} is scalar-only,
 * so a trajectory cannot pass through as one value. But each iteration has its own
 * key, so the `${analyzerId}.${metricKey}` aggregation scheme computes
 * min/mean/max/percentiles *per iteration across seeds* automatically. That
 * per-iteration distribution is exactly the variance range a balance UI charts,
 * with no bespoke aggregation. The cost is `iterations` metric keys per sampled
 * resource. Balance work in development is the only caller, so that cost is
 * acceptable; the default analyzer pack stays scalar-only.
 *
 * Because every headless run in a fixed-tick sweep executes the same tick count, the
 * `t{i}` keyspace is identical across seeds, so each per-tick metric has a
 * full seed sample and the aggregate's `count` matches the seed count.
 *
 * Precision note: mirrors {@link createResourcePeakAnalyzer} — samples convert
 * via `.toNumber()` at observation time; values beyond `Number.MAX_VALUE`
 * saturate to `Infinity`.
 */

import type { Analyzer, AnalyzerSummary } from '@/primitives/types';
import type { Engine } from '@/engine';
import type { Resource } from '@/core/resource';
import { ResourceRegistryKey } from '@/core/registries';
import { Decimal } from '@/primitives/decimal';

/**
 * Create an {@link Analyzer} that records a single resource's value at every
 * tick and reports it as `time-series:{id}.t{i}` (zero-based tick index).
 *
 * The analyzer's `id` is `time-series:{id}`, so multiple time-series analyzers
 * coexist in one headless run without metric-key collisions under the harness's
 * `${analyzerId}.${metricKey}` aggregation scheme.
 *
 * @example
 * ```ts
 * const gold = createResource(0, { id: 'gold', displayName: 'Gold' });
 * const analyzer = createTimeSeriesAnalyzer(gold);
 * runHeadless({ setup: () => [analyzer], iterations: 200, ... });
 * // analyzer.summarize().metrics → { 't0': …, 't1': …, …, 't199': … }
 * ```
 */
export function createTimeSeriesAnalyzer(resource: Resource): Analyzer {
  const name = `time-series:${resource.id}`;
  const samples: number[] = [];

  function sample(): void {
    samples.push(new Decimal(resource.value).toNumber());
  }

  return {
    id: name,
    onStart() {
      samples.length = 0;
    },
    onIteration() {
      sample();
    },
    summarize(): AnalyzerSummary {
      // Zero-tick headless runs still report a single-point series so the trajectory
      // is never empty — mirrors the resource-peak analyzer's fallback.
      if (samples.length === 0) sample();
      const metrics: Record<string, number> = {};
      for (let i = 0; i < samples.length; i++) {
        metrics[`t${i}`] = samples[i]!;
      }
      return { id: name, metrics };
    },
  };
}

/**
 * Build one {@link createTimeSeriesAnalyzer} per entry in the engine's resource
 * registry — the trajectory-capturing counterpart to {@link defaultAnalyzerPack}.
 *
 * Kept separate from the default pack (rather than merged behind a flag)
 * because the per-tick fan-out is expensive relative to the scalar default,
 * so callers opt in explicitly. Intended to be called from inside a harness
 * `Cell.setup()` so it sees the live resource set of its headless run.
 */
export function timeSeriesAnalyzerPack(engine: Engine): Analyzer[] {
  const registry = engine.tryInject(ResourceRegistryKey);
  return (registry?.list() ?? []).map((entry) => createTimeSeriesAnalyzer(entry.resource));
}
