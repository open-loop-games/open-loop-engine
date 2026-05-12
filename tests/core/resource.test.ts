import { describe, it, expect } from 'vitest';
import { nextTick } from 'vue';
import { bn } from '@/primitives/decimal';
import { beginPersistentContext, endPersistentContext } from '@/core/persistence';
import {
  createResource,
  addResource,
  subtractResource,
  hasResource,
  resetResource,
} from '@/core/resource';

describe('Resource', () => {
  it('createResource creates resource with default value', () => {
    beginPersistentContext('test-resource-create');
    const gold = createResource(bn(0), { displayName: 'Gold' });
    endPersistentContext();
    expect(gold.value.eq(0)).toBe(true);
  });
  it('addResource increases amount', () => {
    beginPersistentContext('test-resource-add');
    const gold = createResource(bn(0), { displayName: 'Gold' });
    endPersistentContext();
    addResource(gold, 50);
    expect(gold.value.eq(50)).toBe(true);
  });
  it('subtractResource decreases amount', () => {
    beginPersistentContext('test-resource-sub');
    const gold = createResource(bn(100), { displayName: 'Gold' });
    endPersistentContext();
    subtractResource(gold, 30);
    expect(gold.value.eq(70)).toBe(true);
  });
  it('subtractResource refuses to go negative by default', () => {
    beginPersistentContext('test-resource-sub-floor');
    const gold = createResource(bn(50), { displayName: 'Gold' });
    endPersistentContext();
    expect(subtractResource(gold, 100)).toBe(false);
    expect(gold.value.eq(50)).toBe(true);
  });
  it('subtractResource permits negative values via allowNegative option', () => {
    beginPersistentContext('test-resource-sub-allow');
    const gold = createResource(bn(50), { displayName: 'Gold' });
    endPersistentContext();
    expect(subtractResource(gold, 100, { allowNegative: true })).toBe(true);
    expect(gold.value.eq(-50)).toBe(true);
  });
  it('hasResource checks if enough exists', () => {
    beginPersistentContext('test-resource-has');
    const gold = createResource(bn(100), { displayName: 'Gold' });
    endPersistentContext();
    expect(hasResource(gold, 50)).toBe(true);
    expect(hasResource(gold, 150)).toBe(false);
  });
  it('Resource.best slot maintains highest value', async () => {
    beginPersistentContext('test-resource-best');
    const gold = createResource(bn(0), { displayName: 'Gold' });
    endPersistentContext();
    addResource(gold, 100);
    await nextTick();
    expect(gold.best!.value.gte(100)).toBe(true);
  });
  it('Resource.cumulative slot accumulates gains only', async () => {
    beginPersistentContext('test-resource-total');
    const gold = createResource(bn(0), { displayName: 'Gold' });
    endPersistentContext();
    addResource(gold, 50);
    await nextTick();
    addResource(gold, 30);
    await nextTick();
    expect(gold.cumulative!.value.gte(80)).toBe(true);
  });
  it('resetResource restores default', () => {
    beginPersistentContext('test-resource-reset');
    const gold = createResource(bn(100), { displayName: 'Gold' });
    endPersistentContext();
    addResource(gold, 50);
    resetResource(gold);
    expect(gold.value.eq(100)).toBe(true);
  });
});
