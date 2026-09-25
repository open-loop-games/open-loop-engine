/**
 * `runWaypointProbe` — snapshot-at-time per-waypoint inspector.
 *
 * Sibling of {@link runProbe}, not a subtype. For each waypoint, drives a
 * freshly-built engine via {@link runUntil} until the waypoint's `snapshotAtSec`
 * is reached, then calls `inspect(engine)` to extract a consumer-shaped
 * snapshot. The canonical use case is methodology-#2 predictor-walks-a-schedule:
 * "at sim-second X, what's the per-producer pacing texture?" — the consumer
 * supplies the snapshot shape via the `inspect` callback.
 *
 * One engine per (waypoint × seed). Default `seeds: [0]` runs a single
 * deterministic engine per waypoint, matching the prior starter `runFlowProbe`
 * behavior; pass a wider seed list when waypoint-time variance across seeds
 * matters.
 */

import { seedRNG } from '@/primitives/rng';
import { runUntil } from '../run-until';
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
   * Actual sim-time at snapshot: the first tick at or past `snapshotAtSec`,
   * so it overshoots by less than `tickDelta` when `tickDelta` doesn't
   * divide the waypoint time.
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
   * Build a fresh, started engine for each `(waypoint × seed)` run. The
   * global RNG is seeded with `ctx.seed` just before the call, and again
   * before the first tick; the probe stops the engine after `inspect`.
   */
  buildEngine: (ctx: RunContext) => Engine;
  waypoints: Waypoint[];
  /** Extract a consumer-shaped snapshot from the engine at the waypoint time. */
  inspect: (engine: Engine) => T;
  /** Seeds to run per waypoint. Defaults to `[0]` for deterministic single-engine probes. */
  seeds?: number[];
  /**
   * Sim-seconds advanced per `simulateTick` iteration, forwarded to
   * `runUntil`. Defaults to `runUntil`'s own `0.05`; coarsen for
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
 * For each waypoint × seed: build a fresh engine, advance via `runUntil`
 * until `simTime >= waypoint.snapshotAtSec`, call `inspect(engine)`,
 * return one {@link WaypointSnapshot} per `(waypoint, seed)` in iteration
 * order.
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
    for (const seed of seeds) {
      seedRNG(seed);
      const engine = config.buildEngine({ seed });
      try {
        const result = runUntil({
          engine,
          until: (ctx) => ctx.simTime >= waypoint.snapshotAtSec,
          maxSimTime: waypoint.snapshotAtSec + pad,
          tickDelta: config.tickDelta,
          seed,
        });
        out.push({
          waypointId: waypoint.id,
          seed,
          snapshotSimTime: result.elapsedSimulated,
          reachedTarget: result.terminated === 'predicate',
          snapshot: config.inspect(engine),
        });
      } finally {
        // buildEngine returns a started engine; stop it or its live timer
        // outlives the probe. `stop?.` tolerates lightweight test fakes.
        engine.stop?.();
      }
    }
  }
  return out;
}
