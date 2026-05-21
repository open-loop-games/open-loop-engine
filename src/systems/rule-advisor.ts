/**
 * Rule advisor — intra-session profile-history aggregator with ranked suggestions
 *
 * Pulls entries from a {@link LoopLog} (canonical case, entries are
 * loop-log shaped) or a caller-supplied function (BYO history) through an
 * `aggregate` step, runs caller-supplied
 * `analyzers` over the resulting profile and a parallel `context` value, ranks
 * + caps the merged suggestion list, and exposes a dismissable view with
 * inferred-acceptance bookkeeping. Generic over entry, profile, payload, and
 * analyzer-context shapes — the engine never introspects any of them.
 *
 * **Time-horizon split (vs {@link createRecommendationSystem}):** this primitive
 * covers the *intra-session* shape (re-fired on rule edits, encounter changes,
 * or any caller-defined signal). RecommendationSystem covers the *inter-loop*
 * shape (re-fired by `loop.on('afterRestart')`, picks one configuration to apply
 * next loop). Both surfaces ship; both stay advisory by design.
 *
 * **When to reach for this:**
 * - Multiple independent heuristics each emit zero-or-more suggestions
 * - Output is a ranked list, individually dismissable
 * - Trigger cadence is consumer-driven (rule edits, encounter changes, ticks)
 *
 * **When not to reach for this:**
 * - Between-loop configuration arbitration → use {@link createRecommendationSystem}
 * - Sequencer-driven queue filling → use `createConditionalStrategy`
 * - Weighted top-N selection over a candidate pool → use `createGoalPicker`
 *
 * The advisor is **stateless across save/load**: it owns only an ephemeral
 * dismissal set and last-visible-keys cache. Persistent counters (apply/dismiss
 * tallies) live caller-side as `persistent()` refs.
 *
 * @see {@link createLoopLog} for the canonical history source
 * @see {@link createRecommendationSystem} for the inter-loop sibling
 */

import { createEmitHandle, type Emittable } from '@/core/events';
import type { LoopLog, LoopLogEntry } from './loop-log';

// === TYPES ===

/**
 * One advisory output. The `key` is the stable identity used for dismissal
 * tracking and inferred-acceptance bookkeeping — a heuristic that produces
 * the same logical suggestion across reevaluate() calls MUST emit the same key.
 */
export interface Suggestion<TPayload = unknown> {
  /** Stable identity for dismissal + inferred-acceptance tracking. */
  key: string;
  /** Sort tier in the default ranker (warnings beat infos). */
  severity: 'info' | 'warning';
  /** Human-readable summary text. Caller-formatted. */
  summary: string;
  /** Domain-specific payload. The engine never introspects this. */
  payload: TPayload;
  /**
   * Optional auto-apply thunk. When provided, callers MAY render an "apply"
   * affordance; the engine never invokes this.
   */
  apply?: () => void;
}

/**
 * History source — either a {@link LoopLog} (canonical case, equivalent to
 * `() => loopLog.history.value`) or a caller-supplied function returning the
 * entry list. The function form is the typed path: `TEntry` is inferred from
 * the return type, so consumers don't spell generics. The LoopLog form is the
 * shorthand for the engine's canonical metric source; entries are
 * loop-log shaped at runtime.
 *
 * Read fresh on each `reevaluate()` — pass a stable function reference; the
 * engine doesn't memoize.
 */
export type HistorySource<TEntry> = LoopLog | (() => readonly TEntry[]);

/**
 * Aggregator function — the windowed-history substrate, generic over the
 * consumer's entry, profile, and parallel-context shapes.
 *
 * Receives the entry list from {@link HistorySource} plus the same `context`
 * value the analyzers receive (see {@link AdvisorAnalyzerFn}). The aggregator
 * owns any windowing, fingerprint filtering, or minimum-sample gating — the
 * engine ships none of that.
 *
 * `TContext` defaults to `undefined`, so aggregators that don't need context
 * can ignore the second argument — the engine still calls with `undefined`.
 *
 * MUST be pure; called once per `reevaluate()`.
 */
export type AdvisorAggregatorFn<TEntry, TProfile, TContext = undefined> = (
  history: readonly TEntry[],
  context: TContext,
) => TProfile;

