/**
 * Skill Category — batch-create Skills from content definitions
 *
 * Loop incrementals typically have 5-25 skills sharing a common structure:
 * XP accumulation, level calculation, and a modifier output. Actions grant
 * XP to skills; skills produce modifiers that feed into modifier chains.
 *
 * `createSkillCategory` captures this pattern with a content registry
 * and batch registration. Both level-driven and accumulator modes are
 * supported — each definition independently chooses its mode.
 *
 * The `addXp` helper is the primary bridge between action categories and
 * skill categories: `onTick: () => skills.addXp(def.skillId, xpAmount)`.
 *
 * @example
 * ```ts
 * interface TrainingDef { id: string; name: string; xpScale: number }
 *
 * const skills = createSkillCategory<TrainingDef>({
 *   id: 'skills',
 *   mapSkill: (def) => ({
 *     xpToLevel: (xp) => Decimal.floor(Decimal.sqrt(Decimal.div(xp, def.xpScale))),
 *     levelToMultiplier: (level) => Decimal.pow(1.05, level),
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
import { isType } from '@/core/feature';
import { createCategoryBase, type CategoryBase, type CategoryEntrySignals } from './category-base';
import { type ContentRegistry } from './content-registry';
import { Resettable, type ResettableObject } from './resettable';
import { createSkill, type Skill, type SkillOptions } from './skill';
import { getCurrentEngineCategories } from './engine-categories';
import { type Modifier } from '@/core/modifier';

// === TYPES ===

/** Symbol identifying SkillCategory features */
export const SkillCategoryType = Symbol('SkillCategory');

/**
 * Options for {@link createSkillCategory}.
 *
 * @typeParam Def - The content definition type (must have `id: string`)
 * @typeParam State - Per-instance state created alongside each Skill.
 *   Use `void` if no extra state is needed.
 */
export interface SkillCategoryOptions<Def extends { id: string }, State = void> {
  /** Persistence context name. Each definition gets a sub-context `{id}/{def.id}`. */
  id: string;

  /**
   * Map a content definition to SkillOptions.
   *
   * Called once per definition during {@link SkillCategory.register}.
   * The returned options are passed to `createSkill()`.
   *
   * Return `levelToMultiplier` for level-driven mode or `retentionFormula`
   * for accumulator mode — each definition chooses independently.
   *
   * Note: `id` is provided by the category — don't include it in the
   * returned options (it will be overwritten).
   */
  mapSkill: (def: Def) => Omit<SkillOptions, 'id'>;

  /**
   * Create per-instance state alongside the Skill.
   *
   * Called inside the definition's persistent context, so `persistent()` calls
   * here are scoped to `{categoryId}/{def.id}`.
   *
   * Omit if no extra state is needed.
   */
  mapState?: (def: Def, skill: Skill) => State;
}

/** A registered entry: definition + Skill instance + optional state + introspection signals */
export interface SkillCategoryEntry<Def extends { id: string }, State = void> {
  readonly def: Def;
  readonly skill: Skill;
  readonly state: State;
  readonly signals: CategoryEntrySignals;
}

/**
 * A skill category — batch-registered Skills with a shared shape.
 *
 * @typeParam Def - Content definition type
 * @typeParam State - Per-instance state type (void if none)
 */
export interface SkillCategory<Def extends { id: string }, State = void> extends ResettableObject {
  /** Feature type discriminator for {@link isSkillCategory} checks */
  type: typeof SkillCategoryType;
  /** Persistence context id this category was constructed under. */
  readonly id: string;
  /** The content registry — mods can call `registry.register()` or `registry.patch()` */
  readonly registry: ContentRegistry<Def>;

  /**
   * Register definitions and create their Skill instances.
   * Can be called multiple times (base game + mods).
   */
  register(defs: Def | Def[]): void;

  /** Get the Skill instance for a definition ID */
  getSkill(id: string): Skill | undefined;

