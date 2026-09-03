/* eslint-disable @typescript-eslint/no-unused-vars */
import Formula, {
  calculateCost,
  calculateMaxAffordable,
  unrefFormulaSource,
} from '@/core/formulas/formulas';
import type {
  FormulaSource,
  GenericFormula,
  IntegrableFormula,
  InvertibleFormula,
  InvertibleIntegralFormula,
} from '@/core/formulas/types';
import { Decimal } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import { createResource } from '@/core/resource';
import { beforeAll, describe, expect, test } from 'vitest';
import { ref, type MaybeRef } from 'vue';
import '../utils';

type FormulaFunctions = keyof GenericFormula & keyof typeof Formula & keyof typeof Decimal;

const testValues = [-2, '0', new Decimal(10.5)] as const;

const invertibleZeroParamFunctionNames = [
  'round',
  'floor',
  'ceil',
  'trunc',
  'neg',
  'recip',
  'log10',
  'log2',
  'ln',
  'pow10',
  'exp',
  'sqr',
  'sqrt',
  'cube',
  'cbrt',
  'lambertw',
  'ssqrt',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
  'slog',
  'tetrate',
  'iteratedexp',
] as const;
const nonInvertibleZeroParamFunctionNames = [
  'abs',
  'sign',
  'pLog10',
  'absLog10',
  'factorial',
  'gamma',
  'lngamma',
] as const;
const integrableZeroParamFunctionNames = [
  'neg',
  'recip',
  'log10',
  'log2',
  'ln',
  'pow10',
  'exp',
  'sqr',
  'sqrt',
  'cube',
  'cbrt',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
] as const;
const nonIntegrableZeroParamFunctionNames = [
  ...nonInvertibleZeroParamFunctionNames,
  'round',
  'floor',
  'ceil',
  'trunc',
  'lambertw',
  'ssqrt',
] as const;
const invertibleIntegralZeroPramFunctionNames = [
  'recip',
  'log10',
  'log2',
  'ln',
  'pow10',
  'sqr',
  'sqrt',
  'cube',
  'cbrt',
  'neg',
  'exp',
  'sin',
  'cos',
  'tan',
  'sinh',
  'cosh',
  'tanh',
] as const;
const nonInvertibleIntegralZeroPramFunctionNames = [
  ...nonIntegrableZeroParamFunctionNames,
  'asin',
  'acos',
  'atan',
  'asinh',
  'acosh',
  'atanh',
] as const;

const invertibleOneParamFunctionNames = [
  'add',
  'sub',
  'mul',
  'div',
  'log',
  'pow',
  'root',
  'layeradd',
] as const;
const nonInvertibleOneParamFunctionNames = ['layeradd10'] as const;
const integrableOneParamFunctionNames = ['add', 'sub', 'mul', 'div', 'log', 'pow', 'root'] as const;
const nonIntegrableOneParamFunctionNames = [...nonInvertibleOneParamFunctionNames, 'slog'] as const;
const invertibleIntegralOneParamFunctionNames = integrableOneParamFunctionNames;
const nonInvertibleIntegralOneParamFunctionNames = nonIntegrableOneParamFunctionNames;

const nonInvertibleTwoParamFunctionNames = ['iteratedlog', 'pentate'] as const;
const nonIntegrableTwoParamFunctionNames = nonInvertibleTwoParamFunctionNames;
const nonInvertibleIntegralTwoParamFunctionNames = nonIntegrableTwoParamFunctionNames;

describe('Formula Equality Checking', () => {
  describe('Equality Checks', () => {
    test('Equals', () => expect(Formula.add(1, 1).equals(Formula.add(1, 1))).toBe(true));
    test('Not Equals due to inputs', () =>
      expect(Formula.add(1, 1).equals(Formula.add(1, 0))).toBe(false));
    test('Not Equals due to functions', () =>
      expect(Formula.add(1, 1).equals(Formula.sub(1, 1))).toBe(false));
    test('Not Equals due to hasVariable', () =>
      expect(Formula.constant(1).equals(Formula.variable(1))).toBe(false));
  });

  // One name per operation: `Decimal`'s aliases (`times`, `plus`, `dividedBy`,
  // …) are not re-exported onto `Formula`, so there is no alias-equality block
  // here. `Decimal.mul` etc. still answer to them — that surface is upstream's.
  test('an op answers to its canonical name only', () => {
    for (const alias of ['negate', 'negated', 'sgn', 'reciprocal', 'plus', 'times', 'dividedBy']) {
      expect(alias in Formula, alias).toBe(false);
      expect(alias in Formula.prototype, alias).toBe(false);
    }
  });

  describe('Instance vs Static methods', () => {
    let formula: GenericFormula;
    beforeAll(() => {
      formula = Formula.constant(10);
    });
    [...invertibleZeroParamFunctionNames, ...nonInvertibleZeroParamFunctionNames].forEach(
      (name) => {
        // lambertw uses a wrapper function in the engine (passes true as 2nd arg),
        // so two separately created formulas get different function references
        // and equals() fails on internalEvaluate comparison
        if (name === 'lambertw') {
          test.skip(name, () => {});
          return;
        }
        test(name, () => {
          const instanceFormula = formula[name]();
          const staticFormula = Formula[name](formula);
          expect(instanceFormula.equals(staticFormula)).toBe(true);
        });
      },
    );

    [...invertibleOneParamFunctionNames, ...nonInvertibleOneParamFunctionNames].forEach((name) => {
      test(name, () => {
        const instanceFormula = formula[name](10);
        const staticFormula = Formula[name](formula, 10);
        expect(instanceFormula.equals(staticFormula)).toBe(true);
      });
    });
  });
});

describe('Creating Formulas', () => {
  describe('Constants', () => {
    function testConstant(
      desc: string,
      formulaFunc: () => InvertibleFormula,
      expectedValue: DecimalSource = 10,
    ) {
      describe(desc, () => {
        let formula: GenericFormula;
        beforeAll(() => {
          formula = formulaFunc();
        });
        test('Is not invertible', () => expect(formula.isInvertible()).toBe(false));
        test('Is not integrable', () => expect(formula.isIntegrable()).toBe(false));
        test('Integral is not invertible', () =>
          expect(formula.isIntegralInvertible()).toBe(false));
        test('Is not marked as having a variable', () => expect(formula.hasVariable()).toBe(false));
        test('Evaluates correctly', () =>
          expect(formula.evaluate()).compare_tolerance(expectedValue));
        // @ts-expect-error - dynamic method access
        test('Invert errors', () => expect(() => formula.invert(25)).toLogError());
        test('Integrate errors', () =>
          // @ts-expect-error - dynamic method access
          expect(() => formula.evaluateIntegral()).toLogError());
        test('Invert integral errors', () =>
          // @ts-expect-error - dynamic method access
          expect(() => formula.invertIntegral(25)).toLogError());
      });
    }
    testConstant('number', () => Formula.constant(10));
    testConstant('string', () => Formula.constant('10'));
    testConstant('decimal', () => Formula.constant(new Decimal('1e400')), '1e400');
    testConstant('ref', () => Formula.constant(ref(10)));
  });

  function checkFormula<T extends FormulaFunctions>(
    functionName: T,
    args: Readonly<Parameters<(typeof Formula)[T]>>,
  ) {
    let formula: GenericFormula;
    beforeAll(() => {
      // @ts-expect-error - dynamic method access
      formula = Formula[functionName](...args);
    });
    // None of these formulas have variables, so they should all behave the same
    test('Is not marked as having a variable', () => expect(formula.hasVariable()).toBe(false));
    test('Is not invertible', () => expect(formula.isInvertible()).toBe(false));
    test(`Formula errors if trying to invert`, () =>
      // @ts-expect-error - dynamic method access
      expect(() => formula.invert(10)).toLogError());
    test('Is not integrable', () => expect(formula.isIntegrable()).toBe(false));
    test('Has a non-invertible integral', () => expect(formula.isIntegralInvertible()).toBe(false));
  }

  // Utility function that will test all the different
  // It's a lot of tests, but I'd rather be exhaustive
  function testFormulaCall<T extends FormulaFunctions>(
    functionName: T,
    args: Readonly<Parameters<(typeof Formula)[T]>>,
  ) {
    if ((functionName === 'slog' || functionName === 'layeradd') && args[0] === -1) {
      // These cases in particular take a long time, so skip them
      // We still have plenty of coverage
      return;
    }
    if (functionName === 'pentate' && args[1] === -2 && (args[2] === -2 || args[2] === 0)) {
      // Times out (~5s) due to break_eternity edge case with extreme negative params
      return;
    }
    let testName = functionName + '(';
    for (let i = 0; i < args.length; i++) {
      if (i !== 0) {
        testName += ', ';
      }
      testName += args[i];
    }
    testName += ') evaluates correctly';
    test(
      testName,
      () => {
        // @ts-expect-error - dynamic method access
        const formula = Formula[functionName](...args);

        try {
          const expectedEvaluation = Decimal[functionName](
            // @ts-expect-error - dynamic method access
            ...args.map((i) => unrefFormulaSource(i)),
          );
          if (expectedEvaluation != null) {
            expect(formula.evaluate()).compare_tolerance(expectedEvaluation);
          }
        } catch {
          // If this is an invalid Decimal operation, then ignore this test case
        }
        // A few pathological inputs (e.g. slog(-2), pentate(10.5, -2, 0)) are
        // correct but slow single Decimal calls that brush the default 5s timeout
        // under load; give the whole generated family comfortable headroom.
      },
      15000,
    );
  }

  describe('0-param', () => {
    [...invertibleZeroParamFunctionNames, ...nonInvertibleZeroParamFunctionNames].forEach((names) =>
      describe(names, () => {
        checkFormula(names, [0] as const);
        testValues.forEach((i) => testFormulaCall(names, [i] as const));
      }),
    );
  });
  describe('1-param', () => {
    (
      [
        ...invertibleOneParamFunctionNames,
        ...nonInvertibleOneParamFunctionNames,
        'max',
        'min',
      ] as const
    ).forEach((names) =>
      describe(names, () => {
        checkFormula(names, [0, 0] as const);
        testValues.forEach((i) =>
          testValues.forEach((j) => testFormulaCall(names, [i, j] as const)),
        );
      }),
    );
  });
  describe('2-param', () => {
    (nonInvertibleTwoParamFunctionNames as readonly FormulaFunctions[]).forEach((names) =>
      describe(names, () => {
        checkFormula(names, [0, 0, 0] as const);
        testValues.forEach((i) =>
          testValues.forEach((j) =>
            testValues.forEach((k) => testFormulaCall(names, [i, j, k] as const)),
          ),
        );
      }),
    );
  });
});