/**
 * Analyzer function — domain-specific heuristic that consumes the aggregate
 * plus the parallel `context` value and returns zero or more suggestions.
 * Multiple analyzers compose; their outputs are concatenated and re-ranked.
 *
 * `TContext` defaults to `undefined`, so analyzers that don't need context can
 * ignore the second argument — the engine still calls with `undefined`.
 */
export type AdvisorAnalyzerFn<TProfile, TPayload, TContext = undefined> = (
  profile: TProfile,
  context: TContext,
) => readonly Suggestion<TPayload>[];

/**
 * Comparator for ranking the merged suggestion list. Default: warnings first,
 * then analyzer registration order (stable).
 */
export type SuggestionRankFn<TPayload> = (
  a: Suggestion<TPayload>,
  b: Suggestion<TPayload>,
) => number;

/**
 * Configuration for {@link createRuleAdvisor}.
 *
 * Generic ordering: `TEntry` and `TProfile` reach the aggregator + analyzers;
 * `TPayload` reaches the returned advisor. `TContext` defaults to `undefined`
 * so context-free callers can omit it entirely. With inference-first design,
 * none of these are spelled out at call sites in practice — the function form
 * of `historySource`, the value/getter form of `context`, and the analyzer
 * return types carry enough information for full inference.
 */
export interface RuleAdvisorOptions<TEntry, TProfile, TPayload, TContext = undefined> {
  /**
   * History source. Pass a {@link LoopLog} for the canonical engine case
   * (entries are loop-log shaped) or a function returning the entry list for
   * BYO history. Function form is the typed path — `TEntry` is inferred from
   * the return type.
   */
  historySource: HistorySource<TEntry>;

  /**
   * History-window aggregator. Called fresh each `reevaluate()` with the
   * resolved `context` value as the second argument (mirroring the analyzer
   * shape). The Cookie Monster degenerate case (window = 1,
   * current-state-only advisory) returns the last entry alone; spell-compiler
   * walks the history newest-to-oldest with a fingerprint filter keyed off
   * the context's rule-set and a window cap.
   */
  aggregate: AdvisorAggregatorFn<TEntry, TProfile, TContext>;

  /**
   * Analyzer list. Each is called with the aggregate and the resolved
   * `context` value; outputs are merged. Order is the tiebreaker in the
   * default rank function. Domain-specific heuristics stay caller-side — the
   * engine ships zero analyzers.
   */
  analyzers: ReadonlyArray<AdvisorAnalyzerFn<TProfile, TPayload, TContext>>;

  /**
   * Parallel context passed to every analyzer alongside the aggregated
   * profile. Use for state that *isn't* a function of history — e.g., the
   * current rule set, the active encounter id. Plain value for static
   * context, getter for live context (re-read each `reevaluate()`).
   *
   * Omit when analyzers don't need context; analyzers receive `undefined` and
   * `TContext` infers to `undefined`.
   */
  context?: TContext | (() => TContext);

  /**
   * Ranking comparator. Defaults to severity (warnings first), then array
   * order (stable). Pass a custom comparator to override (e.g., a
   * KIND_RANK lookup).
   */
  rank?: SuggestionRankFn<TPayload>;

  /**
   * Hard cap on suggestions emitted per reevaluate. Plain number for static
   * caps, getter for reactive caps (e.g., a UI density toggle). Default:
   * `Infinity` (no cap).
   */
  maxSuggestions?: number | (() => number);

  /**
   * Profiling hook. Fires once per `reevaluate()`, AFTER aggregation + rank +
   * cap, BEFORE dismissal filtering. The list passed reflects what the
   * heuristics produced — useful for tracking heuristic firing patterns
   * independent of user dismissals.
   *
   * MUST NOT mutate state visible to the next `reevaluate()` call.
   */
  onAggregate?: (profile: TProfile, suggestions: readonly Suggestion<TPayload>[]) => void;
}

