/**
 * Conversion system — atomic multi-resource transformation.
 *
 * Turns N input resources into M output resources atomically: input costs are
 * snapshotted, output formulas evaluate against the snapshot, inputs are paid,
 * outputs are added. Used for crafting recipes, exchanges, market trades, and
 * prestige gain (the prestige variant composes externally with createReset).
 *
 * Inputs adopt the Requirements surface — each input is a Requirement
 * (typically a CostRequirement). Multi-input gating and payment delegate to
 * `requirementsMet()` / `payRequirements()`. The snapshot is keyed by the
 * user-chosen input keys and only includes CostRequirements; boolean gates
 * and other non-cost Requirements contribute nothing to the snapshot but
 * still gate `canConvert`.
 *
 * - {@link createConversion} — the factory
 * - Formula helpers: {@link createSqrtFormula}, {@link createLogFormula}, {@link createPolynomialFormula}
 */

import { computed, unref, type ComputedRef, type MaybeRef } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import type { Computable } from '@/core/computed';
import type { Resource } from '@/core/resource';
import {
  isCostRequirement,
  payRequirements,
  requirementsMet,
  type Requirement,
} from '@/core/requirements';
import { isType } from '@/core/feature';

// === TYPES ===

/** Symbol identifying Conversion features. */
export const ConversionType = Symbol('Conversion');

/**
 * One output of a conversion: which Resource gets the gain, and how much.
 *
 * `amount` is a {@link Computable} for static / reactive values, or a function
 * over the consumed-input snapshot for variable exchanges. Snapshot keys
 * match the keys in the conversion's `inputs` record.
 */
export interface ConversionOutput {
  /** The resource that receives the produced amount. */
  resource: Resource;
  /** Constant, reactive, or snapshot-aware amount specification. */
  amount: Computable<DecimalSource> | ((consumed: Record<string, Decimal>) => DecimalSource);
}

/** Options for {@link createConversion}. */
export interface ConversionOptions<
  I extends Record<string, Requirement> = Record<string, Requirement>,
  O extends Record<string, ConversionOutput> = Record<string, ConversionOutput>,
> {
  /** Input requirements keyed by user-chosen identifier. */
  inputs: I;
  /** Outputs keyed by user-chosen identifier. */
  outputs: O;
  /**
   * Hook fired before payment + production. Receives the predicted produced
   * amounts. Returning `false` cancels the conversion (no mutation occurs).
   */
  onConvert?: (conversion: Conversion, produced: Record<string, Decimal>) => boolean | void;
  /**
   * Hook fired after production. Compose layer resets here, log to telemetry,
   * trigger animations. Receives the actual produced amounts.
   */
  afterConvert?: (conversion: Conversion, produced: Record<string, Decimal>) => void;
}

/** A conversion instance returned by {@link createConversion}. */
export interface Conversion {
  /** Feature type discriminator for {@link isConversion} checks. */
  type: typeof ConversionType;
  /** Input requirements keyed as supplied to the factory. */
  inputs: Record<string, Requirement>;
  /** Output resources keyed as supplied (UI lookup of `displayName`). */
  outputs: Record<string, Resource>;
  /** True when all input requirements are met. */
  canConvert: ComputedRef<boolean>;
  /** Output amounts that would be produced if `convert()` ran right now. */
  currentGain: ComputedRef<Record<string, Decimal>>;
  /**
   * Execute the conversion. Returns the produced amounts, or an empty record
   * if `canConvert` is false or `onConvert` returns `false`.
   */
  convert(): Record<string, Decimal>;
}

// === FACTORY ===

/**
 * Create a conversion that atomically transforms input resources into output
 * resources.
 *
 * Execution order in `convert()`:
 * 1. Bail with `{}` if `!canConvert.value`.
 * 2. Build snapshot from `getCost(1)` per CostRequirement input.
 * 3. Compute `produced` from outputs against the snapshot.
 * 4. Fire `onConvert`. Bail with `{}` if it returns `false`.
 * 5. Pay all input requirements (left-to-right via `payRequirements`).
 * 6. Add `produced[key]` to each output resource.
 * 7. Fire `afterConvert`.
 * 8. Return `produced`.
 *
 * The snapshot materializes before any state mutation, so output formulas
 * reading consumed amounts are deterministic even when input and output
 * share a resource type.
 *
 * @example
 * ```ts
 * // Crafting: 100 wood + 50 mineral → 1 beam
 * createConversion({
 *   inputs: {
 *     wood: createCostRequirement({ resource: wood, cost: 100 }),
 *     mineral: createCostRequirement({ resource: mineral, cost: 50 }),
 *   },
 *   outputs: { beam: { resource: beam, amount: 1 } },
 * });
 * ```
 *
 * @example
 * ```ts
 * // Exchange: drain all gold, gain (gold * 50) mana
 * createConversion({
 *   inputs: {
 *     gold: createCostRequirement({
 *       resource: gold,
 *       cost: () => gold.value,
 *       pay: () => { gold.value = 0 },
 *     }),
 *   },
 *   outputs: {
 *     mana: { resource: mana, amount: ({ gold }) => gold.times(50) },
 *   },
 * });
 * ```
 */
