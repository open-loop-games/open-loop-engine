import { describe, it, expect } from 'vitest';
import type { Analyzer, AnalyzerResult } from '@/primitives/types';
import type { HeadlessResult } from '@/core/headless';
import type { Engine } from '@/index';
import {
  computeMetricStats,
  createWorkPlan,
  diffAggregates,
  runBatch,
  runMatrix,
  runSensitivity,
} from '@/harness';
import { aggregateCell } from '@/harness/aggregate';
import type { Cell, CellResult, UntilCell, WorkItem } from '@/harness';

// --- helpers ---

/** Analyzer factory that produces a monotonic per-tick counter. Reset
 *  semantics are what the "no state bleed" test leans on. */
function createCounterAnalyzer(): Analyzer {
  let ticks = 0;
  let summarized = 0;
  return {
    name: 'counter',
    onTick: () => {
      ticks += 1;
    },
    summarize: (): AnalyzerResult => ({
      name: 'counter',
      metrics: { ticks, summarize: ++summarized },
    }),
  };
}

/** Cell that records a metric equal to its own `ticks` setting — simple,
 *  lets us assert aggregation arithmetic without floating-point fuzz.
 *  Optional `analyzers` factory produces fresh instances per run. */
function fixedMetricCell(
  name: string,
  metric: number,
  analyzers: () => Analyzer[] = () => [],
): Cell {
  return {
    name,
    setup: () => analyzers(),
    tick: () => {},
    ticks: metric,
  };
}

// --- createWorkPlan ---

describe('createWorkPlan', () => {
  it('returns a flat cells × seeds array in stable order', () => {
    const cellA = fixedMetricCell('a', 10);
    const cellB = fixedMetricCell('b', 20);
    const plan = createWorkPlan({ cells: [cellA, cellB], seeds: [1, 2, 3] });
    expect(plan).toHaveLength(6);
    expect(plan.map((w) => [w.cellIdx, w.seedIdx, w.seed])).toEqual([
      [0, 0, 1],
      [0, 1, 2],
      [0, 2, 3],
      [1, 0, 1],
      [1, 1, 2],
      [1, 2, 3],
    ]);
    expect(plan[0]!.cell).toBe(cellA);
    expect(plan[3]!.cell).toBe(cellB);
  });
  it('handles empty cells or seeds as an empty plan', () => {
    expect(createWorkPlan({ cells: [], seeds: [1, 2] })).toHaveLength(0);
    expect(createWorkPlan({ cells: [fixedMetricCell('a', 1)], seeds: [] })).toHaveLength(0);
  });
});

// --- aggregateCell ---

function runWithMetric(
  name: string,
  metrics: Record<string, number | string | boolean>,
): HeadlessResult {
  return {
    totalTicks: 0,
    elapsedSimulated: 0,
    analyzerResults: [{ name, metrics }],
  };
}

