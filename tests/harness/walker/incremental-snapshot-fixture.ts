/**
 * Mixed-engine fixture shared by the incremental-snapshot equivalence and
 * property suites: one category per walker leaf, and challenge gates whose
 * leaves reach every dep axis (resource, rate, unlock, state).
 */

import { expect } from 'vitest';
import { reactive, ref } from 'vue';
import { createEngine, type EngineModule } from '@/index';
import { createResource } from '@/core/resource';
import { createCostRequirement } from '@/core/requirements';
import { createPurchasableCategory } from '@/systems/purchasable-category';
import { createProducerCategory } from '@/systems/producer-category';
import { createChallengeCategory } from '@/systems/challenge-category';
import { bn } from '@/primitives/decimal';
import type { GameStateAccessor } from '@/primitives/types';
import { createIncrementalSnapshot, createTransitionSnapshot } from '@/harness/walker';

export interface MutableAccessorConfig {
  resources: Record<string, number>;
  rates: Record<string, number>;
  unlocks: Record<string, boolean>;
  state: Record<string, unknown>;
}

/** A frozen GameStateAccessor over a plain (non-reactive) config, defaults to all-empty. */
export function mockAccessor(
  config: {
    resources?: Record<string, number>;
    rates?: Record<string, number>;
    unlocks?: Record<string, boolean>;
    state?: Record<string, unknown>;
  } = {},
): GameStateAccessor {
  const resources = config.resources ?? {};
  const rates = config.rates ?? {};
  const unlocks = config.unlocks ?? {};
  const state = config.state ?? {};
  return {
    getAmount: (id) => bn(resources[id] ?? 0),
    getFlag: (id) => unlocks[id] ?? false,
    getState: (path) => state[path],
    getRate: (id) => bn(rates[id] ?? 0),
  };
}

/**
 * Accessor over a reactive config. Writing to `config` stages a mutation, and
 * the challenge computeds that evaluate gates through the accessor re-run as
 * they would over a live engine's resources.
 */
export function mutableAccessor(initial: MutableAccessorConfig): {
  accessor: GameStateAccessor;
  config: MutableAccessorConfig;
} {
  const config = reactive(initial) as MutableAccessorConfig;
  return {
    accessor: {
      getAmount: (id) => bn(config.resources[id] ?? 0),
      getFlag: (id) => config.unlocks[id] ?? false,
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
  limit?: number;
}

/**
 * Engine with upgrades paid in gold under a shared, mutable `upgradeLimit`
 * (initially 1), gem producers paid in gold (one capped), and two challenges:
 *
 * - `bronze` — revealed at 10 gold; startable at 5 gems with the
 *   `bronze-unlock` flag and `trial.seen` state; goal 10 gems; two completions.
 * - `silver` — startable with `silver-unlock`; goal 500 gold unless
 *   `trial.retired` is set.
 */
export function buildMixedEngine(gameId: string, accessor: GameStateAccessor) {
  let upgrades!: ReturnType<typeof createPurchasableCategory<UpgradeDef>>;
  let buildings!: ReturnType<typeof createProducerCategory<BuildingDef>>;
  let trials!: ReturnType<typeof createChallengeCategory>;
  const upgradeLimit = ref(1);

  const module: EngineModule = {
    id: `inc-snapshot-${gameId}`,
    install(ctx) {
      const gold = createResource(0, { id: 'gold', displayName: 'gold' });
      const gems = createResource(0, { id: 'gems', displayName: 'gems' });

      upgrades = createPurchasableCategory<UpgradeDef>({
        id: 'upgrades',
        mapPurchasable: (def) => ({
          display: { description: def.id },
          requirements: [createCostRequirement({ resource: gold, cost: def.cost })],
          limit: upgradeLimit,
        }),
      });
      upgrades.register([
        { id: 'slow', cost: 200 },
        { id: 'fast', cost: 20 },
      ]);

      buildings = createProducerCategory<BuildingDef>({
        id: 'farms',
        mapProducer: (def) => ({
          resource: gems,
          baseRate: def.baseRate,
          trigger: 'continuous',
          purchase: {
            costResource: gold,
            baseCost: def.baseCost,
            costScaling: 1.15,
            limit: def.limit,
          },
        }),
        registerTick: ctx.onTick,
      });
      buildings.register([
        { id: 'wheat', baseRate: 1, baseCost: 50 },
        { id: 'fallow', baseRate: 0, baseCost: 150 },
        { id: 'mill', baseRate: 1, baseCost: 30, limit: 1 },
      ]);

      trials = createChallengeCategory({ id: 'trials', accessor });
      trials.register([
        {
          id: 'bronze',
          name: 'Bronze',
          visible: { kind: 'resource-gte', resource: 'gold', value: 10 },
          canEnter: {
            kind: 'all',
            of: [
              { kind: 'resource-gte', resource: 'gems', value: 5 },
              { kind: 'flag', id: 'bronze-unlock' },
              { kind: 'state', key: 'trial.seen', operator: 'eq', value: true },
            ],
          },
          goal: { kind: 'resource-gte', resource: 'gems', value: 10 },
          completionLimit: 2,
        },
        {
          id: 'silver',
          name: 'Silver',
          canEnter: { kind: 'flag', id: 'silver-unlock' },
          goal: {
            kind: 'any',
            of: [
              { kind: 'resource-gte', resource: 'gold', value: 500 },
              { kind: 'state', key: 'trial.retired', operator: 'eq', value: true },
            ],
          },
        },
      ]);
    },
  };

  const engine = createEngine({ gameId, persistence: false });
  engine.use(module);
  engine.start();
  return { engine, upgrades, upgradeLimit, buildings, trials };
}

/** Deep-equal the incremental rebuild against a fresh full walk. */
export function expectSnapshotsEquivalent(
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

/**
 * A buildMixedEngine + createIncrementalSnapshot pair over a mutableAccessor,
 * with a `check` closure bound to it. `overrides` replaces the default
 * rates/unlocks/state wholesale (not merged) when a case needs a different
 * starting gate state — the entity-gating suite doesn't, the property suite's
 * random-mutation runs do.
 */
export function setup(
  gameId: string,
  resources: MutableAccessorConfig['resources'],
  overrides: Partial<Omit<MutableAccessorConfig, 'resources'>> = {},
) {
  const { accessor, config } = mutableAccessor({
    resources,
    rates: { gold: 2, gems: 1 },
    unlocks: { 'bronze-unlock': true },
    state: { 'trial.seen': true },
    ...overrides,
  });
  const fixture = buildMixedEngine(gameId, accessor);
  const inc = createIncrementalSnapshot(fixture.engine, accessor);
  const check = (label: string) => expectSnapshotsEquivalent(inc, fixture.engine, accessor, label);
  return { ...fixture, accessor, config, inc, check };
}
