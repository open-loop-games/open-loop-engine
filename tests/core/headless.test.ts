import { describe, it, expect } from 'vitest';
import type { Analyzer } from '@/primitives/types';
import { runHeadless } from '@/core/headless';
import { random } from '@/primitives/rng';

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
      name: 'test',
      onStart: () => events.push('start'),
      onTick: (t) => events.push(`tick-${t}`),
      onEnd: () => events.push('end'),
      summarize: () => ({ name: 'test', metrics: {} }),
    };
    const result = runHeadless({ setup: () => [analyzer], tick: () => {}, ticks: 3 });
    expect(events).toEqual(['start', 'tick-0', 'tick-1', 'tick-2', 'end']);
    expect(result.analyzerResults).toHaveLength(1);
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
      name: 'test',
      onStart: () => order.push('onStart'),
      onTick: () => order.push('tick'),
      onEnd: () => order.push('onEnd'),
      summarize: () => ({ name: 'test', metrics: {} }),
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
        { name: 'a', summarize: () => (calls.push('summarize'), { name: 'a', metrics: {} }) },
      ],
      tick: () => {},
      ticks: 1,
      teardown: () => calls.push('teardown'),
    });
    expect(calls).toEqual(['summarize', 'teardown']);
  });
});
