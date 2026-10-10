import { describe, it, expect } from 'vitest';
import { unref } from 'vue';
import { Decimal } from '@/primitives/decimal';
import {
  persistent,
  beginPersistentContext,
  endPersistentContext,
  type Persistent,
} from '@/core/persistence';
import type { DecimalSource } from '@/primitives/decimal';
import { createCostRequirement, createBooleanRequirement } from '@/core/requirements';
import {
  createPurchasableCategory,
  type PurchasableCategory,
} from '@/systems/purchasable-category';
import { createModifierChain, createMultiplicativeModifier } from '@/core/modifier';
import Formula from '@/core/formulas/formulas';
import { createTestResource } from '../helpers/test-resource';

// ============================================================================
// Test types — one-shot upgrades
// ============================================================================

interface UpgradeDef {
  id: string;
  name: string;
  cost: number;
  bonus: number;
}

interface TestState {
  purchasedAt: Persistent<number>;
}

// ============================================================================
// Test types — leveled repeatables
// ============================================================================

interface PerkDef {
  id: string;
  name: string;
  baseCost: number;
  costScaling: number;
  maxLevel: number;
  effectPerLevel: number;
}

// ============================================================================
// One-shot purchasable category tests (ported from upgrade-category)
// ============================================================================

describe('createPurchasableCategory (one-shot, limit: 1)', () => {
  it('registers definitions and creates Purchasable instances', () => {
    const gold = createTestResource('gold', 1000);

    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-test1',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        effect: def.bonus,
        limit: 1,
      }),
    });

    category.register([
      { id: 'double', name: 'Double', cost: 10, bonus: 2 },
      { id: 'triple', name: 'Triple', cost: 50, bonus: 3 },
    ]);

    expect(category.size).toBe(2);
    expect(category.getPurchasable('double')).toBeDefined();
    expect(category.getPurchasable('triple')).toBeDefined();
    expect(category.getPurchasable('unknown')).toBeUndefined();
  });

  it('purchasables start unpurchased', () => {
    const gold = createTestResource('gold', 1000);

    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-test2',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 1,
      }),
    });

    category.register({ id: 'a', name: 'A', cost: 10, bonus: 1 });

    const p = category.getPurchasable('a')!;
    expect(p.active.value).toBe(false);
  });

  it('getDef returns the definition from the registry', () => {
    const gold = createTestResource('gold', 1000);

    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-test3',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 1,
      }),
    });

    const def = { id: 'a', name: 'A', cost: 10, bonus: 1 };
    category.register(def);

    expect(category.getDef('a')).toBe(def);
  });

  it('creates per-instance state via mapState', () => {
    const gold = createTestResource('gold', 1000);

    beginPersistentContext('pc-test-state');

    const category = createPurchasableCategory<UpgradeDef, TestState>({
      id: 'pc-test4',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 1,
      }),
      mapState: () => ({
        purchasedAt: persistent(0),
      }),
    });

    category.register([
      { id: 'a', name: 'A', cost: 10, bonus: 1 },
      { id: 'b', name: 'B', cost: 20, bonus: 2 },
    ]);

    endPersistentContext();

    const stateA = category.getState('a')!;
    const stateB = category.getState('b')!;
    expect(stateA.purchasedAt.value).toBe(0);

    stateA.purchasedAt.value = 42;
    expect(stateB.purchasedAt.value).toBe(0);
  });

  it('getAll returns entries in registration order', () => {
    const gold = createTestResource('gold', 1000);

    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-test5',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 1,
      }),
    });

    category.register([
      { id: 'b', name: 'B', cost: 20, bonus: 2 },
      { id: 'a', name: 'A', cost: 10, bonus: 1 },
      { id: 'c', name: 'C', cost: 30, bonus: 3 },
    ]);

    const ids = category.getAll().map((e) => e.def.id);
    expect(ids).toEqual(['b', 'a', 'c']);
  });

  it('getEntry returns full tuple', () => {
    const gold = createTestResource('gold', 1000);

    beginPersistentContext('pc-test-entry');

    const category = createPurchasableCategory<UpgradeDef, TestState>({
      id: 'pc-test6',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 1,
      }),
      mapState: () => ({
        purchasedAt: persistent(0),
      }),
    });

    category.register({ id: 'a', name: 'A', cost: 10, bonus: 1 });

    endPersistentContext();

    const entry = category.getEntry('a')!;
    expect(entry.def.id).toBe('a');
    expect(entry.purchasable).toBeDefined();
    expect(entry.purchasable.active.value).toBe(false);
    expect(entry.state.purchasedAt.value).toBe(0);
  });

  it('supports incremental registration (base + mod)', () => {
    const gold = createTestResource('gold', 1000);

    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-test7',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 1,
      }),
    });

    category.register([{ id: 'base', name: 'Base', cost: 10, bonus: 1 }]);
    expect(category.size).toBe(1);

    category.register([{ id: 'mod', name: 'Mod Upgrade', cost: 50, bonus: 5 }]);
    expect(category.size).toBe(2);
    expect(category.getPurchasable('mod')).toBeDefined();
  });

  it('throws on duplicate registration', () => {
    const gold = createTestResource('gold', 1000);

    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-test8',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 1,
      }),
    });

    category.register({ id: 'a', name: 'A', cost: 10, bonus: 1 });

    expect(() => {
      category.register({ id: 'a', name: 'Duplicate', cost: 20, bonus: 2 });
    }).toThrow(/Duplicate/);
  });

  it('exposes registry for mod patching', () => {
    const gold = createTestResource('gold', 1000);

    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-test9',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 1,
      }),
    });

    category.register({ id: 'a', name: 'A', cost: 10, bonus: 1 });

    category.registry.patch('a', { cost: 5 });
    expect(category.getDef('a')!.cost).toBe(5);
  });

  it('purchase succeeds when affordable', () => {
    const gold = createTestResource('gold', 100);

    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-test10',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        effect: def.bonus,
        limit: 1,
      }),
    });

    category.register({ id: 'cheap', name: 'Cheap', cost: 10, bonus: 2 });

    const p = category.getPurchasable('cheap')!;
    expect(p.canPurchase.value).toBe(true);

    const result = p.purchase();
    expect(Decimal.gt(result, 0)).toBe(true);
    expect(p.active.value).toBe(true);
    expect(Decimal.eq(gold.value, 90)).toBe(true);
  });

  it('purchase fails when not affordable', () => {
    const gold = createTestResource('gold', 5);

    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-test11',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 1,
      }),
    });

    category.register({ id: 'expensive', name: 'Expensive', cost: 100, bonus: 10 });

    const p = category.getPurchasable('expensive')!;
    expect(p.canPurchase.value).toBe(false);

    const result = p.purchase();
    expect(Decimal.eq(result, 0)).toBe(true);
    expect(p.active.value).toBe(false);
  });

  it('fires onPurchase callback', () => {
    const gold = createTestResource('gold', 100);
    let purchased = false;

    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-test12',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 1,
        onPurchase: () => {
          purchased = true;
        },
      }),
    });

    category.register({ id: 'a', name: 'A', cost: 10, bonus: 1 });
    category.getPurchasable('a')!.purchase();

    expect(purchased).toBe(true);
  });

  it('purchasedCount and allMaxed track state reactively', () => {
    const gold = createTestResource('gold', 1000);

    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-test13',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 1,
      }),
    });

    category.register([
      { id: 'a', name: 'A', cost: 10, bonus: 1 },
      { id: 'b', name: 'B', cost: 20, bonus: 2 },
      { id: 'c', name: 'C', cost: 30, bonus: 3 },
    ]);

    expect(category.purchasedCount.value).toBe(0);
    expect(category.allMaxed.value).toBe(false);

    category.getPurchasable('a')!.purchase();
    expect(category.purchasedCount.value).toBe(1);
    expect(category.allMaxed.value).toBe(false);

    category.getPurchasable('b')!.purchase();
    category.getPurchasable('c')!.purchase();
    expect(category.purchasedCount.value).toBe(3);
    expect(category.allMaxed.value).toBe(true);
  });

  it('allMaxed is false for empty category', () => {
    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-test14',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createBooleanRequirement({ requirement: true }),
        limit: 1,
      }),
    });

    expect(category.allMaxed.value).toBe(false);
  });

  it('getAffordable returns only purchasable items', () => {
    const gold = createTestResource('gold', 25);

    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-test15',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 1,
      }),
    });

    category.register([
      { id: 'cheap', name: 'Cheap', cost: 10, bonus: 1 },
      { id: 'mid', name: 'Mid', cost: 20, bonus: 2 },
      { id: 'expensive', name: 'Expensive', cost: 100, bonus: 5 },
    ]);

    const affordable = category.getAffordable();
    const ids = affordable.map((p) => p.id);
    expect(ids).toContain('cheap');
    expect(ids).toContain('mid');
    expect(ids).not.toContain('expensive');
  });

  it('purchaseAffordable buys all affordable', () => {
    const gold = createTestResource('gold', 35);

    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-test16',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 1,
      }),
    });

    category.register([
      { id: 'a', name: 'A', cost: 10, bonus: 1 },
      { id: 'b', name: 'B', cost: 20, bonus: 2 },
      { id: 'c', name: 'C', cost: 100, bonus: 5 },
    ]);

    const bought = category.purchaseAffordable();
    expect(Decimal.eq(bought, 2)).toBe(true);
    expect(category.getPurchasable('a')!.active.value).toBe(true);
    expect(category.getPurchasable('b')!.active.value).toBe(true);
    expect(category.getPurchasable('c')!.active.value).toBe(false);
  });
});

