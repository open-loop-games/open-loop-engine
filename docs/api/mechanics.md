# Mechanics

The composable evaluation kernel. Modifier chains, requirements, formulas, computed bindings, conditions, effects, gates, and trace. Pure-function evaluation (no Vue dependency in the core) plus reactive wrappers — the substrate the content systems compose against.

## Canonical entrypoints

Start with these public symbols before scanning the full inventory below.

- `createModifierChain` plus `chain.bind` — shared bonus surfaces and attributed conditional modifiers.
- `createCostRequirement` / `createBooleanRequirement` — spend-bearing and predicate-only requirements.
- `F` / `Formula` / `calculateMaxAffordable` — cost curves, inversion, and max-buy previews.
- `Gate` / `C` / `E` — declarative predicates and effects when save/mod/sim data needs serializable shape.
- `createTimedProgress` — tick-driven progress for actions, workers, and staged costs.

## Closed-form beat-timing math

computes the `T(n) = Cost(n) / Production(n)` snapshot used by balance/devtools to label arbitrary (cost, rate, level) samples without booting a live engine

- `interface BeatTimingParams` — Parameters for calculateBeatTiming. `src/core/beat-timing.ts:20`
- `function calculateBeatTiming(params: BeatTimingParams): Decimal` — Closed-form beat timing: time (in seconds) to afford the next purchase at level `n`, given a fully-stacked per-unit production rate. `src/core/beat-timing.ts:61`
- `type CostScalingType = 'exponential' | 'linear' | 'polynomial'` — Cost scaling family for calculateBeatTiming. `src/core/beat-timing.ts:17`

## Common

shared generic type utilities and dev-mode helpers

- `type RequiredKeys<T>` — Extract keys that are required (non-optional) from a type. `src/core/common.ts:6`

## Computed

`Computable<T>` and getter utilities for Vue reactive inputs

- `type Computable<T> = T | Readonly<Ref<T>> | (() => T)` — A reactive input that may be a direct value, a Vue ref/computed, or a getter function. `src/core/computed.ts:20`
- `type MaybeGetter<T> = T | (() => T)` — A value that may be a direct value or a getter function (no refs). `src/core/computed.ts:25`
- `function processGetter<T>(obj: Computable<T>): MaybeRef<T>` — Process a value that may be a getter function. `src/core/computed.ts:63`
- `function resolveComputable<T>(value: Computable<T>): T` — Unwrap a Computable to its current value in a single step. `src/core/computed.ts:36`

## Conditions

declarative predicate evaluation over `GameStateAccessor`

- `const C` — Ergonomic factories for constructing ICondition values. `src/core/conditions.ts:152`
- `function evaluateCondition(condition: ICondition, accessor: GameStateAccessor): boolean` — Evaluate a declarative ICondition against the given game-state accessor. `src/core/conditions.ts:78`
- `function extractDependencies(condition: ICondition): string[]` — Collect the dotted-path dependencies referenced by a condition tree — `resources.<id>.amount`, `unlocks.<id>`, and any state targets — deduped and returned as a flat array. `src/core/conditions.ts:126`

## Effects

declarative game-state mutations from `IEffect` ASTs

