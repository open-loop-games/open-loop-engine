import { describe, it, expect } from 'vitest';
import type { Analyzer, AnalyzerResult } from '@/primitives/types';
import { createEngine, type Engine } from '@/index';
import { resetAllPersistentContexts } from '@/core/persistence';
import { runUntil } from '@/harness';

// --- helpers ---

/** Minimal Engine shape for testing harness behavior in isolation.
 *  Only `engine.tickDriver.advanceTime` is exercised by runUntil; the rest of
 *  the Engine surface is irrelevant here. A monotonic counter gives
 *  predicates something to close over; the stub also records the most
 *  recent dt so tests can pin the caller's tickDelta reaches the engine. */
function createTestEngine(): Engine & {
  readonly tickCount: number;
  readonly lastDt: number;
  readonly dts: readonly number[];
} {
  let tickCount = 0;
  let lastDt = 0;
  const dts: number[] = [];
  const engine = {
    tickDriver: {
      advanceTime: (dt: number) => {
        tickCount += 1;
        lastDt = dt;
        dts.push(dt);
      },
    },
    get tickCount() {
      return tickCount;
    },
    get lastDt() {
      return lastDt;
    },
    get dts() {
      return dts;
    },
  };
  return engine as unknown as Engine & {
    readonly tickCount: number;
    readonly lastDt: number;
    readonly dts: readonly number[];
  };
}

/** Real engine earning 1 gold per simulated second through `ctx.onTick`. */
function createGoldEngine(maxDeltaTime?: number): Engine & { readonly gold: number } {
  resetAllPersistentContexts();
  let gold = 0;
  const engine = createEngine({ gameId: 'gold-per-second', persistence: false, maxDeltaTime });
  engine.use({
    id: 'gold',
    install(ctx) {
      ctx.onTick((dt) => {
        gold += dt;
      });
    },
  });
  engine.start();
  return Object.defineProperty(engine, 'gold', { get: () => gold }) as Engine & {
    readonly gold: number;
  };
}

/** Analyzer factory that records lifecycle calls as metrics. */
function createLifecycleAnalyzer(): Analyzer {
  let starts = 0;
  let ticks = 0;
  let ends = 0;
  const tickIndices: number[] = [];
  return {
    name: 'lifecycle',
    onStart: () => {
      starts += 1;
    },
    onTick: (i) => {
      ticks += 1;
      tickIndices.push(i);
    },
    onEnd: () => {
      ends += 1;
    },
    summarize: (): AnalyzerResult => ({
      name: 'lifecycle',
      metrics: {
        starts,
        ticks,
        ends,
        firstTickIndex: tickIndices[0] ?? -1,
        lastTickIndex: tickIndices[tickIndices.length - 1] ?? -1,
      },
    }),
  };
}

