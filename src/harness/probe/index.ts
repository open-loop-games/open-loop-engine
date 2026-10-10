/**
 * Probe barrel — `runBeatProbe` (beat-timing) and `runWaypointProbe`
 * (snapshot-at-time per waypoint) plus their types.
 *
 * Optimization-research that used to ship as wrappers
 * (`eventDrivenProbe`, `stasisAwareTickProbe`, `coarseFineProbe`,
 * `advanceToNextEvent`) has moved into `runMatrixUntil`/`runUntil` modes —
 * consumers select via `BeatProbeOptions.mode`.
 */

export { runBeatProbe } from './tick';
export { runWaypointProbe } from './waypoint';
export type { Beat, BeatResult, BeatProbeOptions } from './types';
export type { Waypoint, WaypointSnapshot, WaypointProbeOptions } from './waypoint';
