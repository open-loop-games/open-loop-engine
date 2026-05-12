import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { beginPersistentContext, endPersistentContext } from '@/core/persistence';
import { createResource, addResource, type Resource } from '@/core/resource';
import { createSaveManager, createMemoryStorage } from '@/core/save-manager';
import {
  selectionCheapest,
  selectionPaybackPeriod,
  selectionHybridPayback,
  type SelectionPolicy,
} from '@/core/policy';
import { createProducerCategory, type Producer } from '@/systems/producer-category';
import { setupPolicyAutoPurchase, setupSweepAutoPurchase } from '@/systems/auto-purchase';
import { createPurchasable } from '@/systems/purchasable';
import { createCostRequirement } from '@/core/requirements';

// ============================================================================
// Helpers
// ============================================================================

function createTickManager() {
  const callbacks: ((dt: number) => void)[] = [];
  return {
    registerTick(cb: (dt: number) => void) {
      callbacks.push(cb);
      return () => {
        const idx = callbacks.indexOf(cb);
        if (idx >= 0) callbacks.splice(idx, 1);
      };
    },
    tick(dt: number) {
      for (const cb of callbacks) cb(dt);
    },
  };
}

function createTestResource(name: string, initial: DecimalSource = 0): Resource {
  return createResource(initial, { displayName: name });
}

interface BuildingDef {
  id: string;
  name: string;
  baseRate: number;
  baseCost: number;
  costScaling: number;
}

// ============================================================================
// Policy builders for tests — wire built-in factories to producer getters.
// Kept as helpers so each test reads the policy choice on a single line.
// ============================================================================

const cheapestPolicy = (): SelectionPolicy<Producer> =>
  selectionCheapest<Producer>((p) => p.repeatable!.getCost(1));

const paybackPeriodPolicy = (): SelectionPolicy<Producer> =>
  selectionPaybackPeriod<Producer>((p) => p.purchaseBeatSeconds.value);

const hybridPaybackPolicy = (
  category: { getTotalRate: (r: Resource) => DecimalSource },
  reserveRef?: { value: DecimalSource },
): SelectionPolicy<Producer> =>
  selectionHybridPayback<Producer>({
    getCost: (p) => p.repeatable!.getCost(1),
    getRate: (p) => p.computedRate.value,
    getResource: (p) => p.resource.value,
    getReserve: () => reserveRef?.value ?? 0,
    getHeadlineRate: (p) => category.getTotalRate(p.resource),
  });

// ============================================================================
// setupSweepAutoPurchase
// ============================================================================

describe('setupSweepAutoPurchase', () => {
  it('purchases every affordable purchasable each tick', () => {
    const cookies = createTestResource('cookies', 1_000);
    const { registerTick, tick } = createTickManager();

    const cheap = createPurchasable({
      id: 'cheap',
      requirements: createCostRequirement({ resource: cookies, cost: 10 }),
      limit: 1,
    });
    const dear = createPurchasable({
      id: 'dear',
      requirements: createCostRequirement({ resource: cookies, cost: 100 }),
      limit: 1,
    });

    setupSweepAutoPurchase([cheap, dear], true, registerTick);

    tick(0.1);
    expect(cheap.active.value).toBe(true);
    expect(dear.active.value).toBe(true);
  });

  it('skips purchasing while disabled and resumes when enabled', () => {
    const cookies = createTestResource('cookies', 1_000);
    const { registerTick, tick } = createTickManager();
    const enabled = ref(false);

    const upgrade = createPurchasable({
      id: 'upgrade',
      requirements: createCostRequirement({ resource: cookies, cost: 10 }),
      limit: 1,
    });

    setupSweepAutoPurchase([upgrade], enabled, registerTick);

    tick(0.1);
    expect(upgrade.active.value).toBe(false);

    enabled.value = true;
    tick(0.1);
    expect(upgrade.active.value).toBe(true);
  });
});

// ============================================================================
// setupPolicyAutoPurchase
// ============================================================================

