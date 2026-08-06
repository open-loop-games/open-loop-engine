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

import Formula, { F, calculateCost } from '@/core/formulas/formulas';
import { inversionTolerance } from '@/core/formulas/inversion';
import { findCrossing } from '@/core/formulas/root-find';
import type { GenericFormula, InvertibleFormula } from '@/core/formulas/types';
import { Decimal } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import { describe, expect, test, vi } from 'vitest';
import { ref } from 'vue';
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
  /**
   * x > 1 — a logarithm's *base*. Base 1 is undefined (`ln(k)/ln(1)` divides by
   * zero), and the round-trip law survives it only by coincidence: `evaluate`
   * gives Infinity and `invert(Infinity)` happens to come back to 1.
   */
  aboveOne: ['1.5', '2.5', '10', '137.5', '1e3', '1e7'],
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
    rhs: { domain: 'aboveOne', consts: ['100', '1e6'] },
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

describe('piecewise: step and if', () => {
  // `Formula.step` is the engine's existing piecewise-splice structure — the
  // composition the research vocabulary names as the genre's lead pattern, and
  // the shape a first-passage search has to do regime detection through. Its
  // laws were never swept.

  const MODIFIERS: Record<string, (v: never) => GenericFormula> = {
    // Continuous at the breakpoint: m(0) = 0, so the spliced function has no jump.
    sqrt: (v) => (v as unknown as GenericFormula).sqrt(),
    'mul 0.5': (v) => (v as unknown as GenericFormula).mul(0.5),
    'pow 0.75': (v) => (v as unknown as GenericFormula).pow(0.75),
  };

  test('below the breakpoint the value passes through unchanged', () => {
    for (const modifier of Object.values(MODIFIERS)) {
      const formula = F.step(F.variable(0), 100, modifier);
      for (const x of ['0', '1', '50', '99.9']) {
        expect(String(formula.evaluate(x)), `step passthrough at ${x}`).toBe(
          String(new Decimal(x)),
        );
      }
    }
  });

  test('round-trip holds for continuous modifiers, on both sides of the breakpoint', () => {
    for (const [name, modifier] of Object.entries(MODIFIERS)) {
      const formula = F.step(F.variable(0), 100, modifier);
      for (const x of ['50', '100', '110', '200', '1e6']) {
        const { value, errors } = withoutEngineErrors(() => {
          const y = formula.evaluate(x);
          return { y, back: formula.invert(y) };
        });
        expect(errors, `${name} logged at x=${x}`).toEqual([]);
        const err = relativeError(value.back, x);
        expect(
          Decimal.lte(err, DEFAULT_TOL),
          `step(${name}) x=${x} → ${String(value.y)} → ${String(value.back)} (error ${err.toString()})`,
        ).toBe(true);
      }
    }
  });

  test('a discontinuous modifier leaves targets with no pre-image', () => {
    // With m(0) ≠ 0 the splice jumps at the breakpoint: `add 5` maps 100 → 105,
    // so nothing evaluates into (100, 105). `invert` still answers there, and the
    // answer does not evaluate back.
    //
    // This is the *same* defect class as interior rounding — a target outside the
    // function's image — which is the useful part: one signal covers both. That
    // signal is now `tryInvert`; this law pins the raw `invert` path it grades,
    // which stays unchecked because the op table composes with it recursively.
    const formula = F.step(F.variable(0), 100, (v) => (v as unknown as GenericFormula).add(5));
    expect(String(formula.evaluate('100'))).toBe('105');

    const inGap = '102';
    const preimage = formula.invert(inGap);
    expect(
      Decimal.neq(formula.evaluate(preimage), inGap),
      `target ${inGap} sits in the image gap, yet invert returned ${String(preimage)} which evaluates back to ${String(formula.evaluate(preimage))}`,
    ).toBe(true);
  });

  test('if/conditional round-trips through whichever branch is live', () => {
    const condition = ref(true);
    const formula = F.if(
      F.variable(0),
      condition,
      (v) => (v as unknown as GenericFormula).mul(2),
      (v) => (v as unknown as GenericFormula).mul(10),
    );
    for (const live of [true, false]) {
      condition.value = live;
      for (const x of ['0', '2.5', '100', '1e6']) {
        const { value, errors } = withoutEngineErrors(() => {
          const y = formula.evaluate(x);
          return { y, back: formula.invert(y) };
        });
        expect(errors, `if(${String(live)}) logged at x=${x}`).toEqual([]);
        expect(
          Decimal.lte(relativeError(value.back, x), DEFAULT_TOL),
          `if(${String(live)}) x=${x} → ${String(value.y)} → ${String(value.back)}`,
        ).toBe(true);
      }
    }
  });
});

