import { describe, it, expect } from 'vitest';
import type { Engine } from '@/index';
import { random } from '@/primitives/rng';
import { runWaypointProbe } from '@/harness';

/** Minimal engine whose counter advances one tick per simulateTick(dt) call. */
function buildTickCounterEngine(state: { tick: number; simTime: number }): Engine {
  const engine = {
    tickDriver: {
      simulateTick: (dt: number) => {
        state.tick += 1;
        state.simTime += dt;
      },
    },
    __state: state,
  };
  return engine as unknown as Engine;
}

describe('runWaypointProbe', () => {
  it('reaches each waypoint and calls inspect at the snapshot time', () => {
    const states: Array<{ tick: number; simTime: number }> = [];
    const snapshots = runWaypointProbe({
      buildEngine: () => {
        const state = { tick: 0, simTime: 0 };
        states.push(state);
        return buildTickCounterEngine(state);
      },
      waypoints: [
        { id: 'beat-1', snapshotAtSec: 5 },
        { id: 'beat-2', snapshotAtSec: 10 },
      ],
      inspect: (engine) => ({
        tick: (engine as unknown as { __state: { tick: number } }).__state.tick,
      }),
    });

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]!.waypointId).toBe('beat-1');
    expect(snapshots[0]!.reachedTarget).toBe(true);
    expect(snapshots[0]!.snapshotSimTime).toBeGreaterThanOrEqual(5);
    expect(snapshots[1]!.waypointId).toBe('beat-2');
    expect(snapshots[1]!.snapshot.tick).toBeGreaterThan(snapshots[0]!.snapshot.tick);
  });

  it('snapshots on the tick that lands on the waypoint, not the one after', () => {
    // 3 × 0.3 accumulates to 0.8999999999999999, a rounding error short of 0.9.
    const snapshots = runWaypointProbe({
      buildEngine: () => buildTickCounterEngine({ tick: 0, simTime: 0 }),
      waypoints: [{ id: 'on-tick', snapshotAtSec: 0.9 }],
      inspect: (engine) => (engine as unknown as { __state: { tick: number } }).__state.tick,
      tickDelta: 0.3,
    });
    expect(snapshots[0]!.snapshot).toBe(3);
    expect(snapshots[0]!.snapshotSimTime).toBeCloseTo(0.9, 12);
    expect(snapshots[0]!.reachedTarget).toBe(true);
  });

  it('honors a custom seeds list, emitting one snapshot per (waypoint × seed)', () => {
    const seenSeeds: number[] = [];
    const snapshots = runWaypointProbe({
      buildEngine: ({ seed }) => {
        seenSeeds.push(seed);
        return buildTickCounterEngine({ tick: 0, simTime: 0 });
      },
      waypoints: [{ id: 'w1', snapshotAtSec: 3 }],
      inspect: () => null,
      seeds: [10, 20, 30],
    });

    expect(snapshots).toHaveLength(3);
    expect(snapshots.map((s) => s.seed)).toEqual([10, 20, 30]);
    expect(seenSeeds).toEqual([10, 20, 30]);
  });

  it('seeds the RNG before buildEngine, so every waypoint builds the same engine per seed', () => {
    const draws: number[] = [];
    runWaypointProbe({
      buildEngine: () => {
        draws.push(random());
        return buildTickCounterEngine({ tick: 0, simTime: 0 });
      },
      waypoints: [
        { id: 'w1', snapshotAtSec: 1 },
        { id: 'w2', snapshotAtSec: 2 },
      ],
      inspect: () => null,
      seeds: [5],
    });
    expect(draws).toHaveLength(2);
    expect(draws[1]).toBe(draws[0]);
  });

  it("delegates each run's lifecycle to runMatrixUntil: stop, inspect, then teardown on the engine inspect saw", () => {
    const events: string[] = [];
    let built = 0;
    const buildEngine = () => {
      const id = built++;
      return {
        id,
        tickDriver: { simulateTick: () => {} },
        stop: () => events.push(`stop:${id}`),
      } as unknown as Engine;
    };
    const idOf = (engine: Engine) => (engine as unknown as { id: number }).id;
    runWaypointProbe({
      buildEngine,
      waypoints: [{ id: 'w1', snapshotAtSec: 1 }],
      inspect: (engine) => events.push(`inspect:${idOf(engine)}`),
      teardown: (engine, { seed }) => events.push(`teardown:${idOf(engine)}:${seed}`),
      seeds: [1, 2],
    });
    expect(events).toEqual([
      'stop:0',
      'inspect:0',
      'teardown:0:1',
      'stop:1',
      'inspect:1',
      'teardown:1:2',
    ]);

    events.length = 0;
    expect(() =>
      runWaypointProbe({
        buildEngine,
        waypoints: [{ id: 'w2', snapshotAtSec: 1 }],
        inspect: (engine) => {
          events.push(`inspect:${idOf(engine)}`);
          throw new Error('inspect failed');
        },
        teardown: (engine) => events.push(`teardown:${idOf(engine)}`),
      }),
    ).toThrow('inspect failed');
    expect(events).toEqual(['stop:2', 'inspect:2', 'teardown:2']);
  });
});
