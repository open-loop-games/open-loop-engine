/**
 * Modifier system — composable value calculation chains
 *
 * Modifiers are the building blocks for production rates, bonuses, and derived
 * values. Chain them with {@link createSequentialModifier} to build a pipeline
 * like `base → +10 → ×2 → ^0.5` that can run forward (apply) and backward (invert).
 *
 * - {@link createAdditiveModifier} — `value + addend`
 * - {@link createMultiplicativeModifier} — `value × multiplier`
 * - {@link createExponentialModifier} — `value ^ exponent`
 * - {@link createSequentialModifier} — compose modifiers into a pipeline
 * - {@link computeModifiedValue} — reactive computed applying modifiers to a base
 */

import { computed, unref, type ComputedRef, type MaybeRef } from 'vue';
import { Decimal, formatSmall, renormIfLayer0, toFinalDecimal } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import type { RequiredKeys } from './common';
import { processGetter, type Computable, type MaybeGetter } from './computed';
import { createEmitHandle, type Emittable } from './events';
import { getCurrentChainRegistry } from './registries';
import { getCurrentFullContext } from './persistence';
import { profile } from './profiler';

/**
 * A single step in a value calculation pipeline.
 *
 * Every modifier can `apply` (forward) and optionally `invert` (backward).
 * Inversion enables "how much base do I need to reach X?" calculations —
 * critical for "next at" displays and "time until" projections.
 */
export interface Modifier {
  /** Transform the input value forward (e.g., add, multiply, exponentiate) */
  apply: (gain: DecimalSource) => DecimalSource;
  /** Reverse the transformation. Required for inversion-based features (next-at, time-until). */
  invert?: (gain: DecimalSource) => DecimalSource;
  /** When `false`, this modifier is skipped in apply/invert chains. Can be a ref for reactive toggling. */
  enabled?: MaybeRef<boolean>;
  /** Human-readable description for UI breakdown panels */
  description?: MaybeGetter<ModifierDescription>;
}

/** A single line in a modifier breakdown, suitable for rendering in a tooltip or info panel */
export interface ModifierDescription {
  /** What this modifier represents (e.g., "Upgrade 1", "Prestige bonus") */
  text: string;
  /** Formatted operation + value (e.g., "+10", "×2", "^1.5") */
  formattedValue: string;
  /** If `true`, this modifier is detrimental — UI should render in red/warning style */
  isBad?: boolean;
}

type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };

/** Utility type for modifiers that have all optional methods defined */
export type OperationModifier<T> = WithRequired<
  Modifier,
  'invert' | Extract<RequiredKeys<T>, keyof Modifier>
>;

// === ADDITIVE MODIFIER ===

/** Options for {@link createAdditiveModifier} */
export interface AdditiveModifierOptions {
  /** The amount to add. Can be a ref/getter for dynamic values (e.g., scaling with upgrades). */
  addend: Computable<DecimalSource>;
  /** Label for the UI breakdown (e.g., "Upgrade bonus"). Can be a getter for dynamic text. */
  description?: MaybeGetter<string>;
  /** Reactive toggle. When `false`, this modifier is skipped entirely. Default: always enabled. */
  enabled?: Computable<boolean>;
  /** Flip the "bad" indicator: positive addends show as bad. Use for costs or penalties. */
  smallerIsBetter?: boolean;
}

/**
 * Create a modifier that adds a value to the input.
 *
 * @param options - Configuration for the additive modifier
 * @returns A modifier that adds the specified amount
 *
 * @example
 * ```ts
 * const bonusPoints = createAdditiveModifier({
 *   addend: () => upgrades.bonus.value ? 10 : 0,
 *   description: "Bonus upgrade",
 *   enabled: () => upgrades.bonus.active.value
 * })
 * ```
 */
