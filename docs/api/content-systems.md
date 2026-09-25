# Content Systems

The validated incremental primitives, each a typed registration surface over the mechanics kernel. Purchasable / Producer / Achievement / Inventory / BestOf carry currency flow; Skill / Cycle / Challenge / Zone / Slot / AutomationTiers / CycleLog carry long-arc structure; RunPool holds many concurrent runs at once.

## Canonical entrypoints

- `createProducerCategory` — buildings/generators whose ownership creates continuous resource flow.
- `createPurchasableCategory` — upgrades, gates, capped repeatables, perks, and bought effects in batch.
- `createAchievementCategory` — observed milestones and tier ladders that auto-earn.
- `createSkillCategory` — XP/level progression surfaces.
- `createCycle`, `createChallengeCategory`, `createInventory`, `createZoneSystem`, `createSlot`, `createAutomationTiers` — progression, inventory, grouping, selection, and automation surfaces.
- `createActionCategory` — ordered-execution queues with per-execution state machine.

## Achievement

milestone tracking with auto-unlock and tiered rewards

- `interface Achievement<T = unknown>` — A live achievement instance created by createAchievement. `src/systems/achievement.ts:104`
- `interface AchievementCategory<Def extends { id: string; }, State = void> extends ResettableObject` — An achievement category — batch-registered Achievements with a shared shape. `src/systems/achievement-category.ts:220`
- `interface AchievementCategoryEntry<Def extends { id: string; }, State = void>` — A registered entry: definition + Achievement instance + optional state + introspection signals. `src/systems/achievement-category.ts:102`
- `interface AchievementCategoryOptions<Def extends { id: string; }, State = void>` `src/systems/achievement-category.ts:62`
- `interface AchievementDisplay` — Display text shown on an achievement tile. `src/systems/achievement.ts:39`
- `interface AchievementEvents` — Events emitted by an Achievement instance. `src/systems/achievement.ts:148`
- `interface AchievementOptions<T = unknown>` — Configuration for createAchievement. `src/systems/achievement.ts:58`
- `interface BaseTieredAchievementDef<T = unknown>` — Minimum Def shape that AchievementCategory.registerTiered's default `buildDef` can synthesize without a consumer callback. `src/systems/achievement-category.ts:117`
- `function createAchievementCategory<Def extends { id: string; }, State = void>(options: AchievementCategoryOptions<Def, State>): AchievementCategory<Def, State>` — Create an achievement category — batch registration of Achievements from definitions. `src/systems/achievement-category.ts:309`
- `function getCombinedAchievementEffect(achievements: Achievement<number>[], base?: DecimalSource): Decimal` — Multiply effect values across earned achievements onto a base. `src/systems/achievement.ts:274`
- `function getEarnedCount(achievements: Achievement[]): number` — Reactive count of how many achievements in the list are currently earned. `src/systems/achievement.ts:290`
- `interface TieredAchievementBaseSpec<T = number>` — Spec for AchievementCategory.registerTiered. `src/systems/achievement-category.ts:153`
- `type TieredAchievementBuildDef<Def, T = number> = (params: TieredAchievementBuildDefParams<T>) => Def` — `buildDef` callback type for the `registerTiered` spec. `src/systems/achievement-category.ts:185`
- `interface TieredAchievementBuildDefParams<T = number>` — Parameters passed to a TieredAchievementSpec.buildDef callback. `src/systems/achievement-category.ts:170`
- `type TieredAchievementSpec<Def, T = number> = TieredAchievementBaseSpec<T> & (Def extends BaseTieredAchievementDef ? BaseTieredAchievementDef<T> extends Def ? { buildDef?: TieredAchievementBuildDef<Def, T>; } : { buildDef: TieredAchievementBuildDef<Def, T>; } : { buildDef: TieredAchievementBuildDef<Def, T>; })` — `registerTiered` parameter type. `src/systems/achievement-category.ts:207`
- `interface TieredAchievementTier<T = number>` — One tier in a TieredAchievementSpec. `src/systems/achievement-category.ts:130`

## Action Category

batch-registered ordered-execution queue with per-execution state machine