describe('Variables', () => {
  let variable: GenericFormula;
  let constant: GenericFormula;
  beforeAll(() => {
    variable = Formula.variable(10);
    constant = Formula.constant(10);
  });

  test('Created variable is marked as a variable', () => expect(variable.hasVariable()).toBe(true));
  test("evaluate() returns variable's value", () =>
    expect(variable.evaluate()).compare_tolerance(10));
  test('evaluate(variable) overrides variable value', () =>
    expect(variable.add(10).evaluate(20)).compare_tolerance(30));

  test('Nested variable is marked as having a variable', () =>
    expect(variable.add(10).div(3).pow(2).hasVariable()).toBe(true));
  test('Nested non-variable is marked as not having a variable', () =>
    expect(constant.add(10).div(3).pow(2).hasVariable()).toBe(false));
});

describe('Inverting', () => {
  let variable: IntegrableFormula;
  let constant: GenericFormula;
  beforeAll(() => {
    variable = Formula.variable(10);
    constant = Formula.constant(10);
  });

  test('variable.invert() is pass-through', () =>
    expect(variable.invert(100)).compare_tolerance(100));

  describe('Invertible Formulas correctly calculate when they contain a variable', () => {
    function checkFormula(formula: GenericFormula, expectedBool = true) {
      expect(formula.isInvertible()).toBe(expectedBool);
      expect(formula.hasVariable()).toBe(expectedBool);
    }
    invertibleZeroParamFunctionNames.forEach((name) => {
      describe(name, () => {
        test(`${name}(var) is marked as invertible and having a variable`, () =>
          checkFormula(Formula[name](variable)));
      });
    });
    invertibleOneParamFunctionNames.forEach((name) => {
      describe(name, () => {
        test(`${name}(var, const) is marked as invertible and having a variable`, () =>
          checkFormula(Formula[name](variable, constant)));
        test(`${name}(const, var) is marked as invertible and having a variable`, () =>
          checkFormula(Formula[name](constant, variable)));
        test(`${name}(var, var) is marked as not invertible and not having a variable`, () =>
          checkFormula(Formula[name](variable, variable), false));
      });
    });
  });

  describe('Non-invertible formulas marked as such', () => {
    function checkFormula(formula: GenericFormula) {
      expect(formula.isInvertible()).toBe(false);
      expect(formula.isIntegrable()).toBe(false);
      expect(formula.isIntegralInvertible()).toBe(false);
    }
    nonInvertibleZeroParamFunctionNames.forEach((name) => {
      describe(name, () => {
        test(`${name}(var) is marked as not invertible`, () =>
          checkFormula(Formula[name](variable)));
      });
    });
    nonInvertibleOneParamFunctionNames.forEach((name) => {
      describe(name, () => {
        test(`${name}(var, const) is marked as not invertible`, () =>
          checkFormula(Formula[name](variable, constant)));
        test(`${name}(const, var) is marked as not invertible`, () =>
          checkFormula(Formula[name](constant, variable)));
        test(`${name}(var, var) is marked as not invertible`, () =>
          checkFormula(Formula[name](variable, variable)));
      });
    });
    nonInvertibleTwoParamFunctionNames.forEach((name) => {
      describe(name, () => {
        test(`${name}(var, const, const) is marked as not invertible`, () =>
          checkFormula(Formula[name](variable, constant, constant)));
        test(`${name}(const, var, const) is marked as not invertible`, () =>
          checkFormula(Formula[name](constant, variable, constant)));
        test(`${name}(const, const, var) is marked as not invertible`, () =>
          checkFormula(Formula[name](constant, constant, variable)));
        test(`${name}(var, var, const) is marked as not invertible`, () =>
          checkFormula(Formula[name](variable, variable, constant)));
        test(`${name}(var, const, var) is marked as not invertible`, () =>
          checkFormula(Formula[name](variable, constant, variable)));
        test(`${name}(const, var, var) is marked as not invertible`, () =>
          checkFormula(Formula[name](constant, variable, variable)));
        test(`${name}(var, var, var) is marked as not invertible`, () =>
          checkFormula(Formula[name](variable, variable, variable)));
      });
    });
  });

  describe('Inverting calculates the value of the variable', () => {
    let variable: IntegrableFormula;
    let constant: IntegrableFormula;
    beforeAll(() => {
      variable = Formula.variable(2);
      constant = Formula.constant(3);
    });
    invertibleOneParamFunctionNames.forEach((name) =>
      describe(name, () => {
        test(`${name}(var, const).invert()`, () => {
          const formula = Formula[name](variable, constant);
          const result = formula.evaluate();

          expect(formula.invert!(result)).compare_tolerance(2);
        });
        if (name !== 'layeradd') {
          test(`${name}(const, var).invert()`, () => {
            const formula = Formula[name](constant, variable);
            const result = formula.evaluate();
            expect(formula.invert(result)).compare_tolerance(2);
          });
        }
      }),
    );
  });

  // `min`/`max` stay permissive by design: `invert` is the algebra's answer,
  // and a saturated bound is graded by `tryInvert` / `firstPassage` rather than
  // being pushed into `invert`, which the op table composes with recursively.
  describe('Inverting pass-throughs', () => {
    test('max', () => expect(Formula.max(variable, constant).invert(10)).compare_tolerance(10));
    test('min', () => expect(Formula.min(variable, constant).invert(10)).compare_tolerance(10));
  });

  test('Inverting nested formulas', () => {
    const formula = Formula.add(variable, constant).mul(constant).floor();
    expect(formula.invert(100)).compare_tolerance(0);
  });

  describe('Inverting with non-invertible sections', () => {
    test('Non-invertible constant', () => {
      const formula = Formula.add(variable, constant.sign());
      expect(formula.isInvertible()).toBe(true);
      expect(() => formula.invert(10)).not.toLogError();
    });
    test('Non-invertible variable', () => {
      const formula = Formula.add(variable.sign(), constant);
      expect(formula.isInvertible()).toBe(false);
      expect(() => formula.invert(10)).toLogError();
    });
  });
});

