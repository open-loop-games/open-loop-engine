/**
 * LoopLog system — per-loop metric delta recording
 *
 * Records the change in each registered metric across a single loop,
 * building a ring buffer of entries for analytics and UI.
 *
 * - {@link createLoopLog} — sole factory, wires into Loop lifecycle events
 *
 * Key features:
 * - Explicit metric registration (Persistent refs or getter functions)
 * - Snapshot at loop start, delta computed before restart
 * - Ring buffer with configurable capacity and per-entry pinning
 * - `finalize` event for downstream consumers (e.g. best-of tracking)
 *
 * @see {@link createLoop} for the Loop lifecycle this composes with
 * @see {@link createRetentionPolicy} for a similar snapshot/restore pattern
 */

import { ref, type Ref } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { isPersistent, type Persistent } from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import type { InjectionKey } from '@/primitives/types';
import type { Loop } from './loop';

// === TYPES ===

/**
 * Opt-in discovery key for introspection tools (sim, balance workbench,
 * devtools). Games that maintain a canonical LoopLog publish it during
 * `install()` or `connect()`:
 *
 * ```ts
 * const log = createLoopLog({ loop, metrics });
 * context.provide(LoopLogKey, log);
 * ```
 *
 * Consumers read via `engine.tryInject(LoopLogKey)`. Absent when the game
 * doesn't use a loop cadence — discovery tools must handle `undefined`.
 * Sibling to `CategoriesKey`: a convention, not engine machinery.
 */
export const LoopLogKey: InjectionKey<LoopLog> = Symbol('engine:loop-log') as InjectionKey<LoopLog>;

/** Configuration for {@link createLoopLog} */
export interface LoopLogOptions {
  /** The Loop instance whose lifecycle drives snapshot/diff timing */
  loop: Loop;

  /**
   * Named metrics to record each loop. Each value is either a Persistent ref
   * (read via `.value`) or a getter function (called each snapshot).
   * Use getters for computed quantities not stored in persistent refs.
   */
  metrics: Record<string, Persistent<DecimalSource> | (() => DecimalSource)>;

  /** Maximum unpinned entries to retain in the ring buffer. Default: 10. */
  maxLogs?: number;
}

/** Per-metric change recorded during a single loop */
export interface LoopLogDelta {
  key: string;
  start: Decimal;
  end: Decimal;
  /** Net change: `end - start` */
  delta: Decimal;
}

/** A single loop's recorded outcome */
export interface LoopLogEntry {
  /** Loop number at finalize time (loop.count before increment) */
  loopNumber: number;
  /** Elapsed time in seconds at finalize time */
  elapsed: number;
  timestamp: number;
  deltas: LoopLogDelta[];
  /** Consumer-populated structured annotations from the loop */
  context: Record<string, unknown>;
  pinned: boolean;
}

/** Events emitted by a {@link LoopLog} instance */
export interface LoopLogEvents {
  /** Fired after deltas are computed and the entry is pushed to history */
  finalize: (entry: LoopLogEntry) => void;
}

/**
 * A LoopLog instance — the returned object from {@link createLoopLog}.
 *
 * Subscribes to a Loop's `beforeRestart`/`afterRestart` events to record
 * per-loop metric deltas in a reactive ring buffer.
 */
export interface LoopLog {
  /** Reactive history buffer — newest entry is last */
  readonly history: Ref<LoopLogEntry[]>;
  /** Subscribe to LoopLog events */
  on: Emittable<LoopLogEvents>['on'];
  /**
   * Attach a named annotation to the current loop's context.
   * Context resets each loop (on afterRestart) and is captured into the
   * finalized entry. Calling with the same key overwrites the previous value.
   */
  setContext(key: string, value: unknown): void;
  /** Pin an entry by index so it survives ring buffer pruning */
  pin(index: number): void;
  /** Unpin an entry by index, allowing it to be pruned */
  unpin(index: number): void;
  /** Unsubscribe from loop events */
  dispose(): void;
}

// === INTERNAL HELPERS ===

function readMetric(metric: Persistent<DecimalSource> | (() => DecimalSource)): Decimal {
  return new Decimal(isPersistent(metric) ? metric.value : metric());
}

// === FACTORIES ===

/**
 * Create a LoopLog that records per-loop metric deltas from a Loop's lifecycle.
 *
 * Snapshots all registered metrics at loop start and computes deltas before
 * each restart. Works for both resetting resources (delta = accumulated value)
 * and permanent stats (delta = growth during the loop).
 *
 * @param options - Loop to observe, metrics to track, and optional ring buffer size
 * @returns A LoopLog with reactive history, finalize event, and pin/unpin controls
 *
 * @example
 * ```ts
 * const log = createLoopLog({
 *   loop: gameLoop,
 *   metrics: {
 *     gold: goldResource,                    // Persistent ref (resets each loop)
 *     totalStrength: () => strength.base,    // Getter (permanent stat)
 *   },
 *   maxLogs: 15,
 * });
 *
 * log.on('finalize', (entry) => {
 *   // Feed deltas into best-of tracking, analytics, UI, etc.
 *   for (const d of entry.deltas) console.log(`${d.key}: +${d.delta}`);
 * });
 * ```
 */
export function createLoopLog(options: LoopLogOptions): LoopLog {
  const { loop, metrics, maxLogs = 10 } = options;

  const history = ref<LoopLogEntry[]>([]);
  const handle = createEmitHandle<LoopLogEvents>();

  // Snapshot state — intentionally ephemeral, no persistent() calls
  let startSnapshot: Record<string, Decimal> = {};
  let currentContext: Record<string, unknown> = {};

  function takeSnapshot(): void {
    const snap: Record<string, Decimal> = {};
    for (const [key, metric] of Object.entries(metrics)) {
      snap[key] = readMetric(metric);
    }
    startSnapshot = snap;
  }

  function pruneHistory(): void {
    let unpinnedCount = 0;
    for (const entry of history.value) {
      if (!entry.pinned) unpinnedCount++;
    }
    let i = 0;
    while (unpinnedCount > maxLogs && i < history.value.length) {
      if (!history.value[i].pinned) {
        history.value.splice(i, 1);
        unpinnedCount--;
      } else {
        i++;
      }
    }
  }

  takeSnapshot();

  const unsubBefore = loop.on('beforeRestart', () => {
    const deltas: LoopLogDelta[] = [];
    for (const [key, metric] of Object.entries(metrics)) {
      const start = startSnapshot[key] ?? Decimal.dZero;
      const end = readMetric(metric);
      deltas.push({ key, start, end, delta: new Decimal(Decimal.sub(end, start)) });
    }

    const entry: LoopLogEntry = {
      loopNumber: loop.count.value,
      elapsed: loop.elapsed.value,
      timestamp: Date.now(),
      deltas,
      context: { ...currentContext },
      pinned: false,
    };

    history.value.push(entry);
    pruneHistory();
    handle.emit('finalize', entry);
  });

  const unsubAfter = loop.on('afterRestart', () => {
    takeSnapshot();
    currentContext = {};
  });

  return {
    history,
    on: handle.on,
    setContext(key: string, value: unknown) {
      currentContext[key] = value;
    },
    pin(index: number) {
      const entry = history.value[index];
      if (entry) entry.pinned = true;
    },
    unpin(index: number) {
      const entry = history.value[index];
      if (entry) entry.pinned = false;
    },
    dispose() {
      unsubBefore();
      unsubAfter();
    },
  };
}
