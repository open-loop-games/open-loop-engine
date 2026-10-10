import { describe, it, expect } from 'vitest';
import { bn, Decimal } from '@/primitives/decimal';
import type { ICondition, GameStateAccessor } from '@/primitives/types';
import { evaluateCondition, extractDependencies } from '@/core/conditions';

function mockAccessor(overrides: Partial<GameStateAccessor> = {}): GameStateAccessor {
  return {
    getAmount: (id) => (id === 'gold' ? bn(100) : bn(0)),
    getFlag: (id) => id === 'smithing',
    getStateAt: () => undefined,
    getRate: () => Decimal.dZero,
    ...overrides,
  };
}

describe('evaluateCondition', () => {
  it('resource gte passes', () => {
    expect(
      evaluateCondition(
        { kind: 'resource', target: 'gold', operator: 'gte', value: 50 },
        mockAccessor(),
      ),
    ).toBe(true);
  });
  it('resource gte fails', () => {
    expect(
      evaluateCondition(
        { kind: 'resource', target: 'gold', operator: 'gte', value: 200 },
        mockAccessor(),
      ),
    ).toBe(false);
  });
  it('unlock passes', () => {
    expect(evaluateCondition({ kind: 'flag', target: 'smithing' }, mockAccessor())).toBe(true);
  });
  it('unlock fails', () => {
    expect(evaluateCondition({ kind: 'flag', target: 'alchemy' }, mockAccessor())).toBe(false);
  });
  it('and requires all', () => {
    const c: ICondition = {
      kind: 'all',
      conditions: [
        { kind: 'resource', target: 'gold', operator: 'gte', value: 50 },
        { kind: 'flag', target: 'smithing' },
      ],
    };
    expect(evaluateCondition(c, mockAccessor())).toBe(true);
  });
  it('or passes if any', () => {
    const c: ICondition = {
      kind: 'any',
      conditions: [
        { kind: 'resource', target: 'gold', operator: 'gte', value: 999 },
        { kind: 'flag', target: 'smithing' },
      ],
    };
    expect(evaluateCondition(c, mockAccessor())).toBe(true);
  });
  it('not negates', () => {
    expect(
      evaluateCondition(
        { kind: 'not', condition: { kind: 'flag', target: 'alchemy' } },
        mockAccessor(),
      ),
    ).toBe(true);
  });
});

describe('extractDependencies', () => {
  it('extracts resource dep', () => {
    expect(
      extractDependencies({ kind: 'resource', target: 'gold', operator: 'gte', value: 100 }),
    ).toContain('resources.gold.amount');
  });
  it('extracts unlock dep', () => {
    expect(extractDependencies({ kind: 'flag', target: 'smithing' })).toContain('flags.smithing');
  });
  it('deduplicates', () => {
    const c: ICondition = {
      kind: 'all',
      conditions: [
        { kind: 'resource', target: 'gold', operator: 'gte', value: 50 },
        { kind: 'resource', target: 'gold', operator: 'lte', value: 200 },
      ],
    };
    expect(extractDependencies(c).filter((d) => d === 'resources.gold.amount')).toHaveLength(1);
  });
});
