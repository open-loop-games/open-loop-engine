/**
 * TickDriver — the game loop: timer-driven ticks with EWMA lag compensation.
 * Two tick modes: variable (the default and the genre standard) and a fixed-dt
 * accumulator (opt-in, for faithful ports of tick math that clamps on overshoot).
 *
 * Scheduling: `setInterval` fires at the interval rate. A timer provider such as
 * worker-timers keeps it firing in a background tab. Each interval measures its
 * raw dt with `performance.now()`.
 *
 * Variable mode (`tickMode: 'variable'`, the default): each interval runs one
 * tick. Its dt is the raw dt, capped at `maxDeltaTime` and scaled by game speed.
 * This matches the genre-standard loop.
 *
 * Fixed mode (`tickMode: 'fixed'`): each interval adds its raw dt, capped at
 * `maxDeltaTime` and scaled by game speed, to an accumulator. It then runs ticks
 * of `fixedDt` until the remainder is below `fixedDt`. `maxTicksPerInterval` caps
 * the ticks one interval runs. The remainder above the cap is discarded, never
 * kept for later, and `onTicksOverflow`, when set, reports it. Use fixed mode
 * when tick math presumes a small constant dt, such as 120 ms ticks or a
 * per-tick decay.
 *
 * EWMA: an exponentially weighted moving average tracks the mean raw dt in both
 * modes. In variable mode the capped dt compensates for sustained lag; in fixed
 * mode the accumulator does.
 *
 * Game speed: `speedMultiplier` scales dt in live play. The timer loop applies it,
 * and so does `processInterval()`, the live path with an injected clock that
 * replay uses. `advanceTime()` and `tickOnce()` do not, so offline replay and
 * tests stay deterministic and match wall-clock time.
 *
 * Offline replay: in fixed mode `advanceTime()` also uses the accumulator, but
 * `maxTicksPerInterval` does not bound it. That cap protects live play from
 * overflow only. `processOfflineTime`'s `maxOfflineSeconds` bounds offline time
 * before it reaches the loop.
 *
 * Deterministic replay: fixed mode with a seeded RNG and `tickOnce()` gives
 * bit-identical tick sequences under any tab performance. Variable mode cannot.
 *
 * Variable dt with `setInterval` is the genre standard. EWMA lag compensation
 * typically runs at an interval rate of 200 with a filter strength of 20. Fixed
 * mode is opt-in, for faithful ports and for tick-drift diagnostics.
 */

import { shallowRef } from 'vue';
import { persistent, withPersistentContext } from './persistence';
import { beginTraceTick, endTraceTick } from './trace';
import { beginProfileTick, endProfileTick } from './profiler';

// Monotonic counter for per-driver persistent context ids. Several drivers in
// one runtime (tests, multi-engine setups) each get their own persistent
// context, so the `accumulator` save key doesn't collide.
let tickDriverCounter = 0;