export function createAdditiveModifier<T extends AdditiveModifierOptions, S = OperationModifier<T>>(
  options: T,
): S {
  const { addend, description, enabled, smallerIsBetter } = options;

  const processedAddend = processGetter(addend);
  const processedEnabled = enabled == null ? undefined : processGetter(enabled);

  return {
    apply: (gain: DecimalSource) => Decimal.add(gain, unref(processedAddend)),
    invert: (gain: DecimalSource) => Decimal.sub(gain, unref(processedAddend)),
    enabled: processedEnabled,
    currentValue: computed(() => new Decimal(unref(processedAddend))),
    description:
      description == null
        ? undefined
        : (): ModifierDescription => {
            const value = unref(processedAddend);
            const isPositive = Decimal.gte(value, 0);
            return {
              text: typeof description === 'function' ? description() : description,
              formattedValue: (isPositive ? '+' : '') + formatSmall(value),
              isBad: smallerIsBetter ? isPositive : Decimal.lt(value, 0),
            };
          },
  } as S;
}

// === MULTIPLICATIVE MODIFIER ===

/** Options for {@link createMultiplicativeModifier} */
export interface MultiplicativeModifierOptions {
  /** The factor to multiply by. Can be a ref/getter for dynamic values. */
  multiplier: Computable<DecimalSource>;
  /** Label for the UI breakdown. Can be a getter for dynamic text. */
  description?: MaybeGetter<string>;
  /** Reactive toggle. When `false`, this modifier is skipped. Default: always enabled. */
  enabled?: Computable<boolean>;
  /** Flip the "bad" indicator: multipliers > 1 show as bad. Use for cost multipliers. */
  smallerIsBetter?: boolean;
}

/**
 * Create a modifier that multiplies the input by a value.
 *
 * @param options - Configuration for the multiplicative modifier
 * @returns A modifier that multiplies by the specified amount
 *
 * @example
 * ```ts
 * const doubleProduction = createMultiplicativeModifier({
 *   multiplier: 2,
 *   description: "Double production upgrade"
 * })
 * ```
 *
 * @example Per-action conditional multiplier via `enabled` predicate:
 * ```ts
 * // Glasses boost wander progress, but only while equipped
 * const glassesBoost = createMultiplicativeModifier({
 *   multiplier: 1.5,
 *   description: 'Glasses',
 *   enabled: computed(() => equipment.has('glasses')),
 * });
 * ```
 * For lifecycle management + balance-sim attribution, bind conditional
 * modifiers through {@link createPersistentEffectSystem} rather than
 * toggling `enabled` manually.
 */
export function createMultiplicativeModifier<
  T extends MultiplicativeModifierOptions,
  S = OperationModifier<T>,
>(options: T): S {
  const { multiplier, description, enabled, smallerIsBetter } = options;

  const processedMultiplier = processGetter(multiplier);
  const processedEnabled = enabled == null ? undefined : processGetter(enabled);

  return {
    apply: (gain: DecimalSource) => Decimal.times(gain, unref(processedMultiplier)),
    invert: (gain: DecimalSource) => Decimal.div(gain, unref(processedMultiplier)),
    enabled: processedEnabled,
    currentValue: computed(() => new Decimal(unref(processedMultiplier))),
    description:
      description == null
        ? undefined
        : (): ModifierDescription => {
            const value = unref(processedMultiplier);
            return {
              text: typeof description === 'function' ? description() : description,
              formattedValue: '×' + formatSmall(value),
              isBad: smallerIsBetter ? Decimal.gt(value, 1) : Decimal.lt(value, 1),
            };
          },
  } as S;
}

// === EXPONENTIAL MODIFIER ===

/** Options for {@link createExponentialModifier} */
export interface ExponentialModifierOptions {
  /** The power to raise the input to. Can be a ref/getter for dynamic values. */
  exponent: Computable<DecimalSource>;
  /** Label for the UI breakdown. Can be a getter for dynamic text. */
  description?: MaybeGetter<string>;
  /** Reactive toggle. When `false`, this modifier is skipped. Default: always enabled. */
  enabled?: Computable<boolean>;
  /**
   * If true, applies as `(value + 1) ^ exp - 1` instead of `value ^ exp`.
   * Prevents small inputs (< 1) from shrinking further — useful when the
   * base value might be fractional or near zero.
   */
  supportLowNumbers?: boolean;
  /** Flip the "bad" indicator: exponents > 1 show as bad. */
  smallerIsBetter?: boolean;
}

