import { describe, it, expect } from 'vitest';
import { createTimeSystem } from '@/systems/time';

describe('Time System', () => {
  it('tracks elapsed time', () => {
    const t = createTimeSystem();
    t.tick(0.05);
    t.tick(0.05);
    expect(t.elapsed.value).toBeCloseTo(0.1, 5);
  });
  it('supports speed multiplier', () => {
    const t = createTimeSystem({ speedMultiplier: 2 });
    t.tick(0.05);
    expect(t.elapsed.value).toBeCloseTo(0.1, 5);
  });
  it('resets elapsed without affecting totalPlayTime', () => {
    const t = createTimeSystem();
    t.tick(0.05);
    t.tick(0.05);
    expect(t.elapsed.value).toBeCloseTo(0.1, 5);
    expect(t.totalPlayTime.value).toBeCloseTo(0.1, 5);
    t.reset();
    expect(t.elapsed.value).toBe(0);
    expect(t.totalPlayTime.value).toBeCloseTo(0.1, 5);
  });
});
