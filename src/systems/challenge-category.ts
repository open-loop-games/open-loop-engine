/**
 * Challenge Category — batch-create Challenges from content defs
 *
 * Challenges are temporary game modes that modify rules (formula overrides,
 * content patches) while entered. Players enter a challenge, play under
 * modified rules, and keep rewards after completion.
 *
 * Supports:
 * - Simple: 3 mutually exclusive challenges
 * - Repeatable: challenges with several completions and scaling rewards
 * - Reset-bound: enter/exit with goals
 *
 * Uses {@link createCategoryBase} for registration + persistent context.
 * Composes with {@link OverrideRegistry} for scoped overrides of game
 * behaviors and {@link ContentRegistryView} for pushed patches.
 *
 * @example
 * ```ts
 * const challenges = createChallengeCategory<MyChallengeDef>({
 *   id: 'challenges',
 *   overrideRegistry: gameOverrides,
 *   mutuallyExclusive: true,
 * });
 *
 * challenges.register([
 *   { id: 'zombie', displayName: 'Zombie Mode', overrides: { getSelfCombat: () => 0 } },
 * ]);
 *
 * challenges.getChallenge('zombie')!.enter();
 * // ... game runs with modified combat ...
 * challenges.getChallenge('zombie')!.complete();
 * ```
 */

import { computed, effectScope, onScopeDispose, type ComputedRef } from 'vue';
import type { Persistent } from '@/core/persistence';
import { onHydrated, persistent } from '@/core/persistence';
import type { RegisterTick } from '@/core/sequencer';
import {
  setupDeclarativeBindings,
  createCategoryBase,
  type CategoryBase,
  type CategoryEntrySignals,
} from './category-base';
import type { ContentRegistryView } from './content-registry';
import { Resettable, type ResettableObject } from '@/core/resettable';
import type { OverrideRegistry } from '@/core/override-registry';
import type { Reset } from './reset';
import type { IEffect, GameStateAccessor } from '@/primitives/types';
import type { GameStateMutator } from '@/core/effects';
import { applyEffect } from '@/core/effects';
import { getCurrentGameStateAccessor } from '@/core/game-state-accessor';
import { getCurrentEngineCategories } from './engine-categories';
import { bindGateServices, createPredicateResolver, type Predicate } from './gate';
import type { Grant } from '@/core/modifier';

// === TYPES ===

/**
 * Def for a challenge. Registered via
 * {@link ChallengeCategory.register}.
 *
 * @typeParam Overrides - The override registry's type map (e.g., GameOverrides)
 */
export interface ChallengeDef<
  Overrides extends { [K in keyof Overrides]: (...args: never[]) => unknown } = Record<
    string,
    (...args: never[]) => unknown
  >,
