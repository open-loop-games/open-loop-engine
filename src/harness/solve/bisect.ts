/**
 * Bisection tuner — the default {@link Tuner} implementation.
 *
 * Auto-detects direction from `sampler(lo)` vs `sampler(hi)`. That costs
 * two calibration runs up front but removes a per-call decision the
 * caller would otherwise have to make correctly (and getting it wrong
 * silently gives a wrong answer). Forward slope = higher value → later
 * fire (cost-like knobs); inverted = higher value → earlier fire
 * (multiplier-like knobs).
 */

import type { TunerConfig, TunerResult } from './types';

/**
 * Binary-search 1-D tuner. Two calibration runs at `lo` and `hi` auto-detect
 * direction and check the target lies between them: an endpoint already
 * within `tolSec` is returned as is, and a target outside the calibrated
 * range returns the nearer endpoint with `bracketed: false` rather than
 * spending the iteration budget. Otherwise iteration halves the bracket
 * toward `targetSec`, returning early once the sample lands within `tolSec`.
 * If the iteration ceiling fires first, the closest-observed sample is
 * returned.
 *
 * @param config - {@link TunerConfig} — search bracket, target fire time,
 *   sampler, optional tolerance + iteration ceiling.
 * @returns {@link TunerResult} — the converged value, its sampled fire time,
 *   the iteration count, and the auto-detected direction.
 *
 * @example
 * ```ts
 * const result = bisectTuner({
 *   lo: 0.5,
 *   hi: 2.0,
 *   targetSec: 600,
 *   sampler: (mul) => simulateBeatFireTime({ producerCostMul: mul }),
 *   tolSec: 5,
 * });
 * // result.value ≈ the multiplier that makes beat-2 fire at 10:00
 * ```
 */
export function bisectTuner(config: TunerConfig): TunerResult {
  const { lo, hi, targetSec, sampler } = config;
  const tolSec = config.tolSec ?? 1;
  const maxIters = config.maxIters ?? 22;

  const tLo = sampler(lo);
  const tHi = sampler(hi);

  // Infinite = beat never fires at that value. That's "the threshold can't be
  // hit at this setting" — semantically a *late* fire (infinitely late), not
  // an early one. Both endpoints map ∞ → +∞ for direction detection. Forward
  // = higher value → later fire (cost-like); inverted = higher value → earlier
  // fire (multiplier/bonus-like).
  const tLoFinite = isFinite(tLo) ? tLo : Infinity;
  const tHiFinite = isFinite(tHi) ? tHi : Infinity;
  const direction: 'forward' | 'inverted' = tHiFinite >= tLoFinite ? 'forward' : 'inverted';

  const miss = (t: number): number =>
    Math.abs((isFinite(t) ? t : Number.MAX_SAFE_INTEGER) - targetSec);
  const nearer = miss(tHi) < miss(tLo) ? { value: hi, time: tHi } : { value: lo, time: tLo };
  if (isFinite(nearer.time) && miss(nearer.time) <= tolSec) {
    return { ...nearer, iterations: 0, direction, bracketed: true };
  }
  if (targetSec < Math.min(tLoFinite, tHiFinite) || targetSec > Math.max(tLoFinite, tHiFinite)) {
    return { ...nearer, iterations: 0, direction, bracketed: false };
  }

  let a = lo;
  let b = hi;
  let best = { value: (lo + hi) / 2, time: Infinity };
  for (let i = 1; i <= maxIters; i++) {
    const mid = (a + b) / 2;
    const t = sampler(mid);
    if (miss(t) < miss(best.time)) best = { value: mid, time: t };
    if (isFinite(t) && miss(t) <= tolSec) {
      return { value: mid, time: t, iterations: i, direction, bracketed: true };
    }

    const tooEarly = isFinite(t) ? t < targetSec : false;
    const tooLate = !isFinite(t) || t > targetSec;
    if (direction === 'forward') {
      if (tooEarly) a = mid;
      else if (tooLate) b = mid;
    } else {
      if (tooEarly) b = mid;
      else if (tooLate) a = mid;
    }
  }
  return { ...best, iterations: maxIters, direction, bracketed: true };
}
