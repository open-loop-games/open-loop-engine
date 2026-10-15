# Content Systems

The validated incremental primitives, each a typed registration contract over the Mechanics API tier. Purchasable / Producer / Achievement / Inventory / BestOf handle resource flow. Skill / Cycle / Challenge / Zone / Loadout / AutomationTiers / CycleLog give long-arc structure. RunPool holds many concurrent pool runs at once.

## Canonical entrypoints

- `createProducerCategory` — producers, such as buildings, whose ownership creates continuous resource flow.
- `createPurchasableCategory` — upgrades, unlocks, capped repeatables, perks and purchased effects, registered in batch.
- `createAchievementCategory` — achievements and achievement ladders, earned automatically when their goals hold.
- `createSkillCategory` — XP and level progression.
- `createCycle`, `createChallengeCategory`, `createInventory`, `createZoneSystem`, `createLoadout`, `createAutomationTiers` — runs, challenges, inventory, zones, loadouts and automation tiers.
- `createActionCategory` — ordered-execution queues with per-execution state machine.

## Achievement

achievements earned automatically when their goal holds, with ladders and effect values

- `interface Achievement<T = unknown>` — A live achievement instance created by createAchievement. `src/systems/achievement.ts:103`
- `interface AchievementCategory<Def extends { id: string; }, DefState = void> extends ResettableObject` — An achievement category — batch-registered Achievements with a shared shape. `src/systems/achievement-category.ts:220`
- `interface AchievementCategoryEntry<Def extends { id: string; }, DefState = void>` — A category entry: def, Achievement instance, def state and signals. `src/systems/achievement-category.ts:102`
- `interface AchievementCategoryOptions<Def extends { id: string; }, DefState = void>` `src/systems/achievement-category.ts:62`
- `interface AchievementDisplay` — Display text shown on an achievement card. `src/systems/achievement.ts:38`
- `interface AchievementEvents` — Events emitted by an Achievement instance. `src/systems/achievement.ts:147`
- `interface AchievementLadderBaseOptions<T = number>` — Options for AchievementCategory.registerLadder. `src/systems/achievement-category.ts:153`
- `type AchievementLadderBuildDef<Def, T = number> = (params: AchievementLadderBuildDefParams<T>) => Def` — `buildDef` callback type for the `registerLadder` options. `src/systems/achievement-category.ts:185`
- `interface AchievementLadderBuildDefParams<T = number>` — Parameters passed to a AchievementLadderOptions.buildDef callback. `src/systems/achievement-category.ts:170`
- `type AchievementLadderOptions<Def, T = number> = AchievementLadderBaseOptions<T> & (Def extends BaseLadderAchievementDef ? BaseLadderAchievementDef<T> extends Def ? { buildDef?: AchievementLadderBuildDef<Def, T>; } : { buildDef: AchievementLadderBuildDef<Def, T>; } : { buildDef: AchievementLadderBuildDef<Def, T>; })` — `registerLadder` parameter type. `src/systems/achievement-category.ts:207`
- `interface AchievementOptions<T = unknown>` `src/systems/achievement.ts:57`
- `interface AchievementRung<T = number>` — One rung of an AchievementLadderOptions. `src/systems/achievement-category.ts:130`
- `interface BaseLadderAchievementDef<T = unknown>` — Minimum Def shape that AchievementCategory.registerLadder's default `buildDef` can synthesize without a consumer callback. `src/systems/achievement-category.ts:117`
- `function createAchievementCategory<Def extends { id: string; }, DefState = void>(options: AchievementCategoryOptions<Def, DefState>): AchievementCategory<Def, DefState>` — Create an achievement category — batch registration of Achievements from defs. `src/systems/achievement-category.ts:306`
- `function getCombinedAchievementEffect(achievements: Achievement<number>[], base?: DecimalSource): Decimal` — Multiply effect values across earned achievements onto a base. `src/systems/achievement.ts:257`
- `function getEarnedCount(achievements: Achievement[]): number` — Count of the earned achievements in the list; reactive when read inside a `computed`. `src/systems/achievement.ts:273`

## Action Category

batch-registered ordered-execution queue with per-execution state machine

