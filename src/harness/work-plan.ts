/**
 * Work-plan planner — the parallelism seam. The matrix runners do sync
 * iteration; this planner returns the same flat `WorkItem[]` they iterate,
 * so a consumer that wires a worker pool maps through the array instead
 * of reshaping the harness loop. Keeping the planner generic over cell
 * shape lets fixed-tick ({@link Cell}) and until-runner ({@link UntilCell})
 * sweeps share one plan format.
 *
 * @cluster runners
 */

import type { WorkItem } from './types';

/**
 * Build the flat `(cellIdx, seedIdx, seed, cell)` array that
 * {@link runMatrix} and {@link runMatrixUntil} iterate. Stable order:
 * outer loop over cells, inner loop over seeds.
 *
 * @param options - `{ cells, seeds }` — only the iterable dimensions matter,
 *   so this accepts any superset of `MatrixOptions` / `MatrixUntilOptions`.
 * @returns Flat `WorkItem<C>[]` carrying the original cell reference, cell
 *   index, seed value, and seed index for each `(cell, seed)` pair.
 *
 * @example
 * ```ts
 * // Sequential consumption (matches what runMatrix does internally):
 * const plan = createWorkPlan({ cells, seeds });
 * for (const item of plan) {
 *   const result = runHeadless({ ...item.cell, seed: item.seed });
 *   handle(item, result);
 * }
 *
 * // Worker-pool fan-out — same plan, distributed:
 * const plan = createWorkPlan({ cells, seeds });
 * await Promise.all(plan.map((item) => pool.run(serialize(item))));
 * ```
 */
export function createWorkPlan<C>(options: { cells: C[]; seeds: number[] }): WorkItem<C>[] {
  const plan: WorkItem<C>[] = [];
  for (let cellIdx = 0; cellIdx < options.cells.length; cellIdx++) {
    const cell = options.cells[cellIdx];
    for (let seedIdx = 0; seedIdx < options.seeds.length; seedIdx++) {
      plan.push({ cellIdx, seedIdx, seed: options.seeds[seedIdx], cell });
    }
  }
  return plan;
}
