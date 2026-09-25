/**
 * Skill helper for dual-tier loop incremental skills
 *
 * Engine primitive for the Skill Systems pattern — validated at moderate
 * prevalence across the incremental-games corpus.
 *
 * Two modes for the two universal patterns:
 * - **Level-driven:** modifier = levelToMultiplier(level). For tiers where the
 *   current level directly drives the multiplier (Increlution gen/instinct,
 *   Progress Knight level bonuses).
 * - **Accumulator:** modifier = 1 + permanentBonus. For tiers where a bonus
 *   accumulates across loops via retentionFormula (Idle Loops soulstones,
 *   Groundhog Life snapshots).
 *
 * Dual-tier skills compose as two createSkill() calls — one per tier — each
 * returning a .modifier that plugs into a sequential chain.
 *
 * Curves are **Formula factories**: `(variable: MaybeRef<DecimalSource>) => FormulaSource`.
 * The skill binds the returned Formula to its internal xp / level refs and
 * exposes the built formula (`xpCurve`, `multiplierCurve`, `retentionCurve`)
 * so consumers can invert ("XP needed for level N") or integrate via the
 * standard Formula API.
 *
 * Key features:
 * - Persistence: xp + permanentBonus auto-collected via persistent context
 * - Modifier: reactive, updates as xp/level/bonus change
 * - Per-gain ModifierChain: always-created chain (`skill:<id>:gain`) for
 *   cross-cutting XP scaling (global boosts, zone multipliers)
 * - Optional maxXp cap: Computable, applied after gainChain
 * - Event subscription: `skill.on('leveledUp', handler)` for post-creation
 *   listeners. Optional `onLevelUp` creation-time sugar auto-subscribes.
 *   Events fire only on gameplay XP gain, not on save-load or direct xp mutation
 * - Reset integration: consumer includes skill.xp in thingsToReset or
 *   RetentionPolicy as needed
 */

import { computed, watch, unref, type ComputedRef, type MaybeRef } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import {
  getCurrentContext,
  persistent,
  type Persistent,
  withPersistentContext,
} from '@/core/persistence';
import {
  createMultiplicativeModifier,
  createModifierChain,
  type Modifier,
  type ModifierChain,
} from '@/core/modifier';
import { createEmitHandle, type Emittable } from '@/core/events';
import { processGetter, type Computable } from '@/core/computed';
import Formula from '@/core/formulas/formulas';
import type { FormulaSource, GenericFormula } from '@/core/formulas/types';

// === TYPES ===

/**
 * Events emitted by a Skill instance.
 */
export interface SkillEvents {
  /** Fired when the skill's level increases during gameplay XP gain (via `addXp`).
   *  Does NOT fire on save-load rehydration, reset, or direct `xp.value` mutation. */
  leveledUp: (oldLevel: Decimal, newLevel: Decimal) => void;
}

/**
 * Factory that binds a Formula to an engine-owned reactive variable.
 *
 * Return a {@link FormulaSource} built via `Formula.variable(x).…` so the
 * skill can both evaluate forward and invert backward. For simple curves
 * the `Formula.exponential` / `Formula.polynomial` helpers are the one-liner
 * path.
 */
export type SkillCurve = (variable: MaybeRef<DecimalSource>) => FormulaSource;

/** Shared option fields present in both skill modes */
// TODO(expansion): add `unlockGate?: Gate` (and possibly `prerequisites?: Gate`) when a
// consumer wants declarative skill unlocks instead of consumer-side gating closures.
// Gate already exists (src/systems/gate.ts); only consumer demand is pending.
export interface SkillOptionsBase {
  id: string;
  /** Formula factory — receives the internal xp ref, returns a FormulaSource. */
  xpToLevel: SkillCurve;
  /** Description shown in modifier breakdowns */
  description?: string;
  /**
   * Optional XP cap. When present, `addXp` clamps accumulated XP to this value
   * (after the gainChain is applied). Can be a static value or reactive
   * (ref / getter) for scaling caps.
   */
  maxXp?: Computable<DecimalSource>;
  /**
   * Called when level transitions during gameplay XP gain (via `addXp`).
   * Does NOT fire on save-load rehydration, reset, or direct `xp.value` mutation.
   */
  onLevelUp?: (oldLevel: Decimal, newLevel: Decimal) => void;
}

