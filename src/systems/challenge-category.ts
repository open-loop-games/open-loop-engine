/**
 * Challenge Category — batch-create Challenges from content definitions
 *
 * Challenges are temporary game modes that modify rules (formula overrides,
 * content patches) while active. Players enter a challenge, play under
 * modified conditions, and earn persistent rewards on completion.
 *
 * Supports:
 * - Lloyd-style: 3 simple mutually exclusive challenges
 * - AD-style: multi-tier challenges with multiple completions and scaling rewards
 * - TMT/Profectus-style: reset-bound enter/exit with goal conditions
 *
 * Uses {@link createCategoryBase} for registration + persistent context.
 * Composes with {@link OverrideRegistry} for scoped push/pop of game
 * behaviors and {@link ContentRegistryView} for scoped content patches.
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
 *   { id: 'zombie', name: 'Zombie Mode', overrides: { getSelfCombat: () => 0 } },
 * ]);
 *
 * challenges.getChallenge('zombie')!.enter();
 * // ... game runs with modified combat ...
 * challenges.getChallenge('zombie')!.complete();
 * ```
 */

import { computed, type ComputedRef } from 'vue';
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
import { bindGateRuntime, createPredicateResolver, type Predicate } from './gate';
import type { Grant } from '@/core/modifier';

// === TYPES ===

/**
 * Definition for a challenge. Registered via
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
  name: string;

  /**
   * Visibility gate — hidden challenges don't appear in UI. Default: `true`
   *
   * A {@link Gate} resolves through the runtime the category captured at
   * construction, and is what the transition walker predicts; a boolean,
   * ref or getter is opaque to it.
   */
  visible?: Predicate;

  /** Start gate — prevents entering when not met. Default: `true` */
  canStart?: Predicate;

  /**
   * Overrides pushed to the override registry while this challenge is active.
   * Popped automatically on exit.
   */
  overrides?: Partial<Overrides>;

  /**
   * Content patches applied while this challenge is active.
   * Map of registry name → entry id → partial fields.
   * Reverted automatically on exit. A patch changes the def in place; content
   * built from it sees the change where it reads the def at use time, and a
   * computed re-runs on it only when it reads through the registry, such as a
   * getter over a category's `getDef(id)`.
   */
  contentPatches?: Record<string, Record<string, Partial<Record<string, unknown>>>>;

  /**
   * Completion goal — auto-completes when met while active, checked each tick
   * the category's `registerTick` drives. A category without `registerTick`
   * never checks it; call {@link Challenge.complete} instead.
   *
   * A {@link Gate} is predictor- and devtool-friendly, with no consumer-side
   * path conventions; prefer it for category-aware goals. A getter or ref
   * suits a check that reads typed refs in scope where introspection isn't
   * needed. Omitted, the goal never holds.
   */
  goal?: Predicate;

  /** Maximum number of completions. Default: 1. AD Eternity Challenges use 5. */
  completionLimit?: number;

  /**
   * One-shot effects applied once per completion (e.g. grant a resource,
   * unlock a feature). For persistent bonuses that stay active after the
   * challenge is won, use {@link rewards} instead.
   */
  completionEffects?: IEffect[];

  /**
   * Declarative modifier bindings active while the challenge is entered.
   * Lowered to {@link createModifierChain | chain.bind} calls with
   * `challenge.active` as the implicit predicate — the shared chain picks up
   * the contribution whenever the player enters the challenge and drops it
   * on exit. Use for "X is disabled during this challenge" / "rates are
   * halved while active" patterns with full balance-sim attribution.
   */
  restricts?: Grant[];

  /**
   * Declarative modifier bindings active once the challenge has been
   * completed at least once. Lowered to `chain.bind` calls with
   * `completions > 0` as the implicit predicate. Use for persistent
   * per-completion bonuses (the common "beat it to keep its buff" shape).
   */
  rewards?: Grant[];

  /**
   * Called after overrides are pushed and the player enters the challenge.
   * A load or reset that restores `active` doesn't call it, so it may write
   * game state; runtime-only setup belongs in state derived from `active`.
   */
  onEnter?: () => void;

  /**
   * Called after overrides are popped and the player leaves the challenge.
   * A load or reset that clears `active` doesn't call it.
   */
  onExit?: () => void;

  /** Called when goal is met (before exit, if auto-exiting) */
  onComplete?: () => void;
}

