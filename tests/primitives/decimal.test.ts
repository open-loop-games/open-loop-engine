import { describe, it, expect, beforeEach } from 'vitest';
import {
  Decimal,
  bn,
  format,
  formatWhole,
  formatTime,
  integerRoot,
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

  it('recovers perfect cubes across magnitudes, where a fixed additive nudge is scale-blind', () => {
    for (const k of [100, 1000, 1e4, 1e5, 1e6]) {
      const cube = Decimal.pow(k, 3); // exact k³
      expect(integerRoot(cube, 3).eq(k), `∛(${k}³) = ${k}`).toBe(true);
    }
  });

  it('snaps within a relative tolerance band, not an absolute one', () => {
    const cube = Decimal.pow(1e6, 3); // 1e18; band = 1e18 · 1e-9 = 1e9
    expect(integerRoot(cube, 3).eq(1e6)).toBe(true);
    // a hair below the perfect power (well inside the band) snaps up to it —
    // near the boundary the log/exp float error already dominates
    expect(integerRoot(cube.sub(1), 3).eq(1e6)).toBe(true);
    // clearly below the band floors down
    expect(integerRoot(cube.mul(0.9), 3).lt(1e6)).toBe(true);
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
