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
 * `Recommender` is the inter-cycle sibling of {@link FillStrategy}:
 * FillStrategy picks the next action *within* a cycle; recommendation defs
 * pick the configuration *between* cycles.
 *
 * @see {@link createCycleLog} for the per-cycle metric source
 * @see {@link createBestOf} for per-metric best tracking with snapshots
 * @see {@link createCycle} for the lifecycle this wires into
 * @see ./recommenders.ts for built-in recommender factories
 * @see {@link createRuleAdvisor} for the intra-session sibling — same advisory
 *   shape, but re-fired on consumer signals (rule edits, encounter changes)
 *   instead of `cycle.afterEnd`, and emits a ranked list of independent
 *   suggestions rather than one winning configuration
 */

import { computed, type ComputedRef } from 'vue';
import type { DecimalSource } from '@/primitives/decimal';
import {
  persistent,
  withPersistentContext,
  resolveSystemPersistentContextId,
  type Persistent,
  type Serializable,
} from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { attachPersistentContextReset } from '@/core/resettable';
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
  currentSnapshot: Serializable;
  /** Consumer-provided game state for strategy evaluation, from `getGameState()` */
  gameState: Record<string, unknown>;
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
  recommenderId: string;
  /** Per-metric comparison: current performance vs projected with recommended config */
  metrics: Record<string, RecommendationMetricComparison>;
  /** Human-readable summary for UI display (consumer-provided via def) */
  summary: string;
}

/** The output of a def's `recommend()` method */
export interface RecommendationResult {
  /** The proposed configuration to apply next cycle (opaque to the engine) */
  snapshot: Serializable;
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
export interface Recommender {
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
   * system must score on one scale. The built-in `createBestReplayRecommender` scores
   * log10 improvement: log10 of the metric's best minus log10 of the last
   * cycle's, each magnitude floored at 1, in the metric's BestOf mode (value
   * for `'absolute'`, rate for `'perSecond'`). A custom def sharing a system
   * with it should score on that scale.
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
  recommenderId: string;
  /** The proposed configuration snapshot */
  snapshot: Serializable;
  /** Structured explanation data */
  rationale: RecommendationRationale;
  /** When this was generated (Unix ms) */
  timestamp: number;
  /** Whether this has been applied (auto or manual) */
  applied: boolean;
}

/** Serialized form stored in persistent — DecimalSource values as strings */
interface SerializedRecommendation {
  recommenderId: string;
  snapshot: Serializable;
  rationale: {
    recommenderId: string;
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

  /** The Cycle whose `afterEnd` event triggers evaluation */
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
  getCurrentSnapshot: () => Serializable;

  /**
   * Called to apply a recommended snapshot to the live game state.
   * Only called when `autoApply` is enabled or the consumer calls `.apply()`.
   */
  applySnapshot: (snapshot: Serializable) => void;

  /**
   * Definitions to register at construction time; a repeated `id` throws.
   * Additional defs can be added later via `.register()`.
   */
  recommenders?: Recommender[];

  /**
   * Called each `evaluate()` to provide game-specific state for def
   * evaluation. Populates {@link RecommendationContext.gameState}.
   */
  getGameState?: () => Record<string, unknown>;
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
  readonly recommenders: readonly Recommender[];

  /**
   * Register an additional def at runtime. Throws if a def with the same
   * `id` is already registered; `unregister` it first to replace it.
   */
  register(recommender: Recommender): void;

  /** Remove a def by id. No-op if not found. */
  unregister(recommenderId: string): void;

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
   * Called automatically on `cycle.on('afterEnd')` and can also be called manually.
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

  /**
   * Unsubscribe from the cycle's `afterEnd` event. The stored
   * recommendation and `autoApply` stay registered and keep saving, so building
   * a system under the same id again takes a new engine.
   */
  dispose(): void;
}

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
    recommenderId: rec.recommenderId,
    snapshot: rec.snapshot,
    rationale: {
      recommenderId: rec.rationale.recommenderId,
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
    recommenderId: raw.recommenderId,
    snapshot: raw.snapshot,
    rationale: {
      recommenderId: raw.rationale.recommenderId,
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
 *   // and bestOf's captureConfig.
 *   getCurrentSnapshot: () => currentLoadout.snapshot(),
 *   applySnapshot: (snap) => currentLoadout.restore(snap),
 *   // Each def scores log10 improvement of its metric's best over the
 *   // last cycle, so the metric with the most ground to recover wins.
 *   defs: [
 *     createBestReplayRecommender('gold'),
 *     createBestReplayRecommender('xp', { threshold: 100 }),
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
    recommenders: initialRecommenders,
    getGameState: getState,
  } = options;

  // --- Persistence ---
  const contextId = resolveSystemPersistentContextId(id, 'recommendation');
  const { storedRecommendation, autoApply } = withPersistentContext(contextId, () => ({
    storedRecommendation: persistent<SerializedRecommendation | null>(null, {
      name: 'storedRecommendation',
      lifetime: true,
    }),
    autoApply: persistent<boolean>(false, { name: 'autoApply', lifetime: true }),
  }));

  const handle = createEmitHandle<RecommendationSystemEvents>();

  // --- Def registry ---
  const registeredRecommenders: Recommender[] = [];
  function registerRecommender(def: Recommender): void {
    if (registeredRecommenders.some((s) => s.id === def.id)) {
      throw new Error(
        `RecommendationSystem "${contextId}": duplicate recommendation def id "${def.id}". Unregister the existing def before registering its replacement.`,
      );
    }
    registeredRecommenders.push(def);
  }
  for (const recommender of initialRecommenders ?? []) registerRecommender(recommender);

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
      gameState: getState?.() ?? {},
    };
  }

  function evaluate(): Recommendation | null {
    if (registeredRecommenders.length === 0) return null;

    const ctx = buildContext();
    if (!ctx) return null;

    const applicable = registeredRecommenders.filter((s) => s.canApply(ctx));
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
      recommenderId: winner.id,
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
  const unsubAfterEnd = cycle.on('afterEnd', () => {
    evaluate();
  });

  // --- Public API ---
  const system: RecommendationSystem = {
    lastRecommendation,
    autoApply,
    get recommenders() {
      return registeredRecommenders as readonly Recommender[];
    },

    register: registerRecommender,

    unregister(defId: string) {
      const idx = registeredRecommenders.findIndex((s) => s.id === defId);
      if (idx >= 0) registeredRecommenders.splice(idx, 1);
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
      unsubAfterEnd();
    },
  };
  return attachPersistentContextReset(system, contextId);
}
