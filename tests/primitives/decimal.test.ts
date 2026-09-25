import { describe, it, expect, beforeEach } from 'vitest';
import {
  Decimal,
  bn,
  format,
  formatWhole,
  formatTime,
  integerRoot,
  tryIntegerRoot,
  renormIfLayer0,
} from '@/primitives/decimal';
import { notationManager } from '@/primitives/notation-manager';
import { Presets } from '@/primitives/notations';

describe('Decimal wrapper', () => {
  it('bn() creates Decimal from number', () => {
    const d = bn(100);
    expect(d.eq(100)).toBe(true);
  });
  it('bn() creates Decimal from string', () => {
    const d = bn('1e100');
    expect(d.eq(Decimal.pow(10, 100))).toBe(true);
  });
  it('Decimal arithmetic works', () => {
    const a = bn(10);
    const b = bn(3);
    expect(a.add(b).eq(13)).toBe(true);
    expect(a.mul(b).eq(30)).toBe(true);
  });
  it('formatTime() converts seconds to readable', () => {
    expect(formatTime(3661)).toMatch(/1.*01.*01/);
  });
});

describe('Decimal static fast-path chain contract', () => {
  // The fast path returned raw `number` on layer-0 arithmetic, breaking
  // `.clamp()/.toNumber()/.lt()/...` chain calls at runtime. The fix promotes
  // to `new Decimal(r)` before return so the chain contract holds regardless
  // of whether the fast path fires. These are the consumer patterns that
  // crashed before the fix — keeping them as a runtime regression gate.
  it('Decimal.div(num, num).clamp(0, 1).toNumber() — fast path', () => {
    expect(Decimal.div(0.7, 1.0).clamp(0, 1).toNumber()).toBeCloseTo(0.7);
    expect(Decimal.div(1.5, 1.0).clamp(0, 1).toNumber()).toBe(1);
    expect(Decimal.div(-0.3, 1.0).clamp(0, 1).toNumber()).toBe(0);
  });
  it('Decimal.sub(num, num).abs().lt(eps) — fast path', () => {
    expect(Decimal.sub(100, 100.001).abs().lt(0.01)).toBe(true);
    expect(Decimal.sub(100, 99).abs().lt(0.01)).toBe(false);
  });
  it('Decimal.mul(num, num).mul(num) — chained fast paths', () => {
    expect(Decimal.mul(Decimal.mul(2, 3), 4).toNumber()).toBe(24);
  });
  it('Decimal.add(num, num).gt(num) — predicate off chained fast path', () => {
    expect(Decimal.add(5, 3).gt(7)).toBe(true);
  });
  it('Decimal.min(num, num) returns a chainable Decimal — fast path', () => {
    expect(Decimal.min(5, 3).add(1).toNumber()).toBe(4);
    expect(Decimal.max(5, 3).sub(1).toNumber()).toBe(4);
  });
  it('slow path (Decimal+Decimal) stays chainable', () => {
    const big = bn('1e400');
    expect(Decimal.add(big, big).gt('1e400')).toBe(true);
  });
});

describe('Decimal static fast paths agree with the instance forms on tiny results', () => {
  // Law: the patched number-space static equals the unpatched instance method
  // wherever the product or quotient leaves the normal float range from below,
  // measured in log10, where the Decimal answer keeps its precision.
  const operands: number[] = [];
  for (let e = -300; e <= 300; e += 23) operands.push(1.7 * 10 ** e, -4.3 * 10 ** e);

  function expectAgreement(fast: Decimal, reference: Decimal, label: string): void {
    if (reference.eq(0)) {
      expect(fast.eq(0), label).toBe(true);
      return;
    }
    expect(fast.sign, label).toBe(reference.sign);
    const drift = Math.abs(fast.abs().log10().toNumber() - reference.abs().log10().toNumber());
    expect(drift, label).toBeLessThan(1e-12);
  }

  it('mul', () => {
    for (const a of operands) {
      for (const b of operands) {
        expectAgreement(Decimal.mul(a, b), new Decimal(a).mul(b), `mul(${a}, ${b})`);
      }
    }
  });

  it('div', () => {
    for (const a of operands) {
      for (const b of operands) {
        expectAgreement(Decimal.div(a, b), new Decimal(a).div(b), `div(${a}, ${b})`);
      }
    }
  });

  it('a zero operand still answers zero', () => {
    expect(Decimal.mul(0, 1e-200).eq(0)).toBe(true);
    expect(Decimal.div(0, 1e200).eq(0)).toBe(true);
  });
});

