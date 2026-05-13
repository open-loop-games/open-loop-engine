# Content Systems

Currency-flow and long-arc structure systems — the validated incremental-game primitives. Purchasable / Producer / Achievement / Inventory / BestOf for economy; Skill / Loop / Challenge / Zone / Slot / AutomationTiers / LoopLog for progression. Each is a typed registration surface over the mechanics kernel; category factories batch-register many definitions.

## Canonical entrypoints

Start with these public symbols before scanning the full inventory below.

- `createProducerCategory` — buildings/generators whose ownership creates continuous resource flow.
- `createPurchasableCategory` — upgrades, gates, capped repeatables, perks, and bought effects in batch.
- `createAchievementCategory` — observed milestones and tier ladders that auto-earn.
- `createSkillCategory` — XP/level progression surfaces.
- `createLoop`, `createChallengeCategory`, `createInventory`, `createZoneSystem`, `createSlot`, `createAutomationTiers` — progression, inventory, grouping, selection, and automation surfaces.

## Achievement

milestone tracking with auto-unlock and tiered rewards

- `interface Achievement<T = unknown>` — A live achievement instance created by createAchievement. `src/systems/achievement.ts:109`
- `interface AchievementCategory<Def extends { id: string; }, State = void> extends ResettableObject` — An achievement category — batch-registered Achievements with a shared shape. `src/systems/achievement-category.ts:106`
- `interface AchievementCategoryEntry<Def extends { id: string; }, State = void>` — A registered entry: definition + Achievement instance + optional state + introspection signals. `src/systems/achievement-category.ts:93`
- `interface AchievementCategoryOptions<Def extends { id: string; }, State = void>` — Options for createAchievementCategory. `src/systems/achievement-category.ts:61`
- `const AchievementCategoryType: unique symbol` — Symbol identifying AchievementCategory features. `src/systems/achievement-category.ts:52`
- `interface AchievementDisplay` — Display text shown on an achievement tile. `src/systems/achievement.ts:45`
- `interface AchievementEvents` — Events emitted by an Achievement instance. `src/systems/achievement.ts:204`
- `interface AchievementGroup` — A named collection of achievements with aggregate completion tracking. `src/systems/achievement.ts:158`
- `interface AchievementGroupOptions` — Options for createAchievementGroup. `src/systems/achievement.ts:148`
- `interface AchievementOptions<T = unknown>` — Configuration for createAchievement. `src/systems/achievement.ts:63`
- `const AchievementType: unique symbol` — Symbol to identify Achievement features. `src/systems/achievement.ts:42`
- `function createAchievement<T = unknown>(options: AchievementOptions<T>): Achievement<T>` — Create an achievement — a once-and-stay-earned milestone with optional reactive effect and auto-completing requirement watch. `src/systems/achievement.ts:238`
- `function createAchievementCategory<Def extends { id: string; }, State = void>(options: AchievementCategoryOptions<Def, State>): AchievementCategory<Def, State>` — Create an achievement category — batch registration of Achievements from definitions. `src/systems/achievement-category.ts:174`
- `function createAchievementGroup(options: AchievementGroupOptions): AchievementGroup` — Bundle a fixed list of achievements into a named AchievementGroup with reactive earned-count, completion-percent, and all-earned aggregates. `src/systems/achievement.ts:458`
- `function createSimpleAchievement<T = unknown>(id: string, title: string, description: string, requirement: Computable<boolean> | Gate, effect?: T): Achievement<T>` — Positional shorthand over createAchievement for the common case of a one-line title + description and a single boolean requirement. `src/systems/achievement.ts:368`
- `function createTieredAchievement<T = number>(options: TieredAchievementOptions<T>): Achievement<T>[]` — Creates a series of achievements from threshold tiers, each auto-wired to complete when `getValue()` reaches its tier's threshold. `src/systems/achievement.ts:406`
- `function formatAchievementStatus(achievement: Achievement): string` — Localize an achievement's earned status as a human-readable string. `src/systems/achievement.ts:564`
- `function getAchievementEffect<T>(achievement: Achievement<T>, defaultValue: T): T` — Read an achievement's effect value, falling back to `defaultValue` when the achievement is unearned or has no effect configured. `src/systems/achievement.ts:495`
- `function getCombinedAchievementEffect(achievements: Achievement<number>[], base?: DecimalSource): Decimal` — Multiply effect values across earned achievements onto a base. `src/systems/achievement.ts:511`
- `function getEarnedCount(achievements: Achievement[]): number` — Reactive count of how many achievements in the list are currently earned. `src/systems/achievement.ts:550`
- `function getSummedAchievementEffect(achievements: Achievement<number>[], base?: DecimalSource): Decimal` — Additive counterpart to getCombinedAchievementEffect: sum effect values across earned achievements onto a base. `src/systems/achievement.ts:534`
- `function getVisibleAchievements(achievements: Achievement[]): Achievement[]` — Filter a list to the achievements that should be rendered in the UI. `src/systems/achievement.ts:581`
- `function isAchievement(value: unknown): value is Achievement` — Type guard for Achievement instances created by createAchievement. `src/systems/achievement.ts:555`
- `function isAchievementCategory(value: unknown): value is AchievementCategory<{ id: string; }, unknown>` — Type guard: returns `true` if the value is an AchievementCategory instance. `src/systems/achievement-category.ts:260`
- `interface TieredAchievementOptions<T = number>` — Options for createTieredAchievement. `src/systems/achievement.ts:174`

