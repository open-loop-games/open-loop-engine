/**
 * {@link createIncrementalSnapshot} over emissions with empty deps — a
 * predicate the walker can't meter, so no `invalidate*` call ever reaches it.
 *
 * The challenge leaf emits a closure-form goal on an active challenge as
 * `opaque-predicate` with no deps. The closure reads plain (non-reactive)
 * state, so neither a dep signal nor the challenge's gating computeds see it
 * move — and the leaf reads the same stale computeds, so its emission doesn't
 * either. A selective rebuild must still match a full one.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEngine, type EngineModule } from '@/index';
import { createChallengeCategory } from '@/systems/challenge-category';
import { createPurchasableCategory } from '@/systems/purchasable-category';
import { resetAllPersistentContexts } from '@/core/persistence';
import { createIncrementalSnapshot, createTransitionSnapshot } from '@/harness/walker';
import { mockAccessor } from './incremental-snapshot-fixture';

beforeEach(() => {
  resetAllPersistentContexts();
});

const accessor = mockAccessor();

describe('createIncrementalSnapshot — empty-deps emissions', () => {
  it('a selective rebuild matches a full one across a closure flip and a completion', () => {
    const world = { bossDefeated: false };
    let trials!: ReturnType<typeof createChallengeCategory>;
    const module: EngineModule = {
      id: 'inc-opaque',
      install() {
        trials = createChallengeCategory({ id: 'trials', accessor });
        trials.register({ id: 'boss', name: 'Boss', goal: () => world.bossDefeated });
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

  it('a category leaf flipping inside a gate that stays false re-emits the gate distance', () => {
    let shop!: ReturnType<typeof createPurchasableCategory<{ id: string }>>;
    let trials!: ReturnType<typeof createChallengeCategory>;
    const module: EngineModule = {
      id: 'inc-mixed',
      install() {
        shop = createPurchasableCategory<{ id: string }>({
          id: 'shop',
          mapPurchasable: (def) => ({ display: { description: def.id }, requirements: [] }),
        });
        shop.register({ id: 'pick' });
        trials = createChallengeCategory({ id: 'trials', accessor });
        trials.register({
          id: 'mine',
          name: 'Mine',
          canEnter: {
            kind: 'all',
            of: [
              { kind: 'count-gte', category: 'shop', entry: 'pick', value: 1 },
              { kind: 'resource-gte', resource: 'gold', value: 100 },
            ],
          },
          goal: () => false,
        });
      },
    };
    const engine = createEngine({ gameId: 'inc-mixed', persistence: false });
    engine.use(module);
    engine.start();

    const inc = createIncrementalSnapshot(engine, accessor);
    const startUnlock = () => inc.snapshot.challenges.find((t) => t.kind === 'becomes-enterable');
    expect(startUnlock()?.distance).toEqual({ seconds: null, reason: 'opaque-predicate' });

    // Gold has no rate, so no dep moves either way, and the gate stays false.
    const pick = shop.getPurchasable('pick')!;
    pick.count.value = 1;
    inc.rebuild();
    expect(trials.getChallenge('mine')!.canEnter.value).toBe(false);
    expect(startUnlock()?.distance).toEqual({ seconds: null, reason: 'no-rate' });
    expect(inc.snapshot.all).toEqual(createTransitionSnapshot(engine, accessor).all);

    pick.count.value = 0;
    inc.rebuild();
    expect(startUnlock()?.distance).toEqual({ seconds: null, reason: 'opaque-predicate' });
  });
});