describe('setupPolicyAutoPurchase', () => {
  function makeCategory(resource: Resource) {
    const { registerTick, tick } = createTickManager();
    const category = createProducerCategory<BuildingDef>({
      id: `auto-${Math.random().toString(36).slice(2, 8)}`,
      mapProducer: (def) => ({
        resource,
        baseRate: def.baseRate,
        trigger: 'continuous',
        purchase: {
          costResource: resource,
          baseCost: def.baseCost,
          costScaling: def.costScaling,
        },
      }),
      registerTick,
    });
    return { category, registerTick, tick };
  }

  it('cheapest policy buys the lowest-cost affordable producer', () => {
    const cookies = createTestResource('cookies', 1_000_000);
    const { category, registerTick, tick } = makeCategory(cookies);

    category.register([
      { id: 'cursor', name: 'Cursor', baseRate: 1, baseCost: 10, costScaling: 1.15 },
      { id: 'grandma', name: 'Grandma', baseRate: 10, baseCost: 100, costScaling: 1.15 },
      { id: 'farm', name: 'Farm', baseRate: 100, baseCost: 1100, costScaling: 1.15 },
    ]);

    setupPolicyAutoPurchase(category, { enabled: true, policy: cheapestPolicy() }, registerTick);

    tick(0.1);
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      1,
    );
    expect(new Decimal(category.getProducer('grandma')!.repeatable!.amount.value).toNumber()).toBe(
      0,
    );
  });

  it('payback-period policy picks by shortest purchaseBeatSeconds', () => {
    const cookies = createTestResource('cookies', 1_000_000);
    const { category, registerTick, tick } = makeCategory(cookies);

    // cursor: cost 100, rate 1     → beat 100
    // farm:   cost 110, rate 10    → beat 11   ← winner
    // tower:  cost 120, rate 1     → beat 120
    category.register([
      { id: 'cursor', name: 'Cursor', baseRate: 1, baseCost: 100, costScaling: 1.15 },
      { id: 'farm', name: 'Farm', baseRate: 10, baseCost: 110, costScaling: 1.15 },
      { id: 'tower', name: 'Tower', baseRate: 1, baseCost: 120, costScaling: 1.15 },
    ]);

    setupPolicyAutoPurchase(
      category,
      { enabled: true, policy: paybackPeriodPolicy() },
      registerTick,
    );

    tick(0.1);
    expect(new Decimal(category.getProducer('farm')!.repeatable!.amount.value).toNumber()).toBe(1);
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      0,
    );
    expect(new Decimal(category.getProducer('tower')!.repeatable!.amount.value).toNumber()).toBe(0);
  });

  it('does nothing when disabled', () => {
    const cookies = createTestResource('cookies', 1_000_000);
    const { category, registerTick, tick } = makeCategory(cookies);

    category.register({
      id: 'cursor',
      name: 'Cursor',
      baseRate: 1,
      baseCost: 10,
      costScaling: 1.15,
    });

    const enabled = ref(false);
    setupPolicyAutoPurchase(category, { enabled }, registerTick);

    tick(1);
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      0,
    );

    enabled.value = true;
    tick(0.1);
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      1,
    );
  });

  it('throttles purchases by interval', () => {
    const cookies = createTestResource('cookies', 1_000_000);
    const { category, registerTick, tick } = makeCategory(cookies);

    category.register({
      id: 'cursor',
      name: 'Cursor',
      baseRate: 1,
      baseCost: 10,
      costScaling: 1.15,
    });

    setupPolicyAutoPurchase(category, { enabled: true, interval: 2 }, registerTick);

    tick(0.5);
    tick(0.5);
    tick(0.5);
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      0,
    );

    tick(0.5); // accumulator now 2 → purchase fires
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      1,
    );

    tick(1.9);
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      1,
    );

    tick(0.2); // accumulator crosses 2 again
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      2,
    );
  });

  it('skips producers without repeatable and producers that cannot be afforded', () => {
    const cookies = createTestResource('cookies', 5);
    const { category, registerTick, tick } = makeCategory(cookies);

    category.register([
      { id: 'cheap', name: 'Cheap', baseRate: 1, baseCost: 3, costScaling: 1.15 },
      { id: 'expensive', name: 'Expensive', baseRate: 100, baseCost: 1000, costScaling: 1.15 },
    ]);

    setupPolicyAutoPurchase(
      category,
      { enabled: true, policy: paybackPeriodPolicy() },
      registerTick,
    );

    // Expensive has smaller beat but isn't affordable → cheap wins by fallback.
    tick(0.1);
    expect(new Decimal(category.getProducer('cheap')!.repeatable!.amount.value).toNumber()).toBe(1);
    expect(
      new Decimal(category.getProducer('expensive')!.repeatable!.amount.value).toNumber(),
    ).toBe(0);
  });

  it('cleanup unregisters the tick handler', () => {
    const cookies = createTestResource('cookies', 1_000_000);
    const { category, registerTick, tick } = makeCategory(cookies);

    category.register({
      id: 'cursor',
      name: 'Cursor',
      baseRate: 1,
      baseCost: 10,
      costScaling: 1.15,
    });

    const cleanup = setupPolicyAutoPurchase(category, { enabled: true }, registerTick);
    tick(0.1);
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      1,
    );

    cleanup();
    addResource(cookies, 1_000_000);
    tick(0.1);
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      1,
    );
  });

  it('hybrid-payback falls back to cheapest affordable when headline rate is zero', () => {
    // At t=0 with no owned producers, headline rate is 0 → hybrid-payback's
    // wait term would blow up. Expected behavior: degrade to cheapest among
    // affordable, letting the canPurchase filter handle "wait until first
    // purchase becomes possible."
    const cookies = createTestResource('cookies', 200);
    const { category, registerTick, tick } = makeCategory(cookies);

    category.register([
      { id: 'cursor', name: 'Cursor', baseRate: 1, baseCost: 10, costScaling: 1.15 },
      { id: 'farm', name: 'Farm', baseRate: 10, baseCost: 110, costScaling: 1.15 },
    ]);

    setupPolicyAutoPurchase(
      category,
      { enabled: true, policy: hybridPaybackPolicy(category) },
      registerTick,
    );

    tick(0.1);
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      1,
    );
    expect(new Decimal(category.getProducer('farm')!.repeatable!.amount.value).toNumber()).toBe(0);
  });

  it('hybrid-payback prefers higher-payback producers once headline rate is positive', () => {
    const cookies = createTestResource('cookies', 100_000);
    const { category, registerTick, tick } = makeCategory(cookies);

    category.register([
      { id: 'cursor', name: 'Cursor', baseRate: 1, baseCost: 10, costScaling: 1.15 },
      { id: 'farm', name: 'Farm', baseRate: 10, baseCost: 110, costScaling: 1.15 },
    ]);

    const cursor = category.getProducer('cursor')!.repeatable!;
    for (let i = 0; i < 10; i++) cursor.purchase(1);

    setupPolicyAutoPurchase(
      category,
      { enabled: true, policy: hybridPaybackPolicy(category) },
      registerTick,
    );

    tick(0.1);
    expect(new Decimal(category.getProducer('farm')!.repeatable!.amount.value).toNumber()).toBe(1);
  });

  it('drains multiple purchases when dt exceeds the interval', () => {
    const cookies = createTestResource('cookies', 1_000_000);
    const { category, registerTick, tick } = makeCategory(cookies);

    category.register({
      id: 'cursor',
      name: 'Cursor',
      baseRate: 1,
      baseCost: 10,
      costScaling: 1.15,
    });

    setupPolicyAutoPurchase(category, { enabled: true, interval: 1 }, registerTick);

    tick(3); // dt = 3 × interval → 3 drained slots
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      3,
    );
  });

  it('drain stops firing when reserve filters out all candidates mid-drain', () => {
    const cookies = createTestResource('cookies', 100);
    const { category, registerTick, tick } = makeCategory(cookies);

    category.register({
      id: 'cursor',
      name: 'Cursor',
      baseRate: 1,
      baseCost: 10,
      costScaling: 1.15,
    });

    // Reserve 70, cost starts at 10. Effective budget = resource − 70.
    //   slot 1: 100−70=30 ≥ 10 ✓ → buy. resource=90, cost=11.5
    //   slot 2:  90−70=20 ≥ 11.5 ✓ → buy. resource=78.5, cost=13.225
    //   slot 3:  78.5−70=8.5 < 13.225 → skip (and onward).
    setupPolicyAutoPurchase(
      category,
      {
        enabled: true,
        interval: 1,
        policy: cheapestPolicy(),
        reserve: 70,
      },
      registerTick,
    );

    tick(5);
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      2,
    );
  });

  it('hybrid-payback re-scores per drained slot so the winner can flip mid-drain', () => {
    const cookies = createTestResource('cookies', 10_000);
    const { category, registerTick, tick } = makeCategory(cookies);

    // Two producers. `burst` has far better single-purchase payback, but its
    // cost scales aggressively (×100 per level) so after one buy it becomes
    // far more expensive than `steady`. Pick-once-repeat would buy `burst`
    // 3×; recompute picks burst then steady then steady.
    category.register([
      { id: 'burst', name: 'Burst', baseRate: 100, baseCost: 100, costScaling: 100 },
      { id: 'steady', name: 'Steady', baseRate: 1, baseCost: 50, costScaling: 1.01 },
    ]);

    const steadySeed = category.getProducer('steady')!.repeatable!;
    for (let i = 0; i < 10; i++) steadySeed.purchase(1);

    setupPolicyAutoPurchase(
      category,
      {
        enabled: true,
        interval: 1,
        policy: hybridPaybackPolicy(category),
      },
      registerTick,
    );

    tick(3);

    const burstCount = new Decimal(
      category.getProducer('burst')!.repeatable!.amount.value,
    ).toNumber();
    const steadyCount = new Decimal(
      category.getProducer('steady')!.repeatable!.amount.value,
    ).toNumber();

    expect(burstCount).toBe(1);
    expect(steadyCount).toBe(10 + 2);
  });

  it('reserve prevents spending below the configured floor', () => {
    const cookies = createTestResource('cookies', 100);
    const { category, registerTick, tick } = makeCategory(cookies);

    category.register({
      id: 'cursor',
      name: 'Cursor',
      baseRate: 1,
      baseCost: 10,
      costScaling: 1.15,
    });

    // Reserve 95: resource 100, cost 10 → effective 5, short of cost. Skip.
    setupPolicyAutoPurchase(
      category,
      { enabled: true, policy: cheapestPolicy(), reserve: 95 },
      registerTick,
    );

    tick(0.1);
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      0,
    );

    addResource(cookies, 10); // resource now 110; effective 110−95 = 15 ≥ 10
    tick(0.1);
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      1,
    );
  });

  it('interval accumulator round-trips through exportSave/importSave', () => {
    // Regression: when a mid-run importSave restores the resource + purchase-
    // count state, the interval accumulator must be restored alongside them.
    const cookies = createResource<DecimalSource>(1_000_000);
    const { registerTick, tick } = createTickManager();
    const mgr = createSaveManager({ gameId: 'ol-672', storageAdapter: createMemoryStorage() });

    beginPersistentContext('ol-672-autobuy');
    const category = createProducerCategory<BuildingDef>({
      id: 'ol672',
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
    setupPolicyAutoPurchase(
      category,
      { enabled: true, interval: 2, policy: cheapestPolicy() },
      registerTick,
    );
    endPersistentContext();

    const cursor = category.getProducer('cursor')!.repeatable!;

    tick(1.3);
    expect(new Decimal(cursor.amount.value).toNumber()).toBe(0);

    const snapshot = mgr.exportSave();

    tick(0.8);
    expect(new Decimal(cursor.amount.value).toNumber()).toBe(1);

    const result = mgr.importSave(snapshot);
    expect(result.success).toBe(true);
    expect(new Decimal(cursor.amount.value).toNumber()).toBe(0);

    tick(0.8);
    expect(new Decimal(cursor.amount.value).toNumber()).toBe(1);
  });

  it('drives a custom SelectionPolicy<Producer> outside the three built-ins', () => {
    // Proves the abstraction holds: a consumer-defined policy that picks the
    // producer with the highest computedRate (a shape none of the built-in
    // factories cover) wires through the helper without modification.
    const cookies = createTestResource('cookies', 1_000_000);
    const { category, registerTick, tick } = makeCategory(cookies);

    category.register([
      { id: 'cursor', name: 'Cursor', baseRate: 1, baseCost: 10, costScaling: 1.15 },
      { id: 'farm', name: 'Farm', baseRate: 50, baseCost: 50, costScaling: 1.15 },
      { id: 'tower', name: 'Tower', baseRate: 5, baseCost: 30, costScaling: 1.15 },
    ]);

    const highestRate: SelectionPolicy<Producer> = {
      pick(candidates) {
        let best: Producer | undefined;
        let bestRate: Decimal | undefined;
        for (const c of candidates) {
          const rate = Decimal.fromValue(c.computedRate.value);
          if (bestRate === undefined || rate.gt(bestRate)) {
            best = c;
            bestRate = rate;
          }
        }
        return best;
      },
    };

    setupPolicyAutoPurchase(category, { enabled: true, policy: highestRate }, registerTick);

    tick(0.1);
    expect(new Decimal(category.getProducer('farm')!.repeatable!.amount.value).toNumber()).toBe(1);
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      0,
    );
    expect(new Decimal(category.getProducer('tower')!.repeatable!.amount.value).toNumber()).toBe(0);
  });
});
