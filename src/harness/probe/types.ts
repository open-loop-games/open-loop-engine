/**
 * Probe substrate — types.
 *
 * A beat probe collects per-beat termination-time distributions from a
 * `seeds`-wide sweep. {@link runBeatProbe} is the one shipped implementation;
 * it dispatches on {@link BeatProbeOptions.mode} into one of `runMatrixUntil`'s
 * three run modes (`'uniform'` / `'next-event'` / `'stasis-aware'`).
 */

import type { Engine } from '@/engine';
import type { GameStateAccessor } from '@/primitives/types';
import type { MetricStats, RunContext, RunMode } from '../types';

/**
 * One beat's predicate + identity. Game-agnostic: no game-specific
 * window, only the predicate to evaluate and an optional tuning window
 * for `inTuningWindow` classification on the result.
 */
export interface Beat {
  id: string;
  /** Predicate over engine state; it holds once the beat is reached. */
  predicate: (engine: Engine) => boolean;
  /**
   * Optional hand-authored tuning window in sim-seconds, `[lower, upper]`,
   * for design-time balance iteration — a hypothesis a balance script tunes
   * toward, not a claim about recorded behavior. When set,
   * {@link BeatResult.inTuningWindow} is `true` iff `terminationTime.p50`
   * falls inside the window. It only interprets the termination
   * distribution; absent when consumers are not tuning against a window.
   */
  tuningWindow?: [number, number];
}

/**
 * Per-beat termination-time distribution from a `seeds`-wide sweep.
 *
 * `counts.unreachable` is non-zero only when the probe ran in `'next-event'` or
 * `'stasis-aware'` mode and a seed terminated with
 * `RunUntilResult.terminated === 'unreachable'`. `'uniform'`-mode probes always
 * report `unreachable: 0`, because `'uniform'` mode is content-blind.
 */
export interface BeatResult {
  beatId: string;
  /**
   * Stats over predicate-terminated headless runs only. Absent when no seed
   * reached the beat.
   */
  terminationTime: MetricStats | undefined;
  /** Counts of how each seed terminated. Sums to `seeds.length`. */
  counts: { predicate: number; maxSimTime: number; unreachable: number };
  /**
   * Copied from {@link Beat.tuningWindow} when set, so a UI can
   * show the window without holding the originating `Beat[]`.
   */
  tuningWindow?: [number, number];
  /**
   * Present iff {@link Beat.tuningWindow} is set. `true` iff
   * `terminationTime.p50` falls inside the window. So tuning an arc against
   * a window needs no wrapper.
   */
  inTuningWindow?: boolean;
}

/**
 * Options for {@link runBeatProbe}. `buildEngine` is invoked per
 * `(beat, seed)` — the probe reuses the fresh-engine contract from
 * `runMatrixUntil`. The `'next-event'` and `'stasis-aware'` modes read
 * content through the walker, with `buildAccessor`'s accessor, else the
 * engine's own.
 */
export interface BeatProbeOptions {
  /**
   * Build a new, started engine for each `(beat × seed)` headless run. Seeding and
   * stopping follow {@link UntilCell.buildEngine}.
   */
  buildEngine: (ctx: RunContext) => Engine;
  /**
   * Build a read-side accessor for a newly built engine, for
   * `mode !== 'uniform'`, in place of the engine's own. Called once per
   * `(beat, seed)` alongside `buildEngine`; the accessor must read the same
   * state the engine ticks against.
   */
  buildAccessor?: (engine: Engine) => GameStateAccessor;
  /**
   * Called once per `(beat, seed)` headless run as {@link UntilCell.teardown} —
   * release what `buildEngine` built. Defaults to `engine.dispose()`.
   */
  teardown?: (engine: Engine, ctx: RunContext) => void;
  beats: Beat[];
  /** Seeds to run per beat. */
  seeds: number[];
  /**
   * Sim-time cap per headless run, in sim-seconds. It should exceed the largest
   * expected fire time by a clear margin, so outlier seeds are not cut short.
   */
  maxSimTime: number;
  /**
   * Sim-seconds per iteration. Defaults to 1: balance work is
   * measured in minutes, so sub-second resolution is wasted cost.
   * Lower it only when a beat predicate depends on sub-second timing.
   */
  tickDelta?: number;
  /**
   * Run mode. Defaults to `'uniform'`. `'next-event'` steps from event to
   * event via the walker. It cuts the cost of a beat whose live rate is too
   * low to reach it soon. `'stasis-aware'` ends unreachable headless runs
   * early with a walker check each iteration. See {@link RunMode}.
   */
  mode?: RunMode;
  /** See `RunUntilOptions.bisectTolSec`. Ignored when `mode !== 'next-event'`. */
  bisectTolSec?: number;
  /** See `RunUntilOptions.stasisCheckInterval`. Ignored when `mode !== 'next-event'`. */
  stasisCheckInterval?: number;
}
