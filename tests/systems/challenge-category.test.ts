import { describe, it, expect, beforeEach } from 'vitest';
import { ref } from 'vue';
import { resetAllPersistentContexts } from '@/core/persistence';
import { createChallengeCategory } from '@/systems/challenge-category';
import { C } from '@/core/conditions';
import { createModifierChain } from '@/core/modifier';
import { Decimal } from '@/primitives/decimal';

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

  it('declarative goal via ICondition still works alongside the callback form', () => {
    const tickHandlers: Array<(dt: number) => void> = [];
    const registerTick = (cb: (dt: number) => void) => {
      tickHandlers.push(cb);
      return () => {};
    };

    // Minimal accessor backing a single state key for the declarative check
    const stateFlag = ref(false);
    const accessor = {
      getResource: () => undefined,
      hasUnlock: () => false,
      getState: (id: string) => (id === 'done' ? stateFlag.value : undefined),
    };

    const challenges = createChallengeCategory({
      id: 'cbgoal-decl',
      mutuallyExclusive: true,
      accessor,
      registerTick,
    });

    challenges.register({
      id: 'flag',
      name: 'Flag',
      goal: C.state('done', 'eq', true),
    });

    const ch = challenges.getChallenge('flag')!;
    ch.enter();

    tickHandlers.forEach((h) => h(0.016));
    expect(ch.completed.value).toBe(false);

    stateFlag.value = true;
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
