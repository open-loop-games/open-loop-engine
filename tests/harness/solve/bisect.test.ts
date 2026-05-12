import { describe, it, expect } from 'vitest';
import { bisectTuner } from '@/harness';

describe('bisectTuner', () => {
  it('converges on a forward-monotonic sampler', () => {
    const result = bisectTuner({
      lo: 0,
      hi: 20,
      targetSec: 50,
      sampler: (x) => x * 10,
      tolSec: 0.1,
    });
    expect(result.direction).toBe('forward');
    expect(result.value).toBeCloseTo(5, 1);
    expect(result.time).toBeCloseTo(50, 1);
    expect(result.iterations).toBeLessThan(10);
  });

  it('converges on an inverted-monotonic sampler', () => {
    const result = bisectTuner({
      lo: 0,
      hi: 10,
      targetSec: 50,
      sampler: (x) => 100 - x * 10,
      tolSec: 0.1,
    });
    expect(result.direction).toBe('inverted');
    expect(result.value).toBeCloseTo(5, 1);
    expect(result.time).toBeCloseTo(50, 1);
  });

  it('honors maxIters when hi bound is unreachable', () => {
    const result = bisectTuner({
      lo: 0,
      hi: 10,
      targetSec: 100,
      sampler: (x) => (x < 5 ? x * 10 : Infinity),
      maxIters: 8,
    });
    // Hi-side samples infinity → direction 'forward' (tHi +Infinity ≥ tLo 0).
    expect(result.direction).toBe('forward');
    expect(result.iterations).toBeLessThanOrEqual(8);
    // Best seen is still a finite sample — the tuner tracks best-delta.
    expect(isFinite(result.time)).toBe(true);
  });

  it('returns on iteration 1 when the mid already satisfies tolerance', () => {
    const result = bisectTuner({
      lo: 0,
      hi: 100,
      targetSec: 50,
      sampler: () => 50,
      tolSec: 1,
    });
    expect(result.iterations).toBe(1);
    expect(result.time).toBe(50);
  });

  it('does not crash when both bounds are infeasible', () => {
    const result = bisectTuner({
      lo: 0,
      hi: 10,
      targetSec: 50,
      sampler: () => Infinity,
      maxIters: 4,
    });
    // Both endpoints map +Infinity → direction falls back to forward
    // (tHi >= tLo via +Infinity comparison).
    expect(result.direction).toBe('forward');
    expect(result.time).toBe(Infinity);
    expect(result.iterations).toBe(0);
  });
});
