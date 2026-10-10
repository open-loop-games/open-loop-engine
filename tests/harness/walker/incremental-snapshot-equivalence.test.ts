/**
 * Equivalence suite for {@link createIncrementalSnapshot} against
 * {@link createTransitionSnapshot} (correctness contract).
 *
 * Across scripted mutations on every dep axis (resource, rate, unlock,
 * state) and on entity state (purchases, resets, challenge entry), the
 * incremental cache's `rebuild()` — selective under targeted `invalidate*`
 * calls, full under `invalidateAll()` — must deep-equal a fresh
 * `createTransitionSnapshot` call.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEngine, type EngineModule } from '@/index';
import { resetAllPersistentContexts } from '@/core/persistence';
import { createResource } from '@/core/resource';
import { createChallengeCategory } from '@/systems/challenge-category';
import { createProducerCategory } from '@/systems/producer-category';
import { createPurchasableCategory } from '@/systems/purchasable-category';
import { bn } from '@/primitives/decimal';
import type { GameStateAccessor } from '@/primitives/types';
import { createTransitionSnapshot, createIncrementalSnapshot } from '@/harness/walker';
import { expectSnapshotsEquivalent, setup } from './incremental-snapshot-fixture';

beforeEach(() => {
  resetAllPersistentContexts();
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('createIncrementalSnapshot — construction', () => {
  it('returns an empty snapshot when the engine built no categories', () => {
    const engine = createEngine({ gameId: 'inc-no-key', persistence: false });
    engine.start();
    const accessor: GameStateAccessor = {
      getResource: () => bn(0),
      isUnlocked: () => false,
      getState: () => undefined,
      getRate: () => bn(0),
    };
    const inc = createIncrementalSnapshot(engine, accessor);
    expect(inc.snapshot.all).toEqual([]);
    expect(inc.snapshot.challenges).toEqual([]);
    expect(inc.snapshot.purchasables).toEqual([]);
    expect(inc.snapshot.producers).toEqual([]);
  });

  it('returns an empty snapshot when every category holds no defs', () => {
    const module: EngineModule = {
      id: 'empty-slices',
      install(ctx) {
        createChallengeCategory({ id: 'trials' });
        createPurchasableCategory<{ id: string }>({
          id: 'upgrades',
          mapPurchasable: (def) => ({
            display: { description: def.id },
            requirements: [],
            limit: 1,
          }),
        });
        const gold = createResource(0, { id: 'gold' });
        createProducerCategory<{ id: string }>({
          id: 'buildings',
          mapProducer: () => ({ resource: gold, baseRate: 1, trigger: 'continuous' }),
          registerTick: ctx.onTick,
        });
      },
    };
    const engine = createEngine({ gameId: 'inc-empty', persistence: false });
    engine.use(module);
    engine.start();
    const accessor: GameStateAccessor = {
      getResource: () => bn(0),
      isUnlocked: () => false,
      getState: () => undefined,
      getRate: () => bn(0),
    };
    const inc = createIncrementalSnapshot(engine, accessor);
    expect(inc.snapshot.all).toEqual([]);
  });

  it('initial snapshot matches createTransitionSnapshot', () => {
    const { accessor, engine, inc } = setup(
      'inc-init',
      { gold: 0, gems: 0 },
      { unlocks: { 'bronze-unlock': false }, state: { 'trial.seen': false } },
    );
    const direct = createTransitionSnapshot(engine, accessor);
    expect(inc.snapshot.all).toEqual(direct.all);
    expect(inc.snapshot.challenges).toEqual(direct.challenges);
    expect(inc.snapshot.purchasables).toEqual(direct.purchasables);
    expect(inc.snapshot.producers).toEqual(direct.producers);
  });
});

// ---------------------------------------------------------------------------
// Equivalence across mutations
// ---------------------------------------------------------------------------

describe('createIncrementalSnapshot — equivalence across mutations', () => {
  it('matches after purchase', () => {
    const { accessor, config, engine, inc } = setup(
      'inc-purchase',
      { gold: 25, gems: 0 },
      { unlocks: { 'bronze-unlock': false }, state: { 'trial.seen': false } },
    );
    expectSnapshotsEquivalent(inc, engine, accessor, 'initial');

    // Simulate a purchase-like mutation: gold drops below the 20-cost upgrade.
    config.resources.gold = 5;
    inc.invalidateResource('gold');
    expectSnapshotsEquivalent(inc, engine, accessor, 'post-purchase');
  });

  it('matches after tick-driven rate change', () => {
    const { accessor, config, engine, inc } = setup(
      'inc-rate',
      { gold: 0, gems: 0 },
      { unlocks: { 'bronze-unlock': false }, state: { 'trial.seen': false } },
    );

    // Tick-like mutation: gold rate changes; distances recompute.
    config.rates.gold = 5;
    inc.invalidateRate('gold');
    expectSnapshotsEquivalent(inc, engine, accessor, 'post-rate-change');
  });

  it('matches after unlock flip', () => {
    const { accessor, config, engine, inc } = setup(
      'inc-unlock',
      { gold: 0, gems: 0 },
      { unlocks: { 'bronze-unlock': false }, state: { 'trial.seen': false } },
    );

    config.unlocks['bronze-unlock'] = true;
    inc.invalidateUnlock('bronze-unlock');
    expectSnapshotsEquivalent(inc, engine, accessor, 'post-unlock-flip');
  });

  it('matches after state mutation', () => {
    const { accessor, config, engine, inc } = setup(
      'inc-state',
      { gold: 0, gems: 0 },
      { state: { 'trial.seen': false } },
    );

    config.state['trial.seen'] = true;
    inc.invalidateState('trial.seen');
    expectSnapshotsEquivalent(inc, engine, accessor, 'post-state-mutation');
  });

  it('matches across a compound sequence using invalidateAll', () => {
    const { accessor, config, engine, inc } = setup(
      'inc-compound',
      { gold: 0, gems: 0 },
      { unlocks: { 'bronze-unlock': false }, state: { 'trial.seen': false } },
    );
    expectSnapshotsEquivalent(inc, engine, accessor, 'initial');

    // Walk all four axes using invalidateAll between each mutation.
    config.resources.gold = 15;
    inc.invalidateAll();
    expectSnapshotsEquivalent(inc, engine, accessor, 'after-resource');

    config.rates.gems = 3;
    inc.invalidateAll();
    expectSnapshotsEquivalent(inc, engine, accessor, 'after-rate');

    config.unlocks['bronze-unlock'] = true;
    inc.invalidateAll();
    expectSnapshotsEquivalent(inc, engine, accessor, 'after-unlock');

    config.state['trial.seen'] = true;
    inc.invalidateAll();
    expectSnapshotsEquivalent(inc, engine, accessor, 'after-state');
  });

  it('a selective rebuild does not pick up an un-invalidated change', () => {
    const { accessor, config, engine, inc } = setup(
      'inc-silent',
      { gold: 0, gems: 0 },
      { unlocks: { 'bronze-unlock': false }, state: { 'trial.seen': false } },
    );
    const before = inc.rebuild();

    // The gold rate feeds every affordability distance, but only an
    // unrelated id is invalidated, so the cache keeps the old distances.
    config.rates.gold = 50;
    inc.invalidateResource('gems');
    const stale = inc.rebuild();
    expect(stale.purchasables).toEqual(before.purchasables);
    expect(stale.purchasables).not.toEqual(createTransitionSnapshot(engine, accessor).purchasables);

    inc.invalidateRate('gold');
    expectSnapshotsEquivalent(inc, engine, accessor, 'after-invalidating-the-rate');
  });
});

// ---------------------------------------------------------------------------
// Entity gating state
// ---------------------------------------------------------------------------

describe('createIncrementalSnapshot — entity gating changes', () => {
  it('a maxed purchasable returns after a reset un-maxes it', () => {
    const { upgrades, config, inc, check } = setup('inc-gate-purchasable', { gold: 25, gems: 0 });
    const fast = upgrades.getPurchasable('fast')!;

    fast.amount.value = 1;
    config.resources.gold = 5;
    inc.invalidateResource('gold');
    check('after-purchase');
    expect(inc.snapshot.purchasables.some((t) => t.defId === 'fast')).toBe(false);

    fast.amount.value = 0;
    config.resources.gold = 10;
    inc.invalidateResource('gold');
    check('after-reset');
    expect(inc.snapshot.purchasables.some((t) => t.defId === 'fast')).toBe(true);
  });

  it('a raised limit un-maxes a purchasable without an invalidation', () => {
    const { upgrades, upgradeLimit, inc, check } = setup('inc-gate-limit', { gold: 25, gems: 0 });
    upgrades.getPurchasable('fast')!.amount.value = 1;
    check('maxed');

    upgradeLimit.value = 2;
    check('after-raising-the-limit');
    expect(inc.snapshot.purchasables.map((t) => t.label)).toContain(
      'upgrades.fast.purchasable-maxed',
    );
  });

  it('a maxed producer returns after a reset un-maxes it', () => {
    const { buildings, config, inc, check } = setup('inc-gate-producer', { gold: 40, gems: 0 });
    const mill = buildings.getProducer('mill')!.repeatable!;

    mill.amount.value = 1;
    config.resources.gold = 10;
    inc.invalidateResource('gold');
    check('after-purchase');

    mill.amount.value = 0;
    check('after-reset-without-invalidation');
    expect(inc.snapshot.producers.some((t) => t.defId === 'mill')).toBe(true);
  });

  it('entering a challenge surfaces its goal without an invalidation', () => {
    const { trials, inc, check } = setup('inc-gate-enter', { gold: 20, gems: 5 });
    check('before-enter');

    expect(trials.getChallenge('bronze')!.enter()).toBe(true);
    check('after-enter');
    expect(inc.snapshot.challenges.map((t) => t.label)).toContain('trials.bronze.goal-complete');

    trials.getChallenge('bronze')!.complete(true);
    check('after-first-completion');
  });

  it('a challenge with no emissions re-emits when a dep of a silent gate moves', () => {
    // bronze is revealed, startable and inactive: it emits nothing until a
    // reset drops gold under its visibility gate.
    const { config, inc, check } = setup('inc-gate-silent', { gold: 20, gems: 10 });
    check('initial');
    expect(inc.snapshot.challenges.some((t) => t.defId === 'bronze')).toBe(false);

    config.resources.gold = 0;
    inc.invalidateResource('gold');
    check('after-reset');
    expect(inc.snapshot.challenges.map((t) => t.label)).toContain(
      'trials.bronze.visibility-reveal',
    );
  });
});

// ---------------------------------------------------------------------------
// Dirty-set plumbing
// ---------------------------------------------------------------------------

describe('createIncrementalSnapshot — dirty-set plumbing', () => {
  it('accepts invalidate* calls for unknown ids without throwing', () => {
    const { accessor, engine, inc } = setup(
      'inc-unknown-ids',
      { gold: 0, gems: 0 },
      { unlocks: {}, state: {} },
    );

    expect(() => inc.invalidateResource('not-a-resource')).not.toThrow();
    expect(() => inc.invalidateRate('not-a-rate')).not.toThrow();
    expect(() => inc.invalidateUnlock('not-an-unlock')).not.toThrow();
    expect(() => inc.invalidateState('not.a.state.path')).not.toThrow();

    // And the next rebuild is still correct.
    expectSnapshotsEquivalent(inc, engine, accessor, 'after-unknown-invalidates');
  });

  it('invalidateAll and exhaustive targeted invalidation yield identical rebuilds', () => {
    // Single engine; the full and the selective path over the same state
    // must produce identical output.
    const { inc } = setup('inc-paths', { gold: 100, gems: 10 });

    inc.invalidateAll();
    const viaInvalidateAll = inc.rebuild();

    inc.invalidateResource('gold');
    inc.invalidateRate('gold');
    inc.invalidateUnlock('bronze-unlock');
    inc.invalidateState('trial.seen');
    const viaTargeted = inc.rebuild();

    expect(viaTargeted.all).toEqual(viaInvalidateAll.all);
    expect(viaTargeted.challenges).toEqual(viaInvalidateAll.challenges);
    expect(viaTargeted.purchasables).toEqual(viaInvalidateAll.purchasables);
    expect(viaTargeted.producers).toEqual(viaInvalidateAll.producers);
  });
});

// ---------------------------------------------------------------------------
// Reference stability / object identity
// ---------------------------------------------------------------------------

describe('createIncrementalSnapshot — rebuild semantics', () => {
  it('returns a fresh TransitionSnapshot object per rebuild', () => {
    const { inc } = setup(
      'inc-identity',
      { gold: 0, gems: 0 },
      { unlocks: { 'bronze-unlock': false }, state: { 'trial.seen': false } },
    );

    const first = inc.rebuild();
    const second = inc.rebuild();
    expect(second).not.toBe(first);
    expect(second.all).toEqual(first.all);
  });

  it('updates `snapshot` getter after rebuild', () => {
    const { config, inc } = setup(
      'inc-getter',
      { gold: 0, gems: 0 },
      { unlocks: { 'bronze-unlock': false }, state: { 'trial.seen': false } },
    );

    const beforeRebuild = inc.snapshot;
    config.rates.gold = 10;
    const afterRebuild = inc.rebuild();
    expect(inc.snapshot).toBe(afterRebuild);
    expect(inc.snapshot).not.toBe(beforeRebuild);
  });
});