describe('ordering against NaN', () => {
  // break_eternity derives gte/lte/max/min from a strict comparison in a form
  // that assumes trichotomy, so each inverts against NaN: `gte` and `lte` answer
  // `true`, and `max`/`min` swallow a right-hand NaN. A guard asking "have we
  // already arrived?" then claims the domain floor as its answer. Corrected in
  // `primitives/decimal.ts` § ORDERING CORRECTIONS; these are the gate.
  const NAN = bn(NaN);
  const FIVE = bn(5);

  it('gte/lte are false against NaN in either operand position', () => {
    for (const [a, b] of [
      [NAN, FIVE],
      [FIVE, NAN],
      [NAN, NAN],
    ] as const) {
      expect(Decimal.gte(a, b)).toBe(false);
      expect(Decimal.lte(a, b)).toBe(false);
      expect(a.gte(b)).toBe(false);
      expect(a.lte(b)).toBe(false);
    }
  });

  it('gt/lt/eq were already correct and stay so', () => {
    for (const [a, b] of [
      [NAN, FIVE],
      [FIVE, NAN],
      [NAN, NAN],
    ] as const) {
      expect(Decimal.gt(a, b)).toBe(false);
      expect(Decimal.lt(a, b)).toBe(false);
      expect(Decimal.eq(a, b)).toBe(false);
    }
  });

  it('the number-space fast path and the Decimal slow path agree', () => {
    // The fast path uses native operators, which are correctly false against
    // NaN, while the slow path was not — so the same call answered differently
    // depending only on whether its operands happened to be boxed. This asserts
    // the two can never drift apart again.
    expect(Decimal.gte(NaN, 5)).toBe(Decimal.gte(NAN, FIVE));
    expect(Decimal.lte(NaN, 5)).toBe(Decimal.lte(NAN, FIVE));
    expect(Decimal.gte(5, NaN)).toBe(Decimal.gte(FIVE, NAN));
    expect(Decimal.lte(5, NaN)).toBe(Decimal.lte(FIVE, NAN));
    expect(Decimal.max(NaN, 5).isNan()).toBe(Decimal.max(NAN, FIVE).isNan());
    expect(Decimal.min(5, NaN).isNan()).toBe(Decimal.min(FIVE, NAN).isNan());
  });

  it('max/min propagate NaN rather than swallowing it', () => {
    expect(Decimal.max(NAN, FIVE).isNan()).toBe(true);
    expect(Decimal.max(FIVE, NAN).isNan()).toBe(true);
    expect(Decimal.min(NAN, FIVE).isNan()).toBe(true);
    expect(Decimal.min(FIVE, NAN).isNan()).toBe(true);
    expect(FIVE.max(NAN).isNan()).toBe(true);
    expect(FIVE.min(NAN).isNan()).toBe(true);
  });

  it('the clamp family inherits the correction', () => {
    // clamp/clampMin/clampMax are defined in terms of max/min upstream.
    expect(NAN.clamp(0, 10).isNan()).toBe(true);
    expect(NAN.clampMin(0).isNan()).toBe(true);
    expect(NAN.clampMax(10).isNan()).toBe(true);
    expect(FIVE.clampMin(NAN).isNan()).toBe(true);
    expect(FIVE.clampMax(NAN).isNan()).toBe(true);
  });

  it('gte/lte must not be rebuilt from cmp — cmp calls NaN equal', () => {
    // `cmp` is asymmetric: NaN on the right reports 0 ("equal"), so the one-call
    // form `cmp(v) >= 0` would reintroduce the bug that the two assertions below
    // exist to prevent. Pins the trap, not just the symptom.
    expect(FIVE.cmp(NAN)).toBe(0);
    expect(FIVE.gte(NAN)).toBe(false);
    expect(FIVE.lte(NAN)).toBe(false);
  });

  it('ordering on defined values is unchanged, including above layer 0', () => {
    expect(Decimal.gte(5, 5)).toBe(true);
    expect(Decimal.lte(5, 5)).toBe(true);
    expect(Decimal.gte(5, 3)).toBe(true);
    expect(Decimal.lte(5, 3)).toBe(false);
    expect(Decimal.max(5, 3).toNumber()).toBe(5);
    expect(Decimal.min(5, 3).toNumber()).toBe(3);
    expect(bn(Infinity).gte(FIVE)).toBe(true);
    expect(bn(-Infinity).lte(FIVE)).toBe(true);
    const tet = bn(10).tetrate(4);
    expect(tet.gte(tet)).toBe(true);
    expect(tet.lte(tet)).toBe(true);
    expect(tet.gte(bn('1e1000'))).toBe(true);
  });

  it('an undefined chain no longer reads as "already arrived"', () => {
    // The route in: `recip(0)` is NaN rather than Infinity, so an ordinary chain
    // reaches an undefined value without doing anything exotic. Before the
    // correction, comparing it against a threshold answered `true`.
    const undefinedValue = bn(0).recip();
    expect(undefinedValue.isNan()).toBe(true);
    expect(Decimal.gte(bn(1000), undefinedValue)).toBe(false);
    expect(Decimal.gte(undefinedValue, bn(1000))).toBe(false);
  });
});

