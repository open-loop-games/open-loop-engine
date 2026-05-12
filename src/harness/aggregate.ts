/**
 * Cell-aggregation kernel — reduces raw per-run results into per-metric
 * stats, optional histograms, and (for until-runs) termination-time
 * distributions. Also exports `diffAggregates`, the baseline-vs-variant
 * delta primitive consumed directly by custom-sweep callers when the
 * canned `runSensitivity` shape doesn't fit (see starter `sweep.ts`,
 * `tug/balance/probes.ts`).
 *
 * @cluster runners
 */

import type { HeadlessResult } from '@/core/headless';
import type {
  AggregateOptions,
  CellAggregate,
  HistogramSpec,
  MetricDelta,
  MetricHistogram,
  MetricStats,
  RunUntilResult,
} from './types';

/**
 * Floor-index percentile on a pre-sorted ascending array. Matches the
 * convention in `core/profiler.ts` and the bench runner so the three
 * percentile-reporting surfaces in the repo stay comparable. Returns `0`
 * for an empty input.
 */
function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  return sorted[Math.min(n - 1, Math.floor(n * p))] ?? 0;
}

/**
 * Descriptive stats (min/max/avg/stddev/median/p5/p50/p95/count) over a
 * non-empty numeric array. Caller guarantees `values.length >= 1`.
 */
function computeStats(values: number[]): MetricStats {
  // Caller ensures values.length >= 1. Single-pass min/max/avg, then a copy
  // for the sort so we don't mutate the caller's buffer.
  let min = values[0]!;
  let max = values[0]!;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const avg = sum / values.length;
  let sqSum = 0;
  for (const v of values) {
    const d = v - avg;
    sqSum += d * d;
  }
  // Population stddev (divisor n) — single-sample cells report 0 instead
  // of NaN, and balance probes treat the seed batch as the observed
  // population rather than a sample of a larger distribution.
  const stddev = Math.sqrt(sqSum / values.length);
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  const p50 = percentile(sorted, 0.5);
  return {
    min,
    max,
    avg,
    stddev,
    median,
    p5: percentile(sorted, 0.05),
    p50,
    p95: percentile(sorted, 0.95),
    count: values.length,
  };
}

/**
 * Bucket a numeric sample into consumer-declared edges. `edges` has N+1
 * entries defining N buckets, half-open `[edges[i], edges[i+1])` except
 * the final bucket which is closed on both ends. Samples below `edges[0]`
 * count into `underflow`, above `edges[N]` into `overflow` — lossless by
 * construction.
 */
function bucketize(values: number[], spec: HistogramSpec): MetricHistogram {
  const edges = spec.edges;
  const nBuckets = Math.max(0, edges.length - 1);
  const counts = new Array<number>(nBuckets).fill(0);
  let underflow = 0;
  let overflow = 0;
  const lo = edges[0]!;
  const hi = edges[nBuckets]!;
  for (const v of values) {
    if (v < lo) {
      underflow += 1;
      continue;
    }
    if (v > hi) {
      overflow += 1;
      continue;
    }
    if (v === hi) {
      counts[nBuckets - 1]! += 1;
      continue;
    }
    // Linear scan — edges arrays in practice are short (tens at most) and
    // dominate cache locality over a binary search. Revisit if a consumer
    // declares hundreds of buckets.
    for (let i = 0; i < nBuckets; i++) {
      if (v < edges[i + 1]!) {
        counts[i]! += 1;
        break;
      }
    }
  }
  return { edges: [...edges], counts, underflow, overflow };
}

/**
 * Aggregate a cell's raw runs into per-metric stats, keyed
 * `${analyzerName}.${metricKey}`. Only numeric values contribute — string
 * and boolean metric values are silently dropped, so `count` reflects the
 * number of numeric samples observed, not the number of runs. Metric keys
 * that produced no numeric samples are omitted from the result.
 *
 * Percentiles (`p5`/`p50`/`p95`) and `stddev` are always computed;
 * histograms are opt-in via {@link AggregateOptions.histograms} — edges
 * are domain-specific and not worth computing speculatively.
 *
 * @internal
 */
