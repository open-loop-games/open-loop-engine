import { describe, it, expect, beforeEach } from 'vitest';
import { ref } from 'vue';
import { CategoriesKey, createEngine, type EngineModule } from '@/index';
import { createPurchasableCategory } from '@/systems/purchasable-category';
import { createCostRequirement } from '@/core/requirements';
import { createChallengeCategory } from '@/systems/challenge-category';
import { resetAllPersistentContexts } from '@/core/persistence';
import { bn } from '@/primitives/decimal';
import type { GameStateAccessor } from '@/primitives/types';
import {
  emitChallengeTransitionsWithDeps,
  walkChallengeTransitions,
} from '@/harness/walker/walk-challenge-transitions';
import { runUntil } from '@/harness/run-until';
import { createIncrementalSnapshot } from '@/harness/walker/incremental-snapshot';
import { createTransitionSnapshot } from '@/harness/walker';
import { createResource, type Resource } from '@/core/resource';
import { mockAccessor } from './incremental-snapshot-fixture';

beforeEach(() => {
  resetAllPersistentContexts();
});

/**
 * Build a minimal engine that publishes a single challenge category under
 * `CategoriesKey.challenges` so the walker has something to iterate. The
 * provided `accessor` is forwarded to the category for ICondition
 * evaluation (visible / canStart / goal).
 */
function buildEngineWithChallenges(
  categoryId: string,
  register: (category: ReturnType<typeof createChallengeCategory>) => void,
  accessor: GameStateAccessor,
) {
  const module: EngineModule = {
    id: 'challenges-mod',
    install() {
      const challenges = createChallengeCategory({
        id: categoryId,
        mutuallyExclusive: true,
        accessor,
      });
      register(challenges);
    },
  };
  const engine = createEngine({ gameId: `wct-${categoryId}`, persistence: false });
  engine.use(module);
  engine.start();
  return engine;
}

// ---------------------------------------------------------------------------
// Empty / degenerate inputs
// ---------------------------------------------------------------------------

