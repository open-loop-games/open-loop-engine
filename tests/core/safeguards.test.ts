import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEmitHandle, DEFAULT_MAX_EMIT_DEPTH } from '@/core/events';
import { createSequencer, type SequencerItem } from '@/core/sequencer';
import {
  enableDevMode,
  disableDevMode,
  isDevMode,
  getDiagnostics,
  resetDiagnostics,
} from '@/core/safeguards';
import { beginPersistentContext, endPersistentContext } from '@/core/persistence';

const qi = (id: string): SequencerItem<void> => ({ id, metadata: undefined as void });

function makeQueue(
  opts: {
    id?: string;
    mode?: 'queue' | 'list';
    maxAdvancesPerTick?: number;
    startOnEnqueue?: boolean;
  } = {},
) {
  const ctxId = opts.id ?? `q-${Math.random().toString(36).slice(2, 8)}`;
  beginPersistentContext(ctxId);
  const q = createSequencer({ id: ctxId, ...opts });
  endPersistentContext();
  return q;
}

beforeEach(() => {
  resetDiagnostics();
  disableDevMode();
});

// ============================================================================
// Emit depth limit
// ============================================================================

describe('emit depth limit', () => {
  interface TestEvents {
    ping: () => void;
  }

  it('blocks recursive emit chains beyond default depth', () => {
    const handle = createEmitHandle<TestEvents>();
    let calls = 0;

    handle.on('ping', () => {
      calls++;
      handle.emit('ping'); // recursive
    });

    handle.emit('ping');

    // First call + (DEFAULT_MAX_EMIT_DEPTH - 1) recursive calls = DEFAULT_MAX_EMIT_DEPTH
    expect(calls).toBe(DEFAULT_MAX_EMIT_DEPTH);
  });

  it('respects custom maxEmitDepth', () => {
    const handle = createEmitHandle<TestEvents>({ maxEmitDepth: 3 });
    let calls = 0;

    handle.on('ping', () => {
      calls++;
      handle.emit('ping');
    });

    handle.emit('ping');
    expect(calls).toBe(3);
  });

  it('recovers after a blocked chain — depth resets', () => {
    const handle = createEmitHandle<TestEvents>({ maxEmitDepth: 2 });
    let calls = 0;

    handle.on('ping', () => {
      calls++;
      handle.emit('ping');
    });

    handle.emit('ping');
    expect(calls).toBe(2);

    // Should work again — depth counter reset
    calls = 0;
    handle.emit('ping');
    expect(calls).toBe(2);
  });

  it('records trip in diagnostics', () => {
    const handle = createEmitHandle<TestEvents>({ maxEmitDepth: 1 });

    handle.on('ping', () => {
      handle.emit('ping');
    });

    handle.emit('ping');

    const diag = getDiagnostics();
    expect(diag.emitDepthTrips).toBe(1);
    expect(diag.lastEmitDepthEvent).toBe('ping');
  });

  it('does not block non-recursive emits', () => {
    interface MultiEvents {
      a: () => void;
      b: () => void;
    }
    const handle = createEmitHandle<MultiEvents>({ maxEmitDepth: 2 });
    const order: string[] = [];

    handle.on('a', () => {
      order.push('a');
      handle.emit('b');
    });
    handle.on('b', () => {
      order.push('b');
    });

    handle.emit('a');
    expect(order).toEqual(['a', 'b']);
  });
});

// ============================================================================
// Sequencer advance cap
// ============================================================================

