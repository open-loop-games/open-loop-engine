/**
 * Resource-peak tracker — samples a single resource every tick and reports
 * its peak, final, and average value at the end of a headless run. One of
 * the two default analyzers in {@link defaultAnalyzerPack}.
 *
 * The runtime contract is the metric-key naming under the harness's
 * `${analyzerName}.${metricKey}` aggregation scheme:
 * `resource-peak:{displayName}.peak`, `.final`, `.avg`.
 *
 * Resources are not addressable by stable ID at the engine level — `Resource`
 * is a `Ref<Decimal>` carrying a `displayName`. The tracker closure-captures
 * the ref directly so it can read `.value` on every tick without a per-tick
 * registry lookup. Discovery happens one level up in {@link defaultAnalyzerPack},
 * which walks the engine's resource registry (via `ResourceRegistryKey`)
 * and constructs one tracker per entry.
 *
 * Precision note: resource values are `Decimal`, but `AnalyzerResult.metrics`
 * is `number | string | boolean`. Each sample is converted via `.toNumber()`
 * at observation time; values beyond `Number.MAX_VALUE` saturate to `Infinity`.
 * v1 accepts this — astronomical resources are a consumer problem until the
 * harness aggregator grows Decimal-aware metric types.
 *
 * Sampling lifecycle: sampling happens in `onTick` so each observation reflects
 * post-tick state. Zero-tick runs fall back to a single read inside
 * `summarize` so the tracker still reports a meaningful `peak/final/avg` trio.
 */

import type { Analyzer, AnalyzerResult } from '@/primitives/types';
import type { Resource } from '@/core/resource';
import { Decimal } from '@/primitives/decimal';

/**
 * Metrics reported by a single {@link createResourcePeakTracker} instance.
 *
 * @internal Engine-internal shape. Consumers read these via the metric-key
 * naming (`resource-peak:{displayName}.peak/.final/.avg`) rather than by
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
 * emits `{ peak, final, avg }` at the end of the run.
 *
 * The analyzer's `name` is `resource-peak:{displayName}` so multiple peak
 * trackers coexist in a single run without metric-key collisions under the
 * harness's `${analyzerName}.${metricKey}` aggregation scheme.
 *
 * @example
 * ```ts
 * const gold = createResource(0, { displayName: 'gold' });
 * const tracker = createResourcePeakTracker(gold);
 * runHeadless({ analyzers: [tracker], ... });
 * // tracker.summarize().metrics → { peak, final, avg }
 * ```
 */
export function createResourcePeakTracker(resource: Resource): Analyzer {
  const name = `resource-peak:${resource.displayName}`;
  const samples: number[] = [];
  let peak = -Infinity;

  function sample(): void {
    const n = new Decimal(resource.value).toNumber();
    samples.push(n);
    if (n > peak) peak = n;
  }

  return {
    name,
    onStart() {
      samples.length = 0;
      peak = -Infinity;
    },
    onTick() {
      sample();
    },
    summarize(): AnalyzerResult {
      if (samples.length === 0) sample();
      const final = samples[samples.length - 1]!;
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      return {
        name,
        metrics: { peak, final, avg },
      };
    },
  };
}
