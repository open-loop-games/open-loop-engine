/**
 * Throttle — lightweight tick-callback rate limiter
 *
 * Gates a per-tick callback so it fires at most once per configured interval.
 * Useful for pacing automation checks (auto-buy, auto-prestige) that don't
 * need progress or cooldown tracking.
 *
 * - {@link createThrottle} — sole factory
 *
 * @example
 * ```ts
 * const buyThrottle = createThrottle({ interval: 0.5 }); // every 500ms
 *
 * loop.onTick((dt) => {
 *   if (buyThrottle.ready(dt)) {
 *     attemptAutoBuy();
 *   }
 * });
 * ```
 */

// === TYPES ===
/** Options for {@link createThrottle}. */
export interface ThrottleOptions {
  /** Minimum interval in seconds between allowed executions. 0 or negative disables throttling. */
  interval: number;
}

/**
 * A gate that rate-limits execution within a tick callback.
 *
 * Call {@link ready} each tick with the elapsed dt. It returns `true` at most
 * once per configured interval, accumulating dt between allowed executions.
 */
export interface Throttle {
  /**
   * Accumulate dt and return `true` if the interval has elapsed.
   * The internal accumulator subtracts (not resets) to preserve timing accuracy.
   * Fires at most once per call, even with large dt values.
   */
  ready(dt: number): boolean;
  /** Reset the accumulator to zero (e.g., on loop restart). */
  reset(): void;
  /** The configured interval in seconds (read-only). */
  readonly interval: number;
}

// === FACTORY ===
/**
 * Create a throttle gate for rate-limiting tick callbacks.
 *
 * @param options - Configuration with the minimum interval between executions
 * @returns A {@link Throttle} with a `gate(dt)` method
 *
 * @example
 * ```ts
 * const prestiageCheck = createThrottle({ interval: 2 }); // every 2 seconds
 *
 * gameLoop.onTick((dt) => {
 *   if (prestiageCheck.ready(dt) && shouldAutoPrestige()) {
 *     prestige();
 *   }
 * });
 * ```
 */
export function createThrottle(options: ThrottleOptions): Throttle {
  const { interval } = options;
  let accumulated = 0;

  return {
    ready(dt: number): boolean {
      if (interval <= 0) return true;

      accumulated += dt;
      if (accumulated >= interval) {
        // Subtract to preserve remainder — prevents drift over many ticks
        accumulated -= interval;
        // Clamp: if we've fallen far behind (large dt), don't bank multiple triggers
        if (accumulated >= interval) {
          accumulated = accumulated % interval;
        }
        return true;
      }
      return false;
    },

    reset(): void {
      accumulated = 0;
    },

    get interval(): number {
      return interval;
    },
  };
}