describe('sequencer advance cap', () => {
  it('caps advances per tick', () => {
    const q = makeQueue({ maxAdvancesPerTick: 5 });

    // Enqueue more items than the cap
    for (let i = 0; i < 10; i++) {
      q.enqueue(qi(`item-${i}`));
    }

    // First item auto-started on enqueue, consuming 1 advance.
    // Now complete repeatedly — should stop after cap
    for (let i = 0; i < 10; i++) {
      q.complete();
    }

    const diag = getDiagnostics();
    expect(diag.advanceCapTrips).toBeGreaterThan(0);
  });

  it('resets after resetAdvanceCount', () => {
    const q = makeQueue({ maxAdvancesPerTick: 3 });

    for (let i = 0; i < 10; i++) {
      q.enqueue(qi(`item-${i}`));
    }

    // Exhaust the cap
    for (let i = 0; i < 5; i++) {
      q.complete();
    }

    const before = getDiagnostics();
    expect(before.advanceCapTrips).toBeGreaterThan(0);

    // Reset and try again — should advance
    q.resetAdvanceCount();

    q.complete();
    // After reset, complete should have advanced to next item
    // (or null if we ran out of items, but the cap shouldn't block it)
    const diagAfter = getDiagnostics();
    // The trip count should not have increased further after reset + single advance
    expect(diagAfter.advanceCapTrips).toBe(before.advanceCapTrips);
  });

  it('resets the cap each tick when driven via registerTick (B3)', () => {
    // A sequencer wired the recommended way — driven through registerTick —
    // must not let the per-tick cap silently latch into a lifetime budget.
    // Without an owned per-tick reset, cumulative advances across ticks exceed
    // the cap and dequeueNext returns null forever, permanently stalling the
    // queue (the B3 blocker). One item completes per tick here; cumulative
    // completes (15) far exceed the cap (3), so a lifetime counter would trip.
    const cbs = new Set<() => void>();
    const registerTick = (cb: () => void) => {
      cbs.add(cb);
      return () => cbs.delete(cb);
    };
    const fireTick = () => {
      for (const cb of [...cbs]) cb();
    };

    beginPersistentContext('b3');
    const q = createSequencer<void>({ id: 'b3', maxAdvancesPerTick: 3, registerTick });
    endPersistentContext();

    const started: string[] = [];
    q.on('started', (item) => started.push(item.id));

    for (let i = 0; i < 20; i++) q.enqueue(qi(`item-${i}`));

    for (let t = 0; t < 15; t++) {
      fireTick(); // start-of-tick reset zeroes the per-tick counter
      q.complete(); // completes current, advances to next
    }

    // The queue kept advancing every tick — never latched to null.
    expect(getDiagnostics().advanceCapTrips).toBe(0);
    expect(q.currentItem).not.toBeNull();
    // 1 auto-start on first enqueue + 15 per-tick advances.
    expect(started.length).toBe(16);
  });

  it('does not interfere with normal sequencer operation within cap', () => {
    const q = makeQueue({ maxAdvancesPerTick: 100 });
    const completed: string[] = [];
    q.on('completed', (item) => completed.push(item.id));

    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.enqueue(qi('c'));

    q.complete(); // complete a, start b
    q.complete(); // complete b, start c
    q.complete(); // complete c

    expect(completed).toEqual(['a', 'b', 'c']);
    expect(getDiagnostics().advanceCapTrips).toBe(0);
  });
});

// ============================================================================
// Instant-complete cascades — the two caps against a real emitter
// ============================================================================

// The emit-depth coverage above drives a bare `createEmitHandle`, where a
// blocked emit is the whole observable outcome. Inside a sequencer it is not:
// `dequeueNext` sets `current` and *then* emits `started`, so a dropped emit
// leaves an item dispatched that no listener ever learns about and nothing will
// ever complete. These drive the real emitter, where that distinction exists.