describe('runUntil', () => {
  it('terminates at tick 0 when the predicate is satisfied before stepping', () => {
    const engine = createTestEngine();
    const result = runUntil({
      engine,
      until: () => true,
      maxSimTime: 10,
    });
    expect(result.terminated).toBe('predicate');
    expect(result.totalTicks).toBe(0);
    expect(result.elapsedSimulated).toBe(0);
    expect(engine.tickCount).toBe(0);
  });

  it('terminates mid-run with the correct tick count and sim-time', () => {
    const engine = createTestEngine();
    const result = runUntil({
      engine,
      until: ({ iteration: tick }) => tick >= 5,
      maxSimTime: 10,
      tickDelta: 0.1,
    });
    expect(result.terminated).toBe('predicate');
    expect(result.totalTicks).toBe(5);
    expect(result.elapsedSimulated).toBeCloseTo(0.5, 10);
    expect(engine.tickCount).toBe(5);
  });

  it('returns terminated: maxSimTime when the predicate never fires', () => {
    const engine = createTestEngine();
    const result = runUntil({
      engine,
      until: () => false,
      maxSimTime: 1,
      tickDelta: 0.1,
    });
    expect(result.terminated).toBe('maxSimTime');
    // Math.floor(1 / 0.1) === 10 ticks, stepped 10 times with sim-time 1.0.
    expect(result.totalTicks).toBe(10);
    expect(result.elapsedSimulated).toBeCloseTo(1.0, 10);
  });

  it('steps the final tick when maxSimTime / tickDelta lands a hair under an integer', () => {
    const engine = createTestEngine();
    // 0.7 / 0.1 is 6.999999999999999 in binary floating point.
    const result = runUntil({ engine, until: () => false, maxSimTime: 0.7, tickDelta: 0.1 });
    expect(result.terminated).toBe('maxSimTime');
    expect(result.totalTicks).toBe(7);
    expect(result.elapsedSimulated).toBeCloseTo(0.7, 10);
  });

  it('defaults tickDelta to 0.05', () => {
    const engine = createTestEngine();
    const result = runUntil({
      engine,
      until: ({ iteration: tick }) => tick >= 3,
      maxSimTime: 1,
    });
    expect(result.elapsedSimulated).toBeCloseTo(0.15, 10);
  });

  it('fires analyzer lifecycle onStart/onTick/onEnd in order', () => {
    const engine = createTestEngine();
    const result = runUntil({
      engine,
      until: ({ iteration: tick }) => tick >= 3,
      maxSimTime: 1,
      tickDelta: 0.1,
      setup: () => [createLifecycleAnalyzer()],
    });
    const metrics = result.analyzerResults[0]!.metrics;
    expect(metrics.starts).toBe(1);
    expect(metrics.ticks).toBe(3);
    expect(metrics.ends).toBe(1);
    // onTick receives the index of the tick just stepped (0..totalTicks-1).
    expect(metrics.firstTickIndex).toBe(0);
    expect(metrics.lastTickIndex).toBe(2);
  });

  it('does not fire analyzer onTick when the predicate fires at tick 0', () => {
    const engine = createTestEngine();
    const result = runUntil({
      engine,
      until: () => true,
      maxSimTime: 1,
      setup: () => [createLifecycleAnalyzer()],
    });
    const metrics = result.analyzerResults[0]!.metrics;
    expect(metrics.starts).toBe(1);
    expect(metrics.ticks).toBe(0);
    expect(metrics.ends).toBe(1);
  });

  it('passes iteration and simTime in the predicate context', () => {
    const engine = createTestEngine();
    const seen: Array<{ iteration: number; simTime: number }> = [];
    runUntil({
      engine,
      until: (ctx) => {
        seen.push(ctx);
        return ctx.iteration >= 2;
      },
      maxSimTime: 1,
      tickDelta: 0.1,
    });
    expect(seen).toEqual([
      { iteration: 0, simTime: 0 },
      { iteration: 1, simTime: 0.1 },
      { iteration: 2, simTime: 0.2 },
    ]);
  });

  it("forwards caller's tickDelta to engine.tickDriver.advanceTime", () => {
    const engine = createTestEngine();
    runUntil({
      engine,
      until: ({ iteration: tick }) => tick >= 3,
      maxSimTime: 10,
      tickDelta: 0.25,
    });
    expect(engine.tickCount).toBe(3);
    expect(engine.lastDt).toBe(0.25);
    expect([...engine.dts]).toEqual([0.25, 0.25, 0.25]);
  });

  it('omits setup when no analyzers are configured', () => {
    const engine = createTestEngine();
    const result = runUntil({
      engine,
      until: ({ iteration: tick }) => tick >= 1,
      maxSimTime: 1,
    });
    expect(result.analyzerResults).toEqual([]);
  });

  it('simulates every second it reports when tickDelta exceeds maxDeltaTime', () => {
    const engine = createGoldEngine();
    try {
      const result = runUntil({
        engine,
        until: () => engine.gold >= 100 - 1e-9,
        maxSimTime: 1000,
        tickDelta: 5,
      });
      expect(result.terminated).toBe('predicate');
      expect(result.totalTicks).toBe(20);
      expect(result.elapsedSimulated).toBeCloseTo(100, 9);
      expect(engine.gold).toBeCloseTo(result.elapsedSimulated, 9);
    } finally {
      engine.dispose();
    }
  });
});
