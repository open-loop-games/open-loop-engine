import { describe, it, expect } from 'vitest';
import { Decimal } from '@/primitives/decimal';
import type { GameStateAccessor } from '@/primitives/types';
import { AccessorMethods, implementsAccessorMethod } from '@/core/game-state-accessor';
import { memoizeAccessor } from '@/harness/walker/memoize-accessor';

describe('memoizeAccessor', () => {
  it('keeps the AccessorMethods record, so a partial accessor stays partial', () => {
    const partial = {
      getAmount: () => Decimal.dOne,
      getRate: () => Decimal.dZero,
      getFlag: () => false,
      getStateAt: () => undefined,
      [AccessorMethods]: new Set(['getAmount', 'getRate']),
    } as GameStateAccessor;
    const memo = memoizeAccessor(partial);
    expect(implementsAccessorMethod(memo, 'getRate')).toBe(true);
    expect(implementsAccessorMethod(memo, 'getFlag')).toBe(false);
  });
});
