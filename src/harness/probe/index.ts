/**
 * Probe barrel — `runBeatProbe` (beat-timing) and `runWaypointProbe`
 * (snapshot-at-time per waypoint) plus their types.
 *
 * Event stepping and stasis checks are run modes of `runMatrixUntil` and
 * `runUntil`; a beat probe selects one via `BeatProbeOptions.mode`.
 */

export { runBeatProbe } from './tick';
export { runWaypointProbe } from './waypoint';
export type { Beat, BeatResult, BeatProbeOptions } from './types';
export type { Waypoint, WaypointSnapshot, WaypointProbeOptions } from './waypoint';