## Automation tiers

progressive unlock of automation features

- `interface AutomationTierDef` — Definition for a single automation tier. `src/systems/automation.ts:54`
- `interface AutomationTiers` — An automation tiers instance — the returned object from createAutomationTiers. `src/systems/automation.ts:101`
- `interface AutomationTiersEvents` — Events emitted by an AutomationTiers instance. `src/systems/automation.ts:75`
- `interface AutomationTiersOptions` — Options for createAutomationTiers. `src/systems/automation.ts:81`
- `const AutomationTiersType: unique symbol` — Symbol identifying AutomationTiers features. `src/systems/automation.ts:51`
- `function createAutomationTiers(options: AutomationTiersOptions): AutomationTiers` — Create an automation tier system for progressive automation unlocks. `src/systems/automation.ts:172`
- `function isAutomationTiers(value: unknown): value is AutomationTiers` — Type guard: returns `true` if the value is an AutomationTiers instance. `src/systems/automation.ts:278`

## BestOf tracker

per-metric best-of-run recording

- `interface BestOf` — A BestOf instance — the returned object from createBestOf. `src/systems/best-of.ts:151`
- `interface BestOfCandidate` — A candidate submission for best-of comparison. `src/systems/best-of.ts:111`
- `interface BestOfEntry` — A single metric's best recorded outcome. `src/systems/best-of.ts:79`
- `interface BestOfEvents` — Events emitted by a BestOf instance. `src/systems/best-of.ts:125`
- `interface BestOfMetricDef` — Per-metric configuration for createBestOf. `src/systems/best-of.ts:39`
- `interface BestOfOptions` — Configuration for createBestOf. `src/systems/best-of.ts:131`
- `type BestOfStatus = 'valid' | 'stale'` — Validity status of a best-of entry. `src/systems/best-of.ts:76`
- `const BestOfType: unique symbol` — Symbol identifying BestOf features. `src/systems/best-of.ts:30`
- `type CompareBy = 'observed' | 'projected'` — Which value to use for comparison when a projection function is provided. `src/systems/best-of.ts:36`
- `type ComparisonMode = 'absolute' | 'perSecond'` — How to compare candidates: highest absolute delta or highest delta/second. `src/systems/best-of.ts:33`
- `function createBestOf(options: BestOfOptions): BestOf` — Create a BestOf tracker that records the best loop outcome per metric. `src/systems/best-of.ts:243`
- `function isBestOf(value: unknown): value is BestOf` — Type guard: returns `true` if the value is a BestOf instance. `src/systems/best-of.ts:456`

## Challenge Category

batch-create Challenges from content definitions

