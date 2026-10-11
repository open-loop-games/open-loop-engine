/**
 * Recommendation system — between-run arbitration across registered recommenders
 *
 * Combines CycleLog (per-run tracked metric history), BestOf (best-of
 * records) and Cycle (run-end events) into score-based recommendations.
 * Registered recommenders read past runs and propose a configuration for the
 * next run; the system picks the highest-scoring one.
 *
 * - {@link createRecommendationSystem} — sole factory; it subscribes to the cycle's `afterEnd`
 *
 * Key features:
 * - Recommender registration with `canApply` / `score` / `recommend`
 * - Score-based arbitration across registered recommenders (highest wins)
 * - Persistent last recommendation with dismiss/apply lifecycle
 * - Auto-apply mode for full automation
 * - Advisory mode, which presents a recommendation for the player to apply
 *
 * `Recommender` is the between-run sibling of {@link FillStrategy}: a fill
 * strategy picks the next sequencer item *within* a run; a recommender picks
 * the configuration *between* runs.
 *
 * @see {@link createCycleLog} for the per-run tracked metric source
 * @see {@link createBestOf} for per-metric best tracking with configuration snapshots
 * @see {@link createCycle} for the cycle whose run end triggers evaluation
 * @see ./recommenders.ts for built-in recommender factories
 * @see {@link createRuleAdvisor} for the sibling for use within a play
 *   session. It has the same advisory shape, but consumer triggers (rule
 *   edits, encounter changes) re-evaluate it instead of `cycle.afterEnd`. It returns a ranked list of
 *   independent suggestions, not one winning configuration.
 */

