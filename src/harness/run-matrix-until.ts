/**
 * Predicate-bounded matrix runner — the `cells × seeds` counterpart to
 * {@link runUntil}. Drives a newly built engine per `(cell, seed)`,
 * checks the shared predicate each iteration, and aggregates per-cell
 * termination-time distributions as first-class fields on
 * {@link CellAggregate}.
 *
 * Beat-timing probes are the typical consumer: "across 50 seeds, when
 * is beat N reached? Is the mean in [100, 140] min?" `runMatrix` cannot
 * answer that kind of question, because it assumes a fixed tick count.
 *
 * @cluster runners
 */

import { seedRNG } from '@/primitives/rng';
import { runUntil } from './run-until';
import { aggregateUntilCell } from './aggregate';
import { createWorkPlan } from './work-plan';
import type { CellResult, MatrixUntilOptions, MatrixUntilResult, RunUntilResult } from './types';

/**
 * Sync cartesian sweep over `cells × seeds` where each headless run
 * terminates on a shared predicate (or `maxSimTime`). Mirrors `runMatrix`'s structure:
 * stable cell-outer/seed-inner order, progressive `onRunComplete` /
 * `onCellComplete` option callbacks, opt-in histogram bucketing. But every
 * cell builds its own engine per headless run, and the aggregate has
 * `terminationTime` / `terminationCounts`.
 *
 * The runner stops the engine of each headless run, then disposes it once
 * `onRunComplete` has read it (or after a throwing headless run). A cell's
 * `teardown` replaces that dispose; pass a no-op to keep the engines alive past the sweep.
 *
 * @param options - {@link MatrixUntilOptions} — until-cells, seeds, shared
 *   predicate, sim-time cap, optional option callbacks + aggregate options.
 * @returns {@link MatrixUntilResult} with per-cell {@link CellResult}.
 *
 * @example
 * ```ts
 * const result = runMatrixUntil({
 *   cells: [
 *     {
 *       id: 'meta-cost × 0.85',
 *       buildEngine: () => buildDirectorEngine({ metaCostMul: 0.85 }),
 *     },
 *     {
 *       id: 'meta-cost × 1.15',
 *       buildEngine: () => buildDirectorEngine({ metaCostMul: 1.15 }),
 *     },
 *   ],
 *   seeds: Array.from({ length: 50 }, (_, i) => i + 1),
 *   until: (ctx) => ctx.simTime >= minutes(120),
 *   maxSimTime: minutes(150),
 *   aggregate: { terminationTimeHistogram: { edges: [100, 110, 120, 130, 140, 150] } },
 * });
 * result.cells[0].aggregate.terminationTime!.avg;
 * ```
 */
export function runMatrixUntil(options: MatrixUntilOptions): MatrixUntilResult {
  const mode = options.mode ?? 'uniform';
  const plan = createWorkPlan(options);
  const perCellRuns: RunUntilResult[][] = options.cells.map(() => []);
  const cellResults: (CellResult<RunUntilResult> | null)[] = options.cells.map(() => null);

  for (const item of plan) {
    const { cell, seed } = item;
    seedRNG(seed);
    const ctx = { seed };
    const engine = cell.buildEngine(ctx);
    try {
      const analyzers = cell.analyzers;
      const accessor = cell.buildAccessor?.(engine);
      let result: RunUntilResult;
      try {
        result = runUntil({
          engine,
          until: options.until,
          maxSimTime: options.maxSimTime,
          tickDelta: cell.tickDelta,
          setup: analyzers ? () => analyzers(engine, ctx) : undefined,
          seed,
          mode,
          accessor,
          bisectTolSec: options.bisectTolSec,
          stasisCheckInterval: options.stasisCheckInterval,
        });
      } finally {
        // buildEngine returns a *started* engine (contract); with the default
        // TickDriver that is a live setInterval. Stop the engine of each headless run or the
        // sweep leaks one ticking engine per (cell × seed) that keeps the Node
        // process alive. `stop?.` tolerates lightweight test fakes.
        engine.stop?.();
      }
      perCellRuns[item.cellIdx].push(result);
      options.onRunComplete?.(item, result);
    } finally {
      if (cell.teardown) cell.teardown(engine, ctx);
      // `dispose?.` tolerates lightweight test fakes.
      else engine.dispose?.();
    }

    if (
      cellResults[item.cellIdx] === null &&
      perCellRuns[item.cellIdx].length === options.seeds.length
    ) {
      const runs = perCellRuns[item.cellIdx];
      const cellResult: CellResult<RunUntilResult> = {
        id: cell.id,
        runs,
        aggregate: aggregateUntilCell(runs, options.aggregate),
      };
      cellResults[item.cellIdx] = cellResult;
      options.onCellComplete?.(cellResult);
    }
  }

  // Cells with zero seeds never fire onCellComplete — synthesize an empty
  // result so the MatrixUntilResult shape stays predictable.
  const cells: CellResult<RunUntilResult>[] = options.cells.map(
    (cell, i) =>
      cellResults[i] ?? {
        id: cell.id,
        runs: perCellRuns[i],
        aggregate: {
          metrics: {},
          terminationCounts: { predicate: 0, maxSimTime: 0, unreachable: 0 },
        },
      },
  );
  return { cells };
}
