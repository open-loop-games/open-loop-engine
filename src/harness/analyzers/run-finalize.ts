/**
 * Run-finalize analyzer — implements {@link Analyzer.onRunFinalize} to
 * record per-run aggregate metrics from a CycleLog. One of the two default
 * analyzers in {@link defaultAnalyzerPack}.
 *
 * Reports:
 * - `runs` — total number of finalized runs observed during the headless run
 * - `last.{key}.end` — end value of each tracked metric at the most recent run
 * - `last.{key}.delta` — net change of each tracked metric over the most recent run
 *
 * Tracked metrics are whatever the consumer registered with `createCycleLog`.
 * The analyzer is content-agnostic: it reads whatever deltas the CycleLog emits.
 *
 * {@link createSensitivityCell} subscribes it when the engine of a headless
 * run publishes a CycleLog via `CycleLogKey`. Outside a harness cell, subscribe
 * directly: `log.on('finalized', entry => analyzer.onRunFinalize?.(entry))`.
 */

import type { Analyzer, AnalyzerSummary } from '@/primitives/types';
import { Decimal } from '@/primitives/decimal';

type FinalizeEntry = Parameters<NonNullable<Analyzer['onRunFinalize']>>[0];

/**
 * Create an {@link Analyzer} that counts finalized runs and copies the
 * most recent run's deltas into the summary.
 */
export function createRunFinalizeAnalyzer(): Analyzer {
  let runs = 0;
  let lastEntry: FinalizeEntry | null = null;

  return {
    id: 'run-finalize',
    onStart() {
      runs = 0;
      lastEntry = null;
    },
    onRunFinalize(entry) {
      runs += 1;
      lastEntry = entry;
    },
    summarize(): AnalyzerSummary {
      const metrics: Record<string, number> = { runs };
      if (lastEntry) {
        for (const delta of lastEntry.deltas) {
          metrics[`last.${delta.key}.end`] = new Decimal(delta.end).toNumber();
          metrics[`last.${delta.key}.delta`] = new Decimal(delta.delta).toNumber();
        }
      }
      return {
        id: 'run-finalize',
        metrics,
      };
    },
  };
}
