/**
 * Formula conformance — numerical laws over the op table.
 *
 * Distinct in kind from `formulas.test.ts`, which asserts *capability flags*
 * ("marked as invertible") and round-trips a single point. This file asserts
 * *laws* over a domain sample, per op, per magnitude regime:
 *
 * - **Round-trip**: `op.invert(op.evaluate(x)) ≈ x`
 *
 * Two rules the suite exists to enforce, both learned the hard way:
 *
 * 1. **Every op in the table gets swept, at both arities.** The inherited suite
 *    iterated only its binary list for numerical checks, so no unary op was ever
 *    round-tripped — which is exactly where its two wrong inverses hid.
 * 2. **Tolerance is stated in the coordinate the law lives in.** A round-trip
 *    lands back in *input* space, so error is measured there. Comparing the
 *    intermediate value relatively is the trap: for an exponential, a value that
 *    agrees to 1e-9 can sit a long way off in input space.
 */

import { F } from '@/core/formulas/formulas';
import type { GenericFormula } from '@/core/formulas/types';
import { Decimal } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import { describe, expect, test, vi } from 'vitest';
import oracle from './fixtures/formula-oracle.json';

// === DOMAIN SAMPLES ===

/**
 * Input samples by admissible domain. Regime A only (layer 0, |x| < 1e308) —
 * higher regimes are swept separately, since the tolerance coordinate changes
 * with the regime.
 */
const DOMAIN = {
  /** x > 0 — logs, reciprocal, roots. */
  positive: ['0.25', '1', '2.5', '10', '137.5', '1e3', '1e7', '1e15', '1e100', '1e300'],
  /** Any real. Bounded well below overflow so `exp`/`pow10` stay in layer 0–1. */
  real: ['-137.5', '-2.5', '-0.25', '0', '0.25', '2.5', '10', '137.5', '1e3'],
  /** |x| < 1 — `asin`, `atanh`. Endpoints excluded: derivative diverges. */
  unit: ['-0.9', '-0.5', '-0.25', '0', '0.25', '0.5', '0.9'],
  /** 0 ≤ x ≤ 1 — `acos` maps to [0, π] and back single-valued. */
  unitPositive: ['0', '0.25', '0.5', '0.75', '0.9'],
  /** x ≥ 1 — `acosh`. */
  atLeastOne: ['1', '1.5', '2.5', '10', '137.5', '1e3', '1e7'],
  /** (-π/2, π/2) — the principal branch where `asin`/`atan` invert `sin`/`tan`. */
  principal: ['-1.5', '-1', '-0.5', '-0.25', '0', '0.25', '0.5', '1', '1.5'],
  /** [0, π] — the principal branch where `acos` inverts `cos`. */
  principalCos: ['0', '0.25', '1', '1.5', '2.5', '3.1'],
  /** Modest reals — `sinh`/`cosh`/`tanh` saturate or overflow past this. */
  modest: ['-10', '-2.5', '-0.25', '0', '0.25', '2.5', '10'],
  /** x ≥ 0 — `cosh` is even, so only the non-negative half inverts. */
  modestPositive: ['0', '0.25', '2.5', '10'],
} as const;

type DomainName = keyof typeof DOMAIN;

/** Tolerance every op is held to unless it documents why it can't be. */
const DEFAULT_TOL = 1e-10;

/**
 * A loosened tolerance must say why, so a slackened bound can never be silent.
 * `tol` and `tolReason` travel together or not at all — the type enforces it.
 */
type Tolerance = { tol?: undefined; tolReason?: undefined } | { tol: number; tolReason: string };

/** A unary op that declares an inverse, with the domain its round-trip holds on. */
type UnaryCase = Tolerance & {
  op: (value: DecimalSource) => GenericFormula;
  domain: DomainName;
};

/**
 * Every unary op in the table that binds an `invert`. Rounding ops
 * (`round`/`floor`/`ceil`/`trunc`) are excluded deliberately — their invert is
 * `invertPassthrough`, whose contract is target-dependent rather than a
 * round-trip law, and it is under decision. `sign`/`abs`/`factorial`/`gamma`/
 * `lngamma`/`pLog10`/`absLog10` bind no invert at all.
 */
