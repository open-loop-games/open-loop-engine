import { describe, it, expect } from 'vitest';
import { Decimal } from '@/primitives/decimal';
import {
  persistent,
  beginPersistentContext,
  endPersistentContext,
  withPersistentContext,
  resetAllPersistentContexts,
  getAllPersistentRefs,
  serializePersistents,
  deserializePersistents,
  type Persistent,
} from '@/core/persistence';
import type { DecimalSource } from '@/primitives/decimal';
import { createScalingPurchasable } from '@/systems/purchasable';
import { createResource } from '@/core/resource';
import { createResourceBag } from '@/core/resource-bag';
import { createMultiplicativeModifier, createAdditiveModifier } from '@/core/modifier';
import { createProducerCategory } from '@/systems/producer-category';
import { createReset } from '@/systems/reset';
import { createTuningRegistry, tunable } from '@/core/override-registry';
import { ref, unref, watch } from 'vue';
import { createManualTicks } from '../helpers/manual-ticks';
import { createTestResource } from '../helpers/test-resource';

// ============================================================================
// Types for tests
// ============================================================================

interface BuildingDef {
  id: string;
  name: string;
  baseRate: number;
  baseCost: number;
  costRatio: number;
}

interface ClickDef {
  id: string;
  name: string;
  baseRate: number;
}

interface StatefulDef {
  id: string;
  name: string;
  baseRate: number;
}

interface StatefulState {
  totalProduced: Persistent<DecimalSource>;
}

// ============================================================================
// createProducerCategory
// ============================================================================

