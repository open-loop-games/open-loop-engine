/**
 * TickDriver — worker-timer scheduled tick dispatcher with EWMA lag compensation.
 * Two dt modes: variable (default, genre-standard) and fixed-step accumulator
 * (opt-in, for source-faithful ports with clamp-on-overshoot tick math).
 *
 * Scheduling: Uses `setInterval` (optionally backed by worker-timers for background-tab
 * immunity) at the configured tick rate. Each tick measures real elapsed time via
 * `performance.now()`.
 *
 * Variable mode (`tickMode: 'variable'`, default): passes real elapsed dt (capped at
 * maxDeltaTime, scaled by speedMultiplier) to callbacks once per interval. Matches
 * the genre-standard loop and every existing consumer.
 *
 * Fixed mode (`tickMode: 'fixed'`): accumulates real elapsed dt (scaled by
 * speedMultiplier), then drains the accumulator by calling `processTick(fixedDt)`
 * repeatedly until the remainder is below fixedDt. `maxTicksPerInterval` caps per-interval
 * sub-steps; residual above the cap is dropped (optionally reported via
 * `onTicksOverflow`), never banked. For consumers whose tick math presumes a small
 * constant dt (e.g. 120ms steps, tick-counter decay).
 *
 * EWMA: An exponentially-weighted moving average tracks mean raw dt in both modes.
 * In variable mode the capped dt itself compensates for sustained lag; in fixed mode
 * the accumulator does.
 *
 * Speed control: `speedMultiplier` scales dt before passing to callbacks during live play.
 * Both the timer loop and `processInterval()` (the injected-clock live path used by replay) apply
 * it. `advanceTime()` and `tickOnce()` do NOT — offline processing and tests stay
 * wall-clock faithful and deterministic.
 *
 * Offline catchup: `advanceTime()` in fixed mode also uses the accumulator but is NOT
 * bounded by `maxTicksPerInterval` — that cap is live-play overspill protection only.
 * Offline work is bounded upstream by `processOfflineTime`'s `maxOfflineSeconds`.
 *
 * Deterministic replay: fixed mode + seeded RNG + `tickOnce()` produces bit-identical
 * sequences across tab-performance profiles. Variable mode cannot.
 *
 * Variable dt with setInterval is the genre standard. EWMA lag compensation
 * runs at a typical 200 TPS with filterStrength=20. Fixed mode is an opt-in
 * for source-faithful ports and tick-drift diagnostics.
 */

import { shallowRef } from 'vue';
import { persistent, withPersistentContext } from './persistence';
import { beginTraceTick, endTraceTick } from './trace';
import { beginProfileTick, endProfileTick } from './profiler';

// Monotonic counter for per-driver persistent context ids. Multiple drivers in
// a single runtime (tests, multi-engine setups) each get a distinct context so
// the `accumulator` key doesn't collide.
let tickDriverCounter = 0;

