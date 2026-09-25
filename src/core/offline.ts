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
 * @returns Actual seconds processed: `elapsedSeconds` clamped to `[0, maxOfflineSeconds]`, with NaN read as 0.
 */
export function processOfflineTime(
  tickDriver: TickDriver,
  elapsedSeconds: number,
  options?: OfflineProgressOptions,
): number {
  const maxOffline = options?.maxOfflineSeconds ?? 259200;
  const requestedChunk = options?.chunkSize ?? 1;
  if (!Number.isFinite(requestedChunk) || requestedChunk <= 0) {
    throw new Error(
      `processOfflineTime: chunkSize must be a finite positive number, got ${requestedChunk}`,
    );
  }
  // simulateTick clamps each chunk to the driver's maxDeltaTime in variable
  // mode, so a chunkSize above it would advance only maxDeltaTime per call while
  // the loop subtracted the full chunk — silently dropping the difference yet
  // still reporting the whole window processed. Clamp so every chunk is faithful.
  const chunkSize = Math.min(requestedChunk, tickDriver.maxDeltaTime);
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