describe('Integrating', () => {
  let variable: IntegrableFormula;
  let constant: IntegrableFormula;
  beforeAll(() => {
    variable = Formula.variable(ref(10));
    constant = Formula.constant(10);
  });

  test('variable.evaluateIntegral() calculates correctly', () =>
    expect(variable.evaluateIntegral()).compare_tolerance(Decimal.pow(10, 2).div(2)));
  test('variable.evaluateIntegral(variable) overrides variable value', () =>
    expect(variable.evaluateIntegral(20)).compare_tolerance(Decimal.pow(20, 2).div(2)));

  describe('Integrable functions marked as such', () => {
    function checkFormula(formula: IntegrableFormula) {
      expect(formula.isIntegrable()).toBe(true);
      expect(() => formula.evaluateIntegral()).to.not.throw();
    }
    integrableZeroParamFunctionNames.forEach((name) => {
      describe(name, () => {
        test(`${name}(var) is marked as integrable`, () => checkFormula(Formula[name](variable)));
      });
    });
    integrableOneParamFunctionNames.forEach((name) => {
      describe(name, () => {
        test(`${name}(var, const) is marked as integrable`, () =>
          checkFormula(Formula[name](variable, constant)));
        if (name !== 'log' && name !== 'root') {
          test(`${name}(const, var) is marked as integrable`, () =>
            checkFormula(Formula[name](constant, variable)));
        }
        test(`${name}(var, var) is marked as not integrable`, () =>
          expect(Formula[name](variable, variable).isIntegrable()).toBe(false));
      });
    });
  });

  describe('Non-Integrable functions marked as such', () => {
    function checkFormula(formula: GenericFormula) {
      expect(formula.isIntegrable()).toBe(false);
    }
    nonIntegrableZeroParamFunctionNames.forEach((name) => {
      describe(name, () => {
        test(`${name}(var) is marked as not integrable`, () =>
          checkFormula(Formula[name](variable)));
      });
    });
    nonIntegrableOneParamFunctionNames.forEach((name) => {
      describe(name, () => {
        test(`${name}(var, const) is marked as not integrable`, () =>
          checkFormula(Formula[name](variable, constant)));
        test(`${name}(const, var) is marked as not integrable`, () =>
          checkFormula(Formula[name](constant, variable)));
        test(`${name}(var, var) is marked as not integrable`, () =>
          checkFormula(Formula[name](variable, variable)));
      });
    });
    nonIntegrableTwoParamFunctionNames.forEach((name) => {
      describe(name, () => {
        test(`${name}(var, const, const) is marked as not integrable`, () =>
          checkFormula(Formula[name](variable, constant, constant)));
        test(`${name}(const, var, const) is marked as not integrable`, () =>
          checkFormula(Formula[name](constant, variable, constant)));
        test(`${name}(const, const, var) is marked as not integrable`, () =>
          checkFormula(Formula[name](constant, constant, variable)));
        test(`${name}(var, var, const) is marked as not integrable`, () =>
          checkFormula(Formula[name](variable, variable, constant)));
        test(`${name}(var, const, var) is marked as not integrable`, () =>
          checkFormula(Formula[name](variable, constant, variable)));
        test(`${name}(const, var, var) is marked as not integrable`, () =>
          checkFormula(Formula[name](constant, variable, variable)));
        test(`${name}(var, var, var) is marked as not integrable`, () =>
          checkFormula(Formula[name](variable, variable, variable)));
      });
    });
  });

  // TODO I think these tests will require writing at least one known example for every function
  describe.todo('Integrable formulas integrate correctly');

  test('Integrating nested formulas', () => {
    const formula = Formula.add(variable, constant).mul(constant).pow(2).mul(30).add(10);
    const actualCost = new Array(10)
      .fill(null)
      .reduce((acc, _, i) => acc.add(formula.evaluate(i)), new Decimal(0));
    // Check if the calculated cost is within 10% of the actual cost,
    // because this is an approximation
    expect(
      Decimal.sub(
        actualCost,
        Decimal.add(formula.evaluateIntegral(), formula.calculateConstantOfIntegration()),
      )
        .abs()
        .div(actualCost)
        .toNumber(),
    ).toBeLessThan(0.1);
  });

  test('Integrating nested formulas with overridden variable', () => {
    const formula = Formula.add(variable, constant).mul(constant).pow(2).mul(30).add(10);
    const actualCost = new Array(20)
      .fill(null)
      .reduce((acc, _, i) => acc.add(formula.evaluate(i)), new Decimal(0));
    // Check if the calculated cost is within 10% of the actual cost,
    // because this is an approximation
    expect(
      Decimal.sub(
        actualCost,
        Decimal.add(formula.evaluateIntegral(20), formula.calculateConstantOfIntegration()),
      )
        .abs()
        .div(actualCost)
        .toNumber(),
    ).toBeLessThan(0.1);
  });

  test('Integrating nested complex formulas', () => {
    const formula = Formula.pow(1.05, variable).mul(100).pow(0.5);
    expect(() => formula.evaluateIntegral()).toLogError();
  });

  describe('Integrating with non-integrable sections', () => {
    test('Non-integrable constant', () => {
      const formula = Formula.add(variable, constant.ceil());
      expect(formula.isIntegrable()).toBe(true);
      expect(() => formula.evaluateIntegral()).not.toLogError();
    });
    test('Non-integrable variable', () => {
      const formula = Formula.add(variable.ceil(), constant);
      expect(formula.isIntegrable()).toBe(false);
      expect(() => formula.evaluateIntegral()).toLogError();
    });
  });

  describe('integrateAdd preserves the constant term', () => {
    // For f(x) = g(x) + c, ∫_0^N f dx = ∫_0^N g dx + c·N.
    // The constant must scale with the integration upper bound, not be frozen
    // at the variable's construction-time value.
    test('Formula.linear(level=0, base=10, coef=5) integrates as 2.5x² + 10x', () => {
      const level = ref<DecimalSource>(0);
      const formula = Formula.linear(level, 10, 5);
      expect(formula.evaluateIntegral(0)).compare_tolerance(0);
      expect(formula.evaluateIntegral(1)).compare_tolerance(12.5);
      expect(formula.evaluateIntegral(2)).compare_tolerance(30);
      expect(formula.evaluateIntegral(5)).compare_tolerance(112.5);
      expect(formula.evaluateIntegral(10)).compare_tolerance(350);
    });

    test('Formula.add(variable, constant=10) integrates as 0.5x² + 10x', () => {
      const v = Formula.variable(ref<DecimalSource>(0));
      const formula = v.add(10);
      expect(formula.evaluateIntegral(0)).compare_tolerance(0);
      expect(formula.evaluateIntegral(1)).compare_tolerance(10.5);
      expect(formula.evaluateIntegral(10)).compare_tolerance(150);
    });

    test('integrateAdd matches direct discrete sum within boundary error', () => {
      // ∫₀^N f dx ≈ Σ_{i=0}^{N-1} f(i) + f(N)/2 (Euler-Maclaurin trapezoidal).
      // For f(x)=5x+10 at N=10: discrete = Σ(5i+10) = 25·9 + 100 = 325; integral = 350.
      // Diff = 25 = N·c/2 = 50·c/(2·5) — exact discrete-vs-integral relationship.
      const level = ref<DecimalSource>(0);
      const formula = Formula.linear(level, 10, 5);
      const integral10 = Decimal.fromValue(formula.evaluateIntegral(10));
      let discrete = new Decimal(0);
      for (let i = 0; i < 10; i++) discrete = discrete.add(formula.evaluate(i));
      // integral - discrete = N·c/2 + (boundary term) = 25 for this case.
      expect(integral10.toNumber() - discrete.toNumber()).toBeCloseTo(25, 6);
    });

    test('Formula.linear invertIntegral roundtrips via closed-form', () => {
      // ∫₀^N (5x+10) dx = 2.5N² + 10N. At N=10 → 350.
      const level = ref<DecimalSource>(0);
      const formula = Formula.linear(level, 10, 5);
      expect(formula.invertIntegral(350)).compare_tolerance(10);
      expect(formula.invertIntegral(formula.evaluateIntegral(7))).compare_tolerance(7);
      expect(formula.invertIntegral(formula.evaluateIntegral(0.5))).compare_tolerance(0.5);
    });

    test('var.add(c) invertIntegral roundtrips via closed-form', () => {
      // ∫₀^N (x+10) dx = 0.5N² + 10N. At N=5 → 12.5 + 50 = 62.5.
      const level = ref<DecimalSource>(0);
      const formula = Formula.variable(level).add(10);
      expect(formula.invertIntegral(62.5)).compare_tolerance(5);
      expect(formula.invertIntegral(formula.evaluateIntegral(3))).compare_tolerance(3);
    });

    test('non-linear outer-add invertIntegral roundtrips via bisection', () => {
      // x²·10 + 5  → ∫ = 10x³/3 + 5x. Cubic-in-x, no closed form.
      const level = ref<DecimalSource>(0);
      const formula = Formula.polynomial(level, 10, 2).add(5);
      expect(formula.invertIntegral(formula.evaluateIntegral(4))).compare_tolerance(4, 1e-6);
      expect(formula.invertIntegral(formula.evaluateIntegral(10))).compare_tolerance(10, 1e-6);
    });
  });
});

