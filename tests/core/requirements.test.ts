import { describe, it, expect } from 'vitest';
import { unref } from 'vue';
import {
  createCostRequirement,
  createBooleanRequirement,
  anyOf,
  allOf,
  requirementsMet,
  maxRequirementsMet,
  payRequirements,
  isCostRequirement,
} from '@/core/requirements';
import { createResource } from '@/core/resource';
import { Decimal } from '@/primitives/decimal';

describe('requirements module', () => {
  it('exports key functions', () => {
    expect(typeof createCostRequirement).toBe('function');
    expect(typeof createBooleanRequirement).toBe('function');
    expect(typeof requirementsMet).toBe('function');
    expect(typeof maxRequirementsMet).toBe('function');
    expect(typeof payRequirements).toBe('function');
    expect(typeof isCostRequirement).toBe('function');
  });

  it('createBooleanRequirement returns true when condition is true', () => {
    const req = createBooleanRequirement({ requirement: true, description: 'always true' });
    expect(requirementsMet(req)).toBe(true);
  });

  it('createBooleanRequirement returns false when condition is false', () => {
    const req = createBooleanRequirement({ requirement: false, description: 'always false' });
    expect(requirementsMet(req)).toBe(false);
  });

  it('cost requirement is met when resource has enough', () => {
    const gold = createResource(new Decimal(100), { displayName: 'Gold' });
    const req = createCostRequirement({ resource: gold, cost: 50 });
    expect(requirementsMet(req)).toBe(true);
  });

  it('cost requirement is not met when resource has too little', () => {
    const gold = createResource(new Decimal(10), { displayName: 'Gold' });
    const req = createCostRequirement({ resource: gold, cost: 50 });
    expect(requirementsMet(req)).toBe(false);
  });

  it('payRequirements subtracts from resource', () => {
    const gold = createResource(new Decimal(100), { displayName: 'Gold' });
    const req = createCostRequirement({ resource: gold, cost: 30 });
    payRequirements(req);
    expect(Decimal.lte(gold.value, 70)).toBe(true);
  });

  it('isCostRequirement identifies cost requirements', () => {
    const gold = createResource(new Decimal(100), { displayName: 'Gold' });
    const costReq = createCostRequirement({ resource: gold, cost: 10 });
    const boolReq = createBooleanRequirement({ requirement: true });
    expect(isCostRequirement(costReq)).toBe(true);
    expect(isCostRequirement(boolReq)).toBe(false);
  });

  describe('non-Formula cost: balance == cost boundary (Decimal.div precision)', () => {
    // Decimal.div(x, x) returns 0.999...9 for layer-0 inputs, so the naive
    // floor(div(available, cost)) reports 0 affordable at exact equality.
    // requirementMet must round up values within FP tolerance of an integer.
    it.each([50, 100, 1000, 920000, 1e9])(
      'reports requirementMet=1 at balance==cost==%i',
      (cost) => {
        const gold = createResource(new Decimal(cost));
        const req = createCostRequirement({ resource: gold, cost });
        expect(Decimal.eq(unref(req.requirementMet), 1)).toBe(true);
        expect(requirementsMet(req)).toBe(true);
      },
    );

    it('reports requirementMet=N at balance==N×cost for bulk', () => {
      const gold = createResource(new Decimal(250));
      const req = createCostRequirement({ resource: gold, cost: 50, maxBulkAmount: 5 });
      expect(Decimal.eq(unref(req.requirementMet), 5)).toBe(true);
    });

    it('genuine undershoot still reports false (no false snap)', () => {
      // 49.5 is not within 1e-7 relative tolerance of 50 — genuine undershoot.
      const gold = createResource(new Decimal(49.5));
      const req = createCostRequirement({ resource: gold, cost: 50 });
      expect(Decimal.eq(unref(req.requirementMet), 0)).toBe(true);
      expect(requirementsMet(req)).toBe(false);
    });

    it('reports requirementMet=N when balance accumulates to N×cost via FP', () => {
      // Construct a balance that lands at cost*5 via subtract-then-add cancellation.
      const cost = new Decimal(920000);
      let bal = Decimal.mul(cost, 5);
      bal = Decimal.add(bal, 0.000001);
      bal = Decimal.sub(bal, 0.000001);
      const gold = createResource(bal);
      const req = createCostRequirement({ resource: gold, cost: 920000, maxBulkAmount: 5 });
      expect(Decimal.eq(unref(req.requirementMet), 5)).toBe(true);
    });
  });

  describe('anyOf', () => {
    it('is satisfied when any child is satisfied', () => {
      const gold = createResource(new Decimal(0), { displayName: 'Gold' });
      const req = anyOf(
        createCostRequirement({ resource: gold, cost: 50 }),
        createBooleanRequirement({ requirement: true }),
      );
      expect(requirementsMet(req)).toBe(true);
    });

    it('is unsatisfied when no child is satisfied', () => {
      const gold = createResource(new Decimal(10), { displayName: 'Gold' });
      const req = anyOf(
        createCostRequirement({ resource: gold, cost: 50 }),
        createBooleanRequirement({ requirement: false }),
      );
      expect(requirementsMet(req)).toBe(false);
    });

    it('reactively flips with child state changes', () => {
      const gold = createResource(new Decimal(10), { displayName: 'Gold' });
      const req = anyOf(
        createCostRequirement({ resource: gold, cost: 50 }),
        createBooleanRequirement({ requirement: false }),
      );
      expect(requirementsMet(req)).toBe(false);
      gold.value = new Decimal(100);
      expect(requirementsMet(req)).toBe(true);
    });

    it('pays the first satisfied pay-bearing child only', () => {
      const gold = createResource(new Decimal(100), { displayName: 'Gold' });
      const gems = createResource(new Decimal(100), { displayName: 'Gems' });
      const req = anyOf(
        createCostRequirement({ resource: gold, cost: 30 }),
        createCostRequirement({ resource: gems, cost: 50 }),
      );
      payRequirements(req);
      expect(Decimal.lte(gold.value, 70)).toBe(true);
      expect(Decimal.eq(gems.value, 100)).toBe(true);
    });

    it('skips payment when the satisfied branch is a pure gate', () => {
      const gold = createResource(new Decimal(100), { displayName: 'Gold' });
      const req = anyOf(
        createBooleanRequirement({ requirement: true }),
        createCostRequirement({ resource: gold, cost: 30 }),
      );
      payRequirements(req);
      expect(Decimal.eq(gold.value, 100)).toBe(true);
    });

    it('falls through to a pay-bearing later child when earlier child is unsatisfied', () => {
      const gold = createResource(new Decimal(0), { displayName: 'Gold' });
      const gems = createResource(new Decimal(100), { displayName: 'Gems' });
      const req = anyOf(
        createCostRequirement({ resource: gold, cost: 30 }),
        createCostRequirement({ resource: gems, cost: 40 }),
      );
      payRequirements(req);
      expect(Decimal.eq(gold.value, 0)).toBe(true);
      expect(Decimal.lte(gems.value, 60)).toBe(true);
    });

    it('reports requiresPay based on the first satisfied child', () => {
      const gold = createResource(new Decimal(100), { displayName: 'Gold' });

      // First satisfied is the pure gate — no pay.
      const gateFirst = anyOf(
        createBooleanRequirement({ requirement: true }),
        createCostRequirement({ resource: gold, cost: 30 }),
      );
      expect(unref(gateFirst.requiresPay)).toBe(false);

      // First satisfied is the cost — pay.
      const costFirst = anyOf(
        createCostRequirement({ resource: gold, cost: 30 }),
        createBooleanRequirement({ requirement: true }),
      );
      expect(unref(costFirst.requiresPay)).toBe(true);

      // Nothing satisfied — no pay.
      const noneSatisfied = anyOf(
        createBooleanRequirement({ requirement: false }),
        createBooleanRequirement({ requirement: false }),
      );
      expect(unref(noneSatisfied.requiresPay)).toBe(false);
    });

    it('joins child descriptions with " OR "', () => {
      const gold = createResource(new Decimal(100), { displayName: 'Gold' });
      const req = anyOf(
        createCostRequirement({ resource: gold, cost: 30, description: 'spend 30 gold' }),
        createBooleanRequirement({ requirement: true, description: 'tier 2 unlocked' }),
      );
      expect(unref(req.description)).toBe('spend 30 gold OR tier 2 unlocked');
    });
  });

  describe('allOf', () => {
    it('is satisfied only when every child is satisfied', () => {
      const gold = createResource(new Decimal(100), { displayName: 'Gold' });
      const both = allOf(
        createCostRequirement({ resource: gold, cost: 30 }),
        createBooleanRequirement({ requirement: true }),
      );
      expect(requirementsMet(both)).toBe(true);

      const oneFails = allOf(
        createCostRequirement({ resource: gold, cost: 30 }),
        createBooleanRequirement({ requirement: false }),
      );
      expect(requirementsMet(oneFails)).toBe(false);
    });

    it('pays every pay-bearing child', () => {
      const gold = createResource(new Decimal(100), { displayName: 'Gold' });
      const gems = createResource(new Decimal(100), { displayName: 'Gems' });
      const req = allOf(
        createCostRequirement({ resource: gold, cost: 30 }),
        createCostRequirement({ resource: gems, cost: 50 }),
        createBooleanRequirement({ requirement: true }),
      );
      payRequirements(req);
      expect(Decimal.lte(gold.value, 70)).toBe(true);
      expect(Decimal.lte(gems.value, 50)).toBe(true);
    });

    it('joins child descriptions with " AND "', () => {
      const gold = createResource(new Decimal(100), { displayName: 'Gold' });
      const req = allOf(
        createCostRequirement({ resource: gold, cost: 30, description: 'spend 30 gold' }),
        createBooleanRequirement({ requirement: true, description: 'tier 2 unlocked' }),
      );
      expect(unref(req.description)).toBe('spend 30 gold AND tier 2 unlocked');
    });
  });

  describe('combinator nesting', () => {
    it('anyOf composes with allOf for "(A AND B) OR C"', () => {
      const gold = createResource(new Decimal(100), { displayName: 'Gold' });
      const tier2 = createBooleanRequirement({ requirement: false });
      const fallback = createBooleanRequirement({ requirement: true });
      const req = anyOf(
        allOf(createCostRequirement({ resource: gold, cost: 30 }), tier2),
        fallback,
      );
      expect(requirementsMet(req)).toBe(true);
      // Fallback (pure gate) is satisfied first; gold is not paid.
      payRequirements(req);
      expect(Decimal.eq(gold.value, 100)).toBe(true);
    });
  });

  describe('maxRequirementsMet on combinators', () => {
    // Combinators expose boolean requirementMet — bulk semantics are
    // intentionally undefined. maxRequirementsMet returns dInf/0; callers
    // using combinators must pay with amount=1.
    it('returns dInf for satisfied anyOf', () => {
      const gold = createResource(new Decimal(100));
      const req = anyOf(
        createCostRequirement({ resource: gold, cost: 30 }),
        createBooleanRequirement({ requirement: false }),
      );
      expect(Decimal.eq(maxRequirementsMet(req), Decimal.dInf)).toBe(true);
    });

    it('returns 0 for unsatisfied allOf', () => {
      const gold = createResource(new Decimal(10));
      const req = allOf(
        createCostRequirement({ resource: gold, cost: 30 }),
        createBooleanRequirement({ requirement: true }),
      );
      expect(Decimal.eq(maxRequirementsMet(req), 0)).toBe(true);
    });
  });
});
