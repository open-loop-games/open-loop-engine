/**
 * TimedProgress — tickable progress toward a needed value, with no state machine.
 *
 * A `{needed, rate, progress, tickProgressDelta}` primitive with no state
 * machine: no active, cancel or cooldown, no start or complete checks, no
 * progressive costs, no chain. On every registered tick it adds `rate * dt` to
 * `progress`. It calls `onProgress(delta)` when the tick advances progress. It
 * calls `onComplete(overflow)` once when progress reaches `needed`, and not
 * again while progress stays there.
 *
 * The tracker never resets on its own, never moves overflow into the next
 * completion, and never stalls or fails. Those are consumer decisions — this
 * is a value that grows over time, nothing more.
 *
 * Built for N parallel passive progressions, where a one-at-a-time state
 * machine (like Sequencer-driven execution) doesn't fit. Example: passive
 * jobs, one tracker per job, ticking beside the action queue.
 */

import { computed, ref, unref, type ComputedRef, type MaybeRef, type Ref } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { toMaybeRef, type Computable } from './computed';
import {
  disownPersistent,
  getCurrentPersistentContext,
  persistent,
  withPersistentContext,
  type Persistent,
} from './persistence';
import { attachPersistentContextReset } from './resettable';
import type { RegisterTick } from './sequencer';

// === TYPES ===
// `RegisterTick` is canonical in `./sequencer`. Re-export here so existing
// `from '@/core/timed-progress'` consumers keep working.
export type { RegisterTick };

/**
 * Options for {@link createTimedProgress}. A saved tracker needs an `id`,
 * unique among the trackers built in the same module: its progress saves
 * under `${module}/${id}`. Only an `ephemeral` tracker may omit it.
 */
export type TimedProgressOptions = TimedProgressBaseOptions &
  (
    | { id: string; ephemeral?: false }
    | {
        id?: string;
        /**
         * `progress` is a plain Vue ref instead of a persistent one: the
         * tracker works the same but never appears in save data — for
         * predictors and headless runs.
         */
        ephemeral: true;
      }
  );

/** Options every {@link createTimedProgress} tracker shares. */
export interface TimedProgressBaseOptions {
  /** Total progress needed before `onComplete` fires. */
  needed: Computable<DecimalSource>;
  /** Progress gained per second (default 1). */
  rate?: Computable<DecimalSource>;
  /** Tick registration function — tracker self-wires its tick. */
  registerTick: RegisterTick;
  /**
   * Called after each tick that advanced progress. `delta` is the full
   * `rate * dt` progress moved this tick. It is never clamped at `needed`, so
   * the deltas of one completion sum to `needed + overflow`, not `needed`.
   */
  onProgress?: (delta: DecimalSource) => void;
  /**
   * Called on the first advancing tick that leaves `progress >= needed` —
   * whether progress crossed the boundary or a shrinking `needed` dropped
   * below it. `overflow` is how far past `needed` progress now stands.
   * Consumers decide what to do next — reset, keep the overflow as progress,
   * leave progress where it is, etc. A tracker at or past `needed` is not
   * called again until progress falls below `needed` and reaches it anew. A
   * `reset()`, kept overflow or a larger `needed` brings it below. Progress a load
   * restores at or past `needed` counts as already complete.
   * The tracker does nothing else on completion.
   */
  onComplete?: (overflow: DecimalSource) => void;
}

/**
 * Ticking progress toward a needed value, created by {@link createTimedProgress}.
 */
export interface TimedProgress {
  id: string;
  /** Progress so far. Saved unless `ephemeral: true`. */
  progress: Ref<DecimalSource>;
  /** The progress one completion needs. */
  needed: MaybeRef<DecimalSource>;
  /** Progress gained per second. */
  rate: MaybeRef<DecimalSource>;
  /**
   * Progress advanced by the most recent tick, held until the next one. Zero
   * after a tick that didn't advance (rate or dt ≤ 0) and after `reset()`.
   */
  readonly tickProgressDelta: Ref<DecimalSource>;
  /** Progress as a fraction [0, 1] of `needed`. */
  percentComplete: ComputedRef<number>;
  /** Estimated seconds remaining at the current rate. */
  timeRemaining: ComputedRef<DecimalSource>;
  /** Clear `progress` back to 0 and zero `tickProgressDelta`. */
  reset(): void;
  /**
   * Unsubscribe from the game loop. The saved `progress` becomes unowned: it
   * keeps saving, and a tracker built with the same id in the same persistent
   * context takes it over and resumes. Call it when the tracker's owner is
   * disposed.
   */
  dispose(): void;
}

// === CONSTANTS ===
let timedProgressIdCounter = 0;

// === PRIVATE BUILDERS ===
interface TimedProgressState {
  progress: Ref<DecimalSource>;
  /** The persistent context holding `progress`; absent when ephemeral. */
  contextId?: string;
}

