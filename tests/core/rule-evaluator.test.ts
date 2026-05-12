import { describe, it, expect, vi } from 'vitest';
import {
  createRuleEvaluator,
  isRuleEvaluator,
  RuleEvaluatorType,
  type EvaluatorResult,
} from '@/core/rule-evaluator';

interface TestState {
  health: number;
  mana: number;
  canCast: (id: string) => boolean;
}

function makeState(partial: Partial<TestState> = {}): TestState {
  return {
    health: 100,
    mana: 100,
    canCast: () => true,
    ...partial,
  };
}

describe('createRuleEvaluator', () => {
  it('returns the first matching rule with its index', () => {
    const evaluator = createRuleEvaluator<TestState, string>({
      getRules: () => [
        { condition: (s) => s.health < 20, action: 'heal' },
        { condition: (s) => s.mana > 50, action: 'fireball' },
        { condition: () => true, action: 'melee' },
      ],
    });

    expect(evaluator.evaluate(makeState())).toEqual<EvaluatorResult<string>>({
      matched: true,
      ruleIndex: 1,
      action: 'fireball',
    });
  });

  it('short-circuits — later conditions are not called after the first match', () => {
    const callOrder: string[] = [];
    const evaluator = createRuleEvaluator<TestState, string>({
      getRules: () => [
        {
          condition: () => {
            callOrder.push('a');
            return false;
          },
          action: 'a',
        },
        {
          condition: () => {
            callOrder.push('b');
            return true;
          },
          action: 'b',
        },
        {
          condition: () => {
            callOrder.push('c');
            return true;
          },
          action: 'c',
        },
      ],
    });

    evaluator.evaluate(makeState());
    expect(callOrder).toEqual(['a', 'b']);
  });

  it('passes the snapshot through to every condition', () => {
    const seen: TestState[] = [];
    const snapshot = makeState({ health: 42 });
    const evaluator = createRuleEvaluator<TestState, string>({
      getRules: () => [
        {
          condition: (s) => {
            seen.push(s);
            return false;
          },
          action: 'a',
        },
        {
          condition: (s) => {
            seen.push(s);
            return true;
          },
          action: 'b',
        },
      ],
    });

    evaluator.evaluate(snapshot);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(snapshot);
    expect(seen[1]).toBe(snapshot);
  });

  it('returns { matched: false, ruleIndex: -1, action: null } when no rule and no fallback', () => {
    const evaluator = createRuleEvaluator<TestState, string>({
      getRules: () => [{ condition: () => false, action: 'a' }],
    });

    expect(evaluator.evaluate(makeState())).toEqual<EvaluatorResult<string>>({
      matched: false,
      ruleIndex: -1,
      action: null,
    });
  });

  it('fires fallback when no rule matches and returns first entry unconditionally (no canUse)', () => {
    const evaluator = createRuleEvaluator<TestState, string>({
      getRules: () => [{ condition: () => false, action: 'rule' }],
      getFallback: () => ['first', 'second'],
    });

    expect(evaluator.evaluate(makeState())).toEqual<EvaluatorResult<string>>({
      matched: false,
      ruleIndex: -1,
      action: 'first',
    });
  });

  it('fallback walks top-to-bottom, returning the first action for which canUse passes', () => {
    const evaluator = createRuleEvaluator<TestState, string>({
      getRules: () => [],
      getFallback: () => ['expensive', 'cheap', 'free'],
      canUse: (spellId, s) => s.canCast(spellId),
    });

    const state = makeState({
      canCast: (id) => id !== 'expensive',
    });

    expect(evaluator.evaluate(state).action).toBe('cheap');
  });

  it('returns null action when fallback exists but no entry passes canUse', () => {
    const evaluator = createRuleEvaluator<TestState, string>({
      getRules: () => [],
      getFallback: () => ['a', 'b'],
      canUse: () => false,
    });

    expect(evaluator.evaluate(makeState())).toEqual<EvaluatorResult<string>>({
      matched: false,
      ruleIndex: -1,
      action: null,
    });
  });

  it('returns null action when fallback returns an empty list', () => {
    const evaluator = createRuleEvaluator<TestState, string>({
      getRules: () => [],
      getFallback: () => [],
    });

    expect(evaluator.evaluate(makeState()).action).toBeNull();
  });

  it('prefers rule match over fallback even when fallback is set', () => {
    const evaluator = createRuleEvaluator<TestState, string>({
      getRules: () => [{ condition: () => true, action: 'rule-match' }],
      getFallback: () => ['fallback'],
    });

    expect(evaluator.evaluate(makeState())).toEqual<EvaluatorResult<string>>({
      matched: true,
      ruleIndex: 0,
      action: 'rule-match',
    });
  });

  it('supports dynamic rule lists (getter returns different rules across calls)', () => {
    let useAlternate = false;
    const evaluator = createRuleEvaluator<TestState, string>({
      getRules: () =>
        useAlternate
          ? [{ condition: () => true, action: 'alt' }]
          : [{ condition: () => true, action: 'default' }],
    });

    expect(evaluator.evaluate(makeState()).action).toBe('default');
    useAlternate = true;
    expect(evaluator.evaluate(makeState()).action).toBe('alt');
  });

  it('fires onEvaluate exactly once per evaluate() call, with result and state', () => {
    const onEvaluate = vi.fn();
    const state = makeState();
    const evaluator = createRuleEvaluator<TestState, string>({
      getRules: () => [{ condition: () => true, action: 'a' }],
      onEvaluate,
    });

    const result = evaluator.evaluate(state);
    expect(onEvaluate).toHaveBeenCalledTimes(1);
    expect(onEvaluate).toHaveBeenCalledWith(result, state);
  });

  it('fires onEvaluate on the no-match + no-fallback path', () => {
    const onEvaluate = vi.fn();
    const evaluator = createRuleEvaluator<TestState, string>({
      getRules: () => [{ condition: () => false, action: 'a' }],
      onEvaluate,
    });

    evaluator.evaluate(makeState());
    expect(onEvaluate).toHaveBeenCalledTimes(1);
    expect(onEvaluate.mock.calls[0][0]).toMatchObject({
      matched: false,
      ruleIndex: -1,
      action: null,
    });
  });

  it('fires onEvaluate on the fallback path with the resolved fallback action', () => {
    const onEvaluate = vi.fn();
    const evaluator = createRuleEvaluator<TestState, string>({
      getRules: () => [],
      getFallback: () => ['fb'],
      onEvaluate,
    });

    evaluator.evaluate(makeState());
    expect(onEvaluate).toHaveBeenCalledTimes(1);
    expect(onEvaluate.mock.calls[0][0]).toMatchObject({
      matched: false,
      ruleIndex: -1,
      action: 'fb',
    });
  });

  it('returns an object branded with the RuleEvaluatorType symbol', () => {
    const evaluator = createRuleEvaluator<TestState, string>({
      getRules: () => [],
    });
    expect(evaluator.type).toBe(RuleEvaluatorType);
  });

  it('works with non-string action types (structured dispatch records)', () => {
    interface ActionRecord {
      kind: 'cast' | 'move';
      target: string;
    }
    const evaluator = createRuleEvaluator<TestState, ActionRecord>({
      getRules: () => [{ condition: () => true, action: { kind: 'cast', target: 'self' } }],
    });

    expect(evaluator.evaluate(makeState()).action).toEqual({ kind: 'cast', target: 'self' });
  });
});

describe('isRuleEvaluator', () => {
  it('returns true for instances from createRuleEvaluator', () => {
    const evaluator = createRuleEvaluator<TestState, string>({ getRules: () => [] });
    expect(isRuleEvaluator(evaluator)).toBe(true);
  });

  it('returns false for unrelated objects', () => {
    expect(isRuleEvaluator({})).toBe(false);
    expect(isRuleEvaluator({ type: Symbol('other') })).toBe(false);
    expect(isRuleEvaluator(null)).toBe(false);
    expect(isRuleEvaluator(undefined)).toBe(false);
    expect(isRuleEvaluator('string')).toBe(false);
  });
});