> {
  id: string;
  displayName: string;

  /**
   * Visibility Predicate — a challenge with `visible: false` isn't shown in
   * UI. Default: `true`
   *
   * A {@link Gate} evaluates through the Gate services the category captured
   * at construction, and is what the transition walker predicts. A boolean,
   * ref or getter is opaque to it.
   */
  visible?: Predicate;

  /** Entry Predicate — blocks entering while it doesn't hold. Default: `true` */
  canEnter?: Predicate;

  /**
   * Overrides pushed to the override registry while this challenge is entered.
   * Popped automatically on exit.
   */
  overrides?: Partial<Overrides>;

  /**
   * Content patches, pushed while this challenge is entered.
   * Map of registry name → def id → partial fields. Reverted automatically
   * on exit — see {@link ContentRegistryView} for what a patch reaches.
   */
  contentPatches?: Record<string, Record<string, Partial<Record<string, unknown>>>>;

  /**
   * Completion goal — the challenge completes on its own once the goal holds
   * while entered, evaluated each tick the category's `registerTick` drives.
   * A category without `registerTick` never evaluates it; call
   * {@link Challenge.complete} instead.
   *
   * A {@link Gate} is predictor- and devtool-friendly, with no consumer-side
   * path conventions; prefer it for category-aware goals. A getter or ref
   * suits a check that reads typed refs in scope where introspection isn't
   * needed. Omitted, the goal never holds.
   */
  goal?: Predicate;

  /** The limit on completions. Default: 1. Repeatable challenges often use 5. */
  completionLimit?: number;

  /**
   * One-shot effects applied once per completion (e.g. grant a resource,
   * unlock a feature). For lifetime grants that stay in force after the
   * first completion, use {@link rewards} instead.
   */
  completionEffects?: IEffect[];

  /**
   * Grants in force while the challenge is entered. Each becomes a
   * {@link createModifierChain | chain.bind} call with `challenge.entered` as
   * its implicit predicate. So the shared chain applies the modifier whenever
   * the player enters the challenge, and removes it on exit. Use for "X is
   * disabled during this challenge" / "rates are halved while entered"
   * patterns, with full attribution in the balance harness.
   */
  restricts?: Grant[];

  /**
   * Grants in force once the challenge has at least one completion. Each
   * becomes a `chain.bind` call with `completions > 0` as its implicit
   * predicate. Use for lifetime per-completion modifiers (the common
   * "complete it once, keep the reward" shape).
   */
  rewards?: Grant[];

  /**
   * Called after overrides are pushed and the player enters the challenge.
   * A load or reset that restores `entered` doesn't call it, so it may write
   * game state; ephemeral setup belongs in state derived from `entered`.
   */
  onEnter?: () => void;

  /**
   * Called after overrides are popped and the player leaves the challenge.
   * A load or reset that clears `entered` doesn't call it.
   */
  onExit?: () => void;

  /** Called on each completion, before the exit unless `complete(true)` stays entered */
  onComplete?: () => void;
}

/** A challenge instance with saved state and lifecycle methods */
export interface Challenge {
  readonly id: string;

  /**
   * Whether this challenge is entered (saved). Tagged `lifetime`, like
   * `completions`: an entered challenge spans the prestiges played inside
   * it, and completions survive every prestige layer. So no reset or
   * category walk touches either unless it names them. A hard reset names
   * the refs in `thingsToReset`.
   */
  readonly entered: Persistent<boolean>;

  /** Number of times this challenge has been completed (saved) */
  readonly completions: Persistent<number>;

  /** True when completions > 0 */
  readonly completed: ComputedRef<boolean>;

  /** True when completions >= completionLimit */
  readonly maxed: ComputedRef<boolean>;

  /** True while entered and the goal holds */
  readonly canComplete: ComputedRef<boolean>;

  /** True when the challenge can be entered */
  readonly canEnter: ComputedRef<boolean>;

  /** Whether the challenge should be shown in UI */
  readonly visible: ComputedRef<boolean>;

  /**
   * Enter this challenge. Pushes overrides and patches, runs the
   * category's `reset`, calls onEnter.
   * @returns true if entered; false if blocked (already entered, maxed, etc.)
   *   or if the `reset` declines, by which point a mutually exclusive
   *   challenge has already been exited
   */
  enter(): boolean;

  /** Exit without completing. Pops overrides, removes pushed patches, calls onExit. */
  exit(): void;

  /**
   * Complete the challenge (increment completions, apply `completionEffects`).
   * @param stayEntered - If true, stay in the challenge after completion
   */
  complete(stayEntered?: boolean): void;

  /** Toggle: enter if not entered, exit if entered */
  toggle(): void;
}

/** A registered entry in a challenge category */
export interface ChallengeCategoryEntry<Def extends ChallengeDef, DefState = void> {
  readonly def: Def;
  readonly challenge: Challenge;
  readonly state: DefState;
  readonly signals: CategoryEntrySignals;
}

/**
 * Options for {@link createChallengeCategory}.
 *
 * @typeParam Def - Challenge def type
 * @typeParam DefState - Def state type (void if none)
 */
