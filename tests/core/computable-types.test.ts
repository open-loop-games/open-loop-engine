/**
 * Type-level regression tests for Computable<T> covariance.
 *
 * These verify that ComputedRef<Decimal> and Ref<Decimal> satisfy
 * Computable<DecimalSource> — the exact assignment that fails with
 * Vue's MaybeRefOrGetter due to Ref setter contravariance.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { computed, ref } from 'vue';
import { Decimal } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import type { Computable } from '@/core/computed';
import { processGetter, resolveComputable } from '@/core/computed';
import type { AdditiveModifierOptions } from '@/core/modifier';

describe('Computable type variance', () => {
  it('ComputedRef<Decimal> is assignable to Computable<DecimalSource>', () => {
    const dec = computed(() => new Decimal(10));
    expectTypeOf(dec).toMatchTypeOf<Computable<DecimalSource>>();
  });

  it('Ref<Decimal> is assignable to Computable<DecimalSource>', () => {
    const dec = ref(new Decimal(10));
    expectTypeOf(dec).toMatchTypeOf<Computable<DecimalSource>>();
  });

  it('getter returning Decimal is assignable to Computable<DecimalSource>', () => {
    const getter = () => new Decimal(5);
    expectTypeOf(getter).toMatchTypeOf<Computable<DecimalSource>>();
  });

  it('raw Decimal is assignable to Computable<DecimalSource>', () => {
    const dec = new Decimal(42);
    expectTypeOf(dec).toMatchTypeOf<Computable<DecimalSource>>();
  });

  it('ComputedRef<Decimal> works in AdditiveModifierOptions.addend', () => {
    const addend = computed(() => new Decimal(10));
    // This is the exact usage that failed before the fix
    const opts: AdditiveModifierOptions = { addend };
    expect(opts.addend).toBe(addend);
  });

  it('processGetter wraps getters and returns MaybeRef', () => {
    const result = processGetter<DecimalSource>(() => new Decimal(5));
    // Should be a ComputedRef (which is a MaybeRef)
    expect(typeof result).toBe('object');
    expect('value' in (result as object)).toBe(true);
  });

  it('resolveComputable extracts the value from a ref', () => {
    const c = computed(() => 42);
    const val = resolveComputable(c);
    expect(val).toBe(42);
  });

  it('resolveComputable evaluates getter functions', () => {
    const val = resolveComputable(() => 99);
    expect(val).toBe(99);
  });

  it('resolveComputable passes through raw values', () => {
    const val = resolveComputable(7);
    expect(val).toBe(7);
  });
});
