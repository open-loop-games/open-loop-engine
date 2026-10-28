import { describe, it, expect } from 'vitest';
import { computed, ref } from 'vue';
import { bn, type DecimalSource } from '@/primitives/decimal';
import { createResource } from '@/core/resource';
import { createResourceBag } from '@/core/resource-bag';
import {
  addRateSource,
  getInflowRate,
  getRate,
  getRateSources,
  hasRateSources,
} from '@/core/rate-source';

const stock = (amount: DecimalSource = 0) => createResource(ref<DecimalSource>(bn(amount)));

describe('rate sources', () => {
  it('getRate is the sum of the rate sources', () => {
    const gold = stock();
    addRateSource(gold, { text: 'mines', rate: 3 });
    addRateSource(gold, { text: 'upkeep', rate: -1 });
    expect(getRate(gold).eq(2)).toBe(true);
  });

  it('reads zero with no rate sources', () => {
    const gold = stock(5);
    expect(getRate(gold).eq(0)).toBe(true);
    expect(getInflowRate(gold).eq(0)).toBe(true);
    expect(hasRateSources(gold)).toBe(false);
  });

  it('the cleanup removes the source, and a computed over getRate follows', () => {
    const gold = stock();
    const rate = computed(() => getRate(gold).toNumber());
    const remove = addRateSource(gold, { text: 'mines', rate: 3 });
    expect(rate.value).toBe(3);
    remove();
    expect(rate.value).toBe(0);
    expect(hasRateSources(gold)).toBe(false);
  });

  it('a source over a ref is reactive', () => {
    const gold = stock();
    const mines = ref(1);
    const rate = computed(() => getRate(gold).toNumber());
    addRateSource(gold, { text: 'mines', rate: mines });
    expect(rate.value).toBe(1);
    mines.value = 4;
    expect(rate.value).toBe(4);
  });

  it('getInflowRate sums the positive sources only', () => {
    const gold = stock(10);
    addRateSource(gold, { text: 'mines', rate: 3 });
    addRateSource(gold, { text: 'smelter', rate: () => 2 });
    addRateSource(gold, { text: 'upkeep', rate: -4 });
    expect(getInflowRate(gold).eq(5)).toBe(true);
    expect(getRate(gold).eq(1)).toBe(true);
  });

  it('getRateSources lists each source with its label, in order', () => {
    const gold = stock();
    addRateSource(gold, { text: 'mines', rate: 3 });
    addRateSource(gold, { text: 'upkeep', rate: -1, allowNegative: true });
    expect(getRateSources(gold).map((s) => [s.text, s.rate.toNumber(), s.allowNegative])).toEqual([
      ['mines', 3, false],
      ['upkeep', -1, true],
    ]);
  });

  describe("at a linked bag's capacity", () => {
    it('a positive net reads zero, and the sources stay unclamped', () => {
      const gold = stock(10);
      createResourceBag({ capacity: 10 }).link('gold', gold);
      addRateSource(gold, { text: 'mines', rate: 3 });
      expect(getRate(gold).eq(0)).toBe(true);
      expect(getInflowRate(gold).eq(0)).toBe(true);
      expect(getRateSources(gold)[0].rate.eq(3)).toBe(true);
    });

    it('a negative net passes', () => {
      const gold = stock(10);
      createResourceBag({ capacity: 10 }).link('gold', gold);
      addRateSource(gold, { text: 'mines', rate: 1 });
      addRateSource(gold, { text: 'upkeep', rate: -3 });
      expect(getRate(gold).eq(-2)).toBe(true);
      expect(getInflowRate(gold).eq(1)).toBe(true);
    });

    it('below capacity the rate is exact', () => {
      const gold = stock(9);
      createResourceBag({ capacity: 10 }).link('gold', gold);
      addRateSource(gold, { text: 'mines', rate: 3 });
      expect(getRate(gold).eq(3)).toBe(true);
    });
  });

  describe('at zero', () => {
    it('a negative net reads zero', () => {
      const food = stock(0);
      addRateSource(food, { text: 'upkeep', rate: -2 });
      expect(getRate(food).eq(0)).toBe(true);
      expect(getRateSources(food)[0].rate.eq(-2)).toBe(true);
    });

    it('a negative net passes when a drain sets allowNegative', () => {
      const debt = stock(0);
      addRateSource(debt, { text: 'interest', rate: -2, allowNegative: true });
      expect(getRate(debt).eq(-2)).toBe(true);
    });

    it('a positive net passes', () => {
      const food = stock(0);
      addRateSource(food, { text: 'farms', rate: 3 });
      addRateSource(food, { text: 'upkeep', rate: -2 });
      expect(getRate(food).eq(1)).toBe(true);
    });
  });
});
