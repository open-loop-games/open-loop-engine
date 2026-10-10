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
 * - Mana-budget — cycle ends when mana depletes
 * - Health-to-zero — cycle ends when HP hits 0
 * - Fixed time budget — cycle ends after N seconds
 * - Manual trigger — omit `endCondition`, call `cycle.end()` directly
 *
 * @see ./cycle-log for per-cycle analytics that snapshot/diff metrics on lifecycle events
 */

import { ref, type Ref } from 'vue';
import type { Computable } from '@/core/computed';
import {
  persistent,
  type Persistent,
  withPersistentContext,
  resolveSystemPersistentContextId,
} from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { attachPersistentContextReset } from '@/core/resettable';
import type { RegisterTick } from '@/core/sequencer';
import { createReset, type Reset, type ResetScope, type ScopedReset } from './reset';
import { createPredicateResolver, type Predicate } from './gate';

// === TYPES ===

/** Events emitted by a {@link Cycle} instance */
export interface CycleEvents {
  /** Fired after `onBeforeEnd` succeeds, before the actual reset executes */
  beforeEnd: () => void;
  /**
   * Fired after the reset completes and elapsed time is zeroed. Pause from a
   * listener to dwell on a results screen until the player restarts with
   * `resume()`; the screen reads state captured in `onBeforeEnd` or a
   * `CycleLog` entry, because the scope has already reset.
   */
  afterEnd: () => void;
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
   * When it holds, the cycle ends and the end sequence fires. A Gate
   * resolves through the runtime captured at `createCycle` time.
   * Omit for manual-only cycles where the player calls `cycle.end()`.
   *
   * If that restart is declined (see {@link Cycle.end}), the cycle pauses
   * rather than retrying every tick; call `resume()` to re-check.
   */
  endCondition?: Predicate;

  /**
   * A pre-built {@link Reset} to drive instead of constructing one from the
   * shorthand fields below. Takes precedence over `thingsToReset` /
   * `resetPersistentContexts` / `keep` / `retain` / `onEnd`, which are ignored when
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
   * Optional when {@link resetPersistentContexts} is provided.
   */
  thingsToReset?: Computable<unknown[]>;

  /**
   * Module-scoped reset: declare which modules to reset by ID, or compose
   * with other Reset/Cycle objects to inherit their scope.
   * @see {@link ResetScope}
   */
  resetPersistentContexts?: ResetScope[];

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
  onBeforeEnd?: () => boolean | void;

  /**
   * Post-restart hook, called after all persistent refs have been reset.
   * Use for: swapping action queues, applying meta-progression multipliers.
   *
   * It is the Reset's `onReset`, run under the reset's load guard: resource
   * writes here never reach `cumulative` / `best`. Grant earnings in an
   * `afterEnd` listener, which runs once the reset has returned.
   */
  onEnd?: () => void;

  /** Function to register a per-tick callback with the game loop (e.g., `ctx.onTick`) */
  registerTick: RegisterTick;
}

/**
 * A cycle instance — the returned object from {@link createCycle}.
 *
 * Call `resume()` to start ticking, `pause()` to freeze, `end()` to trigger
 * the end sequence. Stats (`count`, `bestTime`) and the current run's
 * `elapsed` persist across saves; `running` doesn't, so a game that wants a
 * run to carry on after a load calls `resume()` from its load hook.
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
   * resumes the run's clock). Resets to 0 on restart, and under any reset
   * whose scope covers the cycle's context.
   */
  readonly elapsed: Persistent<number>;

  /**
   * Whether the cycle is actively ticking. Controlled by `resume()` / `pause()`;
   * not saved, so a fresh session starts paused until `resume()`.
   */
  readonly running: Ref<boolean>;

  /**
   * The flattened set of persistent refs resolved from `resetPersistentContexts`.
   * Exposed so other cycles can compose with this cycle's scope.
   */
  readonly resolvedScope: ReadonlySet<Persistent>;

  /** The underlying {@link Reset} instance — escape hatch for custom reset logic */
  readonly reset: Reset;

  /**
   * Trigger the end sequence: `onBeforeEnd` → `beforeEnd` event →
   * reset → stats → zero elapsed → `afterEnd` event.
   *
   * Returns `false` without touching stats, elapsed, or the `afterEnd`
   * event if the restart is cancelled — either by `onBeforeEnd` returning
   * `false`, or by the underlying {@link Reset} declining (its `canReset` gate
   * or `onBeforeReset` hook). The Reset decides after `beforeEnd` has
   * already fired, so `onBeforeEnd` is the cancellation point to prefer:
   * an observer that records on `beforeEnd` (a {@link CycleLog}) will have
   * logged a cycle that then didn't restart. A declined end that
   * `endCondition` triggered also pauses the cycle, so that entry is logged
   * once rather than on every tick; a declined manual call leaves `running`
   * alone.
   */
  end(): boolean;

  /** Start or resume ticking (sets `running = true`) */
  resume(): void;

  /** Pause ticking (sets `running = false`). Elapsed time and endCondition checks freeze. */
  pause(): void;

  /** Subscribe to cycle lifecycle events */
  on: Emittable<CycleEvents>['on'];

  /**
   * Unregister the tick handler. The run count and timers stay registered and
   * keep saving, so building a cycle under the same id again takes a new engine.
   */
  dispose(): void;
}