/**
 * Create a modifier that raises the input to a power.
 *
 * @param options - Configuration for the exponential modifier
 * @returns A modifier that exponentiates by the specified amount
 *
 * @example
 * ```ts
 * const softcap = createExponentialModifier({
 *   exponent: 0.5,
 *   description: "Softcap at 1000",
 *   enabled: () => points.value >= 1000
 * })
 * ```
 */
export function createExponentialModifier<
  T extends ExponentialModifierOptions,
  S = OperationModifier<T>,
>(options: T): S {
  const { exponent, description, enabled, supportLowNumbers, smallerIsBetter } = options;

  const processedExponent = processGetter(exponent);
  const processedEnabled = enabled == null ? undefined : processGetter(enabled);

  return {
    apply: (gain: DecimalSource) => {
      // renormIfLayer0 between steps keeps the value in number-space so each
      // Decimal.X op's typeof fast path can fire. pow has no fast path of its
      // own, but renorming before it keeps its internal `D()` wrap cheap and
      // the following sub in number-space. Final wrap honors the chain-form
      // contract for consumers of modifier.apply.
      let result: DecimalSource = gain;
      if (supportLowNumbers) {
        result = renormIfLayer0(Decimal.add(result, 1));
      }
      result = renormIfLayer0(Decimal.pow(result, unref(processedExponent)));
      if (supportLowNumbers) {
        result = renormIfLayer0(Decimal.sub(result, 1));
      }
      return toFinalDecimal(result);
    },
    invert: (gain: DecimalSource) => {
      let result: DecimalSource = gain;
      if (supportLowNumbers) {
        result = renormIfLayer0(Decimal.add(result, 1));
      }
      result = renormIfLayer0(Decimal.root(result, unref(processedExponent)));
      if (supportLowNumbers) {
        result = renormIfLayer0(Decimal.sub(result, 1));
      }
      return toFinalDecimal(result);
    },
    enabled: processedEnabled,
    currentValue: computed(() => new Decimal(unref(processedExponent))),
    description:
      description == null
        ? undefined
        : (): ModifierDescription => {
            const value = unref(processedExponent);
            const text = typeof description === 'function' ? description() : description;
            return {
              text: supportLowNumbers ? text + ' (+1 effective)' : text,
              formattedValue: '^' + formatSmall(value),
              isBad: smallerIsBetter ? Decimal.gt(value, 1) : Decimal.lt(value, 1),
            };
          },
  } as S;
}

// === SEQUENTIAL MODIFIER ===

/**
 * Compose multiple modifiers into a single pipeline that applies them in order.
 *
 * This is the primary way to build a calculation chain in the engine. Disabled
 * modifiers are skipped. Inversion runs the chain in reverse (required: every
 * child modifier must have `invert` for the composite to be invertible).
 *
 * The returned modifier exposes a `children` array for introspection. The
 * composite holds the input array *by reference*, so post-construction
 * mutations (push/splice on the original array) are visible at evaluation
 * time — consumers that want a stable snapshot must pass a copy.
 *
 * @param modifiers - Array of modifiers to compose into a pipeline
 * @returns A single {@link Modifier} that applies all children in sequence, plus a readonly `children` array
 *
 * @example
 * ```ts
 * const production = createSequentialModifier([
 *   createAdditiveModifier({ addend: 10, description: 'Base' }),
 *   createMultiplicativeModifier({ multiplier: 2, description: 'Upgrade' }),
 *   createExponentialModifier({ exponent: 0.9, description: 'Softcap' }),
 * ]);
 *
 * production.apply(0);  // (0 + 10) × 2 ^ 0.9 = ~17.1
 * production.invert!(17.1);  // ≈ 0 (reverses the chain)
 * ```
 */
export function createSequentialModifier<
  T extends Modifier,
  S = WithRequired<Modifier, Extract<RequiredKeys<T>, keyof Modifier>> & {
    readonly children: readonly T[];
  },