- `interface ActionCategory<Def extends { id: string; }, DefState = void, Payload = void> extends ResettableObject, Emittable<ActionCategoryEvents<Def, DefState, Payload>>` — An action category — registered queue with per-execution state machine. `src/systems/action-category.ts:184`
- `interface ActionCategoryContext` — Context passed to `mapAction` at registration time. `src/systems/action-category.ts:128`
- `interface ActionCategoryEntry<Def extends { id: string; }, DefState, Payload>` — A category entry: def, def state, and the per-execution metadata while this def is the running item. `src/systems/action-category.ts:93`
- `interface ActionCategoryEvents<Def extends { id: string; }, DefState, Payload>` — Events emitted by an ActionCategory. `src/systems/action-category.ts:133`
- `interface ActionCategoryOptions<Def extends { id: string; }, DefState = void, Payload = void>` `src/systems/action-category.ts:150`
- `interface ActionItemMetadata<Payload>` — Sequencer-item metadata shape for an ActionCategory. `src/systems/action-category.ts:71`
- `type ActionItemStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed'` — Per-execution status. `src/systems/action-category.ts:62`
- `interface ActionMapping<Def extends { id: string; }, DefState, Payload>` — What the `mapAction` callback returns: per-def behavior and signals. `src/systems/action-category.ts:104`
- `interface ActionTickContext<Def extends { id: string; }, DefState, Payload>` — Context passed to a mapping's `tick` closure. `src/systems/action-category.ts:83`
- `function createActionCategory<Def extends { id: string; }, DefState = void, Payload = void>(options: ActionCategoryOptions<Def, DefState, Payload>): ActionCategory<Def, DefState, Payload>` — Create an action category — batch registration of typed action defs into an ordered-execution queue with per-execution state machine. `src/systems/action-category.ts:334`

## Automation tiers

progressive unlock of automation features

- `interface AutomationTierDef` — Def for one automation tier. `src/systems/automation.ts:52`
- `interface AutomationTiers` — The automation tier system createAutomationTiers returns. `src/systems/automation.ts:105`
- `interface AutomationTiersEvents` — Events emitted by an AutomationTiers instance. `src/systems/automation.ts:74`
- `interface AutomationTiersOptions` `src/systems/automation.ts:83`
- `function createAutomationTiers(options: AutomationTiersOptions): AutomationTiers` — Create an automation tier system for progressive automation unlocks. `src/systems/automation.ts:177`

## BestOf tracker

per-metric best-of-run recording

- `interface BestOf` — A BestOf instance — the returned object from createBestOf. `src/systems/best-of.ts:158`
- `interface BestOfCandidate` — A candidate submission for best-of comparison. `src/systems/best-of.ts:118`
- `interface BestOfEntry` — A single metric's best recorded outcome. `src/systems/best-of.ts:86`
- `interface BestOfEvents` — Events emitted by a BestOf instance. `src/systems/best-of.ts:132`
- `interface BestOfMetricDef` — One metric's def for createBestOf. `src/systems/best-of.ts:46`
- `interface BestOfOptions` `src/systems/best-of.ts:138`
- `type BestOfStatus = 'valid' | 'stale'` — Validity status of a best-of entry. `src/systems/best-of.ts:83`
- `type CompareBy = 'observed' | 'projected'` — Which value to use for comparison when a projection function is provided. `src/systems/best-of.ts:43`
- `type ComparisonMode = 'absolute' | 'perSecond'` — How to compare candidates: highest absolute delta or highest delta/second. `src/systems/best-of.ts:40`
- `function createBestOf(options: BestOfOptions): BestOf` — Create a BestOf tracker that records the best run outcome per metric. `src/systems/best-of.ts:259`

## Challenge Category

batch-create Challenges from content defs

- `interface Challenge` — A challenge instance with saved state and lifecycle methods. `src/systems/challenge-category.ts:164`
- `interface ChallengeCategory<Def extends ChallengeDef, DefState = void> extends ResettableObject` — A challenge category — batch-registered challenges with shared lifecycle. `src/systems/challenge-category.ts:295`
- `interface ChallengeCategoryEntry<Def extends ChallengeDef, DefState = void>` — A registered entry in a challenge category. `src/systems/challenge-category.ts:217`
- `interface ChallengeCategoryOptions<Def extends ChallengeDef, DefState = void>` `src/systems/challenge-category.ts:230`
- `interface ChallengeDef<Overrides extends { [K in keyof Overrides]: (...args: never[]) => unknown; } = Record<string, (...args: never[]) => unknown>>` — Def for a challenge. `src/systems/challenge-category.ts:70`
- `function createChallengeCategory<Def extends ChallengeDef, DefState = void>(options: ChallengeCategoryOptions<Def, DefState>): ChallengeCategory<Def, DefState>` — Create a challenge category for batch registration of challenges. `src/systems/challenge-category.ts:357`

