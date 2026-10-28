/**
 * `runBeatProbe` — the one beat-timing probe. Dispatches on
 * {@link BeatProbeOptions.mode} into one of `runMatrixUntil`'s three run modes.
 *
 * For each beat, drives `seeds.length` new engines until the predicate
 * holds, `maxSimTime` is reached, or stasis is observed outside `'uniform'`
 * mode. The results are aggregated into per-beat termination-time
 * distributions.
 *
 * When {@link Beat.tuningWindow} is set, the per-beat result has
 * `inTuningWindow = terminationTime.p50 ∈ tuningWindow`. This only
 * interprets the result; the underlying distribution is unchanged.
 *
 * One call to `runMatrixUntil` per beat (rather than one big matrix),
 * because the predicate varies by beat. Engines are built new per
 * `(beat × seed)` either way.
 */

import { runMatrixUntil } from '../run-matrix-until';
import type { Engine } from '@/engine';
import type { UntilCell, UntilPredicate } from '../types';
import type { BeatResult, BeatProbeOptions } from './types';

/**
 * For each beat, drive `seeds.length` new engines until the beat predicate
 * holds, `maxSimTime` elapses, or stasis is observed outside `'uniform'`
 * mode. The results are aggregated into per-beat termination-time
 * distributions.
 *
 * Mode dispatch (`options.mode`, default `'uniform'`):
 * - `'uniform'` — fixed-tick loop, content-blind. Default.
 * - `'next-event'` — walker-visible event stepping, for a beat whose live
 *   rate is too low to reach it soon. Needs an accessor.
 * - `'stasis-aware'` — a stasis check each iteration; counts a seed in
 *   `counts.unreachable` when the walker confirms its beat cannot be reached. Needs an
 *   accessor: `options.buildAccessor`'s, else the engine's own.
 *
 * @param options — beats, seeds, new-engine factory, sim-time cap,
 *   optional `tickDelta`, optional `mode` + `buildAccessor`.
 * @returns one {@link BeatResult} per beat, with termination-time stats
 *   over the seeds whose predicate held, counts split by termination reason,
 *   and `inTuningWindow` when the beat has a `tuningWindow`.
 *
 * The probe stops and disposes the engine of each headless run; pass a no-op `teardown`
 * to keep them alive.
 *
 * @example
 * ```ts
 * const results = runBeatProbe({
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
export function runBeatProbe(options: BeatProbeOptions): BeatResult[] {
  const tickDelta = options.tickDelta ?? 1;
  const mode = options.mode ?? 'uniform';
  const out: BeatResult[] = [];
  for (const beat of options.beats) {
    let engineForPredicate: Engine | undefined;

    const cell: UntilCell = {
      id: beat.id,
      tickDelta,
      buildEngine: (ctx) => {
        const engine = options.buildEngine(ctx);
        engineForPredicate = engine;
        return engine;
      },
      buildAccessor: options.buildAccessor ? (engine) => options.buildAccessor!(engine) : undefined,
      teardown: options.teardown,
    };

    const until: UntilPredicate = () => {
      if (!engineForPredicate) return false;
      return beat.predicate(engineForPredicate);
    };

    const result = runMatrixUntil({
      cells: [cell],
      seeds: options.seeds,
      until,
      maxSimTime: options.maxSimTime,
      mode,
      bisectTolSec: options.bisectTolSec,
      stasisCheckInterval: options.stasisCheckInterval,
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