function buildTimedProgressState(id: string, ephemeral: boolean | undefined): TimedProgressState {
  if (ephemeral) {
    return {
      progress: ref<DecimalSource>(0),
    };
  }
  // Nest this tracker's id under the enclosing persistent context rather than
  // using that context as is: N parallel trackers built inside one module's
  // install() share it, and their 'progress' refs would collide there.
  // Mirrors category-base's `${parent}/${local}` nesting.
  const parent = getCurrentPersistentContext();
  const contextId = parent ? `${parent}/${id}` : id;
  return withPersistentContext(contextId, (): TimedProgressState => ({
    progress: persistent<DecimalSource>(0, { id: 'progress' }),
    contextId,
  }));
}

interface ProcessedTimedProgressOptions {
  needed: MaybeRef<DecimalSource>;
  rate: MaybeRef<DecimalSource>;
}

function buildProcessedOptions(options: TimedProgressOptions): ProcessedTimedProgressOptions {
  return {
    needed: toMaybeRef(options.needed),
    rate: options.rate != null ? toMaybeRef(options.rate) : 1,
  };
}

function buildComputeds(
  state: TimedProgressState,
  processed: ProcessedTimedProgressOptions,
): {
  percentComplete: ComputedRef<number>;
  timeRemaining: ComputedRef<DecimalSource>;
} {
  const percentComplete = computed((): number => {
    const dur = new Decimal(unref(processed.needed));
    if (dur.lte(0)) return 0;
    return new Decimal(state.progress.value).div(dur).clamp(0, 1).toNumber();
  });

  const timeRemaining = computed((): DecimalSource => {
    const dur = new Decimal(unref(processed.needed));
    const remaining = dur.sub(state.progress.value).max(0);
    const spd = new Decimal(unref(processed.rate));
    if (spd.lte(0)) return Decimal.dInf;
    return remaining.div(spd);
  });

  return { percentComplete, timeRemaining };
}

// === PRIVATE TICK ===
/** Ephemeral record of whether the tracker has already completed at its current progress. */
interface CompletionLatch {
  completed: boolean;
  /** The progress this tracker last wrote; any other value was written from outside. */
  lastWritten: DecimalSource | undefined;
}

interface TimedProgressTickContext {
  state: TimedProgressState;
  latch: CompletionLatch;
  tickProgressDelta: Ref<DecimalSource>;
  processed: ProcessedTimedProgressOptions;
  onProgress: TimedProgressOptions['onProgress'];
  onComplete: TimedProgressOptions['onComplete'];
}

function tickTimedProgress(ctx: TimedProgressTickContext, dt: number): void {
  const { state, latch, tickProgressDelta, processed, onProgress, onComplete } = ctx;

  const spd = new Decimal(unref(processed.rate));
  if (spd.lte(0)) {
    tickProgressDelta.value = 0;
    return;
  }

  const prev = new Decimal(state.progress.value);
  const delta = spd.mul(dt);
  if (delta.lte(0)) {
    tickProgressDelta.value = 0;
    return;
  }

  const next = prev.add(delta);
  const dur = new Decimal(unref(processed.needed));

  // Call onComplete once per completion, so a consumer that holds progress
  // past `needed` without resetting isn't called again on every tick. The
  // latch, not a `prev < dur` crossing test, is what stops the repeat call: a
  // `needed` that drops below progress between ticks is never crossed.
  // Progress written from outside (load, reset, kept overflow) re-derives
  // it — a value already at or past `needed` counts as complete.
  if (prev.lt(dur)) latch.completed = false;
  else if (latch.lastWritten === undefined || !prev.eq(latch.lastWritten)) latch.completed = true;

  state.progress.value = next;
  latch.lastWritten = next;
  tickProgressDelta.value = delta;

  onProgress?.(delta);

  if (!latch.completed && next.gte(dur)) {
    latch.completed = true;
    onComplete?.(next.sub(dur));
  }
}

// === FACTORY ===
/**
 * Creates progress that ticks toward a needed value on every registered tick,
 * advancing `progress` by `rate * dt` each time. Use for parallel "many things
 * progressing at once" patterns, where one-at-a-time execution doesn't fit.
 *
 * The tracker has no opinion about what happens on completion — it calls
 * `onComplete(overflow)` once per completion and leaves everything else
 * to the consumer. Reset, keep the overflow, grant rewards, subtract one
 * completion's worth, or do nothing: all are valid.
 *
 * @param options - Options: `needed`, optional `rate`, tick registration,
 *   optional `onProgress` / `onComplete` option callbacks, and optional
 *   `ephemeral` to skip saving.
 * @returns A {@link TimedProgress} with `progress` / `tickProgressDelta` refs,
 *   `percentComplete` / `timeRemaining` computeds, and `reset` / `dispose`.
 *
 * @example
 * ```ts
 * const tracker = createTimedProgress({
 *   id: 'job:mine-ore',
 *   needed: () => def.requiredProgress,
 *   rate: () => skillMultiplier.value,
 *   registerTick: engine.onTick,
 *   onComplete: (overflow) => {
 *     if (!canDeliverRewards()) return; // stall: progress stays at `needed`
 *     grantRewards();
 *     tracker.progress.value = overflow; // keep overflow for the next completion
 *   },
 * });
 * ```
 */
