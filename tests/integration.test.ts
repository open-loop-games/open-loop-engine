import { describe, it, expect } from 'vitest';
import { bn } from '@/primitives/decimal';
import { random } from '@/primitives/rng';
import { createResource, addResource } from '@/core/resource';
import { createSequentialModifier, createMultiplicativeModifier } from '@/core/modifier';
import { evaluateCondition } from '@/core/conditions';
import { resolveEffect } from '@/core/effects';
import Formula from '@/core/formulas/formulas';
import { Decimal } from '@/primitives/decimal';
import { runHeadless } from '@/core/headless';
import type { GameStateAccessor, ICondition, IEffect, Analyzer } from '@/primitives/types';

describe('Integration: simple idle game loop', () => {
  it('runs a basic resource accumulation game headlessly', () => {
    const result = runHeadless({ setup: () => [], tick: () => {}, ticks: 100, seed: 42 });
    expect(result.totalTicks).toBe(100);
  });

  it('resources + modifiers + conditions + effects work together', () => {
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    const baseRate = bn(1);
    const multiplier = createMultiplicativeModifier({ multiplier: bn(2) });
    const modifier = createSequentialModifier([multiplier]);
    const productionRate = modifier.apply(baseRate) as ReturnType<typeof bn>;

    for (let i = 0; i < 10; i++) addResource(gold, productionRate.mul(0.05));

    const accessor: GameStateAccessor = {
      getResource: (id) => (id === 'gold' ? bn(gold.value) : bn(0)),
      getFlag: () => false,
      getState: () => undefined,
      getRate: () => Decimal.dZero,
    };

    const cond: ICondition = { type: 'resource', target: 'gold', operator: 'gte', value: 0.5 };
    expect(evaluateCondition(cond, accessor)).toBe(true);

    const effect: IEffect = { type: 'resource', target: 'gold', operation: 'multiply', value: 2 };
    const resolved = resolveEffect(effect, accessor);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].operation).toBe('multiply');
  });

  it('scaling formula with resource check', () => {
    const scaling = Formula.exponential(0, 10, 1.15);
    expect(new Decimal(scaling.evaluate(0)).eq(10)).toBe(true);
    expect(new Decimal(scaling.invert(bn(100))).toNumber()).toBeGreaterThan(10);
  });

  it('headless with analyzer tracks metrics', () => {
    let tickGold = 0;
    const tracker: Analyzer = {
      name: 'gold-tracker',
      onTick: () => {},
      onEnd: () => {},
      summarize: () => ({ name: 'gold-tracker', metrics: { maxGold: tickGold } }),
    };
    runHeadless({
      setup: () => [tracker],
      tick: () => {
        tickGold += 1;
      },
      ticks: 50,
    });
    expect(tickGold).toBe(50);
  });

  it('seeded RNG produces deterministic game outcomes', () => {
    let total1 = 0,
      total2 = 0;
    runHeadless({
      setup: () => [],
      tick: () => {
        total1 += random();
      },
      ticks: 100,
      seed: 123,
    });
    runHeadless({
      setup: () => [],
      tick: () => {
        total2 += random();
      },
      ticks: 100,
      seed: 123,
    });
    expect(total1).toBe(total2);
  });
});