import { computed, type ComputedRef } from 'vue';
import type { DecimalSource } from '@/primitives/decimal';
import {
  persistent,
  withPersistentContext,
  disownPersistent,
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
 * The evaluation context passed to every recommender's `canApply`, `score`,
 * and `recommend` methods. Built fresh each `evaluate()` call.
 */
export interface RecommendationContext {
  /** The CycleLog providing per-run tracked metric history */
  cycleLog: CycleLog;
  /** The BestOf providing per-metric best records and configuration snapshots */
  bestOf: BestOf;
  /** The Cycle instance (access count, elapsed, etc.) */
  cycle: Cycle;
  /** Current game configuration snapshot, from `getCurrentSnapshot()` */
  currentSnapshot: Serializable;
  /** Consumer-provided game state for recommender evaluation, from `getGameState()` */
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
  /** Which recommender produced this recommendation */
  recommenderId: string;
  /** Per-metric comparison: current performance vs projected with the recommended configuration */
  metrics: Record<string, RecommendationMetricComparison>;
  /** Display text for the UI, written by the recommender */
  summary: string;
}

/** The output of a recommender's `recommend()` method */
export interface RecommendationResult {
  /** The proposed configuration to apply next run (opaque to the engine) */
  snapshot: Serializable;
  /** Structured explanation data */
  rationale: RecommendationRationale;
}

/**
 * A recommender. Consumers implement this interface and register it with
 * the system; the system scores registered recommenders and runs the winner.
 *
 * Evaluation order: `canApply` → `score` (if applicable) → `recommend` (winner only).
 */
export interface Recommender {
  /** Unique among a system's recommenders */
  id: string;
  /**
   * Returns `true` if this recommender can produce a meaningful
   * recommendation. Recommenders whose `canApply` returns `false` are
   * excluded from arbitration.
   */
  canApply: (ctx: RecommendationContext) => boolean;
  /**
   * Numeric score for arbitration. Higher wins. Only called when `canApply`
   * returns `true`. On ties, the first-registered recommender wins.
   *
   * Scores are compared raw across every registered recommender, so
   * recommenders sharing a system must score on one scale. The built-in
   * `createBestReplayRecommender` scores log10 improvement in the metric's
   * BestOf mode (value for `'absolute'`, rate for `'perSecond'`). That is
   * log10 of the metric's best minus log10 of the last run's. Each magnitude
   * is raised to 1 when it is below 1. A custom recommender sharing a system with it should score
   * on that scale.
   */
  score: (ctx: RecommendationContext) => number;
  /**
   * Produce the recommendation. Only called for the winning recommender
   * (highest score among applicable recommenders).
   */
  recommend: (ctx: RecommendationContext) => RecommendationResult;
}

/** A produced recommendation stored by the system */
export interface Recommendation {
  /** Which recommender produced this */
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

/** The serialized form the persistent ref stores; DecimalSource values as strings */
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
  /** Emitted after a new recommendation is produced by `evaluate()` */
  recommended: (recommendation: Recommendation) => void;
  /** Emitted after a recommendation's snapshot is applied (auto or manual) */
  applied: (recommendation: Recommendation) => void;
  /** Emitted after the last recommendation is dismissed */
  dismissed: () => void;
}

/** Options for {@link createRecommendationSystem} */
export interface RecommendationSystemOptions {
  /**
   * Persistent context id. Defaults to `${module}/recommendation` inside a
   * module; pass one when a module builds more than one.
   */
  id?: string;

  /** The Cycle whose `afterEnd` event triggers evaluation */
  cycle: Cycle;

  /** The CycleLog providing per-run tracked metric history */
  cycleLog: CycleLog;

  /**
   * The BestOf providing per-metric best records and configuration snapshots.
   *
   * Pass a fixed instance for a game with one BestOf, or a resolver for a
   * game with one per zone, encounter or area. The resolver is called each
   * `evaluate()`; return `null` to skip evaluation when none applies.
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
   * Recommenders to register at construction; a repeated `id` throws. Add
   * more later with `.register()`.
   */
  recommenders?: Recommender[];

  /**
   * Called each `evaluate()` to provide game-specific state for recommender
   * evaluation. Populates {@link RecommendationContext.gameState}.
   */
  getGameState?: () => Record<string, unknown>;
}

/**
 * A recommendation system instance — the returned object from
 * {@link createRecommendationSystem}.
 *
 * Evaluates registered recommenders after each run ends, and picks the
 * highest-scoring applicable one. It either presents that as an advisory
 * recommendation or auto-applies it.
 */
export interface RecommendationSystem {
  /**
   * The last produced recommendation, or null. Persistent: a save keeps it.
   * Cleared by `dismiss()`, replaced by each `evaluate()` that produces a winner.
   */
  readonly lastRecommendation: ComputedRef<Recommendation | null>;

  /**
   * When `true`, `evaluate()` automatically calls `applySnapshot` with the
   * winning recommendation's snapshot. Persistent toggle, defaults to `false`.
   * It is a player setting. So it and the stored recommendation are lifetime
   * refs, and survive a reset of the owning module.
   */
  readonly autoApply: Persistent<boolean>;

  /** Registered recommenders (ordered; first-registered wins on tie) */
  readonly recommenders: readonly Recommender[];

  /**
   * Register another recommender after construction. Throws if a recommender
   * with the same `id` is already registered; `unregister` it first to
   * replace it.
   */
  register(recommender: Recommender): void;

  /** Remove a recommender by id. No-op if not found. */
  unregister(recommenderId: string): void;

  /**
   * Run one full evaluation synchronously:
   * 1. Build context from the options' functions
   * 2. Filter recommenders via `canApply`
   * 3. Score and pick highest (ties: first-registered wins)
   * 4. Call `recommend()` on the winner
   * 5. Store as `lastRecommendation`, emit `'recommended'`
   * 6. If `autoApply`, call `applySnapshot` + emit `'applied'`
   *
   * Returns the produced {@link Recommendation}. Returns `null` if no
   * recommender applied, or the BestOf resolver returned `null` (none applies).
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
   * Unsubscribe from the cycle's `afterEnd` event. The stored recommendation
   * and `autoApply` become unowned: they keep saving, and a system built with
   * the same id in the same persistent context takes them over.
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
 * Create a recommendation system that evaluates registered recommenders
 * after each run ends, and presents or auto-applies the winning configuration.
 *
 * Combines CycleLog (tracked metric history), BestOf (best configurations)
 * and Cycle (run ends) into score-based recommendations. Recommenders are
 * the between-run sibling of fill strategies: they pick *the configuration
 * to use next*, not the next sequencer item within a run.
 *
 * @param options - The Cycle, CycleLog and BestOf to combine, the snapshot functions, and optional recommenders
 * @returns A RecommendationSystem with `evaluate` / `apply` / `dismiss` and events
 *
 * @example
 * ```ts
 * const recs = createRecommendationSystem({
 *   id: 'advisor',
 *   cycle: gameCycle,
 *   cycleLog: myCycleLog,
 *   bestOf: myBestOf,
 *   // Snapshots are opaque `Serializable` values; keep one shape across
 *   // these functions and bestOf's captureConfig.
 *   getCurrentSnapshot: () => currentLoadout.snapshot(),
 *   applySnapshot: (snap) => currentLoadout.restore(snap),
 *   // Each recommender scores the log10 improvement of its metric's best
 *   // over the last run, so the metric furthest behind its best wins.
 *   recommenders: [
 *     createBestReplayRecommender('gold'),
 *     createBestReplayRecommender('xp', { threshold: 100 }),
 *   ],
 * });
 *
 * // Advisory mode: present the recommendation in the UI
 * recs.on('recommended', (rec) => {
 *   showAdvisorPanel(rec.rationale.summary, rec.rationale.metrics);
 * });
 *
 * // Auto-apply mode: apply the best configuration after each run
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
      id: 'storedRecommendation',
      lifetime: true,
    }),
    autoApply: persistent<boolean>(false, { id: 'autoApply', lifetime: true }),
  }));

  const handle = createEmitHandle<RecommendationSystemEvents>();

  // --- Recommender registry ---
  const registeredRecommenders: Recommender[] = [];
  function registerRecommender(def: Recommender): void {
    if (registeredRecommenders.some((s) => s.id === def.id)) {
      throw new Error(
        `RecommendationSystem "${contextId}": duplicate recommender id "${def.id}". Unregister the existing recommender before registering its replacement.`,
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
      // handlers, and the manual apply() path clones too. Mutating here would
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
      disownPersistent(storedRecommendation);
      disownPersistent(autoApply);
    },
  };
  return attachPersistentContextReset(system, contextId);
}
