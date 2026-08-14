/**
 * CycleLog system — per-cycle metric delta recording
 *
 * Records the change in each registered metric across a single cycle,
 * building a ring buffer of entries for analytics and UI.
 *
 * - {@link createCycleLog} — sole factory, wires into Cycle lifecycle events
 *
 * Key features:
 * - Explicit metric registration (Persistent refs or getter functions)
 * - Snapshot at cycle start, delta computed before restart
 * - Ring buffer with configurable capacity and per-entry pinning
 * - `finalize` event for downstream consumers (e.g. best-of tracking)
 *
 * @see {@link createCycle} for the Cycle lifecycle this composes with
 * @see {@link createRetentionPolicy} for a similar snapshot/restore pattern
 */

import { ref, type Ref } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { isPersistent, type Persistent } from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import type { InjectionKey } from '@/primitives/types';
import type { Cycle } from './cycle';

// === TYPES ===

/**
 * Opt-in discovery key for introspection tools (sim, balance workbench,
 * devtools). Games that maintain a canonical CycleLog publish it during
 * `install()` or `connect()`:
 *
 * ```ts
 * const log = createCycleLog({ cycle, metrics });
 * context.provide(CycleLogKey, log);
 * ```
 *
 * Consumers read via `engine.tryInject(CycleLogKey)`. Absent when the game
 * doesn't use a cycle cadence — discovery tools must handle `undefined`.
 * Sibling to `CategoriesKey`: a convention, not engine machinery.
 */
export const CycleLogKey: InjectionKey<CycleLog> = Symbol(
  'engine:cycle-log',
) as InjectionKey<CycleLog>;

/** Configuration for {@link createCycleLog} */
export interface CycleLogOptions {
  /** The Cycle instance whose lifecycle drives snapshot/diff timing */
  cycle: Cycle;

  /**
   * Named metrics to record each cycle. Each value is either a Persistent ref
   * (read via `.value`) or a getter function (called each snapshot).
   * Use getters for computed quantities not stored in persistent refs.
   */
  metrics: Record<string, Persistent<DecimalSource> | (() => DecimalSource)>;

  /** Maximum unpinned entries to retain in the ring buffer. Default: 10. */
  maxLogs?: number;
}

/** Per-metric change recorded during a single cycle */
export interface CycleLogDelta {
  key: string;
  start: Decimal;
  end: Decimal;
  /** Net change: `end - start` */
  delta: Decimal;
}

/** A single cycle's recorded outcome */
export interface CycleLogEntry {
  /** Cycle number at finalize time (cycle.count before increment) */
  cycleNumber: number;
  /** Elapsed time in seconds at finalize time */
  elapsed: number;
  timestamp: number;
  deltas: CycleLogDelta[];
  /** Consumer-populated structured annotations from the cycle */
  context: Record<string, unknown>;
  pinned: boolean;
}

/** Events emitted by a {@link CycleLog} instance */
export interface CycleLogEvents {
  /** Fired after deltas are computed and the entry is pushed to history */
  finalize: (entry: CycleLogEntry) => void;
}

/**
 * A CycleLog instance — the returned object from {@link createCycleLog}.
 *
 * Subscribes to a Cycle's `beforeRestart`/`afterRestart` events to record
 * per-cycle metric deltas in a reactive ring buffer.
 */
export interface CycleLog {
  /** Reactive history buffer — newest entry is last */
  readonly history: Ref<CycleLogEntry[]>;
  /** Subscribe to CycleLog events */
  on: Emittable<CycleLogEvents>['on'];
  /**
   * Attach a named annotation to the current cycle's context.
   * Context resets each cycle (on afterRestart) and is captured into the
   * finalized entry. Calling with the same key overwrites the previous value.
   */
  setContext(key: string, value: unknown): void;
  /** Pin an entry by index so it survives ring buffer pruning */
  pin(index: number): void;
  /** Unpin an entry by index, allowing it to be pruned */
  unpin(index: number): void;
  /** Unsubscribe from cycle events */
  dispose(): void;
}

// === INTERNAL HELPERS ===

function readMetric(metric: Persistent<DecimalSource> | (() => DecimalSource)): Decimal {
  return new Decimal(isPersistent(metric) ? metric.value : metric());
}

// === FACTORIES ===

/**
 * Create a CycleLog that records per-cycle metric deltas from a Cycle's lifecycle.
 *
 * Snapshots all registered metrics at cycle start and computes deltas before
 * each restart. Works for both resetting resources (delta = accumulated value)
 * and permanent stats (delta = growth during the cycle).
 *
 * @param options - Cycle to observe, metrics to track, and optional ring buffer size
 * @returns A CycleLog with reactive history, finalize event, and pin/unpin controls
 *
 * @example
 * ```ts
 * const log = createCycleLog({
 *   cycle: gameLoop,
 *   metrics: {
 *     gold: goldResource,                    // Persistent ref (resets each cycle)
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
export function createCycleLog(options: CycleLogOptions): CycleLog {
  const { cycle, metrics, maxLogs = 10 } = options;

  const history = ref<CycleLogEntry[]>([]);
  const handle = createEmitHandle<CycleLogEvents>();

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

  const unsubBefore = cycle.on('beforeRestart', () => {
    const deltas: CycleLogDelta[] = [];
    for (const [key, metric] of Object.entries(metrics)) {
      const start = startSnapshot[key] ?? Decimal.dZero;
      const end = readMetric(metric);
      deltas.push({ key, start, end, delta: new Decimal(Decimal.sub(end, start)) });
    }

    const entry: CycleLogEntry = {
      cycleNumber: cycle.count.value,
      elapsed: cycle.elapsed.value,
      timestamp: Date.now(),
      deltas,
      context: { ...currentContext },
      pinned: false,
    };

    history.value.push(entry);
    pruneHistory();
    handle.emit('finalize', entry);
  });

  const unsubAfter = cycle.on('afterRestart', () => {
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
