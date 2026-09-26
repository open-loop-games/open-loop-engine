/**
 * Offline — catch-up progress by replaying elapsed seconds through the TickDriver in chunks
 */

import type { TickDriver } from './tick-driver';

/** Options for {@link processOfflineTime} — caps the catch-up window and the per-step chunk size. */
export interface OfflineProgressOptions {
  /** Maximum offline seconds to process (default: 259200 = 3 days) */
  maxOfflineSeconds?: number;
  /** Seconds per simulateTick call (default: 1). A chunk above the driver's maxDeltaTime runs as several ticks. */
  chunkSize?: number;
}

/**
 * Process offline elapsed time by feeding it through the TickDriver in chunks.
 *
 * Each chunk is passed to `tickDriver.simulateTick()`, which passes the dt directly to
 * tick callbacks (no speedMultiplier applied — offline processing is wall-clock faithful).
 *
 * @returns Actual seconds processed: `elapsedSeconds` clamped to `[0, maxOfflineSeconds]`, with NaN read as 0.
 */
export function processOfflineTime(
  tickDriver: TickDriver,
  elapsedSeconds: number,
  options?: OfflineProgressOptions,
): number {
  const maxOffline = options?.maxOfflineSeconds ?? 259200;
  const chunkSize = options?.chunkSize ?? 1;
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    throw new Error(
      `processOfflineTime: chunkSize must be a finite positive number, got ${chunkSize}`,
    );
  }
  // NaN (a missing or garbled save timestamp) reads as no time away; +Infinity caps.
  const elapsed = Number.isNaN(elapsedSeconds) ? 0 : elapsedSeconds;
  const capped = Math.min(Math.max(elapsed, 0), maxOffline);

  let remaining = capped;
  while (remaining >= chunkSize) {
    tickDriver.simulateTick(chunkSize);
    remaining -= chunkSize;
  }
  if (remaining > 0) {
    tickDriver.simulateTick(remaining);
  }

  return capped;
}
