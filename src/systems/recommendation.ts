/**
 * Recommendation system — inter-cycle arbitration across registered defs
 *
 * Composes CycleLog (per-cycle metric history), BestOf (best-of-run records),
 * and Cycle (lifecycle events) into a score-based recommendation surface.
 * Registered defs evaluate historical data and propose configurations for
 * the next cycle; the system picks the highest-scoring winner.
 *
 * - {@link createRecommendationSystem} — sole factory, wires into Cycle lifecycle
 *
 * Key features:
 * - Pluggable def registration with `canApply` / `score` / `recommend`
 * - Score-based arbitration across registered defs (highest wins)
 * - Persistent last recommendation with dismiss/apply lifecycle
 * - Auto-apply mode for full automation (T6 Optimizer pattern)
 * - Advisory mode for surfacing suggestions (T5 Advisor pattern)
 *
 * `RecommendationDef` is the inter-cycle sibling of {@link FillStrategy}:
 * FillStrategy picks the next action *within* a cycle; recommendation defs
 * pick the configuration *between* cycles.
 *
 * @see {@link createCycleLog} for the per-cycle metric source
 * @see {@link createBestOf} for per-metric best tracking with snapshots
 * @see {@link createCycle} for the lifecycle this wires into
 * @see ./recommendation-strategies.ts for built-in def factories
 * @see {@link createRuleAdvisor} for the intra-session sibling — same advisory
 *   shape, but re-fired on consumer signals (rule edits, encounter changes)
 *   instead of `cycle.afterRestart`, and emits a ranked list of independent
 *   suggestions rather than one winning configuration
 */

import { computed, type ComputedRef } from 'vue';
import type { DecimalSource } from '@/primitives/decimal';
import {
  persistent,
  withPersistentContext,
  resolveSystemContextId,
  type Persistent,
  type State,
} from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { attachContextReset } from '@/core/resettable';
import type { Cycle } from './cycle';
import type { CycleLog } from './cycle-log';
import type { BestOf } from './best-of';

// === TYPES ===

/**
 * The evaluation context passed to every def's `canApply`, `score`,
 * and `recommend` methods. Built fresh each `evaluate()` call.
 */
export interface RecommendationContext {
  /** The CycleLog providing per-cycle metric history */
  cycleLog: CycleLog;
  /** The BestOf providing per-metric best records and snapshots */
  bestOf: BestOf;
  /** The Cycle instance (access count, elapsed, etc.) */
  cycle: Cycle;
  /** Current game configuration snapshot, from `getCurrentSnapshot()` */
  currentSnapshot: State;
  /** Consumer-provided game state for strategy evaluation, from `getState()` */
  state: Record<string, unknown>;
}

/** Per-metric comparison data in a recommendation's rationale */
export interface RecommendationMetricComparison {
  current: DecimalSource;
  projected: DecimalSource;
  delta: DecimalSource;
}

/** Structured explanation of why a recommendation was made */
export interface RecommendationRationale {
  /** Which def produced this recommendation */
  strategyId: string;
  /** Per-metric comparison: current performance vs projected with recommended config */
  metrics: Record<string, RecommendationMetricComparison>;
  /** Human-readable summary for UI display (consumer-provided via def) */
  summary: string;
}

/** The output of a def's `recommend()` method */
export interface RecommendationResult {
  /** The proposed configuration to apply next cycle (opaque to the engine) */
  snapshot: State;
  /** Structured explanation data */
  rationale: RecommendationRationale;
}

/**
 * A recommendation definition. Consumers implement this interface and
 * register it with the system; the system scores registered defs and runs
 * the winner.
 *
 * Evaluation order: `canApply` → `score` (if applicable) → `recommend` (winner only).
 */
export interface RecommendationDef {
  /** Unique def identifier */
  id: string;
  /**
   * Returns `true` if this def can produce a meaningful recommendation.
   * Defs where `canApply` returns `false` are excluded from arbitration.
   */
  canApply: (ctx: RecommendationContext) => boolean;
  /**
   * Numeric score for arbitration. Higher wins. Only called when `canApply`
   * returns `true`. On ties, the first-registered def wins.
   *
   * Scores are compared raw across every registered def, so defs sharing a
   * system must score on one scale. The built-ins score in these units, each
   * log10 floored at 0 (magnitudes below 1 score 0):
   * - `createBestReplayDef` — log10 of the best entry's per-second rate, or of
   *   its value when that rate isn't finite.
   * - `createGoalDef` — log10 of the best entry's value under `'maximize'`;
   *   minus its elapsed seconds under `'minimize'`, which never beats a
   *   non-negative score.
   */
  score: (ctx: RecommendationContext) => number;
  /**
   * Produce the recommendation. Only called for the winning def
   * (highest score among applicable defs).
   */
  recommend: (ctx: RecommendationContext) => RecommendationResult;
}