/** A challenge instance with persistent state and lifecycle methods */
export interface Challenge {
  readonly id: string;

  /**
   * Whether this challenge is currently active (persistent). Tagged
   * `lifetime` with `completions`: a challenge run spans the prestiges played
   * inside it, and completions outlive every prestige tier, so no module reset
   * or category walk touches either. A hard wipe names the refs in
   * `thingsToReset`.
   */
  readonly active: Persistent<boolean>;

  /** Number of times this challenge has been completed (persistent) */
  readonly completions: Persistent<number>;

  /** True when completions > 0 */
  readonly completed: ComputedRef<boolean>;

  /** True when completions >= completionLimit */
  readonly maxed: ComputedRef<boolean>;

  /** True when active and goal condition is met */
  readonly canComplete: ComputedRef<boolean>;

  /** True when the challenge can be entered */
  readonly canStart: ComputedRef<boolean>;

  /** Whether the challenge should be shown in UI */
  readonly visible: ComputedRef<boolean>;

  /**
   * Enter this challenge. Pushes overrides, applies patches, runs the
   * category's `reset`, calls onEnter.
   * @returns true if entered; false if blocked (already active, maxed, etc.)
   *   or if the `reset` declines, by which point a mutually exclusive
   *   challenge has already been exited
   */
  enter(): boolean;

  /** Exit without completing. Pops overrides, reverts patches, calls onExit. */
  exit(): void;

  /**
   * Complete the challenge (increment completions, apply rewards).
   * @param remainActive - If true, stay in the challenge after completion
   */
  complete(remainActive?: boolean): void;

  /** Toggle: enter if inactive, exit if active */
  toggle(): void;
}

/** A registered entry in a challenge category */
export interface ChallengeCategoryEntry<Def extends ChallengeDef, State = void> {
  readonly def: Def;
  readonly challenge: Challenge;
  readonly state: State;
  readonly signals: CategoryEntrySignals;
}

/**
 * Options for {@link createChallengeCategory}.
 *
 * @typeParam Def - Challenge definition type
 * @typeParam State - Per-instance state type (void if none)
 */
export interface ChallengeCategoryOptions<Def extends ChallengeDef, State = void> {
  /** Persistence context name. Each challenge gets `{id}/{def.id}`. */
  id: string;

  /**
   * Override registry for scoped push/pop of game behaviors.
   * Challenge defs with `overrides` will push/pop scopes on this registry.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  overrideRegistry?: OverrideRegistry<Record<string, (...args: any[]) => any>>;

  /**
   * Content registries for scoped patches.
   * Map of registry name → content registry, such as a category's `registry`.
   * Challenge defs with `contentPatches` reference these by name.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contentRegistries?: Record<string, ContentRegistryView<any>>;

  /**
   * Optional reset to trigger on challenge enter (TMT/Profectus-style).
   * Called after overrides are pushed but before onEnter.
   */
  reset?: Reset;

  /**
   * Whether only one challenge can be active at a time.
   * If true (default), entering a new challenge exits the current one.
   */
  mutuallyExclusive?: boolean;

  /**
   * Game state accessor. Falls back to the ambient accessor wired by
   * `createEngine`. The category resolves the Gate runtime triple (accessor +
   * categories + registry) ambiently at construction time; Gate-typed visible
   * / canStart / goal fields evaluate through that captured runtime.
   */
  accessor?: GameStateAccessor;

  /**
   * Game state mutator that applies `completionEffects`. Falls back to the
   * ambient accessor wired by `createEngine`; registering a def with
   * `completionEffects` throws when neither resolves.
   */
  mutator?: GameStateMutator;

  /**
   * Drives `goal` auto-completion: the category checks every active
   * challenge's goal each tick. Without it, goals are never checked.
   */
  registerTick?: RegisterTick;

  /**
   * Create per-instance state alongside each Challenge.
   * Called inside the challenge's persistent context.
   */
  mapState?: (def: Def, challenge: Challenge) => State;
}

/**
 * A challenge category — batch-registered challenges with shared lifecycle.
 *
 * @typeParam Def - Challenge definition type
 * @typeParam State - Per-instance state type (void if none)
 */
export interface ChallengeCategory<
  Def extends ChallengeDef,
  State = void,
