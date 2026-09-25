import { describe, it, expect } from 'vitest';
import { bn } from '@/primitives/decimal';
import type { ICondition, GameStateAccessor } from '@/primitives/types';
import {
  combineFlipDistances,
  timeUntilAffordable,
  timeUntilConditionFlip,
  timeUntilResource,
  type AffordableLike,
  type ChildFlipResult,
  type TransitionDistance,
} from '@/core/transitions';

/**
 * Mock accessor with configurable resource amounts and rates. Default zero for both —
 * override per-test via the config arg.
 */
function mockAccessor(
  config: {
    resources?: Record<string, number>;
    rates?: Record<string, number>;
    unlocks?: Record<string, boolean>;
    state?: Record<string, unknown>;
  } = {},
): GameStateAccessor {
  const resources = config.resources ?? {};
  const rates = config.rates ?? {};
  const unlocks = config.unlocks ?? {};
  const state = config.state ?? {};
  return {
    getResource: (id) => bn(resources[id] ?? 0),
    isUnlocked: (id) => unlocks[id] ?? false,
    getState: (path) => state[path],
    getRate: (id) => bn(rates[id] ?? 0),
  };
}

describe('timeUntilResource', () => {
  it('returns 0 when current meets target', () => {
    const d = timeUntilResource('gold', 100, mockAccessor({ resources: { gold: 100 } }));
    expect(d.reason).toBe('computed');
    expect(d.seconds).toBe(0);
  });

  it('returns 0 when current exceeds target', () => {
    const d = timeUntilResource('gold', 100, mockAccessor({ resources: { gold: 150 } }));
    expect(d.reason).toBe('computed');
    expect(d.seconds).toBe(0);
  });

  it('computes seconds from positive rate', () => {
    const d = timeUntilResource(
      'gold',
      100,
      mockAccessor({ resources: { gold: 40 }, rates: { gold: 2 } }),
    );
    expect(d.reason).toBe('computed');
    expect(d.seconds).toBe(30);
  });

  it('returns no-rate when rate is zero and current < target', () => {
    const d = timeUntilResource('gold', 100, mockAccessor({ resources: { gold: 40 } }));
    expect(d.seconds).toBeNull();
    expect(d.reason).toBe('no-rate');
  });

  it('returns no-rate when rate is negative and current < target', () => {
    const d = timeUntilResource(
      'gold',
      100,
      mockAccessor({ resources: { gold: 40 }, rates: { gold: -1 } }),
    );
    expect(d.seconds).toBeNull();
    expect(d.reason).toBe('no-rate');
  });

  it('reports uncomputable rather than 0 when the amount is undefined', () => {
    // An undefined amount used to satisfy the `gte(current, target)` guard and
    // answer "you already have it". It is now indeterminate, which is what the
    // `uncomputable` arm is for — `computed` promises a real `seconds`.
    const d = timeUntilResource(
      'gold',
      100,
      mockAccessor({ resources: { gold: NaN }, rates: { gold: 5 } }),
    );
    expect(d.seconds).toBeNull();
    expect(d.reason).toBe('uncomputable');
  });

  it('reports uncomputable when the rate is undefined', () => {
    const d = timeUntilResource(
      'gold',
      100,
      mockAccessor({ resources: { gold: 40 }, rates: { gold: NaN } }),
    );
    expect(d.seconds).toBeNull();
    expect(d.reason).toBe('uncomputable');
  });
});

describe('timeUntilAffordable', () => {
  // id !== displayName on purpose: the accessor contract keys by id, and a
  // regression to passing displayName here would silently return zero from
  // the mock (unknown key) and collapse every distance to no-rate.
  function buildPurchasable(
    resourceId: string,
    resourceDisplayName: string,
    cost: number,
  ): AffordableLike {
    return {
      resource: {
        id: resourceId,
        displayName: resourceDisplayName,
      } as unknown as AffordableLike['resource'],
      getCost: () => bn(cost),
    };
  }

  it('keys timeUntilResource by resource.id, not displayName', () => {
    const p = buildPurchasable('gold', 'Gold', 250);
    const d = timeUntilAffordable(
      p,
      mockAccessor({ resources: { gold: 100 }, rates: { gold: 5 } }),
    );
    expect(d.reason).toBe('computed');
    expect(d.seconds).toBe(30);
  });

  it('misses when accessor is keyed by displayName instead of id', () => {
    const p = buildPurchasable('gold', 'Gold', 250);
    // Accessor keyed by the displayName "Gold" — walker should not find it.
    const d = timeUntilAffordable(
      p,
      mockAccessor({ resources: { Gold: 100 }, rates: { Gold: 5 } }),
    );
    expect(d.seconds).toBeNull();
    expect(d.reason).toBe('no-rate');
  });

  it('returns 0 when already affordable', () => {
    const p = buildPurchasable('gold', 'Gold', 50);
    const d = timeUntilAffordable(
      p,
      mockAccessor({ resources: { gold: 100 }, rates: { gold: 1 } }),
    );
    expect(d.reason).toBe('computed');
    expect(d.seconds).toBe(0);
  });

  it('returns no-rate when unaffordable and rate is zero', () => {
    const p = buildPurchasable('gold', 'Gold', 500);
    const d = timeUntilAffordable(p, mockAccessor({ resources: { gold: 100 } }));
    expect(d.seconds).toBeNull();
    expect(d.reason).toBe('no-rate');
  });
});

