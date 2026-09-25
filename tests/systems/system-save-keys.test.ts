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

const registerTick = () => () => {};

describe('system save keys', () => {
  beforeEach(() => resetAllPersistentContexts());

  it('systems sharing a module each get their own context under it', () => {
    withPersistentContext('realm', () => {
      createZoneSystem({ zones: [{ id: 'town', name: 'Town', order: 0 }] });
      createAutomationTiers({ tiers: [{ id: 'manual', name: 'Manual', order: 0 }] });
      createCycle({ thingsToReset: [], registerTick });
      createTimeBank();
    });

    expect([...getAllPersistentRefs().keys()].sort()).toEqual([
      'realm/automation.unlocked',
      'realm/cycle.bestTime',
      'realm/cycle.count',
      'realm/time-bank.banked',
      'realm/zone.current',
      'realm/zone.unlocked',
    ]);
  });

  it('an explicit id is the whole context, wherever the system is built', () => {
    withPersistentContext('realm', () => {
      createCycle({ id: 'expedition', thingsToReset: [], registerTick });
    });

    expect([...getAllPersistentRefs().keys()].sort()).toEqual([
      'expedition.bestTime',
      'expedition.count',
    ]);
  });
});
