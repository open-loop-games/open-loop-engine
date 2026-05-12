/**
 * Equivalence suite for {@link createIncrementalSnapshot} against
 * {@link createTransitionSnapshot} (correctness contract).
 *
 * Step 4 always full-rebuilds on `rebuild()`. This suite confirms that
 * across a scripted mutation sequence (purchase / tick-driven rate change /
 * unlock flip / state mutation / challenge completion), the incremental
 * cache's `rebuild()` output is deep-equal to a fresh `createTransitionSnapshot`
 * call at every step. Targeted `invalidate*` calls and `invalidateAll()` must
 * both produce the same output, since step 4 ignores the dirty sets.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CategoriesKey, createEngine, type EngineCategories, type EngineModule } from '@/index';
import { createResource } from '@/core/resource';
import { createCostRequirement } from '@/core/requirements';
import { createPurchasableCategory } from '@/systems/purchasable-category';
import { createProducerCategory } from '@/systems/producer-category';
import { createChallengeCategory } from '@/systems/challenge-category';
import { C } from '@/core/conditions';
import { resetAllPersistentContexts } from '@/core/persistence';
import { bn } from '@/primitives/decimal';
import type { GameStateAccessor } from '@/primitives/types';
import { createTransitionSnapshot, createIncrementalSnapshot } from '@/harness/walker';

beforeEach(() => {
  resetAllPersistentContexts();
});

interface MutableAccessorConfig {
  resources: Record<string, number>;
  rates: Record<string, number>;
  unlocks: Record<string, boolean>;
  state: Record<string, unknown>;
}

interface MutableAccessor {
  accessor: GameStateAccessor;
  config: MutableAccessorConfig;
}

/**
 * Accessor whose backing records can be mutated between rebuilds — models
 * real mutations (resource writes, rate changes, unlock flips) without
 * plumbing a whole reactive engine. The returned `config` object is the
 * same one the accessor reads from; write to it to stage a mutation.
 */
function mutableAccessor(config: MutableAccessorConfig): MutableAccessor {
  return {
    accessor: {
      getResource: (id) => bn(config.resources[id] ?? 0),
      isUnlocked: (id) => config.unlocks[id] ?? false,
      getState: (path) => config.state[path],
      getRate: (id) => bn(config.rates[id] ?? 0),
    },
    config,
  };
}

interface UpgradeDef {
  id: string;
  cost: number;
}

interface BuildingDef {
  id: string;
  baseRate: number;
  baseCost: number;
}

/**
 * Engine with one category per leaf (purchasables / producers / challenges)
 * plus a challenge whose `canStart` gate mixes a resource condition, an
 * unlock, and a state read — so the equivalence test exercises every leaf
 * and every dep axis.
 */
function buildMixedEngine(gameId: string, accessor: GameStateAccessor) {
  const module: EngineModule = {
    id: `inc-equivalence-${gameId}`,
    install(ctx) {
      const gold = createResource(0, { displayName: 'gold' });
      const gems = createResource(0, { displayName: 'gems' });

      const upgrades = createPurchasableCategory<UpgradeDef>({
        id: 'upgrades',
        mapPurchasable: (def) => ({
          display: { description: def.id },
          requirements: [createCostRequirement({ resource: gold, cost: def.cost })],
          limit: 1,
        }),
      });
      upgrades.register([
        { id: 'slow', cost: 200 },
        { id: 'fast', cost: 20 },
      ]);

      const buildings = createProducerCategory<BuildingDef>({
        id: 'farms',
        mapProducer: (def) => ({
          resource: gems,
          baseRate: def.baseRate,
          trigger: 'continuous',
          purchase: {
            costResource: gold,
            baseCost: def.baseCost,
            costScaling: 1.15,
          },
        }),
        registerTick: ctx.onTick,
      });
      buildings.register([
        { id: 'wheat', baseRate: 1, baseCost: 50 },
        { id: 'fallow', baseRate: 0, baseCost: 150 },
      ]);

      const challenges = createChallengeCategory({
        id: 'trials',
        accessor,
      });
      challenges.register({
        id: 'bronze',
        name: 'Bronze',
        canStart: C.and(
          C.resource('gems', 'gte', 5),
          C.unlock('bronze-unlock'),
          C.state('trial.seen', 'eq', true),
        ),
        goal: C.resource('gems', 'gte', 10),
      });

      ctx.provide(CategoriesKey, {
        purchasables: [upgrades],
        producers: [buildings],
        challenges: [challenges],
      } as EngineCategories);
    },
  };

  const engine = createEngine({ gameId, persistence: false });
  engine.use(module);
  engine.start();
  return { engine };
}

