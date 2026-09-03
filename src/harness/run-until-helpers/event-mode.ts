/**
 * Event-mode inner loop for {@link runUntil} — walker-visible event stepping.
 *
 * Attacks the never-fires cost where rate is live but insufficient to fire
 * within budget. Tick-count-reduction approaches cannot attack this leg because
 * the walker sees a nonzero rate every tick and refuses to short-circuit;
 * event-stepping advances directly to the next state change instead.
 *
 * Composition:
 *
 * 1. {@link createIncrementalSnapshot} each iteration — finite-distance head is
 *    the next walker-visible event.
 * 2. {@link advanceToNextEvent} drives `engine.tickDriver.simulateTick(dt)` with
 *    `dt = smallest finite distance`, floored at `tickDelta` so dense
 *    auto-purchase cadence can't collapse the advance into a per-step
 *    snapshot-rebuild cliff. The engine must be built with `maxDeltaTime`
 *    raised to cover the largest expected advance — otherwise `simulateTick`
 *    clamps and the loop degrades toward fixed-tick.
 * 3. Refuse handling splits by reason:
 *    - `'opaque-present'` — fall back to `simulateTick(tickDelta)`. Opaque
 *      transitions could flip after a tick, so we tick and re-resolve.
 *    - `'no-finite-transition'` — enter fast-tick stasis mode. Non-walker
 *      sources (clicks, `ctx.onTick` subscribers, `TimedInput`) may still
 *      push state forward. Fast-tick at `tickDelta` without rebuilding the
 *      walker each iteration, checking the predicate per tick; every
 *      `stasisProbeInterval` ticks, rebuild once to detect exit-from-stasis.
 *      When the fast-tick loop exhausts `maxSimTime` without exit, the run
 *      terminates with `terminated: 'unreachable'`.
 *    - zero-distance tie (`{ advanced: 0, fired: [...] }`) — enter tie
 *      fast-tick mode. Walker surfaces a finite transition at distance=0 but
 *      the probe cannot execute it (no auto-purchase or equivalent module
 *      registered). Structurally symmetric to stasis fast-tick.
 * 4. Predicate re-checked at the top of each iteration; termination as soon
 *    as it fires. Optional sub-advance bisection via `bisectTolSec`.
 *
 * @internal
 */

import type { Engine } from '@/engine';
import type { GameStateAccessor } from '@/primitives/types';
import { profile, profileStart, profileEnd } from '@/core/profiler';
import { getRNGState, setRNGState, type RNGState } from '@/primitives/rng';
import type { UntilPredicate } from '../types';
import {
  createTransitionSnapshot,
  createIncrementalSnapshot,
  type IncrementalSnapshot,
  type Transition,
  type TransitionSnapshot,
} from '../walker';
import type { Decimal } from '@/primitives/decimal';

/** @internal */
export type AdvanceToNextEventResult =
  | { advanced: number; fired: Transition[] }
  | { advanced: 0; reason: 'no-finite-transition' }
  | { advanced: 0; reason: 'opaque-present' };

/**
 * Advance `engine` by the smallest finite transition distance in `snapshot`,
 * or refuse if the snapshot cannot be mechanically resolved.
 *
 * Refuse reasons:
 *
 * - `'opaque-present'` — at least one transition has `distance.reason ===
 *   'opaque-predicate'`. Refuses even when a finite head exists, because an
 *   opaque transition could flip before the finite head fires and we cannot
 *   rule that out from the snapshot alone. Conservative by construction.
 * - `'no-finite-transition'` — no transition in `snapshot.all` has finite
 *   `distance.seconds`. Pure stasis, empty snapshot, or all distances
 *   uncomputable / no-rate.
 *
 * The realized advance is floored at `tickDelta`: dense auto-purchase cadence
 * can collapse the head distance to a few milliseconds, and stepping by that
 * raw distance pays a full incremental-snapshot rebuild (plus checkpoint
 * export under `bisectTolSec`) per micro-step — the performance cliff this
 * floor exists to avoid. Flooring makes event mode asymptotically never worse than
 * tick mode; `fired` still reports only the transitions tied at the raw head
 * distance; the caller's existing bisection (triggered whenever
 * `advanced > bisectTolSec`) covers the case where the floor overshoots the
 * walker-reported fire time.
 *
 * @internal
 */
export function advanceToNextEvent(
  engine: Engine,
  snapshot: TransitionSnapshot,
  tickDelta: number,
): AdvanceToNextEventResult {
  for (const t of snapshot.all) {
    if (t.distance.reason === 'opaque-predicate') {
      return { advanced: 0, reason: 'opaque-present' };
    }
  }

  const head = snapshot.all[0];
  if (!head || head.distance.seconds === null) {
    return { advanced: 0, reason: 'no-finite-transition' };
  }

  const rawDt = head.distance.seconds;
  const dt = Math.max(rawDt, tickDelta);
  const fired: Transition[] = [];
  for (const t of snapshot.all) {
    if (t.distance.seconds === rawDt) fired.push(t);
    else break;
  }

  engine.tickDriver.simulateTick(dt);
  return { advanced: dt, fired };
}

