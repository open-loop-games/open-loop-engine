import { describe, it, expect, vi } from 'vitest';
import { bn } from '@/primitives/decimal';
import { Decimal } from '@/primitives/decimal';
import { createResource, addResource } from '@/core/resource';
import { persistent, beginPersistentContext, endPersistentContext } from '@/core/persistence';
import { createReset, createResetTimer } from '@/systems/reset';
import { Resettable } from '@/systems/resettable';
import { createSkillCategory } from '@/systems/skill-category';
import Formula from '@/core/formulas/formulas';
import { fractional } from '@/systems/retention';

describe('Reset', () => {
  it('resets persistent refs to defaults', () => {
    beginPersistentContext('reset-test');
    const gold = createResource(bn(0), { displayName: 'Gold' });
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

  it('calls onReset callback after reset', () => {
    let called = false;
    beginPersistentContext('reset-test-callback');
    const pts = createResource(bn(100), { displayName: 'Points' });
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
    const pts = createResource(bn(0), { displayName: 'Points' });
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
    const pts = createResource(bn(0), { displayName: 'TrackPoints' });
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
    const pts = createResource(bn(0), { displayName: 'EventPoints' });
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
    const pts = createResource(bn(0), { displayName: 'UnsubPoints' });
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

describe('Reset with resetModules', () => {
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
      resetModules: ['rm-mod'],
    });

    reset.reset();
    expect(gold.value).toBe(0);
    expect(skillXp.value).toBe(0);
    expect(warriorLevel.value).toBe(1);
  });

  it('keep exempts specific refs from reset', () => {
    beginPersistentContext('rm-keep');
    const temp = persistent(0);
    const permanent = persistent(0);
    endPersistentContext();

    temp.value = 100;
    permanent.value = 42;

    const reset = createReset({
      resetModules: ['rm-keep'],
      keep: [permanent],
    });

    reset.reset();
    expect(temp.value).toBe(0);
    expect(permanent.value).toBe(42);
  });

  it('retain applies transform to refs', () => {
    beginPersistentContext('rm-retain');
    const skill = createResource(bn(0), { displayName: 'Skill' });
    const temp = persistent(0);
    endPersistentContext();

    addResource(skill, 100);
    temp.value = 500;

    const reset = createReset({
      resetModules: ['rm-retain'],
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
      resetModules: ['rm-inner'],
    });

    const outerReset = createReset({
      resetModules: [innerReset, 'rm-outer'],
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
      resetModules: ['rm-compose-inner'],
      keep: [innerRef], // inner would keep this...
    });

    const outerReset = createReset({
      resetModules: [innerReset, 'rm-compose-outer'],
      // ...but outer doesn't keep innerRef
    });

    outerReset.reset();
    expect(innerRef.value).toBe(0); // NOT kept — outer's retention wins
    expect(outerRef.value).toBe(0);
  });

  it('thingsToReset and resetModules coexist', () => {
    beginPersistentContext('rm-coexist-mod');
    const modRef = persistent(0);
    endPersistentContext();

    beginPersistentContext('rm-coexist-manual');
    const manualRef = persistent(0);
    endPersistentContext();

    modRef.value = 10;
    manualRef.value = 20;

    const reset = createReset({
      resetModules: ['rm-coexist-mod'],
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
      resetModules: ['rm-scope'],
    });

    expect(reset.resolvedScope.size).toBe(1);
    expect(reset.resolvedScope.has(r)).toBe(true);
  });

  it('backward compat: thingsToReset-only still works', () => {
    beginPersistentContext('rm-compat');
    const pts = createResource(bn(0), { displayName: 'Points' });
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

  it('category wrappers expose [Resettable] yielding their instances', () => {
    const skills = createSkillCategory<{ id: string; xpScale: number }>({
      id: 'reset-cat-yield',
      mapSkill: (def) => ({
        xpToLevel: (xp) => Formula.variable(xp).div(def.xpScale).sqrt().floor(),
        levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
      }),
    });
    skills.register({ id: 'reset-cat-yield-combat', xpScale: 10 });

    expect(Resettable in skills).toBe(true);
    const yielded = Array.from(skills[Resettable]());
    expect(yielded).toContain(skills.getSkill('reset-cat-yield-combat'));
  });
});