- `function applyEffect(effect: IEffect, accessor: GameStateAccessor, mutator: GameStateMutator): void` — Resolve an effect and apply it to game state via the mutator. `src/core/effects.ts:92`
- `const E` — Ergonomic factories for constructing IEffect values. `src/core/effects.ts:134`
- `interface GameStateMutator` — Mutation interface for applying resolved effects to game state. `src/core/effects.ts:32`
- `interface ResolvedEffect` — A fully resolved effect with all formulas evaluated — ready for mutation. `src/core/effects.ts:20`
- `function resolveEffect(effect: IEffect, accessor: GameStateAccessor): ResolvedEffect[]` — Flatten a declarative IEffect into a list of concrete ResolvedEffect steps. `src/core/effects.ts:59`
- `function createPersistentEffectSystem(options: PersistentEffectSystemOptions): PersistentEffectSystem` — Create a persistent effect system for managing condition-driven effects. `src/systems/persistent-effect.ts:171`
- `function createTemporaryEffectSystem(options: TemporaryEffectSystemOptions): TemporaryEffectSystem` — Create a temporary effect system for managing time-limited effects. `src/systems/temporary-effect.ts:194`
- `interface EffectModifierBinding` — Binds a modifier to a `ModifierChain` while the effect is active. `src/systems/effect-modifier-binding.ts:20`
- `interface PersistentEffectDef` — Definition for a persistent effect, registered at startup. `src/systems/persistent-effect.ts:54`
- `interface PersistentEffectEvents` — Events emitted by the persistent effect system. `src/systems/persistent-effect.ts:77`
- `interface PersistentEffectSystem` — Manages persistent effects: registration, condition watching, and edge-triggered binding. `src/systems/persistent-effect.ts:91`
- `interface PersistentEffectSystemOptions` — Options for createPersistentEffectSystem. `src/systems/persistent-effect.ts:85`
- `function replacementBinding(options: ReplacementBindingOptions): EffectModifierBinding[]` — Build a cancel-then-replace binding pair for a modifier chain. `src/systems/effect-modifier-binding.ts:92`
- `interface ReplacementBindingOptions` — Options for replacementBinding. `src/systems/effect-modifier-binding.ts:31`
- `interface TemporaryEffectDef` — Definition for a temporary effect, registered at startup. `src/systems/temporary-effect.ts:56`
- `interface TemporaryEffectEvents` — Events emitted by the temporary effect system. `src/systems/temporary-effect.ts:106`
- `interface TemporaryEffectInstance` — A live instance of a temporary effect, created by TemporaryEffectSystem.apply. `src/systems/temporary-effect.ts:90`
- `interface TemporaryEffectSystem` — Manages temporary effects: registration, activation, tick countdown, and cleanup. `src/systems/temporary-effect.ts:124`
- `interface TemporaryEffectSystemOptions` — Options for createTemporaryEffectSystem. `src/systems/temporary-effect.ts:116`

## Formulas

Algebraic expression trees with evaluate / invert / integrate.

