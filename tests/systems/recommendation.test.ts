import { describe, it, expect, vi } from 'vitest';
import { bn } from '@/primitives/decimal';
import { createResource, addResource } from '@/core/resource';
import { beginPersistentContext, endPersistentContext } from '@/core/persistence';
import { createLoop } from '@/systems/loop';
import { createLoopLog } from '@/systems/loop-log';
import { createBestOf } from '@/systems/best-of';
import { createRecommendationSystem } from '@/systems/recommendation';
import type {
  RecommendationStrategyDef,
  Recommendation,
  RecommendationContext,
} from '@/systems/recommendation';

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

/** Create a minimal Loop + LoopLog + BestOf stack for testing */
function createTestStack(prefix: string) {
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
    captureStrategy: () => ({ queue: 'test-snapshot' }),
  });

  return { tick, gold, loop, loopLog, bestOf };
}

/** A simple strategy factory for tests */
function makeStrategy(
  overrides: Partial<RecommendationStrategyDef> & { id: string },
): RecommendationStrategyDef {
  return {
    canApply: () => true,
    score: () => 1,
    recommend: () => ({
      snapshot: { config: overrides.id },
      rationale: {
        strategyId: overrides.id,
        metrics: {},
        summary: `Apply ${overrides.id}`,
      },
    }),
    ...overrides,
  };
}

