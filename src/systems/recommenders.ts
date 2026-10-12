/**
 * Built-in recommenders — common between-run patterns
 *
 * A shorthand factory for a common recommendation shape in incremental games
 * with runs:
 *
 * - {@link createBestReplayRecommender} — "replay the best-known configuration
 *   for this metric" (a best route, a combat loadout), optionally blocked
 *   until a threshold is reached
 *
 * A thin wrapper over {@link BestOf} data. Games with more complex needs
 * (adaptive responses, trend detection, route generation) implement their
 * own recommenders against the {@link Recommender} interface.
 *
 * @see {@link createRecommendationSystem} for the system these register with
 * @see {@link createBestOf} for the data source these read from
 *
 * @cluster recommendation
 */

import { Decimal, type DecimalSource } from '@/primitives/decimal';
import type { Recommender, RecommendationContext } from './recommendation';
import type { BestOfEntry } from './best-of';

// === TYPES ===

/** Options for {@link createBestReplayRecommender} */
export interface BestReplayRecommenderOptions {
  /** The recommender id. Default: `best-replay:${metricKey}` */
  id?: string;
  /**
   * Minimum completed runs before this recommender is applicable.
   * Default: 1 (needs at least one recorded best).
   */
  minRuns?: number;
  /**
   * Minimum best value (the metric's observed per-run delta) before this
   * recommender is applicable: a threshold the player must have reached once.
   */
  threshold?: DecimalSource;
}

// === HELPERS ===

/**
 * Bounded, order-preserving arbitration score for an unbounded game quantity.
 * `Decimal.toNumber()` overflows to `Infinity` above ~1e308 — and
 * `Decimal.isFinite()` stays true there — so raw `.toNumber()` scores collapse
 * every large configuration to `Infinity`, degenerating arbitration to registration
 * order across the exact range this engine exists to support. `log10` of the
 * magnitude stays finite and monotonic, preserving the ranking.
 */
function magnitudeScore(x: DecimalSource): number {
  return Decimal.max(x, 1).log10().toNumber();
}

/** A run's per-second rate; a run with zero elapsed time has none, so its rate is 0. */
function ratePerSecond(value: DecimalSource, elapsed: number): Decimal {
  return elapsed > 0 ? Decimal.div(value, elapsed) : Decimal.dZero;
}

// === FACTORIES ===

/**
 * Create a recommender that replays the configuration that produced the best
 * value for a given metric. The simplest recommendation shape — load
 * whatever worked best before.
 *
 * Scores the log10 improvement of the metric's best over the last run, in
 * the metric's {@link BestOfMetricDef.mode}. That is the projected (else
 * observed) value for `'absolute'`, and the per-second rate for `'perSecond'`. A best the
 * last run matched scores 0 and stays applicable.
 *
 * Requires that {@link BestOf} was created with a `captureConfig` option, so
 * configuration snapshots are recorded beside best entries.
 *
 * @param metricKey - The BestOf metric key to optimize for
 * @param options - Optional id, minimum run count and threshold
 * @returns A {@link Recommender} ready to register
 *
 * @example
 * ```ts
 * const recs = createRecommendationSystem({
 *   // ...
 *   recommenders: [
 *     createBestReplayRecommender('gold'),
 *     createBestReplayRecommender('xp', { minRuns: 3 }),
 *     // Quiet until the best run has produced 1000 damage.
 *     createBestReplayRecommender('damage', { id: 'goal:damage', threshold: 1000 }),
 *   ],
 * });
 * ```
 */
export function createBestReplayRecommender(
  metricKey: string,
  options?: BestReplayRecommenderOptions,
): Recommender {
  const recommenderId = options?.id ?? `best-replay:${metricKey}`;
  const minRuns = options?.minRuns ?? 1;
  const threshold = options?.threshold;

  function getValidEntry(ctx: RecommendationContext): BestOfEntry | null {
    const entry = ctx.bestOf.entries.value[metricKey];
    if (!entry) return null;
    if (entry.status !== 'valid') return null;
    if (entry.configSnapshot == null) return null;
    return entry;
  }

  function getLastCycle(ctx: RecommendationContext): { delta: Decimal; elapsed: number } {
    const history = ctx.cycleLog.history.value;
    const lastEntry = history[history.length - 1];
    const lastDelta = lastEntry?.deltas.find((d) => d.key === metricKey);
    return { delta: lastDelta?.delta ?? Decimal.dZero, elapsed: lastEntry?.elapsed ?? 0 };
  }

  return {
    id: recommenderId,

    canApply(ctx: RecommendationContext): boolean {
      if (ctx.cycle.count.value < minRuns) return false;
      const entry = getValidEntry(ctx);
      if (!entry) return false;
      return threshold == null || Decimal.gte(entry.value, threshold);
    },

    score(ctx: RecommendationContext): number {
      const entry = getValidEntry(ctx)!;
      const last = getLastCycle(ctx);
      if (ctx.bestOf.metrics[metricKey]?.mode === 'perSecond') {
        const best = entry.elapsed > 0 ? entry.perSecond : Decimal.dZero;
        return magnitudeScore(best) - magnitudeScore(ratePerSecond(last.delta, last.elapsed));
      }
      return magnitudeScore(entry.projected ?? entry.value) - magnitudeScore(last.delta);
    },

    recommend(ctx: RecommendationContext) {
      const entry = getValidEntry(ctx)!;

      const current = getLastCycle(ctx).delta;
      const projected = entry.projected ?? entry.value;
      const delta = Decimal.sub(projected, current);

      return {
        snapshot: entry.configSnapshot!,
        rationale: {
          recommenderId,
          metrics: {
            [metricKey]: {
              current,
              projected,
              delta,
            },
          },
          description: `Replay best ${metricKey} configuration (${entry.value.toString()} in ${entry.elapsed.toFixed(1)}s, run #${entry.runNumber})`,
        },
      };
    },
  };
}
