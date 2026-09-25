/**
 * Predicate-bounded sim runner — engine-aware counterpart to `runHeadless`.
 *
 * `runHeadless` takes a tick callback and a fixed tick budget. `runUntil`
 * takes an `Engine` and a predicate, driving the engine via
 * `engine.tickDriver.simulateTick(tickDelta)` until the predicate fires or
 * `maxSimTime` is reached. Headless beat-timing tests (archetype sim
 * suites) are the canonical consumer — they want "how long does it take
 * for state X to hold?" rather than "what does state look like after N
 * ticks?".
 *
 * tickDelta is caller-authoritative: each iteration advances the engine by
 * exactly `tickDelta` seconds via `simulateTick`, which respects fixed-mode
 * accumulator semantics for source-faithful ports. A `tickDelta` above the
 * driver's `maxDeltaTime` is split into equal calls under the cap rather
 * than clamped, so reported sim-time is always simulated sim-time. This
 * decouples the harness from the engine's live `tickRate` — coarsening
 * tickDelta at the harness level is a real speedup, not a reporting phantom,
 * up to the cap. (`stepOnce()` exists for deterministic-replay paths that
 * want the engine's own stepSize regardless of caller dt; `runUntil`
 * deliberately does not call it.)
 *
 * The predicate receives an {@link UntilContext} snapshot (`tick`,
 * `simTime`) and reads game state via closure over the caller's engine.
 * Predicate is evaluated *before* each tick, including the zero-tick case,
 * so a run that starts already in the target state terminates immediately
 * with `totalTicks: 0`.
 *
 * Run mode (`config.mode`):
 *
 * - `'tick'` (default) — fixed-tick loop above. Content-blind.
 * - `'event'` — walker-visible event-stepping with fast-tick fallbacks.
 *   Requires `config.accessor`, and takes no analyzers. Predicate fire-time
 *   can be resolved within an advance via `config.bisectTolSec`.
 * - `'stasis-aware-tick'` — fixed-tick loop with a per-tick stasis check.
 *   When the walker reports no finite or opaque-predicate transition,
 *   terminates with `terminated: 'unreachable'`. Requires `config.accessor`.
 *
 * {@link runMatrixUntil} is the `cells × seeds` counterpart.
 *
 * @cluster runners
 */

import { seedRNG } from '@/primitives/rng';
import { createTransitionSnapshot } from './walker';
import { runEventModeLoop, isStasis } from './run-until-helpers/event-mode';
import { floorSteps, simulateSpan } from './sim-time';
import type { RunUntilConfig, RunUntilResult } from './types';

/**
 * Drive `config.engine` via `engine.tickDriver.simulateTick(tickDelta)` until
 * `config.until` returns `true` or `config.maxSimTime` sim-seconds have
 * elapsed, whichever comes first. Returns the tick count, elapsed sim-time,
 * termination reason, and analyzer results.
 *
 * @param config - {@link RunUntilConfig} — engine, predicate, max sim-time
 *   ceiling, optional tickDelta/setup/seed, optional mode + accessor.
 * @returns {@link RunUntilResult} — superset of `HeadlessResult` with a
 *   `terminated: 'predicate' | 'maxSimTime' | 'unreachable'` field.
 *
 * @example
 * ```ts
 * const engine = buildDirectorEngine(vars);
 * engine.start();
 * const result = runUntil({
 *   engine,
 *   until: ({ simTime }) => engine.state.roundCount >= 1 || simTime > minutes(10),
 *   maxSimTime: minutes(10),
 * });
 * expect(result.terminated).toBe('predicate');
 * expect(result.elapsedSimulated).toBeLessThan(minutes(5));
 * ```
 */
export function runUntil(config: RunUntilConfig): RunUntilResult {
  const { engine, until, maxSimTime } = config;
  const tickDelta = config.tickDelta ?? 0.05;
  const mode = config.mode ?? 'tick';
  if (mode !== 'tick' && !config.accessor) {
    throw new Error(`runUntil: mode "${mode}" requires config.accessor`);
  }
  if (mode === 'event' && config.bisectTolSec !== undefined && !engine.saveManager) {
    throw new Error(
      'runUntil: bisectTolSec restores save checkpoints and requires an engine with a saveManager (persistence enabled)',
    );
  }
  if (config.seed !== undefined) seedRNG(config.seed);
  const analyzers = config.setup?.() ?? [];
  if (mode === 'event' && analyzers.length > 0) {
    throw new Error(
      'runUntil: mode "event" steps variable distances and cannot drive the analyzer tick lifecycle — use mode "tick" for analyzers',
    );
  }

  if (mode === 'event') {
    const out = runEventModeLoop(engine, config.accessor!, until, maxSimTime, tickDelta, {
      bisectTolSec: config.bisectTolSec,
      stasisProbeInterval: config.stasisProbeInterval,
    });
    return {
      totalTicks: out.totalTicks,
      elapsedSimulated: out.elapsedSimulated,
      terminated: out.terminated,
      analyzerResults: [],
    };
  }

  for (const a of analyzers) a.onStart?.();
  const maxTicks = floorSteps(maxSimTime, tickDelta);
  let tick = 0;
  let terminated: 'predicate' | 'maxSimTime' | 'unreachable' = 'maxSimTime';
  const accessor = config.accessor;

  while (tick <= maxTicks) {
    if (until({ tick, simTime: tick * tickDelta })) {
      terminated = 'predicate';
      break;
    }
    if (mode === 'stasis-aware-tick') {
      const snapshot = createTransitionSnapshot(engine, accessor!);
      if (isStasis(snapshot)) {
        terminated = 'unreachable';
        break;
      }
    }
    if (tick === maxTicks) break;
    simulateSpan(engine.tickDriver, tickDelta);
    tick++;
    for (const a of analyzers) a.onTick?.(tick - 1);
  }
  for (const a of analyzers) a.onEnd?.();

  return {
    totalTicks: tick,
    elapsedSimulated: tick * tickDelta,
    terminated,
    analyzerResults: analyzers.map((a) => a.summarize()),
  };
}
