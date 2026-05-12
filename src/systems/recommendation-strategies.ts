/**
 * Built-in recommendation strategies — common inter-loop patterns
 *
 * Sugar factories for the two most common recommendation patterns found
 * across incremental games with loop mechanics:
 *
 * - {@link createBestReplayStrategy} — "replay the best-known config for this metric"
 *   (Cavernous II loadBestRoute, Melvor Idle combat loadouts)
 *
 * - {@link createGoalStrategy} — "optimize for a specific metric goal"
 *   (Spell Compiler farming goals, NGU Idle energy allocation)
 *
 * These are thin wrappers over {@link BestOf} data. Games with more complex
 * needs (adaptive responses, trend detection, route generation) implement
 * custom strategies against the {@link RecommendationStrategyDef} interface.
 *
 * @see {@link createRecommendationSystem} for the system these register with
 * @see {@link createBestOf} for the data source these read from
 *
 * @cluster recommendation
 */

import { Decimal, type DecimalSource } from '@/primitives/decimal';
import type { RecommendationStrategyDef, RecommendationContext } from './recommendation';
import type { BestOfEntry } from './best-of';

// === TYPES ===

/** Options for {@link createBestReplayStrategy} */
export interface BestReplayStrategyOptions {
  /** Override the strategy id. Default: `best-replay:${metricKey}` */
  id?: string;
  /**
   * Minimum completed loops before this strategy becomes applicable.
   * Default: 1 (needs at least one recorded best).
   */
  minLoops?: number;
}

/** Options for {@link createGoalStrategy} */
export interface GoalStrategyOptions {
  /** Strategy id (required — you may register multiple goal strategies) */
  id: string;
  /** The BestOf metric key to optimize for */
  metric: string;
  /**
   * `'maximize'` — prefer the config with the highest value (default).
   * `'minimize'` — prefer the config with the lowest elapsed time for a given threshold.
   */
  prefer?: 'maximize' | 'minimize';
  /**
   * Minimum acceptable value for the metric. Strategy is not applicable
   * until at least one BestOf entry meets this threshold.
   */
  threshold?: DecimalSource;
}

// === FACTORIES ===

// --- Best replay ---

/**
 * Create a strategy that replays the configuration that produced the best
 * value for a given metric. The simplest recommendation pattern — just
 * load whatever worked best last time.
 *
 * Requires that {@link BestOf} was created with a `captureStrategy` callback
 * so that strategy snapshots are recorded alongside best entries.
 *
 * @param metricKey - The BestOf metric key to optimize for
 * @param options - Optional id override and minimum loop count
 * @returns A {@link RecommendationStrategyDef} ready to register
 *
 * @example
 * ```ts
 * const recs = createRecommendationSystem({
 *   // ...
 *   strategies: [
 *     createBestReplayStrategy('gold'),
 *     createBestReplayStrategy('xp', { minLoops: 3 }),
 *   ],
 * });
 * ```
 */
export function createBestReplayStrategy(
  metricKey: string,
  options?: BestReplayStrategyOptions,
): RecommendationStrategyDef {
  const strategyId = options?.id ?? `best-replay:${metricKey}`;
  const minLoops = options?.minLoops ?? 1;

  function getValidEntry(ctx: RecommendationContext): BestOfEntry | null {
    const entry = ctx.bestOf.entries.value[metricKey];
    if (!entry) return null;
    if (entry.status !== 'valid') return null;
    if (entry.strategySnapshot == null) return null;
    return entry;
  }

  return {
    id: strategyId,

    canApply(ctx: RecommendationContext): boolean {
      if (ctx.loop.count.value < minLoops) return false;
      return getValidEntry(ctx) !== null;
    },

    score(ctx: RecommendationContext): number {
      const entry = getValidEntry(ctx)!;
      // Use perSecond when finite for natural efficiency-based arbitration
      // across multiple BestReplay strategies for different metrics
      if (entry.perSecond.isFinite()) return entry.perSecond.toNumber();
      return entry.value.toNumber();
    },

    recommend(ctx: RecommendationContext) {
      const entry = getValidEntry(ctx)!;

      const lastEntry = ctx.loopLog.history.value[ctx.loopLog.history.value.length - 1];
      const lastDelta = lastEntry?.deltas.find((d) => d.key === metricKey);
      const current = lastDelta?.delta ?? Decimal.dZero;
      const projected = entry.projected ?? entry.value;
      const delta = Decimal.sub(projected, current);

      return {
        snapshot: entry.strategySnapshot!,
        rationale: {
          strategyId,
          metrics: {
            [metricKey]: {
              current,
              projected,
              delta,
            },
          },
          summary: `Replay best ${metricKey} config (${entry.value} in ${entry.elapsed.toFixed(1)}s, loop #${entry.loopNumber})`,
        },
      };
    },
  };
}

// --- Goal ---

// TODO(expansion): zero direct fork adoption; shipped on faith because the
// goal-directed shape is corpus-validated. Graduate or delete based on real usage.

/**
 * Create a strategy that selects the configuration optimizing for a specific
 * metric goal. More opinionated than {@link createBestReplayStrategy} — it
 * supports goal direction (maximize value vs minimize time) and threshold gating.
 *
 * @param options - Goal definition with metric, direction, and optional threshold
 * @returns A {@link RecommendationStrategyDef} ready to register
 *
 * @example
 * ```ts
 * const recs = createRecommendationSystem({
 *   // ...
 *   strategies: [
 *     createGoalStrategy({ id: 'farm-gold', metric: 'gold', prefer: 'maximize' }),
 *     createGoalStrategy({
 *       id: 'speed-clear', metric: 'damage', prefer: 'minimize',
 *       threshold: 1000,  // only suggest when damage > 1000 is achievable
 *     }),
 *   ],
 * });
 * ```
 */
export function createGoalStrategy(options: GoalStrategyOptions): RecommendationStrategyDef {
  const { id, metric, prefer = 'maximize', threshold } = options;

  function getEntry(ctx: RecommendationContext): BestOfEntry | null {
    return ctx.bestOf.entries.value[metric] ?? null;
  }

  return {
    id,

    canApply(ctx: RecommendationContext): boolean {
      const entry = getEntry(ctx);
      if (!entry) return false;
      if (threshold != null && Decimal.lt(entry.value, threshold)) return false;
      return true;
    },

    score(ctx: RecommendationContext): number {
      const entry = getEntry(ctx)!;
      if (prefer === 'minimize') {
        // Lower elapsed = better; negate so higher score = better
        return -entry.elapsed;
      }
      return entry.value.toNumber();
    },

    recommend(ctx: RecommendationContext) {
      const entry = getEntry(ctx)!;
      const snapshot = entry.strategySnapshot ?? ctx.currentSnapshot;

      const lastEntry = ctx.loopLog.history.value[ctx.loopLog.history.value.length - 1];
      const lastDelta = lastEntry?.deltas.find((d) => d.key === metric);
      const current = lastDelta?.delta ?? Decimal.dZero;
      const projected = entry.projected ?? entry.value;
      const delta = Decimal.sub(projected, current);

      const direction = prefer === 'maximize' ? 'highest' : 'fastest';
      return {
        snapshot,
        rationale: {
          strategyId: id,
          metrics: {
            [metric]: { current, projected, delta },
          },
          summary: `Goal: ${direction} ${metric} (best: ${entry.value} in ${entry.elapsed.toFixed(1)}s)`,
        },
      };
    },
  };
}
