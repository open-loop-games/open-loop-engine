/**
 * Offline — catch-up progress by replaying elapsed seconds through the TickDriver in chunks
 */

import type { TickDriver } from './tick-driver';

/** Options for {@link processOfflineTime}: the catch-up window's cap and the chunk size of each `advanceTime` call. */
export interface OfflineProgressOptions {
  /** Most offline seconds to replay (default: 259200 = 3 days) */
  maxOfflineSeconds?: number;
  /** Seconds per advanceTime call (default: 1). A chunk above the driver's maxDeltaTime runs as several ticks. */
  chunkSize?: number;
}

/**
 * Replay offline time through the TickDriver in chunks.
 *
 * Each chunk goes to `tickDriver.advanceTime()`, which passes it to the tick handlers as dt.
 * Game speed does not apply, so the replay matches wall-clock time.
 *
 * @returns Seconds replayed: `elapsedSeconds` clamped to `[0, maxOfflineSeconds]`, with NaN taken as 0.
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
    tickDriver.advanceTime(chunkSize);
    remaining -= chunkSize;
  }
  if (remaining > 0) {
    tickDriver.advanceTime(remaining);
  }

  return capped;
}