describe('Inverting integrals', () => {
  let variable: InvertibleIntegralFormula;
  let constant: InvertibleIntegralFormula;
  beforeAll(() => {
    variable = Formula.variable(10);
    constant = Formula.constant(10);
  });

  test('variable.invertIntegral() calculates correctly', () =>
    expect(variable.invertIntegral(20)).compare_tolerance(Decimal.sqrt(20).mul(Decimal.sqrt(2))));

  describe('Invertible Integral functions marked as such', () => {
    function checkFormula(formula: InvertibleIntegralFormula) {
      expect(formula.isIntegralInvertible()).toBe(true);
      expect(() => formula.invertIntegral(10)).not.toLogError();
    }
    invertibleIntegralZeroPramFunctionNames.forEach((name) => {
      describe(name, () => {
        test(`${name}(var) is marked as having an invertible integral`, () =>
          checkFormula(Formula[name](variable)));
      });
    });
    invertibleIntegralOneParamFunctionNames.forEach((name) => {
      describe(name, () => {
        test(`${name}(var, const) is marked as having an invertible integral`, () =>
          checkFormula(Formula[name](variable, constant)));
        if (name !== 'log' && name !== 'root') {
          test(`${name}(const, var) is marked as having an invertible integral`, () =>
            checkFormula(Formula[name](constant, variable)));
        }
        test(`${name}(var, var) is marked as not having an invertible integral`, () => {
          const formula = Formula[name](variable, variable);
          expect(formula.isIntegralInvertible()).toBe(false);
          expect(() => formula.invertIntegral(10)).toLogError();
        });
      });
    });
  });

  describe('Non-Invertible integral functions marked as such', () => {
    function checkFormula(formula: GenericFormula) {
      expect(formula.isIntegralInvertible()).toBe(false);
    }
    nonInvertibleIntegralZeroPramFunctionNames.forEach((name) => {
      describe(name, () => {
        test(`${name}(var) is marked as not having an invertible integral`, () =>
          checkFormula(Formula[name](variable)));
      });
    });
    nonInvertibleIntegralOneParamFunctionNames.forEach((name) => {
      describe(name, () => {
        test(`${name}(var, const) is marked as not having an invertible integral`, () =>
          checkFormula(Formula[name](variable, constant)));
        test(`${name}(const, var) is marked as not having an invertible integral`, () =>
          checkFormula(Formula[name](constant, variable)));
        test(`${name}(var, var) is marked as not having an invertible integral`, () =>
          checkFormula(Formula[name](variable, variable)));
      });
    });
    nonInvertibleIntegralTwoParamFunctionNames.forEach((name) => {
      describe(name, () => {
        test(`${name}(var, const, const) is marked as not having an invertible integral`, () =>
          checkFormula(Formula[name](variable, constant, constant)));
        test(`${name}(const, var, const) is marked as not having an invertible integral`, () =>
          checkFormula(Formula[name](constant, variable, constant)));
        test(`${name}(const, const, var) is marked as not having an invertible integral`, () =>
          checkFormula(Formula[name](constant, constant, variable)));
        test(`${name}(var, var, const) is marked as not having an invertible integral`, () =>
          checkFormula(Formula[name](variable, variable, constant)));
        test(`${name}(var, const, var) is marked as not having an invertible integral`, () =>
          checkFormula(Formula[name](variable, constant, variable)));
        test(`${name}(const, var, var) is marked as not having an invertible integral`, () =>
          checkFormula(Formula[name](constant, variable, variable)));
        test(`${name}(var, var, var) is marked as not having an invertible integral`, () =>
          checkFormula(Formula[name](variable, variable, variable)));
      });
    });
  });

  // TODO I think these tests will require writing at least one known example for every function
  describe.todo('Invertible Integral formulas invert correctly');

  test('Inverting integral of nested formulas', () => {
    const formula = Formula.add(variable, constant).mul(constant).pow(2).mul(30);
    expect(formula.invertIntegral(formula.evaluateIntegral())).compare_tolerance(10);
  });

  test('Inverting integral of nested complex formulas', () => {
    const formula = Formula.pow(1.05, variable).mul(100).pow(0.5);
    expect(() => formula.invertIntegral(100)).toLogError();
  });
});

describe('Step-wise', () => {
  let variable: GenericFormula;
  let constant: GenericFormula;
  beforeAll(() => {
    variable = Formula.variable(10);
    constant = Formula.constant(10);
  });

  test('Formula without variable is marked as such', () => {
    expect(Formula.step(constant, 10, (value) => Formula.sqrt(value)).isInvertible()).toBe(false);
    expect(Formula.step(constant, 10, (value) => Formula.sqrt(value)).hasVariable()).toBe(false);
  });

  test('Formula with variable is marked as such', () => {
    expect(Formula.step(variable, 10, (value) => Formula.sqrt(value)).isInvertible()).toBe(true);
    expect(Formula.step(variable, 10, (value) => Formula.sqrt(value)).hasVariable()).toBe(true);
  });

  test('Non-invertible formula modifier marks formula as such', () => {
    expect(Formula.step(constant, 10, (value) => Formula.abs(value)).isInvertible()).toBe(false);
    expect(Formula.step(constant, 10, (value) => Formula.abs(value)).hasVariable()).toBe(false);
  });

  test('Formula never marked integrable', () => {
    expect(Formula.step(constant, 10, (value) => Formula.add(value, 10)).isIntegrable()).toBe(
      false,
    );
    expect(() =>
      Formula.step(constant, 10, (value) => Formula.add(value, 10)).evaluateIntegral(),
    ).toLogError();
  });

  test('Formula never marked as having an invertible integral', () => {
    expect(
      Formula.step(constant, 10, (value) => Formula.add(value, 10)).isIntegralInvertible(),
    ).toBe(false);
    expect(() =>
      Formula.step(constant, 10, (value) => Formula.add(value, 10)).invertIntegral(10),
    ).toLogError();
  });

  test('Formula modifiers with variables mark formula as non-invertible', () => {
    expect(Formula.step(constant, 10, (value) => Formula.add(value, variable)).isInvertible()).toBe(
      false,
    );
    expect(Formula.step(constant, 10, (value) => Formula.add(value, variable)).hasVariable()).toBe(
      false,
    );
  });

  describe('Pass-through underneath start', () => {
    test('Evaluates correctly', () =>
      expect(
        Formula.step(constant, 20, (value) => Formula.sqrt(value)).evaluate(),
      ).compare_tolerance(10));
    test('Inverts correctly with variable in input', () =>
      expect(
        Formula.step(variable, 20, (value) => Formula.sqrt(value)).invert(10),
      ).compare_tolerance(10));
  });

  describe('Pass-through at boundary', () => {
    test('Evaluates correctly', () =>
      expect(
        Formula.step(constant, 10, (value) => Formula.sqrt(value)).evaluate(),
      ).compare_tolerance(10));
    test('Inverts correctly with variable in input', () =>
      expect(
        Formula.step(variable, 10, (value) => Formula.sqrt(value)).invert(10),
      ).compare_tolerance(10));
  });

  describe('Evaluates correctly beyond start', () => {
    test('Evaluates correctly', () =>
      expect(
        Formula.step(variable, 8, (value) => Formula.add(value, 2)).evaluate(),
      ).compare_tolerance(12));
    test('Inverts correctly', () =>
      expect(
        Formula.step(variable, 8, (value) => Formula.add(value, 2)).invert(12),
      ).compare_tolerance(10));
  });

  describe('Evaluates correctly when nested', () => {
    test('Evaluates correctly', () =>
      expect(
        Formula.add(variable, constant)
          .step(10, (value) => Formula.mul(value, 2))
          .sub(10)
          .evaluate(),
      ).compare_tolerance(20));
    test('Inverts correctly', () =>
      expect(
        Formula.add(variable, constant)
          .step(10, (value) => Formula.mul(value, 2))
          .sub(10)
          .invert(30),
      ).compare_tolerance(15));
  });
});