// ============================================================================
// Leveled purchasable category tests (ported from repeatable-category)
// ============================================================================

describe('createPurchasableCategory (leveled)', () => {
  it('registers definitions and creates Purchasable instances', () => {
    const gold = createTestResource('gold', 10000);

    const category = createPurchasableCategory<PerkDef>({
      id: 'pcl-test1',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.baseCost }),
        limit: def.maxLevel,
      }),
    });

    category.register([
      { id: 'a', name: 'Alpha', baseCost: 10, costScaling: 1.5, maxLevel: 5, effectPerLevel: 1.1 },
      { id: 'b', name: 'Beta', baseCost: 20, costScaling: 2, maxLevel: 3, effectPerLevel: 1.2 },
    ]);

    expect(category.size).toBe(2);
    expect(category.getPurchasable('a')).toBeDefined();
    expect(category.getPurchasable('b')).toBeDefined();
    expect(category.getPurchasable('unknown')).toBeUndefined();
  });

  it('purchasables start at amount 0', () => {
    const gold = createTestResource('gold', 10000);

    const category = createPurchasableCategory<PerkDef>({
      id: 'pcl-test2',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.baseCost }),
        limit: def.maxLevel,
      }),
    });

    category.register({
      id: 'a',
      name: 'A',
      baseCost: 10,
      costScaling: 1.5,
      maxLevel: 5,
      effectPerLevel: 1.1,
    });

    const p = category.getPurchasable('a')!;
    expect(Decimal.eq(p.amount.value, 0)).toBe(true);
  });

  it('purchase succeeds and increments amount', () => {
    const gold = createTestResource('gold', 100);

    const category = createPurchasableCategory<PerkDef>({
      id: 'pcl-test10',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.baseCost }),
        limit: def.maxLevel,
        effect: (amount) => Decimal.pow(def.effectPerLevel, amount),
      }),
    });

    category.register({
      id: 'cheap',
      name: 'Cheap',
      baseCost: 10,
      costScaling: 1,
      maxLevel: 5,
      effectPerLevel: 2,
    });

    const p = category.getPurchasable('cheap')!;
    expect(p.canPurchase.value).toBe(true);

    const bought = p.purchase(1);
    expect(Decimal.gte(bought, 1)).toBe(true);
    expect(Decimal.eq(p.amount.value, 1)).toBe(true);
    expect(Decimal.eq(gold.value, 90)).toBe(true);
  });

  it('purchase fails when not affordable', () => {
    const gold = createTestResource('gold', 5);

    const category = createPurchasableCategory<PerkDef>({
      id: 'pcl-test11',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.baseCost }),
        limit: def.maxLevel,
      }),
    });

    category.register({
      id: 'expensive',
      name: 'Expensive',
      baseCost: 100,
      costScaling: 2,
      maxLevel: 10,
      effectPerLevel: 1.1,
    });

    const p = category.getPurchasable('expensive')!;
    expect(p.canPurchase.value).toBe(false);

    const bought = p.purchase(1);
    expect(Decimal.eq(bought, 0)).toBe(true);
  });

  it('respects maxLevel limit', () => {
    const gold = createTestResource('gold', 10000);

    const category = createPurchasableCategory<PerkDef>({
      id: 'pcl-test12',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.baseCost }),
        limit: def.maxLevel,
      }),
    });

    category.register({
      id: 'capped',
      name: 'Capped',
      baseCost: 1,
      costScaling: 1,
      maxLevel: 2,
      effectPerLevel: 1.1,
    });

    const p = category.getPurchasable('capped')!;
    p.purchase(1);
    p.purchase(1);
    expect(Decimal.eq(p.amount.value, 2)).toBe(true);
    expect(p.maxed.value).toBe(true);
    expect(p.canPurchase.value).toBe(false);
  });

  it('totalAmount sums all amounts', () => {
    const gold = createTestResource('gold', 10000);

    const category = createPurchasableCategory<PerkDef>({
      id: 'pcl-test14',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.baseCost }),
        limit: def.maxLevel,
      }),
    });

    category.register([
      { id: 'a', name: 'A', baseCost: 1, costScaling: 1, maxLevel: 10, effectPerLevel: 1.1 },
      { id: 'b', name: 'B', baseCost: 1, costScaling: 1, maxLevel: 10, effectPerLevel: 1.1 },
    ]);

    expect(Decimal.eq(category.totalAmount.value, 0)).toBe(true);

    category.getPurchasable('a')!.purchase(1);
    category.getPurchasable('a')!.purchase(1);
    category.getPurchasable('b')!.purchase(1);

    expect(Decimal.eq(category.totalAmount.value, 3)).toBe(true);
  });

  it('totalEffect is product of all effects', () => {
    const gold = createTestResource('gold', 10000);

    const category = createPurchasableCategory<PerkDef>({
      id: 'pcl-test15',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.baseCost }),
        limit: def.maxLevel,
        effect: (amount) => Decimal.pow(def.effectPerLevel, amount),
      }),
    });

    category.register([
      { id: 'a', name: 'A', baseCost: 1, costScaling: 1, maxLevel: 10, effectPerLevel: 2 },
      { id: 'b', name: 'B', baseCost: 1, costScaling: 1, maxLevel: 10, effectPerLevel: 3 },
    ]);

    // Both at 0: effect = 2^0 * 3^0 = 1
    expect(Decimal.eq(category.totalEffect.value, 1)).toBe(true);

    category.getPurchasable('a')!.purchase(1); // 2^1 * 3^0 = 2
    expect(Decimal.eq(category.totalEffect.value, 2)).toBe(true);

    category.getPurchasable('b')!.purchase(1); // 2^1 * 3^1 = 6
    expect(Decimal.eq(category.totalEffect.value, 6)).toBe(true);
  });

  it('totalEffect counts a one-shot upgrade only once it is bought', () => {
    const gold = createTestResource('gold', 10000);

    const category = createPurchasableCategory<PerkDef>({
      id: 'pcl-test15b',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.baseCost }),
        limit: 1,
        effect: def.effectPerLevel,
      }),
    });

    category.register([
      { id: 'a', name: 'A', baseCost: 1, costScaling: 1, maxLevel: 1, effectPerLevel: 2 },
      { id: 'b', name: 'B', baseCost: 1, costScaling: 1, maxLevel: 1, effectPerLevel: 3 },
    ]);

    expect(Decimal.eq(category.totalEffect.value, 1)).toBe(true);

    category.getPurchasable('b')!.purchase();
    expect(Decimal.eq(category.totalEffect.value, 3)).toBe(true);
    // An unbought upgrade still reports its bonus, for previews.
    expect(Decimal.eq(category.getPurchasable('a')!.effect.value, 2)).toBe(true);
  });

  it('allMaxed tracks when every purchasable is at limit', () => {
    const gold = createTestResource('gold', 10000);

    const category = createPurchasableCategory<PerkDef>({
      id: 'pcl-test16',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.baseCost }),
        limit: def.maxLevel,
      }),
    });

    category.register([
      { id: 'a', name: 'A', baseCost: 1, costScaling: 1, maxLevel: 1, effectPerLevel: 1.1 },
      { id: 'b', name: 'B', baseCost: 1, costScaling: 1, maxLevel: 1, effectPerLevel: 1.1 },
    ]);

    expect(category.allMaxed.value).toBe(false);

    category.getPurchasable('a')!.purchase(1);
    expect(category.allMaxed.value).toBe(false);

    category.getPurchasable('b')!.purchase(1);
    expect(category.allMaxed.value).toBe(true);
  });

  it('purchaseAffordable buys max on every affordable', () => {
    const gold = createTestResource('gold', 30);

    const category = createPurchasableCategory<PerkDef>({
      id: 'pcl-test19',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.baseCost }),
        limit: def.maxLevel,
        bulkPurchase: false,
      }),
    });

    category.register([
      { id: 'a', name: 'A', baseCost: 10, costScaling: 1, maxLevel: 10, effectPerLevel: 1.1 },
      { id: 'b', name: 'B', baseCost: 10, costScaling: 1, maxLevel: 10, effectPerLevel: 1.1 },
    ]);

    const bought = category.purchaseAffordable();
    expect(Decimal.gt(bought, 0)).toBe(true);
    expect(Decimal.gt(category.totalAmount.value, 0)).toBe(true);
  });
});

