/**
 * Time tracking — persistent elapsed/total play time and reactive speed multiplier.
 *
 * Provides the "how long has the player been playing" surface: a `tick(dt)`-driven
 * counter that splits between since-last-reset (`elapsed`) and lifetime
 * (`totalPlayTime`), a reactive `speedMultiplier` that scales every dt, and a
 * formatted display string for the lifetime counter.
 *
 * Offline-time chunking lives in `core/process-offline-time` — pair the two when
 * a game needs both surfaces.
 */

import { ref } from 'vue';
import type { Ref } from 'vue';
import { persistent } from '@/core/persistence';
import { formatTime } from '@/primitives/decimal';

// === TYPES ===

/** Configuration for {@link createTimeSystem}. */
export interface TimeSystemConfig {
  /** Initial speed multiplier (default 1). Scales dt passed to `tick()`. */
  speedMultiplier?: number;
}

/** Time tracking system with persistent elapsed and total play time. */
export interface TimeSystem {
  /** Seconds elapsed since last reset (persistent). */
  elapsed: Ref<number>;
  /**
   * Total seconds played across all resets (persistent). Tagged `lifetime`,
   * so a reset of the owning module keeps it while zeroing `elapsed`.
   */
  totalPlayTime: Ref<number>;
  /** Reactive speed multiplier — scales dt in `tick()`. */
  speedMultiplier: Ref<number>;
  /** Advance time by `dt` seconds (scaled by speedMultiplier). */
  tick(dt: number): void;
  /** Reset elapsed to 0 (totalPlayTime preserved). */
  reset(): void;
  formatPlayTime(): string;
}

// === FACTORIES ===

/**
 * Creates a time tracking system with persistent elapsed/total play time,
 * speed multiplier, and formatted display.
 *
 * @param config - Optional speed multiplier
 * @returns A time system with persistent `elapsed` and `totalPlayTime` refs,
 *   a `tick()` method to advance time, and `reset()` which zeroes elapsed
 *   but preserves total play time
 *
 * @example
 * ```ts
 * const time = createTimeSystem({ speedMultiplier: 1 });
 * engine.onTick((dt) => time.tick(dt));
 * console.log(time.formatPlayTime()); // "1h 23m 45s"
 * ```
 */
export function createTimeSystem(config: TimeSystemConfig = {}): TimeSystem {
  const elapsed = persistent(0, { name: 'elapsed' });
  const totalPlayTime = persistent(0, { name: 'totalPlayTime', lifetime: true });
  const speedMultiplier = ref(config.speedMultiplier ?? 1);
  return {
    elapsed,
    totalPlayTime,
    speedMultiplier,
    tick(dt) {
      const adj = dt * speedMultiplier.value;
      elapsed.value += adj;
      totalPlayTime.value += adj;
    },
    reset() {
      elapsed.value = 0;
    },
    formatPlayTime() {
      return formatTime(totalPlayTime.value);
    },
  };
}