describe('timeUntilConditionFlip — resource six-way truth table', () => {
  // gte — currently-false (current < target): needs rate > 0
  it('gte currently-false + positive rate → computed', () => {
    const c: ICondition = { type: 'resource', target: 'gold', operator: 'gte', value: 100 };
    const d = timeUntilConditionFlip(
      c,
      mockAccessor({ resources: { gold: 60 }, rates: { gold: 4 } }),
    );
    expect(d).toEqual({ seconds: 10, reason: 'computed' });
  });

  it('gte currently-false + zero rate → no-rate', () => {
    const c: ICondition = { type: 'resource', target: 'gold', operator: 'gte', value: 100 };
    const d = timeUntilConditionFlip(c, mockAccessor({ resources: { gold: 60 } }));
    expect(d).toEqual({ seconds: null, reason: 'no-rate' });
  });

  // gte — currently-true (current >= target): flip-to-false needs rate < 0
  it('gte currently-true + negative rate → computed', () => {
    const c: ICondition = { type: 'resource', target: 'gold', operator: 'gte', value: 100 };
    const d = timeUntilConditionFlip(
      c,
      mockAccessor({ resources: { gold: 150 }, rates: { gold: -5 } }),
    );
    expect(d).toEqual({ seconds: 10, reason: 'computed' });
  });

  it('gte currently-true + positive rate → no-rate (never flips back)', () => {
    const c: ICondition = { type: 'resource', target: 'gold', operator: 'gte', value: 100 };
    const d = timeUntilConditionFlip(
      c,
      mockAccessor({ resources: { gold: 150 }, rates: { gold: 5 } }),
    );
    expect(d).toEqual({ seconds: null, reason: 'no-rate' });
  });

  // gt — strict variant, same direction as gte
  it('gt currently-false + positive rate → computed', () => {
    const c: ICondition = { type: 'resource', target: 'gold', operator: 'gt', value: 100 };
    const d = timeUntilConditionFlip(
      c,
      mockAccessor({ resources: { gold: 60 }, rates: { gold: 2 } }),
    );
    expect(d.reason).toBe('computed');
    expect(d.seconds).toBe(20);
  });

  // lte — currently-false (current > target): flip-to-true needs rate < 0
  it('lte currently-false + negative rate → computed', () => {
    const c: ICondition = { type: 'resource', target: 'gold', operator: 'lte', value: 50 };
    const d = timeUntilConditionFlip(
      c,
      mockAccessor({ resources: { gold: 100 }, rates: { gold: -10 } }),
    );
    expect(d).toEqual({ seconds: 5, reason: 'computed' });
  });

  it('lte currently-false + positive rate → no-rate', () => {
    const c: ICondition = { type: 'resource', target: 'gold', operator: 'lte', value: 50 };
    const d = timeUntilConditionFlip(
      c,
      mockAccessor({ resources: { gold: 100 }, rates: { gold: 1 } }),
    );
    expect(d).toEqual({ seconds: null, reason: 'no-rate' });
  });

  // lte — currently-true (current <= target): flip-to-false needs rate > 0
  it('lte currently-true + positive rate → computed', () => {
    const c: ICondition = { type: 'resource', target: 'gold', operator: 'lte', value: 100 };
    const d = timeUntilConditionFlip(
      c,
      mockAccessor({ resources: { gold: 60 }, rates: { gold: 4 } }),
    );
    expect(d).toEqual({ seconds: 10, reason: 'computed' });
  });

  // lt — strict variant
  it('lt currently-true + positive rate → computed', () => {
    const c: ICondition = { type: 'resource', target: 'gold', operator: 'lt', value: 100 };
    const d = timeUntilConditionFlip(
      c,
      mockAccessor({ resources: { gold: 60 }, rates: { gold: 4 } }),
    );
    expect(d).toEqual({ seconds: 10, reason: 'computed' });
  });

  // eq — always uncomputable
  it('eq → uncomputable', () => {
    const c: ICondition = { type: 'resource', target: 'gold', operator: 'eq', value: 100 };
    const d = timeUntilConditionFlip(
      c,
      mockAccessor({ resources: { gold: 50 }, rates: { gold: 1 } }),
    );
    expect(d).toEqual({ seconds: null, reason: 'uncomputable' });
  });
});