/**
 * Accumulator mode — permanent bonus accumulates across loops.
 *
 * Modifier = `1 + permanentBonus`. Call `accumulateBonus()` at loop end to
 * apply the retention formula. Good for Idle Loops soulstones, Groundhog
 * Life snapshots.
 */
export interface AccumulatorSkillOptions extends SkillOptionsBase {
  /**
   * Formula factory for the retention curve — receives the computed level ref,
   * returns a FormulaSource. The curve's value at the current level is added
   * to `permanentBonus` each time `accumulateBonus()` is called.
   */
  retentionFormula: SkillCurve;
  levelToMultiplier?: never;
}

/**
 * Level-driven mode — modifier tracks level reactively.
 *
 * Modifier = `levelToMultiplier(level)`. No permanentBonus or accumulation.
 * Good for Increlution gen/instinct tiers, Progress Knight level multipliers.
 */
export interface LevelDrivenSkillOptions extends SkillOptionsBase {
  /** Formula factory — receives the computed level ref, returns a FormulaSource. */
  levelToMultiplier: SkillCurve;
  retentionFormula?: never;
}

/**
 * Discriminated union of {@link createSkill} option shapes — accumulator
 * (XP banks for retention) vs level-driven (level multiplies a curve). Choose
 * by setting either `retentionFormula` or `levelToMultiplier`.
 */
export type SkillOptions = AccumulatorSkillOptions | LevelDrivenSkillOptions;

/** Fields present on all skills regardless of mode */
export interface SkillBase {
  id: string;
  /** Current XP — include in loop's thingsToReset or RetentionPolicy as needed */
  readonly xp: Persistent<DecimalSource>;
  /** Current level, computed reactively from xp via xpToLevel */
  readonly level: ComputedRef<DecimalSource>;
  /** Multiplicative modifier — formula depends on mode */
  readonly modifier: Modifier;
  /**
   * The built XP→level formula, bound to `xp`. Use `.evaluate(xp)` for a
   * hypothetical value or `.invert(targetLevel)` to compute the XP required
   * to reach a target level (closed-form when the chain is invertible).
   */
  readonly xpCurve: GenericFormula;
  /**
   * Per-gain modifier chain (`skill:<id>:gain`). Always present — identity
   * when empty. Other modules bind modifiers onto this chain for cross-cutting
   * XP scaling (global XP boosts, zone-specific multipliers).
   * Auto-registered in the ChainRegistry.
   */
  readonly gainChain: ModifierChain;
  /** Add XP to the pool (applies gainChain, then maxXp cap if configured) */
  addXp(amount: DecimalSource): void;

  /** Subscribe to skill events (e.g. `leveledUp`). Returns an unsubscribe function. */
  on: Emittable<SkillEvents>['on'];
}

/** Level-driven skill — modifier = levelToMultiplier(level), no accumulator */
export interface LevelDrivenSkill extends SkillBase {
  readonly permanentBonus?: undefined;
  accumulateBonus?: undefined;
  /**
   * The built level→multiplier formula, bound to `level`. Use `.invert(target)`
   * to compute the level required for a target multiplier.
   */
  readonly multiplierCurve: GenericFormula;
  readonly retentionCurve?: undefined;
}

/** Accumulator skill — modifier = 1 + permanentBonus */
export interface AccumulatorSkill extends SkillBase {
  /**
   * Permanent bonus — tagged `lifetime`, so module-scoped resets
   * (`resetModules`) skip it. To wipe it in a hard reset, pass it through
   * `thingsToReset` explicitly.
   */
  readonly permanentBonus: Persistent<DecimalSource>;
  /**
   * The built retention formula, bound to `level`. `accumulateBonus()` adds
   * `retentionCurve.evaluate()` to `permanentBonus`.
   */
  readonly retentionCurve: GenericFormula;
  readonly multiplierCurve?: undefined;
  /** Add retentionFormula(level) to permanentBonus. Call at loop end. */
  accumulateBonus(): void;
  /**
   * Project how much permanent bonus a given amount of additional XP would produce,
   * without mutating state. Used by optimization systems (e.g. BestOf route tracker)
   * to compare strategies by projected permanent gain.
   *
   * @param additionalXP - The hypothetical XP to add on top of current XP
   * @returns The projected permanent bonus delta (always >= 0)
   */
  projectGain(additionalXP: DecimalSource): DecimalSource;
}