const UNARY: Record<string, UnaryCase> = {
  neg: { op: (v) => F.neg(v), domain: 'real' },
  recip: { op: (v) => F.recip(v), domain: 'positive' },
  log10: { op: (v) => F.log10(v), domain: 'positive' },
  log2: { op: (v) => F.log2(v), domain: 'positive' },
  ln: { op: (v) => F.ln(v), domain: 'positive' },
  pow10: { op: (v) => F.pow10(v), domain: 'real' },
  exp: { op: (v) => F.exp(v), domain: 'real' },
  sin: { op: (v) => F.sin(v), domain: 'principal' },
  cos: { op: (v) => F.cos(v), domain: 'principalCos' },
  tan: { op: (v) => F.tan(v), domain: 'principal' },
  asin: { op: (v) => F.asin(v), domain: 'unit' },
  acos: { op: (v) => F.acos(v), domain: 'unitPositive' },
  atan: { op: (v) => F.atan(v), domain: 'real' },
  // `sinh`/`tanh` are exact on the positive half and lose digits on the
  // negative half, because break_eternity implements the inverses as the naive
  // closed forms — `asinh: ln(x + √(x²+1))` and `atanh: ln((1+x)/(1−x))/2` —
  // both of which cancel catastrophically for arguments in the saturated tail
  // (at x=-10, `x + √(x²+1)` is 4.5e-5, losing ~9 digits). Verified against
  // mpmath and `Math.asinh`, which both return exactly -10 where
  // break_eternity returns -10.000000133701262. Bounds are measured worst-case
  // over the domain, not chosen. Tightening these means binding a stable
  // inverse engine-side rather than deferring to the dependency.
  sinh: {
    op: (v) => F.sinh(v),
    domain: 'modest',
    tol: 1e-7,
    tolReason: 'upstream asinh cancels for negative arguments; measured 1.34e-8 at x=-10',
  },
  cosh: { op: (v) => F.cosh(v), domain: 'modestPositive' },
  tanh: {
    op: (v) => F.tanh(v),
    domain: 'modest',
    tol: 1e-9,
    tolReason: 'upstream atanh cancels as |x|→1; measured 4.48e-10 at x=-10',
  },
  asinh: { op: (v) => F.asinh(v), domain: 'modest' },
  acosh: { op: (v) => F.acosh(v), domain: 'atLeastOne' },
  atanh: { op: (v) => F.atanh(v), domain: 'unit' },
};

/** One orientation of a binary op: which side the variable sits on. */
type Orientation = {
  domain: DomainName;
  /** Values for the non-variable side, each swept against the whole domain. */
  consts: string[];
};

/**
 * Binary ops that bind an `invert`, per orientation. Both orientations are
 * swept because they invert through different branches — `invertPow`'s lhs
 * branch is a root and its rhs branch is a log ratio, and a table can be right
 * in one and wrong in the other.
 *
 * `layeradd` is excluded: it takes a third argument and its invert is
 * layer arithmetic rather than an algebraic pre-image.
 */
const BINARY: Record<
  string,
  Tolerance & {
    op: (a: DecimalSource, b: DecimalSource) => GenericFormula;
    lhs?: Orientation;
    rhs?: Orientation;
  }
> = {
  add: {
    op: (a, b) => F.add(a, b),
    lhs: { domain: 'real', consts: ['-7.5', '0', '3', '1e6'] },
    rhs: { domain: 'real', consts: ['-7.5', '0', '3', '1e6'] },
  },
  sub: {
    op: (a, b) => F.sub(a, b),
    lhs: { domain: 'real', consts: ['-7.5', '0', '3', '1e6'] },
    rhs: { domain: 'real', consts: ['-7.5', '0', '3', '1e6'] },
  },
  mul: {
    op: (a, b) => F.mul(a, b),
    lhs: { domain: 'real', consts: ['-7.5', '0.5', '3', '1e6'] },
    rhs: { domain: 'real', consts: ['-7.5', '0.5', '3', '1e6'] },
  },
  div: {
    op: (a, b) => F.div(a, b),
    lhs: { domain: 'real', consts: ['-7.5', '0.5', '3', '1e6'] },
    // `k / x` — x must stay away from 0 for the inverse to be conditioned.
    rhs: { domain: 'positive', consts: ['-7.5', '0.5', '3', '1e6'] },
  },
  log: {
    op: (a, b) => F.log(a, b),
    // log_base(x): x > 0, base > 1.
    lhs: { domain: 'positive', consts: ['2', '2.718281828459045', '10'] },
    // log_x(k): x is the base — positive and away from 1.
    rhs: { domain: 'atLeastOne', consts: ['100', '1e6'] },
  },
  pow: {
    op: (a, b) => F.pow(a, b),
    // x^k: x > 0 keeps non-integer exponents real.
    lhs: { domain: 'positive', consts: ['0.5', '2', '3', '-2'] },
    // k^x: invert is ln(value)/ln(k).
    rhs: { domain: 'real', consts: ['2', '10'] },
  },
  pow_base: {
    op: (a, b) => F.pow_base(a, b),
    // base^x, the canonical incremental cost curve.
    lhs: { domain: 'real', consts: ['1.15', '2', '10'] },
    // x^base.
    rhs: { domain: 'positive', consts: ['2', '3'] },
  },
  root: {
    op: (a, b) => F.root(a, b),
    lhs: { domain: 'positive', consts: ['2', '3', '10'] },
    rhs: { domain: 'atLeastOne', consts: ['100', '1e6'] },
  },
};

