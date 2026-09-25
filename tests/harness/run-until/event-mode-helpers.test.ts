import { describe, it, expect, beforeEach } from 'vitest';
import {
  CategoriesKey,
  createEngine,
  type Engine,
  type EngineCategories,
  type EngineModule,
} from '@/index';
import { createResource } from '@/core/resource';
import { createCostRequirement } from '@/core/requirements';
import { createPurchasableCategory } from '@/systems/purchasable-category';
import { createChallengeCategory } from '@/systems/challenge-category';
import { resetAllPersistentContexts } from '@/core/persistence';
import { bn } from '@/primitives/decimal';
import type { GameStateAccessor } from '@/primitives/types';
import { createTransitionSnapshot } from '@/harness';
import { advanceToNextEvent } from '@/harness/run-until-helpers/event-mode';

beforeEach(() => {
  resetAllPersistentContexts();
});

function mockAccessor(
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
    getResource: (id) => bn(resources[id] ?? 0),
    isUnlocked: (id) => unlocks[id] ?? false,
    getState: (path) => state[path],
    getRate: (id) => bn(rates[id] ?? 0),
  };
}

interface UpgradeDef {
  id: string;
  cost: number;
}

function buildEmptyEngine(gameId: string): Engine {
  const engine = createEngine({ gameId, persistence: false });
  engine.start();
  return engine;
}

function buildPurchasableEngine(gameId: string): Engine {
  const module: EngineModule = {
    id: 'upgrades-only',
    install(ctx) {
      const gold = createResource(0, { id: 'gold', displayName: 'gold' });
      const upgrades = createPurchasableCategory<UpgradeDef>({
        id: 'upgrades',
        mapPurchasable: (def) => ({
          display: { description: def.id },
          requirements: [createCostRequirement({ resource: gold, cost: def.cost })],
          limit: 1,
        }),
      });
      upgrades.register([{ id: 'cheap', cost: 20 }]);
      ctx.provide(CategoriesKey, { purchasables: [upgrades] } as EngineCategories);
    },
  };
  const engine = createEngine({ gameId, persistence: false });
  engine.use(module);
  engine.start();
  return engine;
}

function buildOpaqueChallengeEngine(gameId: string, accessor: GameStateAccessor): Engine {
  const module: EngineModule = {
    id: 'opaque-challenge',
    install(ctx) {
      const challenges = createChallengeCategory({ id: 'trials', accessor });
      challenges.register({
        id: 'bronze',
        name: 'Bronze',
        // UnlockCondition → walker emits `reason: 'opaque-predicate'`.
        canStart: { kind: 'flag', id: 'unreachable-flag' },
        goal: () => false,
      });
      ctx.provide(CategoriesKey, { challenges: [challenges] } as EngineCategories);
    },
  };
  const engine = createEngine({ gameId, persistence: false });
  engine.use(module);
  engine.start();
  return engine;
}

describe('advanceToNextEvent', () => {
  it('advances by the smallest finite distance on a reachable snapshot', () => {
    const accessor = mockAccessor({ resources: { gold: 0 }, rates: { gold: 5 } });
    const engine = buildPurchasableEngine('adv-reachable');
    const snap = createTransitionSnapshot(engine, accessor);
    // Walker sees gold=0, rate=5, cost=20 → 4s until affordable.
    expect(snap.all.length).toBeGreaterThan(0);

    const result = advanceToNextEvent(engine, snap, 1, Infinity);
    expect('fired' in result).toBe(true);
    if ('fired' in result) {
      expect(result.advanced).toBeCloseTo(4, 5);
      expect(result.fired.length).toBeGreaterThan(0);
      expect(result.fired[0]!.kind).toBe('becomes-affordable');
    }
  });

  it('floors the advance at tickDelta when the head distance is smaller', () => {
    const accessor = mockAccessor({ resources: { gold: 0 }, rates: { gold: 5 } });
    const engine = buildPurchasableEngine('adv-floor');
    const snap = createTransitionSnapshot(engine, accessor);
    // Walker sees a 4s head distance; floor at a tickDelta well past it.
    const result = advanceToNextEvent(engine, snap, 10, Infinity);
    expect('fired' in result).toBe(true);
    if ('fired' in result) {
      expect(result.advanced).toBe(10);
      // `fired` still reports the transitions tied at the raw head distance,
      // not whatever the walker would see at the floored advance.
      expect(result.fired.length).toBeGreaterThan(0);
      expect(result.fired[0]!.kind).toBe('becomes-affordable');
    }
  });

  it('caps the advance at the remaining budget', () => {
    const accessor = mockAccessor({ resources: { gold: 0 }, rates: { gold: 5 } });
    const engine = buildPurchasableEngine('adv-budget');
    const snap = createTransitionSnapshot(engine, accessor);
    // 4s head distance, floored to 10s, capped at the 2.5s left in the budget.
    const result = advanceToNextEvent(engine, snap, 10, 2.5);
    expect('fired' in result).toBe(true);
    expect(result.advanced).toBe(2.5);
  });

  it('refuses with `no-finite-transition` on an empty snapshot', () => {
    const engine = buildEmptyEngine('adv-empty');
    const snap = createTransitionSnapshot(engine, mockAccessor());
    expect(snap.all).toHaveLength(0);

    const result = advanceToNextEvent(engine, snap, 1, Infinity);
    expect(result).toEqual({ advanced: 0, reason: 'no-finite-transition' });
  });

  it('refuses with `no-finite-transition` when every transition is null-distance non-opaque', () => {
    // rate=0 → walker emits `reason: 'no-rate'` for the purchasable. No opaque
    // transitions in snapshot, but no finite head either.
    const accessor = mockAccessor({ resources: { gold: 0 }, rates: { gold: 0 } });
    const engine = buildPurchasableEngine('adv-no-rate');
    const snap = createTransitionSnapshot(engine, accessor);
    expect(snap.all.length).toBeGreaterThan(0);
    expect(snap.all[0]!.distance.seconds).toBeNull();

    const result = advanceToNextEvent(engine, snap, 1, Infinity);
    expect(result).toEqual({ advanced: 0, reason: 'no-finite-transition' });
  });

  it('refuses with `opaque-present` when any transition is opaque-predicate', () => {
    const accessor = mockAccessor();
    const engine = buildOpaqueChallengeEngine('adv-opaque', accessor);
    const snap = createTransitionSnapshot(engine, accessor);
    // Every emission on the opaque challenge is opaque-predicate.
    expect(snap.all.some((t) => t.distance.reason === 'opaque-predicate')).toBe(true);

    const result = advanceToNextEvent(engine, snap, 1, Infinity);
    expect(result).toEqual({ advanced: 0, reason: 'opaque-present' });
  });
});
