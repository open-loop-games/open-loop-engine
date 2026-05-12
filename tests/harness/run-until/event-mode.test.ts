import { describe, it, expect, beforeEach } from 'vitest';
import {
  CategoriesKey,
  createEngine,
  type Engine,
  type EngineCategories,
  type EngineModule,
} from '@/index';
import { addResource, createResource } from '@/core/resource';
import { createMemoryStorage } from '@/core/save-manager';
import { createCostRequirement } from '@/core/requirements';
import { createPurchasableCategory } from '@/systems/purchasable-category';
import { createChallengeCategory } from '@/systems/challenge-category';
import { C } from '@/core/conditions';
import { resetAllPersistentContexts } from '@/core/persistence';
import { bn } from '@/primitives/decimal';
import type { GameStateAccessor } from '@/primitives/types';
import { runProbe } from '@/harness';
import type { BeatProbe } from '@/harness';

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

/** No categories — walker emits empty snapshot → refuse → tick-fallback. */
function buildEmptyEngine(gameId: string): Engine {
  resetAllPersistentContexts();
  const engine = createEngine({ gameId, persistence: false });
  engine.start();
  return engine;
}

/**
 * Purchasable engine. Walker emits a finite-distance `becomes-affordable`
 * transition based on the accessor's reported rate — the mock accessor is
 * stateless, so each snapshot rebuilds with the same distance, making the
 * probe advance by that dt per iteration (suitable for deterministic tests).
 */
