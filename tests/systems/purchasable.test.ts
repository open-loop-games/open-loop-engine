import { describe, it, expect } from 'vitest';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { isRef, ref, unref } from 'vue';
import { createPurchasable, createScalingPurchasable } from '@/systems/purchasable';
import { createResource } from '@/core/resource';
import { createCostRequirement } from '@/core/requirements';
import Formula from '@/core/formulas/formulas';

describe('Purchasable (one-shot, limit: 1)', () => {
  it('starts as not bought (amount 0)', () => {
    const p = createPurchasable({
      id: 'p1',
      display: { title: 'Test', description: 'Test upgrade' },
      requirements: [],
      limit: 1,
    });
    expect(p.active.value).toBe(false);
    expect(Decimal.eq(p.count.value, 0)).toBe(true);
  });

  it('can be purchased when requirements met', () => {
    const p = createPurchasable({
      id: 'p2',
      display: { title: 'Free', description: 'Free upgrade' },
      requirements: [],
      limit: 1,
    });
    expect(p.canPurchase.value).toBe(true);
    const result = p.purchase();
    expect(Decimal.gte(result, 1)).toBe(true);
    expect(p.active.value).toBe(true);
  });

  it('cannot be purchased twice', () => {
    const p = createPurchasable({
      id: 'p3',
      display: { title: 'Once', description: 'One-time' },
      requirements: [],
      limit: 1,
    });
    p.purchase();
    expect(p.canPurchase.value).toBe(false);
    expect(p.maxed.value).toBe(true);
    const result = p.purchase();
    expect(Decimal.eq(result, 0)).toBe(true);
  });

  it('calls onPurchase callback', () => {
    let called = false;
    const p = createPurchasable({
      id: 'p4',
      display: { title: 'Callback', description: 'With callback' },
      requirements: [],
      limit: 1,
      onPurchase: () => {
        called = true;
      },
    });
    p.purchase();
    expect(called).toBe(true);
  });

  it('defaults purchaseMaxByDefault to false when limit is 1', () => {
    const p = createPurchasable({
      id: 'p5',
      display: 'one-shot',
      requirements: [],
      limit: 1,
    });
    expect(p.purchaseMaxByDefault).toBe(false);
  });

  it('takes a display with a title and no description', () => {
    const p = createPurchasable({
      id: 'p-title-only',
      display: { title: 'Forge' },
      requirements: [],
      limit: 1,
    });
    expect(unref(p.display.title)).toBe('Forge');
    expect(unref(p.display.description)).toBe('');
  });

  it('reads a ref display as the description', () => {
    const text = ref('first');
    const p = createPurchasable({ id: 'p-ref-display', display: text, requirements: [], limit: 1 });
    text.value = 'second';
    expect(unref(p.display.description)).toBe('second');
    expect(unref(p.display.title)).toBeUndefined();
  });

  it('defaults showAmount to false when limit is 1', () => {
    const p = createPurchasable({
      id: 'p6',
      display: { description: 'one-shot' },
      requirements: [],
      limit: 1,
    });
    expect(p.display.showAmount).toBe(false);
  });

  it('exposes static effect as computed', () => {
    const p = createPurchasable({
      id: 'p7',
      display: 'effect test',
      requirements: [],
      limit: 1,
      effect: 2,
    });
    expect(Decimal.eq(p.effect.value, 2)).toBe(true);
  });
});

