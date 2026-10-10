/**
 * BestOf tracker — per-metric best-of-run recording
 *
 * Tracks which cycle run produced the best outcome for each registered metric,
 * with optional strategy snapshot capture for reproducibility.
 *
 * - {@link createBestOf} — sole factory, optionally wires into CycleLog `finalized` events
 *
 * Key features:
 * - Declared metrics with configurable comparison mode (absolute or per-second)
 * - Optional projection functions to estimate permanent gain from observed deltas
 * - Automatic tracking via CycleLog integration or manual submit()
 * - Strategy snapshot capture for recording winning configurations
 * - Explicit invalidation with stale state preservation
 * - Persistent storage across sessions via persistent(), tagged `lifetime` so
 *   a reset of the owning module keeps the records (`clearAll()` wipes them)
 *
 * @see {@link createCycleLog} for the delta source this composes with
 */

import { computed, type ComputedRef } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { persistent, withPersistentContext, type Serializable } from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { attachPersistentContextReset } from '@/core/resettable';
import type { CycleLog, CycleLogEntry } from './cycle-log';

// === TYPES ===

/**
 * How to compare candidates: highest absolute delta or highest delta/second.
 * Under `'perSecond'` a zero-elapsed run has no rate, so it ranks below
 * every timed run.
 */
export type ComparisonMode = 'absolute' | 'perSecond';

/** Which value to use for comparison when a projection function is provided */
export type CompareBy = 'observed' | 'projected';

/** Per-metric configuration for {@link createBestOf} */
export interface BestOfMetricDef {
  /** How to compare: highest absolute delta, or highest delta per second */
  mode: ComparisonMode;

  /**
   * Optional projection function that converts observed delta into estimated
   * permanent gain. Called at submit time with the candidate's observed value
   * and the current game state context.
   *
   * @example
   * ```ts
   * // Project transient stat gain into permanent base increase
   * project: (observed) => retentionFormula(observed, currentBase)
   * ```
   */
  project?: (observed: Decimal) => DecimalSource;

  /**
   * Which value to use for ranking when a projection function is provided.
   * Defaults to `'projected'` when `project` is set, `'observed'` otherwise.
   */
  compareBy?: CompareBy;

  /**
   * When set (and > 0), the stored incumbent's comparison value decays with
   * age measured in cycle count: every `recencyHalfLifeRuns` cycles that pass
   * between the incumbent's cycle and the current candidate's cycle halve its
   * effective value. The candidate is always treated as fresh (no decay).
   *
   * Intended for "recency bias" features where the advisor should favor
   * fresh runs over calcified high-water marks. Leave unset for classic
   * strict best-of behavior.
   */
  recencyHalfLifeRuns?: number;
}

/** Validity status of a best-of entry */
export type BestOfStatus = 'valid' | 'stale';

/** A single metric's best recorded outcome */
export interface BestOfEntry {
  /** The winning delta value */
  value: Decimal;
  /** Delta per second — always computed, even for absolute mode (useful for display) */
  perSecond: Decimal;
  /** Projected permanent gain, if a projection function was provided */
  projected: Decimal | undefined;
  /** Cycle duration in seconds */
  elapsed: number;
  /** Which cycle number produced this */
  runNumber: number;
  /** When this record was set (Unix ms) */
  timestamp: number;
  /** Consumer-provided opaque configuration snapshot, or undefined */
  configSnapshot: Serializable | undefined;
  /** Current validity — stale entries are beaten by any new submission */
  status: BestOfStatus;
}

/** Serialized form stored in persistent — Decimals as strings */
interface SerializedBestOfEntry {
  value: string;
  perSecond: string;
  projected: string | undefined;
  elapsed: number;
  runNumber: number;
  timestamp: number;
  configSnapshot: Serializable | undefined;
  status: BestOfStatus;
}

/** A candidate submission for best-of comparison */
export interface BestOfCandidate {
  /** The metric key (must exist in options.metrics) */
  key: string;
  /** The delta value for this run */
  value: DecimalSource;
  /** Elapsed time in seconds */
  elapsed: number;
  /** Cycle number */
  runNumber: number;
  /** Override for strategy snapshot (takes precedence over captureConfig) */
  configSnapshot?: Serializable;
}

/** Events emitted by a {@link BestOf} instance */
export interface BestOfEvents {
  /** Fired when a metric's best is broken */
  bestImproved: (key: string, entry: BestOfEntry) => void;
}

/** Configuration for {@link createBestOf} */
export interface BestOfOptions {
  /** Persistence namespace (required for save/load) */
  id: string;

  /** Metric definitions: which keys to track and how to compare them */
  metrics: Record<string, BestOfMetricDef>;

  /** Auto-subscribe to a CycleLog's `finalized` event for automatic tracking */
  cycleLog?: CycleLog;

  /** Called to capture the current strategy/config when a new best is recorded */
  captureConfig?: () => Serializable;
}

/**
 * A BestOf instance — the returned object from {@link createBestOf}.
 *
 * Tracks per-metric best cycle outcomes with comparison, invalidation,
 * and optional CycleLog integration.
 */