// ============================================================================
// Declarative `grants` bindings
// ============================================================================

describe('createPurchasableCategory grants', () => {
  it('binds modifiers to target chains gated on bought state', () => {
    const gold = createTestResource('grants-g1', 1000);
    const productionChain = createModifierChain('prod-g1');

    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-grants1',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 1,
        grants: [
          {
            chain: productionChain,
            mult: def.bonus,
            description: `from:${def.id}`,
          },
        ],
      }),
    });

    category.register([{ id: 'double', name: 'Double', cost: 10, bonus: 2 }]);

    // Before purchase: binding is inactive; chain is identity.
    expect(Decimal.eq(productionChain.apply(100), 100)).toBe(true);

    // Purchase → binding activates synchronously, chain reflects the multiplier.
    const instance = category.getPurchasable('double')!;
    instance.purchase();
    expect(Decimal.eq(productionChain.apply(100), 200)).toBe(true);

    // Attribution surfaces the grant through chain.bindings().
    const recs = productionChain.bindings();
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe('pc-grants1/double/from:double');
    expect(recs[0].persistentContextId).toBe('pc-grants1/double');
  });

  it('supports multi-chain grants via array shorthand', () => {
    const gold = createTestResource('grants-g2', 1000);
    const chainA = createModifierChain('multi-g2-a');
    const chainB = createModifierChain('multi-g2-b');

    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-grants2',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 1,
        grants: [
          {
            chain: [chainA, chainB],
            add: def.bonus,
            description: `add:${def.id}`,
          },
        ],
      }),
    });

    category.register([{ id: 'boost', name: 'Boost', cost: 10, bonus: 50 }]);
    category.getPurchasable('boost')!.purchase();

    expect(Decimal.eq(chainA.apply(100), 150)).toBe(true);
    expect(Decimal.eq(chainB.apply(100), 150)).toBe(true);
    expect(chainA.bindings()).toHaveLength(1);
    expect(chainB.bindings()).toHaveLength(1);
  });

  it('AND-composes per-entry `when` override with the implicit active signal', () => {
    const gold = createTestResource('grants-g3', 1000);
    const chain = createModifierChain('compose-g3');
    const secondGate = persistent<boolean>(false, { name: 'second-gate-g3' });

    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-grants3',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 1,
        grants: [
          {
            chain,
            mult: def.bonus,
            description: `gated:${def.id}`,
            when: () => secondGate.value,
          },
        ],
      }),
    });

    category.register([{ id: 'g', name: 'G', cost: 10, bonus: 3 }]);
    const instance = category.getPurchasable('g')!;

    instance.purchase();
    // bought, but secondGate still false → binding inactive
    expect(Decimal.eq(chain.apply(100), 100)).toBe(true);

    secondGate.value = true;
    expect(Decimal.eq(chain.apply(100), 300)).toBe(true);

    secondGate.value = false;
    expect(Decimal.eq(chain.apply(100), 100)).toBe(true);
  });

  it('a description-less chain granted with an inline description stays live', () => {
    const gold = createTestResource('grants-g4', 1000);
    const source = createModifierChain('source-g4');
    const target = createModifierChain('target-g4');

    const category = createPurchasableCategory<UpgradeDef>({
      id: 'pc-grants4',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 1,
        grants: [{ chain: target, modifier: source, description: 'Source bonus' }],
      }),
    });

    category.register([{ id: 'link', name: 'Link', cost: 10, bonus: 1 }]);
    category.getPurchasable('link')!.purchase();

    // Added after the grant bound: the target still sees it.
    source.add(createMultiplicativeModifier({ multiplier: 2, description: 'late' }));
    expect(Decimal.eq(source.apply(10), 20)).toBe(true);
    expect(Decimal.eq(target.apply(10), 20)).toBe(true);
    expect(target.bindings()[0].id).toBe('pc-grants4/link/Source bonus');
  });
});