// === FACTORIES ===

/**
 * Create a cycle — a bounded run that ends, resets a scope, and replays.
 *
 * Wires up a {@link Reset} with an elapsed timer, run counter, and best-time
 * tracker. The end sequence is: `onBeforeEnd` → `beforeEnd` →
 * reset persistent refs → `onEnd` → stats → zero elapsed → `afterEnd`.
 *
 * Fits any lifecycle shaped that way, whatever the game calls it — a loop
 * incremental's run, a prestige layer's reincarnation, a new-game-plus.
 *
 * @param options - Configuration for the cycle (end condition, things to reset, hooks, tick registration)
 * @returns A {@link Cycle} with `resume()`, `pause()`, `end()`, stats, and event hooks
 *
 * @example
 * ```ts
 * const run = createCycle({
 *   endCondition: () => Decimal.lte(mana.value, 0),
 *   thingsToReset: [points, upgrades, skills.map(s => s.xp)],
 *   onBeforeEnd() {
 *     // Accumulate permanent skill bonuses before reset
 *     for (const skill of skills) skill.accumulateBonus();
 *   },
 *   registerTick: ctx.onTick,
 * });
 *
 * run.resume();  // start ticking
 * // Cycle auto-ends when mana depletes, or call run.end() manually
 * ```
 */
export function createCycle(options: CycleOptions): Cycle {
  const {
    id,
    endCondition,
    reset: providedReset,
    thingsToReset,
    resetPersistentContexts,
    keep,
    retain,
    onBeforeEnd,
    onEnd,
    registerTick,
  } = options;

  const contextId = resolveSystemPersistentContextId(id, 'cycle');
  const { count, bestTime, elapsed } = withPersistentContext(contextId, () => ({
    count: persistent(0, { name: 'count', lifetime: true }),
    bestTime: persistent(Infinity, { name: 'bestTime', lifetime: true }),
    elapsed: persistent(0, { name: 'elapsed' }),
  }));

  const running = ref(false);
  const handle = createEmitHandle<CycleEvents>();
  const ended =
    endCondition === undefined
      ? undefined
      : createPredicateResolver().adopt(endCondition, false, 'createCycle endCondition');

  const reset =
    providedReset ??
    createReset({
      thingsToReset,
      resetPersistentContexts,
      keep,
      retain,
      onReset: onEnd,
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

    if (onBeforeEnd) {
      const result = onBeforeEnd();
      if (result === false) return false;
    }

    _restarting = true;
    try {
      handle.emit('beforeEnd');

      // Read before the reset, which zeroes `elapsed` when it covers the
      // cycle's own context.
      const runTime = elapsed.value;

      // Stats and elapsed commit only once the reset has actually run. A Reset
      // carrying a `canReset` gate or an `onBeforeReset` hook can decline, and
      // both checks fire before it touches any ref — so declining is clean and
      // the cycle must not count, record a best time, or claim a restart.
      if (!reset.reset()) return false;

      // A zero-length cycle (two ends with no tick between) isn't a run, and
      // a best of 0 is one no later cycle could beat.
      if (runTime > 0 && runTime < bestTime.value) {
        bestTime.value = runTime;
      }
      count.value++;

      elapsed.value = 0;

      handle.emit('afterEnd');

      return true;
    } finally {
      _restarting = false;
    }
  }

  const unregisterTick = registerTick((dt: number) => {
    if (!running.value) return;
    elapsed.value += dt;
    // A declined restart leaves the end condition true, so re-trying next
    // tick would fire `beforeEnd` (and log a phantom cycle) every tick.
    if (ended?.read() && !end()) {
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
    resume() {
      running.value = true;
    },
    pause() {
      running.value = false;
    },
    dispose() {
      unregisterTick();
    },
  };

  return attachPersistentContextReset(cycle, contextId);
}