describe('root finding: findCrossing', () => {
  // The numeric fallback three inverses now share. Swept directly as well as
  // through them, because its two interesting properties — the search coordinate
  // and the refusal to early-out on value tolerance — are invisible from the
  // callers that consume it.

  test('lands on the root of a polynomial with no closed form', () => {
    // x³/3 + 2x, the shape `integrateAdd` hits for a cubic integral. Verified
    // against the forward function rather than a precomputed root, so the law
    // states the property instead of a number.
    const f = (x: Decimal) => Decimal.add(Decimal.div(Decimal.pow(x, 3), 3), Decimal.mul(2, x));
    for (const target of ['1', '100', '1e6', '1e30']) {
      const x = findCrossing(f, target);
      expect(x, `target ${target}`).not.toBeNull();
      expect(
        Decimal.lte(relativeError(f(x!), target), DEFAULT_TOL),
        `target ${target}: f(${String(x)}) = ${String(f(x!))}`,
      ).toBe(true);
    }
  });

  test('the search coordinate follows the bracket, so wide brackets still converge', () => {
    // The property that makes one shared finder viable. `10^x` crossing 1e250
    // has its answer at 250 while the bracket opens to ~1e250: bisecting that
    // arithmetically needs thousands of halvings to walk down, and the default
    // 60 would stop nowhere near. Geometric halving gets there in tens.
    const x = findCrossing((v) => Decimal.pow10(v), '1e250', { upper: '1e250' });
    expect(x).not.toBeNull();
    expect(Decimal.lte(relativeError(x!, 250), DEFAULT_TOL), `got ${String(x)}`).toBe(true);
  });

  test('a target already reached at the domain floor answers with the floor', () => {
    // Not a failure: the first x in the declared domain that reaches the target
    // *is* `lower`. Reporting here would make every "already affordable" query
    // an error.
    const x = findCrossing((v) => Decimal.mul(v, 2), '-5', { lower: 0 });
    expect(x).not.toBeNull();
    expect(String(x)).toBe('0');
  });

  test('an unbracketable target returns null rather than the bound it never crossed', () => {
    // A bounded function: `tanh`-like saturation at 10. Nothing reaches 20, and
    // the old per-caller loops would have returned their final `hi` regardless.
    const x = findCrossing((v) => Decimal.min(v, 10), '20');
    expect(x).toBeNull();
  });

  test('convergence is by bracket collapse, not by value tolerance', () => {
    // The rationale inherited from the hand-rolled loops: at tetration scale a
    // relative-value early-out can fire while x is still far from the root,
    // because dv/dx is enormous. `2 ↑↑ x`-shaped steepness — a tiny x error is a
    // vast value error, so the only safe statement is about x.
    const f = (v: Decimal) => Decimal.pow10(Decimal.pow10(v));
    const x = findCrossing(f, f(new Decimal('2.5')));
    expect(x).not.toBeNull();
    expect(Decimal.lte(relativeError(x!, '2.5'), 1e-14), `got ${String(x)}`).toBe(true);
  });
});

