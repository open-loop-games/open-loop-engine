/**
 * Goal picker — weighted-goal selection over a candidate pool
 *
 * On each `pick()`, runs `scorer(candidate, weights, context)` across the
 * candidate pool and sweeps completed selections through an optional
 * predicate. Then it fills open capacity from the top-scoring candidates.
 * Optionally composes {@link Loadout} for persistence and multi-select
 * constraints; falls back to an internal array when no loadout is passed.
 *
 * **When to use this:**
 * - You have a fixed pool of candidates to rank on each pick
 * - Scoring is a pure function of `(id, weights, context)`
 * - Selection is "top N wins", not first-match
 *
 * **When not to use this:**
 * - Inside the Sequencer's queue-fill path → use
 *   {@link createConditionalStrategy} (a fill strategy the sequencer drives)
 * - Between-run configuration arbitration → use
 *   {@link createRecommendationSystem} (score-based arbitration between
 *   recommenders over past runs)
 *
 * The picker **saves nothing itself**: it owns no persistent refs. When
 * `options.loadout` is passed, the Loadout saves the selection. When omitted,
 * selections are in an internal array and are ephemeral.
 *
 * @see {@link createLoadout} — the loadout that saves a selection
 */

import { resolveComputable, type Computable } from '@/core/computed';
import type { Loadout } from './loadout';

// === TYPES ===

/**
 * Score function. MUST be pure: no writes, no reactive reads.
 * The caller builds a fresh context snapshot once per pick and passes it
 * through; the scorer reads only from its three arguments.
 *
 * Higher scores win. Ties break by pool order (stable sort).
 */
export type GoalScorerFn<TCandidate, TContext, TWeights> = (
  candidateId: TCandidate,
  weights: TWeights,
  context: TContext,
) => number;

/**
 * Completion predicate. Returns `true` when a selected candidate's goal is
 * reached and it should give up its place.
 */
export type GoalCompletionFn<TCandidate, TContext> = (
  candidateId: TCandidate,
  context: TContext,
) => boolean;

/** Result of one {@link GoalPicker.pick} — a diff over the active selections. */
export interface GoalPickResult<TCandidate> {
  /** Candidates newly selected by this pick (not previously active). */
  readonly selected: readonly TCandidate[];
  /**
   * Candidates deselected by this pick: `isCompleted` returned `true`, or
   * the mode is `'fresh-each-pick'`.
   */
  readonly swept: readonly TCandidate[];
  /** All candidates active after this pick. */
  readonly active: readonly TCandidate[];
}

/** Options for {@link createGoalPicker}. */
export interface GoalPickerOptions<TCandidate, TContext, TWeights> {
  /**
   * Returns the candidate pool: every eligible candidate id for this pick.
   * Called at most once per `pick()`, and only when capacity is open. The
   * caller controls eligibility filtering. The picker does not enforce
   * uniqueness, visibility, or exclusion across pickers.
   */
  pool: () => readonly TCandidate[];

  /**
   * Current weights vector (persona, policy, difficulty). Passed verbatim
   * to the scorer. The function form is read on each pick, so weights can
   * change (e.g. a persona that shifts with progress); a plain value is fixed.
   */
  weights: TWeights | (() => TWeights);

  /** The score function. See {@link GoalScorerFn}. */
  scorer: GoalScorerFn<TCandidate, TContext, TWeights>;

  /**
   * Called on each currently-active candidate at the top of every `pick()`.
   * Returning `true` deselects it and frees its place for refill. If
   * omitted, a selection stays until `loadout.deselect` removes it, or the
   * mode is `'fresh-each-pick'`.
   */
  isCompleted?: GoalCompletionFn<TCandidate, TContext>;

  /**
   * Most selections held at once. Can be a ref or getter, read on each
   * pick, so capacity can grow (e.g. through purchases). Default: `1`.
   */
  capacity?: Computable<number>;

  /**
   * A Loadout, owned by the caller, that the picker writes selections into.
   * When passed, the loadout saves the selection, and its `canSelect`,
   * `onSelect` and `onDeselect` options apply. When omitted, the picker holds
   * an internal array, which is ephemeral. A Loadout requires
   * `TCandidate extends string`.
   */
  loadout?: Loadout;

  /**
   * Selection lifecycle. Default `'until-completed'`.
   *
   * - `'until-completed'` — selections stay across `pick()` calls, and
   *   `isCompleted` sweeps them. Right for an AI opponent that tracks its own
   *   goals, where a selection is a long commitment.
   * - `'fresh-each-pick'` — every previously-active candidate is deselected at
   *   the top of each `pick()` and reported in `swept`; capacity is always
   *   fully open per pick. Right for "rank the candidate pool for this turn
   *   only", where a selection lasts one pick. `isCompleted` is redundant
   *   under this mode (the active set is empty before the predicate would run).
   *
   * Under `'fresh-each-pick'` with a Loadout, `loadout.deselect` calls its
   * `onDeselect` option callback for every previously-active candidate on
   * each pick.
   */
  mode?: 'until-completed' | 'fresh-each-pick';

  /**
   * Observe-only option callback. Called once per `pick()` AFTER the
   * selection is updated. Receives the diff result.
   *
   * MUST NOT mutate state visible to the next `pick()` call — the callback is
   * for instrumentation (analyzers, counters, debug logging), not control flow.
   */
  onPick?: (result: GoalPickResult<TCandidate>) => void;
}

