/**
 * Time tracking — persistent elapsed/total play time and reactive speed multiplier.
 *
 * Provides the "how long has the player been playing" surface: a `tick(dt)`-driven
 * counter that splits between since-last-reset (`elapsed`) and lifetime
 * (`totalPlayTime`), a reactive `speedMultiplier` that scales every dt, and a
 * formatted display string for the lifetime counter.
 *
 * Offline-time chunking lives in `core/offline` — pair the two when a game
 * needs both surfaces.
 */

import { ref } from 'vue';
import type { Ref } from 'vue';
import { persistent, resolveSystemContextId, withPersistentContext } from '@/core/persistence';
import { attachContextReset } from '@/core/resettable';
import { formatTime } from '@/primitives/decimal';

// === TYPES ===

/** Configuration for {@link createTimeSystem}. */
export interface TimeSystemConfig {
  /**
   * Save context. Defaults to `${module}/time` inside a module; pass one when
   * a module builds more than one.
   */
  id?: string;
  /**
   * Initial speed multiplier (default 1). Scales dt passed to `tick()`.
   *
   * Fed from an engine tick callback, the dt already carries the tick
   * driver's own `speedMultiplier`, and this one multiplies on top. Leave it
   * at 1 to count game time as the driver ran it.
   */
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
  /**
   * Reactive speed multiplier — scales dt in `tick()`, on top of any scaling
   * the dt already carries (see {@link TimeSystemConfig.speedMultiplier}).
   */
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
 * @param config - Save context id and initial speed multiplier
 * @returns A time system with persistent `elapsed` and `totalPlayTime` refs,
 *   a `tick()` method to advance time, and `reset()` which zeroes elapsed
 *   but preserves total play time
 *
 * @example
 * ```ts
 * // inside a module's install(ctx)
 * const time = createTimeSystem();
 * ctx.onTick((dt) => time.tick(dt));
 * console.log(time.formatPlayTime()); // "1h 23m 45s"
 * ```
 */
export function createTimeSystem(config: TimeSystemConfig = {}): TimeSystem {
  const contextId = resolveSystemContextId(config.id, 'time');
  const { elapsed, totalPlayTime } = withPersistentContext(contextId, () => ({
    elapsed: persistent(0, { name: 'elapsed' }),
    totalPlayTime: persistent(0, { name: 'totalPlayTime', lifetime: true }),
  }));
  const speedMultiplier = ref(config.speedMultiplier ?? 1);
  const time: TimeSystem = {
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
  return attachContextReset(time, contextId);
}
