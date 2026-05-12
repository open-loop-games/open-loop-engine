import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import {
  createSkill,
  SkillType,
  isSkill,
  isAccumulatorSkill,
  getSkillProgress,
  getSkillXPWindow,
} from '@/systems/skill';
import { createMultiplicativeModifier } from '@/core/modifier';
import Formula from '@/core/formulas/formulas';

/** Quadratic XP curve (Idle Loops style): level = floor(sqrt(xp/50)) */
const quadraticXpToLevel = (xp: Parameters<typeof Formula.variable>[0]) =>
  Formula.variable(xp).div(50).sqrt().floor();

/** Increlution-style retention: +1% per temp level */
const percentRetention = (level: Parameters<typeof Formula.variable>[0]) =>
  Formula.variable(level).mul(0.01);

/** Exponential multiplier: base^level */
const expMultiplier = (base: number) => (level: Parameters<typeof Formula.variable>[0]) =>
  Formula.variable(level).pow_base(base);

describe('createSkill — accumulator mode', () => {
  it('initializes with zero xp and no permanent bonus', () => {
    const skill = createSkill({
      id: 'combat',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
    });
    expect(Decimal.eq(skill.xp.value, 0)).toBe(true);
    expect(Decimal.eq(skill.level.value, 0)).toBe(true);
    expect(Decimal.eq(skill.permanentBonus.value, 0)).toBe(true);
    expect(skill.type).toBe(SkillType);
    expect(skill.id).toBe('combat');
  });

  it('addXp increases xp and level updates reactively', () => {
    const skill = createSkill({
      id: 'mining',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
    });

    skill.addXp(200); // sqrt(200/50) = sqrt(4) = 2
    expect(Decimal.eq(skill.xp.value, 200)).toBe(true);
    expect(Decimal.eq(skill.level.value, 2)).toBe(true);

    skill.addXp(600); // sqrt(800/50) = sqrt(16) = 4
    expect(Decimal.eq(skill.xp.value, 800)).toBe(true);
    expect(Decimal.eq(skill.level.value, 4)).toBe(true);
  });

  it('accumulateBonus adds retention to permanent bonus', () => {
    const skill = createSkill({
      id: 'magic',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
    });

    skill.addXp(5000); // sqrt(5000/50) = sqrt(100) = 10
    expect(Decimal.eq(skill.level.value, 10)).toBe(true);

    skill.accumulateBonus(); // 10 * 0.01 = 0.10
    expect(new Decimal(skill.permanentBonus.value).toNumber()).toBeCloseTo(0.1, 10);
  });

  it('permanent bonus accumulates across multiple calls', () => {
    const skill = createSkill({
      id: 'crafting',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
    });

    // First loop: reach level 10
    skill.addXp(5000);
    skill.accumulateBonus(); // +0.10
    expect(new Decimal(skill.permanentBonus.value).toNumber()).toBeCloseTo(0.1, 10);

    // Simulate reset (consumer zeros xp via loop reset)
    skill.xp.value = 0;

    // Second loop: reach level 5
    skill.addXp(1250); // sqrt(1250/50) = sqrt(25) = 5
    skill.accumulateBonus(); // +0.05
    expect(new Decimal(skill.permanentBonus.value).toNumber()).toBeCloseTo(0.15);
  });

  it('modifier applies permanentBonus as 1 + bonus multiplier', () => {
    const skill = createSkill({
      id: 'strength',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
    });

    // No bonus yet → modifier is ×1.0
    const base = skill.modifier.apply(100);
    expect(Decimal.eq(base, 100)).toBe(true);

    // permanentBonus = 0.5 → modifier is ×1.5
    skill.permanentBonus.value = 0.5;
    const boosted = skill.modifier.apply(100);
    expect(Decimal.eq(boosted, 150)).toBe(true);
  });

  it('supports custom retention formulas', () => {
    // Groundhog Life style: bonus = level / 10
    const skill = createSkill({
      id: 'life',
      xpToLevel: (xp) => Formula.variable(xp).div(100).floor(),
      retentionFormula: (level) => Formula.variable(level).div(10),
    });

    skill.addXp(5000); // level 50
    skill.accumulateBonus(); // 50/10 = 5.0
    expect(Decimal.eq(skill.permanentBonus.value, 5)).toBe(true);

    // Modifier: 1 + 5 = 6x
    const result = skill.modifier.apply(10);
    expect(Decimal.eq(result, 60)).toBe(true);
  });

  it('exposes retentionCurve for Formula-based queries', () => {
    const skill = createSkill({
      id: 'query-retention',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
    });
    // retention(10) = 10 * 0.01 = 0.1
    expect(new Decimal(skill.retentionCurve.evaluate(10)).toNumber()).toBeCloseTo(0.1);
  });
});

