import { describe, it, expect } from 'vitest';
import type { Engine } from '@/index';
import { runBeatProbe } from '@/harness';
import type { Beat } from '@/harness';

/** Minimal engine shaped object whose counter advances one tick per advanceTime. */
function buildTickCounterEngine(state: { tick: number }): Engine {
  const engine = {
    tickDriver: {
      advanceTime: (_dt: number) => {
        state.tick += 1;
      },
    },
    // Used by the beat predicate via closure; attach state reference for clarity.
    __state: state,
  };
  return engine as unknown as Engine;
}

describe('runBeatProbe', () => {
  it('fires predicate once the counter crosses the threshold (stats over all seeds)', () => {
    const sinks = new Map<number, { tick: number }>();
    const beat: Beat = {
      id: 'fires-at-5',
      predicate: (engine) => (engine as unknown as { __state: { tick: number } }).__state.tick >= 5,
    };

    const results = runBeatProbe({
      buildEngine: ({ seed }) => {
        const state = { tick: 0 };
        sinks.set(seed, state);
        return buildTickCounterEngine(state);
      },
      beats: [beat],
      seeds: [1, 2, 3],
      maxSimTime: 100,
      tickDelta: 1,
    });

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.beatId).toBe('fires-at-5');
    expect(r.counts).toEqual({ predicate: 3, maxSimTime: 0, unreachable: 0 });
    expect(r.terminationTime).toBeDefined();
    // tickDelta=1s, predicate fires at tick 5 → simTime 5s.
    expect(r.terminationTime!.p50).toBeCloseTo(5, 5);
  });

  it('runs teardown once per (beat × seed) on the engine it built', () => {
    const built: Engine[] = [];
    const torn: [Engine, number][] = [];
    runBeatProbe({
      buildEngine: () => {
        const engine = buildTickCounterEngine({ tick: 0 });
        built.push(engine);
        return engine;
      },
      teardown: (engine, { seed }) => torn.push([engine, seed]),
      beats: [
        { id: 'a', predicate: () => true },
        { id: 'b', predicate: () => true },
      ],
      seeds: [1, 2],
      maxSimTime: 10,
    });
    expect(torn).toEqual([
      [built[0], 1],
      [built[1], 2],
      [built[2], 1],
      [built[3], 2],
    ]);
  });

  it('preserves beat order and counts runs that hit maxSimTime', () => {
    const neverFires: Beat = { id: 'never', predicate: () => false };
    const firesAt3: Beat = {
      id: 'at-3',
      predicate: (engine) => (engine as unknown as { __state: { tick: number } }).__state.tick >= 3,
    };

    const results = runBeatProbe({
      buildEngine: () => buildTickCounterEngine({ tick: 0 }),
      beats: [neverFires, firesAt3],
      seeds: [1, 2],
      maxSimTime: 10,
      tickDelta: 1,
    });

    expect(results).toHaveLength(2);
    expect(results[0]!.beatId).toBe('never');
    expect(results[0]!.counts).toEqual({ predicate: 0, maxSimTime: 2, unreachable: 0 });
    expect(results[0]!.terminationTime).toBeUndefined();

    expect(results[1]!.beatId).toBe('at-3');
    expect(results[1]!.counts).toEqual({ predicate: 2, maxSimTime: 0, unreachable: 0 });
    expect(results[1]!.terminationTime!.p50).toBeCloseTo(3, 5);
  });

  it('populates inTuningWindow when the beat carries a tuningWindow', () => {
    const inside: Beat = {
      id: 'inside',
      predicate: (engine) => (engine as unknown as { __state: { tick: number } }).__state.tick >= 5,
      tuningWindow: [4, 6],
    };
    const outside: Beat = {
      id: 'outside',
      predicate: (engine) => (engine as unknown as { __state: { tick: number } }).__state.tick >= 5,
      tuningWindow: [10, 20],
    };
    const noWindow: Beat = {
      id: 'no-window',
      predicate: (engine) => (engine as unknown as { __state: { tick: number } }).__state.tick >= 5,
    };

    const results = runBeatProbe({
      buildEngine: () => buildTickCounterEngine({ tick: 0 }),
      beats: [inside, outside, noWindow],
      seeds: [1],
      maxSimTime: 100,
      tickDelta: 1,
    });

    expect(results[0]!.inTuningWindow).toBe(true);
    expect(results[0]!.tuningWindow).toEqual([4, 6]);
    expect(results[1]!.inTuningWindow).toBe(false);
    expect(results[1]!.tuningWindow).toEqual([10, 20]);
    expect(results[2]!.inTuningWindow).toBeUndefined();
    expect(results[2]!.tuningWindow).toBeUndefined();
  });
});
