import { describe, it, expect, beforeEach } from 'vitest';
import {
  withPersistentContext,
  resetAllPersistentContexts,
  getAllPersistentRefs,
} from '@/core/persistence';
import { createZoneSystem } from '@/systems/zone';
import { createAutomationTiers } from '@/systems/automation';
import { createCycle } from '@/systems/cycle';
import { createTimeBank } from '@/systems/time-bank';
import { createTimeSystem } from '@/systems/time';

const registerTick = () => () => {};

describe('system save keys', () => {
  beforeEach(() => resetAllPersistentContexts());

  it('systems sharing a module each get their own context under it', () => {
    withPersistentContext('realm', () => {
      createZoneSystem({ zones: [{ id: 'town', name: 'Town', order: 0 }] });
      createAutomationTiers({ tiers: [{ id: 'manual', name: 'Manual', order: 0 }] });
      createCycle({ thingsToReset: [], registerTick });
      createTimeBank();
      createTimeSystem();
    });

    expect([...getAllPersistentRefs().keys()].sort()).toEqual([
      'realm/automation.unlocked',
      'realm/cycle.bestTime',
      'realm/cycle.count',
      'realm/cycle.elapsed',
      'realm/time-bank.banked',
      'realm/time.elapsed',
      'realm/time.totalPlayTime',
      'realm/zone.current',
      'realm/zone.unlocked',
    ]);
  });

  it('an explicit id is the whole context, wherever the system is built', () => {
    withPersistentContext('realm', () => {
      createCycle({ id: 'expedition', thingsToReset: [], registerTick });
      createTimeSystem({ id: 'clock' });
    });

    expect([...getAllPersistentRefs().keys()].sort()).toEqual([
      'clock.elapsed',
      'clock.totalPlayTime',
      'expedition.bestTime',
      'expedition.count',
      'expedition.elapsed',
    ]);
  });
});
