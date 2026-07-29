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
 * TMT/Profectus/AD/Synergism and every existing consumer.
 *
 * Fixed mode (`tickMode: 'fixed'`): accumulates real elapsed dt (scaled by
 * speedMultiplier), then drains the accumulator by calling `processTick(stepSize)`
 * repeatedly until the remainder is below stepSize. `maxStepsPerTick` caps per-interval
 * sub-steps; residual above the cap is dropped (optionally reported via
 * `onStepsOverflow`), never banked. For consumers whose tick math presumes a small
 * constant dt (Arcanum 120ms, Increlution tick-counter decay).
 *
 * EWMA: An exponentially-weighted moving average tracks mean raw dt in both modes.
 * In variable mode the capped dt itself compensates for sustained lag; in fixed mode
 * the accumulator does.
 *
 * Speed control: `speedMultiplier` scales dt before passing to callbacks during live play.
 * Both the timer loop and `tickRaw()` (the injected-clock live path used by replay) apply
 * it. `simulateTick()` and `stepOnce()` do NOT — offline processing and tests stay
 * wall-clock faithful and deterministic.
 *
 * Offline catchup: `simulateTick()` in fixed mode also uses the accumulator but is NOT
 * bounded by `maxStepsPerTick` — that cap is live-play overspill protection only.
 * Offline work is bounded upstream by `processOfflineTime`'s `maxOfflineSeconds`.
 *
 * Deterministic replay: fixed mode + seeded RNG + `stepOnce()` produces bit-identical
 * sequences across tab-performance profiles. Variable mode cannot.
 *
 * Variable dt with setInterval is the genre standard. EWMA lag compensation adapted
 * from Synergism (200 TPS, filterStrength=20). Fixed mode is an opt-in for the
 * source-faithful-port case (incloneution's tick-drift diagnostic).
 */

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
export interface TickDriverConfig {
  /** Ticks per second (default 20). Controls the setInterval cadence. */
  tickRate?: number;
  /** Maximum seconds of game time per tick (default 1). Caps variable dt. */
  maxDeltaTime?: number;
  /** Initial speed multiplier (default 1). Scales dt during live play only. */
  speedMultiplier?: number;
  /**
   * dt handling mode. `'variable'` (default) passes real elapsed dt to callbacks once
   * per interval — genre standard, arbitrary dt supported. `'fixed'` accumulates real
   * elapsed dt and drains at `stepSize` per sub-tick — for source-faithful ports whose
   * tick math presumes a small constant dt (clamp-on-overshoot jobs, decay formulas
   * authored against a 20ms or 120ms step).
   */
  tickMode?: 'variable' | 'fixed';
  /**
   * Seconds per sub-tick in fixed mode. Defaults to `1 / tickRate`. Unused in variable
   * mode. Typical values: 0.020 (incloneution/Increlution), 0.120 (Arcanum).
   */
  stepSize?: number;
  /**
   * Cap on sub-ticks drained per `intervalTick` invocation in fixed mode (default 100).
   * Overspill protection for frozen-tab wakeups — residual above the cap is dropped and
   * the accumulator resets to 0. Does NOT apply to `simulateTick` or `stepOnce`.
   */
  maxStepsPerTick?: number;
  /**
   * Diagnostic callback fired when fixed-mode `intervalTick` drops sub-steps because
   * the accumulator exceeded `maxStepsPerTick * stepSize`. Receives the floor of
   * dropped-steps count. Default: no-op. Never throws on overflow.
   */
  onStepsOverflow?: (droppedSteps: number) => void;
  /**
   * Diagnostic callback fired in variable mode when raw dt exceeds `maxDeltaTime`, i.e.
   * the loop clamped because a long tab-hide or hitch produced more wall time than the
   * loop will simulate in one interval. Receives the dropped seconds
   * (`rawDt - maxDeltaTime`). Default: no-op. Never throws. Mirrors `onStepsOverflow`
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
export interface PhaseHooks {
  onEnter?: () => void;
  onExit?: () => void;
  onTick?: (dt: number) => void;
}

/**
 * Tick-handler signature for `tickDriver.onTick`: dt in seconds — the real
 * (speed-scaled, capped) elapsed time in variable mode, always `stepSize` in
 * fixed mode.
 */
export type TickCallback = (dt: number) => void;

/**
 * The TickDriver instance returned by {@link createTickDriver}. Exposes
 * start/stop control, deterministic `stepOnce` / `simulateTick` entry points
 * for tests and offline processing, named-phase hooks, and live-settable
 * overflow diagnostics.
 */
export interface TickDriver {
  onTick(callback: TickCallback): () => void;
  /**
   * Run one live tick from an injected `rawDt` — the speed-aware path the timer
   * loop runs internally, exposed for deterministic replay. Applies the EWMA
   * update, the `maxDeltaTime` cap (firing `onDeltaOverflow`), `speedMultiplier`,
   * and in fixed mode the `maxStepsPerTick`-bounded accumulator drain (firing
   * `onStepsOverflow`). `intervalTick` is exactly this fed the wall clock; the
   * harness `replayLive` drives it from a controlled clock. Contrast
   * `simulateTick`, the offline/test path: no speed scaling, no `maxStepsPerTick`.
   */
  tickRaw(rawDt: number): void;
  /**
   * Feed raw seconds through the loop (for offline processing). Does NOT apply
   * speedMultiplier. In fixed mode, drains the accumulator at `stepSize` per sub-tick
   * with no `maxStepsPerTick` cap (offline is bounded upstream by `processOfflineTime`).
   */
  simulateTick(rawDt: number): void;
  /**
   * Process exactly one tick. Deterministic — for tests and headless. dt is `stepSize`
   * in fixed mode, `1 / tickRate` (tickInterval) in variable mode.
   */
  stepOnce(): void;
  start(): void;
  stop(): void;
  registerPhase(name: string, hooks: PhaseHooks): void;
  enterPhase(name: string): void;
  exitPhase(name: string): void;
  readonly running: boolean;
  /** Ticks per second. Setter restarts the interval if running. */
  tickRate: number;
  /** Scales dt during live play. Does not affect simulateTick or stepOnce. */
  speedMultiplier: number;
  /**
   * Live-settable diagnostic callback for fixed-mode sub-step drop (see config field).
   * Consumers that need the grant closure built after the loop exists can set this
   * post-create; setting to `undefined` clears it.
   */
  onStepsOverflow: ((droppedSteps: number) => void) | undefined;
  /**
   * Live-settable diagnostic callback for variable-mode raw-dt clamp (see config field).
   */
  onDeltaOverflow: ((droppedSeconds: number) => void) | undefined;
  /** EWMA of recent tick deltas (seconds). Read-only diagnostic. */
  readonly deltaMean: number;
  /** Per-tick dt cap (seconds). `simulateTick` clamps to this in variable mode. */
  readonly maxDeltaTime: number;
}

/** EWMA smoothing factor. Higher = more smoothing, slower response. Matches Synergism. */
const FILTER_STRENGTH = 20;

/**
 * Tolerance for the fixed-mode accumulator's `>= stepSize` compare. Iterative subtraction
 * accumulates FP error — e.g. draining 1.0 by 0.02 fifty times can leave the accumulator
 * at ~0.01999999999999986 after iteration 49, which would fail a strict compare and drop
 * the final sub-step. Sized well below any realistic stepSize (minimum ~0.001 s = 1000 Hz)
 * to round only numerical noise into the intended step count.
 */
const ACCUMULATOR_EPSILON = 1e-9;

/**
 * Creates a TickDriver with EWMA lag compensation, speed control, named phase hooks, and
 * a choice of variable-dt (default) or fixed-step accumulator mode.
 *
 * @param config - Driver configuration: tick rate, max delta, speed multiplier, `tickMode`
 *   (`'variable'` or `'fixed'`), plus fixed-mode knobs (`stepSize`, `maxStepsPerTick`,
 *   `onStepsOverflow`) and an optional custom timer provider for Web Workers or testing.
 * @returns A TickDriver that can be started/stopped, supports per-phase enter/exit/tick
 *   hooks, and exposes `simulateTick()` / `stepOnce()` for deterministic testing.
 *
 * @example
 * ```ts
 * // Variable mode (genre default)
 * const tickDriver = createTickDriver({ tickRate: 20 });
 * tickDriver.onTick((dt) => updateResources(dt));
 * tickDriver.registerPhase('combat', { onTick: (dt) => tickCombat(dt) });
 * tickDriver.start();
 *
 * // Fixed mode (source-faithful ports)
 * const fixed = createTickDriver({
 *   tickRate: 50,
 *   tickMode: 'fixed',
 *   stepSize: 0.020, // 20 ms sub-tick
 *   maxStepsPerTick: 100,
 * });
 * ```
 */
export function createTickDriver(config: TickDriverConfig = {}): TickDriver {
  let tickRate = config.tickRate ?? 20;
  const maxDeltaTime = config.maxDeltaTime ?? 1;
  let tickInterval = 1 / tickRate;
  let speedMultiplier = config.speedMultiplier ?? 1;
  const tickMode = config.tickMode ?? 'variable';
  const stepSize = config.stepSize ?? 1 / tickRate;
  const maxStepsPerTick = config.maxStepsPerTick ?? 100;
  let onStepsOverflow = config.onStepsOverflow;
  let onDeltaOverflow = config.onDeltaOverflow;

  // Fixed-mode time-integrated accumulator. Persistent so `importSave` restores
  // it alongside the rest of engine state; closure-local state would leave a
  // sub-tick (≤ `stepSize`) remainder desynced from resources after a mid-run
  // snapshot restore, breaking deterministic-replay and bisection flows.
  // Unused in variable mode; value stays 0 so the context key costs nothing.
  // A caller-supplied id (the engine's namespaced `'tick-driver'`) is a stable
  // key for cross-session determinism; the counter fallback is collision-free
  // but order-dependent — see `persistentContextId`.
  const driverContextId = config.persistentContextId ?? `tick-driver_${++tickDriverCounter}`;
  const accumulator = withPersistentContext(driverContextId, () =>
    persistent<number>(0, { name: 'accumulator' }),
  );

  const timers: TimerProvider = config.timerProvider ?? {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };

  const callbacks: TickCallback[] = [];
  const phases = new Map<string, PhaseHooks>();
  const activePhases = new Set<string>();
  let running = false;
  let intervalId: number | null = null;
  let lastTime = 0;
  let deltaMean = 0;

  function onTick(callback: TickCallback): () => void {
    callbacks.push(callback);
    return () => {
      const idx = callbacks.indexOf(callback);
      if (idx !== -1) callbacks.splice(idx, 1);
    };
  }

  function processTick(dt: number): void {
    beginTraceTick();
    beginProfileTick();
    for (const cb of callbacks) cb(dt);
    for (const name of activePhases) phases.get(name)?.onTick?.(dt);
    endProfileTick();
    endTraceTick();
  }

  // Speed-aware live-tick body, shared by the timer loop and deterministic
  // replay. The single home for the live dt math: EWMA, maxDeltaTime cap,
  // speedMultiplier scaling, and the fixed-mode accumulator drain bounded by
  // maxStepsPerTick.
  function tickRaw(rawDt: number): void {
    if (rawDt <= 0) return;

    // EWMA: track mean raw delta for diagnostics and lag detection (both modes)
    deltaMean += (rawDt - deltaMean) / FILTER_STRENGTH;

    const cappedDt = Math.min(rawDt, maxDeltaTime);
    if (rawDt > maxDeltaTime) {
      onDeltaOverflow?.(rawDt - maxDeltaTime);
    }

    if (tickMode === 'fixed') {
      accumulator.value += cappedDt * speedMultiplier;
      let steps = 0;
      while (accumulator.value + ACCUMULATOR_EPSILON >= stepSize && steps < maxStepsPerTick) {
        processTick(stepSize);
        accumulator.value -= stepSize;
        steps++;
      }
      if (accumulator.value + ACCUMULATOR_EPSILON >= stepSize) {
        const droppedSteps = Math.floor(accumulator.value / stepSize);
        accumulator.value = 0;
        onStepsOverflow?.(droppedSteps);
      }
      return;
    }

    processTick(cappedDt * speedMultiplier);
  }

  function intervalTick(): void {
    if (!running) return;
    const now = performance.now();
    const rawDt = (now - lastTime) / 1000;
    lastTime = now;
    tickRaw(rawDt);
  }

  function simulateTick(rawDt: number): void {
    if (tickMode === 'fixed') {
      accumulator.value += rawDt;
      while (accumulator.value + ACCUMULATOR_EPSILON >= stepSize) {
        processTick(stepSize);
        accumulator.value -= stepSize;
      }
      return;
    }
    processTick(Math.min(rawDt, maxDeltaTime));
  }

  function startInterval(): void {
    lastTime = performance.now();
    deltaMean = tickInterval;
    intervalId = timers.setInterval(intervalTick, Math.round(1000 / tickRate));
  }

  function stopInterval(): void {
    if (intervalId !== null) {
      timers.clearInterval(intervalId);
      intervalId = null;
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    startInterval();
  }

  function stop(): void {
    running = false;
    stopInterval();
  }

  return {
    onTick,
    tickRaw,
    simulateTick,
    maxDeltaTime,
    start,
    stop,
    stepOnce() {
      processTick(tickMode === 'fixed' ? stepSize : tickInterval);
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
      return running;
    },
    get tickRate() {
      return tickRate;
    },
    set tickRate(value: number) {
      tickRate = value;
      tickInterval = 1 / value;
      if (running) {
        stopInterval();
        startInterval();
      }
    },
    get speedMultiplier() {
      return speedMultiplier;
    },
    set speedMultiplier(value: number) {
      speedMultiplier = value;
    },
    get onStepsOverflow() {
      return onStepsOverflow;
    },
    set onStepsOverflow(fn) {
      onStepsOverflow = fn;
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