describe('createProducerCategory', () => {
  it('registers definitions and creates Producer instances', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<BuildingDef>({
      id: 'test1',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
      }),
      registerTick,
    });

    category.register([
      { id: 'cursor', name: 'Cursor', baseRate: 0.1, baseCost: 15, costRatio: 1.15 },
      { id: 'grandma', name: 'Grandma', baseRate: 1, baseCost: 100, costRatio: 1.15 },
    ]);

    expect(category.size).toBe(2);
    expect(category.getProducer('cursor')).toBeDefined();
    expect(category.getProducer('grandma')).toBeDefined();
    expect(category.getProducer('unknown')).toBeUndefined();
    expect(category.getProducer('grandma')!.id).toBe('grandma');
  });

  it('continuous producers have correct initial computedRate', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<BuildingDef>({
      id: 'test2',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
      }),
      registerTick,
    });

    category.register({
      id: 'grandma',
      name: 'Grandma',
      baseRate: 5,
      baseCost: 100,
      costRatio: 1.15,
    });

    const producer = category.getProducer('grandma')!;
    expect(new Decimal(producer.computedRate.value).eq(5)).toBe(true);
  });

  it('getDef returns the definition from the registry', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<BuildingDef>({
      id: 'test3',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
      }),
      registerTick,
    });

    const def = { id: 'cursor', name: 'Cursor', baseRate: 0.1, baseCost: 15, costRatio: 1.15 };
    category.register(def);

    expect(category.getDef('cursor')).toBe(def);
  });

  it('creates per-instance state via mapState', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    beginPersistentContext('test-state');

    const category = createProducerCategory<StatefulDef, StatefulState>({
      id: 'test4',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
      }),
      mapState: () => ({
        totalProduced: persistent<DecimalSource>(0),
      }),
      registerTick,
    });

    category.register([
      { id: 'a', name: 'A', baseRate: 1 },
      { id: 'b', name: 'B', baseRate: 2 },
    ]);

    endPersistentContext();

    const stateA = category.getState('a')!;
    const stateB = category.getState('b')!;
    expect(new Decimal(stateA.totalProduced.value).eq(0)).toBe(true);

    // States are independent
    stateA.totalProduced.value = 100;
    expect(new Decimal(stateB.totalProduced.value).eq(0)).toBe(true);
  });

  it('getAll returns entries in registration order', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<BuildingDef>({
      id: 'test5',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
      }),
      registerTick,
    });

    category.register([
      { id: 'b', name: 'B', baseRate: 2, baseCost: 1, costRatio: 1 },
      { id: 'a', name: 'A', baseRate: 1, baseCost: 1, costRatio: 1 },
      { id: 'c', name: 'C', baseRate: 3, baseCost: 1, costRatio: 1 },
    ]);

    const ids = category.getAll().map((e) => e.def.id);
    expect(ids).toEqual(['b', 'a', 'c']);
  });

  it('getEntry returns full tuple', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    beginPersistentContext('test-entry');

    const category = createProducerCategory<StatefulDef, StatefulState>({
      id: 'test6',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
      }),
      mapState: () => ({
        totalProduced: persistent<DecimalSource>(0),
      }),
      registerTick,
    });

    category.register({ id: 'cursor', name: 'Cursor', baseRate: 0.1 });

    endPersistentContext();

    const entry = category.getEntry('cursor')!;
    expect(entry.def.id).toBe('cursor');
    expect(entry.producer).toBeDefined();
    expect(new Decimal(entry.state.totalProduced.value).eq(0)).toBe(true);
  });

  it('supports incremental registration (base + mod)', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<BuildingDef>({
      id: 'test7',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
      }),
      registerTick,
    });

    // Base game
    category.register([
      { id: 'cursor', name: 'Cursor', baseRate: 0.1, baseCost: 15, costRatio: 1.15 },
    ]);
    expect(category.size).toBe(1);

    // Mod adds more
    category.register([
      { id: 'portal', name: 'Portal', baseRate: 100, baseCost: 1e12, costRatio: 1.15 },
    ]);
    expect(category.size).toBe(2);
    expect(category.getProducer('portal')).toBeDefined();
  });

  it('throws on duplicate registration', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<BuildingDef>({
      id: 'test8',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
      }),
      registerTick,
    });

    category.register({
      id: 'cursor',
      name: 'Cursor',
      baseRate: 0.1,
      baseCost: 15,
      costRatio: 1.15,
    });

    expect(() => {
      category.register({
        id: 'cursor',
        name: 'Cursor 2',
        baseRate: 0.2,
        baseCost: 20,
        costRatio: 1.2,
      });
    }).toThrow(/Duplicate/);
  });

  it('exposes registry for mod patching', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<BuildingDef>({
      id: 'test9',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
      }),
      registerTick,
    });

    category.register({
      id: 'cursor',
      name: 'Cursor',
      baseRate: 0.1,
      baseCost: 15,
      costRatio: 1.15,
    });

    category.registry.patch('cursor', { baseRate: 0.5 });
    expect(category.getDef('cursor')!.baseRate).toBe(0.5);
  });

  // ==========================================================================
  // Continuous production
  // ==========================================================================

  it('continuous producer adds resources each tick', () => {
    const { registerTick, tick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<BuildingDef>({
      id: 'test10',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
      }),
      registerTick,
    });

    // No purchase config — count defaults to 1
    category.register({ id: 'gen', name: 'Generator', baseRate: 10, baseCost: 0, costRatio: 1 });

    tick(1.0);
    // 10 rate * 1 count * 1.0 dt = 10
    expect(new Decimal(cookies.value).eq(10)).toBe(true);
  });

  it("continuous producer scales with its purchasable's count", () => {
    const { registerTick, tick } = createManualTicks();
    const cookies = createTestResource('cookies', 1000);
    const gold = createTestResource('gold');

    const category = createProducerCategory<BuildingDef>({
      id: 'test11',
      mapProducer: (def) => ({
        resource: gold,
        baseRate: def.baseRate,
        trigger: 'continuous',
        purchase: {
          costResource: cookies,
          baseCost: def.baseCost,
          costRatio: def.costRatio,
        },
      }),
      registerTick,
    });

    category.register({ id: 'mine', name: 'Mine', baseRate: 5, baseCost: 10, costRatio: 1.15 });

    const producer = category.getProducer('mine')!;
    // Purchase 3 units
    producer.purchasable!.purchase(3);

    expect(new Decimal(producer.count.value).eq(3)).toBe(true);

    tick(0.5);
    // 5 rate * 3 count * 0.5 dt = 7.5
    expect(new Decimal(gold.value).eq(7.5)).toBe(true);
  });

  it("passes a display object to the producer's purchasable", () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<BuildingDef>({
      id: 'test-display',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
        purchase: { costResource: cookies, baseCost: def.baseCost, costRatio: def.costRatio },
        display: { title: def.name, effectDescription: '+5/s each', showCount: false },
      }),
      registerTick,
    });
    category.register({ id: 'mine', name: 'Mine', baseRate: 5, baseCost: 10, costRatio: 1.15 });

    const { display } = category.getProducer('mine')!.purchasable!;
    expect(unref(display.title)).toBe('Mine');
    expect(unref(display.description)).toBe('');
    expect(unref(display.effectDescription)).toBe('+5/s each');
    expect(display.showCount).toBe(false);
  });

  it("reads a string display as the purchasable's description, defaulting to the def id", () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<BuildingDef>({
      id: 'test-display-string',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
        purchase: { costResource: cookies, baseCost: def.baseCost, costRatio: def.costRatio },
        display: def.id === 'mine' ? def.name : undefined,
      }),
      registerTick,
    });
    category.register([
      { id: 'mine', name: 'Mine', baseRate: 5, baseCost: 10, costRatio: 1.15 },
      { id: 'well', name: 'Well', baseRate: 1, baseCost: 10, costRatio: 1.15 },
    ]);

    expect(unref(category.getProducer('mine')!.purchasable!.display.description)).toBe('Mine');
    expect(unref(category.getProducer('well')!.purchasable!.display.description)).toBe('well');
  });

  it('continuous producer without purchase has count 1', () => {
    const { registerTick, tick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<ClickDef>({
      id: 'test12',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
      }),
      registerTick,
    });

    category.register({ id: 'passive', name: 'Passive', baseRate: 3 });

    const producer = category.getProducer('passive')!;
    expect(producer.purchasable).toBeUndefined();
    expect(new Decimal(producer.count.value).eq(1)).toBe(true);

    tick(2.0);
    // 3 * 1 * 2.0 = 6
    expect(new Decimal(cookies.value).eq(6)).toBe(true);
  });

  // ==========================================================================
  // Manual production
  // ==========================================================================

  it('manual producer exposes activate()', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<ClickDef>({
      id: 'test13',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'manual',
      }),
      registerTick,
    });

    category.register({ id: 'click', name: 'Click', baseRate: 1 });

    const producer = category.getProducer('click')!;
    expect(producer.activate).toBeDefined();

    producer.activate!();
    expect(new Decimal(cookies.value).eq(1)).toBe(true);

    producer.activate!();
    producer.activate!();
    expect(new Decimal(cookies.value).eq(3)).toBe(true);
  });

  it('manual producer yields rate × count', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies', 1e6);
    const cursors = ref<DecimalSource>(3);

    const category = createProducerCategory<ClickDef>({
      id: 'manual-count',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'manual',
        purchase: { costResource: cookies, baseCost: 10, costRatio: 1.15 },
        extraCount: cursors,
      }),
      registerTick,
    });

    category.register({ id: 'click', name: 'Click', baseRate: 2 });
    const producer = category.getProducer('click')!;
    producer.purchasable!.purchase(2);
    const before = new Decimal(cookies.value);

    producer.activate!();
    // count = 2 owned + 3 extra; 2 × 5 = 10
    expect(new Decimal(cookies.value).sub(before).toNumber()).toBe(10);
  });

  it('manual producer has no purchase beat', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies', 1e6);

    const category = createProducerCategory<ClickDef>({
      id: 'manual-beat',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'manual',
        purchase: { costResource: cookies, baseCost: 10, costRatio: 1.15 },
      }),
      registerTick,
    });

    category.register({ id: 'click', name: 'Click', baseRate: 1 });
    expect(category.getProducer('click')!.purchaseBeatSeconds.value).toBe(Infinity);
  });

  it('manual producer does not tick', () => {
    const { registerTick, tick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<ClickDef>({
      id: 'test14',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'manual',
      }),
      registerTick,
    });

    category.register({ id: 'click', name: 'Click', baseRate: 100 });

    tick(1.0);
    tick(1.0);
    tick(1.0);
    // Manual producers should not produce on tick
    expect(new Decimal(cookies.value).eq(0)).toBe(true);
  });

  // ==========================================================================
  // Modifier chain
  // ==========================================================================

  it('modifier chain affects computed rate', () => {
    const { registerTick, tick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<ClickDef>({
      id: 'test15',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
      }),
      registerTick,
    });

    category.register({ id: 'gen', name: 'Generator', baseRate: 10 });

    const producer = category.getProducer('gen')!;

    // Add a x2 multiplier
    producer.rateChain.add(createMultiplicativeModifier({ multiplier: 2 }));
    expect(new Decimal(producer.computedRate.value).eq(20)).toBe(true);

    tick(1.0);
    // 20 rate * 1 count * 1.0 dt = 20
    expect(new Decimal(cookies.value).eq(20)).toBe(true);
  });

  it('modifier chain affects manual producer rate', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<ClickDef>({
      id: 'test15b',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'manual',
      }),
      registerTick,
    });

    category.register({ id: 'click', name: 'Click', baseRate: 1 });

    const producer = category.getProducer('click')!;
    producer.rateChain.add(createAdditiveModifier({ addend: 4 }));
    // baseRate 1 + 4 = 5
    expect(new Decimal(producer.computedRate.value).eq(5)).toBe(true);

    producer.activate!();
    expect(new Decimal(cookies.value).eq(5)).toBe(true);
  });

  // ==========================================================================
  // getTotalRate
  // ==========================================================================

  it('getTotalRate aggregates continuous producers for a resource', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<BuildingDef>({
      id: 'test16',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
        purchase: {
          costResource: cookies,
          baseCost: def.baseCost,
          costRatio: def.costRatio,
        },
      }),
      registerTick,
    });

    // Give plenty of cookies for purchasing
    cookies.value = 1e9;

    category.register([
      { id: 'cursor', name: 'Cursor', baseRate: 1, baseCost: 1, costRatio: 1.01 },
      { id: 'grandma', name: 'Grandma', baseRate: 5, baseCost: 1, costRatio: 1.01 },
    ]);

    // Buy 2 cursors, 3 grandmas
    category.getProducer('cursor')!.purchasable!.purchase(2);
    category.getProducer('grandma')!.purchasable!.purchase(3);

    // Total = (1 * 2) + (5 * 3) = 2 + 15 = 17
    const total = category.getTotalRate(cookies);
    expect(new Decimal(total).eq(17)).toBe(true);
  });

  it('getTotalRate excludes manual producers', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<ClickDef>({
      id: 'test17',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: def.id === 'click' ? 'manual' : 'continuous',
      }),
      registerTick,
    });

    category.register([
      { id: 'click', name: 'Click', baseRate: 100 },
      { id: 'gen', name: 'Generator', baseRate: 5 },
    ]);

    // Only gen (continuous) should count
    const total = category.getTotalRate(cookies);
    expect(new Decimal(total).eq(5)).toBe(true);
  });

  it('getTotalRate returns zero for untracked resource', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');
    const gold = createTestResource('gold');

    const category = createProducerCategory<ClickDef>({
      id: 'test18',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
      }),
      registerTick,
    });

    category.register({ id: 'gen', name: 'Generator', baseRate: 10 });

    const total = category.getTotalRate(gold);
    expect(new Decimal(total).eq(0)).toBe(true);
  });

  // ==========================================================================
  // Repeatable creation
  // ==========================================================================

  it('repeatable is created when purchase config provided', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies', 1000);

    const category = createProducerCategory<BuildingDef>({
      id: 'test19',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
        purchase: {
          costResource: cookies,
          baseCost: def.baseCost,
          costRatio: def.costRatio,
        },
      }),
      registerTick,
    });

    category.register({
      id: 'cursor',
      name: 'Cursor',
      baseRate: 0.1,
      baseCost: 15,
      costRatio: 1.15,
    });

    const producer = category.getProducer('cursor')!;
    expect(producer.purchasable).toBeDefined();
    expect(new Decimal(producer.purchasable!.count.value).eq(0)).toBe(true);

    producer.purchasable!.purchase(1);
    expect(new Decimal(producer.purchasable!.count.value).eq(1)).toBe(true);
  });

  // ==========================================================================
  // extraCount (cascade-feed)
  // ==========================================================================

  it('extraCount folds into count alongside owned amount, exposing each axis separately', () => {
    const { registerTick, tick } = createManualTicks();
    const cookies = createTestResource('cookies', 10000);
    const gold = createTestResource('gold');
    const generated = createTestResource('generated', 4);

    const category = createProducerCategory<BuildingDef>({
      id: 'test-extracount-1',
      mapProducer: (def) => ({
        resource: gold,
        baseRate: def.baseRate,
        trigger: 'continuous',
        purchase: {
          costResource: cookies,
          baseCost: def.baseCost,
          costRatio: def.costRatio,
        },
        extraCount: () => generated.value,
      }),
      registerTick,
    });

    category.register({ id: 'mine', name: 'Mine', baseRate: 2, baseCost: 10, costRatio: 1.15 });

    const producer = category.getProducer('mine')!;
    producer.purchasable!.purchase(3); // owned = 3, extra = 4 → count = 7

    // Both axes addressable separately for owned-only / generated-only effects
    expect(new Decimal(producer.ownedCount.value).eq(3)).toBe(true);
    expect(new Decimal(producer.extraCount.value).eq(4)).toBe(true);
    expect(new Decimal(producer.count.value).eq(7)).toBe(true);

    tick(0.5);
    // 2 rate * 7 count * 0.5 dt = 7
    expect(new Decimal(gold.value).eq(7)).toBe(true);
  });

  it('extraCount alone drives count when no purchase config is set', () => {
    const { registerTick, tick } = createManualTicks();
    const gold = createTestResource('gold');
    const generated = createTestResource('generated', 5);

    const category = createProducerCategory<ClickDef>({
      id: 'test-extracount-2',
      mapProducer: (def) => ({
        resource: gold,
        baseRate: def.baseRate,
        trigger: 'continuous',
        extraCount: () => generated.value,
      }),
      registerTick,
    });

    category.register({ id: 'cascade', name: 'Cascade', baseRate: 3 });

    const producer = category.getProducer('cascade')!;
    expect(producer.purchasable).toBeUndefined();
    expect(new Decimal(producer.ownedCount.value).eq(0)).toBe(true);
    expect(new Decimal(producer.extraCount.value).eq(5)).toBe(true);
    expect(new Decimal(producer.count.value).eq(5)).toBe(true);

    tick(1);
    // 3 rate * 5 count * 1 dt = 15
    expect(new Decimal(gold.value).eq(15)).toBe(true);
  });

  it('ownedCount and extraCount default to 0 when neither is configured (count = 1)', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<ClickDef>({
      id: 'test-extracount-defaults',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
      }),
      registerTick,
    });

    category.register({ id: 'passive', name: 'Passive', baseRate: 1 });

    const producer = category.getProducer('passive')!;
    expect(new Decimal(producer.ownedCount.value).eq(0)).toBe(true);
    expect(new Decimal(producer.extraCount.value).eq(0)).toBe(true);
    expect(new Decimal(producer.count.value).eq(1)).toBe(true);
  });

  it('two-tier cascade: T2 generates T1, T1 emits to coin (closed-form check)', () => {
    const { registerTick, tick } = createManualTicks();
    const cookies = createTestResource('cookies', 1e6);
    const coin = createTestResource('coin');
    const generated1 = createTestResource('generated1');

    const category = createProducerCategory<BuildingDef>({
      id: 'test-cascade',
      mapProducer: (def) => {
        if (def.id === 't1') {
          return {
            resource: coin,
            baseRate: def.baseRate,
            trigger: 'continuous',
            purchase: {
              costResource: cookies,
              baseCost: def.baseCost,
              costRatio: def.costRatio,
            },
            extraCount: () => generated1.value,
          };
        }
        // t2 emits into generated1 (drives t1's extraCount)
        return {
          resource: generated1,
          baseRate: def.baseRate,
          trigger: 'continuous',
          purchase: {
            costResource: cookies,
            baseCost: def.baseCost,
            costRatio: def.costRatio,
          },
        };
      },
      registerTick,
    });

    category.register([
      { id: 't1', name: 'T1', baseRate: 1, baseCost: 100, costRatio: 1.15 },
      { id: 't2', name: 'T2', baseRate: 1, baseCost: 1000, costRatio: 1.15 },
    ]);

    const t1 = category.getProducer('t1')!;
    const t2 = category.getProducer('t2')!;
    t1.purchasable!.purchase(1);
    t2.purchasable!.purchase(1);

    // Sub-tick to keep Euler error tiny against the closed form below.
    const dt = 0.001;
    const steps = 1000;
    for (let i = 0; i < steps; i++) tick(dt);
    const t = dt * steps; // 1.0s

    // Closed form (continuous, baseRate = 1 for both, owned = 1 each):
    //   generated1(t) = t           (T2 produces 1/s)
    //   coin(t)       = t + t^2 / 2 (T1 owned + T1 extra accumulating)
    // The discretized loop trails by O(dt); 1e-3 dt keeps the gap < 1e-3.
    const expectedGen1 = t;
    const expectedCoin = t + (t * t) / 2;

    expect(Math.abs(new Decimal(generated1.value).toNumber() - expectedGen1)).toBeLessThan(1e-3);
    expect(Math.abs(new Decimal(coin.value).toNumber() - expectedCoin)).toBeLessThan(1e-3);
  });

  it('no repeatable when purchase config omitted', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<ClickDef>({
      id: 'test20',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'manual',
      }),
      registerTick,
    });

    category.register({ id: 'click', name: 'Click', baseRate: 1 });

    const producer = category.getProducer('click')!;
    expect(producer.purchasable).toBeUndefined();
  });

  it('reads a reactive costRatio into the next purchase cost', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies', 1e9);
    const scaling = ref(2);

    const category = createProducerCategory<BuildingDef>({
      id: 'reactive-scaling',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
        purchase: { costResource: cookies, baseCost: def.baseCost, costRatio: scaling },
      }),
      registerTick,
    });
    category.register({ id: 'mine', name: 'Mine', baseRate: 1, baseCost: 10, costRatio: 0 });

    const repeatable = category.getProducer('mine')!.purchasable!;
    repeatable.purchase(1);
    expect(new Decimal(repeatable.getCost(1)).toNumber()).toBeCloseTo(20, 5);
    scaling.value = 3;
    expect(new Decimal(repeatable.getCost(1)).toNumber()).toBeCloseTo(30, 5);
  });

  it('reads a tunable baseRate, so a scoped override moves the rate and the tick output', () => {
    const { registerTick, tick } = createManualTicks();
    const cookies = createTestResource('cookies', 0);
    const tuning = createTuningRegistry('reactive-rate-tuning');

    const category = createProducerCategory<ClickDef>({
      id: 'reactive-rate',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: tunable(tuning, `producers/${def.id}/baseRate`, () => def.baseRate),
        trigger: 'continuous',
      }),
      registerTick,
    });
    category.register({ id: 'well', name: 'Well', baseRate: 2 });

    const producer = category.getProducer('well')!;
    expect(new Decimal(producer.computedRate.value).toNumber()).toBe(2);

    const pop = tuning.pushOverrides('probe', { 'producers/well/baseRate': () => 5 });
    expect(new Decimal(producer.computedRate.value).toNumber()).toBe(5);
    tick(1);
    expect(new Decimal(cookies.value).toNumber()).toBe(5);

    pop();
    expect(new Decimal(producer.computedRate.value).toNumber()).toBe(2);
  });
});

