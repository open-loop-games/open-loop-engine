import { describe, it, expect, vi } from 'vitest'
import { createGameLoop } from '@/core/game-loop'
import { processOfflineTime } from '@/core/offline'

describe('processOfflineTime', () => {
  it('feeds elapsed time through game loop in chunks', () => {
    const loop = createGameLoop({ tickRate: 20, maxDeltaTime: 5 })
    const fn = vi.fn()
    loop.onTick(fn)
    processOfflineTime(loop, 3, { chunkSize: 1 })
    const totalDt = fn.mock.calls.reduce((sum: number, call: [number]) => sum + call[0], 0)
    expect(totalDt).toBeCloseTo(3, 0)
  })

  it('returns capped seconds processed', () => {
    const loop = createGameLoop({ tickRate: 20, maxDeltaTime: 5 })
    const result = processOfflineTime(loop, 500, { maxOfflineSeconds: 100 })
    expect(result).toBe(100)
  })

  it('handles remainder smaller than chunkSize', () => {
    const loop = createGameLoop({ tickRate: 20, maxDeltaTime: 5 })
    const fn = vi.fn()
    loop.onTick(fn)
    processOfflineTime(loop, 2.5, { chunkSize: 1 })
    const totalDt = fn.mock.calls.reduce((sum: number, call: [number]) => sum + call[0], 0)
    expect(totalDt).toBeCloseTo(2.5, 0)
  })

  it('clamps negative elapsed to zero', () => {
    const loop = createGameLoop({ tickRate: 20, maxDeltaTime: 5 })
    const fn = vi.fn()
    loop.onTick(fn)
    const result = processOfflineTime(loop, -10)
    expect(result).toBe(0)
    expect(fn).not.toHaveBeenCalled()
  })

  it('defaults to 3-day cap', () => {
    const loop = createGameLoop({ tickRate: 1, maxDeltaTime: 500000 })
    const result = processOfflineTime(loop, 1_000_000)
    expect(result).toBe(259200)
  })
})