describe('createSkill — level-driven mode', () => {
  it('initializes with zero xp and level', () => {
    const skill = createSkill({
      id: 'gen-combat',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
    });
    expect(Decimal.eq(skill.xp.value, 0)).toBe(true);
    expect(Decimal.eq(skill.level.value, 0)).toBe(true);
    expect(skill.type).toBe(SkillType);
    expect(skill.id).toBe('gen-combat');
  });

  it('has no permanentBonus or accumulateBonus', () => {
    const skill = createSkill({
      id: 'gen-mining',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
    });
    expect(skill.permanentBonus).toBeUndefined();
    expect(skill.accumulateBonus).toBeUndefined();
  });

  it('modifier tracks level reactively via levelToMultiplier', () => {
    const skill = createSkill({
      id: 'gen-str',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
    });

    // Level 0 → 1.05^0 = 1.0
    expect(Decimal.eq(skill.modifier.apply(100), 100)).toBe(true);

    // Level 2 → 1.05^2 = 1.1025
    skill.addXp(200);
    expect(Decimal.eq(skill.level.value, 2)).toBe(true);
    const result = new Decimal(skill.modifier.apply(100)).toNumber();
    expect(result).toBeCloseTo(110.25);

    // Level 4 → 1.05^4 ≈ 1.2155
    skill.addXp(600);
    expect(Decimal.eq(skill.level.value, 4)).toBe(true);
    const result2 = new Decimal(skill.modifier.apply(100)).toNumber();
    expect(result2).toBeCloseTo(121.55, 1);
  });

  it('supports different base multipliers', () => {
    // Instinct tier: 1.01^level
    const skill = createSkill({
      id: 'inst-combat',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.01),
    });

    skill.addXp(5000); // level 10
    // 1.01^10 ≈ 1.10462
    const result = new Decimal(skill.modifier.apply(100)).toNumber();
    expect(result).toBeCloseTo(110.462, 1);
  });

  it('supports non-exponential multiplier formulas', () => {
    // PK2 style: 1 + level/10
    const skill = createSkill({
      id: 'pk2-str',
      xpToLevel: (xp) => Formula.variable(xp).div(100).floor(),
      levelToMultiplier: (level) => Formula.variable(level).div(10).add(1),
    });

    skill.addXp(5000); // level 50
    // 1 + 50/10 = 6.0
    const result = skill.modifier.apply(10);
    expect(Decimal.eq(result, 60)).toBe(true);
  });

  it('exposes multiplierCurve for Formula-based queries', () => {
    const skill = createSkill({
      id: 'query-mult',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
    });
    // multiplier at level 10: 1.05^10 ≈ 1.6289
    expect(new Decimal(skill.multiplierCurve.evaluate(10)).toNumber()).toBeCloseTo(1.6289, 3);
  });
});

describe('dual-tier composition', () => {
  it('two skills compose into a sequential modifier chain', () => {
    const gen = createSkill({
      id: 'combat-gen',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
    });

    const inst = createSkill({
      id: 'combat-inst',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.01),
    });

    gen.addXp(5000); // level 10 → 1.05^10 ≈ 1.6289
    inst.addXp(5000); // level 10 → 1.01^10 ≈ 1.1046

    const afterGen = gen.modifier.apply(100);
    const afterBoth = inst.modifier.apply(afterGen);

    // 100 * 1.6289 * 1.1046 ≈ 179.93
    const result = new Decimal(afterBoth).toNumber();
    expect(result).toBeCloseTo(179.93, 0);
  });
});

