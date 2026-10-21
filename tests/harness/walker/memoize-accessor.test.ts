import { describe, it, expect } from 'vitest';
import {
  AccessorMethods,
  implementsAccessorMethod,
  type GameStateAccessorMutator,
} from '@/core/game-state-accessor';
import { accessorStub } from '../../systems/fixtures/stateful-systems';
import { memoizeAccessor } from '@/harness/walker/memoize-accessor';

describe('memoizeAccessor', () => {
  it('keeps the AccessorMethods record, so a partial accessor stays partial', () => {
    const partial: GameStateAccessorMutator = {
      ...accessorStub,
      [AccessorMethods]: new Set(['getAmount', 'getRate']),
    };
    const memo = memoizeAccessor(partial);
    expect(implementsAccessorMethod(memo, 'getRate')).toBe(true);
    expect(implementsAccessorMethod(memo, 'getFlag')).toBe(false);
  });
});
