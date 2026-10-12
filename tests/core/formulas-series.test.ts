/**
 * Series contracts — what `Formula.sum` grades, what it reports, and the
 * agreement between a bulk purchase and the same purchases made one at a time.
 *
 * The numerical laws the closed forms and grades must satisfy, swept over their
 * domains against brute force and the mpmath oracle, live in
 * `formulas-conformance.test.ts`.
 */

import { describe, expect, test } from 'vitest';
import { ref } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { Formula } from '@/core/formulas';
import { geometricSeries, powerSeries } from '@/core/formulas/series';
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

describe('closed forms at their edges', () => {
  test('geometricSeries — base 1 is the degenerate arm, not 0/0', () => {
    expect(Decimal.eq(geometricSeries(1, 5, 7), 7)).toBe(true);
  });

  test('powerSeries — reports rather than guessing where Faulhaber does not apply', () => {
    expect(powerSeries(2.5, 0, 10)).toBeNull(); // fractional exponent — Hurwitz zeta
    expect(powerSeries(-1, 1, 10)).toBeNull(); // negative exponent — harmonic
    expect(powerSeries(2, -1, 10)).toBeNull(); // negative offset — the expansion cancels
    expect(powerSeries(50, 0, 10)).toBeNull(); // past MAX_POWER
  });

  test('powerSeries — p=0 counts terms, including the 0⁰ one', () => {
    // Σ i⁰ over [0, n) is n, and the Faulhaber prefix sums index from 1, so the
    // i=0 term has to be counted explicitly.
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
    // eight inherited defects in this subsystem. The span has to outrun the
    // term-by-term sum, which is exact for anything short.
    const f = Formula.variable(0).mul(2).pow_base(1.15);
    expect(f.sum(0, 10).reason).toBe('exact');
    expect(f.sum(0, 5000).reason).not.toBe('exact');
  });

  test('a genuinely non-elementary series reports rather than answering', () => {
    const f = Formula.variable(0).add(1).ln();
    const series = f.sum(1, 5000);
    expect(series.reason).not.toBe('exact');
  });
});