- `interface Challenge` — A challenge instance with persistent state and lifecycle methods. `src/systems/challenge-category.ts:171`
- `interface ChallengeCategory<Def extends ChallengeDef, State = void> extends ResettableObject` — A challenge category — batch-registered challenges with shared lifecycle. `src/systems/challenge-category.ts:292`
- `interface ChallengeCategoryEntry<Def extends ChallengeDef, State = void>` — A registered entry in a challenge category. `src/systems/challenge-category.ts:217`
- `interface ChallengeCategoryOptions<Def extends ChallengeDef, State = void>` — Options for createChallengeCategory. `src/systems/challenge-category.ts:230`
- `const ChallengeCategoryType: unique symbol` — Symbol identifying ChallengeCategory features. `src/systems/challenge-category.ts:66`
- `interface ChallengeDef<Overrides extends Record<string, (...args: never[]) => unknown> = Record<string, (...args: never[]) => unknown>>` — Definition for a challenge. `src/systems/challenge-category.ts:74`
- `const ChallengeType: unique symbol` — Symbol identifying Challenge features. `src/systems/challenge-category.ts:63`
- `function createChallengeCategory<Def extends ChallengeDef, State = void>(options: ChallengeCategoryOptions<Def, State>): ChallengeCategory<Def, State>` — Create a challenge category for batch registration of challenges. `src/systems/challenge-category.ts:352`
- `function isChallenge(value: unknown): value is Challenge` — Type guard: returns `true` if the value is a Challenge instance. `src/systems/challenge-category.ts:655`
- `function isChallengeCategory(value: unknown): value is ChallengeCategory<ChallengeDef, unknown>` — Type guard: returns `true` if the value is a ChallengeCategory instance. `src/systems/challenge-category.ts:660`

## Inventory

game-dev-friendly wrapper over ResourceBag

- `function createInventory(options: InventoryOptions): Inventory` — Creates a game inventory with per-item capacity driven by modifier chains, backed by a ResourceBag with optional auto-persistence. `src/systems/inventory.ts:112`
- `interface Inventory` — Inventory instance created by createInventory. `src/systems/inventory.ts:50`
- `interface InventoryOptions` — Options for createInventory — capacity, overflow behavior, and the initial item list. `src/systems/inventory.ts:23`
- `const InventoryType: unique symbol` — Symbol identifying Inventory features. `src/systems/inventory.ts:20`
- `function isInventory(value: unknown): value is Inventory` — Type guard: returns `true` if the value is an Inventory instance. `src/systems/inventory.ts:251`

## Loop

constrained-replay incremental games

- `function createLoop(options: LoopOptions): Loop` — Create a loop — the core building block of loop-incremental games. `src/systems/loop.ts:174`
- `function isLoop(value: unknown): value is Loop` — Type guard: returns `true` if the value is a Loop instance. `src/systems/loop.ts:264`
- `interface Loop extends ScopedReset` — A loop instance — the returned object from createLoop. `src/systems/loop.ts:103`
- `interface LoopEvents` — Events emitted by a Loop instance. `src/systems/loop.ts:36`
- `interface LoopOptions` — Options for createLoop. `src/systems/loop.ts:44`
- `const LoopType: unique symbol` — Symbol identifying Loop features. `src/systems/loop.ts:33`

## LoopLog

per-loop metric delta recording

- `function createLoopLog(options: LoopLogOptions): LoopLog` — Create a LoopLog that records per-loop metric deltas from a Loop's lifecycle. `src/systems/loop-log.ts:153`
- `function isLoopLog(value: unknown): value is LoopLog` — Type guard: returns `true` if the value is a LoopLog instance. `src/systems/loop-log.ts:241`
- `interface LoopLog` — A LoopLog instance — the returned object from createLoopLog. `src/systems/loop-log.ts:98`
- `interface LoopLogDelta` — Per-metric change recorded during a single loop. `src/systems/loop-log.ts:65`
- `interface LoopLogEntry` — A single loop's recorded outcome. `src/systems/loop-log.ts:74`
- `interface LoopLogEvents` — Events emitted by a LoopLog instance. `src/systems/loop-log.ts:87`
- `const LoopLogKey: InjectionKey<LoopLog>` — Opt-in discovery key for introspection tools (sim, balance workbench, devtools). `src/systems/loop-log.ts:46`
- `interface LoopLogOptions` — Configuration for createLoopLog. `src/systems/loop-log.ts:49`
- `const LoopLogType: unique symbol` — Symbol identifying LoopLog features. `src/systems/loop-log.ts:30`

## Producer Category

batch-create Producers from content definitions

