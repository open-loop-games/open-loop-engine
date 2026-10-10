import { describe, it, expect, beforeEach } from 'vitest';
import {
  CategoriesKey,
  Decimal,
  Formula,
  createAchievementCategory,
  createChallengeCategory,
  createEngine,
  createProducerCategory,
  createPurchasableCategory,
  createResource,
  createSkillCategory,
  findCategoryEntrySignals,
  type EngineCategories,
  type EngineModule,
} from '@/index';
import { resetAllPersistentContexts } from '@/core/persistence';

beforeEach(() => {
  resetAllPersistentContexts();
});

interface AchDef {
  id: string;
  name: string;
}

interface UpgDef {
  id: string;
  name: string;
}

interface SkillDef {
  id: string;
  name: string;
}

interface ProdDef {
  id: string;
}

interface ChalDef {
  id: string;
  name: string;
  goal?: () => boolean;
}

// ============================================================================
// Per-category signals — verify the unlock/count derivations
// ============================================================================

describe('CategoryEntrySignals — per-category derivation', () => {
  it('Achievement: unlock=earned, count=earned?1:0', () => {
    const cat = createAchievementCategory<AchDef>({
      id: 'achievements',
      mapAchievement: (def) => ({ display: { title: def.name } }),
    });
    cat.register({ id: 'first', name: 'First' });

    const entry = cat.getEntry('first')!;
    expect(entry.signals.active.value).toBe(false);
    expect(Decimal.fromValue(entry.signals.count.value).toNumber()).toBe(0);

    entry.achievement.complete();
    expect(entry.signals.active.value).toBe(true);
    expect(Decimal.fromValue(entry.signals.count.value).toNumber()).toBe(1);
  });

  it('Purchasable: unlock=active, count=amount', () => {
    const cat = createPurchasableCategory<UpgDef>({
      id: 'upgrades',
      mapPurchasable: () => ({
        display: { description: '' },
        requirements: [],
        effect: 1,
        limit: 5,
      }),
    });
    cat.register({ id: 'fast', name: 'Fast' });

    const entry = cat.getEntry('fast')!;
    expect(entry.signals.active.value).toBe(false);
    expect(Decimal.fromValue(entry.signals.count.value).toNumber()).toBe(0);

    entry.purchasable.amount.value = 3;
    expect(entry.signals.active.value).toBe(true);
    expect(Decimal.fromValue(entry.signals.count.value).toNumber()).toBe(3);
  });

  it('Skill: unlock=level>0, count=level (level-driven)', () => {
    const cat = createSkillCategory<SkillDef>({
      id: 'skills',
      mapSkill: () => ({
        xpToLevel: (xp) => Formula.variable(xp),
        levelToMultiplier: (level) => Formula.variable(level),
      }),
    });
    cat.register({ id: 'combat', name: 'Combat' });

    const entry = cat.getEntry('combat')!;
    expect(entry.signals.active.value).toBe(false);
    expect(Decimal.fromValue(entry.signals.count.value).toNumber()).toBe(0);

    entry.skill.addXp(5);
    expect(entry.signals.active.value).toBe(true);
    expect(Decimal.fromValue(entry.signals.count.value).toNumber()).toBe(5);
  });

  it('Producer (manual): count=1 with no purchase config, unlock=true', () => {
    const points = createResource(0, { id: 'points', displayName: 'points' });
    const cat = createProducerCategory<ProdDef>({
      id: 'clicks',
      mapProducer: () => ({
        resource: points,
        baseRate: 1,
        trigger: 'manual',
      }),
      registerTick: () => () => {},
    });
    cat.register({ id: 'click' });

    const entry = cat.getEntry('click')!;
    // Manual producer with no purchase config: count is constant 1.
    expect(Decimal.fromValue(entry.signals.count.value).toNumber()).toBe(1);
    expect(entry.signals.active.value).toBe(true);
  });

  it('Challenge: unlock=completed, count=completions', () => {
    const cat = createChallengeCategory<ChalDef>({
      id: 'challenges',
      mutuallyExclusive: false,
    });
    cat.register({ id: 'no-x', name: 'No X', goal: () => true });

    const entry = cat.getEntry('no-x')!;
    expect(entry.signals.active.value).toBe(false);
    expect(Decimal.fromValue(entry.signals.count.value).toNumber()).toBe(0);

    entry.challenge.enter();
    entry.challenge.complete();
    expect(entry.signals.active.value).toBe(true);
    expect(Decimal.fromValue(entry.signals.count.value).toNumber()).toBe(1);
  });
});

