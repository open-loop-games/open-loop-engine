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
    const req = createBooleanRequirement({ met: true, description: 'always true' });
    expect(requirementsMet(req)).toBe(true);
  });

  it('createBooleanRequirement returns false when condition is false', () => {
    const req = createBooleanRequirement({ met: false, description: 'always false' });
    expect(requirementsMet(req)).toBe(false);
  });

  it('cost requirement is met when resource has enough', () => {
    const gold = createResource(new Decimal(100), { id: 'Gold', displayName: 'Gold' });
    const req = createCostRequirement({ resource: gold, cost: 50 });
    expect(requirementsMet(req)).toBe(true);
  });

  it('cost requirement is not met when resource has too little', () => {
    const gold = createResource(new Decimal(10), { id: 'Gold', displayName: 'Gold' });
    const req = createCostRequirement({ resource: gold, cost: 50 });
    expect(requirementsMet(req)).toBe(false);
  });

  it('payRequirements subtracts from resource', () => {
    const gold = createResource(new Decimal(100), { id: 'Gold', displayName: 'Gold' });
    const req = createCostRequirement({ resource: gold, cost: 30 });
    payRequirements(req);
    expect(Decimal.lte(gold.value, 70)).toBe(true);
  });

  it('isCostRequirement identifies cost requirements', () => {
    const gold = createResource(new Decimal(100), { id: 'Gold', displayName: 'Gold' });
    const costReq = createCostRequirement({ resource: gold, cost: 10 });
    const boolReq = createBooleanRequirement({ met: true });
    expect(isCostRequirement(costReq)).toBe(true);
    expect(isCostRequirement(boolReq)).toBe(false);
  });

  describe('non-Formula cost: balance == cost boundary (Decimal.div precision)', () => {
    // Decimal.div(x, x) returns 0.999...9 for layer-0 inputs, so the naive
    // floor(div(available, cost)) reports 0 affordable at exact equality.
    // met must round up values within FP tolerance of an integer.
    it.each([50, 100, 1000, 920000, 1e9])('reports met=1 at balance==cost==%i', (cost) => {
      const gold = createResource(new Decimal(cost), { id: 'Gold', displayName: 'Gold' });
      const req = createCostRequirement({ resource: gold, cost });
      expect(Decimal.eq(unref(req.met), 1)).toBe(true);
      expect(requirementsMet(req)).toBe(true);
    });

    it('reports met=N at balance==N×cost for bulk', () => {
      const gold = createResource(new Decimal(250), { id: 'Gold', displayName: 'Gold' });
      const req = createCostRequirement({ resource: gold, cost: 50, maxBulkCount: 5 });
      expect(Decimal.eq(unref(req.met), 5)).toBe(true);
    });

    it('genuine undershoot still reports false (no false snap)', () => {
      // 49.5 is not within 1e-7 relative tolerance of 50 — genuine undershoot.
      const gold = createResource(new Decimal(49.5), { id: 'Gold', displayName: 'Gold' });
      const req = createCostRequirement({ resource: gold, cost: 50 });
      expect(Decimal.eq(unref(req.met), 0)).toBe(true);
      expect(requirementsMet(req)).toBe(false);
    });

    it('reports met=N when balance accumulates to N×cost via FP', () => {
      // Construct a balance that lands at cost*5 via subtract-then-add cancellation.
      const cost = new Decimal(920000);
      let bal = Decimal.mul(cost, 5);
      bal = Decimal.add(bal, 0.000001);
      bal = Decimal.sub(bal, 0.000001);
      const gold = createResource(bal, { id: 'Gold', displayName: 'Gold' });
      const req = createCostRequirement({ resource: gold, cost: 920000, maxBulkCount: 5 });
      expect(Decimal.eq(unref(req.met), 5)).toBe(true);
    });
  });

  describe('anyOf', () => {
    it('is satisfied when any child is satisfied', () => {
      const gold = createResource(new Decimal(0), { id: 'Gold', displayName: 'Gold' });
      const req = anyOf(
        createCostRequirement({ resource: gold, cost: 50 }),
        createBooleanRequirement({ met: true }),
      );
      expect(requirementsMet(req)).toBe(true);
    });

    it('is unsatisfied when no child is satisfied', () => {
      const gold = createResource(new Decimal(10), { id: 'Gold', displayName: 'Gold' });
      const req = anyOf(
        createCostRequirement({ resource: gold, cost: 50 }),
        createBooleanRequirement({ met: false }),
      );
      expect(requirementsMet(req)).toBe(false);
    });

    it('reactively flips with child state changes', () => {
      const gold = createResource(new Decimal(10), { id: 'Gold', displayName: 'Gold' });
      const req = anyOf(
        createCostRequirement({ resource: gold, cost: 50 }),
        createBooleanRequirement({ met: false }),
      );
      expect(requirementsMet(req)).toBe(false);
      gold.value = new Decimal(100);
      expect(requirementsMet(req)).toBe(true);
    });

    it('pays the first satisfied pay-bearing child only', () => {
      const gold = createResource(new Decimal(100), { id: 'Gold', displayName: 'Gold' });
      const gems = createResource(new Decimal(100), { id: 'Gems', displayName: 'Gems' });
      const req = anyOf(
        createCostRequirement({ resource: gold, cost: 30 }),
        createCostRequirement({ resource: gems, cost: 50 }),
      );
      payRequirements(req);
      expect(Decimal.lte(gold.value, 70)).toBe(true);
      expect(Decimal.eq(gems.value, 100)).toBe(true);
    });

    it('skips payment when the satisfied branch is a pure gate', () => {
      const gold = createResource(new Decimal(100), { id: 'Gold', displayName: 'Gold' });
      const req = anyOf(
        createBooleanRequirement({ met: true }),
        createCostRequirement({ resource: gold, cost: 30 }),
      );
      payRequirements(req);
      expect(Decimal.eq(gold.value, 100)).toBe(true);
    });

    it('falls through to a pay-bearing later child when earlier child is unsatisfied', () => {
      const gold = createResource(new Decimal(0), { id: 'Gold', displayName: 'Gold' });
      const gems = createResource(new Decimal(100), { id: 'Gems', displayName: 'Gems' });
      const req = anyOf(
        createCostRequirement({ resource: gold, cost: 30 }),
        createCostRequirement({ resource: gems, cost: 40 }),
      );
      payRequirements(req);
      expect(Decimal.eq(gold.value, 0)).toBe(true);
      expect(Decimal.lte(gems.value, 60)).toBe(true);
    });

    it('reports requiresPay based on the first satisfied child', () => {
      const gold = createResource(new Decimal(100), { id: 'Gold', displayName: 'Gold' });

      // First satisfied is the pure gate — no pay.
      const gateFirst = anyOf(
        createBooleanRequirement({ met: true }),
        createCostRequirement({ resource: gold, cost: 30 }),
      );
      expect(unref(gateFirst.requiresPay)).toBe(false);

      // First satisfied is the cost — pay.
      const costFirst = anyOf(
        createCostRequirement({ resource: gold, cost: 30 }),
        createBooleanRequirement({ met: true }),
      );
      expect(unref(costFirst.requiresPay)).toBe(true);

      // Nothing satisfied — no pay.
      const noneSatisfied = anyOf(
        createBooleanRequirement({ met: false }),
        createBooleanRequirement({ met: false }),
      );
      expect(unref(noneSatisfied.requiresPay)).toBe(false);
    });

    it('joins child descriptions with " OR "', () => {
      const gold = createResource(new Decimal(100), { id: 'Gold', displayName: 'Gold' });
      const req = anyOf(
        createCostRequirement({ resource: gold, cost: 30, description: 'spend 30 gold' }),
        createBooleanRequirement({ met: true, description: 'tier 2 unlocked' }),
      );
      expect(unref(req.description)).toBe('spend 30 gold OR tier 2 unlocked');
    });
  });

  describe('allOf', () => {
    it('is satisfied only when every child is satisfied', () => {
      const gold = createResource(new Decimal(100), { id: 'Gold', displayName: 'Gold' });
      const both = allOf(
        createCostRequirement({ resource: gold, cost: 30 }),
        createBooleanRequirement({ met: true }),
      );
      expect(requirementsMet(both)).toBe(true);

      const oneFails = allOf(
        createCostRequirement({ resource: gold, cost: 30 }),
        createBooleanRequirement({ met: false }),
      );
      expect(requirementsMet(oneFails)).toBe(false);
    });

    it('pays every pay-bearing child', () => {
      const gold = createResource(new Decimal(100), { id: 'Gold', displayName: 'Gold' });
      const gems = createResource(new Decimal(100), { id: 'Gems', displayName: 'Gems' });
      const req = allOf(
        createCostRequirement({ resource: gold, cost: 30 }),
        createCostRequirement({ resource: gems, cost: 50 }),
        createBooleanRequirement({ met: true }),
      );
      payRequirements(req);
      expect(Decimal.lte(gold.value, 70)).toBe(true);
      expect(Decimal.lte(gems.value, 50)).toBe(true);
    });

    it('joins child descriptions with " AND "', () => {
      const gold = createResource(new Decimal(100), { id: 'Gold', displayName: 'Gold' });
      const req = allOf(
        createCostRequirement({ resource: gold, cost: 30, description: 'spend 30 gold' }),
        createBooleanRequirement({ met: true, description: 'tier 2 unlocked' }),
      );
      expect(unref(req.description)).toBe('spend 30 gold AND tier 2 unlocked');
    });
  });

  describe('combinator nesting', () => {
    it('anyOf composes with allOf for "(A AND B) OR C"', () => {
      const gold = createResource(new Decimal(100), { id: 'Gold', displayName: 'Gold' });
      const tier2 = createBooleanRequirement({ met: false });
      const fallback = createBooleanRequirement({ met: true });
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
    // Combinators expose boolean met — bulk semantics are
    // intentionally undefined. maxRequirementsMet returns dInf/0; callers
    // using combinators must pay with amount=1.
    it('returns dInf for satisfied anyOf', () => {
      const gold = createResource(new Decimal(100), { id: 'Gold', displayName: 'Gold' });
      const req = anyOf(
        createCostRequirement({ resource: gold, cost: 30 }),
        createBooleanRequirement({ met: false }),
      );
      expect(Decimal.eq(maxRequirementsMet(req), Decimal.dInf)).toBe(true);
    });

    it('returns 0 for unsatisfied allOf', () => {
      const gold = createResource(new Decimal(10), { id: 'Gold', displayName: 'Gold' });
      const req = allOf(
        createCostRequirement({ resource: gold, cost: 30 }),
        createBooleanRequirement({ met: true }),
      );
      expect(Decimal.eq(maxRequirementsMet(req), 0)).toBe(true);
    });

    it('returns dInf for empty requirements array', () => {
      // Mirrors `requirementsMet([]) === true` (vacuous .every). Bulk-purchase
      // callers passing a possibly-empty array must not crash.
      expect(Decimal.eq(maxRequirementsMet([]), Decimal.dInf)).toBe(true);
    });
  });
});
