import { describe, it, expect } from 'vitest';
import { createResource } from '@/core/resource';
import { runHeadless } from '@/core/headless';
import { createResourcePeakAnalyzer } from '@/harness/analyzers/resource-peak';

describe('createResourcePeakAnalyzer', () => {
  it('tracks peak, final, and avg across a deterministic sample trajectory', () => {
    const gold = createResource(0, { id: 'gold', displayName: 'gold' });
    const tracker = createResourcePeakAnalyzer(gold);

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
      iterations: 10,
    });

    const metrics = result.analyzerSummaries[0]!.metrics;
    expect(metrics.peak).toBe(5);
    expect(metrics.final).toBe(0);
    expect(metrics.avg).toBeCloseTo(2.5, 10);
  });

  it('analyzer name is keyed by resource id, so a shared displayName never merges', () => {
    const prestige = createResource(0, { id: 'prestige-points', displayName: 'Points' });
    const transcend = createResource(0, { id: 'transcend-points', displayName: 'Points' });
    expect(createResourcePeakAnalyzer(prestige).id).toBe('resource-peak:prestige-points');
    expect(createResourcePeakAnalyzer(transcend).id).toBe('resource-peak:transcend-points');
  });

  it('zero-tick run reports the start-of-run value for all three metrics', () => {
    const gold = createResource(42, { id: 'gold', displayName: 'gold' });
    const tracker = createResourcePeakAnalyzer(gold);

    const result = runHeadless({
      setup: () => [tracker],
      tick: () => {},
      iterations: 0,
    });

    const metrics = result.analyzerSummaries[0]!.metrics;
    expect(metrics.peak).toBe(42);
    expect(metrics.final).toBe(42);
    expect(metrics.avg).toBe(42);
  });

  it('resets state between sequential runs of the same instance', () => {
    const gold = createResource(0, { id: 'gold', displayName: 'gold' });
    const tracker = createResourcePeakAnalyzer(gold);

    runHeadless({
      setup: () => {
        gold.value = 100;
        return [tracker];
      },
      tick: () => {},
      iterations: 1,
    });
    const result = runHeadless({
      setup: () => {
        gold.value = 5;
        return [tracker];
      },
      tick: () => {},
      iterations: 1,
    });

    expect(result.analyzerSummaries[0]!.metrics.peak).toBe(5);
  });
});