describe('invert contract: tryInvert grades the answer', () => {
  // `invert` returns the algebra's pre-image whether or not it is reachable.
  // `tryInvert` grades it by mapping the candidate forward, which is the only
  // way to answer a question that depends on *(chain, target)* rather than on
  // the chain alone. These laws pin each arm of the contract to the defect that
  // motivated it.

  /**
   * Image-check tolerance where it differs from the round-trip's. The round-trip
   * grades in *input* space against `max(|x|, 1)`; the image check grades in
   * *output* space against the target. For `sinh` at x=-10 the two differ by
   * exactly that factor of 10: break_eternity's naive `asinh` cancels, leaving
   * 1.34e-7 of absolute input error, and `cosh(10)/sinh(10) ≈ 1` transfers it
   * ~1:1 into output-space relative error.
   */
  const IMAGE_TOL: Record<string, number> = { sinh: 2e-7 };

  test('every op that round-trips is graded exact', () => {
    // The strongest form of the contract: the image check must not reject
    // anything the round-trip law already accepts.
    for (const [name, { op, domain, tol = DEFAULT_TOL }] of Object.entries(UNARY)) {
      for (const x of DOMAIN[domain]) {
        const formula = op(F.variable(x));
        const { value, errors } = withoutEngineErrors(() =>
          formula.tryInvert(formula.evaluate(), IMAGE_TOL[name] ?? tol),
        );
        expect(errors, `${name} logged at x=${x}`).toEqual([]);
        expect(value.reason, `${name} at x=${x} (value ${String(value.value)})`).toBe('exact');
      }
    }
  });

  test('every binary op that round-trips is graded exact, both orientations', () => {
    for (const [name, { op, lhs, rhs, tol = DEFAULT_TOL }] of Object.entries(BINARY)) {
      for (const [label, side, build] of [
        ['var,k', lhs, (x: string, k: string) => op(F.variable(x), k)],
        ['k,var', rhs, (x: string, k: string) => op(k, F.variable(x))],
      ] as const) {
        if (!side) continue;
        for (const k of side.consts) {
          for (const x of DOMAIN[side.domain]) {
            const formula = build(x, k);
            const { value, errors } = withoutEngineErrors(() =>
              formula.tryInvert(formula.evaluate(), tol),
            );
            expect(errors, `${name}(${label}) logged at x=${x}, k=${k}`).toEqual([]);
            expect(value.reason, `${name}(${label}) at x=${x}, k=${k}`).toBe('exact');
          }
        }
      }
    }
  });

  describe('outside-image — the target has no pre-image', () => {
    test('interior rounding: a fractional level through the documented Skill curve', () => {
      // `xpToLevel: variable(xp).div(scale).sqrt().floor()` is the pattern
      // `skill.ts` documents. Passthrough inversion is *correct* for integer
      // targets — that is what the progress-bar callers ask for — and silently
      // wrong for anything between breakpoints. Same chain, both outcomes,
      // which is why no chain-only boolean can answer.
      const xpToLevel = F.variable(0).div(50).sqrt().floor();

      for (const [level, xp] of [
        ['1', '50'],
        ['2', '200'],
        ['3', '450'],
        ['10', '5000'],
      ]) {
        const result = xpToLevel.tryInvert(level);
        expect(result.reason, `level ${level}`).toBe('exact');
        expect(String(result.value), `level ${level}`).toBe(String(new Decimal(xp)));
      }

      const fractional = xpToLevel.tryInvert('3.5');
      expect(fractional.reason).toBe('outside-image');
      // The algebraic pre-image is still returned — a progress bar wants it.
      expect(Decimal.lte(relativeError(fractional.value!, '612.5'), DEFAULT_TOL)).toBe(true);
      expect(fractional.reason === 'outside-image' && String(fractional.evaluatesTo)).toBe('3');
    });

    test('a step splice with a discontinuous modifier', () => {
      // The gap `add 5` opens at the breakpoint. Nothing evaluates into
      // (100, 105), and the contract now says so rather than answering.
      const formula = F.step(F.variable(0), 100, (v) => (v as unknown as GenericFormula).add(5));
      const { value, errors } = withoutEngineErrors(() => formula.tryInvert('102'));
      expect(errors).toEqual([]);
      expect(value.reason).toBe('outside-image');
    });

    test('a saturated min / max / clamp', () => {
      // The clamp family inverts by passthrough, so a target past the bound
      // gets an answer that saturates back to the bound.
      const cases: [string, GenericFormula, string][] = [
        ['min', F.min(F.variable(0), 200), '500'],
        ['max', F.max(F.variable(0), 200), '100'],
        ['clamp', F.clamp(F.variable(0), 0, 200), '500'],
        ['clampMax', F.clampMax(F.variable(0), 200), '500'],
      ];
      for (const [name, formula, target] of cases) {
        const { value, errors } = withoutEngineErrors(() => formula.tryInvert(target));
        expect(errors, `${name} logged`).toEqual([]);
        expect(value.reason, `${name} at target ${target}`).toBe('outside-image');
      }
    });
  });

  test('not-invertible — the unary ops that bind no inverse', () => {
    // These correctly report `isInvertible() === false`, and `invert` used to
    // answer for them anyway: its bare-variable fallback keyed on arity alone,
    // so any one-input op with no inverse fell through it and got `value` back
    // unchanged. Carried from the 2026-05-26 audit, where it was recorded
    // against `sign`/`abs` only — the real set is all seven.
    for (const name of ['sign', 'abs', 'pLog10', 'absLog10', 'factorial', 'gamma', 'lngamma']) {
      const formula = (F as unknown as Record<string, (v: GenericFormula) => GenericFormula>)[name](
        F.variable('5'),
      );
      expect(formula.isInvertible(), `${name} claims invertibility`).toBe(false);
      const { value, errors } = withoutEngineErrors(() => formula.tryInvert('5'));
      expect(errors, `${name} logged instead of reporting structurally`).toEqual([]);
      expect(value.reason, name).toBe('not-invertible');
      expect(value.value, name).toBeNull();
    }
  });

  test('a bare variable still inverts as the identity', () => {
    // The fallback the fix above narrowed. Tightening it to `internalEvaluate ==
    // null` must not cost the legitimate case.
    const result = F.variable('7').tryInvert('12');
    expect(result.reason).toBe('exact');
    expect(String(result.value)).toBe('12');
  });

  test('no-solution — distinguished from having no inverse at all', () => {
    // The arm earns its separation by being *target*-dependent where
    // `not-invertible` is structural. Each of these binds an inverse and reports
    // `isInvertible() === true`; the target is what has no pre-image. The
    // tetration heights that used to sit here are now solved numerically, which
    // is the point of keeping the two arms apart — widening one didn't have to
    // touch consumers of the other.
    for (const [label, formula, target] of [
      ['tetrate height 0 (base cannot influence the result)', F.tetrate(F.variable('2'), 0), '16'],
      ['iteratedexp height 0', F.iteratedexp(F.variable('2'), 0), '16'],
    ] as const) {
      expect(formula.isInvertible(), `${label} should look invertible`).toBe(true);
      const { value, errors } = withoutEngineErrors(() => formula.tryInvert(target));
      expect(errors, `${label} logged instead of reporting structurally`).toEqual([]);
      expect(value.reason, label).toBe('no-solution');
      expect(value.value, label).toBeNull();
    }
  });

  test('the magnitude-derived tolerance is load-bearing, not decorative', () => {
    // Past layer 0 a value is stored as its logarithm in a float64, so the
    // exponent carries ulp error and the image check cannot demand 1e-10. If it
    // did, a spine consumer computing a crossing at layer 1 would be told its
    // arithmetic is outside the image when it is as exact as the representation
    // allows.
    const formula = F.variable(0).pow10();
    for (const x of ['1e6', '1e9']) {
      const target = formula.evaluate(x);
      expect(formula.tryInvert(target).reason, `pow10 at x=${x}`).toBe('exact');
      expect(inversionTolerance(target), `tolerance at x=${x}`).toBeGreaterThan(1e-10);
    }
    // Layer 0 keeps the strict floor, and so does the low end of layer 1 — the
    // exponent's ulp only overtakes 1e-10 above ~1e10^4.9.
    expect(inversionTolerance('1e100')).toBe(1e-10);
    expect(inversionTolerance(formula.evaluate('1e3'))).toBe(1e-10);
  });

  test('tryInvertIntegral grades the integral the same way', () => {
    const formula = F.variable(0).pow_base(1.15).mul(100);
    const cumulative = formula.evaluateIntegral(50);
    const result = formula.tryInvertIntegral(cumulative);
    expect(result.reason).toBe('exact');
    expect(Decimal.lte(relativeError(result.value!, 50), DEFAULT_TOL)).toBe(true);

    // Non-integrable chain: no answer, and the reason is structural. `factorial`
    // binds no integral — `sin` does, so it is not the example it looks like.
    const { value, errors } = withoutEngineErrors(() =>
      F.variable(0).factorial().tryInvertIntegral('1'),
    );
    expect(errors).toEqual([]);
    expect(value.reason).toBe('not-invertible');
    expect(value.value).toBeNull();
  });
});

