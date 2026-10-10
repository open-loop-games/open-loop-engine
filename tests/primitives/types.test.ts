import { describe, it, expect } from 'vitest';
import type { IEffect, CompositeEffect, ResourceCondition, AllCondition } from '@/primitives/types';

describe('Primitive types', () => {
  it('IEffect discriminated union works', () => {
    const effect: IEffect = { type: 'resource', target: 'gold', operation: 'add', value: 10 };
    expect(effect.type).toBe('resource');
  });
  it('Composite effect nests correctly', () => {
    const effect: CompositeEffect = {
      type: 'composite',
      effects: [
        { type: 'resource', target: 'gold', operation: 'add', value: 10 },
        { type: 'flag', target: 'smithing', value: true },
      ],
    };
    expect(effect.effects).toHaveLength(2);
  });
  it('ICondition discriminated union works', () => {
    const cond: ResourceCondition = {
      type: 'resource',
      target: 'gold',
      operator: 'gte',
      value: 100,
    };
    expect(cond.type).toBe('resource');
  });
  it('Composite condition nests', () => {
    const cond: AllCondition = {
      type: 'all',
      conditions: [
        { type: 'resource', target: 'gold', operator: 'gte', value: 100 },
        { type: 'flag', target: 'smithing' },
      ],
    };
    expect(cond.conditions).toHaveLength(2);
  });
});