- `interface ActionCategory<Def extends { id: string; }, State = void, Payload = void> extends ResettableObject, Emittable<ActionCategoryEvents<Def, State, Payload>>` — An action category — registered queue with per-execution state machine. `src/systems/action-category.ts:178`
- `interface ActionCategoryContext` — Context passed to `mapAction` at registration time. `src/systems/action-category.ts:126`
- `interface ActionCategoryEntry<Def extends { id: string; }, State, Payload>` — A registered entry: definition + per-def state + the current per-execution metadata when this def is the running item. `src/systems/action-category.ts:91`
- `interface ActionCategoryEvents<Def extends { id: string; }, State, Payload>` — Events emitted by an ActionCategory. `src/systems/action-category.ts:131`
- `interface ActionCategoryOptions<Def extends { id: string; }, State = void, Payload = void>` `src/systems/action-category.ts:148`
- `interface ActionItemMetadata<Payload>` — Sequencer-item metadata shape for an ActionCategory. `src/systems/action-category.ts:69`
- `type ActionItemState = 'pending' | 'running' | 'waiting' | 'completed' | 'failed'` — Per-execution lifecycle state. `src/systems/action-category.ts:60`
- `interface ActionMapping<Def extends { id: string; }, State, Payload>` — Return type of the `mapAction` callback. `src/systems/action-category.ts:102`
- `interface ActionTickContext<Def extends { id: string; }, State, Payload>` — Context passed to a mapping's `tick` closure. `src/systems/action-category.ts:81`
- `function createActionCategory<Def extends { id: string; }, State = void, Payload = void>(options: ActionCategoryOptions<Def, State, Payload>): ActionCategory<Def, State, Payload>` — Create an action category — batch registration of typed action defs into an ordered-execution queue with per-execution state machine. `src/systems/action-category.ts:323`

## Automation tiers

progressive unlock of automation features

- `interface AutomationTierDef` — Definition for a single automation tier. `src/systems/automation.ts:53`
- `interface AutomationTiers` — An automation tiers instance — the returned object from createAutomationTiers. `src/systems/automation.ts:103`
- `interface AutomationTiersEvents` — Events emitted by an AutomationTiers instance. `src/systems/automation.ts:76`
- `interface AutomationTiersOptions` `src/systems/automation.ts:82`
- `function createAutomationTiers(options: AutomationTiersOptions): AutomationTiers` — Create an automation tier system for progressive automation unlocks. `src/systems/automation.ts:175`

## BestOf tracker

per-metric best-of-run recording

- `interface BestOf` — A BestOf instance — the returned object from createBestOf. `src/systems/best-of.ts:153`
- `interface BestOfCandidate` — A candidate submission for best-of comparison. `src/systems/best-of.ts:113`
- `interface BestOfEntry` — A single metric's best recorded outcome. `src/systems/best-of.ts:81`
- `interface BestOfEvents` — Events emitted by a BestOf instance. `src/systems/best-of.ts:127`
- `interface BestOfMetricDef` — Per-metric configuration for createBestOf. `src/systems/best-of.ts:41`
- `interface BestOfOptions` — Configuration for createBestOf. `src/systems/best-of.ts:133`
- `type BestOfStatus = 'valid' | 'stale'` — Validity status of a best-of entry. `src/systems/best-of.ts:78`
- `type CompareBy = 'observed' | 'projected'` — Which value to use for comparison when a projection function is provided. `src/systems/best-of.ts:38`
- `type ComparisonMode = 'absolute' | 'perSecond'` — How to compare candidates: highest absolute delta or highest delta/second. `src/systems/best-of.ts:35`
- `function createBestOf(options: BestOfOptions): BestOf` — Create a BestOf tracker that records the best cycle outcome per metric. `src/systems/best-of.ts:257`

## Challenge Category

batch-create Challenges from content definitions

- `interface Challenge` — A challenge instance with persistent state and lifecycle methods. `src/systems/challenge-category.ts:159`
- `interface ChallengeCategory<Def extends ChallengeDef, State = void> extends ResettableObject` — A challenge category — batch-registered challenges with shared lifecycle. `src/systems/challenge-category.ts:290`
- `interface ChallengeCategoryEntry<Def extends ChallengeDef, State = void>` — A registered entry in a challenge category. `src/systems/challenge-category.ts:212`
- `interface ChallengeCategoryOptions<Def extends ChallengeDef, State = void>` `src/systems/challenge-category.ts:225`
- `interface ChallengeDef<Overrides extends { [K in keyof Overrides]: (...args: never[]) => unknown; } = Record<string, (...args: never[]) => unknown>>` — Definition for a challenge. `src/systems/challenge-category.ts:65`
- `function createChallengeCategory<Def extends ChallengeDef, State = void>(options: ChallengeCategoryOptions<Def, State>): ChallengeCategory<Def, State>` — Create a challenge category for batch registration of challenges. `src/systems/challenge-category.ts:345`

