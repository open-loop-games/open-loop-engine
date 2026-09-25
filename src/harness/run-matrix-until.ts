/**
 * Predicate-bounded matrix runner — the `cells × seeds` counterpart to
 * {@link runUntil}. Drives a freshly-built engine per `(cell, seed)`,
 * checks the shared predicate each tick, and aggregates per-cell
 * termination-time distributions as first-class fields on
 * {@link CellAggregate}.
 *
 * Beat-timing probes are the canonical consumer: "across 50 seeds, when
 * does beat-N fire? is the mean in [100, 140] min?" — the kind of question
 * `runMatrix` can't answer because it presumes a fixed tick budget.
 *
 * @cluster runners
 */

import { seedRNG } from '@/primitives/rng';
import { runUntil } from './run-until';
import { aggregateUntilCell } from './aggregate';
import { createWorkPlan } from './work-plan';
import type { CellResult, MatrixUntilConfig, MatrixUntilResult, RunUntilResult } from './types';

/**
 * Sync cartesian run over `cells × seeds` where each run terminates on a
 * shared predicate (or `maxSimTime`). Mirrors `runMatrix`'s structure —
 * stable cell-outer/seed-inner order, progressive `onRunComplete` /
 * `onCellComplete` callbacks, opt-in histogram bucketing — but every cell
 * builds its own engine per run and the aggregate carries
 * `terminationTime` / `terminationCounts`.
 *
 * @param config - {@link MatrixUntilConfig} — until-cells, seeds, shared
 *   predicate, max sim-time ceiling, optional callbacks + aggregate opts.
 * @returns {@link MatrixUntilResult} with per-cell {@link CellResult}.
 *
 * @example
 * ```ts
 * const result = runMatrixUntil({
 *   cells: [
 *     {
 *       name: 'meta-cost × 0.85',
 *       buildEngine: () => buildDirectorEngine({ metaCostMul: 0.85 }),
 *     },
 *     {
 *       name: 'meta-cost × 1.15',
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
export function runMatrixUntil(config: MatrixUntilConfig): MatrixUntilResult {
  const mode = config.mode ?? 'tick';
  if (mode !== 'tick') {
    for (const cell of config.cells) {
      if (!cell.buildAccessor) {
        throw new Error(
          `runMatrixUntil: mode "${mode}" requires UntilCell.buildAccessor on every cell (missing on "${cell.name}")`,
        );
      }
    }
  }
  const plan = createWorkPlan(config);
  const perCellRuns: RunUntilResult[][] = config.cells.map(() => []);
  const cellResults: (CellResult | null)[] = config.cells.map(() => null);

  for (const item of plan) {
    const { cell, seed } = item;
    seedRNG(seed);
    const engine = cell.buildEngine({ seed });
    const analyzers = cell.analyzers;
    const accessor = cell.buildAccessor?.(engine);
    let result: RunUntilResult;
    try {
      result = runUntil({
        engine,
        until: config.until,
        maxSimTime: config.maxSimTime,
        tickDelta: cell.tickDelta,
        setup: analyzers ? () => analyzers(engine, { seed }) : undefined,
        seed,
        mode,
        accessor,
        bisectTolSec: config.bisectTolSec,
        stasisProbeInterval: config.stasisProbeInterval,
      });
    } finally {
      // buildEngine returns a *started* engine (contract); with the default
      // TickDriver that is a live setInterval. Stop each run's engine or the
      // sweep leaks one ticking engine per (cell × seed) that keeps the Node
      // process alive. `stop?.` tolerates lightweight test fakes.
      engine.stop?.();
    }
    perCellRuns[item.cellIdx].push(result);
    config.onRunComplete?.(item, result);

    if (
      cellResults[item.cellIdx] === null &&
      perCellRuns[item.cellIdx].length === config.seeds.length
    ) {
      const runs = perCellRuns[item.cellIdx];
      const cellResult: CellResult = {
        name: cell.name,
        runs,
        aggregate: aggregateUntilCell(runs, config.aggregate),
      };
      cellResults[item.cellIdx] = cellResult;
      config.onCellComplete?.(cellResult);
    }
  }

  // Cells with zero seeds never fire onCellComplete — synthesize an empty
  // result so the MatrixUntilResult shape stays predictable.
  const cells: CellResult[] = config.cells.map(
    (cell, i) =>
      cellResults[i] ?? {
        name: cell.name,
        runs: perCellRuns[i],
        aggregate: {
          metrics: {},
          terminationCounts: { predicate: 0, maxSimTime: 0, unreachable: 0 },
        },
      },
  );
  return { cells };
}