describe('timeUntilConditionFlip — opaque predicates', () => {
  it('unlock → opaque-predicate', () => {
    const c: ICondition = { type: 'unlock', target: 'smithing' };
    const d = timeUntilConditionFlip(c, mockAccessor());
    expect(d).toEqual({ seconds: null, reason: 'opaque-predicate' });
  });

  it('state → opaque-predicate', () => {
    const c: ICondition = { type: 'state', target: 'phase', operator: 'eq', value: 'combat' };
    const d = timeUntilConditionFlip(c, mockAccessor());
    expect(d).toEqual({ seconds: null, reason: 'opaque-predicate' });
  });
});

describe('timeUntilConditionFlip — and combinator', () => {
  it('currently-false: max over currently-false children (all computable)', () => {
    const c: ICondition = {
      type: 'and',
      conditions: [
        { type: 'resource', target: 'gold', operator: 'gte', value: 100 },
        { type: 'resource', target: 'wood', operator: 'gte', value: 50 },
      ],
    };
    // gold: needs 60 at rate 4 → 15s; wood: needs 30 at rate 3 → 10s. Max = 15.
    const d = timeUntilConditionFlip(
      c,
      mockAccessor({ resources: { gold: 40, wood: 20 }, rates: { gold: 4, wood: 3 } }),
    );
    expect(d).toEqual({ seconds: 15, reason: 'computed' });
  });

  it('currently-false: ignores currently-true children', () => {
    const c: ICondition = {
      type: 'and',
      conditions: [
        { type: 'resource', target: 'gold', operator: 'gte', value: 100 },
        { type: 'resource', target: 'wood', operator: 'gte', value: 50 },
      ],
    };
    // gold currently false (40 < 100, rate 4 → 15s); wood currently true (80 >= 50, rate 0).
    // Only actionable is gold.
    const d = timeUntilConditionFlip(
      c,
      mockAccessor({ resources: { gold: 40, wood: 80 }, rates: { gold: 4, wood: 0 } }),
    );
    expect(d).toEqual({ seconds: 15, reason: 'computed' });
  });

  it('currently-true: min over children (any flip breaks AND)', () => {
    const c: ICondition = {
      type: 'and',
      conditions: [
        { type: 'resource', target: 'gold', operator: 'gte', value: 100 },
        { type: 'resource', target: 'wood', operator: 'gte', value: 50 },
      ],
    };
    // Both true. Flip-to-false needs rate < 0. gold at 150 rate -5 → 10s; wood at 80 rate -6 → 5s.
    const d = timeUntilConditionFlip(
      c,
      mockAccessor({ resources: { gold: 150, wood: 80 }, rates: { gold: -5, wood: -6 } }),
    );
    expect(d).toEqual({ seconds: 5, reason: 'computed' });
  });

  it('strict-null: any null-distance child propagates null with reason', () => {
    const c: ICondition = {
      type: 'and',
      conditions: [
        { type: 'resource', target: 'gold', operator: 'gte', value: 100 },
        { type: 'unlock', target: 'smithing' },
      ],
    };
    // gold computable (15s); unlock opaque. AND currently false (unlock is false).
    const d = timeUntilConditionFlip(
      c,
      mockAccessor({ resources: { gold: 40 }, rates: { gold: 4 } }),
    );
    expect(d.seconds).toBeNull();
    expect(d.reason).toBe('opaque-predicate');
  });

  it('empty children → uncomputable', () => {
    const c: ICondition = { type: 'and', conditions: [] };
    const d = timeUntilConditionFlip(c, mockAccessor());
    expect(d).toEqual({ seconds: null, reason: 'uncomputable' });
  });
});

