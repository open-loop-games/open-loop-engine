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

function makeQueue(opts: { id?: string; maxAdvancesPerTick?: number } = {}) {
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

  it('does not interfere with normal sequencer operation within cap', () => {
    const q = makeQueue({ maxAdvancesPerTick: 100 });
    const completed: string[] = [];
    q.on('complete', (item) => completed.push(item.id));

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