/** Timer functions for scheduling. Defaults to native setInterval/clearInterval. */
export interface TimerProvider {
  setInterval: (callback: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
}

/**
 * Options for {@link createTickDriver}. They set the interval rate, the tick
 * mode, the overflow callbacks and the timer provider. Every option default
 * matches the genre-standard shape: 20 intervals per second, variable dt.
 */
export interface TickDriverOptions {
  /** Intervals per second (default 20): the `setInterval` cadence. */
  intervalRate?: number;
  /**
   * Maximum seconds of game time per tick (default 1). Live variable-mode play clamps
   * to it; `advanceTime` splits a longer dt into several ticks instead.
   */
  maxDeltaTime?: number;
  /** Initial game speed (default 1). It scales dt in live play only. */
  speedMultiplier?: number;
  /**
   * Tick mode. `'variable'` (the default and the genre standard) runs one tick per
   * interval, with the raw dt capped and scaled by game speed, so any dt works.
   * `'fixed'` accumulates that dt and runs ticks of `fixedDt` from it. It suits
   * faithful ports whose tick math presumes a small constant dt. Examples are jobs
   * that clamp on overshoot, and decay formulas written for 20 ms or 120 ms ticks.
   */
  tickMode?: 'variable' | 'fixed';
  /**
   * The dt of every fixed-mode tick. Defaults to `1 / intervalRate`. Unused in
   * variable mode. Typical values: 0.020, 0.120.
   */
  fixedDt?: number;
  /**
   * Cap on the fixed-mode ticks one interval runs (default 100). It protects a
   * frozen tab that wakes from a burst of ticks. The remainder above the cap is
   * discarded and the accumulator resets to 0. It does not apply to `advanceTime`
   * or `tickOnce`.
   */
  maxTicksPerInterval?: number;
  /**
   * Called when a fixed-mode interval discards ticks, because the accumulator
   * exceeded `maxTicksPerInterval * fixedDt`. It receives the whole number of
   * discarded ticks. Default: no-op. Overflow never throws.
   */
  onTicksOverflow?: (droppedTicks: number) => void;
  /**
   * Called in variable mode when raw dt exceeds `maxDeltaTime`. The loop then
   * clamps, because a hidden tab or a hitch gave more wall-clock time than one
   * interval simulates. It receives the discarded seconds (`rawDt - maxDeltaTime`).
   * Default: no-op; it never throws. It is the variable-mode counterpart of
   * `onTicksOverflow`, for a consumer that deposits the overflow in a time bank
   * instead of discarding it.
   */
  onDeltaOverflow?: (droppedSeconds: number) => void;
  /**
   * Custom timer functions for scheduling. Pass `worker-timers` functions
   * so the timer keeps firing in a background tab. Defaults to native
   * setInterval/clearInterval.
   */
  timerProvider?: TimerProvider;
  /**
   * Persistent context id for the fixed-mode accumulator. When set, the
   * accumulator registers under exactly this id, inside any ambient persistence
   * namespace ({@link withPersistenceNamespace}). The id is then a *stable* save
   * key, so a save and a load restore the accumulator deterministically, as part
   * of the engine's save. The engine passes `'tick-driver'` inside its
   * `persistenceNamespace`. So the accumulator is in that persistence namespace,
   * and `dispose()` deletes it.
   *
   * When unset (the default), the id is a process-wide `tick-driver_${counter}`.
   * That never collides between standalone drivers in one runtime. But it
   * depends on creation order, so it is not deterministic across play sessions.
   * An engine owns exactly one driver, so the engine supplies the stable id.
   */
  persistentContextId?: string;
}

/** Handlers for a tick phase, registered with `tickDriver.registerPhase()`. */
export interface PhaseHandlers {
  onEnter?: () => void;
  onExit?: () => void;
  onTick?: (dt: number) => void;
}

/**
 * A tick handler for `tickDriver.onTick`. It receives the tick's dt in seconds.
 * In live variable-mode play that is the raw dt, capped and scaled by game
 * speed; in fixed mode it is always `fixedDt`.
 */
export type TickHandler = (dt: number) => void;

/**
 * The TickDriver returned by {@link createTickDriver}. It has start and stop
 * control, and deterministic `tickOnce` and `advanceTime` for tests and
 * offline replay. It also has tick phases, and overflow callbacks that can be
 * set while it runs.
 */
export interface TickDriver {
  onTick(handler: TickHandler): () => void;
  /**
   * Run one interval of live play from an injected `rawDt`. This is the
   * game-speed path the timer loop runs, exposed for deterministic replay. It
   * applies the EWMA update, then the `maxDeltaTime` cap, which calls
   * `onDeltaOverflow`, then `speedMultiplier`. In fixed mode it then drains the
   * accumulator, capped by `maxTicksPerInterval`, which calls `onTicksOverflow`.
   * The timer loop calls exactly this with the wall clock; the balance harness's
   * `replayLive` calls it from a controlled clock. `advanceTime` is the offline
   * and test path instead: no game speed and no `maxTicksPerInterval`.
   */
  processInterval(rawDt: number): void;
  /**
   * Advance time: feed raw seconds through the loop as ticks, for offline
   * replay. It does not apply `speedMultiplier`. In fixed mode it drains the
   * accumulator in ticks of `fixedDt`, with no `maxTicksPerInterval` cap;
   * `processOfflineTime` bounds offline time before it. In variable mode, a
   * `rawDt` above `maxDeltaTime` runs as the fewest equal ticks under the cap. So
   * every second fed in is simulated, and `onDeltaOverflow` is never called.
   */
  advanceTime(rawDt: number): void;
  /**
   * Run exactly one tick, deterministically, for tests and headless runs. Its dt
   * is `fixedDt` in fixed mode and `1 / intervalRate` in variable mode.
   */
  tickOnce(): void;
  start(): void;
  stop(): void;
  registerPhase(name: string, handlers: PhaseHandlers): void;
  enterPhase(name: string): void;
  exitPhase(name: string): void;
  readonly running: boolean;
  /** Intervals per second. Setting it restarts the timer while the driver runs. */
  intervalRate: number;
  /** Game speed: it scales dt in live play. It does not affect advanceTime or tickOnce. */
  speedMultiplier: number;
  /**
   * The fixed-mode tick-discard callback (see the option). Set it after creation
   * when its closure needs objects built after the loop; `undefined` clears it.
   */
  onTicksOverflow: ((droppedTicks: number) => void) | undefined;
  /**
   * The variable-mode raw-dt clamp callback (see the option). It can be set after creation.
   */
  onDeltaOverflow: ((droppedSeconds: number) => void) | undefined;
  /**
   * EWMA of recent raw dt, in seconds. A read-only diagnostic and a snapshot: it
   * changes every interval but is not reactive, so a computed over it never
   * recomputes. Poll it on your own cadence.
   */
  readonly deltaMean: number;
  /** Per-tick dt cap (seconds). Variable-mode `advanceTime` splits a longer dt into ticks under it. */
  readonly maxDeltaTime: number;
}

/** EWMA smoothing factor. Higher = more smoothing, slower response. */
const FILTER_STRENGTH = 20;

/**
 * Tolerance for the fixed-mode accumulator's `>= fixedDt` compare. Iterative subtraction
 * accumulates FP error — e.g. draining 1.0 by 0.02 fifty times can leave the accumulator
 * at ~0.01999999999999986 after the 49th subtraction, which would fail a strict compare
 * and skip the final tick. Sized well below any realistic fixedDt (minimum ~0.001 s =
 * 1000 Hz) to round only numerical noise into the intended tick count.
 */
const ACCUMULATOR_EPSILON = 1e-9;

/**
 * Relative slack on the variable-mode split count: `2.1 / 0.7` is `3.0000000000000004`
 * (error ~1e-16), while a genuine fractional remainder sits far above this.
 */
const SPLIT_QUOTIENT_EPSILON = 1e-12;

/**
 * Creates the game loop: a TickDriver with EWMA lag compensation, game speed, tick
 * phases, and a variable-dt (default) or fixed-dt tick mode.
 *
 * @param options - The interval rate, the dt cap, game speed and `tickMode` (`'variable'`
 *   or `'fixed'`). Fixed mode adds `fixedDt`, `maxTicksPerInterval` and
 *   `onTicksOverflow`. A custom timer provider serves Web Workers or tests.
 * @returns A TickDriver to start and stop, with enter, exit and tick handlers per tick
 *   phase. Its `advanceTime()` and `tickOnce()` serve deterministic tests.
 *
 * @example
 * ```ts
 * // Variable mode (genre default)
 * const tickDriver = createTickDriver({ intervalRate: 20 });
 * tickDriver.onTick((dt) => updateResources(dt));
 * tickDriver.registerPhase('combat', { onTick: (dt) => tickCombat(dt) });
 * tickDriver.start();
 *
 * // Fixed mode (source-faithful ports)
 * const fixed = createTickDriver({
 *   intervalRate: 50,
 *   tickMode: 'fixed',
 *   fixedDt: 0.020, // 20 ms ticks
 *   maxTicksPerInterval: 100,
 * });
 * ```
 */
export function createTickDriver(options: TickDriverOptions = {}): TickDriver {
  const intervalRate = shallowRef(options.intervalRate ?? 20);
  const maxDeltaTime = options.maxDeltaTime ?? 1;
  let tickInterval = 1 / intervalRate.value;
  const speedMultiplier = shallowRef(options.speedMultiplier ?? 1);
  const tickMode = options.tickMode ?? 'variable';
  const fixedDt = options.fixedDt ?? 1 / intervalRate.value;
  const maxTicksPerInterval = options.maxTicksPerInterval ?? 100;
  let onTicksOverflow = options.onTicksOverflow;
  let onDeltaOverflow = options.onDeltaOverflow;

  // Fixed-mode accumulator. Persistent so `importSave` restores it with the
  // rest of live state; a closure-local value would leave a remainder below
  // `fixedDt` out of step with resources after a mid-run load, which breaks
  // deterministic replay and bisection. Unused in variable mode, where it
  // stays 0, so its save key costs nothing. A caller-supplied id (the engine's
  // `'tick-driver'`, inside its persistence namespace) is a stable save key
  // across play sessions; the counter fallback never collides but depends on
  // creation order — see `persistentContextId`.
  const driverContextId = options.persistentContextId ?? `tick-driver_${++tickDriverCounter}`;
  const accumulator = withPersistentContext(driverContextId, () =>
    persistent<number>(0, { id: 'accumulator' }),
  );

  const timers: TimerProvider = options.timerProvider ?? {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };

  const callbacks: TickHandler[] = [];
  const phases = new Map<string, PhaseHandlers>();
  const activePhases = new Set<string>();
  const running = shallowRef(false);
  let intervalId: number | null = null;
  let lastTime = 0;
  let deltaMean = 0;

  // Index of the handler processTick is running, or -1 between ticks. A
  // handler that unsubscribes itself (or an earlier one) mid-tick shifts the
  // rest down one position; the unsubscribe moves this back so none is skipped.
  let tickIndex = -1;

  function onTick(callback: TickHandler): () => void {
    callbacks.push(callback);
    return () => {
      const idx = callbacks.indexOf(callback);
      if (idx === -1) return;
      callbacks.splice(idx, 1);
      if (idx <= tickIndex) tickIndex--;
    };
  }

  function processTick(dt: number): void {
    beginTraceTick();
    beginProfileTick();
    try {
      for (tickIndex = 0; tickIndex < callbacks.length; tickIndex++) callbacks[tickIndex](dt);
    } finally {
      tickIndex = -1;
    }
    for (const name of activePhases) phases.get(name)?.onTick?.(dt);
    endProfileTick();
    endTraceTick();
  }

  // The live interval body, shared by the timer loop and deterministic replay.
  // It is the one place for the live dt math: EWMA, the maxDeltaTime cap,
  // speedMultiplier scaling, and the fixed-mode accumulator drain bounded by
  // maxTicksPerInterval.
  function processInterval(rawDt: number): void {
    if (rawDt <= 0) return;

    // EWMA: track the mean raw dt for diagnostics and lag detection (both modes)
    deltaMean += (rawDt - deltaMean) / FILTER_STRENGTH;

    const cappedDt = Math.min(rawDt, maxDeltaTime);
    if (rawDt > maxDeltaTime) {
      onDeltaOverflow?.(rawDt - maxDeltaTime);
    }

    if (tickMode === 'fixed') {
      accumulator.value += cappedDt * speedMultiplier.value;
      let ticks = 0;
      while (accumulator.value + ACCUMULATOR_EPSILON >= fixedDt && ticks < maxTicksPerInterval) {
        processTick(fixedDt);
        accumulator.value -= fixedDt;
        ticks++;
      }
      if (accumulator.value + ACCUMULATOR_EPSILON >= fixedDt) {
        const droppedTicks = Math.floor(accumulator.value / fixedDt);
        accumulator.value = 0;
        onTicksOverflow?.(droppedTicks);
      }
      return;
    }

    processTick(cappedDt * speedMultiplier.value);
  }

  function intervalTick(): void {
    if (!running.value) return;
    const now = performance.now();
    const rawDt = (now - lastTime) / 1000;
    lastTime = now;
    processInterval(rawDt);
  }

  function advanceTime(rawDt: number): void {
    if (tickMode === 'fixed') {
      accumulator.value += rawDt;
      while (accumulator.value + ACCUMULATOR_EPSILON >= fixedDt) {
        processTick(fixedDt);
        accumulator.value -= fixedDt;
      }
      return;
    }
    if (!(rawDt > maxDeltaTime)) {
      processTick(rawDt);
      return;
    }
    const q = rawDt / maxDeltaTime;
    const ticks = Math.ceil(q - q * SPLIT_QUOTIENT_EPSILON);
    const dt = rawDt / ticks;
    for (let i = 0; i < ticks; i++) processTick(dt);
  }

  function startInterval(): void {
    lastTime = performance.now();
    deltaMean = tickInterval;
    intervalId = timers.setInterval(intervalTick, Math.round(1000 / intervalRate.value));
  }

  function stopInterval(): void {
    if (intervalId !== null) {
      timers.clearInterval(intervalId);
      intervalId = null;
    }
  }

  function start(): void {
    if (running.value) return;
    running.value = true;
    startInterval();
  }

  function stop(): void {
    running.value = false;
    stopInterval();
  }

  return {
    onTick,
    processInterval,
    advanceTime,
    maxDeltaTime,
    start,
    stop,
    tickOnce() {
      processTick(tickMode === 'fixed' ? fixedDt : tickInterval);
    },
    registerPhase(name, hooks) {
      phases.set(name, hooks);
    },
    enterPhase(name) {
      if (!activePhases.has(name)) {
        activePhases.add(name);
        phases.get(name)?.onEnter?.();
      }
    },
    exitPhase(name) {
      if (activePhases.has(name)) {
        activePhases.delete(name);
        phases.get(name)?.onExit?.();
      }
    },
    get running() {
      return running.value;
    },
    get intervalRate() {
      return intervalRate.value;
    },
    set intervalRate(value: number) {
      intervalRate.value = value;
      tickInterval = 1 / value;
      if (running.value) {
        stopInterval();
        startInterval();
      }
    },
    get speedMultiplier() {
      return speedMultiplier.value;
    },
    set speedMultiplier(value: number) {
      speedMultiplier.value = value;
    },
    get onTicksOverflow() {
      return onTicksOverflow;
    },
    set onTicksOverflow(fn) {
      onTicksOverflow = fn;
    },
    get onDeltaOverflow() {
      return onDeltaOverflow;
    },
    set onDeltaOverflow(fn) {
      onDeltaOverflow = fn;
    },
    get deltaMean() {
      return deltaMean;
    },
  };
}
