import { describe, it, expect } from 'vitest';
import { bn } from '@/primitives/decimal';
import { Decimal } from '@/primitives/decimal';
import { createResource, addResource } from '@/core/resource';
import {
  persistent,
  beginPersistentContext,
  endPersistentContext,
  deserializePersistents,
  getAllPersistentRefs,
  withPersistentContext,
} from '@/core/persistence';
import { createReset } from '@/systems/reset';
import { createCycle } from '@/systems/cycle';
import { createCycleLog } from '@/systems/cycle-log';
import type { CycleLogEntry } from '@/systems/cycle-log';
import type { Analyzer } from '@/primitives/types';
import { runHeadless } from '@/core/headless';
import { createManualTicks } from '../helpers/manual-ticks';
import { saveAndClear } from '../helpers/save-roundtrip';

describe('createCycleLog', () => {
  // ==========================================================================
  // Delta computation
  // ==========================================================================

  it('produces zero deltas when nothing changes', () => {
    const { registerTick } = createManualTicks();
    beginPersistentContext('ll-zero');
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();

    const cycle = createCycle({ thingsToReset: [gold], registerTick });
    const log = createCycleLog({ cycle, metrics: { gold } });

    cycle.end();

    expect(log.history.value).toHaveLength(1);
    const delta = log.history.value[0].deltas[0];
    expect(delta.key).toBe('gold');
    expect(delta.delta.eq(0)).toBe(true);
  });

  it('computes correct delta for a Persistent ref', () => {
    const { registerTick } = createManualTicks();
    beginPersistentContext('ll-ref');
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();

    const cycle = createCycle({ thingsToReset: [gold], registerTick });
    const log = createCycleLog({ cycle, metrics: { gold } });

    addResource(gold, 50);
    cycle.end();

    const delta = log.history.value[0].deltas[0];
    expect(delta.start.eq(0)).toBe(true);
    expect(delta.end.eq(50)).toBe(true);
    expect(delta.delta.eq(50)).toBe(true);
  });

  it('computes correct delta for a getter function', () => {
    const { registerTick } = createManualTicks();
    let counter = 0;

    const cycle = createCycle({ thingsToReset: [], registerTick });
    const log = createCycleLog({
      cycle,
      metrics: { counter: () => counter },
    });

    counter = 100;
    cycle.end();

    const delta = log.history.value[0].deltas[0];
    expect(delta.start.eq(0)).toBe(true);
    expect(delta.end.eq(100)).toBe(true);
    expect(delta.delta.eq(100)).toBe(true);
  });

  it('captures permanent stat growth (metric not in thingsToReset)', () => {
    const { registerTick } = createManualTicks();
    beginPersistentContext('ll-perm');
    const temp = createResource(bn(0), { id: 'Temp', displayName: 'Temp' });
    const permStat = persistent<number>(10);
    endPersistentContext();

    const cycle = createCycle({ thingsToReset: [temp], registerTick });
    const log = createCycleLog({
      cycle,
      metrics: { permStat },
    });

    // permStat grows during the cycle but is NOT reset
    permStat.value = 25;
    cycle.end();

    const delta = log.history.value[0].deltas[0];
    expect(delta.start.eq(10)).toBe(true);
    expect(delta.end.eq(25)).toBe(true);
    expect(delta.delta.eq(15)).toBe(true);
  });

  it('resetting resource: delta is pre-reset accumulated value', () => {
    const { registerTick } = createManualTicks();
    beginPersistentContext('ll-reset-res');
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();

    const cycle = createCycle({ thingsToReset: [gold], registerTick });
    const log = createCycleLog({ cycle, metrics: { gold } });

    addResource(gold, 200);
    cycle.end();

    // Delta should reflect the 200 gained before reset
    expect(log.history.value[0].deltas[0].delta.eq(200)).toBe(true);
    // After restart, gold is back to 0 (reset happened)
    expect(gold.value.eq(0)).toBe(true);
  });

  // ==========================================================================
  // Consecutive cycles
  // ==========================================================================

  it('consecutive cycles produce independent deltas', () => {
    const { registerTick } = createManualTicks();
    beginPersistentContext('ll-consec');
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();

    const cycle = createCycle({ thingsToReset: [gold], registerTick });
    const log = createCycleLog({ cycle, metrics: { gold } });

    // Cycle 0: earn 50
    addResource(gold, 50);
    cycle.end();

    // Cycle 1: earn 120
    addResource(gold, 120);
    cycle.end();

    expect(log.history.value).toHaveLength(2);
    expect(log.history.value[0].deltas[0].delta.eq(50)).toBe(true);
    expect(log.history.value[1].deltas[0].delta.eq(120)).toBe(true);
  });

  it('runNumber is cycle.count before increment', () => {
    const { registerTick } = createManualTicks();

    const cycle = createCycle({ thingsToReset: [], registerTick });
    const log = createCycleLog({ cycle, metrics: {} });

    cycle.end(); // count was 0 at beforeEnd
    cycle.end(); // count was 1 at beforeEnd

    expect(log.history.value[0].runNumber).toBe(0);
    expect(log.history.value[1].runNumber).toBe(1);
  });

  it('elapsed reflects cycle.elapsed at finalize time', () => {
    const { registerTick, tick } = createManualTicks();

    const cycle = createCycle({ thingsToReset: [], registerTick });
    const log = createCycleLog({ cycle, metrics: {} });

    cycle.resume();
    tick(3.5);
    cycle.end();

    expect(log.history.value[0].elapsed).toBeCloseTo(3.5);
  });

  // ==========================================================================
  // Ring buffer and pinning
  // ==========================================================================

  it('prunes oldest unpinned beyond maxLogs', () => {
    const { registerTick } = createManualTicks();

    const cycle = createCycle({ thingsToReset: [], registerTick });
    const log = createCycleLog({ cycle, metrics: {}, maxLogs: 3 });

    for (let i = 0; i < 5; i++) cycle.end();

    expect(log.history.value).toHaveLength(3);
    // Oldest remaining should be cycle 2 (cycles 0 and 1 pruned)
    expect(log.history.value[0].runNumber).toBe(2);
  });

  it('pinned entries survive pruning', () => {
    const { registerTick } = createManualTicks();

    const cycle = createCycle({ thingsToReset: [], registerTick });
    const log = createCycleLog({ cycle, metrics: {}, maxLogs: 2 });

    cycle.end(); // entry 0
    log.pin(0); // pin it
    cycle.end(); // entry 1
    cycle.end(); // entry 2
    cycle.end(); // entry 3 — should prune unpinned, keeping pinned + 2 newest unpinned

    // Pinned entry (cycle 0) + 2 most recent unpinned
    expect(log.history.value.some((e) => e.runNumber === 0 && e.pinned)).toBe(true);
    const unpinned = log.history.value.filter((e) => !e.pinned);
    expect(unpinned).toHaveLength(2);
  });

  it('unpin allows entry to be pruned', () => {
    const { registerTick } = createManualTicks();

    const cycle = createCycle({ thingsToReset: [], registerTick });
    const log = createCycleLog({ cycle, metrics: {}, maxLogs: 2 });

    cycle.end(); // entry 0
    log.pin(0);
    cycle.end(); // entry 1
    cycle.end(); // entry 2 — pinned entry survives

    expect(log.history.value.some((e) => e.runNumber === 0)).toBe(true);

    log.unpin(0);
    cycle.end(); // entry 3 — now entry 0 can be pruned

    expect(log.history.value.some((e) => e.runNumber === 0)).toBe(false);
  });

  it('pin/unpin out-of-bounds are no-ops', () => {
    const { registerTick } = createManualTicks();

    const cycle = createCycle({ thingsToReset: [], registerTick });
    const log = createCycleLog({ cycle, metrics: {} });

    // Should not throw
    log.pin(-1);
    log.pin(999);
    log.unpin(-1);
    log.unpin(999);

    expect(log.history.value).toHaveLength(0);
  });

  // ==========================================================================
  // finalized event
  // ==========================================================================

  it('emits finalized event with correct entry', () => {
    const { registerTick } = createManualTicks();
    beginPersistentContext('ll-event');
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();

    const cycle = createCycle({ thingsToReset: [gold], registerTick });
    const log = createCycleLog({ cycle, metrics: { gold } });

    const received: CycleLogEntry[] = [];
    log.on('finalized', (entry) => received.push(entry));

    addResource(gold, 42);
    cycle.end();

    expect(received).toHaveLength(1);
    expect(received[0]).toStrictEqual(log.history.value[0]);
    expect(received[0].deltas[0].delta.eq(42)).toBe(true);
  });

  it('finalized fires before afterEnd snapshot', () => {
    const { registerTick } = createManualTicks();
    beginPersistentContext('ll-finalize-order');
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();

    const cycle = createCycle({ thingsToReset: [gold], registerTick });
    const log = createCycleLog({ cycle, metrics: { gold } });

    let goldAtFinalize: Decimal | null = null;
    log.on('finalized', () => {
      // At finalize time, gold hasn't been reset yet (beforeEnd fires before reset)
      goldAtFinalize = new Decimal(gold.value);
    });

    addResource(gold, 75);
    cycle.end();

    expect(goldAtFinalize!.eq(75)).toBe(true);
  });

  // ==========================================================================
  // dispose
  // ==========================================================================

  it('dispose stops recording entries', () => {
    const { registerTick } = createManualTicks();

    const cycle = createCycle({ thingsToReset: [], registerTick });
    const log = createCycleLog({ cycle, metrics: {} });

    cycle.end();
    expect(log.history.value).toHaveLength(1);

    log.dispose();
    cycle.end();
    cycle.end();

    expect(log.history.value).toHaveLength(1);
  });

  // ==========================================================================
  // Context enrichment
  // ==========================================================================

  it('annotate attaches data to the finalized entry', () => {
    const { registerTick } = createManualTicks();

    const cycle = createCycle({ thingsToReset: [], registerTick });
    const log = createCycleLog({ cycle, metrics: {} });

    log.annotate('spell', { id: 'fireball', hits: 3 });
    log.annotate('result', 'success');
    cycle.end();

    const entry = log.history.value[0];
    expect(entry.annotations).toEqual({ spell: { id: 'fireball', hits: 3 }, result: 'success' });
  });

  it('context resets after each cycle restart', () => {
    const { registerTick } = createManualTicks();

    const cycle = createCycle({ thingsToReset: [], registerTick });
    const log = createCycleLog({ cycle, metrics: {} });

    log.annotate('tag', 'cycle-0');
    cycle.end();

    // Second cycle — no annotate calls
    cycle.end();

    expect(log.history.value[0].annotations).toEqual({ tag: 'cycle-0' });
    expect(log.history.value[1].annotations).toEqual({});
  });

  it('annotate overwrites previous value for same key', () => {
    const { registerTick } = createManualTicks();

    const cycle = createCycle({ thingsToReset: [], registerTick });
    const log = createCycleLog({ cycle, metrics: {} });

    log.annotate('count', 1);
    log.annotate('count', 5);
    cycle.end();

    expect(log.history.value[0].annotations).toEqual({ count: 5 });
  });

  it('finalized entry context is a snapshot (not a live reference)', () => {
    const { registerTick } = createManualTicks();

    const cycle = createCycle({ thingsToReset: [], registerTick });
    const log = createCycleLog({ cycle, metrics: {} });

    log.annotate('val', 'before');
    cycle.end();

    // Mutating after finalize should not affect the stored entry
    log.annotate('val', 'after');
    expect(log.history.value[0].annotations).toEqual({ val: 'before' });
  });

  it('entries without annotate calls have empty context', () => {
    const { registerTick } = createManualTicks();

    const cycle = createCycle({ thingsToReset: [], registerTick });
    const log = createCycleLog({ cycle, metrics: {} });

    cycle.end();
    expect(log.history.value[0].annotations).toEqual({});
  });

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  it('empty metrics record produces entry with empty deltas', () => {
    const { registerTick } = createManualTicks();

    const cycle = createCycle({ thingsToReset: [], registerTick });
    const log = createCycleLog({ cycle, metrics: {} });

    cycle.end();

    expect(log.history.value).toHaveLength(1);
    expect(log.history.value[0].deltas).toHaveLength(0);
  });

  it('handles large Decimal values without precision loss', () => {
    const { registerTick } = createManualTicks();
    beginPersistentContext('ll-big');
    const big = createResource(bn(0), { id: 'Big', displayName: 'Big' });
    endPersistentContext();

    const cycle = createCycle({ thingsToReset: [big], registerTick });
    const log = createCycleLog({ cycle, metrics: { big } });

    addResource(big, bn('1e308'));
    cycle.end();

    expect(log.history.value[0].deltas[0].delta.eq(bn('1e308'))).toBe(true);
  });

  // ==========================================================================
  // Analyzer wiring via log.on('finalized', ...)
  // ==========================================================================

  it('log.on(finalized, ...) delivers one onRunFinalize call per cycle over a headless run', () => {
    const entries: CycleLogEntry[] = [];
    const loopAnalyzer: Analyzer = {
      id: 'cycle-counter',
      onRunFinalize: (entry) => entries.push(entry as CycleLogEntry),
      summarize: () => ({
        id: 'cycle-counter',
        metrics: { cycles: entries.length },
      }),
    };

    // Separate tick-only analyzer to verify coexistence with cycle-aware analyzers
    let tickCount = 0;
    const tickAnalyzer: Analyzer = {
      id: 'ticker',
      onTick: () => {
        tickCount++;
      },
      summarize: () => ({ id: 'ticker', metrics: { ticks: tickCount } }),
    };

    const { registerTick } = createManualTicks();
    beginPersistentContext('ll-headless-analyzer');
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();

    const cycle = createCycle({ thingsToReset: [gold], registerTick });
    const log = createCycleLog({ cycle, metrics: { gold } });
    log.on('finalized', (entry) => loopAnalyzer.onRunFinalize?.(entry));

    // Drive 3 cycles: each tick adds gold, every 2 ticks end a cycle
    const result = runHeadless({
      setup: () => [loopAnalyzer, tickAnalyzer],
      tick: () => {
        addResource(gold, 10);
        if (tickCount % 2 === 1) cycle.end();
      },
      ticks: 6,
    });

    expect(entries).toHaveLength(3);
    expect(entries[0].runNumber).toBe(0);
    expect(entries[0].deltas[0].delta.eq(20)).toBe(true);
    expect(tickCount).toBe(6);
    expect(result.analyzerResults[0].metrics.cycles).toBe(3);
    expect(result.analyzerResults[1].metrics.ticks).toBe(6);
  });

  it('unsubscribe returned by log.on removes the finalized subscription', () => {
    const entries: CycleLogEntry[] = [];
    const analyzer: Analyzer = {
      id: 'x',
      onRunFinalize: (entry) => entries.push(entry as CycleLogEntry),
      summarize: () => ({ id: 'x', metrics: {} }),
    };

    const { registerTick } = createManualTicks();
    const cycle = createCycle({ thingsToReset: [], registerTick });
    const log = createCycleLog({ cycle, metrics: {} });
    const dispose = log.on('finalized', (entry) => analyzer.onRunFinalize?.(entry));

    cycle.end();
    expect(entries).toHaveLength(1);

    dispose();
    cycle.end();
    expect(entries).toHaveLength(1);
  });
});

