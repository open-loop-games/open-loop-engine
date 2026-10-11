/**
 * Predicate-bounded runner — the engine-aware counterpart to `runHeadless`.
 *
 * `runHeadless` takes a `tick` function and a fixed tick count. `runUntil`
 * takes an `Engine` and a predicate. It drives the engine via
 * `engine.tickDriver.advanceTime(tickDelta)` until the predicate holds or
 * `maxSimTime` is reached. Beat-timing tests are the typical consumer: they
 * ask "how long until state X holds?", not "what is the state after N
 * ticks?".
 *
 * The caller's `tickDelta` decides the advance: each iteration advances the
 * engine by exactly `tickDelta` seconds via `advanceTime`, which keeps
 * fixed-mode accumulator semantics for source-faithful ports. A `tickDelta`
 * above the driver's `maxDeltaTime` runs as several engine ticks under the
 * cap, so reported sim-time is always the sim-time the engine simulated. This
 * decouples the balance harness from the engine's live `intervalRate`.
 * Coarsening `tickDelta` is a real speedup up to the cap, not only a
 * reporting change. (`tickOnce()` exists for deterministic-replay paths that
 * want the engine's own fixedDt regardless of caller dt; `runUntil`
 * deliberately does not call it.)
 *
 * The predicate receives an {@link UntilContext} snapshot (`iteration`,
 * `simTime`) and reads game state via closure over the caller's engine.
 * The predicate is evaluated *before* each iteration, including iteration 0.
 * So a headless run that starts already in the target state terminates at once
 * with `totalTicks: 0`.
 *
 * Run mode (`options.mode`):
 *
 * - `'uniform'` (default) — the fixed-tick loop above. Content-blind.
 * - `'next-event'` — walker-visible event stepping with fast-tick fallbacks.
 *   Requires `options.accessor`, and takes no analyzers. `options.bisectTolSec`
 *   can resolve the predicate's fire time within an advance.
 * - `'stasis-aware'` — the fixed-tick loop with a stasis check each iteration.
 *   When the walker reports no finite or opaque-predicate transition, it
 *   terminates with `terminated: 'unreachable'`. Requires `options.accessor`.
 *
 * {@link runMatrixUntil} is the `cells × seeds` counterpart.
 *
 * @cluster runners
 */

import { seedRNG } from '@/primitives/rng';
import { createTransitionSnapshot } from './walker';
import { runNextEventLoop, isStasis } from './run-until-helpers/next-event-mode';
import { floorSteps } from './sim-time';
import type { RunUntilOptions, RunUntilResult } from './types';

/**
 * Drive `options.engine` via `engine.tickDriver.advanceTime(tickDelta)` until
 * `options.until` returns `true` or `options.maxSimTime` sim-seconds have
 * elapsed, whichever comes first. Returns the iteration count, elapsed sim-time,
 * termination reason, and analyzer summaries.
 *
 * @param options - {@link RunUntilOptions} — engine, predicate, sim-time
 *   cap, optional tickDelta/setup/seed, optional mode + accessor.
 * @returns {@link RunUntilResult} — superset of `HeadlessResult` with a
 *   `terminated: 'predicate' | 'maxSimTime' | 'unreachable'` field.
 *
 * @example
 * ```ts
 * const { engine, gold } = buildGame(); // your builder: the engine and a Resource it drives
 * engine.start();
 * try {
 *   const result = runUntil({
 *     engine,
 *     until: () => Decimal.gte(gold.value, 1000),
 *     maxSimTime: 600,
 *     seed: 1,
 *   });
 *   // 'predicate' once gold reaches 1000, 'maxSimTime' if ten minutes run out first
 *   console.log(result.terminated, result.elapsedSimulated);
 * } finally {
 *   engine.stop();
 * }
 * ```
 */
export function runUntil(options: RunUntilOptions): RunUntilResult {
  const { engine, until, maxSimTime } = options;
  const tickDelta = options.tickDelta ?? 0.05;
  const mode = options.mode ?? 'uniform';
  if (mode !== 'uniform' && !options.accessor) {
    throw new Error(`runUntil: mode "${mode}" requires options.accessor`);
  }
  if (mode === 'next-event' && options.bisectTolSec !== undefined && !engine.saveManager) {
    throw new Error(
      'runUntil: bisectTolSec restores save checkpoints and requires an engine with a saveManager (persistence enabled)',
    );
  }
  if (options.seed !== undefined) seedRNG(options.seed);
  const analyzers = options.setup?.() ?? [];
  if (mode === 'next-event' && analyzers.length > 0) {
    throw new Error(
      'runUntil: mode "next-event" advances by varying distances and cannot drive the analyzer tick lifecycle — use mode "uniform" for analyzers',
    );
  }

  if (mode === 'next-event') {
    const out = runNextEventLoop(engine, options.accessor!, until, maxSimTime, tickDelta, {
      bisectTolSec: options.bisectTolSec,
      stasisCheckInterval: options.stasisCheckInterval,
    });
    return {
      totalTicks: out.totalTicks,
      elapsedSimulated: out.elapsedSimulated,
      terminated: out.terminated,
      analyzerSummaries: [],
    };
  }

  for (const a of analyzers) a.onStart?.();
  const maxTicks = floorSteps(maxSimTime, tickDelta);
  let tick = 0;
  let terminated: 'predicate' | 'maxSimTime' | 'unreachable' = 'maxSimTime';
  const accessor = options.accessor;

  while (tick <= maxTicks) {
    if (until({ iteration: tick, simTime: tick * tickDelta })) {
      terminated = 'predicate';
      break;
    }
    if (mode === 'stasis-aware') {
      const snapshot = createTransitionSnapshot(engine, accessor!);
      if (isStasis(snapshot)) {
        terminated = 'unreachable';
        break;
      }
    }
    if (tick === maxTicks) break;
    engine.tickDriver.advanceTime(tickDelta);
    tick++;
    for (const a of analyzers) a.onTick?.(tick - 1);
  }
  for (const a of analyzers) a.onEnd?.();

  return {
    totalTicks: tick,
    elapsedSimulated: tick * tickDelta,
    terminated,
    analyzerSummaries: analyzers.map((a) => a.summarize()),
  };
}
