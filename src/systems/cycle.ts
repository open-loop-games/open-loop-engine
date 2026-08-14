/**
 * Cycle system — a bounded run that ends, resets a scope, and replays
 *
 * Composes Reset + time tracking + run counter into the "play a constrained
 * period, reset with meta-progression, replay" shape. The loop incremental
 * genre is the origin, not the limit: a prestige layer and a new-game-plus
 * are the same lifecycle with a different trigger, and both ship on this.
 *
 * - {@link createCycle} — the sole factory, wires up reset + elapsed timer + stats
 *
 * Supports any termination model via `endCondition`:
 * - Mana-budget (Idle Loops) — cycle ends when mana depletes
 * - Health-to-zero (Increlution) — cycle ends when HP hits 0
 * - Fixed time budget (Groundhog Life) — cycle ends after N seconds
 * - Manual trigger (Progress Knight) — omit `endCondition`, call `cycle.end()` directly
 *
 * @see ./cycle-log for per-cycle analytics that snapshot/diff metrics on lifecycle events
 */

import { ref, type Ref } from 'vue';
import type { Computable } from '@/core/computed';
import {
  persistent,
  type Persistent,
  withPersistentContext,
  getCurrentContext,
} from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { createReset, type Reset, type ResetScope, type ScopedReset } from './reset';

// === TYPES ===

/** Events emitted by a {@link Cycle} instance */
export interface CycleEvents {
  /** Fired after `onBeforeRestart` succeeds, before the actual reset executes */
  beforeRestart: () => void;
  /** Fired after the reset completes and elapsed time is zeroed */
  afterRestart: () => void;
}

/** Options for {@link createCycle} */
export interface CycleOptions {
  /** Persistence ID. Falls back to surrounding context or auto-generated. Explicit IDs are safer for save compat. */
  id?: string;

  /**
   * Automatic termination condition, checked every tick while `running` is true.
   * When it returns `true`, the cycle ends and the restart sequence fires.
   * Omit for manual-only cycles where the player calls `cycle.end()`.
   */
  endCondition?: () => boolean;

  /**
   * A pre-built {@link Reset} to drive instead of constructing one from the
   * shorthand fields below. Takes precedence over `thingsToReset` /
   * `resetModules` / `keep` / `retain` / `onRestart`, which are ignored when
   * this is supplied.
   *
   * Those five fields are shorthand covering the common case, deliberately not
   * a mirror of {@link ResetOptions} — reach for this whenever the reset needs
   * anything they don't spell, notably a `canReset` gate (and its predictor
   * projection) or the reset's own `beforeReset` / `afterReset` events.
   *
   * A Reset that declines aborts the restart; see {@link Cycle.end}.
   */
  reset?: Reset;

  /**
   * Objects containing persistent refs to reset each cycle (passed through to the internal {@link Reset}).
   * Optional when {@link resetModules} is provided.
   */
  thingsToReset?: Computable<unknown[]>;

  /**
   * Module-scoped reset: declare which modules to reset by ID, or compose
   * with other Reset/Cycle objects to inherit their scope.
   * @see {@link ResetScope}
   */
  resetModules?: ResetScope[];

  /**
   * Refs that should survive the cycle reset unchanged.
   * @see {@link createRetentionPolicy}
   */
  keep?: Persistent[];

  /**
   * Refs with custom retention transforms applied after reset.
   * @see {@link createRetentionPolicy}
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retain?: Map<Persistent, (value: any) => any>;

  /**
   * Pre-restart hook. Return `false` to cancel the restart.
   * Use for: calculating prestige currency, recording per-cycle stats, skill XP accumulation.
   */
  onBeforeRestart?: () => boolean | void;

  /**
   * Post-restart hook, called after all persistent refs have been reset.
   * Use for: swapping action queues, applying meta-progression multipliers.
   */
  onRestart?: () => void;

  /** Function to register a per-tick callback with the game loop (e.g., `ctx.onTick`) */
  registerTick: (callback: (dt: number) => void) => () => void;
}

/**
 * A cycle instance — the returned object from {@link createCycle}.
 *
 * Call `run()` to start ticking, `pause()` to freeze, `end()` to trigger
 * the restart sequence. Stats (`count`, `bestTime`) persist across saves.
 */
export interface Cycle extends ScopedReset {
  /** Total completed cycles (persistent, saved automatically) */
  readonly count: Persistent<number>;

  /** Fastest cycle completion in seconds (persistent, `Infinity` until first cycle) */
  readonly bestTime: Persistent<number>;

  /** Elapsed time in the current cycle, in seconds. Resets to 0 on restart. */
  readonly elapsed: Ref<number>;

  /** Whether the cycle is actively ticking. Controlled by `run()` / `pause()`. */
  readonly running: Ref<boolean>;

