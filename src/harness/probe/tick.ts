/**
 * `runProbe` — the single beat-timing probe. Dispatches on
 * {@link ProbeConfig.mode} into one of `runMatrixUntil`'s three loop modes.
 *
 * For each beat, drives `seeds.length` fresh engines until the predicate
 * fires (or `maxSimTime` is reached, or stasis is observed in non-tick
 * modes), aggregated into per-beat termination-time distributions.
 *
 * When {@link BeatProbe.tuningWindow} is set, the per-beat result carries
 * `inTuningWindow = terminationTime.p50 ∈ tuningWindow`. Pure interpretation —
 * the underlying distribution is unchanged.
 *
 * One call to `runMatrixUntil` per beat (rather than one big matrix)
 * because the predicate varies by beat; the input that varies is the
 * predicate, and engine builds are fresh per `(beat × seed)` either way.
 */

import { runMatrixUntil } from '../run-matrix-until';
import type { Engine } from '@/engine';
import type { UntilCell, UntilPredicate } from '../types';
import type { BeatResult, ProbeConfig } from './types';

/**
 * For each beat, drive `seeds.length` fresh engines until the beat predicate
 * fires (or `maxSimTime` elapses, or — in non-tick modes — stasis is
 * observed), aggregated into per-beat termination-time distributions.
 *
 * Mode dispatch (`config.mode`, default `'tick'`):
 * - `'tick'` — fixed-tick loop, content-blind. Default.
 * - `'event'` — walker-visible event-stepping for live-rate-insufficient legs.
 *   Requires `config.buildAccessor`.
 * - `'stasis-aware-tick'` — per-tick stasis check; terminates with
 *   `counts.unreachable` for seeds the walker confirms cannot fire. Requires
 *   `config.buildAccessor`.
 *
 * @param config — beats, seeds, fresh-engine factory, sim-time ceiling,
 *   optional tick granularity, optional `mode` + `buildAccessor`.
 * @returns one {@link BeatResult} per beat, with termination-time stats
 *   over predicate-fired seeds, counts split by termination reason, and
 *   `inTuningWindow` when the beat carried a `tuningWindow`.
 *
 * The probe stops and disposes each run's engine; pass a no-op `teardown`
 * to keep them alive.
 *
 * @example
 * ```ts
 * const results = runProbe({
 *   buildEngine: ({ seed }) => buildProducerSimEngine(overrides, seed),
 *   beats: ARC_BEATS,
 *   seeds: [0, 1, 2, 3, 4],
 *   maxSimTime: hours(2),
 *   tickDelta: 1,
 * });
 * for (const r of results) {
 *   console.log(r.beatId, r.terminationTime?.p50, r.inTuningWindow, r.counts);
 * }
 * ```
 */
export function runProbe(config: ProbeConfig): BeatResult[] {
  const tickDelta = config.tickDelta ?? 1;
  const mode = config.mode ?? 'tick';
  if (mode !== 'tick' && !config.buildAccessor) {
    throw new Error(`runProbe: mode "${mode}" requires config.buildAccessor`);
  }
  const out: BeatResult[] = [];
  for (const beat of config.beats) {
    let engineForPredicate: Engine | undefined;

    const cell: UntilCell = {
      name: beat.id,
      tickDelta,
      buildEngine: (ctx) => {
        const engine = config.buildEngine(ctx);
        engineForPredicate = engine;
        return engine;
      },
      buildAccessor: config.buildAccessor ? (engine) => config.buildAccessor!(engine) : undefined,
      teardown: config.teardown,
    };

    const until: UntilPredicate = () => {
      if (!engineForPredicate) return false;
      return beat.predicate(engineForPredicate);
    };

    const result = runMatrixUntil({
      cells: [cell],
      seeds: config.seeds,
      until,
      maxSimTime: config.maxSimTime,
      mode,
      bisectTolSec: config.bisectTolSec,
      stasisProbeInterval: config.stasisProbeInterval,
    });

    const aggregate = result.cells[0].aggregate;
    const counts = aggregate.terminationCounts ?? {
      predicate: 0,
      maxSimTime: 0,
      unreachable: 0,
    };
    const beatResult: BeatResult = {
      beatId: beat.id,
      terminationTime: aggregate.terminationTime,
      counts: {
        predicate: counts.predicate,
        maxSimTime: counts.maxSimTime,
        unreachable: counts.unreachable,
      },
    };
    if (beat.tuningWindow) {
      const p50 = aggregate.terminationTime?.p50 ?? Infinity;
      beatResult.tuningWindow = beat.tuningWindow;
      beatResult.inTuningWindow = p50 >= beat.tuningWindow[0] && p50 <= beat.tuningWindow[1];
    }
    out.push(beatResult);
  }
  return out;
}
