/**
 * Skill Category — batch-create Skills from defs
 *
 * Run-based incrementals often have many skills that share a structure:
 * XP accumulation, level calculation, and a modifier output. Actions give
 * XP to skills; skills produce modifiers that feed into modifier chains.
 *
 * `createSkillCategory` captures this shape with a content registry
 * and batch registration. Both level-driven and accumulator modes are
 * supported — each def chooses its own mode.
 *
 * The `addXp` method is the main bridge between action categories and
 * skill categories: `onTick: () => skills.addXp(def.skillId, xpAmount)`.
 *
 * @example
 * ```ts
 * interface TrainingDef { id: string; name: string; xpScale: number }
 *
 * const skills = createSkillCategory<TrainingDef>({
 *   id: 'skills',
 *   mapSkill: (def) => ({
 *     xpToLevel: (xp) => Formula.variable(xp).div(def.xpScale).sqrt().floor(),
 *     levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
 *   }),
 * });
 *
 * skills.register(SKILL_DEFS);
 *
 * // Action → Skill bridge
 * skills.addXp('combat', 10);
 *
 * // Modifier chain integration
 * chain.add(skills.getModifier('combat')!);
 * ```
 *
 * @cluster skill
 */

import { computed } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { createCategoryBase, type CategoryBase, type CategoryEntrySignals } from './category-base';
import { type ContentRegistryView } from './content-registry';
import { Resettable, type ResettableObject } from '@/core/resettable';
import { createSkill, type Skill, type SkillOptions } from './skill';
import { getCurrentEngineCategories } from './engine-categories';
import { type Modifier } from '@/core/modifier';

// === TYPES ===

/** `Omit` applied to each member of a union, so the mode discriminants survive. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Options for {@link createSkillCategory}.
 *
 * @typeParam Def - The def type (must have `id: string`)
 * @typeParam DefState - Def state created beside each Skill.
 *   Use `void` if no def state is needed.
 */
export interface SkillCategoryOptions<Def extends { id: string }, DefState = void> {
  /** Persistent context id. Each def gets a child persistent context `{id}/{def.id}`. */
  id: string;

  /**
   * Map a def to SkillOptions.
   *
   * Called once per def during {@link SkillCategory.register}.
   * The returned options are passed to `createSkill()`.
   *
   * Return exactly one of `levelToMultiplier` (level-driven mode) or
   * `retentionFormula` (accumulator mode) — each def chooses its own.
   *
   * Note: `id` is provided by the category — don't include it in the
   * returned options (it will be overwritten).
   */
  mapSkill: (def: Def) => DistributiveOmit<SkillOptions, 'id'>;

  /**
   * Create the def state beside the Skill.
   *
   * Called inside the def's persistent context, so `persistent()` calls
   * here save under `{categoryId}/{def.id}`.
   *
   * Omit if no def state is needed.
   */
  mapState?: (def: Def, skill: Skill) => DefState;
}

/** A category entry: def, Skill instance, def state and signals */
export interface SkillCategoryEntry<Def extends { id: string }, DefState = void> {
  readonly def: Def;
  readonly skill: Skill;
  readonly state: DefState;
  readonly signals: CategoryEntrySignals;
}

/**
 * A skill category — batch-registered Skills with a shared shape.
 *
 * @typeParam Def - The def type
 * @typeParam DefState - The def state type (void if none)
 */
export interface SkillCategory<
  Def extends { id: string },
  DefState = void,
