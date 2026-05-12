/**
 * Retention policy for declarative carryover across resets
 *
 * Snapshot/restore pattern: saves retained values before reset,
 * restores them after. Zero changes to core — composes with
 * existing Reset/Loop hooks.
 *
 * Covers the universal retention categories:
 * - keep: refs that survive reset unchanged
 * - retain: refs with custom transforms (fractional, formula-based)
 */

import { Decimal, type DecimalSource } from '@/primitives/decimal';
import type { Persistent, State } from '@/core/persistence';

// === TYPES ===

/** Options for {@link createRetentionPolicy} — split refs into `keep` (verbatim) and `retain` (transformed). */
export interface RetentionPolicyOptions {
  /** Refs that should not be reset — restored to their pre-reset value */
  keep?: Persistent[];
  /**
   * Refs with custom retention transforms.
   * The transform receives the pre-reset value and returns the post-reset value.
   */
  retain?: Map<Persistent, (value: any) => any>;
}

/**
 * Snapshot/restore pair that selectively preserves persistent refs across a
 * reset. Created by {@link createRetentionPolicy}; consumers call `snapshot()`
 * before the reset fires and `restore()` after.
 */
export interface RetentionPolicy {
  /** Snapshot all retained values. Call before reset fires. */
  snapshot(): void;
  /** Restore retained values. Call after reset fires. */
  restore(): void;
}

// === HELPERS ===

/**
 * Create a fractional retention transform.
 * Keeps the given fraction of the value (works with Decimal).
 *
 * @example retain.set(skillLevel, fractional(0.3)) // keep 30%
 */
export function fractional(rate: DecimalSource): (value: any) => any {
  return (value: any) => Decimal.mul(value, rate);
}

// === FACTORIES ===

/**
 * Creates a declarative retention policy for carrying values across resets.
 *
 * Call `snapshot()` before a reset to capture current values, then `restore()`
 * after the reset to write them back. Composes with existing Reset/Loop hooks
 * without modifying core.
 *
 * @param options - Refs to `keep` unchanged and refs to `retain` with custom
 *   transform functions (e.g. `fractional(0.3)` to keep 30%)
 * @returns A retention policy with `snapshot()` and `restore()` methods
 *
 * @example
 * ```ts
 * const policy = createRetentionPolicy({
 *   keep: [totalEarned, achievements],
 *   retain: new Map([[skillLevel, fractional(0.1)]]),
 * });
 * // In reset handler:
 * policy.snapshot();
 * reset.execute();
 * policy.restore();
 * ```
 */
export function createRetentionPolicy(options: RetentionPolicyOptions): RetentionPolicy {
  const { keep = [], retain = new Map() } = options;
  const snapshots = new Map<Persistent, State>();

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
