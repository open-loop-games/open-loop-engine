import { describe, it, expect, vi } from 'vitest';
import { effectScope } from 'vue';
import { bn } from '@/primitives/decimal';
import { Decimal } from '@/primitives/decimal';
import { createResource, addResource } from '@/core/resource';
import {
  persistent,
  beginPersistentContext,
  endPersistentContext,
  withPersistentContext,
  withPersistenceNamespace,
  getAllPersistentRefs,
  serializePersistents,
  Lifetime,
} from '@/core/persistence';
import { createRunPool } from '@/core/run-pool';
import { createCycle } from '@/systems/cycle';
import { createCycleLog } from '@/systems/cycle-log';
import { createTimeSystem } from '@/systems/time';
import { createTimeBank } from '@/systems/time-bank';
import { createBestOf } from '@/systems/best-of';
import { createAutomationTiers } from '@/systems/automation';
import { createDialogSession } from '@/systems/dialog-session';
import { createAchievementCategory } from '@/systems/achievement-category';
import { createChallengeCategory } from '@/systems/challenge-category';
import { createReset, createResetTimer } from '@/systems/reset';
import { createAchievement } from '@/systems/achievement';
import { createSkill } from '@/systems/skill';
import { createSkillCategory } from '@/systems/skill-category';
import { createPurchasableCategory } from '@/systems/purchasable-category';
import { createProducerCategory } from '@/systems/producer-category';
import { createCostRequirement } from '@/core/requirements';
import Formula from '@/core/formulas/formulas';
import { fractional } from '@/systems/retention';
import {
  AUTOMATION_TIER_DEFS,
  buildRecommendationStack,
  dialogAccessorStub,
  noopRegisterTick as registerTick,
} from './fixtures/stateful-systems';