describe('first passage: the smallest input that reaches the target', () => {
  // The third arm of the same story. `invert` answers the algebraic pre-image,
  // `tryInvert` grades whether that answer is reachable, and `firstPassage`
  // answers the question a time axis actually asked. The laws below pin where
  // the first two diverge from the third — and, first, that they don't diverge
  // where the target is genuinely in the image.

  test('agrees with invert on a continuous invertible chain', () => {
    // The load-bearing non-divergence law. If these came apart, `firstPassage`
    // would be a second, subtly different algebra rather than the same answer
    // reached by another route.
    const formula = F.variable(0).pow(2).mul(10).add(100);
    for (const target of ['110', '350', '1e6', '1e30']) {
      const { value, errors } = withoutEngineErrors(() => formula.firstPassage(target));
      expect(errors, `target ${target}`).toEqual([]);
      expect(value.reason, `target ${target}`).toBe('crossed');
      expect(
        Decimal.lte(relativeError(value.value!, formula.invert(target)), DEFAULT_TOL),
        `target ${target}: passage ${String(value.value)}, invert ${String(formula.invert(target))}`,
      ).toBe(true);
    }
  });

  test('reproduces a shipped stepped-burn schedule that invert misses', () => {
    // multiverse-hr's operating-burn spine (`src/balance/drain-projection.ts`):
    // burn = B₀·g^(⌊t/T_g⌋+½), and the run ends when it overtakes P_max. The
    // shipped hand-roll computes the crossing as T_g·⌈log_g H − ½⌉; written as
    // an ordinary chain the `.floor()` is *interior*, so the algebra lands on
    // the step's centre rather than its boundary — off by T_g·frac(log_g H),
    // up to a full T_g. The law states the hand-roll's formula, not its numbers.
    const [g, tg, b0] = [2, 15, 6];
    const burn = F.variable(0).div(tg).floor().add(0.5).pow_base(g).mul(b0);

    for (const h of [4, 8, 16, 32, 100]) {
      const shipped = tg * Math.ceil(Math.log(h) / Math.log(g) - 0.5);
      const { value, errors } = withoutEngineErrors(() => burn.firstPassage(b0 * h));
      expect(errors, `H=${h}`).toEqual([]);
      expect(value.reason, `H=${h}`).toBe('crossed');
      expect(String(value.value), `H=${h}`).toBe(String(shipped));
      // …and the algebra really does miss it, so the law fails if the
      // divergence this method exists for ever quietly closes.
      expect(burn.tryInvert(b0 * h).reason, `H=${h}`).toBe('outside-image');
    }
  });

  test('answers the next breakpoint where an interior floor has no pre-image', () => {
    // The documented Skill curve. At an integer level the two agree, because
    // that is exactly what rounding passthrough answers exactly for. At 3.5 the
    // level axis has no such value: nothing evaluates to 3.5, so the smallest
    // XP that *reaches* it is the start of level 4, while `invert` hands back a
    // number from inside the gap.
    const xpToLevel = F.variable(0).div(50).sqrt().floor();

    expect(String(xpToLevel.firstPassage(3).value)).toBe('450');
    expect(xpToLevel.tryInvert(3).reason).toBe('exact');

    const fractional = xpToLevel.firstPassage(3.5);
    expect(fractional.reason).toBe('crossed');
    expect(xpToLevel.tryInvert(3.5).reason).toBe('outside-image');
    // Stated as the property, not the number: the answer is the smallest
    // *representable* input whose evaluation reaches 3.5. That sits one ulp
    // under the exact 800, because `sqrt(15.999999999999998)` rounds to 4 in
    // break_eternity's arithmetic — a fact about the representation, not slack
    // in the search, and the law would hide a real regression if it demanded
    // the prettier number.
    expect(String(xpToLevel.evaluate(fractional.value!))).toBe('4');
    expect(Decimal.lte(relativeError(fractional.value!, 800), 1e-15)).toBe(true);
  });

  test('answers the far side of a step splice’s jump discontinuity', () => {
    // Where the modifier does not vanish at the breakpoint the splice jumps, so
    // targets inside the gap have no pre-image at all — the defect class leaf 1
    // collapsed into `outside-image`. A first passage has a real answer here:
    // the breakpoint itself, where the curve lands on the far side of the jump.
    const spliced = F.step(F.variable(0), 10, (f) => f.add(5));
    expect(String(spliced.evaluate(9.9))).toBe('9.9');
    expect(String(spliced.evaluate(10))).toBe('15');

    const passage = spliced.firstPassage(12);
    expect(passage.reason).toBe('crossed');
    expect(String(passage.value)).toBe('10');
  });

  test('reports rather than answers when a clamp saturates below the target', () => {
    // `min`/`max`/`clamp` invert by passthrough, so the algebra answers for a
    // target the curve can never produce. The search cannot bracket it and says
    // so; below the cap it answers normally.
    const capped = F.variable(0).mul(2).clamp(0, 50);
    expect(capped.firstPassage('80')).toEqual({ value: null, reason: 'no-crossing' });
    expect(String(capped.firstPassage(50).value)).toBe('25');
  });

  test('answers for chains that have no inverse at all', () => {
    // The capability that falls out of searching the forward function: nothing
    // here binds an inverse, and `isInvertible()` correctly says so. This is the
    // forward-only evaluator class (outermost `ceil`/`floor`/`min`/`max`) that
    // the algebra could never serve.
    const absolute = F.variable(0).abs().mul(3);
    expect(absolute.isInvertible()).toBe(false);

    const { value, errors } = withoutEngineErrors(() => absolute.firstPassage(30));
    expect(errors).toEqual([]);
    expect(value.reason).toBe('crossed');
    expect(String(value.value)).toBe('10');
  });

  test('distinguishes a target already met at the domain floor from a crossing', () => {
    // A legitimate answer, not a failure — "when do I reach X" is answered by
    // "you already have" — but a caller driving a countdown wants to say that
    // rather than render a zero it can't tell from a computed crossing.
    const formula = F.variable(0).add(100);
    expect(formula.firstPassage(50)).toEqual({ value: new Decimal(0), reason: 'already-reached' });
    expect(formula.firstPassage(150).reason).toBe('crossed');
  });

  test('refuses a descending curve instead of reporting its floor', () => {
    // The precondition failure that would otherwise be silent *and* plausible:
    // for a falling curve `f(lower) ≥ target` is true at the floor, so an
    // unguarded search reports 0 — a confident wrong answer to "when does this
    // drop below X". Bisection cannot detect the violation, so the floor case
    // probes forward before claiming it.
    const draining = F.variable(0).neg().add(100);
    expect(draining.firstPassage(50)).toEqual({ value: null, reason: 'not-monotone' });
  });

  test('refuses a domain floor the curve is not real-valued at', () => {
    // break_eternity's `gte` answers `true` against NaN, so an unguarded
    // comparison at the floor turns an undefined point into "already reached".
    // `recip` at 0 is the reachable case: 1/0 is NaN, not Infinity.
    const reciprocal = F.variable(1).recip().mul(1000);
    expect(String(reciprocal.evaluate(0))).toBe('NaN');
    expect(reciprocal.firstPassage(10)).toEqual({ value: null, reason: 'not-monotone' });
  });

  test('crosses at layer 1, where the answer is the exponent', () => {
    // A spine consumer computing a crossing time up here gets an answer floored
    // by the representation rather than the search: past layer 0 the value is a
    // logarithm in a float64, worth ~16 − log₁₀(log₁₀ x) significant digits.
    const tower = F.variable(0).pow_base(10);
    const passage = tower.firstPassage('1e250');
    expect(passage.reason).toBe('crossed');
    expect(Decimal.lte(relativeError(passage.value!, 250), DEFAULT_TOL)).toBe(true);
  });
});

