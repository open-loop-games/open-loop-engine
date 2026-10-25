/**
 * Cycle system — bounded runs that end, reset, and start the next run
 *
 * Composes Reset + time tracking + run counter into the "play a constrained
 * run, reset with meta-progression, play again" shape. A game built from
 * repeated runs is the origin, not the limit. A prestige layer and a
 * new-game-plus are the same lifecycle with a different trigger, and both are
 * built on this.
 *
 * - {@link createCycle} — the sole factory, wires up reset + elapsed timer + stats
 *
 * Supports any termination model via `endCondition`:
 * - Mana — the run ends when mana runs out
 * - Health — the run ends when HP reaches 0
 * - Fixed length — the run ends after N seconds
 * - Manual trigger — omit `endCondition`, call `cycle.end()` directly
 *
 * @see ./cycle-log for per-run analytics that snapshot/diff metrics on lifecycle events
 */

import { ref, type Ref } from 'vue';
import type { Computable } from '@/core/computed';
import {
  persistent,
  type Persistent,
  withPersistentContext,
  disownPersistent,
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
   * handler to stay on a results screen until the player resumes with
   * `resume()`. The screen reads state captured in `onBeforeEnd` or a
   * `CycleLog` entry, because the reset scope has already been reset.
   */
  afterEnd: () => void;
}

/** Options for {@link createCycle} */
export interface CycleOptions {
  /**
   * Persistent context id. Defaults to `${module}/cycle` inside a module; pass
   * one when a module builds more than one.
   */
  id?: string;

  /**
   * Automatic end Predicate, evaluated every tick while `running` is true.
   * When it holds, the run ends and the end sequence starts. A Gate
   * evaluates through the Gate services captured at `createCycle` time.
   * Omit for manual-only cycles where the player calls `cycle.end()`.
   *
   * If that end is declined (see {@link Cycle.end}), the cycle pauses
   * rather than retrying every tick; call `resume()` to evaluate it again.
   */
  endCondition?: Predicate;

  /**
   * A pre-built {@link Reset} to drive instead of constructing one from the
   * shorthand fields below. Takes precedence over `thingsToReset` /
   * `resetPersistentContexts` / `keep` / `retain` / `onEnd`, which are ignored when
   * this is supplied.
   *
   * Those five fields are shorthand covering the common case, deliberately not
   * a mirror of {@link ResetOptions}. Use this whenever the reset needs
   * anything they don't express, notably a `canReset` Predicate (and its
   * predictor projection) or the reset's own `beforeReset` / `afterReset` events.
   *
   * A Reset that declines cancels the end; see {@link Cycle.end}.
   */
  reset?: Reset;

  /**
   * Objects containing persistent refs to reset at each end (passed through to the internal {@link Reset}).
   * Optional when {@link resetPersistentContexts} is provided.
   */
  thingsToReset?: Computable<unknown[]>;

  /**
   * Persistent-context reset: list the persistent context ids to reset (a
   * module's id names its persistent context). Or compose with other
   * Reset/Cycle objects to take in their reset scope.
   * @see {@link ResetScope}
   */
  resetPersistentContexts?: ResetScope[];

  /**
   * Refs that should survive the reset at each end unchanged.
   * @see {@link createRetention}
   */
  keep?: Persistent[];

  /**
   * Refs with custom retention transforms applied after reset.
   * @see {@link createRetention}
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retain?: Map<Persistent, (value: any) => any>;

  /**
   * Called before the end. Return `false` to cancel the end.
   * Use for: calculating prestige currency, recording per-run stats, skill XP accumulation.
   */
  onBeforeEnd?: () => boolean | void;

  /**
   * Called at the end, after all persistent refs have been reset.
   * Use for: swapping action queues, applying meta-progression multipliers.
   *
   * It is the Reset's `onReset`, run under the reset's settle guard: resource
   * writes here never reach `cumulative` / `best`. Add resource gains in an
   * `afterEnd` handler, which runs once the reset has returned.
   */
  onEnd?: () => void;

  /** Registers a per-tick handler with the game loop (e.g., `ctx.onTick`) */
  registerTick: RegisterTick;
}

/**
 * A cycle instance — the returned object from {@link createCycle}.
 *
 * Call `resume()` to start ticking, `pause()` to stop ticking, `end()` to
 * start the end sequence. Stats (`count`, `bestTime`) and the current run's
 * `elapsed` are saved; `running` isn't. So a game that keeps a run going
 * after a load calls `resume()` once the load is done.
 */
export interface Cycle extends ScopedReset {
  /**
   * Total ended runs (saved). Tagged `lifetime`, like `bestTime`: the
   * cycle's own reset keeps both, even when it names the module the cycle
   * was built in.
   */
  readonly count: Persistent<number>;

  /**
   * Fastest run in seconds (saved, `Infinity` until the first run ends). A
   * run that ended before any time elapsed doesn't count.
   */
  readonly bestTime: Persistent<number>;

