import { describe, it, expect, beforeEach } from 'vitest';
import { CategoriesKey, createEngine, type EngineCategories, type EngineModule } from '@/index';
import { createResource } from '@/core/resource';
import { createCostRequirement } from '@/core/requirements';
import { createProducerCategory } from '@/systems/producer-category';
import { createPurchasableCategory } from '@/systems/purchasable-category';
import { createChallengeCategory } from '@/systems/challenge-category';
import { resetAllPersistentContexts } from '@/core/persistence';
import { bn } from '@/primitives/decimal';
import type { GameStateAccessor } from '@/primitives/types';
import type { TransitionDeps } from '@/core/transitions';
import { emitProducerTransitionsWithDeps } from '@/harness/walker/walk-producer-transitions';
import { emitPurchasableTransitionsWithDeps } from '@/harness/walker/walk-purchasable-transitions';
import { emitChallengeTransitionsWithDeps } from '@/harness/walker/walk-challenge-transitions';

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

/** Order-insensitive projection of a TransitionDeps for equality matching. */
function shape(deps: TransitionDeps) {
  return {
    resources: [...deps.resources].sort(),
    rates: [...deps.rates].sort(),
    unlocks: [...deps.unlocks].sort(),
    states: [...deps.states].sort(),
  };
}

// ---------------------------------------------------------------------------
// Producer — single cost resource
// ---------------------------------------------------------------------------

describe('emitProducerTransitionsWithDeps', () => {
  interface BuildingDef {
    id: string;
    baseRate: number;
    baseCost: number;
  }

  function buildEngine(costResourceName: string, defs: BuildingDef[]) {
    const module: EngineModule = {
      id: 'producers-mod',
      install(ctx) {
        const resource = createResource(0, { id: costResourceName, displayName: costResourceName });
        const category = createProducerCategory<BuildingDef>({
          id: 'buildings',
          mapProducer: (def) => ({
            resource,
            baseRate: def.baseRate,
            trigger: 'continuous',
            purchase: {
              costResource: resource,
              baseCost: def.baseCost,
              costScaling: 1.15,
            },
          }),
          registerTick: ctx.onTick,
        });
        category.register(defs);
        ctx.provide(CategoriesKey, { producers: [category] } as EngineCategories);
      },
    };
    const engine = createEngine({ gameId: 'tdeps-producer', persistence: false });
    engine.use(module);
    engine.start();
    return engine;
  }

  it('emits deps naming the cost resource in both resources and rates', () => {
    const engine = buildEngine('cookies', [{ id: 'cursor', baseRate: 1, baseCost: 10 }]);
    const accessor = mockAccessor({ resources: { cookies: 0 }, rates: { cookies: 2 } });

    const out = emitProducerTransitionsWithDeps(engine, accessor);
    expect(out).toHaveLength(1);

    const [entry] = out;
    expect(entry.transition.label).toBe('buildings.cursor.producer-becomes-affordable');
    expect(shape(entry.deps)).toEqual({
      resources: ['cookies'],
      rates: ['cookies'],
      unlocks: [],
      states: [],
    });
  });

  it('reports independent dep sets per producer — no cross-sharing of Set instances', () => {
    const engine = buildEngine('cookies', [
      { id: 'cursor', baseRate: 1, baseCost: 10 },
      { id: 'grandma', baseRate: 5, baseCost: 100 },
    ]);
    const accessor = mockAccessor({ resources: { cookies: 0 }, rates: { cookies: 1 } });

    const out = emitProducerTransitionsWithDeps(engine, accessor);
    expect(out).toHaveLength(2);
    // Each entry owns its deps — mutating one must not bleed into another.
    expect(out[0].deps.resources).not.toBe(out[1].deps.resources);
    expect(out[0].deps.rates).not.toBe(out[1].deps.rates);
  });
});

// ---------------------------------------------------------------------------
// Purchasable — multi-cost (first requirement wins)
// ---------------------------------------------------------------------------

