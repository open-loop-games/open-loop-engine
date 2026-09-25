import { describe, it, expect, beforeEach } from 'vitest';
import { ref, nextTick } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { createAchievement } from '@/systems/achievement';
import {
  createAchievementCategory,
  type BaseTieredAchievementDef,
} from '@/systems/achievement-category';
import {
  deserializePersistents,
  getAllPersistentRefs,
  persistent,
  resetAllPersistentContexts,
  serializePersistents,
  withPersistentContext,
} from '@/core/persistence';
import { createReset } from '@/systems/reset';
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

// Helper: build a category that maps the base tiered Def directly into
// AchievementOptions for `registerTiered` tests.
function makeTieredCategory(id: string) {
  return createAchievementCategory<BaseTieredAchievementDef>({
    id,
    mapAchievement: (def) => ({
      display: { title: def.title, description: def.description },
      requirement: def.requirement,
    }),
  });
}

describe('AchievementCategory.registerTiered', () => {
  it('earns tiers in order as static thresholds are crossed', async () => {
    const gold = ref<DecimalSource>(0);
    const cat = makeTieredCategory('gold-hoarder-cat');
    const achievements = cat.registerTiered({
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

    const cat = makeTieredCategory('scaling-hoarder-cat');
    const [ach] = cat.registerTiered({
      baseId: 'scaling-hoarder',
      baseName: 'Scaling Hoarder',
      getValue: () => gold.value,
      tiers: [{ threshold: dynamicThreshold, suffix: 'I' }],
    });

    // prestige=1 → threshold=100
    gold.value = 150;
    await nextTick();
    expect(ach!.earned.value).toBe(true);

    // Separate instance with prestige=2 — threshold=400
    const gold2 = ref<DecimalSource>(0);
    const prestige2 = ref<DecimalSource>(2);
    const threshold2 = Formula.variable(prestige2).pow(2).mul(100);
    const cat2 = makeTieredCategory('scaling-hoarder-2-cat');
    const [ach2] = cat2.registerTiered({
      baseId: 'scaling-hoarder-2',
      baseName: 'Scaling Hoarder',
      getValue: () => gold2.value,
      tiers: [{ threshold: threshold2, suffix: 'I' }],
    });
    gold2.value = 300; // under 400
    await nextTick();
    expect(ach2!.earned.value).toBe(false);
    gold2.value = 500;
    await nextTick();
    expect(ach2!.earned.value).toBe(true);
  });

  it('Formula threshold with no variable works as a constant', async () => {
    const gold = ref<DecimalSource>(0);
    const staticFormula = Formula.constant(new Decimal(250));
    const cat = makeTieredCategory('const-formula-cat');
    const [ach] = cat.registerTiered({
      baseId: 'const-formula',
      baseName: 'Const Formula',
      getValue: () => gold.value,
      tiers: [{ threshold: staticFormula, suffix: 'I' }],
    });
    gold.value = 249;
    await nextTick();
    expect(ach!.earned.value).toBe(false);
    gold.value = 250;
    await nextTick();
    expect(ach!.earned.value).toBe(true);
  });
});

describe('Achievement — a load restores state, it does not earn', () => {
  /** One session: gold registers before the achievements, as a module's resources do. */
  function buildSession(ids: string[]) {
    const log: string[] = [];
    return withPersistentContext('m', () => {
      const gold = persistent(0, { name: 'gold' });
      const achievements = createAchievementCategory<{ id: string }>({
        id: 'ach',
        mapAchievement: (def) => ({
          display: { title: def.id },
          requirement: () => gold.value >= 10,
          onComplete: () => log.push(`onComplete ${def.id}`),
        }),
      });
      achievements.register(ids.map((id) => ({ id })));
      for (const { achievement } of achievements.getAll()) {
        achievement.on('earned', () => log.push(`earned ${achievement.id}`));
      }
      return { gold, achievements, log };
    });
  }

  function saveSession(gold: { value: number }): Record<string, unknown> {
    gold.value = 20;
    const save = serializePersistents(getAllPersistentRefs());
    resetAllPersistentContexts();
    return save;
  }

  it('fires no onComplete or earned for an achievement the save already holds', () => {
    const first = buildSession(['rich']);
    const earnedAt = first.achievements.getAchievement('rich')!.earnedAt;
    const save = saveSession(first.gold);
    const savedAt = earnedAt.value;

    const second = buildSession(['rich']);
    deserializePersistents(getAllPersistentRefs(), save);

    expect(second.log).toEqual([]);
    const rich = second.achievements.getAchievement('rich')!;
    expect(rich.earned.value).toBe(true);
    expect(rich.earnedAt.value).toBe(savedAt);
  });

  it('earns once on load an achievement added since the save whose requirement holds', () => {
    const save = saveSession(buildSession(['rich']).gold);

    const second = buildSession(['rich', 'added']);
    deserializePersistents(getAllPersistentRefs(), save);

    expect(second.log).toEqual(['onComplete added', 'earned added']);
  });

  it('re-earns after a reset that names its refs when the requirement still holds', () => {
    const { achievements, gold, log } = buildSession(['rich']);
    gold.value = 20;
    const rich = achievements.getAchievement('rich')!;
    log.length = 0;

    createReset({ thingsToReset: [rich.earned, rich.earnedAt] }).reset();

    expect(rich.earned.value).toBe(true);
    expect(log).toEqual(['onComplete rich', 'earned rich']);
  });
});