export interface ChallengeCategoryOptions<Def extends ChallengeDef, DefState = void> {
  /** Persistent context id. Each challenge's persistent context is `{id}/{def.id}`. */
  id: string;

  /**
   * Override registry for scoped overrides of game behaviors.
   * A challenge def with `overrides` pushes and pops them on this registry.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  overrideRegistry?: OverrideRegistry<Record<string, (...args: any[]) => any>>;

  /**
   * Content registries for pushed patches.
   * Map of registry name → content registry, such as a category's `registry`.
   * Challenge defs with `contentPatches` reference these by name.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contentRegistries?: Record<string, ContentRegistryView<any>>;

  /**
   * Optional reset to trigger on challenge enter.
   * Called after overrides are pushed but before onEnter.
   */
  reset?: Reset;

  /**
   * Whether only one challenge can be entered at a time.
   * If true (default), entering a new challenge exits the current one.
   */
  mutuallyExclusive?: boolean;

  /**
   * Game state accessor. Falls back to the ambient accessor wired by
   * `createEngine`. The category captures the ambient Gate services at
   * construction; Gate-typed `visible`, `canEnter` and `goal` fields evaluate
   * through them.
   */
  accessor?: GameStateAccessor;

  /**
   * Game state mutator that applies `completionEffects`. Falls back to the
   * ambient accessor wired by `createEngine`; registering a def with
   * `completionEffects` throws when neither resolves.
   */
  mutator?: GameStateMutator;

  /**
   * Drives `goal` auto-completion: the category evaluates every entered
   * challenge's goal each tick. Without it, goals are never evaluated.
   */
  registerTick?: RegisterTick;

  /**
   * Build the def state beside each Challenge.
   * Called inside the challenge's persistent context.
   */
  mapState?: (def: Def, challenge: Challenge) => DefState;
}

/**
 * A challenge category — batch-registered challenges with shared lifecycle.
 *
 * @typeParam Def - Challenge def type
 * @typeParam DefState - Def state type (void if none)
 */
export interface ChallengeCategory<
  Def extends ChallengeDef,
  DefState = void,
> extends ResettableObject {
  /** Persistent context id this category was constructed under. */
  readonly id: string;
  /**
   * The content registry (see {@link ContentRegistryView} for what a patch
   * reaches). Add defs with the category's `register`, which builds each
   * def's challenge and state.
   */
  readonly registry: ContentRegistryView<Def>;

  /** Register challenge defs. Can be called multiple times. */
  register(defs: Def | Def[]): void;

  /** Get the Challenge instance by def id */
  getChallenge(id: string): Challenge | undefined;

  /** Get the def state by def id */
  getState(id: string): DefState | undefined;

  /** Get the def by id */
  getDef(id: string): Def | undefined;

  /** Get the full entry (def + challenge + state) */
  getEntry(id: string): ChallengeCategoryEntry<Def, DefState> | undefined;

  /** All entries in registration order */
  getAll(): ChallengeCategoryEntry<Def, DefState>[];

  /** The entered challenge (null if none). Reactive. */
  readonly current: ComputedRef<Challenge | null>;

  /** Number of challenges with at least one completion. Reactive. */
  readonly completedCount: ComputedRef<number>;

  /** True when all challenges are maxed. Reactive. */
  readonly allMaxed: ComputedRef<boolean>;

  /** Number of registered challenges */
  readonly size: number;

  /**
   * End the runtime wiring: pop every scoped override, remove every pushed
   * patch, and stop the goal tick and the load handler. No `onExit` runs.
   * `entered` and `completions` stay saved, so a save taken after
   * `dispose()` keeps the challenge.
   */
  dispose(): void;
}

// === FACTORIES ===

/**
 * Create a challenge category for batch registration of challenges.
 *
 * @param options - Category options
 * @returns A {@link ChallengeCategory} with registration, lookup, and lifecycle
 */
