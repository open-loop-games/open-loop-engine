import { describe, it, expect } from 'vitest';
import { bn, Decimal } from '@/primitives/decimal';
import type { ICondition, GameStateAccessor } from '@/primitives/types';
import { evaluateCondition, extractDependencies } from '@/core/conditions';

function mockAccessor(overrides: Partial<GameStateAccessor> = {}): GameStateAccessor {
  return {
    getAmount: (id) => (id === 'gold' ? bn(100) : bn(0)),
    getFlag: (id) => id === 'smithing',
    getState: () => undefined,
    getRate: () => Decimal.dZero,
    ...overrides,
  };
}

describe('evaluateCondition', () => {
  it('resource gte passes', () => {
    expect(
      evaluateCondition(
        { type: 'resource', target: 'gold', operator: 'gte', value: 50 },
        mockAccessor(),
      ),
    ).toBe(true);
  });
  it('resource gte fails', () => {
    expect(
      evaluateCondition(
        { type: 'resource', target: 'gold', operator: 'gte', value: 200 },
        mockAccessor(),
      ),
    ).toBe(false);
  });
  it('unlock passes', () => {
    expect(evaluateCondition({ type: 'flag', target: 'smithing' }, mockAccessor())).toBe(true);
  });
  it('unlock fails', () => {
    expect(evaluateCondition({ type: 'flag', target: 'alchemy' }, mockAccessor())).toBe(false);
  });
  it('and requires all', () => {
    const c: ICondition = {
      type: 'all',
      conditions: [
        { type: 'resource', target: 'gold', operator: 'gte', value: 50 },
        { type: 'flag', target: 'smithing' },
      ],
    };
    expect(evaluateCondition(c, mockAccessor())).toBe(true);
  });
  it('or passes if any', () => {
    const c: ICondition = {
      type: 'any',
      conditions: [
        { type: 'resource', target: 'gold', operator: 'gte', value: 999 },
        { type: 'flag', target: 'smithing' },
      ],
    };
    expect(evaluateCondition(c, mockAccessor())).toBe(true);
  });
  it('not negates', () => {
    expect(
      evaluateCondition(
        { type: 'not', condition: { type: 'flag', target: 'alchemy' } },
        mockAccessor(),
      ),
    ).toBe(true);
  });
});

describe('extractDependencies', () => {
  it('extracts resource dep', () => {
    expect(
      extractDependencies({ type: 'resource', target: 'gold', operator: 'gte', value: 100 }),
    ).toContain('resources.gold.amount');
  });
  it('extracts unlock dep', () => {
    expect(extractDependencies({ type: 'flag', target: 'smithing' })).toContain('flags.smithing');
  });
  it('deduplicates', () => {
    const c: ICondition = {
      type: 'all',
      conditions: [
        { type: 'resource', target: 'gold', operator: 'gte', value: 50 },
        { type: 'resource', target: 'gold', operator: 'lte', value: 200 },
      ],
    };
    expect(extractDependencies(c).filter((d) => d === 'resources.gold.amount')).toHaveLength(1);
  });
});
