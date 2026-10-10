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
 * 2. {@link resolveNextEvent} picks the smallest finite distance, floored at
 *    `tickDelta` so dense auto-purchase cadence can't collapse the advance
 *    into a per-step snapshot-rebuild cliff, and capped at the remaining
 *    budget so no advance crosses `maxSimTime`. A distance beyond the
 *    driver's `maxDeltaTime` is simulated in full, as several engine ticks.
 * 3. Refuse handling splits by reason:
 *    - `'opaque-present'` — fall back to a `tickDelta` step. Opaque
 *      transitions could flip after a tick, so we tick and re-resolve.
 *    - `'no-finite-transition'` — enter fast-tick stasis mode. Non-walker
 *      sources (clicks, `ctx.onTick` subscribers, `TimedInput`) may still
 *      push state forward. Fast-tick at `tickDelta` without rebuilding the
 *      walker each iteration, checking the predicate per tick; every
 *      `stasisProbeInterval` ticks, rebuild once to detect exit-from-stasis.
 *      When the fast-tick loop exhausts `maxSimTime` without exit, the run
 *      terminates `'unreachable'` if the walker's tracked dependencies held
 *      still throughout, and `'maxSimTime'` if something it can't see moved
 *      them.
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
import { Decimal } from '@/primitives/decimal';
import { ResourceRegistryKey, type ResourceRegistry } from '@/core/registries';

/** @internal */
export type NextEvent =
  | { dt: number; fired: Transition[] }
  | { reason: 'no-finite-transition' }
  | { reason: 'opaque-present' };

/**
 * How far to advance: the smallest finite transition distance in `snapshot`,
 * never past `remaining` sim-seconds, or a refusal if the snapshot cannot be
 * mechanically resolved. Touches no engine; the caller simulates `dt`.
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
 * raw distance pays a full incremental-snapshot rebuild per micro-step — the
 * performance cliff this floor exists to avoid. Flooring makes event mode
 * asymptotically never worse than tick mode; `fired` still reports only the
 * transitions tied at the raw head distance; the caller's bisection
 * (triggered whenever `dt > bisectTolSec`) covers the case where the floor
 * overshoots the walker-reported fire time. The `remaining` cap applies after the floor, so
 * an advance cut short by the budget leaves `fired` unfired.
 *
 * @internal
 */
