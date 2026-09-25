import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import {
  beginPersistentContext,
  endPersistentContext,
  withPersistentContext,
  resetAllPersistentContexts,
  getAllPersistentRefs,
} from '@/core/persistence';
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
import { createPurchasable, createScalingPurchasable } from '@/systems/purchasable';
import { createPurchasableCategory } from '@/systems/purchasable-category';
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
  return createResource(initial, { id: name, displayName: name });
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

    setupSweepAutoPurchase([cheap, dear], { enabled: true }, registerTick);

    tick(0.1);
    expect(cheap.active.value).toBe(true);
    expect(dear.active.value).toBe(true);
  });

  it('sweeps a category, including purchasables registered after setup', () => {
    const cookies = createTestResource('cookies', 1_000);
    const { registerTick, tick } = createTickManager();
    const upgrades = createPurchasableCategory<{ id: string; cost: number }>({
      id: 'upgrades',
      mapPurchasable: (def) => ({
        display: def.id,
        requirements: createCostRequirement({ resource: cookies, cost: def.cost }),
        limit: 1,
      }),
    });
    upgrades.register({ id: 'early', cost: 10 });

    setupSweepAutoPurchase(upgrades, { enabled: true }, registerTick);
    tick(0.1);
    expect(upgrades.getPurchasable('early')!.active.value).toBe(true);

    upgrades.register({ id: 'late', cost: 10 });
    tick(0.1);
    expect(upgrades.getPurchasable('late')!.active.value).toBe(true);
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

    setupSweepAutoPurchase([upgrade], { enabled }, registerTick);

    tick(0.1);
    expect(upgrade.active.value).toBe(false);

    enabled.value = true;
    tick(0.1);
    expect(upgrade.active.value).toBe(true);
  });

  it('holds the reserve floor, clamping the buy instead of skipping it', () => {
    const cookies = createTestResource('cookies', 1_000);
    const { registerTick, tick } = createTickManager();

    // Cumulative cost of n levels: 100, ~433, ~1010. A 1000 bank reaches 3
    // outright; under a 400 floor only 600 is spendable, which reaches 2.
    // The clamp must buy those 2, not skip the candidate.
    const levels = createScalingPurchasable({
      id: 'levels',
      description: 'Leveled upgrade',
      resource: cookies,
      baseCost: 100,
      costScaling: 2,
    });

    setupSweepAutoPurchase([levels], { enabled: true, reserve: 400 }, registerTick);

    tick(0.1);
    expect(Decimal.eq(levels.amount.value, 2)).toBe(true);
    expect(Decimal.gte(cookies.value, 400)).toBe(true);
    // ...and 2 is the *most* it could take: one more level would breach.
    expect(Decimal.lt(Decimal.sub(cookies.value, levels.getCost(1)), 400)).toBe(true);
  });

  it('skips a candidate whose first level alone would breach the floor', () => {
    const cookies = createTestResource('cookies', 1_000);
    const { registerTick, tick } = createTickManager();

    const cheap = createPurchasable({
      id: 'cheap',
      requirements: createCostRequirement({ resource: cookies, cost: 50 }),
      limit: 1,
    });
    const dear = createPurchasable({
      id: 'dear',
      requirements: createCostRequirement({ resource: cookies, cost: 500 }),
      limit: 1,
    });

    setupSweepAutoPurchase([cheap, dear], { enabled: true, reserve: 600 }, registerTick);

    tick(0.1);
    expect(cheap.active.value).toBe(true);
    expect(dear.active.value).toBe(false);
    expect(Decimal.eq(cookies.value, 950)).toBe(true);
  });

  it('re-reads a bank-fraction reserve per candidate so the floor holds cumulatively', () => {
    const cookies = createTestResource('cookies', 1_000);
    const { registerTick, tick } = createTickManager();

    // Five 200-cost one-shots against a floor of half the *live* bank.
    // Re-read per candidate the floor shrinks as the bank drains, admitting
    // buys while `bank ≥ 400`: 1000→800→600→400→200, refusing the fifth.
    // Read once per beat it would freeze at 500 and refuse from the third on,
    // leaving the bank at 600 — so the two shapes are distinguishable here.
    const items = [1, 2, 3, 4, 5].map((n) =>
      createPurchasable({
        id: `item-${n}`,
        requirements: createCostRequirement({ resource: cookies, cost: 200 }),
        limit: 1,
      }),
    );

    setupSweepAutoPurchase(
      items,
      { enabled: true, reserve: () => Decimal.mul(0.5, cookies.value) },
      registerTick,
    );

    tick(0.1);
    expect(items.map((i) => i.active.value)).toEqual([true, true, true, true, false]);
    expect(Decimal.eq(cookies.value, 200)).toBe(true);
  });

  it('applies the floor per cost-resource on a multi-currency candidate', () => {
    const cookies = createTestResource('cookies', 1_000);
    const chips = createTestResource('chips', 100);
    const { registerTick, tick } = createTickManager();

    // Affordable in cookies under the floor, but chips has only 100 against a
    // 90 floor and a 50 cost — the second currency binds.
    const combo = createPurchasable({
      id: 'combo',
      requirements: [
        createCostRequirement({ resource: cookies, cost: 100 }),
        createCostRequirement({ resource: chips, cost: 50 }),
      ],
      limit: 1,
    });

    setupSweepAutoPurchase([combo], { enabled: true, reserve: 90 }, registerTick);

    tick(0.1);
    expect(combo.active.value).toBe(false);
    expect(Decimal.eq(chips.value, 100)).toBe(true);
  });

  it('sums cost requirements that share a resource before applying the floor', () => {
    const cookies = createTestResource('cookies', 1_000);
    const { registerTick, tick } = createTickManager();

    // Two 60-cost requirements drawn from one bank against a 900 floor: 100 of
    // budget, 120 of cost. Measured per requirement each one "fits"; they spend
    // from the same balance, so what the floor admits is their sum.
    const combo = createPurchasable({
      id: 'same-resource-combo',
      requirements: [
        createCostRequirement({ resource: cookies, cost: 60 }),
        createCostRequirement({ resource: cookies, cost: 60 }),
      ],
      limit: 1,
    });

    setupSweepAutoPurchase([combo], { enabled: true, reserve: 900 }, registerTick);

    tick(0.1);
    expect(combo.active.value).toBe(false);
    expect(Decimal.eq(cookies.value, 1_000)).toBe(true);
  });

  it('throttles on interval and does not replay elapsed beats', () => {
    const ctx = beginPersistentContext('sweep-interval');
    const cookies = createTestResource('cookies', 1_000);
    const { registerTick, tick } = createTickManager();

    const levels = createPurchasable({
      id: 'levels',
      requirements: createCostRequirement({ resource: cookies, cost: 100 }),
      limit: 3,
      bulkPurchase: false,
    });

    setupSweepAutoPurchase([levels], { enabled: true, interval: 2 }, registerTick);
    endPersistentContext(ctx);

    tick(1);
    expect(Decimal.eq(levels.amount.value, 0)).toBe(true);

    tick(1);
    expect(Decimal.eq(levels.amount.value, 1)).toBe(true);

    // 10s of catch-up is still one sweep, not five — a sweep is idempotent
    // per beat, so the elapsed beats collapse.
    tick(10);
    expect(Decimal.eq(levels.amount.value, 2)).toBe(true);
  });

  it('registers no persistent state when interval is omitted', () => {
    const cookies = createTestResource('cookies', 1_000);
    const { registerTick } = createTickManager();

    const upgrade = createPurchasable({
      id: 'upgrade',
      requirements: createCostRequirement({ resource: cookies, cost: 10 }),
      limit: 1,
    });

    // No ambient persistent context — the throttle-free path must not reach
    // for one.
    expect(() => setupSweepAutoPurchase([upgrade], { enabled: true }, registerTick)).not.toThrow();
  });
});

