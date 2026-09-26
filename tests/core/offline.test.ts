import { describe, it, expect, vi } from 'vitest';
import { createTickDriver } from '@/core/tick-driver';
import { processOfflineTime } from '@/core/offline';

describe('processOfflineTime', () => {
  it('feeds elapsed time through game tickDriver in chunks', () => {
    const tickDriver = createTickDriver({ tickRate: 20, maxDeltaTime: 5 });
    const fn = vi.fn();
    tickDriver.onTick(fn);
    processOfflineTime(tickDriver, 3, { chunkSize: 1 });
    const totalDt = fn.mock.calls.reduce((sum: number, call: [number]) => sum + call[0], 0);
    expect(totalDt).toBeCloseTo(3, 0);
  });

  it('does not silently drop time when chunkSize exceeds maxDeltaTime', () => {
    const tickDriver = createTickDriver({ tickRate: 20, maxDeltaTime: 1 });
    const fn = vi.fn();
    tickDriver.onTick(fn);
    const result = processOfflineTime(tickDriver, 30, { chunkSize: 10 });
    const totalDt = fn.mock.calls.reduce((sum: number, call: [number]) => sum + call[0], 0);
    expect(result).toBe(30);
    // Actual advanced time must match the reported window, and no tick exceeds the cap.
    expect(totalDt).toBeCloseTo(30, 5);
    for (const [dt] of fn.mock.calls) expect(dt).toBeLessThanOrEqual(1);
  });

  it('returns capped seconds processed', () => {
    const tickDriver = createTickDriver({ tickRate: 20, maxDeltaTime: 5 });
    const result = processOfflineTime(tickDriver, 500, { maxOfflineSeconds: 100 });
    expect(result).toBe(100);
  });

  it('handles remainder smaller than chunkSize', () => {
    const tickDriver = createTickDriver({ tickRate: 20, maxDeltaTime: 5 });
    const fn = vi.fn();
    tickDriver.onTick(fn);
    processOfflineTime(tickDriver, 2.5, { chunkSize: 1 });
    const totalDt = fn.mock.calls.reduce((sum: number, call: [number]) => sum + call[0], 0);
    expect(totalDt).toBeCloseTo(2.5, 0);
  });

  it('clamps negative elapsed to zero', () => {
    const tickDriver = createTickDriver({ tickRate: 20, maxDeltaTime: 5 });
    const fn = vi.fn();
    tickDriver.onTick(fn);
    const result = processOfflineTime(tickDriver, -10);
    expect(result).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it('treats a NaN elapsed (a missing or garbled timestamp) as zero', () => {
    const tickDriver = createTickDriver({ tickRate: 20, maxDeltaTime: 5 });
    const fn = vi.fn();
    tickDriver.onTick(fn);
    expect(processOfflineTime(tickDriver, NaN)).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it('defaults to 3-day cap', () => {
    const tickDriver = createTickDriver({ tickRate: 1, maxDeltaTime: 500000 });
    const result = processOfflineTime(tickDriver, 1_000_000);
    expect(result).toBe(259200);
  });

  it('throws on non-positive or non-finite chunkSize', () => {
    const tickDriver = createTickDriver({ tickRate: 20, maxDeltaTime: 5 });
    expect(() => processOfflineTime(tickDriver, 10, { chunkSize: 0 })).toThrow(/chunkSize/);
    expect(() => processOfflineTime(tickDriver, 10, { chunkSize: -1 })).toThrow(/chunkSize/);
    expect(() => processOfflineTime(tickDriver, 10, { chunkSize: Infinity })).toThrow(/chunkSize/);
    expect(() => processOfflineTime(tickDriver, 10, { chunkSize: NaN })).toThrow(/chunkSize/);
  });
});