> extends ResettableObject {
  /** Persistent context id this category was built under. */
  readonly id: string;
  /**
   * The content registry (see {@link ContentRegistryView} for what a patch
   * reaches). Add defs with the category's `register`, which builds each
   * def's instance and def state.
   */
  readonly registry: ContentRegistryView<Def>;

  /**
   * Register defs and create their Skill instances.
   * Can be called more than once (base game, then a mod's content).
   */
  register(defs: Def | readonly Def[]): void;

  /** Get the Skill instance for a def id */
  getSkill(id: string): Skill | undefined;

  /** Get the def state for a def id */
  getState(id: string): DefState | undefined;

  /** Get the def for an id (delegates to registry.get) */
  getDef(id: string): Def | undefined;

  /** Get the category entry (def, skill, def state, signals) */
  getEntry(id: string): SkillCategoryEntry<Def, DefState> | undefined;

  /** All category entries in registration order */
  getAll(): SkillCategoryEntry<Def, DefState>[];

  /**
   * Get the modifier for a skill — shorthand for `getSkill(id)?.modifier`.
   * Main use: adding a skill's modifier to a modifier chain.
   */
  getModifier(id: string): Modifier | undefined;

  /**
   * Add XP to a skill — shorthand for `getSkill(id)?.addXp(amount)`.
   * The action→skill bridge: `onTick: () => skills.addXp(def.skillId, xpAmount)`.
   * No-op if the skill id doesn't exist.
   */
  addXp(id: string, amount: DecimalSource): void;

  /** Number of registered entries */
  readonly size: number;
}

// === FACTORIES ===

/**
 * Create a skill category — batch registration of Skills from defs.
 *
 * @param options - Category id and `mapSkill`
 * @returns A {@link SkillCategory} with registry, lookup, and XP and modifier methods
 *
 * @example
 * ```ts
 * // Mixed modes: some level-driven, some accumulator
 * const skills = createSkillCategory<SkillDef>({
 *   id: 'skills',
 *   mapSkill: (def) => def.mode === 'accumulator'
 *     ? {
 *         xpToLevel: (xp) => Formula.variable(xp).sqrt().floor(),
 *         retentionFormula: (level) => Formula.variable(level).mul(0.01),
 *       }
 *     : {
 *         xpToLevel: (xp) => Formula.variable(xp).sqrt().floor(),
 *         levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
 *       },
 * });
 *
 * skills.register(SKILL_DEFS);
 * skills.addXp('combat', 100);
 * chain.add(skills.getModifier('combat')!);
 * ```
 */
export function createSkillCategory<Def extends { id: string }, DefState = void>(
  options: SkillCategoryOptions<Def, DefState>,
): SkillCategory<Def, DefState> {
  const { id, mapSkill, mapState } = options;

  const base: CategoryBase<Def, Skill, DefState> = createCategoryBase({
    id,
    buildInstance: (def) => {
      return createSkill({ ...mapSkill(def), id: def.id });
    },
    buildState: mapState,
    buildSignals: (_def, skill) => ({
      active: computed(() => Decimal.fromValue(skill.level.value).gt(0)),
      count: skill.level,
    }),
  });

  const category: SkillCategory<Def, DefState> = {
    id: base.id,
    registry: base.registry,
    register: base.register,
    getDef: base.getDef,

    getSkill(id: string): Skill | undefined {
      return base.getEntry(id)?.instance;
    },

    getState(id: string): DefState | undefined {
      return base.getEntry(id)?.state;
    },

    getEntry(id: string): SkillCategoryEntry<Def, DefState> | undefined {
      const entry = base.getEntry(id);
      if (!entry) return undefined;
      return {
        def: entry.def,
        skill: entry.instance,
        state: entry.state,
        signals: entry.signals!,
      };
    },

    getAll(): SkillCategoryEntry<Def, DefState>[] {
      return base.getAll().map((e) => ({
        def: e.def,
        skill: e.instance,
        state: e.state,
        signals: e.signals!,
      }));
    },

    getModifier(id: string): Modifier | undefined {
      return base.getEntry(id)?.instance.modifier;
    },

    addXp(id: string, amount: DecimalSource): void {
      base.getEntry(id)?.instance.addXp(amount);
    },

    get size(): number {
      return base.size;
    },

    [Resettable]: base[Resettable],
  };

  const ec = getCurrentEngineCategories();
  if (ec) (ec.skills ??= []).push(category);

  return category;
}
