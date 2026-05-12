import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { Decimal, bn, type DecimalSource } from '@/primitives/decimal';
import Formula from '@/core/formulas/formulas';

describe('Formula cost-scaling sugar constructors', () => {
  describe('Formula.exponential', () => {
    it('evaluates cost = base * mult^level', () => {
      const f = Formula.exponential(0, 10, 1.15);
      expect(new Decimal(f.evaluate(0)).eq(10)).toBe(true);
      expect(new Decimal(f.evaluate(1)).toNumber()).toBeCloseTo(11.5, 1);
    });
    it('inverts to find level from cost', () => {
      const f = Formula.exponential(0, 10, 1.15);
      const cost = f.evaluate(5);
      expect(new Decimal(f.invert(cost)).toNumber()).toBeCloseTo(5, 5);
    });
    it('closed-form integral matches naive sum for small ranges', () => {
      const f = Formula.exponential(0, 10, 1.15);
      let manual = new Decimal(0);
      for (let i = 0; i < 10; i++) manual = manual.add(new Decimal(f.evaluate(i)));
      const integralEnd = new Decimal(f.evaluateIntegral(10));
      const integralStart = new Decimal(f.evaluateIntegral(0));
      const closedForm = integralEnd.sub(integralStart);
      // Closed-form integral approximates discrete sum — loose tolerance
      expect(closedForm.div(manual).toNumber()).toBeCloseTo(1, 0);
    });
    it('reactive variable drives evaluation', () => {
      const level = ref<DecimalSource>(0);
      const f = Formula.exponential(level, 10, 1.15);
      expect(new Decimal(f.evaluate()).eq(10)).toBe(true);
      level.value = 2;
      expect(new Decimal(f.evaluate()).toNumber()).toBeCloseTo(13.225, 2);
    });
  });

  describe('Formula.linear', () => {
    it('evaluates cost = base + coef * level', () => {
      const f = Formula.linear(0, 10, 5);
      expect(new Decimal(f.evaluate(0)).eq(10)).toBe(true);
      expect(new Decimal(f.evaluate(3)).eq(25)).toBe(true);
    });
    it('inverts correctly', () => {
      const f = Formula.linear(0, 10, 5);
      expect(new Decimal(f.invert(bn(25))).toNumber()).toBeCloseTo(3, 5);
    });
    it('integrable', () => {
      const f = Formula.linear(0, 10, 5);
      expect(f.isIntegrable()).toBe(true);
    });
  });

  describe('Formula.polynomial', () => {
    it('evaluates cost = base * level^exp', () => {
      const f = Formula.polynomial(0, 10, 2);
      expect(new Decimal(f.evaluate(0)).eq(0)).toBe(true);
      expect(new Decimal(f.evaluate(3)).eq(90)).toBe(true);
    });
    it('inverts correctly', () => {
      const f = Formula.polynomial(0, 10, 2);
      expect(new Decimal(f.invert(bn(90))).toNumber()).toBeCloseTo(3, 5);
    });
    it('integrable', () => {
      const f = Formula.polynomial(0, 10, 2);
      expect(f.isIntegrable()).toBe(true);
    });
  });

  describe('Formula.preset', () => {
    it('gentle uses 1.07', () => {
      expect(new Decimal(Formula.preset(0, 'gentle', 10).evaluate(1)).toNumber()).toBeCloseTo(
        10.7,
        1,
      );
    });
    it('moderate uses 1.15', () => {
      expect(new Decimal(Formula.preset(0, 'moderate', 10).evaluate(1)).toNumber()).toBeCloseTo(
        11.5,
        1,
      );
    });
    it('aggressive uses 1.30', () => {
      expect(new Decimal(Formula.preset(0, 'aggressive', 10).evaluate(1)).toNumber()).toBeCloseTo(
        13.0,
        1,
      );
    });
  });
});
