import { describe, it, expect, beforeEach } from 'vitest';
import { ref } from 'vue';
import {
  deserializePersistents,
  getAllPersistentRefs,
  resetAllPersistentContexts,
  serializePersistents,
  withPersistentContext,
} from '@/core/persistence';
import { createOverrideRegistry } from '@/core/override-registry';
import { E } from '@/core/effects';
import { createChallengeCategory } from '@/systems/challenge-category';
import { createContentRegistry } from '@/systems/content-registry';
import { createReset, type Reset } from '@/systems/reset';
import { createModifierChain } from '@/core/modifier';
import { Decimal } from '@/primitives/decimal';
import { saveAndClear } from '../helpers/save-roundtrip';

beforeEach(() => {
  resetAllPersistentContexts();
});

describe('ChallengeDef.goal callback form', () => {
  it('auto-completes via registerTick when the callback returns true', () => {
    const progress = ref(0);
    const tickHandlers: Array<(dt: number) => void> = [];
    const registerTick = (cb: (dt: number) => void) => {
      tickHandlers.push(cb);
      return () => {};
    };

    const challenges = createChallengeCategory({
      id: 'cbgoal-tick',
      mutuallyExclusive: true,
      registerTick,
    });

    challenges.register({
      id: 'reach-ten',
      name: 'Reach Ten',
      goal: () => progress.value >= 10,
    });

    const ch = challenges.getChallenge('reach-ten')!;
    ch.enter();

    progress.value = 9;
    tickHandlers.forEach((h) => h(0.016));
    expect(ch.completed.value).toBe(false);

    progress.value = 10;
    tickHandlers.forEach((h) => h(0.016));
    expect(ch.completed.value).toBe(true);
  });
});

describe('ChallengeDef declarative bindings', () => {
  it('restricts bind while challenge is active, detach on exit', () => {
    const chain = createModifierChain('ch-restricts-chain');
    const challenges = createChallengeCategory({
      id: 'ch-restricts',
      mutuallyExclusive: true,
    });

    challenges.register({
      id: 'halved',
      name: 'Halved',
      goal: () => false,
      restricts: [{ chain, mult: 0.5, description: 'rate-halve' }],
    });

    const ch = challenges.getChallenge('halved')!;
    expect(Decimal.eq(chain.apply(100), 100)).toBe(true);

    ch.enter();
    expect(Decimal.eq(chain.apply(100), 50)).toBe(true);

    ch.exit();
    expect(Decimal.eq(chain.apply(100), 100)).toBe(true);
  });

  it('a restriction and a reward sharing a description on one chain both bind', () => {
    const chain = createModifierChain('ch-shared-desc-chain');
    const challenges = createChallengeCategory({
      id: 'ch-shared-desc',
      mutuallyExclusive: true,
    });

    challenges.register({
      id: 'trade',
      name: 'Trade',
      goal: () => true,
      restricts: [{ chain, mult: 0.5, description: 'rate' }],
      rewards: [{ chain, mult: 3, description: 'rate' }],
    });

    const ch = challenges.getChallenge('trade')!;
    expect(chain.bindings()).toHaveLength(2);
    expect(new Set(chain.bindings().map((b) => b.id)).size).toBe(2);

    ch.enter();
    expect(Decimal.eq(chain.apply(100), 50)).toBe(true);
    ch.complete();
    expect(Decimal.eq(chain.apply(100), 300)).toBe(true);
  });

  it('rewards persist on chain after at least one completion', () => {
    const chain = createModifierChain('ch-rewards-chain');
    const challenges = createChallengeCategory({
      id: 'ch-rewards',
      mutuallyExclusive: true,
    });

    challenges.register({
      id: 'beat',
      name: 'Beat',
      goal: () => true,
      rewards: [{ chain, mult: 2, description: 'perk' }],
    });

    const ch = challenges.getChallenge('beat')!;
    expect(Decimal.eq(chain.apply(100), 100)).toBe(true);

    ch.enter();
    ch.complete();
    // Exited after completion; but reward predicate is completions > 0.
    expect(ch.active.value).toBe(false);
    expect(ch.completions.value).toBe(1);
    expect(Decimal.eq(chain.apply(100), 200)).toBe(true);
  });

  it('completionEffects (renamed from rewards:IEffect[]) still fire on complete', () => {
    // Regression: the field renamed from `rewards: IEffect[]` to
    // `completionEffects: IEffect[]`. A present-but-empty (or missing)
    // mutator path must not crash complete().
    const challenges = createChallengeCategory({
      id: 'ch-compEffects',
      mutuallyExclusive: true,
    });

    challenges.register({
      id: 'simple',
      name: 'Simple',
      goal: () => true,
      completionEffects: [],
    });

    const ch = challenges.getChallenge('simple')!;
    ch.enter();
    expect(() => ch.complete()).not.toThrow();
    expect(ch.completions.value).toBe(1);
  });
});

