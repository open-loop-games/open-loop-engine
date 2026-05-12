import { describe, it, expect, beforeEach } from 'vitest';
import { ref, nextTick } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import {
  createAchievement,
  createAchievementGroup,
  createTieredAchievement,
} from '@/systems/achievement';
import { resetAllPersistentContexts } from '@/core/persistence';
import Formula from '@/core/formulas/formulas';

beforeEach(() => {
  resetAllPersistentContexts();
});

describe('Achievement', () => {
  it('starts as not earned', () => {
    const a = createAchievement({
      id: 'test-ach',
      display: { title: 'First Gold', description: 'Earn gold' },
    });
    expect(a.earned.value).toBe(false);
  });

  it('can be manually completed', () => {
    const a = createAchievement({
      id: 'test-ach-manual',
      display: { title: 'Manual', description: 'Manually awarded' },
    });
    a.complete();
    expect(a.earned.value).toBe(true);
  });

  it('cannot be completed twice', () => {
    let calls = 0;
    const a = createAchievement({
      id: 'test-ach-once',
      display: { title: 'Once', description: 'One-time' },
      onComplete: () => {
        calls++;
      },
    });
    a.complete();
    a.complete();
    expect(calls).toBe(1);
  });

  it('auto-completes when requirement met', async () => {
    const flag = ref(true);
    const a = createAchievement({
      id: 'test-ach-auto',
      display: { title: 'Auto', description: 'Auto awarded' },
      requirement: flag,
    });
    // requirement is immediately true, watch with immediate:true should award it
    expect(a.earned.value).toBe(true);
  });
});

describe('createTieredAchievement', () => {
  it('earns tiers in order as static thresholds are crossed', async () => {
    const gold = ref<DecimalSource>(0);
    const achievements = createTieredAchievement({
      baseId: 'gold-hoarder',
      baseName: 'Gold Hoarder',
      getValue: () => gold.value,
      tiers: [
        { threshold: 100, suffix: 'I' },
        { threshold: 1000, suffix: 'II' },
        { threshold: 10000, suffix: 'III' },
      ],
    });

    expect(achievements.map((a) => a.earned.value)).toEqual([false, false, false]);
    gold.value = 500;
    await nextTick();
    expect(achievements.map((a) => a.earned.value)).toEqual([true, false, false]);
    gold.value = 2000;
    await nextTick();
    expect(achievements.map((a) => a.earned.value)).toEqual([true, true, false]);
  });

  it('accepts a Formula threshold that scales with external state', async () => {
    const prestige = ref<DecimalSource>(1);
    const gold = ref<DecimalSource>(0);
    // Threshold grows with prestige count: 100 * prestige^2
    const dynamicThreshold = Formula.variable(prestige).pow(2).mul(100);

    const [ach] = createTieredAchievement({
      baseId: 'scaling-hoarder',
      baseName: 'Scaling Hoarder',
      getValue: () => gold.value,
      tiers: [{ threshold: dynamicThreshold, suffix: 'I' }],
    });

    // prestige=1 → threshold=100
    gold.value = 150;
    await nextTick();
    expect(ach.earned.value).toBe(true);

    // Separate instance with prestige=2 — threshold=400
    const gold2 = ref<DecimalSource>(0);
    const prestige2 = ref<DecimalSource>(2);
    const threshold2 = Formula.variable(prestige2).pow(2).mul(100);
    const [ach2] = createTieredAchievement({
      baseId: 'scaling-hoarder-2',
      baseName: 'Scaling Hoarder',
      getValue: () => gold2.value,
      tiers: [{ threshold: threshold2, suffix: 'I' }],
    });
    gold2.value = 300; // under 400
    await nextTick();
    expect(ach2.earned.value).toBe(false);
    gold2.value = 500;
    await nextTick();
    expect(ach2.earned.value).toBe(true);
  });

  it('Formula threshold with no variable works as a constant', async () => {
    const gold = ref<DecimalSource>(0);
    const staticFormula = Formula.constant(new Decimal(250));
    const [ach] = createTieredAchievement({
      baseId: 'const-formula',
      baseName: 'Const Formula',
      getValue: () => gold.value,
      tiers: [{ threshold: staticFormula, suffix: 'I' }],
    });
    gold.value = 249;
    await nextTick();
    expect(ach.earned.value).toBe(false);
    gold.value = 250;
    await nextTick();
    expect(ach.earned.value).toBe(true);
  });
});

describe('createAchievementGroup', () => {
  it('allEarned is false for an empty group', () => {
    const group = createAchievementGroup({
      id: 'empty-group',
      name: 'Empty',
      achievements: [],
    });
    expect(group.allEarned.value).toBe(false);
    expect(group.earnedCount.value).toBe(0);
    expect(group.totalCount).toBe(0);
    expect(group.completionPercent.value).toBe(0);
  });

  it('allEarned tracks earned count against totalCount', () => {
    const a = createAchievement({ id: 'g1-a', display: { title: 'A' } });
    const b = createAchievement({ id: 'g1-b', display: { title: 'B' } });
    const group = createAchievementGroup({
      id: 'g1',
      name: 'Group 1',
      achievements: [a, b],
    });

    expect(group.allEarned.value).toBe(false);
    a.complete();
    expect(group.earnedCount.value).toBe(1);
    expect(group.allEarned.value).toBe(false);
    expect(group.completionPercent.value).toBe(50);
    b.complete();
    expect(group.allEarned.value).toBe(true);
    expect(group.completionPercent.value).toBe(100);
  });
});
