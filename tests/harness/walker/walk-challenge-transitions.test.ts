import { describe, it, expect, beforeEach } from 'vitest';
import { CategoriesKey, createEngine, type EngineCategories, type EngineModule } from '@/index';
import { createChallengeCategory } from '@/systems/challenge-category';
import { C } from '@/core/conditions';
import { resetAllPersistentContexts } from '@/core/persistence';
import { bn } from '@/primitives/decimal';
import type { GameStateAccessor } from '@/primitives/types';
import { walkChallengeTransitions } from '@/harness/walker/walk-challenge-transitions';

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
    install(ctx) {
      const challenges = createChallengeCategory({
        id: categoryId,
        mutuallyExclusive: true,
        accessor,
      });
      register(challenges);
      ctx.provide(CategoriesKey, { challenges: [challenges] } as EngineCategories);
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
  it('returns [] when CategoriesKey is not provided', () => {
    const engine = createEngine({ gameId: 'wct-empty', persistence: false });
    engine.start();
    expect(walkChallengeTransitions(engine, mockAccessor())).toEqual([]);
  });

  it('returns [] when challenges slice is empty', () => {
    const module: EngineModule = {
      id: 'empty-mod',
      install(ctx) {
        ctx.provide(CategoriesKey, { challenges: [] } as EngineCategories);
      },
    };
    const engine = createEngine({ gameId: 'wct-empty-slice', persistence: false });
    engine.use(module);
    engine.start();
    expect(walkChallengeTransitions(engine, mockAccessor())).toEqual([]);
  });

  it('ignores non-challenge category slices', () => {
    // Walker must filter to `challenges` — non-challenge slices on the same
    // CategoriesKey object shouldn't leak through.
    const accessor = mockAccessor();
    const module: EngineModule = {
      id: 'mixed-mod',
      install(ctx) {
        const challenges = createChallengeCategory({
          id: 'mix',
          accessor,
        });
        // No defs registered → nothing for this walker to emit.
        ctx.provide(CategoriesKey, {
          challenges: [challenges],
          resources: [], // irrelevant slice, should be ignored
        } as EngineCategories);
      },
    };
    const engine = createEngine({ gameId: 'wct-mixed', persistence: false });
    engine.use(module);
    engine.start();
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
          visible: C.resource('gold', 'gte', 100),
        }),
      accessor,
    );

    const out = walkChallengeTransitions(engine, accessor);
    const vis = out.filter((t) => t.kind === 'visibility-reveal');
    expect(vis).toHaveLength(1);
    expect(vis[0].source).toBe('challenge');
    expect(vis[0].categoryId).toBe('vis');
    expect(vis[0].entityId).toBe('secret');
    expect(vis[0].label).toBe('vis.secret.visibility-reveal');
    expect(vis[0].currentValue).toBe(false);
    expect(vis[0].distance.reason).toBe('computed');
    expect(vis[0].distance.seconds).toBe(30); // (100 - 40) / 2
  });

  it('skips visibility-reveal when already visible', () => {
    const accessor = mockAccessor({ resources: { gold: 150 }, rates: { gold: 1 } });
    const engine = buildEngineWithChallenges(
      'vis-already',
      (c) =>
        c.register({
          id: 's',
          name: 'S',
          visible: C.resource('gold', 'gte', 100),
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
          canStart: C.resource('mana', 'gte', 20),
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
          goal: C.resource('xp', 'gte', 100),
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
          goal: C.and(C.resource('a', 'gte', 10), C.resource('b', 'gte', 10)),
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

  it('skips goal-complete for closure-form goal even when active', () => {
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

    const out = walkChallengeTransitions(engine, accessor);
    expect(out.filter((t) => t.kind === 'goal-complete')).toHaveLength(0);
  });

  it('skips goal-complete when active === false with declarative goal', () => {
    const accessor = mockAccessor({ resources: { xp: 20 }, rates: { xp: 2 } });
    const engine = buildEngineWithChallenges(
      'inactive',
      (c) =>
        c.register({
          id: 'idle',
          name: 'Idle',
          goal: C.resource('xp', 'gte', 100),
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
          goal: C.resource('xp', 'gte', 10),
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
