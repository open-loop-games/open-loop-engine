/**
 * Time tracking — persistent elapsed and total play time.
 *
 * Answers "how long has the player been playing". It is a `tick(dt)`-driven
 * counter that splits between since-last-reset (`elapsed`) and lifetime
 * (`totalPlayTime`), with a formatted display string for the lifetime counter.
 * Game speed is the tick driver's `speedMultiplier`: the dt fed to `tick()`
 * already includes it.
 *
 * Offline-time chunking is in `core/offline` — pair the two when a game
 * needs both.
 */

import type { Ref } from 'vue';
import {
  persistent,
  resolveSystemPersistentContextId,
  withPersistentContext,
} from '@/core/persistence';
import { attachPersistentContextReset } from '@/core/resettable';
import { formatTime } from '@/primitives/decimal';

// === TYPES ===

/** Options for {@link createTimeSystem}. */
export interface TimeSystemOptions {
  /**
   * The persistent context id. Defaults to `${module}/time` inside a module;
   * pass one when a module builds more than one.
   */
  id?: string;
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
  /** Add `dt` seconds to both counters. */
  tick(dt: number): void;
  /** Reset elapsed to 0 (totalPlayTime is kept). */
  reset(): void;
  formatPlayTime(): string;
}

// === FACTORIES ===

/**
 * Creates a time tracking system with persistent elapsed/total play time and
 * a formatted display.
 *
 * @param options - The persistent context id
 * @returns A time system with persistent `elapsed` and `totalPlayTime` refs,
 *   a `tick()` method that adds to both, and `reset()`, which zeroes elapsed
 *   but keeps total play time
 *
 * @example
 * ```ts
 * // inside a module's install(ctx)
 * const time = createTimeSystem();
 * ctx.onTick((dt) => time.tick(dt));
 * console.log(time.formatPlayTime()); // "1h 23m 45s"
 * ```
 */
export function createTimeSystem(options: TimeSystemOptions = {}): TimeSystem {
  const contextId = resolveSystemPersistentContextId(options.id, 'time');
  const { elapsed, totalPlayTime } = withPersistentContext(contextId, () => ({
    elapsed: persistent(0, { id: 'elapsed' }),
    totalPlayTime: persistent(0, { id: 'totalPlayTime', lifetime: true }),
  }));
  const time: TimeSystem = {
    elapsed,
    totalPlayTime,
    tick(dt) {
      elapsed.value += dt;
      totalPlayTime.value += dt;
    },
    reset() {
      elapsed.value = 0;
    },
    formatPlayTime() {
      return formatTime(totalPlayTime.value);
    },
  };
  return attachPersistentContextReset(time, contextId);
}
