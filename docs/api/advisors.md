# Advisors

Decision-support systems that observe the engine and rank or recommend actions. The rule advisor + evaluator (rank candidates against a rule set), goal picker (which goal to pursue next), recommendation system (curated next-actions for the player), and the selection policies they share.

## Canonical entrypoints

Start with these public symbols before scanning the full inventory below.

- `createRuleEvaluator` — pure state-to-action rule dispatch.
- `selectionCheapest`, `selectionPaybackPeriod`, `selectionHybridPayback`, `selectionComposite` — choose among candidates.
- `createGoalPicker` — pick weighted goals from a candidate pool.
- `createRecommendationSystem` — arbitrate and surface strategies between loop runs.
- `createRuleAdvisor` — aggregate history and surface ranked suggestions.

## Goal picker

weighted-goal selection over a candidate pool

- `function createGoalPicker<TCandidate, TContext, TWeights>(options: GoalPickerOptions<TCandidate, TContext, TWeights>): GoalPicker<TCandidate, TContext, TWeights>` — Creates a weighted-goal picker over a candidate pool. `src/systems/goal-picker.ts:213`
- `type GoalCompletionFn<TCandidate, TContext> = (candidateId: TCandidate, context: TContext) => boolean` — Completion predicate. `src/systems/goal-picker.ts:55`
- `interface GoalPicker<TCandidate, TContext, TWeights>` — A goal picker instance, returned by createGoalPicker. `src/systems/goal-picker.ts:140`
- `interface GoalPickerOptions<TCandidate, TContext, TWeights>` — Configuration for createGoalPicker. `src/systems/goal-picker.ts:71`
- `const GoalPickerType: unique symbol` — Symbol identifying GoalPicker instances. `src/systems/goal-picker.ts:36`
- `interface GoalPickResult<TCandidate>` — Result of one GoalPicker.pick cycle — a diff over active selections. `src/systems/goal-picker.ts:61`
- `type GoalScorerFn<TCandidate, TContext, TWeights> = (candidateId: TCandidate, weights: TWeights, context: TContext) => number` — Score function. `src/systems/goal-picker.ts:45`
- `function isGoalPicker(value: unknown): value is GoalPicker<unknown, unknown, unknown>` — Type guard: returns `true` if the value is a GoalPicker instance. `src/systems/goal-picker.ts:327`

## Selection policies

score-and-pick over a candidate list

- `interface HybridPaybackContext<T>` — Per-call context that selectionHybridPayback understands. `src/core/policy.ts:89`
- `interface HybridPaybackOptions<T>` — Options for selectionHybridPayback. `src/core/policy.ts:55`
- `function selectionCheapest<T>(getCost: (t: T) => DecimalSource): SelectionPolicy<T>` — Pick the candidate with the smallest cost. `src/core/policy.ts:113`
- `function selectionComposite<T>(...policies: SelectionPolicy<T>[]): SelectionPolicy<T>` — Chain policies with first-non-empty-pick semantics. `src/core/policy.ts:243`
- `function selectionHybridPayback<T>(opts: HybridPaybackOptions<T>): SelectionPolicy<T>` — Pick the candidate with the smallest blended payback score: `max(cost − effectiveResource, 0) / headlineRate + cost / Δrate`, where `effectiveResource = resource − reserve`. `src/core/policy.ts:191`
- `function selectionPaybackPeriod<T>(getBeat: (t: T) => number): SelectionPolicy<T>` — Pick the candidate with the shortest payback period (smallest beat). `src/core/policy.ts:143`
- `interface SelectionPolicy<T>` — Pick one item from a list of pre-filtered candidates, or `undefined` when none of the candidates are an acceptable choice under this policy. `src/core/policy.ts:40`

## Recommendation

inter-loop strategy arbitration

- `interface BestReplayStrategyOptions` — Options for createBestReplayStrategy. `src/systems/recommendation-strategies.ts:30`
- `function createBestReplayStrategy(metricKey: string, options?: BestReplayStrategyOptions): RecommendationStrategyDef` — Create a strategy that replays the configuration that produced the best value for a given metric. `src/systems/recommendation-strategies.ts:85`
- `function createGoalStrategy(options: GoalStrategyOptions): RecommendationStrategyDef` — Create a strategy that selects the configuration optimizing for a specific metric goal. `src/systems/recommendation-strategies.ts:170`
- `function createRecommendationSystem(options: RecommendationSystemOptions): RecommendationSystem` — Create a recommendation system that evaluates strategies after each loop restart and surfaces or auto-applies the winning configuration. `src/systems/recommendation.ts:362`
- `interface GoalStrategyOptions` — Options for createGoalStrategy. `src/systems/recommendation-strategies.ts:41`
- `function isRecommendationSystem(value: unknown): value is RecommendationSystem` — Type guard: returns `true` if the value is a RecommendationSystem instance. `src/systems/recommendation.ts:508`
- `interface Recommendation` — A produced recommendation stored by the system. `src/systems/recommendation.ts:121`
- `interface RecommendationContext` — The evaluation context passed to every strategy's `canApply`, `score`, and `recommend` methods. `src/systems/recommendation.ts:56`
- `interface RecommendationMetricComparison` — Per-metric comparison data in a recommendation's rationale. `src/systems/recommendation.ts:70`
- `interface RecommendationRationale` — Structured explanation of why a recommendation was made. `src/systems/recommendation.ts:77`
- `interface RecommendationResult` — The output of a strategy's `recommend()` method. `src/systems/recommendation.ts:87`
- `interface RecommendationStrategyDef` — A recommendation strategy definition. `src/systems/recommendation.ts:100`
- `interface RecommendationSystem` — A recommendation system instance — the returned object from createRecommendationSystem. `src/systems/recommendation.ts:214`
- `interface RecommendationSystemEvents` — Events emitted by a RecommendationSystem instance. `src/systems/recommendation.ts:148`
- `interface RecommendationSystemOptions` — Configuration for createRecommendationSystem. `src/systems/recommendation.ts:158`
- `const RecommendationSystemType: unique symbol` — Symbol identifying RecommendationSystem features. `src/systems/recommendation.ts:50`

