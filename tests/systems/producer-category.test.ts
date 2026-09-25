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
  type DecimalSource,
} from '@/core/persistence';
import { createScalingPurchasable } from '@/systems/purchasable';
import { createResource } from '@/core/resource';
import { createMultiplicativeModifier, createAdditiveModifier } from '@/core/modifier';
import { createProducerCategory } from '@/systems/producer-category';
import { ref } from 'vue';
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
  costScaling: number;
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
      { id: 'cursor', name: 'Cursor', baseRate: 0.1, baseCost: 15, costScaling: 1.15 },
      { id: 'grandma', name: 'Grandma', baseRate: 1, baseCost: 100, costScaling: 1.15 },
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
      costScaling: 1.15,
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

    const def = { id: 'cursor', name: 'Cursor', baseRate: 0.1, baseCost: 15, costScaling: 1.15 };
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
      { id: 'b', name: 'B', baseRate: 2, baseCost: 1, costScaling: 1 },
      { id: 'a', name: 'A', baseRate: 1, baseCost: 1, costScaling: 1 },
      { id: 'c', name: 'C', baseRate: 3, baseCost: 1, costScaling: 1 },
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
      { id: 'cursor', name: 'Cursor', baseRate: 0.1, baseCost: 15, costScaling: 1.15 },
    ]);
    expect(category.size).toBe(1);

    // Mod adds more
    category.register([
      { id: 'portal', name: 'Portal', baseRate: 100, baseCost: 1e12, costScaling: 1.15 },
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
      costScaling: 1.15,
    });

    expect(() => {
      category.register({
        id: 'cursor',
        name: 'Cursor 2',
        baseRate: 0.2,
        baseCost: 20,
        costScaling: 1.2,
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
      costScaling: 1.15,
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
    category.register({ id: 'gen', name: 'Generator', baseRate: 10, baseCost: 0, costScaling: 1 });

    tick(1.0);
    // 10 rate * 1 count * 1.0 dt = 10
    expect(new Decimal(cookies.value).eq(10)).toBe(true);
  });

  it('continuous producer scales with repeatable count', () => {
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
          costScaling: def.costScaling,
        },
      }),
      registerTick,
    });

    category.register({ id: 'mine', name: 'Mine', baseRate: 5, baseCost: 10, costScaling: 1.15 });

    const producer = category.getProducer('mine')!;
    // Purchase 3 units
    producer.repeatable!.purchase(3);

    expect(new Decimal(producer.count.value).eq(3)).toBe(true);

    tick(0.5);
    // 5 rate * 3 count * 0.5 dt = 7.5
    expect(new Decimal(gold.value).eq(7.5)).toBe(true);
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
    expect(producer.repeatable).toBeUndefined();
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
        purchase: { costResource: cookies, baseCost: 10, costScaling: 1.15 },
        extraCount: cursors,
      }),
      registerTick,
    });

    category.register({ id: 'click', name: 'Click', baseRate: 2 });
    const producer = category.getProducer('click')!;
    producer.repeatable!.purchase(2);
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
        purchase: { costResource: cookies, baseCost: 10, costScaling: 1.15 },
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
          costScaling: def.costScaling,
        },
      }),
      registerTick,
    });

    // Give plenty of cookies for purchasing
    cookies.value = 1e9;

    category.register([
      { id: 'cursor', name: 'Cursor', baseRate: 1, baseCost: 1, costScaling: 1.01 },
      { id: 'grandma', name: 'Grandma', baseRate: 5, baseCost: 1, costScaling: 1.01 },
    ]);

    // Buy 2 cursors, 3 grandmas
    category.getProducer('cursor')!.repeatable!.purchase(2);
    category.getProducer('grandma')!.repeatable!.purchase(3);

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
          costScaling: def.costScaling,
        },
      }),
      registerTick,
    });

    category.register({
      id: 'cursor',
      name: 'Cursor',
      baseRate: 0.1,
      baseCost: 15,
      costScaling: 1.15,
    });

    const producer = category.getProducer('cursor')!;
    expect(producer.repeatable).toBeDefined();
    expect(new Decimal(producer.repeatable!.amount.value).eq(0)).toBe(true);

    producer.repeatable!.purchase(1);
    expect(new Decimal(producer.repeatable!.amount.value).eq(1)).toBe(true);
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
          costScaling: def.costScaling,
        },
        extraCount: () => generated.value,
      }),
      registerTick,
    });

    category.register({ id: 'mine', name: 'Mine', baseRate: 2, baseCost: 10, costScaling: 1.15 });

    const producer = category.getProducer('mine')!;
    producer.repeatable!.purchase(3); // owned = 3, extra = 4 → count = 7

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
    expect(producer.repeatable).toBeUndefined();
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
              costScaling: def.costScaling,
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
            costScaling: def.costScaling,
          },
        };
      },
      registerTick,
    });

    category.register([
      { id: 't1', name: 'T1', baseRate: 1, baseCost: 100, costScaling: 1.15 },
      { id: 't2', name: 'T2', baseRate: 1, baseCost: 1000, costScaling: 1.15 },
    ]);

    const t1 = category.getProducer('t1')!;
    const t2 = category.getProducer('t2')!;
    t1.repeatable!.purchase(1);
    t2.repeatable!.purchase(1);

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
    expect(producer.repeatable).toBeUndefined();
  });

  it('reads a reactive costScaling into the next purchase cost', () => {
    const { registerTick } = createManualTicks();
    const cookies = createTestResource('cookies', 1e9);
    const scaling = ref(2);

    const category = createProducerCategory<BuildingDef>({
      id: 'reactive-scaling',
      mapProducer: (def) => ({
        resource: cookies,
        baseRate: def.baseRate,
        trigger: 'continuous',
        purchase: { costResource: cookies, baseCost: def.baseCost, costScaling: scaling },
      }),
      registerTick,
    });
    category.register({ id: 'mine', name: 'Mine', baseRate: 1, baseCost: 10, costScaling: 0 });

    const repeatable = category.getProducer('mine')!.repeatable!;
    repeatable.purchase(1);
    expect(new Decimal(repeatable.getCost(1)).toNumber()).toBeCloseTo(20, 5);
    scaling.value = 3;
    expect(new Decimal(repeatable.getCost(1)).toNumber()).toBeCloseTo(30, 5);
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
          costScaling: def.costScaling,
        },
      }),
      registerTick,
    });

    category.register({
      id: 'cursor',
      name: 'Cursor',
      baseRate: 1,
      baseCost: 10,
      costScaling: 1.15,
    });

    const producer = category.getProducer('cursor')!;
    // count=0 → max(1, 0)=1; cost(1)=10; rate=1 → beat = 10
    expect(producer.purchaseBeatSeconds.value).toBe(10);

    producer.repeatable!.purchase(1);
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
          costScaling: def.costScaling,
        },
      }),
      registerTick,
    });

    category.register({
      id: 'broken',
      name: 'Broken',
      baseRate: 0,
      baseCost: 10,
      costScaling: 1.15,
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
          costScaling: def.costScaling,
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
      costScaling: 1.15,
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
      costScaling: 1.15,
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
      costScaling: 1.15,
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
      costScaling: 1.15,
    });

    tick(1);

    // -3 is readable by a starvation detector; the clamped variant loses it.
    expect(new Decimal(catnip.value).eq(-3)).toBe(true);
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
          costScaling: 2,
        });
      }
      const category = createProducerCategory<BuildingDef>({
        id: 'buildings',
        mapProducer: (def) => ({
          resource: cookies,
          baseRate: def.baseRate,
          trigger: 'continuous',
          purchase: { costResource: cookies, baseCost: def.baseCost, costScaling: def.costScaling },
        }),
        registerTick,
      });
      category.register({ id: 'mine', name: 'Mine', baseRate: 5, baseCost: 10, costScaling: 1.15 });
      return category;
    });
  }

  it('owned counts load back when the build creates another purchasable first', () => {
    build(false).getProducer('mine')!.repeatable!.purchase(3);
    const saved = JSON.parse(JSON.stringify(serializePersistents(getAllPersistentRefs())));

    const rebuilt = build(true);
    deserializePersistents(getAllPersistentRefs(), saved);

    expect(new Decimal(rebuilt.getProducer('mine')!.count.value).eq(3)).toBe(true);
  });
});