/** Deep-equal the three snapshot surfaces consumers read. */
function expectSnapshotsEquivalent(
  inc: ReturnType<typeof createIncrementalSnapshot>,
  engine: ReturnType<typeof buildMixedEngine>['engine'],
  accessor: GameStateAccessor,
  label: string,
): void {
  const direct = createTransitionSnapshot(engine, accessor);
  const cached = inc.rebuild();
  expect(cached.all, `${label}: .all mismatch`).toEqual(direct.all);
  expect(cached.challenges, `${label}: .challenges mismatch`).toEqual(direct.challenges);
  expect(cached.purchasables, `${label}: .purchasables mismatch`).toEqual(direct.purchasables);
  expect(cached.producers, `${label}: .producers mismatch`).toEqual(direct.producers);
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('createIncrementalSnapshot — construction', () => {
  it('returns an empty snapshot when CategoriesKey is not provided', () => {
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

  it('returns an empty snapshot when every slice is empty', () => {
    const module: EngineModule = {
      id: 'empty-slices',
      install(ctx) {
        ctx.provide(CategoriesKey, {
          challenges: [],
          purchasables: [],
          producers: [],
        } as EngineCategories);
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
    const { accessor } = mutableAccessor({
      resources: { gold: 0, gems: 0 },
      rates: { gold: 2, gems: 1 },
      unlocks: { 'bronze-unlock': false },
      state: { 'trial.seen': false },
    });
    const { engine } = buildMixedEngine('inc-init', accessor);
    const inc = createIncrementalSnapshot(engine, accessor);
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
    const { accessor, config } = mutableAccessor({
      resources: { gold: 25, gems: 0 },
      rates: { gold: 2, gems: 1 },
      unlocks: { 'bronze-unlock': false },
      state: { 'trial.seen': false },
    });
    const { engine } = buildMixedEngine('inc-purchase', accessor);
    const inc = createIncrementalSnapshot(engine, accessor);
    expectSnapshotsEquivalent(inc, engine, accessor, 'initial');

    // Simulate a purchase-like mutation: gold drops below the 20-cost upgrade.
    config.resources.gold = 5;
    inc.invalidateResource('gold');
    expectSnapshotsEquivalent(inc, engine, accessor, 'post-purchase');
  });

  it('matches after tick-driven rate change', () => {
    const { accessor, config } = mutableAccessor({
      resources: { gold: 0, gems: 0 },
      rates: { gold: 2, gems: 1 },
      unlocks: { 'bronze-unlock': false },
      state: { 'trial.seen': false },
    });
    const { engine } = buildMixedEngine('inc-rate', accessor);
    const inc = createIncrementalSnapshot(engine, accessor);

    // Tick-like mutation: gold rate changes; distances recompute.
    config.rates.gold = 5;
    inc.invalidateRate('gold');
    expectSnapshotsEquivalent(inc, engine, accessor, 'post-rate-change');
  });

  it('matches after unlock flip', () => {
    const { accessor, config } = mutableAccessor({
      resources: { gold: 0, gems: 0 },
      rates: { gold: 2, gems: 1 },
      unlocks: { 'bronze-unlock': false },
      state: { 'trial.seen': false },
    });
    const { engine } = buildMixedEngine('inc-unlock', accessor);
    const inc = createIncrementalSnapshot(engine, accessor);

    config.unlocks['bronze-unlock'] = true;
    inc.invalidateUnlock('bronze-unlock');
    expectSnapshotsEquivalent(inc, engine, accessor, 'post-unlock-flip');
  });

  it('matches after state mutation', () => {
    const { accessor, config } = mutableAccessor({
      resources: { gold: 0, gems: 0 },
      rates: { gold: 2, gems: 1 },
      unlocks: { 'bronze-unlock': true },
      state: { 'trial.seen': false },
    });
    const { engine } = buildMixedEngine('inc-state', accessor);
    const inc = createIncrementalSnapshot(engine, accessor);

    config.state['trial.seen'] = true;
    inc.invalidateState('trial.seen');
    expectSnapshotsEquivalent(inc, engine, accessor, 'post-state-mutation');
  });

  it('matches across a compound sequence using invalidateAll', () => {
    const { accessor, config } = mutableAccessor({
      resources: { gold: 0, gems: 0 },
      rates: { gold: 2, gems: 1 },
      unlocks: { 'bronze-unlock': false },
      state: { 'trial.seen': false },
    });
    const { engine } = buildMixedEngine('inc-compound', accessor);
    const inc = createIncrementalSnapshot(engine, accessor);
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

  it('ignores targeted invalidation axis and still produces a correct full rebuild', () => {
    // Step-4 contract: even when we invalidate only one axis, the rebuild is
    // still a full walk and equivalent to createTransitionSnapshot. In other
    // words, calling invalidateResource on a resource that didn't change
    // must not affect correctness.
    const { accessor, config } = mutableAccessor({
      resources: { gold: 0, gems: 0 },
      rates: { gold: 2, gems: 1 },
      unlocks: { 'bronze-unlock': false },
      state: { 'trial.seen': false },
    });
    const { engine } = buildMixedEngine('inc-step4-contract', accessor);
    const inc = createIncrementalSnapshot(engine, accessor);

    // Mutate two axes but only invalidate one — step 4 should still full-
    // rebuild and pick up both.
    config.resources.gold = 1000;
    config.unlocks['bronze-unlock'] = true;
    inc.invalidateResource('gold');
    expectSnapshotsEquivalent(inc, engine, accessor, 'full-rebuild-despite-narrow-signal');
  });
});

// ---------------------------------------------------------------------------
// Dirty-set plumbing
// ---------------------------------------------------------------------------

describe('createIncrementalSnapshot — dirty-set plumbing', () => {
  it('accepts invalidate* calls for unknown ids without throwing', () => {
    const { accessor } = mutableAccessor({
      resources: { gold: 0, gems: 0 },
      rates: { gold: 2, gems: 1 },
      unlocks: {},
      state: {},
    });
    const { engine } = buildMixedEngine('inc-unknown-ids', accessor);
    const inc = createIncrementalSnapshot(engine, accessor);

    expect(() => inc.invalidateResource('not-a-resource')).not.toThrow();
    expect(() => inc.invalidateRate('not-a-rate')).not.toThrow();
    expect(() => inc.invalidateUnlock('not-an-unlock')).not.toThrow();
    expect(() => inc.invalidateState('not.a.state.path')).not.toThrow();

    // And the next rebuild is still correct.
    expectSnapshotsEquivalent(inc, engine, accessor, 'after-unknown-invalidates');
  });

  it('invalidateAll and exhaustive targeted invalidation yield identical rebuilds', () => {
    // Single engine; two sequential rebuild paths over the same state must
    // produce identical output in step 4 (no path-dependence, since
    // invalidation signals are ignored).
    const { accessor } = mutableAccessor({
      resources: { gold: 100, gems: 10 },
      rates: { gold: 2, gems: 1 },
      unlocks: { 'bronze-unlock': true },
      state: { 'trial.seen': true },
    });
    const { engine } = buildMixedEngine('inc-paths', accessor);
    const inc = createIncrementalSnapshot(engine, accessor);

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
    const { accessor } = mutableAccessor({
      resources: { gold: 0, gems: 0 },
      rates: { gold: 2, gems: 1 },
      unlocks: { 'bronze-unlock': false },
      state: { 'trial.seen': false },
    });
    const { engine } = buildMixedEngine('inc-identity', accessor);
    const inc = createIncrementalSnapshot(engine, accessor);

    const first = inc.rebuild();
    const second = inc.rebuild();
    expect(second).not.toBe(first);
    expect(second.all).toEqual(first.all);
  });

  it('updates `snapshot` getter after rebuild', () => {
    const { accessor, config } = mutableAccessor({
      resources: { gold: 0, gems: 0 },
      rates: { gold: 2, gems: 1 },
      unlocks: { 'bronze-unlock': false },
      state: { 'trial.seen': false },
    });
    const { engine } = buildMixedEngine('inc-getter', accessor);
    const inc = createIncrementalSnapshot(engine, accessor);

    const beforeRebuild = inc.snapshot;
    config.rates.gold = 10;
    const afterRebuild = inc.rebuild();
    expect(inc.snapshot).toBe(afterRebuild);
    expect(inc.snapshot).not.toBe(beforeRebuild);
  });
});
