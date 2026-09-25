import { describe, it, expect, vi } from 'vitest';
import { effectScope } from 'vue';
import {
  cloneDefault,
  getAllPersistentRefs,
  Lifetime,
  resetAllPersistentContexts,
  withPersistentContext,
} from '@/core/persistence';
import { bn, Decimal } from '@/primitives/decimal';
import { createRunPool } from '@/core/run-pool';
import { createSequencer } from '@/core/sequencer';
import { Resettable } from '@/core/resettable';
import { createTimedProgress } from '@/core/timed-progress';
import { createAchievement } from '@/systems/achievement';
import { createAutomationTiers } from '@/systems/automation';
import { createBestOf } from '@/systems/best-of';
import { createCycle } from '@/systems/cycle';
import { createCycleLog } from '@/systems/cycle-log';
import { createDialogSession } from '@/systems/dialog-session';
import { createInventory } from '@/systems/inventory';
import { createRecommendationSystem } from '@/systems/recommendation';
import { createReset } from '@/systems/reset';
import { createSlot } from '@/systems/slot';
import { createTimeBank } from '@/systems/time-bank';
import { createTimeSystem } from '@/systems/time';
import { createZoneSystem } from '@/systems/zone';

// A `thingsToReset: [system]` walk resets what a module reset of the system's
// own module does, and nothing the module reset would leave alone.

interface Case {
  name: string;
  /** Build the system inside module `m`. */
  build: () => object;
  /** Move the system's state, run-scoped and lifetime alike, off its defaults. */
  dirty: (system: never) => void;
  /** Extra checks on the system after a `thingsToReset` reset. */
  check?: (system: never) => void;
}

const registerTick = () => () => {};

/** A tick source the test drives by hand. */
function manualTicks() {
  const listeners = new Set<(dt: number) => void>();
  return {
    registerTick: (fn: (dt: number) => void) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    tick: (dt: number) => listeners.forEach((fn) => fn(dt)),
  };
}