>(modifiers: T[]): S {
  return {
    // Reduce body keeps the accumulator renormalized so each modifier's
    // typeof fast path can fire; the final return wraps once to Decimal so
    // consumers chaining `.mul()/.gt()/.toNumber()` on the output see the
    // instance form.
    apply: (gain: DecimalSource) =>
      profile('modifier.chain.apply', () =>
        toFinalDecimal(
          modifiers
            .filter((m) => unref(m.enabled) !== false)
            .reduce<DecimalSource>((acc, modifier) => renormIfLayer0(modifier.apply(acc)), gain),
        ),
      ),

    invert: modifiers.every((m) => m.invert != null)
      ? (gain: DecimalSource) =>
          toFinalDecimal(
            modifiers
              .filter((m) => unref(m.enabled) !== false)
              .reduceRight<DecimalSource>(
                (acc, modifier) => renormIfLayer0(modifier.invert!(acc)),
                gain,
              ),
          )
      : undefined,

    enabled: modifiers.some((m) => m.enabled != null)
      ? computed(() => modifiers.filter((m) => unref(m.enabled) !== false).length > 0)
      : undefined,

    description: modifiers.some((m) => m.description != null)
      ? (): ModifierDescription[] =>
          modifiers
            .filter((m) => unref(m.enabled) !== false && m.description != null)
            .map((m) => {
              const desc = m.description!;
              return typeof desc === 'function' ? desc() : desc;
            })
      : undefined,

    /** Read-only access to the component modifiers in this chain */
    children: modifiers as readonly T[],
  } as S;
}

// === MODIFIER CHAIN ===

/**
 * Events emitted by a {@link ModifierChain}
 */
export interface ModifierChainEvents {
  /** Fired when a modifier is added or removed */
  change: () => void;
}

/**
 * Options for {@link ModifierChain.bind}.
 *
 * A "bound" modifier is a {@link Modifier} added to a chain with auto-derived
 * attribution (so balance-sim/devtools can trace each chain contribution back
 * to its originating category + item) and an optional reactive predicate that
 * gates evaluation.
 */
export interface BindOptions {
  /**
   * Reactive predicate controlling whether the bound modifier is active.
   * Composed AND-style with any existing `enabled` flag on the modifier itself.
   * When omitted, the binding is always active (useful for permanent
   * contributions with attribution metadata).
   */
  active?: Computable<boolean>;
  /**
   * The modifier to bind — either a concrete modifier or a factory called
   * once at bind time. Factory form is a convenience for inline composition
   * (e.g. `modifier: () => createMultiplicativeModifier({...})`).
   */
  modifier: Modifier | (() => Modifier);
  /**
   * Override the auto-derived binding id. Normally omitted — the id is
   * derived from the ambient persistent context (`getCurrentFullContext`)
   * and the modifier's description text, producing `{scope}/{text}`.
   */
  id?: string;
  /** Free-form attribution tags surfaced through {@link ModifierChain.bindings}. */
  tags?: readonly string[];
}

/**
 * Attribution record for a single bound modifier, returned by
 * {@link ModifierChain.bindings}.
 */
export interface BindingRecord {
  /** Unique (within a chain) binding id. Auto-derived or explicit per {@link BindOptions}. */
  readonly id: string;
  /** The modifier that was bound. */
  readonly modifier: Modifier;
  /** The active predicate (if any) gating this binding's evaluation. */
  readonly active?: MaybeRef<boolean>;
  /** Free-form attribution tags supplied at bind time. */
  readonly tags: readonly string[];
  /**
   * The full (namespaced) persistent context id this binding was registered
   * in, or `undefined` if the binding was created outside any
   * `withPersistentContext` scope.
   */
  readonly scope: string | undefined;
}

/**
 * Declarative binding entry — the shape consumers use inside per-category
 * declarative fields (`grants` / `restricts` / `rewards`). Each entry says
 * *what modifier* to bind to *which chain(s)* when the surrounding category
 * signal is active; the category supplies the implicit `active` predicate
 * (e.g. `item.active` for purchasables) so consumer code doesn't repeat it.
 *
 * Use the `mult` / `add` / `exp` short-hands for the common modifier kinds;
 * the `modifier` variant is the escape hatch for hand-built modifiers
 * (invertible chains, sequential composites, replacement bindings).
 */
