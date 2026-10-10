/**
 * `runWaypointProbe` — snapshot-at-time per-waypoint inspector.
 *
 * Sibling of {@link runBeatProbe}, not a subtype. For each waypoint, drives a
 * freshly-built engine via {@link runMatrixUntil} until the waypoint's
 * `snapshotAtSec` is reached, then calls `inspect(engine)` to extract a
 * consumer-shaped snapshot. The canonical use case is methodology-#2
 * predictor-walks-a-schedule: "at sim-second X, what's the per-producer
 * pacing texture?" — the consumer supplies the snapshot shape via the
 * `inspect` callback.
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
   * (a tick that lands on it within rounding counts), so it overshoots by
   * less than `tickDelta` when `tickDelta` doesn't divide the waypoint time.
   */
  snapshotSimTime: number;
  /**
   * `true` when the run reached `snapshotAtSec`. Always `true` while
   * `maxSimTimePad` is at least `tickDelta`, since the ceiling then lies
   * past the first tick at or after the waypoint; a smaller pad can cut
   * the run short.
   */
  reachedTarget: boolean;
  /** Consumer-shaped snapshot returned by `inspect(engine)`. */
  snapshot: T;
}

/** Configuration for {@link runWaypointProbe}. */
export interface WaypointProbeConfig<T> {
  /**
   * Build a fresh, started engine for each `(waypoint × seed)` run, as
   * {@link UntilCell.buildEngine}.
   */
  buildEngine: (ctx: RunContext) => Engine;
  waypoints: Waypoint[];
  /**
   * Extract a consumer-shaped snapshot from the engine at the waypoint time.
   * Runs once the engine is stopped, so its state reads as of the last tick.
   */
  inspect: (engine: Engine) => T;
  /**
   * Called once per `(waypoint, seed)` run after `inspect`, as
   * {@link UntilCell.teardown} — release what `buildEngine` built. Defaults
   * to `engine.dispose()`.
   */
  teardown?: (engine: Engine, ctx: RunContext) => void;
  /** Seeds to run per waypoint. Defaults to `[0]` for deterministic single-engine probes. */
  seeds?: number[];
  /**
   * Sim-seconds advanced per `simulateTick` iteration, as
   * {@link UntilCell.tickDelta}. Defaults to `0.05`; coarsen for
   * long-horizon waypoints (minutes–hours of sim-time).
   */
  tickDelta?: number;
  /**
   * Sim-seconds added to each waypoint's `snapshotAtSec` to form the
   * `runUntil` `maxSimTime` ceiling — slack for the first tick at or past
   * the waypoint, not a budget the run is expected to spend. Defaults to `60`.
   */
  maxSimTimePad?: number;
}

/**
 * For each waypoint × seed: build a fresh engine, advance it until
 * `simTime >= waypoint.snapshotAtSec`, call `inspect(engine)`, and return one
 * {@link WaypointSnapshot} per `(waypoint, seed)` in iteration order. Each
 * waypoint is a single-cell {@link runMatrixUntil} sweep over `seeds`, so
 * seeding, stopping and `teardown` follow that runner's per-run lifecycle.
 *
 * The probe stops each run's engine and disposes it once `inspect` has read
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
export function runWaypointProbe<T>(config: WaypointProbeConfig<T>): WaypointSnapshot<T>[] {
  const seeds = config.seeds ?? [0];
  const pad = config.maxSimTimePad ?? 60;
  const out: WaypointSnapshot<T>[] = [];
  for (const waypoint of config.waypoints) {
    let engine!: Engine;
    runMatrixUntil({
      cells: [
        {
          name: waypoint.id,
          tickDelta: config.tickDelta,
          buildEngine: (ctx) => (engine = config.buildEngine(ctx)),
          teardown: config.teardown,
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
          snapshot: config.inspect(engine),
        }),
    });
  }
  return out;
}
