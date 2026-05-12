/**
 * Solve substrate — types.
 *
 * A tuner performs 1-D scalar search against a sampler that returns a
 * fire time (or `Infinity` for unreachable). {@link bisectTuner} is the
 * auto-direction-detecting default; alternate {@link Tuner} impls
 * (golden-section, secant, scope-push variants) plug into the same
 * signature.
 */

/**
 * Configuration for a {@link Tuner} call. `sampler` drives the cost
 * function — a single 1-D parameter maps to a fire time, and the tuner
 * searches for the value that lands on `targetSec`.
 */
export interface TunerConfig {
  /** Low end of the search bracket. Sampled once for direction detection. */
  lo: number;
  /** High end of the search bracket. Sampled once for direction detection. */
  hi: number;
  /** Target fire time in sim-seconds. */
  targetSec: number;
  /** Returns the sim-second the event fired, or `Infinity` if unreachable. */
  sampler: (value: number) => number;
  /** Convergence tolerance on `|time - targetSec|`. Defaults to 1 sec. */
  tolSec?: number;
  /** Hard iteration ceiling. Defaults to 22. */
  maxIters?: number;
}

/**
 * Outcome of a tuner run. `direction` is auto-detected from the endpoint
 * calibration — `'forward'` means higher value → later fire (cost-like);
 * `'inverted'` means higher value → earlier fire (multiplier-like).
 */
export interface TunerResult {
  /** The 1-D parameter value the tuner converged on. */
  value: number;
  /** Sampled fire time at `value`. `Infinity` if the converged value still never fires. */
  time: number;
  /** Number of `sampler` calls (excluding the two calibration runs at `lo` and `hi`). */
  iterations: number;
  direction: 'forward' | 'inverted';
}

/**
 * Runner-level swappable for 1-D parameter search. {@link bisectTuner} is
 * the default. Alternates can implement golden-section, secant, or
 * scope-push-based iteration, all sharing this signature so the caller
 * picks strategy at the import site.
 */
export type Tuner = (config: TunerConfig) => TunerResult;
