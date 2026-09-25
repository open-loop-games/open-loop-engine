/**
 * TimedProgress — stateless tickable progress accumulator.
 *
 * A pure `{duration, speed, progress, tickProgressDelta}` primitive with no
 * state machine, no active/cancel/cooldown, no start/complete gates, no
 * progressive costs, no chain. Ticks on every registered tick and accumulates
 * `speed * dt` into `progress`. Fires `onProgress(delta)` when the tick
 * advances progress; fires `onComplete(overflow)` on the single tick that
 * *crosses* `duration`.
 *
 * The tracker never auto-resets, never carries overflow, never stalls or
 * fails. Those are consumer decisions — this is a value that accumulates
 * over time, nothing more.
 *
 * Intended as the building block for N-parallel passive tick loops where a
 * single-active-at-a-time state machine (like Sequencer-driven execution)
 * doesn't fit — e.g., incloneution's `tickJobDirect`, idle-loops-ng's
 * `ProgressVar`.
 */

import { computed, ref, unref, type ComputedRef, type MaybeRef, type Ref } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { processGetter, type Computable } from './computed';
import { persistent, withPersistentContext, getCurrentContext } from './persistence';
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
         * tracker works the same but never appears in save data. Mirrors
         * {@link Action}'s ephemeral mode for predictors and headless simulation.
         */
        ephemeral: true;
      }
  );

/** Options every {@link createTimedProgress} tracker shares. */
export interface TimedProgressBaseOptions {
  /** Total progress needed before `onComplete` fires. */
  duration: Computable<DecimalSource>;
  /** Progress gained per second (default 1). */
  speed?: Computable<DecimalSource>;
  /** Tick registration function — tracker self-wires its tick. */
  registerTick: RegisterTick;
  /**
   * Called after each tick that advanced progress. `delta` is the amount
   * progress moved this tick (may be capped to the duration boundary on the
   * completing tick).
   */
  onProgress?: (delta: DecimalSource) => void;
  /**
   * Called on the single tick that crosses from `progress < duration` to
   * `progress >= duration`. `overflow` is how far past duration the raw
   * advance would have gone. Consumers decide what to do next — reset,
   * carry overflow, leave progress parked, etc. The tracker does nothing
   * else on completion.
   */
  onComplete?: (overflow: DecimalSource) => void;
}

/**
 * A stateless ticking progress accumulator created by {@link createTimedProgress}.
 */
export interface TimedProgress {
  id: string;
  /** Accumulated progress. Persistent unless `ephemeral: true`. */
  progress: Ref<DecimalSource>;
  /** Total progress for one completion cycle. */
  duration: MaybeRef<DecimalSource>;
  /** Progress gained per second. */
  speed: MaybeRef<DecimalSource>;
  /** Progress actually advanced in the last tick. Zero between ticks. */
  readonly tickProgressDelta: Ref<DecimalSource>;
  /** Progress as a fraction [0, 1] of duration. */
  percentComplete: ComputedRef<number>;
  /** Estimated seconds remaining at the current speed. */
  timeRemaining: ComputedRef<DecimalSource>;
  /** Clear `progress` back to 0 and zero `tickProgressDelta`. */
  reset(): void;
  /** Unsubscribe from the tick loop. Call on teardown. */
  dispose(): void;
}

// === CONSTANTS ===
let timedProgressIdCounter = 0;

// === PRIVATE BUILDERS ===
interface TimedProgressState {
  progress: Ref<DecimalSource>;
}

function buildTimedProgressState(id: string, ephemeral: boolean | undefined): TimedProgressState {
  if (ephemeral) {
    return {
      progress: ref<DecimalSource>(0) as Ref<DecimalSource>,
    };
  }
  // Compose the ambient context with this tracker's id rather than letting the
  // ambient win — N parallel trackers built inside one module's install() share
  // an ambient context, and collapsing them onto it collides their 'progress'
  // refs. Mirrors category-base's `${parent}/${local}` nesting.
  const parent = getCurrentContext();
  const contextId = parent ? `${parent}/${id}` : id;
  return withPersistentContext(contextId, (): TimedProgressState => ({
    progress: persistent<DecimalSource>(0, { name: 'progress' }),
  }));
}

interface ProcessedTimedProgressOptions {
  duration: MaybeRef<DecimalSource>;
  speed: MaybeRef<DecimalSource>;
}

function buildProcessedOptions(options: TimedProgressOptions): ProcessedTimedProgressOptions {
  return {
    duration: processGetter(options.duration),
    speed: options.speed != null ? processGetter(options.speed) : 1,
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
    const dur = new Decimal(unref(processed.duration));
    if (dur.lte(0)) return 0;
    return new Decimal(state.progress.value).div(dur).clamp(0, 1).toNumber();
  });

  const timeRemaining = computed((): DecimalSource => {
    const dur = new Decimal(unref(processed.duration));
    const remaining = dur.sub(state.progress.value).max(0);
    const spd = new Decimal(unref(processed.speed));
    if (spd.lte(0)) return Decimal.dInf;
    return remaining.div(spd);
  });

  return { percentComplete, timeRemaining };
}

