import { describe, it, expect } from 'vitest';
import { bn } from '@/primitives/decimal';
import { Decimal } from '@/primitives/decimal';
import { createResource, addResource } from '@/core/resource';
import { persistent, beginPersistentContext, endPersistentContext } from '@/core/persistence';
import { createLoop } from '@/systems/loop';
import { createLoopLog, isLoopLog } from '@/systems/loop-log';
import type { LoopLogEntry } from '@/systems/loop-log';
import type { Analyzer } from '@/primitives/types';
import { runHeadless } from '@/core/headless';

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

describe('createLoopLog', () => {
  // ==========================================================================
  // Delta computation
  // ==========================================================================

  it('produces zero deltas when nothing changes', () => {
    const { registerTick } = createTickManager();
    beginPersistentContext('ll-zero');
    const gold = createResource(bn(0), { displayName: 'Gold' });
    endPersistentContext();

    const loop = createLoop({ thingsToReset: [gold], registerTick });
    const log = createLoopLog({ loop, metrics: { gold } });

    loop.end();

    expect(log.history.value).toHaveLength(1);
    const delta = log.history.value[0].deltas[0];
    expect(delta.key).toBe('gold');
    expect(delta.delta.eq(0)).toBe(true);
  });

  it('computes correct delta for a Persistent ref', () => {
    const { registerTick } = createTickManager();
    beginPersistentContext('ll-ref');
    const gold = createResource(bn(0), { displayName: 'Gold' });
    endPersistentContext();

    const loop = createLoop({ thingsToReset: [gold], registerTick });
    const log = createLoopLog({ loop, metrics: { gold } });

    addResource(gold, 50);
    loop.end();

    const delta = log.history.value[0].deltas[0];
    expect(delta.start.eq(0)).toBe(true);
    expect(delta.end.eq(50)).toBe(true);
    expect(delta.delta.eq(50)).toBe(true);
  });

  it('computes correct delta for a getter function', () => {
    const { registerTick } = createTickManager();
    let counter = 0;

    const loop = createLoop({ thingsToReset: [], registerTick });
    const log = createLoopLog({
      loop,
      metrics: { counter: () => counter },
    });

    counter = 100;
    loop.end();

    const delta = log.history.value[0].deltas[0];
    expect(delta.start.eq(0)).toBe(true);
    expect(delta.end.eq(100)).toBe(true);
    expect(delta.delta.eq(100)).toBe(true);
  });

  it('captures permanent stat growth (metric not in thingsToReset)', () => {
    const { registerTick } = createTickManager();
    beginPersistentContext('ll-perm');
    const temp = createResource(bn(0), { displayName: 'Temp' });
    const permStat = persistent<number>(10);
    endPersistentContext();

    const loop = createLoop({ thingsToReset: [temp], registerTick });
    const log = createLoopLog({
      loop,
      metrics: { permStat },
    });

    // permStat grows during the loop but is NOT reset
    permStat.value = 25;
    loop.end();

    const delta = log.history.value[0].deltas[0];
    expect(delta.start.eq(10)).toBe(true);
    expect(delta.end.eq(25)).toBe(true);
    expect(delta.delta.eq(15)).toBe(true);
  });

  it('resetting resource: delta is pre-reset accumulated value', () => {
    const { registerTick } = createTickManager();
    beginPersistentContext('ll-reset-res');
    const gold = createResource(bn(0), { displayName: 'Gold' });
    endPersistentContext();

    const loop = createLoop({ thingsToReset: [gold], registerTick });
    const log = createLoopLog({ loop, metrics: { gold } });

    addResource(gold, 200);
    loop.end();

    // Delta should reflect the 200 gained before reset
    expect(log.history.value[0].deltas[0].delta.eq(200)).toBe(true);
    // After restart, gold is back to 0 (reset happened)
    expect(gold.value.eq(0)).toBe(true);
  });

  // ==========================================================================
  // Consecutive loops
  // ==========================================================================

  it('consecutive loops produce independent deltas', () => {
    const { registerTick } = createTickManager();
    beginPersistentContext('ll-consec');
    const gold = createResource(bn(0), { displayName: 'Gold' });
    endPersistentContext();

    const loop = createLoop({ thingsToReset: [gold], registerTick });
    const log = createLoopLog({ loop, metrics: { gold } });

    // Loop 0: earn 50
    addResource(gold, 50);
    loop.end();

    // Loop 1: earn 120
    addResource(gold, 120);
    loop.end();

    expect(log.history.value).toHaveLength(2);
    expect(log.history.value[0].deltas[0].delta.eq(50)).toBe(true);
    expect(log.history.value[1].deltas[0].delta.eq(120)).toBe(true);
  });

  it('loopNumber is loop.count before increment', () => {
    const { registerTick } = createTickManager();

    const loop = createLoop({ thingsToReset: [], registerTick });
    const log = createLoopLog({ loop, metrics: {} });

    loop.end(); // count was 0 at beforeRestart
    loop.end(); // count was 1 at beforeRestart

    expect(log.history.value[0].loopNumber).toBe(0);
    expect(log.history.value[1].loopNumber).toBe(1);
  });

  it('elapsed reflects loop.elapsed at finalize time', () => {
    const { registerTick, tick } = createTickManager();

    const loop = createLoop({ thingsToReset: [], registerTick });
    const log = createLoopLog({ loop, metrics: {} });

    loop.run();
    tick(3.5);
    loop.end();

    expect(log.history.value[0].elapsed).toBeCloseTo(3.5);
  });

  // ==========================================================================
  // Ring buffer and pinning
  // ==========================================================================

  it('prunes oldest unpinned beyond maxLogs', () => {
    const { registerTick } = createTickManager();

    const loop = createLoop({ thingsToReset: [], registerTick });
    const log = createLoopLog({ loop, metrics: {}, maxLogs: 3 });

    for (let i = 0; i < 5; i++) loop.end();

    expect(log.history.value).toHaveLength(3);
    // Oldest remaining should be loop 2 (loops 0 and 1 pruned)
    expect(log.history.value[0].loopNumber).toBe(2);
  });

  it('pinned entries survive pruning', () => {
    const { registerTick } = createTickManager();

    const loop = createLoop({ thingsToReset: [], registerTick });
    const log = createLoopLog({ loop, metrics: {}, maxLogs: 2 });

    loop.end(); // entry 0
    log.pin(0); // pin it
    loop.end(); // entry 1
    loop.end(); // entry 2
    loop.end(); // entry 3 — should prune unpinned, keeping pinned + 2 newest unpinned

    // Pinned entry (loop 0) + 2 most recent unpinned
    expect(log.history.value.some((e) => e.loopNumber === 0 && e.pinned)).toBe(true);
    const unpinned = log.history.value.filter((e) => !e.pinned);
    expect(unpinned).toHaveLength(2);
  });

  it('unpin allows entry to be pruned', () => {
    const { registerTick } = createTickManager();

    const loop = createLoop({ thingsToReset: [], registerTick });
    const log = createLoopLog({ loop, metrics: {}, maxLogs: 2 });

    loop.end(); // entry 0
    log.pin(0);
    loop.end(); // entry 1
    loop.end(); // entry 2 — pinned entry survives

    expect(log.history.value.some((e) => e.loopNumber === 0)).toBe(true);

    log.unpin(0);
    loop.end(); // entry 3 — now entry 0 can be pruned

    expect(log.history.value.some((e) => e.loopNumber === 0)).toBe(false);
  });

  it('pin/unpin out-of-bounds are no-ops', () => {
    const { registerTick } = createTickManager();

    const loop = createLoop({ thingsToReset: [], registerTick });
    const log = createLoopLog({ loop, metrics: {} });

    // Should not throw
    log.pin(-1);
    log.pin(999);
    log.unpin(-1);
    log.unpin(999);

    expect(log.history.value).toHaveLength(0);
  });

  // ==========================================================================
  // finalize event
  // ==========================================================================

  it('emits finalize event with correct entry', () => {
    const { registerTick } = createTickManager();
    beginPersistentContext('ll-event');
    const gold = createResource(bn(0), { displayName: 'Gold' });
    endPersistentContext();

    const loop = createLoop({ thingsToReset: [gold], registerTick });
    const log = createLoopLog({ loop, metrics: { gold } });

    const received: LoopLogEntry[] = [];
    log.on('finalize', (entry) => received.push(entry));

    addResource(gold, 42);
    loop.end();

    expect(received).toHaveLength(1);
    expect(received[0]).toStrictEqual(log.history.value[0]);
    expect(received[0].deltas[0].delta.eq(42)).toBe(true);
  });

  it('finalize fires before afterRestart snapshot', () => {
    const { registerTick } = createTickManager();
    beginPersistentContext('ll-finalize-order');
    const gold = createResource(bn(0), { displayName: 'Gold' });
    endPersistentContext();

    const loop = createLoop({ thingsToReset: [gold], registerTick });
    const log = createLoopLog({ loop, metrics: { gold } });

    let goldAtFinalize: Decimal | null = null;
    log.on('finalize', () => {
      // At finalize time, gold hasn't been reset yet (beforeRestart fires before reset)
      goldAtFinalize = new Decimal(gold.value);
    });

    addResource(gold, 75);
    loop.end();

    expect(goldAtFinalize!.eq(75)).toBe(true);
  });

  // ==========================================================================
  // dispose
  // ==========================================================================

  it('dispose stops recording entries', () => {
    const { registerTick } = createTickManager();

    const loop = createLoop({ thingsToReset: [], registerTick });
    const log = createLoopLog({ loop, metrics: {} });

    loop.end();
    expect(log.history.value).toHaveLength(1);

    log.dispose();
    loop.end();
    loop.end();

    expect(log.history.value).toHaveLength(1);
  });

  // ==========================================================================
  // Context enrichment
  // ==========================================================================

  it('setContext attaches data to the finalized entry', () => {
    const { registerTick } = createTickManager();

    const loop = createLoop({ thingsToReset: [], registerTick });
    const log = createLoopLog({ loop, metrics: {} });

    log.setContext('spell', { id: 'fireball', hits: 3 });
    log.setContext('result', 'success');
    loop.end();

    const entry = log.history.value[0];
    expect(entry.context).toEqual({ spell: { id: 'fireball', hits: 3 }, result: 'success' });
  });

  it('context resets after each loop restart', () => {
    const { registerTick } = createTickManager();

    const loop = createLoop({ thingsToReset: [], registerTick });
    const log = createLoopLog({ loop, metrics: {} });

    log.setContext('tag', 'loop-0');
    loop.end();

    // Second loop — no setContext calls
    loop.end();

    expect(log.history.value[0].context).toEqual({ tag: 'loop-0' });
    expect(log.history.value[1].context).toEqual({});
  });

  it('setContext overwrites previous value for same key', () => {
    const { registerTick } = createTickManager();

    const loop = createLoop({ thingsToReset: [], registerTick });
    const log = createLoopLog({ loop, metrics: {} });

    log.setContext('count', 1);
    log.setContext('count', 5);
    loop.end();

    expect(log.history.value[0].context).toEqual({ count: 5 });
  });

  it('finalized entry context is a snapshot (not a live reference)', () => {
    const { registerTick } = createTickManager();

    const loop = createLoop({ thingsToReset: [], registerTick });
    const log = createLoopLog({ loop, metrics: {} });

    log.setContext('val', 'before');
    loop.end();

    // Mutating after finalize should not affect the stored entry
    log.setContext('val', 'after');
    expect(log.history.value[0].context).toEqual({ val: 'before' });
  });

  it('entries without setContext calls have empty context', () => {
    const { registerTick } = createTickManager();

    const loop = createLoop({ thingsToReset: [], registerTick });
    const log = createLoopLog({ loop, metrics: {} });

    loop.end();
    expect(log.history.value[0].context).toEqual({});
  });

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  it('empty metrics record produces entry with empty deltas', () => {
    const { registerTick } = createTickManager();

    const loop = createLoop({ thingsToReset: [], registerTick });
    const log = createLoopLog({ loop, metrics: {} });

    loop.end();

    expect(log.history.value).toHaveLength(1);
    expect(log.history.value[0].deltas).toHaveLength(0);
  });

  it('handles large Decimal values without precision loss', () => {
    const { registerTick } = createTickManager();
    beginPersistentContext('ll-big');
    const big = createResource(bn(0), { displayName: 'Big' });
    endPersistentContext();

    const loop = createLoop({ thingsToReset: [big], registerTick });
    const log = createLoopLog({ loop, metrics: { big } });

    addResource(big, bn('1e308'));
    loop.end();

    expect(log.history.value[0].deltas[0].delta.eq(bn('1e308'))).toBe(true);
  });

  // ==========================================================================
  // Analyzer wiring via log.on('finalize', ...)
  // ==========================================================================

  it('log.on(finalize, ...) delivers one onLoopFinalize call per loop over a headless run', () => {
    const entries: LoopLogEntry[] = [];
    const loopAnalyzer: Analyzer = {
      name: 'loop-counter',
      onLoopFinalize: (entry) => entries.push(entry as LoopLogEntry),
      summarize: () => ({
        name: 'loop-counter',
        metrics: { loops: entries.length },
      }),
    };

    // Separate tick-only analyzer to verify coexistence with loop-aware analyzers
    let tickCount = 0;
    const tickAnalyzer: Analyzer = {
      name: 'ticker',
      onTick: () => {
        tickCount++;
      },
      summarize: () => ({ name: 'ticker', metrics: { ticks: tickCount } }),
    };

    const { registerTick } = createTickManager();
    beginPersistentContext('ll-headless-analyzer');
    const gold = createResource(bn(0), { displayName: 'Gold' });
    endPersistentContext();

    const loop = createLoop({ thingsToReset: [gold], registerTick });
    const log = createLoopLog({ loop, metrics: { gold } });
    log.on('finalize', (entry) => loopAnalyzer.onLoopFinalize?.(entry));

    // Drive 3 loops: each tick adds gold, every 2 ticks end a loop
    const result = runHeadless({
      setup: () => [loopAnalyzer, tickAnalyzer],
      tick: () => {
        addResource(gold, 10);
        if (tickCount % 2 === 1) loop.end();
      },
      ticks: 6,
    });

    expect(entries).toHaveLength(3);
    expect(entries[0].loopNumber).toBe(0);
    expect(entries[0].deltas[0].delta.eq(20)).toBe(true);
    expect(tickCount).toBe(6);
    expect(result.analyzerResults[0].metrics.loops).toBe(3);
    expect(result.analyzerResults[1].metrics.ticks).toBe(6);
  });

  it('unsubscribe returned by log.on removes the finalize subscription', () => {
    const entries: LoopLogEntry[] = [];
    const analyzer: Analyzer = {
      name: 'x',
      onLoopFinalize: (entry) => entries.push(entry as LoopLogEntry),
      summarize: () => ({ name: 'x', metrics: {} }),
    };

    const { registerTick } = createTickManager();
    const loop = createLoop({ thingsToReset: [], registerTick });
    const log = createLoopLog({ loop, metrics: {} });
    const dispose = log.on('finalize', (entry) => analyzer.onLoopFinalize?.(entry));

    loop.end();
    expect(entries).toHaveLength(1);

    dispose();
    loop.end();
    expect(entries).toHaveLength(1);
  });

  it('isLoopLog type guard', () => {
    const { registerTick } = createTickManager();

    const loop = createLoop({ thingsToReset: [], registerTick });
    const log = createLoopLog({ loop, metrics: {} });

    expect(isLoopLog(log)).toBe(true);
    expect(isLoopLog({})).toBe(false);
    expect(isLoopLog(null)).toBe(false);
    expect(isLoopLog(loop)).toBe(false);
  });
});
