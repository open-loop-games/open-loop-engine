/**
 * Rule advisor — reduces history to a digest and ranks advisor analyzer suggestions
 *
 * Reads entries from a {@link CycleLog} (the usual case) or a caller-supplied
 * function (BYO history). A `digest` function reduces them to a digest.
 * Caller-supplied `analyzers` read the digest and a parallel `context` value.
 * The advisor ranks and caps the merged suggestion list, and exposes a
 * dismissable view with inferred-acceptance bookkeeping. Generic over entry,
 * digest, payload and advisor-analyzer context shapes; the engine never
 * inspects any of them.
 *
 * **Trigger split (vs {@link createRecommendationSystem}):** this system
 * covers the *consumer-triggered* shape: it re-evaluates on rule edits,
 * encounter changes or any caller-defined trigger. RecommendationSystem
 * covers the *between-run* shape: `cycle.on('afterEnd')` re-evaluates it, and
 * it picks one configuration for the next run. Both are advisory by design.
 *
 * **When to use this:**
 * - Multiple independent heuristics each produce zero or more suggestions
 * - Output is a ranked list, individually dismissable
 * - Trigger cadence is consumer-driven (rule edits, encounter changes, ticks)
 *
 * **When not to use this:**
 * - Between-run configuration arbitration → use {@link createRecommendationSystem}
 * - Sequencer-driven queue filling → use `createConditionalStrategy`
 * - Weighted top-N selection over a candidate pool → use `createGoalPicker`
 *
 * The advisor **saves nothing**: it owns only an ephemeral dismissal set and
 * last-visible-ids cache. Persistent counters (apply and dismiss tallies) are
 * the caller's own `persistent()` refs.
 *
 * @see {@link createCycleLog} for the usual history source
 * @see {@link createRecommendationSystem} for the between-run sibling
 */

import { shallowRef } from 'vue';
import { resolveComputable, type Computable } from '@/core/computed';
import { createEmitHandle, type Emittable } from '@/core/events';
import type { CycleLog, CycleLogEntry } from './cycle-log';

// === TYPES ===

/**
 * One entry of the advisor's ranked list. The `id` is its stable identity
 * for dismissal and inferred acceptance. An advisor analyzer that produces
 * the same logical suggestion across `reevaluate()` calls MUST give it the same id.
 */
export interface Suggestion<TPayload = unknown> {
  /** Stable identity for dismissal + inferred-acceptance tracking. */
  id: string;
  /** Sort rank in the default rank function (warnings before infos). */
  severity: 'info' | 'warning';
  /** Display text, formatted by the caller. */
  summary: string;
  /** Domain-specific payload. The engine never inspects this. */
  payload: TPayload;
  /**
   * Optional apply function. When present, a UI MAY show an "apply" control;
   * the engine never calls it.
   */
  apply?: () => void;
}

/**
 * History source — either a {@link CycleLog} (the usual case, equivalent to
 * `() => cycleLog.history.value`) or a caller-supplied function returning the
 * entry list. The function form is the typed path: `TEntry` is inferred from
 * the return type, so consumers don't spell generics. The CycleLog form is the
 * shorthand for the engine's own tracked metric source; its entries are
 * `CycleLogEntry` values.
 *
 * Read fresh on each `reevaluate()` — pass a stable function reference; the
 * engine doesn't memoize.
 */
export type HistorySource<TEntry> = CycleLog | (() => readonly TEntry[]);

/**
 * Digest function — reduces history to the digest the advisor analyzers read.
 * Generic over the consumer's entry, digest and parallel-context shapes.
 *
 * Receives the entry list from {@link HistorySource} plus the same `context`
 * value the advisor analyzers receive (see {@link AdvisorAnalyzerFn}). The
 * digest function owns any windowing, fingerprint filtering or minimum-sample check;
 * the engine ships none of that.
 *
 * `TContext` defaults to `undefined`, so a digest function that doesn't need
 * context can ignore the second argument; the engine still passes `undefined`.
 *
 * MUST be pure; called once per `reevaluate()`.
 */
export type AdvisorDigestFn<TEntry, TDigest, TContext = undefined> = (
  history: readonly TEntry[],
  context: TContext,
) => TDigest;

