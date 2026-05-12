import { describe, it, expect } from 'vitest';
import { bn } from '@/primitives/decimal';
import { Decimal } from '@/primitives/decimal';
import { createResource, addResource } from '@/core/resource';
import { beginPersistentContext, endPersistentContext } from '@/core/persistence';
import { createLoop } from '@/systems/loop';
import { createLoopLog } from '@/systems/loop-log';
import { createBestOf } from '@/systems/best-of';
import { createBestReplayStrategy, createGoalStrategy } from '@/systems/recommendation-strategies';
import type { RecommendationContext } from '@/systems/recommendation';

/** Simple tick manager matching the existing test pattern */
function createTickManager() {
  const callbacks: ((dt: number) => void)[] = [];
  return {
    registerTick(cb: (dt: number) => void) {
      callbacks.push(cb);
      return () => {
        const idx = callbacks.indexOf(cb);
        if (idx >= 0) callbacks.splice(idx, 1);
      };
    },
    tick(dt: number) {
      for (const cb of callbacks) cb(dt);
    },
  };
}

/** Build a full Loop + LoopLog + BestOf stack and run N loops to populate data */
function createPopulatedStack(prefix: string, opts?: { captureStrategy?: boolean }) {
  const tick = createTickManager();

  beginPersistentContext(`${prefix}-res`);
  const gold = createResource(bn(0), { displayName: 'Gold' });
  endPersistentContext();

  const loop = createLoop({
    id: `${prefix}-loop`,
    thingsToReset: [gold],
    registerTick: tick.registerTick,
  });

  const loopLog = createLoopLog({
    loop,
    metrics: { gold },
  });

  const bestOf = createBestOf({
    id: `${prefix}-best`,
    metrics: { gold: { mode: 'absolute' } },
    loopLog,
    captureStrategy:
      opts?.captureStrategy !== false ? () => ({ queue: ['spell-a', 'spell-b'] }) : undefined,
  });

  /** Run a loop cycle: set gold, tick, end */
  function runLoop(goldAmount: number, elapsed: number) {
    loop.run();
    addResource(gold, bn(goldAmount));
    tick.tick(elapsed);
    loop.end();
  }

  /** Build a RecommendationContext from the current state */
  function buildContext(currentSnapshot = {}): RecommendationContext {
    return {
      loopLog,
      bestOf,
      loop,
      currentSnapshot,
      state: {},
    };
  }

  return { tick, gold, loop, loopLog, bestOf, runLoop, buildContext };
}

describe('createBestReplayStrategy', () => {
  // ==========================================================================
  // canApply
  // ==========================================================================

  it('canApply returns false when no best entry exists', () => {
    const { buildContext } = createPopulatedStack('br-noentry');
    const strategy = createBestReplayStrategy('gold');

    expect(strategy.canApply(buildContext())).toBe(false);
  });

  it('canApply returns false when entry has no strategySnapshot', () => {
    const { runLoop, buildContext } = createPopulatedStack('br-nosnap', {
      captureStrategy: false,
    });

    runLoop(100, 5);

    const strategy = createBestReplayStrategy('gold');
    expect(strategy.canApply(buildContext())).toBe(false);
  });

  it('canApply returns false when entry status is stale', () => {
    const { runLoop, bestOf, buildContext } = createPopulatedStack('br-stale');

    runLoop(100, 5);
    bestOf.invalidate('gold');

    const strategy = createBestReplayStrategy('gold');
    expect(strategy.canApply(buildContext())).toBe(false);
  });

  it('canApply returns true when valid entry with snapshot exists', () => {
    const { runLoop, buildContext } = createPopulatedStack('br-ok');

    runLoop(100, 5);

    const strategy = createBestReplayStrategy('gold');
    expect(strategy.canApply(buildContext())).toBe(true);
  });

  it('minLoops option gates applicability on loop count', () => {
    const { runLoop, buildContext } = createPopulatedStack('br-minloops');

    runLoop(100, 5);

    const strategy = createBestReplayStrategy('gold', { minLoops: 3 });
    // loop.count is 1 after one completed loop
    expect(strategy.canApply(buildContext())).toBe(false);

    runLoop(80, 4);
    // loop.count is 2
    expect(strategy.canApply(buildContext())).toBe(false);

    runLoop(60, 3);
    // loop.count is 3
    expect(strategy.canApply(buildContext())).toBe(true);
  });

  // ==========================================================================
  // score
  // ==========================================================================

  it('score reflects entry value for natural arbitration', () => {
    const { runLoop, buildContext } = createPopulatedStack('br-score');

    runLoop(200, 10);

    const strategy = createBestReplayStrategy('gold');
    const ctx = buildContext();
    expect(strategy.canApply(ctx)).toBe(true);

    const score = strategy.score(ctx);
    // perSecond = 200/10 = 20
    expect(score).toBe(20);
  });

  // ==========================================================================
  // recommend
  // ==========================================================================

  it('recommend returns the stored strategySnapshot', () => {
    const { runLoop, buildContext } = createPopulatedStack('br-rec');

    runLoop(150, 5);

    const strategy = createBestReplayStrategy('gold');
    const ctx = buildContext();
    const result = strategy.recommend(ctx);

    expect(result.snapshot).toEqual({ queue: ['spell-a', 'spell-b'] });
  });

  it('rationale contains metric comparison with current loop data', () => {
    const { runLoop, buildContext } = createPopulatedStack('br-rationale');

    // First loop: gold = 100 (sets the best)
    runLoop(100, 5);
    // Second loop: gold = 50 (worse, doesn't beat best)
    runLoop(50, 5);

    const strategy = createBestReplayStrategy('gold');
    const ctx = buildContext();
    const result = strategy.recommend(ctx);

    expect(result.rationale.strategyId).toBe('best-replay:gold');
    expect(result.rationale.metrics.gold).toBeDefined();
    // Current should be last loop's delta (50)
    expect(Decimal.eq(result.rationale.metrics.gold.current, 50)).toBe(true);
    // Projected should be the best value (100)
    expect(Decimal.eq(result.rationale.metrics.gold.projected, 100)).toBe(true);
    // Delta = 100 - 50 = 50
    expect(Decimal.eq(result.rationale.metrics.gold.delta, 50)).toBe(true);
  });

  it('uses custom id when provided', () => {
    const { runLoop, buildContext } = createPopulatedStack('br-custom-id');
    runLoop(100, 5);

    const strategy = createBestReplayStrategy('gold', { id: 'my-replay' });
    expect(strategy.id).toBe('my-replay');

    const result = strategy.recommend(buildContext());
    expect(result.rationale.strategyId).toBe('my-replay');
  });
});

