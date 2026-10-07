/**
 * Goal picker — weighted-goal selection over a candidate pool
 *
 * Runs `score(candidate, weights, context)` across a pool each tick, sweeps
 * completed selections via an optional predicate, then fills open capacity
 * from the top-scoring candidates. Optionally composes {@link Slot} for
 * persistence and multi-select constraints; falls back to an internal array
 * when no slot is provided.
 *
 * **When to reach for this:**
 * - You have a fixed pool of candidates to rank each tick
 * - Scoring is a pure function of `(id, weights, context)`
 * - Selection is "top N wins", not first-match
 *
 * **When not to reach for this:**
 * - Inside the Sequencer's queue-fill path → use
 *   {@link createConditionalStrategy} (FillStrategy variant, sequencer-driven)
 * - Between-loop configuration arbitration → use
 *   {@link createRecommendationSystem} (score-based strategy arbitration across
 *   historical runs)
 *
 * The picker is **stateless**: it owns no persistent refs. When `options.slot`
 * is provided, the Slot handles selection persistence. When omitted, selections
 * live in an internal array and are ephemeral.
 *
 * @see {@link createSlot} — the composition target for persistence
 */

import type { Slot } from './slot';

// === TYPES ===

/**
 * Score function. MUST be pure: no writes, no reactive reads.
 * The caller builds a fresh context snapshot once per pick cycle and passes it
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
 * Completion predicate. Returns `true` when a previously-selected candidate's
 * objective is met and the slot should be freed.
 */
export type GoalCompletionFn<TCandidate, TContext> = (
  candidateId: TCandidate,
  context: TContext,
) => boolean;

/** Result of one {@link GoalPicker.pick} cycle — a diff over active selections. */
export interface GoalPickResult<TCandidate> {
  /** Candidates newly selected this cycle (not previously active). */
  readonly selected: readonly TCandidate[];
  /** Candidates deselected this cycle because their completion predicate fired. */
  readonly swept: readonly TCandidate[];
  /** All candidates active after this pick cycle. */
  readonly active: readonly TCandidate[];
}

/** Configuration for {@link createGoalPicker}. */
export interface GoalPickerOptions<TCandidate, TContext, TWeights> {
  /**
   * Returns the full pool of eligible candidate IDs for this pick cycle.
   * Called once per `pick()`. The caller controls eligibility filtering — the
   * picker does not enforce uniqueness, visibility, or cross-slot exclusion.
   */
  pool: () => readonly TCandidate[];

  /**
   * Current weights vector (personality, policy, difficulty). Passed verbatim
   * to the scorer. Function form supports reactive weights (e.g., a personality
   * slot ratchet); plain-value form supports static weights.
   */
  weights: TWeights | (() => TWeights);

  /** The score function. See {@link GoalScorerFn}. */
  scorer: GoalScorerFn<TCandidate, TContext, TWeights>;

  /**
   * Called on each currently-active candidate at the top of every `pick()`.
   * Returning `true` deselects it and frees the slot for refill.
   * If omitted, selections persist until the caller deselects manually.
   */
  isCompleted?: GoalCompletionFn<TCandidate, TContext>;

  /**
   * Maximum concurrent selections. Function form supports reactive capacity
   * (e.g., growing via purchases — the slot-ratchet pattern). Default: `1`.
   */
  capacity?: number | (() => number);

  /**
   * Externally-managed Slot to write selections into. When provided, selection
   * state persists with the slot and integrates with its `canSelect` /
   * `onSelect` / `onDeselect` hooks. When omitted, the picker holds an internal
   * array (no persistence). Using a Slot requires `TCandidate extends string`.
   */
  slot?: Slot;

  /**
   * Selection lifecycle. Default `'persistent'`.
   *
   * - `'persistent'` — selections survive across `pick()` calls; sweep via
   *   `isCompleted`. Right for AI-bot-watching-its-own-goals shapes where the
   *   selection is a long-running commitment.
   * - `'fresh-each-cycle'` — every previously-active candidate is deselected at
   *   the top of each `pick()` and reported in `swept`; capacity is always
   *   fully open per pick. Right for "rank a candidate pool for this turn /
   *   this loop only" shapes where selections are ephemeral. `isCompleted`
   *   becomes redundant under this mode (the active set is empty before the
   *   predicate would run).
   *
   * Under `'fresh-each-cycle'` with a Slot, `slot.deselect` fires its
   * `onDeselect` hook for every previously-active candidate each cycle.
   */
  mode?: 'persistent' | 'fresh-each-cycle';

