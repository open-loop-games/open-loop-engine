/**
 * Loop system — constrained-replay incremental games
 *
 * Composes Reset + time tracking + loop counter into the "loop incremental"
 * pattern: play a constrained period, reset with meta-progression, replay.
 *
 * - {@link createLoop} — the sole factory, wires up reset + elapsed timer + stats
 *
 * Supports any termination model via `endCondition`:
 * - Mana-budget (Idle Loops) — loop ends when mana depletes
 * - Health-to-zero (Increlution) — loop ends when HP hits 0
 * - Fixed time budget (Groundhog Life) — loop ends after N seconds
 * - Manual trigger (Progress Knight) — omit `endCondition`, call `loop.end()` directly
 *
 * @see ./loop-log for per-loop analytics that snapshot/diff metrics on lifecycle events
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

/** Events emitted by a {@link Loop} instance */
export interface LoopEvents {
  /** Fired after `onBeforeRestart` succeeds, before the actual reset executes */
  beforeRestart: () => void;
  /** Fired after the reset completes and elapsed time is zeroed */
  afterRestart: () => void;
}

/** Options for {@link createLoop} */
export interface LoopOptions {
  /** Persistence ID. Falls back to surrounding context or auto-generated. Explicit IDs are safer for save compat. */
  id?: string;

  /**
   * Automatic termination condition, checked every tick while `running` is true.
   * When it returns `true`, the loop ends and the restart sequence fires.
   * Omit for manual-only loops where the player calls `loop.end()`.
   */
  endCondition?: () => boolean;

  /**
   * Objects containing persistent refs to reset each loop (passed through to the internal {@link Reset}).
   * Optional when {@link resetModules} is provided.
   */
  thingsToReset?: Computable<unknown[]>;

  /**
   * Module-scoped reset: declare which modules to reset by ID, or compose
   * with other Reset/Loop objects to inherit their scope.
   * @see {@link ResetScope}
   */
  resetModules?: ResetScope[];

  /**
   * Refs that should survive the loop reset unchanged.
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
   * Use for: calculating prestige currency, recording per-loop stats, skill XP accumulation.
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
 * A loop instance — the returned object from {@link createLoop}.
 *
 * Call `run()` to start ticking, `pause()` to freeze, `end()` to trigger
 * the restart sequence. Stats (`count`, `bestTime`) persist across saves.
 */
export interface Loop extends ScopedReset {
  /** Total completed loops (persistent, saved automatically) */
  readonly count: Persistent<number>;

  /** Fastest loop completion in seconds (persistent, `Infinity` until first loop) */
  readonly bestTime: Persistent<number>;

  /** Elapsed time in the current loop, in seconds. Resets to 0 on restart. */
  readonly elapsed: Ref<number>;

  /** Whether the loop is actively ticking. Controlled by `run()` / `pause()`. */
  readonly running: Ref<boolean>;

  /**
   * The flattened set of persistent refs resolved from `resetModules`.
   * Exposed so other loops can compose with this loop's scope.
   */
  readonly resolvedScope: ReadonlySet<Persistent>;

  /** The underlying {@link Reset} instance — escape hatch for custom reset logic */
  readonly reset: Reset;

  /** Trigger the restart sequence: pre-hook → stats → reset → post-hook. Returns `false` if cancelled by `onBeforeRestart`. */
  end(): boolean;

  /** Start or resume ticking (sets `running = true`) */
  run(): void;

  /** Pause ticking (sets `running = false`). Elapsed time and endCondition checks freeze. */
  pause(): void;

  /** Subscribe to loop lifecycle events */
  on: Emittable<LoopEvents>['on'];

  /** Unregister the tick handler. Call when the loop is no longer needed. */
  dispose(): void;
}

// === FACTORIES ===

let loopCounter = 0;

/**
 * Create a loop — the core building block of loop-incremental games.
 *
 * Wires up a {@link Reset} with an elapsed timer, loop counter, and best-time
 * tracker. The restart sequence is: `onBeforeRestart` → stats update → reset
 * persistent refs → `onRestart` → zero elapsed.
 *
 * @param options - Configuration for the loop (end condition, things to reset, hooks, tick registration)
 * @returns A {@link Loop} with `run()`, `pause()`, `end()`, stats, and event hooks
 *
 * @example
 * ```ts
 * const gameLoop = createLoop({
 *   endCondition: () => Decimal.lte(mana.value, 0),
 *   thingsToReset: [points, upgrades, skills.map(s => s.xp)],
 *   onBeforeRestart() {
 *     // Accumulate permanent skill bonuses before reset
 *     for (const skill of skills) skill.accumulateBonus();
 *   },
 *   registerTick: ctx.onTick,
 * });
 *
 * gameLoop.run();  // start ticking
 * // Loop auto-ends when mana depletes, or call gameLoop.end() manually
 * ```
 */
export function createLoop(options: LoopOptions): Loop {
  const autoId = `loop_${loopCounter++}`;

  const {
    id,
    endCondition,
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
  const handle = createEmitHandle<LoopEvents>();

  const reset = createReset({
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

    if (elapsed.value < bestTime.value) {
      bestTime.value = elapsed.value;
    }
    count.value++;

    reset.reset();

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

  const loop: Loop = {
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

  return loop;
}

// === TYPE GUARDS ===
