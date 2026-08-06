/**
 * Series laws — the discrete sum, against brute-force summation.
 *
 * Every closed form here is checked against `Σ` computed term by term, which is
 * the definition. The umbrella's leaf 1 found eight inherited defects behind
 * capability flags that were tested while the arithmetic never was; this file
 * tests the arithmetic first and the flags only where they carry a decision.
 */

import { describe, expect, test } from 'vitest';
import { ref } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { Formula } from '@/core/formulas';
import { arithmeticSeries, geometricSeries, powerSeries } from '@/core/formulas/series';
import type { GenericFormula } from '@/core/formulas';
import { createResource } from '@/core/resource';
import { createCostRequirement, maxRequirementsMet, payRequirements } from '@/core/requirements';
import { createScalingPurchasable } from '@/systems/purchasable';

/** Σ f(from + i) for i in [0, count) — the definition. */
function bruteForce(f: (x: DecimalSource) => DecimalSource, from: number, count: number): Decimal {
  let total = new Decimal(0);
  for (let i = 0; i < count; i++) total = total.add(f(from + i));
  return total;
}

function relativeError(a: DecimalSource, b: DecimalSource): Decimal {
  if (Decimal.eq(b, 0)) return Decimal.abs(a);
  return Decimal.abs(Decimal.div(Decimal.sub(a, b), b));
}

const EXACT = 1e-12;

describe('closed forms match brute-force summation', () => {
  test('arithmeticSeries — Σ(a + i)', () => {
    for (const from of [0, 1, 7, 1000]) {
      for (const count of [0, 1, 2, 5, 40]) {
        const truth = bruteForce((x) => x, from, count);
        expect(
          Decimal.lte(relativeError(arithmeticSeries(from, count), truth), EXACT),
          `from=${from} count=${count}`,
        ).toBe(true);
      }
    }
  });

  test('geometricSeries — Σ base^(a + i)', () => {
    for (const base of [1.05, 1.15, 1.5, 2, 3, 10]) {
      for (const from of [0, 1, 13]) {
        for (const count of [0, 1, 2, 5, 30]) {
          const truth = bruteForce((x) => Decimal.pow(base, x), from, count);
          expect(
            Decimal.lte(relativeError(geometricSeries(base, from, count), truth), EXACT),
            `base=${base} from=${from} count=${count}`,
          ).toBe(true);
        }
      }
    }
  });

  test('geometricSeries — base 1 is the degenerate arm, not 0/0', () => {
    expect(Decimal.eq(geometricSeries(1, 5, 7), 7)).toBe(true);
  });

  test('powerSeries — Σ(a + i)^p across the Faulhaber range', () => {
    for (let p = 0; p <= 8; p++) {
      for (const from of [0, 1, 4, 100]) {
        for (const count of [0, 1, 2, 5, 25]) {
          const value = powerSeries(p, from, count);
          expect(value, `p=${p} from=${from} count=${count} returned null`).not.toBeNull();
          const truth = bruteForce((x) => Decimal.pow(x, p), from, count);
          expect(
            Decimal.lte(relativeError(value!, truth), EXACT),
            `p=${p} from=${from} count=${count}: got ${String(value)}, want ${truth.toString()}`,
          ).toBe(true);
        }
      }
    }
  });

  test('powerSeries — reports rather than guessing where Faulhaber does not apply', () => {
    expect(powerSeries(2.5, 0, 10)).toBeNull(); // fractional exponent — Hurwitz zeta
    expect(powerSeries(-1, 1, 10)).toBeNull(); // negative exponent — harmonic
    expect(powerSeries(2, 0.5, 10)).toBeNull(); // fractional offset — not an integer index
    expect(powerSeries(50, 0, 10)).toBeNull(); // past MAX_POWER
  });

  test('powerSeries — p=0 counts terms, including the 0⁰ one', () => {
    // Σ i⁰ over [0, n) is n, which the prefix-sum difference alone gets wrong:
    // it indexes from 1, so the i=0 term has to be peeled off explicitly.
    expect(Decimal.eq(powerSeries(0, 0, 6)!, 6)).toBe(true);
    expect(Decimal.eq(powerSeries(0, 3, 6)!, 6)).toBe(true);
  });
});

