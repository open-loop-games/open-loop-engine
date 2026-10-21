/**
 * Skill — XP, a level and a modifier per skill, in a level-driven or an accumulator mode
 *
 * Two modes:
 * - **Level-driven:** modifier = levelToMultiplier(level). For a skill whose
 *   current level drives the multiplier (e.g. a per-run stat level).
 * - **Accumulator:** modifier = 1 + lifetimeBonus. For a skill whose lifetime
 *   bonus accumulates across runs through retentionFormula.
 *
 * A skill with both parts is two createSkill() calls, one per part. Each
 * returns a `.modifier` for a sequential modifier to compose.
 *
 * Curves are **curve factories**: `(variable: MaybeRef<DecimalSource>) => FormulaSource`.
 * The skill binds the returned Formula to its internal xp / level refs and
 * exposes the built formula (`xpCurve`, `multiplierCurve`, `retentionCurve`).
 * So consumers can invert it ("XP needed for level N") or integrate it through
 * the standard Formula API.
 *
 * Key features:
 * - Persistence: `xp` and `lifetimeBonus` are persistent refs in the skill's persistent context
 * - Modifier: reactive, updates as xp, level or lifetime bonus change
 * - Per-gain ModifierChain: always-created chain (`skill:<id>:gain`) for
 *   cross-cutting XP scaling (global multipliers, zone multipliers)
 * - Optional maxXp: a Computable XP maximum, applied after gainChain
 * - Event subscription: `skill.on('leveledUp', handler)` for handlers added
 *   after creation. The `onLevelUp` option callback subscribes at creation.
 *   Events are emitted only on gameplay XP gain, not on a load or a direct xp write
 * - Reset: a consumer names `skill.xp` in `thingsToReset` or a retention, as needed
 */