/** @internal */
export interface EventModeOptions {
  bisectTolSec?: number;
  stasisProbeInterval?: number;
}

/** @internal */
export interface EventModeResult {
  totalTicks: number;
  elapsedSimulated: number;
  terminated: 'predicate' | 'maxSimTime' | 'unreachable';
}

/**
 * Drive a freshly-built (and pre-seeded) engine through the event-stepping
 * loop until `predicate(engine)` fires, `maxSimTime` is reached, or the
 * walker confirms stasis cannot be mechanically broken.
 *
 * @param engine - Engine to drive. Caller seeds RNG before this call.
 * @param accessor - Read-side accessor matching the engine; used by the
 *   incremental snapshot.
 * @param predicate - Termination predicate. Closes over the engine; returning
 *   `true` ends the run with `terminated: 'predicate'`.
 * @param maxSimTime - Sim-seconds ceiling.
 * @param tickDelta - Fixed-tick fallback delta (used inside fast-tick stasis
 *   and tie loops, and on opaque-present refuses).
 * @param options - {@link EventModeOptions} — bisect tolerance and stasis
 *   probe interval.
 *
 * @internal
 */
export function runEventModeLoop(
  engine: Engine,
  accessor: GameStateAccessor,
  predicate: UntilPredicate,
  maxSimTime: number,
  tickDelta: number,
  options: EventModeOptions,
): EventModeResult {
  const stasisProbeInterval = options.stasisProbeInterval ?? 100;
  const bisectTolSec = options.bisectTolSec;
  const inc = createIncrementalSnapshot(engine, accessor);

  let simTime = 0;
  let steps = 0;
  let terminated: 'predicate' | 'maxSimTime' | 'unreachable' = 'maxSimTime';

  // Sample the tracked dep slice before each engine advance; compare to the
  // post-advance sample to drive selective invalidation. `before` is seeded
  // after the initial full rebuild — construction is a full walk, so
  // `inc.trackedResources` etc. are populated at this point.
  let before = sampleDeps(inc, accessor);

  while (true) {
    if (predicate({ tick: steps, simTime })) {
      terminated = 'predicate';
      break;
    }
    if (simTime >= maxSimTime) break;

    const snapshot = inc.rebuild();
    const checkpoint =
      bisectTolSec !== undefined && engine.saveManager
        ? { blob: engine.saveManager.exportSave(), rng: getRNGState() }
        : null;
    const advanceStart = profileStart();
    const result = advanceToNextEvent(engine, snapshot, tickDelta);
    profileEnd('runUntil.event.advance', advanceStart);

    if ('fired' in result && result.advanced > 0) {
      if (
        checkpoint !== null &&
        result.advanced > bisectTolSec! &&
        predicate({ tick: steps, simTime: simTime + result.advanced })
      ) {
        // Predicate flipped during this advance. Restore + replay sub-intervals
        // to narrow the fire time to within `bisectTolSec`; otherwise the
        // top-of-loop check on the next iteration would record
        // `simTime + result.advanced` as the fire time.
        const fireDt = bisectFireTime(
          engine,
          predicate,
          checkpoint,
          result.advanced,
          bisectTolSec!,
          simTime,
          steps,
        );
        simTime += fireDt;
        terminated = 'predicate';
        break;
      }
      simTime += result.advanced;
      before = commitDeps(inc, accessor, before);
    } else if ('fired' in result) {
      // Zero-distance tie: walker surfaces a finite transition at distance=0
      // but the probe cannot execute it (no auto-purchase module registered).
      // Fast-tick at `tickDelta` while the tied set stays shape-stable; exit
      // when it changes, the predicate fires, or budget runs out.
      const outcome = profile('runUntil.event.tieFastTick', () =>
        fastTickDuringTie(
          engine,
          accessor,
          predicate,
          simTime,
          steps,
          maxSimTime,
          tickDelta,
          result.fired,
          stasisProbeInterval,
        ),
      );
      simTime = outcome.simTime;
      steps += outcome.ticks;
      inc.invalidateAll();
      before = sampleDeps(inc, accessor);
      if (outcome.exit === 'predicate') {
        terminated = 'predicate';
        break;
      }
      if (outcome.exit === 'maxSimTime') break;
      // outcome.exit === 'resume' — fall through to the next iteration.
    } else if (result.reason === 'no-finite-transition') {
      // Walker sees nothing advancing. Tick at `tickDelta` without rebuilding
      // the walker until state flips, the predicate fires, or budget runs out.
      const outcome = profile('runUntil.event.stasisFastTick', () =>
        fastTickDuringStasis(
          engine,
          accessor,
          predicate,
          simTime,
          steps,
          maxSimTime,
          tickDelta,
          stasisProbeInterval,
        ),
      );
      simTime = outcome.simTime;
      steps += outcome.ticks;
      inc.invalidateAll();
      before = sampleDeps(inc, accessor);
      if (outcome.exit === 'predicate') {
        terminated = 'predicate';
        break;
      }
      if (outcome.exit === 'maxSimTime') {
        // Stasis confirmed for the remainder of the budget — non-walker sources
        // never broke the wedge. Classify as unreachable rather than
        // maxSimTime so consumers can distinguish "ran out of time" from
        // "could not have fired."
        terminated = 'unreachable';
        break;
      }
      // outcome.exit === 'resume' — fall through.
    } else {
      // Opaque-present refuse. Opaque transitions can flip after a tick, so
      // we tick-and-retry rather than short-circuit.
      const remaining = maxSimTime - simTime;
      const dt = Math.min(tickDelta, remaining);
      if (dt <= 0) break;
      const opaqueStart = profileStart();
      engine.tickDriver.simulateTick(dt);
      profileEnd('runUntil.event.opaqueTick', opaqueStart);
      simTime += dt;
      before = commitDeps(inc, accessor, before);
    }
    steps++;
  }

  return {
    totalTicks: steps,
    elapsedSimulated: Math.min(simTime, maxSimTime),
    terminated,
  };
}