// ============================================================================
// findCategoryEntrySignals — cross-cut helper
// ============================================================================

describe('findCategoryEntrySignals', () => {
  it('resolves across heterogeneous category types via engine.tryInject', () => {
    let categories: EngineCategories | undefined;

    const game: EngineModule = {
      id: 'game',
      install() {
        const skills = createSkillCategory<SkillDef>({
          id: 'pk/skills',
          mapSkill: () => ({
            xpToLevel: (xp) => Formula.variable(xp),
            levelToMultiplier: (level) => Formula.variable(level),
          }),
        });
        skills.register({ id: 'mining', name: 'Mining' });

        const ach = createAchievementCategory<AchDef>({
          id: 'pk/achievements',
          mapAchievement: (def) => ({ display: { title: def.name } }),
        });
        ach.register({ id: 'first-ore', name: 'First Ore' });
      },
    };

    const observer: EngineModule = {
      id: 'observer',
      dependencies: ['game'],
      install(ctx) {
        categories = ctx.tryInject(CategoriesKey);
      },
    };

    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(game).use(observer);
    engine.start();

    const skillSignals = findCategoryEntrySignals(categories!, 'pk/skills', 'mining');
    expect(skillSignals).toBeDefined();
    expect(skillSignals!.active.value).toBe(false);

    const achSignals = findCategoryEntrySignals(categories!, 'pk/achievements', 'first-ore');
    expect(achSignals).toBeDefined();
    expect(achSignals!.active.value).toBe(false);

    engine.stop();
  });

  it('returns undefined for unknown category id', () => {
    const cat = createSkillCategory<SkillDef>({
      id: 'real-skills',
      mapSkill: () => ({
        xpToLevel: (xp) => Formula.variable(xp),
        levelToMultiplier: (level) => Formula.variable(level),
      }),
    });
    cat.register({ id: 'mining', name: 'Mining' });

    const categories: EngineCategories = { skills: [cat] };
    expect(findCategoryEntrySignals(categories, 'fictional', 'mining')).toBeUndefined();
  });

  it('returns undefined for known category but unknown entity id', () => {
    const cat = createSkillCategory<SkillDef>({
      id: 'skills',
      mapSkill: () => ({
        xpToLevel: (xp) => Formula.variable(xp),
        levelToMultiplier: (level) => Formula.variable(level),
      }),
    });
    cat.register({ id: 'mining', name: 'Mining' });

    const categories: EngineCategories = { skills: [cat] };
    expect(findCategoryEntrySignals(categories, 'skills', 'fishing')).toBeUndefined();
  });

  it('returns undefined when no buckets are populated', () => {
    expect(findCategoryEntrySignals({}, 'anything', 'anywhere')).toBeUndefined();
  });

  it('signals are reactive — track underlying ref changes', () => {
    const cat = createAchievementCategory<AchDef>({
      id: 'achievements',
      mapAchievement: (def) => ({ display: { title: def.name } }),
    });
    cat.register({ id: 'a', name: 'A' });

    const categories: EngineCategories = { achievements: [cat] };
    const signals = findCategoryEntrySignals(categories, 'achievements', 'a')!;

    expect(signals.active.value).toBe(false);
    cat.getAchievement('a')!.complete();
    expect(signals.active.value).toBe(true);
  });
});

// ============================================================================
// Category id exposure
// ============================================================================

describe('Category.id exposure', () => {
  it('each category factory exposes its id field', () => {
    const ach = createAchievementCategory<AchDef>({
      id: 'achievements/main',
      mapAchievement: (def) => ({ display: { title: def.name } }),
    });
    expect(ach.id).toBe('achievements/main');

    const upg = createPurchasableCategory<UpgDef>({
      id: 'upgrades/buildings',
      mapPurchasable: () => ({ display: { description: '' }, requirements: [], effect: 1 }),
    });
    expect(upg.id).toBe('upgrades/buildings');

    const skill = createSkillCategory<SkillDef>({
      id: 'skills/combat',
      mapSkill: () => ({
        xpToLevel: (xp) => Formula.variable(xp),
        levelToMultiplier: (level) => Formula.variable(level),
      }),
    });
    expect(skill.id).toBe('skills/combat');

    const chal = createChallengeCategory<ChalDef>({ id: 'challenges/cycle' });
    expect(chal.id).toBe('challenges/cycle');
  });
});