describe('projectGain', () => {
  it('projects permanent bonus gain from additional XP without mutating state', () => {
    const skill = createSkill({
      id: 'proj-basic',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
    });

    skill.addXp(200); // level 2
    const projected = skill.projectGain(4800); // would reach level 10 (total 5000 xp)
    // retentionFormula(10) - retentionFormula(2) = 0.10 - 0.02 = 0.08
    expect(new Decimal(projected).toNumber()).toBeCloseTo(0.08);

    // State unchanged
    expect(Decimal.eq(skill.xp.value, 200)).toBe(true);
    expect(Decimal.eq(skill.permanentBonus.value, 0)).toBe(true);
  });

  it('returns 0 when additional XP does not change level', () => {
    const skill = createSkill({
      id: 'proj-same-level',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
    });

    skill.addXp(200); // level 2
    // Adding 10 xp: sqrt(210/50) ≈ 2.05 → floor = 2, still level 2
    const projected = skill.projectGain(10);
    expect(Decimal.eq(projected, 0)).toBe(true);
  });

  it('projects from zero XP baseline', () => {
    const skill = createSkill({
      id: 'proj-zero',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
    });

    // From zero to level 4: sqrt(800/50) = 4
    const projected = skill.projectGain(800);
    // retentionFormula(4) - retentionFormula(0) = 0.04 - 0 = 0.04
    expect(new Decimal(projected).toNumber()).toBeCloseTo(0.04);
  });

  it('works with custom retention formulas', () => {
    // Groundhog Life style: bonus = level / 10
    const skill = createSkill({
      id: 'proj-custom',
      xpToLevel: (xp) => Formula.variable(xp).div(100).floor(),
      retentionFormula: (level) => Formula.variable(level).div(10),
    });

    skill.addXp(1000); // level 10
    // Adding 4000 xp → level 50
    // retentionFormula(50) - retentionFormula(10) = 5.0 - 1.0 = 4.0
    const projected = skill.projectGain(4000);
    expect(new Decimal(projected).toNumber()).toBeCloseTo(4.0);
  });

  it('never returns negative values', () => {
    // Pathological: retention formula that decreases at high levels
    const skill = createSkill({
      id: 'proj-negative',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: (level) => Formula.variable(level).neg().add(10),
    });

    skill.addXp(200); // level 2, retention = 8
    // Adding enough to reach level 20: retention = -10
    // Delta would be -10 - 8 = -18, but clamped to 0
    const projected = skill.projectGain(19800);
    expect(Decimal.gte(projected, 0)).toBe(true);
  });
});

describe('Formula inversion via xpCurve', () => {
  it('can answer "XP needed for level N" for invertible curves', () => {
    // Pure power curve without floor: level = sqrt(xp/50) → xp = 50 * level^2
    const skill = createSkill({
      id: 'invertible',
      xpToLevel: (xp) => Formula.variable(xp).div(50).sqrt(),
      levelToMultiplier: expMultiplier(1.05),
    });
    // XP to reach level 10 → 50 * 100 = 5000
    expect(new Decimal(skill.xpCurve.invert(10)).toNumber()).toBeCloseTo(5000, 5);
  });

  it('can answer "level required for target multiplier"', () => {
    const skill = createSkill({
      id: 'mult-invert',
      xpToLevel: (xp) => Formula.variable(xp).div(50).sqrt(),
      levelToMultiplier: expMultiplier(1.05),
    });
    // 1.05^level = 2 → level = log(2) / log(1.05) ≈ 14.21
    const levelForDouble = new Decimal(skill.multiplierCurve.invert(2)).toNumber();
    expect(levelForDouble).toBeCloseTo(14.21, 1);
  });
});

describe('type guards', () => {
  it('isSkill identifies both modes', () => {
    const levelDriven = createSkill({
      id: 'ld',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
    });
    const accumulator = createSkill({
      id: 'acc',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
    });
    expect(isSkill(levelDriven)).toBe(true);
    expect(isSkill(accumulator)).toBe(true);
    expect(isSkill({})).toBe(false);
    expect(isSkill(null)).toBe(false);
  });

  it('isAccumulatorSkill distinguishes modes', () => {
    const levelDriven = createSkill({
      id: 'ld2',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
    });
    const accumulator = createSkill({
      id: 'acc2',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
    });
    expect(isAccumulatorSkill(levelDriven)).toBe(false);
    expect(isAccumulatorSkill(accumulator)).toBe(true);
  });

  it('xp is a persistent ref in both modes', () => {
    const ld = createSkill({
      id: 'ld3',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
    });
    const acc = createSkill({
      id: 'acc3',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
    });
    ld.addXp(999);
    acc.addXp(999);
    expect('value' in ld.xp).toBe(true);
    expect('value' in acc.xp).toBe(true);
  });
});

describe('reactive xpCurve binding', () => {
  it('xpCurve stays bound to xp across updates', () => {
    const skill = createSkill({
      id: 'reactive-bind',
      xpToLevel: (xp) => Formula.variable(xp).div(50).sqrt(),
      levelToMultiplier: expMultiplier(1.05),
    });
    skill.addXp(200);
    // xpCurve.evaluate() with no override should use current xp
    expect(new Decimal(skill.xpCurve.evaluate()).toNumber()).toBeCloseTo(2, 5);
    skill.addXp(600);
    expect(new Decimal(skill.xpCurve.evaluate()).toNumber()).toBeCloseTo(4, 5);
  });

  it('ref variables are supported directly (not just persistent refs)', () => {
    const external = ref<DecimalSource>(0);
    const skill = createSkill({
      id: 'ref-only',
      xpToLevel: (xp) => Formula.variable(xp).div(50).sqrt().floor(),
      // The skill still owns its own xp; this just confirms MaybeRef is threaded through
      levelToMultiplier: (level) => Formula.variable(level).add(external.value),
    });
    skill.addXp(200); // level 2
    const before = new Decimal(skill.modifier.apply(1)).toNumber();
    expect(before).toBeCloseTo(2);
  });
});