/** Events emitted by a {@link RuleAdvisor} instance. */
export interface RuleAdvisorEvents<TPayload> {
  /** Fired after each `reevaluate()` with the new visible suggestion list. */
  suggestions: (suggestions: readonly Suggestion<TPayload>[]) => void;
  /** Fired when `dismiss(key)` is called for a key not already dismissed. */
  dismissed: (key: string) => void;
  /**
   * Fired when a `reevaluate()` removes one or more previously-visible keys
   * without an explicit `dismiss()` — the inferred-acceptance signal. The
   * `trigger` value is whatever the caller passed to `reevaluate()` (engine
   * never inspects it), letting consumers distinguish edit-triggered
   * disappearance (often counts as acceptance) from cycle-triggered drop
   * (often doesn't).
   */
  accepted: (info: { keys: readonly string[]; trigger: string | undefined }) => void;
}

/** A rule advisor instance, returned by {@link createRuleAdvisor}. */
export interface RuleAdvisor<TPayload> {
  /**
   * Currently-visible suggestions: post-rank, post-cap, post-dismissal-filter.
   * Plain readonly array; wrap in a Vue ref via the `'suggestions'` event if
   * reactive UI binding is needed.
   */
  readonly suggestions: readonly Suggestion<TPayload>[];

  /**
   * Re-run aggregation + analysis + rank + cap, apply dismissal filter, emit
   * `'suggestions'`, and fire `'accepted'` for any keys that were visible
   * before but absent now.
   *
   * The optional `trigger` is opaque to the engine — it threads through to
   * the `'accepted'` event payload, letting consumers filter (e.g., only
   * count edit-triggered disappearance as inferred acceptance, ignore
   * cycle-end ones).
   *
   * Idempotent over identical history + dismissal state. Caller decides when
   * to invoke (loop afterRestart, rule edits, encounter changes — the
   * canonical triggers).
   */
  reevaluate(trigger?: string): readonly Suggestion<TPayload>[];

  /**
   * Hide a suggestion until {@link reset} is called. No-op if `key` is
   * already dismissed. Removes the key from the live `suggestions` view
   * immediately and emits `'dismissed'`.
   */
  dismiss(key: string): void;

  /**
   * Clear the dismissal set AND the last-visible-keys cache. Use when the
   * domain context changes such that old keys are no longer comparable
   * (encounter switch, rule-set fingerprint change). Suppresses spurious
   * `'accepted'` events on the next `reevaluate()`.
   */
  reset(): void;

  /** Subscribe to advisor events. */
  on: Emittable<RuleAdvisorEvents<TPayload>>['on'];
}

// === CONSTANTS ===

const SEVERITY_ORDER: Record<Suggestion['severity'], number> = {
  warning: 0,
  info: 1,
};

// === PRIVATE BUILDERS ===

function defaultRank<TPayload>(a: Suggestion<TPayload>, b: Suggestion<TPayload>): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
}

function normalizeMaxSuggestions(c: number | (() => number) | undefined): () => number {
  if (c == null) return () => Infinity;
  if (typeof c === 'function') return c;
  return () => c;
}

function resolveHistory<TEntry>(source: HistorySource<TEntry>): readonly TEntry[] {
  if (typeof source === 'function') return source();
  return source.history.value as unknown as readonly TEntry[];
}

function resolveContext<TContext>(context: TContext | (() => TContext) | undefined): TContext {
  if (typeof context === 'function') {
    return (context as () => TContext)();
  }
  return context as TContext;
}

// === FACTORIES ===

