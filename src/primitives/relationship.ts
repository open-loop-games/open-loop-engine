/**
 * Relationship — typed per-actor / per-faction state with five variant shapes (scalar, faction, tiered, vector, flag).
 *
 * The variant set is `kind`-discriminated: a single `RelationshipDef` union
 * covers Tuxemon-style scalar bonds, Daggerfall faction trees, ranked guild
 * ladders, CDDA multi-axis opinions, and Exult-style flag bags. Each variant
 * carries its own policy options (decay, derivation, propagation matrix,
 * tier-transition gates) without forcing the others to model what they don't
 * need. The matching runtime instances live in `systems/relationship.ts`.
 */

import type { ICondition } from './types';

/** Common identity for every relationship def. */
export interface RelationshipDefBase {
  id: string;
  /** Display name for UI / debug. Defaults to id. */
  displayName?: string;
}

/**
 * V1: scalar per-entity (Tuxemon bond, Level13 trust). One number per
 * relationship-holder. Optionally derived-on-read from input fields to
 * sidestep the affinity-grinding failure mode (Level13 takes
 * `Math.max(dialogueValue, explorationValue, fightValue)` over persistent
 * play-stat counters with per-axis denominators).
 */
export interface ScalarRelationshipDef extends RelationshipDefBase {
  kind: 'scalar';
  /** Known actor ids — pre-creates persistent refs for save round-trip. */
  actors: readonly string[];
  /** Initial value when no save data present. Default 0. */
  initial?: number;
  /** Inclusive lower bound. Default -Infinity. */
  min?: number;
  /** Inclusive upper bound. Default Infinity. */
  max?: number;
  /** Optional time-decay rate (per second toward neutral = 0). Default 0 (no decay). */
  decayPerSecond?: number;
  /**
   * When present, stored fields are inputs and reads call `derive(inputs)`.
   * Use for trust-from-play-stats shapes (Level13's `max` over per-stat
   * counters with per-axis denominators sidesteps farmable affinity).
   */
  derive?: (inputs: Record<string, number>) => number;
}

/**
 * V2: scalar per-faction with attitude-matrix propagation (Endless Sky,
 * Daggerfall faction tree). Asymmetric attitude: a write of +N to faction A
 * propagates `N * attitude[A][B]` to every faction B above `weightFloor`.
 */
export interface FactionRelationshipDef extends RelationshipDefBase {
  kind: 'faction';
  factions: readonly string[];
  initial?: number;
  min?: number;
  max?: number;
  /**
   * Attitude matrix. `attitude[from][to] = weight in [-1, 1]`. Missing entries
   * are 0 (no propagation); the diagonal defaults to 1 (the writing faction
   * itself receives the full delta).
   */
  attitude?: Record<string, Record<string, number>>;
  /** Below this absolute weight, propagation is suppressed. Default 0.05 (Endless Sky's value). */
  weightFloor?: number;
  /**
   * Permanent/temporary split — when true, the variant maintains a separate
   * "temporary" layer per faction that's cleared on `dailyReset()` calls.
   * Models Endless Sky's `provoked` / `bribed` / `fined` sets.
   */
  temporaryLayer?: boolean;
  decayPerSecond?: number;
}

/**
 * V3: ordered tier ladder (Daggerfall guild rank, OpenMW faction rank,
 * molcremental NPC trust). Discrete 0..N progression; per-transition
 * advancement gates let the consumer encode time-based, skill-based, or
 * discovery-based prerequisites as an {@link ICondition}.
 */
export interface TieredRelationshipDef extends RelationshipDefBase {
  kind: 'tiered';
  actors: readonly string[];
  /** Ordered tier names; index 0 = lowest. */
  tiers: readonly string[];
  /** Initial tier index. Default 0. */
  initial?: number;
  /**
   * Per-transition advancement gate. `gates[from]` must evaluate true (or be
   * absent) to advance from index `from` to `from + 1`. Game-side modules
   * supply these as ICondition references to module state.
   */
  gates?: ReadonlyArray<ICondition | undefined>;
  /** When true, advancement is checked on every tick rather than only on explicit `tryAdvance()`. */
  autoAdvance?: boolean;
}

/**
 * V4: multi-dimensional vector (CDDA opinion:
 * `{trust, fear, value, anger, owed, sold}`). N independent scalars per
 * actor; each dimension drives a different output surface asymmetrically.
 * The value is in the asymmetry — don't fold dimensions that share an
 * output back into a scalar.
 */
export interface VectorRelationshipDef extends RelationshipDefBase {
  kind: 'vector';
  actors: readonly string[];
  /** Dimension names — each becomes a separate persistent scalar per actor. */
  dimensions: readonly string[];
  /** Per-dimension policy overrides. Defaults: initial = 0, no clamp, no decay. */
  dimensionConfig?: Partial<
    Record<
      string,
      {
        initial?: number;
        min?: number;
        max?: number;
        decayPerSecond?: number;
      }
    >
  >;
}

/**
 * V5: boolean flag bag (Exult `Obj_flags` + global `gflags`). No scalars;
 * per-actor named flags. Use when the design encodes social state as
 * authored events (`MET_GORDON`, `HIRED_BY_GORDON`) rather than aggregate
 * values. Does not scale past a few hundred named events without a scripted
 * DSL alongside.
 */
export interface FlagRelationshipDef extends RelationshipDefBase {
  kind: 'flag';
  actors: readonly string[];
  /**
   * Known flag names per actor. Unknown flag names are still settable but
   * won't preallocate save slots — declare them here for save-version stability.
   */
  flags: readonly string[];
}

// V6 (Continuous-drives, openc2e biochemistry) is intentionally not typed here.
// TODO(expansion): add ChemicalRelationshipDef when a second consumer needs it.
// Single-game prevalence (openc2e is the only known case); the 5 variants here
// cover the rest of the validated shapes from the Phase 1 study.

/** Discriminated union — every registered relationship def is one of these. */
export type RelationshipDef =
  | ScalarRelationshipDef
  | FactionRelationshipDef
  | TieredRelationshipDef
  | VectorRelationshipDef
  | FlagRelationshipDef;