/** A produced recommendation stored by the system */
export interface Recommendation {
  /** Which def produced this */
  strategyId: string;
  /** The proposed configuration snapshot */
  snapshot: State;
  /** Structured explanation data */
  rationale: RecommendationRationale;
  /** When this was generated (Unix ms) */
  timestamp: number;
  /** Whether this has been applied (auto or manual) */
  applied: boolean;
}

/** Serialized form stored in persistent — DecimalSource values as strings */
interface SerializedRecommendation {
  strategyId: string;
  snapshot: State;
  rationale: {
    strategyId: string;
    metrics: Record<string, { current: string; projected: string; delta: string }>;
    summary: string;
  };
  timestamp: number;
  applied: boolean;
}

/** Events emitted by a {@link RecommendationSystem} instance */
export interface RecommendationSystemEvents {
  /** Fired after a new recommendation is produced by `evaluate()` */
  recommended: (recommendation: Recommendation) => void;
  /** Fired after a recommendation's snapshot is applied (auto or manual) */
  applied: (recommendation: Recommendation) => void;
  /** Fired after the last recommendation is dismissed */
  dismissed: () => void;
}

/** Configuration for {@link createRecommendationSystem} */
export interface RecommendationSystemOptions {
  /**
   * Save context. Defaults to `${module}/recommendation` inside a module; pass one
   * when a module builds more than one.
   */
  id?: string;

  /** The Cycle whose `afterRestart` event triggers evaluation */
  cycle: Cycle;

  /** The CycleLog providing per-cycle metric history */
  cycleLog: CycleLog;

  /**
   * The BestOf providing per-metric best records and snapshots.
   *
   * Pass a static instance for single-context games, or a resolver function
   * for games with multiple contexts (zones, encounters, areas). The resolver
   * is called each `evaluate()` — return `null` to skip evaluation when no
   * context is active.
   */
  bestOf: BestOf | (() => BestOf | null);

  /**
   * Called to read the current game configuration as an opaque snapshot.
   * Populates {@link RecommendationContext.currentSnapshot}.
   */
  getCurrentSnapshot: () => State;

  /**
   * Called to apply a recommended snapshot to the live game state.
   * Only called when `autoApply` is enabled or the consumer calls `.apply()`.
   */
  applySnapshot: (snapshot: State) => void;

  /**
   * Definitions to register at construction time.
   * Additional defs can be added later via `.register()`.
   */
  defs?: RecommendationDef[];

  /**
   * Called each `evaluate()` to provide game-specific state for def
   * evaluation. Populates {@link RecommendationContext.state}.
   */
  getState?: () => Record<string, unknown>;
}

/**
 * A recommendation system instance — the returned object from
 * {@link createRecommendationSystem}.
 *
 * Evaluates registered defs after each cycle restart, picks the
 * highest-scoring applicable one, and either surfaces it as an advisory
 * recommendation or auto-applies it.
 */
export interface RecommendationSystem {
  /**
   * The last produced recommendation, or null. Persistent — survives save/load.
   * Cleared by `dismiss()`, replaced by each `evaluate()` that produces a winner.
   */
  readonly lastRecommendation: ComputedRef<Recommendation | null>;

  /**
   * When `true`, `evaluate()` automatically calls `applySnapshot` with the
   * winning recommendation's snapshot. Persistent toggle, defaults to `false`.
   * A player setting, so it and the stored recommendation are tagged
   * `lifetime` and outlive a reset of the owning module.
   */
  readonly autoApply: Persistent<boolean>;

  /** Registered definitions (ordered; first-registered wins on tie) */
  readonly defs: readonly RecommendationDef[];

  /**
   * Register an additional def at runtime.
   * No-op if a def with the same `id` is already registered.
   */
  register(def: RecommendationDef): void;