export function createTimedProgress(options: TimedProgressOptions): TimedProgress {
  const actualId = options.id ?? `timedProgress_${++timedProgressIdCounter}`;

  const state = buildTimedProgressState(actualId, options.ephemeral);
  const tickProgressDelta = ref<DecimalSource>(0) as Ref<DecimalSource>;
  const processed = buildProcessedOptions(options);
  const { percentComplete, timeRemaining } = buildComputeds(state, processed);
  const tickCtx: TimedProgressTickContext = {
    state,
    latch: { completed: false, lastWritten: undefined },
    tickProgressDelta,
    processed,
    onProgress: options.onProgress,
    onComplete: options.onComplete,
  };

  const unsubTick = options.registerTick((dt: number) => tickTimedProgress(tickCtx, dt));

  const timedProgress: TimedProgress = {
    id: actualId,
    progress: state.progress,
    needed: processed.needed,
    rate: processed.rate,
    tickProgressDelta,
    percentComplete,
    timeRemaining,
    reset(): void {
      state.progress.value = 0;
      tickProgressDelta.value = 0;
    },
    dispose(): void {
      unsubTick();
      if (state.contextId !== undefined) disownPersistent(state.progress as Persistent);
    },
  };
  return state.contextId === undefined
    ? timedProgress
    : attachPersistentContextReset(timedProgress, state.contextId);
}

// === UTILITIES ===
/**
 * How many whole resource units are paid at a given progress.
 * Formula: ceil(progress / (needed / amount)), clamped to [0, amount].
 * Use for progressive costs, where a resource is paid at discrete thresholds
 * spread evenly across `needed`.
 */
export function resourcePaidAt(
  progress: DecimalSource,
  needed: DecimalSource,
  amount: DecimalSource,
): Decimal {
  if (Decimal.lte(progress, 0)) return Decimal.dZero;
  if (Decimal.gte(progress, needed)) return new Decimal(amount);
  const interval = Decimal.div(needed, amount);
  return Decimal.ceil(Decimal.div(progress, interval));
}

/** The furthest progress at which {@link resourcePaidAt} pays at most `units`. */
function progressForUnits(units: Decimal, duration: DecimalSource, amount: DecimalSource): Decimal {
  // (units * duration) / amount, not units * (duration / amount): the latter
  // rounds the intermediate ratio and ends up further off the threshold.
  let prog = units.mul(duration).div(amount);
  // The product and resourcePaidAt's own `progress / (duration / amount)`
  // round independently, so `prog` can be a few ulps past the threshold, where
  // ceil pays `units + 1` — one more than the caller holds. Walk it back
  // until the helper agrees; paying is monotone in progress, and prog reaches
  // 0 (pays 0) before the step does, so the loop ends.
  for (let step = 1e-15; resourcePaidAt(prog, duration, amount).gt(units); step *= 10) {
    prog = prog.sub(prog.abs().mul(step));
  }
  return prog;
}

/** One progressive-cost entry — the total amount over one completion, plus a
 * getter for the resource's current amount, which decides affordability. */
export interface ProgressiveCostEntry {
  /** Total units paid by the time progress reaches `needed`. */
  amount: DecimalSource;
  /** Returns the resource's current amount. Called at most once per call. */
  available: () => DecimalSource;
}

/** Result of one {@link stepProgressiveCosts} evaluation. */
export interface ProgressiveCostStep {
  /**
   * The progress value the caller should write back. May equal `prevProgress`
   * (fully stalled), equal `proposedProgress` (fully covered), or sit between
   * (partially capped by an unaffordable cost).
   */
  cappedProgress: Decimal;
  /**
   * True when `cappedProgress <= prevProgress`. The caller decides what
   * follows (leave state.progress untouched, advance a queue, etc.). The
   * primitive never writes state itself.
   */
  stalled: boolean;
  /**
   * Per-entry amount to pay this tick. Indices align with the `costs`
   * input. The caller calls its own `subtract` — the primitive does not own
   * resource mutation.
   */
  deltas: Decimal[];
}

