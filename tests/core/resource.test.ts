import { describe, it, expect } from 'vitest';
import { nextTick } from 'vue';
import { Decimal, bn } from '@/primitives/decimal';
import { beginPersistentContext, endPersistentContext } from '@/core/persistence';
import { createCostRequirement, payByReset } from '@/core/requirements';
import { createSaveManager, createMemoryStorage } from '@/core/save-manager';
import { createReset } from '@/systems/reset';
import {
  createResource,
  addResource,
  subtractResource,
  hasResource,
  resetResource,
  formatResource,
} from '@/core/resource';

describe('Resource', () => {
  it('createResource creates resource with default value', () => {
    beginPersistentContext('test-resource-create');
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();
    expect(gold.value.eq(0)).toBe(true);
  });
  it('addResource increases amount', () => {
    beginPersistentContext('test-resource-add');
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();
    addResource(gold, 50);
    expect(gold.value.eq(50)).toBe(true);
  });
  it('subtractResource decreases amount', () => {
    beginPersistentContext('test-resource-sub');
    const gold = createResource(bn(100), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();
    subtractResource(gold, 30);
    expect(gold.value.eq(70)).toBe(true);
  });
  it('subtractResource refuses to go negative by default', () => {
    beginPersistentContext('test-resource-sub-floor');
    const gold = createResource(bn(50), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();
    expect(subtractResource(gold, 100)).toBe(false);
    expect(gold.value.eq(50)).toBe(true);
  });
  it('subtractResource permits negative values via allowNegative option', () => {
    beginPersistentContext('test-resource-sub-allow');
    const gold = createResource(bn(50), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();
    expect(subtractResource(gold, 100, { allowNegative: true })).toBe(true);
    expect(gold.value.eq(-50)).toBe(true);
  });
  it('hasResource checks if enough exists', () => {
    beginPersistentContext('test-resource-has');
    const gold = createResource(bn(100), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();
    expect(hasResource(gold, 50)).toBe(true);
    expect(hasResource(gold, 150)).toBe(false);
  });
  it('Resource.best slot maintains highest value', async () => {
    beginPersistentContext('test-resource-best');
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();
    addResource(gold, 100);
    await nextTick();
    expect(Decimal.gte(gold.best!.value, 100)).toBe(true);
  });
  it('Resource.cumulative slot accumulates gains only', async () => {
    beginPersistentContext('test-resource-total');
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();
    addResource(gold, 50);
    await nextTick();
    addResource(gold, 30);
    await nextTick();
    expect(Decimal.gte(gold.cumulative!.value, 80)).toBe(true);
  });
  it('small values stay hidden by default at any decimals', () => {
    beginPersistentContext('test-resource-small-default');
    const dust = createResource(bn(0.00001), { id: 'dust', decimals: 2 });
    const hidden = createResource(bn(0.00001), { id: 'hidden', decimals: 2, small: false });
    endPersistentContext();
    expect(formatResource(dust)).toBe(formatResource(hidden));
  });
  it('carries its decimals option into what it formats', () => {
    beginPersistentContext('test-resource-decimals');
    const whole = createResource(bn(1.5), { id: 'whole' });
    const fine = createResource(bn(1.5), { id: 'fine', decimals: 2 });
    endPersistentContext();
    expect(fine.decimals).toBe(2);
    expect(formatResource(fine)).not.toBe(formatResource(whole));
  });
  it('a dotted id throws an error naming the resource id', () => {
    beginPersistentContext('mine');
    try {
      expect(() => createResource(0, { id: 'ore.iron' })).toThrow(/Resource id "ore\.iron"/);
    } finally {
      endPersistentContext();
    }
  });
  it('lifetime trackers survive a module reset', () => {
    beginPersistentContext('tracker-reset');
    const gold = createResource(bn(0), { id: 'gold' });
    endPersistentContext();
    addResource(gold, 50);
    subtractResource(gold, 20);

    createReset({ resetPersistentContexts: ['tracker-reset'] }).reset();

    expect(gold.value.toNumber()).toBe(0);
    expect(new Decimal(gold.cumulative!.value).toNumber()).toBe(50);
    expect(new Decimal(gold.best!.value).toNumber()).toBe(50);
  });
  it('lifetime trackers round-trip through a save, and the load itself is no gain', () => {
    const mgr = createSaveManager({
      gameId: 'tracker-save',
      storageAdapter: createMemoryStorage(),
    });
    beginPersistentContext('tracker-save');
    const gold = createResource(bn(0), { id: 'gold' });
    endPersistentContext();
    addResource(gold, 50);
    const snapshot = mgr.exportSave();
    subtractResource(gold, 50);
    addResource(gold, 10);

    expect(mgr.importSave(snapshot).success).toBe(true);
    expect(gold.value.toNumber()).toBe(50);
    expect(new Decimal(gold.cumulative!.value).toNumber()).toBe(50);
    expect(new Decimal(gold.best!.value).toNumber()).toBe(50);
  });
  it('resetResource restores default', () => {
    beginPersistentContext('test-resource-reset');
    const gold = createResource(bn(100), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();
    addResource(gold, 50);
    resetResource(gold);
    expect(gold.value.eq(100)).toBe(true);
  });
  it('resetResource hands out a copy, so mutating the value in place leaves the default intact', () => {
    beginPersistentContext('test-resource-reset-alias');
    const gold = createResource(bn(100), { id: 'Gold' });
    endPersistentContext();
    resetResource(gold);
    gold.value.fromNumber(7);
    addResource(gold, 1);
    resetResource(gold);
    expect(gold.value.toNumber()).toBe(100);
  });
  it('payByReset hands out a copy of the default', () => {
    beginPersistentContext('test-resource-paybyreset-alias');
    const gold = createResource(bn(100), { id: 'Gold' });
    endPersistentContext();
    const req = createCostRequirement({ resource: gold, cost: 1 });
    payByReset(req);
    gold.value.fromNumber(7);
    addResource(gold, 1);
    payByReset(req);
    expect(gold.value.toNumber()).toBe(100);
  });
});