import { computed, watch, unref, type ComputedRef, type MaybeRef } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import {
  getCurrentPersistentContext,
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
import { attachPersistentContextReset } from '@/core/resettable';
import { toMaybeRef, type Computable } from '@/core/computed';
import { toFormula } from '@/core/formulas/formulas';
import type { FormulaSource, GenericFormula } from '@/core/formulas/types';

// === TYPES ===

/**
 * Events emitted by a Skill instance.
 */
export interface SkillEvents {
  /** Emitted when the skill's level changes during gameplay XP gain (through `addXp`).
   *  Not emitted on a load's hydration, a reset, or a direct `xp.value` write. */
  leveledUp: (oldLevel: Decimal, newLevel: Decimal) => void;
}

/**
 * Curve factory that binds a Formula to an engine-owned reactive variable.
 *
 * Return a {@link FormulaSource} built through `Formula.variable(x).…` so the
 * skill can both evaluate forward and invert backward. For simple curves,
 * `Formula.exponential` and `Formula.polynomial` build one in a single line.
 */
export type SkillCurve = (variable: MaybeRef<DecimalSource>) => FormulaSource;

/** Shared option fields present in both skill modes */
// TODO(expansion): add `unlockGate?: Gate` (and possibly `prerequisites?: Gate`) when a
// consumer wants declarative skill unlocks instead of consumer-side closures that block them.
// Gate already exists (src/systems/gate.ts); only consumer demand is pending.
export interface SkillOptionsBase {
  id: string;
  /** Curve factory — receives the internal xp ref, returns a FormulaSource. */
  xpToLevel: SkillCurve;
  /** Description shown in modifier breakdowns */
  description?: string;
  /**
   * Optional XP maximum. When present, `addXp` clamps accumulated XP to this
   * value (after the gainChain is applied). Can be a static value, or a ref
   * or getter for a maximum that changes.
   */
  maxXp?: Computable<DecimalSource>;
  /**
   * Option callback called when the level changes during gameplay XP gain
   * (through `addXp`). Not called on a load's hydration, a reset, or a direct
   * `xp.value` write.
   */
  onLevelUp?: (oldLevel: Decimal, newLevel: Decimal) => void;
}

/**
 * Accumulator mode — a lifetime bonus accumulates across runs.
 *
 * Modifier = `1 + lifetimeBonus`. Call `accumulateBonus()` at a run's end to
 * add the retention curve's value. Suits a bonus that grows from each run's level.
 */
export interface AccumulatorSkillOptions extends SkillOptionsBase {
  /**
   * Curve factory for the retention curve — receives the computed level ref,
   * returns a FormulaSource. The curve's value at the current level is added
   * to `lifetimeBonus` each time `accumulateBonus()` is called.
   */
  retentionFormula: SkillCurve;
  levelToMultiplier?: never;
}

/**
 * Level-driven mode — the modifier tracks the level reactively.
 *
 * Modifier = `levelToMultiplier(level)`. No lifetimeBonus or accumulation.
 * Suits a per-run stat level and level multipliers.
 */
export interface LevelDrivenSkillOptions extends SkillOptionsBase {
  /** Curve factory — receives the computed level ref, returns a FormulaSource. */
  levelToMultiplier: SkillCurve;
  retentionFormula?: never;
}

/**
 * Discriminated union of {@link createSkill} option shapes — accumulator
 * (each run's level adds to a lifetime bonus) or level-driven (the level drives
 * a curve). Choose by setting either `retentionFormula` or `levelToMultiplier`.
 */
export type SkillOptions = AccumulatorSkillOptions | LevelDrivenSkillOptions;

/** Fields present on all skills regardless of mode */
export interface SkillBase {
  id: string;
  /** Current XP — name it in a reset's `thingsToReset` or a retention, as needed */
  readonly xp: Persistent<DecimalSource>;
  /** Current level, computed reactively from xp via xpToLevel */
  readonly level: ComputedRef<DecimalSource>;
  /** Multiplicative modifier — formula depends on mode */
  readonly modifier: Modifier;
  /**
   * The built XP→level formula, bound to `xp`. Use `.evaluate(xp)` for a
   * hypothetical value or `.invert(targetLevel)` to compute the XP required
   * to reach a target level (closed-form when the op chain is invertible).
   */
  readonly xpCurve: GenericFormula;
  /**
   * Per-gain modifier chain (`skill:<id>:gain`). Always present — identity
   * when empty. Other modules bind modifiers onto this chain for cross-cutting
   * XP scaling (global XP multipliers, zone-specific multipliers).
   * Registered in the chain registry.
   */
  readonly gainChain: ModifierChain;
  /** Add XP (applies gainChain, then the maxXp maximum when one is set) */
  addXp(amount: DecimalSource): void;

  /** Subscribe to skill events (e.g. `leveledUp`). Returns an unsubscribe function. */
  on: Emittable<SkillEvents>['on'];
}

/** Level-driven skill — modifier = levelToMultiplier(level), no accumulator */
export interface LevelDrivenSkill extends SkillBase {
  readonly lifetimeBonus?: undefined;
  accumulateBonus?: undefined;
  /**
   * The built level→multiplier formula, bound to `level`. Use `.invert(target)`
   * to compute the level required for a target multiplier.
   */
  readonly multiplierCurve: GenericFormula;
  readonly retentionCurve?: undefined;
}

/** Accumulator skill — modifier = 1 + lifetimeBonus */
export interface AccumulatorSkill extends SkillBase {
  /**
   * Lifetime bonus — tagged `lifetime`, so any reset that doesn't name it
   * leaves it alone. To clear it in a hard reset, name it in `thingsToReset` itself.
   */
  readonly lifetimeBonus: Persistent<DecimalSource>;
  /**
   * The built retention formula, bound to `level`. `accumulateBonus()` adds
   * `retentionCurve.evaluate()` to `lifetimeBonus`.
   */
  readonly retentionCurve: GenericFormula;
  readonly multiplierCurve?: undefined;
  /** Add retentionFormula(level) to lifetimeBonus. Call at a run's end. */
  accumulateBonus(): void;
  /**
   * Project how much lifetime bonus a given amount of additional XP would add,
   * without writing state. For comparing candidates by projected lifetime gain,
   * e.g. in a best-of record (`BestOf`).
   *
   * @param additionalXP - The hypothetical XP to add on top of current XP
   * @returns The projected rise in lifetime bonus (never below 0)
   */
  projectGain(additionalXP: DecimalSource): DecimalSource;
}

/** A Skill in either mode — discriminated by the presence of `lifetimeBonus`. */
export type Skill = LevelDrivenSkill | AccumulatorSkill;

// === PRIVATE BUILDERS ===

/**
 * Allocate xp (and lifetimeBonus, accumulator-only) under the skill's
 * persistent context. When called inside an enclosing persistent context (the
 * common case — the category base's `registerOne` opens
 * `${categoryId}/${defId}` around `buildInstance`), the skill's persistent
 * context is prefixed by the enclosing one. So two categories that share
 * skill ids (e.g. a per-run stat category and a lifetime talent category, both
 * keyed by `Dex` / `Str`) don't collide on the per-skill `xp` persistent ref.
 *
 * A standalone `createSkill` call (no enclosing persistent context) uses
 * `skill:${id}`.
 */
function buildSkillState(
  id: string,
  isLevelDriven: boolean,
): {
  contextId: string;
  xp: Persistent<DecimalSource>;
  lifetimeBonus: Persistent<DecimalSource> | null;
} {
  const parent = getCurrentPersistentContext();
  const contextId = parent ? `${parent}/skill:${id}` : `skill:${id}`;
  return withPersistentContext(contextId, () => ({
    contextId,
    xp: persistent<DecimalSource>(0, { id: 'xp' }),
    lifetimeBonus: isLevelDriven
      ? null
      : persistent<DecimalSource>(0, { id: 'lifetimeBonus', lifetime: true }),
  }));
}

/** Bind xpToLevel and the mode-specific curve, returning xpCurve, level, and the assembled modifier. */
function buildSkillCurves(
  options: SkillOptions,
  xp: Persistent<DecimalSource>,
  lifetimeBonus: Persistent<DecimalSource> | null,
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
          multiplier: computed(() => Decimal.add(1, lifetimeBonus!.value)),
          description: description ?? `${options.id} mastery`,
        });
      })();

  return { xpCurve, level, multiplierCurve, retentionCurve, modifier };
}