export function resolveNextEvent(
  snapshot: TransitionSnapshot,
  tickDelta: number,
  remaining: number,
): NextEvent {
  for (const t of snapshot.all) {
    if (t.distance.reason === 'opaque-predicate') {
      return { reason: 'opaque-present' };
    }
  }

  const head = snapshot.all[0];
  if (!head || head.distance.seconds === null) {
    return { reason: 'no-finite-transition' };
  }

  const rawDt = head.distance.seconds;
  const dt = Math.min(Math.max(rawDt, tickDelta), remaining);
  const fired: Transition[] = [];
  for (const t of snapshot.all) {
    if (t.distance.seconds === rawDt) fired.push(t);
    else break;
  }
  return { dt, fired };
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
 * @param engine - Engine to drive. Caller seeds RNG before this call, and
 *   supplies a `saveManager` whenever `options.bisectTolSec` is set.
 * @param accessor - Read-side accessor matching the engine; used by the
 *   incremental snapshot.
 * @param predicate - Termination predicate. Closes over the engine; returning
 *   `true` ends the run with `terminated: 'predicate'`.
 * @param maxSimTime - Sim-seconds ceiling.
 * @param tickDelta - Advance floor, and the fixed-tick delta of the stasis
 *   fast-tick and of opaque-present refuses.
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
  const registry = engine.tryInject(ResourceRegistryKey);
  const sample = (): DepSnapshot => sampleDeps(inc, accessor, registry);

  let simTime = 0;
  let steps = 0;
  let terminated: 'predicate' | 'maxSimTime' | 'unreachable' = 'maxSimTime';

  // Sample the tracked dep slice before each engine advance; compare to the
  // post-advance sample to drive selective invalidation. `before` is seeded
  // after the initial full rebuild — construction is a full walk, so
  // `inc.trackedResources` etc. are populated at this point.
  let before = sample();

  while (true) {
    if (predicate({ tick: steps, simTime })) {
      terminated = 'predicate';
      break;
    }
    if (simTime >= maxSimTime) break;

    const snapshot = inc.rebuild();
    const result = resolveNextEvent(snapshot, tickDelta, maxSimTime - simTime);

    if ('fired' in result) {
      // Only an advance bisection could narrow needs the pre-advance state.
      const checkpoint =
        bisectTolSec !== undefined && result.dt > bisectTolSec
          ? { blob: engine.saveManager!.exportSave(), rng: getRNGState() }
          : null;
      const advanceStart = profileStart();
      engine.tickDriver.simulateTick(result.dt);
      profileEnd('runUntil.event.advance', advanceStart);
      if (checkpoint !== null && predicate({ tick: steps, simTime: simTime + result.dt })) {
        // Predicate flipped during this advance. Restore + replay sub-intervals
        // to narrow the fire time to within `bisectTolSec`; otherwise the
        // top-of-loop check on the next iteration would record
        // `simTime + result.advanced` as the fire time.
        const fireDt = bisectTerminationTime(
          engine,
          predicate,
          checkpoint,
          result.dt,
          bisectTolSec!,
          simTime,
          steps,
        );
        simTime += fireDt;
        terminated = 'predicate';
        break;
      }
      simTime += result.dt;
      before = commitDeps(inc, sample, before);
    } else if (result.reason === 'no-finite-transition') {
      // Walker sees nothing advancing. Tick at `tickDelta` without rebuilding
      // the walker until state flips, the predicate fires, or budget runs out.
      const windowStart = sample();
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
      before = sample();
      if (outcome.exit === 'predicate') {
        terminated = 'predicate';
        break;
      }
      if (outcome.exit === 'maxSimTime') {
        // Budget ran out in stasis. Only a window in which nothing the walker
        // tracks moved shows the wedge held; if a source it can't see moved
        // state, a longer budget might still fire, so it's a plain miss.
        terminated = depsChanged(windowStart, before) ? 'maxSimTime' : 'unreachable';
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
      before = commitDeps(inc, sample, before);
    }
    steps++;
  }

  return {
    totalTicks: steps,
    elapsedSimulated: Math.min(simTime, maxSimTime),
    terminated,
  };
}

/**
 * One sample of the slots the walker tracks. A tracked resource also carries
 * its lifetime total and a tracked rate its inflow, where either is served:
 * a `cumulative-gte` distance reads both, and a drain matching the inflow
 * holds the balance and net rate still while the total climbs.
 */
interface DepSnapshot {
  resources: Map<string, Decimal>;
  totals: Map<string, Decimal>;
  rates: Map<string, Decimal>;
  inflows: Map<string, Decimal>;
  flags: Map<string, boolean>;
  states: Map<string, unknown>;
}

function sampleDeps(
  inc: IncrementalSnapshot,
  accessor: GameStateAccessor,
  registry: ResourceRegistry | undefined,
): DepSnapshot {
  const resources = new Map<string, Decimal>();
  const totals = new Map<string, Decimal>();
  const rates = new Map<string, Decimal>();
  const inflows = new Map<string, Decimal>();
  const flags = new Map<string, boolean>();
  const states = new Map<string, unknown>();
  for (const id of inc.trackedResources) {
    resources.set(id, accessor.getAmount(id));
    const total = registry?.findById(id)?.cumulative;
    if (total) totals.set(id, new Decimal(total.value));
  }
  for (const id of inc.trackedRates) {
    rates.set(id, accessor.getRate(id));
    if (accessor.getInflowRate) inflows.set(id, accessor.getInflowRate(id));
  }
  for (const id of inc.trackedFlags) flags.set(id, accessor.getFlag(id));
  for (const path of inc.trackedStates) states.set(path, accessor.getStateAt(path));
  return { resources, totals, rates, inflows, flags, states };
}

function forEachChangedDep(
  before: DepSnapshot,
  after: DepSnapshot,
  visit: (kind: 'resources' | 'rates' | 'flags' | 'states', key: string) => void,
): void {
  const visitMoved = (
    kind: 'resources' | 'rates',
    beforeMap: Map<string, Decimal>,
    afterMap: Map<string, Decimal>,
  ): void => {
    for (const [id, afterVal] of afterMap) {
      const beforeVal = beforeMap.get(id);
      if (beforeVal === undefined || !beforeVal.eq(afterVal)) visit(kind, id);
    }
  };
  visitMoved('resources', before.resources, after.resources);
  visitMoved('resources', before.totals, after.totals);
  visitMoved('rates', before.rates, after.rates);
  visitMoved('rates', before.inflows, after.inflows);
  for (const [id, afterVal] of after.flags) {
    if (before.flags.get(id) !== afterVal) visit('flags', id);
  }
  for (const [path, afterVal] of after.states) {
    if (!Object.is(before.states.get(path), afterVal)) visit('states', path);
  }
}

function diffInto(inc: IncrementalSnapshot, before: DepSnapshot, after: DepSnapshot): void {
  forEachChangedDep(before, after, (kind, key) => {
    if (kind === 'resources') inc.invalidateResource(key);
    else if (kind === 'rates') inc.invalidateRate(key);
    else if (kind === 'flags') inc.invalidateFlag(key);
    else inc.invalidateState(key);
  });
}

function depsChanged(before: DepSnapshot, after: DepSnapshot): boolean {
  let changed = false;
  forEachChangedDep(before, after, () => {
    changed = true;
  });
  return changed;
}

/**
 * Diff the tracked slice against `before` to invalidate what moved, and return
 * the fresh sample as the next baseline. Diffing without re-baselining would
 * re-invalidate the same deps on every later advance, so the two travel
 * together.
 */
function commitDeps(
  inc: IncrementalSnapshot,
  sample: () => DepSnapshot,
  before: DepSnapshot,
): DepSnapshot {
  const after = sample();
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
      if (!isStasis(snapshot)) {
        return { simTime, ticks, exit: 'resume' };
      }
    }
  }

  return { simTime, ticks, exit: 'maxSimTime' };
}

function bisectTerminationTime(
  engine: Engine,
  predicate: UntilPredicate,
  checkpoint: { blob: string; rng: RNGState },
  advanceDt: number,
  tolSec: number,
  baseSimTime: number,
  baseSteps: number,
): number {
  const restore = (): void => {
    if (!engine.saveManager!.importSave(checkpoint.blob).success) {
      throw new Error(
        'runUntil: bisectTolSec could not restore the pre-advance checkpoint (importSave failed)',
      );
    }
    setRNGState(checkpoint.rng);
  };
  let low = 0;
  let high = advanceDt;
  while (high - low > tolSec) {
    const mid = (low + high) / 2;
    restore();
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
  restore();
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