/**
 * Per-op relaxations for the oracle laws, where break_eternity's own accuracy —
 * not the engine's wiring — sets the ceiling. Same rule as {@link Tolerance}:
 * every entry states its measured reason. An empty entry means the op is held to
 * the default.
 */
const ORACLE_TOL: Record<string, Tolerance> = {
  // `asinh(x) = ln(x + √(x²+1))` cancels for negative x, and the severity scales
  // with the argument: relative error tracks ~ε·2x². At x=-10 that is 2.2e-15
  // (measured); it is what grows into the 1.34e-8 seen on `sinh`'s round-trip,
  // where the inverse is applied at x=-11013 instead. Positive arguments have no
  // cancellation and hold machine epsilon.
  asinh: {
    tol: 1e-14,
    tolReason: 'upstream cancellation for negative x; measured 2.2e-15 at x=-10',
  },
};
const INTEGRAL_TOL: Record<string, Tolerance> = {};

// === LAW HELPERS ===

/**
 * Relative error in the coordinate the comparison is made in. Absolute below
 * 1 so a round-trip to 0 doesn't divide by zero and doesn't get graded on an
 * impossible relative scale.
 */
function relativeError(got: DecimalSource, want: DecimalSource): Decimal {
  const scale = Decimal.max(Decimal.abs(want), 1);
  return new Decimal(Decimal.abs(Decimal.sub(got, want))).div(scale);
}

/**
 * Run `body` with `console.error` captured. The engine reports unsound
 * operations by logging rather than throwing, so a law that "passes" while the
 * engine logged `Cannot invert…` has not actually been verified.
 */
function withoutEngineErrors<T>(body: () => T): { value: T; errors: string[] } {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return { value: body(), errors: spy.mock.calls.map((c) => String(c[0])) };
  } finally {
    spy.mockRestore();
  }
}

/**
 * Largest magnitude a value-space comparison stays meaningful at. Above it,
 * break_eternity is storing a logarithm, and subtracting two such values throws
 * away the mantissa — so the comparison has to move into log space too.
 */
const VALUE_SPACE_CEILING = '1e300';

/**
 * Compare a computed value against the oracle's reference in whichever
 * coordinate is faithful at that magnitude.
 *
 * Below the ceiling: relative error in value space. Above it: absolute error in
 * log₁₀ space, which is the same statement about the ratio (a log₁₀ gap of
 * 1e-15 is a ratio within 1 + 3.5e-15) and keeps full mantissa sensitivity.
 * The log-space floor rises with the exponent's own magnitude — float64 ulp at
 * log₁₀ = 1000 is ~1e-13 — so `logTol` is deliberately looser than `tol`.
 */
function expectValueClose(
  got: DecimalSource,
  want: DecimalSource,
  { tol, logTol, label }: { tol: number; logTol: number; label: string },
) {
  if (Decimal.lte(Decimal.abs(want), VALUE_SPACE_CEILING)) {
    const err = relativeError(got, want);
    expect(
      Decimal.lte(err, tol),
      `${label}: got ${String(got)}, oracle ${String(want)} (relative error ${err.toString()} in value space, tolerance ${tol})`,
    ).toBe(true);
    return;
  }
  const err = Decimal.abs(Decimal.sub(Decimal.log10(got), Decimal.log10(want)));
  expect(
    Decimal.lte(err, logTol),
    `${label}: got ${String(got)}, oracle ${String(want)} (absolute error ${err.toString()} in log10 space, tolerance ${logTol})`,
  ).toBe(true);
}

/**
 * The round-trip law: inverting a forward evaluation returns the input.
 * Error is graded in input space — see the file header's rule 2.
 */
function expectRoundTrip(formula: GenericFormula, x: DecimalSource, tol: number) {
  const { value, errors } = withoutEngineErrors(() => {
    const y = formula.evaluate();
    return { y, back: formula.invert(y) };
  });
  expect(errors, `engine logged while round-tripping x=${String(x)}`).toEqual([]);
  const err = relativeError(value.back, x);
  expect(
    Decimal.lte(err, tol),
    `x=${String(x)} → evaluate=${String(value.y)} → invert=${String(value.back)}` +
      ` (relative error ${err.toString()} in input space, tolerance ${tol})`,
  ).toBe(true);
}

