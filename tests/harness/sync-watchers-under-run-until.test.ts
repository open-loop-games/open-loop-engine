import { describe, it, expect } from 'vitest';
import { createResource } from '@/core/resource';
import { beginPersistentContext, endPersistentContext } from '@/core/persistence';
import { createAchievement } from '@/systems/achievement';
import { runUntil } from '@/harness';
import type { Engine } from '@/index';

/**
 * Regression pins: engine primitives that internally use `watch()` must keep
 * firing under sim harnesses that drive `engine.loop.simulateTick(dt)` in a
 * tight loop. Vue's default async scheduler never flushes inside such a
 * loop — so `Resource.cumulative` / `Resource.best` and `createAchievement`
 * use `flush: 'sync'`.
 *
 * If these tests fail, a sim-driving consumer will silently observe stale
 * trackers / un-earned achievements.
 */

// Minimal engine shape runUntil needs — simulateTick is the only method it calls.
function buildStepEngine(onStep: () => void): Engine {
  return {
    loop: { simulateTick: (_dt: number) => onStep() },
  } as unknown as Engine;
}

describe('watch-based primitives under runUntil (sync flush)', () => {
  it('Resource.cumulative accumulates gains tick-by-tick, not at async flush time', () => {
    beginPersistentContext('sync-cumulative');
    const gold = createResource(0, { displayName: 'gold-total' });
    endPersistentContext();
    const total = gold.cumulative!;

    const trajectory = [5, 3, 8, 2, 10]; // absolute values; only increases count
    let i = 0;
    const engine = buildStepEngine(() => {
      if (i < trajectory.length) gold.value = trajectory[i]!;
      i += 1;
    });

    const result = runUntil({
      engine,
      until: ({ tick }) => tick >= 5,
      maxSimTime: 1,
      tickDelta: 0.05,
    });

    expect(result.terminated).toBe('predicate');
    // Increases: 0→5 (+5), 3→8 (+5), 2→10 (+8) = 18
    expect(Number(total.value)).toBe(18);
  });

  it('Resource.best observes the peak mid-run, not after the run ends', () => {
    beginPersistentContext('sync-best');
    const gold = createResource(0, { displayName: 'gold-best' });
    endPersistentContext();
    const best = gold.best!;

    let observedPeak = 0;
    const trajectory = [1, 7, 3, 5, 2];
    let i = 0;
    const engine = buildStepEngine(() => {
      if (i < trajectory.length) gold.value = trajectory[i]!;
      i += 1;
      // Sample best mid-run — proves the watcher fired synchronously, not at
      // the end.
      observedPeak = Math.max(observedPeak, Number(best.value));
    });

    runUntil({
      engine,
      until: ({ tick }) => tick >= 5,
      maxSimTime: 1,
      tickDelta: 0.05,
    });

    expect(observedPeak).toBe(7);
    expect(Number(best.value)).toBe(7);
  });

  it('createAchievement earns on the same tick its requirement first holds', () => {
    const score = createResource(0, { displayName: 'score' });
    const ach = createAchievement({
      id: 'score-100',
      display: { title: 'Hit 100' },
      requirement: () => Number(score.value) >= 100,
    });

    let earnedAtTick = -1;
    let tick = 0;
    const engine = buildStepEngine(() => {
      score.value = (tick + 1) * 20; // 20, 40, 60, 80, 100, ...
      tick += 1;
      if (ach.earned.value && earnedAtTick === -1) earnedAtTick = tick;
    });

    const result = runUntil({
      engine,
      until: () => ach.earned.value,
      maxSimTime: 1,
      tickDelta: 0.05,
    });

    expect(result.terminated).toBe('predicate');
    expect(ach.earned.value).toBe(true);
    // Score hits 100 on tick 5 (after stepOnce runs with tick=4 → sets 100).
    expect(earnedAtTick).toBe(5);
  });
});
