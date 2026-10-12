/**
 * Computed — `Computable<T>` and getter utilities for Vue reactive inputs
 *
 * Uses `Readonly<Ref<T>>` instead of `Ref<T>` so covariant subtypes work:
 * `ComputedRef<Decimal>` satisfies `Computable<DecimalSource>` without wrapping.
 */

import { computed, isRef, type MaybeRef, type Ref } from 'vue';
import { isFunction } from './common';

/**
 * A reactive input that may be a direct value, a Vue ref/computed, or a getter function.
 *
 * Uses `Readonly<Ref<T>>` instead of `Ref<T>` so that subtype refs work naturally:
 * `ComputedRef<Decimal>` satisfies `Computable<DecimalSource>` without wrapping.
 *
 * Use in option interfaces (the input side). After {@link toMaybeRef}, the
 * result is a standard `MaybeRef<T>` compatible with Vue's `unref()`.
 */
export type Computable<T> = T | Readonly<Ref<T>> | (() => T);

/**
 * Unwrap a {@link Computable} to its current value in a single step.
 *
 * Unlike {@link toMaybeRef} (which wraps getters in `computed()`), this
 * evaluates eagerly — suitable for one-shot reads, not reactive ones.
 *
 * @param value - A raw value, ref, or getter function
 * @returns The current value
 */
export function resolveComputable<T>(value: Computable<T>): T {
  if (typeof value === 'function' && (value as (...args: unknown[]) => unknown).length === 0) {
    return (value as () => T)();
  }
  if (isRef(value)) return value.value;
  return value as T;
}

/**
 * Process a value that may be a getter function.
 * If it's a zero-argument function, wrap it in computed().
 * Otherwise, return as-is.
 *
 * The return type is `MaybeRef<T>`, compatible with Vue's `unref()`.
 * The cast from `Readonly<Ref<T>>` to `MaybeRef<T>` is safe because
 * at runtime the value is always a real Vue ref (Ref, ComputedRef, etc.).
 *
 * @param obj - A value, ref, or getter function
 * @returns A raw value or ref (getter functions become ComputedRefs)
 *
 * @example
 * ```ts
 * const staticValue = toMaybeRef(5)                       // 5
 * const reactive = toMaybeRef(() => count.value * 2)      // ComputedRef<number>
 * const passthrough = toMaybeRef(someComputedRef)          // same ref
 * ```
 */
export function toMaybeRef<T>(obj: Computable<T>): MaybeRef<T> {
  if (isFunction(obj) && obj.length === 0) {
    return computed(obj);
  }
  return obj as MaybeRef<T>;
}
