/**
 * NotationManager — singleton that controls which notation format() uses.
 *
 * Ships with Standard, Scientific, and Engineering from eternal_notations
 * pre-registered. Consumers can register additional notations at init time.
 *
 * @cluster notations
 */

import { Decimal, type DecimalSource } from './decimal';
import { Notation, Presets } from './notations';

/**
 * Build a rounding function for N significant figures.
 * Matches eternal_notations' defaultRound pattern (which uses 4 sig figs).
 */
function sigFigRounding(sigFigs: number): (value: Decimal) => Decimal {
  const offset = sigFigs - 1;
  return (value: Decimal) => {
    if (value.eq(0)) return new Decimal(0);
    return value.abs().log10().floor().sub(offset).pow_base(10).min(1);
  };
}

/**
 * Singleton-style registry that controls which {@link Notation} `format()`
 * uses for `Decimal` rendering. Ships with `standard`, `scientific`, and
 * `engineering` from `eternal_notations` pre-registered; consumers add more
 * via `register(name, notation)`.
 */
export class NotationManager {
  private notations = new Map<string, Notation>();
  private active = 'standard';
  private precision = 4; // eternal_notations default (defaultRound uses 4 sig figs)

  constructor() {
    this.notations.set('standard', Presets.Standard);
    this.notations.set('scientific', Presets.Scientific);
    this.notations.set('engineering', Presets.Engineering);
  }

  /** Register a notation by name. Accepts any eternal_notations Notation instance. */
  register(name: string, notation: Notation): void {
    this.notations.set(name, notation);
  }

  /** Set the active notation by name. Throws if not registered. */
  setActive(name: string): void {
    if (!this.notations.has(name)) {
      throw new Error(`Notation "${name}" is not registered`);
    }
    this.active = name;
  }

  /** Get the name of the active notation. */
  getActive(): string {
    return this.active;
  }

  /** Get the current precision (significant figures). */
  getPrecision(): number {
    return this.precision;
  }

  /**
   * Set significant figures for all registered notations.
   * Updates the `rounding` property on notations that support it.
   */
  setPrecision(sigFigs: number): void {
    this.precision = sigFigs;
    const roundFn = sigFigRounding(sigFigs);
    for (const notation of this.notations.values()) {
      if ('rounding' in notation) {
        (notation as Notation & { rounding: unknown }).rounding = roundFn;
      }
    }
  }

  /** List all registered notation names. */
  getAvailable(): string[] {
    return [...this.notations.keys()];
  }

  /** Format a value using the active notation. */
  format(value: DecimalSource): string {
    const notation = this.notations.get(this.active)!;
    return notation.format(value);
  }
}

/** Global notation manager instance. */
export const notationManager = new NotationManager();