describe('emitPurchasableTransitionsWithDeps', () => {
  interface UpgradeDef {
    id: string;
    primaryCost: number;
    secondaryCost: number;
  }

  function buildEngine(defs: UpgradeDef[], secondaryName: string) {
    const module: EngineModule = {
      id: 'purchasables-mod',
      install(ctx) {
        const primary = createResource(0, { id: 'gold', displayName: 'gold' });
        const secondary = createResource(0, { id: secondaryName, displayName: secondaryName });
        const category = createPurchasableCategory<UpgradeDef>({
          id: 'upgrades',
          mapPurchasable: (def) => ({
            display: { description: def.id },
            requirements: [
              createCostRequirement({ resource: primary, cost: def.primaryCost }),
              createCostRequirement({ resource: secondary, cost: def.secondaryCost }),
            ],
            limit: 1,
          }),
        });
        category.register(defs);
        ctx.provide(CategoriesKey, { purchasables: [category] } as EngineCategories);
      },
    };
    const engine = createEngine({ gameId: 'tdeps-purchasable', persistence: false });
    engine.use(module);
    engine.start();
    return engine;
  }

  it('names only the first cost requirement resource — per walker convention', () => {
    const engine = buildEngine([{ id: 'upgrade-a', primaryCost: 100, secondaryCost: 50 }], 'wood');
    // Give positive rate on both so the transition is computed, then verify
    // the second cost's resource does NOT appear in deps.
    const accessor = mockAccessor({
      resources: { gold: 0, wood: 0 },
      rates: { gold: 10, wood: 5 },
    });

    const out = emitPurchasableTransitionsWithDeps(engine, accessor);
    const affordable = out.find((e) => e.transition.kind === 'becomes-affordable');
    expect(affordable).toBeDefined();
    expect(shape(affordable!.deps)).toEqual({
      resources: ['gold'],
      rates: ['gold'],
      unlocks: [],
      states: [],
    });
    // Sanity: wood appears nowhere in the dep set despite being a real
    // cost — the walker only meters against the first requirement.
    expect(affordable!.deps.resources.has('wood')).toBe(false);
    expect(affordable!.deps.rates.has('wood')).toBe(false);
  });

  it('paired purchasable-maxed shares the same dep set as becomes-affordable', () => {
    // limit: 1 triggers the maxed-shadow emission on the very first purchase.
    const engine = buildEngine([{ id: 'upgrade-a', primaryCost: 100, secondaryCost: 50 }], 'wood');
    const accessor = mockAccessor({
      resources: { gold: 0, wood: 0 },
      rates: { gold: 10, wood: 5 },
    });

    const out = emitPurchasableTransitionsWithDeps(engine, accessor);
    const affordable = out.find((e) => e.transition.kind === 'becomes-affordable');
    const maxed = out.find((e) => e.transition.kind === 'purchasable-maxed');
    expect(affordable).toBeDefined();
    expect(maxed).toBeDefined();
    expect(shape(affordable!.deps)).toEqual(shape(maxed!.deps));
  });
});

// ---------------------------------------------------------------------------
// Challenge — AND / OR / NOT over resources + unlocks + state paths
// ---------------------------------------------------------------------------

