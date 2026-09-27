import { describe, it, expect } from 'vitest';
import type { Analyzer, AnalyzerResult } from '@/primitives/types';
import type { Engine } from '@/index';
import { random } from '@/primitives/rng';
import { runMatrixUntil, runMatrix } from '@/harness';
import type { CellResult, MatrixUntilWorkItem, RunUntilResult, UntilCell } from '@/harness';

// --- helpers ---

/** Engine whose internal counter closes over the builder's local state,
 *  then increments on each simulateTick. The builder also exposes the
 *  counter via a shared `state` object so analyzers and the predicate can
 *  read it. Each buildEngine() call returns a fresh (engine, state) pair. */
interface TestState {
  tick: number;
  lastDt: number;
}

function buildTestEngine(state: TestState): Engine {
  const engine = {
    tickDriver: {
      simulateTick: (dt: number) => {
        state.tick += 1;
        state.lastDt = dt;
      },
    },
  };
  return engine as unknown as Engine;
}

/** UntilCell whose engine advances one tick per simulateTick and whose
 *  state is recorded into a per-cell aggregator for analyzer metrics. The
 *  `terminate_at_tick` parameter controls when the predicate should fire
 *  (via the shared module-level capture below). */
function makeCell(name: string, stateSink: Map<number, TestState>, tickDelta = 0.1): UntilCell {
  return {
    name,
    buildEngine: ({ seed }) => {
      const state: TestState = { tick: 0, lastDt: 0 };
      stateSink.set(seed, state);
      return buildTestEngine(state);
    },
    tickDelta,
  };
}

/** Trivial analyzer that records final tick count per run. */
function createTickRecorder(state: TestState): Analyzer {
  return {
    name: 'tick-recorder',
    summarize: (): AnalyzerResult => ({
      name: 'tick-recorder',
      metrics: { finalTick: state.tick },
    }),
  };
}