// === PRIVATE TICK ===
interface TimedProgressTickContext {
  state: TimedProgressState;
  tickProgressDelta: Ref<DecimalSource>;
  processed: ProcessedTimedProgressOptions;
  onProgress: TimedProgressOptions['onProgress'];
  onComplete: TimedProgressOptions['onComplete'];
}

function tickTimedProgress(ctx: TimedProgressTickContext, dt: number): void {
  const { state, tickProgressDelta, processed, onProgress, onComplete } = ctx;

  const spd = new Decimal(unref(processed.speed));
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
  const dur = new Decimal(unref(processed.duration));

  state.progress.value = next;
  tickProgressDelta.value = delta;

  onProgress?.(delta);

  // Fire onComplete only on the tick that *crosses* the boundary, so a
  // consumer that parks progress past duration without resetting doesn't
  // receive onComplete again on every subsequent tick.
  if (prev.lt(dur) && next.gte(dur)) {
    onComplete?.(next.sub(dur));
  }
}

// === FACTORY ===
/**
 * Creates a stateless progress accumulator that ticks on every registered tick,
 * advancing `progress` by `speed * dt` each time. Use for parallel "many things
 * progressing at once" patterns where single-active-at-a-time execution
 * doesn't fit.
 *
 * The tracker has no opinion about what happens on completion — it fires
 * `onComplete(overflow)` once per boundary crossing and leaves everything else
 * to the consumer. Reset, carry overflow, grant rewards, subtract a cycle, or
 * do nothing: all are valid.
 *
 * @param options - Configuration: duration, optional speed, tick registration,
 *   optional `onProgress` / `onComplete` callbacks, optional `ephemeral` to
 *   skip persistence.
 * @returns A {@link TimedProgress} with `progress` / `tickProgressDelta` refs,
 *   `percentComplete` / `timeRemaining` computeds, and `reset` / `dispose`.
 *
 * @example
 * ```ts
 * const tracker = createTimedProgress({
 *   id: 'job:mine-ore',
 *   duration: () => def.requiredProgress,
 *   speed: () => skillMultiplier.value,
 *   registerTick: engine.onTick,
 *   onComplete: (overflow) => {
 *     if (!canDeliverRewards()) return; // stall — tracker parks at duration
 *     grantRewards();
 *     tracker.progress.value = overflow; // carry overflow into next cycle
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

  const unsubTick = options.registerTick((dt: number) =>
    tickTimedProgress(
      {
        state,
        tickProgressDelta,
        processed,
        onProgress: options.onProgress,
        onComplete: options.onComplete,
      },
      dt,
    ),
  );

  return {
    id: actualId,
    progress: state.progress,
    duration: processed.duration,
    speed: processed.speed,
    tickProgressDelta,
    percentComplete,
    timeRemaining,
    reset(): void {
      state.progress.value = 0;
      tickProgressDelta.value = 0;
    },
    dispose: unsubTick,
  };
}

// === UTILITIES ===
/**
 * How many whole resource units should be consumed at a given progress level.
 * Formula: ceil(progress / (duration / amount)), clamped to [0, amount].
 * Use for progressive-cost tracking where a resource drains at discrete
 * thresholds spread evenly across a duration.
 */
export function resourceConsumedAt(
  progress: DecimalSource,
  duration: DecimalSource,
  amount: DecimalSource,
): Decimal {
  if (Decimal.lte(progress, 0)) return Decimal.dZero;
  if (Decimal.gte(progress, duration)) return new Decimal(amount);
  const interval = Decimal.div(duration, amount);
  return Decimal.ceil(Decimal.div(progress, interval));
}

/** One progressive-cost entry — amount total across a full run, plus a live
 * balance getter the primitive calls to decide affordability. */
export interface ProgressiveCostEntry {
  /** Total units consumed when progress reaches duration. */
  amount: DecimalSource;
  /** Callback returning the current resource balance. Called once per step. */
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
   * True when `cappedProgress <= prevProgress`. Caller decides policy
   * (leave state.progress untouched, advance a queue, etc.). The primitive
   * never writes state itself.
   */
  stalled: boolean;
  /**
   * Per-entry amount to deduct this tick. Indices align with the `costs`
   * input. Caller is responsible for calling its own `remove`/`deduct` — the
   * primitive does not own resource mutation.
   */
  deltas: Decimal[];
}