describe('createRecommendationSystem', () => {
  // ==========================================================================
  // Factory and basics
  // ==========================================================================

  it('creates with no strategies; lastRecommendation is null', () => {
    const { loop, loopLog, bestOf } = createTestStack('basic-empty');
    const recs = createRecommendationSystem({
      id: 'rec-empty',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
    });

    expect(recs.lastRecommendation.value).toBeNull();
    expect(recs.autoApply.value).toBe(false);
    expect(recs.strategies).toHaveLength(0);
  });

  it('pre-registers strategies from options', () => {
    const { loop, loopLog, bestOf } = createTestStack('basic-pre');
    const s1 = makeStrategy({ id: 'a' });
    const s2 = makeStrategy({ id: 'b' });
    const recs = createRecommendationSystem({
      id: 'rec-pre',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      strategies: [s1, s2],
    });

    expect(recs.strategies).toHaveLength(2);
    expect(recs.strategies[0].id).toBe('a');
    expect(recs.strategies[1].id).toBe('b');
  });

  // ==========================================================================
  // evaluate() — strategy selection
  // ==========================================================================

  it('returns null when no strategies are registered', () => {
    const { loop, loopLog, bestOf } = createTestStack('eval-none');
    const recs = createRecommendationSystem({
      id: 'rec-eval-none',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
    });

    expect(recs.evaluate()).toBeNull();
  });

  it('returns null when no strategies are applicable', () => {
    const { loop, loopLog, bestOf } = createTestStack('eval-skip');
    const recs = createRecommendationSystem({
      id: 'rec-eval-skip',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      strategies: [makeStrategy({ id: 'nope', canApply: () => false })],
    });

    expect(recs.evaluate()).toBeNull();
  });

  it('picks the single applicable strategy', () => {
    const { loop, loopLog, bestOf } = createTestStack('eval-single');
    const recs = createRecommendationSystem({
      id: 'rec-eval-single',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      strategies: [makeStrategy({ id: 'winner' })],
    });

    const result = recs.evaluate();
    expect(result).not.toBeNull();
    expect(result!.strategyId).toBe('winner');
    expect(result!.applied).toBe(false);
    expect(result!.snapshot).toEqual({ config: 'winner' });
  });

  it('picks the highest-scoring strategy among applicable ones', () => {
    const { loop, loopLog, bestOf } = createTestStack('eval-score');
    const recs = createRecommendationSystem({
      id: 'rec-eval-score',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      strategies: [
        makeStrategy({ id: 'low', score: () => 1 }),
        makeStrategy({ id: 'high', score: () => 10 }),
        makeStrategy({ id: 'mid', score: () => 5 }),
      ],
    });

    const result = recs.evaluate();
    expect(result!.strategyId).toBe('high');
  });

  it('first-registered wins on score tie', () => {
    const { loop, loopLog, bestOf } = createTestStack('eval-tie');
    const recs = createRecommendationSystem({
      id: 'rec-eval-tie',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      strategies: [
        makeStrategy({ id: 'first', score: () => 5 }),
        makeStrategy({ id: 'second', score: () => 5 }),
      ],
    });

    const result = recs.evaluate();
    expect(result!.strategyId).toBe('first');
  });

  it('skips strategies where canApply returns false', () => {
    const { loop, loopLog, bestOf } = createTestStack('eval-filter');
    const recs = createRecommendationSystem({
      id: 'rec-eval-filter',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      strategies: [
        makeStrategy({ id: 'blocked', canApply: () => false, score: () => 100 }),
        makeStrategy({ id: 'available', score: () => 1 }),
      ],
    });

    const result = recs.evaluate();
    expect(result!.strategyId).toBe('available');
  });

  // ==========================================================================
  // evaluate() — context correctness
  // ==========================================================================

  it('passes getCurrentSnapshot and getState to strategy context', () => {
    const { loop, loopLog, bestOf } = createTestStack('eval-ctx');
    let capturedCtx: RecommendationContext | null = null;

    const recs = createRecommendationSystem({
      id: 'rec-eval-ctx',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({ loadout: 'fire' }),
      applySnapshot: () => {},
      getState: () => ({ goal: 'gold' }),
      strategies: [
        makeStrategy({
          id: 'spy',
          canApply: (ctx) => {
            capturedCtx = ctx;
            return true;
          },
        }),
      ],
    });

    recs.evaluate();
    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.currentSnapshot).toEqual({ loadout: 'fire' });
    expect(capturedCtx!.state).toEqual({ goal: 'gold' });
    expect(capturedCtx!.loopLog).toBe(loopLog);
    expect(capturedCtx!.bestOf).toBe(bestOf);
    expect(capturedCtx!.loop).toBe(loop);
  });

  it('defaults state to empty object when getState is not provided', () => {
    const { loop, loopLog, bestOf } = createTestStack('eval-nostate');
    let capturedState: Record<string, unknown> = { should: 'not be here' };

    const recs = createRecommendationSystem({
      id: 'rec-eval-nostate',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      strategies: [
        makeStrategy({
          id: 'spy',
          canApply: (ctx) => {
            capturedState = ctx.state;
            return true;
          },
        }),
      ],
    });

    recs.evaluate();
    expect(capturedState).toEqual({});
  });

  // ==========================================================================
  // Events
  // ==========================================================================

  it('emits recommend event when evaluation produces a winner', () => {
    const { loop, loopLog, bestOf } = createTestStack('evt-rec');
    const received: Recommendation[] = [];

    const recs = createRecommendationSystem({
      id: 'rec-evt-rec',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      strategies: [makeStrategy({ id: 'a' })],
    });

    recs.on('recommend', (rec) => received.push(rec));
    recs.evaluate();

    expect(received).toHaveLength(1);
    expect(received[0].strategyId).toBe('a');
  });

  it('does not emit recommend when no strategy applies', () => {
    const { loop, loopLog, bestOf } = createTestStack('evt-norec');
    const received: Recommendation[] = [];

    const recs = createRecommendationSystem({
      id: 'rec-evt-norec',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      strategies: [makeStrategy({ id: 'skip', canApply: () => false })],
    });

    recs.on('recommend', (rec) => received.push(rec));
    recs.evaluate();

    expect(received).toHaveLength(0);
  });

  // ==========================================================================
  // autoApply
  // ==========================================================================

  it('does not call applySnapshot when autoApply is false', () => {
    const { loop, loopLog, bestOf } = createTestStack('auto-off');
    const applySpy = vi.fn();

    const recs = createRecommendationSystem({
      id: 'rec-auto-off',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: applySpy,
      strategies: [makeStrategy({ id: 'a' })],
    });

    recs.evaluate();
    expect(applySpy).not.toHaveBeenCalled();
    expect(recs.lastRecommendation.value!.applied).toBe(false);
  });

  it('calls applySnapshot and emits apply when autoApply is true', () => {
    const { loop, loopLog, bestOf } = createTestStack('auto-on');
    const applySpy = vi.fn();
    const applyEvents: Recommendation[] = [];

    const recs = createRecommendationSystem({
      id: 'rec-auto-on',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: applySpy,
      strategies: [makeStrategy({ id: 'a' })],
    });

    recs.autoApply.value = true;
    recs.on('apply', (rec) => applyEvents.push(rec));
    recs.evaluate();

    expect(applySpy).toHaveBeenCalledOnce();
    expect(applySpy).toHaveBeenCalledWith({ config: 'a' });
    expect(recs.lastRecommendation.value!.applied).toBe(true);
    expect(applyEvents).toHaveLength(1);
  });

  // ==========================================================================
  // Manual apply
  // ==========================================================================

  it('apply() calls applySnapshot on a pending recommendation', () => {
    const { loop, loopLog, bestOf } = createTestStack('apply-manual');
    const applySpy = vi.fn();
    const applyEvents: Recommendation[] = [];

    const recs = createRecommendationSystem({
      id: 'rec-apply-manual',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: applySpy,
      strategies: [makeStrategy({ id: 'a' })],
    });

    recs.on('apply', (rec) => applyEvents.push(rec));
    recs.evaluate();
    expect(applySpy).not.toHaveBeenCalled();

    recs.apply();
    expect(applySpy).toHaveBeenCalledOnce();
    expect(recs.lastRecommendation.value!.applied).toBe(true);
    expect(applyEvents).toHaveLength(1);
  });

  it('apply() is a no-op when lastRecommendation is null', () => {
    const { loop, loopLog, bestOf } = createTestStack('apply-null');
    const applySpy = vi.fn();

    const recs = createRecommendationSystem({
      id: 'rec-apply-null',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: applySpy,
    });

    recs.apply();
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('apply() is a no-op when recommendation is already applied', () => {
    const { loop, loopLog, bestOf } = createTestStack('apply-dup');
    const applySpy = vi.fn();

    const recs = createRecommendationSystem({
      id: 'rec-apply-dup',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: applySpy,
      strategies: [makeStrategy({ id: 'a' })],
    });

    recs.autoApply.value = true;
    recs.evaluate();
    expect(applySpy).toHaveBeenCalledOnce();

    recs.apply();
    expect(applySpy).toHaveBeenCalledOnce(); // not called again
  });

  // ==========================================================================
  // dismiss
  // ==========================================================================

  it('dismiss() clears lastRecommendation and emits dismiss', () => {
    const { loop, loopLog, bestOf } = createTestStack('dismiss-ok');
    let dismissed = false;

    const recs = createRecommendationSystem({
      id: 'rec-dismiss-ok',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      strategies: [makeStrategy({ id: 'a' })],
    });

    recs.on('dismiss', () => {
      dismissed = true;
    });
    recs.evaluate();
    expect(recs.lastRecommendation.value).not.toBeNull();

    recs.dismiss();
    expect(recs.lastRecommendation.value).toBeNull();
    expect(dismissed).toBe(true);
  });

  it('dismiss() is a no-op when lastRecommendation is already null', () => {
    const { loop, loopLog, bestOf } = createTestStack('dismiss-null');
    let dismissed = false;

    const recs = createRecommendationSystem({
      id: 'rec-dismiss-null',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
    });

    recs.on('dismiss', () => {
      dismissed = true;
    });
    recs.dismiss();
    expect(dismissed).toBe(false);
  });

  // ==========================================================================
  // Loop wiring
  // ==========================================================================

  it('evaluates automatically on loop afterRestart', () => {
    const { tick, gold, loop, loopLog, bestOf } = createTestStack('wire-auto');
    const received: Recommendation[] = [];

    const recs = createRecommendationSystem({
      id: 'rec-wire-auto',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      strategies: [makeStrategy({ id: 'auto' })],
    });

    recs.on('recommend', (rec) => received.push(rec));

    // Run a loop cycle: start → tick → end
    loop.run();
    addResource(gold, bn(50));
    tick.tick(1);
    loop.end();

    expect(received).toHaveLength(1);
    expect(received[0].strategyId).toBe('auto');
  });

  it('dispose() stops auto-evaluation on subsequent restarts', () => {
    const { tick, gold, loop, loopLog, bestOf } = createTestStack('wire-disp');
    const received: Recommendation[] = [];

    const recs = createRecommendationSystem({
      id: 'rec-wire-disp',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      strategies: [makeStrategy({ id: 'a' })],
    });

    recs.on('recommend', (rec) => received.push(rec));
    recs.dispose();

    loop.run();
    addResource(gold, bn(50));
    tick.tick(1);
    loop.end();

    expect(received).toHaveLength(0);
  });

  // ==========================================================================
  // register / unregister
  // ==========================================================================

  it('register() adds a strategy that subsequent evaluate() can select', () => {
    const { loop, loopLog, bestOf } = createTestStack('reg-add');
    const recs = createRecommendationSystem({
      id: 'rec-reg-add',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
    });

    expect(recs.evaluate()).toBeNull();

    recs.register(makeStrategy({ id: 'late' }));
    const result = recs.evaluate();
    expect(result!.strategyId).toBe('late');
  });

  it('register() is a no-op for duplicate ids', () => {
    const { loop, loopLog, bestOf } = createTestStack('reg-dup');
    const recs = createRecommendationSystem({
      id: 'rec-reg-dup',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      strategies: [makeStrategy({ id: 'a' })],
    });

    recs.register(makeStrategy({ id: 'a', score: () => 999 }));
    expect(recs.strategies).toHaveLength(1);
  });

  it('unregister() removes a strategy', () => {
    const { loop, loopLog, bestOf } = createTestStack('reg-rm');
    const recs = createRecommendationSystem({
      id: 'rec-reg-rm',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      strategies: [makeStrategy({ id: 'a' }), makeStrategy({ id: 'b' })],
    });

    recs.unregister('a');
    expect(recs.strategies).toHaveLength(1);
    expect(recs.strategies[0].id).toBe('b');
  });

  it('unregister() is a no-op for unknown ids', () => {
    const { loop, loopLog, bestOf } = createTestStack('reg-rmnone');
    const recs = createRecommendationSystem({
      id: 'rec-reg-rmnone',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      strategies: [makeStrategy({ id: 'a' })],
    });

    recs.unregister('nonexistent');
    expect(recs.strategies).toHaveLength(1);
  });

  // ==========================================================================
  // Persistence
  // ==========================================================================

  it('lastRecommendation persists via storedRecommendation ref', () => {
    const { loop, loopLog, bestOf } = createTestStack('persist');
    const recs = createRecommendationSystem({
      id: 'rec-persist',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      strategies: [
        makeStrategy({
          id: 'persisted',
          recommend: () => ({
            snapshot: { loadout: 'fire' },
            rationale: {
              strategyId: 'persisted',
              metrics: {
                gold: { current: '10', projected: '20', delta: '10' },
              },
              summary: 'Use fire loadout',
            },
          }),
        }),
      ],
    });

    recs.evaluate();
    const rec = recs.lastRecommendation.value;
    expect(rec).not.toBeNull();
    expect(rec!.strategyId).toBe('persisted');
    expect(rec!.snapshot).toEqual({ loadout: 'fire' });
    expect(rec!.rationale.summary).toBe('Use fire loadout');
    expect(rec!.rationale.metrics.gold).toEqual({
      current: '10',
      projected: '20',
      delta: '10',
    });
  });

  // ==========================================================================
  // lastRecommendation updates on each evaluate
  // ==========================================================================

  it('evaluate() replaces previous recommendation', () => {
    const { loop, loopLog, bestOf } = createTestStack('replace');
    let callCount = 0;

    const recs = createRecommendationSystem({
      id: 'rec-replace',
      loop,
      loopLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      strategies: [
        makeStrategy({
          id: 'counter',
          recommend: () => {
            callCount++;
            return {
              snapshot: { n: callCount },
              rationale: {
                strategyId: 'counter',
                metrics: {},
                summary: `Call ${callCount}`,
              },
            };
          },
        }),
      ],
    });

    recs.evaluate();
    expect(recs.lastRecommendation.value!.snapshot).toEqual({ n: 1 });

    recs.evaluate();
    expect(recs.lastRecommendation.value!.snapshot).toEqual({ n: 2 });
  });

  // ==========================================================================
  // Type guard
  // ==========================================================================
});