describe('cumulative cost: integral vs discrete sum', () => {
  // The two are different operations, and `calculateCost` selects between them
  // by `directSum` — which is exactly the ambiguity the umbrella's integral
  // uncertainty is about. Pinning both halves so any renaming or splitting has
  // to preserve the arithmetic.

  /** Σ f(start + i) for i in [0, n) — the definition of a discrete bulk cost. */
  function discreteSum(formula: GenericFormula, start: DecimalSource, n: number): Decimal {
    let total = new Decimal(0);
    for (let i = 0; i < n; i++) {
      total = total.add(formula.evaluate(Decimal.add(start, i)));
    }
    return total;
  }

  const CURVES: Record<string, () => GenericFormula> = {
    'exponential 10·1.15ⁿ': () => Formula.exponential(0, 10, 1.15),
    'linear 5n+10': () => Formula.linear(0, 10, 5),
    'polynomial 10n²': () => Formula.polynomial(0, 10, 2),
  };

  for (const [name, build] of Object.entries(CURVES)) {
    test(`${name} — calculateCost reproduces Σ f(i) exactly`, () => {
      const formula = build() as InvertibleFormula;
      for (const n of [1, 2, 5, 8]) {
        const cost = calculateCost(formula, n, true);
        const truth = discreteSum(formula, 0, n);
        expect(
          Decimal.lte(relativeError(cost, truth), 1e-12),
          `${name} n=${n}: calculateCost=${String(cost)}, Σ=${truth.toString()}`,
        ).toBe(true);
      }
    });
  }

  test('the continuous cumulative is a different number, and now a different call', () => {
    // Not a defect — a continuous antiderivative genuinely disagrees with a
    // discrete sum for a convex curve. What was a defect is the two sharing one
    // name, so that a consumer indexing by level reached for `calculateCost`
    // and silently got this gap charged to it. Both remain reachable; they are
    // no longer reachable by accident.
    const formula = Formula.exponential(0, 10, 1.15) as InvertibleFormula;
    const n = 8;
    const summed = discreteSum(formula, 0, n);
    expect(Decimal.lte(relativeError(calculateCost(formula, n, true), summed), 1e-12)).toBe(true);

    const area = formula.cumulative(0, n);
    expect(Decimal.neq(area, summed)).toBe(true);
    // The gap is the geometric boundary term (s−1)/ln s, exactly — 7.33% here.
    const ratio = new Decimal(area).div(summed).toNumber();
    expect(ratio).toBeCloseTo(0.15 / Math.log(1.15), 10);
  });
});