describe('Purchasable (leveled, limit > 1)', () => {
  it('starts at amount 0', () => {
    const p = createPurchasable({
      id: 'p8',
      display: { title: 'Worker', description: 'Produces gold' },
      requirements: [],
    });
    expect(Decimal.eq(p.count.value, 0)).toBe(true);
    expect(p.active.value).toBe(false);
  });

  it('can be purchased when requirements met', () => {
    const p = createPurchasable({
      id: 'p9',
      display: { title: 'Free', description: 'Free repeatable' },
      requirements: [],
      purchaseMaxByDefault: false,
    });
    expect(p.canPurchase.value).toBe(true);
    p.purchase(1);
    expect(Decimal.eq(p.count.value, 1)).toBe(true);
    expect(p.active.value).toBe(true);
  });

  it('respects limit', () => {
    const p = createPurchasable({
      id: 'p10',
      display: { title: 'Limited', description: 'Max 3' },
      requirements: [],
      limit: 3,
    });
    p.purchaseMax();
    expect(p.maxed.value).toBe(true);
    expect(Decimal.eq(p.count.value, 3)).toBe(true);
  });

  it('defaults purchaseMaxByDefault to true when limit > 1', () => {
    const p = createPurchasable({
      id: 'p11',
      display: 'leveled',
      requirements: [],
    });
    expect(p.purchaseMaxByDefault).toBe(true);
  });

  it('defaults showAmount to true when limit > 1', () => {
    const p = createPurchasable({
      id: 'p12',
      display: { description: 'leveled' },
      requirements: [],
    });
    expect(p.display.showAmount).toBe(true);
  });

  it('computes effect from amount function', () => {
    const p = createPurchasable({
      id: 'p13',
      display: 'effect test',
      requirements: [],
      effect: (amount) => Decimal.pow(2, amount),
      purchaseMaxByDefault: false,
    });
    expect(Decimal.eq(p.effect.value, 1)).toBe(true); // 2^0 = 1
    p.purchase(1);
    expect(Decimal.eq(p.effect.value, 2)).toBe(true); // 2^1 = 2
    p.purchase(1);
    expect(Decimal.eq(p.effect.value, 4)).toBe(true); // 2^2 = 4
  });

  it('supports initialCount', () => {
    const p = createPurchasable({
      id: 'p14',
      display: 'pre-purchased',
      requirements: [],
      initialCount: 5,
      limit: 10,
    });
    expect(Decimal.eq(p.count.value, 5)).toBe(true);
    expect(p.active.value).toBe(true);
  });
});

describe('createScalingPurchasable — effectDescription', () => {
  it('defaults to a multiplier readout of the effect', () => {
    const points = createResource(1e6, { id: 'Points', displayName: 'Points' });
    const p = createScalingPurchasable({
      id: 'display-default',
      description: 'Multiplier',
      resource: points,
      baseCost: 10,
      costScaling: 1.15,
      effect: 2,
    });

    p.purchase(3);
    expect(unref(p.display.effectDescription)).toBe('×8.00');
  });

  it('takes an override for effects that are not multipliers', () => {
    const points = createResource(1e6, { id: 'Points', displayName: 'Points' });
    const p = createScalingPurchasable({
      id: 'display-override',
      description: 'Spell damage',
      resource: points,
      baseCost: 10,
      costScaling: 1.15,
      effect: (level: DecimalSource) => Decimal.mul(level, 0.25),
      effectDescription: '+0.25 damage per level',
    });

    p.purchase(2);
    expect(unref(p.display.effectDescription)).toBe('+0.25 damage per level');
  });
});

describe('createScalingPurchasable — effect as Formula', () => {
  it('DecimalSource shorthand auto-wraps as invertible Formula', () => {
    const points = createResource(1e6, { id: 'Points', displayName: 'Points' });
    const p = createScalingPurchasable({
      id: 'shorthand-effect',
      description: 'Shorthand effect',
      resource: points,
      baseCost: 10,
      costScaling: 1.15,
      effect: 2, // interpreted as 2^amount
    });

    expect(p.effectCurve).toBeDefined();
    // At amount 0: 2^0 = 1
    expect(Decimal.eq(p.effect.value, 1)).toBe(true);
    // Invert: 2^level = 8 → level = 3
    const levelForEight = new Decimal(p.effectCurve!.invert(8)).toNumber();
    expect(levelForEight).toBeCloseTo(3, 5);
  });

  it('accepts a Formula factory for effect and exposes effectCurve', () => {
    const points = createResource(1e6, { id: 'Points', displayName: 'Points' });
    const p = createScalingPurchasable({
      id: 'factory-effect',
      description: 'Factory effect',
      resource: points,
      baseCost: 10,
      costScaling: 1.15,
      // Linear effect: 1 + 0.5 * amount
      effectFormula: (amount) => Formula.variable(amount).mul(0.5).add(1),
    });

    expect(p.effectCurve).toBeDefined();
    // At amount 0: 1 + 0 = 1
    expect(Decimal.eq(p.effect.value, 1)).toBe(true);
    p.purchase(1);
    // At amount 1: 1.5
    expect(new Decimal(p.effect.value).toNumber()).toBeCloseTo(1.5);
    // Invert: 1 + 0.5*level = 11 → level = 20
    const levelForEleven = new Decimal(p.effectCurve!.invert(11)).toNumber();
    expect(levelForEleven).toBeCloseTo(20, 5);
  });

  it('opaque value function still works; effectCurve is undefined', () => {
    const points = createResource(1e6, { id: 'Points', displayName: 'Points' });
    const p = createScalingPurchasable({
      id: 'opaque-effect',
      description: 'Opaque effect',
      resource: points,
      baseCost: 10,
      costScaling: 1.15,
      // Non-Formula function that might do anything
      effect: (amount) => Decimal.add(Decimal.mul(amount, 3), 7),
    });

    expect(p.effectCurve).toBeUndefined();
    // At amount 0: 3*0 + 7 = 7
    expect(Decimal.eq(p.effect.value, 7)).toBe(true);
    p.purchase(1);
    expect(Decimal.eq(p.effect.value, 10)).toBe(true);
  });
});