describe('integerRoot', () => {
  it('recovers perfect cubes that a raw floor drops', () => {
    // Decimal.root(x, 3) = pow(x, 1/3) lands a hair under exact cubes, so
    // Decimal.floor(Decimal.root(8, 3)) is 1. integerRoot corrects it.
    expect(Decimal.floor(Decimal.root(8, 3)).eq(1)).toBe(true); // the bug, pinned
    for (const [x, k] of [
      [8, 2],
      [27, 3],
      [64, 4],
      [125, 5],
      [216, 6],
      [343, 7],
      [1000, 10],
      [15625, 25],
    ] as const) {
      expect(integerRoot(x, 3).eq(k), `∛${x} = ${k}`).toBe(true);
    }
  });

  it('floors non-perfect radicands to the largest integer whose cube fits', () => {
    expect(integerRoot(8.5, 3).eq(2)).toBe(true);
    expect(integerRoot(26.999, 3).eq(2)).toBe(true);
    expect(integerRoot(28, 3).eq(3)).toBe(true);
    expect(integerRoot(7.999, 3).eq(1)).toBe(true);
  });

  it('supports the integer square root (degree 2)', () => {
    expect(integerRoot(144, 2).eq(12)).toBe(true);
    expect(integerRoot(145, 2).eq(12)).toBe(true);
    expect(integerRoot(143, 2).eq(11)).toBe(true);
  });

  it('returns 0 for zero and negatives', () => {
    expect(integerRoot(0, 3).eq(0)).toBe(true);
    expect(integerRoot(-8, 3).eq(0)).toBe(true);
  });

  it('accepts string and Decimal sources and returns a chainable Decimal', () => {
    expect(integerRoot('1000', 3).eq(10)).toBe(true);
    expect(integerRoot(bn(216), 3).add(1).eq(7)).toBe(true);
  });

  it('recovers perfect cubes across magnitudes, where a fixed additive nudge is scale-blind', () => {
    for (const k of [100, 1000, 1e4, 1e5, 1e6]) {
      const cube = Decimal.pow(k, 3); // exact k³
      expect(integerRoot(cube, 3).eq(k), `∛(${k}³) = ${k}`).toBe(true);
    }
  });

  it('snaps only across break_eternity’s own error, not a fixed relative band', () => {
    const cube = Decimal.pow(1e6, 3); // 1e18
    expect(integerRoot(cube, 3).eq(1e6)).toBe(true);
    // `cube.sub(1)` is a no-op at this magnitude — the ulp of 1e18 is 128 — so
    // the value below has to be built far enough down to be representable at
    // all. One part in 1e12 is ~1e6 absolute, far outside the ~1e-14 relative
    // slack, and must floor rather than snap.
    const justBelow = cube.mul(1 - 1e-12);
    expect(justBelow.lt(cube)).toBe(true); // the input really did move
    expect(integerRoot(justBelow, 3).eq(999999)).toBe(true);
    // clearly below floors down
    expect(integerRoot(cube.mul(0.9), 3).lt(1e6)).toBe(true);
  });

  it('holds m^degree ≤ x < (m+1)^degree exactly, checked in BigInt', () => {
    // Below 9e15 a Decimal is an exact layer-0 integer, so the law can be
    // checked against arbitrary-precision integer arithmetic with no oracle
    // fixture and no tolerance of its own.
    const law = (x: number, degree: number) => {
      const m = BigInt(integerRoot(x, degree).toNumber());
      const d = BigInt(degree);
      const X = BigInt(x);
      expect(m ** d <= X, `${m}^${degree} ≤ ${x}`).toBe(true);
      expect((m + 1n) ** d > X, `${m + 1n}^${degree} > ${x}`).toBe(true);
    };
    for (const degree of [2, 3, 4, 5]) {
      for (const x of [
        1, 2, 7, 8, 9, 26, 27, 28, 100, 1023, 1024, 1025, 999999, 1e6, 1e9, 1e12, 4e15,
      ]) {
        law(x, degree);
      }
    }
  });

  it('is exact at the magnitudes the unbounded snap overshot', () => {
    // Oracle values from mpmath at 80 digits. The prior implementation applied
    // a 1e-9 relative tolerance in radicand space while stepping the root by 1,
    // so it overshot by `tol / (degree·m^(degree−1))` integers — 5 at 1e20,
    // 500001 at 1e30 — and the overshoot grew without bound.
    const DEGREE_2 = [
      ['1e16', 100000000],
      ['1e17', 316227766],
      ['1e18', 1000000000],
      ['1e19', 3162277660],
      ['1e20', 10000000000],
      ['1e21', 31622776601],
      ['1e22', 100000000000],
      ['1e24', 1000000000000],
      ['1e26', 10000000000000],
      ['1e27', 31622776601683],
    ] as const;
    const DEGREE_3 = [
      ['1e18', 1000000],
      ['1e20', 4641588],
      ['1e24', 100000000],
      ['1e28', 2154434690],
      ['1e30', 10000000000],
      ['1e33', 100000000000],
      ['1e36', 1000000000000],
      ['1e40', 21544346900318],
      ['1e41', 46415888336127],
    ] as const;
    const DEGREE_5 = [
      ['1e30', 1000000],
      ['1e50', 10000000000],
      ['1e60', 1000000000000],
      ['1e70', 100000000000000],
    ] as const;
    for (const [degree, table] of [
      [2, DEGREE_2],
      [3, DEGREE_3],
      [5, DEGREE_5],
    ] as const) {
      for (const [x, expected] of table) {
        const got = integerRoot(x, degree);
        expect(got.eq(expected), `integerRoot(${x}, ${degree}) = ${got}, want ${expected}`).toBe(
          true,
        );
      }
    }
  });

  it('terminates in bounded time at magnitudes that used to hang', () => {
    // The old walk stepped one integer at a time across a tolerance that grew
    // with x: 699 ms at 1e30 degree 2, and no termination within 120 s past
    // ~1e32. The candidate set is now fixed, so cost is flat in x.
    const started = performance.now();
    for (const [x, degree] of [
      ['1e32', 2],
      ['1e100', 2],
      ['1e1000', 2],
      ['1e400', 3],
      ['1e1e10', 2],
    ] as const) {
      expect(integerRoot(x, degree).gt(0)).toBe(true);
    }
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe('tryIntegerRoot', () => {
  it('grades a resolvable root exact and returns the same value as integerRoot', () => {
    for (const [x, degree] of [
      [2240, 3],
      [8, 3],
      [144, 2],
      ['1e15', 2], // exact-integer arithmetic reaches this far
      ['3.7e20', 3], // past it, the error bar still clears every integer
      ['4e38', 3],
    ] as const) {
      const graded = tryIntegerRoot(x, degree);
      expect(graded.reason, `${x} deg ${degree}`).toBe('exact');
      expect(graded.value.eq(integerRoot(x, degree))).toBe(true);
    }
  });

  it('reports ambiguous once the root’s error bar can reach an integer boundary', () => {
    // The bar grows with magnitude and shrinks with degree, so the crossing is
    // degree-dependent: the root passes ~1e11 at 1e22 for degree 2 and only at
    // 1e33 for degree 3. Width below 1 means "possibly off by one" — the value
    // is still the best estimate, and here still the right one.
    for (const [x, degree, value] of [
      ['1e22', 2, 100000000000],
      ['1e27', 2, 31622776601683],
      ['1e41', 3, 46415888336127],
    ] as const) {
      const graded = tryIntegerRoot(x, degree);
      expect(graded.reason, `${x} deg ${degree} should be ambiguous`).toBe('ambiguous');
      expect(graded.value.eq(value), `${x} deg ${degree} value is still correct`).toBe(true);
    }
  });

  it('separates a hair of doubt from an answer carrying no information', () => {
    const hair = tryIntegerRoot('1e22', 2); // root 1e11, bar ~1e-3 of an integer
    const none = tryIntegerRoot('1e45', 2); // root past the distinguishable ceiling
    expect(hair.reason).toBe('ambiguous');
    expect(none.reason).toBe('ambiguous');
    if (hair.reason === 'ambiguous') expect(hair.width.lt(1)).toBe(true);
    if (none.reason === 'ambiguous') expect(none.width.gt(1e6)).toBe(true);
  });

  it('reports ambiguous once the root itself outgrows distinguishable integers', () => {
    // Past 9e15 a Decimal stores its logarithm and m+1 is m, so no
    // implementation can floor here — the honest answer is to say so.
    const graded = tryIntegerRoot('1e40', 2); // root ≈ 1e20, far past the ceiling
    expect(graded.reason).toBe('ambiguous');
    const root = integerRoot('1e40', 2);
    expect(root.add(1).eq(root)).toBe(true);
  });

  it('width grows with the ambiguity rather than being a flag in disguise', () => {
    const near = tryIntegerRoot('1e29', 2);
    const far = tryIntegerRoot('1e40', 2);
    expect(near.reason).toBe('ambiguous');
    expect(far.reason).toBe('ambiguous');
    if (near.reason === 'ambiguous' && far.reason === 'ambiguous') {
      expect(far.width.gt(near.width)).toBe(true);
    }
  });

  it('grades exactly-representable radicands exact at every degree', () => {
    // Below 9e15 the answer is settled in BigInt, so nothing here depends on
    // magnitude, degree, or how close the radicand sits to a perfect power.
    for (const degree of [1, 2, 3, 7]) {
      for (const x of [1, 2, 8, 143, 26.999, 1e9, 4e15]) {
        expect(tryIntegerRoot(x, degree).reason, `${x} deg ${degree}`).toBe('exact');
      }
    }
  });

  it('grades the clamped non-positive arm exact', () => {
    expect(tryIntegerRoot(0, 3).reason).toBe('exact');
    expect(tryIntegerRoot(-8, 3).value.eq(0)).toBe(true);
  });
});

describe('renormIfLayer0', () => {
  it('number passes through unchanged', () => {
    expect(renormIfLayer0(0)).toBe(0);
    expect(renormIfLayer0(42)).toBe(42);
    expect(renormIfLayer0(-7.5)).toBe(-7.5);
    expect(renormIfLayer0(1e14)).toBe(1e14);
  });
  it('layer-0 small-mag Decimal coerces to native number', () => {
    const r = renormIfLayer0(bn(100));
    expect(typeof r).toBe('number');
    expect(r).toBe(100);
  });
  it('sign is preserved when coercing layer-0 Decimal to number', () => {
    const neg = renormIfLayer0(bn(-250));
    expect(typeof neg).toBe('number');
    expect(neg).toBe(-250);
    const zero = renormIfLayer0(bn(0));
    expect(typeof zero).toBe('number');
    expect(zero).toBe(0);
  });
  it('layer-0 Decimal at or above OVERFLOW_ABS stays Decimal', () => {
    // OVERFLOW_ABS = 1e15; threshold is strict less-than.
    const atThreshold = bn(1e15);
    const r1 = renormIfLayer0(atThreshold);
    expect(r1).toBe(atThreshold);
    const above = bn(1e18);
    const r2 = renormIfLayer0(above);
    expect(r2).toBe(above);
  });
  it('layer > 0 Decimal stays Decimal regardless of mag', () => {
    const huge = bn('1e400');
    expect(huge.layer).toBeGreaterThan(0);
    expect(renormIfLayer0(huge)).toBe(huge);
  });
  it('renormalizing a promoted fast-path result yields native number', () => {
    // Fast path wraps `new Decimal(r)`; renormIfLayer0 peels it back so the
    // next iter's typeof dispatch fires.
    const wrapped = Decimal.add(5, 3); // layer-0 Decimal(8) from fast path
    const r = renormIfLayer0(wrapped);
    expect(typeof r).toBe('number');
    expect(r).toBe(8);
  });
});

describe('format()', () => {
  beforeEach(() => {
    notationManager.setActive('standard');
  });

  it('handles NaN', () => {
    expect(format(NaN)).toBe('NaN');
  });

  it('handles Infinity', () => {
    expect(format(Infinity)).toBe('Infinity');
  });

  it('handles negative numbers', () => {
    expect(format(-1490)).toBe('-1.49 k');
  });

  it('handles zero', () => {
    expect(format(0)).toBe('0.00');
  });

  describe('small numbers (< 1000) use regularFormat', () => {
    it('formats with default precision', () => {
      expect(format(bn(0.5))).toBe('0.50');
      expect(format(bn(42))).toBe('42.00');
      expect(format(bn(999))).toBe('999.00');
    });

    it('respects precision parameter', () => {
      expect(format(bn(42), 0)).toBe('42');
      expect(format(bn(42.567), 1)).toBe('42.6');
    });
  });

  describe('large numbers (>= 1000) delegate to notation', () => {
    it('Standard notation for thousands', () => {
      expect(format(bn(1000))).toBe('1 k');
      expect(format(bn(1490))).toBe('1.49 k');
    });

    it('Standard notation for millions+', () => {
      expect(format(bn(1e6))).toBe('1 M');
      expect(format(bn(1e9))).toBe('1 B');
      expect(format(bn(1e12))).toBe('1 T');
    });

    it('Scientific notation when switched', () => {
      notationManager.setActive('scientific');
      expect(format(bn(1490))).toBe('1.49e3');
      expect(format(bn(1e15))).toBe('1e15');
    });

    it('Engineering notation when switched', () => {
      notationManager.setActive('engineering');
      expect(format(bn(1e7))).toBe('10e6');
    });
  });

  describe('very small numbers', () => {
    it('shows very small numbers when small=true', () => {
      const result = format(bn(0.0001), 2, true);
      expect(result).not.toBe('0.00');
    });

    it('uses regularFormat for very small when small=false', () => {
      expect(format(bn(0.0001), 2, false)).toBe('0.0001');
    });
  });
});

describe('formatWhole()', () => {
  beforeEach(() => {
    notationManager.setActive('standard');
  });

  it('formats large numbers via notation', () => {
    expect(formatWhole(bn(1e9))).toBe('1 B');
  });

  it('formats medium numbers without decimals', () => {
    expect(formatWhole(bn(42))).toBe('42');
  });

  it('formats small decimals with precision', () => {
    expect(formatWhole(bn(0.5))).toBe('0.50');
  });

  it('handles negatives', () => {
    expect(formatWhole(bn(-42))).toBe('-42');
  });
});

describe('formatTime()', () => {
  it('formats seconds', () => {
    expect(formatTime(30)).toBe('30.00s');
  });

  it('formats minutes and seconds', () => {
    expect(formatTime(90)).toMatch(/1m.*30/);
  });

  it('formats hours', () => {
    expect(formatTime(3661)).toMatch(/1h.*01m.*01s/);
  });

  it('formats days', () => {
    const result = formatTime(90000);
    expect(result).toContain('d');
    expect(result).toContain('h');
  });

  it('formats years', () => {
    const result = formatTime(40000000);
    expect(result).toContain('y');
  });

  it('handles negatives', () => {
    expect(formatTime(-30)).toBe('-30.00s');
  });

  it('carries a seconds field that rounds up to 60 into the next unit', () => {
    expect(formatTime(59.999)).toBe('1m 0.00s');
    expect(formatTime(119.999)).toBe('2m 0.00s');
    expect(formatTime(3599.999)).toBe('1h 00m 00s');
  });

  it('renders NaN as NaN', () => {
    expect(formatTime(NaN)).toBe('NaN');
  });
});

describe('notation switching via notationManager', () => {
  beforeEach(() => {
    notationManager.setActive('standard');
  });

  it('switches active notation and format follows', () => {
    expect(format(bn(1490))).toBe('1.49 k');
    notationManager.setActive('scientific');
    expect(format(bn(1490))).toBe('1.49e3');
  });

  it('supports registering additional presets', () => {
    notationManager.register('logarithm', Presets.Logarithm);
    notationManager.setActive('logarithm');
    expect(format(bn(1e15))).toBe('e15');
  });
});
