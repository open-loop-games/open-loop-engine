import { describe, it, expect, beforeEach } from 'vitest';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import {
  persistent,
  beginPersistentContext,
  endPersistentContext,
  resetAllPersistentContexts,
  type Persistent,
} from '@/core/persistence';

beforeEach(() => {
  resetAllPersistentContexts();
});
import { createSkillCategory } from '@/systems/skill-category';
import type { AccumulatorSkill, Skill } from '@/systems/skill';
import Formula from '@/core/formulas/formulas';

const isAccumulator = (s: Skill): s is AccumulatorSkill => s.lifetimeBonus != null;

// ============================================================================
// Types for tests
// ============================================================================

interface LevelDef {
  id: string;
  name: string;
  xpScale: number;
}

interface AccumDef {
  id: string;
  name: string;
  retentionRate: number;
}

interface MixedDef {
  id: string;
  name: string;
  mode: 'level' | 'accumulator';
}

interface TestState {
  totalXPGained: Persistent<DecimalSource>;
}

// ============================================================================
// createSkillCategory
// ============================================================================

describe('createSkillCategory', () => {
  it('registers definitions and creates Skill instances', () => {
    const category = createSkillCategory<LevelDef>({
      id: 'test1',
      mapSkill: (def) => ({
        xpToLevel: (xp) => Formula.variable(xp).div(def.xpScale).sqrt().floor(),
        levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
      }),
    });

    category.register([
      { id: 'combat', name: 'Combat', xpScale: 10 },
      { id: 'mining', name: 'Mining', xpScale: 20 },
    ]);

    expect(category.size).toBe(2);
    expect(category.getSkill('combat')).toBeDefined();
    expect(category.getSkill('mining')).toBeDefined();
    expect(category.getSkill('unknown')).toBeUndefined();
  });

  it('skills start at zero XP and level', () => {
    const category = createSkillCategory<LevelDef>({
      id: 'test2',
      mapSkill: (def) => ({
        xpToLevel: (xp) => Formula.variable(xp).div(def.xpScale).sqrt().floor(),
        levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
      }),
    });

    category.register({ id: 'combat', name: 'Combat', xpScale: 10 });

    const skill = category.getSkill('combat')!;
    expect(new Decimal(skill.xp.value).eq(0)).toBe(true);
    expect(new Decimal(skill.level.value).eq(0)).toBe(true);
  });

  it('getDef returns the definition from the registry', () => {
    const category = createSkillCategory<LevelDef>({
      id: 'test3',
      mapSkill: (def) => ({
        xpToLevel: (xp) => Formula.variable(xp).div(def.xpScale).sqrt().floor(),
        levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
      }),
    });

    const def = { id: 'combat', name: 'Combat', xpScale: 10 };
    category.register(def);

    expect(category.getDef('combat')).toBe(def);
  });

  it('creates per-instance state via mapState', () => {
    beginPersistentContext('test-state');

    const category = createSkillCategory<LevelDef, TestState>({
      id: 'test4',
      mapSkill: (def) => ({
        xpToLevel: (xp) => Formula.variable(xp).div(def.xpScale).sqrt().floor(),
        levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
      }),
      mapState: () => ({
        totalXPGained: persistent<DecimalSource>(0),
      }),
    });

    category.register([
      { id: 'a', name: 'A', xpScale: 10 },
      { id: 'b', name: 'B', xpScale: 20 },
    ]);

    endPersistentContext();

    const stateA = category.getState('a')!;
    const stateB = category.getState('b')!;
    expect(new Decimal(stateA.totalXPGained.value).eq(0)).toBe(true);

    stateA.totalXPGained.value = 100;
    expect(new Decimal(stateB.totalXPGained.value).eq(0)).toBe(true);
  });

  it('getAll returns entries in registration order', () => {
    const category = createSkillCategory<LevelDef>({
      id: 'test5',
      mapSkill: (def) => ({
        xpToLevel: (xp) => Formula.variable(xp).div(def.xpScale).sqrt().floor(),
        levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
      }),
    });

    category.register([
      { id: 'b', name: 'B', xpScale: 20 },
      { id: 'a', name: 'A', xpScale: 10 },
      { id: 'c', name: 'C', xpScale: 30 },
    ]);

    const ids = category.getAll().map((e) => e.def.id);
    expect(ids).toEqual(['b', 'a', 'c']);
  });

  it('getEntry returns full tuple', () => {
    beginPersistentContext('test-entry');

    const category = createSkillCategory<LevelDef, TestState>({
      id: 'test6',
      mapSkill: (def) => ({
        xpToLevel: (xp) => Formula.variable(xp).div(def.xpScale).sqrt().floor(),
        levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
      }),
      mapState: () => ({
        totalXPGained: persistent<DecimalSource>(0),
      }),
    });

    category.register({ id: 'combat', name: 'Combat', xpScale: 10 });

    endPersistentContext();

    const entry = category.getEntry('combat')!;
    expect(entry.def.id).toBe('combat');
    expect(entry.skill).toBeDefined();
    expect(new Decimal(entry.state.totalXPGained.value).eq(0)).toBe(true);
  });

  it('supports incremental registration (base + mod)', () => {
    const category = createSkillCategory<LevelDef>({
      id: 'test7',
      mapSkill: (def) => ({
        xpToLevel: (xp) => Formula.variable(xp).div(def.xpScale).sqrt().floor(),
        levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
      }),
    });

    category.register([{ id: 'base', name: 'Base', xpScale: 10 }]);
    expect(category.size).toBe(1);

    category.register([{ id: 'mod', name: 'Mod Skill', xpScale: 50 }]);
    expect(category.size).toBe(2);
    expect(category.getSkill('mod')).toBeDefined();
  });

  it('throws on duplicate registration', () => {
    const category = createSkillCategory<LevelDef>({
      id: 'test8',
      mapSkill: (def) => ({
        xpToLevel: (xp) => Formula.variable(xp).div(def.xpScale).sqrt().floor(),
        levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
      }),
    });

    category.register({ id: 'combat', name: 'Combat', xpScale: 10 });

    expect(() => {
      category.register({ id: 'combat', name: 'Duplicate', xpScale: 20 });
    }).toThrow(/Duplicate/);
  });

  it('exposes registry for mod patching', () => {
    const category = createSkillCategory<LevelDef>({
      id: 'test9',
      mapSkill: (def) => ({
        xpToLevel: (xp) => Formula.variable(xp).div(def.xpScale).sqrt().floor(),
        levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
      }),
    });

    category.register({ id: 'combat', name: 'Combat', xpScale: 10 });

    category.registry.patch('combat', { xpScale: 5 });
    expect(category.getDef('combat')!.xpScale).toBe(5);
  });

  // ==========================================================================
  // Level-driven mode
  // ==========================================================================

  it('level-driven skill levels up with XP', () => {
    const category = createSkillCategory<LevelDef>({
      id: 'test10',
      mapSkill: (def) => ({
        xpToLevel: (xp) => Formula.variable(xp).div(def.xpScale).sqrt().floor(),
        levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
      }),
    });

    category.register({ id: 'combat', name: 'Combat', xpScale: 1 });

    const skill = category.getSkill('combat')!;

    // sqrt(100/1) = 10 → level 10
    skill.addXp(100);
    expect(new Decimal(skill.level.value).eq(10)).toBe(true);
  });

  // ==========================================================================
  // Accumulator mode
  // ==========================================================================

  it('accumulator skill accumulates permanent bonus', () => {
    const category = createSkillCategory<AccumDef>({
      id: 'test11',
      mapSkill: (def) => ({
        xpToLevel: (xp) => Formula.variable(xp).sqrt().floor(),
        retentionFormula: (level) => Formula.variable(level).mul(def.retentionRate),
      }),
    });

    category.register({ id: 'mastery', name: 'Mastery', retentionRate: 0.01 });

    const skill = category.getSkill('mastery')!;
    expect(isAccumulator(skill)).toBe(true);

    if (isAccumulator(skill)) {
      // Add 100 XP → level = floor(sqrt(100)) = 10
      skill.addXp(100);
      expect(new Decimal(skill.level.value).eq(10)).toBe(true);

      // Accumulate: 10 * 0.01 = 0.1
      skill.accumulateBonus();
      expect(new Decimal(skill.lifetimeBonus.value).eq(0.1)).toBe(true);
    }
  });

  // ==========================================================================
  // Mixed modes in one category
  // ==========================================================================

  it('supports mixed level-driven and accumulator in one category', () => {
    const category = createSkillCategory<MixedDef>({
      id: 'test12',
      mapSkill: (def) =>
        def.mode === 'accumulator'
          ? {
              xpToLevel: (xp) => Formula.variable(xp).sqrt().floor(),
              retentionFormula: (level) => Formula.variable(level).mul(0.01),
            }
          : {
              xpToLevel: (xp) => Formula.variable(xp).sqrt().floor(),
              levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
            },
    });

    category.register([
      { id: 'combat', name: 'Combat', mode: 'level' },
      { id: 'mastery', name: 'Mastery', mode: 'accumulator' },
    ]);

    const combat = category.getSkill('combat')!;
    const mastery = category.getSkill('mastery')!;

    expect(isAccumulator(combat)).toBe(false);
    expect(isAccumulator(mastery)).toBe(true);
  });

  // ==========================================================================
  // addXp helper
  // ==========================================================================

  it('addXp adds XP via the category helper', () => {
    const category = createSkillCategory<LevelDef>({
      id: 'test13',
      mapSkill: (def) => ({
        xpToLevel: (xp) => Formula.variable(xp).div(def.xpScale).sqrt().floor(),
        levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
      }),
    });

    category.register({ id: 'combat', name: 'Combat', xpScale: 1 });

    category.addXp('combat', 50);

    const skill = category.getSkill('combat')!;
    expect(new Decimal(skill.xp.value).eq(50)).toBe(true);
  });

  it('addXp is a no-op for unknown skill ID', () => {
    const category = createSkillCategory<LevelDef>({
      id: 'test14',
      mapSkill: (def) => ({
        xpToLevel: (xp) => Formula.variable(xp).div(def.xpScale).sqrt().floor(),
        levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
      }),
    });

    // Should not throw
    category.addXp('nonexistent', 100);
  });

  // ==========================================================================
  // getModifier helper
  // ==========================================================================

  it('getModifier returns the skill modifier', () => {
    const category = createSkillCategory<LevelDef>({
      id: 'test15',
      mapSkill: (def) => ({
        xpToLevel: (xp) => Formula.variable(xp).div(def.xpScale).sqrt().floor(),
        levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
      }),
    });

    category.register({ id: 'combat', name: 'Combat', xpScale: 1 });

    const modifier = category.getModifier('combat');
    expect(modifier).toBeDefined();

    // At level 0, multiplier = 1.05^0 = 1
    expect(new Decimal(modifier!.apply(100)).eq(100)).toBe(true);

    // Add XP to reach level 10, multiplier = 1.05^10
    category.addXp('combat', 100);
    const expected = Decimal.mul(100, Decimal.pow(1.05, 10));
    expect(new Decimal(modifier!.apply(100)).toNumber()).toBeCloseTo(expected.toNumber(), 5);
  });

  it('getModifier returns undefined for unknown skill', () => {
    const category = createSkillCategory<LevelDef>({
      id: 'test16',
      mapSkill: (def) => ({
        xpToLevel: (xp) => Formula.variable(xp).div(def.xpScale).sqrt().floor(),
        levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
      }),
    });

    expect(category.getModifier('nonexistent')).toBeUndefined();
  });
});