/** A Skill in either mode — discriminated by the presence of `permanentBonus`. */
export type Skill = LevelDrivenSkill | AccumulatorSkill;

// === PRIVATE BUILDERS ===

/** Coerce a FormulaSource to a Formula — wrap raw values in `Formula.constant`. */
function toFormula(source: FormulaSource): GenericFormula {
  return source instanceof Formula ? source : Formula.constant(source);
}

/**
 * Allocate xp (and permanentBonus, accumulator-only) under the skill's
 * persistence context. When invoked inside an enclosing context (the
 * common case — `createSkillCategory`'s `registerOne` opens
 * `${categoryId}/${defId}` around `buildInstance`), the skill context
 * is prefixed by the enclosing one so two categories that share skill
 * ids (e.g. looper's stat-level + talent both keyed by `Dex` / `Str`)
 * don't collide on the per-skill `xp` persistent ref.
 *
 * Standalone `createSkill` calls (no enclosing context) keep the
 * legacy `skill:${id}` context unchanged.
 */
function buildSkillState(
  id: string,
  isLevelDriven: boolean,
): { xp: Persistent<DecimalSource>; permanentBonus: Persistent<DecimalSource> | null } {
  const parent = getCurrentContext();
  const ctxId = parent ? `${parent}/skill:${id}` : `skill:${id}`;
  return withPersistentContext(ctxId, () => ({
    xp: persistent<DecimalSource>(0, { name: 'xp' }),
    permanentBonus: isLevelDriven
      ? null
      : persistent<DecimalSource>(0, { name: 'permanentBonus', lifetime: true }),
  }));
}

/** Bind xpToLevel and the mode-specific curve, returning xpCurve, level, and the assembled modifier. */
function buildSkillCurves(
  options: SkillOptions,
  xp: Persistent<DecimalSource>,
  permanentBonus: Persistent<DecimalSource> | null,
  isLevelDriven: boolean,
): {
  xpCurve: GenericFormula;
  level: ComputedRef<DecimalSource>;
  multiplierCurve: GenericFormula | undefined;
  retentionCurve: GenericFormula | undefined;
  modifier: Modifier;
} {
  const xpCurve = toFormula(options.xpToLevel(xp));
  const level = computed(() => new Decimal(xpCurve.evaluate()));
  const description = options.description;

  let multiplierCurve: GenericFormula | undefined;
  let retentionCurve: GenericFormula | undefined;

  const modifier = isLevelDriven
    ? (() => {
        multiplierCurve = toFormula(options.levelToMultiplier!(level));
        return createMultiplicativeModifier({
          multiplier: computed(() => new Decimal(multiplierCurve!.evaluate())),
          description: description ?? `${options.id} level`,
        });
      })()
    : (() => {
        retentionCurve = toFormula((options as AccumulatorSkillOptions).retentionFormula(level));
        return createMultiplicativeModifier({
          multiplier: computed(() => Decimal.add(1, permanentBonus!.value)),
          description: description ?? `${options.id} mastery`,
        });
      })();

  return { xpCurve, level, multiplierCurve, retentionCurve, modifier };
}

/** Build the addXp closure (gainChain + maxXp cap) and the synchronous gameplay-XP guard flag. */
function buildAddXp(
  xp: Persistent<DecimalSource>,
  gainChain: ModifierChain,
  processedMaxXp: MaybeRef<DecimalSource> | undefined,
): { addXp: (amount: DecimalSource) => void; gainInProgress: { value: boolean } } {
  // Plain object wrapper so buildOnLevelUp can read the flag synchronously.
  // Not a Vue ref — no reactivity needed, just a synchronous guard.
  const gainInProgress = { value: false };

  function addXp(amount: DecimalSource) {
    gainInProgress.value = true;
    try {
      const gained = gainChain.apply(amount);
      const newXp = Decimal.add(xp.value, gained);
      const cap = processedMaxXp != null ? unref(processedMaxXp) : undefined;
      xp.value = cap != null ? Decimal.min(newXp, cap) : newXp;
    } finally {
      gainInProgress.value = false;
    }
  }

  return { addXp, gainInProgress };
}

