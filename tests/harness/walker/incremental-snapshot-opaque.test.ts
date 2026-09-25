/**
 * {@link createIncrementalSnapshot} over emissions with empty deps — a
 * predicate the walker can't meter, so no `invalidate*` call ever reaches it.
 *
 * The challenge leaf is wrapped to add an `opaque-predicate` goal emission for
 * a closure-form goal on an active challenge, carrying the closure's live
 * value as `currentValue`. The closure reads plain (non-reactive) state, so
 * neither a dep signal nor the challenge's gating computeds see it move. A
 * selective rebuild must still match a full one.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CategoriesKey, createEngine, type EngineCategories, type EngineModule } from '@/index';
import { createChallengeCategory, type ChallengeDef } from '@/systems/challenge-category';
import { resetAllPersistentContexts } from '@/core/persistence';
import { bn } from '@/primitives/decimal';
import type { GameStateAccessor } from '@/primitives/types';
import type { Transition } from '@/harness/walker/types';
import { createIncrementalSnapshot } from '@/harness/walker';

vi.mock('@/harness/walker/walk-challenge-transitions', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/harness/walker/walk-challenge-transitions')>();
  return {
    ...actual,
    emitChallengeTransitionsForEntity: (
      categoryId: string,
      entity: unknown,
      accessor: GameStateAccessor,
    ) => {
      const out = actual.emitChallengeTransitionsForEntity(categoryId, entity, accessor);
      const { def, challenge } = entity as {
        def: ChallengeDef;
        challenge: { active: { value: boolean } };
      };
      if (typeof def.goal === 'function' && challenge.active.value) {
        const transition: Transition = {
          source: 'challenge',
          kind: 'goal-complete',
          categoryId,
          entityId: def.id,
          currentValue: def.goal(),
          distance: { seconds: null, reason: 'opaque-predicate' },
          label: `${categoryId}.${def.id}.goal-complete`,
        };
        out.push({
          transition,
          deps: { resources: new Set(), rates: new Set(), unlocks: new Set(), states: new Set() },
        });
      }
      return out;
    },
  };
});

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
    expect(goal()?.currentValue).toBe(false);

    world.bossDefeated = true;
    inc.invalidateResource('unrelated');
    inc.rebuild();
    reference.invalidateAll();
    expect(inc.snapshot.all).toEqual(reference.rebuild().all);
    expect(goal()?.currentValue).toBe(true);

    trials.getChallenge('boss')!.complete();
    inc.rebuild();
    expect(goal()).toBeUndefined();
  });
});