describe('aggregateCell', () => {
  it('computes min/max/avg/median/count for numeric metrics, namespaced by analyzer', () => {
    const runs = [
      runWithMetric('a', { x: 10 }),
      runWithMetric('a', { x: 20 }),
      runWithMetric('a', { x: 30 }),
      runWithMetric('a', { x: 40 }),
    ];
    const agg = aggregateCell(runs);
    expect(agg.metrics['a.x']).toMatchObject({ min: 10, max: 40, avg: 25, median: 25, count: 4 });
  });
  it('uses the odd-length median convention', () => {
    const runs = [1, 2, 3, 4, 5].map((v) => runWithMetric('a', { x: v }));
    expect(aggregateCell(runs).metrics['a.x']!.median).toBe(3);
  });
  it('computes population stddev and returns 0 for a single sample', () => {
    const single = aggregateCell([runWithMetric('a', { x: 42 })]);
    expect(single.metrics['a.x']!.stddev).toBe(0);
    // Population stddev of [2, 4, 4, 4, 5, 5, 7, 9] — canonical textbook
    // example; mean 5, variance 4, stddev 2.
    const canonical = aggregateCell(
      [2, 4, 4, 4, 5, 5, 7, 9].map((v) => runWithMetric('a', { x: v })),
    );
    expect(canonical.metrics['a.x']!.stddev).toBe(2);
  });
  it('computes p5/p50/p95 via floor-index selection on the sorted sample', () => {
    // 100 samples (1..100) — floor-index percentile returns values[floor(n*p)]:
    //   p05 → index 5  → 6, p50 → index 50 → 51, p95 → index 95 → 96.
    const runs = Array.from({ length: 100 }, (_, i) => runWithMetric('a', { x: i + 1 }));
    const stats = aggregateCell(runs).metrics['a.x']!;
    expect(stats.p5).toBe(6);
    expect(stats.p50).toBe(51);
    expect(stats.p95).toBe(96);
  });
  it('does not emit histograms unless a spec is supplied', () => {
    const runs = [1, 2, 3].map((v) => runWithMetric('a', { x: v }));
    expect(aggregateCell(runs).histograms).toBeUndefined();
  });
  it('bucketizes declared histogram metrics with underflow/overflow counts', () => {
    const runs = [-5, 0, 2, 7, 9, 10, 15, 99].map((v) => runWithMetric('a', { x: v }));
    const agg = aggregateCell(runs, { histograms: { 'a.x': { edges: [0, 5, 10] } } });
    // Edges [0, 5, 10] → 2 buckets: [0,5) and [5,10]. -5 is underflow;
    // {15, 99} are overflow; {0, 2} fall in bucket 0; {7, 9, 10} fall in
    // bucket 1 (10 lands in the final closed bucket, not overflow).
    expect(agg.histograms!['a.x']).toEqual({
      edges: [0, 5, 10],
      counts: [2, 3],
      underflow: 1,
      overflow: 2,
    });
  });
  it('omits histograms for metrics that produced no numeric samples', () => {
    const runs = [runWithMetric('a', { label: 'ok' })];
    const agg = aggregateCell(runs, { histograms: { 'a.x': { edges: [0, 1] } } });
    expect(agg.histograms).toEqual({});
  });
  it('drops non-numeric metric samples from the aggregate', () => {
    const runs = [
      runWithMetric('a', { x: 10, label: 'ok', flag: true }),
      runWithMetric('a', { x: 20, label: 'bad', flag: false }),
    ];
    const agg = aggregateCell(runs);
    expect(Object.keys(agg.metrics)).toEqual(['a.x']);
    expect(agg.metrics['a.x']!.count).toBe(2);
  });
  it('prevents cross-analyzer collisions via namespacing', () => {
    const runs: HeadlessResult[] = [
      {
        totalTicks: 0,
        elapsedSimulated: 0,
        analyzerResults: [
          { name: 'a', metrics: { x: 10 } },
          { name: 'b', metrics: { x: 100 } },
        ],
      },
    ];
    const agg = aggregateCell(runs);
    expect(agg.metrics['a.x']!.avg).toBe(10);
    expect(agg.metrics['b.x']!.avg).toBe(100);
  });
});

// --- diffAggregates ---

describe('computeMetricStats', () => {
  it('keeps median the true median and p50 the floor-index percentile', () => {
    expect(computeMetricStats([1, 3])).toMatchObject({ median: 2, p50: 3 });
  });

  it('refuses an empty sample', () => {
    expect(() => computeMetricStats([])).toThrow(/at least one value/);
  });
});

describe('diffAggregates', () => {
  it('computes absolute and relative deltas against baseline', () => {
    const baseline = aggregateCell([runWithMetric('a', { x: 10 })]);
    const variant = aggregateCell([runWithMetric('a', { x: 15 })]);
    expect(diffAggregates(variant, baseline)['a.x']).toEqual({
      absolute: 5,
      relative: 0.5,
    });
  });
  it('returns relative=0 when baseline avg is zero', () => {
    const baseline = aggregateCell([runWithMetric('a', { x: 0 })]);
    const variant = aggregateCell([runWithMetric('a', { x: 7 })]);
    expect(diffAggregates(variant, baseline)['a.x']).toEqual({ absolute: 7, relative: 0 });
  });
  it('skips metrics that exist only on one side', () => {
    const baseline = aggregateCell([runWithMetric('a', { x: 10 })]);
    const variant = aggregateCell([runWithMetric('a', { y: 5 })]);
    expect(diffAggregates(variant, baseline)).toEqual({});
  });
  it('adds the mean fire-time delta as termination.time when both sides carry one', () => {
    const baseline = { metrics: {}, terminationTime: computeMetricStats([8, 12]) };
    const variant = { metrics: {}, terminationTime: computeMetricStats([15]) };
    expect(diffAggregates(variant, baseline)).toEqual({
      'termination.time': { absolute: 5, relative: 0.5 },
    });
    expect(diffAggregates({ metrics: {} }, baseline)).toEqual({});
  });
});

// --- runMatrix ---