## Cycle

a bounded run that ends, resets a scope, and replays

- `function createCycle(options: CycleOptions): Cycle` — Create a cycle — a bounded run that ends, resets a scope, and replays. `src/systems/cycle.ts:230`
- `interface Cycle extends ScopedReset` — A cycle instance — the returned object from createCycle. `src/systems/cycle.ts:132`
- `interface CycleEvents` — Events emitted by a Cycle instance. `src/systems/cycle.ts:37`
- `interface CycleOptions` `src/systems/cycle.ts:45`

## CycleLog

per-cycle metric delta recording

- `function createCycleLog(options: CycleLogOptions): CycleLog` — Create a CycleLog that records per-cycle metric deltas from a Cycle's lifecycle. `src/systems/cycle-log.ts:153`
- `interface CycleLog` — A CycleLog instance — the returned object from createCycleLog. `src/systems/cycle-log.ts:94`
- `interface CycleLogDelta` — Per-metric change recorded during a single cycle. `src/systems/cycle-log.ts:61`
- `interface CycleLogEntry` — A single cycle's recorded outcome. `src/systems/cycle-log.ts:70`
- `interface CycleLogEvents` — Events emitted by a CycleLog instance. `src/systems/cycle-log.ts:83`
- `const CycleLogKey: InjectionKey<CycleLog>` — Opt-in discovery key for introspection tools (sim, balance workbench, devtools). `src/systems/cycle-log.ts:42`
- `interface CycleLogOptions` — Configuration for createCycleLog. `src/systems/cycle-log.ts:45`

## Inventory

game-dev-friendly wrapper over ResourceBag

- `function createInventory(options: InventoryOptions): Inventory` — Creates a game inventory with per-item capacity driven by modifier chains, backed by a ResourceBag with optional auto-persistence. `src/systems/inventory.ts:111`
- `interface Inventory` — Inventory instance created by createInventory. `src/systems/inventory.ts:49`
- `interface InventoryOptions` — Options for createInventory — capacity, overflow behavior, and the initial item list. `src/systems/inventory.ts:20`

## Producer Category

batch-create Producers from content definitions

- `function createProducerCategory<Def extends { id: string; }, State = void>(options: ProducerCategoryOptions<Def, State>): ProducerCategory<Def, State>` — Create a producer category — batch registration of Producers from definitions. `src/systems/producer-category.ts:439`
- `interface Producer` — A producer instance — generates resources continuously or on demand. `src/systems/producer-category.ts:153`
- `interface ProducerCategory<Def extends { id: string; }, State = void> extends ResettableObject` — A producer category — batch-registered Producers with a shared production shape. `src/systems/producer-category.ts:241`
- `interface ProducerCategoryContext` — Context passed to the ProducerCategoryOptions.mapProducer callback. `src/systems/producer-category.ts:35`
- `interface ProducerCategoryEntry<Def extends { id: string; }, State = void>` — A registered entry: definition + Producer instance + optional state + introspection signals. `src/systems/producer-category.ts:228`
- `interface ProducerCategoryOptions<Def extends { id: string; }, State = void>` `src/systems/producer-category.ts:123`
- `interface ProducerMapping` — Return type of the ProducerCategoryOptions.mapProducer callback. `src/systems/producer-category.ts:70`
- `interface ProducerPurchaseConfig` — Purchase configuration for producers that can be bought multiple times. `src/systems/producer-category.ts:44`

## Purchasable

unified purchase primitives for incremental games

Two consumer entry points: `createPurchasableCategory` batch-registers from content definitions and is the default; `createScalingPurchasable` is the per-instance escape hatch for leveled costs. `createPurchasable` is the raw factory both lower into. A cost that scales on the item's own level goes through the factory form of `requirements`, which receives the live level ref — a getter reading the level back out misprices bulk purchases. See consumer-guide.md §Choosing among purchasable primitives.

