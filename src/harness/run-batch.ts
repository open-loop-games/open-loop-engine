/**
 * Batch runner — thin wrapper over {@link runMatrix} for the "N
 * configurations × M seeds, no variant semantics" case. Provided as a
 * separate entry point so callers that aren't reaching for the "cells"
 * vocabulary don't have to.
 *
 * @cluster runners
 */

import { runMatrix } from './run-matrix';
import type { BatchConfig, MatrixResult } from './types';

/**
 * Run every config × seed pair via {@link runMatrix}. Each entry in
 * `configs` becomes one matrix cell; behavior is observably identical to
 * calling `runMatrix` directly with `{ cells: configs, seeds, ... }`.
 *
 * @param config - {@link BatchConfig} — configs, seeds, optional callbacks
 *   and histogram opt-in.
 * @returns {@link MatrixResult} — one {@link CellResult} per config in
 *   input order.
 *
 * @example
 * ```ts
 * const result = runBatch({
 *   configs: [
 *     { name: 'cfg-a', setup: () => [createGoldTracker()], tick, ticks: 1000 },
 *     { name: 'cfg-b', setup: () => [createGoldTracker()], tick, ticks: 1000 },
 *   ],
 *   seeds: [1, 2, 3, 4, 5],
 * });
 * ```
 */
export function runBatch(config: BatchConfig): MatrixResult {
  return runMatrix({
    cells: config.configs,
    seeds: config.seeds,
    onRunComplete: config.onRunComplete,
    onCellComplete: config.onCellComplete,
    aggregate: config.aggregate,
  });
}