describe('runMatrix', () => {
  it('round-trips 2 cells × 3 seeds into 6 runs with per-cell aggregates', () => {
    const result = runMatrix({
      cells: [
        fixedMetricCell('a', 5, () => [createCounterAnalyzer()]),
        fixedMetricCell('b', 10, () => [createCounterAnalyzer()]),
      ],
      seeds: [1, 2, 3],
    });
    expect(result.cells).toHaveLength(2);
    expect(result.cells[0]!.runs).toHaveLength(3);
    expect(result.cells[1]!.runs).toHaveLength(3);
    expect(result.cells[0]!.aggregate.metrics['counter.ticks']!.avg).toBe(5);
    expect(result.cells[0]!.aggregate.metrics['counter.ticks']!.median).toBe(5);
    expect(result.cells[1]!.aggregate.metrics['counter.ticks']!.avg).toBe(10);
  });
  it('resets stateful analyzers between runs via the setup-owned factory', () => {
    // Monotonic counter: if setup constructs fresh analyzers, every run sees
    // `summarize: 1`. If the same instance leaks across runs, it climbs 1,2,3.
    const result = runMatrix({
      cells: [fixedMetricCell('a', 3, () => [createCounterAnalyzer()])],
      seeds: [1, 2, 3],
    });
    const summarizeValues = result.cells[0]!.runs.map(
      (r) => r.analyzerResults[0]!.metrics.summarize,
    );
    expect(summarizeValues).toEqual([1, 1, 1]);
  });
  it('fires onRunComplete and onCellComplete in deterministic plan order', () => {
    const runEvents: Array<[number, number]> = [];
    const cellEvents: string[] = [];
    runMatrix({
      cells: [fixedMetricCell('a', 1), fixedMetricCell('b', 1)],
      seeds: [10, 20],
      onRunComplete: (item: WorkItem) => runEvents.push([item.cellIdx, item.seedIdx]),
      onCellComplete: (cell: CellResult) => cellEvents.push(cell.name),
    });
    expect(runEvents).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
    expect(cellEvents).toEqual(['a', 'b']);
  });
  it('threads the aggregate option through to each cell for histogram bucketing', () => {
    const result = runMatrix({
      cells: [fixedMetricCell('a', 3, () => [createCounterAnalyzer()])],
      seeds: [1, 2, 3],
      aggregate: { histograms: { 'counter.ticks': { edges: [0, 3, 6] } } },
    });
    // Every run records ticks=3, which lands in the final (closed) bucket.
    expect(result.cells[0]!.aggregate.histograms!['counter.ticks']).toEqual({
      edges: [0, 3, 6],
      counts: [0, 3],
      underflow: 0,
      overflow: 0,
    });
  });
  it('passes the per-run seed to setup and collects returned analyzers', () => {
    const seen: Array<{ name: string; seed: number }> = [];
    runMatrix({
      cells: [
        {
          name: 'probe',
          setup: ({ seed }) => {
            const analyzer = createCounterAnalyzer();
            seen.push({ name: analyzer.name, seed });
            return [analyzer];
          },
          tick: () => {},
          ticks: 1,
        },
      ],
      seeds: [100, 200],
    });
    expect(seen).toEqual([
      { name: 'counter', seed: 100 },
      { name: 'counter', seed: 200 },
    ]);
  });
  it('tears each run down before the next sets up', () => {
    const events: string[] = [];
    runMatrix({
      cells: [
        {
          ...fixedMetricCell('a', 1),
          setup: () => (events.push('setup'), []),
          teardown: () => events.push('teardown'),
        },
      ],
      seeds: [1, 2],
    });
    expect(events).toEqual(['setup', 'teardown', 'setup', 'teardown']);
  });
});

// --- runBatch ---

describe('runBatch', () => {
  it('is observably identical to runMatrix for a single-config case', () => {
    const cell = fixedMetricCell('a', 7, () => [createCounterAnalyzer()]);
    const batchResult = runBatch({
      configs: [cell],
      seeds: [1, 2],
    });
    const matrixResult = runMatrix({
      cells: [cell],
      seeds: [1, 2],
    });
    expect(batchResult.cells[0]!.aggregate).toEqual(matrixResult.cells[0]!.aggregate);
    expect(batchResult.cells[0]!.runs.length).toBe(matrixResult.cells[0]!.runs.length);
  });
});

// --- runSensitivity ---

