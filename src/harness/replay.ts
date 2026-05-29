/**
 * Deterministic live-play replay — drive a {@link TickDriver} the way production's
 * `intervalTick` does, but from a controlled clock instead of `performance.now()`.
 *
 * `runUntil` / `runProbe` deliberately decouple from the driver's live `tickRate`
 * and `speedMultiplier` (caller-authoritative `tickDelta`); `processOfflineTime`
 * replays wall-clock seconds with no speed scaling. Neither reproduces the *live*
 * path. `replayLive` is the one that does: it fires `seconds × tickRate` interval
 * ticks, each calling `driver.tickRaw(1 / tickRate)` — the same speed-aware live
 * body `intervalTick` runs per interval, just fed an injected clock. The dt math
 * (cap, `speedMultiplier`, fixed-mode accumulator) lives in `tickRaw`, so replay
 * reproduces live play by invoking it rather than re-deriving the formula; the two
 * cannot drift apart.
 *
 * Speed is applied the live way — by setting `driver.speedMultiplier` for the
 * duration of the replay (restored on exit) — not by pre-scaling dt. `tickRaw`
 * folds it in exactly where the timer loop does.
 *
 * This makes the fixed-mode speed-invariance guarantee testable: equal game-time
 * at 1× and N× drains the same total sub-tick count through identical per-tick
 * math, so state must converge. See {@link createTickCounter} for the sub-tick
 * assertion side.
 *
 * @cluster runners
 */

import type { TickDriver } from '@/core/tick-driver';

/** Options for {@link replayLive}. */
export interface ReplayLiveOptions {
  /** Wall-clock seconds to replay. Negative clamps to zero (no ticks fired). */
  seconds: number;
  /**
   * Speed multiplier. Set on `driver.speedMultiplier` for the duration of the
   * replay (its prior value is restored on exit) so `tickRaw` scales dt exactly
   * as the live loop does. Default 1. Total simulated game-time is `seconds × speed`.
   */
  speed?: number;
  /**
   * Awaited after each interval tick. The escape hatch for consumers whose tick
   * pipeline defers work to a microtask (e.g. an action dispatcher that advances
   * its queue via `queueMicrotask`): pass `() => Promise.resolve()` to flush
   * between ticks so replay matches live cadence instead of batching at the end.
   * Omit for pure synchronous tick logic.
   */
  afterTick?: () => void | Promise<void>;
}

/**
 * Replay `seconds` of live play at `speed` through `driver`, reproducing
 * `intervalTick`'s dt math deterministically.
 *
 * @returns the number of interval ticks fired (`floor(seconds × tickRate)`). The
 *   sub-tick count (relevant in fixed mode) is observed via {@link createTickCounter},
 *   not returned here.
 */
export async function replayLive(driver: TickDriver, options: ReplayLiveOptions): Promise<number> {
  const speed = options.speed ?? 1;
  const tickRate = driver.tickRate;
  const tickInterval = 1 / tickRate;
  const intervalTicks = Math.max(0, Math.floor(options.seconds * tickRate));

  const prevSpeed = driver.speedMultiplier;
  driver.speedMultiplier = speed;
  try {
    for (let i = 0; i < intervalTicks; i++) {
      driver.tickRaw(tickInterval);
      if (options.afterTick) await options.afterTick();
    }
  } finally {
    driver.speedMultiplier = prevSpeed;
  }
  return intervalTicks;
}

/** A live sub-tick counter returned by {@link createTickCounter}. */
export interface TickCounter {
  /** Current count of `onTick` fires since creation or last `reset`. */
  get(): number;
  /** Zero the count. */
  reset(): void;
  /** Unsubscribe from the driver. */
  dispose(): void;
}

/**
 * Count `onTick` fires on `driver` — one per sub-tick in fixed mode, one per
 * interval tick in variable mode. The canonical use is asserting that equal
 * game-time produces equal sub-tick counts across speeds (fixed-mode invariant).
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