describe('createGoalStrategy', () => {
  // ==========================================================================
  // canApply
  // ==========================================================================

  it('canApply returns false with no best entry', () => {
    const { buildContext } = createPopulatedStack('gs-noentry');
    const strategy = createGoalStrategy({ id: 'goal', metric: 'gold' });

    expect(strategy.canApply(buildContext())).toBe(false);
  });

  it('canApply returns false when entry is below threshold', () => {
    const { runLoop, buildContext } = createPopulatedStack('gs-thresh');

    runLoop(50, 5);

    const strategy = createGoalStrategy({
      id: 'goal',
      metric: 'gold',
      threshold: 100,
    });
    expect(strategy.canApply(buildContext())).toBe(false);
  });

  it('canApply returns true when entry meets threshold', () => {
    const { runLoop, buildContext } = createPopulatedStack('gs-thresh-ok');

    runLoop(150, 5);

    const strategy = createGoalStrategy({
      id: 'goal',
      metric: 'gold',
      threshold: 100,
    });
    expect(strategy.canApply(buildContext())).toBe(true);
  });

  it('canApply returns true with no threshold when any entry exists', () => {
    const { runLoop, buildContext } = createPopulatedStack('gs-nothresh');

    runLoop(10, 5);

    const strategy = createGoalStrategy({ id: 'goal', metric: 'gold' });
    expect(strategy.canApply(buildContext())).toBe(true);
  });

  // ==========================================================================
  // score
  // ==========================================================================

  it('maximize score is the entry value', () => {
    const { runLoop, buildContext } = createPopulatedStack('gs-score-max');

    runLoop(200, 10);

    const strategy = createGoalStrategy({
      id: 'goal',
      metric: 'gold',
      prefer: 'maximize',
    });
    const ctx = buildContext();
    expect(strategy.score(ctx)).toBe(200);
  });

  it('minimize score is negative elapsed', () => {
    const { runLoop, buildContext } = createPopulatedStack('gs-score-min');

    runLoop(200, 8);

    const strategy = createGoalStrategy({
      id: 'goal',
      metric: 'gold',
      prefer: 'minimize',
    });
    const ctx = buildContext();
    expect(strategy.score(ctx)).toBe(-8);
  });

  // ==========================================================================
  // recommend
  // ==========================================================================

  it('recommend returns strategySnapshot when available', () => {
    const { runLoop, buildContext } = createPopulatedStack('gs-snap');

    runLoop(100, 5);

    const strategy = createGoalStrategy({ id: 'goal', metric: 'gold' });
    const result = strategy.recommend(buildContext());

    expect(result.snapshot).toEqual({ queue: ['spell-a', 'spell-b'] });
  });

  it('recommend falls back to currentSnapshot when no strategySnapshot', () => {
    const { runLoop, buildContext } = createPopulatedStack('gs-fallback', {
      captureStrategy: false,
    });

    runLoop(100, 5);

    const strategy = createGoalStrategy({ id: 'goal', metric: 'gold' });
    // canApply still true (goal strategy doesn't require snapshot)
    const ctx = buildContext({ fallback: true });
    const result = strategy.recommend(ctx);

    expect(result.snapshot).toEqual({ fallback: true });
  });

  it('rationale reflects goal direction', () => {
    const { runLoop, buildContext } = createPopulatedStack('gs-rationale');

    runLoop(100, 5);

    const maxStrategy = createGoalStrategy({
      id: 'max',
      metric: 'gold',
      prefer: 'maximize',
    });
    const minStrategy = createGoalStrategy({
      id: 'min',
      metric: 'gold',
      prefer: 'minimize',
    });

    const maxResult = maxStrategy.recommend(buildContext());
    expect(maxResult.rationale.summary).toContain('highest');

    const minResult = minStrategy.recommend(buildContext());
    expect(minResult.rationale.summary).toContain('fastest');
  });

  it('defaults prefer to maximize', () => {
    const { runLoop, buildContext } = createPopulatedStack('gs-default');

    runLoop(100, 5);

    const strategy = createGoalStrategy({ id: 'goal', metric: 'gold' });
    const result = strategy.recommend(buildContext());
    expect(result.rationale.summary).toContain('highest');
  });
});