interface DepSnapshot {
  resources: Map<string, Decimal>;
  rates: Map<string, Decimal>;
  unlocks: Map<string, boolean>;
  states: Map<string, unknown>;
}

function sampleDeps(inc: IncrementalSnapshot, accessor: GameStateAccessor): DepSnapshot {
  const resources = new Map<string, Decimal>();
  const rates = new Map<string, Decimal>();
  const unlocks = new Map<string, boolean>();
  const states = new Map<string, unknown>();
  for (const id of inc.trackedResources) resources.set(id, accessor.getResource(id));
  for (const id of inc.trackedRates) rates.set(id, accessor.getRate(id));
  for (const id of inc.trackedUnlocks) unlocks.set(id, accessor.isUnlocked(id));
  for (const path of inc.trackedStates) states.set(path, accessor.getState(path));
  return { resources, rates, unlocks, states };
}

function diffInto(inc: IncrementalSnapshot, before: DepSnapshot, after: DepSnapshot): void {
  for (const [id, afterVal] of after.resources) {
    const beforeVal = before.resources.get(id);
    if (beforeVal === undefined || !beforeVal.eq(afterVal)) {
      inc.invalidateResource(id);
    }
  }
  for (const [id, afterVal] of after.rates) {
    const beforeVal = before.rates.get(id);
    if (beforeVal === undefined || !beforeVal.eq(afterVal)) {
      inc.invalidateRate(id);
    }
  }
  for (const [id, afterVal] of after.unlocks) {
    if (before.unlocks.get(id) !== afterVal) inc.invalidateUnlock(id);
  }
  for (const [path, afterVal] of after.states) {
    if (!Object.is(before.states.get(path), afterVal)) inc.invalidateState(path);
  }
}

/**
 * Diff the tracked slice against `before` to invalidate what moved, and return
 * the fresh sample as the next baseline. Diffing without re-baselining would
 * re-invalidate the same deps on every later advance, so the two travel
 * together.
 */
function commitDeps(
  inc: IncrementalSnapshot,
  accessor: GameStateAccessor,
  before: DepSnapshot,
): DepSnapshot {
  const after = sampleDeps(inc, accessor);
  diffInto(inc, before, after);
  return after;
}

interface FastTickOutcome {
  simTime: number;
  ticks: number;
  exit: 'predicate' | 'maxSimTime' | 'resume';
}

function fastTickDuringStasis(
  engine: Engine,
  accessor: GameStateAccessor,
  predicate: UntilPredicate,
  startSimTime: number,
  startSteps: number,
  maxSimTime: number,
  tickDelta: number,
  stasisProbeInterval: number,
): FastTickOutcome {
  let simTime = startSimTime;
  let ticks = 0;

  while (simTime < maxSimTime) {
    const remaining = maxSimTime - simTime;
    const dt = Math.min(tickDelta, remaining);
    if (dt <= 0) break;
    engine.tickDriver.simulateTick(dt);
    simTime += dt;
    ticks++;

    // `startSteps + ticks` keeps ctx.tick run-absolute — consistent with the
    // main loop's `steps`, not a per-entry local counter restarting at 1.
    if (predicate({ tick: startSteps + ticks, simTime })) {
      return { simTime, ticks, exit: 'predicate' };
    }
    if (ticks % stasisProbeInterval === 0) {
      const snapshot = createTransitionSnapshot(engine, accessor);
      if (!isNoFiniteTransition(snapshot)) {
        return { simTime, ticks, exit: 'resume' };
      }
    }
  }

  return { simTime, ticks, exit: 'maxSimTime' };
}

