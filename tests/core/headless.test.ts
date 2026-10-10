import { describe, it, expect } from 'vitest';
import type { Analyzer } from '@/primitives/types';
import { runHeadless } from '@/core/headless';
import { random } from '@/primitives/rng';
import { enableTracing, isTracing } from '@/core/trace';

describe('Headless Runner', () => {
  it('runs specified number of ticks', () => {
    let count = 0;
    runHeadless({
      setup: () => [],
      tick: () => {
        count++;
      },
      ticks: 100,
    });
    expect(count).toBe(100);
  });
  it('passes correct delta time', () => {
    const deltas: number[] = [];
    runHeadless({
      setup: () => [],
      tick: (dt) => {
        deltas.push(dt);
      },
      ticks: 5,
      tickDelta: 0.1,
    });
    expect(deltas.every((d) => d === 0.1)).toBe(true);
  });
  it('uses default tickDelta of 0.05', () => {
    const deltas: number[] = [];
    runHeadless({
      setup: () => [],
      tick: (dt) => {
        deltas.push(dt);
      },
      ticks: 1,
    });
    expect(deltas[0]).toBe(0.05);
  });
  it('seeds RNG when seed provided', () => {
    const v1: number[] = [],
      v2: number[] = [];
    runHeadless({
      setup: () => [],
      tick: () => {
        v1.push(random());
      },
      ticks: 5,
      seed: 42,
    });
    runHeadless({
      setup: () => [],
      tick: () => {
        v2.push(random());
      },
      ticks: 5,
      seed: 42,
    });
    expect(v1).toEqual(v2);
  });
  it('calls analyzer lifecycle hooks', () => {
    const events: string[] = [];
    const analyzer: Analyzer = {
      id: 'test',
      onStart: () => events.push('start'),
      onTick: (t) => events.push(`tick-${t}`),
      onEnd: () => events.push('end'),
      summarize: () => ({ id: 'test', metrics: {} }),
    };
    const result = runHeadless({ setup: () => [analyzer], tick: () => {}, ticks: 3 });
    expect(events).toEqual(['start', 'tick-0', 'tick-1', 'tick-2', 'end']);
    expect(result.analyzerSummaries).toHaveLength(1);
  });
  it('calls setup before first tick', () => {
    const order: string[] = [];
    runHeadless({
      setup: () => {
        order.push('setup');
        return [];
      },
      tick: () => order.push('tick'),
      ticks: 1,
    });
    expect(order).toEqual(['setup', 'tick']);
  });
  it('runs setup before onStart so analyzers see post-setup engine state', () => {
    const order: string[] = [];
    const analyzer: Analyzer = {
      id: 'test',
      onStart: () => order.push('onStart'),
      onTick: () => order.push('tick'),
      onEnd: () => order.push('onEnd'),
      summarize: () => ({ id: 'test', metrics: {} }),
    };
    runHeadless({
      setup: () => {
        order.push('setup');
        return [analyzer];
      },
      tick: () => {},
      ticks: 1,
    });
    expect(order).toEqual(['setup', 'onStart', 'tick', 'onEnd']);
  });
  it('returns elapsed time', () => {
    const r = runHeadless({ setup: () => [], tick: () => {}, ticks: 100, tickDelta: 0.05 });
    expect(r.totalTicks).toBe(100);
    expect(r.elapsedSimulated).toBeCloseTo(5, 5);
  });
  it('runs teardown once the analyzers have summarized', () => {
    const calls: string[] = [];
    runHeadless({
      setup: () => [
        { id: 'a', summarize: () => (calls.push('summarize'), { id: 'a', metrics: {} }) },
      ],
      tick: () => {},
      ticks: 1,
      teardown: () => calls.push('teardown'),
    });
    expect(calls).toEqual(['summarize', 'teardown']);
  });
  it('runs teardown and closes the trace tick window when the run throws', () => {
    const stopTracing = enableTracing();
    try {
      let teardowns = 0;
      expect(() =>
        runHeadless({
          setup: () => [],
          tick: () => {
            throw new Error('tick blew up');
          },
          ticks: 1,
          teardown: () => teardowns++,
        }),
      ).toThrow('tick blew up');
      expect(isTracing()).toBe(false);
      expect(() =>
        runHeadless({
          setup: () => [
            {
              id: 'a',
              summarize: () => {
                throw new Error('analyzer blew up');
              },
            },
          ],
          tick: () => {},
          ticks: 1,
          teardown: () => teardowns++,
        }),
      ).toThrow('analyzer blew up');
      expect(teardowns).toBe(2);
    } finally {
      stopTracing();
    }
  });
  it('skips teardown when setup itself throws', () => {
    let teardowns = 0;
    expect(() =>
      runHeadless({
        setup: () => {
          throw new Error('setup blew up');
        },
        tick: () => {},
        ticks: 1,
        teardown: () => teardowns++,
      }),
    ).toThrow('setup blew up');
    expect(teardowns).toBe(0);
  });
});