export interface BestOf {
  /** Reactive map of current best per metric key (null if no best recorded) */
  readonly entries: ComputedRef<Record<string, BestOfEntry | null>>;
  /** The metric definitions this tracker was created with, by key */
  readonly metrics: Readonly<Record<string, BestOfMetricDef>>;
  /** Subscribe to BestOf events */
  on: Emittable<BestOfEvents>['on'];
  /** Manually submit a candidate result for comparison */
  submit(candidate: BestOfCandidate): void;
  /** Mark a metric's best as stale (data preserved, any new submission wins) */
  invalidate(metricKey: string): void;
  /** Mark all metrics as stale */
  invalidateAll(): void;
  /** Remove a metric's best entirely */
  clear(metricKey: string): void;
  /** Remove all bests */
  clearAll(): void;
  /**
   * Runtime override for incumbent recency decay, applied to every metric
   * on this instance. Pass a positive number to enable age-based decay
   * (half-life in cycle count), or `undefined` to clear the override and
   * fall back to each metric's static `recencyHalfLifeRuns` option.
   *
   * Useful for toggling decay at runtime without mutating shared metric
   * config objects.
   */
  setRecencyHalfLifeRuns(halfLifeRuns: number | undefined): void;
  /**
   * Unsubscribe from the CycleLog, if connected. The stored bests stay
   * registered and keep saving, so building one under the same id again takes
   * a new engine.
   */
  dispose(): void;
}

// === INTERNAL HELPERS ===

function serialize(entry: BestOfEntry): SerializedBestOfEntry {
  return {
    value: entry.value.toString(),
    perSecond: entry.perSecond.toString(),
    projected: entry.projected?.toString(),
    elapsed: entry.elapsed,
    runNumber: entry.runNumber,
    timestamp: entry.timestamp,
    configSnapshot: entry.configSnapshot,
    status: entry.status,
  };
}

function deserialize(raw: SerializedBestOfEntry): BestOfEntry {
  return {
    value: new Decimal(raw.value),
    perSecond: new Decimal(raw.perSecond),
    projected: raw.projected != null ? new Decimal(raw.projected) : undefined,
    elapsed: raw.elapsed,
    runNumber: raw.runNumber,
    timestamp: raw.timestamp,
    configSnapshot: raw.configSnapshot,
    status: raw.status,
  };
}

/** Value per second; a zero-elapsed run reports ±Infinity by the value's sign, or 0. */
function computePerSecond(value: DecimalSource, elapsed: number): Decimal {
  if (elapsed <= 0) {
    const sign = Decimal.sign(value);
    return new Decimal(sign === 0 ? 0 : sign * Infinity);
  }
  return new Decimal(Decimal.div(value, elapsed));
}

// === FACTORIES ===

/**
 * Create a BestOf tracker that records the best cycle outcome per metric.
 *
 * Compares each new cycle result against the stored best and replaces it when
 * the new result wins. Supports both automatic tracking via CycleLog and manual
 * submission for custom metric sources.
 *
 * @param options - Persistence ID, metric definitions, optional CycleLog and strategy capture
 * @returns A BestOf with reactive entries, submit/invalidate/clear API, and `bestImproved` event
 *
 * @example
 * ```ts
 * const bestOf = createBestOf({
 *   id: 'main-best',
 *   metrics: {
 *     gold: { mode: 'perSecond' },
 *     xp: { mode: 'absolute' },
 *   },
 *   cycleLog: myCycleLog,
 *   captureConfig: () => ({ queue: actionQueue.serialize() }),
 * });
 *
 * bestOf.on('bestImproved', (key, entry) => {
 *   console.log(`New best ${key}: ${entry.value} in ${entry.elapsed}s`);
 * });
 * ```
 */
