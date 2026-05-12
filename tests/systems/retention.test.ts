import { describe, it, expect } from 'vitest';
import { bn } from '@/primitives/decimal';
import { Decimal } from '@/primitives/decimal';
import { createResource, addResource } from '@/core/resource';
import { persistent, beginPersistentContext, endPersistentContext } from '@/core/persistence';
import { createReset } from '@/systems/reset';
import { createRetentionPolicy, fractional } from '@/systems/retention';

describe('createRetentionPolicy', () => {
  it('keep preserves refs through reset', () => {
    beginPersistentContext('ret-keep');
    const gold = createResource(bn(0), { displayName: 'Gold' });
    const prestige = persistent(0);
    const discoveries = persistent(5);
    endPersistentContext();

    addResource(gold, 100);
    prestige.value = 42;

    const retention = createRetentionPolicy({
      keep: [prestige, discoveries],
    });

    const reset = createReset({
      thingsToReset: [gold, prestige, discoveries],
      onBeforeReset: () => {
        retention.snapshot();
      },
      onReset: () => {
        retention.restore();
      },
    });

    reset.reset();

    // gold should be reset
    expect(gold.value.eq(0)).toBe(true);
    // kept refs should survive
    expect(prestige.value).toBe(42);
    expect(discoveries.value).toBe(5);
  });

  it('retain applies transform to refs through reset', () => {
    beginPersistentContext('ret-retain');
    const skillLevel = createResource(bn(0), { displayName: 'Skill' });
    const xp = persistent<number>(0);
    endPersistentContext();

    addResource(skillLevel, 100);
    xp.value = 5000;

    const retention = createRetentionPolicy({
      retain: new Map([[skillLevel, fractional(0.3)]]),
    });

    const reset = createReset({
      thingsToReset: [skillLevel, xp],
      onBeforeReset: () => {
        retention.snapshot();
      },
      onReset: () => {
        retention.restore();
      },
    });

    reset.reset();

    // skillLevel should be 30% of 100 = 30
    expect(Decimal.eq(skillLevel.value, 30)).toBe(true);
    // xp should be fully reset
    expect(xp.value).toBe(0);
  });

  it('retain works with custom formula', () => {
    beginPersistentContext('ret-formula');
    const level = persistent<number>(0);
    const bonus = persistent<number>(0);
    endPersistentContext();

    level.value = 50;
    bonus.value = 2;

    // Groundhog style: bonus = previous + level/10
    const retention = createRetentionPolicy({
      retain: new Map([[bonus, (v: number) => v + level.value / 10]]),
    });

    const reset = createReset({
      thingsToReset: [level, bonus],
      onBeforeReset: () => {
        retention.snapshot();
      },
      onReset: () => {
        retention.restore();
      },
    });

    reset.reset();

    // level should be reset
    expect(level.value).toBe(0);
    // bonus should be 2 + 50/10 = 7
    expect(bonus.value).toBe(7);
  });

  it('keep and retain can be combined', () => {
    beginPersistentContext('ret-combined');
    const permanent = persistent(99);
    const partial = persistent<number>(0);
    const temp = persistent<number>(0);
    endPersistentContext();

    partial.value = 200;
    temp.value = 500;

    const retention = createRetentionPolicy({
      keep: [permanent],
      retain: new Map([[partial, fractional(0.5)]]),
    });

    const reset = createReset({
      thingsToReset: [permanent, partial, temp],
      onBeforeReset: () => {
        retention.snapshot();
      },
      onReset: () => {
        retention.restore();
      },
    });

    reset.reset();

    expect(permanent.value).toBe(99);
    expect(Decimal.eq(partial.value, 100)).toBe(true); // 200 * 0.5
    expect(temp.value).toBe(0);
  });

  it('snapshot captures pre-reset values', () => {
    beginPersistentContext('ret-snapshot-order');
    const counter = persistent<number>(0);
    endPersistentContext();

    counter.value = 10;

    const retention = createRetentionPolicy({
      keep: [counter],
    });

    // Snapshot captures current value
    retention.snapshot();
    // Even if value changes between snapshot and restore
    counter.value = 0;
    retention.restore();

    expect(counter.value).toBe(10);
  });

  it('works with Decimal values via fractional', () => {
    beginPersistentContext('ret-decimal');
    const bigResource = createResource(bn(0), { displayName: 'Big' });
    endPersistentContext();

    addResource(bigResource, bn('1e100'));

    const retention = createRetentionPolicy({
      retain: new Map([[bigResource, fractional(0.1)]]),
    });

    const reset = createReset({
      thingsToReset: [bigResource],
      onBeforeReset: () => {
        retention.snapshot();
      },
      onReset: () => {
        retention.restore();
      },
    });

    reset.reset();

    // Should be 10% of 1e100 = 1e99
    expect(Decimal.eq(bigResource.value, bn('1e99'))).toBe(true);
  });

  it('empty policy is a no-op', () => {
    beginPersistentContext('ret-empty');
    const val = persistent<number>(0);
    endPersistentContext();

    val.value = 42;

    const retention = createRetentionPolicy({});

    retention.snapshot();
    val.value = 0;
    retention.restore();

    // No refs to restore — stays at 0
    expect(val.value).toBe(0);
  });
});
