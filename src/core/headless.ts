/**
 * Headless runner — synchronous tick loop for deterministic simulation and tests
 */

import type { Analyzer, AnalyzerSummary } from '@/primitives/types';
import { seedRNG } from '@/primitives/rng';
import { beginTraceTick, endTraceTick } from './trace';
import { beginProfileTick, endProfileTick } from './profiler';

/** Options for one synchronous headless run. */
export interface HeadlessOptions {
  /**
   * Called once before the tick loop to build the headless run: initialize
   * state, register resources. Returns the analyzers of the headless run; a
   * headless run with no metrics returns `[]`. `setup` builds the analyzers
   * so they can close over the engine objects it just built (e.g. the
   * resource refs a sensitivity cell just installed).
   */
  setup: () => Analyzer[];
  /** Called once per iteration with `tickDelta`. Drives the game logic under test. */
  tick: (dt: number) => void;
  /** Number of iterations to run: one `tick(tickDelta)` call each. */
  iterations: number;
  /** Optional RNG seed for deterministic replay. Seeds the global Alea instance. */
  seed?: number;
  /** Sim-seconds each iteration advances. Defaults to 0.05. */
  tickDelta?: number;
  /**
   * Called once the analyzers have summarized, or once the headless run throws
   * after `setup` returned. Dispose what `setup` built here (e.g. its engine).
   * A throwing `setup` skips it, because what it built is unknown.
   */
  teardown?: () => void;
}

/** What a completed headless run returns. */
export interface HeadlessResult {
  /** Number of iterations that ran. */
  iterations: number;
  /** Sim-seconds the headless run advanced (iterations × tickDelta). */
  elapsedSimulated: number;
  /** One summary per analyzer, in the order `setup` returned them. */
  analyzerSummaries: AnalyzerSummary[];
}

/**
 * Run a fixed number of iterations headless. Calls each analyzer's `onStart`,
 * `onIteration` and `onEnd` around the consumer's `tick` function. Seeds the RNG
 * when `seed` is set, and runs the trace and profile buffers per iteration.
 * Returns each analyzer's summary. `teardown` runs after that, and also when
 * the headless run throws after `setup` returned.
 */
export function runHeadless(options: HeadlessOptions): HeadlessResult {
  const { setup, tick, iterations } = options;
  const tickDelta = options.tickDelta ?? 0.05;
  if (options.seed !== undefined) seedRNG(options.seed);
  const analyzers: Analyzer[] = setup() ?? [];
  try {
    for (const a of analyzers) a.onStart?.();
    for (let i = 0; i < iterations; i++) {
      beginTraceTick();
      beginProfileTick();
      try {
        tick(tickDelta);
      } finally {
        endProfileTick();
        endTraceTick();
      }
      for (const a of analyzers) a.onIteration?.(i);
    }
    for (const a of analyzers) a.onEnd?.();
    const analyzerSummaries = analyzers.map((a) => a.summarize());
    return {
      iterations,
      elapsedSimulated: iterations * tickDelta,
      analyzerSummaries,
    };
  } finally {
    options.teardown?.();
  }
}