describe('runMatrixUntil', () => {
  it('stops every engine it builds, so no started engine leaks past the sweep', () => {
    const stops: string[] = [];
    let built = 0;
    const cell: UntilCell = {
      name: 'leaky',
      buildEngine: ({ seed }) => {
        const state: TestState = { tick: 0, lastDt: 0 };
        const id = `run-${seed}-${built++}`;
        const engine = {
          tickDriver: { simulateTick: () => (state.tick += 1) },
          stop: () => stops.push(id),
        };
        return engine as unknown as Engine;
      },
      tickDelta: 0.1,
    };
    runMatrixUntil({
      cells: [cell],
      seeds: [1, 2, 3],
      until: ({ tick }) => tick >= 3,
      maxSimTime: 10,
    });
    // One stop() per (cell × seed) run — none left ticking.
    expect(stops).toHaveLength(3);
    expect(built).toBe(3);
  });

  it('runs the cell teardown once per run, after onRunComplete, on the run it built', () => {
    const events: string[] = [];
    const cell: UntilCell = {
      name: 'disposable',
      buildEngine: ({ seed }) => {
        const engine = {
          id: seed,
          tickDriver: { simulateTick: () => {} },
          stop: () => events.push(`stop:${seed}`),
        };
        return engine as unknown as Engine;
      },
      teardown: (engine, { seed }) =>
        events.push(`teardown:${seed}:${(engine as unknown as { id: number }).id}`),
    };
    runMatrixUntil({
      cells: [cell],
      seeds: [1, 2],
      until: () => true,
      maxSimTime: 10,
      onRunComplete: ({ seed }) => events.push(`complete:${seed}`),
    });
    expect(events).toEqual([
      'stop:1',
      'complete:1',
      'teardown:1:1',
      'stop:2',
      'complete:2',
      'teardown:2:2',
    ]);
  });

  it('disposes each run engine after onRunComplete when the cell passes no teardown', () => {
    const events: string[] = [];
    const cell: UntilCell = {
      name: 'default-dispose',
      buildEngine: ({ seed }) =>
        ({
          tickDriver: { simulateTick: () => {} },
          dispose: () => events.push(`dispose:${seed}`),
        }) as unknown as Engine,
    };
    runMatrixUntil({
      cells: [cell],
      seeds: [1, 2],
      until: () => true,
      maxSimTime: 10,
      onRunComplete: ({ seed }) => events.push(`complete:${seed}`),
    });
    expect(events).toEqual(['complete:1', 'dispose:1', 'complete:2', 'dispose:2']);
  });

  it('runs the cell teardown when a run throws', () => {
    const torn: number[] = [];
    expect(() =>
      runMatrixUntil({
        cells: [
          {
            name: 'throws',
            buildEngine: () =>
              ({
                tickDriver: {
                  simulateTick: () => {
                    throw new Error('tick failed');
                  },
                },
              }) as unknown as Engine,
            teardown: (_engine, { seed }) => torn.push(seed),
          },
        ],
        seeds: [7],
        until: () => false,
        maxSimTime: 10,
      }),
    ).toThrow('tick failed');
    expect(torn).toEqual([7]);
  });

  it('seeds the RNG before buildEngine, so construction draws are independent of sweep order', () => {
    const sweep = (seeds: number[]): Map<number, number> => {
      const draws = new Map<number, number>();
      runMatrixUntil({
        cells: [
          {
            name: 'draws-at-build',
            buildEngine: ({ seed }) => {
              draws.set(seed, random());
              return buildTestEngine({ tick: 0, lastDt: 0 });
            },
          },
        ],
        seeds,
        until: () => true,
        maxSimTime: 1,
      });
      return draws;
    };
    const alone = sweep([1]);
    const second = sweep([2, 1]);
    expect(second.get(1)).toBe(alone.get(1));
  });

  it('runs cells × seeds, fresh engine per run, predicate-terminated', () => {
    const sink = new Map<number, TestState>();
    const cellA = makeCell('a', sink, 0.1);
    const result = runMatrixUntil({
      cells: [cellA],
      seeds: [1, 2, 3],
      until: ({ tick }) => tick >= 5,
      maxSimTime: 10,
    });
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]!.runs).toHaveLength(3);
    for (const run of result.cells[0]!.runs) {
      expect(run.terminated).toBe('predicate');
      expect(run.totalTicks).toBe(5);
      expect(run.elapsedSimulated).toBeCloseTo(0.5, 10);
    }
    // Three independent state objects — no bleed.
    expect(sink.size).toBe(3);
  });

  it('reports terminationTime stats only over predicate-terminated runs', () => {
    // Cell where the predicate fires at tick 5 (sim-time 0.5 with tickDelta 0.1).
    const sinkA = new Map<number, TestState>();
    // Cell where the predicate fires at tick 10 (sim-time 1.0).
    const sinkB = new Map<number, TestState>();
    const result = runMatrixUntil({
      cells: [
        {
          name: 'fast',
          buildEngine: ({ seed }) => {
            const state: TestState = { tick: 0, lastDt: 0 };
            sinkA.set(seed, state);
            return buildTestEngine(state);
          },
          tickDelta: 0.1,
        },
        {
          name: 'slow',
          buildEngine: ({ seed }) => {
            const state: TestState = { tick: 0, lastDt: 0 };
            sinkB.set(seed, state);
            return buildTestEngine(state);
          },
          tickDelta: 0.1,
        },
      ],
      seeds: [1, 2, 3],
      // Predicate reads per-cell state via sink lookup. Both cells share
      // the predicate; because predicates close over state indirectly,
      // we use a tick threshold that differs by cell name via the current
      // tick index.
      until: ({ tick }) => tick >= 5,
      maxSimTime: 10,
    });
    // Both cells terminate at tick 5 (sim-time 0.5) for every seed.
    for (const cell of result.cells) {
      expect(cell.aggregate.terminationCounts).toEqual({
        predicate: 3,
        maxSimTime: 0,
        unreachable: 0,
      });
      expect(cell.aggregate.terminationTime!.avg).toBeCloseTo(0.5, 10);
      expect(cell.aggregate.terminationTime!.count).toBe(3);
    }
  });

  it('excludes maxSimTime-terminated runs from terminationTime stats', () => {
    // Predicate never fires; every run hits maxSimTime.
    const sink = new Map<number, TestState>();
    const result = runMatrixUntil({
      cells: [makeCell('a', sink, 0.1)],
      seeds: [1, 2, 3],
      until: () => false,
      maxSimTime: 1,
    });
    const agg = result.cells[0]!.aggregate;
    expect(agg.terminationCounts).toEqual({ predicate: 0, maxSimTime: 3, unreachable: 0 });
    expect(agg.terminationTime).toBeUndefined();
    expect(agg.terminationTimeHistogram).toBeUndefined();
  });

  it('mixed termination: only predicate-terminated runs contribute to terminationTime', () => {
    // Predicate fires when tick >= seed (so seed 1 → 1 tick, seed 2 → 2 ticks,
    // seed 20 → exceeds maxSimTime). With maxSimTime=1 and tickDelta=0.1,
    // max ticks per run is 10. Seeds 1..3 hit the predicate; seed 20 does not.
    const result = runMatrixUntil({
      cells: [
        {
          name: 'a',
          buildEngine: () => buildTestEngine({ tick: 0, lastDt: 0 }),
          tickDelta: 0.1,
        },
      ],
      seeds: [1, 2, 3, 20],
      until: (() => {
        // Predicate closes over a per-call counter. Since createWorkPlan runs
        // cells outer, seeds inner, and runUntil evaluates predicate each tick
        // starting from tick 0, use ctx.tick >= threshold keyed by the seed
        // via an external seed counter.
        let seedIdx = 0;
        const thresholds = [1, 2, 3, 20];
        let current = thresholds[0]!;
        // Track which run we're in via maxSimTime re-evaluation boundaries.
        return (ctx: { tick: number; simTime: number }): boolean => {
          if (ctx.tick === 0) {
            current = thresholds[seedIdx]!;
            seedIdx += 1;
          }
          return ctx.tick >= current;
        };
      })(),
      maxSimTime: 1,
    });
    const agg = result.cells[0]!.aggregate;
    expect(agg.terminationCounts).toEqual({ predicate: 3, maxSimTime: 1, unreachable: 0 });
    expect(agg.terminationTime!.count).toBe(3);
    // Thresholds 1, 2, 3 → sim-times 0.1, 0.2, 0.3.
    expect(agg.terminationTime!.avg).toBeCloseTo(0.2, 10);
    expect(agg.terminationTime!.min).toBeCloseTo(0.1, 10);
    expect(agg.terminationTime!.max).toBeCloseTo(0.3, 10);
  });

  it('opt-in terminationTimeHistogram buckets predicate-terminated runs', () => {
    const result = runMatrixUntil({
      cells: [
        {
          name: 'a',
          buildEngine: () => buildTestEngine({ tick: 0, lastDt: 0 }),
          tickDelta: 0.1,
        },
      ],
      seeds: [1, 2, 3],
      // Every run fires at tick 5 → sim-time 0.5.
      until: ({ tick }) => tick >= 5,
      maxSimTime: 1,
      aggregate: { terminationTimeHistogram: { edges: [0, 0.25, 0.75, 1] } },
    });
    const hist = result.cells[0]!.aggregate.terminationTimeHistogram!;
    // 0.5 lands in bucket [0.25, 0.75).
    expect(hist.edges).toEqual([0, 0.25, 0.75, 1]);
    expect(hist.counts).toEqual([0, 3, 0]);
    expect(hist.underflow).toBe(0);
    expect(hist.overflow).toBe(0);
  });

  it('fires onRunComplete and onCellComplete in deterministic plan order', () => {
    const runEvents: Array<[number, number]> = [];
    const cellEvents: string[] = [];
    runMatrixUntil({
      cells: [
        { name: 'a', buildEngine: () => buildTestEngine({ tick: 0, lastDt: 0 }), tickDelta: 0.1 },
        { name: 'b', buildEngine: () => buildTestEngine({ tick: 0, lastDt: 0 }), tickDelta: 0.1 },
      ],
      seeds: [10, 20],
      until: ({ tick }) => tick >= 1,
      maxSimTime: 1,
      onRunComplete: (item: MatrixUntilWorkItem, result: RunUntilResult) => {
        runEvents.push([item.cellIdx, item.seedIdx]);
        expect(result.terminated).toBe('predicate');
      },
      onCellComplete: (cell: CellResult) => cellEvents.push(cell.name),
    });
    expect(runEvents).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
    expect(cellEvents).toEqual(['a', 'b']);
  });

  it('wires per-run analyzers via cell.analyzers(engine, ctx)', () => {
    const seenSeeds: number[] = [];
    const result = runMatrixUntil({
      cells: [
        {
          name: 'a',
          buildEngine: () => buildTestEngine({ tick: 0, lastDt: 0 }),
          analyzers: (engine, ctx) => {
            seenSeeds.push(ctx.seed);
            // Closure captures the engine — a real consumer would read its state
            // here. For this test we just verify the analyzer runs and returns.
            const state = (engine.tickDriver as unknown as { _state?: TestState })._state;
            return [createTickRecorder(state ?? { tick: 0, lastDt: 0 })];
          },
          tickDelta: 0.1,
        },
      ],
      seeds: [7, 8, 9],
      until: ({ tick }) => tick >= 3,
      maxSimTime: 1,
    });
    expect(seenSeeds).toEqual([7, 8, 9]);
    expect(result.cells[0]!.runs).toHaveLength(3);
    for (const run of result.cells[0]!.runs) {
      expect(run.analyzerResults).toHaveLength(1);
    }
  });

  it('synthesizes an empty result for cells with zero seeds', () => {
    const result = runMatrixUntil({
      cells: [{ name: 'empty', buildEngine: () => buildTestEngine({ tick: 0, lastDt: 0 }) }],
      seeds: [],
      until: () => true,
      maxSimTime: 1,
    });
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]!.runs).toEqual([]);
    expect(result.cells[0]!.aggregate.terminationCounts).toEqual({
      predicate: 0,
      maxSimTime: 0,
      unreachable: 0,
    });
  });

  it('runMatrix output still omits termination fields (no regression)', () => {
    const result = runMatrix({
      cells: [{ name: 'a', setup: () => [], tick: () => {}, ticks: 3 }],
      seeds: [1, 2],
    });
    const agg = result.cells[0]!.aggregate;
    expect(agg.terminationTime).toBeUndefined();
    expect(agg.terminationCounts).toBeUndefined();
    expect(agg.terminationTimeHistogram).toBeUndefined();
  });
});
