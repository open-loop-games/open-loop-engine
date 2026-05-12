import { describe, it, expect } from 'vitest';
import type { Engine } from '@/index';
import { runWaypointProbe } from '@/harness';

/** Minimal engine whose counter advances one tick per simulateTick(dt) call. */
function buildTickCounterEngine(state: { tick: number; simTime: number }): Engine {
  const engine = {
    loop: {
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
});