describe('Formula.sum — the shipped cost curves are exact', () => {
  const CURVES: Record<string, () => GenericFormula> = {
    'exponential 10·1.15ⁿ': () => Formula.exponential(0, 10, 1.15),
    'exponential 5·2ⁿ': () => Formula.exponential(0, 5, 2),
    'linear 5n+10': () => Formula.linear(0, 10, 5),
    'polynomial 10n²': () => Formula.polynomial(0, 10, 2),
    'polynomial 3n³': () => Formula.polynomial(0, 3, 3),
  };

  for (const [name, build] of Object.entries(CURVES)) {
    test(name, () => {
      const formula = build();
      for (const from of [0, 1, 12]) {
        for (const count of [0, 1, 2, 5, 30]) {
          const series = formula.sum(from, count);
          expect(series.reason, `${name} from=${from} count=${count}`).toBe('exact');
          const truth = bruteForce((x) => formula.evaluate(x), from, count);
          expect(
            Decimal.lte(relativeError(series.value!, truth), EXACT),
            `${name} from=${from} count=${count}: got ${String(series.value)}, want ${truth.toString()}`,
          ).toBe(true);
        }
      }
    });
  }

  test('the 19-level bulk buy that motivated the split', () => {
    const cost = Formula.exponential(0, 10, 1.15);
    const series = cost.sum(0, 19);
    expect(series.reason).toBe('exact');
    // Σ 10·1.15ⁱ for i in [0,19) — what nineteen sequential purchases charge.
    expect(Decimal.lte(relativeError(series.value!, '882.1181097360056'), EXACT)).toBe(true);
    // The continuous cumulative over the same span is a different number, and
    // charging it was the defect: 946.736…, 7.3% high.
    expect(Decimal.lte(relativeError(cost.cumulative(0, 19), '946.7363876871747'), EXACT)).toBe(
      true,
    );
  });
});

describe('linearity composes, and only linearity', () => {
  test('Σ(f + g) splits across a constant addend', () => {
    const f = Formula.variable(0).pow_base(1.15).mul(10).add(7);
    const truth = bruteForce((x) => f.evaluate(x), 0, 20);
    const series = f.sum(0, 20);
    expect(series.reason).toBe('exact');
    expect(Decimal.lte(relativeError(series.value!, truth), EXACT)).toBe(true);
  });

  test('Σ(f − g) and Σ(f/k) carry the sign and the divisor', () => {
    const f = Formula.variable(0).mul(3).sub(4).div(2);
    const truth = bruteForce((x) => f.evaluate(x), 2, 15);
    const series = f.sum(2, 15);
    expect(series.reason).toBe('exact');
    expect(Decimal.lte(relativeError(series.value!, truth), EXACT)).toBe(true);
  });

  test('Σ(−f) negates', () => {
    const f = Formula.variable(0).mul(3).neg();
    const truth = bruteForce((x) => f.evaluate(x), 0, 10);
    const series = f.sum(0, 10);
    expect(series.reason).toBe('exact');
    expect(Decimal.lte(relativeError(series.value!, truth), EXACT)).toBe(true);
  });

  test('a nested variable under pow_base has no closed form and says so', () => {
    // `1.15^(2x)` is still geometric mathematically, but the op table only
    // claims the case it can prove — the inner must be the bare variable.
    // Reporting here is the design: a compositional guess is what produced
    // eight inherited defects in this subsystem.
    const f = Formula.variable(0).mul(2).pow_base(1.15);
    expect(f.sum(0, 10).reason).not.toBe('exact');
  });

  test('a genuinely non-elementary series reports rather than answering', () => {
    const f = Formula.variable(0).add(1).ln();
    const series = f.sum(1, 10);
    expect(series.reason).not.toBe('exact');
  });
});