// ============================================================================
// The tick walk
// ============================================================================

describe('producer category tick', () => {
  it('writes each resource once per tick, however many producers feed it', () => {
    const { registerTick, tick } = createManualTicks();
    const cookies = createTestResource('cookies');
    const category = createProducerCategory<BuildingDef>({
      id: 'walk-writes',
      mapProducer: (def) => ({ resource: cookies, baseRate: def.baseRate, trigger: 'continuous' }),
      registerTick,
    });
    category.register([
      { id: 'a', name: 'A', baseRate: 1, baseCost: 0, costRatio: 1 },
      { id: 'b', name: 'B', baseRate: 2, baseCost: 0, costRatio: 1 },
      { id: 'c', name: 'C', baseRate: 3, baseCost: 0, costRatio: 1 },
    ]);
    let writes = 0;
    watch(cookies, () => writes++, { flush: 'sync' });

    tick(1);

    expect(writes).toBe(1);
    expect(new Decimal(cookies.value).eq(6)).toBe(true);
  });

  it("reads every producer's rate from the state before the tick, whatever the walk order", () => {
    const { registerTick, tick } = createManualTicks();
    const cookies = createTestResource('cookies');
    const category = createProducerCategory<BuildingDef>({
      id: 'walk-order',
      mapProducer: (def) => ({
        resource: cookies,
        // `b` produces at the amount held, so it would see `a`'s gain mid-walk.
        baseRate: def.id === 'b' ? () => cookies.value : def.baseRate,
        trigger: 'continuous',
      }),
      registerTick,
    });
    category.register([
      { id: 'a', name: 'A', baseRate: 10, baseCost: 0, costRatio: 1 },
      { id: 'b', name: 'B', baseRate: 0, baseCost: 0, costRatio: 1 },
    ]);

    tick(1);

    expect(new Decimal(cookies.value).eq(10)).toBe(true);
  });

  for (const [order, ids] of [
    ['gain first', ['gain', 'loss']],
    ['loss first', ['loss', 'gain']],
  ] as const) {
    it(`clamps a loss against the tick's gains (${order})`, () => {
      const { registerTick, tick } = createManualTicks();
      const cookies = createTestResource('cookies');
      const category = createProducerCategory<BuildingDef>({
        id: `walk-loss-${ids[0]}`,
        mapProducer: (def) => ({
          resource: cookies,
          baseRate: def.baseRate,
          trigger: 'continuous',
        }),
        registerTick,
      });
      category.register(
        ids.map((id) => ({
          id,
          name: id,
          baseRate: id === 'gain' ? 5 : -3,
          baseCost: 0,
          costRatio: 1,
        })),
      );

      tick(1);

      expect(new Decimal(cookies.value).eq(2)).toBe(true);
    });
  }

  it("lets a converter draw the tick's gains", () => {
    const { registerTick, tick } = createManualTicks();
    const ore = createTestResource('ore');
    const ingots = createTestResource('ingots');
    const category = createProducerCategory<BuildingDef>({
      id: 'walk-converter',
      mapProducer: (def) =>
        def.id === 'mine'
          ? { resource: ore, baseRate: 4, trigger: 'continuous' }
          : {
              resource: ingots,
              baseRate: 10,
              trigger: 'continuous',
              inputs: { ore: { resource: ore, per: 2 } },
            },
      registerTick,
    });
    category.register([
      { id: 'mine', name: 'Mine', baseRate: 0, baseCost: 0, costRatio: 1 },
      { id: 'smelter', name: 'Smelter', baseRate: 0, baseCost: 0, costRatio: 1 },
    ]);

    tick(1);

    expect(new Decimal(ingots.value).eq(2)).toBe(true);
    expect(new Decimal(ore.value).eq(0)).toBe(true);
  });
});

