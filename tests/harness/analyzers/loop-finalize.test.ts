import { describe, it, expect } from 'vitest';
import { addResource, createResource } from '@/core/resource';
import { runHeadless } from '@/core/headless';
import { createLoop } from '@/systems/loop';
import { createLoopLog, type LoopLogEntry } from '@/systems/loop-log';
import { createLoopFinalizeTracker } from '@/harness/analyzers/loop-finalize';

describe('createLoopFinalizeTracker', () => {
  it('records loop count + last-loop deltas when wired via log.on(finalize, ...)', () => {
    const gold = createResource(0, { displayName: 'gold' });
    const tracker = createLoopFinalizeTracker();

    let loopTickHandler: ((dt: number) => void) | null = null;
    let loopCount = 0;

    const loop = createLoop({
      endCondition: () => true,
      thingsToReset: [gold],
      registerTick: (cb) => {
        loopTickHandler = cb;
        return () => {
          loopTickHandler = null;
        };
      },
    });
    const log = createLoopLog({ loop, metrics: { gold } });

    const result = runHeadless({
      setup: () => {
        log.on('finalize', (entry) => tracker.onLoopFinalize?.(entry));
        loop.run();
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
    expect(metrics.loops).toBe(3);
    expect(metrics['last.gold.end']).toBe(30);
    expect(metrics['last.gold.delta']).toBe(30);
  });

  it('reports loops: 0 and no per-key metrics when no LoopLog is bound', () => {
    const tracker = createLoopFinalizeTracker();

    const result = runHeadless({
      setup: () => [tracker],
      tick: () => {},
      ticks: 5,
    });

    const metrics = result.analyzerResults[0]!.metrics;
    expect(metrics.loops).toBe(0);
    expect(Object.keys(metrics)).toEqual(['loops']);
  });

  it('onStart resets loop count between sequential runs of the same instance', () => {
    const tracker = createLoopFinalizeTracker();
    const fakeEntry: LoopLogEntry = {
      loopNumber: 0,
      elapsed: 0,
      timestamp: 0,
      deltas: [],
      context: {},
      pinned: false,
    };

    tracker.onStart?.();
    tracker.onLoopFinalize!(fakeEntry);
    tracker.onLoopFinalize!(fakeEntry);
    expect(tracker.summarize().metrics.loops).toBe(2);

    tracker.onStart?.();
    tracker.onLoopFinalize!(fakeEntry);
    expect(tracker.summarize().metrics.loops).toBe(1);
  });
});