export function aggregateCell(runs: HeadlessResult[], options?: AggregateOptions): CellAggregate {
  const samples: Record<string, number[]> = {};
  for (const run of runs) {
    for (const ar of run.analyzerResults) {
      for (const [key, value] of Object.entries(ar.metrics)) {
        if (typeof value !== 'number') continue;
        const fullKey = `${ar.name}.${key}`;
        (samples[fullKey] ??= []).push(value);
      }
    }
  }
  const metrics: Record<string, MetricStats> = {};
  for (const [key, values] of Object.entries(samples)) {
    if (values.length > 0) metrics[key] = computeStats(values);
  }

  const histogramSpecs = options?.histograms;
  if (!histogramSpecs) {
    return { metrics };
  }
  const histograms: Record<string, MetricHistogram> = {};
  for (const [key, spec] of Object.entries(histogramSpecs)) {
    const values = samples[key];
    if (!values || values.length === 0) continue;
    histograms[key] = bucketize(values, spec);
  }
  return { metrics, histograms };
}

/**
 * Aggregate an until-run seed sweep. Extends {@link aggregateCell}'s output
 * with first-class termination data: `terminationTime` stats over the
 * `elapsedSimulated` of predicate-terminated runs, `terminationCounts` by
 * reason, and (opt-in via {@link AggregateOptions.terminationTimeHistogram})
 * a histogram of predicate-termination sim-times.
 *
 * Runs that hit `maxSimTime` are excluded from `terminationTime` stats so
 * the ceiling doesn't pollute the distribution — consumers inspect
 * `terminationCounts.maxSimTime` to see how often the predicate failed to
 * fire. When no runs terminated on the predicate, `terminationTime` is
 * omitted entirely (rather than returning a zero-filled `MetricStats`).
 *
 * @internal
 */
export function aggregateUntilCell(
  runs: RunUntilResult[],
  options?: AggregateOptions,
): CellAggregate {
  const base = aggregateCell(runs, options);

  let predicateCount = 0;
  let maxSimTimeCount = 0;
  let unreachableCount = 0;
  const predicateTimes: number[] = [];
  for (const run of runs) {
    if (run.terminated === 'predicate') {
      predicateCount += 1;
      predicateTimes.push(run.elapsedSimulated);
    } else if (run.terminated === 'unreachable') {
      unreachableCount += 1;
    } else {
      maxSimTimeCount += 1;
    }
  }

  base.terminationCounts = {
    predicate: predicateCount,
    maxSimTime: maxSimTimeCount,
    unreachable: unreachableCount,
  };
  if (predicateTimes.length > 0) {
    base.terminationTime = computeStats(predicateTimes);
    if (options?.terminationTimeHistogram) {
      base.terminationTimeHistogram = bucketize(predicateTimes, options.terminationTimeHistogram);
    }
  }
  return base;
}

/**
 * Per-metric delta between a variant cell aggregate and the baseline.
 * Compares on `avg`; `relative` is `absolute / baseline.avg`, or `0` when
 * the baseline average is zero (avoids `±Infinity` without hiding the
 * sign of `absolute`). Metrics present on only one side are skipped —
 * callers that need the union shape can walk both aggregates directly.
 *
 * Used both internally by {@link runSensitivity} and directly by consumers
 * composing custom sensitivity-shape sweeps over `runMatrix` or
 * `runMatrixUntil`.
 *
 * @param cell - The variant cell's aggregate, keyed `${analyzerName}.${metricKey}`.
 * @param baseline - The baseline cell's aggregate, same key namespace.
 * @returns Per-metric `{ absolute, relative }` delta, keyed by the metric
 *   name. Empty when the two aggregates share no metric keys.
 *
 * @example
 * ```ts
 * const result = runMatrix({ cells: [baseline, ...variants], seeds });
 * const deltas = diffAggregates(result.cells[1]!.aggregate, result.cells[0]!.aggregate);
 * deltas['gold-tracker.peak'].relative; // e.g. +0.42
 * ```
 */
export function diffAggregates(
  cell: CellAggregate,
  baseline: CellAggregate,
): Record<string, MetricDelta> {
  const out: Record<string, MetricDelta> = {};
  for (const [key, cellStats] of Object.entries(cell.metrics)) {
    const baseStats = baseline.metrics[key];
    if (!baseStats) continue;
    const absolute = cellStats.avg - baseStats.avg;
    const relative = baseStats.avg === 0 ? 0 : absolute / baseStats.avg;
    out[key] = { absolute, relative };
  }
  return out;
}