/**
 * Advisor analyzer function — a domain-specific heuristic that reads the
 * digest and the parallel `context` value, and returns zero or more
 * suggestions. Multiple advisor analyzers compose; their outputs are
 * concatenated and re-ranked.
 *
 * `TContext` defaults to `undefined`, so an advisor analyzer that doesn't need
 * context can ignore the second argument; the engine still passes `undefined`.
 */
export type AdvisorAnalyzerFn<TDigest, TPayload, TContext = undefined> = (
  digest: TDigest,
  context: TContext,
) => readonly Suggestion<TPayload>[];

/**
 * Comparator for ranking the merged suggestion list. Default: warnings first,
 * then advisor analyzer order (stable sort).
 */
export type SuggestionRankFn<TPayload> = (
  a: Suggestion<TPayload>,
  b: Suggestion<TPayload>,
) => number;

/**
 * Options for {@link createRuleAdvisor}.
 *
 * Generic ordering: `TEntry` and `TDigest` reach the digest function and the
 * advisor analyzers; `TPayload` reaches the returned advisor. `TContext` defaults to `undefined`
 * so context-free callers can omit it entirely. With inference-first design,
 * call sites spell none of these out in practice. The function form of
 * `historySource`, the `context` value, ref or getter, and the advisor analyzer
 * return types give TypeScript enough to infer them all.
 */
export interface RuleAdvisorOptions<TEntry, TDigest, TPayload, TContext = undefined> {
  /**
   * History source. Pass a {@link CycleLog} for the usual case, or a
   * function returning the entry list for BYO history. Function form is the
   * typed path — `TEntry` is inferred from the return type.
   */
  historySource: HistorySource<TEntry>;

  /**
   * Reduces history to the digest. Called each `reevaluate()`, with the
   * resolved `context` value as the second argument, as advisor analyzers
   * are. The simplest digest (a window of 1) returns the last entry alone. A richer
   * one reads the history newest-to-oldest, with a fingerprint filter on the
   * context's rule set and a window cap.
   */
  digest: AdvisorDigestFn<TEntry, TDigest, TContext>;

  /**
   * Advisor analyzer list. Each is called with the digest and the resolved
   * `context` value; outputs are merged. Order is the tiebreaker in the
   * default rank function. Domain-specific heuristics stay caller-side — the
   * engine ships zero advisor analyzers.
   */
  analyzers: ReadonlyArray<AdvisorAnalyzerFn<TDigest, TPayload, TContext>>;

  /**
   * Parallel context passed to the digest function and every advisor
   * analyzer. Use for state that *isn't* a function of history — e.g. the current rule
   * set, the current encounter id. A plain value for a fixed context, a
   * ref or getter for a changing one (re-read each `reevaluate()`).
   *
   * Omit when the advisor analyzers don't need context; they receive
   * `undefined`, and `TContext` infers to `undefined`.
   */
  context?: Computable<TContext>;

  /**
   * Ranking comparator. Defaults to severity (warnings first), then array
   * order (stable). Pass your own comparator instead (e.g. a KIND_RANK
   * lookup).
   */
  rank?: SuggestionRankFn<TPayload>;

  /**
   * Cap on suggestions per `reevaluate()`. A plain number for a fixed cap, a
   * ref or getter for a changing cap (e.g. a UI density toggle). Default:
   * `Infinity` (no cap).
   */
  maxSuggestions?: Computable<number>;

  /**
   * Observe-only option callback. Called once per `reevaluate()`, AFTER
   * digest, rank and cap, BEFORE dismissed ids are removed. Its list is what
   * the advisor analyzers produced, so it tracks their output apart from the
   * player's dismissals.
   *
   * MUST NOT mutate state visible to the next `reevaluate()` call.
   */
  onDigest?: (digest: TDigest, suggestions: readonly Suggestion<TPayload>[]) => void;
}