// ============================================================================
// purchaseBeatSeconds
// ============================================================================

describe('Producer.purchaseBeatSeconds', () => {
  it('computes cost / (rate * max(1, count)) for purchasable producers', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies', 1000);

    const category = createProducerCategory<BuildingDef>({
      id: 'beat-basic',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
        purchase: {
          costResource: cookies,
          baseCost: def.baseCost,
          costRatio: def.costRatio,
        },
      }),
      registerTick,
    });

    category.register({
      id: 'cursor',
      name: 'Cursor',
      baseRate: 1,
      baseCost: 10,
      costRatio: 1.15,
    });

    const producer = category.getProducer('cursor')!;
    // count=0 → max(1, 0)=1; cost(1)=10; rate=1 → beat = 10
    expect(producer.purchaseBeatSeconds.value).toBe(10);

    producer.purchasable!.purchase(1);
    // count=1; rate=1; cost(1)=10 * 1.15 = 11.5 → beat = 11.5
    expect(producer.purchaseBeatSeconds.value).toBeCloseTo(11.5, 5);
  });

  it('returns Infinity when repeatable is absent', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<ClickDef>({
      id: 'beat-manual',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'manual',
      }),
      registerTick,
    });

    category.register({ id: 'click', name: 'Click', baseRate: 1 });
    expect(category.getProducer('click')!.purchaseBeatSeconds.value).toBe(Infinity);
  });

  it('returns Infinity when computed rate is zero', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies');

    const category = createProducerCategory<BuildingDef>({
      id: 'beat-zero-rate',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: 0,
        trigger: 'continuous',
        purchase: {
          costResource: cookies,
          baseCost: def.baseCost,
          costRatio: def.costRatio,
        },
      }),
      registerTick,
    });

    category.register({
      id: 'broken',
      name: 'Broken',
      baseRate: 0,
      baseCost: 10,
      costRatio: 1.15,
    });

    expect(category.getProducer('broken')!.purchaseBeatSeconds.value).toBe(Infinity);
  });

  it('reacts to a ref-backed multiplier on the rateChain', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies', 1000);

    const category = createProducerCategory<BuildingDef>({
      id: 'beat-reactive',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
        purchase: {
          costResource: cookies,
          baseCost: def.baseCost,
          costRatio: def.costRatio,
        },
      }),
      registerTick,
    });

    // Attach the modifier BEFORE first read so computedRate's dep set includes
    // the multiplier ref. (chain.add() after the first read doesn't invalidate
    // computedRate — that's a separate framework limitation, not a beat-calc
    // concern: real games attach modifiers at module-install time.)
    category.register({
      id: 'cursor',
      name: 'Cursor',
      baseRate: 1,
      baseCost: 10,
      costRatio: 1.15,
    });

    const producer = category.getProducer('cursor')!;
    const multiplier = ref<DecimalSource>(1);
    producer.rateChain.add(createMultiplicativeModifier({ multiplier }));

    // rate=1, cost=10, count=0 → beat = 10 / 1 = 10
    expect(producer.purchaseBeatSeconds.value).toBe(10);

    // Flip the reactive multiplier: rate=2 → beat = 10 / 2 = 5
    multiplier.value = 2;
    expect(producer.purchaseBeatSeconds.value).toBe(5);
  });
});