// === LAWS ===

describe('round-trip: invert(evaluate(x)) === x', () => {
  describe('unary ops', () => {
    for (const [name, { op, domain, tol = DEFAULT_TOL }] of Object.entries(UNARY)) {
      test(name, () => {
        for (const x of DOMAIN[domain]) {
          expectRoundTrip(op(F.variable(x)), x, tol);
        }
      });
    }
  });

  describe('binary ops', () => {
    for (const [name, { op, lhs, rhs, tol = DEFAULT_TOL }] of Object.entries(BINARY)) {
      if (lhs) {
        test(`${name}(var, k)`, () => {
          for (const k of lhs.consts) {
            for (const x of DOMAIN[lhs.domain]) {
              expectRoundTrip(op(F.variable(x), k), x, tol);
            }
          }
        });
      }
      if (rhs) {
        test(`${name}(k, var)`, () => {
          for (const k of rhs.consts) {
            for (const x of DOMAIN[rhs.domain]) {
              expectRoundTrip(op(k, F.variable(x)), x, tol);
            }
          }
        });
      }
    }
  });
});

describe('oracle fixture', () => {
  // The suite's own domains and the generator's are deliberately independent —
  // the round-trip laws need no oracle and own their sampling. That split is
  // only safe while both tables cover the same ops, so the drift is fenced
  // rather than trusted.
  test('covers exactly the unary ops the suite sweeps', () => {
    expect(Object.keys(oracle.unary).sort()).toEqual(Object.keys(UNARY).sort());
  });

  test('was generated at higher precision than the laws assert', () => {
    expect(oracle.significantDigits).toBeGreaterThanOrEqual(30);
    expect(oracle.generator).toMatch(/^mpmath /);
  });
});

describe('oracle: forward evaluation matches a high-precision reference', () => {
  // A round-trip passes whenever evaluate and invert are consistently wrong, and
  // it can't tell an implementation defect from the function's conditioning.
  // Only an independent reference separates those — see scripts/formula-oracle.py.
  for (const [name, { samples }] of Object.entries(oracle.unary)) {
    const { tol = 1e-15, tolReason } = ORACLE_TOL[name] ?? {};
    test(`${name}${tolReason ? ` (${tolReason})` : ''}`, () => {
      expect(samples.length).toBeGreaterThan(0);
      for (const { x, y } of samples) {
        const { value, errors } = withoutEngineErrors(() =>
          UNARY[name].op(F.variable(x)).evaluate(),
        );
        expect(errors, `engine logged evaluating ${name}(${x})`).toEqual([]);
        expectValueClose(value, y, { tol, logTol: 1e-12, label: `${name}(${x})` });
      }
    });
  }
});

describe('oracle: invert lands on the true pre-image', () => {
  // Fed the oracle's exact forward value rather than the engine's own, so a
  // compensating error in evaluate cannot mask a wrong inverse.
  for (const [name, { samples }] of Object.entries(oracle.unary)) {
    const { tol = DEFAULT_TOL, tolReason } = UNARY[name];
    test(`${name}${tolReason ? ` (${tolReason})` : ''}`, () => {
      for (const { x, y } of samples) {
        const { value, errors } = withoutEngineErrors(() =>
          UNARY[name].op(F.variable(x)).invert(y),
        );
        expect(errors, `engine logged inverting ${name} at ${y}`).toEqual([]);
        const err = relativeError(value, x);
        expect(
          Decimal.lte(err, tol),
          `${name}.invert(${y}) = ${String(value)}, want ${x}` +
            ` (relative error ${err.toString()} in input space, tolerance ${tol})`,
        ).toBe(true);
      }
    });
  }
});