describe('Σ over a span the closed forms do not cover', () => {
  test('approximate carries a value close to the truth and an error estimate', () => {
    // ln(x+1) is integrable but not summable in closed form — the
    // Euler–Maclaurin arm. It must beat the raw integral it corrects.
    const f = Formula.variable(0).add(1).ln();
    const from = 1;
    const count = 400;
    const series = f.sum(from, count);
    expect(series.reason).toBe('approximate');
    const truth = bruteForce((x) => f.evaluate(x), from, count);
    const err = relativeError(series.value!, truth);
    // 1e-5, because the two corrections land at 2.21e-6 relative here (measured)
    // — the bound is the measurement plus headroom, not an aspiration.
    expect(Decimal.lt(err, 1e-5), `corrected error was ${err.toString()}`).toBe(true);
    const raw = relativeError(f.cumulative(from, from + count), truth);
    expect(Decimal.lt(err, raw)).toBe(true);
    // The reported estimate is the size of the last correction applied, so it
    // has to be at least as large as what is actually left over.
    expect((series as { error: number }).error).toBeGreaterThanOrEqual(err.toNumber());
  });
});

describe('a bulk purchase charges what the same purchases charge one at a time', () => {
  // The law the suite never had. Every prior assertion called `getCost(1)`,
  // which short-circuits before the cumulative path — so a bulk buy priced by
  // the continuous integral while max-affordable counted by the discrete sum,
  // and the gap was charged to the player: 7.3% on a 1.15 curve, 44% on a 2.
  // See studio/open-loop-engine#22.

  const CURVES = [
    { baseCost: 10, costScaling: 1.05 },
    { baseCost: 10, costScaling: 1.15 },
    { baseCost: 10, costScaling: 1.5 },
    { baseCost: 10, costScaling: 2 },
    { baseCost: 10, costScaling: 3 },
    { baseCost: 1e6, costScaling: 1.15 },
  ];

  for (const { baseCost, costScaling } of CURVES) {
    for (const funds of [1e3, 1e6, 1e12]) {
      test(`base=${baseCost} s=${costScaling} funds=${funds}`, () => {
        const bulkWallet = createResource(ref<DecimalSource>(funds), 'coins');
        const bulk = createScalingPurchasable({
          id: `bulk-${baseCost}-${costScaling}-${funds}`,
          resource: bulkWallet,
          baseCost,
          costScaling,
          bulkPurchase: true,
        });
        const boughtInBulk = bulk.purchaseMax();

        const oneWallet = createResource(ref<DecimalSource>(funds), 'coins');
        const one = createScalingPurchasable({
          id: `one-${baseCost}-${costScaling}-${funds}`,
          resource: oneWallet,
          baseCost,
          costScaling,
        });
        let boughtSingly = 0;
        while (one.canPurchase.value && boughtSingly < 5000) {
          one.purchase(1);
          boughtSingly++;
        }

        expect(
          Decimal.eq(boughtInBulk, boughtSingly),
          `bought ${String(boughtInBulk)} in bulk, ${boughtSingly} one at a time`,
        ).toBe(true);
        expect(
          Decimal.lte(relativeError(bulkWallet.value, oneWallet.value), EXACT),
          `left ${String(bulkWallet.value)} after bulk, ${String(oneWallet.value)} after singles`,
        ).toBe(true);
      });
    }
  }

  test('a bulk buy never spends more than the player has', () => {
    // The overcharge used to exceed the balance outright on steep curves, and
    // `pay`'s clamp to zero hid it by draining the wallet instead of failing.
    for (const costScaling of [1.5, 2, 3, 5]) {
      const wallet = createResource(ref<DecimalSource>(1e6), 'coins');
      const p = createScalingPurchasable({
        id: `clamp-${costScaling}`,
        resource: wallet,
        baseCost: 10,
        costScaling,
        bulkPurchase: true,
      });
      const bought = p.purchaseMax();
      const spent = Decimal.sub(1e6, wallet.value);
      const truth = bruteForce(
        (x) => Decimal.mul(10, Decimal.pow(costScaling, x)),
        0,
        Number(bought.toString()),
      );
      expect(
        Decimal.lte(relativeError(spent, truth), EXACT),
        `s=${costScaling}: spent ${spent.toString()} for ${String(bought)} levels worth ${truth.toString()}`,
      ).toBe(true);
      expect(Decimal.gt(wallet.value, 0)).toBe(true);
    }
  });
});