/** Timer functions for scheduling. Defaults to native setInterval/clearInterval. */
export interface TimerProvider {
  setInterval: (callback: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
}

/**
 * Configuration accepted by {@link createTickDriver}. Tunes cadence, dt mode,
 * overflow diagnostics, and the timer provider; every field has a default
 * matching the genre-standard 20 Hz variable-dt shape.
 */
export interface TickDriverOptions {
  /** Ticks per second (default 20). Controls the setInterval cadence. */
  intervalRate?: number;
  /**
   * Maximum seconds of game time per tick (default 1). Live variable-mode play clamps
   * to it; `advanceTime` splits a longer dt into several ticks instead.
   */
  maxDeltaTime?: number;
  /** Initial speed multiplier (default 1). Scales dt during live play only. */
  speedMultiplier?: number;
  /**
   * dt handling mode. `'variable'` (default) passes real elapsed dt to callbacks once
   * per interval — genre standard, arbitrary dt supported. `'fixed'` accumulates real
   * elapsed dt and drains at `fixedDt` per sub-tick — for source-faithful ports whose
   * tick math presumes a small constant dt (clamp-on-overshoot jobs, decay formulas
   * authored against a 20ms or 120ms step).
   */
  tickMode?: 'variable' | 'fixed';
  /**
   * Seconds per sub-tick in fixed mode. Defaults to `1 / intervalRate`. Unused in variable
   * mode. Typical values: 0.020, 0.120.
   */
  fixedDt?: number;
  /**
   * Cap on sub-ticks drained per `intervalTick` invocation in fixed mode (default 100).
   * Overspill protection for frozen-tab wakeups — residual above the cap is dropped and
   * the accumulator resets to 0. Does NOT apply to `advanceTime` or `tickOnce`.
   */
  maxTicksPerInterval?: number;
  /**
   * Diagnostic callback fired when a fixed-mode interval drops ticks because
   * the accumulator exceeded `maxTicksPerInterval * fixedDt`. Receives the floor of
   * dropped-ticks count. Default: no-op. Never throws on overflow.
   */
  onTicksOverflow?: (droppedTicks: number) => void;
  /**
   * Diagnostic callback fired in variable mode when raw dt exceeds `maxDeltaTime`, i.e.
   * the loop clamped because a long tab-hide or hitch produced more wall time than the
   * loop will simulate in one interval. Receives the dropped seconds
   * (`rawDt - maxDeltaTime`). Default: no-op. Never throws. Mirrors `onTicksOverflow`
   * for consumers that bank overflow (time-bank patterns) instead of discarding it.
   */
  onDeltaOverflow?: (droppedSeconds: number) => void;
  /**
   * Custom timer functions for scheduling. Pass `worker-timers` functions
   * for background-tab immunity. Defaults to native setInterval/clearInterval.
   */
  timerProvider?: TimerProvider;
  /**
   * Persistent-context id for the fixed-mode accumulator. When set, the
   * accumulator registers under this exact id (combined with any ambient
   * {@link withPersistenceNamespace}) — a *stable* key that survives a
   * save/reload deterministically and joins the engine's namespaced save. The
   * engine passes `'tick-driver'` here, wrapped in its `persistenceNamespace`,
   * so the accumulator lands in the right namespace bucket and is evicted by
   * `dispose()`.
   *
   * When unset (default), the id falls back to a process-global
   * `tick-driver_${counter}` — collision-free for multiple standalone drivers
   * in one runtime, but order-dependent and therefore unsuitable for
   * cross-session determinism. A single engine owns exactly one driver, so the
   * stable id is the engine's to supply.
   */
  persistentContextId?: string;
}

/** Lifecycle hooks for a named game phase, registered via `tickDriver.registerPhase()`. */
export interface PhaseHandlers {
  onEnter?: () => void;
  onExit?: () => void;
  onTick?: (dt: number) => void;
}

/**
 * Tick-handler signature for `tickDriver.onTick`: dt in seconds — the real
 * (speed-scaled, capped) elapsed time in variable mode, always `fixedDt` in
 * fixed mode.
 */
export type TickHandler = (dt: number) => void;

/**
 * The TickDriver instance returned by {@link createTickDriver}. Exposes
 * start/stop control, deterministic `tickOnce` / `advanceTime` entry points
 * for tests and offline processing, named-phase hooks, and live-settable
 * overflow diagnostics.
 */
export interface TickDriver {
  onTick(handler: TickHandler): () => void;
  /**
   * Run one live tick from an injected `rawDt` — the speed-aware path the timer
   * loop runs internally, exposed for deterministic replay. Applies the EWMA
   * update, the `maxDeltaTime` cap (firing `onDeltaOverflow`), `speedMultiplier`,
   * and in fixed mode the `maxTicksPerInterval`-bounded accumulator drain (firing
   * `onTicksOverflow`). `intervalTick` is exactly this fed the wall clock; the
   * harness `replayLive` drives it from a controlled clock. Contrast
   * `advanceTime`, the offline/test path: no speed scaling, no `maxTicksPerInterval`.
   */
  processInterval(rawDt: number): void;
  /**
   * Feed raw seconds through the loop (for offline processing). Does NOT apply
   * speedMultiplier. In fixed mode, drains the accumulator at `fixedDt` per sub-tick
   * with no `maxTicksPerInterval` cap (offline is bounded upstream by `processOfflineTime`).
   * In variable mode, a `rawDt` above `maxDeltaTime` runs as the fewest equal ticks
   * under the cap, so every second fed in is simulated and `onDeltaOverflow` never fires.
   */
  advanceTime(rawDt: number): void;
  /**
   * Process exactly one tick. Deterministic — for tests and headless. dt is `fixedDt`
   * in fixed mode, `1 / intervalRate` (tickInterval) in variable mode.
   */
  tickOnce(): void;
  start(): void;
  stop(): void;
  registerPhase(name: string, handlers: PhaseHandlers): void;
  enterPhase(name: string): void;
  exitPhase(name: string): void;
  readonly running: boolean;
  /** Ticks per second. Setter restarts the interval if running. */
  intervalRate: number;
  /** Scales dt during live play. Does not affect advanceTime or tickOnce. */
  speedMultiplier: number;
  /**
   * Live-settable diagnostic callback for fixed-mode sub-step drop (see config field).
   * Consumers that need the grant closure built after the loop exists can set this
   * post-create; setting to `undefined` clears it.
   */
  onTicksOverflow: ((droppedTicks: number) => void) | undefined;
  /**
   * Live-settable diagnostic callback for variable-mode raw-dt clamp (see config field).
   */
  onDeltaOverflow: ((droppedSeconds: number) => void) | undefined;
  /**
   * EWMA of recent tick deltas (seconds). Read-only diagnostic and a snapshot:
   * it changes every tick, so a computed over it never recomputes. Poll it on
   * your own cadence.
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
 * at ~0.01999999999999986 after iteration 49, which would fail a strict compare and drop
 * the final sub-step. Sized well below any realistic fixedDt (minimum ~0.001 s = 1000 Hz)
 * to round only numerical noise into the intended step count.
 */
const ACCUMULATOR_EPSILON = 1e-9;

/**
 * Relative slack on the variable-mode split count: `2.1 / 0.7` is `3.0000000000000004`
 * (error ~1e-16), while a genuine fractional remainder sits far above this.
 */
const SPLIT_QUOTIENT_EPSILON = 1e-12;

/**
 * Creates a TickDriver with EWMA lag compensation, speed control, named phase hooks, and
 * a choice of variable-dt (default) or fixed-step accumulator mode.
 *
 * @param options - Driver configuration: tick rate, max delta, speed multiplier, `tickMode`
 *   (`'variable'` or `'fixed'`), plus fixed-mode knobs (`fixedDt`, `maxTicksPerInterval`,
 *   `onTicksOverflow`) and an optional custom timer provider for Web Workers or testing.
 * @returns A TickDriver that can be started/stopped, supports per-phase enter/exit/tick
 *   hooks, and exposes `advanceTime()` / `tickOnce()` for deterministic testing.
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
 *   fixedDt: 0.020, // 20 ms sub-tick
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

  // Fixed-mode time-integrated accumulator. Persistent so `importSave` restores
  // it alongside the rest of engine state; closure-local state would leave a
  // sub-tick (≤ `fixedDt`) remainder desynced from resources after a mid-run
  // snapshot restore, breaking deterministic-replay and bisection flows.
  // Unused in variable mode; value stays 0 so the context key costs nothing.
  // A caller-supplied id (the engine's namespaced `'tick-driver'`) is a stable
  // key for cross-session determinism; the counter fallback is collision-free
  // but order-dependent — see `persistentContextId`.
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

  // Index of the callback processTick is running, or -1 between ticks. A
  // callback that unsubscribes itself (or an earlier one) mid-tick shifts the
  // rest down a slot; the unsubscribe steps this back so none is skipped.
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

  // Speed-aware live-tick body, shared by the timer loop and deterministic
  // replay. The single home for the live dt math: EWMA, maxDeltaTime cap,
  // speedMultiplier scaling, and the fixed-mode accumulator drain bounded by
  // maxTicksPerInterval.
  function processInterval(rawDt: number): void {
    if (rawDt <= 0) return;

    // EWMA: track mean raw delta for diagnostics and lag detection (both modes)
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