export type Grant =
  | {
      /** One or more chains to bind onto. Array binds the same modifier to each chain with a shared predicate. */
      chain: ModifierChain | ModifierChain[];
      /** Multiplier value (or reactive source). */
      mult: Computable<DecimalSource>;
      /** Stable description used for attribution + UI breakdowns. */
      description: string;
      /** Optional additional predicate AND-composed with the category's implicit active signal. */
      when?: Computable<boolean>;
    }
  | {
      chain: ModifierChain | ModifierChain[];
      /** Additive value (or reactive source). */
      add: Computable<DecimalSource>;
      description: string;
      when?: Computable<boolean>;
    }
  | {
      chain: ModifierChain | ModifierChain[];
      /** Exponent value (or reactive source). */
      exp: Computable<DecimalSource>;
      description: string;
      when?: Computable<boolean>;
    }
  | {
      chain: ModifierChain | ModifierChain[];
      /** Hand-built modifier (or factory). Must have a description for attribution, or supply one inline. */
      modifier: Modifier | (() => Modifier);
      description?: string;
      when?: Computable<boolean>;
    };

/**
 * A named, auto-composing sequential modifier that acts as a registry.
 * Other modules add modifiers via `add()` (raw) or `bind()` (with attribution).
 * The chain composes them internally via {@link createSequentialModifier}
 * and exposes `apply` / `invert` / `description`.
 *
 * Implements the {@link Modifier} interface so it can be used anywhere a modifier is expected.
 */
export interface ModifierChain extends Modifier {
  /** Unique identifier for this chain */
  readonly id: string;
  /**
   * Add a modifier to the chain. Returns a function to remove it.
   *
   * No reference-identity dedup: pushing the same `Modifier` twice adds two
   * entries (and {@link remove} only removes the first). Callers that need
   * dedup should use {@link bind}, which throws on duplicate ids.
   */
  add(modifier: Modifier): () => void;
  /**
   * Add a modifier with auto-derived attribution and an optional reactive
   * `active` predicate. Prefer this over {@link add} for consumer code:
   * balance-sim, devtools, and modifier inspectors walk
   * {@link bindings} to attribute each chain contribution to its source.
   *
   * Auto-id format: `{scope}/{modifier.description.text}` where `scope`
   * comes from the ambient persistent context. Outside any context, emits
   * a warning and uses just the description text as the id. Duplicate ids
   * within one chain throw — override via `opts.id` when intentional.
   *
   * @returns A function that removes the binding (modifier + attribution record) from the chain.
   */
  bind(opts: BindOptions): () => void;
  /** Remove a previously added modifier */
  remove(modifier: Modifier): void;
  /** Read-only snapshot of the current modifiers in the chain */
  readonly modifiers: readonly Modifier[];
  /**
   * Attribution records for every modifier added via {@link bind} (modifiers
   * added via raw {@link add} do not appear here). Walk this to surface
   * "where does each contribution come from?" in balance-sim / devtools.
   */
  bindings(): readonly BindingRecord[];
  /** Subscribe to chain events */
  on: Emittable<ModifierChainEvents>['on'];
}