describe('emitChallengeTransitionsWithDeps', () => {
  function buildEngine(
    register: (category: ReturnType<typeof createChallengeCategory>) => void,
    accessor: GameStateAccessor,
  ) {
    const module: EngineModule = {
      id: 'challenges-mod',
      install(ctx) {
        const challenges = createChallengeCategory({
          id: 'trials',
          mutuallyExclusive: true,
          accessor,
        });
        register(challenges);
        ctx.provide(CategoriesKey, { challenges: [challenges] } as EngineCategories);
      },
    };
    const engine = createEngine({ gameId: 'tdeps-challenge', persistence: false });
    engine.use(module);
    engine.start();
    return engine;
  }

  it('visibility condition: AND of resource and unlock leaks both into deps', () => {
    const accessor = mockAccessor({
      resources: { gold: 40 },
      rates: { gold: 2 },
      unlocks: { smithing: false },
    });
    const engine = buildEngine((c) => {
      c.register({
        id: 'secret',
        name: 'Secret',
        visible: {
          kind: 'all',
          of: [
            { kind: 'resource-gte', resource: 'gold', value: 100 },
            { kind: 'flag', id: 'smithing' },
          ],
        },
      });
    }, accessor);

    const out = emitChallengeTransitionsWithDeps(engine, accessor);
    const vis = out.find((e) => e.transition.kind === 'visibility-reveal');
    expect(vis).toBeDefined();
    expect(shape(vis!.deps)).toEqual({
      resources: ['gold'],
      rates: ['gold'],
      unlocks: ['smithing'],
      states: [],
    });
  });

  it('start-unlock condition: OR with a state path registers the state dep', () => {
    const accessor = mockAccessor({
      resources: { mana: 10 },
      rates: { mana: 1 },
      state: { 'player.phase': 'idle' },
    });
    const engine = buildEngine((c) => {
      c.register({
        id: 'gated',
        name: 'Gated',
        canStart: {
          kind: 'any',
          of: [
            { kind: 'resource-gte', resource: 'mana', value: 20 },
            { kind: 'state', key: 'player.phase', operator: 'eq', value: 'combat' },
          ],
        },
      });
    }, accessor);

    const out = emitChallengeTransitionsWithDeps(engine, accessor);
    const unlock = out.find((e) => e.transition.kind === 'start-unlock');
    expect(unlock).toBeDefined();
    expect(shape(unlock!.deps)).toEqual({
      resources: ['mana'],
      rates: ['mana'],
      unlocks: [],
      states: ['player.phase'],
    });
  });

  it('goal condition: NOT over resource keeps the inner target in deps', () => {
    const accessor = mockAccessor({ resources: { xp: 20 }, rates: { xp: 2 } });
    const engine = buildEngine((c) => {
      c.register({
        id: 'survive',
        name: 'Survive',
        // Challenge succeeds when xp is NOT below 100 — i.e. xp >= 100.
        goal: {
          kind: 'not',
          of: { kind: 'resource-gte', resource: 'xp', value: 100 },
        },
      });
    }, accessor);
    const challenges = (engine.tryInject(CategoriesKey) as EngineCategories).challenges![0];
    challenges.getChallenge('survive')!.enter();

    const out = emitChallengeTransitionsWithDeps(engine, accessor);
    const goal = out.find((e) => e.transition.kind === 'goal-complete');
    expect(goal).toBeDefined();
    expect(shape(goal!.deps)).toEqual({
      resources: ['xp'],
      rates: ['xp'],
      unlocks: [],
      states: [],
    });
  });

  it('goal-complete and paired challenge-maxed share the same goal-dep set', () => {
    const accessor = mockAccessor({ resources: { xp: 20 }, rates: { xp: 2 } });
    const engine = buildEngine((c) => {
      c.register({
        id: 'once',
        name: 'Once',
        goal: { kind: 'resource-gte', resource: 'xp', value: 100 },
        completionLimit: 1,
      });
    }, accessor);
    const challenges = (engine.tryInject(CategoriesKey) as EngineCategories).challenges![0];
    challenges.getChallenge('once')!.enter();

    const out = emitChallengeTransitionsWithDeps(engine, accessor);
    const goal = out.find((e) => e.transition.kind === 'goal-complete');
    const maxed = out.find((e) => e.transition.kind === 'challenge-maxed');
    expect(goal).toBeDefined();
    expect(maxed).toBeDefined();
    expect(shape(goal!.deps)).toEqual(shape(maxed!.deps));
  });

  it('nested AND/OR/NOT tree collects every leaf axis', () => {
    const accessor = mockAccessor({
      resources: { gold: 0, wood: 0 },
      rates: { gold: 1, wood: 1 },
      unlocks: { smithing: false },
      state: { 'player.phase': 'idle' },
    });
    const engine = buildEngine((c) => {
      c.register({
        id: 'deep',
        name: 'Deep',
        visible: {
          kind: 'all',
          of: [
            {
              kind: 'any',
              of: [
                { kind: 'resource-gte', resource: 'gold', value: 10 },
                {
                  kind: 'not',
                  of: { kind: 'resource-gte', resource: 'wood', value: 5 },
                },
              ],
            },
            {
              kind: 'all',
              of: [
                { kind: 'flag', id: 'smithing' },
                { kind: 'state', key: 'player.phase', operator: 'eq', value: 'combat' },
              ],
            },
          ],
        },
      });
    }, accessor);

    const out = emitChallengeTransitionsWithDeps(engine, accessor);
    const vis = out.find((e) => e.transition.kind === 'visibility-reveal');
    expect(vis).toBeDefined();
    expect(shape(vis!.deps)).toEqual({
      resources: ['gold', 'wood'],
      rates: ['gold', 'wood'],
      unlocks: ['smithing'],
      states: ['player.phase'],
    });
  });
});