describe('Producer signed-rate integration', () => {
  it('a net-negative composed rate drains the resource', () => {
    const { registerTick, tick } = createManualTicks();
    const catnip = createTestResource('catnip', 100);

    const category = createProducerCategory<BuildingDef>({
      id: 'net-negative',
      mapProducer: (def) => ({
        resource: catnip,
        baseRate: def.baseRate,
        trigger: 'continuous',
      }),
      registerTick,
    });

    category.register({
      id: 'field',
      name: 'Field',
      baseRate: 5,
      baseCost: 10,
      costRatio: 1.15,
    });

    const producer = category.getProducer('field')!;

    // Consumption bound onto the same rate chain outweighs production:
    // 5 produced - 8 consumed = -3/sec net.
    producer.rateChain.add(createAdditiveModifier({ addend: -8, description: 'Upkeep' }));
    expect(new Decimal(producer.computedRate.value).eq(-3)).toBe(true);

    tick(1);

    expect(new Decimal(catnip.value).eq(97)).toBe(true);
  });

  it('a drain floors at zero by default, taking what remains', () => {
    const { registerTick, tick } = createManualTicks();
    const catnip = createTestResource('catnip', 2);

    const category = createProducerCategory<BuildingDef>({
      id: 'drain-clamped',
      mapProducer: (def) => ({
        resource: catnip,
        baseRate: def.baseRate,
        trigger: 'continuous',
      }),
      registerTick,
    });

    category.register({
      id: 'field',
      name: 'Field',
      baseRate: -5,
      baseCost: 10,
      costRatio: 1.15,
    });

    // Demand is 5, balance is 2 — the shortfall drains the remainder rather
    // than refusing outright the way subtractResource would.
    tick(1);

    expect(new Decimal(catnip.value).eq(0)).toBe(true);
  });

  it('allowNegative lets the deficit accumulate below zero', () => {
    const { registerTick, tick } = createManualTicks();
    const catnip = createTestResource('catnip', 2);

    const category = createProducerCategory<BuildingDef>({
      id: 'drain-signed',
      mapProducer: (def) => ({
        resource: catnip,
        baseRate: def.baseRate,
        trigger: 'continuous',
        allowNegative: true,
      }),
      registerTick,
    });

    category.register({
      id: 'field',
      name: 'Field',
      baseRate: -5,
      baseCost: 10,
      costRatio: 1.15,
    });

    tick(1);

    // -3 is readable by a starvation detector; the clamped variant loses it.
    expect(new Decimal(catnip.value).eq(-3)).toBe(true);
  });
});

