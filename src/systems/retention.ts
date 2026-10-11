/**
 * Retention — declarative keep and retain of values through a reset
 *
 * A retention snapshots the kept and retained values before a reset and
 * restores them after. It composes with `createReset` and `createCycle`.
 *
 * It has two kinds of entry:
 * - `keep`: refs that survive a reset unchanged
 * - `retain`: refs with a custom transform, such as `fractional` or a formula
 */

import { Decimal, toNumber, type DecimalSource } from '@/primitives/decimal';
import type { Persistent, Serializable } from '@/core/persistence';

// === TYPES ===

/** Options for {@link createRetention} — split refs into `keep` (verbatim) and `retain` (transformed). */
export interface RetentionOptions {
  /** Refs that should not be reset — restored to their pre-reset value */
  keep?: Persistent[];
  /**
   * Refs with custom retention transforms.
   * The transform receives the pre-reset value and returns the post-reset value.
   */
  retain?: Map<Persistent, (value: any) => any>;
}

/**
 * A snapshot and restore pair that keeps chosen persistent refs through a
 * reset. {@link createRetention} creates it. A consumer calls `snapshot()`
 * before the reset runs and `restore()` after.
 */
export interface Retention {
  /** Snapshot all kept and retained values. Call before the reset runs. */
  snapshot(): void;
  /** Restore the snapshotted values. Call after the reset runs. */
  restore(): void;
}

// === HELPERS ===

/**
 * Create a fractional retention transform.
 * Keeps the given fraction of the value, in the value's own kind: a
 * `number` ref stays a `number`, anything else comes back a `Decimal`.
 *
 * @example retain.set(skillLevel, fractional(0.3)) // keep 30%
 */
export function fractional(fraction: DecimalSource): (value: any) => any {
  return (value: any) =>
    typeof value === 'number' ? value * toNumber(fraction) : Decimal.mul(value, fraction);
}

// === FACTORIES ===

/**
 * Create a retention: a declarative keep and retain of values through resets.
 *
 * Call `snapshot()` before a reset to capture the values, then `restore()`
 * after the reset to write them back. It composes with `createReset` and
 * `createCycle`, and needs no change to core.
 *
 * @param options - Refs to `keep` unchanged and refs to `retain` with custom
 *   transform functions (e.g. `fractional(0.3)` to keep 30%)
 * @returns A retention with `snapshot()` and `restore()` methods
 *
 * @example
 * ```ts
 * const retention = createRetention({
 *   keep: [totalGained, achievements],
 *   retain: new Map([[skillLevel, fractional(0.1)]]),
 * });
 * // One retention shared by several resets. A single reset takes the same
 * // `keep` / `retain` inline on `createReset` instead.
 * retention.snapshot();
 * prestigeReset.reset();
 * retention.restore();
 * ```
 */
export function createRetention(options: RetentionOptions): Retention {
  const { keep = [], retain = new Map() } = options;
  const snapshots = new Map<Persistent, Serializable>();

  return {
    snapshot() {
      snapshots.clear();
      for (const ref of keep) {
        snapshots.set(ref, ref.value);
      }
      for (const [ref, transform] of retain) {
        snapshots.set(ref, transform(ref.value));
      }
    },

    restore() {
      for (const [ref, value] of snapshots) {
        ref.value = value;
      }
      snapshots.clear();
    },
  };
}