  /**
   * Profiling hook. Fires once per `pick()` call AFTER the slot has been
   * updated. Receives the diff result.
   *
   * MUST NOT mutate state visible to the next `pick()` call — the callback is
   * for instrumentation (analyzers, profile counters, debug logging), not
   * control flow.
   */
  onPick?: (result: GoalPickResult<TCandidate>) => void;
}

/** A goal picker instance, returned by {@link createGoalPicker}. */
export interface GoalPicker<TCandidate, TContext, TWeights> {
  /**
   * Run one pick cycle:
   *   1. If `mode` is `'fresh-each-cycle'`, deselect every active candidate
   *      and add them to `swept`.
   *   2. Sweep completed selections (calls `isCompleted` on each remaining
   *      active).
   *   3. Score all non-active pool members.
   *   4. Fill open capacity from top-scoring set, descending by score.
   *   5. Fire `onPick` callback if provided.
   *
   * The caller owns the context snapshot. Context must be fresh; the picker
   * does not subscribe to reactive dependencies and will not re-run on its own.
   */
  pick(context: TContext): GoalPickResult<TCandidate>;

  /**
   * Currently active candidates. Backed by a slot, it is live. Without one it
   * is a snapshot of the internal array: a computed over it never recomputes,
   * so re-read it after each `pick()`.
   */
  readonly active: readonly TCandidate[];

  /** Replace the weights value or getter for the next `pick()` call. */
  setWeights(weights: TWeights | (() => TWeights)): void;
}

// === PRIVATE BUILDERS ===

function normalizeWeights<T>(w: T | (() => T)): () => T {
  return typeof w === 'function' ? (w as () => T) : () => w;
}

function normalizeCapacity(c: number | (() => number) | undefined): () => number {
  if (c == null) return () => 1;
  if (typeof c === 'function') return c;
  return () => c;
}

// === FACTORIES ===

/**
 * Creates a weighted-goal picker over a candidate pool.
 *
 * @param options - Pool, weights, scorer, and optional completion predicate,
 *   capacity, slot, and profiling callback
 * @returns A {@link GoalPicker} with an imperative `pick(context)` method, a
 *   live `active` accessor, and `setWeights` for personality swaps
 *
 * @example
 * ```ts
 * // Multi-slot linear-weighted scoring:
 * const picker = createGoalPicker<GoalId, WorldView, AiWeights>({
 *   pool: () => goalPoolFor(faction),
 *   weights: () => AI_PERSONALITIES[factionPersonality],
 *   scorer: (id, w, world) => scoreGoal(id, w, world),
 *   isCompleted: (id, world) => isGoalDone(id, world),
 *   capacity: () => factionCapacity.value,
 *   slot: factionSlot,
 * });
 *
 * // In tick loop:
 * const world = buildWorldView();
 * picker.pick(world);
 *
 * // Single-slot priority-table scoring:
 * const bot = createGoalPicker<GoalType, BotContext, PersonalityConfig>({
 *   pool: () => ALL_GOAL_TYPES,
 *   weights: () => context.effectiveConfig,
 *   scorer: (g) => GOAL_PRIORITY[g],
 *   isCompleted: (g, ctx) => !isGoalStillValid(g, ctx),
 *   capacity: 1,
 * });
 * ```
 */
export function createGoalPicker<TCandidate, TContext, TWeights>(
  options: GoalPickerOptions<TCandidate, TContext, TWeights>,
): GoalPicker<TCandidate, TContext, TWeights> {
  const { pool, scorer, isCompleted, slot, onPick, mode = 'persistent' } = options;

  let getWeights = normalizeWeights(options.weights);
  const getCapacity = normalizeCapacity(options.capacity);

  const internal: TCandidate[] = [];

  function readActive(): readonly TCandidate[] {
    if (slot != null) return slot.selected.value as unknown as readonly TCandidate[];
    return internal;
  }

  function addSelection(id: TCandidate): boolean {
    if (slot != null) {
      return slot.select(id as unknown as string);
    }
    internal.push(id);
    return true;
  }

  function removeSelection(id: TCandidate): boolean {
    if (slot != null) {
      return slot.deselect(id as unknown as string);
    }
    const idx = internal.indexOf(id);
    if (idx === -1) return false;
    internal.splice(idx, 1);
    return true;
  }

  function isActive(id: TCandidate): boolean {
    if (slot != null) return slot.isSelected(id as unknown as string);
    return internal.includes(id);
  }

  function pick(context: TContext): GoalPickResult<TCandidate> {
    const swept: TCandidate[] = [];

    if (mode === 'fresh-each-cycle') {
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
