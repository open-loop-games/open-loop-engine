import { describe, it, expect } from 'vitest';
import { createResource } from '@/core/resource';
import { runHeadless } from '@/core/headless';
import { createResourcePeakTracker } from '@/harness/analyzers/resource-peak';

describe('createResourcePeakTracker', () => {
  it('tracks peak, final, and avg across a deterministic sample trajectory', () => {
    const gold = createResource(0, { id: 'gold', displayName: 'gold' });
    const tracker = createResourcePeakTracker(gold);

    let tick = 0;
    const trajectory = [1, 2, 3, 4, 5, 4, 3, 2, 1, 0];

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
      ticks: 10,
    });

    const metrics = result.analyzerResults[0]!.metrics;
    expect(metrics.peak).toBe(5);
    expect(metrics.final).toBe(0);
    expect(metrics.avg).toBeCloseTo(2.5, 10);
  });

  it('analyzer name is namespaced by displayName to prevent key collision', () => {
    const gold = createResource(0, { id: 'gold', displayName: 'gold' });
    const gems = createResource(0, { id: 'gems', displayName: 'gems' });

    expect(createResourcePeakTracker(gold).name).toBe('resource-peak:gold');
    expect(createResourcePeakTracker(gems).name).toBe('resource-peak:gems');
  });

  it('zero-tick run reports the start-of-run value for all three metrics', () => {
    const gold = createResource(42, { id: 'gold', displayName: 'gold' });
    const tracker = createResourcePeakTracker(gold);

    const result = runHeadless({
      setup: () => [tracker],
      tick: () => {},
      ticks: 0,
    });

    const metrics = result.analyzerResults[0]!.metrics;
    expect(metrics.peak).toBe(42);
    expect(metrics.final).toBe(42);
    expect(metrics.avg).toBe(42);
  });

  it('resets state between sequential runs of the same instance', () => {
    const gold = createResource(0, { id: 'gold', displayName: 'gold' });
    const tracker = createResourcePeakTracker(gold);

    runHeadless({
      setup: () => {
        gold.value = 100;
        return [tracker];
      },
      tick: () => {},
      ticks: 1,
    });
    const result = runHeadless({
      setup: () => {
        gold.value = 5;
        return [tracker];
      },
      tick: () => {},
      ticks: 1,
    });

    expect(result.analyzerResults[0]!.metrics.peak).toBe(5);
  });
});