## Cycle

bounded runs that end, reset, and start the next run

- `function createCycle(options: CycleOptions): Cycle` — Create a cycle — bounded runs that end, reset, and start the next run. `src/systems/cycle.ts:243`
- `interface Cycle extends ScopedReset` — A cycle instance — the returned object from createCycle. `src/systems/cycle.ts:140`
- `interface CycleEvents` — Events emitted by a Cycle instance. `src/systems/cycle.ts:39`
- `interface CycleOptions` `src/systems/cycle.ts:52`

## CycleLog

per-run metric delta recording

- `function createCycleLog(options: CycleLogOptions): CycleLog` — Create a CycleLog that records per-run metric deltas from a Cycle's lifecycle. `src/systems/cycle-log.ts:153`
- `interface CycleLog` — A CycleLog instance — the returned object from createCycleLog. `src/systems/cycle-log.ts:94`
- `interface CycleLogDelta` — Per-metric change recorded during one run. `src/systems/cycle-log.ts:61`
- `interface CycleLogEntry` — One run's recorded outcome. `src/systems/cycle-log.ts:70`
- `interface CycleLogEvents` — Events emitted by a CycleLog instance. `src/systems/cycle-log.ts:83`
- `const CycleLogKey: InjectionKey<CycleLog>` — Opt-in injection key for introspection tools (balance harness, balance workbench, devtools). `src/systems/cycle-log.ts:42`
- `interface CycleLogOptions` `src/systems/cycle-log.ts:45`

## Inventory

game-dev-friendly wrapper over ResourceBag

- `function createInventory(options: InventoryOptions): Inventory` — Creates a game inventory with per-item capacity driven by modifier chains, backed by a ResourceBag with optional automatic persistence. `src/systems/inventory.ts:111`
- `interface Inventory` — Inventory instance created by createInventory. `src/systems/inventory.ts:49`
- `interface InventoryOptions` — Options for createInventory — capacity, overflow behavior, and the initial item list. `src/systems/inventory.ts:21`

## Producer Category

batch-create Producers from defs

- `function createProducerCategory<Def extends { id: string; }, DefState = void>(options: ProducerCategoryOptions<Def, DefState>): ProducerCategory<Def, DefState>` — Create a producer category — batch registration of Producers from defs. `src/systems/producer-category.ts:641`
- `interface Producer` — A producer instance — produces resources continuously or when activated. `src/systems/producer-category.ts:189`
- `interface ProducerCategory<Def extends { id: string; }, DefState = void> extends ResettableObject` — A producer category — batch-registered Producers with a shared production shape. `src/systems/producer-category.ts:301`
- `interface ProducerCategoryContext` — Context passed to the ProducerCategoryOptions.mapProducer callback. `src/systems/producer-category.ts:40`
- `interface ProducerCategoryEntry<Def extends { id: string; }, DefState = void>` — A category entry: def, Producer instance, def state and signals. `src/systems/producer-category.ts:288`
- `interface ProducerCategoryOptions<Def extends { id: string; }, DefState = void>` `src/systems/producer-category.ts:159`
- `interface ProducerInput` — A stock a converting producer draws for each unit of output. `src/systems/producer-category.ts:72`
- `type ProducerLimit` — What bound a converter's last tick: `'rate'` when it made what its rate wants, `'input:<key>'` when that input ran short, `'room'` when the output's resource bag was full. `src/systems/producer-category.ts:279`
- `interface ProducerMapping` — Return type of the ProducerCategoryOptions.mapProducer callback. `src/systems/producer-category.ts:82`
- `interface ProducerPurchaseOptions` — Purchase options for a producer purchased more than once. `src/systems/producer-category.ts:49`
- `interface ResolvedProducerInput` — A ProducerInput with its per-unit draw resolved to a ref. `src/systems/producer-category.ts:282`

## Purchasable

unified purchase primitives for incremental games

Two factories for consumers. `createPurchasableCategory` batch-registers from defs and is the default. `createScalingPurchasable` is the per-instance escape hatch for costs that scale with purchase count. `createPurchasable` is the raw factory both build on. A cost that scales on the item's own purchase count goes through the factory form of `requirements`, which receives the live count ref. A getter that reads the count back out gives bulk purchases the wrong cost. See ../consumer-guide-choosing.md#choosing-among-purchasable-primitives.

