# Advisors

Decision-support systems that observe the engine and rank actions: rule advisor, goal picker, recommendation system, and the selection policies they share. Candidates are abstract. Build board-based ones from influence layer readings in spatial.md.

## Canonical entrypoints

- `selectionCheapest`, `selectionPaybackPeriod`, `selectionHybridPayback`, `selectionComposite` — choose among candidates.
- `createGoalPicker` — pick weighted goals from a candidate pool.
- `createRecommendationSystem` — rank recommenders between runs, and present the winner.
- `createRuleAdvisor` — reduce history to a digest, and present ranked suggestions.

## Goal picker

weighted-goal selection over a candidate pool

- `function createGoalPicker<TCandidate, TContext, TWeights>(options: GoalPickerOptions<TCandidate, TContext, TWeights>): GoalPicker<TCandidate, TContext, TWeights>` — Creates a weighted-goal picker over a candidate pool. `src/systems/goal-picker.ts:215`
- `type GoalCompletionFn<TCandidate, TContext> = (candidateId: TCandidate, context: TContext) => boolean` — Completion predicate. `src/systems/goal-picker.ts:50`
- `interface GoalPicker<TCandidate, TContext, TWeights>` — A goal picker instance, returned by createGoalPicker. `src/systems/goal-picker.ts:140`
- `interface GoalPickerOptions<TCandidate, TContext, TWeights>` `src/systems/goal-picker.ts:69`
- `interface GoalPickResult<TCandidate>` — Result of one GoalPicker.pick — a diff over the active selections. `src/systems/goal-picker.ts:56`
- `type GoalScorerFn<TCandidate, TContext, TWeights> = (candidateId: TCandidate, weights: TWeights, context: TContext) => number` — Score function. `src/systems/goal-picker.ts:40`

## Selection policies

score-and-pick over a candidate list

- `interface HybridPaybackContext<T>` — Per-call context that selectionHybridPayback understands. `src/core/policy.ts:103`
- `interface HybridPaybackOptions<T>` — Options for selectionHybridPayback. `src/core/policy.ts:68`
- `function selectionCheapest<T>(getCost: (t: T) => DecimalSource): SelectionPolicy<T>` — Pick the candidate with the smallest cost. `src/core/policy.ts:127`
- `function selectionComposite<T>(...policies: SelectionPolicy<T>[]): SelectionPolicy<T>` — Chain policies with first-non-empty-pick semantics. `src/core/policy.ts:264`
- `function selectionHybridPayback<T>(opts: HybridPaybackOptions<T>): SelectionPolicy<T>` — Pick the candidate with the smallest blended payback score: `max(cost − effectiveAmount, 0) / totalRate + cost / Δrate`, where `effectiveAmount = amount − reserve`. `src/core/policy.ts:214`
- `function selectionPaybackPeriod<T>(getSeconds: (t: T) => number): SelectionPolicy<T>` — Pick the candidate with the smallest seconds figure, which the caller supplies per candidate; lower wins. `src/core/policy.ts:162`
- `interface SelectionPolicy<T>` — Pick one item from a list of pre-filtered candidates, or `undefined` when none of the candidates are an acceptable choice under this policy. `src/core/policy.ts:48`

## Recommendation

between-run arbitration across registered recommenders

- `interface BestReplayRecommenderOptions` `src/systems/recommenders.ts:28`
- `function createBestReplayRecommender(metricKey: string, options?: BestReplayRecommenderOptions): Recommender` — Create a recommender that replays the configuration that produced the best value for a given metric. `src/systems/recommenders.ts:94`
- `function createRecommendationSystem(options: RecommendationSystemOptions): RecommendationSystem` — Create a recommendation system that evaluates registered recommenders after each run ends, and presents or auto-applies the winning configuration. `src/systems/recommendation.ts:372`
- `interface Recommendation` — A produced recommendation stored by the system. `src/systems/recommendation.ts:128`
- `interface RecommendationContext` — The evaluation context passed to every recommender's `canApply`, `score`, and `recommend` methods. `src/systems/recommendation.ts:54`
- `interface RecommendationMetricComparison` — Per-metric comparison data in a recommendation's rationale. `src/systems/recommendation.ts:68`
- `interface RecommendationRationale` — Structured explanation of why a recommendation was made. `src/systems/recommendation.ts:75`
- `interface RecommendationResult` — The output of a recommender's `recommend()` method. `src/systems/recommendation.ts:85`
- `interface RecommendationSystem` — A recommendation system instance — the returned object from createRecommendationSystem. `src/systems/recommendation.ts:220`
- `interface RecommendationSystemEvents` — Events emitted by a RecommendationSystem instance. `src/systems/recommendation.ts:155`
- `interface RecommendationSystemOptions` `src/systems/recommendation.ts:165`
- `interface Recommender` — A recommender. `src/systems/recommendation.ts:98`

## Rule advisor

reduces history to a digest and ranks advisor analyzer suggestions

- `type AdvisorAnalyzerFn<TDigest, TPayload, TContext = undefined> = (digest: TDigest, context: TContext) => readonly Suggestion<TPayload>[]` — Advisor analyzer function — a domain-specific heuristic that reads the digest and the parallel `context` value, and returns zero or more suggestions. `src/systems/rule-advisor.ts:104`
- `type AdvisorDigestFn<TEntry, TDigest, TContext = undefined> = (history: readonly TEntry[], context: TContext) => TDigest` — Digest function — reduces history to the digest the advisor analyzers read. `src/systems/rule-advisor.ts:90`
- `function createRuleAdvisor<TDigest, TPayload, TContext = undefined>(options: Omit<RuleAdvisorOptions<CycleLogEntry, TDigest, TPayload, TContext>, 'historySource'> & { historySource: CycleLog; }): RuleAdvisor<TPayload>` — Create a rule advisor. `src/systems/rule-advisor.ts:334`
- `function createRuleAdvisor<TEntry, TDigest, TPayload, TContext = undefined>(options: Omit<RuleAdvisorOptions<TEntry, TDigest, TPayload, TContext>, 'historySource'> & { historySource: () => readonly TEntry[]; }): RuleAdvisor<TPayload>` `src/systems/rule-advisor.ts:339`
- `type HistorySource<TEntry> = CycleLog | (() => readonly TEntry[])` — History source — either a CycleLog (the usual case, equivalent to `() => cycleLog.history.value`) or a caller-supplied function returning the entry list. `src/systems/rule-advisor.ts:74`
- `interface RuleAdvisor<TPayload>` — A rule advisor instance, returned by createRuleAdvisor. `src/systems/rule-advisor.ts:208`
- `interface RuleAdvisorEvents<TPayload>` — Events emitted by a RuleAdvisor instance. `src/systems/rule-advisor.ts:190`
- `interface RuleAdvisorOptions<TEntry, TDigest, TPayload, TContext = undefined>` `src/systems/rule-advisor.ts:128`
- `interface Suggestion<TPayload = unknown>` — One entry of the advisor's ranked list. `src/systems/rule-advisor.ts:47`
- `type SuggestionRankFn<TPayload> = (a: Suggestion<TPayload>, b: Suggestion<TPayload>) => number` — Comparator for ranking the merged suggestion list. `src/systems/rule-advisor.ts:113`
