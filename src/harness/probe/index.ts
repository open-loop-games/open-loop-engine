/**
 * Probe barrel — `runProbe` (beat-timing) and `runWaypointProbe`
 * (snapshot-at-time per waypoint) plus their types.
 *
 * Optimization-research that used to ship as wrappers
 * (`eventDrivenProbe`, `stasisAwareTickProbe`, `coarseFineProbe`,
 * `advanceToNextEvent`) has moved into `runMatrixUntil`/`runUntil` modes —
 * consumers select via `ProbeConfig.mode`.
 */

export { runProbe } from './tick';
export { runWaypointProbe } from './waypoint';
export type { BeatProbe, BeatResult, ProbeConfig } from './types';
export type { Waypoint, WaypointSnapshot, WaypointProbeConfig } from './waypoint';
