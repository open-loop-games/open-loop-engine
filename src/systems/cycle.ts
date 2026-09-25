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
  resolveSystemContextId,
} from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import type { RegisterTick } from '@/core/sequencer';
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
  /**
   * Save context. Defaults to `${module}/cycle` inside a module; pass one
   * when a module builds more than one.
   */
  id?: string;

  /**
   * Automatic termination condition, checked every tick while `running` is true.
   * When it returns `true`, the cycle ends and the restart sequence fires.
   * Omit for manual-only cycles where the player calls `cycle.end()`.
   *
   * If that restart is declined (see {@link Cycle.end}), the cycle pauses
   * rather than retrying every tick; call `run()` to resume and re-check.
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
   *
   * It is the Reset's `onReset`, run under the reset's load guard: resource
   * writes here never reach `cumulative` / `best`. Grant earnings in an
   * `afterRestart` listener, which runs once the reset has returned.
   */
  onRestart?: () => void;

  /** Function to register a per-tick callback with the game loop (e.g., `ctx.onTick`) */
  registerTick: RegisterTick;
}

/**
 * A cycle instance — the returned object from {@link createCycle}.
 *
 * Call `run()` to start ticking, `pause()` to freeze, `end()` to trigger
 * the restart sequence. Stats (`count`, `bestTime`) and the current run's
 * `elapsed` persist across saves; `running` doesn't, so a game that wants a
 * run to carry on after a load calls `run()` from its load hook.
 */
export interface Cycle extends ScopedReset {
  /**
   * Total completed cycles (persistent, saved automatically). Tagged
   * `lifetime`, like `bestTime`: the cycle's own reset keeps both, even when
   * it names the module the cycle was built in.
   */
  readonly count: Persistent<number>;

  /**
   * Fastest cycle completion in seconds (persistent, `Infinity` until first
   * cycle). A cycle ended before any time elapsed doesn't count.
   */
  readonly bestTime: Persistent<number>;

  /**
   * Elapsed time in the current cycle, in seconds (persistent, so a reload
   * resumes the run's clock). Resets to 0 on restart.
   */
  readonly elapsed: Persistent<number>;

  /**
   * Whether the cycle is actively ticking. Controlled by `run()` / `pause()`;
   * not saved, so a fresh session starts paused until `run()`.
   */
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
   * logged a cycle that then didn't restart. A declined end that
   * `endCondition` triggered also pauses the cycle, so that entry is logged
   * once rather than on every tick; a declined manual call leaves `running`
   * alone.
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

  const contextId = resolveSystemContextId(id, 'cycle', () => `cycle_${cycleCounter++}`);
  // `elapsed` is lifetime too: the cycle zeroes it itself, and a reset that
  // covers the cycle's own context would otherwise zero it before `end()`
  // records the best time.
  const { count, bestTime, elapsed } = withPersistentContext(contextId, () => ({
    count: persistent(0, { name: 'count', lifetime: true }),
    bestTime: persistent(Infinity, { name: 'bestTime', lifetime: true }),
    elapsed: persistent(0, { name: 'elapsed', lifetime: true }),
  }));

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

  // `elapsed` is read after the emit and zeroed after that, so a listener
  // re-entering `end()` zeroes it before the outer comparison sees it and the
  // outer records a best time of 0 — into a persistent ref, where no later
  // cycle can beat it. The count double-increments for the same reason. Guards
  // the cycle's own bookkeeping only: the inner `reset` carries its own flag,
  // and the call below is not re-entrant with respect to it.
  let _restarting = false;

  function end(): boolean {
    if (_restarting) return false;

    if (onBeforeRestart) {
      const result = onBeforeRestart();
      if (result === false) return false;
    }

    _restarting = true;
    try {
      handle.emit('beforeRestart');

      // Stats and elapsed commit only once the reset has actually run. A Reset
      // carrying a `canReset` gate or an `onBeforeReset` hook can decline, and
      // both checks fire before it touches any ref — so declining is clean and
      // the cycle must not count, record a best time, or claim a restart.
      if (!reset.reset()) return false;

      // A zero-length cycle (two ends with no tick between) isn't a run, and
      // a best of 0 is one no later cycle could beat.
      if (elapsed.value > 0 && elapsed.value < bestTime.value) {
        bestTime.value = elapsed.value;
      }
      count.value++;

      elapsed.value = 0;

      handle.emit('afterRestart');

      return true;
    } finally {
      _restarting = false;
    }
  }

  const unregisterTick = registerTick((dt: number) => {
    if (!running.value) return;
    elapsed.value += dt;
    // A declined restart leaves the end condition true, so re-trying next
    // tick would fire `beforeRestart` (and log a phantom cycle) every tick.
    if (endCondition && endCondition() && !end()) {
      running.value = false;
    }
  });

  const cycle: Cycle = {
    count,
    bestTime,
    elapsed,
    running,
    get resolvedScope() {
      return reset.resolvedScope;
    },
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
