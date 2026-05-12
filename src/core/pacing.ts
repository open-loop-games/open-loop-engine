/**
 * Flow-channel classification + closed-form beat-timing math — maps beat
 * duration to Csikszentmihalyi's Flow Theory engagement bands, and computes
 * the T(n) = Cost(n)/Production(n) snapshot used by balance/devtools to
 * label arbitrary (cost, rate, level) samples without booting a live engine.
 *
 * The flow-channel thresholds come from the incremental-games research corpus
 * (`open-loop-research/patterns/cross-pattern-properties/automation.md`)
 * and match Flow Theory's original engagement bands (Csikszentmihalyi 1990):
 *
 * - **arousal** `[5, 30)` — learning phase, building engagement
 * - **flow** `[30, 120)` — optimal engagement zone (target)
 * - **flow-upper** `[120, 300)` — extended flow, beginning to slow
 * - **boredom** `[300, 900)` — disengagement risk
 * - **frustration** `[900, 3600)` — high disengagement
 * - **breakdown** `[3600, ∞)` — player abandonment likely
 */

import { bn, Decimal, type DecimalSource } from '@/primitives';

/**
 * Flow-channel classification based on Csikszentmihalyi's Flow Theory (1990).
 * Maps beat duration to a player engagement band.
 */
export type FlowChannel =
  | 'arousal'
  | 'flow'
  | 'flow-upper'
  | 'boredom'
  | 'frustration'
  | 'breakdown';

/**
 * Classify a beat duration (in seconds) into its flow channel.
 *
 * Boundaries are half-open `[min, max)`: a beat of exactly `30s` is `'flow'`,
 * not `'arousal'`. Negative or zero durations classify as `'arousal'`.
 *
 * @param beatTimeSeconds - Beat duration in seconds
 * @returns Flow channel classification
 *
 * @example
 * ```ts
 * classifyFlowChannel(60);   // 'flow'       — optimal
 * classifyFlowChannel(10);   // 'arousal'    — learning
 * classifyFlowChannel(600);  // 'boredom'    — warning
 * classifyFlowChannel(1800); // 'frustration'— critical
 * ```
 */
export function classifyFlowChannel(beatTimeSeconds: number): FlowChannel {
  if (beatTimeSeconds < 30) return 'arousal';
  if (beatTimeSeconds < 120) return 'flow';
  if (beatTimeSeconds < 300) return 'flow-upper';
  if (beatTimeSeconds < 900) return 'boredom';
  if (beatTimeSeconds < 3600) return 'frustration';
  return 'breakdown';
}

/**
 * Get flow-channel threshold boundaries as `[min, max)` pairs in seconds.
 *
 * Useful for rendering boundary markers on a beat chart, or for consumer
 * code that needs to quantize beats into channels without re-calling the
 * classifier per value.
 */
export function getFlowChannelBoundaries(): Record<FlowChannel, [number, number]> {
  return {
    arousal: [5, 30],
    flow: [30, 120],
    'flow-upper': [120, 300],
    boredom: [300, 900],
    frustration: [900, 3600],
    breakdown: [3600, Infinity],
  };
}

/**
 * Cost scaling family for {@link calculateBeatTiming}. Determines how
 * `Cost(n)` grows with level.
 */
export type CostScalingType = 'exponential' | 'linear' | 'polynomial';

/** Parameters for {@link calculateBeatTiming}. */
export interface BeatTimingParams {
  /** Base cost of the first purchase (level 1). */
  baseCost: DecimalSource;
  /** Cost multiplier per level (e.g. `1.15` for Cookie Clicker). */
  costMultiplier: DecimalSource;
  /** Base production rate (resources per second). */
  baseProduction: DecimalSource;
  /** Current quantity owned (affects cumulative production). */
  quantity: DecimalSource;
  /** Target level to calculate timing for. */
  level: number;
  /** Cost scaling family (default: `'exponential'`). */
  scalingType?: CostScalingType;
}

/**
 * Closed-form beat timing: time (in seconds) to afford the next purchase
 * at level `n`, given a fully-stacked per-unit production rate.
 *
 * `T(n) = Cost(n) / Production(n)` where `Production(n) = baseProduction × quantity`.
 *
 * For exponential scaling, `Cost(n) = baseCost × costMultiplier^level`.
 * For linear, `Cost(n) = baseCost × (1 + (costMultiplier - 1) × level)`.
 * For polynomial, `Cost(n) = baseCost × level^costMultiplier`.
 *
 * Used by devtools/balance views that need a pure-math check against the
 * live engine (whose `producer.purchaseBeatSeconds` applies the full
 * modifier chain). Returns `Infinity` when production is zero.
 *
 * @example
 * ```ts
 * // Cookie Clicker: 150 grandmas at level 10, base cost 100, ×1.15 per level
 * const beat = calculateBeatTiming({
 *   baseCost: 100,
 *   costMultiplier: 1.15,
 *   baseProduction: 1,
 *   quantity: 150,
 *   level: 10,
 * });
 * ```
 */
export function calculateBeatTiming(params: BeatTimingParams): Decimal {
  const {
    baseCost,
    costMultiplier,
    baseProduction,
    quantity,
    level,
    scalingType = 'exponential',
  } = params;

  const cost = bn(baseCost);
  const multiplier = bn(costMultiplier);
  const rate = bn(baseProduction);
  const qty = bn(quantity);

  let costAtLevel: Decimal;
  if (scalingType === 'exponential') {
    costAtLevel = cost.mul(multiplier.pow(level));
  } else if (scalingType === 'linear') {
    costAtLevel = cost.mul(new Decimal(1).add(multiplier.sub(1).mul(level)));
  } else if (scalingType === 'polynomial') {
    costAtLevel = cost.mul(bn(level).pow(multiplier));
  } else {
    throw new Error(`Unsupported scaling type: ${String(scalingType)}`);
  }

  const production = rate.mul(qty);
  if (production.lte(0)) {
    return new Decimal(Infinity);
  }
  return costAtLevel.div(production);
}
