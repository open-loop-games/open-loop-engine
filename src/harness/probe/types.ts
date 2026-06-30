/**
 * Probe substrate — types.
 *
 * A probe collects per-beat termination-time distributions from a
 * `seeds`-wide sweep. {@link runProbe} is the single shipped implementation;
 * it dispatches on {@link ProbeConfig.mode} into one of `runMatrixUntil`'s
 * three loop modes (`'tick'` / `'event'` / `'stasis-aware-tick'`).
 */

import type { Engine } from '@/index';
import type { GameStateAccessor } from '@/primitives/types';
import type { MetricStats, RunContext, RunMode } from '../types';

/**
 * One beat's predicate + identity. Archetype-agnostic — no game-specific
 * spec window, just the predicate to evaluate and an optional tuning window
 * for `inTuningWindow` classification on the result.
 */
export interface BeatProbe {
  id: string;
  /** Predicate evaluating engine state, fired when the beat lands. */
  predicate: (engine: Engine) => boolean;
  /**
   * Optional hand-authored tuning window in sim-seconds, `[lower, upper]`,
   * for design-time balance iteration — a hypothesis a balance script tunes
   * toward, not a claim about recorded behavior. When set,
   * {@link BeatResult.inTuningWindow} is `true` iff `terminationTime.p50`
   * falls inside the window. Pure interpretation layer on top of the
   * termination distribution; absent when consumers aren't tuning against
   * a window.
   */
  tuningWindow?: [number, number];
}

/**
 * Per-beat termination-time distribution from a `seeds`-wide sweep.
 *
 * `counts.unreachable` is non-zero only when the probe ran in `'event'` or
 * `'stasis-aware-tick'` mode and a seed terminated with
 * `RunUntilResult.terminated === 'unreachable'`. Tick-mode probes always
 * report `unreachable: 0` — tick-mode is content-blind.
 */
export interface BeatResult {
  beatId: string;
  /** Stats over predicate-terminated runs only. Absent when no seed fired. */
  terminationTime: MetricStats | undefined;
  /** Counts of how each seed terminated. Sums to `seeds.length`. */
  counts: { predicate: number; maxSimTime: number; unreachable: number };
  /**
   * Echoed from {@link BeatProbe.tuningWindow} when set, so renderers can
   * display the window without holding the originating `BeatProbe[]`.
   */
  tuningWindow?: [number, number];
  /**
   * Present iff {@link BeatProbe.tuningWindow} is set. `true` iff
   * `terminationTime.p50` falls inside the window. Allows windowed-arc
   * tuning usage as a first-class probe field without a wrapper.
   */
  inTuningWindow?: boolean;
}

/**
 * Configuration for {@link runProbe}. `buildEngine` is invoked per
 * `(beat, seed)` — the probe reuses the fresh-engine contract from
 * `runMatrixUntil`. `buildAccessor` is required when `mode !== 'tick'`
 * because event-stepping and stasis-aware-tick modes introspect content
 * through the walker.
 */
export interface ProbeConfig {
  /** Build a fresh, started engine for each `(beat × seed)` run. */
  buildEngine: (ctx: RunContext) => Engine;
  /**
   * Build a read-side accessor for a freshly-built engine. Required when
   * `mode !== 'tick'`. Called once per `(beat, seed)` alongside
   * `buildEngine`; the accessor must read the same state the engine ticks
   * against.
   */
  buildAccessor?: (engine: Engine) => GameStateAccessor;
  beats: BeatProbe[];
  /** Seeds to run per beat. */
  seeds: number[];
  /**
   * Sim-seconds ceiling per run. Should comfortably exceed the largest
   * expected beat fire time so outlier seeds don't get truncated.
   */
  maxSimTime: number;
  /**
   * Seconds of sim-time per tick. Defaults to 1 — balance work is
   * measured in minutes, so sub-second tick fidelity is wasted cost.
   * Lower only when a beat predicate depends on sub-second timing.
   */
  tickDelta?: number;
  /**
   * Run mode. Defaults to `'tick'`. `'event'` event-steps via the walker
   * (attacks never-fires cost for live-rate-insufficient legs); `'stasis-aware-tick'`
   * short-circuits unreachable runs with a per-tick walker check. See {@link RunMode}.
   */
  mode?: RunMode;
  /** See `RunUntilConfig.bisectTolSec`. Ignored when `mode !== 'event'`. */
  bisectTolSec?: number;
  /** See `RunUntilConfig.stasisProbeInterval`. Ignored when `mode !== 'event'`. */
  stasisProbeInterval?: number;
}