  /** Get the per-instance state for a definition ID */
  getState(id: string): State | undefined;

  /** Get the definition for an ID (delegates to registry.get) */
  getDef(id: string): Def | undefined;

  /** Get the full entry (def + skill + state) */
  getEntry(id: string): SkillCategoryEntry<Def, State> | undefined;

  /** All entries in registration order */
  getAll(): SkillCategoryEntry<Def, State>[];

  /**
   * Get the modifier for a skill — shorthand for `getSkill(id)?.modifier`.
   * Primary use case: plugging skills into modifier chains.
   */
  getModifier(id: string): Modifier | undefined;

  /**
   * Add XP to a skill — shorthand for `getSkill(id)?.addXp(amount)`.
   * The action→skill bridge: `onTick: () => skills.addXp(def.skillId, xpAmount)`.
   * No-op if the skill ID doesn't exist.
   */
  addXp(id: string, amount: DecimalSource): void;

  /** Number of registered entries */
  readonly size: number;
}

// === FACTORIES ===

/**
 * Create a skill category — batch registration of Skills from definitions.
 *
 * @param options - Category ID and mapping function
 * @returns A {@link SkillCategory} with registry, lookup, and XP/modifier helpers
 *
 * @example
 * ```ts
 * // Mixed modes: some level-driven, some accumulator
 * const skills = createSkillCategory<SkillDef>({
 *   id: 'skills',
 *   mapSkill: (def) => def.mode === 'accumulator'
 *     ? {
 *         xpToLevel: (xp) => Decimal.floor(Decimal.sqrt(xp)),
 *         retentionFormula: (level) => Decimal.mul(level, 0.01),
 *       }
 *     : {
 *         xpToLevel: (xp) => Decimal.floor(Decimal.sqrt(xp)),
 *         levelToMultiplier: (level) => Decimal.pow(1.05, level),
 *       },
 * });
 *
 * skills.register(SKILL_DEFS);
 * skills.addXp('combat', 100);
 * chain.add(skills.getModifier('combat')!);
 * ```
 */
export function createSkillCategory<Def extends { id: string }, State = void>(
  options: SkillCategoryOptions<Def, State>,
): SkillCategory<Def, State> {
  const { id, mapSkill, mapState } = options;

  const base: CategoryBase<Def, Skill, State> = createCategoryBase({
    id,
    buildInstance: (def) => {
      const opts = mapSkill(def);
      // createSkill has discriminated overloads (AccumulatorSkillOptions | LevelDrivenSkillOptions).
      // The mapSkill return is Omit<SkillOptions, 'id'> which is the union before discrimination.
      // The runtime call is correct — cast to satisfy the overload resolution.
      return createSkill({ ...opts, id: def.id } as Parameters<typeof createSkill>[0]);
    },
    buildState: mapState,
    buildSignals: (_def, skill) => ({
      unlock: computed(() => Decimal.fromValue(skill.level.value).gt(0)),
      count: skill.level,
    }),
  });

  const category: SkillCategory<Def, State> = {
    type: SkillCategoryType,
    id: base.id,
    registry: base.registry,
    register: base.register,
    getDef: base.getDef,

    getSkill(id: string): Skill | undefined {
      return base.getEntry(id)?.instance;
    },

    getState(id: string): State | undefined {
      return base.getEntry(id)?.state;
    },

    getEntry(id: string): SkillCategoryEntry<Def, State> | undefined {
      const entry = base.getEntry(id);
      if (!entry) return undefined;
      return {
        def: entry.def,
        skill: entry.instance,
        state: entry.state,
        signals: entry.signals!,
      };
    },

    getAll(): SkillCategoryEntry<Def, State>[] {
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

// === TYPE GUARDS ===

/** Type guard: returns `true` if the value is a {@link SkillCategory} instance */
export function isSkillCategory(value: unknown): value is SkillCategory<{ id: string }, unknown> {
  return isType(value, SkillCategoryType);
}