  /**
   * The flattened set of persistent refs resolved from `resetModules`.
   * Exposed so other cycles can compose with this cycle's scope.
   */
  readonly resolvedScope: ReadonlySet<Persistent>;

  /** The underlying {@link Reset} instance — escape hatch for custom reset logic */
  readonly reset: Reset;

  /**
   * Trigger the restart sequence: `onBeforeRestart` → `beforeRestart` event →
   * reset → stats → zero elapsed → `afterRestart` event.
   *
   * Returns `false` without touching stats, elapsed, or the `afterRestart`
   * event if the restart is cancelled — either by `onBeforeRestart` returning
   * `false`, or by the underlying {@link Reset} declining (its `canReset` gate
   * or `onBeforeReset` hook). The Reset decides after `beforeRestart` has
   * already fired, so `onBeforeRestart` is the cancellation point to prefer:
   * an observer that records on `beforeRestart` (a {@link CycleLog}) will have
   * logged a cycle that then didn't restart.
   */
  end(): boolean;

  /** Start or resume ticking (sets `running = true`) */
  run(): void;

  /** Pause ticking (sets `running = false`). Elapsed time and endCondition checks freeze. */
  pause(): void;

  /** Subscribe to cycle lifecycle events */
  on: Emittable<CycleEvents>['on'];

  /** Unregister the tick handler. Call when the cycle is no longer needed. */
  dispose(): void;
}

// === FACTORIES ===

let cycleCounter = 0;

/**
 * Create a cycle — a bounded run that ends, resets a scope, and replays.
 *
 * Wires up a {@link Reset} with an elapsed timer, run counter, and best-time
 * tracker. The restart sequence is: `onBeforeRestart` → `beforeRestart` →
 * reset persistent refs → `onRestart` → stats → zero elapsed → `afterRestart`.
 *
 * Fits any lifecycle shaped that way, whatever the game calls it — a loop
 * incremental's run, a prestige layer's reincarnation, a new-game-plus.
 *
 * @param options - Configuration for the cycle (end condition, things to reset, hooks, tick registration)
 * @returns A {@link Cycle} with `run()`, `pause()`, `end()`, stats, and event hooks
 *
 * @example
 * ```ts
 * const run = createCycle({
 *   endCondition: () => Decimal.lte(mana.value, 0),
 *   thingsToReset: [points, upgrades, skills.map(s => s.xp)],
 *   onBeforeRestart() {
 *     // Accumulate permanent skill bonuses before reset
 *     for (const skill of skills) skill.accumulateBonus();
 *   },
 *   registerTick: ctx.onTick,
 * });
 *
 * run.run();  // start ticking
 * // Cycle auto-ends when mana depletes, or call run.end() manually
 * ```
 */
export function createCycle(options: CycleOptions): Cycle {
  const autoId = `cycle_${cycleCounter++}`;

  const {
    id,
    endCondition,
    reset: providedReset,
    thingsToReset,
    resetModules,
    keep,
    retain,
    onBeforeRestart,
    onRestart,
    registerTick,
  } = options;

  const contextId = id ?? getCurrentContext() ?? autoId;
  const { count, bestTime } = withPersistentContext(contextId, () => ({
    count: persistent(0, { name: 'count' }),
    bestTime: persistent(Infinity, { name: 'bestTime' }),
  }));

  const elapsed = ref(0);
  const running = ref(false);
  const handle = createEmitHandle<CycleEvents>();

  const reset =
    providedReset ??
    createReset({
      thingsToReset,
      resetModules,
      keep,
      retain,
      onReset: onRestart,
    });

  function end(): boolean {
    if (onBeforeRestart) {
      const result = onBeforeRestart();
      if (result === false) return false;
    }

    handle.emit('beforeRestart');

    // Stats and elapsed commit only once the reset has actually run. A Reset
    // carrying a `canReset` gate or an `onBeforeReset` hook can decline, and
    // both checks fire before it touches any ref — so declining is clean and
    // the cycle must not count, record a best time, or claim a restart.
    if (!reset.reset()) return false;

    if (elapsed.value < bestTime.value) {
      bestTime.value = elapsed.value;
    }
    count.value++;

    elapsed.value = 0;

    handle.emit('afterRestart');

    return true;
  }

  const unregisterTick = registerTick((dt: number) => {
    if (!running.value) return;
    elapsed.value += dt;
    if (endCondition && endCondition()) {
      end();
    }
  });

  const cycle: Cycle = {
    count,
    bestTime,
    elapsed,
    running,
    resolvedScope: reset.resolvedScope,
    reset,
    end,
    on: handle.on,
    run() {
      running.value = true;
    },
    pause() {
      running.value = false;
    },
    dispose() {
      unregisterTick();
    },
  };

  return cycle;
}