describe('magnitude regimes: laws hold where no oracle can reach', () => {
  /**
   * Sample points by break_eternity regime. Layer 0 is an ordinary float; layer
   * 1 stores `10^mag`; layer 2 stores `10^10^mag`. Past layer 0 no external
   * reference can hold the value, so these are self-consistency and algebraic
   * laws rather than oracle comparisons — which is the correct instrument, not a
   * concession: break_eternity's representation is itself logarithmic there.
   */
  const REGIMES = {
    'layer 0': ['1e15', '1e100', '1e300'],
    'layer 1': ['1e400', '1e5000', '1e1000000', '1e1e15'],
    'layer 2': ['1e1e400'],
  } as const;

  /**
   * The accuracy a round-trip can possibly have at a given magnitude.
   *
   * Past layer 0 a value is stored as its logarithm in a float64, so the
   * exponent itself carries ulp error: at `x = 1e1000000` the exponent 1e6 has
   * an ulp of ~2.2e-10, and exponentiating back turns that into a relative
   * error of the same order in value space. Nothing can beat it while the
   * exponent is a float64 — so the bound is derived from the representation
   * rather than picked, and holding a layer-1 round-trip to 1e-10 would be
   * asserting something arithmetically impossible.
   *
   * The consumer-facing consequence, which belongs in the contract: a
   * first-passage computed at layer 1 carries roughly `16 − log₁₀(log₁₀ x)`
   * significant digits, not 16.
   */
  const EPSILON = 2.220446049250313e-16;
  function representationFloor(x: DecimalSource): number {
    const exponent = Math.abs(Decimal.log10(Decimal.abs(x)).toNumber());
    if (!Number.isFinite(exponent) || exponent <= 308) return DEFAULT_TOL;
    // ×4 headroom so the bound tracks the representation rather than one op's
    // particular rounding, and stays a fence instead of a knife-edge.
    return Math.max(DEFAULT_TOL, EPSILON * exponent * Math.LN10 * 4);
  }

  // Round-trip is graded in input space, so it stays meaningful at every layer:
  // the answer comes back into the same coordinate the input was stated in.
  describe('round-trip through log/exp pairs', () => {
    const PAIRS: Record<string, (v: DecimalSource) => GenericFormula> = {
      log10: (v) => F.log10(v),
      log2: (v) => F.log2(v),
      ln: (v) => F.ln(v),
      recip: (v) => F.recip(v),
    };
    for (const [regime, samples] of Object.entries(REGIMES)) {
      for (const [name, op] of Object.entries(PAIRS)) {
        test(`${name} — ${regime}`, () => {
          for (const x of samples) {
            expectRoundTrip(op(F.variable(x)), x, representationFloor(x));
          }
        });
      }
    }
  });

  // A homomorphism the representation must respect independently of any
  // reference: log₁₀(aᵏ) = k·log₁₀(a). Catches an exponent path that silently
  // saturates or loses the mantissa at layer boundaries.
  describe('log10(pow(a, k)) === k * log10(a)', () => {
    for (const [regime, samples] of Object.entries(REGIMES)) {
      test(regime, () => {
        for (const a of samples) {
          for (const k of ['2', '0.5', '7']) {
            const got = Decimal.log10(Decimal.pow(a, k));
            const want = Decimal.mul(k, Decimal.log10(a));
            const err = relativeError(got, want);
            expect(
              Decimal.lte(err, 1e-12),
              `a=${a}, k=${k}: log10(a^k)=${got.toString()}, k*log10(a)=${String(want)}` +
                ` (relative error ${err.toString()})`,
            ).toBe(true);
          }
        }
      });
    }
  });

  // Monotonicity is what makes a first-passage search well-founded, so it has to
  // survive into the layers where a closed-form inverse may not. Asserted on the
  // canonical incremental cost curve rather than in the abstract.
  test('exponential cost curve stays strictly increasing across layers', () => {
    const cost = F.pow_base(F.variable(0), '1.15');
    const levels = ['1', '10', '100', '1e3', '1e4', '1e5', '1e6', '1e7', '1e15'];
    let previous = cost.evaluate('0');
    for (const level of levels) {
      const current = cost.evaluate(level);
      expect(
        Decimal.gt(current, previous),
        `1.15^${level} = ${String(current)} did not exceed the previous level's ${String(previous)}`,
      ).toBe(true);
      previous = current;
    }
  });
});

describe('oracle: F(b) − F(a) equals the definite integral', () => {
  // `evaluateIntegral` is an antiderivative, not `∫₀ˣ` — `evaluateIntegral(0)`
  // is not 0. So the law that actually holds is the difference, where the
  // arbitrary constant cancels. Reference values come from adaptive quadrature.
  for (const { op, from, to, value } of oracle.integrals) {
    test(`${op} over [${from}, ${to}]`, () => {
      const formula = UNARY[op].op(F.variable(0));
      const { value: got, errors } = withoutEngineErrors(() =>
        Decimal.sub(formula.evaluateIntegral(to), formula.evaluateIntegral(from)),
      );
      expect(errors, `engine logged integrating ${op}`).toEqual([]);
      const { tol = 1e-12, tolReason } = INTEGRAL_TOL[op] ?? {};
      expectValueClose(got, value, {
        tol,
        logTol: 1e-12,
        label: `∫${op} over [${from}, ${to}]${tolReason ? ` (${tolReason})` : ''}`,
      });
    });
  }
});