export function createBestOf(options: BestOfOptions): BestOf {
  const { id, metrics, cycleLog, captureConfig } = options;

  // --- Reactive state ---
  const store = withPersistentContext(id, () =>
    persistent<Record<string, SerializedBestOfEntry | null>>({}, { id: 'store', lifetime: true }),
  );

  const handle = createEmitHandle<BestOfEvents>();

  const entries = computed<Record<string, BestOfEntry | null>>(() => {
    const result: Record<string, BestOfEntry | null> = {};
    for (const key of Object.keys(metrics)) {
      const raw = store.value[key];
      result[key] = raw ? deserialize(raw) : null;
    }
    return result;
  });

  let recencyOverride: number | undefined;

  // --- Comparison ---
  function resolveCompareBy(def: BestOfMetricDef): CompareBy {
    return def.compareBy ?? (def.project ? 'projected' : 'observed');
  }

  function resolveRecencyHalfLife(def: BestOfMetricDef): number | undefined {
    return recencyOverride !== undefined ? recencyOverride : def.recencyHalfLifeRuns;
  }

  /**
   * Decay the incumbent's comparison value by its age. Age is measured in
   * cycles between the incumbent and the current candidate. Returns the
   * original value unchanged when no half-life is configured or the age
   * is non-positive (candidate from same or earlier cycle — shouldn't happen
   * in practice, but clamped defensively).
   */
  function applyRecencyDecay(
    existingVal: Decimal,
    existingCycle: number,
    candidateCycle: number,
    halfLifeRuns: number | undefined,
  ): Decimal {
    if (halfLifeRuns === undefined || halfLifeRuns <= 0) return existingVal;
    const ageRuns = candidateCycle - existingCycle;
    if (ageRuns <= 0) return existingVal;
    const factor = Math.pow(0.5, ageRuns / halfLifeRuns);
    return new Decimal(Decimal.mul(existingVal, factor));
  }

  function pickValue(
    observed: Decimal,
    projected: Decimal | undefined,
    useProjected: boolean,
  ): Decimal {
    return useProjected && projected != null ? projected : observed;
  }

  function isBetter(
    candidate: {
      value: Decimal;
      perSecond: Decimal;
      projected: Decimal | undefined;
      elapsed: number;
      runNumber: number;
    },
    existing: SerializedBestOfEntry,
    metricDef: BestOfMetricDef,
  ): boolean {
    if (existing.status === 'stale') return true;

    const useProjected = resolveCompareBy(metricDef) === 'projected';
    const candidateVal = pickValue(candidate.value, candidate.projected, useProjected);
    const rawExistingVal = pickValue(
      new Decimal(existing.value),
      existing.projected != null ? new Decimal(existing.projected) : undefined,
      useProjected,
    );
    const existingVal = applyRecencyDecay(
      rawExistingVal,
      existing.runNumber,
      candidate.runNumber,
      resolveRecencyHalfLife(metricDef),
    );

    if (metricDef.mode === 'perSecond') {
      // A zero-elapsed run has no rate: it never beats a timed run and any
      // timed run beats it. Two of them fall back to comparing values.
      const candidateTimed = candidate.elapsed > 0;
      const existingTimed = existing.elapsed > 0;
      if (candidateTimed !== existingTimed) return candidateTimed;
      if (!candidateTimed) return Decimal.gt(candidateVal, existingVal);
      return Decimal.gt(
        computePerSecond(candidateVal, candidate.elapsed),
        computePerSecond(existingVal, existing.elapsed),
      );
    }

    return Decimal.gt(candidateVal, existingVal);
  }

  // --- Submission ---
  function trySubmit(candidate: BestOfCandidate): void {
    const metricDef = metrics[candidate.key];
    if (!metricDef) return;

    const candidateValue = new Decimal(candidate.value);
    const candidatePS = computePerSecond(candidate.value, candidate.elapsed);
    const projected = metricDef.project
      ? new Decimal(metricDef.project(candidateValue))
      : undefined;

    const existing = store.value[candidate.key];

    if (
      existing &&
      !isBetter(
        {
          value: candidateValue,
          perSecond: candidatePS,
          projected,
          elapsed: candidate.elapsed,
          runNumber: candidate.runNumber,
        },
        existing,
        metricDef,
      )
    ) {
      return;
    }

    const snapshot =
      candidate.configSnapshot !== undefined ? candidate.configSnapshot : captureConfig?.();

    const entry: BestOfEntry = {
      value: candidateValue,
      perSecond: candidatePS,
      projected,
      elapsed: candidate.elapsed,
      runNumber: candidate.runNumber,
      timestamp: Date.now(),
      configSnapshot: snapshot,
      status: 'valid',
    };

    store.value = { ...store.value, [candidate.key]: serialize(entry) };
    handle.emit('bestImproved', candidate.key, entry);
  }

  function handleFinalize(logEntry: CycleLogEntry): void {
    for (const delta of logEntry.deltas) {
      if (!(delta.key in metrics)) continue;
      trySubmit({
        key: delta.key,
        value: delta.delta,
        elapsed: logEntry.elapsed,
        runNumber: logEntry.runNumber,
      });
    }
  }

  // --- CycleLog integration ---
  const unsubCycleLog = cycleLog?.on('finalized', handleFinalize);

  // --- Public API ---
  const bestOf: BestOf = {
    entries,
    metrics,
    on: handle.on,
    submit: trySubmit,

    invalidate(metricKey: string) {
      const raw = store.value[metricKey];
      if (raw && raw.status !== 'stale') {
        store.value = { ...store.value, [metricKey]: { ...raw, status: 'stale' } };
      }
    },

    invalidateAll() {
      const updated = { ...store.value };
      let changed = false;
      for (const key of Object.keys(updated)) {
        const raw = updated[key];
        if (raw && raw.status !== 'stale') {
          updated[key] = { ...raw, status: 'stale' };
          changed = true;
        }
      }
      if (changed) store.value = updated;
    },

    clear(metricKey: string) {
      if (metricKey in store.value) {
        const updated = { ...store.value };
        delete updated[metricKey];
        store.value = updated;
      }
    },

    clearAll() {
      store.value = {};
    },

    setRecencyHalfLifeRuns(halfLifeRuns: number | undefined) {
      recencyOverride = halfLifeRuns;
    },

    dispose() {
      unsubCycleLog?.();
    },
  };
  return attachPersistentContextReset(bestOf, id);
}
