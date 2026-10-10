import { describe, it, expect, beforeEach } from 'vitest';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { createResource, addResource, subtractResource } from '@/core/resource';
import {
  beginPersistentContext,
  endPersistentContext,
  persistent,
  resetAllPersistentContexts,
} from '@/core/persistence';
import {
  beginTraceTick,
  endTraceTick,
  enableTracing,
  getCurrentTraceEntries,
  getPreviousTraceEntries,
  getTraceTick,
  withTraceChain,
  resetTrace,
} from '@/core/trace';
import { createMultiplicativeModifier } from '@/core/modifier';
import type { Modifier } from '@/core/modifier';

function setup() {
  resetTrace();
  resetAllPersistentContexts();
  enableTracing();
}

function makeResource(name: string, initial: DecimalSource) {
  beginPersistentContext(name);
  const r = createResource(initial, { id: name, displayName: name });
  endPersistentContext();
  return r;
}

describe('Trace System', () => {
  beforeEach(setup);

  describe('basic tracing', () => {
    it('records resource mutations during a tick', () => {
      const health = makeResource('Health', 100);

      beginTraceTick();
      health.value = Decimal.sub(health.value, 10);
      endTraceTick();

      const entries = getPreviousTraceEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].resource).toBe(health);
      expect(Decimal.eq(entries[0].delta, -10)).toBe(true);
    });

    it('does not record when not inside a tick', () => {
      const health = makeResource('Health', 100);

      // Mutation outside any tick
      health.value = Decimal.sub(health.value, 5);

      beginTraceTick();
      endTraceTick();

      expect(getPreviousTraceEntries()).toHaveLength(0);
    });

    it('records multiple mutations in one tick', () => {
      const health = makeResource('Health', 100);
      const gold = makeResource('Gold', 50);

      beginTraceTick();
      health.value = Decimal.sub(health.value, 10);
      gold.value = Decimal.add(gold.value, 20);
      endTraceTick();

      const entries = getPreviousTraceEntries();
      expect(entries).toHaveLength(2);
      expect(Decimal.eq(entries[0].delta, -10)).toBe(true);
      expect(Decimal.eq(entries[1].delta, 20)).toBe(true);
    });

    it('ignores zero-delta mutations', () => {
      const health = makeResource('Health', 100);

      beginTraceTick();
      health.value = Decimal.add(health.value, 0);
      endTraceTick();

      expect(getPreviousTraceEntries()).toHaveLength(0);
    });

    it('does not trace non-resource persistents', () => {
      // A plain persistent without displayName should not be traced
      beginPersistentContext('test');
      const flag = persistent(false);
      endPersistentContext();

      beginTraceTick();
      flag.value = true;
      endTraceTick();

      // boolean mutation — not a Decimal, won't produce a valid trace entry
      // The 'displayName' check in the setter should skip it
      expect(getPreviousTraceEntries()).toHaveLength(0);
    });
  });

  describe('tick lifecycle', () => {
    it('rotates entries on beginTraceTick', () => {
      const health = makeResource('Health', 100);

      // Tick 1
      beginTraceTick();
      health.value = Decimal.sub(health.value, 5);
      endTraceTick();

      // Tick 2
      beginTraceTick();
      health.value = Decimal.sub(health.value, 3);
      endTraceTick();

      // Previous should be tick 2's entries
      const prev = getPreviousTraceEntries();
      expect(prev).toHaveLength(1);
      expect(Decimal.eq(prev[0].delta, -3)).toBe(true);
    });

    it('increments tick counter', () => {
      expect(getTraceTick()).toBe(0);
      beginTraceTick();
      endTraceTick();
      expect(getTraceTick()).toBe(1);
      beginTraceTick();
      endTraceTick();
      expect(getTraceTick()).toBe(2);
    });

    it('current entries are readable during a tick', () => {
      const health = makeResource('Health', 100);

      beginTraceTick();
      health.value = Decimal.sub(health.value, 7);
      const during = getCurrentTraceEntries();
      expect(during).toHaveLength(1);
      expect(Decimal.eq(during[0].delta, -7)).toBe(true);
      endTraceTick();
    });
  });

  describe('withTraceChain attribution', () => {
    it('attaches modifier chain to trace entries', () => {
      const health = makeResource('Health', 100);
      const decayMod = createMultiplicativeModifier({
        multiplier: 0.001,
        description: 'Base decay',
      }) as Modifier;

      beginTraceTick();
      withTraceChain(decayMod, () => {
        health.value = Decimal.sub(health.value, 10);
      });
      endTraceTick();

      const entries = getPreviousTraceEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].chain).toBe(decayMod);
    });

    it('does not attach chain outside withTraceChain', () => {
      const health = makeResource('Health', 100);

      beginTraceTick();
      health.value = Decimal.sub(health.value, 5);
      endTraceTick();

      expect(getPreviousTraceEntries()[0].chain).toBeUndefined();
    });

    it('restores previous chain on nested withTraceChain', () => {
      const health = makeResource('Health', 100);
      const gold = makeResource('Gold', 50);
      const chainA = createMultiplicativeModifier({ multiplier: 1, description: 'A' }) as Modifier;
      const chainB = createMultiplicativeModifier({ multiplier: 1, description: 'B' }) as Modifier;

      beginTraceTick();
      withTraceChain(chainA, () => {
        health.value = Decimal.sub(health.value, 1);
        withTraceChain(chainB, () => {
          gold.value = Decimal.add(gold.value, 1);
        });
        health.value = Decimal.sub(health.value, 1);
      });
      endTraceTick();

      const entries = getPreviousTraceEntries();
      expect(entries).toHaveLength(3);
      expect(entries[0].chain).toBe(chainA);
      expect(entries[1].chain).toBe(chainB);
      expect(entries[2].chain).toBe(chainA);
    });
  });

  describe('works with addResource/subtractResource helpers', () => {
    it('traces addResource', () => {
      const gold = makeResource('Gold', 0);

      beginTraceTick();
      addResource(gold, 25);
      endTraceTick();

      const entries = getPreviousTraceEntries();
      expect(entries).toHaveLength(1);
      expect(Decimal.eq(entries[0].delta, 25)).toBe(true);
    });

    it('traces subtractResource', () => {
      const gold = makeResource('Gold', 100);

      beginTraceTick();
      subtractResource(gold, 30);
      endTraceTick();

      const entries = getPreviousTraceEntries();
      expect(entries).toHaveLength(1);
      expect(Decimal.eq(entries[0].delta, -30)).toBe(true);
    });

    it('does not trace failed subtractResource', () => {
      const gold = makeResource('Gold', 5);

      beginTraceTick();
      const success = subtractResource(gold, 100); // fails — insufficient
      endTraceTick();

      expect(success).toBe(false);
      expect(getPreviousTraceEntries()).toHaveLength(0);
    });

    it('attaches chain via addResource chain param', () => {
      const gold = makeResource('Gold', 0);
      const prodChain = createMultiplicativeModifier({
        multiplier: 2,
        description: 'Production',
      }) as Modifier;

      beginTraceTick();
      addResource(gold, 25, prodChain);
      endTraceTick();

      const entries = getPreviousTraceEntries();
      expect(entries).toHaveLength(1);
      expect(Decimal.eq(entries[0].delta, 25)).toBe(true);
      expect(entries[0].chain).toBe(prodChain);
    });

    it('attaches chain via subtractResource options', () => {
      const gold = makeResource('Gold', 100);
      const costChain = createMultiplicativeModifier({
        multiplier: 1.5,
        description: 'Cost scaling',
      }) as Modifier;

      beginTraceTick();
      subtractResource(gold, 30, { chain: costChain });
      endTraceTick();

      const entries = getPreviousTraceEntries();
      expect(entries).toHaveLength(1);
      expect(Decimal.eq(entries[0].delta, -30)).toBe(true);
      expect(entries[0].chain).toBe(costChain);
    });
  });

  describe('opt-in gate', () => {
    it('does not record when no subscription is held', () => {
      resetTrace();
      resetAllPersistentContexts();
      // Intentionally skip enableTracing()
      const health = makeResource('Health', 100);

      beginTraceTick();
      health.value = Decimal.sub(health.value, 10);
      endTraceTick();

      expect(getPreviousTraceEntries()).toHaveLength(0);
    });

    it('records after enableTracing() and stops after dispose', () => {
      resetTrace();
      resetAllPersistentContexts();
      const health = makeResource('Health', 100);

      const dispose = enableTracing();
      beginTraceTick();
      health.value = Decimal.sub(health.value, 1);
      endTraceTick();
      expect(getPreviousTraceEntries()).toHaveLength(1);

      dispose();
      beginTraceTick();
      health.value = Decimal.sub(health.value, 1);
      endTraceTick();
      // After dispose, no new entries recorded
      expect(getPreviousTraceEntries()).toHaveLength(0);
    });

    it('refcounts multiple subscribers', () => {
      resetTrace();
      resetAllPersistentContexts();
      const health = makeResource('Health', 100);

      const disposeA = enableTracing();
      const disposeB = enableTracing();
      disposeA();

      // Still enabled via B
      beginTraceTick();
      health.value = Decimal.sub(health.value, 1);
      endTraceTick();
      expect(getPreviousTraceEntries()).toHaveLength(1);

      disposeB();
      beginTraceTick();
      health.value = Decimal.sub(health.value, 1);
      endTraceTick();
      expect(getPreviousTraceEntries()).toHaveLength(0);
    });
  });
});