- `function createPurchasableCategory<Def extends { id: string; }, State = void>(options: PurchasableCategoryOptions<Def, State>): PurchasableCategory<Def, State>` — Create a purchasable category — batch registration of Purchasables from definitions. `src/systems/purchasable-category.ts:203`
- `function createScalingPurchasable(options: ScalingPurchasableOptions, predicates?: PredicateResolver): Purchasable` — Create a purchasable with leveled cost scaling — the L3 escape hatch for per-instance customized leveled purchases. `src/systems/purchasable.ts:728`
- `interface Purchasable` — A purchasable — the returned object from createPurchasable. `src/systems/purchasable.ts:264`
- `interface PurchasableCategory<Def extends { id: string; }, State = void> extends ResettableObject` — A purchasable category — batch-registered Purchasables with a shared shape. `src/systems/purchasable-category.ts:121`
- `interface PurchasableCategoryEntry<Def extends { id: string; }, State = void>` — A registered entry: definition + Purchasable instance + optional state + introspection signals. `src/systems/purchasable-category.ts:108`
- `interface PurchasableCategoryOptions<Def extends { id: string; }, State = void>` `src/systems/purchasable-category.ts:68`
- `interface PurchasableDisplay` — UI text for a purchasable. `src/systems/purchasable.ts:57`
- `interface PurchasableEvents` — Events emitted by a Purchasable instance. `src/systems/purchasable.ts:51`
- `interface PurchasableOptions` — Full options for createPurchasable — the engine-internal raw factory. `src/systems/purchasable.ts:84`
- `type ScalingPurchasableCost` — Cost configuration for ScalingPurchasableOptions. `src/systems/purchasable.ts:157`
- `type ScalingPurchasableEffect` — Effect configuration for ScalingPurchasableOptions — at most one of `effect` (a static base or a plain function) or `effectFormula` (a Formula factory). `src/systems/purchasable.ts:198`
- `type ScalingPurchasableOptions` — Shorthand options for createScalingPurchasable — leveled purchases with geometric, Formula or function cost scaling. `src/systems/purchasable.ts:230`
- `function setupPolicyAutoPurchase(producers: ProducerCategory<{ id: string; }, unknown> | Producer[], options: SetupPolicyAutoPurchaseOptions, registerTick: RegisterTick): () => void` — Register a tick handler that auto-buys one producer per throttled beat according to a SelectionPolicy. `src/systems/auto-purchase.ts:481`
- `interface SetupPolicyAutoPurchaseOptions` `src/systems/auto-purchase.ts:352`
- `function setupSweepAutoPurchase(purchasables: PurchasableCategory<{ id: string; }, unknown> | Purchasable[], options: SetupSweepAutoPurchaseOptions, registerTick: RegisterTick): () => void` — Register a tick handler that sweeps a purchasable list, buying every candidate whose `canPurchase` is true. `src/systems/auto-purchase.ts:266`
- `interface SetupSweepAutoPurchaseOptions` `src/systems/auto-purchase.ts:125`

## RunPool

core primitive for managing a collection of opaque, addressable "runs" with independent lifecycle state

- `function createRunPool<Id = string>(options: RunPoolOptions): RunPool<Id>` — Creates a persistent pool of opaque runs with lifecycle events. `src/core/run-pool.ts:203`
- `type RunDeathOutcome` — Outcome of a run's death, returned synchronously from a per-instance `onDeath` callback. `src/core/run-pool.ts:47`
- `interface RunHandle<Id = string>` — Opaque handle to one run inside the pool. `src/core/run-pool.ts:53`
- `interface RunPool<Id = string> extends Emittable<RunPoolEvents<Id>>` — A pool of concurrent run instances — borglike clones, Cavernous loops, idle factory loops — sharing one death policy but each carrying its own step closure. `src/core/run-pool.ts:150`
- `interface RunPoolEvents<Id = string>` — Events emitted during pool lifecycle. `src/core/run-pool.ts:98`
- `interface RunPoolOptions` — Configuration for createRunPool. `src/core/run-pool.ts:126`
- `interface RunRegistration<Id = string>` — Registration payload for RunPool.addInstance: a stable id, the per-tick `step` function, and an optional `onDeath` override that supersedes the pool's `deathPolicy` for this specific instance. `src/core/run-pool.ts:87`
- `type RunStep = () => boolean` — One step of a run. `src/core/run-pool.ts:40`