/**
 * Create a named modifier chain that other modules can push modifiers into.
 *
 * The chain composes all added modifiers via {@link createSequentialModifier}
 * and re-exposes `apply`, `invert`, `enabled`, and `description`. Implements
 * `Modifier` so it can be used directly in {@link computeModifiedValue} or
 * other consumers of the `Modifier` shape.
 *
 * Share chains across modules either explicitly via `engine.provide()` /
 * `engine.inject()`, or implicitly via the engine-wide chain registry:
 * every chain constructed inside a module's `install()` or `connect()`
 * auto-registers under {@link ChainRegistryKey}, so balance workbenches and
 * devtools can enumerate all chains without any per-chain publication.
 * Chains constructed outside an engine (tests, throwaway scripts) skip
 * registration silently — the primitive still works, just isn't discoverable.
 *
 * Duplicate ids within a single engine throw on construction. Use namespaced
 * ids (e.g., `"producers/coin-mine/rate"`) for per-entity chains.
 *
 * @param id - Unique name for the chain (e.g., 'decay', 'maxHealth')
 * @returns A {@link ModifierChain} that acts as both a registry and a modifier
 *
 * @example Single-module chain with direct add:
 * ```ts
 * install(engine) {
 *   const decayChain = createModifierChain('decay');
 *   decayChain.add(createMultiplicativeModifier({ multiplier: 0.9, description: 'Base' }));
 *   engine.provide(DecayChainKey, decayChain);
 * }
 * ```
 *
 * @example Surface-wide chain shared across modules via persistent-effect:
 * ```ts
 * // Module A creates the chain — auto-registered for discovery
 * const progressChain = createModifierChain('progress');
 *
 * // Module B binds a conditional modifier through persistent-effect
 * effects.register({
 *   id: 'affected-by:wander:glasses',
 *   active: computed(() => equipment.has('glasses')),
 *   modifiers: [{ chain: progressChain, modifier: () =>
 *     createMultiplicativeModifier({ multiplier: 1.5, description: 'Glasses' }) }],
 * });
 *
 * // Balance tool enumerates all chains
 * const registry = engine.inject(ChainRegistryKey);
 * for (const chain of registry.all()) console.log(chain.id);
 * ```
 * Prefer binding through {@link createPersistentEffectSystem} over raw
 * `chain.add()` so the {@link EffectSystemRegistryKey | EffectSystemRegistry}
 * can trace every modifier to its source for balance-sim attribution.
 */
export function createModifierChain(id: string): ModifierChain {
  const items: Modifier[] = [];
  const bindingsById = new Map<string, BindingRecord>();
  const handle = createEmitHandle<ModifierChainEvents>();

  function recompose(): void {
    profile('modifier.chain.recompose', () => {
      const composed = createSequentialModifier(items);
      chain.apply = composed.apply;
      chain.invert = composed.invert;
      chain.enabled = composed.enabled;
      chain.description = composed.description;
      handle.emit('change');
    });
  }

  const chain: ModifierChain = {
    id,
    apply: (gain: DecimalSource) => gain,
    invert: (gain: DecimalSource) => gain,
    enabled: undefined,
    description: undefined,

    add(modifier: Modifier): () => void {
      items.push(modifier);
      recompose();
      return () => chain.remove(modifier);
    },

    bind(opts: BindOptions): () => void {
      const rawModifier = typeof opts.modifier === 'function' ? opts.modifier() : opts.modifier;

      // Compose active predicate with any existing enabled on the modifier.
      let modifier: Modifier = rawModifier;
      let activeRef: MaybeRef<boolean> | undefined;
      if (opts.active != null) {
        activeRef = processGetter(opts.active);
        const existingEnabled = rawModifier.enabled;
        const composedEnabled: MaybeRef<boolean> =
          existingEnabled == null
            ? activeRef
            : computed(() => unref(existingEnabled) !== false && unref(activeRef!) !== false);
        modifier = { ...rawModifier, enabled: composedEnabled };
      }

      // Resolve id — explicit override wins, otherwise derive from scope + description.
      const scope = getCurrentFullContext();
      let bindingId = opts.id;
      if (bindingId == null) {
        const descText = resolveDescriptionText(modifier);
        if (descText == null) {
          throw new Error(
            `chain.bind on "${chain.id}": cannot auto-derive binding id — modifier has ` +
              `no description and no explicit \`id\` was provided.`,
          );
        }
        bindingId = scope == null ? descText : `${scope}/${descText}`;
      }

      if (bindingsById.has(bindingId)) {
        throw new Error(
          `chain.bind on "${chain.id}": duplicate binding id "${bindingId}". Binding ids ` +
            `must be unique within a chain.`,
        );
      }

      if (scope == null && opts.id == null) {
        console.warn(
          `chain.bind on "${chain.id}": called outside any persistent context. ` +
            `Binding will still work but won't be attributed to a category or module.`,
        );
      }

      const record: BindingRecord = {
        id: bindingId,
        modifier,
        active: activeRef,
        tags: opts.tags ?? [],
        scope,
      };
      bindingsById.set(bindingId, record);

      const removeFromChain = chain.add(modifier);
      return () => {
        removeFromChain();
        bindingsById.delete(bindingId!);
      };
    },

    remove(modifier: Modifier): void {
      const idx = items.indexOf(modifier);
      if (idx >= 0) {
        items.splice(idx, 1);
        recompose();
      }
    },

    get modifiers(): readonly Modifier[] {
      return items;
    },

    bindings(): readonly BindingRecord[] {
      return Array.from(bindingsById.values());
    },

    on: handle.on,
  };

  // Auto-register into the current engine's chain registry when constructed
  // inside an install()/connect() phase. Outside an engine (tests, ad-hoc
  // scripts) the ambient is undefined and registration is a silent no-op.
  getCurrentChainRegistry()?.register(chain);

  return chain;
}

