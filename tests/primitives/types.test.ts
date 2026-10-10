import { describe, it, expect } from 'vitest';
import type { IEffect, CompositeEffect, ResourceCondition, AllCondition } from '@/primitives/types';

describe('Primitive types', () => {
  it('IEffect discriminated union works', () => {
    const effect: IEffect = { kind: 'resource', target: 'gold', operation: 'add', value: 10 };
    expect(effect.kind).toBe('resource');
  });
  it('Composite effect nests correctly', () => {
    const effect: CompositeEffect = {
      kind: 'composite',
      effects: [
        { kind: 'resource', target: 'gold', operation: 'add', value: 10 },
        { kind: 'flag', target: 'smithing', value: true },
      ],
    };
    expect(effect.effects).toHaveLength(2);
  });
  it('ICondition discriminated union works', () => {
    const cond: ResourceCondition = {
      kind: 'resource',
      target: 'gold',
      operator: 'gte',
      value: 100,
    };
    expect(cond.kind).toBe('resource');
  });
  it('Composite condition nests', () => {
    const cond: AllCondition = {
      kind: 'all',
      conditions: [
        { kind: 'resource', target: 'gold', operator: 'gte', value: 100 },
        { kind: 'flag', target: 'smithing' },
      ],
    };
    expect(cond.conditions).toHaveLength(2);
  });
});
