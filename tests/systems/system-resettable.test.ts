import { describe, it, expect, vi } from 'vitest';
import { effectScope } from 'vue';
import {
  cloneDefault,
  getAllPersistentRefs,
  isAtDefault,
  Lifetime,
  resetAllPersistentContexts,
  withPersistentContext,
} from '@/core/persistence';
import { Decimal } from '@/primitives/decimal';
import { createRunPool } from '@/core/run-pool';
import { createSequencer } from '@/core/sequencer';
import { createRoundRobinStrategy } from '@/core/sequencer-strategies';
import Formula from '@/core/formulas/formulas';
import { Resettable } from '@/core/resettable';
import { createTimedProgress } from '@/core/timed-progress';
import { createAchievement } from '@/systems/achievement';
import { createAutomationTiers } from '@/systems/automation';
import { createBestOf } from '@/systems/best-of';
import { createCycle } from '@/systems/cycle';
import { createCycleLog } from '@/systems/cycle-log';
import { createDialogSession } from '@/systems/dialog-session';
import { createInventory } from '@/systems/inventory';
import { createPurchasable } from '@/systems/purchasable';
import { createRecommendationSystem } from '@/systems/recommendation';
import { createReset } from '@/systems/reset';
import { createSkill } from '@/systems/skill';
import { createSlot } from '@/systems/slot';
import { createTemporaryEffectSystem } from '@/systems/temporary-effect';
import { createTimeBank } from '@/systems/time-bank';
import { createTimeSystem } from '@/systems/time';
import { createZoneSystem } from '@/systems/zone';
import { createManualTicks } from '../helpers/manual-ticks';
import {
  AUTOMATION_TIER_DEFS,
  buildRecommendationStack,
  dialogAccessorStub,
  noopRegisterTick as registerTick,
} from './fixtures/stateful-systems';

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
      const ticks = createManualTicks();
      return Object.assign(
        createCycle({ resetPersistentContexts: [], registerTick: ticks.registerTick }),
        {
          ticks,
        },
      );
    },
    dirty: (
      cycle: ReturnType<typeof createCycle> & { ticks: ReturnType<typeof createManualTicks> },
    ) => {
      cycle.resume();
      cycle.ticks.tick(5);
      cycle.end();
      cycle.ticks.tick(2);
    },
  },
  {
    name: 'automation tiers',
    build: () => createAutomationTiers({ tiers: AUTOMATION_TIER_DEFS }),
    dirty: (tiers: ReturnType<typeof createAutomationTiers>) => tiers.unlock('basic'),
  },
  {
    name: 'best-of',
    build: () => createBestOf({ id: 'm-best', metrics: { gold: { mode: 'absolute' } } }),
    dirty: (bestOf: ReturnType<typeof createBestOf>) =>
      void bestOf.submit({ key: 'gold', value: 5, elapsed: 1, runNumber: 0 }),
  },
  {
    name: 'achievement',
    build: () => createAchievement({ id: 'first', display: { title: 'First' } }),
    dirty: (achievement: ReturnType<typeof createAchievement>) => achievement.complete(),
  },
  {
    name: 'recommendation system',
    build: () => {
      const cycle = createCycle({ resetPersistentContexts: [], registerTick });
      const cycleLog = createCycleLog({ cycle, metrics: {} });
      const bestOf = createBestOf({ id: 'm-rec-best', metrics: {} });
      return buildRecommendationStack(cycle, cycleLog, bestOf);
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
        accessor: dialogAccessorStub,
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
      void pool.addRun({ id: 'a', step: () => false }).step(),
  },
  {
    name: 'timed progress',
    build: () => {
      const ticks = createManualTicks();
      return Object.assign(
        createTimedProgress({ id: 'craft', duration: 10, registerTick: ticks.registerTick }),
        { ticks },
      );
    },
    dirty: (progress: { ticks: ReturnType<typeof createManualTicks> }) => progress.ticks.tick(4),
  },
  {
    name: 'temporary effect system',
    build: () => {
      const effects = createTemporaryEffectSystem({ id: 'm-buffs', registerTick });
      effects.register({ id: 'haste', duration: 30 });
      return effects;
    },
    dirty: (effects: ReturnType<typeof createTemporaryEffectSystem>) => void effects.apply('haste'),
    check: (effects: ReturnType<typeof createTemporaryEffectSystem>) => {
      expect(effects.getActive()).toEqual([]);
    },
  },
  {
    name: 'purchasable',
    build: () =>
      createPurchasable({ id: 'sharpen', display: { description: '' }, requirements: [] }),
    dirty: (upgrade: ReturnType<typeof createPurchasable>) => void upgrade.purchase(2),
  },
  {
    name: 'skill',
    build: () =>
      createSkill({
        id: 'mining',
        xpToLevel: (xp) => Formula.variable(xp).sqrt().floor(),
        levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
      }),
    dirty: (skill: ReturnType<typeof createSkill>) => skill.addXp(40),
  },
  {
    name: 'round-robin strategy',
    build: () =>
      createRoundRobinStrategy('m-rotation', () => [
        { id: 'a', metadata: undefined },
        { id: 'b', metadata: undefined },
      ]),
    dirty: (strategy: ReturnType<typeof createRoundRobinStrategy>) => void strategy.next(),
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

/** Run-scoped refs sitting off their default, which a reset must move back. */
function movedRunScopedKeys(): string[] {
  return [...getAllPersistentRefs()]
    .filter(([, ref]) => !ref[Lifetime] && !isAtDefault(ref))
    .map(([key]) => key);
}

function resetVia(c: Case, via: 'thingsToReset' | 'resetPersistentContexts') {
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
      const moved = movedRunScopedKeys();
      const reset =
        via === 'thingsToReset'
          ? createReset({ thingsToReset: [system] })
          : createReset({ resetPersistentContexts: ['m'] });
      reset.reset();
      if (via === 'thingsToReset') c.check?.(system as never);
      return { before, after: snapshot(), lifetime, moved };
    })!;
  } finally {
    scope.stop();
    vi.useRealTimers();
  }
}

describe('Reset — a standalone system in thingsToReset', () => {
  it.each(cases)('$name resets as a module reset of its own context does', (c) => {
    const walked = resetVia(c, 'thingsToReset');
    const moduled = resetVia(c, 'resetPersistentContexts');

    expect(walked.after).toEqual(moduled.after);
    for (const key of walked.lifetime) {
      expect(walked.after[key], key).toEqual(walked.before[key]);
    }
    if (walked.moved.length > 0) {
      expect(walked.after).not.toEqual(walked.before);
    }
  });
});