const cases: Case[] = [
  {
    name: 'slot',
    build: () => createSlot({ id: 'gear', mode: 'multi' }),
    dirty: (slot: ReturnType<typeof createSlot>) => {
      slot.select('sword');
    },
    check: (slot: ReturnType<typeof createSlot>) => {
      expect(slot.selected.value).toEqual([]);
    },
  },
  {
    name: 'sequencer',
    build: () => createSequencer<void>({ id: 'm-queue' }),
    dirty: (seq: ReturnType<typeof createSequencer<void>>) => {
      seq.enqueue({ id: 'a', metadata: undefined });
      seq.enqueue({ id: 'b', metadata: undefined });
      seq.pause();
    },
    check: (seq: ReturnType<typeof createSequencer<void>>) => {
      expect(seq.current.value).toBe('');
      expect(seq.items.value).toEqual([]);
    },
  },
  {
    name: 'zone system',
    build: () =>
      createZoneSystem({
        zones: [
          { id: 'town', name: 'Town', order: 0 },
          { id: 'cave', name: 'Cave', order: 1 },
        ],
      }),
    dirty: (zones: ReturnType<typeof createZoneSystem>) => {
      zones.unlock('cave');
      zones.select('cave');
    },
  },
  {
    name: 'time system',
    build: () => createTimeSystem(),
    dirty: (time: ReturnType<typeof createTimeSystem>) => time.tick(50),
  },
  {
    name: 'time bank',
    build: () => createTimeBank(),
    dirty: (bank: ReturnType<typeof createTimeBank>) => void bank.deposit(30),
  },
  {
    name: 'cycle',
    build: () => {
      const ticks = manualTicks();
      return Object.assign(createCycle({ resetModules: [], registerTick: ticks.registerTick }), {
        ticks,
      });
    },
    dirty: (cycle: ReturnType<typeof createCycle> & { ticks: ReturnType<typeof manualTicks> }) => {
      cycle.run();
      cycle.ticks.tick(5);
      cycle.end();
      cycle.ticks.tick(2);
    },
  },
  {
    name: 'automation tiers',
    build: () =>
      createAutomationTiers({
        tiers: [
          { id: 'manual', name: 'Manual', order: 0 },
          { id: 'basic', name: 'Basic', order: 1 },
        ],
      }),
    dirty: (tiers: ReturnType<typeof createAutomationTiers>) => tiers.unlock('basic'),
  },
  {
    name: 'best-of',
    build: () => createBestOf({ id: 'm-best', metrics: { gold: { mode: 'absolute' } } }),
    dirty: (bestOf: ReturnType<typeof createBestOf>) =>
      void bestOf.submit({ key: 'gold', value: 5, elapsed: 1, cycleNumber: 0 }),
  },
  {
    name: 'achievement',
    build: () => createAchievement({ id: 'first', display: { title: 'First' } }),
    dirty: (achievement: ReturnType<typeof createAchievement>) => achievement.complete(),
  },
  {
    name: 'recommendation system',
    build: () => {
      const cycle = createCycle({ resetModules: [], registerTick });
      const cycleLog = createCycleLog({ cycle, metrics: {} });
      const bestOf = createBestOf({ id: 'm-rec-best', metrics: {} });
      return createRecommendationSystem({
        cycle,
        cycleLog,
        bestOf,
        getCurrentSnapshot: () => ({}),
        applySnapshot: () => {},
      });
    },
    dirty: (recs: ReturnType<typeof createRecommendationSystem>) => {
      recs.autoApply.value = true;
    },
  },
  {
    name: 'dialog session',
    build: () =>
      createDialogSession({
        id: 'm-dialog',
        graphs: [],
        accessor: {
          getResource: () => bn(0),
          isUnlocked: () => false,
          getState: () => undefined,
          getRate: () => Decimal.dZero,
          applyResourceOp: () => {},
          setUnlocked: () => {},
          setState: () => {},
        },
      }),
    dirty: () => {},
  },
  {
    name: 'inventory',
    build: () => createInventory({ id: 'm-pack', baseCapacity: 10, items: ['ore'] }),
    dirty: (pack: ReturnType<typeof createInventory>) => void pack.add('ore', 4),
    check: (pack: ReturnType<typeof createInventory>) => {
      expect(Decimal.eq(pack.get('ore'), 0)).toBe(true);
    },
  },
  {
    name: 'run pool',
    build: () => createRunPool({ id: 'm-pool', deathPolicy: 'park' }),
    dirty: (pool: ReturnType<typeof createRunPool>) =>
      void pool.addInstance({ id: 'a', step: () => false }).step(),
  },
  {
    name: 'timed progress',
    build: () => {
      const ticks = manualTicks();
      return Object.assign(
        createTimedProgress({ id: 'craft', duration: 10, registerTick: ticks.registerTick }),
        { ticks },
      );
    },
    dirty: (progress: { ticks: ReturnType<typeof manualTicks> }) => progress.ticks.tick(4),
  },
];

type Snapshot = Record<string, unknown>;

function snapshot(): Snapshot {
  return Object.fromEntries(
    [...getAllPersistentRefs()].map(([key, ref]) => [key, cloneDefault(ref.value)]),
  );
}

function lifetimeKeys(): string[] {
  return [...getAllPersistentRefs()].filter(([, ref]) => ref[Lifetime]).map(([key]) => key);
}

function resetVia(c: Case, via: 'thingsToReset' | 'resetModules') {
  resetAllPersistentContexts();
  // Earned-at and best-of timestamps read the clock; both runs see one instant.
  vi.useFakeTimers({ toFake: ['Date'], now: 0 });
  const scope = effectScope();
  try {
    return scope.run(() => {
      const system = withPersistentContext('m', c.build);
      expect(Resettable in system).toBe(true);
      c.dirty(system as never);
      const before = snapshot();
      const lifetime = lifetimeKeys();
      const reset =
        via === 'thingsToReset'
          ? createReset({ thingsToReset: [system] })
          : createReset({ resetModules: ['m'] });
      reset.reset();
      if (via === 'thingsToReset') c.check?.(system as never);
      return { before, after: snapshot(), lifetime };
    })!;
  } finally {
    scope.stop();
    vi.useRealTimers();
  }
}

describe('Reset — a standalone system in thingsToReset', () => {
  it.each(cases)('$name resets as a module reset of its own context does', (c) => {
    const walked = resetVia(c, 'thingsToReset');
    const moduled = resetVia(c, 'resetModules');

    expect(walked.after).toEqual(moduled.after);
    for (const key of walked.lifetime) {
      expect(walked.after[key], key).toEqual(walked.before[key]);
    }
    if (Object.keys(walked.before).length > walked.lifetime.length) {
      expect(walked.after).not.toEqual(walked.before);
    }
  });
});
