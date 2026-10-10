import { describe, it, expect } from 'vitest';
import { createResource } from '@/core/resource';
import { runHeadless } from '@/core/headless';
import { createTimeSeriesAnalyzer } from '@/harness/analyzers/time-series';

describe('createTimeSeriesAnalyzer', () => {
  it('emits one metric per tick keyed t{i} over the trajectory', () => {
    const gold = createResource(0, { id: 'gold', displayName: 'gold' });
    const tracker = createTimeSeriesAnalyzer(gold);

    let tick = 0;
    const trajectory = [1, 2, 3, 4, 5];

    const result = runHeadless({
      setup: () => {
        gold.value = 0;
        tick = 0;
        return [tracker];
      },
      tick: () => {
        gold.value = trajectory[tick]!;
        tick += 1;
      },
      ticks: 5,
    });

    const metrics = result.analyzerSummaries[0]!.metrics;
    expect(metrics.t0).toBe(1);
    expect(metrics.t1).toBe(2);
    expect(metrics.t4).toBe(5);
    expect(Object.keys(metrics)).toHaveLength(5);
  });

  it('analyzer id is keyed by resource id, so a shared displayName never merges', () => {
    const prestige = createResource(0, { id: 'prestige-points', displayName: 'Points' });
    const transcend = createResource(0, { id: 'transcend-points', displayName: 'Points' });
    expect(createTimeSeriesAnalyzer(prestige).id).toBe('time-series:prestige-points');
    expect(createTimeSeriesAnalyzer(transcend).id).toBe('time-series:transcend-points');
  });

  it('zero-tick run reports a single-point series', () => {
    const gold = createResource(42, { id: 'gold', displayName: 'gold' });
    const tracker = createTimeSeriesAnalyzer(gold);

    const result = runHeadless({
      setup: () => [tracker],
      tick: () => {},
      ticks: 0,
    });

    const metrics = result.analyzerSummaries[0]!.metrics;
    expect(metrics.t0).toBe(42);
    expect(Object.keys(metrics)).toHaveLength(1);
  });

  it('resets state between sequential runs of the same instance', () => {
    const gold = createResource(0, { id: 'gold', displayName: 'gold' });
    const tracker = createTimeSeriesAnalyzer(gold);

    runHeadless({
      setup: () => {
        gold.value = 100;
        return [tracker];
      },
      tick: () => {},
      ticks: 3,
    });
    const result = runHeadless({
      setup: () => {
        gold.value = 5;
        return [tracker];
      },
      tick: () => {},
      ticks: 1,
    });

    const metrics = result.analyzerSummaries[0]!.metrics;
    expect(metrics.t0).toBe(5);
    expect(Object.keys(metrics)).toHaveLength(1);
  });
});