// ============================================================================
// New feature tests
// ============================================================================

describe('gainChain', () => {
  it('exposes a ModifierChain on every skill', () => {
    const skill = createSkill({
      id: 'chain-exists',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
    });
    expect(skill.gainChain).toBeDefined();
    expect(skill.gainChain.id).toBe('skill:chain-exists:gain');
  });

  it('is identity when empty — addXp passes raw amount through', () => {
    const skill = createSkill({
      id: 'chain-identity',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
    });
    skill.addXp(200);
    expect(Decimal.eq(skill.xp.value, 200)).toBe(true);
  });

  it('transforms XP gain when modifiers are bound', () => {
    const skill = createSkill({
      id: 'chain-boost',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
    });

    // 2x XP boost
    const remove = skill.gainChain.add(createMultiplicativeModifier({ multiplier: 2 }));

    skill.addXp(100); // 100 * 2 = 200 effective
    expect(Decimal.eq(skill.xp.value, 200)).toBe(true);

    // Remove the boost
    remove();
    skill.addXp(100); // 100 raw
    expect(Decimal.eq(skill.xp.value, 300)).toBe(true);
  });

  it('works in accumulator mode too', () => {
    const skill = createSkill({
      id: 'chain-acc',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
    });

    skill.gainChain.add(createMultiplicativeModifier({ multiplier: 3 }));
    skill.addXp(100); // 100 * 3 = 300
    expect(Decimal.eq(skill.xp.value, 300)).toBe(true);
  });
});

describe('maxXp', () => {
  it('clamps XP to static cap', () => {
    const skill = createSkill({
      id: 'cap-static',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
      maxXp: 500,
    });

    skill.addXp(1000);
    expect(Decimal.eq(skill.xp.value, 500)).toBe(true);
  });

  it('allows accumulation below cap', () => {
    const skill = createSkill({
      id: 'cap-below',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
      maxXp: 500,
    });

    skill.addXp(200);
    expect(Decimal.eq(skill.xp.value, 200)).toBe(true);
    skill.addXp(200);
    expect(Decimal.eq(skill.xp.value, 400)).toBe(true);
    skill.addXp(200); // would be 600, clamped to 500
    expect(Decimal.eq(skill.xp.value, 500)).toBe(true);
  });

  it('supports reactive cap (ref)', () => {
    const cap = ref<DecimalSource>(300);
    const skill = createSkill({
      id: 'cap-reactive',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
      maxXp: cap,
    });

    skill.addXp(500);
    expect(Decimal.eq(skill.xp.value, 300)).toBe(true);

    // Raise the cap — existing XP stays, new gains allowed up to new cap
    cap.value = 1000;
    skill.addXp(500);
    expect(Decimal.eq(skill.xp.value, 800)).toBe(true);
  });

  it('supports reactive cap (getter over ref)', () => {
    const capRef = ref<DecimalSource>(200);
    const skill = createSkill({
      id: 'cap-getter',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
      maxXp: () => capRef.value,
    });

    skill.addXp(500);
    expect(Decimal.eq(skill.xp.value, 200)).toBe(true);

    capRef.value = 1000;
    skill.addXp(500);
    expect(Decimal.eq(skill.xp.value, 700)).toBe(true);
  });

  it('cap is applied after gainChain', () => {
    const skill = createSkill({
      id: 'cap-after-chain',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
      maxXp: 500,
    });

    // 2x boost: raw 300 → effective 600, clamped to 500
    skill.gainChain.add(createMultiplicativeModifier({ multiplier: 2 }));
    skill.addXp(300);
    expect(Decimal.eq(skill.xp.value, 500)).toBe(true);
  });

  it('no cap when maxXp is omitted', () => {
    const skill = createSkill({
      id: 'no-cap',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
    });

    skill.addXp(1_000_000);
    expect(Decimal.eq(skill.xp.value, 1_000_000)).toBe(true);
  });
});

