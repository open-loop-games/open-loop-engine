/**
 * Built-in recommendation defs — common inter-cycle patterns
 *
 * Sugar factory for the most common recommendation pattern found across
 * incremental games with cycle mechanics:
 *
 * - {@link createBestReplayDef} — "replay the best-known config for this metric"
 *   (Cavernous II loadBestRoute, Melvor Idle combat loadouts), optionally
 *   gated on a goal threshold (Spell Compiler farming goals)
 *
 * A thin wrapper over {@link BestOf} data. Games with more complex needs
 * (adaptive responses, trend detection, route generation) implement custom
 * defs against the {@link RecommendationDef} interface.
 *
 * @see {@link createRecommendationSystem} for the system these register with
 * @see {@link createBestOf} for the data source these read from
 *
 * @cluster recommendation
 */

import { Decimal, type DecimalSource } from '@/primitives/decimal';
import type { RecommendationDef, RecommendationContext } from './recommendation';
import type { BestOfEntry } from './best-of';

// === TYPES ===

/** Options for {@link createBestReplayDef} */
export interface BestReplayDefOptions {
  /** Override the def id. Default: `best-replay:${metricKey}` */
  id?: string;
  /**
   * Minimum completed cycles before this def becomes applicable.
   * Default: 1 (needs at least one recorded best).
   */
  minCycles?: number;
  /**
   * Minimum best value (the metric's observed cycle delta) before this def
   * becomes applicable — a goal the player must have reached once.
   */
  threshold?: DecimalSource;
}

// === HELPERS ===

/**
 * Bounded, order-preserving arbitration score for an unbounded game quantity.
 * `Decimal.toNumber()` overflows to `Infinity` above ~1e308 — and
 * `Decimal.isFinite()` stays true there — so raw `.toNumber()` scores collapse
 * every large config to `Infinity`, degenerating arbitration to registration
 * order across the exact range this engine exists to support. `log10` of the
 * magnitude stays finite and monotonic, preserving the ranking.
 */
function magnitudeScore(x: DecimalSource): number {
  return Decimal.max(x, 1).log10().toNumber();
}

/** A cycle's per-second rate; a zero-elapsed cycle has none and rates as 0. */
function ratePerSecond(value: DecimalSource, elapsed: number): Decimal {
  return elapsed > 0 ? Decimal.div(value, elapsed) : Decimal.dZero;
}

// === FACTORIES ===

/**
 * Create a def that replays the configuration that produced the best value
 * for a given metric. The simplest recommendation pattern — just load
 * whatever worked best last time.
 *
 * Scores the log10 improvement of the metric's best over the last cycle, in
 * the metric's {@link BestOfMetricDef.mode}: the projected (else observed)
 * value for `'absolute'`, the per-second rate for `'perSecond'`. A best the
 * last cycle matched scores 0 and stays applicable.
 *
 * Requires that {@link BestOf} was created with a `captureStrategy` callback
 * so that strategy snapshots are recorded alongside best entries.
 *
 * @param metricKey - The BestOf metric key to optimize for
 * @param options - Optional id override, minimum cycle count and goal threshold
 * @returns A {@link RecommendationDef} ready to register
 *
 * @example
 * ```ts
 * const recs = createRecommendationSystem({
 *   // ...
 *   defs: [
 *     createBestReplayDef('gold'),
 *     createBestReplayDef('xp', { minCycles: 3 }),
 *     // Quiet until the best run has produced 1000 damage.
 *     createBestReplayDef('damage', { id: 'goal:damage', threshold: 1000 }),
 *   ],
 * });
 * ```
 */
export function createBestReplayDef(
  metricKey: string,
  options?: BestReplayDefOptions,
): RecommendationDef {
  const strategyId = options?.id ?? `best-replay:${metricKey}`;
  const minCycles = options?.minCycles ?? 1;
  const threshold = options?.threshold;

  function getValidEntry(ctx: RecommendationContext): BestOfEntry | null {
    const entry = ctx.bestOf.entries.value[metricKey];
    if (!entry) return null;
    if (entry.status !== 'valid') return null;
    if (entry.strategySnapshot == null) return null;
    return entry;
  }

  function getLastCycle(ctx: RecommendationContext): { delta: Decimal; elapsed: number } {
    const history = ctx.cycleLog.history.value;
    const lastEntry = history[history.length - 1];
    const lastDelta = lastEntry?.deltas.find((d) => d.key === metricKey);
    return { delta: lastDelta?.delta ?? Decimal.dZero, elapsed: lastEntry?.elapsed ?? 0 };
  }

  return {
    id: strategyId,

    canApply(ctx: RecommendationContext): boolean {
      if (ctx.cycle.count.value < minCycles) return false;
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
          summary: `Replay best ${metricKey} config (${entry.value.toString()} in ${entry.elapsed.toFixed(1)}s, cycle #${entry.cycleNumber})`,
        },
      };
    },
  };
}