function fastTickDuringTie(
  engine: Engine,
  accessor: GameStateAccessor,
  predicate: UntilPredicate,
  startSimTime: number,
  startSteps: number,
  maxSimTime: number,
  tickDelta: number,
  initialFired: readonly Transition[],
  stasisProbeInterval: number,
): FastTickOutcome {
  const initialKey = tieSetKey(initialFired);
  let simTime = startSimTime;
  let ticks = 0;

  while (simTime < maxSimTime) {
    const remaining = maxSimTime - simTime;
    const dt = Math.min(tickDelta, remaining);
    if (dt <= 0) break;
    engine.tickDriver.simulateTick(dt);
    simTime += dt;
    ticks++;

    // `startSteps + ticks` keeps ctx.tick run-absolute — consistent with the
    // main loop's `steps`, not a per-entry local counter restarting at 1.
    if (predicate({ tick: startSteps + ticks, simTime })) {
      return { simTime, ticks, exit: 'predicate' };
    }
    if (ticks % stasisProbeInterval === 0) {
      const snapshot = createTransitionSnapshot(engine, accessor);
      if (snapshotHasOpaque(snapshot) || currentTieKey(snapshot) !== initialKey) {
        return { simTime, ticks, exit: 'resume' };
      }
    }
  }

  return { simTime, ticks, exit: 'maxSimTime' };
}

function isNoFiniteTransition(snapshot: TransitionSnapshot): boolean {
  for (const t of snapshot.all) {
    if (t.distance.reason === 'opaque-predicate') return false;
    if (t.distance.seconds !== null) return false;
  }
  return true;
}

function tieSetKey(transitions: readonly Transition[]): string {
  const parts: string[] = [];
  for (const t of transitions) {
    parts.push(`${t.source}|${t.categoryId}|${t.entityId}|${t.kind}`);
  }
  parts.sort();
  return parts.join(',');
}

function currentTieKey(snapshot: TransitionSnapshot): string {
  const parts: string[] = [];
  for (const t of snapshot.all) {
    if (t.distance.seconds === 0) {
      parts.push(`${t.source}|${t.categoryId}|${t.entityId}|${t.kind}`);
    }
  }
  parts.sort();
  return parts.join(',');
}

function snapshotHasOpaque(snapshot: TransitionSnapshot): boolean {
  for (const t of snapshot.all) {
    if (t.distance.reason === 'opaque-predicate') return true;
  }
  return false;
}

function bisectFireTime(
  engine: Engine,
  predicate: UntilPredicate,
  checkpoint: { blob: string; rng: RNGState },
  advanceDt: number,
  tolSec: number,
  baseSimTime: number,
  baseSteps: number,
): number {
  let low = 0;
  let high = advanceDt;
  while (high - low > tolSec) {
    const mid = (low + high) / 2;
    engine.saveManager!.importSave(checkpoint.blob);
    setRNGState(checkpoint.rng);
    engine.tickDriver.simulateTick(mid);
    // `mid` is relative to the checkpoint (the advance's start); the predicate
    // reads run-absolute `simTime`, so feed it `baseSimTime + mid`. Passing the
    // raw `mid` here silently defeats bisection for any simTime-reading
    // predicate — the exact idiom in runUntil's @example.
    if (predicate({ tick: baseSteps, simTime: baseSimTime + mid })) high = mid;
    else low = mid;
  }
  // Leave the engine at the smallest dt for which the predicate is true so
  // the run ends in the fired state rather than a bisect intermediate.
  engine.saveManager!.importSave(checkpoint.blob);
  setRNGState(checkpoint.rng);
  engine.tickDriver.simulateTick(high);
  return high;
}

/**
 * True when the snapshot is in a state that mechanically cannot produce a
 * predicate-firing transition — no opaque-predicates, no finite distances.
 * Used by `'stasis-aware-tick'` mode in `runUntil` to short-circuit unreachable
 * runs. Conservative: any opaque-predicate distance aborts the classification
 * (false-negatives preferred over false-positives).
 *
 * @internal
 */
export function isStasis(snapshot: TransitionSnapshot): boolean {
  for (const t of snapshot.all) {
    if (t.distance.reason === 'opaque-predicate') return false;
    if (t.distance.seconds !== null) return false;
  }
  return true;
}
