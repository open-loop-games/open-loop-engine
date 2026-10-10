/**
 * Cycle-finalize tracker — implements {@link Analyzer.onRunFinalize} to
 * record per-cycle aggregate metrics. One of the two default analyzers in
 * {@link defaultAnalyzerPack}.
 *
 * Reports:
 * - `runs` — total number of finalized runs observed during the run
 * - `last.{key}.end` — end value of each tracked metric at the most recent cycle
 * - `last.{key}.delta` — net change of each tracked metric on the most recent cycle
 *
 * "Tracked metrics" are whatever the consumer registered with `createCycleLog`.
 * The tracker is content-agnostic: it reads whatever deltas the CycleLog emits.
 *
 * Auto-bound by {@link createSensitivityCell} when the per-run engine
 * publishes a CycleLog via `CycleLogKey`. Outside a harness cell, subscribe
 * directly: `log.on('finalized', entry => tracker.onRunFinalize?.(entry))`.
 */

import type { Analyzer, AnalyzerResult } from '@/primitives/types';
import { Decimal } from '@/primitives/decimal';

type FinalizeEntry = Parameters<NonNullable<Analyzer['onRunFinalize']>>[0];

/**
 * Create an {@link Analyzer} that counts finalized cycles and snapshots the
 * most recent cycle's deltas into the summary.
 */
export function createRunFinalizeAnalyzer(): Analyzer {
  let runs = 0;
  let lastEntry: FinalizeEntry | null = null;

  return {
    name: 'run-finalize',
    onStart() {
      runs = 0;
      lastEntry = null;
    },
    onRunFinalize(entry) {
      runs += 1;
      lastEntry = entry;
    },
    summarize(): AnalyzerResult {
      const metrics: Record<string, number> = { runs };
      if (lastEntry) {
        for (const delta of lastEntry.deltas) {
          metrics[`last.${delta.key}.end`] = new Decimal(delta.end).toNumber();
          metrics[`last.${delta.key}.delta`] = new Decimal(delta.delta).toNumber();
        }
      }
      return {
        name: 'run-finalize',
        metrics,
      };
    },
  };
}
