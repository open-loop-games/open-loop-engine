/**
 * Offline — catch-up progress by replaying elapsed seconds through the TickDriver in chunks
 */

import type { TickDriver } from './tick-driver';

/** Options for {@link processOfflineTime} — caps the catch-up window and the per-step chunk size. */
export interface OfflineProgressOptions {
  /** Maximum offline seconds to process (default: 259200 = 3 days) */
  maxOfflineSeconds?: number;
  /** Seconds per simulateTick call (default: 1). Must be <= driver's maxDeltaTime. */
  chunkSize?: number;
}

/**
 * Process offline elapsed time by feeding it through the TickDriver in chunks.
 *
 * Each chunk is passed to `tickDriver.simulateTick()`, which caps at `maxDeltaTime` and
 * passes the dt directly to tick callbacks (no speedMultiplier applied — offline
 * processing is wall-clock faithful).
 *
 * @returns Actual seconds processed (capped by maxOfflineSeconds).
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
  const capped = Math.min(Math.max(elapsedSeconds, 0), maxOffline);

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