/** A goal picker instance, returned by {@link createGoalPicker}. */
export interface GoalPicker<TCandidate, TContext, TWeights> {
  /**
   * Run one pick:
   *   1. If `mode` is `'fresh-each-pick'`, deselect every active candidate
   *      and add them to `swept`.
   *   2. Sweep completed selections (calls `isCompleted` on each remaining
   *      active).
   *   3. Score all non-active pool members.
   *   4. Fill open capacity from top-scoring set, descending by score.
   *   5. Call `onPick` if provided.
   *
   * The caller owns the context snapshot. Context must be fresh; the picker
   * does not subscribe to reactive dependencies and will not re-run on its own.
   */
  pick(context: TContext): GoalPickResult<TCandidate>;

  /**
   * Currently active candidates. Backed by a loadout, it is reactive. Without
   * one it is a snapshot of the internal array: a computed over it never
   * recomputes, so re-read it after each `pick()`.
   */
  readonly active: readonly TCandidate[];

  /** Replace the weights value or getter for the next `pick()` call. */
  setWeights(weights: TWeights | (() => TWeights)): void;
}

// === PRIVATE BUILDERS ===

function normalizeWeights<T>(w: T | (() => T)): () => T {
  return typeof w === 'function' ? (w as () => T) : () => w;
}

function normalizeCapacity(c: Computable<number> | undefined): () => number {
  if (c == null) return () => 1;
  return () => resolveComputable(c);
}

// === FACTORIES ===

/**
 * Creates a weighted-goal picker over a candidate pool.
 *
 * @param options - Pool, weights, scorer, and an optional completion
 *   predicate, capacity, loadout and `onPick`
 * @returns A {@link GoalPicker} with an imperative `pick(context)` method, an
 *   `active` read, and `setWeights` for persona swaps
 *
 * @example
 * ```ts
 * // Multi-select linear-weighted scoring:
 * const picker = createGoalPicker<GoalId, WorldView, AiWeights>({
 *   pool: () => goalPoolFor(faction),
 *   weights: () => AI_PERSONAS[factionPersona],
 *   scorer: (id, w, world) => scoreGoal(id, w, world),
 *   isCompleted: (id, world) => isGoalDone(id, world),
 *   capacity: () => factionCapacity.value,
 *   loadout: factionLoadout,
 * });
 *
 * // In a tick handler:
 * const world = buildWorldView();
 * picker.pick(world);
 *
 * // Single-select priority-table scoring:
 * const opponent = createGoalPicker<GoalType, OpponentContext, PersonaWeights>({
 *   pool: () => ALL_GOAL_TYPES,
 *   weights: () => context.effectiveWeights,
 *   scorer: (g) => GOAL_PRIORITY[g],
 *   isCompleted: (g, ctx) => !isGoalStillValid(g, ctx),
 *   capacity: 1,
 * });
 * ```
 */
export function createGoalPicker<TCandidate, TContext, TWeights>(
  options: GoalPickerOptions<TCandidate, TContext, TWeights>,
): GoalPicker<TCandidate, TContext, TWeights> {
  const { pool, scorer, isCompleted, loadout, onPick, mode = 'until-completed' } = options;

  let getWeights = normalizeWeights(options.weights);
  const getCapacity = normalizeCapacity(options.capacity);

  const internal: TCandidate[] = [];

  function readActive(): readonly TCandidate[] {
    if (loadout != null) return loadout.selected.value as unknown as readonly TCandidate[];
    return internal;
  }

  function addSelection(id: TCandidate): boolean {
    if (loadout != null) {
      return loadout.select(id as unknown as string);
    }
    internal.push(id);
    return true;
  }

  function removeSelection(id: TCandidate): boolean {
    if (loadout != null) {
      return loadout.deselect(id as unknown as string);
    }
    const idx = internal.indexOf(id);
    if (idx === -1) return false;
    internal.splice(idx, 1);
    return true;
  }

  function isActive(id: TCandidate): boolean {
    if (loadout != null) return loadout.isSelected(id as unknown as string);
    return internal.includes(id);
  }

  function pick(context: TContext): GoalPickResult<TCandidate> {
    const swept: TCandidate[] = [];

    if (mode === 'fresh-each-pick') {
      const currentActive = [...readActive()];
      for (const id of currentActive) {
        if (removeSelection(id)) swept.push(id);
      }
    }

    if (isCompleted != null) {
      const currentActive = [...readActive()];
      for (const id of currentActive) {
        if (isCompleted(id, context)) {
          if (removeSelection(id)) swept.push(id);
        }
      }
    }

    const capacity = Math.max(0, getCapacity());
    const activeCount = readActive().length;
    const openSlots = Math.max(0, capacity - activeCount);

    const selected: TCandidate[] = [];

    if (openSlots > 0) {
      const weights = getWeights();
      const candidates = pool();

      const scored: { id: TCandidate; score: number; order: number }[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const id = candidates[i];
        if (isActive(id)) continue;
        scored.push({ id, score: scorer(id, weights, context), order: i });
      }

      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.order - b.order;
      });

      for (const entry of scored) {
        if (selected.length >= openSlots) break;
        if (addSelection(entry.id)) {
          selected.push(entry.id);
        }
      }
    }

    const result: GoalPickResult<TCandidate> = {
      selected,
      swept,
      active: [...readActive()],
    };

    onPick?.(result);
    return result;
  }

  function setWeights(weights: TWeights | (() => TWeights)): void {
    getWeights = normalizeWeights(weights);
  }

  return {
    pick,
    get active() {
      return readActive();
    },
    setWeights,
  };
}
