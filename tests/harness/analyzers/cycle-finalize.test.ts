import { describe, it, expect } from 'vitest';
import { addResource, createResource } from '@/core/resource';
import { runHeadless } from '@/core/headless';
import { createCycle } from '@/systems/cycle';
import { createCycleLog, type CycleLogEntry } from '@/systems/cycle-log';
import { createCycleFinalizeTracker } from '@/harness/analyzers/cycle-finalize';

describe('createCycleFinalizeTracker', () => {
  it('records cycle count + last-cycle deltas when wired via log.on(finalized, ...)', () => {
    const gold = createResource(0, { id: 'gold', displayName: 'gold' });
    const tracker = createCycleFinalizeTracker();

    let loopTickHandler: ((dt: number) => void) | null = null;
    let loopCount = 0;

    const cycle = createCycle({
      endCondition: () => true,
      thingsToReset: [gold],
      registerTick: (cb) => {
        loopTickHandler = cb;
        return () => {
          loopTickHandler = null;
        };
      },
    });
    const log = createCycleLog({ cycle, metrics: { gold } });

    const result = runHeadless({
      setup: () => {
        log.on('finalized', (entry) => tracker.onCycleFinalize?.(entry));
        cycle.run();
        return [tracker];
      },
      tick: (dt) => {
        loopCount += 1;
        addResource(gold, loopCount * 10);
        loopTickHandler?.(dt);
      },
      ticks: 3,
    });

    const metrics = result.analyzerResults[0]!.metrics;
    expect(metrics.cycles).toBe(3);
    expect(metrics['last.gold.end']).toBe(30);
    expect(metrics['last.gold.delta']).toBe(30);
  });

  it('reports cycles: 0 and no per-key metrics when no CycleLog is bound', () => {
    const tracker = createCycleFinalizeTracker();

    const result = runHeadless({
      setup: () => [tracker],
      tick: () => {},
      ticks: 5,
    });

    const metrics = result.analyzerResults[0]!.metrics;
    expect(metrics.cycles).toBe(0);
    expect(Object.keys(metrics)).toEqual(['cycles']);
  });

  it('onStart resets cycle count between sequential runs of the same instance', () => {
    const tracker = createCycleFinalizeTracker();
    const fakeEntry: CycleLogEntry = {
      cycleNumber: 0,
      elapsed: 0,
      timestamp: 0,
      deltas: [],
      context: {},
      pinned: false,
    };

    tracker.onStart?.();
    tracker.onCycleFinalize!(fakeEntry);
    tracker.onCycleFinalize!(fakeEntry);
    expect(tracker.summarize().metrics.cycles).toBe(2);

    tracker.onStart?.();
    tracker.onCycleFinalize!(fakeEntry);
    expect(tracker.summarize().metrics.cycles).toBe(1);
  });
});