/** Events emitted by a {@link RuleAdvisor} instance. */
export interface RuleAdvisorEvents<TPayload> {
  /** Emitted after each `reevaluate()` and `dismiss()` with the new visible suggestion list. */
  suggestionsUpdated: (suggestions: readonly Suggestion<TPayload>[]) => void;
  /** Emitted when `dismiss(id)` is called for an id not already dismissed. */
  dismissed: (id: string) => void;
  /**
   * Emitted when a `reevaluate()` finds the advisor analyzers no longer
   * produce one or more previously-visible, undismissed ids: the inferred acceptance. An
   * id that a higher-ranked suggestion pushed below the cap is still
   * produced, so it doesn't count. `trigger` is whatever the caller passed
   * to `reevaluate()`; the engine never inspects it. So consumers can tell
   * an edit-triggered disappearance (often an acceptance) from a run-end
   * one (often not).
   */
  accepted: (info: { keys: readonly string[]; trigger: string | undefined }) => void;
}

/** A rule advisor instance, returned by {@link createRuleAdvisor}. */
export interface RuleAdvisor<TPayload> {
  /**
   * Currently-visible suggestions: ranked, dismissed ids removed, then
   * capped — a dismissed suggestion's place goes to the next-ranked one.
   * Reactive: a computed over it recomputes after `reevaluate()` and `dismiss()`.
   */
  readonly suggestions: readonly Suggestion<TPayload>[];

  /**
   * Re-run digest, analysis and rank, remove dismissed ids, cap, emit
   * `'suggestionsUpdated'`, and emit `'accepted'` for previously-visible ids
   * the advisor analyzers no longer produce.
   *
   * The optional `trigger` is opaque to the engine. It is passed through to
   * the `'accepted'` payload, so consumers can filter (e.g. count only
   * edit-triggered disappearance as inferred acceptance, and ignore run-end
   * ones).
   *
   * Idempotent over identical history + dismissal state. The caller decides
   * when to call it (cycle `afterEnd`, rule edits and encounter changes are
   * the usual triggers).
   */
  reevaluate(trigger?: string): readonly Suggestion<TPayload>[];

  /**
   * Hide a suggestion until {@link reset} is called. No-op if `id` is
   * already dismissed. Removes it from the `suggestions` view at once; the
   * next-ranked suggestion from the last `reevaluate()` takes its place.
   * Emits `'dismissed'`, then `'suggestionsUpdated'`.
   */
  dismiss(id: string): void;