/** Build the addXp closure (gainChain + maxXp clamp) and the synchronous gameplay-XP guard. */
function buildAddXp(
  xp: Persistent<DecimalSource>,
  gainChain: ModifierChain,
  processedMaxXp: MaybeRef<DecimalSource> | undefined,
): { addXp: (amount: DecimalSource) => void; gainInProgress: { value: boolean } } {
  // Plain object wrapper so buildLevelUpEmitter can read the guard synchronously.
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
 * Curves are curve factories — the skill calls each one with its own
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
 *   and (accumulator mode only) lifetimeBonus + accumulateBonus + projectGain
 *
 * @example
 * // Level-driven (a per-run stat) — power curve via Formula sugar
 * const gen = createSkill({
 *   id: 'combat-gen',
 *   xpToLevel: (xp) => Formula.variable(xp).div(50).sqrt().floor(),
 *   levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
 * })
 *
 * // How much XP to reach level 20?
 * gen.xpCurve.invert(20)
 *
 * // Add a global XP multiplier to the gain chain
 * gen.gainChain.add(createMultiplicativeModifier({ multiplier: 2 }))
 *
 * @example
 * // Accumulator (a lifetime bonus)
 * const mastery = createSkill({
 *   id: 'combat-mastery',
 *   xpToLevel: (xp) => Formula.variable(xp).div(50).sqrt().floor(),
 *   retentionFormula: (level) => Formula.variable(level).mul(0.01),
 * })
 *
 * @example
 * // With an XP maximum and an onLevelUp option callback
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

  const { contextId, xp, lifetimeBonus } = buildSkillState(id, isLevelDriven);

  const { xpCurve, level, multiplierCurve, retentionCurve, modifier } = buildSkillCurves(
    options,
    xp,
    lifetimeBonus,
    isLevelDriven,
  );

  // Prefix the gain chain id with the enclosing persistent context (when
  // present), so two categories sharing a skill id don't collide in the chain
  // registry. Same shape as `buildSkillState` above.
  const gainChainParent = getCurrentPersistentContext();
  const gainChainId = gainChainParent ? `${gainChainParent}/skill:${id}:gain` : `skill:${id}:gain`;
  const gainChain = createModifierChain(gainChainId);
  const processedMaxXp = options.maxXp != null ? toMaybeRef(options.maxXp) : undefined;
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
    return attachPersistentContextReset({ ...base, multiplierCurve: multiplierCurve! }, contextId);
  }

  return attachPersistentContextReset(
    {
      ...base,
      lifetimeBonus: lifetimeBonus!,
      retentionCurve: retentionCurve!,
      accumulateBonus() {
        const gain = retentionCurve!.evaluate();
        lifetimeBonus!.value = Decimal.add(lifetimeBonus!.value, gain);
      },
      projectGain(additionalXP: DecimalSource): DecimalSource {
        const projectedXP = Decimal.add(xp.value, additionalXP);
        const projectedLevel = xpCurve.evaluate(projectedXP);
        const currentRetention = retentionCurve!.evaluate();
        const projectedRetention = retentionCurve!.evaluate(projectedLevel);
        const delta = Decimal.sub(projectedRetention, currentRetention);
        return Decimal.max(delta, 0);
      },
    },
    contextId,
  );
}

// === PUBLIC UTILITIES ===

/**
 * XP the current level starts and ends at, or `null` when `xpCurve` has no
 * inverse to ask.
 *
 * A `.floor()`ed curve is fine here, because these callers only ever ask for
 * integer levels: an outermost `floor`, `ceil` or `trunc` inverts an integer
 * level to an input that evaluates back to it, near the level's edge. A
 * fractional target would come back `outside-image` instead — see
 * `Formula.tryInvert`. Both bounds are used whatever the grade, so an inexact
 * op above the rounding op can still shift them by a level.
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
