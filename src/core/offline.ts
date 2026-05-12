/**
 * Offline — catch-up progress by replaying elapsed seconds through the game loop in chunks
 */

import type { GameLoop } from './game-loop';

/** Options for {@link processOfflineTime} — caps the catch-up window and the per-step chunk size. */
export interface OfflineProgressOptions {
  /** Maximum offline seconds to process (default: 259200 = 3 days) */
  maxOfflineSeconds?: number;
  /** Seconds per simulateTick call (default: 1). Must be <= loop's maxDeltaTime. */
  chunkSize?: number;
}

/**
 * Process offline elapsed time by feeding it through the game loop in chunks.
 *
 * Each chunk is passed to `loop.simulateTick()`, which caps at `maxDeltaTime` and
 * passes the dt directly to tick callbacks (no speedMultiplier applied — offline
 * processing is wall-clock faithful).
 *
 * @returns Actual seconds processed (capped by maxOfflineSeconds).
 */
export function processOfflineTime(
  loop: GameLoop,
  elapsedSeconds: number,
  options?: OfflineProgressOptions,
): number {
  const maxOffline = options?.maxOfflineSeconds ?? 259200;
  const chunkSize = options?.chunkSize ?? 1;
  const capped = Math.min(Math.max(elapsedSeconds, 0), maxOffline);

  let remaining = capped;
  while (remaining >= chunkSize) {
    loop.simulateTick(chunkSize);
    remaining -= chunkSize;
  }
  if (remaining > 0) {
    loop.simulateTick(remaining);
  }

  return capped;
}