## Skill

Skill helper for dual-tier loop incremental skills

- `interface AccumulatorSkill extends SkillBase` — Accumulator skill — modifier = 1 + permanentBonus. `src/systems/skill.ts:179`
- `interface AccumulatorSkillOptions extends SkillOptionsBase` — Accumulator mode — permanent bonus accumulates across loops. `src/systems/skill.ts:108`
- `function createSkill(options: AccumulatorSkillOptions): AccumulatorSkill` — Create a skill with XP tracking, computed level, and a reactive modifier. `src/systems/skill.ts:378`
- `function createSkill(options: LevelDrivenSkillOptions): LevelDrivenSkill` `src/systems/skill.ts:379`
- `function createSkill(options: SkillOptions): Skill` `src/systems/skill.ts:380`
- `function createSkillCategory<Def extends { id: string; }, State = void>(options: SkillCategoryOptions<Def, State>): SkillCategory<Def, State>` — Create a skill category — batch registration of Skills from definitions. `src/systems/skill-category.ts:183`
- `function getSkillProgress(skill: Skill): number` — Progress fraction (0–1) within the current level, for progress bar display. `src/systems/skill.ts:475`
- `function getSkillXPWindow(skill: Skill): { current: Decimal; needed: Decimal; }` — XP window for "N / M" display — how much XP into the current level and how much the current level spans. `src/systems/skill.ts:492`
- `interface LevelDrivenSkill extends SkillBase` — Level-driven skill — modifier = levelToMultiplier(level), no accumulator. `src/systems/skill.ts:167`
- `interface LevelDrivenSkillOptions extends SkillOptionsBase` — Level-driven mode — modifier tracks level reactively. `src/systems/skill.ts:124`
- `type Skill = LevelDrivenSkill | AccumulatorSkill` — A Skill in either mode — discriminated by the presence of `permanentBonus`. `src/systems/skill.ts:206`
- `interface SkillBase` — Fields present on all skills regardless of mode. `src/systems/skill.ts:138`
- `interface SkillCategory<Def extends { id: string; }, State = void> extends ResettableObject` — A skill category — batch-registered Skills with a shared shape. `src/systems/skill-category.ts:104`
- `interface SkillCategoryEntry<Def extends { id: string; }, State = void>` — A registered entry: definition + Skill instance + optional state + introspection signals. `src/systems/skill-category.ts:91`
- `interface SkillCategoryOptions<Def extends { id: string; }, State = void>` `src/systems/skill-category.ts:60`
- `type SkillCurve = (variable: MaybeRef<DecimalSource>) => FormulaSource` — Factory that binds a Formula to an engine-owned reactive variable. `src/systems/skill.ts:76`
- `interface SkillEvents` — Events emitted by a Skill instance. `src/systems/skill.ts:62`
- `type SkillOptions = AccumulatorSkillOptions | LevelDrivenSkillOptions` — Discriminated union of createSkill option shapes — accumulator (XP banks for retention) vs level-driven (level multiplies a curve). `src/systems/skill.ts:135`
- `interface SkillOptionsBase` — Shared option fields present in both skill modes. `src/systems/skill.ts:82`

## Slot

constrained persistent selection from a pool

- `function createSlot(options: SlotOptions): Slot` — Creates a slot — a constrained persistent selection from a pool. `src/systems/slot.ts:178`
- `interface Slot` — A constrained persistent selection from a pool, created by createSlot. `src/systems/slot.ts:107`
- `interface SlotEvents` — Events emitted by a Slot. `src/systems/slot.ts:92`
- `interface SlotOptions` — Configuration for createSlot. `src/systems/slot.ts:55`

## Zone

named content groupings with progressive unlock

- `function createZoneSystem(options?: ZoneSystemOptions): ZoneSystem` — Create a zone system — content groupings with progressive unlock. `src/systems/zone.ts:146`
- `interface ZoneDef` — Definition for a zone in the content registry. `src/systems/zone.ts:48`
- `interface ZoneSystem` — A zone system instance — the returned object from createZoneSystem. `src/systems/zone.ts:89`
- `interface ZoneSystemEvents` — Events emitted by a ZoneSystem instance. `src/systems/zone.ts:60`
- `interface ZoneSystemOptions` `src/systems/zone.ts:68`
