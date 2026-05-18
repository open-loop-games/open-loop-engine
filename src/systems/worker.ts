/**
 * Worker — pure identity container over a Sequencer + TimedProgress + task lookup.
 *
 * Gives "the thing executing work" an addressable handle ("player", "clone-0",
 * "predictor") for multi-clone scopes and devtools. Owns no behavior: no
 * subscriptions, no event forwarding, no ticks. The struct *is* the four
 * inputs plus two computeds and `dispose`.
 *
 * Precedent: Cavernous II's `Clone` — a pure identity container with no
 * behavior, used only so devtools, sync barriers, and queue-scoping have
 * something to address. The engine's separation of Sequencer / TimedProgress /
 * task lookup is already cleaner than anything real games build; Worker's
 * value-add is *naming*, not re-unifying those concerns.
 *
 * Consumer wiring (the three-way dance lives in tracker construction options):
 *
 * ```ts
 * const tracker = createTimedProgress({
 *   id: `worker:${workerId}:tracker`,
 *   duration: () => getTask(sequencer.currentItem?.id ?? '')?.duration ?? 0,
 *   speed: () => getTask(sequencer.currentItem?.id ?? '')?.speed ?? 1,
 *   registerTick: ctx.onTick,
 *   onProgress: (dt) => getTask(sequencer.currentItem?.id ?? '')?.onTick?.(dt),
 *   onComplete: () => {
 *     getTask(sequencer.currentItem?.id ?? '')?.onComplete?.();
 *     sequencer.complete();
 *   },
 * });
 * sequencer.on('start', () => tracker.reset());
 * const worker = createWorker({ id: workerId, sequencer, tracker, getTask });
 * ```
 */

import { computed, type ComputedRef } from 'vue';
import type { Sequencer } from '@/core/sequencer';
import type { TimedProgress } from '@/core/timed-progress';
import { isType } from '@/core/feature';

// === TYPES ===

/** Symbol identifying Worker instances. */
export const WorkerType = Symbol('Worker');

/** Configuration for {@link createWorker}. */
export interface WorkerOptions<TaskDef extends { id: string }> {
  /** Addressable identity — 'player', 'clone-0', 'predictor'. Scopes devtools and introspection. */
  id: string;
  /** The schedule this worker pulls from. */
  sequencer: Sequencer<unknown>;
  /** The progress accumulator the current task runs against. Worker owns disposal. */
  tracker: TimedProgress;
  /** Look up a task def by id. Returns undefined if the id isn't in the consumer's content. */
  getTask: (id: string) => TaskDef | undefined;
}

/**
 * A named execution unit built by {@link createWorker}. Pure struct — no
 * behavior of its own. All four input references are exposed directly; the
 * struct adds two computeds and a `dispose`.
 */
export interface Worker<TaskDef extends { id: string }> {
  type: typeof WorkerType;
  readonly id: string;
  readonly sequencer: Sequencer<unknown>;
  readonly tracker: TimedProgress;
  /** Id of the task currently running (from `sequencer.currentItem`). */
  readonly currentTaskId: ComputedRef<string | undefined>;
  /** Current task def, resolved via `getTask`. */
  readonly currentTask: ComputedRef<TaskDef | undefined>;
  /**
   * Disposes the tracker. Does NOT dispose the sequencer — sequencers may be
   * shared across workers in fill-pool scenarios, so the consumer owns that
   * lifecycle.
   */
  dispose(): void;
}

// === FACTORIES ===

/**
 * Creates a pure identity container binding a sequencer, a progress tracker,
 * and a task lookup into one addressable unit. The Worker installs no
 * subscriptions and emits no events of its own — it's a named handle the
 * consumer (and devtools) can reach through to the three underlying primitives.
 *
 * Multi-clone: call `createWorker` N times, one per clone, each with its own
 * sequencer and tracker sharing the same `getTask` lookup. Predictor: pass an
 * ephemeral sequencer and an ephemeral tracker; no primitive-level distinction.
 *
 * @param options - Four required inputs: `id`, `sequencer`, `tracker`, `getTask`.
 *   No configurability beyond these — behavior grows on the underlying primitives,
 *   not here.
 * @returns A {@link Worker} exposing the four inputs, plus `currentTaskId` /
 *   `currentTask` computeds and a `dispose` that tears down the tracker.
 *
 * @example
 * ```ts
 * const worker = createWorker({
 *   id: 'clone-0',
 *   sequencer: cloneSequencer,
 *   tracker: cloneTracker,
 *   getTask: (id) => actionDefs.get(id),
 * });
 * watch(worker.currentTask, (task) => console.log('now running', task?.id));
 * ```
 */
export function createWorker<TaskDef extends { id: string }>(
  options: WorkerOptions<TaskDef>,
): Worker<TaskDef> {
  const { id, sequencer, tracker, getTask } = options;

  const currentTaskId = computed((): string | undefined => sequencer.currentItem?.id);

  const currentTask = computed((): TaskDef | undefined => {
    const taskId = currentTaskId.value;
    return taskId !== undefined ? getTask(taskId) : undefined;
  });

  return {
    type: WorkerType,
    id,
    sequencer,
    tracker,
    currentTaskId,
    currentTask,
    dispose(): void {
      tracker.dispose();
    },
  };
}

// === PUBLIC UTILITIES ===

/** Type guard for Worker instances. */
export function isWorker<TaskDef extends { id: string } = { id: string }>(
  value: unknown,
): value is Worker<TaskDef> {
  return isType(value, WorkerType);
}