- `function createProducerCategory<Def extends { id: string; }, State = void>(options: ProducerCategoryOptions<Def, State>): ProducerCategory<Def, State>` — Create a producer category — batch registration of Producers from definitions. `src/systems/producer-category.ts:379`
- `function isProducerCategory(value: unknown): value is ProducerCategory<{ id: string; }, unknown>` — Type guard: returns `true` if the value is a ProducerCategory instance. `src/systems/producer-category.ts:457`
- `interface Producer` — A producer instance — generates resources continuously or on demand. `src/systems/producer-category.ts:135`
- `interface ProducerCategory<Def extends { id: string; }, State = void> extends ResettableObject` — A producer category — batch-registered Producers with a shared production shape. `src/systems/producer-category.ts:205`
- `interface ProducerCategoryContext` — Context passed to the ProducerCategoryOptions.mapProducer callback. `src/systems/producer-category.ts:38`
- `interface ProducerCategoryEntry<Def extends { id: string; }, State = void>` — A registered entry: definition + Producer instance + optional state + introspection signals. `src/systems/producer-category.ts:192`
- `interface ProducerCategoryOptions<Def extends { id: string; }, State = void>` — Options for createProducerCategory. `src/systems/producer-category.ts:105`
- `const ProducerCategoryType: unique symbol` — Symbol identifying ProducerCategory features. `src/systems/producer-category.ts:33`
- `interface ProducerMapping` — Return type of the ProducerCategoryOptions.mapProducer callback. `src/systems/producer-category.ts:70`
- `interface ProducerPurchaseConfig` — Purchase configuration for producers that can be bought multiple times. `src/systems/producer-category.ts:47`

## Purchasable

unified purchase primitives for incremental games

Three factories in increasing flexibility: `createSimplePurchasable` for static one-shot costs, `createScalingPurchasable` for leveled geometric scaling, `createPurchasable` for arbitrary requirements. See consumer-guide.md §Choosing among purchasable primitives.