describe('Reset', () => {
  it('resets persistent refs to defaults', () => {
    beginPersistentContext('reset-test');
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    const level = persistent(1);
    endPersistentContext();
    addResource(gold, 500);
    level.value = 10;
    const reset = createReset({
      thingsToReset: [gold, level],
    });
    reset.reset();
    expect(gold.value.eq(0)).toBe(true);
    expect(level.value).toBe(1);
  });

  it('writes inside onReset and afterReset skip cumulative/best; a grant after reset() counts', () => {
    beginPersistentContext('reset-hook-grant');
    const pp = createResource(bn(0), { id: 'Prestige', displayName: 'Prestige' });
    endPersistentContext();
    addResource(pp, 1);

    const reset = createReset({
      thingsToReset: [],
      onReset: () => addResource(pp, 5),
    });
    reset.on('afterReset', () => addResource(pp, 10));
    reset.reset();

    expect(Decimal.eq(pp.value, 16)).toBe(true);
    expect(Decimal.eq(pp.cumulative!.value, 1)).toBe(true);
    expect(Decimal.eq(pp.best!.value, 1)).toBe(true);

    addResource(pp, 5);
    expect(Decimal.eq(pp.cumulative!.value, 6)).toBe(true);
    expect(Decimal.eq(pp.best!.value, 21)).toBe(true);
  });

  it("a reset run from another reset's onReset leaves the outer's hooks guarded", () => {
    beginPersistentContext('reset-nested-guard');
    const pp = createResource(bn(0), { id: 'NestedPrestige', displayName: 'Prestige' });
    endPersistentContext();
    addResource(pp, 1);

    const inner = createReset({ thingsToReset: [] });
    const outer = createReset({
      thingsToReset: [],
      onReset: () => {
        inner.reset();
        addResource(pp, 5);
      },
    });
    outer.on('afterReset', () => addResource(pp, 10));
    outer.reset();

    expect(Decimal.eq(pp.value, 16)).toBe(true);
    expect(Decimal.eq(pp.cumulative!.value, 1)).toBe(true);
    expect(Decimal.eq(pp.best!.value, 1)).toBe(true);
  });

  it('a nested reset settles once, as the outermost reset ends', () => {
    const scope = effectScope();
    const flag = withPersistentContext('reset-nested-settle', () =>
      persistent(false, { id: 'flag', lifetime: true }),
    );
    const achievement = scope.run(() =>
      createAchievement({
        id: 'nested-settle',
        display: { title: 'Flag' },
        goal: () => flag.value,
      }),
    )!;

    const inner = createReset({ thingsToReset: [] });
    const outer = createReset({
      thingsToReset: [],
      onReset: () => {
        flag.value = true;
        inner.reset();
        flag.value = false;
      },
    });
    outer.reset();
    scope.stop();

    // The requirement held only mid-reset; the settled state decides.
    expect(achievement.earned.value).toBe(false);
  });

  it('calls onReset callback after reset', () => {
    let called = false;
    beginPersistentContext('reset-test-callback');
    const pts = createResource(bn(100), { id: 'Points', displayName: 'Points' });
    endPersistentContext();
    const reset = createReset({
      thingsToReset: [pts],
      onReset: () => {
        called = true;
      },
    });
    reset.reset();
    expect(called).toBe(true);
  });

  it('cancels reset when onBeforeReset returns false', () => {
    beginPersistentContext('reset-test-cancel');
    const pts = createResource(bn(0), { id: 'Points', displayName: 'Points' });
    endPersistentContext();
    addResource(pts, 999);
    const reset = createReset({
      thingsToReset: [pts],
      onBeforeReset: () => false,
    });
    const result = reset.reset();
    expect(result).toBe(false);
    expect(pts.value.eq(999)).toBe(true);
  });

  it('createResetTimer zeros on reset', () => {
    beginPersistentContext('reset-test-track');
    const pts = createResource(bn(0), { id: 'TrackPoints', displayName: 'TrackPoints' });
    endPersistentContext();
    addResource(pts, 100);

    const reset = createReset({
      thingsToReset: [pts],
    });

    const elapsed = createResetTimer(reset);
    elapsed.value = 42;

    reset.reset();
    expect(elapsed.value).toBe(0);
  });

  it('emits per-instance events via on()', () => {
    beginPersistentContext('reset-test-events');
    const pts = createResource(bn(0), { id: 'EventPoints', displayName: 'EventPoints' });
    endPersistentContext();

    const reset = createReset({
      thingsToReset: [pts],
    });

    const events: string[] = [];
    reset.on('beforeReset', () => events.push('before'));
    reset.on('afterReset', () => events.push('after'));

    reset.reset();
    expect(events).toEqual(['before', 'after']);
  });

  it('unsubscribes per-instance events', () => {
    beginPersistentContext('reset-test-unsub');
    const pts = createResource(bn(0), { id: 'UnsubPoints', displayName: 'UnsubPoints' });
    endPersistentContext();

    const reset = createReset({
      thingsToReset: [pts],
    });

    const cb = vi.fn();
    const unsub = reset.on('afterReset', cb);

    reset.reset();
    expect(cb).toHaveBeenCalledOnce();

    unsub();
    reset.reset();
    expect(cb).toHaveBeenCalledOnce();
  });

  it('resets persistent refs inside Maps', () => {
    beginPersistentContext('reset-test-map');
    const stateMap = new Map<string, { score: ReturnType<typeof persistent<number>> }>();
    stateMap.set('a', { score: persistent(0) });
    stateMap.set('b', { score: persistent(0) });
    endPersistentContext();

    stateMap.get('a')!.score.value = 42;
    stateMap.get('b')!.score.value = 99;

    const reset = createReset({
      thingsToReset: [stateMap],
    });

    reset.reset();
    expect(stateMap.get('a')!.score.value).toBe(0);
    expect(stateMap.get('b')!.score.value).toBe(0);
  });
});

