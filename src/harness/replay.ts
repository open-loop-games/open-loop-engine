/**
 * Deterministic live-play replay — drive a {@link TickDriver} the way production's
 * `intervalTick` does, but from a controlled clock instead of `performance.now()`.
 *
 * `runUntil` / `runBeatProbe` deliberately decouple from the driver's live `intervalRate`
 * and `speedMultiplier` (caller-authoritative `tickDelta`); `processOfflineTime`
 * replays wall-clock seconds with no game-speed scaling. Neither reproduces the *live*
 * path. `replayLive` is the one that does: it fires `seconds × intervalRate` intervals,
 * each calling `driver.processInterval(1 / intervalRate)`. That is the same speed-aware
 * live body `intervalTick` runs per interval, fed an injected clock. The dt math
 * (cap, `speedMultiplier`, fixed-mode accumulator) is in `processInterval`, so replay
 * reproduces live play by calling it rather than re-deriving the formula. So the two
 * cannot drift apart.
 *
 * Game speed is applied the live way: by setting `driver.speedMultiplier` for the
 * duration of the replay (restored on exit), not by pre-scaling dt. `processInterval`
 * applies it exactly where the timer loop does.
 *
 * This makes the fixed-mode speed-invariance guarantee testable. Equal game time
 * at 1× and N× drains the same total tick count through identical per-tick
 * math, so state must converge. See {@link createTickCounter} for the tick-count
 * assertion side.
 *
 * @cluster runners
 */

import type { TickDriver } from '@/core/tick-driver';
import { floorSteps } from './sim-time';

/** Options for {@link replayLive}. */
export interface ReplayLiveOptions {
  /** Wall-clock seconds to replay. Negative clamps to zero (no ticks fired). */
  seconds: number;
  /**
   * Game speed. It is set on `driver.speedMultiplier` for the duration of the
   * replay, and the prior value is restored on exit. So `processInterval`
   * scales dt exactly as the live loop does. Default 1. Total game time is
   * `seconds × speed`.
   */
  speed?: number;
  /**
   * Awaited after each interval. It is for consumers whose tick handlers
   * defer work to a microtask, e.g. a consumer's own action queue that
   * advances via `queueMicrotask`. Pass `() => Promise.resolve()` to flush
   * between intervals. Then replay matches the live cadence instead of
   * batching at the end. Omit it for pure synchronous tick logic.
   */
  afterInterval?: () => void | Promise<void>;
}

/**
 * Replay `seconds` of live play at `speed` through `driver`, reproducing
 * `intervalTick`'s dt math deterministically.
 *
 * @returns the number of intervals fired (`floor(seconds × intervalRate)`). The
 *   tick count, which differs in fixed mode, is observed via {@link createTickCounter},
 *   not returned here.
 */
export async function replayLive(driver: TickDriver, options: ReplayLiveOptions): Promise<number> {
  const speed = options.speed ?? 1;
  const intervalRate = driver.intervalRate;
  const tickInterval = 1 / intervalRate;
  const intervalTicks = Math.max(0, floorSteps(options.seconds, tickInterval));

  const prevSpeed = driver.speedMultiplier;
  driver.speedMultiplier = speed;
  try {
    for (let i = 0; i < intervalTicks; i++) {
      driver.processInterval(tickInterval);
      if (options.afterInterval) await options.afterInterval();
    }
  } finally {
    driver.speedMultiplier = prevSpeed;
  }
  return intervalTicks;
}

/** A live tick counter returned by {@link createTickCounter}. */
export interface TickCounter {
  /** Current count of `onTick` fires since creation or last `reset`. */
  get(): number;
  /** Zero the count. */
  reset(): void;
  /** Unsubscribe from the driver. The counter saves nothing. */
  dispose(): void;
}

/**
 * Count `onTick` fires on `driver`, one per tick. An interval runs one tick in
 * variable mode and can run several in fixed mode. The typical use asserts that
 * equal game time produces equal tick counts across game speeds (fixed-mode invariant).
 */
export function createTickCounter(driver: TickDriver): TickCounter {
  let count = 0;
  const unsubscribe = driver.onTick(() => count++);
  return {
    get: () => count,
    reset: () => {
      count = 0;
    },
    dispose: unsubscribe,
  };
}