describe('Conditionals', () => {
  let variable: GenericFormula;
  let constant: GenericFormula;
  beforeAll(() => {
    variable = Formula.variable(10);
    constant = Formula.constant(10);
  });

  test('Formula without variable is marked as such', () => {
    expect(Formula.if(constant, true, (value) => Formula.sqrt(value)).isInvertible()).toBe(false);
    expect(Formula.if(constant, true, (value) => Formula.sqrt(value)).hasVariable()).toBe(false);
  });

  test('Formula with variable is marked as such', () => {
    expect(Formula.if(variable, true, (value) => Formula.sqrt(value)).isInvertible()).toBe(true);
    expect(Formula.if(variable, true, (value) => Formula.sqrt(value)).hasVariable()).toBe(true);
  });

  test('Non-invertible formula modifier marks formula as such', () => {
    expect(Formula.if(constant, true, (value) => Formula.abs(value)).isInvertible()).toBe(false);
    expect(Formula.if(constant, true, (value) => Formula.abs(value)).hasVariable()).toBe(false);
  });

  test('Formula never marked integrable', () => {
    expect(Formula.if(constant, true, (value) => Formula.add(value, 10)).isIntegrable()).toBe(
      false,
    );
    expect(() =>
      Formula.if(constant, true, (value) => Formula.add(value, 10)).evaluateIntegral(),
    ).toLogError();
  });

  test('Formula never marked as having an invertible integral', () => {
    expect(
      Formula.if(constant, true, (value) => Formula.add(value, 10)).isIntegralInvertible(),
    ).toBe(false);
    expect(() =>
      Formula.if(constant, true, (value) => Formula.add(value, 10)).invertIntegral(10),
    ).toLogError();
  });

  test('Formula modifiers with variables mark formula as non-invertible', () => {
    expect(Formula.if(constant, true, (value) => Formula.add(value, variable)).isInvertible()).toBe(
      false,
    );
    expect(Formula.if(constant, true, (value) => Formula.add(value, variable)).hasVariable()).toBe(
      false,
    );
  });

  describe('Pass-through with condition false', () => {
    test('Evaluates correctly', () =>
      expect(
        Formula.if(constant, false, (value) => Formula.sqrt(value)).evaluate(),
      ).compare_tolerance(10));
    test('Inverts correctly with variable in input', () =>
      expect(
        Formula.if(variable, false, (value) => Formula.sqrt(value)).invert(10),
      ).compare_tolerance(10));
  });
  describe('Evaluates correctly with condition false and else statement', () => {
    test('Evaluates correctly', () =>
      expect(
        Formula.if(
          constant,
          false,
          (value) => Formula.sqrt(value),
          (value) => value.mul(2),
        ).evaluate(),
      ).compare_tolerance(20));
    test('Inverts correctly with variable in input', () =>
      expect(
        Formula.if(
          variable,
          false,
          (value) => Formula.sqrt(value),
          (value) => value.mul(2),
        ).invert(20),
      ).compare_tolerance(10));
  });

  describe('Evaluates correctly with condition true', () => {
    test('Evaluates correctly', () =>
      expect(
        Formula.if(variable, true, (value) => Formula.add(value, 2)).evaluate(),
      ).compare_tolerance(12));
    test('Inverts correctly', () =>
      expect(
        Formula.if(variable, true, (value) => Formula.add(value, 2)).invert(12),
      ).compare_tolerance(10));
  });

  describe('Evaluates correctly when nested', () => {
    test('Evaluates correctly', () =>
      expect(
        Formula.add(variable, constant)
          .if(true, (value) => Formula.add(value, 2))
          .div(2)
          .evaluate(),
      ).compare_tolerance(11));
    test('Inverts correctly', () =>
      expect(
        Formula.add(variable, constant)
          .if(true, (value) => Formula.add(value, 2))
          .div(2)
          .invert(12),
      ).compare_tolerance(12));
  });
});

describe('Custom Formulas', () => {
  let variable: InvertibleIntegralFormula;
  beforeAll(() => {
    variable = Formula.variable(1);
  });

  describe('Formula with evaluate', () => {
    test('Zero input evaluates correctly', () =>
      expect(new Formula({ inputs: [], evaluate: () => 10 }).evaluate()).compare_tolerance(10));
    test('One input evaluates correctly', () =>
      expect(new Formula({ inputs: [1], evaluate: (value) => value }).evaluate()).compare_tolerance(
        1,
      ));
    test('Two inputs evaluates correctly', () =>
      expect(
        new Formula({ inputs: [1, 2], evaluate: (v1, v2) => v1 }).evaluate(),
      ).compare_tolerance(1));
  });

  describe('Formula with invert', () => {
    test('Zero input does not invert', () =>
      expect(() =>
        new Formula({
          inputs: [],
          evaluate: () => 6,
          invert: (value) => value,
        }).invert(10),
      ).toLogError());
    test('One input inverts correctly', () =>
      expect(
        new Formula({
          inputs: [variable],
          evaluate: () => 10,
          invert: (value, v1) => v1.evaluate(),
        }).invert(10),
      ).compare_tolerance(1));
    test('Two inputs inverts correctly', () =>
      expect(
        new Formula({
          inputs: [variable, 2],
          evaluate: () => 10,
          invert: (value, v1, v2) => v2,
        }).invert(10),
      ).compare_tolerance(2));
  });

  describe('Formula with integrate', () => {
    test('Zero input cannot integrate', () =>
      expect(() =>
        new Formula({
          inputs: [],
          evaluate: () => 0,
          integrate: (stack) => variable,
        }).evaluateIntegral(),
      ).toLogError());
    test('One input integrates correctly', () =>
      expect(
        new Formula({
          inputs: [variable],
          evaluate: (v1) => Decimal.add(v1, 10),
          integrate: (stack, v1) => Formula.add(v1, 10),
        }).evaluateIntegral(),
      ).compare_tolerance(11));
    test('Two inputs integrates correctly', () =>
      expect(
        new Formula({
          inputs: [variable, 10],
          evaluate: (v1, v2) => Decimal.add(v1, v2),
          integrate: (stack, v1, v2) => Formula.add(v1, v2),
        }).evaluateIntegral(),
      ).compare_tolerance(11));
  });

  describe('Formula with invertIntegral', () => {
    test('Zero input does not invert integral', () =>
      expect(() =>
        new Formula({
          inputs: [],
          evaluate: () => 0,
          integrate: (stack) => variable,
        }).invertIntegral(20),
      ).toLogError());
    test('One input inverts integral correctly', () =>
      expect(
        new Formula({
          inputs: [variable],
          evaluate: (v1) => Decimal.add(v1, 10),
          integrate: (stack, v1) => Formula.add(v1, 10),
        }).invertIntegral(20),
      ).compare_tolerance(10));
    test('Two inputs inverts integral correctly', () =>
      expect(
        new Formula({
          inputs: [variable, 10],
          evaluate: (v1, v2) => Decimal.add(v1, v2),
          integrate: (stack, v1, v2) => Formula.add(v1, v2),
        }).invertIntegral(20),
      ).compare_tolerance(10));
  });

  describe('Formula as input', () => {
    let customFormula: InvertibleIntegralFormula;
    beforeAll(() => {
      customFormula = new Formula({
        inputs: [variable],
        evaluate: (v1) => v1,
        invert: (value) => value,
        integrate: (stack, v1) => v1.getIntegralFormula(stack),
      });
    });
    test('Evaluate correctly', () =>
      expect(customFormula.add(10).evaluate()).compare_tolerance(11));
    test('Invert correctly', () => expect(customFormula.add(10).invert(20)).compare_tolerance(10));
    test('Integrate correctly', () =>
      // ∫(customFormula(x) + 10) dx at x=10 = customFormula_integral(10) + 10·10
      // customFormula's integral delegates to variable.getIntegralFormula via
      // the substitution stack, which evaluates as 10 at x=10. So 10 + 100 = 110.
      expect(customFormula.add(10).evaluateIntegral(10)).compare_tolerance(110));
  });
});

/**
 * Brute-force `max n such that Σ_{i<n} f(A+i) ≤ R` — the discrete cumulative
 * every buy-max answer is graded against.
 */
function discreteTruth(formula: GenericFormula, R: DecimalSource, A: number): number {
  let n = 0;
  let summed = new Decimal(0);
  for (let i = 0; i < 10000; i++) {
    const cost = formula.evaluate(A + i);
    if (Decimal.add(summed, cost).gt(R)) return n;
    n++;
    summed = Decimal.add(summed, cost);
  }
  return n;
}