/**
 * Compute one tick of progressive-cost metering. Given a proposed progress
 * advance, walk each cost entry, cap the advance at whichever cost can't be
 * fully covered, and return the final progress plus the per-entry deltas the
 * caller should remove.
 *
 * This wraps the canonical pattern around {@link resourceConsumedAt}: each
 * cost drains at `ceil(progress / (duration / amount))` thresholds, and an
 * insufficient balance caps progress to `(prevConsumed + available) * (duration / amount)`.
 * The caller writes back progress and calls its own resource-remove — the
 * primitive owns no state and makes no mutations.
 *
 * Typical call-site:
 *
 * ```ts
 * const step = stepProgressiveCosts({
 *   prevProgress: state.progress.value,
 *   proposedProgress: Decimal.min(
 *     Decimal.add(state.progress.value, speed.mul(dt)),
 *     def.duration,
 *   ),
 *   duration: def.duration,
 *   costs: def.costs.map((c) => ({
 *     amount: c.amount,
 *     available: () => inventory.balance(c.resourceId),
 *   })),
 * });
 *
 * if (step.stalled) return 'stalled';
 * state.progress.value = step.cappedProgress;
 * def.costs.forEach((c, i) => {
 *   if (step.deltas[i].gt(0)) inventory.remove(c.resourceId, step.deltas[i]);
 * });
 * ```
 *
 * @param opts.prevProgress - Progress value at the start of this tick.
 * @param opts.proposedProgress - Progress the caller wants to advance to
 *   (normally `prev + speed*dt` clamped to duration). May be <= prevProgress
 *   — the step stalls and deltas are all zero.
 * @param opts.duration - Total progress for one full run; the consumption
 *   schedule is distributed evenly across [0, duration].
 * @param opts.costs - Per-entry cost descriptors. Order is significant only
 *   for matching `deltas` back to entries; the capping result is independent
 *   of order.
 * @returns A {@link ProgressiveCostStep} with the capped progress, a stall
 *   flag, and the per-entry delta to consume this tick.
 *
 * @example
 * // Two-cost construction, wood abundant, stone limited
 * const step = stepProgressiveCosts({
 *   prevProgress: 40,
 *   proposedProgress: 60,
 *   duration: 100,
 *   costs: [
 *     { amount: 10, available: () => 5 }, // wood: 5 units on hand
 *     { amount: 20, available: () => 2 }, // stone: 2 units on hand
 *   ],
 * });
 * // step.cappedProgress = 50 (stone caps at 50: prevConsumed 8 + available 2 = 10 units → 50)
 * // step.stalled = false
 * // step.deltas = [1, 2] (wood goes 4→5 = 1, stone goes 8→10 = 2)
 */
export function stepProgressiveCosts(opts: {
  prevProgress: DecimalSource;
  proposedProgress: DecimalSource;
  duration: DecimalSource;
  costs: readonly ProgressiveCostEntry[];
}): ProgressiveCostStep {
  const { prevProgress, proposedProgress, duration, costs } = opts;
  const prev = new Decimal(prevProgress);
  let capped = new Decimal(proposedProgress);

  // `resourceConsumedAt` is called with `duration` and `cost.amount` in their
  // original DecimalSource form (not re-wrapped). Decimal.div between two
  // already-wrapped Decimals can introduce a tiny precision artifact in the
  // intermediate `duration/amount`, splitting this primitive's view of
  // prevConsumed from a caller that passes raw number args to the same helper.
  // Keeping the args raw here lines the two views up.
  for (const cost of costs) {
    if (Decimal.lte(cost.amount, 0)) continue;

    const prevConsumed = resourceConsumedAt(prev, duration, cost.amount);
    const wouldConsume = resourceConsumedAt(capped, duration, cost.amount);
    const needed = wouldConsume.sub(prevConsumed);
    if (needed.lte(0)) continue;

    const available = new Decimal(cost.available());
    if (available.lt(needed)) {
      // Floor `available` so maxUnits stays on the same integer-threshold grid
      // that resourceConsumedAt's ceil produces. Without it, a fractional
      // available propagates into maxProg and the later ceil rounds back up,
      // making the delta over-request by up to one unit (delta > available).
      const maxUnits = prevConsumed.add(available.floor());
      // (maxUnits * duration) / amount, not maxUnits * (duration / amount): the
      // latter rounds the intermediate ratio and writes state.progress just
      // above an integer threshold, which then desyncs the next-tick reads.
      const maxProg = maxUnits.mul(duration).div(cost.amount);
      if (maxProg.lt(capped)) capped = maxProg;
    }
  }

  const stalled = capped.lte(prev);

  const deltas: Decimal[] = costs.map((cost) => {
    if (Decimal.lte(cost.amount, 0)) return Decimal.dZero;
    const prevConsumed = resourceConsumedAt(prev, duration, cost.amount);
    const newConsumed = resourceConsumedAt(capped, duration, cost.amount);
    const delta = new Decimal(Decimal.sub(newConsumed, prevConsumed));
    return delta.lte(0) ? Decimal.dZero : delta;
  });

  return { cappedProgress: capped, stalled, deltas };
}