- `function additiveEffect(perLevel: DecimalSource, base?: DecimalSource): (amount: DecimalSource) => DecimalSource` — Create an effect function where each level adds a flat amount: `base + perLevel * amount`. `src/systems/purchasable-effects.ts:59`
- `function createPurchasable<T extends PurchasableOptions>(options: T): Purchasable` — Create a purchasable with full control over requirements. `src/systems/purchasable.ts:574`
- `function createPurchasableCategory<Def extends { id: string; }, State = void>(options: PurchasableCategoryOptions<Def, State>): PurchasableCategory<Def, State>` — Create a purchasable category — batch registration of Purchasables from definitions. `src/systems/purchasable-category.ts:188`
- `function createPurchasableGroup(options: PurchasableGroupOptions): PurchasableGroup` — Group purchasables for aggregate tracking and bulk purchase. `src/systems/purchasable.ts:840`
- `function createScalingPurchasable<T extends ScalingPurchasableOptions>(options: T): Purchasable` — Create a purchasable with leveled cost scaling — the most common leveled pattern. `src/systems/purchasable.ts:755`
- `function createSimplePurchasable<T extends SimplePurchasableOptions>(options: T): Purchasable` — Create a purchasable with a simple resource cost — the most common one-shot pattern. `src/systems/purchasable.ts:696`
- `function diminishingEffect(cap: DecimalSource, rate?: DecimalSource): (amount: DecimalSource) => DecimalSource` — Create an effect function with diminishing returns that asymptotically approaches a cap. `src/systems/purchasable-effects.ts:112`
- `function formatPurchasable(purchasable: Purchasable): ComputedRef<string>` — Format a purchasable's amount as "N" or "N/limit" (e.g., "5/10"). `src/systems/purchasable.ts:864`
- `function getPurchasableEffect(purchasables: Purchasable[], base?: DecimalSource): ComputedRef<DecimalSource>` — Compute the multiplicative product of all purchasables' effects. `src/systems/purchasable-effects.ts:138`
- `function getPurchasableSum(purchasables: Purchasable[], base?: DecimalSource): ComputedRef<DecimalSource>` — Compute the additive sum of all purchasables' effects. `src/systems/purchasable-effects.ts:164`
- `function isPurchasable(value: unknown): value is Purchasable` — Type guard: returns `true` if the value is a Purchasable instance. `src/systems/purchasable.ts:874`
- `function isPurchasableCategory(value: unknown): value is PurchasableCategory<{ id: string; }, unknown>` — Type guard: returns `true` if the value is a PurchasableCategory instance. `src/systems/purchasable-category.ts:263`
- `function multiplicativeEffect(factor: DecimalSource): (amount: DecimalSource) => DecimalSource` — Create an effect function where each level multiplies: `factor ^ amount`. `src/systems/purchasable-effects.ts:36`
- `function polynomialEffect(power: DecimalSource, scale?: DecimalSource, base?: DecimalSource): (amount: DecimalSource) => DecimalSource` — Create an effect function with polynomial scaling: `base + scale * amount ^ power`. `src/systems/purchasable-effects.ts:84`
- `interface Purchasable` — A purchasable — the returned object from createPurchasable. `src/systems/purchasable.ts:233`
- `interface PurchasableCategory<Def extends { id: string; }, State = void> extends ResettableObject` — A purchasable category — batch-registered Purchasables with a shared shape. `src/systems/purchasable-category.ts:110`
- `interface PurchasableCategoryEntry<Def extends { id: string; }, State = void>` — A registered entry: definition + Purchasable instance + optional state + introspection signals. `src/systems/purchasable-category.ts:97`
- `interface PurchasableCategoryOptions<Def extends { id: string; }, State = void>` — Options for createPurchasableCategory. `src/systems/purchasable-category.ts:64`
- `const PurchasableCategoryType: unique symbol` — Symbol identifying PurchasableCategory features. `src/systems/purchasable-category.ts:55`
- `interface PurchasableDisplay` — UI text for a purchasable. `src/systems/purchasable.ts:66`
- `interface PurchasableEvents` — Events emitted by a Purchasable instance. `src/systems/purchasable.ts:60`
- `interface PurchasableGroup` — A managed collection of purchasables with aggregate queries and bulk operations. `src/systems/purchasable.ts:296`
- `interface PurchasableGroupOptions` — Options for createPurchasableGroup. `src/systems/purchasable.ts:290`
- `function purchasableModifierBinding(purchasable: Purchasable, effectOverride?: DecimalSource): { multiplier: ComputedRef<DecimalSource>; enabled: ComputedRef<boolean>; }` — Build a `{ multiplier, enabled }` binding from a purchasable, shaped for direct hand-off to a modifier chain. `src/systems/purchasable-effects.ts:207`
- `interface PurchasableOptions` — Full options for createPurchasable. `src/systems/purchasable.ts:90`
- `const PurchasableType: unique symbol` — Symbol identifying Purchasable features. `src/systems/purchasable.ts:57`
- `type ScalingPurchasableCost` — Cost configuration for ScalingPurchasableOptions. `src/systems/purchasable.ts:159`
- `type ScalingPurchasableOptions` — Shorthand options for createScalingPurchasable — leveled purchases with either geometric or closure-form cost scaling. `src/systems/purchasable.ts:189`
- `function setupPolicyAutoPurchase(producers: ProducerCategory<{ id: string; }, unknown> | Producer[], options: SetupPolicyAutoPurchaseOptions, registerTick: RegisterTick): () => void` — Register a tick handler that auto-buys one producer per throttled beat according to a SelectionPolicy. `src/systems/auto-purchase.ts:191`
- `interface SetupPolicyAutoPurchaseOptions` — Options for setupPolicyAutoPurchase. `src/systems/auto-purchase.ts:106`
- `function setupSweepAutoPurchase(purchasables: Purchasable[] | PurchasableGroup, enabled: Computable<boolean>, registerTick: (callback: (dt: number) => void) => () => void): () => void` — Register a tick handler that sweeps a purchasable list each frame, calling `purchaseMax()` on every candidate whose `canPurchase` is true. `src/systems/auto-purchase.ts:79`
- `interface SimplePurchasableOptions` — Shorthand options for createSimplePurchasable — the "costs X of resource Y" pattern. `src/systems/purchasable.ts:129`

## Skill

Skill helper for dual-tier loop incremental skills

