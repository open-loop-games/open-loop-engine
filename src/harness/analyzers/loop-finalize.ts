/**
 * Loop-finalize tracker — implements {@link Analyzer.onLoopFinalize} to
 * record per-loop aggregate metrics. One of the two default analyzers in
 * {@link defaultAnalyzerPack}.
 *
 * Reports:
 * - `loops` — total number of finalized loops observed during the run
 * - `last.{key}.end` — end value of each tracked metric at the most recent loop
 * - `last.{key}.delta` — net change of each tracked metric on the most recent loop
 *
 * "Tracked metrics" are whatever the consumer registered with `createLoopLog`.
 * The tracker is content-agnostic: it reads whatever deltas the LoopLog emits.
 *
 * Auto-bound by {@link createSensitivityCell} when the per-run engine
 * publishes a LoopLog via `LoopLogKey`. Outside a harness cell, subscribe
 * directly: `log.on('finalize', entry => tracker.onLoopFinalize?.(entry))`.
 */

import type { Analyzer, AnalyzerResult } from '@/primitives/types';
import { Decimal } from '@/primitives/decimal';

type FinalizeEntry = Parameters<NonNullable<Analyzer['onLoopFinalize']>>[0];

/**
 * Create an {@link Analyzer} that counts finalized loops and snapshots the
 * most recent loop's deltas into the summary.
 */
export function createLoopFinalizeTracker(): Analyzer {
  let loops = 0;
  let lastEntry: FinalizeEntry | null = null;

  return {
    name: 'loop-finalize',
    onStart() {
      loops = 0;
      lastEntry = null;
    },
    onLoopFinalize(entry) {
      loops += 1;
      lastEntry = entry;
    },
    summarize(): AnalyzerResult {
      const metrics: Record<string, number> = { loops };
      if (lastEntry) {
        for (const delta of lastEntry.deltas) {
          metrics[`last.${delta.key}.end`] = new Decimal(delta.end).toNumber();
          metrics[`last.${delta.key}.delta`] = new Decimal(delta.delta).toNumber();
        }
      }
      return {
        name: 'loop-finalize',
        metrics,
      };
    },
  };
}
