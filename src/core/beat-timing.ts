/**
 * Closed-form beat-timing math — computes the `T(n) = Cost(n) / Production(n)`
 * snapshot used by balance/devtools to label arbitrary (cost, rate, level)
 * samples without booting a live engine.
 *
 * Pure algebra: no game-pattern opinions, no engine state, no reactive refs.
 * Three cost-scaling families (`exponential` / `linear` / `polynomial`) cover
 * the canonical incremental shapes.
 */

import { bn, Decimal, type DecimalSource } from '@/primitives';

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
