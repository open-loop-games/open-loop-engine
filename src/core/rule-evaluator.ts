/**
 * Rule evaluator — pure `evaluate(state) → action` primitive for consumer-driven rule sets
 *
 * Walks an ordered rule list top-to-bottom, returning the first matching rule's
 * action with structured {@link EvaluatorResult.ruleIndex} attribution. When no
 * rule matches, optionally consults a caller-owned fallback list (the OTHERWISE
 * surface), returning the first entry whose `canUse` predicate passes.
 *
 * **Lifecycle:** the caller invokes {@link RuleEvaluator.evaluate} explicitly —
 * mid-cycle, preemptively, or wherever its control flow needs a decision. Compare
 * {@link createConditionalStrategy}, which is a `FillStrategy` invoked by the
 * Sequencer when its queue runs dry. Same "first rule wins" shape, different
 * lifecycle — hence the separate primitive.
 *
 * **When to reach for this:**
 * - Consumer drives invocation explicitly (not the sequencer)
 * - Profile-attributed rule firing matters (per-rule counters, dispatch logs)
 * - Mid-cycle preemption is a feature, not a workaround
 *
 * **When not to reach for this:**
 * - Sequencer-driven queue filling → use {@link createConditionalStrategy}
 * - Weighted top-N selection over a pool → use `createGoalPicker`
 *
 * The evaluator is **stateless**: it owns no persistent refs. Rule storage
 * (including the fallback list) lives caller-side, typically as `persistent()`
 * refs in the consuming module.
 *
 * Predicates are fully consumer-defined closures over a context snapshot the
 * caller builds before each `evaluate()` — the engine ships no predicate library
 * and never introspects `TState` or `TAction`.
 */

// === TYPES ===
/**
 * One rule — a predicate closure over a context snapshot, mapped to an action.
 *
 * The engine never introspects `TAction`; consumers map to spell IDs, item
 * actions, or whatever dispatch target their module uses.
 */
export interface EvaluatorRule<TState, TAction> {
  /**
   * Pure predicate over the caller's context snapshot. MUST NOT do reactive
   * reads — the snapshot must be built once by the caller before `evaluate()`
   * runs. The snapshot-not-closure model is intentional: it keeps evaluations
   * deterministic under headless replay and testable without a reactive scope.
   */
  condition: (state: TState) => boolean;
  /** The action to dispatch when this rule matches. */
  action: TAction;
}

/** Structured result of one {@link RuleEvaluator.evaluate} pass. */
export interface EvaluatorResult<TAction> {
  /**
   * `true` when a named rule matched; `false` when the fallback fired or
   * nothing was eligible.
   */
  matched: boolean;
  /**
   * Index of the matching rule in the rules array, or `-1` for fallback and
   * no-match. Profiling consumers attribute per-rule firings by this index.
   */
  ruleIndex: number;
  /**
   * The resolved action. Invariants:
   * - `matched: true`  → non-null `action`, `ruleIndex >= 0`
   * - `matched: false` + non-null `action` → fallback fired, `ruleIndex === -1`
   * - `matched: false` + null `action`     → nothing matched and no eligible
   *   fallback, `ruleIndex === -1`
   */
  action: TAction | null;
}

/** Configuration for {@link createRuleEvaluator}. */
export interface RuleEvaluatorOptions<TState, TAction> {
  /**
   * Returns the current rule list. Called once per `evaluate()` call — the
   * list MAY change at runtime (e.g., player editing automation rules).
   */
  getRules: () => EvaluatorRule<TState, TAction>[];

  /**
   * Optional fallback action list, consulted top-to-bottom when no rule
   * matches. Returns the first action for which `canUse` returns `true` (or
   * the first entry unconditionally when `canUse` is omitted).
   *
   * Omit for no-fallback behavior — `evaluate()` returns
   * `{ matched: false, ruleIndex: -1, action: null }` on no-match.
   */
  getFallback?: () => TAction[];

  /**
   * Optional affordability/availability check for fallback entries. If
   * omitted, the first fallback entry is always returned. MUST read from
   * `state` only, not reactive sources outside the snapshot.
   */
  canUse?: (action: TAction, state: TState) => boolean;

  /**
   * Profiling hook. Fires once per `evaluate()` call AFTER the result is
   * computed and BEFORE `evaluate()` returns. Receives the same state
   * snapshot passed to `evaluate()` so consumers can record context-dependent
   * attribution (e.g., encounter ID, combo state).
   *
   * MUST NOT mutate state visible to the result — this is for instrumentation
   * (dispatch logs, per-rule counters, debug tracing), not control flow.
   */
  onEvaluate?: (result: EvaluatorResult<TAction>, state: TState) => void;
}

/** A rule evaluator instance, returned by {@link createRuleEvaluator}. */
export interface RuleEvaluator<TState, TAction> {
  /**
   * Evaluate rules against the given state snapshot. Pure: no reactive reads
   * inside. The snapshot must be built by the caller before invocation.
   */
  evaluate(state: TState): EvaluatorResult<TAction>;
}

// === FACTORY ===
/**
 * Creates a pure rule evaluator over consumer-provided state and action types.
 *
 * @param options - Rule-list getter, and optional fallback list, affordability
 *   predicate, and profiling callback
 * @returns A {@link RuleEvaluator} with an imperative `evaluate(state)` method
 *
 * @example
 * ```ts
 * // Spell-compiler automation shape: rules over encounter state, spell IDs
 * // as actions, fallback priority list for OTHERWISE, profiler hook for
 * // per-rule dispatch counters.
 * const evaluator = createRuleEvaluator<EvalContext, SpellId>({
 *   getRules: () =>
 *     ruleSets.value[encounterId].rules.map((r) => ({
 *       condition: (s) => conditionMatches(r.condition, s),
 *       action: r.spellId,
 *     })),
 *   getFallback: () => ruleSets.value[encounterId].otherwise.spellIds,
 *   canUse: (spellId, s) => s.canCast(spellId),
 *   onEvaluate: (result, s) => loopLog.recordRuleDispatch(result, s),
 * });
 *
 * // Called by the consumer's control flow (not by a sequencer):
 * const snapshot = buildEvalContext();
 * const { action } = evaluator.evaluate(snapshot);
 * if (action != null) spells.preempt(action);
 * ```
 */
export function createRuleEvaluator<TState, TAction>(
  options: RuleEvaluatorOptions<TState, TAction>,
): RuleEvaluator<TState, TAction> {
  const { getRules, getFallback, canUse, onEvaluate } = options;

  function evaluate(state: TState): EvaluatorResult<TAction> {
    const rules = getRules();
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]!;
      if (rule.condition(state)) {
        const matched: EvaluatorResult<TAction> = {
          matched: true,
          ruleIndex: i,
          action: rule.action,
        };
        onEvaluate?.(matched, state);
        return matched;
      }
    }

    let fallbackAction: TAction | null = null;
    if (getFallback != null) {
      const fallback = getFallback();
      for (const action of fallback) {
        if (canUse == null || canUse(action, state)) {
          fallbackAction = action;
          break;
        }
      }
    }

    const result: EvaluatorResult<TAction> = {
      matched: false,
      ruleIndex: -1,
      action: fallbackAction,
    };
    onEvaluate?.(result, state);
    return result;
  }

  return {
    evaluate,
  };
}