  /** Remove a def by id. No-op if not found. */
  unregister(defId: string): void;

  /**
   * Run the full evaluation cycle synchronously:
   * 1. Build context from options callbacks
   * 2. Filter defs via `canApply`
   * 3. Score and pick highest (ties: first-registered wins)
   * 4. Call `recommend()` on the winner
   * 5. Store as `lastRecommendation`, emit `'recommended'`
   * 6. If `autoApply`, call `applySnapshot` + emit `'applied'`
   *
   * Returns the produced {@link Recommendation} or `null` if no def applied
   * or the BestOf resolver returned `null` (no active context).
   * Called automatically on `cycle.on('afterRestart')` and can also be called manually.
   */
  evaluate(): Recommendation | null;

  /**
   * Apply the `lastRecommendation`'s snapshot manually.
   * No-op if `lastRecommendation` is null or already applied. Emits `'applied'`.
   */
  apply(): void;

  /** Clear `lastRecommendation`, emit `'dismissed'`. No-op if already null. */
  dismiss(): void;

  /** Subscribe to recommendation system events */
  on: Emittable<RecommendationSystemEvents>['on'];

  /** Unsubscribe from the cycle's `afterRestart` event */
  dispose(): void;
}

// === CONSTANTS ===

let recSystemCounter = 0;

// === PRIVATE BUILDERS ===

function serialize(rec: Recommendation): SerializedRecommendation {
  const serializedMetrics: Record<string, { current: string; projected: string; delta: string }> =
    {};
  for (const [key, m] of Object.entries(rec.rationale.metrics)) {
    serializedMetrics[key] = {
      current: String(m.current),
      projected: String(m.projected),
      delta: String(m.delta),
    };
  }
  return {
    strategyId: rec.strategyId,
    snapshot: rec.snapshot,
    rationale: {
      strategyId: rec.rationale.strategyId,
      metrics: serializedMetrics,
      summary: rec.rationale.summary,
    },
    timestamp: rec.timestamp,
    applied: rec.applied,
  };
}

function deserialize(raw: SerializedRecommendation): Recommendation {
  const metrics: Record<string, RecommendationMetricComparison> = {};
  for (const [key, m] of Object.entries(raw.rationale.metrics)) {
    metrics[key] = {
      current: m.current,
      projected: m.projected,
      delta: m.delta,
    };
  }
  return {
    strategyId: raw.strategyId,
    snapshot: raw.snapshot,
    rationale: {
      strategyId: raw.rationale.strategyId,
      metrics,
      summary: raw.rationale.summary,
    },
    timestamp: raw.timestamp,
    applied: raw.applied,
  };
}

// === FACTORIES ===

/**
 * Create a recommendation system that evaluates registered defs after
 * each cycle restart and surfaces or auto-applies the winning configuration.
 *
 * Composes CycleLog (metric history), BestOf (best configs), and Cycle
 * (lifecycle) into a score-based recommendation surface. Defs are the
 * inter-cycle sibling of FillStrategy: they pick *what configuration to
 * use next*, not what action to run within a cycle.
 *
 * @param options - Cycle/CycleLog/BestOf to compose with, snapshot callbacks, and optional defs
 * @returns A RecommendationSystem with evaluate/apply/dismiss lifecycle and event hooks
 *
 * @example
 * ```ts
 * const recs = createRecommendationSystem({
 *   id: 'advisor',
 *   cycle: gameLoop,
 *   cycleLog: myCycleLog,
 *   bestOf: myBestOf,
 *   // Snapshots are opaque `State`; keep one shape across these callbacks
 *   // and bestOf's captureStrategy.
 *   getCurrentSnapshot: () => currentLoadout.snapshot(),
 *   applySnapshot: (snap) => currentLoadout.restore(snap),
 *   // Scores compare raw across defs: log10 of gold/s against log10 of xp.
 *   defs: [
 *     createBestReplayDef('gold'),
 *     createGoalDef({ id: 'max-xp', metric: 'xp' }),
 *   ],
 * });
 *
 * // Advisory mode (T5 Advisor): surface recommendation in UI
 * recs.on('recommended', (rec) => {
 *   showAdvisorPanel(rec.rationale.summary, rec.rationale.metrics);
 * });
 *
 * // Optimizer mode (T6): auto-apply best config each cycle
 * recs.autoApply.value = true;
 * ```
 */