- `interface AccumulatorSkill extends SkillBase` — Accumulator skill — modifier = 1 + permanentBonus. `src/systems/skill.ts:183`
- `interface AccumulatorSkillOptions extends SkillOptionsBase` — Accumulator mode — permanent bonus accumulates across loops. `src/systems/skill.ts:111`
- `function createSkill(options: AccumulatorSkillOptions): AccumulatorSkill` — Create a skill with XP tracking, computed level, and a reactive modifier. `src/systems/skill.ts:368`
- `function createSkillCategory<Def extends { id: string; }, State = void>(options: SkillCategoryOptions<Def, State>): SkillCategory<Def, State>` — Create a skill category — batch registration of Skills from definitions. `src/systems/skill-category.ts:179`
- `function getSkillProgress(skill: Skill): number` — Progress fraction (0–1) within the current level, for progress bar display. `src/systems/skill.ts:454`
- `function getSkillXPWindow(skill: Skill): { current: Decimal; needed: Decimal; }` — XP window for "N / M" display — how much XP into the current level and how much the current level spans. `src/systems/skill.ts:473`
- `function isAccumulatorSkill(value: unknown): value is AccumulatorSkill` — Check if a skill is in accumulator mode (has permanentBonus + accumulateBonus). `src/systems/skill.ts:443`
- `function isSkill(value: unknown): value is Skill` — Check if a value is a Skill (either mode). `src/systems/skill.ts:438`
- `function isSkillCategory(value: unknown): value is SkillCategory<{ id: string; }, unknown>` — Type guard: returns `true` if the value is a SkillCategory instance. `src/systems/skill-category.ts:259`
- `interface LevelDrivenSkill extends SkillBase` — Level-driven skill — modifier = levelToMultiplier(level), no accumulator. `src/systems/skill.ts:171`
- `interface LevelDrivenSkillOptions extends SkillOptionsBase` — Level-driven mode — modifier tracks level reactively. `src/systems/skill.ts:127`
- `type Skill = LevelDrivenSkill | AccumulatorSkill` — A Skill in either mode — discriminated by the presence of `permanentBonus`. `src/systems/skill.ts:206`
- `interface SkillBase` — Fields present on all skills regardless of mode. `src/systems/skill.ts:141`
- `interface SkillCategory<Def extends { id: string; }, State = void> extends ResettableObject` — A skill category — batch-registered Skills with a shared shape. `src/systems/skill-category.ts:104`
- `interface SkillCategoryEntry<Def extends { id: string; }, State = void>` — A registered entry: definition + Skill instance + optional state + introspection signals. `src/systems/skill-category.ts:91`
- `interface SkillCategoryOptions<Def extends { id: string; }, State = void>` — Options for createSkillCategory. `src/systems/skill-category.ts:61`
- `const SkillCategoryType: unique symbol` — Symbol identifying SkillCategory features. `src/systems/skill-category.ts:52`
- `type SkillCurve = (variable: MaybeRef<DecimalSource>) => FormulaSource` — Factory that binds a Formula to an engine-owned reactive variable. `src/systems/skill.ts:79`
- `interface SkillEvents` — Events emitted by a Skill instance. `src/systems/skill.ts:65`
- `type SkillOptions = AccumulatorSkillOptions | LevelDrivenSkillOptions` — Discriminated union of createSkill option shapes — accumulator (XP banks for retention) vs level-driven (level multiplies a curve). `src/systems/skill.ts:138`
- `interface SkillOptionsBase` — Shared option fields present in both skill modes. `src/systems/skill.ts:85`
- `const SkillType: unique symbol` — Symbol identifying Skill features (both modes). `src/systems/skill.ts:60`

## Slot

constrained persistent selection from a pool

- `function createSlot(options: SlotOptions): Slot` — Creates a slot — a constrained persistent selection from a pool. `src/systems/slot.ts:168`
- `function isSlot(value: unknown): value is Slot` — Type guard: returns `true` if the value is a Slot instance. `src/systems/slot.ts:308`
- `interface Slot` — A constrained persistent selection from a pool, created by createSlot. `src/systems/slot.ts:101`
- `interface SlotEvents` — Events emitted by a Slot. `src/systems/slot.ts:86`
- `interface SlotOptions` — Configuration for createSlot. `src/systems/slot.ts:57`
- `const SlotType: unique symbol` — Symbol identifying Slot features. `src/systems/slot.ts:54`

## Zone

named content groupings with progressive unlock

- `function createZoneSystem(options?: ZoneSystemOptions): ZoneSystem` — Create a zone system — content groupings with progressive unlock. `src/systems/zone.ts:146`
- `function isZoneSystem(value: unknown): value is ZoneSystem` — Type guard: returns `true` if the value is a ZoneSystem instance. `src/systems/zone.ts:216`
- `interface ZoneDef` — Definition for a zone in the content registry. `src/systems/zone.ts:51`
- `interface ZoneSystem` — A zone system instance — the returned object from createZoneSystem. `src/systems/zone.ts:86`
- `interface ZoneSystemEvents` — Events emitted by a ZoneSystem instance. `src/systems/zone.ts:60`
- `interface ZoneSystemOptions` — Options for createZoneSystem. `src/systems/zone.ts:68`
- `const ZoneSystemType: unique symbol` — Symbol identifying ZoneSystem features. `src/systems/zone.ts:48`