describe('Σ over a span the closed forms do not cover', () => {
  test('approximate carries a value close to the truth and an error estimate', () => {
    // ln(x+1) is integrable but not summable in closed form — the
    // Euler–Maclaurin arm. It must beat the raw integral it corrects.
    const f = Formula.variable(0).add(1).ln();
    const from = 1;
    const count = 2000;
    const series = f.sum(from, count);
    expect(series.reason).toBe('approximate');
    const truth = bruteForce((x) => f.evaluate(x), from, count);
    const err = relativeError(series.value!, truth);
    // 1e-6, because the two corrections land at 2.0e-7 relative here (measured)
    // — the bound is the measurement plus headroom, not an aspiration.
    expect(Decimal.lt(err, 1e-6), `corrected error was ${err.toString()}`).toBe(true);
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
    { baseCost: 10, costRatio: 1.05 },
    { baseCost: 10, costRatio: 1.15 },
    { baseCost: 10, costRatio: 1.5 },
    { baseCost: 10, costRatio: 2 },
    { baseCost: 10, costRatio: 3 },
    { baseCost: 1e6, costRatio: 1.15 },
  ];

  for (const { baseCost, costRatio } of CURVES) {
    for (const funds of [1e3, 1e6, 1e12]) {
      test(`base=${baseCost} s=${costRatio} funds=${funds}`, () => {
        const bulkWallet = createResource(ref<DecimalSource>(funds), { displayName: 'coins' });
        const bulk = createScalingPurchasable({
          id: `bulk-${baseCost}-${costRatio}-${funds}`.replaceAll('.', '_'),
          description: 'bulk-buy curve',
          resource: bulkWallet,
          baseCost,
          costRatio,
          purchaseMaxByDefault: true,
        });
        const boughtInBulk = bulk.purchaseMax();

        const oneWallet = createResource(ref<DecimalSource>(funds), { displayName: 'coins' });
        const one = createScalingPurchasable({
          id: `one-${baseCost}-${costRatio}-${funds}`.replaceAll('.', '_'),
          description: 'one-at-a-time curve',
          resource: oneWallet,
          baseCost,
          costRatio,
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
    for (const costRatio of [1.5, 2, 3, 5]) {
      const wallet = createResource(ref<DecimalSource>(1e6), { displayName: 'coins' });
      const p = createScalingPurchasable({
        id: `clamp-${costRatio}`.replaceAll('.', '_'),
        description: 'clamp curve',
        resource: wallet,
        baseCost: 10,
        costRatio,
        purchaseMaxByDefault: true,
      });
      const bought = p.purchaseMax();
      const spent = Decimal.sub(1e6, wallet.value);
      const truth = bruteForce(
        (x) => Decimal.mul(10, Decimal.pow(costRatio, x)),
        0,
        Number(bought.toString()),
      );
      expect(
        Decimal.lte(relativeError(spent, truth), EXACT),
        `s=${costRatio}: spent ${spent.toString()} for ${String(bought)} levels worth ${truth.toString()}`,
      ).toBe(true);
      expect(Decimal.gt(wallet.value, 0)).toBe(true);
    }
  });

  test('a cost curve that changes under a warm affordability cache still charges honestly', () => {
    // Same drain, reached from the other side. Above, the count and the charge
    // disagreed because they were computed in different coordinates; here they
    // disagree because `calculateMaxAffordable` answered out of a cache whose
    // key could not see the cost change, while `pay` priced the levels live.
    // The wallet is what notices either way.
    const level = ref<DecimalSource>(0);
    const surcharge = ref<DecimalSource>(1);
    const cost = Formula.variable(level)
      .pow_base(2)
      .mul(10)
      .mul(Formula.constant(surcharge).mul(1));
    const wallet = createResource(ref<DecimalSource>(101), { displayName: 'coins' });
    const req = createCostRequirement({
      resource: wallet,
      cost,
      sumLevels: true,
      maxBulkCount: 100,
    });

    expect(Decimal.eq(maxRequirementsMet(req), 3)).toBe(true);
    wallet.value = 102; // small move -> the affordability cache is warm
    expect(Decimal.eq(maxRequirementsMet(req), 3)).toBe(true);

    surcharge.value = 100; // every level now costs 100x: nothing is affordable
    const offered = maxRequirementsMet(req);
    expect(Decimal.eq(offered, 0)).toBe(true);

    payRequirements(req, offered);
    expect(Decimal.eq(wallet.value, 102)).toBe(true);
  });

  test('a cost coefficient that moves after the integral is built charges honestly', () => {
    // studio/open-loop-engine#29. Same drain, reached from a third side: here
    // the count came out of an integral whose coefficient was read once, when
    // the integral was built, while `pay` priced the levels live. The wallet is
    // what notices — the count was 378 against a true 45, and `pay`'s clamp to
    // zero turned the 333 unaffordable levels into free ones.
    const coef = ref<DecimalSource>(1);
    const funds = 1e5;
    const wallet = createResource(ref<DecimalSource>(funds), { displayName: 'coins' });
    const p = createScalingPurchasable({
      id: 'reactive-coefficient',
      description: 'a cost curve whose slope is a modifier',
      resource: wallet,
      costFormula: (level) => Formula.variable(level).mul(coef).add(5),
      purchaseMaxByDefault: true,
    });

    // Read once at coef = 1 — this is what builds and memoizes the integral.
    expect(Decimal.gt(p.countToPurchase.value, 0)).toBe(true);

    coef.value = 100;
    const bought = p.purchaseMax();
    const spent = Decimal.sub(funds, wallet.value);
    const truth = bruteForce(
      (x) => Decimal.add(Decimal.mul(x, 100), 5),
      0,
      Number(bought.toString()),
    );

    expect(
      Decimal.lte(relativeError(spent, truth), EXACT),
      `spent ${spent.toString()} for ${String(bought)} levels worth ${truth.toString()}`,
    ).toBe(true);
    expect(Decimal.gt(wallet.value, 0)).toBe(true);
  });
});

describe('a flat price is an ordinary authored value', () => {
  test('costRatio 1 buys in bulk, singly, and under a cap', () => {
    // A ratio of 1 has no continuous inverse to seed buy-max from — `1ˣ/ln 1`
    // is 0/0 — and the count still has to come out of the price.
    const capped = createScalingPurchasable({
      id: 'flat-capped',
      description: 'flat capped curve',
      resource: createResource(ref<DecimalSource>(100), { displayName: 'coins' }),
      baseCost: 10,
      costRatio: 1,
      limit: 5,
      purchaseMaxByDefault: true,
    });
    expect(String(capped.purchaseMax())).toBe('5');
    expect(String(capped.count.value)).toBe('5');

    const wallet = createResource(ref<DecimalSource>(100), { displayName: 'coins' });
    const bulk = createScalingPurchasable({
      id: 'flat-bulk',
      description: 'flat bulk curve',
      resource: wallet,
      baseCost: 10,
      costRatio: 1,
      purchaseMaxByDefault: true,
    });
    expect(String(bulk.purchaseMax())).toBe('10');
    expect(String(wallet.value)).toBe('0');

    const single = createScalingPurchasable({
      id: 'flat-single',
      description: 'flat single curve',
      resource: createResource(ref<DecimalSource>(100), { displayName: 'coins' }),
      baseCost: 10,
      costRatio: 1,
      purchaseMaxByDefault: false,
    });
    expect(single.canPurchase.value).toBe(true);
    expect(String(single.purchase())).toBe('1');
  });
});

describe('a single-payment purchase charges the level it counted to', () => {
  test('a cap of 1 counts the level it is buying, not the one it is on', () => {
    // `maxBulkCount: 1` — createCostRequirement's default — takes a fast path
    // that skips the seed and the correction walk entirely. It still has to
    // answer the same question the general path does, and under
    // `sumLevels: false` it did not: it compared the balance against
    // `evaluate(A)`, the cost at the current level, while `pay` charges
    // `evaluate(A + 1)` for the level being reached. Funds sit exactly at the
    // current level's price, which is the value the fast path was reading and
    // is strictly below the next level's on every increasing curve.
    for (const startLevel of [0, 7]) {
      for (const costRatio of [1.05, 1.15, 1.5, 2, 3]) {
        const funds = Decimal.mul(10, Decimal.pow(costRatio, startLevel));
        const level = ref<DecimalSource>(startLevel);
        const wallet = createResource(ref<DecimalSource>(funds), { displayName: 'coins' });
        const shape = {
          resource: wallet,
          sumLevels: false as const,
        };
        const capped = createCostRequirement({
          ...shape,
          cost: Formula.exponential(level, 10, costRatio),
          maxBulkCount: 1,
        });
        const uncapped = createCostRequirement({
          ...shape,
          cost: Formula.exponential(level, 10, costRatio),
          maxBulkCount: Decimal.dInf,
        });

        const capAnswer = maxRequirementsMet(capped);
        const truth = Decimal.min(maxRequirementsMet(uncapped), 1);
        expect(
          Decimal.eq(capAnswer, truth),
          `level=${startLevel} s=${costRatio}: cap of 1 said ${String(capAnswer)}, uncapped clamped says ${String(truth)}`,
        ).toBe(true);

        // And the wallet is what notices if it doesn't: `pay` subtracts the
        // live price and clamps at zero, so a level counted but not payable is
        // a level granted free.
        payRequirements(capped, capAnswer);
        expect(
          Decimal.gte(wallet.value, 0) && Decimal.lte(capped.getCost(capAnswer), funds),
          `level=${startLevel} s=${costRatio}: charged ${String(capped.getCost(capAnswer))} out of ${String(funds)}`,
        ).toBe(true);
      }
    }
  });

  // The sibling of the law above, one flag over. `sumLevels: false` prices
  // a bulk buy as one payment at the target level rather than a sum, so "bulk
  // charges what singles charge" does NOT hold here and is the wrong law. What
  // must hold is the invariant studio/open-loop-engine#22 was actually about:
  // the count and the charge resolve through the same operation. Both sides go
  // through `evaluate(current + n)` — `calculateCost`'s non-cumulative branch
  // and `calculateMaxAffordable`'s `priceOf` — and nothing pinned that.

  for (const startLevel of [0, 7]) {
    for (const costRatio of [1.05, 1.15, 1.5, 2, 3]) {
      test(`level=${startLevel} s=${costRatio}`, () => {
        const funds = 1e3;
        const level = ref<DecimalSource>(startLevel);
        const wallet = createResource(ref<DecimalSource>(funds), { displayName: 'coins' });
        const req = createCostRequirement({
          resource: wallet,
          cost: Formula.exponential(level, 10, costRatio),
          sumLevels: false,
          maxBulkCount: Decimal.dInf,
        });

        const n = maxRequirementsMet(req);
        const price = req.getCost(n);

        // The charge is a single evaluation at the target level, not a sum —
        // the defining semantic of the flag. Buying nothing charges nothing:
        // at level 7 a 2× or 3× curve already prices the next level above the
        // whole balance, which is a real state and not a degenerate skip.
        const expected = Decimal.gt(n, 0)
          ? Decimal.mul(10, Decimal.pow(costRatio, Decimal.add(startLevel, n)))
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