describe('producer inputs (a continuous converter)', () => {
  interface RecipeDef {
    id: string;
    rate: number;
  }
  const amount = (r: { value: DecimalSource }) => new Decimal(r.value).toNumber();

  it('debits each input per unit made, and makes only what the scarcest input feeds', () => {
    const { registerTick, tick } = createManualTicks();
    const meat = createTestResource('meat', 3);
    const wood = createTestResource('wood', 100);
    const jerky = createTestResource('jerky', 0);
    const racks = createProducerCategory<RecipeDef>({
      id: 'racks',
      mapProducer: (def) => ({
        resource: jerky,
        baseRate: def.rate,
        trigger: 'continuous',
        inputs: { meat: { resource: meat, per: 0.5 }, wood: { resource: wood, per: 2 } },
      }),
      registerTick,
    });
    racks.register({ id: 'rack', rate: 10 });

    tick(1);

    // Meat feeds 3 / 0.5 = 6 of the 10 the rate wants.
    expect(amount(jerky)).toBeCloseTo(6);
    expect(amount(meat)).toBeCloseTo(0);
    expect(amount(wood)).toBeCloseTo(88);
  });

  it('reports the realized rate and what bound the last tick', () => {
    const { registerTick, tick } = createManualTicks();
    const ore = createTestResource('ore', 100);
    const bars = createTestResource('bars', 0);
    const smelters = createProducerCategory<RecipeDef>({
      id: 'smelters',
      mapProducer: (def) => ({
        resource: bars,
        baseRate: def.rate,
        trigger: 'continuous',
        inputs: { ore: { resource: ore, per: 10 } },
      }),
      registerTick,
    });
    smelters.register({ id: 'smelter', rate: 4 });
    const smelter = smelters.getProducer('smelter')!;

    tick(2);
    expect(amount(smelter.realizedRate!)).toBeCloseTo(4);
    expect(smelter.bottleneck!.value).toBe('rate');

    // 20 ore left feeds 2 bars, against the 8 that 2 s at rate 4 wants.
    tick(2);
    expect(amount(smelter.realizedRate!)).toBeCloseTo(1);
    expect(smelter.bottleneck!.value).toBe('input:ore');

    tick(2);
    expect(amount(smelter.realizedRate!)).toBe(0);
  });

  it("throttles at a linked bag's cap instead of burning inputs into the overflow", () => {
    const { registerTick, tick } = createManualTicks();
    const ore = createTestResource('ore', 100);
    const bars = createTestResource('bars', 7);
    createResourceBag({ capacityPerType: { bars: 10 } }).link('bars', bars);
    const smelters = createProducerCategory<RecipeDef>({
      id: 'smelters-capped',
      mapProducer: (def) => ({
        resource: bars,
        baseRate: def.rate,
        trigger: 'continuous',
        inputs: { ore: { resource: ore, per: 2 } },
      }),
      registerTick,
    });
    smelters.register({ id: 'smelter', rate: 5 });

    tick(1);

    expect(amount(bars)).toBeCloseTo(10);
    expect(amount(ore)).toBeCloseTo(94);
    expect(smelters.getProducer('smelter')!.bottleneck!.value).toBe('capacity');
  });

  it('starts its last-tick report over on a reset and on a load', () => {
    const { registerTick, tick } = createManualTicks();
    const ore = createTestResource('ore', 100);
    const bars = createTestResource('bars', 7);
    createResourceBag({ capacityPerType: { bars: 10 } }).link('bars', bars);
    const smelters = createProducerCategory<RecipeDef>({
      id: 'smelters-hydrated',
      mapProducer: (def) => ({
        resource: bars,
        baseRate: def.rate,
        trigger: 'continuous',
        inputs: { ore: { resource: ore, per: 2 } },
      }),
      registerTick,
    });
    smelters.register({ id: 'smelter', rate: 5 });
    const smelter = smelters.getProducer('smelter')!;
    const report = () => [smelter.bottleneck!.value, amount(smelter.realizedRate!)];

    tick(1);
    expect(report()).toEqual(['capacity', 3]);
    createReset({ thingsToReset: [smelters] }).reset();
    expect(report()).toEqual(['rate', 0]);

    tick(1);
    expect(report()[0]).toBe('capacity');
    deserializePersistents(getAllPersistentRefs(), {});
    expect(report()).toEqual(['rate', 0]);
  });

  it('is not room-bound when the bag has room, whatever the float error of held + made − held', () => {
    const { registerTick, tick } = createManualTicks();
    const ore = createTestResource('ore', 100);
    // (held + made) − held lands an ulp below made for this pair.
    const bars = createTestResource('bars', 12.593465862187864);
    createResourceBag({ capacityPerType: { bars: 100 } }).link('bars', bars);
    const smelters = createProducerCategory<RecipeDef>({
      id: 'smelters-roomy',
      mapProducer: (def) => ({
        resource: bars,
        baseRate: def.rate,
        trigger: 'continuous',
        inputs: { ore: { resource: ore, per: 1 } },
      }),
      registerTick,
    });
    smelters.register({ id: 'smelter', rate: 0.36059794958967123 });

    tick(1);

    expect(smelters.getProducer('smelter')!.bottleneck!.value).toBe('rate');
    expect(amount(ore)).toBe(new Decimal(100).sub(0.36059794958967123).toNumber());
  });

  it('calls onProduce with what each tick made, and not on a tick that made nothing', () => {
    const { registerTick, tick } = createManualTicks();
    const pages = createTestResource('pages', 3);
    const notes = createTestResource('notes', 0);
    const made: number[] = [];
    const clerks = createProducerCategory<RecipeDef>({
      id: 'clerks',
      mapProducer: (def) => ({
        resource: notes,
        baseRate: def.rate,
        trigger: 'continuous',
        inputs: { pages: { resource: pages, per: 1 } },
        onProduce: (amount) => made.push(new Decimal(amount).toNumber()),
      }),
      registerTick,
    });
    clerks.register({ id: 'clerk', rate: 2 });

    tick(1);
    tick(1);
    tick(1);

    expect(made).toEqual([2, 1]);
  });

  it('claims a shared input in registration order', () => {
    const { registerTick, tick } = createManualTicks();
    const coal = createTestResource('coal', 6);
    const steel = createTestResource('steel', 0);
    const coke = createTestResource('coke', 0);
    const works = createProducerCategory<RecipeDef & { out: 'steel' | 'coke' }>({
      id: 'works',
      mapProducer: (def) => ({
        resource: def.out === 'steel' ? steel : coke,
        baseRate: def.rate,
        trigger: 'continuous',
        inputs: { coal: { resource: coal, per: 1 } },
      }),
      registerTick,
    });
    works.register([
      { id: 'foundry', rate: 4, out: 'steel' },
      { id: 'oven', rate: 4, out: 'coke' },
    ]);

    tick(1);

    expect(amount(steel)).toBeCloseTo(4);
    expect(amount(coke)).toBeCloseTo(2);
    expect(works.getProducer('oven')!.bottleneck!.value).toBe('input:coal');
  });

  it('refuses inputs on a manual producer or beside allowNegative', () => {
    const { registerTick } = createManualTicks();
    const ore = createTestResource('ore', 1);
    const bars = createTestResource('bars', 0);
    const build = (extra: { trigger?: 'manual'; allowNegative?: boolean }) =>
      createProducerCategory<RecipeDef>({
        id: `refuse-${extra.trigger ?? 'negative'}`,
        mapProducer: (def) => ({
          resource: bars,
          baseRate: def.rate,
          trigger: extra.trigger ?? 'continuous',
          allowNegative: extra.allowNegative,
          inputs: { ore: { resource: ore, per: 1 } },
        }),
        registerTick,
      }).register({ id: 'smelter', rate: 1 });

    expect(() => build({ trigger: 'manual' })).toThrow(/smelter.*inputs/);
    expect(() => build({ allowNegative: true })).toThrow(/smelter.*inputs/);
  });
});

