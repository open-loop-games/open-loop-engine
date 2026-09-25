import { describe, it, expect } from 'vitest';
import type {
  IEffect,
  ICondition,
  ResourceEffect,
  CompositeEffect,
  ResourceCondition,
  AndCondition,
} from '@/primitives/types';

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
        { type: 'unlock', target: 'smithing', value: true },
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
    const cond: AndCondition = {
      type: 'and',
      conditions: [
        { type: 'resource', target: 'gold', operator: 'gte', value: 100 },
        { type: 'unlock', target: 'smithing' },
      ],
    };
    expect(cond.conditions).toHaveLength(2);
  });
});