/**
 * Best-effort extraction of the stable text key from a modifier's description.
 * Returns the `.text` of a {@link ModifierDescription}, or the joined texts of
 * a description-array (sequential modifier output), or `undefined` when the
 * modifier has no description at all.
 */
function resolveDescriptionText(modifier: Modifier): string | undefined {
  const desc = modifier.description;
  if (desc == null) return undefined;
  const resolved = typeof desc === 'function' ? desc() : desc;
  if (resolved == null) return undefined;
  if (Array.isArray(resolved)) {
    const texts = resolved.map((d) => d.text).filter((t) => t != null && t !== '');
    return texts.length > 0 ? texts.join('+') : undefined;
  }
  return (resolved as ModifierDescription).text;
}

// === UTILITY FUNCTIONS ===

/**
 * Apply a single modifier to a value. Respects the modifier's `enabled` flag.
 *
 * @param modifier - The modifier to apply
 * @param value - The input value
 * @returns The modified value, or the original if the modifier is disabled
 */
export function applyModifier(modifier: Modifier, value: DecimalSource): DecimalSource {
  if (unref(modifier.enabled) === false) {
    return value;
  }
  return modifier.apply(value);
}

/**
 * Apply multiple modifiers in sequence to a value (left to right).
 *
 * @param modifiers - Modifiers to apply in order
 * @param value - The starting input value
 * @returns The value after all enabled modifiers have been applied
 */
export function applyModifiers(modifiers: Modifier[], value: DecimalSource): DecimalSource {
  return toFinalDecimal(
    modifiers.reduce<DecimalSource>((acc, mod) => renormIfLayer0(applyModifier(mod, acc)), value),
  );
}

/**
 * Invert a modifier: given a desired output, find the input that produces it.
 *
 * @param modifier - The modifier to invert
 * @param value - The desired output value
 * @returns The input that would produce `value`, or `undefined` if the modifier is not invertible
 */
export function invertModifier(
  modifier: Modifier,
  value: DecimalSource,
): DecimalSource | undefined {
  if (unref(modifier.enabled) === false) {
    return value;
  }
  return modifier.invert?.(value);
}

/**
 * Create a computed ref that applies modifiers to a base value.
 * Automatically updates when any modifier's values change.
 *
 * @param base - Base value or getter
 * @param modifiers - Array of modifiers to apply
 * @returns Computed ref with the modified value
 *
 * @example
 * ```ts
 * const production = computeModifiedValue(
 *   () => baseProduction.value,
 *   [upgradeModifier, prestigeModifier, softcap]
 * )
 * ```
 */
export function computeModifiedValue(
  base: Computable<DecimalSource>,
  modifiers: Modifier[],
): ComputedRef<DecimalSource> {
  const processedBase = processGetter(base);
  return computed(() => {
    const baseValue = unref(processedBase);
    return applyModifiers(modifiers, baseValue);
  });
}