export function createConversion<
  I extends Record<string, Requirement>,
  O extends Record<string, ConversionOutput>,
>(options: ConversionOptions<I, O>): Conversion {
  const { inputs, outputs, onConvert, afterConvert } = options;

  const outputResources: Record<string, Resource> = {};
  for (const key of Object.keys(outputs)) {
    outputResources[key] = outputs[key].resource;
  }

  const inputList = Object.values(inputs);

  function buildSnapshot(): Record<string, Decimal> {
    const snapshot: Record<string, Decimal> = {};
    for (const key of Object.keys(inputs)) {
      const req = inputs[key];
      if (isCostRequirement(req)) {
        snapshot[key] = new Decimal(req.getCost(1));
      }
    }
    return snapshot;
  }

  function evaluateOutput(out: ConversionOutput, snapshot: Record<string, Decimal>): Decimal {
    const amt = out.amount;
    if (typeof amt === 'function') {
      return new Decimal((amt as (s: Record<string, Decimal>) => DecimalSource)(snapshot));
    }
    return new Decimal(unref(amt as MaybeRef<DecimalSource>));
  }

  const canConvert = computed((): boolean => requirementsMet(inputList));

  const currentGain = computed((): Record<string, Decimal> => {
    const snapshot = buildSnapshot();
    const produced: Record<string, Decimal> = {};
    for (const key of Object.keys(outputs)) {
      produced[key] = evaluateOutput(outputs[key], snapshot);
    }
    return produced;
  });

  const conversion: Conversion = {
    type: ConversionType,
    inputs,
    outputs: outputResources,
    canConvert,
    currentGain,

    convert(): Record<string, Decimal> {
      if (!canConvert.value) return {};

      const snapshot = buildSnapshot();
      const produced: Record<string, Decimal> = {};
      for (const key of Object.keys(outputs)) {
        produced[key] = evaluateOutput(outputs[key], snapshot);
      }

      if (onConvert) {
        const result = onConvert(conversion, produced);
        if (result === false) return {};
      }

      payRequirements(inputList, 1);

      for (const key of Object.keys(outputs)) {
        const resource = outputs[key].resource;
        resource.value = Decimal.add(resource.value, produced[key]);
      }

      afterConvert?.(conversion, produced);

      return produced;
    },
  };

  return conversion;
}

// === FORMULA HELPERS ===

/**
 * Create a square-root formula: `floor(√(x / scale))`.
 *
 * The most common prestige gain curve. With `scale = 100`, 100 base → 1 gain,
 * 400 → 2, 900 → 3.
 */
export function createSqrtFormula(scale: DecimalSource = 10): (x: DecimalSource) => DecimalSource {
  return (x: DecimalSource): DecimalSource => {
    return new Decimal(Decimal.div(x, scale)).sqrt().floor();
  };
}

/**
 * Create a logarithmic formula: `floor(log_base(x / scale))`.
 *
 * Slower than sqrt — each additional gain unit requires ~`base`× more base.
 * Returns 0 when `x / scale <= 1`.
 */
export function createLogFormula(
  base: DecimalSource = 10,
  scale: DecimalSource = 1,
): (x: DecimalSource) => DecimalSource {
  return (x: DecimalSource): DecimalSource => {
    const scaled = Decimal.div(x, scale);
    if (Decimal.lte(scaled, 1)) return Decimal.dZero;
    return Decimal.log(scaled, base).floor();
  };
}

/**
 * Create a polynomial formula: `floor((x / scale) ^ exponent)`.
 *
 * Generalizes sqrt — `exponent = 0.5` matches {@link createSqrtFormula}.
 */
export function createPolynomialFormula(
  exponent: DecimalSource = 0.5,
  scale: DecimalSource = 10,
): (x: DecimalSource) => DecimalSource {
  return (x: DecimalSource): DecimalSource => {
    return new Decimal(Decimal.div(x, scale)).pow(exponent).floor();
  };
}

// === TYPE GUARDS ===

/** Type guard: returns `true` if the value is a {@link Conversion} instance. */
export function isConversion(value: unknown): value is Conversion {
  return isType(value, ConversionType);
}
