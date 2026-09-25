import { describe, it, expect } from 'vitest';
import { bn } from '@/primitives/decimal';
import { Decimal } from '@/primitives/decimal';
import { createResource, addResource } from '@/core/resource';
import { beginPersistentContext, endPersistentContext } from '@/core/persistence';
import { createCycle } from '@/systems/cycle';
import { createCycleLog } from '@/systems/cycle-log';
import { createBestOf, type BestOfMetricDef } from '@/systems/best-of';
import { createBestReplayDef } from '@/systems/recommendation-strategies';
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

/** Build a full Cycle + CycleLog + BestOf stack and run N cycles to populate data */
function createPopulatedStack(
  prefix: string,
  opts?: { captureStrategy?: boolean; metric?: BestOfMetricDef },
) {
  const tick = createTickManager();

  beginPersistentContext(`${prefix}-res`);
  const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
  endPersistentContext();

  const cycle = createCycle({
    id: `${prefix}-cycle`,
    thingsToReset: [gold],
    registerTick: tick.registerTick,
  });

  const cycleLog = createCycleLog({
    cycle,
    metrics: { gold },
  });

  const bestOf = createBestOf({
    id: `${prefix}-best`,
    metrics: { gold: opts?.metric ?? { mode: 'absolute' } },
    cycleLog,
    captureStrategy:
      opts?.captureStrategy !== false ? () => ({ queue: ['spell-a', 'spell-b'] }) : undefined,
  });

  /** Run a cycle cycle: set gold, tick, end. String gold allows values past the double range. */
  function runCycle(goldAmount: number | string, elapsed: number) {
    cycle.run();
    addResource(gold, bn(goldAmount));
    tick.tick(elapsed);
    cycle.end();
  }

  /** Build a RecommendationContext from the current state */
  function buildContext(currentSnapshot = {}): RecommendationContext {
    return {
      cycleLog,
      bestOf,
      cycle,
      currentSnapshot,
      state: {},
    };
  }

  return { tick, gold, cycle, cycleLog, bestOf, runCycle, buildContext };
}