> extends ResettableObject {
  /** Persistence context id this category was constructed under. */
  readonly id: string;
  /**
   * The content registry. `registry.patch()` / `pushPatches()` change the def
   * in place, so code reading `def.x` when it runs sees the change. Defs aren't
   * reactive, though: a computed reading `def.x` directly isn't re-run by a
   * patch, one reading through `getDef(id)` or `registry.get(id)` is, and a
   * field given as a value is copied at register and keeps its old one. The
   * view has no `register`: add defs with the
   * category's `register`, which builds each def's challenge and state.
   */
  readonly registry: ContentRegistryView<Def>;

  /** Register challenge definitions. Can be called multiple times. */
  register(defs: Def | Def[]): void;

  /** Get the Challenge instance by definition ID */
  getChallenge(id: string): Challenge | undefined;

  /** Get per-instance state by definition ID */
  getState(id: string): State | undefined;

  /** Get the definition by ID */
  getDef(id: string): Def | undefined;

  /** Get the full entry (def + challenge + state) */
  getEntry(id: string): ChallengeCategoryEntry<Def, State> | undefined;

  /** All entries in registration order */
  getAll(): ChallengeCategoryEntry<Def, State>[];

  /** Currently active challenge (null if none). Reactive. */
  readonly active: ComputedRef<Challenge | null>;

  /** Number of challenges with at least one completion. Reactive. */
  readonly completedCount: ComputedRef<number>;

  /** True when all challenges are maxed. Reactive. */
  readonly allMaxed: ComputedRef<boolean>;

  /** Number of registered challenges */
  readonly size: number;

  /**
   * Release runtime state: pop every pushed override and patch and stop the
   * goal tick. `active` and the hooks are left alone, so a save taken after
   * teardown keeps the challenge.
   */
  dispose(): void;
}

// === FACTORIES ===

/**
 * Create a challenge category for batch registration of challenges.
 *
 * @param options - Category configuration
 * @returns A {@link ChallengeCategory} with registration, lookup, and lifecycle
 */
