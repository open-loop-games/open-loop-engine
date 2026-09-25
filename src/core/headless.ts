/**
 * Headless runner — synchronous tick loop for deterministic simulation and tests
 */

import type { Analyzer, AnalyzerResult } from '@/primitives/types';
import { seedRNG } from '@/primitives/rng';
import { beginTraceTick, endTraceTick } from './trace';
import { beginProfileTick, endProfileTick } from './profiler';

/** Configuration for a synchronous headless simulation run. */
export interface HeadlessConfig {
  /**
   * Called once before the tick loop — initialize state, register resources,
   * etc. Returns the analyzer list for this run; metric-free runs return `[]`.
   * Setup produces the analyzers so they can close over freshly-built engine
   * state (e.g. the per-run resource refs a sensitivity cell just installed).
   */
  setup: () => Analyzer[];
  /** Called once per tick with the fixed dt. Drives the game logic under test. */
  tick: (dt: number) => void;
  /** Total number of ticks to simulate. */
  ticks: number;
  /** Optional RNG seed for deterministic replay. Seeds the global Alea instance. */
  seed?: number;
  /** Seconds of simulated time per tick (default 0.05, i.e. 20 TPS). */
  tickDelta?: number;
  /**
   * Called once the analyzers have summarized — release what `setup` built
   * (e.g. dispose the run's engine).
   */
  teardown?: () => void;
}

/** Results returned after a completed headless simulation run. */
export interface HeadlessResult {
  /** Number of ticks that were executed. */
  totalTicks: number;
  /** Total simulated wall-clock time in seconds (ticks × tickDelta). */
  elapsedSimulated: number;
  /** One result object per analyzer, in the same order `setup` returned them. */
  analyzerResults: AnalyzerResult[];
}

/**
 * Run a fixed-tick-count headless simulation, threading each analyzer's
 * `onStart` / `onTick` / `onEnd` callbacks around the consumer's `tick`
 * function. Seeds the RNG when `seed` is set, runs the trace and profile
 * buffers per tick, and returns each analyzer's summary at the end, after
 * which `teardown` runs.
 */
export function runHeadless(config: HeadlessConfig): HeadlessResult {
  const { setup, tick, ticks } = config;
  const tickDelta = config.tickDelta ?? 0.05;
  if (config.seed !== undefined) seedRNG(config.seed);
  const analyzers: Analyzer[] = setup() ?? [];
  for (const a of analyzers) a.onStart?.();
  for (let i = 0; i < ticks; i++) {
    beginTraceTick();
    beginProfileTick();
    tick(tickDelta);
    endProfileTick();
    endTraceTick();
    for (const a of analyzers) a.onTick?.(i);
  }
  for (const a of analyzers) a.onEnd?.();
  const analyzerResults = analyzers.map((a) => a.summarize());
  config.teardown?.();
  return {
    totalTicks: ticks,
    elapsedSimulated: ticks * tickDelta,
    analyzerResults,
  };
}