export function createRecommendationSystem(
  options: RecommendationSystemOptions,
): RecommendationSystem {
  const {
    id,
    cycle,
    cycleLog,
    bestOf,
    getCurrentSnapshot,
    applySnapshot,
    defs: initialDefs,
    getState,
  } = options;

  // --- Persistence ---
  const contextId = resolveSystemContextId(
    id,
    'recommendation',
    () => `recSystem_${recSystemCounter++}`,
  );
  const { storedRecommendation, autoApply } = withPersistentContext(contextId, () => ({
    storedRecommendation: persistent<SerializedRecommendation | null>(null, {
      name: 'storedRecommendation',
      lifetime: true,
    }),
    autoApply: persistent<boolean>(false, { name: 'autoApply', lifetime: true }),
  }));

  const handle = createEmitHandle<RecommendationSystemEvents>();

  // --- Def registry ---
  const registeredDefs: RecommendationDef[] = [...(initialDefs ?? [])];

  // --- Deserialized view ---
  const lastRecommendation = computed<Recommendation | null>(() => {
    const raw = storedRecommendation.value;
    return raw ? deserialize(raw) : null;
  });

  // --- BestOf resolution ---
  const resolveBestOf = typeof bestOf === 'function' ? bestOf : () => bestOf;

  // --- Core evaluation ---
  function buildContext(): RecommendationContext | null {
    const resolved = resolveBestOf();
    if (!resolved) return null;
    return {
      cycleLog,
      bestOf: resolved,
      cycle,
      currentSnapshot: getCurrentSnapshot(),
      state: getState?.() ?? {},
    };
  }

  function evaluate(): Recommendation | null {
    if (registeredDefs.length === 0) return null;

    const ctx = buildContext();
    if (!ctx) return null;

    const applicable = registeredDefs.filter((s) => s.canApply(ctx));
    if (applicable.length === 0) return null;

    // Score and pick highest (first-registered wins ties via strict >)
    let winner = applicable[0];
    let bestScore = winner.score(ctx);
    for (let i = 1; i < applicable.length; i++) {
      const s = applicable[i];
      const sc = s.score(ctx);
      if (sc > bestScore) {
        winner = s;
        bestScore = sc;
      }
    }

    const result = winner.recommend(ctx);
    const rec: Recommendation = {
      strategyId: winner.id,
      snapshot: result.snapshot,
      rationale: result.rationale,
      timestamp: Date.now(),
      applied: false,
    };

    storedRecommendation.value = serialize(rec);
    handle.emit('recommended', rec);

    if (autoApply.value) {
      applySnapshot(rec.snapshot);
      // Clone rather than mutate: `rec` was already handed to 'recommended'
      // listeners, and the manual apply() path clones too. Mutating here would
      // flip `applied` under a retained 'recommended' payload only in auto mode.
      const appliedRec = { ...rec, applied: true };
      storedRecommendation.value = serialize(appliedRec);
      handle.emit('applied', appliedRec);
      return appliedRec;
    }

    return rec;
  }

  // --- Cycle wiring ---
  const unsubAfterRestart = cycle.on('afterRestart', () => {
    evaluate();
  });

  // --- Public API ---
  const system: RecommendationSystem = {
    lastRecommendation,
    autoApply,
    get defs() {
      return registeredDefs as readonly RecommendationDef[];
    },

    register(def: RecommendationDef) {
      if (registeredDefs.some((s) => s.id === def.id)) return;
      registeredDefs.push(def);
    },

    unregister(defId: string) {
      const idx = registeredDefs.findIndex((s) => s.id === defId);
      if (idx >= 0) registeredDefs.splice(idx, 1);
    },

    evaluate,

    apply() {
      const rec = lastRecommendation.value;
      if (!rec || rec.applied) return;
      applySnapshot(rec.snapshot);
      const updated = { ...rec, applied: true };
      storedRecommendation.value = serialize(updated);
      handle.emit('applied', updated);
    },

    dismiss() {
      if (storedRecommendation.value === null) return;
      storedRecommendation.value = null;
      handle.emit('dismissed');
    },

    on: handle.on,

    dispose() {
      unsubAfterRestart();
    },
  };
  return attachContextReset(system, contextId);
}
