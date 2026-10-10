# Advisors

Decision-support systems that observe the engine and rank actions: rule advisor, goal picker, recommendation system, and the selection policies they share. Candidates are abstract — build map-based ones from spatial.md influence readings.

## Canonical entrypoints

- `selectionCheapest`, `selectionPaybackPeriod`, `selectionHybridPayback`, `selectionComposite` — choose among candidates.
- `createGoalPicker` — pick weighted goals from a candidate pool.
- `createRecommendationSystem` — arbitrate and surface strategies between loop runs.
- `createRuleAdvisor` — aggregate history and surface ranked suggestions.

## Goal picker

weighted-goal selection over a candidate pool

- `function createGoalPicker<TCandidate, TContext, TWeights>(options: GoalPickerOptions<TCandidate, TContext, TWeights>): GoalPicker<TCandidate, TContext, TWeights>` — Creates a weighted-goal picker over a candidate pool. `src/systems/goal-picker.ts:210`
- `type GoalCompletionFn<TCandidate, TContext> = (candidateId: TCandidate, context: TContext) => boolean` — Completion predicate. `src/systems/goal-picker.ts:50`
- `interface GoalPicker<TCandidate, TContext, TWeights>` — A goal picker instance, returned by createGoalPicker. `src/systems/goal-picker.ts:135`
- `interface GoalPickerOptions<TCandidate, TContext, TWeights>` — Configuration for createGoalPicker. `src/systems/goal-picker.ts:66`
- `interface GoalPickResult<TCandidate>` — Result of one GoalPicker.pick cycle — a diff over active selections. `src/systems/goal-picker.ts:56`
- `type GoalScorerFn<TCandidate, TContext, TWeights> = (candidateId: TCandidate, weights: TWeights, context: TContext) => number` — Score function. `src/systems/goal-picker.ts:40`

## Selection policies

score-and-pick over a candidate list

- `interface HybridPaybackContext<T>` — Per-call context that selectionHybridPayback understands. `src/core/policy.ts:100`
- `interface HybridPaybackOptions<T>` — Options for selectionHybridPayback. `src/core/policy.ts:65`
- `function selectionCheapest<T>(getCost: (t: T) => DecimalSource): SelectionPolicy<T>` — Pick the candidate with the smallest cost. `src/core/policy.ts:124`
- `function selectionComposite<T>(...policies: SelectionPolicy<T>[]): SelectionPolicy<T>` — Chain policies with first-non-empty-pick semantics. `src/core/policy.ts:261`
- `function selectionHybridPayback<T>(opts: HybridPaybackOptions<T>): SelectionPolicy<T>` — Pick the candidate with the smallest blended payback score: `max(cost − effectiveResource, 0) / headlineRate + cost / Δrate`, where `effectiveResource = resource − reserve`. `src/core/policy.ts:211`
- `function selectionPaybackPeriod<T>(getSeconds: (t: T) => number): SelectionPolicy<T>` — Pick the candidate with the smallest beat — a per-candidate seconds figure the caller supplies, lower wins. `src/core/policy.ts:158`
- `interface SelectionPolicy<T>` — Pick one item from a list of pre-filtered candidates, or `undefined` when none of the candidates are an acceptable choice under this policy. `src/core/policy.ts:48`

## Recommendation

inter-cycle arbitration across registered defs

- `interface BestReplayRecommenderOptions` `src/systems/recommenders.ts:27`
- `function createBestReplayRecommender(metricKey: string, options?: BestReplayRecommenderOptions): Recommender` — Create a def that replays the configuration that produced the best value for a given metric. `src/systems/recommenders.ts:93`
- `function createRecommendationSystem(options: RecommendationSystemOptions): RecommendationSystem` — Create a recommendation system that evaluates registered defs after each cycle restart and surfaces or auto-applies the winning configuration. `src/systems/recommendation.ts:370`
- `interface Recommendation` — A produced recommendation stored by the system. `src/systems/recommendation.ts:126`
- `interface RecommendationContext` — The evaluation context passed to every def's `canApply`, `score`, and `recommend` methods. `src/systems/recommendation.ts:53`
- `interface RecommendationMetricComparison` — Per-metric comparison data in a recommendation's rationale. `src/systems/recommendation.ts:67`
- `interface RecommendationRationale` — Structured explanation of why a recommendation was made. `src/systems/recommendation.ts:74`
- `interface RecommendationResult` — The output of a def's `recommend()` method. `src/systems/recommendation.ts:84`
- `interface RecommendationSystem` — A recommendation system instance — the returned object from createRecommendationSystem. `src/systems/recommendation.ts:219`
- `interface RecommendationSystemEvents` — Events emitted by a RecommendationSystem instance. `src/systems/recommendation.ts:153`
- `interface RecommendationSystemOptions` — Configuration for createRecommendationSystem. `src/systems/recommendation.ts:163`
- `interface Recommender` — A recommendation definition. `src/systems/recommendation.ts:98`

## Rule advisor

intra-session profile-history aggregator with ranked suggestions

- `type AdvisorAnalyzerFn<TDigest, TPayload, TContext = undefined> = (digest: TDigest, context: TContext) => readonly Suggestion<TPayload>[]` — Analyzer function — domain-specific heuristic that consumes the aggregate plus the parallel `context` value and returns zero or more suggestions. `src/systems/rule-advisor.ts:103`
- `type AdvisorDigestFn<TEntry, TDigest, TContext = undefined> = (history: readonly TEntry[], context: TContext) => TDigest` — Aggregator function — the windowed-history substrate, generic over the consumer's entry, profile, and parallel-context shapes. `src/systems/rule-advisor.ts:90`
- `function createRuleAdvisor<TDigest, TPayload, TContext = undefined>(options: Omit<RuleAdvisorOptions<CycleLogEntry, TDigest, TPayload, TContext>, 'historySource'> & { historySource: CycleLog; }): RuleAdvisor<TPayload>` — Create an intra-session advisor that aggregates history into a profile, runs analyzers over the profile and a parallel context value, and surfaces a ranked + dismissable suggestion list. `src/systems/rule-advisor.ts:336`
- `function createRuleAdvisor<TEntry, TDigest, TPayload, TContext = undefined>(options: Omit<RuleAdvisorOptions<TEntry, TDigest, TPayload, TContext>, 'historySource'> & { historySource: () => readonly TEntry[]; }): RuleAdvisor<TPayload>` `src/systems/rule-advisor.ts:341`
- `type HistorySource<TEntry> = CycleLog | (() => readonly TEntry[])` — History source — either a CycleLog (canonical case, equivalent to `() => cycleLog.history.value`) or a caller-supplied function returning the entry list. `src/systems/rule-advisor.ts:74`
- `interface RuleAdvisor<TPayload>` — A rule advisor instance, returned by createRuleAdvisor. `src/systems/rule-advisor.ts:210`
- `interface RuleAdvisorEvents<TPayload>` — Events emitted by a RuleAdvisor instance. `src/systems/rule-advisor.ts:191`
- `interface RuleAdvisorOptions<TEntry, TDigest, TPayload, TContext = undefined>` — Configuration for createRuleAdvisor. `src/systems/rule-advisor.ts:127`
- `interface Suggestion<TPayload = unknown>` — One advisory output. `src/systems/rule-advisor.ts:47`
- `type SuggestionRankFn<TPayload> = (a: Suggestion<TPayload>, b: Suggestion<TPayload>) => number` — Comparator for ranking the merged suggestion list. `src/systems/rule-advisor.ts:112`
