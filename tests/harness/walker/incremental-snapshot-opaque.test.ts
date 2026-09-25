/**
 * {@link createIncrementalSnapshot} over emissions with empty deps — a
 * predicate the walker can't meter, so no `invalidate*` call ever reaches it.
 *
 * The challenge leaf emits a closure-form goal on an active challenge as
 * `opaque-predicate` with no deps. The closure reads plain (non-reactive)
 * state, so neither a dep signal nor the challenge's gating computeds see it
 * move. A selective rebuild must still match a full one.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CategoriesKey, createEngine, type EngineCategories, type EngineModule } from '@/index';
import { createChallengeCategory } from '@/systems/challenge-category';
import { resetAllPersistentContexts } from '@/core/persistence';
import { bn } from '@/primitives/decimal';
import type { GameStateAccessor } from '@/primitives/types';
import { createIncrementalSnapshot } from '@/harness/walker';

beforeEach(() => {
  resetAllPersistentContexts();
});

const accessor: GameStateAccessor = {
  getResource: () => bn(0),
  isUnlocked: () => false,
  getState: () => undefined,
  getRate: () => bn(0),
};

describe('createIncrementalSnapshot — empty-deps emissions', () => {
  it('refreshes an opaque closure-goal emission on every selective rebuild', () => {
    const world = { bossDefeated: false };
    let trials!: ReturnType<typeof createChallengeCategory>;
    const module: EngineModule = {
      id: 'inc-opaque',
      install(ctx) {
        trials = createChallengeCategory({ id: 'trials', accessor });
        trials.register({ id: 'boss', name: 'Boss', goal: () => world.bossDefeated });
        ctx.provide(CategoriesKey, { challenges: [trials] } as EngineCategories);
      },
    };
    const engine = createEngine({ gameId: 'inc-opaque', persistence: false });
    engine.use(module);
    engine.start();
    trials.getChallenge('boss')!.enter();

    const inc = createIncrementalSnapshot(engine, accessor);
    const reference = createIncrementalSnapshot(engine, accessor);
    const goal = () => inc.snapshot.challenges.find((t) => t.kind === 'goal-complete');
    expect(goal()?.distance).toEqual({ seconds: null, reason: 'opaque-predicate' });

    world.bossDefeated = true;
    inc.invalidateResource('unrelated');
    inc.rebuild();
    reference.invalidateAll();
    expect(inc.snapshot.all).toEqual(reference.rebuild().all);

    trials.getChallenge('boss')!.complete();
    inc.rebuild();
    expect(goal()).toBeUndefined();
  });
});
