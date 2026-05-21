import { describe, it, expect, vi } from 'vitest';
import { bn } from '@/primitives/decimal';
import { Decimal } from '@/primitives/decimal';
import { createResource, addResource } from '@/core/resource';
import { beginPersistentContext, endPersistentContext } from '@/core/persistence';
import { createLoop } from '@/systems/loop';
import { createLoopLog } from '@/systems/loop-log';
import { createBestOf } from '@/systems/best-of';
import type { BestOfEntry } from '@/systems/best-of';

/** Simple tick manager matching the existing test pattern */
function createTickManager() {
  const callbacks: ((dt: number) => void)[] = [];
  return {
    registerTick(cb: (dt: number) => void) {
      callbacks.push(cb);
      return () => {
        const idx = callbacks.indexOf(cb);
        if (idx >= 0) callbacks.splice(idx, 1);
      };
    },
    tick(dt: number) {
      for (const cb of callbacks) cb(dt);
    },
  };
}

describe('createBestOf', () => {
  // ==========================================================================
  // Submission and comparison
  // ==========================================================================

  it('manual submit sets a best for an empty metric', () => {
    const bestOf = createBestOf({
      id: 'bo-empty',
      metrics: { gold: { mode: 'absolute' } },
    });

    bestOf.submit({ key: 'gold', value: 100, elapsed: 10, loopNumber: 0 });

    const entry = bestOf.entries.value.gold;
    expect(entry).not.toBeNull();
    expect(entry!.value.eq(100)).toBe(true);
    expect(entry!.status).toBe('valid');
  });

  it('lower absolute value does not replace existing best', () => {
    const bestOf = createBestOf({
      id: 'bo-lower',
      metrics: { gold: { mode: 'absolute' } },
    });

    bestOf.submit({ key: 'gold', value: 100, elapsed: 10, loopNumber: 0 });
    bestOf.submit({ key: 'gold', value: 50, elapsed: 5, loopNumber: 1 });

    expect(bestOf.entries.value.gold!.value.eq(100)).toBe(true);
    expect(bestOf.entries.value.gold!.loopNumber).toBe(0);
  });

  it('higher absolute value replaces best and emits newBest', () => {
    const bestOf = createBestOf({
      id: 'bo-higher',
      metrics: { gold: { mode: 'absolute' } },
    });

    const received: { key: string; entry: BestOfEntry }[] = [];
    bestOf.on('newBest', (key, entry) => received.push({ key, entry }));

    bestOf.submit({ key: 'gold', value: 100, elapsed: 10, loopNumber: 0 });
    bestOf.submit({ key: 'gold', value: 200, elapsed: 20, loopNumber: 1 });

    expect(bestOf.entries.value.gold!.value.eq(200)).toBe(true);
    expect(received).toHaveLength(2); // both submissions were new bests
    expect(received[1].entry.value.eq(200)).toBe(true);
  });

  it('perSecond mode: shorter time with same delta wins', () => {
    const bestOf = createBestOf({
      id: 'bo-ps-shorter',
      metrics: { gold: { mode: 'perSecond' } },
    });

    bestOf.submit({ key: 'gold', value: 100, elapsed: 10, loopNumber: 0 }); // 10/s
    bestOf.submit({ key: 'gold', value: 100, elapsed: 5, loopNumber: 1 }); // 20/s

    expect(bestOf.entries.value.gold!.loopNumber).toBe(1);
    expect(bestOf.entries.value.gold!.perSecond.eq(20)).toBe(true);
  });

  it('perSecond mode: same delta but longer elapsed loses', () => {
    const bestOf = createBestOf({
      id: 'bo-ps-longer',
      metrics: { gold: { mode: 'perSecond' } },
    });

    bestOf.submit({ key: 'gold', value: 100, elapsed: 5, loopNumber: 0 }); // 20/s
    bestOf.submit({ key: 'gold', value: 100, elapsed: 10, loopNumber: 1 }); // 10/s

    expect(bestOf.entries.value.gold!.loopNumber).toBe(0);
  });

  // ==========================================================================
  // LoopLog integration
  // ==========================================================================

  it('auto-subscribes to LoopLog finalize events', () => {
    const { registerTick, tick } = createTickManager();
    beginPersistentContext('bo-ll-auto');
    const gold = createResource(bn(0), { displayName: 'Gold' });
    endPersistentContext();

    const loop = createLoop({ thingsToReset: [gold], registerTick });
    const log = createLoopLog({ loop, metrics: { gold } });
    const bestOf = createBestOf({
      id: 'bo-ll-auto',
      metrics: { gold: { mode: 'absolute' } },
      loopLog: log,
    });

    loop.run();
    addResource(gold, 50);
    tick(5);
    loop.end();

    expect(bestOf.entries.value.gold).not.toBeNull();
    expect(bestOf.entries.value.gold!.value.eq(50)).toBe(true);
  });

  it('ignores LoopLog deltas for unregistered metric keys', () => {
    const { registerTick } = createTickManager();
    beginPersistentContext('bo-ll-ignore');
    const gold = createResource(bn(0), { displayName: 'Gold' });
    endPersistentContext();

    const loop = createLoop({ thingsToReset: [gold], registerTick });
    const log = createLoopLog({ loop, metrics: { gold } });
    const bestOf = createBestOf({
      id: 'bo-ll-ignore',
      metrics: { xp: { mode: 'absolute' } }, // tracks xp, not gold
      loopLog: log,
    });

    addResource(gold, 100);
    loop.end();

    expect(bestOf.entries.value.xp).toBeNull();
  });

  it('tracks multiple metrics from a single LoopLog finalize', () => {
    const { registerTick, tick } = createTickManager();
    beginPersistentContext('bo-ll-multi');
    const gold = createResource(bn(0), { displayName: 'Gold' });
    const xp = createResource(bn(0), { displayName: 'XP' });
    endPersistentContext();

    const loop = createLoop({ thingsToReset: [gold, xp], registerTick });
    const log = createLoopLog({ loop, metrics: { gold, xp } });
    const bestOf = createBestOf({
      id: 'bo-ll-multi',
      metrics: {
        gold: { mode: 'absolute' },
        xp: { mode: 'perSecond' },
      },
      loopLog: log,
    });

    loop.run();
    addResource(gold, 100);
    addResource(xp, 50);
    tick(10);
    loop.end();

    expect(bestOf.entries.value.gold!.value.eq(100)).toBe(true);
    expect(bestOf.entries.value.xp!.perSecond.eq(5)).toBe(true);
  });

  // ==========================================================================
  // Projection
  // ==========================================================================

  it('stores projected value when project function is provided', () => {
    const bestOf = createBestOf({
      id: 'bo-proj-store',
      metrics: {
        strength: {
          mode: 'absolute',
          project: (observed) => Decimal.mul(observed, 0.1), // 10% retention
        },
      },
    });

    bestOf.submit({ key: 'strength', value: 200, elapsed: 10, loopNumber: 0 });

    const entry = bestOf.entries.value.strength!;
    expect(entry.value.eq(200)).toBe(true);
    expect(entry.projected!.eq(20)).toBe(true);
  });

  it('projected is undefined when no project function', () => {
    const bestOf = createBestOf({
      id: 'bo-proj-none',
      metrics: { gold: { mode: 'absolute' } },
    });

    bestOf.submit({ key: 'gold', value: 100, elapsed: 10, loopNumber: 0 });
    expect(bestOf.entries.value.gold!.projected).toBeUndefined();
  });

  it('compares by projected value by default when project exists', () => {
    const bestOf = createBestOf({
      id: 'bo-proj-compare',
      metrics: {
        strength: {
          mode: 'absolute',
          // Higher observed doesn't mean higher projected
          project: (observed) => {
            // Diminishing returns: sqrt
            return Decimal.sqrt(observed);
          },
        },
      },
    });

    // sqrt(100) = 10
    bestOf.submit({ key: 'strength', value: 100, elapsed: 10, loopNumber: 0 });
    // sqrt(81) = 9 — lower projected, should NOT replace
    bestOf.submit({ key: 'strength', value: 81, elapsed: 5, loopNumber: 1 });

    expect(bestOf.entries.value.strength!.loopNumber).toBe(0);

    // sqrt(121) = 11 — higher projected, SHOULD replace
    bestOf.submit({ key: 'strength', value: 121, elapsed: 20, loopNumber: 2 });

    expect(bestOf.entries.value.strength!.loopNumber).toBe(2);
  });

  it('compareBy: observed ignores projection for ranking', () => {
    const bestOf = createBestOf({
      id: 'bo-proj-observed',
      metrics: {
        strength: {
          mode: 'absolute',
          project: (observed) => Decimal.sqrt(observed),
          compareBy: 'observed',
        },
      },
    });

    bestOf.submit({ key: 'strength', value: 100, elapsed: 10, loopNumber: 0 });
    // Higher observed value wins even though projected might differ
    bestOf.submit({ key: 'strength', value: 200, elapsed: 10, loopNumber: 1 });

    expect(bestOf.entries.value.strength!.loopNumber).toBe(1);
    // But projected is still stored for display
    expect(bestOf.entries.value.strength!.projected!.eq(Decimal.sqrt(200))).toBe(true);
  });

  it('projection works with perSecond mode', () => {
    const bestOf = createBestOf({
      id: 'bo-proj-ps',
      metrics: {
        strength: {
          mode: 'perSecond',
          project: (observed) => Decimal.mul(observed, 0.1),
        },
      },
    });

    // projected=10, elapsed=10 → 1/s
    bestOf.submit({ key: 'strength', value: 100, elapsed: 10, loopNumber: 0 });
    // projected=10, elapsed=5 → 2/s — wins on projected per second
    bestOf.submit({ key: 'strength', value: 100, elapsed: 5, loopNumber: 1 });

    expect(bestOf.entries.value.strength!.loopNumber).toBe(1);
  });

  // ==========================================================================
  // Invalidation
  // ==========================================================================

  it('invalidate marks entry as stale but preserves data', () => {
    const bestOf = createBestOf({
      id: 'bo-inv-stale',
      metrics: { gold: { mode: 'absolute' } },
    });

    bestOf.submit({ key: 'gold', value: 100, elapsed: 10, loopNumber: 0 });
    bestOf.invalidate('gold');

    const entry = bestOf.entries.value.gold!;
    expect(entry.status).toBe('stale');
    expect(entry.value.eq(100)).toBe(true);
  });

  it('any submission beats a stale entry', () => {
    const bestOf = createBestOf({
      id: 'bo-inv-beat',
      metrics: { gold: { mode: 'absolute' } },
    });

    bestOf.submit({ key: 'gold', value: 100, elapsed: 10, loopNumber: 0 });
    bestOf.invalidate('gold');
    bestOf.submit({ key: 'gold', value: 1, elapsed: 10, loopNumber: 1 }); // worse value, but stale

    expect(bestOf.entries.value.gold!.value.eq(1)).toBe(true);
    expect(bestOf.entries.value.gold!.status).toBe('valid');
  });

  it('invalidateAll marks all entries stale', () => {
    const bestOf = createBestOf({
      id: 'bo-inv-all',
      metrics: { gold: { mode: 'absolute' }, xp: { mode: 'absolute' } },
    });

    bestOf.submit({ key: 'gold', value: 100, elapsed: 10, loopNumber: 0 });
    bestOf.submit({ key: 'xp', value: 50, elapsed: 10, loopNumber: 0 });
    bestOf.invalidateAll();

    expect(bestOf.entries.value.gold!.status).toBe('stale');
    expect(bestOf.entries.value.xp!.status).toBe('stale');
  });

  it('clear removes an entry entirely', () => {
    const bestOf = createBestOf({
      id: 'bo-clear',
      metrics: { gold: { mode: 'absolute' } },
    });

    bestOf.submit({ key: 'gold', value: 100, elapsed: 10, loopNumber: 0 });
    bestOf.clear('gold');

    expect(bestOf.entries.value.gold).toBeNull();
  });

  it('clearAll removes all entries', () => {
    const bestOf = createBestOf({
      id: 'bo-clear-all',
      metrics: { gold: { mode: 'absolute' }, xp: { mode: 'absolute' } },
    });

    bestOf.submit({ key: 'gold', value: 100, elapsed: 10, loopNumber: 0 });
    bestOf.submit({ key: 'xp', value: 50, elapsed: 10, loopNumber: 0 });
    bestOf.clearAll();

    expect(bestOf.entries.value.gold).toBeNull();
    expect(bestOf.entries.value.xp).toBeNull();
  });

  // ==========================================================================
  // Strategy snapshots
  // ==========================================================================

  it('captureStrategy is called on new best', () => {
    const capture = vi.fn(() => ({ queue: ['mine', 'smelt'] }));
    const bestOf = createBestOf({
      id: 'bo-snap-capture',
      metrics: { gold: { mode: 'absolute' } },
      captureStrategy: capture,
    });

    bestOf.submit({ key: 'gold', value: 100, elapsed: 10, loopNumber: 0 });

    expect(capture).toHaveBeenCalledOnce();
    expect(bestOf.entries.value.gold!.strategySnapshot).toEqual({ queue: ['mine', 'smelt'] });
  });

  it('strategySnapshot is undefined when captureStrategy not provided', () => {
    const bestOf = createBestOf({
      id: 'bo-snap-none',
      metrics: { gold: { mode: 'absolute' } },
    });

    bestOf.submit({ key: 'gold', value: 100, elapsed: 10, loopNumber: 0 });

    expect(bestOf.entries.value.gold!.strategySnapshot).toBeUndefined();
  });

  it('manual snapshot overrides captureStrategy', () => {
    const capture = vi.fn(() => ({ queue: ['auto'] }));
    const bestOf = createBestOf({
      id: 'bo-snap-override',
      metrics: { gold: { mode: 'absolute' } },
      captureStrategy: capture,
    });

    bestOf.submit({
      key: 'gold',
      value: 100,
      elapsed: 10,
      loopNumber: 0,
      strategySnapshot: { queue: ['manual'] },
    });

    expect(capture).not.toHaveBeenCalled();
    expect(bestOf.entries.value.gold!.strategySnapshot).toEqual({ queue: ['manual'] });
  });

  // ==========================================================================
  // Persistence
  // ==========================================================================

  it('Decimal values round-trip through string serialization', () => {
    const bestOf = createBestOf({
      id: 'bo-roundtrip',
      metrics: { gold: { mode: 'absolute' } },
    });

    bestOf.submit({ key: 'gold', value: bn('1.5e308'), elapsed: 10, loopNumber: 0 });

    const entry = bestOf.entries.value.gold!;
    expect(entry.value.eq(bn('1.5e308'))).toBe(true);
    expect(entry.perSecond.eq(Decimal.div('1.5e308', 10))).toBe(true);
  });

  // ==========================================================================
  // Events
  // ==========================================================================

  it('newBest fires with correct key and entry', () => {
    const bestOf = createBestOf({
      id: 'bo-event-fire',
      metrics: { gold: { mode: 'absolute' } },
    });

    const received: { key: string; entry: BestOfEntry }[] = [];
    bestOf.on('newBest', (key, entry) => received.push({ key, entry }));

    bestOf.submit({ key: 'gold', value: 100, elapsed: 10, loopNumber: 0 });

    expect(received).toHaveLength(1);
    expect(received[0].key).toBe('gold');
    expect(received[0].entry.value.eq(100)).toBe(true);
  });

  it('newBest does not fire when submission loses', () => {
    const bestOf = createBestOf({
      id: 'bo-event-nofire',
      metrics: { gold: { mode: 'absolute' } },
    });

    bestOf.submit({ key: 'gold', value: 100, elapsed: 10, loopNumber: 0 });

    const received: unknown[] = [];
    bestOf.on('newBest', (key, entry) => received.push({ key, entry }));

    bestOf.submit({ key: 'gold', value: 50, elapsed: 5, loopNumber: 1 });

    expect(received).toHaveLength(0);
  });

  it('newBest fires when replacing a stale entry', () => {
    const bestOf = createBestOf({
      id: 'bo-event-stale',
      metrics: { gold: { mode: 'absolute' } },
    });

    bestOf.submit({ key: 'gold', value: 100, elapsed: 10, loopNumber: 0 });
    bestOf.invalidate('gold');

    const received: unknown[] = [];
    bestOf.on('newBest', (key, entry) => received.push({ key, entry }));

    bestOf.submit({ key: 'gold', value: 1, elapsed: 10, loopNumber: 1 });

    expect(received).toHaveLength(1);
  });

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  it('zero elapsed produces Infinity perSecond', () => {
    const bestOf = createBestOf({
      id: 'bo-zero-elapsed',
      metrics: { gold: { mode: 'perSecond' } },
    });

    bestOf.submit({ key: 'gold', value: 100, elapsed: 0, loopNumber: 0 });

    expect(bestOf.entries.value.gold!.perSecond.eq(Infinity)).toBe(true);
  });

  it('submitting to unknown metric key is a no-op', () => {
    const bestOf = createBestOf({
      id: 'bo-unknown-key',
      metrics: { gold: { mode: 'absolute' } },
    });

    const received: unknown[] = [];
    bestOf.on('newBest', (key, entry) => received.push({ key, entry }));

    bestOf.submit({ key: 'silver', value: 100, elapsed: 10, loopNumber: 0 });

    expect(received).toHaveLength(0);
  });

  it('dispose stops auto-tracking from LoopLog', () => {
    const { registerTick } = createTickManager();
    beginPersistentContext('bo-dispose');
    const gold = createResource(bn(0), { displayName: 'Gold' });
    endPersistentContext();

    const loop = createLoop({ thingsToReset: [gold], registerTick });
    const log = createLoopLog({ loop, metrics: { gold } });
    const bestOf = createBestOf({
      id: 'bo-dispose',
      metrics: { gold: { mode: 'absolute' } },
      loopLog: log,
    });

    addResource(gold, 50);
    loop.end();
    expect(bestOf.entries.value.gold!.value.eq(50)).toBe(true);

    bestOf.dispose();

    addResource(gold, 200);
    loop.end();
    // Still 50 — disposed, so the second finalize was not tracked
    expect(bestOf.entries.value.gold!.value.eq(50)).toBe(true);
  });
});