- `function createPurchasableCategory<Def extends { id: string; }, DefState = void>(options: PurchasableCategoryOptions<Def, DefState>): PurchasableCategory<Def, DefState>` — Create a purchasable category — batch registration of Purchasables from defs. `src/systems/purchasable-category.ts:201`
- `function createScalingPurchasable(options: ScalingPurchasableOptions, predicates?: PredicateResolver): Purchasable` — Create a purchasable whose cost scales with its count — the L3 factory for one customized repeatable purchase. `src/systems/purchasable.ts:740`
- `interface Purchasable` — A purchasable — the returned object from createPurchasable. `src/systems/purchasable.ts:266`
- `interface PurchasableCategory<Def extends { id: string; }, DefState = void> extends ResettableObject` — A purchasable category — batch-registered Purchasables with a shared shape. `src/systems/purchasable-category.ts:121`
- `interface PurchasableCategoryEntry<Def extends { id: string; }, DefState = void>` — A category entry: def, Purchasable instance, def state and signals. `src/systems/purchasable-category.ts:108`
- `interface PurchasableCategoryOptions<Def extends { id: string; }, DefState = void>` `src/systems/purchasable-category.ts:68`
- `interface PurchasableDisplay` — UI text for a purchasable. `src/systems/purchasable.ts:58`
- `interface PurchasableEvents` — Events emitted by a Purchasable instance. `src/systems/purchasable.ts:52`
- `interface PurchasableOptions` — Full options for createPurchasable — the engine-internal raw factory. `src/systems/purchasable.ts:80`
- `type ScalingPurchasableCost` — Cost options for ScalingPurchasableOptions. `src/systems/purchasable.ts:154`
- `type ScalingPurchasableEffect` — Effect options for ScalingPurchasableOptions — at most one of `effect` (a static base or a plain function) or `effectFormula` (a curve factory). `src/systems/purchasable.ts:195`
- `type ScalingPurchasableOptions` — Shorthand options for createScalingPurchasable — repeatable purchases with a geometric, Formula or function cost. `src/systems/purchasable.ts:227`
- `function setupPolicyAutoPurchase(producers: ProducerCategory<{ id: string; }, unknown> | Producer[], options: SetupPolicyAutoPurchaseOptions, registerTick: RegisterTick): () => void` — Register a tick handler that auto-purchases one producer per attempt, as a SelectionPolicy picks. `src/systems/auto-purchase.ts:503`
- `interface SetupPolicyAutoPurchaseOptions` `src/systems/auto-purchase.ts:348`
- `function setupSweepAutoPurchase(purchasables: PurchasableCategory<{ id: string; }, unknown> | Purchasable[], options: SetupSweepAutoPurchaseOptions, registerTick: RegisterTick): () => void` — Register a tick handler that sweeps a purchasable list, purchasing every candidate whose `canPurchase` is true. `src/systems/auto-purchase.ts:262`
- `interface SetupSweepAutoPurchaseOptions` `src/systems/auto-purchase.ts:123`

## RunPool

core primitive for managing a collection of opaque, addressable pool runs with independent lifecycle state

- `function createRunPool<Id = string>(options: RunPoolOptions): RunPool<Id>` — Creates a run pool: opaque pool runs with saved aliveness and lifecycle events. `src/core/run-pool.ts:208`
- `type RunDeathOutcome` — Outcome of a pool run's death, returned synchronously from its `onDeath` option callback. `src/core/run-pool.ts:47`
- `interface RunHandle<Id = string>` — Opaque handle to one pool run. `src/core/run-pool.ts:53`
- `interface RunPool<Id = string> extends Emittable<RunPoolEvents<Id>>` — A run pool: concurrent pool runs, such as spawned clones, that share one death disposition, each with its own step closure. `src/core/run-pool.ts:149`
- `interface RunPoolEvents<Id = string>` — Events emitted during the run pool's lifecycle. `src/core/run-pool.ts:97`
- `interface RunPoolOptions` `src/core/run-pool.ts:125`
- `interface RunRegistration<Id = string>` — Registration payload for RunPool.addRun: a stable id, the `step` function, and an optional `onDeath` override of the run pool's `deathDisposition` for this pool run. `src/core/run-pool.ts:86`
- `type RunStep = () => boolean` — One step of a pool run. `src/core/run-pool.ts:40`