describe('walkChallengeTransitions — discovery degradation', () => {
  it('returns [] when the engine built no categories', () => {
    const engine = createEngine({ gameId: 'wct-empty', persistence: false });
    engine.start();
    expect(walkChallengeTransitions(engine, mockAccessor())).toEqual([]);
  });

  it('returns [] when the challenge category holds no defs', () => {
    const accessor = mockAccessor();
    const engine = buildEngineWithChallenges('empty-slice', () => {}, accessor);
    expect(walkChallengeTransitions(engine, accessor)).toEqual([]);
  });

  it('ignores non-challenge category slices', () => {
    const accessor = mockAccessor({ rates: { gold: 1 } });
    const engine = createEngine({ gameId: 'wct-mixed', persistence: false });
    engine.use({
      id: 'purchasable-mod',
      install() {
        const gold = createResource(0, { id: 'gold', displayName: 'gold' });
        createPurchasableCategory<{ id: string }>({
          id: 'upgrades',
          mapPurchasable: (def) => ({
            display: { description: def.id },
            requirements: [createCostRequirement({ resource: gold, cost: 10 })],
            limit: 1,
          }),
        }).register({ id: 'double' });
      },
    });
    engine.start();
    expect(createTransitionSnapshot(engine, accessor).purchasables).not.toEqual([]);
    expect(walkChallengeTransitions(engine, accessor)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// visibility-reveal
// ---------------------------------------------------------------------------

describe('walkChallengeTransitions — visibility-reveal', () => {
  it('emits visibility-reveal with computed distance for declarative visible', () => {
    const accessor = mockAccessor({ resources: { gold: 40 }, rates: { gold: 2 } });
    const engine = buildEngineWithChallenges(
      'vis',
      (c) =>
        c.register({
          id: 'secret',
          name: 'Secret',
          visible: { kind: 'resource-gte', resource: 'gold', value: 100 },
        }),
      accessor,
    );

    const out = walkChallengeTransitions(engine, accessor);
    const vis = out.filter((t) => t.kind === 'visibility-reveal');
    expect(vis).toHaveLength(1);
    expect(vis[0].source).toBe('challenge');
    expect(vis[0].categoryId).toBe('vis');
    expect(vis[0].defId).toBe('secret');
    expect(vis[0].label).toBe('vis.secret.visibility-reveal');
    expect(vis[0].currentValue).toBe(false);
    expect(vis[0].distance.reason).toBe('computed');
    expect(vis[0].distance.seconds).toBe(30); // (100 - 40) / 2
  });

  it('emits an opaque visibility-reveal for a ref-form visible', () => {
    const accessor = mockAccessor();
    const shown = ref(false);
    const engine = buildEngineWithChallenges(
      'vis-ref',
      (c) => c.register({ id: 'secret', name: 'Secret', visible: shown }),
      accessor,
    );

    const vis = walkChallengeTransitions(engine, accessor).filter(
      (t) => t.kind === 'visibility-reveal',
    );
    expect(vis).toHaveLength(1);
    expect(vis[0].distance.reason).toBe('opaque-predicate');
  });

  it('skips visibility-reveal when already visible', () => {
    const accessor = mockAccessor({ resources: { gold: 150 }, rates: { gold: 1 } });
    const engine = buildEngineWithChallenges(
      'vis-already',
      (c) =>
        c.register({
          id: 's',
          name: 'S',
          visible: { kind: 'resource-gte', resource: 'gold', value: 100 },
          // Closure-form goal keeps other emissions off while we assert visibility silence.
          goal: () => false,
        }),
      accessor,
    );
    const out = walkChallengeTransitions(engine, accessor);
    expect(out.filter((t) => t.kind === 'visibility-reveal')).toHaveLength(0);
  });

  it('skips visibility-reveal for boolean visible (always-visible)', () => {
    const accessor = mockAccessor();
    const engine = buildEngineWithChallenges(
      'vis-bool',
      (c) =>
        c.register({
          id: 'always',
          name: 'Always',
          visible: true,
          goal: () => false,
        }),
      accessor,
    );
    const out = walkChallengeTransitions(engine, accessor);
    expect(out.filter((t) => t.kind === 'visibility-reveal')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// start-unlock
// ---------------------------------------------------------------------------

describe('walkChallengeTransitions — start-unlock', () => {
  it('emits start-unlock with computed distance for declarative canStart', () => {
    const accessor = mockAccessor({ resources: { mana: 10 }, rates: { mana: 1 } });
    const engine = buildEngineWithChallenges(
      'start',
      (c) =>
        c.register({
          id: 'gated',
          name: 'Gated',
          canStart: { kind: 'resource-gte', resource: 'mana', value: 20 },
        }),
      accessor,
    );

    const out = walkChallengeTransitions(engine, accessor);
    const unlock = out.filter((t) => t.kind === 'start-unlock');
    expect(unlock).toHaveLength(1);
    expect(unlock[0].distance.reason).toBe('computed');
    expect(unlock[0].distance.seconds).toBe(10);
    expect(unlock[0].currentValue).toBe(false);
  });

  it('skips start-unlock while the challenge is active, even with the gate true', () => {
    const accessor = mockAccessor({ resources: { gold: 200 }, rates: { gold: -10 } });
    const engine = buildEngineWithChallenges(
      'start-active',
      (c) =>
        c.register({
          id: 'c',
          name: 'C',
          canStart: { kind: 'resource-gte', resource: 'gold', value: 100 },
          goal: () => false,
        }),
      accessor,
    );
    expect(
      walkChallengeTransitions(engine, accessor).filter((t) => t.kind === 'start-unlock'),
    ).toHaveLength(0);

    engine.tryInject(CategoriesKey)!.challenges![0].getChallenge('c')!.enter();
    expect(
      walkChallengeTransitions(engine, accessor).filter((t) => t.kind === 'start-unlock'),
    ).toHaveLength(0);
  });

  it('skips start-unlock once the challenge is maxed', () => {
    const accessor = mockAccessor({ resources: { gold: 200 }, rates: { gold: 1 } });
    const engine = buildEngineWithChallenges(
      'start-maxed',
      (c) =>
        c.register({
          id: 'c',
          name: 'C',
          canStart: { kind: 'resource-gte', resource: 'gold', value: 100 },
        }),
      accessor,
    );
    const challenge = engine.tryInject(CategoriesKey)!.challenges![0].getChallenge('c')!;
    challenge.enter();
    challenge.complete();
    expect(challenge.maxed.value).toBe(true);

    // The gate is false again, and rising, but a maxed challenge never starts.
    (accessor as { getResource: GameStateAccessor['getResource'] }).getResource = () => bn(0);
    expect(
      walkChallengeTransitions(engine, accessor).filter((t) => t.kind === 'start-unlock'),
    ).toHaveLength(0);
  });

  it('emits an opaque start-unlock for a category-aware canStart gate', () => {
    const accessor = mockAccessor();
    const engine = buildEngineWithChallenges(
      'start-count',
      (c) =>
        c.register({
          id: 'c',
          name: 'C',
          canStart: { kind: 'count-gte', category: 'upgrades', entry: 'farm', value: 3 },
        }),
      accessor,
    );
    const unlock = walkChallengeTransitions(engine, accessor).filter(
      (t) => t.kind === 'start-unlock',
    );
    expect(unlock).toHaveLength(1);
    expect(unlock[0].distance).toEqual({ seconds: null, reason: 'opaque-predicate' });
  });

  it('skips start-unlock when boolean canStart', () => {
    const accessor = mockAccessor();
    const engine = buildEngineWithChallenges(
      'start-bool',
      (c) =>
        c.register({
          id: 'open',
          name: 'Open',
          canStart: true,
          goal: () => false,
        }),
      accessor,
    );
    const out = walkChallengeTransitions(engine, accessor);
    expect(out.filter((t) => t.kind === 'start-unlock')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// goal-complete
// ---------------------------------------------------------------------------

describe('walkChallengeTransitions — goal-complete', () => {
  it('emits goal-complete only when the challenge is active', () => {
    const accessor = mockAccessor({ resources: { xp: 20 }, rates: { xp: 2 } });
    const engine = buildEngineWithChallenges(
      'goal',
      (c) =>
        c.register({
          id: 'survive',
          name: 'Survive',
          goal: { kind: 'resource-gte', resource: 'xp', value: 100 },
        }),
      accessor,
    );
    const challenges = engine.tryInject(CategoriesKey)!.challenges![0]!;
    // Inactive: no goal-complete emission.
    expect(
      walkChallengeTransitions(engine, accessor).filter((t) => t.kind === 'goal-complete'),
    ).toHaveLength(0);

    challenges.getChallenge('survive')!.enter();

    const out = walkChallengeTransitions(engine, accessor);
    const goal = out.filter((t) => t.kind === 'goal-complete');
    expect(goal).toHaveLength(1);
    expect(goal[0].distance.reason).toBe('computed');
    expect(goal[0].distance.seconds).toBe(40); // (100 - 20) / 2
    expect(goal[0].currentValue).toBe(false);
  });

  it('handles And/Or/Not composite goals', () => {
    const accessor = mockAccessor({
      resources: { a: 0, b: 0 },
      rates: { a: 1, b: 2 },
    });
    const engine = buildEngineWithChallenges(
      'composite',
      (c) =>
        c.register({
          id: 'both',
          name: 'Both',
          // AND currently-false → max over child flip-to-true distances.
          // a reaches 10 in 10s; b reaches 10 in 5s; max = 10s.
          goal: {
            kind: 'all',
            of: [
              { kind: 'resource-gte', resource: 'a', value: 10 },
              { kind: 'resource-gte', resource: 'b', value: 10 },
            ],
          },
        }),
      accessor,
    );
    engine.tryInject(CategoriesKey)!.challenges![0].getChallenge('both')!.enter();

    const [goal] = walkChallengeTransitions(engine, accessor).filter(
      (t) => t.kind === 'goal-complete',
    );
    expect(goal.distance.reason).toBe('computed');
    expect(goal.distance.seconds).toBe(10);
  });

  it('emits an opaque goal-complete for a closure-form goal while active', () => {
    const accessor = mockAccessor();
    const engine = buildEngineWithChallenges(
      'closure',
      (c) =>
        c.register({
          id: 'manual',
          name: 'Manual',
          goal: () => false,
        }),
      accessor,
    );
    engine.tryInject(CategoriesKey)!.challenges![0].getChallenge('manual')!.enter();

    const goal = walkChallengeTransitions(engine, accessor).filter(
      (t) => t.kind === 'goal-complete',
    );
    expect(goal).toHaveLength(1);
    expect(goal[0].distance).toEqual({ seconds: null, reason: 'opaque-predicate' });
  });

  it('skips goal-complete while the goal already holds', () => {
    // Without registerTick nothing completes a met goal, so the only flip left
    // to predict is the goal turning false again, which isn't this transition.
    const accessor = mockAccessor({ resources: { xp: 200 }, rates: { xp: -1 } });
    const engine = buildEngineWithChallenges(
      'goal-met',
      (c) =>
        c.register({
          id: 'done',
          name: 'Done',
          goal: { kind: 'resource-gte', resource: 'xp', value: 100 },
        }),
      accessor,
    );
    engine.tryInject(CategoriesKey)!.challenges![0].getChallenge('done')!.enter();

    const out = walkChallengeTransitions(engine, accessor);
    expect(out.filter((t) => t.kind === 'goal-complete')).toHaveLength(0);
    expect(out.filter((t) => t.kind === 'challenge-maxed')).toHaveLength(0);
  });

  it('skips goal-complete when active === false with declarative goal', () => {
    const accessor = mockAccessor({ resources: { xp: 20 }, rates: { xp: 2 } });
    const engine = buildEngineWithChallenges(
      'inactive',
      (c) =>
        c.register({
          id: 'idle',
          name: 'Idle',
          goal: { kind: 'resource-gte', resource: 'xp', value: 100 },
        }),
      accessor,
    );
    const out = walkChallengeTransitions(engine, accessor);
    expect(out.filter((t) => t.kind === 'goal-complete')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// challenge-maxed
// ---------------------------------------------------------------------------

describe('walkChallengeTransitions — challenge-maxed', () => {
  it('emits challenge-maxed on the last completion with matching goal distance', () => {
    const accessor = mockAccessor({ resources: { xp: 0 }, rates: { xp: 1 } });
    const engine = buildEngineWithChallenges(
      'max',
      (c) =>
        c.register({
          id: 'grind',
          name: 'Grind',
          goal: { kind: 'resource-gte', resource: 'xp', value: 10 },
          completionLimit: 2,
        }),
      accessor,
    );
    const challenge = engine.tryInject(CategoriesKey)!.challenges![0].getChallenge('grind')!;

    // First completion: 2 remaining, no challenge-maxed yet.
    challenge.enter();
    expect(
      walkChallengeTransitions(engine, accessor).filter((t) => t.kind === 'challenge-maxed'),
    ).toHaveLength(0);
    challenge.complete(); // exits after completion

    // Re-enter for the final run — completions === 1, limit === 2, so emits.
    challenge.enter();
    const out = walkChallengeTransitions(engine, accessor);
    const goal = out.find((t) => t.kind === 'goal-complete')!;
    const maxed = out.find((t) => t.kind === 'challenge-maxed')!;
    expect(maxed).toBeDefined();
    expect(maxed.distance).toEqual(goal.distance);
    expect(maxed.currentValue).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cumulative-gte
// ---------------------------------------------------------------------------

describe('walkChallengeTransitions — cumulative-gte', () => {
  function buildCumulativeEngine(inflow?: number) {
    let fragments!: Resource<number>;
    const accessor: GameStateAccessor = {
      getResource: (id) => (id === 'fragments' ? bn(fragments.value) : bn(0)),
      getRate: (id) => (id === 'fragments' ? bn(1) : bn(0)),
      isUnlocked: () => false,
      getState: () => undefined,
    };
    if (inflow !== undefined) {
      accessor.getInflowRate = (id) => (id === 'fragments' ? bn(inflow) : bn(0));
    }
    const module: EngineModule = {
      id: 'boards',
      install() {
        fragments = createResource(0, { id: 'fragments', displayName: 'fragments' });
        const boards = createChallengeCategory({ id: 'boards', accessor });
        boards.register({
          id: 'b',
          name: 'B',
          visible: { kind: 'cumulative-gte', resource: 'fragments', value: 50 },
        });
      },
    };
    const engine = createEngine({ gameId: 'wct-cumulative', persistence: false });
    engine.use(module);
    engine.start();
    return { engine, accessor, fragments: () => fragments };
  }

  it('measures the distance on the cumulative total, not the balance', () => {
    const { engine, accessor, fragments } = buildCumulativeEngine();
    fragments().value = 30;
    fragments().value = 10; // spending leaves cumulative at 30

    const [vis] = walkChallengeTransitions(engine, accessor).filter(
      (t) => t.kind === 'visibility-reveal',
    );
    expect(vis.distance).toEqual({ seconds: 20, reason: 'computed' });
  });

  it('gives the incremental snapshot the same distance', () => {
    const { engine, accessor, fragments } = buildCumulativeEngine();
    fragments().value = 30;
    fragments().value = 10;

    const [vis] = createIncrementalSnapshot(engine, accessor).snapshot.challenges;
    expect(vis.distance).toEqual({ seconds: 20, reason: 'computed' });
  });

  it('divides by the inflow rate when the accessor reports one, through both snapshots', () => {
    const { engine, accessor, fragments } = buildCumulativeEngine(4);
    fragments().value = 30;

    const [walked] = createTransitionSnapshot(engine, accessor).challenges;
    const [cached] = createIncrementalSnapshot(engine, accessor).snapshot.challenges;
    expect(walked.distance).toEqual({ seconds: 5, reason: 'computed' });
    expect(cached.distance).toEqual({ seconds: 5, reason: 'computed' });
  });

  it('reports the base resource as the dependency', () => {
    const { engine, accessor } = buildCumulativeEngine();
    const [entry] = emitChallengeTransitionsWithDeps(engine, accessor);
    expect([...entry.deps.resources]).toEqual(['fragments']);
    expect([...entry.deps.rates]).toEqual(['fragments']);
  });
});

// ---------------------------------------------------------------------------
// stasis detection over opaque challenge fields
// ---------------------------------------------------------------------------

describe("runUntil 'stasis-aware-tick' — opaque challenge fields", () => {
  it('reaches a closure goal that an onTick drives instead of calling it unreachable', () => {
    const points = ref(0);
    let completed!: () => boolean;
    const accessor = mockAccessor({ rates: { points: 1 } });
    const module: EngineModule = {
      id: 'trials',
      install(ctx) {
        ctx.onTick((dt) => {
          points.value += dt;
        });
        const trials = createChallengeCategory({
          id: 'trials',
          accessor,
          registerTick: (cb) => ctx.onTick(cb),
        });
        trials.register({ id: 't', name: 'T', goal: () => points.value >= 5 });
        const challenge = trials.getChallenge('t')!;
        challenge.enter();
        completed = () => challenge.completed.value;
      },
    };
    const engine = createEngine({ gameId: 'wct-stasis', persistence: false });
    engine.use(module);
    engine.start();

    const result = runUntil({
      engine,
      accessor,
      mode: 'stasis-aware-tick',
      until: completed,
      maxSimTime: 20,
      tickDelta: 1,
    });
    expect(result.terminated).toBe('predicate');
  });
});
