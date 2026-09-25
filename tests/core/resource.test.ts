import { describe, it, expect } from 'vitest';
import { nextTick } from 'vue';
import { bn } from '@/primitives/decimal';
import { beginPersistentContext, endPersistentContext } from '@/core/persistence';
import { createCostRequirement, payByReset } from '@/core/requirements';
import {
  createResource,
  addResource,
  subtractResource,
  hasResource,
  resetResource,
  displayResource,
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
    expect(gold.best!.value.gte(100)).toBe(true);
  });
  it('Resource.cumulative slot accumulates gains only', async () => {
    beginPersistentContext('test-resource-total');
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();
    addResource(gold, 50);
    await nextTick();
    addResource(gold, 30);
    await nextTick();
    expect(gold.cumulative!.value.gte(80)).toBe(true);
  });
  it('small values stay hidden by default at any precision', () => {
    beginPersistentContext('test-resource-small-default');
    const dust = createResource(bn(0.00001), { id: 'dust', precision: 2 });
    const hidden = createResource(bn(0.00001), { id: 'hidden', precision: 2, small: false });
    endPersistentContext();
    expect(displayResource(dust)).toBe(displayResource(hidden));
  });
  it('a dotted id throws an error naming the resource id', () => {
    beginPersistentContext('mine');
    try {
      expect(() => createResource(0, { id: 'ore.iron' })).toThrow(/Resource id "ore\.iron"/);
    } finally {
      endPersistentContext();
    }
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