export function createChallengeCategory<Def extends ChallengeDef, DefState = void>(
  options: ChallengeCategoryOptions<Def, DefState>,
): ChallengeCategory<Def, DefState> {
  const {
    id: categoryId,
    overrideRegistry,
    contentRegistries = {},
    reset,
    mutuallyExclusive = true,
    accessor: optAccessor,
    mutator: optMutator,
    registerTick,
    mapState,
  } = options;

  // Resolve accessor/mutator: explicit option wins, then ambient fallback.
  const ambient = getCurrentGameStateAccessor();
  const accessor = optAccessor ?? ambient;
  const mutator = optMutator ?? ambient;

  // Captured at construction — challenge defs register and evaluate long after
  // the ambient values are gone.
  const predicates = createPredicateResolver({ accessor });

  // Track cleanup functions for each entered challenge's scoped overrides and pushed patches
  const activeCleanups = new Map<string, Array<() => void>>();
  // The challenge whose enter() has pushed its scoped overrides but not yet set
  // `entered` — its entry reset settles in between, and must not pop them.
  let entering: string | undefined;

  /** Push scoped overrides and patches for a challenge def */
  function pushOverrides(def: Def): Array<() => void> {
    const cleanups: Array<() => void> = [];

    if (def.overrides && overrideRegistry) {
      cleanups.push(overrideRegistry.pushOverrides(`challenge:${def.id}`, def.overrides));
    }

    if (def.contentPatches) {
      for (const [registryId, patches] of Object.entries(def.contentPatches)) {
        const reg = contentRegistries[registryId];
        if (reg) {
          cleanups.push(reg.pushPatches(patches));
        }
      }
    }

    return cleanups;
  }

  /** Pop scoped overrides and remove pushed patches (reverse order) */
  function popOverrides(challengeId: string): void {
    const cleanups = activeCleanups.get(challengeId);
    if (cleanups) {
      for (let i = cleanups.length - 1; i >= 0; i--) {
        cleanups[i]();
      }
      activeCleanups.delete(challengeId);
    }
  }

  /** Push or pop each challenge's scoped overrides to match its `entered`. */
  function hydrateOverrides(): void {
    for (const entry of base.getAll()) {
      const id = entry.def.id;
      if (id === entering) continue;
      const pushed = activeCleanups.has(id);
      if (entry.instance.entered.value && !pushed) activeCleanups.set(id, pushOverrides(entry.def));
      else if (!entry.instance.entered.value && pushed) popOverrides(id);
    }
  }

  const base: CategoryBase<Def, Challenge, DefState> = createCategoryBase({
    id: categoryId,
    buildInstance(def: Def): Challenge {
      if (def.completionEffects?.length && !(accessor && mutator)) {
        throw new Error(
          `Challenge "${def.id}" has completionEffects but category "${categoryId}" has no ` +
            'accessor and mutator to apply them; pass both, or build it inside createEngine',
        );
      }

      const active = persistent<boolean>(false, { id: 'entered', lifetime: true });
      const completions = persistent<number>(0, { id: 'completions', lifetime: true });
      const limit = def.completionLimit ?? 1;

      const completed = computed(() => completions.value > 0);
      const maxed = computed(() => completions.value >= limit);

      const label = `challenge '${def.id}'`;
      const goal = predicates.adopt(def.goal, false, `${label} goal`);
      const canEnter = predicates.adopt(def.canEnter, true, `${label} canEnter`);
      const visible = predicates.adopt(def.visible, true, `${label} visible`);

      const canComplete = computed(() => active.value && goal.holds.value);

      const canEnterComputed = computed(() => {
        if (maxed.value) return false;
        if (active.value) return false;
        return canEnter.holds.value;
      });

      function enter(): boolean {
        if (!canEnterComputed.value) return false;

        if (mutuallyExclusive) {
          for (const entry of base.getAll()) {
            if (entry.instance.entered.value && entry.instance.id !== def.id) {
              entry.instance.exit();
            }
          }
        }

        popOverrides(def.id);
        entering = def.id;
        try {
          activeCleanups.set(def.id, pushOverrides(def));
          if (reset && !reset.reset()) {
            popOverrides(def.id);
            return false;
          }
        } finally {
          entering = undefined;
        }

        active.value = true;
        def.onEnter?.();
        return true;
      }

      function exit(): void {
        if (!active.value) return;

        active.value = false;
        popOverrides(def.id);
        def.onExit?.();
      }

      function complete(stayEntered = false): void {
        if (!active.value) return;
        if (completions.value >= limit) return;

        completions.value++;

        if (def.completionEffects && accessor && mutator) {
          for (const effect of def.completionEffects) {
            applyEffect(effect, accessor, mutator);
          }
        }

        def.onComplete?.();

        if (!stayEntered) {
          exit();
        }
      }

      function toggle(): void {
        if (active.value) {
          exit();
        } else {
          enter();
        }
      }

      // Grants. `restricts` holds while entered; `rewards` holds once the
      // challenge has been completed at least once. Both are bound inside the
      // def's persistent context, which createCategoryBase opens, so
      // chain.bind auto-derives attribution ids like
      // `{categoryId}/{def.id}/{role}/{description}`; the role keeps a
      // restriction and a reward with the same description apart on one chain.
      setupDeclarativeBindings(
        def.restricts,
        active,
        predicates,
        `challenge '${def.id}' restricts`,
        'restricts',
      );
      setupDeclarativeBindings(
        def.rewards,
        completed,
        predicates,
        `challenge '${def.id}' rewards`,
        'rewards',
      );

      const challenge: Challenge = {
        id: def.id,
        entered: active,
        completions,
        completed,
        maxed,
        canComplete,
        canEnter: canEnterComputed,
        visible: visible.holds,
        enter,
        exit,
        complete,
        toggle,
      };
      bindGateServices(challenge, predicates.services);
      return challenge;
    },
    buildState: mapState,
    buildSignals: (_def, challenge) => ({
      active: challenge.completed,
      count: computed(() => challenge.completions.value),
    }),
  });

  const scope = effectScope();
  scope.run(() => {
    onHydrated(hydrateOverrides);
    if (registerTick) {
      onScopeDispose(
        registerTick(() => {
          for (const entry of base.getAll()) {
            if (entry.instance.canComplete.value) {
              entry.instance.complete();
            }
          }
        }),
      );
    }
  });

  const activeChallenge = computed(() => {
    const entry = base.getAll().find((e) => e.instance.entered.value);
    return entry?.instance ?? null;
  });

  const completedCount = computed(() => {
    return base.getAll().filter((e) => e.instance.completed.value).length;
  });

  const allMaxed = computed(() => {
    const all = base.getAll();
    return all.length > 0 && all.every((e) => e.instance.maxed.value);
  });

  const category: ChallengeCategory<Def, DefState> = {
    id: base.id,
    registry: base.registry,
    register: base.register,
    getDef: base.getDef,

    getChallenge(id: string): Challenge | undefined {
      return base.getEntry(id)?.instance;
    },

    getState(id: string): DefState | undefined {
      return base.getEntry(id)?.state;
    },

    getEntry(id: string): ChallengeCategoryEntry<Def, DefState> | undefined {
      const entry = base.getEntry(id);
      if (!entry) return undefined;
      return {
        def: entry.def,
        challenge: entry.instance,
        state: entry.state,
        signals: entry.signals!,
      };
    },

    getAll(): ChallengeCategoryEntry<Def, DefState>[] {
      return base.getAll().map((e) => ({
        def: e.def,
        challenge: e.instance,
        state: e.state,
        signals: e.signals!,
      }));
    },

    current: activeChallenge,
    completedCount,
    allMaxed,

    get size(): number {
      return base.size;
    },

    dispose(): void {
      scope.stop();
      for (const id of [...activeCleanups.keys()]) popOverrides(id);
    },

    [Resettable]: base[Resettable],
  };

  const ec = getCurrentEngineCategories();
  if (ec) (ec.challenges ??= []).push(category);

  return category;
}
