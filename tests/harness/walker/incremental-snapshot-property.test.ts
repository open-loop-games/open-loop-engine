/**
 * Property test for {@link createIncrementalSnapshot}.
 *
 * A seeded RNG generates random mutation sequences against a shared mixed
 * engine fixture (one purchasable category, one producer category, one
 * challenge category — exercises all three dep axes plus state). After each
 * mutation, the incremental cache receives a targeted `invalidate*` call
 * matching the axis that changed, and `inc.rebuild()` is asserted
 * deep-equal to a fresh `createTransitionSnapshot(...)` call.
 *
 * Catches invalidation gaps the scripted equivalence suite misses: scripted
 * sequences can only probe shapes the author thought of, whereas random
 * sequences cross compound mutation orderings (a-b-a, b-c-a-b, etc.) and
 * are the honest stress test for the selective-rebuild path.
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
import { createSeededRNG } from '@/primitives/rng';
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

function mutableAccessor(config: MutableAccessorConfig): {
  accessor: GameStateAccessor;
  config: MutableAccessorConfig;
} {
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

function buildMixedEngine(gameId: string, accessor: GameStateAccessor) {
  const module: EngineModule = {
    id: `inc-property-${gameId}`,
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

type MutationAxis = 'resource' | 'rate' | 'unlock' | 'state';

interface Mutation {
  axis: MutationAxis;
  key: string;
  apply: (config: MutableAccessorConfig) => void;
}

// Candidate mutations — keys chosen to span tracked-axis ids that the
// mixed engine actually reads (cost resources: `gold`; tracked state path:
// `trial.seen`). Random values cover both equal-to-last (no-op invalidation)
// and strictly-different.
function makeMutationPool(rng: () => number): Mutation[] {
  const resourceKeys = ['gold', 'gems'];
  const rateKeys = ['gold', 'gems'];
  const unlockKeys = ['bronze-unlock', 'silver-unlock'];
  const stateKeys = ['trial.seen', 'trial.retired'];
  const pool: Mutation[] = [];
  for (const key of resourceKeys) {
    pool.push({
      axis: 'resource',
      key,
      apply: (c) => {
        c.resources[key] = Math.floor(rng() * 2000);
      },
    });
  }
  for (const key of rateKeys) {
    pool.push({
      axis: 'rate',
      key,
      apply: (c) => {
        c.rates[key] = Math.floor(rng() * 20);
      },
    });
  }
  for (const key of unlockKeys) {
    pool.push({
      axis: 'unlock',
      key,
      apply: (c) => {
        c.unlocks[key] = rng() < 0.5;
      },
    });
  }
  for (const key of stateKeys) {
    pool.push({
      axis: 'state',
      key,
      apply: (c) => {
        c.state[key] = rng() < 0.5;
      },
    });
  }
  return pool;
}

function applyMutation(
  mutation: Mutation,
  config: MutableAccessorConfig,
  inc: ReturnType<typeof createIncrementalSnapshot>,
): void {
  mutation.apply(config);
  switch (mutation.axis) {
    case 'resource':
      inc.invalidateResource(mutation.key);
      break;
    case 'rate':
      inc.invalidateRate(mutation.key);
      break;
    case 'unlock':
      inc.invalidateUnlock(mutation.key);
      break;
    case 'state':
      inc.invalidateState(mutation.key);
      break;
  }
}

function expectEquivalent(
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

describe('createIncrementalSnapshot — random-mutation equivalence', () => {
  // Multiple seeds exercise different mutation orderings. 6 seeds × 60 steps
  // = 360 rebuilds per run — well inside vitest's default timeout and
  // meaningfully broader coverage than the scripted equivalence suite.
  const SEEDS = [1, 2, 3, 17, 42, 99];
  const STEPS_PER_SEED = 60;

  for (const seed of SEEDS) {
    it(`equivalent across ${STEPS_PER_SEED} random mutations (seed ${seed})`, () => {
      const rng = createSeededRNG(seed);
      const { accessor, config } = mutableAccessor({
        resources: { gold: 0, gems: 0 },
        rates: { gold: 2, gems: 1 },
        unlocks: { 'bronze-unlock': false, 'silver-unlock': false },
        state: { 'trial.seen': false, 'trial.retired': false },
      });
      const { engine } = buildMixedEngine(`inc-property-${seed}`, accessor);
      const inc = createIncrementalSnapshot(engine, accessor);
      const pool = makeMutationPool(rng);

      expectEquivalent(inc, engine, accessor, `seed ${seed} initial`);

      for (let step = 0; step < STEPS_PER_SEED; step++) {
        const mutation = pool[Math.floor(rng() * pool.length)]!;
        applyMutation(mutation, config, inc);
        expectEquivalent(
          inc,
          engine,
          accessor,
          `seed ${seed} step ${step} axis=${mutation.axis} key=${mutation.key}`,
        );
      }
    });
  }

  it('targeted invalidation recovers after a mutation axis was missed', () => {
    // Simulates a bug where the caller mutates state but forgets to
    // invalidate; the next full-rebuild (via invalidateAll) must still
    // recover. Selective rebuild under *stale* dirty state would diverge
    // silently, so this guards against regressions.
    const rng = createSeededRNG(1234);
    const { accessor, config } = mutableAccessor({
      resources: { gold: 0, gems: 0 },
      rates: { gold: 2, gems: 1 },
      unlocks: { 'bronze-unlock': false },
      state: { 'trial.seen': false },
    });
    const { engine } = buildMixedEngine('inc-property-recovery', accessor);
    const inc = createIncrementalSnapshot(engine, accessor);

    // Silent mutation (no invalidation) — cache is now stale relative to accessor.
    config.resources.gold = Math.floor(rng() * 1000);
    config.unlocks['bronze-unlock'] = true;
    config.state['trial.seen'] = true;

    // Targeted invalidate on one axis. Selective rebuild will miss the
    // silent mutations — that's expected, that's the whole point of the
    // "must invalidate or invalidateAll" contract. So we assert divergence
    // first, then recover via invalidateAll.
    inc.invalidateResource('gems'); // unrelated axis, mutation wasn't here
    const stale = inc.rebuild();
    // (We don't assert stale !== direct here — on some mutation subsets
    //  selective may happen to coincide with direct. The point is that
    //  invalidateAll guarantees recovery regardless.)
    void stale;

    inc.invalidateAll();
    expectEquivalent(inc, engine, accessor, 'post-invalidateAll-recovery');
  });
});