## Skill

XP, a level and a modifier per skill, in a level-driven or an accumulator mode

- `interface AccumulatorSkill extends SkillBase` — Accumulator skill — modifier = 1 + lifetimeBonus. `src/systems/skill.ts:172`
- `interface AccumulatorSkillOptions extends SkillOptionsBase` — Accumulator mode — a lifetime bonus accumulates across runs. `src/systems/skill.ts:101`
- `function createSkill(options: AccumulatorSkillOptions): AccumulatorSkill` — Create a skill with XP tracking, computed level, and a reactive modifier. `src/systems/skill.ts:365`
- `function createSkill(options: LevelDrivenSkillOptions): LevelDrivenSkill` `src/systems/skill.ts:366`
- `function createSkill(options: SkillOptions): Skill` `src/systems/skill.ts:367`
- `function createSkillCategory<Def extends { id: string; }, DefState = void>(options: SkillCategoryOptions<Def, DefState>): SkillCategory<Def, DefState>` — Create a skill category — batch registration of Skills from defs. `src/systems/skill-category.ts:183`
- `function getSkillProgress(skill: Skill): number` — Progress fraction (0–1) within the current level, for progress bar display. `src/systems/skill.ts:462`
- `function getSkillXPWindow(skill: Skill): { current: Decimal; needed: Decimal; }` — XP window for "N / M" display — how much XP into the current level and how much the current level spans. `src/systems/skill.ts:479`
- `interface LevelDrivenSkill extends SkillBase` — Level-driven skill — modifier = levelToMultiplier(level), no accumulator. `src/systems/skill.ts:160`
- `interface LevelDrivenSkillOptions extends SkillOptionsBase` — Level-driven mode — the modifier tracks the level reactively. `src/systems/skill.ts:117`
- `type Skill = LevelDrivenSkill | AccumulatorSkill` — A Skill in either mode — discriminated by the presence of `lifetimeBonus`. `src/systems/skill.ts:198`
- `interface SkillBase` — Fields present on all skills regardless of mode. `src/systems/skill.ts:131`
- `interface SkillCategory<Def extends { id: string; }, DefState = void> extends ResettableObject` — A skill category — batch-registered Skills with a shared shape. `src/systems/skill-category.ts:103`
- `interface SkillCategoryEntry<Def extends { id: string; }, DefState = void>` — A category entry: def, Skill instance, def state and signals. `src/systems/skill-category.ts:90`
- `interface SkillCategoryOptions<Def extends { id: string; }, DefState = void>` `src/systems/skill-category.ts:60`
- `type SkillCurve = (variable: MaybeRef<DecimalSource>) => FormulaSource` — Curve factory that binds a Formula to an engine-owned reactive variable. `src/systems/skill.ts:69`
- `interface SkillEvents` — Events emitted by a Skill instance. `src/systems/skill.ts:56`
- `type SkillOptions = AccumulatorSkillOptions | LevelDrivenSkillOptions` — Discriminated union of createSkill option shapes — accumulator (each run's level adds to a lifetime bonus) or level-driven (the level drives a curve). `src/systems/skill.ts:128`
- `interface SkillOptionsBase` — Shared option fields present in both skill modes. `src/systems/skill.ts:75`

## Loadout

constrained persistent selection from a pool

- `function createLoadout(options: LoadoutOptions): Loadout` — Creates a loadout — a constrained persistent selection from a pool. `src/systems/loadout.ts:179`
- `interface Loadout` — A constrained persistent selection from a pool, created by createLoadout. `src/systems/loadout.ts:106`
- `interface LoadoutEvents` — Events emitted by a Loadout. `src/systems/loadout.ts:91`
- `interface LoadoutOptions` `src/systems/loadout.ts:54`

## Zone

named content groupings with progressive unlock

- `function createZoneSystem(options?: ZoneSystemOptions): ZoneSystem` — Create a zone system — content groupings with progressive unlock. `src/systems/zone.ts:143`
- `interface ZoneDef` — A zone's def in the content registry. `src/systems/zone.ts:48`
- `interface ZoneSystem` — A zone system instance — the returned object from createZoneSystem. `src/systems/zone.ts:88`
- `interface ZoneSystemEvents` — Events emitted by a ZoneSystem instance. `src/systems/zone.ts:59`
- `interface ZoneSystemOptions` `src/systems/zone.ts:67`
