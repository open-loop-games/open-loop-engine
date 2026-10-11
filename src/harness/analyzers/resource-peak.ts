/**
 * Resource-peak analyzer — samples a single resource every tick and reports
 * its peak, final, and average value at the end of a headless run. One of
 * the two default analyzers in {@link defaultAnalyzerPack}.
 *
 * The runtime contract is the metric-key naming under the harness's
 * `${analyzerId}.${metricKey}` aggregation scheme:
 * `resource-peak:{id}.peak`, `.final`, `.avg`. Keys use {@link Resource.id},
 * unique per engine, so two resources sharing a display name never merge;
 * label a key via `ResourceRegistry.findById(id).displayName`.
 *
 * The analyzer captures the resource in its closure, so it reads `.value` on
 * every tick without a per-tick registry lookup. Discovery is one level up, in
 * {@link defaultAnalyzerPack}, which walks the engine's resource registry
 * (via `ResourceRegistryKey`) and builds one analyzer per entry.
 *
 * Precision note: resource values are `Decimal`, but `AnalyzerSummary.metrics`
 * is `number | string | boolean`. Each sample is converted via `.toNumber()`
 * at observation time; values beyond `Number.MAX_VALUE` saturate to `Infinity`.
 * The analyzer accepts this: an astronomical resource is the consumer's
 * problem until the harness aggregator has Decimal-aware metric types.
 *
 * Sampling lifecycle: sampling happens in `onTick`, so each observation shows
 * post-tick state. Zero-tick headless runs fall back to a single read inside
 * `summarize`, so the analyzer still reports a meaningful `peak/final/avg` trio.
 */

import type { Analyzer, AnalyzerSummary } from '@/primitives/types';
import type { Resource } from '@/core/resource';
import { Decimal } from '@/primitives/decimal';

/**
 * Metrics reported by a single {@link createResourcePeakAnalyzer} instance.
 *
 * @internal Engine-internal shape. Consumers read these via the metric-key
 * naming (`resource-peak:{id}.peak/.final/.avg`) rather than by
 * importing this type.
 */
export interface ResourcePeakMetrics {
  /** Highest value observed across all ticks (including the initial sample). */
  peak: number;
  /** Value at the final tick. */
  final: number;
  /**
   * Arithmetic mean of per-tick samples. Ticks are weighted uniformly —
   * time-weighted averaging (respecting variable `tickDelta`) is deferred
   * until a consumer needs it.
   */
  avg: number;
}

/**
 * Create an {@link Analyzer} that samples a single resource every tick and
 * reports `{ peak, final, avg }` at the end of the headless run.
 *
 * The analyzer's `id` is `resource-peak:{id}`, so multiple peak
 * analyzers coexist in a single headless run without metric-key collisions under the
 * harness's `${analyzerId}.${metricKey}` aggregation scheme.
 *
 * @example
 * ```ts
 * const gold = createResource(0, { id: 'gold', displayName: 'Gold' });
 * const analyzer = createResourcePeakAnalyzer(gold);
 * runHeadless({ setup: () => [analyzer], ... });
 * // analyzer.summarize().metrics → { peak, final, avg }
 * ```
 */
export function createResourcePeakAnalyzer(resource: Resource): Analyzer {
  const name = `resource-peak:${resource.id}`;
  const samples: number[] = [];
  let peak = -Infinity;

  function sample(): void {
    const n = new Decimal(resource.value).toNumber();
    samples.push(n);
    if (n > peak) peak = n;
  }

  return {
    id: name,
    onStart() {
      samples.length = 0;
      peak = -Infinity;
    },
    onTick() {
      sample();
    },
    summarize(): AnalyzerSummary {
      if (samples.length === 0) sample();
      const final = samples[samples.length - 1];
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      return {
        id: name,
        metrics: { peak, final, avg },
      };
    },
  };
}