describe('ChallengeCategory — scopes follow `active` through every load and reset', () => {
  interface Rules extends Record<string, (...args: never[]) => unknown> {
    combat: () => number;
  }

  /** A category in module `m` whose `zombie` challenge overrides combat and patches a cost. */
  function build(reset?: Reset) {
    const log: string[] = [];
    const rules = createOverrideRegistry<Rules>('rules');
    rules.setDefault('combat', () => 10);
    const actions = createContentRegistry<{ id: string; cost: number }>('actions');
    actions.register({ id: 'buy', cost: 5 });
    const challenges = withPersistentContext('m', () =>
      createChallengeCategory({
        id: 'ch',
        overrideRegistry: rules,
        contentRegistries: { actions },
        reset,
      }),
    );
    const hooks = (id: string) => ({
      onEnter: () => log.push(`enter ${id}`),
      onExit: () => log.push(`exit ${id}`),
    });
    challenges.register([
      {
        id: 'zombie',
        name: 'Zombie',
        overrides: { combat: () => 0 },
        contentPatches: { actions: { buy: { cost: 1 } } },
        ...hooks('zombie'),
      },
      {
        id: 'other',
        name: 'Other',
        overrides: { combat: () => 5 },
        ...hooks('other'),
      },
    ]);
    return {
      challenges,
      log,
      rules,
      zombie: challenges.getChallenge('zombie')!,
      combat: () => rules.get('combat')(),
      cost: () => actions.get('buy')!.cost,
    };
  }

  function save(): Record<string, unknown> {
    return serializePersistents(getAllPersistentRefs());
  }

  it('a load of a mid-challenge save pushes its scopes without calling onEnter', () => {
    build().zombie.enter();
    const midChallenge = saveAndClear();

    const { combat, cost, log, zombie } = build();
    deserializePersistents(getAllPersistentRefs(), midChallenge);

    expect(zombie.active.value).toBe(true);
    expect(combat()).toBe(0);
    expect(cost()).toBe(1);
    expect(log).toEqual([]);
  });

  it('a load of a save with no challenge active pops the scopes, and re-entry leaks none', () => {
    const { combat, cost, log, zombie } = build();
    const idle = save();
    zombie.enter();
    log.length = 0;

    deserializePersistents(getAllPersistentRefs(), idle);
    expect(zombie.active.value).toBe(false);
    expect(combat()).toBe(10);
    expect(cost()).toBe(5);
    expect(log).toEqual([]);

    zombie.enter();
    zombie.exit();
    expect(combat()).toBe(10);
    expect(cost()).toBe(5);
  });

  it('a reset that names `active` pops the scopes, and re-entry leaks none', () => {
    const { combat, zombie } = build();
    zombie.enter();

    createReset({ thingsToReset: [zombie.active] }).reset();
    expect(zombie.active.value).toBe(false);
    expect(combat()).toBe(10);

    zombie.enter();
    zombie.exit();
    expect(combat()).toBe(10);
  });

  it('a second load of the same save adds no second scope', () => {
    build().zombie.enter();
    const midChallenge = saveAndClear();

    const { rules, log } = build();
    deserializePersistents(getAllPersistentRefs(), midChallenge);
    deserializePersistents(getAllPersistentRefs(), midChallenge);

    expect(rules.overrideDepth).toBe(1);
    expect(log).toEqual([]);
  });

  it("an entry reset over the category's own module keeps the challenge entered", () => {
    const { combat, zombie, log } = build(createReset({ resetPersistentContexts: ['m'] }));

    expect(zombie.enter()).toBe(true);

    expect(zombie.active.value).toBe(true);
    expect(combat()).toBe(0);
    expect(log).toEqual(['enter zombie']);
  });

  it('entering a declined reset does not enter', () => {
    const { combat, zombie, log } = build(createReset({ onBeforeReset: () => false }));

    expect(zombie.enter()).toBe(false);

    expect(zombie.active.value).toBe(false);
    expect(combat()).toBe(10);
    expect(log).toEqual([]);
  });

  it('entering one challenge exits the other', () => {
    const { challenges, combat, zombie, log } = build();
    zombie.enter();

    challenges.getChallenge('other')!.enter();

    expect(zombie.active.value).toBe(false);
    expect(combat()).toBe(5);
    expect(log).toEqual(['enter zombie', 'exit zombie', 'enter other']);
  });

  it('dispose releases the scopes and leaves `active` and the hooks alone', () => {
    const { challenges, combat, cost, zombie, log } = build();
    zombie.enter();

    challenges.dispose();

    expect(zombie.active.value).toBe(true);
    expect(combat()).toBe(10);
    expect(cost()).toBe(5);
    expect(log).toEqual(['enter zombie']);
  });
});

describe('ChallengeCategory — completionEffects need a mutator', () => {
  it('throws at register when a def has completionEffects and no mutator resolves', () => {
    const challenges = createChallengeCategory({ id: 'ch-no-mutator' });

    expect(() =>
      challenges.register({
        id: 'grant',
        name: 'Grant',
        completionEffects: [E.resource('gold', 'add', 1)],
      }),
    ).toThrow(/completionEffects/);
  });
});