describe('createCycleLog — the baseline follows loads and resets', () => {
  /** Module `m`: a permanent stat and a run-scoped wallet, logged per cycle. */
  function build() {
    const { registerTick } = createManualTicks();
    return withPersistentContext('m', () => {
      const strength = persistent<number>(0, { id: 'strength', lifetime: true });
      const gold = persistent<number>(0, { id: 'gold' });
      const cycle = createCycle({ registerTick });
      const log = createCycleLog({ cycle, metrics: { strength, gold } });
      return { strength, gold, cycle, log };
    });
  }

  function lastDelta(log: ReturnType<typeof build>['log'], key: string): number {
    const entry = log.history.value[log.history.value.length - 1];
    return entry.deltas.find((d) => d.key === key)!.delta.toNumber();
  }

  it('the first cycle after a load counts only growth since the load', () => {
    const first = build();
    first.strength.value = 1000;
    const save = saveAndClear();

    const { strength, cycle, log } = build();
    deserializePersistents(getAllPersistentRefs(), save);
    strength.value += 10;
    cycle.end();

    expect(lastDelta(log, 'strength')).toBe(10);
  });

  it('a reset mid-cycle re-baselines the metrics it wrote and keeps the rest', () => {
    const { strength, gold, cycle, log } = build();
    strength.value = 5;
    gold.value = 40;
    cycle.end();

    strength.value += 2;
    createReset({ resetPersistentContexts: ['m'] }).reset();
    strength.value += 3;
    gold.value += 3;
    cycle.end();

    expect(lastDelta(log, 'strength')).toBe(5);
    expect(lastDelta(log, 'gold')).toBe(3);
  });

  it('a load that leaves a metric at its value keeps its growth so far', () => {
    const { registerTick } = createManualTicks();
    const { a, cycle, log } = withPersistentContext('parts', () => {
      const a = persistent<number>(0, { id: 'a' });
      const b = persistent<number>(0, { id: 'b' });
      const cycle = createCycle({ registerTick });
      const log = createCycleLog({ cycle, metrics: { power: () => a.value + b.value } });
      return { a, cycle, log };
    });

    a.value = 5;
    deserializePersistents(getAllPersistentRefs(), { parts: { a: 2, b: 3 } });
    cycle.end();

    expect(lastDelta(log, 'power')).toBe(5);
  });
});
