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
import { createResource } from '@/core/resource';
import { createProducerCategory } from '@/systems/producer-category';
import { createPurchasableCategory } from '@/systems/purchasable-category';
import { setupPolicyAutoPurchase, setupSweepAutoPurchase } from '@/systems/auto-purchase';
import { createCostRequirement } from '@/core/requirements';
import { createInventory } from '@/systems/inventory';
import { createEngine } from '@/engine';
import { noopRegisterTick as registerTick } from './fixtures/stateful-systems';

const INVENTORY_KEYS = [
  'storage/loop.anchor',
  'storage/loop.ore',
  'storage/loop::anchor.best',
  'storage/loop::anchor.cumulative',
  'storage/loop::ore.best',
  'storage/loop::ore.cumulative',
  'storage/vault.anchor',
  'storage/vault.ore',
  'storage/vault::anchor.best',
  'storage/vault::anchor.cumulative',
  'storage/vault::ore.best',
  'storage/vault::ore.cumulative',
];

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

  it('inventories sharing item ids save each item under their own context', () => {
    withPersistentContext('storage', () => {
      createInventory({ id: 'storage/loop', baseCapacity: 10, items: ['anchor', 'ore'] });
      createInventory({ id: 'storage/vault', baseCapacity: 10, items: ['anchor', 'ore'] });
    });

    expect([...getAllPersistentRefs().keys()].sort()).toEqual(INVENTORY_KEYS);
  });

  it('an engine installing both keeps those keys', () => {
    const engine = createEngine({ gameId: 'save-keys', persistence: false });
    engine.use({
      id: 'storage',
      install() {
        createInventory({ id: 'storage/loop', baseCapacity: 10, items: ['anchor', 'ore'] });
        createInventory({ id: 'storage/vault', baseCapacity: 10, items: ['anchor', 'ore'] });
      },
    });
    engine.start();

    const keys = [...getAllPersistentRefs().keys()].filter((k) => k.startsWith('storage/'));
    expect(keys.sort()).toEqual(INVENTORY_KEYS);
    engine.dispose();
  });

  describe('auto-purchase accumulators', () => {
    const accumulatorKeys = () =>
      [...getAllPersistentRefs().keys()].filter((k) => k.includes('Accumulator')).sort();

    const buildings = () => {
      const cookies = createResource(0, { id: 'cookies' });
      const category = createProducerCategory<{ id: string }>({
        id: 'buildings',
        mapProducer: () => ({
          resource: cookies,
          baseRate: 1,
          trigger: 'continuous',
          purchase: { costResource: cookies, baseCost: 10, costScaling: 1.15 },
        }),
        registerTick,
      });
      category.register([{ id: 'cursor' }, { id: 'farm' }]);
      return category;
    };

    it('a policy buyer keys by its id, else its category, else its kind', () => {
      const category = buildings();
      withPersistentContext('realm', () => {
        setupPolicyAutoPurchase(category, { enabled: true }, registerTick);
        setupPolicyAutoPurchase(
          category.getAll().map((e) => e.producer),
          { enabled: true },
          registerTick,
        );
        setupPolicyAutoPurchase(category, { id: 'late', enabled: true }, registerTick);
      });

      expect(accumulatorKeys()).toEqual([
        'realm.policyAutoPurchaseAccumulator',
        'realm.policyAutoPurchaseAccumulator:buildings',
        'realm.policyAutoPurchaseAccumulator:late',
      ]);
    });

    it('a sweep buyer keys the same way, and only when it has an interval', () => {
      const gold = createResource(0, { id: 'gold' });
      const upgrades = createPurchasableCategory<{ id: string }>({
        id: 'upgrades',
        mapPurchasable: () => ({
          display: 'upgrade',
          requirements: createCostRequirement({ resource: gold, cost: 1 }),
          limit: 1,
        }),
      });
      upgrades.register([{ id: 'sale' }]);
      const list = upgrades.getAll().map((e) => e.purchasable);

      withPersistentContext('realm', () => {
        setupSweepAutoPurchase(upgrades, { enabled: true, interval: 1 }, registerTick);
        setupSweepAutoPurchase(list, { enabled: true, interval: 1 }, registerTick);
        setupSweepAutoPurchase(list, { id: 'perks', enabled: true, interval: 1 }, registerTick);
        setupSweepAutoPurchase(list, { enabled: true }, registerTick);
      });

      expect(accumulatorKeys()).toEqual([
        'realm.sweepAutoPurchaseAccumulator',
        'realm.sweepAutoPurchaseAccumulator:perks',
        'realm.sweepAutoPurchaseAccumulator:upgrades',
      ]);
    });

    it('a second unnamed array-form buyer in one context throws', () => {
      const list = buildings()
        .getAll()
        .map((e) => e.producer);
      expect(() =>
        withPersistentContext('realm', () => {
          setupPolicyAutoPurchase(list, { enabled: true }, registerTick);
          setupPolicyAutoPurchase(list, { enabled: true }, registerTick);
        }),
      ).toThrow(/policyAutoPurchaseAccumulator/);
    });
  });
});