/**
 * Compute one tick of progressive-cost metering. Given a proposed progress
 * advance, walk each cost entry, cap the advance at whichever cost can't be
 * fully covered, and return the final progress plus the per-entry deltas the
 * caller should subtract.
 *
 * This wraps the canonical pattern around {@link resourcePaidAt}. Each cost
 * is paid at `ceil(progress / (needed / amount))` thresholds. An amount too
 * small to cover it caps progress at the threshold of unit
 * `prevPaid + floor(available)`. So no delta ever exceeds its entry's
 * `available()`.
 * The caller writes back progress and calls its own resource subtract — the
 * primitive owns no state and makes no mutations.
 *
 * Typical call-site:
 *
 * ```ts
 * const step = stepProgressiveCosts({
 *   prevProgress: state.progress.value,
 *   proposedProgress: Decimal.min(
 *     Decimal.add(state.progress.value, rate.mul(dt)),
 *     def.duration,
 *   ),
 *   needed: def.duration,
 *   costs: def.costs.map((c) => ({
 *     amount: c.amount,
 *     available: () => inventory.get(c.resourceId),
 *   })),
 * });
 *
 * if (step.stalled) return 'stalled';
 * state.progress.value = step.cappedProgress;
 * def.costs.forEach((c, i) => {
 *   if (step.deltas[i].gt(0)) inventory.subtract(c.resourceId, step.deltas[i]);
 * });
 * ```
 *
 * @param opts.prevProgress - Progress value at the start of this tick.
 * @param opts.proposedProgress - Progress the caller wants to advance to
 *   (normally `prev + rate * dt` clamped to `needed`). May be <= prevProgress
 *   — the step stalls and deltas are all zero.
 * @param opts.needed - Total progress for one completion; payments are spread
 *   evenly across [0, needed].
 * @param opts.costs - Per-entry cost descriptors. Order is significant only
 *   for matching `deltas` back to entries; the capping result is independent
 *   of order.
 * @returns A {@link ProgressiveCostStep} with the capped progress, a stall
 *   flag, and the per-entry delta to pay this tick.
 *
 * @example
 * // Two-cost construction, wood abundant, stone limited
 * const step = stepProgressiveCosts({
 *   prevProgress: 40,
 *   proposedProgress: 60,
 *   needed: 100,
 *   costs: [
 *     { amount: 10, available: () => 5 }, // wood: 5 units on hand
 *     { amount: 20, available: () => 2 }, // stone: 2 units on hand
 *   ],
 * });
 * // step.cappedProgress = 50 (stone caps at 50: prevPaid 8 + available 2 = 10 units → 50)
 * // step.stalled = false
 * // step.deltas = [1, 2] (wood goes 4→5 = 1, stone goes 8→10 = 2)
 */
export function stepProgressiveCosts(opts: {
  prevProgress: DecimalSource;
  proposedProgress: DecimalSource;
  needed: DecimalSource;
  costs: readonly ProgressiveCostEntry[];
}): ProgressiveCostStep {
  const { prevProgress, proposedProgress, needed: duration, costs } = opts;
  const prev = new Decimal(prevProgress);
  let capped = new Decimal(proposedProgress);

  // `resourcePaidAt` is called with `duration` and `cost.amount` in their
  // original DecimalSource form (not re-wrapped). Decimal.div between two
  // already-wrapped Decimals can introduce a tiny precision artifact in the
  // intermediate `duration/amount`, splitting this primitive's view of
  // prevPaid from a caller that passes raw number args to the same helper.
  // Keeping the args raw here lines the two views up.
  for (const cost of costs) {
    if (Decimal.lte(cost.amount, 0)) continue;

    const prevPaid = resourcePaidAt(prev, duration, cost.amount);
    const wouldPay = resourcePaidAt(capped, duration, cost.amount);
    const needed = wouldPay.sub(prevPaid);
    if (needed.lte(0)) continue;

    const available = new Decimal(cost.available());
    if (available.lt(needed)) {
      // Floor `available` so maxUnits stays on the same integer-threshold grid
      // that resourcePaidAt's ceil produces. Without it, a fractional
      // available propagates into maxProg and the later ceil rounds back up,
      // making the delta over-request by up to one unit (delta > available).
      const maxProg = progressForUnits(prevPaid.add(available.floor()), duration, cost.amount);
      if (maxProg.lt(capped)) capped = maxProg;
    }
  }

  const stalled = capped.lte(prev);

  const deltas: Decimal[] = costs.map((cost) => {
    if (Decimal.lte(cost.amount, 0)) return Decimal.dZero;
    const prevPaid = resourcePaidAt(prev, duration, cost.amount);
    const newPaid = resourcePaidAt(capped, duration, cost.amount);
    const delta = new Decimal(Decimal.sub(newPaid, prevPaid));
    return delta.lte(0) ? Decimal.dZero : delta;
  });

  return { cappedProgress: capped, stalled, deltas };
}
