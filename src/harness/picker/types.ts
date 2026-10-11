/**
 * Picker types — `PickerWalker`, `PickerAddress`, `PickerEntry`,
 * `PickerSnapshot`.
 *
 * The picker walks two kinds of address:
 *
 * - **Structural identity** — `Modifier`s in auto-registered chains and
 *   lowered grants. The picker finds them by enumerating the engine's
 *   chain registry and effect-system registry (`ChainRegistryKey`,
 *   `EffectSystemRegistryKey`). Perturbation wraps the modifier in its chain
 *   position, or, for a lowered grant, the grant in every activation.
 *
 * - **Addressability identity** — `tunable()` values registered into a
 *   `TuningRegistry`. A tunable is the designer's opt-in declaration that a
 *   value is open to external control (see `createTuningRegistry` /
 *   `tunable` for the principle). Perturbation pushes overrides on the
 *   owning tuning registry.
 *
 * `PickerEntry` is a tagged union whose discriminant is the top-level `kind`,
 * so the two kinds narrow cleanly. Balance-workbench and perturbation code
 * dispatch on `kind`. A consumer that needs finer dispatch within
 * `kind === 'modifier'` then narrows on `address.walker`.
 */

import type { Modifier, ModifierChain } from '@/core/modifier';

/**
 * Which discovery walker produced a given {@link PickerEntry}. The merge also
 * ranks walkers to deduplicate modifier entries. When several walks reach the
 * same `Modifier` instance, the canonical address wins in this order:
 * `effect-system` > `chain-registry`. Tunable entries don't compete with
 * modifier entries for identity, and skip deduplication entirely.
 */
export type PickerWalker = 'effect-system' | 'chain-registry' | 'tunable';

/**
 * Address of a `ModifierPickerEntry`: a tagged union whose discriminant is
 * `walker`. Consumers narrow on it to dispatch walker-specific UI projections
 * (label, badge, perturbation target, etc.).
 */
export type ModifierPickerAddress =
  | {
      walker: 'effect-system';
      /** Effect-system id (e.g. `'buffs'`, `'constructions-effects'`) */
      effectSystemId: string;
      /** Def id within the effect system */
      defId: string;
      /**
       * Position of this lowered grant in the def's `grants`, each grant's
       * chain array flattened
       */
      grantIndex: number;
    }
  | {
      walker: 'chain-registry';
      /** The {@link ModifierChain.id} */
      chainId: string;
      /** Targets one existing modifier by its position in the chain. */
      kind: 'modifier-index';
      /**
       * Position of this modifier within the chain's `modifiers` array at
       * snapshot time. Perturbation prefers the entry's `modifier` while it
       * is still in the chain, and falls back to this index otherwise: a
       * different engine, or the modifier since replaced. Take a new snapshot
       * when the chain changes.
       */
      modifierIndex: number;
    }
  | {
      walker: 'chain-registry';
      /**
       * Targets the chain as a whole: perturbation appends a scalar
       * wrapper modifier rather than wrapping an existing one. It is the only
       * way to perturb a chain that is auto-registered empty and filled later
       * by purchases or binds.
       */
      chainId: string;
      kind: 'chain-apply';
    };

/**
 * Address of a `TunablePickerEntry`. It holds `registryId` (a string), not
 * a direct tuning-registry reference. Perturbation looks the tuning registry
 * up on whichever engine it's called on, via
 * `engine.tryInject(TuningRegistriesKey)`. So a
 * perturbation found on the live engine and applied to a scratch engine
 * leaves the live tuning registry unchanged. The `chainId` of the
 * `chain-registry` walker's `ModifierPickerAddress` follows the same rule.
 */
export interface TunablePickerAddress {
  walker: 'tunable';
  /** `TuningRegistry.id` — used to look up the tuning registry at perturb time. */
  registryId: string;
  /** Tuning key within the tuning registry. */
  key: string;
}

/**
 * Address of any {@link PickerEntry}: the union of the modifier and tunable
 * address shapes. Narrow on `address.walker` for fine-grained dispatch, or
 * on the entry's `kind` discriminant before reading `address`.
 */
export type PickerAddress = ModifierPickerAddress | TunablePickerAddress;

/**
 * A perturbable modifier the picker found. Covers both discovery walkers:
 * `effect-system` (lowered grants, active or not) and `chain-registry`
 * (auto-registered `ModifierChain` modifiers).
 */
export interface ModifierPickerEntry {
  kind: 'modifier';
  /** Canonical object identity — used by the merger for deduplication. */
  modifier: Modifier;
  /** Owning chain. */
  chain: ModifierChain;
  /**
   * Position of `modifier` within `chain.modifiers` at snapshot time, for
   * display and debugging; perturbation doesn't read it. `-1` when the
   * snapshot's object isn't in the chain: a lowered grant whose effect
   * is inactive, one bound through a factory (each call makes a fresh
   * modifier), or a `chain-apply` entry.
   */
  indexInChain: number;
  /** Stable address for this entry. */
  address: ModifierPickerAddress;
  /** Display-ready label like `hazards.burn[0]`, `spellPotency[2]`. */
  label: string;
}

/**
 * A designer-flagged tunable the picker found. The picker returns one for
 * every key in every {@link TuningRegistry} auto-registered with the
 * engine's `TuningRegistriesKey`. Perturbation pushes overrides on the owning
 * tuning registry rather than changing a chain.
 *
 * `registryId` is a string by design — see {@link TunablePickerAddress}
 * for the scratch-engine safety rationale.
 */
export interface TunablePickerEntry {
  kind: 'tunable';
  /** `TuningRegistry.id` — used to look up the tuning registry at perturb time. */
  registryId: string;
  /** Tuning key within the tuning registry. */
  key: string;
  /** Stable address for this entry. */
  address: TunablePickerAddress;
  /** Display-ready label like `producer-tuning/upgrades/double-gold/effect`. */
  label: string;
}

/**
 * Normalized picker output, which balance workbenches, solvers and
 * sensitivity analysis read. Narrow on `entry.kind` to tell modifier
 * entries from tunable entries.
 */
export type PickerEntry = ModifierPickerEntry | TunablePickerEntry;

/**
 * Result of {@link createPickerSnapshot}. Groups entries by walker, to show
 * as a tree, and also has a flat `all` list for linear access.
 *
 * Modifier entries are deduplicated by `Modifier` object identity across the
 * `effect-system` and `chain-registry` walkers. So one `Modifier` instance
 * appears in exactly one of `effectSystem` / `chains`. Tunable entries are
 * unique by `(registryId, key)` and never collide with modifier entries.
 */
export interface PickerSnapshot {
  /** All entries after deduplication, in walker order. */
  all: readonly PickerEntry[];
  /** Modifier entries whose canonical address walker is `effect-system`. */
  effectSystem: readonly ModifierPickerEntry[];
  /** Modifier entries whose canonical address walker is `chain-registry`. */
  chains: readonly ModifierPickerEntry[];
  /** Tunable entries — one per key per registered tuning registry. */
  tunables: readonly TunablePickerEntry[];
}
