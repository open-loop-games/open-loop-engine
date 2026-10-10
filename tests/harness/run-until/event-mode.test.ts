import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createEngine, type Engine, type EngineModule } from '@/index';
import { addResource, createResource } from '@/core/resource';
import { createMemoryStorage } from '@/core/save-manager';
import { createCostRequirement } from '@/core/requirements';
import { createPurchasableCategory } from '@/systems/purchasable-category';
import { createChallengeCategory } from '@/systems/challenge-category';
import { resetAllPersistentContexts } from '@/core/persistence';
import { bn } from '@/primitives/decimal';
import type { GameStateAccessor } from '@/primitives/types';
import { runMatrixUntil, runProbe, runUntil } from '@/harness';
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
    getFlag: (id) => unlocks[id] ?? false,
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
      upgrades.register([{ id: 'cheap', cost: 20 }]);
    },
  };
  const engine = createEngine({ gameId, persistence: false });
  engine.use(module);
  engine.start();
  return engine;
}

/** FlagCondition gate → every walker emission is `reason: 'opaque-predicate'`. */
function buildOpaqueChallengeEngine(gameId: string, accessor: GameStateAccessor): Engine {
  resetAllPersistentContexts();
  const module: EngineModule = {
    id: 'opaque-challenge',
    install() {
      const challenges = createChallengeCategory({ id: 'trials', accessor });
      challenges.register({
        id: 'bronze',
        name: 'Bronze',
        canStart: { kind: 'flag', id: 'unreachable-flag' },
        goal: () => false,
      });
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

  it('steps a persistent zero-distance head at tickDelta through budget', () => {
    // Purchasable is already affordable (gold >= cost), so the walker
    // surfaces the `becomes-affordable` transition at distance=0. The probe
    // does not execute it (no auto-purchase); the tickDelta floor carries the
    // run to the ceiling one tickDelta per advance.
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

  it('a persistent zero-distance head still fires the predicate when a non-walker rate source advances state', () => {
    // Regression guard: an already-affordable purchase stays at distance 0
    // across rebuilds, but a non-walker `ctx.onTick` subscriber mutates state
    // that flips the predicate. Must not false-negate.
    resetAllPersistentContexts();
    let tickCount = 0;
    const fireAt = 3;
    const flag = { fired: false };
    const module: EngineModule = {
      id: 'tie-with-non-walker-input',
      install(ctx) {
        const gold = createResource(100, { id: 'gold', displayName: 'gold' });
        const upgrades = createPurchasableCategory<UpgradeDef>({
          id: 'upgrades',
          mapPurchasable: (def) => ({
            display: { description: def.id },
            requirements: [createCostRequirement({ resource: gold, cost: def.cost })],
            limit: 1,
          }),
        });
        upgrades.register([{ id: 'cheap', cost: 20 }]);
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
        const gold = createResource(0, { id: 'gold', displayName: 'gold' });
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
        const gold = createResource(0, { id: 'gold', displayName: 'gold' });
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

  it('bisects a simTime-reading predicate to run-absolute fire time on a later advance', () => {
    // Regression: bisectTerminationTime evaluated the predicate with checkpoint-
    // relative `mid` as simTime, so a simTime-reading predicate — the exact
    // idiom in runUntil's @example — never saw its time clause flip inside the
    // bisect loop, and the search fell to the advance boundary. The divergence
    // is only visible past the first advance, where the checkpoint's absolute
    // simTime is nonzero (baseSimTime + mid ≠ mid).
    resetAllPersistentContexts();
    const module: EngineModule = {
      id: 'simtime-bisect',
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
        upgrades.register([{ id: 'big', cost: 100 }]);
      },
    };
    const engine = createEngine({
      gameId: 'simtime-bisect',
      storageAdapter: createMemoryStorage(),
      maxDeltaTime: 1000,
    });
    engine.use(module);
    engine.start();

    // Stateless accessor (gold=0, rate=1, cost=100) → the walker emits a 100s
    // `becomes-affordable` transition every rebuild, so the run advances 100s
    // per iteration: 0 → 100 → 200 → (crosses 250 inside the 200→300 advance).
    // The checkpoint simTime there is 200, so the relative-vs-absolute bug
    // records the advance boundary (300s) instead of the true crossing (250s).
    const accessor = mockAccessor({ resources: { gold: 0 }, rates: { gold: 1 } });
    const threshold = 250;
    const tol = 0.5;

    const result = runUntil({
      engine,
      accessor,
      mode: 'event',
      until: ({ simTime }) => simTime >= threshold,
      maxSimTime: 1000,
      tickDelta: 1,
      bisectTolSec: tol,
    });

    expect(result.terminated).toBe('predicate');
    // With the fix, bisect resolves the true crossing at 250s (± tol). With the
    // bug it recorded the advance boundary at 300s.
    expect(result.elapsedSimulated).toBeGreaterThanOrEqual(threshold - tol);
    expect(result.elapsedSimulated).toBeLessThanOrEqual(threshold + tol);
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

/**
 * Real engine earning 1 gold per simulated second through `ctx.onTick`, with a
 * cost-100 purchasable so the walker has a head. The accessor reads the live
 * gold amount and reports `rate` — 1 matches the real income, 0 hides it.
 */
function buildGoldEngine(
  options: { maxDeltaTime?: number; persistence?: boolean; rate?: number } = {},
): { engine: Engine; accessor: GameStateAccessor; gold: () => number } {
  resetAllPersistentContexts();
  let goldRef: ReturnType<typeof createResource<number>> | null = null;
  const module: EngineModule = {
    id: 'gold-income',
    install(ctx) {
      const gold = createResource(0, { id: 'gold', displayName: 'gold' });
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
      ctx.onTick((dt) => {
        addResource(gold, dt);
      });
    },
  };
  const engine = createEngine({
    gameId: 'gold-income',
    maxDeltaTime: options.maxDeltaTime,
    ...(options.persistence === false
      ? { persistence: false }
      : { storageAdapter: createMemoryStorage() }),
  });
  engine.use(module);
  engine.start();
  const gold = () => bn(goldRef!.value).toNumber();
  const accessor: GameStateAccessor = {
    getResource: () => bn(goldRef!.value),
    getFlag: () => false,
    getState: () => undefined,
    getRate: () => bn(options.rate ?? 1),
  };
  return { engine, accessor, gold };
}

describe("runUntil({mode: 'event'}) time accounting", () => {
  it('simulates every second it reports on an engine with the default maxDeltaTime', () => {
    const { engine, accessor, gold } = buildGoldEngine();
    const result = runUntil({
      engine,
      accessor,
      mode: 'event',
      until: () => gold() >= 100 - 1e-9,
      maxSimTime: 10_000,
      tickDelta: 0.5,
    });
    engine.stop();

    expect(result.terminated).toBe('predicate');
    expect(result.elapsedSimulated).toBeCloseTo(100, 6);
    expect(gold()).toBeCloseTo(result.elapsedSimulated, 6);
  });

  it('ends as maxSimTime when the next event lies past the ceiling', () => {
    const { engine, accessor, gold } = buildGoldEngine({ maxDeltaTime: 1e6 });
    const result = runUntil({
      engine,
      accessor,
      mode: 'event',
      until: () => gold() >= 100 - 1e-9,
      maxSimTime: 50,
      tickDelta: 1,
    });
    engine.stop();

    expect(result.terminated).toBe('maxSimTime');
    expect(result.elapsedSimulated).toBeCloseTo(50, 6);
    expect(gold()).toBeCloseTo(50, 6);
  });

  it('never bisects to a fire time past the ceiling', () => {
    const { engine, accessor, gold } = buildGoldEngine({ maxDeltaTime: 1e6 });
    const result = runUntil({
      engine,
      accessor,
      mode: 'event',
      until: () => gold() >= 100 - 1e-9,
      maxSimTime: 50,
      tickDelta: 1,
      bisectTolSec: 1,
    });
    engine.stop();

    expect(result.terminated).toBe('maxSimTime');
    expect(gold()).toBeCloseTo(50, 6);
  });

  it('reports maxSimTime, not unreachable, when income the walker cannot see moves its tracked state', () => {
    // The accessor reports rate 0, so every snapshot is no-finite-transition
    // stasis — but the onTick income keeps raising the gold the walker tracks.
    const { engine, accessor, gold } = buildGoldEngine({ rate: 0 });
    const result = runUntil({
      engine,
      accessor,
      mode: 'event',
      until: () => gold() >= 100 - 1e-9,
      maxSimTime: 50,
      tickDelta: 1,
    });
    engine.stop();

    expect(result.terminated).toBe('maxSimTime');
    expect(result.elapsedSimulated).toBeCloseTo(50, 6);
  });
});

// ---------------------------------------------------------------------------
// cumulative-gte under a drain — the lifetime total moves while the balance holds
// ---------------------------------------------------------------------------

/**
 * A `fragments` balance that a sink drains as fast as its source fills it, so
 * the balance holds while the lifetime total grows at the inflow rate. The
 * inflow starts once `clock` reaches `inflowFrom`. Challenge `early` reveals at
 * clock 2, an event ahead of `late`, which reveals at 10 lifetime fragments.
 */
function buildDrainedEngine(inflowFrom: number) {
  resetAllPersistentContexts();
  let clock!: ReturnType<typeof createResource<number>>;
  let fragments!: ReturnType<typeof createResource<number>>;
  let late!: () => boolean;
  const inflow = () => (clock.value >= inflowFrom ? 1 : 0);
  const accessor: GameStateAccessor = {
    getResource: (id) =>
      id === 'clock' ? bn(clock.value) : id === 'fragments' ? bn(fragments.value) : bn(0),
    getRate: (id) => (id === 'clock' ? bn(1) : bn(0)),
    getInflowRate: (id) => (id === 'fragments' ? bn(inflow()) : bn(0)),
    getFlag: () => false,
    getState: () => undefined,
  };
  const module: EngineModule = {
    id: 'drained',
    install(ctx) {
      clock = createResource(0, { id: 'clock', displayName: 'clock' });
      fragments = createResource(0, { id: 'fragments', displayName: 'fragments' });
      ctx.onTick((dt) => {
        const gain = inflow() * dt;
        fragments.value = fragments.value + gain;
        fragments.value = fragments.value - gain;
        clock.value = clock.value + dt;
      });
      const boards = createChallengeCategory({ id: 'boards', accessor });
      boards.register([
        {
          id: 'early',
          name: 'Early',
          visible: { kind: 'resource-gte', resource: 'clock', value: 2 },
        },
        {
          id: 'late',
          name: 'Late',
          visible: { kind: 'cumulative-gte', resource: 'fragments', value: 10 },
        },
      ]);
      const challenge = boards.getChallenge('late')!;
      late = () => challenge.visible.value;
    },
  };
  const engine = createEngine({ gameId: `drained-${inflowFrom}`, persistence: false });
  engine.use(module);
  engine.start();
  return { engine, accessor, late };
}

describe("runUntil({mode: 'event'}) — cumulative-gte under a drain", () => {
  it('re-predicts a lifetime total that grew while its balance held', () => {
    const { engine, accessor, late } = buildDrainedEngine(0);
    const result = runUntil({
      engine,
      accessor,
      mode: 'event',
      until: late,
      maxSimTime: 50,
      tickDelta: 0.25,
    });
    engine.stop();

    expect(result.terminated).toBe('predicate');
    expect(result.elapsedSimulated).toBeCloseTo(10, 6);
  });

  it('re-predicts when inflow starts while the balance and net rate hold', () => {
    const { engine, accessor, late } = buildDrainedEngine(2);
    const result = runUntil({
      engine,
      accessor,
      mode: 'event',
      until: late,
      maxSimTime: 50,
      tickDelta: 0.25,
    });
    engine.stop();

    expect(result.terminated).toBe('predicate');
    expect(result.elapsedSimulated).toBeCloseTo(12, 6);
    // One event step to each reveal, rather than fast-ticking a stasis the
    // inflow already broke.
    expect(result.totalTicks).toBe(2);
  });
});

describe("runUntil({mode: 'event'}) guards", () => {
  const trackerAnalyzer = () => ({
    name: 'tracker',
    summarize: () => ({ name: 'tracker', metrics: {} }),
  });

  it('throws when setup returns analyzers', () => {
    const { engine, accessor } = buildGoldEngine();
    expect(() =>
      runUntil({
        engine,
        accessor,
        mode: 'event',
        until: () => false,
        maxSimTime: 10,
        setup: () => [trackerAnalyzer()],
      }),
    ).toThrow(/analyzers/);
    engine.stop();
  });

  it('runs when setup returns no analyzers', () => {
    const { engine, accessor } = buildGoldEngine();
    const result = runUntil({
      engine,
      accessor,
      mode: 'event',
      until: () => false,
      maxSimTime: 10,
      setup: () => [],
    });
    engine.stop();
    expect(result.analyzerResults).toEqual([]);
  });

  it('throws from runMatrixUntil when an event-mode cell carries analyzers', () => {
    let built: Engine | undefined;
    expect(() =>
      runMatrixUntil({
        mode: 'event',
        cells: [
          {
            name: 'with-analyzers',
            buildEngine: () => {
              const { engine } = buildGoldEngine();
              built = engine;
              return engine;
            },
            buildAccessor: () => mockAccessor(),
            analyzers: () => [trackerAnalyzer()],
          },
        ],
        seeds: [1],
        until: () => false,
        maxSimTime: 10,
      }),
    ).toThrow(/analyzers/);
    built?.stop();
  });

  it('throws when bisectTolSec is set on an engine without a saveManager', () => {
    const { engine, accessor } = buildGoldEngine({ persistence: false });
    expect(() =>
      runUntil({
        engine,
        accessor,
        mode: 'event',
        until: () => false,
        maxSimTime: 10,
        bisectTolSec: 0.5,
      }),
    ).toThrow(/saveManager/);
    engine.stop();
  });

  it('throws when a bisect restore fails to import', () => {
    const { engine, accessor, gold } = buildGoldEngine({ maxDeltaTime: 1e6 });
    vi.spyOn(engine.saveManager!, 'importSave').mockReturnValue({ success: false });
    expect(() =>
      runUntil({
        engine,
        accessor,
        mode: 'event',
        until: () => gold() >= 10,
        maxSimTime: 200,
        tickDelta: 1,
        bisectTolSec: 0.5,
      }),
    ).toThrow(/import/);
    engine.stop();
  });
});