describe('tetration family', () => {
  // No external reference reaches here, and these ops are where an inverse is
  // most likely to be wrong: each takes auxiliary arguments (height, base,
  // payload) that the inverse has to honour, and upstream dropped several of
  // them behind `eslint-disable no-unused-vars` rather than reporting.
  // `lambertw` earns its own sweep by being load-bearing in four integral
  // inversions (`operations.ts` log/log2/log10/ln).

  test('lambertw — w·eʷ recovers the argument', () => {
    for (const x of ['0.5', '2', '10', '1e10', '1e100', '1e300']) {
      expectRoundTrip(F.lambertw(F.variable(x)), x, 1e-12);
    }
  });

  test('ssqrt — inverts xˣ', () => {
    for (const x of ['1.5', '2', '3', '10']) {
      expectRoundTrip(F.ssqrt(F.variable(x)), x, DEFAULT_TOL);
    }
  });

  test('tetrate at height 2 — ssqrt is the exact inverse', () => {
    for (const base of ['1.5', '2', '3', '10']) {
      expectRoundTrip(F.tetrate(F.variable(base), 2), base, DEFAULT_TOL);
    }
  });

  test('tetrate above height 2 — solved numerically in the base', () => {
    // `ssqrt` inverts `b^b` alone. Applying it at height 3 returned a
    // plausible-looking wrong number (2.745 for `tetrate(2, 3) = 16`); the
    // interim contract reported instead. Now `findCrossing` solves for the base,
    // which is a well-conditioned search even where the value is at layer 2 —
    // the answer lives in a bracket a few units wide no matter how tall the
    // tower. `b ↑↑ 5` at base 3 is `ee3638334640023.79`, and the base still
    // comes back exactly.
    for (const height of [3, 4, 5]) {
      for (const base of ['1.5', '2', '3']) {
        expectRoundTrip(F.tetrate(F.variable(base), height), base, DEFAULT_TOL);
      }
    }
  });

  test('tetrate at height 2 with a payload — also solved numerically', () => {
    // `ssqrt` only covers payload 1, which is why the closed form is guarded to
    // it. Any other payload takes the search.
    for (const payload of ['2', '5']) {
      for (const base of ['1.5', '2', '3']) {
        expectRoundTrip(F.tetrate(F.variable(base), 2, payload), base, DEFAULT_TOL);
      }
    }
  });

  test('tetrate where the base cannot reach the target — still reports', () => {
    // Height 0 is `payload` regardless of base, so no base solves for 16. The
    // search reports rather than returning a bound it never crossed — which is
    // what keeps the `no-solution` arm honest now that the closed-form gaps are
    // filled.
    const formula = F.tetrate(F.variable('2'), 0);
    const { value, errors } = withoutEngineErrors(() => formula.tryInvert('16'));
    expect(errors).toEqual([]);
    expect(value.reason).toBe('no-solution');
    expect(value.value).toBeNull();
  });

  test('slog — inverse is base ↑↑ y, carrying the base', () => {
    for (const base of ['2', '10']) {
      for (const x of ['1e10', '1e100']) {
        expectRoundTrip(F.slog(F.variable(x), base), x, 1e-9);
      }
    }
  });

  test('layeradd — inverse carries the base', () => {
    for (const base of ['2', '10']) {
      for (const diff of ['1', '2']) {
        for (const x of ['1e10', '1e100']) {
          expectRoundTrip(F.layeradd(F.variable(x), diff, base), x, 1e-9);
        }
      }
    }
  });

  test('iteratedexp at height 1 — degenerates to base^payload and inverts', () => {
    for (const payload of ['1', '2']) {
      for (const x of ['1.5', '2', '3']) {
        expectRoundTrip(F.iteratedexp(F.variable(x), 1, payload), x, 1e-9);
      }
    }
  });

  test('iteratedexp above height 1 — solved numerically in the base', () => {
    for (const height of [2, 3]) {
      for (const base of ['1.5', '2', '3']) {
        expectRoundTrip(F.iteratedexp(F.variable(base), height), base, DEFAULT_TOL);
      }
    }
  });
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

  // Binary ops integrate through a different path per orientation — `integrateX`
  // dispatches on which side holds the variable, and `integrateAdd`/`integrateSub`
  // additionally branch between a closed-form quadratic and bisection. A single
  // orientation would leave half of that untested.
  for (const { op, side, k, from, to, value } of oracle.binaryIntegrals) {
    test(`${op}(${side === 'lhs' ? `var, ${k}` : `${k}, var`}) over [${from}, ${to}]`, () => {
      const build = BINARY[op].op;
      const formula = side === 'lhs' ? build(F.variable(0), k) : build(k, F.variable(0));
      const { value: got, errors } = withoutEngineErrors(() =>
        Decimal.sub(formula.evaluateIntegral(to), formula.evaluateIntegral(from)),
      );
      expect(errors, `engine logged integrating ${op}(${side})`).toEqual([]);
      const { tol = 1e-12, tolReason } = INTEGRAL_TOL[`${op}.${side}`] ?? {};
      expectValueClose(got, value, {
        tol,
        logTol: 1e-12,
        label: `∫${op}(${side}, k=${k})${tolReason ? ` (${tolReason})` : ''}`,
      });
    });
  }
});
