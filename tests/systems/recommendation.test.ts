import { describe, it, expect, vi } from 'vitest';
import { bn } from '@/primitives/decimal';
import { createResource, addResource } from '@/core/resource';
import {
  beginPersistentContext,
  endPersistentContext,
  deserializePersistents,
  getAllPersistentRefs,
} from '@/core/persistence';
import { createCycle } from '@/systems/cycle';
import { createCycleLog } from '@/systems/cycle-log';
import { createBestOf } from '@/systems/best-of';
import { createRecommendationSystem } from '@/systems/recommendation';
import type { Recommender, Recommendation, RecommendationContext } from '@/systems/recommendation';
import { createManualTicks } from '../helpers/manual-ticks';

/** Create a minimal Cycle + CycleLog + BestOf stack for testing */
function createTestStack(prefix: string) {
  const tick = createManualTicks();

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
    metrics: { gold: { mode: 'absolute' } },
    cycleLog,
    captureConfig: () => ({ queue: 'test-snapshot' }),
  });

  return { tick, gold, cycle, cycleLog, bestOf };
}

/** A simple strategy factory for tests */
function makeStrategy(overrides: Partial<Recommender> & { id: string }): Recommender {
  return {
    canApply: () => true,
    score: () => 1,
    recommend: () => ({
      snapshot: { config: overrides.id },
      rationale: {
        recommenderId: overrides.id,
        metrics: {},
        description: `Apply ${overrides.id}`,
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
    const { cycle, cycleLog, bestOf } = createTestStack('basic-empty');
    const recs = createRecommendationSystem({
      id: 'rec-empty',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
    });

    expect(recs.lastRecommendation.value).toBeNull();
    expect(recs.autoApply.value).toBe(false);
    expect(recs.recommenders).toHaveLength(0);
  });

  it('pre-registers strategies from options', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('basic-pre');
    const s1 = makeStrategy({ id: 'a' });
    const s2 = makeStrategy({ id: 'b' });
    const recs = createRecommendationSystem({
      id: 'rec-pre',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [s1, s2],
    });

    expect(recs.recommenders).toHaveLength(2);
    expect(recs.recommenders[0].id).toBe('a');
    expect(recs.recommenders[1].id).toBe('b');
  });

  // ==========================================================================
  // evaluate() — strategy selection
  // ==========================================================================

  it('returns null when no strategies are registered', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('eval-none');
    const recs = createRecommendationSystem({
      id: 'rec-eval-none',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
    });

    expect(recs.evaluate()).toBeNull();
  });

  it('returns null when no strategies are applicable', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('eval-skip');
    const recs = createRecommendationSystem({
      id: 'rec-eval-skip',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [makeStrategy({ id: 'nope', canApply: () => false })],
    });

    expect(recs.evaluate()).toBeNull();
  });

  it('picks the single applicable strategy', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('eval-single');
    const recs = createRecommendationSystem({
      id: 'rec-eval-single',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [makeStrategy({ id: 'winner' })],
    });

    const result = recs.evaluate();
    expect(result).not.toBeNull();
    expect(result!.recommenderId).toBe('winner');
    expect(result!.applied).toBe(false);
    expect(result!.snapshot).toEqual({ config: 'winner' });
  });

  it('picks the highest-scoring strategy among applicable ones', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('eval-score');
    const recs = createRecommendationSystem({
      id: 'rec-eval-score',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [
        makeStrategy({ id: 'low', score: () => 1 }),
        makeStrategy({ id: 'high', score: () => 10 }),
        makeStrategy({ id: 'mid', score: () => 5 }),
      ],
    });

    const result = recs.evaluate();
    expect(result!.recommenderId).toBe('high');
  });

  it('first-registered wins on score tie', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('eval-tie');
    const recs = createRecommendationSystem({
      id: 'rec-eval-tie',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [
        makeStrategy({ id: 'first', score: () => 5 }),
        makeStrategy({ id: 'second', score: () => 5 }),
      ],
    });

    const result = recs.evaluate();
    expect(result!.recommenderId).toBe('first');
  });

  it('skips strategies where canApply returns false', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('eval-filter');
    const recs = createRecommendationSystem({
      id: 'rec-eval-filter',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [
        makeStrategy({ id: 'blocked', canApply: () => false, score: () => 100 }),
        makeStrategy({ id: 'available', score: () => 1 }),
      ],
    });

    const result = recs.evaluate();
    expect(result!.recommenderId).toBe('available');
  });

  // ==========================================================================
  // evaluate() — context correctness
  // ==========================================================================

  it('passes getCurrentSnapshot and getState to strategy context', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('eval-ctx');
    let capturedCtx: RecommendationContext | null = null;

    const recs = createRecommendationSystem({
      id: 'rec-eval-ctx',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({ loadout: 'fire' }),
      applySnapshot: () => {},
      getGameState: () => ({ goal: 'gold' }),
      recommenders: [
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
    expect(capturedCtx!.gameState).toEqual({ goal: 'gold' });
    expect(capturedCtx!.cycleLog).toBe(cycleLog);
    expect(capturedCtx!.bestOf).toBe(bestOf);
    expect(capturedCtx!.cycle).toBe(cycle);
  });

  it('defaults state to empty object when getState is not provided', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('eval-nostate');
    let capturedState: Record<string, unknown> = { should: 'not be here' };

    const recs = createRecommendationSystem({
      id: 'rec-eval-nostate',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [
        makeStrategy({
          id: 'spy',
          canApply: (ctx) => {
            capturedState = ctx.gameState;
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
    const { cycle, cycleLog, bestOf } = createTestStack('evt-rec');
    const received: Recommendation[] = [];

    const recs = createRecommendationSystem({
      id: 'rec-evt-rec',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [makeStrategy({ id: 'a' })],
    });

    recs.on('recommended', (rec) => received.push(rec));
    recs.evaluate();

    expect(received).toHaveLength(1);
    expect(received[0].recommenderId).toBe('a');
  });

  it('does not emit recommend when no strategy applies', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('evt-norec');
    const received: Recommendation[] = [];

    const recs = createRecommendationSystem({
      id: 'rec-evt-norec',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [makeStrategy({ id: 'skip', canApply: () => false })],
    });

    recs.on('recommended', (rec) => received.push(rec));
    recs.evaluate();

    expect(received).toHaveLength(0);
  });

  // ==========================================================================
  // autoApply
  // ==========================================================================

  it('does not call applySnapshot when autoApply is false', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('auto-off');
    const applySpy = vi.fn();

    const recs = createRecommendationSystem({
      id: 'rec-auto-off',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: applySpy,
      recommenders: [makeStrategy({ id: 'a' })],
    });

    recs.evaluate();
    expect(applySpy).not.toHaveBeenCalled();
    expect(recs.lastRecommendation.value!.applied).toBe(false);
  });

  it('calls applySnapshot and emits apply when autoApply is true', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('auto-on');
    const applySpy = vi.fn();
    const applyEvents: Recommendation[] = [];

    const recs = createRecommendationSystem({
      id: 'rec-auto-on',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: applySpy,
      recommenders: [makeStrategy({ id: 'a' })],
    });

    recs.autoApply.value = true;
    recs.on('applied', (rec) => applyEvents.push(rec));
    recs.evaluate();

    expect(applySpy).toHaveBeenCalledOnce();
    expect(applySpy).toHaveBeenCalledWith({ config: 'a' });
    expect(recs.lastRecommendation.value!.applied).toBe(true);
    expect(applyEvents).toHaveLength(1);
  });

  it('does not mutate the already-emitted recommend payload when auto-applying', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('auto-clone');
    const recommendEvents: Recommendation[] = [];

    const recs = createRecommendationSystem({
      id: 'rec-auto-clone',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [makeStrategy({ id: 'a' })],
    });

    recs.autoApply.value = true;
    recs.on('recommended', (rec) => recommendEvents.push(rec));
    recs.evaluate();

    // The object handed to 'recommended' listeners must stay applied=false even
    // though auto-apply flipped applied=true immediately afterward (auto mode
    // used to mutate the shared object in place; manual apply() clones).
    expect(recommendEvents).toHaveLength(1);
    expect(recommendEvents[0]!.applied).toBe(false);
  });

  // ==========================================================================
  // Manual apply
  // ==========================================================================

  it('apply() calls applySnapshot on a pending recommendation', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('apply-manual');
    const applySpy = vi.fn();
    const applyEvents: Recommendation[] = [];

    const recs = createRecommendationSystem({
      id: 'rec-apply-manual',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: applySpy,
      recommenders: [makeStrategy({ id: 'a' })],
    });

    recs.on('applied', (rec) => applyEvents.push(rec));
    recs.evaluate();
    expect(applySpy).not.toHaveBeenCalled();

    recs.apply();
    expect(applySpy).toHaveBeenCalledOnce();
    expect(recs.lastRecommendation.value!.applied).toBe(true);
    expect(applyEvents).toHaveLength(1);
  });

  it('apply() is a no-op when lastRecommendation is null', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('apply-null');
    const applySpy = vi.fn();

    const recs = createRecommendationSystem({
      id: 'rec-apply-null',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: applySpy,
    });

    recs.apply();
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('apply() is a no-op when recommendation is already applied', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('apply-dup');
    const applySpy = vi.fn();

    const recs = createRecommendationSystem({
      id: 'rec-apply-dup',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: applySpy,
      recommenders: [makeStrategy({ id: 'a' })],
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
    const { cycle, cycleLog, bestOf } = createTestStack('dismiss-ok');
    let dismissed = false;

    const recs = createRecommendationSystem({
      id: 'rec-dismiss-ok',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [makeStrategy({ id: 'a' })],
    });

    recs.on('dismissed', () => {
      dismissed = true;
    });
    recs.evaluate();
    expect(recs.lastRecommendation.value).not.toBeNull();

    recs.dismiss();
    expect(recs.lastRecommendation.value).toBeNull();
    expect(dismissed).toBe(true);
  });

  it('dismiss() is a no-op when lastRecommendation is already null', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('dismiss-null');
    let dismissed = false;

    const recs = createRecommendationSystem({
      id: 'rec-dismiss-null',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
    });

    recs.on('dismissed', () => {
      dismissed = true;
    });
    recs.dismiss();
    expect(dismissed).toBe(false);
  });

  // ==========================================================================
  // Cycle wiring
  // ==========================================================================

  it('evaluates automatically on cycle afterEnd', () => {
    const { tick, gold, cycle, cycleLog, bestOf } = createTestStack('wire-auto');
    const received: Recommendation[] = [];

    const recs = createRecommendationSystem({
      id: 'rec-wire-auto',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [makeStrategy({ id: 'auto' })],
    });

    recs.on('recommended', (rec) => received.push(rec));

    // Run a cycle cycle: start → tick → end
    cycle.resume();
    addResource(gold, bn(50));
    tick.tick(1);
    cycle.end();

    expect(received).toHaveLength(1);
    expect(received[0].recommenderId).toBe('auto');
  });

  it('dispose() stops auto-evaluation on subsequent restarts', () => {
    const { tick, gold, cycle, cycleLog, bestOf } = createTestStack('wire-disp');
    const received: Recommendation[] = [];

    const recs = createRecommendationSystem({
      id: 'rec-wire-disp',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [makeStrategy({ id: 'a' })],
    });

    recs.on('recommended', (rec) => received.push(rec));
    recs.dispose();

    cycle.resume();
    addResource(gold, bn(50));
    tick.tick(1);
    cycle.end();

    expect(received).toHaveLength(0);
  });

  // ==========================================================================
  // register / unregister
  // ==========================================================================

  it('register() adds a strategy that subsequent evaluate() can select', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('reg-add');
    const recs = createRecommendationSystem({
      id: 'rec-reg-add',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
    });

    expect(recs.evaluate()).toBeNull();

    recs.register(makeStrategy({ id: 'late' }));
    const result = recs.evaluate();
    expect(result!.recommenderId).toBe('late');
  });

  it('register() throws on a repeated id and keeps the first def', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('reg-dup');
    const recs = createRecommendationSystem({
      id: 'rec-reg-dup',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [makeStrategy({ id: 'a' })],
    });

    expect(() => recs.register(makeStrategy({ id: 'a', score: () => 999 }))).toThrow(
      /duplicate recommender id "a"/,
    );
    expect(recs.recommenders).toHaveLength(1);
  });

  it('a repeated id among the initial defs throws at construction', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('reg-dup-initial');
    expect(() =>
      createRecommendationSystem({
        id: 'rec-reg-dup-initial',
        cycle,
        cycleLog,
        bestOf,
        getCurrentSnapshot: () => ({}),
        applySnapshot: () => {},
        recommenders: [makeStrategy({ id: 'a' }), makeStrategy({ id: 'a' })],
      }),
    ).toThrow(/duplicate recommender id "a"/);
  });

  it('unregister() removes a strategy', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('reg-rm');
    const recs = createRecommendationSystem({
      id: 'rec-reg-rm',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [makeStrategy({ id: 'a' }), makeStrategy({ id: 'b' })],
    });

    recs.unregister('a');
    expect(recs.recommenders).toHaveLength(1);
    expect(recs.recommenders[0].id).toBe('b');
  });

  it('unregister() is a no-op for unknown ids', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('reg-rmnone');
    const recs = createRecommendationSystem({
      id: 'rec-reg-rmnone',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [makeStrategy({ id: 'a' })],
    });

    recs.unregister('nonexistent');
    expect(recs.recommenders).toHaveLength(1);
  });

  // ==========================================================================
  // Persistence
  // ==========================================================================

  it('lastRecommendation persists via storedRecommendation ref', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('persist');
    const recs = createRecommendationSystem({
      id: 'rec-persist',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [
        makeStrategy({
          id: 'persisted',
          recommend: () => ({
            snapshot: { loadout: 'fire' },
            rationale: {
              recommenderId: 'persisted',
              metrics: {
                gold: { current: '10', projected: '20', delta: '10' },
              },
              description: 'Use fire loadout',
            },
          }),
        }),
      ],
    });

    recs.evaluate();
    const rec = recs.lastRecommendation.value;
    expect(rec).not.toBeNull();
    expect(rec!.recommenderId).toBe('persisted');
    expect(rec!.snapshot).toEqual({ loadout: 'fire' });
    expect(rec!.rationale.description).toBe('Use fire loadout');
    expect(rec!.rationale.metrics.gold).toEqual({
      current: '10',
      projected: '20',
      delta: '10',
    });
  });

  it('loads the rationale description from the saved summary key', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('legacy-summary');
    const recs = createRecommendationSystem({
      id: 'rec-legacy-summary',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [],
    });

    deserializePersistents(getAllPersistentRefs(), {
      'rec-legacy-summary': {
        storedRecommendation: {
          recommenderId: 'old',
          snapshot: {},
          rationale: { recommenderId: 'old', metrics: {}, summary: 'Use fire loadout' },
          timestamp: 1,
          applied: false,
        },
      },
    });

    expect(recs.lastRecommendation.value!.rationale.description).toBe('Use fire loadout');
  });

  // ==========================================================================
  // lastRecommendation updates on each evaluate
  // ==========================================================================

  it('a system built with the id of a disposed one keeps autoApply', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('rebuild');
    const options = {
      id: 'rec-rebuild',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
    };
    const first = createRecommendationSystem(options);
    first.autoApply.value = true;
    first.dispose();

    expect(createRecommendationSystem(options).autoApply.value).toBe(true);
  });

  it('evaluate() replaces previous recommendation', () => {
    const { cycle, cycleLog, bestOf } = createTestStack('replace');
    let callCount = 0;

    const recs = createRecommendationSystem({
      id: 'rec-replace',
      cycle,
      cycleLog,
      bestOf,
      getCurrentSnapshot: () => ({}),
      applySnapshot: () => {},
      recommenders: [
        makeStrategy({
          id: 'counter',
          recommend: () => {
            callCount++;
            return {
              snapshot: { n: callCount },
              rationale: {
                recommenderId: 'counter',
                metrics: {},
                description: `Call ${callCount}`,
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