describe('instant-complete cascades', () => {
  /** Subscribe a `started` listener that immediately completes — the runaway shape. */
  function completeOnStart(q: ReturnType<typeof makeQueue>, log?: string[]) {
    q.on('started', (item) => {
      log?.push(item.id);
      q.complete();
    });
  }

  it('drains a queue-mode cascade past the emit-depth cap', () => {
    const q = makeQueue({ startOnEnqueue: false });
    const starts: string[] = [];
    const completes: string[] = [];
    completeOnStart(q, starts);
    q.on('completed', (item) => completes.push(item.id));

    for (let i = 0; i < 20; i++) q.enqueue(qi(`i${i}`));
    q.start();

    expect(starts).toHaveLength(20);
    expect(completes).toHaveLength(20);
    expect(q.items.value).toHaveLength(0);
    expect(q.currentItem).toBeNull();
    // Depth stays constant however long the cascade runs.
    expect(getDiagnostics().emitDepthTrips).toBe(0);
  });

  it('drains a list-mode cascade past the emit-depth cap', () => {
    const q = makeQueue({ mode: 'list', startOnEnqueue: false });
    const starts: string[] = [];
    completeOnStart(q, starts);

    for (let i = 0; i < 20; i++) q.enqueue(qi(`i${i}`));
    q.start();

    expect(starts).toHaveLength(20);
    expect(q.cursor).toBe(20);
    expect(q.currentItem).toBeNull();
    expect(getDiagnostics().emitDepthTrips).toBe(0);
  });

  it('drains a cascade routed through a second sequencer', () => {
    // Per-instance emit-depth counters cannot see a chain that alternates
    // between sequencers — each reads half the true stack cost. Flattening is
    // per-instance but covers this, since the cycle re-enters both.
    const a = makeQueue({ id: 'cross-a', startOnEnqueue: false });
    const b = makeQueue({ id: 'cross-b' });
    const log: string[] = [];
    let spawned = 0;

    a.on('started', (item) => {
      log.push(item.id);
      if (spawned < 30) b.enqueue(qi(`b${spawned++}`));
      a.complete();
    });
    b.on('started', (item) => {
      log.push(item.id);
      if (spawned < 30) a.enqueue(qi(`a${spawned++}`));
      b.complete();
    });

    a.enqueue(qi('seed'));
    a.start();

    expect(log).toHaveLength(31);
    expect(a.currentItem).toBeNull();
    expect(b.currentItem).toBeNull();
    expect(getDiagnostics().emitDepthTrips).toBe(0);
  });

  it('bounds a cascade by the advance cap, and resumes on the next tick', () => {
    const cbs = new Set<() => void>();
    const registerTick = (cb: () => void) => {
      cbs.add(cb);
      return () => cbs.delete(cb);
    };
    beginPersistentContext('cap-resume');
    const q = createSequencer<void>({
      id: 'cap-resume',
      startOnEnqueue: false,
      maxAdvancesPerTick: 1000,
      registerTick,
    });
    endPersistentContext();
    const starts: string[] = [];
    completeOnStart(q, starts);

    for (let i = 0; i < 2500; i++) q.enqueue(qi(`i${i}`));
    q.start();

    expect(starts).toHaveLength(1000);
    expect(getDiagnostics().advanceCapTrips).toBe(1);
    expect(getDiagnostics().emitDepthTrips).toBe(0);
    // Degraded, not wedged: nothing is left dispatched-but-unstarted.
    expect(q.currentItem).toBeNull();
    expect(q.items.value).toHaveLength(1500);

    // The tick boundary resets the counter and re-drives dispatch on its own.
    for (const cb of [...cbs]) cb();
    expect(starts).toHaveLength(2000);
    for (const cb of [...cbs]) cb();
    expect(starts).toHaveLength(2500);
    expect(q.items.value).toHaveLength(0);
  });

  it('bounds an unconditional repeat() by the advance cap', () => {
    // `repeat()` re-dispatches the same item forever. Flattened, that is a loop
    // rather than a stack overflow, so the advance cap is what ends it.
    const q = makeQueue({ startOnEnqueue: false, maxAdvancesPerTick: 1000 });
    let starts = 0;
    q.on('started', () => {
      starts++;
      q.repeat();
    });

    q.enqueue(qi('x'));
    q.start();

    expect(starts).toBe(1000);
    expect(getDiagnostics().advanceCapTrips).toBe(1);
  });

  it("defers a listener's dispatch until the emit unwinds", () => {
    // The observable edge of flattening: `complete()` inside a `started` listener
    // is a state transition, not a dispatch. Nothing is running when it returns.
    const q = makeQueue({ startOnEnqueue: false });
    const observed: (string | null)[] = [];
    let reentrantReturn: unknown = 'unset';

    q.on('started', (item) => {
      if (item.id !== 'first') return;
      q.complete();
      observed.push(q.currentItem?.id ?? null);
      reentrantReturn = q.dequeueNext();
    });

    q.enqueue(qi('first'));
    q.enqueue(qi('second'));
    q.start();

    expect(observed).toEqual([null]);
    expect(reentrantReturn).toBeNull();
    // The deferred dispatch still lands once the emit unwinds.
    expect(q.currentItem?.id).toBe('second');
  });
});

// ============================================================================
// Dev mode diagnostics
// ============================================================================

describe('dev mode diagnostics', () => {
  it('defaults to off', () => {
    expect(isDevMode()).toBe(false);
  });

  it('can be toggled', () => {
    enableDevMode();
    expect(isDevMode()).toBe(true);
    disableDevMode();
    expect(isDevMode()).toBe(false);
  });

  it('logs warning in dev mode when emit depth trips', () => {
    enableDevMode();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const handle = createEmitHandle<{ ping: () => void }>({ maxEmitDepth: 1 });
    handle.on('ping', () => handle.emit('ping'));
    handle.emit('ping');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[safeguard] Emit depth limit'));
    warnSpy.mockRestore();
  });

  it('does not log when dev mode is off', () => {
    disableDevMode();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const handle = createEmitHandle<{ ping: () => void }>({ maxEmitDepth: 1 });
    handle.on('ping', () => handle.emit('ping'));
    handle.emit('ping');

    expect(warnSpy).not.toHaveBeenCalled();
    // But diagnostics still recorded
    expect(getDiagnostics().emitDepthTrips).toBe(1);
    warnSpy.mockRestore();
  });

  it('resetDiagnostics clears all counters', () => {
    const handle = createEmitHandle<{ ping: () => void }>({ maxEmitDepth: 1 });
    handle.on('ping', () => handle.emit('ping'));
    handle.emit('ping');

    expect(getDiagnostics().emitDepthTrips).toBe(1);
    resetDiagnostics();
    expect(getDiagnostics().emitDepthTrips).toBe(0);
    expect(getDiagnostics().lastEmitDepthEvent).toBeNull();
  });
});