describe('createBestReplayDef', () => {
  // ==========================================================================
  // canApply
  // ==========================================================================

  it('canApply returns false when no best entry exists', () => {
    const { buildContext } = createPopulatedStack('br-noentry');
    const strategy = createBestReplayDef('gold');

    expect(strategy.canApply(buildContext())).toBe(false);
  });

  it('canApply returns false when entry has no strategySnapshot', () => {
    const { runCycle, buildContext } = createPopulatedStack('br-nosnap', {
      captureStrategy: false,
    });

    runCycle(100, 5);

    const strategy = createBestReplayDef('gold');
    expect(strategy.canApply(buildContext())).toBe(false);
  });

  it('canApply returns false when entry status is stale', () => {
    const { runCycle, bestOf, buildContext } = createPopulatedStack('br-stale');

    runCycle(100, 5);
    bestOf.invalidate('gold');

    const strategy = createBestReplayDef('gold');
    expect(strategy.canApply(buildContext())).toBe(false);
  });

  it('canApply returns true when valid entry with snapshot exists', () => {
    const { runCycle, buildContext } = createPopulatedStack('br-ok');

    runCycle(100, 5);

    const strategy = createBestReplayDef('gold');
    expect(strategy.canApply(buildContext())).toBe(true);
  });

  it('minCycles option gates applicability on cycle count', () => {
    const { runCycle, buildContext } = createPopulatedStack('br-mincycles');

    runCycle(100, 5);

    const strategy = createBestReplayDef('gold', { minCycles: 3 });
    // cycle.count is 1 after one completed cycle
    expect(strategy.canApply(buildContext())).toBe(false);

    runCycle(80, 4);
    // cycle.count is 2
    expect(strategy.canApply(buildContext())).toBe(false);

    runCycle(60, 3);
    // cycle.count is 3
    expect(strategy.canApply(buildContext())).toBe(true);
  });

  it('threshold gates applicability on the best entry value', () => {
    const { runCycle, buildContext } = createPopulatedStack('br-thresh');

    runCycle(50, 5);

    const strategy = createBestReplayDef('gold', { threshold: 100 });
    expect(strategy.canApply(buildContext())).toBe(false);

    runCycle(150, 5);
    expect(strategy.canApply(buildContext())).toBe(true);
  });

  // ==========================================================================
  // score
  // ==========================================================================

  it('scores absolute improvement of the best over the last cycle, in log10', () => {
    const { runCycle, buildContext } = createPopulatedStack('br-score');

    runCycle(200, 10);
    runCycle(50, 5);

    const strategy = createBestReplayDef('gold');
    // Bounded log10 magnitudes, so unbounded quantities can't overflow toNumber().
    expect(strategy.score(buildContext())).toBeCloseTo(Math.log10(200) - Math.log10(50), 10);
  });

  it('scores a per-second metric by rate', () => {
    const { runCycle, buildContext } = createPopulatedStack('br-score-rate', {
      metric: { mode: 'perSecond' },
    });

    runCycle(100, 5); // best: 20/s
    runCycle(40, 4); // last: 10/s

    const strategy = createBestReplayDef('gold');
    expect(strategy.score(buildContext())).toBeCloseTo(Math.log10(2), 10);
  });

  it('scores the projected best against the observed last cycle', () => {
    const { runCycle, buildContext } = createPopulatedStack('br-score-projected', {
      metric: { mode: 'absolute', project: (observed) => observed.mul(2) },
    });

    runCycle(100, 5); // best: projected 200
    runCycle(50, 5); // last: 50 observed

    const strategy = createBestReplayDef('gold');
    expect(strategy.score(buildContext())).toBeCloseTo(Math.log10(200) - Math.log10(50), 10);
  });

  it('stays applicable at zero improvement', () => {
    const { runCycle, buildContext } = createPopulatedStack('br-score-zero');

    runCycle(200, 10);

    const strategy = createBestReplayDef('gold');
    const ctx = buildContext();
    expect(strategy.canApply(ctx)).toBe(true);
    expect(strategy.score(ctx)).toBe(0);
  });

  it('scores a zero-elapsed last cycle as no rate', () => {
    const { runCycle, buildContext } = createPopulatedStack('br-score-instant', {
      metric: { mode: 'perSecond' },
    });

    runCycle(100, 5); // best: 20/s
    runCycle(10, 0); // last: no rate

    const strategy = createBestReplayDef('gold');
    expect(strategy.score(buildContext())).toBeCloseTo(Math.log10(20), 10);
  });

  it('keeps scores finite and ordered above the double-overflow threshold', () => {
    // Two configs whose values exceed ~1e308 must still rank distinctly rather
    // than both scoring Infinity and collapsing arbitration to registration order.
    const low = createPopulatedStack('br-huge-low');
    low.runCycle('1e400', 10);
    low.runCycle('1e350', 10);
    const scoreLow = createBestReplayDef('gold').score(low.buildContext());

    const high = createPopulatedStack('br-huge-high');
    high.runCycle('1e500', 10);
    high.runCycle('1e350', 10);
    const scoreHigh = createBestReplayDef('gold').score(high.buildContext());

    expect(Number.isFinite(scoreLow)).toBe(true);
    expect(Number.isFinite(scoreHigh)).toBe(true);
    expect(scoreHigh).toBeGreaterThan(scoreLow);
  });

  // ==========================================================================
  // recommend
  // ==========================================================================

  it('recommend returns the stored strategySnapshot', () => {
    const { runCycle, buildContext } = createPopulatedStack('br-rec');

    runCycle(150, 5);

    const strategy = createBestReplayDef('gold');
    const ctx = buildContext();
    const result = strategy.recommend(ctx);

    expect(result.snapshot).toEqual({ queue: ['spell-a', 'spell-b'] });
  });

  it('rationale contains metric comparison with current cycle data', () => {
    const { runCycle, buildContext } = createPopulatedStack('br-rationale');

    // First cycle: gold = 100 (sets the best)
    runCycle(100, 5);
    // Second cycle: gold = 50 (worse, doesn't beat best)
    runCycle(50, 5);

    const strategy = createBestReplayDef('gold');
    const ctx = buildContext();
    const result = strategy.recommend(ctx);

    expect(result.rationale.strategyId).toBe('best-replay:gold');
    expect(result.rationale.metrics.gold).toBeDefined();
    // Current should be last cycle's delta (50)
    expect(Decimal.eq(result.rationale.metrics.gold.current, 50)).toBe(true);
    // Projected should be the best value (100)
    expect(Decimal.eq(result.rationale.metrics.gold.projected, 100)).toBe(true);
    // Delta = 100 - 50 = 50
    expect(Decimal.eq(result.rationale.metrics.gold.delta, 50)).toBe(true);
  });

  it('uses custom id when provided', () => {
    const { runCycle, buildContext } = createPopulatedStack('br-custom-id');
    runCycle(100, 5);

    const strategy = createBestReplayDef('gold', { id: 'my-replay' });
    expect(strategy.id).toBe('my-replay');

    const result = strategy.recommend(buildContext());
    expect(result.rationale.strategyId).toBe('my-replay');
  });
});
