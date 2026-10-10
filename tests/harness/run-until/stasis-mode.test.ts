import { describe, it, expect, beforeEach } from 'vitest';
import { createEngine, type Engine, type EngineModule } from '@/index';
import { createResource } from '@/core/resource';
import { createCostRequirement } from '@/core/requirements';
import { createPurchasableCategory } from '@/systems/purchasable-category';
import { createChallengeCategory } from '@/systems/challenge-category';
import { resetAllPersistentContexts } from '@/core/persistence';
import { bn } from '@/primitives/decimal';
import type { GameStateAccessor } from '@/primitives/types';
import { runBeatProbe } from '@/harness';
import type { Beat } from '@/harness';

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
    getAmount: (id) => bn(resources[id] ?? 0),
    getFlag: (id) => unlocks[id] ?? false,
    getStateAt: (path) => state[path],
    getRate: (id) => bn(rates[id] ?? 0),
  };
}

interface UpgradeDef {
  id: string;
  cost: number;
}

/** Engine with no categories at all — walker emits an empty snapshot → stasis. */
function buildEmptyEngine(gameId: string): Engine {
  resetAllPersistentContexts();
  const engine = createEngine({ gameId, persistence: false });
  engine.start();
  return engine;
}

/**
 * Purchasable-only engine. Gold rate is a knob: positive → the upgrade
 * becomes affordable after a finite delay (walker emits a finite distance →
 * NOT stasis). Zero → the walker emits null/no-rate for every transition
 * (stasis).
 */
function buildPurchasableEngine(gameId: string) {
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

/**
 * Challenge whose `canEnter` is a pure `FlagCondition` — the walker emits
 * `{ seconds: null, reason: 'opaque-predicate' }`. Conservative stasis
 * refuses to short-circuit in this case even though no finite distance
 * exists.
 */
function buildOpaqueChallengeEngine(gameId: string, accessor: GameStateAccessor) {
  resetAllPersistentContexts();
  const module: EngineModule = {
    id: 'opaque-challenge',
    install() {
      const challenges = createChallengeCategory({ id: 'trials', accessor });
      challenges.register({
        id: 'bronze',
        displayName: 'Bronze',
        // FlagCondition → opaque-predicate distance, no computable horizon.
        canEnter: { kind: 'flag', id: 'unreachable-flag' },
        goal: () => false,
      });
    },
  };
  const engine = createEngine({ gameId, persistence: false });
  engine.use(module);
  engine.start();
  return engine;
}

describe("runBeatProbe({mode: 'stasis-aware'})", () => {
  it('short-circuits on a constructed empty-content engine (unreachable counted)', () => {
    const beat: Beat = {
      // Hard-false — only stasis can terminate these runs.
      id: 'never-fires',
      predicate: () => false,
    };
    const results = runBeatProbe({
      mode: 'stasis-aware',
      buildEngine: ({ seed }) => buildEmptyEngine(`stasis-empty-${seed}`),
      buildAccessor: () => mockAccessor(),
      beats: [beat],
      seeds: [1, 2, 3],
      maxSimTime: 100,
      tickDelta: 1,
    });

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.beatId).toBe('never-fires');
    // All three seeds short-circuit on stasis — none run to maxSimTime.
    expect(r.counts).toEqual({ predicate: 0, maxSimTime: 0, unreachable: 3 });
    // Stasis fires at tick 0 → no termination-time stats to report.
    expect(r.terminationTime).toBeUndefined();
  });

  it('does NOT short-circuit when the walker emits any finite-distance transition', () => {
    // Positive gold rate → `upgrades.cheap.becomes-affordable` has a finite
    // distance → not stasis → probe runs until predicate fires.
    const accessor = mockAccessor({ resources: { gold: 0 }, rates: { gold: 5 } });
    const beat: Beat = {
      // Fire at tick 1: we don't observe ticks on the real engine's
      // counters, so we use a simTime proxy via the until-runner. Easiest
      // is to use a `ctx`-free predicate that reads engine state directly;
      // but our test engine doesn't model time passing for the walker
      // accessor (the mockAccessor is stateless). So we fire after N
      // evaluations by closing over a counter.
      id: 'count-3',
      predicate: (() => {
        let calls = 0;
        return () => ++calls >= 4;
      })(),
    };
    const results = runBeatProbe({
      mode: 'stasis-aware',
      buildEngine: ({ seed }) => buildPurchasableEngine(`stasis-reachable-${seed}`),
      buildAccessor: () => accessor,
      beats: [beat],
      seeds: [1],
      maxSimTime: 10,
      tickDelta: 1,
    });

    // Predicate fired, stasis never triggered.
    expect(results[0]!.counts).toEqual({ predicate: 1, maxSimTime: 0, unreachable: 0 });
    expect(results[0]!.terminationTime).toBeDefined();
  });

  it('does NOT short-circuit when an opaque-predicate transition is present', () => {
    // Challenge gated by FlagCondition → every walker emission is
    // `reason: 'opaque-predicate'`. No finite distance, but conservative
    // stasis refuses to classify as unreachable (could be flipped by code
    // the walker can't introspect).
    const accessor = mockAccessor();
    const beat: Beat = { id: 'never-fires', predicate: () => false };

    const results = runBeatProbe({
      mode: 'stasis-aware',
      buildEngine: ({ seed }) => buildOpaqueChallengeEngine(`stasis-opaque-${seed}`, accessor),
      buildAccessor: () => accessor,
      beats: [beat],
      seeds: [1, 2],
      maxSimTime: 5,
      tickDelta: 1,
    });

    // No stasis short-circuit — probe hits maxSimTime for every seed.
    expect(results[0]!.counts).toEqual({ predicate: 0, maxSimTime: 2, unreachable: 0 });
    expect(results[0]!.terminationTime).toBeUndefined();
  });

  it('agrees with runBeatProbe on fire-time when stasis does not trigger', () => {
    const accessor = mockAccessor({ resources: { gold: 0 }, rates: { gold: 5 } });
    const makeBeat = (): Beat => ({
      id: 'count-3',
      predicate: (() => {
        let calls = 0;
        return () => ++calls >= 4;
      })(),
    });

    const stasis = runBeatProbe({
      mode: 'stasis-aware',
      buildEngine: ({ seed }) => buildPurchasableEngine(`stasis-agree-a-${seed}`),
      buildAccessor: () => accessor,
      beats: [makeBeat()],
      seeds: [1],
      maxSimTime: 10,
      tickDelta: 1,
    });
    const plain = runBeatProbe({
      buildEngine: ({ seed }) => buildPurchasableEngine(`stasis-agree-b-${seed}`),
      beats: [makeBeat()],
      seeds: [1],
      maxSimTime: 10,
      tickDelta: 1,
    });

    // Stasis probe must not produce a false-positive unreachable when
    // a legitimate predicate fire is available — fire-time is the same as
    // the plain tick probe.
    expect(stasis[0]!.counts).toEqual(plain[0]!.counts);
    expect(stasis[0]!.terminationTime!.p50).toBeCloseTo(plain[0]!.terminationTime!.p50, 5);
  });
});