describe('runSensitivity', () => {
  it('returns per-variant deltas against baseline', () => {
    const baseline = fixedMetricCell('baseline', 10, () => [createCounterAnalyzer()]);
    const result = runSensitivity({
      baseline,
      variants: [
        { name: 'double', patch: (b) => ({ ...b, ticks: b.ticks * 2 }) },
        { name: 'half', patch: (b) => ({ ...b, ticks: b.ticks / 2 }) },
      ],
      seeds: [1, 2, 3],
    });
    expect(result.baseline.aggregate.metrics['counter.ticks']!.avg).toBe(10);
    expect(result.variants).toHaveLength(2);
    expect(result.variants[0]!.name).toBe('double');
    expect(result.variants[0]!.deltas['counter.ticks']).toEqual({
      absolute: 10,
      relative: 1,
    });
    expect(result.variants[1]!.deltas['counter.ticks']).toEqual({
      absolute: -5,
      relative: -0.5,
    });
  });
  it('forces variant cell names to match the Variant.name', () => {
    const result = runSensitivity({
      baseline: fixedMetricCell('baseline', 1),
      variants: [{ name: 'forced-label', patch: (b) => ({ ...b, name: 'ignored' }) }],
      seeds: [1],
    });
    expect(result.variants[0]!.cell.name).toBe('forced-label');
  });

  it('expands axes into one variant per value', () => {
    const baseline = fixedMetricCell('baseline', 10);
    const result = runSensitivity({
      baseline,
      axes: [
        {
          name: 'ticks',
          values: [5, 20],
          patch: (b, v) => ({ ...b, ticks: v as number }),
        },
      ],
      seeds: [1],
    });
    expect(result.variants).toHaveLength(2);
    expect(result.variants[0]!.name).toBe('ticks=5');
    expect(result.variants[1]!.name).toBe('ticks=20');
  });

  it('expands multiple axes as a cartesian product', () => {
    const baseline = fixedMetricCell('baseline', 10);
    const result = runSensitivity({
      baseline,
      axes: [
        { name: 'a', values: [1, 2], patch: (b) => b },
        { name: 'b', values: ['x', 'y'], patch: (b) => b },
      ],
      seeds: [1],
    });
    expect(result.variants.map((v) => v.name)).toEqual([
      'a=1 × b=x',
      'a=1 × b=y',
      'a=2 × b=x',
      'a=2 × b=y',
    ]);
  });

  it('concatenates flat variants with axis-expanded variants', () => {
    const baseline = fixedMetricCell('baseline', 10);
    const result = runSensitivity({
      baseline,
      variants: [{ name: 'flat', patch: (b) => b }],
      axes: [{ name: 'axis', values: [1, 2], patch: (b) => b }],
      seeds: [1],
    });
    expect(result.variants.map((v) => v.name)).toEqual(['flat', 'axis=1', 'axis=2']);
  });

  it('switches to predicate-bounded mode when `until` is set', () => {
    interface S {
      tick: number;
    }
    const buildEngine = (mul: number): Engine =>
      ({
        tickDriver: {
          simulateTick: () => {
            state.tick += mul;
          },
        },
      }) as unknown as Engine;
    let state: S = { tick: 0 };
    const baseline: UntilCell = {
      name: 'baseline',
      buildEngine: () => {
        state = { tick: 0 };
        return buildEngine(1);
      },
      tickDelta: 0.1,
    };
    const result = runSensitivity({
      baseline,
      variants: [
        {
          name: 'fast',
          patch: (b) => ({
            ...b,
            buildEngine: () => {
              state = { tick: 0 };
              return buildEngine(2);
            },
          }),
        },
      ],
      seeds: [1, 2, 3],
      until: () => state.tick >= 10,
      maxSimTime: 10,
    });
    expect(result.baseline.aggregate.terminationCounts?.predicate).toBe(3);
    expect(result.variants).toHaveLength(1);
    // Fast variant terminates faster → lower terminationTime.avg → negative delta.
    const baseTT = result.baseline.aggregate.terminationTime!.avg;
    const fastTT = result.variants[0]!.cell.aggregate.terminationTime!.avg;
    expect(fastTT).toBeLessThan(baseTT);
    expect(result.variants[0]!.deltas['termination.time']).toEqual({
      absolute: fastTT - baseTT,
      relative: (fastTT - baseTT) / baseTT,
    });
  });

  it('throws when maxSimTime is given without until', () => {
    expect(() =>
      runSensitivity({
        baseline: fixedMetricCell('baseline', 1),
        variants: [],
        seeds: [1],
        maxSimTime: 10,
      }),
    ).toThrow(/maxSimTime.*until/);
  });

  it('throws when until is set without maxSimTime', () => {
    const baseline: UntilCell = {
      name: 'baseline',
      buildEngine: () => ({ tickDriver: { simulateTick: () => {} } }) as unknown as Engine,
    };
    expect(() =>
      runSensitivity({
        baseline,
        variants: [],
        seeds: [1],
        until: () => true,
      }),
    ).toThrow(/maxSimTime/);
  });
});
