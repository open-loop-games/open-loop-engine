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
      sampler: (x) => x,
      tolSec: 1,
    });
    expect(result.iterations).toBe(1);
    expect(result.time).toBe(50);
  });

  it('returns a calibration endpoint that already meets the target, without bisecting', () => {
    const calls: number[] = [];
    const result = bisectTuner({
      lo: 1,
      hi: 2,
      targetSec: 100,
      sampler: (x) => (calls.push(x), 100 * x),
    });
    expect(result).toMatchObject({ value: 1, time: 100, iterations: 0, bracketed: true });
    expect(calls).toEqual([1, 2]);
  });

  it('reports a target outside the calibrated range as unbracketed, at the nearer endpoint', () => {
    const calls: number[] = [];
    const result = bisectTuner({
      lo: 1,
      hi: 2,
      targetSec: 500,
      sampler: (x) => (calls.push(x), 100 * x),
    });
    expect(result).toMatchObject({ value: 2, time: 200, iterations: 0, bracketed: false });
    expect(calls).toEqual([1, 2]);
  });

  it('counts every bisection call when the ceiling stops it', () => {
    let calls = 0;
    const result = bisectTuner({
      lo: 0,
      hi: 1,
      targetSec: Math.PI / 10,
      sampler: (x) => (calls++, x),
      tolSec: 1e-12,
      maxIters: 5,
    });
    expect(calls).toBe(7);
    expect(result.iterations).toBe(5);
    expect(result.bracketed).toBe(true);
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
    expect(result.bracketed).toBe(false);
  });
});
