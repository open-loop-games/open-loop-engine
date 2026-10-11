/**
 * `runWaypointProbe` — snapshot-at-time per-waypoint inspector.
 *
 * Sibling of {@link runBeatProbe}, not a subtype. For each waypoint, drives a
 * newly built engine via {@link runMatrixUntil} until the waypoint's
 * `snapshotAtSec` is reached, then calls `inspect(engine)` to extract a
 * consumer-shaped snapshot. The typical use checks a predictor against a
 * schedule: "at sim-second X, what is each producer's pacing?" The
 * consumer supplies the snapshot shape via the `inspect` function.
 *
 * One engine per (waypoint × seed). Default `seeds: [0]` runs a single
 * deterministic engine per waypoint; pass a wider seed list when waypoint-time
 * variance across seeds matters.
 */

import { runMatrixUntil } from '../run-matrix-until';
import { reachedTime } from '../sim-time';
import type { Engine } from '@/engine';
import type { RunContext } from '../types';

/** One named time-anchored snapshot target. */
export interface Waypoint {
  id: string;
  /** Sim-time (seconds) to snapshot at — typically a beat's midpoint target. */
  snapshotAtSec: number;
}

/** Per-waypoint × per-seed inspector output. */
export interface WaypointSnapshot<T> {
  waypointId: string;
  /** Seed that produced this snapshot. */
  seed: number;
  /**
   * Actual sim-time at snapshot: the first tick at or past `snapshotAtSec`
   * (a tick that ends on it within rounding counts), so it overshoots by
   * less than `tickDelta` when `tickDelta` doesn't divide the waypoint time.
   */
  snapshotSimTime: number;
  /**
   * `true` when the headless run reached `snapshotAtSec`. Always `true` while
   * `maxSimTimePad` is at least `tickDelta`, because the sim-time cap then
   * ends past the first tick at or after the waypoint. A smaller pad can cut
   * the headless run short.
   */
  reachedTarget: boolean;
  /** Consumer-shaped snapshot returned by `inspect(engine)`. */
  snapshot: T;
}

/** Options for {@link runWaypointProbe}. */
export interface WaypointProbeOptions<T> {
  /**
   * Build a new, started engine for each `(waypoint × seed)` headless run, as
   * {@link UntilCell.buildEngine}.
   */
  buildEngine: (ctx: RunContext) => Engine;
  waypoints: Waypoint[];
  /**
   * Extract a consumer-shaped snapshot from the engine at the waypoint time.
   * Runs once the engine is stopped, so it reads the state after the last tick.
   */
  inspect: (engine: Engine) => T;
  /**
   * Called once per `(waypoint, seed)` headless run after `inspect`, as
   * {@link UntilCell.teardown} — release what `buildEngine` built. Defaults
   * to `engine.dispose()`.
   */
  teardown?: (engine: Engine, ctx: RunContext) => void;
  /** Seeds to run per waypoint. Defaults to `[0]` for deterministic single-engine probes. */
  seeds?: number[];
  /**
   * Sim-seconds advanced per `advanceTime` iteration, as
   * {@link UntilCell.tickDelta}. Defaults to `0.05`; coarsen for
   * long-horizon waypoints (minutes–hours of sim-time).
   */
  tickDelta?: number;
  /**
   * Sim-seconds added to each waypoint's `snapshotAtSec` to form the
   * `runUntil` `maxSimTime` cap. It is slack for the first tick at or past
   * the waypoint, not time the headless run is expected to spend. Defaults
   * to `60`.
   */
  maxSimTimePad?: number;
}

/**
 * For each waypoint × seed: build a new engine, advance it until
 * `simTime >= waypoint.snapshotAtSec`, call `inspect(engine)`, and return one
 * {@link WaypointSnapshot} per `(waypoint, seed)` in iteration order. Each
 * waypoint is a single-cell {@link runMatrixUntil} sweep over `seeds`, so
 * seeding, stopping and `teardown` follow that runner's lifecycle for each headless run.
 *
 * The probe stops the engine of each headless run and disposes it once `inspect` has read
 * it; pass a no-op `teardown` to keep them alive.
 *
 * @example
 * ```ts
 * const snapshots = runWaypointProbe({
 *   buildEngine: ({ seed }) => buildProducerSimEngine(undefined, seed),
 *   waypoints: FLOW_BEATS,
 *   inspect: (engine) => collectProducerPacing(engine),
 *   seeds: [0],
 * });
 * for (const s of snapshots) {
 *   console.log(s.waypointId, s.reachedTarget, s.snapshot);
 * }
 * ```
 */
export function runWaypointProbe<T>(options: WaypointProbeOptions<T>): WaypointSnapshot<T>[] {
  const seeds = options.seeds ?? [0];
  const pad = options.maxSimTimePad ?? 60;
  const out: WaypointSnapshot<T>[] = [];
  for (const waypoint of options.waypoints) {
    let engine!: Engine;
    runMatrixUntil({
      cells: [
        {
          id: waypoint.id,
          tickDelta: options.tickDelta,
          buildEngine: (ctx) => (engine = options.buildEngine(ctx)),
          teardown: options.teardown,
        },
      ],
      seeds,
      until: (ctx) => reachedTime(ctx.simTime, waypoint.snapshotAtSec),
      maxSimTime: waypoint.snapshotAtSec + pad,
      onRunComplete: ({ seed }, result) =>
        out.push({
          waypointId: waypoint.id,
          seed,
          snapshotSimTime: result.elapsedSimulated,
          reachedTarget: result.terminated === 'predicate',
          snapshot: options.inspect(engine),
        }),
    });
  }
  return out;
}
