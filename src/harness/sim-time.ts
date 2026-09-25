/**
 * Sim-time accounting — the two helpers that keep a runner's reported time
 * equal to the time the engine actually simulated.
 *
 * - {@link simulateSpan} advances a driver by a span of any length, splitting
 *   it under `maxDeltaTime` so variable-mode `simulateTick` never clamps.
 * - {@link floorSteps} counts whole steps in a span without losing the last
 *   one to floating-point quotient error.
 *
 * @cluster runners
 * @internal
 */

import type { TickDriver } from '@/core/tick-driver';

/**
 * Relative slack on a step-count quotient: `0.7 / 0.1` is `6.999…` (error
 * ~1e-16), while a genuine fractional remainder sits far above this.
 */
const STEP_QUOTIENT_EPSILON = 1e-12;

/**
 * Advance `driver` by `dt` sim-seconds in equal `simulateTick` calls no larger
 * than its `maxDeltaTime`. A span within the cap is a single call.
 *
 * @internal
 */
export function simulateSpan(driver: TickDriver, dt: number): void {
  const cap = driver.maxDeltaTime;
  if (!(dt > cap)) {
    driver.simulateTick(dt);
    return;
  }
  const q = dt / cap;
  const chunks = Math.ceil(q - q * STEP_QUOTIENT_EPSILON);
  const chunk = dt / chunks;
  for (let i = 0; i < chunks; i++) driver.simulateTick(chunk);
}

/**
 * Whole `step`s in `span` — `Math.floor(span / step)`, tolerant of a quotient
 * that lands a hair under an integer.
 *
 * @internal
 */
export function floorSteps(span: number, step: number): number {
  const q = span / step;
  return Math.floor(q + Math.abs(q) * STEP_QUOTIENT_EPSILON);
}