describe('createScalingPurchasable — cost escalation regression', () => {
  it('getCost(1) reflects the next-level cost after purchase', () => {
    const r = createResource(1e9, { id: 'r', displayName: 'r' });
    const p = createScalingPurchasable({
      id: 'ol430-basic',
      description: 'cost escalation',
      resource: r,
      baseCost: 10,
      costScaling: 1.15,
    });

    expect(new Decimal(p.getCost(1)).toNumber()).toBeCloseTo(10, 5);
    p.purchase(1);
    // baseCost * 1.15^1
    expect(new Decimal(p.getCost(1)).toNumber()).toBeCloseTo(11.5, 5);
    p.purchase(1);
    // baseCost * 1.15^2
    expect(new Decimal(p.getCost(1)).toNumber()).toBeCloseTo(13.225, 4);
  });

  it('escalates correctly across multiple level steps', () => {
    const r = createResource(1e9, { id: 'r', displayName: 'r' });
    const p = createScalingPurchasable({
      id: 'ol430-multi',
      description: 'multi',
      resource: r,
      baseCost: 100,
      costScaling: 1.2,
    });

    // Buy 5 via repeated single purchases so the test is independent of bulk math.
    for (let i = 0; i < 5; i++) {
      p.purchase(1);
    }
    // Cost at level 5: 100 * 1.2^5 = 248.832
    expect(new Decimal(p.getCost(1)).toNumber()).toBeCloseTo(248.832, 3);
  });

  it('canPurchase and countToPurchase reflect escalated affordability', () => {
    // 500 cookies, cost 100 then 120, 144, 172.8, 207.36, 248.832 ...
    // Cumulative affordable from 0 with cost 100 * 1.2^k: at most 3 levels
    // (100 + 120 + 144 = 364 ≤ 500; + 172.8 = 536.8 > 500)
    const r = createResource(500, { id: 'r', displayName: 'r' });
    const p = createScalingPurchasable({
      id: 'ol430-afford',
      description: 'afford',
      resource: r,
      baseCost: 100,
      costScaling: 1.2,
    });

    p.purchase(1);
    // After buying one (100 spent, 400 left), next cost is 120 — affordable
    expect(p.canPurchase.value).toBe(true);
    p.purchase(1);
    // After two purchases (220 spent, 280 left), next cost is 144 — affordable
    expect(p.canPurchase.value).toBe(true);
    p.purchase(1);
    // After three purchases (364 spent, 136 left), next cost is 172.8 — NOT affordable
    expect(p.canPurchase.value).toBe(false);
  });
});

describe('createScalingPurchasable — reactive geometric cost', () => {
  it('reads a ref costScaling into the next cost and the bulk cost', () => {
    const r = createResource(1e9, { id: 'r', displayName: 'r' });
    const scaling = ref<DecimalSource>(2);
    const p = createScalingPurchasable({
      id: 'reactive-scaling',
      description: 'reactive scaling',
      resource: r,
      baseCost: 10,
      costScaling: scaling,
    });

    p.purchase(1);
    expect(new Decimal(p.getCost(1)).toNumber()).toBeCloseTo(20, 5);

    scaling.value = 3;
    expect(new Decimal(p.getCost(1)).toNumber()).toBeCloseTo(30, 5);
    // Levels 1 and 2 at the new rate: 10·3 + 10·9.
    expect(new Decimal(p.getCost(2)).toNumber()).toBeCloseTo(120, 5);
  });
});