export function createChallengeCategory<Def extends ChallengeDef, State = void>(
  options: ChallengeCategoryOptions<Def, State>,
): ChallengeCategory<Def, State> {
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
  // the ambient scope closes.
  const predicates = createPredicateResolver({ accessor });

  // Track cleanup functions for each active challenge's scoped overrides/patches
  const activeCleanups = new Map<string, Array<() => void>>();
  // The challenge whose enter() has pushed its scopes but not yet set `active`
  // — its entry reset settles in between, and must not pop them.
  let entering: string | undefined;

  /** Push scoped overrides and content patches for a challenge def */
  function pushScopes(def: Def): Array<() => void> {
    const cleanups: Array<() => void> = [];

    if (def.overrides && overrideRegistry) {
      cleanups.push(overrideRegistry.pushScope(`challenge:${def.id}`, def.overrides));
    }

    if (def.contentPatches) {
      for (const [registryName, patches] of Object.entries(def.contentPatches)) {
        const reg = contentRegistries[registryName];
        if (reg) {
          cleanups.push(reg.pushPatches(patches));
        }
      }
    }

    return cleanups;
  }

  /** Pop scoped overrides and content patches (reverse order) */
  function popScopes(challengeId: string): void {
    const cleanups = activeCleanups.get(challengeId);
    if (cleanups) {
      for (let i = cleanups.length - 1; i >= 0; i--) {
        cleanups[i]();
      }
      activeCleanups.delete(challengeId);
    }
  }

  /** Push or pop each challenge's scopes to match its `active`. */
  function reconcileScopes(): void {
    for (const entry of base.getAll()) {
      const id = entry.def.id;
      if (id === entering) continue;
      const pushed = activeCleanups.has(id);
      if (entry.instance.active.value && !pushed) activeCleanups.set(id, pushScopes(entry.def));
      else if (!entry.instance.active.value && pushed) popScopes(id);
    }
  }

  const base: CategoryBase<Def, Challenge, State> = createCategoryBase({
    id: categoryId,
    buildInstance(def: Def): Challenge {
      if (def.completionEffects?.length && !(accessor && mutator)) {
        throw new Error(
          `Challenge "${def.id}" has completionEffects but category "${categoryId}" has no ` +
            'accessor and mutator to apply them; pass both, or build it inside createEngine',
        );
      }

      const active = persistent<boolean>(false, { name: 'active', lifetime: true });
      const completions = persistent<number>(0, { name: 'completions', lifetime: true });
      const limit = def.completionLimit ?? 1;

      const completed = computed(() => completions.value > 0);
      const maxed = computed(() => completions.value >= limit);

      const label = `challenge '${def.id}'`;
      const goal = predicates.adopt(def.goal, false, `${label} goal`);
      const canStart = predicates.adopt(def.canStart, true, `${label} canStart`);
      const visible = predicates.adopt(def.visible, true, `${label} visible`);

      const canComplete = computed(() => active.value && goal.holds.value);

      const canStartComputed = computed(() => {
        if (maxed.value) return false;
        if (active.value) return false;
        return canStart.holds.value;
      });

      function enter(): boolean {
        if (!canStartComputed.value) return false;

        if (mutuallyExclusive) {
          for (const entry of base.getAll()) {
            if (entry.instance.active.value && entry.instance.id !== def.id) {
              entry.instance.exit();
            }
          }
        }

        popScopes(def.id);
        entering = def.id;
        try {
          activeCleanups.set(def.id, pushScopes(def));
          if (reset && !reset.reset()) {
            popScopes(def.id);
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
        popScopes(def.id);
        def.onExit?.();
      }

      function complete(remainActive = false): void {
        if (!active.value) return;
        if (completions.value >= limit) return;

        completions.value++;

        if (def.completionEffects && accessor && mutator) {
          for (const effect of def.completionEffects) {
            applyEffect(effect, accessor, mutator);
          }
        }

        def.onComplete?.();

        if (!remainActive) {
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

      // Declarative modifier bindings. `restricts` gates on `active`;
      // `rewards` gates on "has been completed at least once". Both are
      // bound inside the per-def persistent-context scope opened by
      // createCategoryBase, so chain.bind auto-derives attribution ids like
      // `{categoryId}/{def.id}/{description}`.
      setupDeclarativeBindings(
        def.restricts,
        active,
        predicates,
        `challenge '${def.id}' restricts`,
      );
      setupDeclarativeBindings(def.rewards, completed, predicates, `challenge '${def.id}' rewards`);

      const challenge: Challenge = {
        id: def.id,
        active,
        completions,
        completed,
        maxed,
        canComplete,
        canStart: canStartComputed,
        visible: visible.holds,
        enter,
        exit,
        complete,
        toggle,
      };
      bindGateRuntime(challenge, predicates.runtime);
      return challenge;
    },
    buildState: mapState,
    buildSignals: (_def, challenge) => ({
      unlock: challenge.completed,
      count: computed(() => challenge.completions.value),
    }),
  });

  const stopHydrated = onHydrated(reconcileScopes);

  let unregisterTick: (() => void) | undefined;
  if (registerTick) {
    unregisterTick = registerTick(() => {
      for (const entry of base.getAll()) {
        if (entry.instance.canComplete.value) {
          entry.instance.complete();
        }
      }
    });
  }

  const activeChallenge = computed(() => {
    const entry = base.getAll().find((e) => e.instance.active.value);
    return entry?.instance ?? null;
  });

  const completedCount = computed(() => {
    return base.getAll().filter((e) => e.instance.completed.value).length;
  });

  const allMaxed = computed(() => {
    const all = base.getAll();
    return all.length > 0 && all.every((e) => e.instance.maxed.value);
  });

  const category: ChallengeCategory<Def, State> = {
    id: base.id,
    registry: base.registry,
    register: base.register,
    getDef: base.getDef,

    getChallenge(id: string): Challenge | undefined {
      return base.getEntry(id)?.instance;
    },

    getState(id: string): State | undefined {
      return base.getEntry(id)?.state;
    },

    getEntry(id: string): ChallengeCategoryEntry<Def, State> | undefined {
      const entry = base.getEntry(id);
      if (!entry) return undefined;
      return {
        def: entry.def,
        challenge: entry.instance,
        state: entry.state,
        signals: entry.signals!,
      };
    },

    getAll(): ChallengeCategoryEntry<Def, State>[] {
      return base.getAll().map((e) => ({
        def: e.def,
        challenge: e.instance,
        state: e.state,
        signals: e.signals!,
      }));
    },

    active: activeChallenge,
    completedCount,
    allMaxed,

    get size(): number {
      return base.size;
    },

    dispose(): void {
      unregisterTick?.();
      stopHydrated();
      for (const id of [...activeCleanups.keys()]) popScopes(id);
    },

    [Resettable]: base[Resettable],
  };

  const ec = getCurrentEngineCategories();
  if (ec) (ec.challenges ??= []).push(category);

  return category;
}
