/**
 * Recommendation system — inter-loop arbitration across registered defs
 *
 * Composes LoopLog (per-loop metric history), BestOf (best-of-run records),
 * and Loop (lifecycle events) into a score-based recommendation surface.
 * Registered defs evaluate historical data and propose configurations for
 * the next loop; the system picks the highest-scoring winner.
 *
 * - {@link createRecommendationSystem} — sole factory, wires into Loop lifecycle
 *
 * Key features:
 * - Pluggable def registration with `canApply` / `score` / `recommend`
 * - Score-based arbitration across registered defs (highest wins)
 * - Persistent last recommendation with dismiss/apply lifecycle
 * - Auto-apply mode for full automation (T6 Optimizer pattern)
 * - Advisory mode for surfacing suggestions (T5 Advisor pattern)
 *
 * `RecommendationDef` is the inter-loop sibling of {@link FillStrategy}:
 * FillStrategy picks the next action *within* a loop; recommendation defs
 * pick the configuration *between* loops.
 *
 * @see {@link createLoopLog} for the per-loop metric source
 * @see {@link createBestOf} for per-metric best tracking with snapshots
 * @see {@link createLoop} for the lifecycle this wires into
 * @see ./recommendation-strategies.ts for built-in def factories
 * @see {@link createRuleAdvisor} for the intra-session sibling — same advisory
 *   shape, but re-fired on consumer signals (rule edits, encounter changes)
 *   instead of `loop.afterRestart`, and emits a ranked list of independent
 *   suggestions rather than one winning configuration
 */

import { computed, type ComputedRef } from 'vue';
import type { DecimalSource } from '@/primitives/decimal';
import {
  persistent,
  withPersistentContext,
  getCurrentContext,
  type Persistent,
  type State,
} from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import type { Loop } from './loop';
import type { LoopLog } from './loop-log';
import type { BestOf } from './best-of';

// === TYPES ===

/**
 * The evaluation context passed to every def's `canApply`, `score`,
 * and `recommend` methods. Built fresh each `evaluate()` call.
 */
export interface RecommendationContext {
  /** The LoopLog providing per-loop metric history */
  loopLog: LoopLog;
  /** The BestOf providing per-metric best records and snapshots */
  bestOf: BestOf;
  /** The Loop instance (access count, elapsed, etc.) */
  loop: Loop;
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
  /** The proposed configuration to apply next loop (opaque to the engine) */
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
  recommend: (recommendation: Recommendation) => void;
  /** Fired after a recommendation's snapshot is applied (auto or manual) */
  apply: (recommendation: Recommendation) => void;
  /** Fired after the last recommendation is dismissed */
  dismiss: () => void;
}

/** Configuration for {@link createRecommendationSystem} */
export interface RecommendationSystemOptions {
  /**
   * Persistence namespace. Falls back to surrounding context or auto-generated.
   * Explicit IDs are safer for save compatibility.
   */
  id?: string;

  /** The Loop whose `afterRestart` event triggers evaluation */
  loop: Loop;

  /** The LoopLog providing per-loop metric history */
  loopLog: LoopLog;

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
 * Evaluates registered defs after each loop restart, picks the
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
   * 5. Store as `lastRecommendation`, emit `'recommend'`
   * 6. If `autoApply`, call `applySnapshot` + emit `'apply'`
   *
   * Returns the produced {@link Recommendation} or `null` if no def applied
   * or the BestOf resolver returned `null` (no active context).
   * Called automatically on `loop.on('afterRestart')` and can also be called manually.
   */
  evaluate(): Recommendation | null;

  /**
   * Apply the `lastRecommendation`'s snapshot manually.
   * No-op if `lastRecommendation` is null or already applied. Emits `'apply'`.
   */
  apply(): void;

  /** Clear `lastRecommendation`, emit `'dismiss'`. No-op if already null. */
  dismiss(): void;

  /** Subscribe to recommendation system events */
  on: Emittable<RecommendationSystemEvents>['on'];

  /** Unsubscribe from the loop's `afterRestart` event */
  dispose(): void;
}

// === CONSTANTS ===

let recSystemCounter = 0;

// === INTERNAL HELPERS ===

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
 * each loop restart and surfaces or auto-applies the winning configuration.
 *
 * Composes LoopLog (metric history), BestOf (best configs), and Loop
 * (lifecycle) into a score-based recommendation surface. Defs are the
 * inter-loop sibling of FillStrategy: they pick *what configuration to
 * use next*, not what action to run within a loop.
 *
 * @param options - Loop/LoopLog/BestOf to compose with, snapshot callbacks, and optional defs
 * @returns A RecommendationSystem with evaluate/apply/dismiss lifecycle and event hooks
 *
 * @example
 * ```ts
 * const recs = createRecommendationSystem({
 *   id: 'advisor',
 *   loop: gameLoop,
 *   loopLog: myLoopLog,
 *   bestOf: myBestOf,
 *   getCurrentSnapshot: () => ({ loadout: currentLoadout.snapshot() }),
 *   applySnapshot: (snap) => currentLoadout.restore(snap.loadout),
 *   defs: [
 *     createBestReplayDef('gold'),
 *     createGoalDef({ id: 'max-xp', metric: 'xp' }),
 *   ],
 * });
 *
 * // Advisory mode (T5 Advisor): surface recommendation in UI
 * recs.on('recommend', (rec) => {
 *   showAdvisorPanel(rec.rationale.summary, rec.rationale.metrics);
 * });
 *
 * // Optimizer mode (T6): auto-apply best config each loop
 * recs.autoApply.value = true;
 * ```
 */
export function createRecommendationSystem(
  options: RecommendationSystemOptions,
): RecommendationSystem {
  const autoId = `recSystem_${recSystemCounter++}`;
  const {
    id,
    loop,
    loopLog,
    bestOf,
    getCurrentSnapshot,
    applySnapshot,
    defs: initialDefs,
    getState,
  } = options;

  // --- Persistence ---
  const contextId = id ?? getCurrentContext() ?? autoId;
  const { storedRecommendation, autoApply } = withPersistentContext(contextId, () => ({
    storedRecommendation: persistent<SerializedRecommendation | null>(null, {
      name: 'storedRecommendation',
    }),
    autoApply: persistent<boolean>(false, { name: 'autoApply' }),
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
      loopLog,
      bestOf: resolved,
      loop,
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
    handle.emit('recommend', rec);

    if (autoApply.value) {
      applySnapshot(rec.snapshot);
      // Clone rather than mutate: `rec` was already handed to 'recommend'
      // listeners, and the manual apply() path clones too. Mutating here would
      // flip `applied` under a retained 'recommend' payload only in auto mode.
      const appliedRec = { ...rec, applied: true };
      storedRecommendation.value = serialize(appliedRec);
      handle.emit('apply', appliedRec);
      return appliedRec;
    }

    return rec;
  }

  // --- Loop wiring ---
  const unsubAfterRestart = loop.on('afterRestart', () => {
    evaluate();
  });

  // --- Public API ---
  return {
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
      handle.emit('apply', updated);
    },

    dismiss() {
      if (storedRecommendation.value === null) return;
      storedRecommendation.value = null;
      handle.emit('dismiss');
    },

    on: handle.on,

    dispose() {
      unsubAfterRestart();
    },
  };
}

// === TYPE GUARDS ===