/** Wire a sync watcher on `level` that emits `leveledUp` only during gameplay XP gain. */
function buildLevelUpEmitter(
  level: ComputedRef<DecimalSource>,
  gainInProgress: { value: boolean },
  handle: ReturnType<typeof createEmitHandle<SkillEvents>>,
): void {
  watch(
    level,
    (newLevel, oldLevel) => {
      if (!gainInProgress.value) return;
      if (Decimal.eq(oldLevel, newLevel)) return;
      handle.emit('leveledUp', new Decimal(oldLevel), new Decimal(newLevel));
    },
    { flush: 'sync' },
  );
}

// === FACTORIES ===

/**
 * Create a skill with XP tracking, computed level, and a reactive modifier.
 *
 * Curves are Formula factories — the skill calls each factory with its own
 * internal ref (xp or level) and stores the returned Formula. Consumers can
 * evaluate, invert, or integrate these curves via the exposed `xpCurve`,
 * `multiplierCurve`, or `retentionCurve` properties.
 *
 * Every skill has a per-gain {@link ModifierChain} (`skill:<id>:gain`) that
 * transforms raw XP before accumulation. The chain is identity when empty.
 * Other modules bind modifiers onto it for cross-cutting XP scaling.
 *
 * @param options - Provide `levelToMultiplier` for level-driven mode or
 *   `retentionFormula` for accumulator mode (mutually exclusive).
 * @returns Skill with xp, level, modifier, gainChain, addXp, exposed curves,
 *   and (accumulator mode only) permanentBonus + accumulateBonus + projectGain
 *
 * @example
 * // Level-driven (Increlution gen tier) — power curve via Formula sugar
 * const gen = createSkill({
 *   id: 'combat-gen',
 *   xpToLevel: (xp) => Formula.variable(xp).div(50).sqrt().floor(),
 *   levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
 * })
 *
 * // How much XP to reach level 20?
 * gen.xpCurve.invert(20)
 *
 * // Bind a global XP boost onto the gain chain
 * gen.gainChain.add(createMultiplicativeModifier({ multiplier: 2 }))
 *
 * @example
 * // Accumulator (Idle Loops soulstones)
 * const mastery = createSkill({
 *   id: 'combat-mastery',
 *   xpToLevel: (xp) => Formula.variable(xp).div(50).sqrt().floor(),
 *   retentionFormula: (level) => Formula.variable(level).mul(0.01),
 * })
 *
 * @example
 * // With maxXp cap and onLevelUp callback
 * const capped = createSkill({
 *   id: 'combat-capped',
 *   xpToLevel: (xp) => Formula.variable(xp).div(50).sqrt().floor(),
 *   levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
 *   maxXp: 505_000,
 *   onLevelUp: (oldLevel, newLevel) => console.log(`Leveled up: ${oldLevel} → ${newLevel}`),
 * })
 */