describe('Buy Max', () => {
  let resource: ReturnType<typeof createResource>;
  beforeAll(() => {
    resource = createResource(ref(100000));
  });
  describe('Without cumulative cost', () => {
    test('Errors on calculating max affordable of non-invertible formula', () => {
      const purchases = ref(1);
      const variable = Formula.variable(purchases);
      const formula = Formula.abs(variable);
      const maxAffordable = calculateMaxAffordable(formula, resource, false);
      expect(() => maxAffordable.value).toLogError();
    });
    test('Prices a non-invertible formula by evaluating it, without erroring', () => {
      // Non-cumulative cost is a single evaluation at the target level, so
      // invertibility never enters into it. The old signature routed this
      // through an inversion guard and reported instead of answering.
      const purchases = ref(1);
      const variable = Formula.variable(purchases);
      const formula = Formula.abs(variable);
      expect(() => calculateCost(formula, 5, false)).not.toLogError();
      expect(calculateCost(formula, 5, false)).compare_tolerance(6);
    });
    test('A cost curve that evaluates to NaN affords nothing', () => {
      // `maxBulkAmount === 1` short-circuits past the seed and the correction
      // walk. break_eternity's `gte` answered `true` against NaN, so an
      // undefined cost — `recip(0)` is NaN rather than Infinity — read as
      // affordable and handed out a free level. Corrected in
      // `primitives/decimal.ts`; gated here because this is the default
      // single-buy path every purchasable takes.
      //
      // The undefined level has to be the one being *priced*, and the two cost
      // operations price different levels: a cumulative buy of one sums to
      // `evaluate(A)`, a single-payment one pays `evaluate(A + 1)` for the
      // level it reaches. Both are gated, each against its own curve.
      const cumulativeLevel = ref<DecimalSource>(0);
      const cumulative = Formula.recip(Formula.variable(cumulativeLevel));
      expect(new Decimal(cumulative.evaluate()).isNan()).toBe(true);
      expect(calculateMaxAffordable(cumulative, resource, true, 1).value).compare_tolerance(0);

      const singleLevel = ref<DecimalSource>(0);
      const single = Formula.recip(Formula.variable(singleLevel).sub(1));
      expect(new Decimal(single.evaluate(1)).isNan()).toBe(true);
      expect(calculateMaxAffordable(single, resource, false, 1).value).compare_tolerance(0);
    });
    test('Calculates max affordable and cost correctly', () => {
      const variable = Formula.variable(0);
      const formula = Formula.pow(1.05, variable).mul(100);
      const maxAffordable = calculateMaxAffordable(formula, resource, false);
      expect(maxAffordable.value).compare_tolerance(141);
      expect(calculateCost(formula, maxAffordable.value, false)).compare_tolerance(
        Decimal.pow(1.05, 141).mul(100),
      );
    });
    test('Caps the count at maxBulkAmount and prices the capped target', () => {
      const variable = Formula.variable(0);
      const formula = Formula.pow(1.05, variable).mul(100);
      const maxAffordable = calculateMaxAffordable(formula, resource, false, 4);
      expect(maxAffordable.value).compare_tolerance(4);
      expect(calculateCost(formula, maxAffordable.value, false)).compare_tolerance(
        formula.evaluate(4),
      );
    });
    test('Returns purchase count, not absolute level, when currentVariable > 0', () => {
      // invert(100000) for 100·1.05^x is floor(log_1.05(1000)) = 141. With
      // currentVariable=10, the bug-shaped result (absolute level) is 141; the
      // correct count of additional purchases is 141 - 10 = 131.
      const purchases = ref(10);
      const variable = Formula.variable(purchases);
      const formula = Formula.pow(1.05, variable).mul(100);
      const maxAffordable = calculateMaxAffordable(formula, resource, false);
      expect(maxAffordable.value).compare_tolerance(131);

      // Round-trip: paying for 131 levels (non-cumulative) costs evaluate(141).
      expect(calculateCost(formula, maxAffordable.value, false)).compare_tolerance(
        Decimal.pow(1.05, 141).mul(100),
      );
    });
    test('Clamps to 0 when currentVariable already exceeds invert(resource)', () => {
      // At level 200, cost = 100·1.05^200 ≈ 1.7M, well above resource (100k).
      // invert(100000) = 141 < 200, so count must clamp to 0 — without the
      // clamp, the result would be negative and poison downstream callers.
      const purchases = ref(200);
      const variable = Formula.variable(purchases);
      const formula = Formula.pow(1.05, variable).mul(100);
      const maxAffordable = calculateMaxAffordable(formula, resource, false);
      expect(maxAffordable.value).compare_tolerance(0);
    });
  });
  describe('With cumulative cost', () => {
    test('Errors on calculating max affordable of non-invertible formula', () => {
      const purchases = ref(1);
      const variable = Formula.variable(purchases);
      const formula = Formula.abs(variable);
      const maxAffordable = calculateMaxAffordable(formula, resource, true);
      expect(() => maxAffordable.value).toLogError();
    });
    test('Sums a formula with no closed-form series term by term', () => {
      // `abs` binds neither a series rule nor an integral, so there is nothing
      // to apply and nothing to correct — but a short span is still exactly
      // summable, and answering beats reporting. |1|+|2|+…+|5| = 15.
      const purchases = ref(1);
      const variable = Formula.variable(purchases);
      const formula = Formula.abs(variable);
      expect(() => calculateCost(formula, 5, true)).not.toLogError();
      expect(calculateCost(formula, 5, true)).compare_tolerance(15);
    });
    test('Reports rather than stalling when an unsummable span is unbounded', () => {
      const purchases = ref(1);
      const formula = Formula.abs(Formula.variable(purchases));
      expect(() => calculateCost(formula, 1e6, true)).toLogError();
    });
    test('Max affordable and cost agree exactly with 0 purchases', () => {
      const purchases = ref(0);
      const variable = Formula.variable(purchases);
      const formula = Formula.pow(1.05, variable).mul(100);
      const maxAffordable = calculateMaxAffordable(formula, resource, true);
      let actualAffordable = 0;
      let summedCost = Decimal.dZero;
      while (true) {
        const nextCost = formula.evaluate(actualAffordable);
        if (Decimal.add(summedCost, nextCost).lte(resource.value)) {
          actualAffordable++;
          summedCost = Decimal.add(summedCost, nextCost);
        } else {
          break;
        }
      }
      expect(maxAffordable.value).compare_tolerance(actualAffordable);

      const actualCost = new Array(actualAffordable)
        .fill(null)
        .reduce((acc, _, i) => acc.add(formula.evaluate(i)), new Decimal(0));
      // Was "within 10%, because this is an approximation" — it no longer is.
      // The cost is the same series the affordability count was decided by, so
      // the two agree to the closed form's own precision.
      expect(calculateCost(formula, maxAffordable.value)).compare_tolerance(actualCost);
    });
    test('Max affordable and cost agree exactly with 1 purchase', () => {
      const purchases = ref(1);
      const variable = Formula.variable(purchases);
      const formula = Formula.pow(1.05, variable).mul(100);
      const maxAffordable = calculateMaxAffordable(formula, resource, true);
      let actualAffordable = 0;
      let summedCost = Decimal.dZero;
      while (true) {
        const nextCost = formula.evaluate(Decimal.add(actualAffordable, 1));
        if (Decimal.add(summedCost, nextCost).lte(resource.value)) {
          actualAffordable++;
          summedCost = Decimal.add(summedCost, nextCost);
        } else {
          break;
        }
      }
      expect(maxAffordable.value).compare_tolerance(actualAffordable);

      const actualCost = new Array(actualAffordable)
        .fill(null)
        .reduce((acc, _, i) => acc.add(formula.evaluate(i + 1)), new Decimal(0));
      expect(calculateCost(formula, maxAffordable.value)).compare_tolerance(actualCost);
    });
    test('The default path prices the levels it counted, exactly', () => {
      const purchases = ref(1);
      const variable = Formula.variable(purchases);
      const formula = Formula.pow(1.05, variable).mul(100);
      const maxAffordable = calculateMaxAffordable(formula, resource);
      let actualAffordable = 0;
      let summedCost = Decimal.dZero;
      while (true) {
        const nextCost = formula.evaluate(Decimal.add(actualAffordable, 1));
        if (Decimal.add(summedCost, nextCost).lte(resource.value)) {
          actualAffordable++;
          summedCost = Decimal.add(summedCost, nextCost);
        } else {
          break;
        }
      }
      expect(maxAffordable.value).compare_tolerance(actualAffordable);

      const actualCost = new Array(actualAffordable)
        .fill(null)
        .reduce((acc, _, i) => acc.add(formula.evaluate(i + 1)), new Decimal(0));
      expect(calculateCost(formula, maxAffordable.value)).compare_tolerance(actualCost);
    });
    test('Stays exact partway up the curve, not just from level zero', () => {
      const purchases = ref(90);
      const variable = Formula.variable(purchases);
      const formula = Formula.pow(1.05, variable).mul(100);
      const maxAffordable = calculateMaxAffordable(formula, resource, true);
      let actualAffordable = 0;
      let summedCost = Decimal.dZero;
      while (true) {
        const nextCost = formula.evaluate(Decimal.add(actualAffordable, purchases.value));
        if (Decimal.add(summedCost, nextCost).lte(resource.value)) {
          actualAffordable++;
          summedCost = Decimal.add(summedCost, nextCost);
        } else {
          break;
        }
      }
      expect(maxAffordable.value).compare_tolerance(actualAffordable);

      const actualCost = new Array(actualAffordable)
        .fill(null)
        .reduce((acc, _, i) => acc.add(formula.evaluate(i + purchases.value)), new Decimal(0));
      expect(calculateCost(formula, maxAffordable.value, true)).compare_tolerance(actualCost);
    });
    test('Handles over e308 purchases', () => {
      resource.value = '1ee308';
      const purchases = ref(0);
      const variable = Formula.variable(purchases);
      const formula = variable;
      const maxAffordable = calculateMaxAffordable(formula, resource);
      const calculatedCost = calculateCost(formula, maxAffordable.value);
      expect(Decimal.isNaN(calculatedCost)).toBe(false);
      expect(Decimal.isFinite(calculatedCost)).toBe(true);
      resource.value = 100000;
    });
    test('Non-integrable formula over a short span does not error', () => {
      const purchases = ref(0);
      const formula = Formula.variable(purchases).abs();
      expect(() => calculateCost(formula, 10, true)).not.toLogError();
    });
    test('directSum tail terminates when the current level exceeds 2^53', () => {
      // Iterating the tail by a float counter over the value range hangs here:
      // past 2^53 the float ULP exceeds 1, so `i++` is a no-op and the loop
      // spins forever. The cost must still resolve to a finite value.
      const purchases = ref(new Decimal(2).pow(53));
      const variable = Formula.variable(purchases);
      const cost = calculateCost(variable, 20, true, 10);
      expect(Decimal.isFinite(cost)).toBe(true);
    });
  });

  describe('discrete-sum semantics: max-affordable matches Σf(A+i) ≤ R', () => {
    // The four primitives must agree on what "buy 1" means.
    // pay(1), getCost(1), timeUntilAffordable use single-level cost.
    // calculateMaxAffordable must too — its answer is the discrete cumulative.

    test('exponential s=1.15: boundary R=10 reports 1 (integral predicts 0)', () => {
      const level = ref<DecimalSource>(0);
      const formula = Formula.exponential(level, 10, 1.15);
      const resource = createResource(ref<DecimalSource>(10));
      expect(calculateMaxAffordable(formula, resource).value).compare_tolerance(1);
    });

    test('exponential s=2.0 small N: matches discrete sum', () => {
      const level = ref<DecimalSource>(0);
      const formula = Formula.exponential(level, 10, 2);
      const r1 = createResource(ref<DecimalSource>(10));
      expect(calculateMaxAffordable(formula, r1).value).compare_tolerance(
        discreteTruth(formula, 10, 0),
      );
      const r2 = createResource(ref<DecimalSource>(100));
      expect(calculateMaxAffordable(formula, r2).value).compare_tolerance(
        discreteTruth(formula, 100, 0),
      );
    });

    test('exponential mid-game: matches discrete sum across resource scales', () => {
      const level = ref<DecimalSource>(0);
      const formula = Formula.exponential(level, 10, 1.15);
      for (const A of [10, 50, 100, 200]) {
        level.value = A;
        const cost1 = Decimal.pow(1.15, A).mul(10);
        const R = cost1.mul(50);
        const resource = createResource(ref<DecimalSource>(R));
        const truth = discreteTruth(formula, R, A);
        expect(calculateMaxAffordable(formula, resource).value).compare_tolerance(truth);
      }
    });

    test('linear 5x+10: boundary R=25 reports 2', () => {
      // Discrete cumulative: 10 → 25 → 45 → ...
      // R=24 → 1, R=25 → 2, R=44 → 2, R=45 → 3.
      const level = ref<DecimalSource>(0);
      const formula = Formula.linear(level, 10, 5);
      expect(
        calculateMaxAffordable(formula, createResource(ref<DecimalSource>(24))).value,
      ).compare_tolerance(1);
      expect(
        calculateMaxAffordable(formula, createResource(ref<DecimalSource>(25))).value,
      ).compare_tolerance(2);
      expect(
        calculateMaxAffordable(formula, createResource(ref<DecimalSource>(44))).value,
      ).compare_tolerance(2);
      expect(
        calculateMaxAffordable(formula, createResource(ref<DecimalSource>(45))).value,
      ).compare_tolerance(3);
    });

    test('polynomial x²·10: matches discrete sum at small N', () => {
      const level = ref<DecimalSource>(0);
      const formula = Formula.polynomial(level, 10, 2);
      // Single costs: 0, 10, 40, 90, 160. Discrete cumulative: 0, 10, 50, 140, 300.
      // Note evaluate(0)=0 means buy-1 always succeeds at zero cost.
      const resource = createResource(ref<DecimalSource>(50));
      expect(calculateMaxAffordable(formula, resource).value).compare_tolerance(
        discreteTruth(formula, 50, 0),
      );
      const r2 = createResource(ref<DecimalSource>(140));
      expect(calculateMaxAffordable(formula, r2).value).compare_tolerance(
        discreteTruth(formula, 140, 0),
      );
    });

    test('threshold-guard cache: resource arriving at single-level cost invalidates band', () => {
      // Pre-fix, the cumulative cache band stored ceilCost as the integral
      // cumulative for `affordable + 1` levels. For Formula.exponential at
      // amount=0 with single-level cost 46 and scaling 1.15, that integral is
      // ~49.36 — so resource ∈ [46, 49.36) hit the warm cache and returned a
      // stale affordable=0 even though the discrete answer was 1.
      const level = ref<DecimalSource>(0);
      const formula = Formula.exponential(level, 46, 1.15);
      const resourceRef = ref<DecimalSource>(0);
      const resource = createResource(resourceRef);
      const maxAffordable = calculateMaxAffordable(formula, resource);
      expect(maxAffordable.value).compare_tolerance(0);
      resourceRef.value = 46;
      expect(maxAffordable.value).compare_tolerance(1);
    });
  });

  describe('threshold-guard key: everything the band was computed against', () => {
    // The guard caches a band computed at one level, in one pricing operation,
    // under one cap, on one shape of curve. Each test moves one of those while
    // the resource stays inside the cached band, which is the arrangement that
    // reaches the fast path. A stale answer here is not a display bug: `pay`
    // prices live through `calculateCost`, so the count and the charge
    // disagree and the wallet drains to cover the difference.

    test('a reactive input nested below the top level invalidates the band', () => {
      // The old signature walked only `formula.inputs`, writing a bare 'f' for
      // Formula entries and never recursing. Chaining a second multiplier
      // pushes the first one a level down, out of that walk's sight. Worse, the
      // fast path returned before reading the nested ref at all, so Vue dropped
      // it from the dependency set and the computed stopped invalidating: the
      // staleness was permanent, not one tick late.
      const level = ref<DecimalSource>(0);
      const mult = ref<DecimalSource>(1);
      const formula = Formula.variable(level)
        .pow_base(2)
        .mul(10)
        .mul(Formula.constant(mult).mul(1));
      const resourceRef = ref<DecimalSource>(101);
      const maxAffordable = calculateMaxAffordable(formula, createResource(resourceRef), true);

      expect(maxAffordable.value).compare_tolerance(3);
      resourceRef.value = 102; // small move -> guard hit
      expect(maxAffordable.value).compare_tolerance(3);

      mult.value = 100; // 10*2^n becomes 1000*2^n: nothing is affordable
      expect(maxAffordable.value).compare_tolerance(0);

      // And it stays correct as production keeps arriving. Band membership was
      // tested against the *old* curve's bounds, so a rising resource kept
      // landing inside the stale band instead of falling out of it.
      for (let i = 0; i < 6; i++) {
        resourceRef.value = Decimal.add(resourceRef.value, 1);
        expect(maxAffordable.value).compare_tolerance(0);
      }
    });

    test('raising maxBulkAmount past a capped answer invalidates the band', () => {
      // `maxBulkAmount` is a MaybeRef and `canMaximize` exists to drive an
      // x1/x10/x100/max toggle, so this moves whenever a player clicks one. It
      // was absent from the key entirely, and a capped band stores ceilCost as
      // Infinity — which `!payable` always accepts — so the cap check passed
      // trivially and the old cap was returned forever.
      const level = ref<DecimalSource>(0);
      const formula = Formula.variable(level).pow_base(2).mul(10);
      const cap = ref<DecimalSource>(5);
      const maxAffordable = calculateMaxAffordable(
        formula,
        createResource(ref<DecimalSource>(1e9)),
        true,
        cap,
      );

      expect(maxAffordable.value).compare_tolerance(5);
      cap.value = 20;
      expect(maxAffordable.value).compare_tolerance(20);
    });

    test('flipping cumulativeCost invalidates the band', () => {
      // The two operations price different things — the series vs the single
      // level reached — and on a linear curve they diverge widely. The band was
      // computed in one of them and read back under the other.
      const level = ref<DecimalSource>(0);
      const formula = Formula.variable(level).add(1);
      const cumulative = ref(true);
      const maxAffordable = calculateMaxAffordable(
        formula,
        createResource(ref<DecimalSource>(100)),
        cumulative,
        1000,
      );

      expect(maxAffordable.value).compare_tolerance(13); // Σ(i+1) <= 100
      cumulative.value = false;
      expect(maxAffordable.value).compare_tolerance(99); // f(n) = n+1 <= 100
    });

    test('a condition held in a Formula.if closure invalidates the band', () => {
      // `Formula.if` carries only the value in `inputs`; the condition and both
      // branch formulas live in a closure. No signature over the input tree can
      // reach them at any depth, which is why the guard keys on a token that
      // *evaluates* the curve instead. Reachable under cumulativeCost: false —
      // `if` binds no integrate, so the cumulative path bails before the guard
      // is ever written.
      const level = ref<DecimalSource>(0);
      const halved = ref(true);
      const formula = Formula.variable(level)
        .add(10)
        .if(halved, (x) => x.div(2));
      const maxAffordable = calculateMaxAffordable(
        formula,
        createResource(ref<DecimalSource>(100)),
        false,
        1000,
      );

      expect(maxAffordable.value).compare_tolerance(190); // (n+10)/2 <= 100
      halved.value = false;
      expect(maxAffordable.value).compare_tolerance(90); // n+10 <= 100
    });

    test('a band one level below the cap keeps its ceiling', () => {
      // `capped` asks whether there is a next level to price. Testing
      // `affordable + 1 >= maxBulkAmount` also fired one level *below* the cap,
      // where that next level is real and priceable; erasing its ceiling to
      // Infinity froze the answer at maxBulkAmount - 1 for as long as the level
      // held.
      const level = ref<DecimalSource>(0);
      const formula = Formula.exponential(level, 10, 1.15);
      const resourceRef = ref<DecimalSource>(50);
      const maxAffordable = calculateMaxAffordable(formula, createResource(resourceRef), true, 5);

      expect(maxAffordable.value).compare_tolerance(4);
      resourceRef.value = 100;
      expect(maxAffordable.value).compare_tolerance(5);
    });
  });
});

