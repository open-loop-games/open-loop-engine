/**
 * Cycle-finalize tracker — implements {@link Analyzer.onCycleFinalize} to
 * record per-cycle aggregate metrics. One of the two default analyzers in
 * {@link defaultAnalyzerPack}.
 *
 * Reports:
 * - `cycles` — total number of finalized cycles observed during the run
 * - `last.{key}.end` — end value of each tracked metric at the most recent cycle
 * - `last.{key}.delta` — net change of each tracked metric on the most recent cycle
 *
 * "Tracked metrics" are whatever the consumer registered with `createCycleLog`.
 * The tracker is content-agnostic: it reads whatever deltas the CycleLog emits.
 *
 * Auto-bound by {@link createSensitivityCell} when the per-run engine
 * publishes a CycleLog via `CycleLogKey`. Outside a harness cell, subscribe
 * directly: `log.on('finalize', entry => tracker.onCycleFinalize?.(entry))`.
 */

import type { Analyzer, AnalyzerResult } from '@/primitives/types';
import { Decimal } from '@/primitives/decimal';

type FinalizeEntry = Parameters<NonNullable<Analyzer['onCycleFinalize']>>[0];

/**
 * Create an {@link Analyzer} that counts finalized cycles and snapshots the
 * most recent cycle's deltas into the summary.
 */
export function createCycleFinalizeTracker(): Analyzer {
  let cycles = 0;
  let lastEntry: FinalizeEntry | null = null;

  return {
    name: 'cycle-finalize',
    onStart() {
      cycles = 0;
      lastEntry = null;
    },
    onCycleFinalize(entry) {
      cycles += 1;
      lastEntry = entry;
    },
    summarize(): AnalyzerResult {
      const metrics: Record<string, number> = { cycles };
      if (lastEntry) {
        for (const delta of lastEntry.deltas) {
          metrics[`last.${delta.key}.end`] = new Decimal(delta.end).toNumber();
          metrics[`last.${delta.key}.delta`] = new Decimal(delta.delta).toNumber();
        }
      }
      return {
        name: 'cycle-finalize',
        metrics,
      };
    },
  };
}
