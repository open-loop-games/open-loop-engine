import { describe, it, expect } from 'vitest';
import { createThrottle } from '@/core/throttle';

describe('createThrottle', () => {
  it('returns false before interval elapsed', () => {
    const t = createThrottle({ interval: 1 });
    expect(t.gate(0.3)).toBe(false);
    expect(t.gate(0.3)).toBe(false);
    expect(t.gate(0.3)).toBe(false); // 0.9 total, still under 1
  });

  it('returns true when accumulated dt reaches interval', () => {
    const t = createThrottle({ interval: 1 });
    expect(t.gate(0.5)).toBe(false);
    expect(t.gate(0.5)).toBe(true); // exactly 1.0
  });

  it('preserves remainder for drift-free timing', () => {
    const t = createThrottle({ interval: 1 });
    expect(t.gate(0.7)).toBe(false);
    expect(t.gate(0.7)).toBe(true); // 1.4 total, remainder 0.4
    // Next trigger should happen after 0.6 more (not 1.0)
    expect(t.gate(0.5)).toBe(false); // 0.9 accumulated
    expect(t.gate(0.2)).toBe(true); // 1.1 accumulated → fires
  });

  it('fires at most once per gate() call even with large dt', () => {
    const t = createThrottle({ interval: 1 });
    // Large dt simulating offline catchup
    expect(t.gate(10)).toBe(true);
    // Accumulator should be clamped, not banked for 10 fires
    expect(t.gate(0.5)).toBe(false);
  });

  it('clamps accumulator via modulo on large dt', () => {
    const t = createThrottle({ interval: 1 });
    expect(t.gate(2.7)).toBe(true); // remainder = 2.7 - 1 = 1.7, clamped to 0.7
    // Next trigger after 0.3 more
    expect(t.gate(0.2)).toBe(false);
    expect(t.gate(0.2)).toBe(true); // 0.7 + 0.4 = 1.1
  });

  it('always returns true when interval is zero', () => {
    const t = createThrottle({ interval: 0 });
    expect(t.gate(0.05)).toBe(true);
    expect(t.gate(0.05)).toBe(true);
    expect(t.gate(0)).toBe(true);
  });

  it('always returns true when interval is negative', () => {
    const t = createThrottle({ interval: -1 });
    expect(t.gate(0.05)).toBe(true);
    expect(t.gate(0)).toBe(true);
  });

  it('reset() clears the accumulator', () => {
    const t = createThrottle({ interval: 1 });
    t.gate(0.8); // accumulate 0.8
    t.reset();
    // Need full interval again
    expect(t.gate(0.5)).toBe(false);
    expect(t.gate(0.5)).toBe(true);
  });

  it('exposes interval as read-only', () => {
    const t = createThrottle({ interval: 2.5 });
    expect(t.interval).toBe(2.5);
  });

  it('handles dt of zero without triggering', () => {
    const t = createThrottle({ interval: 1 });
    expect(t.gate(0)).toBe(false);
    expect(t.gate(0)).toBe(false);
  });
});