function buildPurchasableEngine(gameId: string): Engine {
  resetAllPersistentContexts();
  const module: EngineModule = {
    id: 'upgrades-only',
    install(ctx) {
      const gold = createResource(0, { displayName: 'gold' });
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

/** UnlockCondition gate → every walker emission is `reason: 'opaque-predicate'`. */
function buildOpaqueChallengeEngine(gameId: string, accessor: GameStateAccessor): Engine {
  resetAllPersistentContexts();
  const module: EngineModule = {
    id: 'opaque-challenge',
    install(ctx) {
      const challenges = createChallengeCategory({ id: 'trials', accessor });
      challenges.register({
        id: 'bronze',
        name: 'Bronze',
        canStart: C.unlock('unreachable-flag'),
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

describe("runProbe({mode: 'event'})", () => {
  it('steps by walker-visible event distance and terminates on predicate', () => {
    // Accessor reports gold=0, rate=5, cost=20 → 4s per event.
    const accessor = mockAccessor({ resources: { gold: 0 }, rates: { gold: 5 } });
    // Predicate: fire on the 4th evaluation. The probe evaluates it once per
    // loop iteration (predicate-first), so:
    //   iter 1 (simTime=0)  → false, advance 4s
    //   iter 2 (simTime=4)  → false, advance 4s
    //   iter 3 (simTime=8)  → false, advance 4s
    //   iter 4 (simTime=12) → true, terminate
    let calls = 0;
    const beat: BeatProbe = {
      id: 'fire-on-4th',
      predicate: () => ++calls >= 4,
    };

    const results = runProbe({
      mode: 'event',
      buildEngine: ({ seed }) => buildPurchasableEngine(`event-reachable-${seed}`),
      buildAccessor: () => accessor,
      beats: [beat],
      seeds: [1],
      maxSimTime: 100,
      tickDelta: 1,
    });

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.counts).toEqual({ predicate: 1, maxSimTime: 0, unreachable: 0 });
    expect(r.terminationTime).toBeDefined();
    expect(r.terminationTime!.avg).toBeCloseTo(12, 5);
  });

  it('fast-ticks through no-finite-transition stasis without rebuilding walker', () => {
    const beat: BeatProbe = { id: 'never-fires', predicate: () => false };

    const results = runProbe({
      mode: 'event',
      buildEngine: ({ seed }) => buildEmptyEngine(`event-empty-${seed}`),
      buildAccessor: () => mockAccessor(),
      beats: [beat],
      seeds: [1, 2],
      maxSimTime: 5,
      tickDelta: 1,
    });

    // Walker emits no finite transition every rebuild. Fast-tick carries the
    // run through budget without ever exiting stasis — event-mode classifies
    // the run as `unreachable` (terminated propagates through runUntil's
    // result into BeatResult.counts).
    expect(results[0]!.counts).toEqual({ predicate: 0, maxSimTime: 0, unreachable: 2 });
    expect(results[0]!.terminationTime).toBeUndefined();
  });

  it('fast-tick still fires the predicate when a non-walker rate source advances state', () => {
    // Regression guard: an earlier version short-circuited on
    // no-finite-transition, causing false negatives for runs that would fire
    // via clicks / onTick subscribers not enumerated by the walker. This
    // fixture simulates that with a tick-handler that flips a flag after
    // enough ticks.
    resetAllPersistentContexts();
    let flipTick = 0;
    const flipAt = 3;
    const flag = { fired: false };
    const module: EngineModule = {
      id: 'non-walker-input',
      install(ctx) {
        ctx.onTick(() => {
          flipTick++;
          if (flipTick >= flipAt) flag.fired = true;
        });
      },
    };
    const engine = createEngine({ gameId: 'fast-tick-flip', persistence: false });
    engine.use(module);
    engine.start();

    const beat: BeatProbe = { id: 'flag-fires', predicate: () => flag.fired };
    const results = runProbe({
      mode: 'event',
      buildEngine: () => engine,
      buildAccessor: () => mockAccessor(),
      beats: [beat],
      seeds: [1],
      maxSimTime: 100,
      tickDelta: 1,
    });

    expect(results[0]!.counts).toEqual({ predicate: 1, maxSimTime: 0, unreachable: 0 });
    expect(results[0]!.terminationTime).toBeDefined();
  });

  it('tick-fallbacks when an opaque transition is present', () => {
    const accessor = mockAccessor();
    const beat: BeatProbe = { id: 'never-fires', predicate: () => false };

    const results = runProbe({
      mode: 'event',
      buildEngine: ({ seed }) => buildOpaqueChallengeEngine(`event-opaque-${seed}`, accessor),
      buildAccessor: () => accessor,
      beats: [beat],
      seeds: [1, 2],
      maxSimTime: 5,
      tickDelta: 1,
    });

    // Opaque-present refuse → tick-fallback at tickDelta=1 → 5 ticks to maxSimTime.
    expect(results[0]!.counts).toEqual({ predicate: 0, maxSimTime: 2, unreachable: 0 });
    expect(results[0]!.terminationTime).toBeUndefined();
  });

  it('fast-ticks through zero-distance-tie refuses without rebuilding walker', () => {
    // Purchasable is already affordable (gold >= cost), so the walker
    // surfaces the `becomes-affordable` transition at distance=0. The probe
    // does not execute it (no auto-purchase). Without the tie fast-tick this looped at
    // full walker cost per iteration; the tie fast-tick carries the run
    // through budget at tickDelta without rebuilding each iteration.
    const accessor = mockAccessor({ resources: { gold: 100 }, rates: { gold: 0 } });
    const beat: BeatProbe = { id: 'never-fires', predicate: () => false };

    const results = runProbe({
      mode: 'event',
      buildEngine: ({ seed }) => buildPurchasableEngine(`event-tie-${seed}`),
      buildAccessor: () => accessor,
      beats: [beat],
      seeds: [1, 2],
      maxSimTime: 5,
      tickDelta: 1,
    });

    expect(results[0]!.counts).toEqual({ predicate: 0, maxSimTime: 2, unreachable: 0 });
    expect(results[0]!.terminationTime).toBeUndefined();
  });

  it('tie fast-tick still fires the predicate when a non-walker rate source advances state', () => {
    // Regression guard: an already-affordable purchase stays tied across
    // rebuilds, but a non-walker `ctx.onTick` subscriber mutates state that
    // flips the predicate. Must not false-negate — the fast-tick is allowed
    // to short-circuit walker rebuilds, never predicate checks.
    resetAllPersistentContexts();
    let tickCount = 0;
    const fireAt = 3;
    const flag = { fired: false };
    const module: EngineModule = {
      id: 'tie-with-non-walker-input',
      install(ctx) {
        const gold = createResource(100, { displayName: 'gold' });
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
        ctx.onTick(() => {
          tickCount++;
          if (tickCount >= fireAt) flag.fired = true;
        });
      },
    };
    const engine = createEngine({ gameId: 'tie-flip', persistence: false });
    engine.use(module);
    engine.start();

    // Accessor reports gold=100 and rate=0 — purchasable stays tied at
    // distance=0 every rebuild. Only the onTick handler can fire the flag.
    const accessor = mockAccessor({ resources: { gold: 100 }, rates: { gold: 0 } });
    const beat: BeatProbe = { id: 'flag-fires', predicate: () => flag.fired };
    const results = runProbe({
      mode: 'event',
      buildEngine: () => engine,
      buildAccessor: () => accessor,
      beats: [beat],
      seeds: [1],
      maxSimTime: 100,
      tickDelta: 1,
    });

    expect(results[0]!.counts).toEqual({ predicate: 1, maxSimTime: 0, unreachable: 0 });
    expect(results[0]!.terminationTime).toBeDefined();
  });

  it('bisects fire time within tolerance when advance overshoots predicate', () => {
    // Walker-visible rate matches the onTick-driven accumulation, so the
    // walker emits a single `becomes-affordable` transition at 100s. The
    // beat predicate, however, fires on gold >= 10 — i.e., 10s into the
    // advance. Without bisect, `simTime` records the end of the advance
    // (≈100s). With `bisectTolSec: 0.5`, it should converge within ±0.5s
    // of the true fire time.
    resetAllPersistentContexts();
    let goldRef: ReturnType<typeof createResource<number>> | null = null;
    const module: EngineModule = {
      id: 'gold-accumulator',
      install(ctx) {
        const gold = createResource(0, { displayName: 'gold' });
        goldRef = gold;
        const upgrades = createPurchasableCategory<UpgradeDef>({
          id: 'upgrades',
          mapPurchasable: (def) => ({
            display: { description: def.id },
            requirements: [createCostRequirement({ resource: gold, cost: def.cost })],
            limit: 1,
          }),
        });
        upgrades.register([{ id: 'big', cost: 100 }]);
        ctx.provide(CategoriesKey, { purchasables: [upgrades] } as EngineCategories);
        ctx.onTick((dt) => {
          addResource(gold, dt);
        });
      },
    };
    const engine = createEngine({
      gameId: 'bisect-overshoot',
      storageAdapter: createMemoryStorage(),
      maxDeltaTime: 1000,
    });
    engine.use(module);
    engine.start();

    const accessor = mockAccessor({ resources: { gold: 0 }, rates: { gold: 1 } });
    const beat: BeatProbe = {
      id: 'gold-hits-10',
      predicate: () => bn(goldRef!.value).gte(10),
    };

    const tol = 0.5;
    const results = runProbe({
      mode: 'event',
      buildEngine: () => engine,
      buildAccessor: () => accessor,
      beats: [beat],
      seeds: [1],
      maxSimTime: 200,
      tickDelta: 1,
      bisectTolSec: tol,
    });

    expect(results[0]!.counts).toEqual({ predicate: 1, maxSimTime: 0, unreachable: 0 });
    const fireTime = results[0]!.terminationTime!.avg;
    // True fire time is 10s. Bisect converges within tol; allow one tol of
    // slack for the upper-bound leaving heuristic.
    expect(fireTime).toBeGreaterThanOrEqual(10 - tol);
    expect(fireTime).toBeLessThanOrEqual(10 + tol);
  });

  it('falls back to advance-end fire time without bisectTolSec', () => {
    // Same setup as the bisect test but with `bisectTolSec` unset — the
    // `simTime` should record the full advance distance (≈100s), not the
    // true fire time of ≈10s. This pins the no-bisect behavior so a future
    // change to default-on bisect is an intentional choice, not silent.
    resetAllPersistentContexts();
    let goldRef: ReturnType<typeof createResource<number>> | null = null;
    const module: EngineModule = {
      id: 'gold-accumulator-nobisect',
      install(ctx) {
        const gold = createResource(0, { displayName: 'gold' });
        goldRef = gold;
        const upgrades = createPurchasableCategory<UpgradeDef>({
          id: 'upgrades',
          mapPurchasable: (def) => ({
            display: { description: def.id },
            requirements: [createCostRequirement({ resource: gold, cost: def.cost })],
            limit: 1,
          }),
        });
        upgrades.register([{ id: 'big', cost: 100 }]);
        ctx.provide(CategoriesKey, { purchasables: [upgrades] } as EngineCategories);
        ctx.onTick((dt) => {
          addResource(gold, dt);
        });
      },
    };
    const engine = createEngine({
      gameId: 'bisect-overshoot-off',
      storageAdapter: createMemoryStorage(),
      maxDeltaTime: 1000,
    });
    engine.use(module);
    engine.start();

    const accessor = mockAccessor({ resources: { gold: 0 }, rates: { gold: 1 } });
    const beat: BeatProbe = {
      id: 'gold-hits-10',
      predicate: () => bn(goldRef!.value).gte(10),
    };

    const results = runProbe({
      mode: 'event',
      buildEngine: () => engine,
      buildAccessor: () => accessor,
      beats: [beat],
      seeds: [1],
      maxSimTime: 200,
      tickDelta: 1,
    });

    expect(results[0]!.counts).toEqual({ predicate: 1, maxSimTime: 0, unreachable: 0 });
    // Without bisect, the probe records post-advance simTime = 100s.
    expect(results[0]!.terminationTime!.avg).toBeCloseTo(100, 1);
  });

  it('terminates as maxSimTime when predicate never fires and events keep coming', () => {
    // Same reachable snapshot as the success case, but hard-false predicate.
    // Events at 4s intervals → 25 events fill a 100s budget → maxSimTime term.
    const accessor = mockAccessor({ resources: { gold: 0 }, rates: { gold: 5 } });
    const beat: BeatProbe = { id: 'hard-false', predicate: () => false };

    const results = runProbe({
      mode: 'event',
      buildEngine: ({ seed }) => buildPurchasableEngine(`event-maxsim-${seed}`),
      buildAccessor: () => accessor,
      beats: [beat],
      seeds: [1],
      maxSimTime: 100,
      tickDelta: 1,
    });

    expect(results[0]!.counts).toEqual({ predicate: 0, maxSimTime: 1, unreachable: 0 });
    expect(results[0]!.terminationTime).toBeUndefined();
  });
});
