/**
 * Picker types — `PickerWalker`, `PickerAddress`, `PickerEntry`,
 * `PickerSnapshot`.
 *
 * Picker walks two layers of intent:
 *
 * - **Structural identity** — `Modifier`s in auto-registered chains and
 *   effect-system bindings. Discoverable by enumeration of the engine's
 *   ambient registries (`ChainRegistryKey`, `EffectSystemRegistryKey`).
 *   Perturbation wraps the modifier in its chain position, or, for
 *   an effect-system binding, the binding in every activation.
 *
 * - **Addressability identity** — `tunable()` values registered into a
 *   `TuningRegistry`. The designer's opt-in declaration that a value
 *   belongs in the externally-controlled tuning surface (see
 *   `createTuningRegistry` / `tunable` for the principle).
 *   Perturbation pushes a scope on the owning registry.
 *
 * `PickerEntry` is a discriminated union by top-level `kind` so the two
 * layers narrow cleanly. Workbench and perturbation code dispatch on
 * `kind`; consumers that need fine-grained source dispatch within
 * `kind === 'modifier'` pattern-match on `address.walker` afterward.
 */

import type { Modifier, ModifierChain } from '@/core/modifier';

/**
 * Which discovery walker produced a given {@link PickerEntry}. Also used by
 * the merger as the priority order for deduplication of modifier entries:
 * when the same `Modifier` instance is reachable via multiple walks, the
 * canonical address wins in this order — `effect-system` > `chain-registry`.
 * Tunable entries don't compete with modifier entries for identity and
 * skip dedup entirely.
 */
export type PickerWalker = 'effect-system' | 'chain-registry' | 'tunable';

/**
 * Address of a `ModifierPickerEntry`. Discriminated union by `source` —
 * consumers pattern-match to dispatch source-specific UI projections
 * (label, badge, perturbation target, etc.).
 */
export type ModifierPickerAddress =
  | {
      walker: 'effect-system';
      /** Effect-system id (e.g. `'buffs'`, `'constructions-effects'`) */
      effectSystemId: string;
      /** Def id within the effect system */
      defId: string;
      /** Position of this binding in the def's `modifiers`, each grant's chain array flattened */
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
       * is still in the chain and falls back to this index otherwise (a
       * different engine, or the modifier since swapped out) — refresh the
       * snapshot when the chain changes.
       */
      modifierIndex: number;
    }
  | {
      walker: 'chain-registry';
      /**
       * Targets the chain as a whole — perturbation appends a scalar
       * wrapper modifier rather than wrapping an existing one. The only
       * way to perturb chains that are auto-registered empty and populated
       * later via purchases/binds.
       */
      chainId: string;
      kind: 'chain-apply';
    };

/**
 * Address of a `TunablePickerEntry`. Carries `registryId` (string) rather
 * than a direct registry reference — perturbation resolves the registry
 * against whichever engine it's called on via
 * `engine.tryInject(TuningRegistriesKey)`, so a perturbation discovered against
 * the live engine and applied to a scratch sensitivity-fork doesn't stomp
 * the live registry. Mirrors the `chainId` precedent in
 * `ModifierPickerAddress` (chain-registry source).
 */
export interface TunablePickerAddress {
  walker: 'tunable';
  /** `TuningRegistry.name` — used to look up the registry at perturb time. */
  registryId: string;
  /** Key within the registry. */
  key: string;
}

/**
 * Address of any {@link PickerEntry}. Union of the modifier-side and
 * tunable-side address shapes — pattern-match on `address.walker` for
 * fine-grained dispatch, or narrow on the entry's `kind` discriminator
 * before reaching `address`.
 */
export type PickerAddress = ModifierPickerAddress | TunablePickerAddress;

/**
 * A perturbable modifier surface discovered by the picker. Covers both
 * `effect-system` (effect-system bindings, active or not) and `chain-registry`
 * (auto-registered `ModifierChain` modifiers) discovery sources.
 */
export interface ModifierPickerEntry {
  kind: 'modifier';
  /** Canonical object identity — used by the merger for deduplication. */
  modifier: Modifier;
  /** Owning chain. */
  chain: ModifierChain;
  /**
   * Position of `modifier` within `chain.modifiers` at snapshot time, for
   * display and diagnostics; perturbation doesn't read it. `-1` when the
   * snapshot's object isn't in the chain: an effect-system binding whose effect
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
 * A designer-flagged tunable value discovered by the picker. Emitted for
 * every key in every {@link TuningRegistry} auto-registered with the
 * engine's `TuningRegistriesKey`. Perturbation pushes a scope on the owning
 * registry rather than mutating a chain.
 *
 * `registryId` is a string by design — see {@link TunablePickerAddress}
 * for the scratch-engine safety rationale.
 */
export interface TunablePickerEntry {
  kind: 'tunable';
  /** `TuningRegistry.name` — used to look up the registry at perturb time. */
  registryId: string;
  /** Key within the registry. */
  key: string;
  /** Stable address for this entry. */
  address: TunablePickerAddress;
  /** Display-ready label like `producer-tuning/upgrades/double-gold/effect`. */
  label: string;
}

/**
 * Normalized picker output. Workbench, solver, and sensitivity-analysis
 * tooling consume this; pattern-match on `entry.kind` to discriminate
 * between modifier and tunable variants.
 */
export type PickerEntry = ModifierPickerEntry | TunablePickerEntry;

/**
 * Result of {@link createPickerSnapshot}. Groups entries by discovery layer
 * for tree rendering, and also exposes a flat `all` list for linear access.
 *
 * Modifier entries are deduplicated by `Modifier` object identity across
 * `effect-system` and `chain-registry` walkers — a single `Modifier` instance
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