describe('createScalingPurchasable — purchaseMax at finite limit regression', () => {
  it('purchaseMax reaches the declared limit in a single call', () => {
    const r = createResource(1e308, { id: 'r', displayName: 'r' });
    const p = createScalingPurchasable({
      id: 'ol433-limit3',
      description: 'limit 3',
      resource: r,
      baseCost: 100,
      costScaling: 10,
      limit: 3,
      effectFormula: (amount) => Formula.variable(amount).mul(1).add(1),
    });

    const bought = p.purchaseMax();
    expect(new Decimal(p.count.value).toNumber()).toBe(3);
    expect(new Decimal(bought).toNumber()).toBe(3);
    expect(new Decimal(p.effect.value).toNumber()).toBe(4);
    expect(p.maxed.value).toBe(true);
  });

  it('createPurchasable with finite limit also reaches the limit via purchaseMax', () => {
    const r = createResource(1e308, { id: 'r', displayName: 'r' });
    const p = createPurchasable({
      id: 'p15',
      display: { description: 'non-scaling limit 3' },
      requirements: createCostRequirement({
        resource: r,
        cost: Formula.variable(0).add(100),
        maxBulkCount: 3,
      }),
      limit: 3,
      effect: (amt) => Decimal.add(amt, 1),
    });

    p.purchaseMax();
    expect(new Decimal(p.count.value).toNumber()).toBe(3);
    expect(p.maxed.value).toBe(true);
  });
});

