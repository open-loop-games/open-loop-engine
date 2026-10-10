import { describe, it, expect, beforeEach } from 'vitest';
import { createEngine, type EngineModule } from '@/index';
import { createResource } from '@/core/resource';
import { createCostRequirement } from '@/core/requirements';
import { createPurchasableCategory } from '@/systems/purchasable-category';
import { createProducerCategory } from '@/systems/producer-category';
import { createChallengeCategory } from '@/systems/challenge-category';
import { resetAllPersistentContexts } from '@/core/persistence';
import type { GameStateAccessor } from '@/primitives/types';
import { createTransitionSnapshot, type Transition } from '@/harness/walker';
import { mockAccessor } from './incremental-snapshot-fixture';

beforeEach(() => {
  resetAllPersistentContexts();
});

// ---------------------------------------------------------------------------
// Degenerate inputs
// ---------------------------------------------------------------------------

describe('createTransitionSnapshot — discovery degradation', () => {
  it('returns an empty snapshot when the engine built no categories', () => {
    const engine = createEngine({ gameId: 'bts-no-key', persistence: false });
    engine.start();
    const snap = createTransitionSnapshot(engine, mockAccessor());
    expect(snap.all).toEqual([]);
    expect(snap.challenges).toEqual([]);
    expect(snap.purchasables).toEqual([]);
    expect(snap.producers).toEqual([]);
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
    const engine = createEngine({ gameId: 'bts-empty', persistence: false });
    engine.use(module);
    engine.start();
    const snap = createTransitionSnapshot(engine, mockAccessor());
    expect(snap.all).toEqual([]);
    expect(snap.challenges).toEqual([]);
    expect(snap.purchasables).toEqual([]);
    expect(snap.producers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Merge + sort + grouping
// ---------------------------------------------------------------------------

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
 * Build an engine that publishes one category each of purchasables,
 * producers, and challenges so the merger has representatives from all three
 * leaves to sort together. The challenge category receives `accessor` so its
 * `ICondition` gates evaluate against the same state the walker reads.
 */
function buildMergeEngine(gameId: string, accessor: GameStateAccessor) {
  const module: EngineModule = {
    id: 'mixed-content',
    install(ctx) {
      const gold = createResource(0, { id: 'gold', displayName: 'gold' });
      const gems = createResource(0, { id: 'gems', displayName: 'gems' });

      // Purchasables: two upgrades at different gold costs to produce two
      // distinct becomes-affordable distances.
      const upgrades = createPurchasableCategory<UpgradeDef>({
        id: 'upgrades',
        mapPurchasable: (def) => ({
          display: { description: def.id },
          requirements: [createCostRequirement({ resource: gold, cost: def.cost })],
          limit: 1,
        }),
      });
      upgrades.register([
        { id: 'slow', cost: 200 }, // gold rate 2/s → 100s
        { id: 'fast', cost: 20 }, //  gold rate 2/s →  10s
      ]);

      // Producers: distances now derive from accessor-reported cost-resource
      // rate (gold), not producer output. Two entries at the same gold cost
      // exercise the tie-break path; baseRate differences are irrelevant to
      // the walker's emission for cost-resource-rate-based distances.
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

      // Challenges: declarative `canEnter` keyed on gems; the merger's
      // accessor reports rates the walker turns into a distance.
      const challenges = createChallengeCategory({
        id: 'trials',
        accessor,
      });
      challenges.register({
        id: 'bronze',
        displayName: 'Bronze',
        canEnter: { kind: 'resource-gte', resource: 'gems', value: 5 }, // gems rate 1/s → 5s
        goal: { kind: 'resource-gte', resource: 'gems', value: 10 },
      });
    },
  };

  const engine = createEngine({ gameId, persistence: false });
  engine.use(module);
  engine.start();
  return { engine };
}

describe('createTransitionSnapshot — merge + sort', () => {
  it('merges all three leaves and sorts finite distances ascending', () => {
    const accessor = mockAccessor({
      resources: { gold: 0, gems: 0 },
      rates: { gold: 2, gems: 1 },
    });
    const { engine } = buildMergeEngine('bts-merge', accessor);

    const snap = createTransitionSnapshot(engine, accessor);

    // Expected finite emissions, ordered ascending by seconds:
    //  - trials.bronze.becomes-enterable                  gems (5-0)/1   =   5s
    //  - upgrades.fast.becomes-affordable            gold (20-0)/2  =  10s
    //  - farms.wheat.producer-becomes-affordable     gold (50-0)/2  =  25s
    //  - farms.fallow.producer-becomes-affordable    gold (150-0)/2 =  75s
    //  - upgrades.slow.becomes-affordable            gold (200-0)/2 = 100s
    const kinds = snap.all.map((t) => ({
      source: t.walker,
      kind: t.kind,
      defId: t.defId,
      seconds: t.distance.seconds,
      reason: t.distance.reason,
    }));

    // Pull out the affordability ones and verify the order we care about.
    const finite = snap.all.filter((t) => t.distance.seconds !== null);
    const finiteSeconds = finite.map((t) => t.distance.seconds as number);
    expect(finiteSeconds).toEqual([...finiteSeconds].sort((a, b) => a - b));

    // Null distances come at the tail.
    const firstNullIndex = snap.all.findIndex((t) => t.distance.seconds === null);
    if (firstNullIndex !== -1) {
      const tail = snap.all.slice(firstNullIndex);
      expect(tail.every((t) => t.distance.seconds === null)).toBe(true);
    }

    // Each of the three leaves contributes to the snapshot.
    expect(snap.challenges.length).toBeGreaterThan(0);
    expect(snap.purchasables.length).toBeGreaterThan(0);
    expect(snap.producers.length).toBeGreaterThan(0);

    // Group arrays preserve the merged order (subsequence of `all`).
    assertGroupsAreSubsequencesOfAll(snap, kinds);
  });

  it('sorts null-distance transitions by label (deterministic tie-break)', () => {
    // Purchasables + challenges only, rates all zero → every leaf's distances
    // collapse to null/no-rate.
    const accessor = mockAccessor({
      resources: { gold: 0, gems: 0 },
      rates: { gold: 0, gems: 0 },
    });
    const module: EngineModule = {
      id: 'nulls-only',
      install() {
        const gold = createResource(0, { id: 'gold', displayName: 'gold' });
        const upgrades = createPurchasableCategory<UpgradeDef>({
          id: 'upgrades',
          mapPurchasable: (def) => ({
            display: { description: def.id },
            requirements: [createCostRequirement({ resource: gold, cost: def.cost })],
            limit: 1,
          }),
        });
        upgrades.register([
          { id: 'zeta', cost: 5 },
          { id: 'alpha', cost: 10 },
        ]);

        const challenges = createChallengeCategory({ id: 'trials', accessor });
        challenges.register({
          id: 'bronze',
          displayName: 'Bronze',
          canEnter: { kind: 'resource-gte', resource: 'gems', value: 5 },
          goal: () => false,
        });
      },
    };
    const engine = createEngine({ gameId: 'bts-nulls', persistence: false });
    engine.use(module);
    engine.start();

    const snap = createTransitionSnapshot(engine, accessor);
    expect(snap.all.length).toBeGreaterThan(1);
    expect(snap.all.every((t) => t.distance.seconds === null)).toBe(true);

    // Within the null group, labels are ascending.
    const labels = snap.all.map((t) => t.label);
    expect(labels).toEqual([...labels].sort());
  });

  it('tie-breaks equal finite seconds by label', () => {
    // Engine with two upgrades at the same cost → same distance; label
    // ascending ('alpha' < 'beta') must decide order.
    const module: EngineModule = {
      id: 'tie-upgrades',
      install() {
        const gold = createResource(0, { id: 'gold', displayName: 'gold' });
        const cat = createPurchasableCategory<UpgradeDef>({
          id: 'upgrades',
          mapPurchasable: (def) => ({
            display: { description: def.id },
            requirements: [createCostRequirement({ resource: gold, cost: def.cost })],
            limit: 1,
          }),
        });
        cat.register([
          { id: 'beta', cost: 10 },
          { id: 'alpha', cost: 10 },
        ]);
      },
    };
    const engine = createEngine({ gameId: 'bts-tie', persistence: false });
    engine.use(module);
    engine.start();

    const accessor = mockAccessor({ resources: { gold: 0 }, rates: { gold: 1 } });
    const snap = createTransitionSnapshot(engine, accessor);
    const affordable = snap.purchasables.filter((t) => t.kind === 'becomes-affordable');
    expect(affordable.map((t) => t.defId)).toEqual(['alpha', 'beta']);
  });
});

function assertGroupsAreSubsequencesOfAll(
  snap: {
    all: readonly Transition[];
    challenges: readonly Transition[];
    purchasables: readonly Transition[];
    producers: readonly Transition[];
  },
  _debug: unknown,
): void {
  const byIdentity = new Map<Transition, number>();
  snap.all.forEach((t, i) => byIdentity.set(t, i));
  const check = (group: readonly Transition[]) => {
    let prev = -1;
    for (const t of group) {
      const idx = byIdentity.get(t);
      expect(idx, 'group entry must exist in `all`').toBeDefined();
      expect(idx).toBeGreaterThan(prev);
      prev = idx as number;
    }
  };
  check(snap.challenges);
  check(snap.purchasables);
  check(snap.producers);
}