describe('timeUntilConditionFlip — or combinator', () => {
  it('currently-false: min over all children (any child flipping satisfies OR)', () => {
    const c: ICondition = {
      type: 'or',
      conditions: [
        { type: 'resource', target: 'gold', operator: 'gte', value: 100 },
        { type: 'resource', target: 'wood', operator: 'gte', value: 50 },
      ],
    };
    const d = timeUntilConditionFlip(
      c,
      mockAccessor({ resources: { gold: 40, wood: 20 }, rates: { gold: 4, wood: 3 } }),
    );
    expect(d).toEqual({ seconds: 10, reason: 'computed' }); // wood is faster
  });

  it('currently-true: max over currently-true children (all must flip)', () => {
    const c: ICondition = {
      type: 'or',
      conditions: [
        { type: 'resource', target: 'gold', operator: 'gte', value: 100 },
        { type: 'resource', target: 'wood', operator: 'gte', value: 50 },
      ],
    };
    // Both currently true. Flip-to-false needs all to flip.
    const d = timeUntilConditionFlip(
      c,
      mockAccessor({ resources: { gold: 150, wood: 80 }, rates: { gold: -5, wood: -6 } }),
    );
    expect(d).toEqual({ seconds: 10, reason: 'computed' }); // max
  });

  it('currently-true: ignores currently-false children (they stay false, assumed)', () => {
    const c: ICondition = {
      type: 'or',
      conditions: [
        { type: 'resource', target: 'gold', operator: 'gte', value: 100 },
        { type: 'resource', target: 'wood', operator: 'gte', value: 500 },
      ],
    };
    // gold currently true (150 >= 100, rate -5 → 10s); wood currently false (80 < 500, rate 0).
    // OR currently true. Only actionable is gold (currently-true child).
    const d = timeUntilConditionFlip(
      c,
      mockAccessor({ resources: { gold: 150, wood: 80 }, rates: { gold: -5, wood: 0 } }),
    );
    expect(d).toEqual({ seconds: 10, reason: 'computed' });
  });
});

describe('timeUntilConditionFlip — not combinator', () => {
  it('NOT currently-true: inner flips to false', () => {
    const c: ICondition = {
      type: 'not',
      condition: { type: 'resource', target: 'gold', operator: 'lt', value: 100 },
    };
    // inner lt currently false (150 < 100 is false), NOT currently true. Flip needs inner to become true.
    // inner lt currently-false needs rate < 0. 150 down to 100 at rate -5 → 10s.
    const d = timeUntilConditionFlip(
      c,
      mockAccessor({ resources: { gold: 150 }, rates: { gold: -5 } }),
    );
    expect(d).toEqual({ seconds: 10, reason: 'computed' });
  });

  it('NOT of opaque → opaque-predicate', () => {
    const c: ICondition = { type: 'not', condition: { type: 'unlock', target: 'smithing' } };
    const d = timeUntilConditionFlip(c, mockAccessor());
    expect(d).toEqual({ seconds: null, reason: 'opaque-predicate' });
  });
});

describe('combineFlipDistances — children that never flip', () => {
  const computed = (seconds: number): TransitionDistance => ({ seconds, reason: 'computed' });
  const never: TransitionDistance = { seconds: null, reason: 'no-rate' };
  const child = (currentlyTrue: boolean, distance: TransitionDistance): ChildFlipResult => ({
    currentlyTrue,
    distance,
  });

  it('OR currently-false takes the soonest child that flips, past ones that never do', () => {
    const d = combineFlipDistances([child(false, never), child(false, computed(10))], 'or');
    expect(d).toEqual(computed(10));
  });

  it('AND currently-true takes the soonest child that breaks, past ones that never do', () => {
    const d = combineFlipDistances([child(true, computed(5)), child(true, never)], 'and');
    expect(d).toEqual(computed(5));
  });

  it('a min over children that all never flip never flips', () => {
    const d = combineFlipDistances([child(false, never), child(false, never)], 'or');
    expect(d).toEqual(never);
  });

  it('a min still propagates an opaque or uncomputable child, which may flip at any time', () => {
    for (const open of [
      { seconds: null, reason: 'opaque-predicate' },
      { seconds: null, reason: 'uncomputable' },
    ] as TransitionDistance[]) {
      expect(
        combineFlipDistances(
          [child(false, never), child(false, computed(10)), child(false, open)],
          'or',
        ),
      ).toEqual(open);
    }
  });

  it('a max propagates a child that never flips: the combinator waits on it', () => {
    expect(combineFlipDistances([child(false, computed(10)), child(false, never)], 'and')).toEqual(
      never,
    );
    expect(combineFlipDistances([child(true, computed(10)), child(true, never)], 'or')).toEqual(
      never,
    );
  });
});