describe('Reset with resetPersistentContexts', () => {
  it('resets all refs in a module including nested contexts', () => {
    beginPersistentContext('rm-mod');
    const gold = persistent(0);

    beginPersistentContext('rm-mod/skills');
    const skillXp = persistent(0);
    endPersistentContext();

    beginPersistentContext('rm-mod/skills/warrior');
    const warriorLevel = persistent(1);
    endPersistentContext();

    endPersistentContext();

    gold.value = 500;
    skillXp.value = 1000;
    warriorLevel.value = 10;

    const reset = createReset({
      resetPersistentContexts: ['rm-mod'],
    });

    reset.reset();
    expect(gold.value).toBe(0);
    expect(skillXp.value).toBe(0);
    expect(warriorLevel.value).toBe(1);
  });

  it('skips accumulator lifetimeBonus (lifetime) while wiping xp', () => {
    beginPersistentContext('rm-permbonus');
    const mastery = createSkill({
      id: 'mastery',
      xpToLevel: (xp) => Formula.variable(xp).div(50).sqrt().floor(),
      retentionFormula: (level) => Formula.variable(level).mul(0.01),
    });
    endPersistentContext();

    mastery.xp.value = new Decimal(5000);
    mastery.accumulateBonus();
    const bonusBefore = new Decimal(mastery.lifetimeBonus.value);
    expect(bonusBefore.gt(0)).toBe(true);

    const reset = createReset({ resetPersistentContexts: ['rm-permbonus'] });
    reset.reset();

    expect(new Decimal(mastery.xp.value).eq(0)).toBe(true);
    expect(new Decimal(mastery.lifetimeBonus.value).eq(bonusBefore)).toBe(true);
  });

  it('clones non-primitive defaults so in-place mutation does not corrupt them', () => {
    beginPersistentContext('rm-clone-default');
    const inventory = persistent<string[]>([]);
    endPersistentContext();

    const reset = createReset({ resetPersistentContexts: ['rm-clone-default'] });

    inventory.value.push('sword');
    reset.reset();
    expect(inventory.value).toEqual([]);

    inventory.value.push('shield');
    reset.reset();
    expect(inventory.value).toEqual([]);
  });

  it('keep exempts specific refs from reset', () => {
    beginPersistentContext('rm-keep');
    const temp = persistent(0);
    const permanent = persistent(0);
    endPersistentContext();

    temp.value = 100;
    permanent.value = 42;

    const reset = createReset({
      resetPersistentContexts: ['rm-keep'],
      keep: [permanent],
    });

    reset.reset();
    expect(temp.value).toBe(0);
    expect(permanent.value).toBe(42);
  });

  it('retain applies transform to refs', () => {
    beginPersistentContext('rm-retain');
    const skill = createResource(bn(0), { id: 'Skill', displayName: 'Skill' });
    const temp = persistent(0);
    endPersistentContext();

    addResource(skill, 100);
    temp.value = 500;

    const reset = createReset({
      resetPersistentContexts: ['rm-retain'],
      retain: new Map([[skill, fractional(0.1)]]),
    });

    reset.reset();
    expect(Decimal.eq(skill.value, 10)).toBe(true);
    expect(temp.value).toBe(0);
  });

  it('composable: passing another Reset unions scopes', () => {
    beginPersistentContext('rm-inner');
    const innerRef = persistent(0);
    endPersistentContext();

    beginPersistentContext('rm-outer');
    const outerRef = persistent(0);
    endPersistentContext();

    innerRef.value = 10;
    outerRef.value = 20;

    const innerReset = createReset({
      resetPersistentContexts: ['rm-inner'],
    });

    const outerReset = createReset({
      resetPersistentContexts: [innerReset, 'rm-outer'],
    });

    outerReset.reset();
    expect(innerRef.value).toBe(0);
    expect(outerRef.value).toBe(0);
  });

  it('composable: outer reset uses its own retention, not inner', () => {
    beginPersistentContext('rm-compose-inner');
    const innerRef = persistent(0);
    endPersistentContext();

    beginPersistentContext('rm-compose-outer');
    const outerRef = persistent(0);
    endPersistentContext();

    innerRef.value = 100;
    outerRef.value = 200;

    const innerReset = createReset({
      resetPersistentContexts: ['rm-compose-inner'],
      keep: [innerRef], // inner would keep this...
    });

    const outerReset = createReset({
      resetPersistentContexts: [innerReset, 'rm-compose-outer'],
      // ...but outer doesn't keep innerRef
    });

    outerReset.reset();
    expect(innerRef.value).toBe(0); // NOT kept — outer's retention wins
    expect(outerRef.value).toBe(0);
  });

  it('thingsToReset and resetPersistentContexts coexist', () => {
    beginPersistentContext('rm-coexist-mod');
    const modRef = persistent(0);
    endPersistentContext();

    beginPersistentContext('rm-coexist-manual');
    const manualRef = persistent(0);
    endPersistentContext();

    modRef.value = 10;
    manualRef.value = 20;

    const reset = createReset({
      resetPersistentContexts: ['rm-coexist-mod'],
      thingsToReset: [manualRef],
    });

    reset.reset();
    expect(modRef.value).toBe(0);
    expect(manualRef.value).toBe(0);
  });

  it('resolvedScope is exposed for composability', () => {
    beginPersistentContext('rm-scope');
    const r = persistent(0);
    endPersistentContext();

    const reset = createReset({
      resetPersistentContexts: ['rm-scope'],
    });

    expect(reset.resolvedScope.size).toBe(1);
    expect(reset.resolvedScope.has(r)).toBe(true);
  });

  it('resolves resetPersistentContexts at reset time, so refs created after createReset are in scope', () => {
    beginPersistentContext('rm-lazy');
    const early = persistent(0);
    endPersistentContext();
    const reset = createReset({ resetPersistentContexts: ['rm-lazy'] });
    const cycle = createCycle({
      resetPersistentContexts: ['rm-lazy'],
      registerTick: () => () => {},
    });
    beginPersistentContext('rm-lazy');
    const late = persistent(0);
    endPersistentContext();

    expect(reset.resolvedScope.has(late)).toBe(true);
    expect(cycle.resolvedScope.has(late)).toBe(true);

    early.value = 5;
    late.value = 7;
    reset.reset();
    expect(early.value).toBe(0);
    expect(late.value).toBe(0);
  });

  it('warns once when a resetPersistentContexts id names no registered persistent context', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const reset = createReset({ resetPersistentContexts: ['rm-no-such-module'] });
      reset.reset();
      reset.reset();
      const calls = warn.mock.calls.filter((c) => String(c[0]).includes('rm-no-such-module'));
      expect(calls).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('names the persistence namespace an unknown id is registered under', () => {
    withPersistenceNamespace('rm-ns1', () =>
      withPersistentContext('rm-elsewhere', () => persistent(0)),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createReset({ resetPersistentContexts: ['rm-elsewhere'] }).reset();
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        'createReset: resetPersistentContexts names "rm-elsewhere", which has no registered persistent ' +
          'context — nothing under that id is reset. It is registered under persistence namespace ' +
          '"rm-ns1". Create the reset inside a module\'s install() or connect(), so it resolves ids ' +
          "in that engine's persistence namespace.",
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("names the reset's persistence namespace when an unknown id is registered nowhere", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      withPersistenceNamespace('rm-ns2', () =>
        createReset({ resetPersistentContexts: ['rm-nowhere'] }),
      ).reset();
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        'createReset: resetPersistentContexts names "rm-nowhere", which has no registered persistent context ' +
          'in persistence namespace "rm-ns2" — nothing under that id is reset. Check the id.',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('warns about an unknown id inside a composed reset or cycle, but not on a scope read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const warningsFor = (id: string) =>
      warn.mock.calls.filter((c) => String(c[0]).includes(id)).length;
    try {
      const inner = createReset({ resetPersistentContexts: ['rm-composed-missing'] });
      const cycle = createCycle({
        resetPersistentContexts: ['rm-cycle-missing'],
        registerTick: () => () => {},
      });
      const outer = createReset({ resetPersistentContexts: [inner, cycle] });

      void outer.resolvedScope;
      expect(warningsFor('rm-composed-missing')).toBe(0);
      expect(warningsFor('rm-cycle-missing')).toBe(0);

      outer.reset();
      expect(warningsFor('rm-composed-missing')).toBe(1);
      expect(warningsFor('rm-cycle-missing')).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps resolving a module id inside the namespace it was created under', () => {
    beginPersistentContext('rm-ns-shop');
    const live = persistent(0);
    endPersistentContext();
    live.value = 42;

    const forkReset = withPersistenceNamespace('fork-1', () => {
      beginPersistentContext('rm-ns-shop');
      const forked = persistent(0);
      endPersistentContext();
      forked.value = 9;
      return { reset: createReset({ resetPersistentContexts: ['rm-ns-shop'] }), forked };
    });

    forkReset.reset.reset();
    expect(forkReset.forked.value).toBe(0);
    expect(live.value).toBe(42);
  });

  it('backward compat: thingsToReset-only still works', () => {
    beginPersistentContext('rm-compat');
    const pts = createResource(bn(0), { id: 'Points', displayName: 'Points' });
    endPersistentContext();
    addResource(pts, 500);

    const reset = createReset({
      thingsToReset: [pts],
    });

    reset.reset();
    expect(pts.value.eq(0)).toBe(true);
  });
});

describe('Reset — Resettable protocol on category wrappers', () => {
  it('resets skills inside a createSkillCategory wrapper passed to thingsToReset', () => {
    interface SkillDef {
      id: string;
      xpScale: number;
    }
    const skills = createSkillCategory<SkillDef>({
      id: 'reset-cat-reset',
      mapSkill: (def) => ({
        xpToLevel: (xp) => Formula.variable(xp).div(def.xpScale).sqrt().floor(),
        levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
      }),
    });
    skills.register([
      { id: 'reset-cat-combat', xpScale: 10 },
      { id: 'reset-cat-mining', xpScale: 10 },
    ]);

    skills.addXp('reset-cat-combat', 250);
    skills.addXp('reset-cat-mining', 40);
    expect(Decimal.eq(skills.getSkill('reset-cat-combat')!.xp.value, 250)).toBe(true);
    expect(Decimal.eq(skills.getSkill('reset-cat-mining')!.xp.value, 40)).toBe(true);

    const reset = createReset({ thingsToReset: [skills] });
    reset.reset();

    expect(Decimal.eq(skills.getSkill('reset-cat-combat')!.xp.value, 0)).toBe(true);
    expect(Decimal.eq(skills.getSkill('reset-cat-mining')!.xp.value, 0)).toBe(true);
  });

  it('a category walk leaves nested lifetime refs alone, as a module reset does', () => {
    const skills = createSkillCategory<{ id: string }>({
      id: 'reset-cat-lifetime',
      mapSkill: () => ({
        xpToLevel: (xp) => Formula.variable(xp).div(50).sqrt().floor(),
        retentionFormula: (level) => Formula.variable(level).mul(0.01),
      }),
    });
    skills.register({ id: 'reset-cat-lifetime-mastery' });
    const mastery = skills.getSkill('reset-cat-lifetime-mastery')!;
    mastery.xp.value = new Decimal(5000);
    mastery.accumulateBonus!();
    const bonus = new Decimal(mastery.lifetimeBonus!.value);
    expect(bonus.gt(0)).toBe(true);

    createReset({ thingsToReset: [skills] }).reset();

    expect(Decimal.eq(mastery.xp.value, 0)).toBe(true);
    expect(Decimal.eq(mastery.lifetimeBonus!.value, bonus)).toBe(true);
  });

  it('a lifetime ref named directly in thingsToReset is still reset', () => {
    beginPersistentContext('reset-lifetime-direct');
    const best = persistent(0, { lifetime: true });
    endPersistentContext();
    best.value = 9;

    createReset({ thingsToReset: [best] }).reset();

    expect(best.value).toBe(0);
  });

  it('a purchasable category resets its purchases and no ref its options name', () => {
    const gold = createResource(1000, { id: 'reset-cat-gold' });
    const [maxLevel, shown] = withPersistentContext('reset-cat-elsewhere', () => [
      persistent(1, { id: 'maxLevel' }),
      persistent(false, { id: 'shown' }),
    ]);
    const upgrades = createPurchasableCategory<{ id: string }>({
      id: 'reset-cat-upgrades',
      mapPurchasable: () => ({
        display: { description: '' },
        requirements: createCostRequirement({ resource: gold, cost: 10 }),
        limit: maxLevel,
        visible: shown,
      }),
    });
    upgrades.register({ id: 'sharpen' });
    maxLevel.value = 3;
    shown.value = true;
    upgrades.getPurchasable('sharpen')!.purchase(1);

    createReset({ thingsToReset: [upgrades] }).reset();

    expect(Decimal.eq(upgrades.getPurchasable('sharpen')!.count.value, 0)).toBe(true);
    expect(Decimal.eq(gold.value, 990)).toBe(true);
    expect(maxLevel.value).toBe(3);
    expect(shown.value).toBe(true);
  });

  it('a producer category resets its counts and leaves both of its resources alone', () => {
    const cookies = createResource(1000, { id: 'reset-cat-cookies' });
    const flour = createResource(5, { id: 'reset-cat-flour' });
    const bakeries = createProducerCategory<{ id: string }>({
      id: 'reset-cat-bakeries',
      mapProducer: () => ({
        resource: flour,
        baseRate: 1,
        trigger: 'continuous',
        purchase: { costResource: cookies, baseCost: 10, costRatio: 1 },
      }),
      registerTick: () => () => {},
    });
    bakeries.register({ id: 'mill' });
    bakeries.getProducer('mill')!.repeatable!.purchase(2);
    flour.value = 7;

    createReset({ thingsToReset: [bakeries] }).reset();

    expect(Decimal.eq(bakeries.getProducer('mill')!.ownedCount.value, 0)).toBe(true);
    expect(Decimal.eq(cookies.value, 980)).toBe(true);
    expect(Decimal.eq(flour.value, 7)).toBe(true);
  });
});

describe('Reset — listener re-entrancy', () => {
  /** Run `fn` on the first emit only — re-entrancy, not recursion. */
  function once(subscribe: (fn: () => void) => void, fn: () => void) {
    let fired = false;
    subscribe(() => {
      if (fired) return;
      fired = true;
      fn();
    });
  }

  it('refuses a reset re-entered from a beforeReset listener', () => {
    beginPersistentContext('reset-reentry');
    const skill = persistent<Decimal>(bn(0));
    endPersistentContext();
    let grants = 0;
    let afterResets = 0;
    const reset = createReset({
      thingsToReset: [{ skill }],
      retain: new Map([[skill, fractional(0.1)]]),
      onReset: () => {
        grants++;
      },
    });
    reset.on('afterReset', () => afterResets++);

    let nested: boolean | undefined;
    once(
      (fn) => reset.on('beforeReset', fn),
      () => {
        nested = reset.reset();
      },
    );

    skill.value = bn(100);
    expect(reset.reset()).toBe(true);

    // The retain transform runs once per reset. A second, nested application
    // would leave 1% rather than 10%.
    expect(nested).toBe(false);
    expect(skill.value.eq(10)).toBe(true);
    expect(grants).toBe(1);
    expect(afterResets).toBe(1);
  });

  it('still allows sequential resets after a refused re-entry', () => {
    beginPersistentContext('reset-reentry-sequential');
    const gold = persistent<Decimal>(bn(0));
    endPersistentContext();
    const reset = createReset({ thingsToReset: [{ gold }] });
    once(
      (fn) => reset.on('beforeReset', fn),
      () => reset.reset(),
    );

    gold.value = bn(50);
    expect(reset.reset()).toBe(true);
    gold.value = bn(50);
    expect(reset.reset()).toBe(true);
    expect(gold.value.eq(0)).toBe(true);
  });
});

describe('Reset — system-owned cross-run state survives a reset of its own module', () => {
  /** Every stateful system a module can build, all inside module `m`. */
  function buildSystems() {
    return withPersistentContext('m', () => {
      const cycle = createCycle({ resetPersistentContexts: ['m'], registerTick });
      const time = createTimeSystem();
      const bank = createTimeBank();
      const bestOf = createBestOf({ id: 'm-best', metrics: { gold: { mode: 'absolute' } } });
      const pool = createRunPool({ id: 'm-pool', deathDisposition: 'park' });
      const tiers = createAutomationTiers({ tiers: AUTOMATION_TIER_DEFS });
      const cycleLog = createCycleLog({ cycle, metrics: {} });
      const recs = buildRecommendationStack(cycle, cycleLog, bestOf);
      const dialog = createDialogSession({
        id: 'm-dialog',
        graphs: [],
        accessor: dialogAccessorStub,
      });
      const achievements = createAchievementCategory<{ id: string }>({
        id: 'm-achievements',
        mapAchievement: (def) => ({ display: { title: def.id } }),
      });
      achievements.register({ id: 'first' });
      const challenges = createChallengeCategory({ id: 'm-challenges' });
      challenges.register({ id: 'hard', displayName: 'Hard' });
      return { cycle, time, bank, bestOf, pool, tiers, recs, dialog, achievements, challenges };
    });
  }

  it('tags each cross-run ref lifetime and leaves run-scoped refs sweepable', () => {
    buildSystems();
    const lifetimeByKey = Object.fromEntries(
      [...getAllPersistentRefs()].map(([key, ref]) => [key, ref[Lifetime]]),
    );
    expect(lifetimeByKey).toEqual({
      'm/cycle.count': true,
      'm/cycle.bestTime': true,
      'm/cycle.elapsed': false,
      'm/time.elapsed': false,
      'm/time.totalPlayTime': true,
      // Whether banked time survives a prestige is the game's call: run-scoped
      // by default, `keep: [bank.banked]` carries it.
      'm/time-bank.banked': false,
      'm-best.store': true,
      'm-pool.aliveStates': true,
      'm/automation.unlocked': true,
      'm/recommendation.storedRecommendation': true,
      'm/recommendation.autoApply': true,
      'dialog-sessions/m-dialog.state': true,
      'm-achievements/first/achievement:first.earned': true,
      'm-achievements/first/achievement:first.earnedAt': true,
      'm-challenges/hard.entered': true,
      'm-challenges/hard.completions': true,
    });
  });

  it('keeps counting cycles when the cycle resets its own module', () => {
    const { cycle } = buildSystems();
    cycle.end();
    cycle.end();
    cycle.end();
    expect(cycle.count.value).toBe(3);
  });

  it('keeps lifetime state through a module reset', () => {
    const { time, pool, tiers, recs, bestOf, achievements, challenges } = buildSystems();
    const first = achievements.getAchievement('first')!;
    const hard = challenges.getChallenge('hard')!;
    first.complete();
    const earnedAt = first.earnedAt.value;
    hard.enter();
    hard.complete(true);
    time.tick(50);
    const run = pool.addRun({ id: 'a', step: () => false });
    run.step();
    tiers.unlock('basic');
    recs.autoApply.value = true;
    bestOf.submit({ key: 'gold', value: 5, elapsed: 1, runNumber: 0 });

    createReset({ resetPersistentContexts: ['m'] }).reset();

    expect(time.elapsed.value).toBe(0);
    expect(time.totalPlayTime.value).toBe(50);
    expect(run.alive.value).toBe(false);
    expect(serializePersistents(getAllPersistentRefs())).toMatchObject({
      'm-pool': { aliveStates: { a: false } },
    });
    expect(tiers.hasReached('basic')).toBe(true);
    expect(recs.autoApply.value).toBe(true);
    expect(bestOf.entries.value.gold).not.toBeNull();
    expect(first.earned.value).toBe(true);
    expect(first.earnedAt.value).toBe(earnedAt);
    expect(hard.completions.value).toBe(1);
    expect(hard.entered.value).toBe(true);
  });

  it('a module reset re-fires no achievement whose requirement still holds', () => {
    let rewards = 0;
    const lifetimeGold = persistent<number>(100, { lifetime: true });
    withPersistentContext('m', () => {
      const achievements = createAchievementCategory<{ id: string }>({
        id: 'm-achievements',
        mapAchievement: () => ({
          display: { title: 'Rich' },
          goal: () => lifetimeGold.value >= 100,
          onComplete: () => rewards++,
        }),
      });
      achievements.register({ id: 'rich' });
    });
    expect(rewards).toBe(1);

    createReset({ resetPersistentContexts: ['m'] }).reset();
    createReset({ resetPersistentContexts: ['m'] }).reset();

    expect(rewards).toBe(1);
  });

  it('a thingsToReset walk over a system agrees with the module reset', () => {
    const { cycle, time } = buildSystems();
    cycle.end();
    time.tick(50);

    createReset({ thingsToReset: [cycle, time] }).reset();

    expect(cycle.count.value).toBe(1);
    expect(time.totalPlayTime.value).toBe(50);
    expect(time.elapsed.value).toBe(0);
  });
});