// ============================================================================
// Leveled costs — requirements factory over the purchasable's own level
// ============================================================================

interface LadderDef {
  id: string;
  name: string;
  baseCost: number;
}

describe('PurchasableCategory — invertible leveled costs', () => {
  it('prices buy-max along the real curve instead of extrapolating the current level', () => {
    const gold = createTestResource('gold', 1e6);
    const category = createPurchasableCategory<LadderDef>({
      id: 'ladders',
      mapPurchasable: (def) => ({
        display: def.name,
        requirements: (level) =>
          createCostRequirement({
            resource: gold,
            cost: Formula.exponential(level, def.baseCost, 1.15),
            maxBulkAmount: Decimal.dInf,
          }),
      }),
    });

    category.register([{ id: 'forge', name: 'Forge', baseCost: 10 }]);
    const forge = category.getPurchasable('forge')!;

    // A `cost: () => …` getter reading the level back out of the category
    // prices this as 3 × 10; the Formula walks 10 + 11.5 + 13.225.
    expect(Decimal.eq_tolerance(forge.getCost(3), 34.725, 1e-9)).toBe(true);

    const spentBefore = gold.value;
    const bought = forge.purchaseMax();
    expect(Decimal.gt(bought, 1)).toBe(true);
    expect(Decimal.eq(forge.amount.value, bought)).toBe(true);

    // Every level bought was paid for at its own rung.
    const paid = Decimal.sub(spentBefore, gold.value);
    let expected: DecimalSource = Decimal.dZero;
    for (let i = 0; Decimal.lt(i, bought); i++) {
      expected = Decimal.add(expected, Decimal.mul(10, Decimal.pow(1.15, i)));
    }
    expect(Decimal.eq_tolerance(paid, expected, 1e-6)).toBe(true);

    // One more level would be unaffordable — the walk consumed the curve.
    expect(forge.canPurchase.value).toBe(false);
  });

  it('min-folds bulk across an array of per-resource ladders over one level', () => {
    const iron = createTestResource('iron', 1e6);
    const wood = createTestResource('wood', 5e5);
    const category = createPurchasableCategory<LadderDef>({
      id: 'multi-ladders',
      mapPurchasable: (def) => ({
        display: def.name,
        requirements: (level) => [
          createCostRequirement({
            resource: iron,
            cost: Formula.exponential(level, def.baseCost, 1.15),
            maxBulkAmount: Decimal.dInf,
          }),
          createCostRequirement({
            resource: wood,
            cost: Formula.exponential(level, 20, 1.2),
            maxBulkAmount: Decimal.dInf,
          }),
        ],
      }),
    });

    category.register([{ id: 'forge', name: 'Forge', baseCost: 10 }]);
    const forge = category.getPurchasable('forge')!;

    forge.purchaseMax();
    // The steeper wood ladder binds, so neither resource goes negative.
    expect(Decimal.gte(iron.value, 0)).toBe(true);
    expect(Decimal.gte(wood.value, 0)).toBe(true);
    expect(forge.canPurchase.value).toBe(false);
  });

  it('keeps the cost on the loaded level after persistence rehydrates amount', () => {
    const gold = createTestResource('gold', 1e6);
    const category = createPurchasableCategory<LadderDef>({
      id: 'rehydrated',
      mapPurchasable: (def) => ({
        display: def.name,
        requirements: (level) =>
          createCostRequirement({
            resource: gold,
            cost: Formula.exponential(level, def.baseCost, 1.15),
            maxBulkAmount: Decimal.dInf,
          }),
      }),
    });

    category.register([{ id: 'forge', name: 'Forge', baseCost: 10 }]);
    const forge = category.getPurchasable('forge')!;

    // Save load writes straight through `amount`; there is no mirror to fall
    // out of sync, so the next rung prices off the loaded level immediately.
    forge.amount.value = 5;
    expect(
      Decimal.eq_tolerance(forge.getCost(1), Decimal.mul(10, Decimal.pow(1.15, 5)), 1e-9),
    ).toBe(true);
  });
});

// ============================================================================
// Registry patches
// ============================================================================

describe('createPurchasableCategory — registry patches', () => {
  it('a mapping getter that reads through getDef tracks a registry patch', () => {
    const gold = createTestResource('gold', 1000);
    const category: PurchasableCategory<PerkDef> = createPurchasableCategory<PerkDef>({
      id: 'patched-perks',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.baseCost }),
        limit: () => category.getDef(def.id)!.maxLevel,
      }),
    });
    category.register({
      id: 'p',
      name: 'P',
      baseCost: 1,
      costScaling: 1,
      maxLevel: 1,
      effectPerLevel: 1,
    });

    const perk = category.getPurchasable('p')!;
    expect(new Decimal(unref(perk.limit)).toNumber()).toBe(1);

    category.registry.patch('p', { maxLevel: 5 });
    expect(new Decimal(unref(perk.limit)).toNumber()).toBe(5);

    const revert = category.registry.pushPatches({ p: { maxLevel: 9 } });
    expect(new Decimal(unref(perk.limit)).toNumber()).toBe(9);
    revert();
    expect(new Decimal(unref(perk.limit)).toNumber()).toBe(5);
  });
});
