/**
 * Matrix runner — sync cartesian sweep over `cells × seeds`, built on
 * `runHeadless`. Raw `HeadlessResult[]` are preserved per cell; aggregates
 * are a convenience layer over the raw data, not a replacement for it.
 *
 * Each cell's `setup` constructs and returns its analyzer list per run, so
 * stateful analyzers reset between runs and can close over freshly-built
 * engine state. Parallelism is out of scope here — a pool-wiring consumer
 * maps through {@link createWorkPlan}'s output instead of reshaping this
 * loop. {@link runSensitivity} is a thin wrapper over `runMatrix` for the
 * baseline-vs-variant case.
 *
 * @cluster runners
 */

import { runHeadless } from '@/core/headless';
import type { HeadlessResult } from '@/core/headless';
import { aggregateCell } from './aggregate';
import { createWorkPlan } from './work-plan';
import type { CellResult, MatrixConfig, MatrixResult } from './types';

/**
 * Run every `(cell, seed)` pair in deterministic cell-outer / seed-inner
 * order. `onRunComplete` and `onCellComplete` fire as the sweep progresses,
 * silent by default — progressive UI consumers opt in.
 *
 * @param config - {@link MatrixConfig} — cells, seeds, optional callbacks
 *   and histogram opt-in.
 * @returns {@link MatrixResult} carrying one {@link CellResult} per cell,
 *   in input order. Empty-seed cells get a placeholder result with empty
 *   `metrics`.
 *
 * @example
 * ```ts
 * const result = runMatrix({
 *   cells: [
 *     { name: 'fast', setup: () => [createGoldTracker()], tick, ticks: 1000 },
 *     { name: 'slow', setup: () => [createGoldTracker()], tick, ticks: 1000 },
 *   ],
 *   seeds: [1, 2, 3],
 * });
 * result.cells[0].aggregate.metrics['gold-tracker.peak'];
 * ```
 */
export function runMatrix(config: MatrixConfig): MatrixResult {
  const plan = createWorkPlan(config);
  const perCellRuns: HeadlessResult[][] = config.cells.map(() => []);
  const cellResults: (CellResult | null)[] = config.cells.map(() => null);

  for (const item of plan) {
    const { cell, seed } = item;
    const result = runHeadless({
      setup: () => cell.setup({ seed }),
      tick: cell.tick,
      ticks: cell.ticks,
      tickDelta: cell.tickDelta,
      seed,
      teardown: cell.teardown,
    });
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
        aggregate: aggregateCell(runs, config.aggregate),
      };
      cellResults[item.cellIdx] = cellResult;
      config.onCellComplete?.(cellResult);
    }
  }

  // Cells with zero seeds never fire onCellComplete — synthesize an empty
  // result so the MatrixResult shape stays predictable.
  const cells: CellResult[] = config.cells.map(
    (cell, i) =>
      cellResults[i] ?? {
        name: cell.name,
        runs: perCellRuns[i],
        aggregate: { metrics: {} },
      },
  );
  return { cells };
}
