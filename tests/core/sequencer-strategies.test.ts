import { describe, it, expect } from 'vitest';
import {
  createConditionalStrategy,
  createCompositeStrategy,
  createPriorityStrategy,
} from '@/core/sequencer-strategies';

describe('createConditionalStrategy', () => {
  it('returns the first matching rule item', () => {
    const s = createConditionalStrategy(() => [
      { condition: () => false, item: { id: 'a' } },
      { condition: () => true, item: { id: 'b' } },
      { condition: () => true, item: { id: 'c' } },
    ]);
    expect(s.next()).toEqual({ id: 'b' });
  });

  it('returns null when no rules match', () => {
    const s = createConditionalStrategy(() => [
      { condition: () => false, item: { id: 'a' } },
      { condition: () => false, item: { id: 'b' } },
    ]);
    expect(s.next()).toBeNull();
  });

  it('returns null for empty rules list', () => {
    const s = createConditionalStrategy(() => []);
    expect(s.next()).toBeNull();
  });

  it('evaluates rules in order (first-match, not best-match)', () => {
    const callOrder: string[] = [];
    const s = createConditionalStrategy(() => [
      {
        condition: () => {
          callOrder.push('a');
          return false;
        },
        item: { id: 'a' },
      },
      {
        condition: () => {
          callOrder.push('b');
          return true;
        },
        item: { id: 'b' },
      },
      {
        condition: () => {
          callOrder.push('c');
          return true;
        },
        item: { id: 'c' },
      },
    ]);

    const result = s.next();
    expect(result).toEqual({ id: 'b' });
    // 'c' should NOT be evaluated — short-circuit on first match
    expect(callOrder).toEqual(['a', 'b']);
  });

  it('supports dynamic rule lists (getter returns different rules between calls)', () => {
    let useAlternate = false;
    const s = createConditionalStrategy(() =>
      useAlternate
        ? [{ condition: () => true, item: { id: 'alt' } }]
        : [{ condition: () => true, item: { id: 'default' } }],
    );

    expect(s.next()).toEqual({ id: 'default' });
    useAlternate = true;
    expect(s.next()).toEqual({ id: 'alt' });
  });

  it('conditions can reference external mutable state', () => {
    let health = 100;
    const s = createConditionalStrategy(() => [
      { condition: () => health < 20, item: { id: 'heal' } },
      { condition: () => true, item: { id: 'attack' } },
    ]);

    expect(s.next()).toEqual({ id: 'attack' });
    health = 10;
    expect(s.next()).toEqual({ id: 'heal' });
  });

  it('composes with createCompositeStrategy as fallback', () => {
    const conditional = createConditionalStrategy(() => [
      { condition: () => false, item: { id: 'nope' } },
    ]);
    const fallback = createPriorityStrategy(() => [{ id: 'fallback', priority: 1 }]);
    const composed = createCompositeStrategy(conditional, fallback);

    expect(composed.next()).toEqual({ id: 'fallback' });
  });

  it('works with typed metadata', () => {
    interface SpellMeta {
      school: string;
    }
    const s = createConditionalStrategy<SpellMeta>(() => [
      {
        condition: () => true,
        item: { id: 'fireball', metadata: { school: 'fire' } },
      },
    ]);
    const result = s.next();
    expect(result).toEqual({ id: 'fireball', metadata: { school: 'fire' } });
  });
});
