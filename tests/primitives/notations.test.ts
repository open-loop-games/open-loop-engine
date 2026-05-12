import { describe, it, expect, beforeEach } from 'vitest';
import { Presets } from '@/primitives/notations';
import { NotationManager } from '@/primitives/notation-manager';

// ============================================================================
// Eternal Notations Presets (sanity checks — the library has its own tests)
// ============================================================================

describe('Presets.Standard', () => {
  const fmt = (v: number | string) => Presets.Standard.format(v);

  it('handles zero', () => {
    expect(fmt(0)).toBe('0');
  });

  it('formats small numbers without suffix', () => {
    expect(fmt(1)).toBe('1');
    expect(fmt(42)).toBe('42');
    expect(fmt(999)).toBe('999');
  });

  it('formats thousands with k suffix', () => {
    expect(fmt(1000)).toBe('1 k');
    expect(fmt(1490)).toBe('1.49 k');
    expect(fmt(10000)).toBe('10 k');
    expect(fmt(149000)).toBe('149 k');
  });

  it('formats millions and beyond', () => {
    expect(fmt(1e6)).toBe('1 M');
    expect(fmt(1e9)).toBe('1 B');
    expect(fmt(1e12)).toBe('1 T');
    expect(fmt(1e15)).toBe('1 Qa');
  });
});

describe('Presets.Scientific', () => {
  const fmt = (v: number | string) => Presets.Scientific.format(v);

  it('handles zero', () => {
    expect(fmt(0)).toBe('0');
  });

  it('formats with mantissa and exponent', () => {
    expect(fmt(1000)).toBe('1e3');
    expect(fmt(1490)).toBe('1.49e3');
    expect(fmt(1e6)).toBe('1e6');
    expect(fmt(2.5e10)).toBe('2.5e10');
  });
});

describe('Presets.Engineering', () => {
  const fmt = (v: number | string) => Presets.Engineering.format(v);

  it('handles zero', () => {
    expect(fmt(0)).toBe('0');
  });

  it('uses exponents that are multiples of 3', () => {
    expect(fmt(1000)).toBe('1e3');
    expect(fmt(1e4)).toBe('10e3');
    expect(fmt(1e5)).toBe('100e3');
    expect(fmt(1e6)).toBe('1e6');
    expect(fmt(1e7)).toBe('10e6');
    expect(fmt(1e8)).toBe('100e6');
    expect(fmt(1e9)).toBe('1e9');
  });
});

// ============================================================================
// NotationManager
// ============================================================================

describe('NotationManager', () => {
  let manager: NotationManager;

  beforeEach(() => {
    manager = new NotationManager();
  });

  it('starts with standard as default', () => {
    expect(manager.getActive()).toBe('standard');
  });

  it('has three built-in notations', () => {
    const available = manager.getAvailable();
    expect(available).toEqual(['standard', 'scientific', 'engineering']);
  });

  it('formats using the active notation', () => {
    expect(manager.format(1490)).toBe('1.49 k');
  });

  it('switches active notation', () => {
    manager.setActive('scientific');
    expect(manager.getActive()).toBe('scientific');
    expect(manager.format(1490)).toBe('1.49e3');
  });

  it('throws on unknown notation', () => {
    expect(() => manager.setActive('unknown')).toThrow('Notation "unknown" is not registered');
  });

  it('registers additional eternal presets', () => {
    manager.register('logarithm', Presets.Logarithm);
    expect(manager.getAvailable()).toContain('logarithm');
    manager.setActive('logarithm');
    expect(manager.format(1e15)).toBe('e15');
  });

  it('overwrites existing notation on re-register', () => {
    manager.register('standard', Presets.Scientific);
    expect(manager.format(1490)).toBe('1.49e3');
  });
});