  /**
   * Clear the dismissal set AND the last-visible-ids cache. Use when the
   * game situation changes so old ids are no longer comparable (encounter
   * switch, rule-set fingerprint change). Suppresses spurious `'accepted'`
   * events on the next `reevaluate()`.
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

function normalizeMaxSuggestions(c: Computable<number> | undefined): () => number {
  if (c == null) return () => Infinity;
  return () => resolveComputable(c);
}

function capList<T>(list: T[], cap: number): T[] {
  return cap < list.length ? list.slice(0, cap) : list;
}

function resolveHistory<TEntry>(source: HistorySource<TEntry>): readonly TEntry[] {
  if (typeof source === 'function') return source();
  return source.history.value as unknown as readonly TEntry[];
}

function resolveContext<TContext>(context: Computable<TContext> | undefined): TContext {
  return (context === undefined ? undefined : resolveComputable(context)) as TContext;
}

// === FACTORIES ===

/**
 * Create a rule advisor. It reduces history to a digest, runs advisor
 * analyzers over the digest and a parallel context value, and presents a ranked,
 * dismissable suggestion list.
 *
 * Overloaded so that inference works for both `historySource` shapes — passing
 * a {@link CycleLog} pins `TEntry` to {@link CycleLogEntry}; passing a function
 * infers `TEntry` from its return type.
 *
 * @param options - History source, digest function and advisor analyzers; optional context, rank, cap and `onDigest`
 * @returns A {@link RuleAdvisor} with `reevaluate` / `dismiss` / `reset` and events
 *
 * @example
 * ```ts
 * // History advisor with a parallel rule-set context:
 * const advisor = createRuleAdvisor({
 *   historySource: cycleLog,
 *   context: () => ({ ruleSet: currentRuleSet.value, encounterId: currentEncounterId.value }),
 *   digest: (history, ctx) => digestRuleHistory(history, ctx.ruleSet, ctx.encounterId),
 *   analyzers: [
 *     (d) => narrowOtherwiseSuggestion(d),
 *     (d, ctx) => hazardGapSuggestions(d, ctx.ruleSet),
 *     (d, ctx) => unusedRuleSuggestions(d, ctx.ruleSet),
 *   ],
 *   rank: (a, b) => KIND_RANK[a.payload.kind] - KIND_RANK[b.payload.kind],
 *   maxSuggestions: 3,
 * });
 *
 * // Caller-side trigger wiring with trigger labels:
 * cycle.on('afterEnd', () => advisor.reevaluate('cycle'));
 * watch(() => ruleSets.value, () => { advisor.reset(); advisor.reevaluate('edit'); });
 *
 * // Inferred-acceptance only counts edit-triggered drops:
 * advisor.on('accepted', ({ keys, trigger }) => {
 *   if (trigger === 'edit') tallyAccepted(keys.length);
 * });
 *
 * // BYO history (function form — TEntry inferred from return type):
 * const advisor = createRuleAdvisor({
 *   historySource: () => cycleRecords,
 *   digest: (history) => digestCycleRecords(history),
 *   analyzers: [emergingPatternAnalyzer],
 * });
 * ```
 */
export function createRuleAdvisor<TDigest, TPayload, TContext = undefined>(
  options: Omit<RuleAdvisorOptions<CycleLogEntry, TDigest, TPayload, TContext>, 'historySource'> & {
    historySource: CycleLog;
  },
): RuleAdvisor<TPayload>;
export function createRuleAdvisor<TEntry, TDigest, TPayload, TContext = undefined>(
  options: Omit<RuleAdvisorOptions<TEntry, TDigest, TPayload, TContext>, 'historySource'> & {
    historySource: () => readonly TEntry[];
  },
): RuleAdvisor<TPayload>;
export function createRuleAdvisor<TEntry, TDigest, TPayload, TContext = undefined>(
  options: RuleAdvisorOptions<TEntry, TDigest, TPayload, TContext>,
): RuleAdvisor<TPayload> {
  const { historySource, digest: reduce, analyzers, context, rank, onDigest } = options;

  const getMaxSuggestions = normalizeMaxSuggestions(options.maxSuggestions);
  const rankFn: SuggestionRankFn<TPayload> = rank ?? defaultRank;
  const handle = createEmitHandle<RuleAdvisorEvents<TPayload>>();

  let dismissed = new Set<string>();
  let lastVisibleKeys: string[] = [];
  const visible = shallowRef<readonly Suggestion<TPayload>[]>([]);
  // The last reevaluate's ranked, uncapped output, so a dismissal re-projects
  // it and the next-ranked suggestion takes the freed place.
  let ranked: readonly Suggestion<TPayload>[] = [];

  function project(cap: number): void {
    visible.value = capList(
      ranked.filter((s) => !dismissed.has(s.id)),
      cap,
    );
    lastVisibleKeys = visible.value.map((s) => s.id);
  }

  function reevaluate(trigger?: string): readonly Suggestion<TPayload>[] {
    const history = resolveHistory<TEntry>(historySource);
    const ctx = resolveContext<TContext>(context);
    const digest = reduce(history, ctx);

    const merged: Suggestion<TPayload>[] = [];
    for (const analyzer of analyzers) {
      const out = analyzer(digest, ctx);
      for (const s of out) merged.push(s);
    }

    merged.sort(rankFn);

    const cap = getMaxSuggestions();
    onDigest?.(digest, capList(merged, cap));

    // Acceptance means the advisor analyzers stopped producing the id; one a
    // higher-ranked suggestion pushed below the cap is still being produced.
    const producedKeys = new Set(merged.map((s) => s.id));

    const acceptedKeys: string[] = [];
    for (const key of lastVisibleKeys) {
      if (!producedKeys.has(key) && !dismissed.has(key)) acceptedKeys.push(key);
    }

    ranked = merged;
    project(cap);

    handle.emit('suggestionsUpdated', visible.value);
    if (acceptedKeys.length > 0) handle.emit('accepted', { keys: acceptedKeys, trigger });

    return visible.value;
  }

  function dismiss(key: string): void {
    if (dismissed.has(key)) return;
    dismissed.add(key);
    project(getMaxSuggestions());
    handle.emit('dismissed', key);
    handle.emit('suggestionsUpdated', visible.value);
  }

  function reset(): void {
    dismissed = new Set();
    lastVisibleKeys = [];
  }

  return {
    get suggestions() {
      return visible.value;
    },
    reevaluate,
    dismiss,
    reset,
    on: handle.on,
  };
}