// ============================================================================
// setupPolicyAutoPurchase
// ============================================================================

describe('setupPolicyAutoPurchase', () => {
  function makeCategory(resource: Resource, costResource: Resource = resource) {
    const { registerTick, tick } = createTickManager();
    const category = createProducerCategory<BuildingDef>({
      id: `auto-${Math.random().toString(36).slice(2, 8)}`,
      mapProducer: (def) => ({
        resource,
        baseRate: def.baseRate,
        trigger: 'continuous',
        purchase: {
          costResource,
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

  it('hybrid-payback ranks affordable producers by payback when headline rate is zero', () => {
    // No owned producers, so no income: both are affordable and there is no
    // wait, leaving payback alone — farm's 5.5s beats the cheaper cursor's 10s.
    const cookies = createTestResource('cookies', 200);
    const { category, registerTick, tick } = makeCategory(cookies);

    category.register([
      { id: 'cursor', name: 'Cursor', baseRate: 1, baseCost: 10, costScaling: 1.15 },
      { id: 'farm', name: 'Farm', baseRate: 20, baseCost: 110, costScaling: 1.15 },
    ]);

    setupPolicyAutoPurchase(
      category,
      { enabled: true, policy: hybridPaybackPolicy(category) },
      registerTick,
    );

    tick(0.1);
    expect(new Decimal(category.getProducer('farm')!.repeatable!.amount.value).toNumber()).toBe(1);
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      0,
    );
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

  it('bails on the iteration cap and reports dropped iterations via onIterationsOverflow', () => {
    // Pathological config: tiny interval + a tick whose dt would drain 1M
    // slots. Without the cap the loop would synchronously freeze; with the
    // cap, the loop bails at `maxIterationsPerTick`, drops the accumulator,
    // and fires the diagnostic callback with the floor of the dropped count.
    const cookies = createTestResource('cookies', new Decimal('1e100'));
    const { category, registerTick, tick } = makeCategory(cookies);

    category.register({
      id: 'cursor',
      name: 'Cursor',
      baseRate: 1,
      baseCost: 1,
      costScaling: 1.0001,
    });

    let droppedReported: number | undefined;
    setupPolicyAutoPurchase(
      category,
      {
        enabled: true,
        interval: 1e-6,
        maxIterationsPerTick: 100,
        onIterationsOverflow: (n) => {
          droppedReported = n;
        },
      },
      registerTick,
    );

    tick(1); // dt = 1, interval = 1e-6 → 1M iters wanted, but capped at 100.

    // Exactly 100 purchases happen (cap), and the remainder is reported.
    expect(new Decimal(category.getProducer('cursor')!.repeatable!.amount.value).toNumber()).toBe(
      100,
    );
    expect(droppedReported).toBeGreaterThan(0);
    expect(droppedReported).toBeLessThanOrEqual(1_000_000);
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

  it('clamps bulkAmount to the reserve floor instead of buying through it', () => {
    const cookies = createTestResource('cookies', 100);
    const { category, registerTick, tick } = makeCategory(cookies);

    category.register({
      id: 'cursor',
      name: 'Cursor',
      baseRate: 1,
      baseCost: 10,
      costScaling: 1.15,
    });

    // Reserve 70 leaves a 30 budget. `bulkAmount: 10` would cost far more than
    // that, so the floor has to clamp the buy — the candidate filter only
    // proves a *single* unit fits under the floor.
    setupPolicyAutoPurchase(
      category,
      {
        enabled: true,
        interval: 1,
        policy: cheapestPolicy(),
        bulkAmount: 10,
        reserve: 70,
      },
      registerTick,
    );

    tick(5);
    expect(Decimal.gte(cookies.value, 70)).toBe(true);
    // ...and it bought as much as the floor allowed, rather than nothing.
    expect(Decimal.gt(category.getProducer('cursor')!.repeatable!.amount.value, 0)).toBe(true);
  });

  it('holds the floor on the cost resource, not the produced resource', () => {
    const cookies = createTestResource('cookies', 1_000);
    const chips = createTestResource('chips', 100);
    const { category, registerTick, tick } = makeCategory(cookies, chips);

    category.register({
      id: 'cursor',
      name: 'Cursor',
      baseRate: 1,
      baseCost: 50,
      costScaling: 1.15,
    });

    // A unit costs 50 chips against a 90-chip floor on a 100 bank, so nothing
    // is affordable under it. Measured against the *produced* resource — 1000
    // cookies — the same candidate looks comfortably payable.
    setupPolicyAutoPurchase(
      category,
      { enabled: true, interval: 1, policy: cheapestPolicy(), reserve: 90 },
      registerTick,
    );

    tick(5);
    expect(Decimal.eq(chips.value, 100)).toBe(true);
    expect(Decimal.eq(category.getProducer('cursor')!.repeatable!.amount.value, 0)).toBe(true);
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

  it('interval accumulators save under what they drive, not how many ran before', () => {
    const build = () => {
      resetAllPersistentContexts();
      const { registerTick } = createTickManager();
      withPersistentContext('shop', () => {
        const cookies = createResource<DecimalSource>(0, { id: 'cookies' });
        const category = createProducerCategory<BuildingDef>({
          id: 'buildings',
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
        const upgrade = createScalingPurchasable({
          id: 'sale',
          description: 'Sale',
          resource: cookies,
          baseCost: 1,
          costScaling: 2,
        });
        setupPolicyAutoPurchase(category, { enabled: true, interval: 2 }, registerTick);
        setupSweepAutoPurchase([upgrade], { enabled: true, interval: 2 }, registerTick);
      });
      return [...getAllPersistentRefs().keys()].filter((k) => k.includes('Accumulator')).sort();
    };

    const first = build();
    expect(first).toEqual([
      'shop.policyAutoPurchaseAccumulator:buildings',
      'shop.sweepAutoPurchaseAccumulator',
    ]);
    expect(build()).toEqual(first);
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