/**
 * Create an intra-session advisor that aggregates history into a profile,
 * runs analyzers over the profile and a parallel context value, and surfaces
 * a ranked + dismissable suggestion list.
 *
 * Overloaded so that inference works for both `historySource` shapes — passing
 * a {@link LoopLog} pins `TEntry` to {@link LoopLogEntry}; passing a function
 * infers `TEntry` from its return type.
 *
 * @param options - History source, aggregate + analyzers, optional context/rank/cap/profile hook
 * @returns A {@link RuleAdvisor} with `reevaluate` / `dismiss` / `reset` and event hooks
 *
 * @example
 * ```ts
 * // Profile-history advisor with parallel rule-set context (spell-compiler shape):
 * const advisor = createRuleAdvisor({
 *   historySource: loopLog,
 *   context: () => ({ ruleSet: currentRuleSet.value, encounterId: currentEncounterId.value }),
 *   aggregate: (history, ctx) => aggregateRuleProfiles(history, ctx.ruleSet, ctx.encounterId),
 *   analyzers: [
 *     (agg) => narrowOtherwiseSuggestion(agg),
 *     (agg, ctx) => hazardGapSuggestions(agg, ctx.ruleSet),
 *     (agg, ctx) => deadRuleSuggestions(agg, ctx.ruleSet),
 *   ],
 *   rank: (a, b) => KIND_RANK[a.payload.kind] - KIND_RANK[b.payload.kind],
 *   maxSuggestions: 3,
 * });
 *
 * // Caller-side trigger wiring with trigger labels:
 * loop.on('afterRestart', () => advisor.reevaluate('cycle'));
 * watch(() => ruleSets.value, () => { advisor.reset(); advisor.reevaluate('edit'); });
 *
 * // Inferred-acceptance only counts edit-triggered drops:
 * advisor.on('accepted', ({ keys, trigger }) => {
 *   if (trigger === 'edit') tallyAccepted(keys.length);
 * });
 *
 * // BYO history (function form — TEntry inferred from return type):
 * const advisor = createRuleAdvisor({
 *   historySource: () => loopRecords,
 *   aggregate: (history) => aggregateLoopRecords(history),
 *   analyzers: [emergingPatternAnalyzer],
 * });
 * ```
 */
export function createRuleAdvisor<TProfile, TPayload, TContext = undefined>(
  options: Omit<RuleAdvisorOptions<LoopLogEntry, TProfile, TPayload, TContext>, 'historySource'> & {
    historySource: LoopLog;
  },
): RuleAdvisor<TPayload>;
export function createRuleAdvisor<TEntry, TProfile, TPayload, TContext = undefined>(
  options: Omit<RuleAdvisorOptions<TEntry, TProfile, TPayload, TContext>, 'historySource'> & {
    historySource: () => readonly TEntry[];
  },
): RuleAdvisor<TPayload>;
export function createRuleAdvisor<TEntry, TProfile, TPayload, TContext = undefined>(
  options: RuleAdvisorOptions<TEntry, TProfile, TPayload, TContext>,
): RuleAdvisor<TPayload> {
  const { historySource, aggregate, analyzers, context, rank, onAggregate } = options;

  const getMaxSuggestions = normalizeMaxSuggestions(options.maxSuggestions);
  const rankFn: SuggestionRankFn<TPayload> = rank ?? defaultRank;
  const handle = createEmitHandle<RuleAdvisorEvents<TPayload>>();

  let dismissed = new Set<string>();
  let lastVisibleKeys: string[] = [];
  let visible: readonly Suggestion<TPayload>[] = [];

  function reevaluate(trigger?: string): readonly Suggestion<TPayload>[] {
    const history = resolveHistory<TEntry>(historySource);
    const ctx = resolveContext<TContext>(context);
    const profile = aggregate(history, ctx);

    const merged: Suggestion<TPayload>[] = [];
    for (const analyzer of analyzers) {
      const out = analyzer(profile, ctx);
      for (const s of out) merged.push(s);
    }

    merged.sort(rankFn);

    const cap = getMaxSuggestions();
    const ranked = cap < merged.length ? merged.slice(0, cap) : merged;

    onAggregate?.(profile, ranked);

    const next = ranked.filter((s) => !dismissed.has(s.key));
    const nextKeys = new Set(next.map((s) => s.key));

    const acceptedKeys: string[] = [];
    for (const key of lastVisibleKeys) {
      if (!nextKeys.has(key) && !dismissed.has(key)) acceptedKeys.push(key);
    }

    visible = next;
    lastVisibleKeys = next.map((s) => s.key);

    handle.emit('suggestions', visible);
    if (acceptedKeys.length > 0) handle.emit('accepted', { keys: acceptedKeys, trigger });

    return visible;
  }

  function dismiss(key: string): void {
    if (dismissed.has(key)) return;
    dismissed.add(key);
    visible = visible.filter((s) => s.key !== key);
    lastVisibleKeys = visible.map((s) => s.key);
    handle.emit('dismissed', key);
    handle.emit('suggestions', visible);
  }

  function reset(): void {
    dismissed = new Set();
    lastVisibleKeys = [];
  }

  return {
    get suggestions() {
      return visible;
    },
    reevaluate,
    dismiss,
    reset,
    on: handle.on,
  };
}

// === PUBLIC UTILITIES ===