## Rule advisor

intra-session profile-history aggregator with ranked suggestions

- `type AdvisorAggregatorFn<TEntry, TProfile, TContext = undefined> = (history: readonly TEntry[], context: TContext) => TProfile` — Aggregator function — the windowed-history substrate, generic over the consumer's entry, profile, and parallel-context shapes. `src/systems/rule-advisor.ts:93`
- `type AdvisorAnalyzerFn<TProfile, TPayload, TContext = undefined> = (profile: TProfile, context: TContext) => readonly Suggestion<TPayload>[]` — Analyzer function — domain-specific heuristic that consumes the aggregate plus the parallel `context` value and returns zero or more suggestions. `src/systems/rule-advisor.ts:106`
- `function createRuleAdvisor<TProfile, TPayload, TContext = undefined>(options: Omit<RuleAdvisorOptions<LoopLogEntry, TProfile, TPayload, TContext>, 'historySource'> & { historySource: LoopLog; }): RuleAdvisor<TPayload>` — Create an intra-session advisor that aggregates history into a profile, runs analyzers over the profile and a parallel context value, and surfaces a ranked + dismissable suggestion list. `src/systems/rule-advisor.ts:336`
- `type HistorySource<TEntry> = LoopLog | (() => readonly TEntry[])` — History source — either a LoopLog (canonical case, equivalent to `() => loopLog.history.value`) or a caller-supplied function returning the entry list. `src/systems/rule-advisor.ts:77`
- `function isRuleAdvisor(value: unknown): value is RuleAdvisor<unknown>` — Type guard: returns `true` if the value is a RuleAdvisor instance. `src/systems/rule-advisor.ts:423`
- `interface RuleAdvisor<TPayload>` — A rule advisor instance, returned by createRuleAdvisor. `src/systems/rule-advisor.ts:211`
- `interface RuleAdvisorEvents<TPayload>` — Events emitted by a RuleAdvisor instance. `src/systems/rule-advisor.ts:194`
- `interface RuleAdvisorOptions<TEntry, TProfile, TPayload, TContext = undefined>` — Configuration for createRuleAdvisor. `src/systems/rule-advisor.ts:130`
- `const RuleAdvisorType: unique symbol` — Symbol identifying RuleAdvisor instances. `src/systems/rule-advisor.ts:43`
- `interface Suggestion<TPayload = unknown>` — One advisory output. `src/systems/rule-advisor.ts:50`
- `type SuggestionRankFn<TPayload> = (a: Suggestion<TPayload>, b: Suggestion<TPayload>) => number` — Comparator for ranking the merged suggestion list. `src/systems/rule-advisor.ts:115`

## Rule evaluator

pure `evaluate(state) → action` primitive for consumer-driven rule sets

- `function createRuleEvaluator<TState, TAction>(options: RuleEvaluatorOptions<TState, TAction>): RuleEvaluator<TState, TAction>` — Creates a pure rule evaluator over consumer-provided state and action types. `src/core/rule-evaluator.ts:157`
- `interface EvaluatorResult<TAction>` — Structured result of one RuleEvaluator.evaluate pass. `src/core/rule-evaluator.ts:58`
- `interface EvaluatorRule<TState, TAction>` — One rule — a predicate closure over a context snapshot, mapped to an action. `src/core/rule-evaluator.ts:45`
- `function isRuleEvaluator(value: unknown): value is RuleEvaluator<unknown, unknown>` — Type guard: returns `true` if `value` is a RuleEvaluator instance. `src/core/rule-evaluator.ts:205`
- `interface RuleEvaluator<TState, TAction>` — A rule evaluator instance, returned by createRuleEvaluator. `src/core/rule-evaluator.ts:117`
- `interface RuleEvaluatorOptions<TState, TAction>` — Configuration for createRuleEvaluator. `src/core/rule-evaluator.ts:80`
- `const RuleEvaluatorType: unique symbol` — Symbol identifying RuleEvaluator instances (for type guards). `src/core/rule-evaluator.ts:37`