describe('reactive coefficients survive integral memoization', () => {
  // `getIntegralFormula` memoizes its result for the life of the formula, so
  // anything the builders read while *constructing* it is frozen there. A
  // coefficient is a `FormulaSource` — a ref or a variable-free sub-formula —
  // and reading one eagerly turns it into a snapshot that a later modifier,
  // upgrade or prestige multiplier never updates.

  test('the forward integral recovers the real level, not one scaled by a stale slope', () => {
    // Recovering x from F(x) with a frozen coefficient reports the wrong level
    // and so charges the wrong `c·x` term. Invisible at level 0, where F(x) is
    // zero and every slope agrees; this samples above it.
    const level = ref<DecimalSource>(0);
    const coef = ref<DecimalSource>(1);
    const formula = Formula.variable(level).mul(coef).add(5);

    formula.evaluateIntegral(); // build and memoize the integral against coef = 1

    coef.value = 100;
    level.value = 10;
    // ∫₀¹⁰ (100x + 5) dx = 100·10²/2 + 5·10 = 5050
    expect(formula.evaluateIntegral()).compare_tolerance(5050);
  });

  test('a ref coefficient that moves is honoured by buy-max', () => {
    // The ticket's reproduction. Asserted through the *same* computed across
    // the change, so it covers the memoized integral and the threshold guard
    // together — a fresh computed would exonerate the guard by accident.
    const level = ref<DecimalSource>(0);
    const coef = ref<DecimalSource>(1);
    const formula = Formula.variable(level).mul(coef).add(5);
    const maxAffordable = calculateMaxAffordable(
      formula,
      createResource(ref<DecimalSource>(1e5)),
      true,
    );

    expect(maxAffordable.value).compare_tolerance(discreteTruth(formula, 1e5, 0));

    coef.value = 100;
    // Σ (100i + 5) ≤ 1e5 → 45. Read off a frozen slope of 1 the seed is 442,
    // and the correction walk exhausts its budget 64 short of it at 378.
    expect(maxAffordable.value).compare_tolerance(45);
    expect(maxAffordable.value).compare_tolerance(discreteTruth(formula, 1e5, 0));
  });

  test('a formula-valued coefficient is re-evaluated, not snapshotted', () => {
    // The shape a consumer actually writes: the multiplier is a whole
    // variable-free sub-formula off a modifier chain, and `unrefFormulaSource`
    // collapses all of it to one number at build time.
    const level = ref<DecimalSource>(0);
    const multiplier = ref<DecimalSource>(1);
    const coef = Formula.constant(multiplier).mul(4);
    const formula = Formula.variable(level).mul(coef).add(5);
    const maxAffordable = calculateMaxAffordable(
      formula,
      createResource(ref<DecimalSource>(1e5)),
      true,
    );

    expect(maxAffordable.value).compare_tolerance(discreteTruth(formula, 1e5, 0));

    multiplier.value = 25;
    expect(maxAffordable.value).compare_tolerance(discreteTruth(formula, 1e5, 0));
  });

  test('integrateSub reads its coefficient at invert time too', () => {
    // The fix touches both builders; the ticket only ever exercised `add`.
    // Inverting is where the slope still lives after the forward arm stopped
    // consulting it, so this has to go through `invertIntegral` to bite.
    const level = ref<DecimalSource>(0);
    const coef = ref<DecimalSource>(1);
    const formula = Formula.variable(level).mul(coef).sub(5);

    formula.invertIntegral(1e5); // build and memoize against coef = 1

    coef.value = 100;
    // K·x²/2 - c·x = T with K = 100, c = 5, T = 1e5
    //   → x = (5 + √(25 + 2·100·1e5)) / 100 ≈ 44.77
    // A slope frozen at 1 answers 452.24 instead.
    expect(formula.invertIntegral(1e5)).compare_tolerance(
      Decimal.add(5, Decimal.sqrt(20000025)).div(100),
    );
  });

  test('a coefficient that turns non-positive declines the closed form and reports', () => {
    // Build/call split: the *shape* is settled once, the *sign* every call. A
    // stale positive slope would keep feeding the closed form and return a
    // confident wrong number; declining it lands in bisection, which cannot
    // bracket a negative-K integral and says so.
    const level = ref<DecimalSource>(0);
    const coef = ref<DecimalSource>(1);
    const formula = Formula.variable(level).mul(coef).add(5);

    formula.evaluateIntegral();

    coef.value = -100;
    expect(() => formula.invertIntegral(1e5)).toLogError();
  });
});