export function createSkill(options: AccumulatorSkillOptions): AccumulatorSkill;
export function createSkill(options: LevelDrivenSkillOptions): LevelDrivenSkill;
export function createSkill(options: SkillOptions): Skill;
export function createSkill(options: SkillOptions): Skill {
  const { id } = options;
  const isLevelDriven = 'levelToMultiplier' in options && options.levelToMultiplier != null;

  const { xp, permanentBonus } = buildSkillState(id, isLevelDriven);

  const { xpCurve, level, multiplierCurve, retentionCurve, modifier } = buildSkillCurves(
    options,
    xp,
    permanentBonus,
    isLevelDriven,
  );

  // Namespace the gain chain id by the enclosing context (when present)
  // so two categories sharing a skill id don't collide on the ChainRegistry.
  // Same posture as `buildSkillState` above.
  const gainChainParent = getCurrentContext();
  const gainChainId = gainChainParent ? `${gainChainParent}/skill:${id}:gain` : `skill:${id}:gain`;
  const gainChain = createModifierChain(gainChainId);
  const processedMaxXp = options.maxXp != null ? processGetter(options.maxXp) : undefined;
  const { addXp, gainInProgress } = buildAddXp(xp, gainChain, processedMaxXp);
  const handle = createEmitHandle<SkillEvents>();
  buildLevelUpEmitter(level, gainInProgress, handle);
  if (options.onLevelUp) {
    handle.on('leveledUp', options.onLevelUp);
  }

  const base: SkillBase = {
    id,
    xp,
    level,
    modifier,
    xpCurve,
    gainChain,
    addXp,
    on: handle.on,
  };

  if (isLevelDriven) {
    return {
      ...base,
      multiplierCurve: multiplierCurve!,
    };
  }

  return {
    ...base,
    permanentBonus: permanentBonus!,
    retentionCurve: retentionCurve!,
    accumulateBonus() {
      const gain = retentionCurve!.evaluate();
      permanentBonus!.value = Decimal.add(permanentBonus!.value, gain);
    },
    projectGain(additionalXP: DecimalSource): DecimalSource {
      const projectedXP = Decimal.add(xp.value, additionalXP);
      const projectedLevel = xpCurve.evaluate(projectedXP);
      const currentRetention = retentionCurve!.evaluate();
      const projectedRetention = retentionCurve!.evaluate(projectedLevel);
      const delta = Decimal.sub(projectedRetention, currentRetention);
      return Decimal.max(delta, 0);
    },
  };
}

// === PUBLIC UTILITIES ===

/**
 * XP the current level starts and ends at, or `null` when `xpCurve` has no
 * inverse to ask.
 *
 * A `.floor()`ed curve is fine here, and precisely because these callers only
 * ever ask for integer levels: an interior rounding op inverts to the exact
 * breakpoint below the target, which for an integer target *is* the pre-image.
 * A fractional target would come back `outside-image` instead — see
 * `Formula.tryInvert`, which is what makes the distinction visible rather than
 * leaving it to a passthrough that answers either way.
 */
function getLevelXPBounds(
  skill: Skill,
  currentLevel: Decimal,
): { from: Decimal; to: Decimal } | null {
  const from = skill.xpCurve.tryInvert(currentLevel);
  const to = skill.xpCurve.tryInvert(currentLevel.add(1));
  if (from.value == null || to.value == null) return null;
  return { from: new Decimal(from.value), to: new Decimal(to.value) };
}

/**
 * Progress fraction (0–1) within the current level, for progress bar display.
 *
 * Computes `(currentXP - xpForCurrentLevel) / (xpForNextLevel - xpForCurrentLevel)`.
 * Requires an invertible `xpToLevel` curve; returns 1 (a full bar) when the
 * curve can't be inverted or the level spans no XP.
 */
export function getSkillProgress(skill: Skill): number {
  const currentLevel = new Decimal(skill.level.value);
  const currentXp = new Decimal(skill.xp.value);
  const bounds = getLevelXPBounds(skill, currentLevel);
  if (bounds == null) return 1;
  const span = new Decimal(Decimal.sub(bounds.to, bounds.from));
  if (Decimal.lte(span, 0)) return 1;
  return new Decimal(Decimal.div(Decimal.sub(currentXp, bounds.from), span)).clamp(0, 1).toNumber();
}

/**
 * XP window for "N / M" display — how much XP into the current level and
 * how much the current level spans.
 *
 * Requires an invertible `xpToLevel` curve; reports a zero window when the
 * curve can't be inverted, rather than a window measured from a failed inverse.
 */
export function getSkillXPWindow(skill: Skill): { current: Decimal; needed: Decimal } {
  const currentLevel = new Decimal(skill.level.value);
  const currentXp = new Decimal(skill.xp.value);
  const bounds = getLevelXPBounds(skill, currentLevel);
  if (bounds == null) return { current: new Decimal(0), needed: new Decimal(0) };
  return {
    current: new Decimal(Decimal.sub(currentXp, bounds.from)),
    needed: new Decimal(Decimal.sub(bounds.to, bounds.from)),
  };
}
