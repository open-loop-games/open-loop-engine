import { describe, it, expect } from 'vitest';
import {
  seedRNG,
  getSeed,
  random,
  randomInt,
  randomItem,
  shuffle,
  weightedPick,
  chance,
  createSeededRNG,
} from '@/primitives/rng';

describe('Seeded RNG', () => {
  it('produces deterministic sequence from same seed', () => {
    seedRNG(42);
    const a1 = random(),
      a2 = random(),
      a3 = random();
    seedRNG(42);
    expect(random()).toBe(a1);
    expect(random()).toBe(a2);
    expect(random()).toBe(a3);
  });
  it('different seeds produce different sequences', () => {
    seedRNG(42);
    const a = random();
    seedRNG(99);
    const b = random();
    expect(a).not.toBe(b);
  });
  it('early draws of a seeded stream are non-degenerate (mash carries state)', () => {
    // Regression: a stateless mash makes s0==s1==s2 at init, so draws 2 and 3
    // come out bit-identical for every seed. Guard the whole init family.
    for (const seed of [0, 1, 42, 12345]) {
      seedRNG(seed);
      const draws = [random(), random(), random(), random()];
      expect(new Set(draws).size).toBe(draws.length);
    }
  });
  it('seeded streams reproduce pinned values', () => {
    // Recorded seeds and replays depend on these exact streams (canonical Alea).
    const golden: Record<number, number[]> = {
      0: [0.5945264333859086, 0.8065849216654897, 0.12979769078083336, 0.6747123580425978],
      42: [0.6848634963389486, 0.5463244677521288, 0.8455933185759932, 0.19908552314154804],
      12345: [0.27138191112317145, 0.19615925149992108, 0.6810678059700876, 0.9894359013997018],
    };
    for (const [seed, values] of Object.entries(golden)) {
      const rng = createSeededRNG(Number(seed));
      expect([rng(), rng(), rng(), rng()]).toEqual(values);
      seedRNG(Number(seed));
      expect([random(), random(), random(), random()]).toEqual(values);
    }
  });
  it('getSeed() returns current seed', () => {
    seedRNG(123);
    expect(getSeed()).toBe(123);
  });
  it('random() returns values in [0, 1)', () => {
    seedRNG(1);
    for (let i = 0; i < 100; i++) {
      const v = random();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it('randomInt() returns values in [min, max] inclusive', () => {
    seedRNG(1);
    for (let i = 0; i < 100; i++) {
      const v = randomInt(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
  it('randomItem() picks from array', () => {
    seedRNG(1);
    const arr = ['a', 'b', 'c'];
    expect(arr).toContain(randomItem(arr));
  });
  it('shuffle() returns all elements without mutating', () => {
    seedRNG(1);
    const arr = [1, 2, 3, 4, 5];
    const original = [...arr];
    const shuffled = shuffle(arr);
    expect(shuffled).toHaveLength(5);
    expect(shuffled.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(arr).toEqual(original);
  });
  it('weightedPick() respects weights', () => {
    seedRNG(1);
    const items = [
      { item: 'common', weight: 100 },
      { item: 'rare', weight: 0 },
    ];
    for (let i = 0; i < 10; i++) expect(weightedPick(items)).toBe('common');
  });
  it('chance(1) always true, chance(0) always false', () => {
    seedRNG(1);
    for (let i = 0; i < 10; i++) {
      expect(chance(1)).toBe(true);
      expect(chance(0)).toBe(false);
    }
  });
});

describe('Injected RNG stream', () => {
  it('weightedPick() draws from the injected stream deterministically', () => {
    const items = [
      { item: 'a', weight: 1 },
      { item: 'b', weight: 1 },
      { item: 'c', weight: 1 },
    ];
    const picksOf = (seed: number) => {
      const rng = createSeededRNG(seed);
      return Array.from({ length: 20 }, () => weightedPick(items, rng));
    };
    expect(picksOf(7)).toEqual(picksOf(7));
    expect(picksOf(7)).not.toEqual(picksOf(8));
  });
  it('injected draws never advance the module-global stream', () => {
    seedRNG(42);
    const expected = [random(), random(), random()];
    seedRNG(42);
    const rng = createSeededRNG(7);
    randomInt(1, 6, rng);
    randomItem(['a', 'b', 'c'], rng);
    shuffle([1, 2, 3, 4], rng);
    weightedPick([{ item: 'x', weight: 1 }], rng);
    chance(0.5, rng);
    expect([random(), random(), random()]).toEqual(expected);
  });
  it('all helpers accept an injected stream and stay in contract', () => {
    const rng = createSeededRNG(3);
    for (let i = 0; i < 50; i++) {
      const v = randomInt(1, 6, rng);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    }
    expect(['a', 'b', 'c']).toContain(randomItem(['a', 'b', 'c'], rng));
    expect(shuffle([1, 2, 3, 4, 5], rng).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(chance(1, rng)).toBe(true);
    expect(chance(0, rng)).toBe(false);
  });
});