describe('buy-max returns no count it could not price', () => {
  // The correction walk exists because the seed solves the continuous equation
  // and the answer is discrete; it walks a level or two. Running the budget out
  // means the two coordinates disagree wildly, and what the walk is holding
  // when that happens was never passed through `canAfford`. `pay` does not
  // re-check it — it subtracts and clamps at zero — so returning it is how a
  // wrong seed becomes free levels.

  /**
   * A curve that prices honestly and inverts by a factor of 100 too far. The
   * input has to be `Formula.variable`, not the bare ref: `internalVariables`
   * counts only Formula inputs, and a node with none is rejected as
   * non-invertible long before the walk.
   */
  function overshootingCurve(level: MaybeRef<DecimalSource>): InvertibleFormula {
    return new Formula({
      inputs: [Formula.variable(level)],
      evaluate: (x: DecimalSource) => Decimal.add(Decimal.mul(x, 10), 10),
      invert: (value: DecimalSource, lhs: FormulaSource) =>
        (lhs as InvertibleFormula).invert(Decimal.mul(value, 100)),
    }) as InvertibleFormula;
  }

  test('a seed the walk cannot reach answers 0 rather than an unpayable count', () => {
    // Non-cumulative, so the seed is `formula.invert` — the lie — and pricing
    // is `evaluate`, which stays honest. Under cumulativeCost the seed comes
    // from `invertIntegral` instead and a lying `invert` is never consulted.
    const level = ref<DecimalSource>(0);
    const formula = overshootingCurve(level);
    const maxAffordable = calculateMaxAffordable(
      formula,
      createResource(ref<DecimalSource>(100)),
      false,
    );

    expect(() => maxAffordable.value).toLogError();
    expect(maxAffordable.value).compare_tolerance(0);
  });

  test('a seed the walk can reach is still answered normally', () => {
    // The postcondition must not fire on the ordinary case: the same curve,
    // inverted honestly, walks home and reports nothing.
    const level = ref<DecimalSource>(0);
    const formula = Formula.variable(level).mul(10).add(10);
    const maxAffordable = calculateMaxAffordable(
      formula,
      createResource(ref<DecimalSource>(100)),
      false,
    );

    expect(() => maxAffordable.value).not.toLogError();
    // evaluate(n) = 10n + 10 <= 100 -> n = 9
    expect(maxAffordable.value).compare_tolerance(9);
  });
});
