/**
 * Conversion system — atomic multi-resource transformation.
 *
 * Turns N input resources into M output resources atomically: input costs are
 * snapshotted, outputs evaluate against the snapshot, inputs are paid, outputs
 * are added. Crafting recipes, market trades, and exchanges are the shape it
 * is built for — the machinery that earns its keep is multi-input atomicity
 * and the pre-payment snapshot.
 *
 * Inputs adopt the Requirements surface — each input is a Requirement.
 * Multi-input gating and payment delegate to `requirementsMet()` /
 * `payRequirements()`. The snapshot is keyed by the user-chosen input keys and
 * only includes CostRequirements; boolean gates and other non-cost
 * Requirements contribute nothing to the snapshot but still gate `canConvert`.
 *
 * That gives two legitimate shapes, and shipping code uses both:
 *
 * - **Paying exchange** — inputs are CostRequirements, the snapshot carries
 *   what was charged, outputs are a function of it. The recipe case.
 * - **Gated trigger** — inputs are `createBooleanRequirement`s (or costs with
 *   `requiresPay: false`) that pay nothing, the output amount is precomputed
 *   elsewhere, and the real "spend" is a `createReset` fired from
 *   `afterConvert`. The prestige case. Nothing about it is a misuse; a
 *   Requirement is not obliged to charge, which is why `anyOf` documents the
 *   pure-gate branch explicitly.
 *
 * Prestige does not *need* this factory — `createReset` plus a gain function
 * is the whole pattern, and several shipping games compose it that way. Reach
 * for a Conversion when you want the atomic gate + gain + reset bundled behind
 * one `convert()`, not because prestige is expected to live here.
 *
 * - {@link createConversion} — the factory
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

// === TYPES ===

/**
 * One output of a conversion: which Resource gets the gain, and how much.
 *
 * `amount` is a {@link Computable} for static / reactive values, or a function
 * over the consumed-input snapshot for variable exchanges. Snapshot keys match
 * the keys in the conversion's `inputs` record, and only CostRequirement
 * inputs appear.
 *
 * The two arms overlap by construction — `Computable` already admits a
 * zero-argument getter, so `() => gain.value` and `({ gold }) => …` are the
 * same arm as far as the type is concerned, distinguished only by whether the
 * body wants the snapshot. Both are called before any payment, so a getter
 * reading a live resource sees pre-conversion state too; the snapshot exists
 * for the one thing a getter cannot reach, which is *what the inputs charged*.
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
 * Steps 2–3 run before step 5, so an output reading the snapshot is
 * deterministic even when an input and an output share a resource.
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
 *     mana: { resource: mana, amount: ({ gold }) => gold.mul(50) },
 *   },
 * });
 * ```
 *
 * @example
 * ```ts
 * // Gated trigger: no cost, the reset is the spend.
 * createConversion({
 *   inputs: {
 *     ready: createBooleanRequirement({
 *       requirement: () => Decimal.gte(runs.value, 50),
 *       description: 'Reached run 50',
 *     }),
 *   },
 *   outputs: { token: { resource: token, amount: () => gainComputed.value } },
 *   afterConvert: () => prestigeReset.reset(),
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
      return new Decimal(amt(snapshot));
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