describe('onLevelUp', () => {
  it('fires when level changes during addXp', () => {
    const callback = vi.fn();
    const skill = createSkill({
      id: 'levelup-basic',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
      onLevelUp: callback,
    });

    // Level 0 → 2 (sqrt(200/50) = 2)
    skill.addXp(200);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(Decimal.eq(callback.mock.calls[0][0], 0)).toBe(true); // oldLevel
    expect(Decimal.eq(callback.mock.calls[0][1], 2)).toBe(true); // newLevel
  });

  it('does not fire when XP gain does not change level', () => {
    const callback = vi.fn();
    const skill = createSkill({
      id: 'levelup-noop',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
      onLevelUp: callback,
    });

    skill.addXp(200); // level 0→2
    callback.mockClear();

    // Adding 10 xp: sqrt(210/50) ≈ 2.05 → floor = 2, still level 2
    skill.addXp(10);
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not fire on direct xp.value mutation (save-load simulation)', () => {
    const callback = vi.fn();
    const skill = createSkill({
      id: 'levelup-direct',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
      onLevelUp: callback,
    });

    // Direct mutation simulating save-load rehydration
    skill.xp.value = 5000; // level would jump 0→10
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not fire on xp reset (consumer zeros xp)', () => {
    const callback = vi.fn();
    const skill = createSkill({
      id: 'levelup-reset',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
      onLevelUp: callback,
    });

    skill.addXp(5000); // level 0→10
    callback.mockClear();

    // Simulate reset
    skill.xp.value = 0; // level 10→0
    expect(callback).not.toHaveBeenCalled();
  });

  it('fires multiple times across separate addXp calls', () => {
    const callback = vi.fn();
    const skill = createSkill({
      id: 'levelup-multi',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
      onLevelUp: callback,
    });

    skill.addXp(200); // level 0→2
    skill.addXp(600); // level 2→4

    expect(callback).toHaveBeenCalledTimes(2);
    expect(Decimal.eq(callback.mock.calls[1][0], 2)).toBe(true); // oldLevel
    expect(Decimal.eq(callback.mock.calls[1][1], 4)).toBe(true); // newLevel
  });

  it('works in accumulator mode', () => {
    const callback = vi.fn();
    const skill = createSkill({
      id: 'levelup-acc',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
      onLevelUp: callback,
    });

    skill.addXp(200); // level 0→2
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe('display utilities', () => {
  // Display utilities use xpCurve.invert() which inverts through .floor() via
  // passthrough. Use the standard floored quadratic curve — the realistic case.
  // level = floor(sqrt(xp/50)):
  //   level 2 at xp = 200, level 3 at xp = 450, level 4 at xp = 800

  it('getSkillProgress returns 0 at start of level', () => {
    const skill = createSkill({
      id: 'progress-start',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
    });

    // XP for level 2 = 50 * 4 = 200. Set xp exactly there.
    skill.addXp(200);
    expect(getSkillProgress(skill)).toBeCloseTo(0, 5);
  });

  it('getSkillProgress returns fraction between 0 and 1', () => {
    const skill = createSkill({
      id: 'progress-mid',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
    });

    // Level 2 at xp=200, level 3 at xp=450. Midpoint = 325
    skill.addXp(325);
    const progress = getSkillProgress(skill);
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThan(1);
    // (325 - 200) / (450 - 200) = 125 / 250 = 0.5
    expect(progress).toBeCloseTo(0.5);
  });

  it('getSkillXPWindow returns correct window', () => {
    const skill = createSkill({
      id: 'window-basic',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
    });

    // Level 2 at xp=200, level 3 at xp=450.
    skill.addXp(300); // 100 xp into level 2
    const window = getSkillXPWindow(skill);
    expect(new Decimal(window.current).toNumber()).toBeCloseTo(100); // 300 - 200
    expect(new Decimal(window.needed).toNumber()).toBeCloseTo(250); // 450 - 200
  });

  it('getSkillXPWindow works in accumulator mode', () => {
    const skill = createSkill({
      id: 'window-acc',
      xpToLevel: quadraticXpToLevel,
      retentionFormula: percentRetention,
    });

    skill.addXp(300);
    const window = getSkillXPWindow(skill);
    expect(new Decimal(window.current).toNumber()).toBeGreaterThan(0);
    expect(new Decimal(window.needed).toNumber()).toBeGreaterThan(0);
  });

  it('getSkillProgress returns 0 at zero xp', () => {
    const skill = createSkill({
      id: 'progress-zero',
      xpToLevel: quadraticXpToLevel,
      levelToMultiplier: expMultiplier(1.05),
    });

    expect(getSkillProgress(skill)).toBeCloseTo(0);
  });
});
