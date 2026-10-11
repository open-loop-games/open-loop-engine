/**
 * Solve substrate — types.
 *
 * A tuner performs 1-D scalar search against a sampler that returns a
 * fire time (or `Infinity` for unreachable). {@link bisectTuner} is the
 * auto-direction-detecting default; other {@link Tuner} implementations
 * (golden-section, secant, scoped-override variants) share the same
 * signature.
 */

/**
 * Options for a {@link Tuner} call. `sampler` is the searched function. It
 * maps a single 1-D parameter to a fire time. The tuner searches for the
 * value whose fire time is `targetSec`.
 */
export interface TunerOptions {
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
  /** Iteration budget. Defaults to 22. */
  maxIters?: number;
}

/**
 * Outcome of a tuner call. `direction` is auto-detected from the endpoint
 * calibration — `'forward'` means higher value → later fire (cost-like);
 * `'inverted'` means higher value → earlier fire (multiplier-like).
 */
export interface TunerResult {
  /** The 1-D parameter value the tuner converged on. */
  value: number;
  /** Sampled fire time at `value`. `Infinity` if the converged value still never fires. */
  time: number;
  /** Number of `sampler` calls (excluding the two calibration samples at `lo` and `hi`). */
  iterations: number;
  direction: 'forward' | 'inverted';
  /**
   * `false` when `targetSec` lies outside the fire times sampled at `lo` and
   * `hi`, so no value in the bracket reaches it and `value` is the nearer
   * endpoint. {@link bisectTuner} always sets it; optional so a custom
   * {@link Tuner} needn't.
   */
  bracketed?: boolean;
}

/**
 * A replaceable 1-D parameter search. {@link bisectTuner} is
 * the default. Others can implement golden-section, secant, or
 * scoped-override iteration. All share this signature, so the caller
 * picks the search method at the import site.
 */
export type Tuner = (config: TunerOptions) => TunerResult;