describe('a single-payment purchase charges the level it counted to', () => {
  // The sibling of the law above, one flag over. `cumulativeCost: false` prices
  // a bulk buy as one payment at the target level rather than a sum, so "bulk
  // charges what singles charge" does NOT hold here and is the wrong law. What
  // must hold is the invariant studio/open-loop-engine#22 was actually about:
  // the count and the charge resolve through the same operation. Both sides go
  // through `evaluate(current + n)` — `calculateCost`'s non-cumulative branch
  // and `calculateMaxAffordable`'s `priceOf` — and nothing pinned that.

  for (const startLevel of [0, 7]) {
    for (const costScaling of [1.05, 1.15, 1.5, 2, 3]) {
      test(`level=${startLevel} s=${costScaling}`, () => {
        const funds = 1e3;
        const level = ref<DecimalSource>(startLevel);
        const wallet = createResource(ref<DecimalSource>(funds), 'coins');
        const req = createCostRequirement({
          resource: wallet,
          cost: Formula.exponential(level, 10, costScaling),
          cumulativeCost: false,
          maxBulkAmount: Decimal.dInf,
        });

        const n = maxRequirementsMet(req);
        const price = req.getCost(n);

        // The charge is a single evaluation at the target level, not a sum —
        // the defining semantic of the flag. Buying nothing charges nothing:
        // at level 7 a 2× or 3× curve already prices the next level above the
        // whole balance, which is a real state and not a degenerate skip.
        const expected = Decimal.gt(n, 0)
          ? Decimal.mul(10, Decimal.pow(costScaling, Decimal.add(startLevel, n)))
          : Decimal.dZero;
        expect(
          Decimal.lte(relativeError(price, expected), EXACT),
          `charged ${String(price)} for ${String(n)} levels from ${startLevel}, expected ${String(expected)}`,
        ).toBe(true);

        // The count is honest in both directions: what it counted is payable,
        // and one more is not. An overcharge lives in the first assertion — it
        // is exactly what a continuous price against a discrete count breaks.
        expect(
          Decimal.lte_tolerance(price, funds, EXACT),
          `charged ${String(price)} out of ${funds}`,
        ).toBe(true);
        expect(
          Decimal.gt(req.getCost(Decimal.add(n, 1)), funds),
          `one more level cost ${String(req.getCost(Decimal.add(n, 1)))}, still under ${funds}`,
        ).toBe(true);

        // `pay`'s clamp to zero must not be what keeps the wallet solvent.
        payRequirements(req, n);
        expect(
          Decimal.lte(relativeError(wallet.value, Decimal.sub(funds, price)), EXACT),
          `left ${String(wallet.value)}, expected ${String(Decimal.sub(funds, price))}`,
        ).toBe(true);
      });
    }
  }
});

describe('degenerate spans', () => {
  test('a zero-length span sums to zero, exactly', () => {
    for (const build of [
      () => Formula.exponential(0, 10, 1.15),
      () => Formula.variable(0).add(1).ln(),
    ]) {
      const series = build().sum(5, 0);
      expect(series.reason).toBe('exact');
      expect(Decimal.eq(series.value!, 0)).toBe(true);
    }
  });

  test('a single-term span is the term itself', () => {
    const f = Formula.exponential(0, 10, 1.15);
    const series = f.sum(7, 1);
    expect(series.reason).toBe('exact');
    expect(Decimal.lte(relativeError(series.value!, f.evaluate(7)), EXACT)).toBe(true);
  });
});