describe('createScalingPurchasable — closure cost (cost / costFormula)', () => {
  it('opaque closure cost reads through scalingAmount as level rises', () => {
    const r = createResource(1e9, { id: 'r', displayName: 'r' });
    // Super-exponential: 10^(1 + level²) — not expressible in engine Formula
    // vocabulary, so the consumer takes the opaque-closure path.
    const p = createScalingPurchasable({
      id: 'closure-superexp',
      description: 'superexp',
      resource: r,
      cost: (level) => Decimal.pow(10, Decimal.add(1, Decimal.pow(level, 2))),
      purchaseMaxByDefault: false,
    });

    expect(Decimal.eq(p.getCost(1), 10)).toBe(true); // 10^(1+0) at level 0
    p.purchase();
    expect(Decimal.eq(p.getCost(1), 100)).toBe(true); // 10^(1+1) at level 1
    p.purchase();
    expect(Decimal.eq(p.getCost(1), 1e5)).toBe(true); // 10^(1+4) at level 2
  });

  it('opaque closure cost is paid against the resource', () => {
    const r = createResource(500, { id: 'r', displayName: 'r' });
    const p = createScalingPurchasable({
      id: 'closure-pay',
      description: 'closure pay',
      resource: r,
      cost: (level) => Decimal.add(100, Decimal.mul(level, 50)),
      purchaseMaxByDefault: false,
    });

    p.purchase();
    expect(Decimal.eq(r.value, 400)).toBe(true); // paid 100 at level 0
    p.purchase();
    expect(Decimal.eq(r.value, 250)).toBe(true); // paid 150 at level 1
  });

  it('Formula factory closure produces an invertible bulk-aware cost', () => {
    const r = createResource(1000, { id: 'r', displayName: 'r' });
    // 100 + level² via Formula vocabulary — bulk math should work.
    const p = createScalingPurchasable({
      id: 'formula-factory',
      description: 'formula factory',
      resource: r,
      costFormula: (amount) =>
        (Formula.variable(amount) as ReturnType<typeof Formula.variable>).pow(2).add(100),
    });

    expect(Decimal.eq(p.getCost(1), 100)).toBe(true); // 0²+100 at level 0
    p.purchase(1);
    expect(Decimal.eq(p.getCost(1), 101)).toBe(true); // 1²+100 at level 1
    p.purchase(1);
    expect(Decimal.eq(p.getCost(1), 104)).toBe(true); // 2²+100 at level 2
  });

  it('costFormula returning a plain value prices every rung at it', () => {
    const r = createResource(1000, { id: 'r', displayName: 'r' });
    const p = createScalingPurchasable({
      id: 'formula-constant',
      description: 'constant',
      resource: r,
      costFormula: () => 40,
    });

    expect(Decimal.eq(p.getCost(1), 40)).toBe(true);
    expect(Decimal.eq(p.purchaseMax(), 25)).toBe(true);
    expect(Decimal.eq(r.value, 0)).toBe(true);
  });

  it('calls a plain cost function only with the plain level', () => {
    const r = createResource(1000, { id: 'r', displayName: 'r' });
    const seen: unknown[] = [];
    const p = createScalingPurchasable({
      id: 'closure-args',
      description: 'args',
      resource: r,
      cost: (level) => {
        seen.push(level);
        return 10;
      },
    });

    p.getCost(1);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((level) => !isRef(level))).toBe(true);
  });

  it('opaque closure that indexes a table by level builds and prices each rung', () => {
    const r = createResource(1000, { id: 'r', displayName: 'r' });
    const COSTS = [{ cost: 10 }, { cost: 25 }, { cost: 70 }];
    const p = createScalingPurchasable({
      id: 'closure-table',
      description: 'table',
      resource: r,
      cost: (level: DecimalSource) => COSTS[Number(level)]!.cost,
      limit: COSTS.length,
    });

    expect(Decimal.eq(p.getCost(1), 10)).toBe(true);
    p.purchase();
    expect(Decimal.eq(p.getCost(1), 25)).toBe(true);
    p.purchase();
    expect(Decimal.eq(r.value, 965)).toBe(true);
  });

  it('opaque closure disables bulk purchase (maxBulkCount = 1)', () => {
    const r = createResource(1e6, { id: 'r', displayName: 'r' });
    const p = createScalingPurchasable({
      id: 'closure-no-bulk',
      description: 'no bulk',
      resource: r,
      cost: (level) => Decimal.add(10, Decimal.mul(level, 1)),
    });

    // countToPurchase caps at 1 because the cost is non-Formula.
    expect(new Decimal(p.countToPurchase.value).toNumber()).toBe(1);
  });

  it('geometric path remains unchanged (regression)', () => {
    const r = createResource(1e9, { id: 'r', displayName: 'r' });
    const p = createScalingPurchasable({
      id: 'geometric-regression',
      description: 'geometric',
      resource: r,
      baseCost: 100,
      costScaling: 2,
    });

    expect(Decimal.eq(p.getCost(1), 100)).toBe(true);
    p.purchase(1);
    expect(Decimal.eq(p.getCost(1), 200)).toBe(true);
    p.purchase(1);
    expect(Decimal.eq(p.getCost(1), 400)).toBe(true);
  });

  it('closure cost reactively flips canPurchase when resource crosses threshold', () => {
    const r = createResource<DecimalSource>(50, { id: 'r', displayName: 'r' });
    const p = createScalingPurchasable({
      id: 'closure-canpurchase',
      description: 'reactive',
      resource: r,
      cost: (level) => Decimal.add(100, Decimal.mul(level, 100)),
      purchaseMaxByDefault: false,
    });

    expect(p.canPurchase.value).toBe(false); // 50 < 100
    r.value = new Decimal(150);
    expect(p.canPurchase.value).toBe(true); // 150 ≥ 100
  });
});

describe('createPurchasable — requirements as a factory over the level ref', () => {
  it("hands the factory the purchasable's own amount ref, so the cost is invertible", () => {
    const points = createResource(1e6, { id: 'points', displayName: 'points' });
    const p = createPurchasable({
      id: 'ladder',
      display: 'Geometric ladder',
      requirements: (level) =>
        createCostRequirement({
          resource: points,
          cost: Formula.exponential(level, 10, 1.15),
          maxBulkCount: Decimal.dInf,
        }),
    });

    // Cumulative, not linear: 10 + 11.5 + 13.225. The getter form prices 3 × 10.
    expect(Decimal.eq_tolerance(p.getCost(3), 34.725, 1e-9)).toBe(true);

    // No mirror watch: the cost tracks `amount` because it *is* `amount`.
    p.purchase(2);
    expect(Decimal.eq_tolerance(p.getCost(1), 13.225, 1e-9)).toBe(true);
  });
});