describe('producer save keys', () => {
  function build(extraPurchasableFirst: boolean) {
    resetAllPersistentContexts();
    const { registerTick } = createManualTicks();
    return withPersistentContext('shop', () => {
      const cookies = createResource(1e6, { id: 'cookies', displayName: 'Cookies' });
      if (extraPurchasableFirst) {
        createScalingPurchasable({
          id: 'sale',
          description: 'Sale',
          resource: cookies,
          baseCost: 1,
          costRatio: 2,
        });
      }
      const category = createProducerCategory<BuildingDef>({
        id: 'buildings',
        mapProducer: (def) => ({
          resource: cookies,
          baseRate: def.baseRate,
          trigger: 'continuous',
          purchase: { costResource: cookies, baseCost: def.baseCost, costRatio: def.costRatio },
        }),
        registerTick,
      });
      category.register({ id: 'mine', name: 'Mine', baseRate: 5, baseCost: 10, costRatio: 1.15 });
      return category;
    });
  }

  it('owned counts load back when the build creates another purchasable first', () => {
    build(false).getProducer('mine')!.purchasable!.purchase(3);
    const saved = JSON.parse(JSON.stringify(serializePersistents(getAllPersistentRefs())));

    const rebuilt = build(true);
    deserializePersistents(getAllPersistentRefs(), saved);

    expect(new Decimal(rebuilt.getProducer('mine')!.count.value).eq(3)).toBe(true);
  });
});
