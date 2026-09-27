import { Decimal, format } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import type { Mock } from 'vitest';
import { expect, vi } from 'vitest';

interface CustomMatchers<R = unknown> {
  compare_tolerance(expected: DecimalSource, tolerance?: number): R;
  toLogError(): R;
}

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Assertion extends CustomMatchers {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends CustomMatchers {}
}

expect.extend({
  compare_tolerance(received: DecimalSource, expected: DecimalSource, tolerance?: number) {
    const { isNot } = this;
    let pass: boolean;
    if (!Decimal.isFinite(expected)) {
      pass = !Decimal.isFinite(received);
    } else if (Decimal.isNaN(expected)) {
      pass = Decimal.isNaN(received);
    } else {
      // break_eternity's own eq_tolerance defaults an omitted tolerance to
      // 1e-7 at runtime; match that default explicitly to satisfy the typed
      // (non-optional) 3-arg overload without changing behavior.
      pass = Decimal.eq_tolerance(received, expected, tolerance ?? 1e-7);
    }
    return {
      pass,
      message: () =>
        `Expected ${received} to${(isNot as boolean) ? ' not' : ''} be close to ${expected}`,
      expected: format(expected),
      actual: format(received),
    };
  },
  toLogError(received: () => unknown) {
    const { isNot } = this;
    console.error = vi.fn();
    received();
    const calls = (console.error as Mock<typeof console.error>).mock.calls.length;
    const pass = calls >= 1;
    vi.restoreAllMocks();
    return {
      pass,
      message: () => `Expected ${received} to ${(isNot as boolean) ? ' not' : ''} log an error`,
      expected: '1+',
      actual: calls,
    };
  },
});
