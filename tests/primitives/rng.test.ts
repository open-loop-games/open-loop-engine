import { describe, it, expect } from 'vitest'
import { seedRNG, getSeed, random, randomInt, randomItem, shuffle, weightedPick, chance } from '@/primitives/rng'

describe('Seeded RNG', () => {
  it('produces deterministic sequence from same seed', () => {
    seedRNG(42)
    const a1 = random(), a2 = random(), a3 = random()
    seedRNG(42)
    expect(random()).toBe(a1)
    expect(random()).toBe(a2)
    expect(random()).toBe(a3)
  })
  it('different seeds produce different sequences', () => {
    seedRNG(42); const a = random()
    seedRNG(99); const b = random()
    expect(a).not.toBe(b)
  })
  it('getSeed() returns current seed', () => {
    seedRNG(123)
    expect(getSeed()).toBe(123)
  })
  it('random() returns values in [0, 1)', () => {
    seedRNG(1)
    for (let i = 0; i < 100; i++) {
      const v = random()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
  it('randomInt() returns values in [min, max] inclusive', () => {
    seedRNG(1)
    for (let i = 0; i < 100; i++) {
      const v = randomInt(1, 6)
      expect(v).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(6)
      expect(Number.isInteger(v)).toBe(true)
    }
  })
  it('randomItem() picks from array', () => {
    seedRNG(1)
    const arr = ['a', 'b', 'c']
    expect(arr).toContain(randomItem(arr))
  })
  it('shuffle() returns all elements without mutating', () => {
    seedRNG(1)
    const arr = [1, 2, 3, 4, 5]
    const original = [...arr]
    const shuffled = shuffle(arr)
    expect(shuffled).toHaveLength(5)
    expect(shuffled.sort()).toEqual([1, 2, 3, 4, 5])
    expect(arr).toEqual(original)
  })
  it('weightedPick() respects weights', () => {
    seedRNG(1)
    const items = [{ item: 'common', weight: 100 }, { item: 'rare', weight: 0 }]
    for (let i = 0; i < 10; i++) expect(weightedPick(items)).toBe('common')
  })
  it('chance(1) always true, chance(0) always false', () => {
    seedRNG(1)
    for (let i = 0; i < 10; i++) { expect(chance(1)).toBe(true); expect(chance(0)).toBe(false) }
  })
})
