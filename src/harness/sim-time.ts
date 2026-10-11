/**
 * Sim-time accounting — the two helpers that keep a runner's reported time
 * equal to the time the engine actually simulated.
 *
 * - {@link floorSteps} counts whole steps in a span without losing the last
 *   one to floating-point quotient error.
 * - {@link reachedTime} compares an accumulated sim-time against a target
 *   with the same tolerance, so a sum of steps that ends on the target counts.
 *
 * @cluster runners
 * @internal
 */

/**
 * Relative slack on a step-count quotient: `0.7 / 0.1` is `6.999…` (error
 * ~1e-16), while a genuine fractional remainder sits far above this.
 */
const STEP_QUOTIENT_EPSILON = 1e-12;

/**
 * Whole `step`s in `span` — `Math.floor(span / step)`, tolerant of a quotient
 * that ends a hair under an integer.
 *
 * @internal
 */
export function floorSteps(span: number, step: number): number {
  const q = span / step;
  return Math.floor(q + Math.abs(q) * STEP_QUOTIENT_EPSILON);
}

/**
 * Whether `simTime` has reached `target`, counting a sum of steps that ends
 * a rounding error short (`3 × 0.3` is `0.8999…`) as there.
 *
 * @internal
 */
export function reachedTime(simTime: number, target: number): boolean {
  return simTime + Math.abs(target) * STEP_QUOTIENT_EPSILON >= target;
}