- `type BinaryFormulaInstanceOp = (other: FormulaSource) => GenericFormula` — Instance-side signature of a binary op (`formula.add(other)`). `src/core/formulas/formulas.ts:77`
- `type BinaryFormulaOp = (value: FormulaSource, other: FormulaSource) => GenericFormula` — Signature of a two-argument formula op (e.g. `src/core/formulas/formulas.ts:72`
- `function calculateCost(formula: InvertibleFormula, amountToBuy: DecimalSource, cumulativeCost?: true, directSum?: number): DecimalSource` — Calculate the total cost of purchasing a specific number of levels. `src/core/formulas/formulas.ts:1342`
- `function calculateMaxAffordable(formula: GenericFormula, resource: Resource, cumulativeCost?: Computable<boolean>, directSum?: Computable<number>, maxBulkAmount?: Computable<DecimalSource>): import("vue").ComputedRef<DecimalSource>` — Calculate the maximum number of purchases affordable with the current resource amount. `src/core/formulas/formulas.ts:1154`
- `type ConstantFormulaOptions` — Options for creating a constant formula (a fixed numeric value). `src/core/formulas/types.ts:77`
- `type EvaluateFunction<T extends FormulaSource[]> = (this: Formula<T>, ...inputs: GuardedFormulasToDecimals<T>) => DecimalSource` — Forward evaluation function signature — used in GeneralFormulaOptions. `src/core/formulas/types.ts:44`
- `const F: typeof Formula & FormulaStaticOps` — Formula constructor with full static typings for dynamically-registered operations. `src/core/formulas/formulas.ts:1078`
- `function findNonInvertible(formula: GenericFormula): GenericFormula | null` — Debug helper: find the operation that breaks invertibility in a formula chain. `src/core/formulas/formulas.ts:1128`
- `class Formula<T extends [FormulaSource] | FormulaSource[] = FormulaSource[]>` — A composable math expression that supports forward evaluation, backward inversion, and cumulative integration. `src/core/formulas/formulas.ts:325`
- `interface FormulaInstanceOps` — Instance-side mirror of FormulaStaticOps — the methods `registerOps` adds to `Formula.prototype`. `src/core/formulas/formulas.ts:147`
- `type FormulaOptions<T extends [FormulaSource] | FormulaSource[]> = VariableFormulaOptions | ConstantFormulaOptions | GeneralFormulaOptions<T>` — Union of all formula constructor option shapes. `src/core/formulas/types.ts:94`
- `type FormulaSource = MaybeRef<DecimalSource> | GenericFormula` — A formula or a raw Decimal value — the universal input type for formula operations. `src/core/formulas/types.ts:24`
- `interface FormulaStaticOps` — Type of the static methods `registerOps` adds to F. `src/core/formulas/formulas.ts:84`
- `type FormulasToDecimals<T extends FormulaSource[]>` — Map a tuple of FormulaSource inputs to a tuple of DecimalSource outputs — the value shape `internalEvaluate` / `internalInvert` see at runtime. `src/core/formulas/types.ts:120`
- `type GeneralFormulaOptions<T extends [FormulaSource] | FormulaSource[]>` — Options for creating a formula with custom evaluate/invert/integrate functions. `src/core/formulas/types.ts:83`
- `type GenericFormula = Formula<any>` — Any Formula instance, regardless of capability. `src/core/formulas/types.ts:21`
- `type GuardedFormulasToDecimals<T extends FormulaSource[]> = TupleGuard<T>` — Inference-friendly alias of FormulasToDecimals that keeps tuple positions intact under TypeScript's mapped-type rules. `src/core/formulas/types.ts:136`
- `function hasVariable(value: FormulaSource): value is InvertibleFormula` — Check if a formula source contains exactly one variable (required for inversion). `src/core/formulas/formulas.ts:50`
- `type IntegrableFormula` — A formula that supports cumulative cost calculation via integration. `src/core/formulas/types.ts:32`
- `type IntegrateFunction<T extends FormulaSource[]> = (this: Formula<T>, stack: SubstitutionStack | undefined, ...inputs: T) => GenericFormula` — Integration function signature — used in GeneralFormulaOptions. `src/core/formulas/types.ts:57`
- `type InvertFunction<T extends FormulaSource[]> = (this: Formula<T>, value: DecimalSource, ...inputs: T) => DecimalSource` — Inversion function signature — used in GeneralFormulaOptions. `src/core/formulas/types.ts:50`
- `type InvertibleFormula` — A formula that supports backward evaluation (invert). `src/core/formulas/types.ts:27`
- `type InvertibleIntegralFormula` — A formula with full capability: evaluate, invert, integrate, and invert the integral. `src/core/formulas/types.ts:39`
- `function isFormula(value: unknown): value is GenericFormula` — Type guard for Formula instances. `src/core/formulas/formulas.ts:45`
- `type SubstitutionFunction<T extends FormulaSource[]> = (this: Formula<T>, variable: GenericFormula, ...inputs: T) => GenericFormula` — Substitution function signature (for nested integration) — used in GeneralFormulaOptions. `src/core/formulas/types.ts:64`
- `type SubstitutionStack = ((value: GenericFormula) => GenericFormula)[] | undefined` — Stack of substitution functions used during nested integration. `src/core/formulas/types.ts:113`
- `type TupleGuard<T extends any[]> = T extends any[] ? FormulasToDecimals<T> : never` — Conditional wrapper that preserves the tuple shape through mapped-type inference. `src/core/formulas/types.ts:130`
- `type UnaryFormulaInstanceOp = () => GenericFormula` — Instance-side signature of a unary op (`formula.neg()`). `src/core/formulas/formulas.ts:75`
- `type UnaryFormulaOp = (value: FormulaSource) => GenericFormula` — Signature of a one-argument formula op (e.g. `src/core/formulas/formulas.ts:70`
- `function unrefFormulaSource(value: FormulaSource, variable?: DecimalSource): DecimalSource` — Evaluate a FormulaSource to a DecimalSource — unwraps refs and evaluates formulas. `src/core/formulas/formulas.ts:55`
- `type VariableFormulaOptions` — Options for creating a variable formula (the "x" in a cost function). `src/core/formulas/types.ts:71`

## Gate

consumer-facing predicate-spec data shape over the engine's existing substrate. Cross-cuts every requirement-bearing field where today consumers either reach for `C.*` (exposes engine-internal vocabulary) or fall back to opaque `Computable<boolean>` closures (loses predictor introspection)

- `interface AllGate` — True when every child Gate is true. `src/systems/gate.ts:141`
- `interface AnyGate` — True when at least one child Gate is true. `src/systems/gate.ts:147`
- `interface CountGteGate` — True when the entity's `count` signal is `>= value`. `src/systems/gate.ts:91`
- `function createGateRequirement(options: GateRequirementOptions): Requirement` — Build a Requirement that's met whenever its Gate evaluates truthy. `src/systems/gate.ts:451`
- `interface CumulativeGteGate` — True when `resource.cumulative.value >= value`. `src/systems/gate.ts:79`
- `function evaluateGate(gate: Gate, runtime: GateRuntime): boolean` — Resolve a Gate to its current truth value against the engine's live state. `src/systems/gate.ts:269`
- `interface FlagGate` — True when `accessor.isUnlocked(id)` returns true. `src/systems/gate.ts:135`
- `type Gate = ResourceGteGate | CumulativeGteGate | CountGteGate | UnlockGate | StateGate | FlagGate | AllGate | AnyGate | NotGate` — Typed declarative predicate spec. `src/systems/gate.ts:165`
- `interface GateRequirementOptions` — Options for createGateRequirement. `src/systems/gate.ts:418`
- `interface GateRuntime` — The three engine handles evaluateGate and timeUntilGateFlip need at runtime. `src/systems/gate.ts:187`
- `function gateToCondition(gate: Gate): ICondition` — Project a Gate AST to ICondition. `src/systems/gate.ts:386`
- `function getAmbientGateRuntime(override?: Partial<GateRuntime>): GateRuntime` — Resolve the three ambient handles into a GateRuntime bundle. `src/systems/gate.ts:207`
- `function isGate(value: unknown): value is Gate` — Type guard for Gate. `src/systems/gate.ts:232`
- `interface NotGate` — True when the wrapped Gate is false. `src/systems/gate.ts:153`
- `interface ResourceGteGate` — True when `accessor.getResource(resource) >= value`. `src/systems/gate.ts:66`
- `interface StateGate` — True when the comparison `accessor.getState(key) <op> value` holds. `src/systems/gate.ts:115`
- `function timeUntilGateFlip(gate: Gate, runtime: GateRuntime): TransitionDistance` — Distance until `gate` flips truth value at current rates. `src/systems/gate.ts:314`
- `interface UnlockGate` — True when the entity's `unlock` signal is true. `src/systems/gate.ts:103`

## Modifier

composable value calculation chains

- `interface AdditiveModifierOptions` — Options for createAdditiveModifier. `src/core/modifier.ts:64`
- `function applyModifier(modifier: Modifier, value: DecimalSource): DecimalSource` — Apply a single modifier to a value. `src/core/modifier.ts:705`
- `function applyModifiers(modifiers: Modifier[], value: DecimalSource): DecimalSource` — Apply multiple modifiers in sequence to a value (left to right). `src/core/modifier.ts:719`
- `interface BindingRecord` — Attribution record for a single bound modifier, returned by ModifierChain.bindings. `src/core/modifier.ts:402`
- `interface BindOptions` — Options for ModifierChain.bind. `src/core/modifier.ts:374`
- `function computeModifiedValue(base: Computable<DecimalSource>, modifiers: Modifier[]): ComputedRef<DecimalSource>` — Create a computed ref that applies modifiers to a base value. `src/core/modifier.ts:758`
- `function createAdditiveModifier<T extends AdditiveModifierOptions, S = OperationModifier<T>>(options: T): S` — Create a modifier that adds a value to the input. `src/core/modifier.ts:90`
- `function createExponentialModifier<T extends ExponentialModifierOptions, S = OperationModifier<T>>(options: T): S` — Create a modifier that raises the input to a power. `src/core/modifier.ts:222`
- `function createModifierChain(id: string): ModifierChain` — Create a named modifier chain that other modules can push modifiers into. `src/core/modifier.ts:562`
- `function createMultiplicativeModifier<T extends MultiplicativeModifierOptions, S = OperationModifier<T>>(options: T): S` — Create a modifier that multiplies the input by a value. `src/core/modifier.ts:159`
- `function createSequentialModifier<T extends Modifier, S = WithRequired<Modifier, Extract<RequiredKeys<T>, keyof Modifier>> & { readonly children: readonly T[]; }>(modifiers: T[]): S` — Compose multiple modifiers into a single pipeline that applies them in order. `src/core/modifier.ts:305`
- `interface ExponentialModifierOptions` — Options for createExponentialModifier. `src/core/modifier.ts:190`
- `type Grant` — Declarative binding entry — the shape consumers use inside per-category declarative fields (`grants` / `restricts` / `rewards`). `src/core/modifier.ts:430`
- `function invertModifier(modifier: Modifier, value: DecimalSource): DecimalSource | undefined` — Invert a modifier: given a desired output, find the input that produces it. `src/core/modifier.ts:732`
- `interface Modifier` — A single step in a value calculation pipeline. `src/core/modifier.ts:32`
- `interface ModifierChain extends Modifier` — A named, auto-composing sequential modifier that acts as a registry. `src/core/modifier.ts:471`
- `interface ModifierChainEvents` — Events emitted by a ModifierChain. `src/core/modifier.ts:361`
- `interface ModifierDescription` — A single line in a modifier breakdown, suitable for rendering in a tooltip or info panel. `src/core/modifier.ts:44`
- `interface MultiplicativeModifierOptions` — Options for createMultiplicativeModifier. `src/core/modifier.ts:121`
- `type OperationModifier<T> = WithRequired<Modifier, 'invert' | Extract<RequiredKeys<T>, keyof Modifier>>` — Utility type for modifiers that have all optional methods defined. `src/core/modifier.ts:56`

## Requirements

Requirements system for gating purchases, unlocks, and actions

- `function allOf(...children: Requirement[]): Requirement` — Compose requirements with AND semantics. `src/core/requirements.ts:371`
- `function anyOf(...children: Requirement[]): Requirement` — Compose requirements with OR semantics. `src/core/requirements.ts:320`
- `interface BooleanRequirementOptions` — Options for creating a boolean requirement. `src/core/requirements.ts:246`
- `interface CostRequirement extends Requirement` — A requirement that costs a resource to satisfy. `src/core/requirements.ts:112`
- `interface CostRequirementOptions` — Options for creating a cost requirement. `src/core/requirements.ts:76`
- `function createBooleanRequirement<T extends BooleanRequirementOptions>(options: T): Requirement` — Create a simple true/false requirement. `src/core/requirements.ts:267`
- `function createCostRequirement<T extends CostRequirementOptions>(options: T): CostRequirement` — Create a requirement based on spending a resource. `src/core/requirements.ts:151`
- `function createResetPay(overrideValue?: DecimalSource): (amount?: DecimalSource) => void` — Create a pay function that resets to default. `src/core/requirements.ts:490`
- `function getRequirementDescriptions(requirements: Requirements): string[]` — Get descriptions for all requirements. `src/core/requirements.ts:462`
- `function isCostRequirement(req: Requirement): req is CostRequirement` — Check if a requirement is a cost requirement. `src/core/requirements.ts:501`
- `function maxRequirementsMet(requirements: Requirements): DecimalSource` — Calculate the maximum number of times requirements can be met. `src/core/requirements.ts:415`
- `function payByDivision(requirement: CostRequirement, amount?: DecimalSource): void` — Pay strategy: divide resource instead of subtract. `src/core/requirements.ts:473`
- `function payByReset(requirement: CostRequirement, overrideValue?: DecimalSource): void` — Pay strategy: reset resource to default value. `src/core/requirements.ts:482`
- `function payRequirements(requirements: Requirements, amount?: DecimalSource): void` — Pay the costs for one or more requirements. `src/core/requirements.ts:444`
- `interface Requirement` — Base requirement interface. `src/core/requirements.ts:28`
- `type Requirements = Requirement | Requirement[]` — Utility type for accepting one or more requirements. `src/core/requirements.ts:69`
- `function requirementsMet(requirements: Requirements): boolean` — Check if all requirements are met. `src/core/requirements.ts:399`

## TimedProgress

stateless tickable progress accumulator

- `function createTimedProgress(options: TimedProgressOptions): TimedProgress` — Creates a stateless progress accumulator that ticks on every registered tick, advancing `progress` by `speed * dt` each time. `src/core/timed-progress.ts:219`
- `interface ProgressiveCostEntry` — One progressive-cost entry — amount total across a full run, plus a live balance getter the primitive calls to decide affordability. `src/core/timed-progress.ts:276`
- `interface ProgressiveCostStep` — Result of one stepProgressiveCosts evaluation. `src/core/timed-progress.ts:284`
- `function resourceConsumedAt(progress: DecimalSource, duration: DecimalSource, amount: DecimalSource): Decimal` — How many whole resource units should be consumed at a given progress level. `src/core/timed-progress.ts:263`
- `function stepProgressiveCosts(opts: { prevProgress: DecimalSource; proposedProgress: DecimalSource; duration: DecimalSource; costs: readonly ProgressiveCostEntry[]; }): ProgressiveCostStep` — Compute one tick of progressive-cost metering. `src/core/timed-progress.ts:367`
- `interface TimedProgress` — A stateless ticking progress accumulator created by createTimedProgress. `src/core/timed-progress.ts:66`
- `interface TimedProgressOptions` — Options for createTimedProgress. `src/core/timed-progress.ts:33`

## Trace

Resource mutation tracing system

- `function enableTracing(): () => void` — Enable the trace system for the duration of a subscription. `src/core/trace.ts:45`
- `function getCurrentTraceEntries(): readonly TraceEntry[]` — Get trace entries for the current (in-progress) tick. `src/core/trace.ts:156`
- `function getPreviousTraceEntries(): readonly TraceEntry[]` — Get trace entries for the previous (completed) tick. `src/core/trace.ts:161`
- `function getTraceTick(): number` — Get the current tick number. `src/core/trace.ts:151`
- `interface TraceEntry` — A single resource mutation recorded by the trace system. `src/core/trace.ts:17`
- `function withChain<T>(chain: Modifier, fn: () => T): T` — Execute a callback with modifier chain attribution. `src/core/trace.ts:84`
