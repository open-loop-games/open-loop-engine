import { describe, it, expect, vi } from 'vitest';
import {
  selectionCheapest,
  selectionComposite,
  selectionHybridPayback,
  type HybridPaybackOptions,
  type SelectionPolicy,
} from '@/core/policy';

interface Candidate {
  id: string;
  cost: number;
  rate: number;
}

function hybridOptions(headline = 1000, resource = 0): HybridPaybackOptions<Candidate> {
  return {
    getCost: (c) => c.cost,
    getRate: (c) => c.rate,
    getAmount: () => resource,
    getReserve: () => 0,
    getTotalRate: () => headline,
  };
}

const never: SelectionPolicy<Candidate> = { pick: () => undefined };

describe('selectionComposite', () => {
  const a: Candidate = { id: 'a', cost: 5, rate: 1 };
  const b: Candidate = { id: 'b', cost: 1, rate: 1 };

  it('returns the first policy pick that is not undefined, in order', () => {
    const first = { pick: vi.fn(() => undefined) };
    const second = { pick: vi.fn(() => a) };
    const third = { pick: vi.fn(() => b) };
    const policy = selectionComposite<Candidate>(first, second, third);

    expect(policy.pick([a, b])).toBe(a);
    expect(first.pick).toHaveBeenCalledOnce();
    expect(third.pick).not.toHaveBeenCalled();
  });

  it('hands every policy the same candidates and ctx', () => {
    const first = { pick: vi.fn(() => undefined) };
    const second = { pick: vi.fn(() => undefined) };
    const ctx = { tag: 'call' };
    selectionComposite<Candidate>(first, second).pick([a, b], ctx);

    expect(first.pick).toHaveBeenCalledWith([a, b], ctx);
    expect(second.pick).toHaveBeenCalledWith([a, b], ctx);
  });

  it('returns undefined when every policy declines', () => {
    expect(selectionComposite(never, never).pick([a, b])).toBeUndefined();
  });

  it('falls back to the next policy when the first declines', () => {
    const policy = selectionComposite(
      never,
      selectionCheapest<Candidate>((c) => c.cost),
    );
    expect(policy.pick([a, b])).toBe(b);
  });
});

describe('selectionHybridPayback', () => {
  // quick: payback 100s; slow: payback 200s but a tenth of the price.
  const quick: Candidate = { id: 'quick', cost: 100, rate: 1 };
  const slow: Candidate = { id: 'slow', cost: 10, rate: 0.05 };

  it('ranks by wait plus payback under the options headline rate', () => {
    expect(selectionHybridPayback(hybridOptions(1000)).pick([quick, slow])).toBe(quick);
  });

  it('prefers a ctx getTotalRate over the options one', () => {
    const policy = selectionHybridPayback(hybridOptions(1000));
    // At 0.1/s the wait term dominates: quick 1000 + 100, slow 100 + 200.
    expect(policy.pick([quick, slow], { getTotalRate: () => 0.1 })).toBe(slow);
  });

  it('skips candidates that add no rate', () => {
    const free: Candidate = { id: 'free', cost: 1, rate: 0 };
    const policy = selectionHybridPayback(hybridOptions());
    expect(policy.pick([free, slow])).toBe(slow);
    expect(policy.pick([free])).toBeUndefined();
  });

  it('ranks affordable candidates by payback when the headline rate is zero', () => {
    const policy = selectionHybridPayback(hybridOptions(0, 1000));
    // Both affordable, so no wait: quick pays back in 100s, slow in 200s.
    expect(policy.pick([quick, slow])).toBe(quick);
  });

  it('skips unaffordable candidates when the headline rate is zero', () => {
    // 50 in the bank covers slow (10) but not quick (100), and nothing earns.
    expect(selectionHybridPayback(hybridOptions(0, 50)).pick([quick, slow])).toBe(slow);
    expect(selectionHybridPayback(hybridOptions(0, 5)).pick([quick, slow])).toBeUndefined();
  });
});