  /**
   * Elapsed time in the current run, in seconds (saved, so a reload
   * resumes the run's clock). Resets to 0 at each end, and under any reset
   * whose reset scope covers the cycle's persistent context.
   */
  readonly elapsed: Persistent<number>;

  /**
   * Whether the cycle is ticking. Controlled by `resume()` / `pause()`;
   * not saved, so a fresh play session starts paused until `resume()`.
   */
  readonly running: Ref<boolean>;

  /**
   * The flattened set of persistent refs resolved from `resetPersistentContexts`.
   * Exposed so other cycles can compose with this cycle's reset scope.
   */
  readonly resolvedScope: ReadonlySet<Persistent>;

  /** The underlying {@link Reset} instance — escape hatch for custom reset logic */
  readonly reset: Reset;

  /**
   * Trigger the end sequence: `onBeforeEnd` → `beforeEnd` event →
   * reset → stats → zero elapsed → `afterEnd` event.
   *
   * Returns `false` if the end is cancelled, and touches no stats, elapsed
   * time or `afterEnd` event. Two things cancel it: `onBeforeEnd` returning
   * `false`, or the underlying {@link Reset} declining (its `canReset`
   * Predicate or `onBeforeReset` option callback).
   *
   * The Reset decides after `beforeEnd` has already fired. So `onBeforeEnd`
   * is the cancellation point to prefer. An observer that records on
   * `beforeEnd` (a {@link CycleLog}) will have logged a run that then didn't
   * end. A declined end that `endCondition` triggered also pauses the cycle,
   * so that entry is logged once rather than on every tick. A declined manual
   * call leaves `running` alone.
   */
  end(): boolean;

  /** Start or resume ticking (sets `running = true`) */
  resume(): void;

  /**
   * Pause ticking (sets `running = false`). Elapsed time and `endCondition`
   * evaluation stop, and nothing else: producers and other tick handlers keep
   * ticking. To switch a set of mechanics off with the run, hold their grants
   * in one {@link createConditionalEffectSystem} def.
   */
  pause(): void;

  /** Subscribe to cycle lifecycle events */
  on: Emittable<CycleEvents>['on'];

  /**
   * Unregister the tick handler. The run count and timers become unowned: they
   * keep saving, and a cycle built with the same id in the same persistent
   * context takes them over.
   */
  dispose(): void;
}

// === FACTORIES ===

/**
 * Create a cycle — bounded runs that end, reset, and start the next run.
 *
 * Wires up a {@link Reset} with an elapsed timer, run counter, and best-time
 * record. The end sequence is: `onBeforeEnd` → `beforeEnd` →
 * reset persistent refs → `onEnd` → stats → zero elapsed → `afterEnd`.
 *
 * Fits any lifecycle shaped that way, whatever the game calls it — a run in a
 * game built from repeated runs, a prestige layer's reincarnation, a
 * new-game-plus.
 *
 * @param options - Cycle options (end Predicate, things to reset, option callbacks, tick registration)
 * @returns A {@link Cycle} with `resume()`, `pause()`, `end()`, stats, and events
 *
 * @example
 * ```ts
 * const cycle = createCycle({
 *   endCondition: () => Decimal.lte(mana.value, 0),
 *   thingsToReset: [points, upgrades, skills.map(s => s.xp)],
 *   onBeforeEnd() {
 *     // Accumulate lifetime skill bonuses before reset
 *     for (const skill of skills) skill.accumulateBonus();
 *   },
 *   registerTick: ctx.onTick,
 * });
 *
 * cycle.resume();  // start ticking
 * // The run ends when mana runs out, or call cycle.end() manually
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
    count: persistent(0, { id: 'count', lifetime: true }),
    bestTime: persistent(Infinity, { id: 'bestTime', lifetime: true }),
    elapsed: persistent(0, { id: 'elapsed' }),
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

  // `elapsed` is read after the emit and zeroed after that, so a handler
  // re-entering `end()` zeroes it before the outer comparison sees it and the
  // outer records a best time of 0 — into a persistent ref, where no later
  // run can beat it. The count double-increments for the same reason. Guards
  // the cycle's own bookkeeping only: the inner `reset` has its own flag,
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
      // cycle's own persistent context.
      const runTime = elapsed.value;

      // Stats and elapsed commit only once the reset has actually run. A Reset
      // with a `canReset` Predicate or an `onBeforeReset` option callback can
      // decline, and both checks run before it touches any ref — so declining is
      // clean and the cycle must not count, record a best time, or report an end.
      if (!reset.reset()) return false;

      // A zero-length run (two ends with no tick between) doesn't count, and
      // a best of 0 is one no later run could beat.
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
    // A declined end leaves the end Predicate holding, so retrying next
    // tick would emit `beforeEnd` (and log a phantom run) every tick.
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
      for (const r of [count, bestTime, elapsed]) disownPersistent(r);
    },
  };

  return attachPersistentContextReset(cycle, contextId);
}
