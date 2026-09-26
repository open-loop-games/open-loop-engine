# Mechanics

The composable evaluation kernel — modifier chains, requirements, formulas, computed bindings, effects, gates, trace. Pure evaluation plus reactive wrappers; the substrate content systems compose against.

## Canonical entrypoints

- `createModifierChain` plus `chain.bind` — shared bonus surfaces and attributed conditional modifiers.
- `createCostRequirement` / `createBooleanRequirement` — spend-bearing and predicate-only requirements.
- `F` / `Formula` / `calculateMaxAffordable` — cost curves, inversion, and max-buy previews.
- `Gate` / `E` — declarative predicates and effects when save/mod/sim data needs serializable shape.
- `createTimedProgress` — tick-driven progress for actions, workers, and staged costs.

## Common

shared generic type utilities and dev-mode helpers

- `type RequiredKeys<T>` — Extract keys that are required (non-optional) from a type. `src/core/common.ts:6`

## Computed

`Computable<T>` and getter utilities for Vue reactive inputs

- `type Computable<T> = T | Readonly<Ref<T>> | (() => T)` — A reactive input that may be a direct value, a Vue ref/computed, or a getter function. `src/core/computed.ts:20`
- `type MaybeGetter<T> = T | (() => T)` — A value that may be a direct value or a getter function (no refs). `src/core/computed.ts:25`
- `function processGetter<T>(obj: Computable<T>): MaybeRef<T>` — Process a value that may be a getter function. `src/core/computed.ts:63`
- `function resolveComputable<T>(value: Computable<T>): T` — Unwrap a Computable to its current value in a single step. `src/core/computed.ts:36`

## Effects

declarative game-state mutations from `IEffect` ASTs

- `function applyEffect(effect: IEffectInternal, accessor: GameStateAccessor, mutator: GameStateMutator): void` — Apply an effect to game state via the mutator. `src/core/effects.ts:103`
- `const E` — Ergonomic factories for constructing IEffect values. `src/core/effects.ts:146`
- `interface GameStateMutator` — Mutation interface for applying resolved effects to game state. `src/core/effects.ts:32`
- `interface ResolvedEffect` — A fully resolved effect with all formulas evaluated — ready for mutation. `src/core/effects.ts:20`
- `function resolveEffect(effect: IEffectInternal, accessor: GameStateAccessor): ResolvedEffect[]` — Flatten a declarative IEffectInternal into a list of concrete ResolvedEffect steps. `src/core/effects.ts:67`
- `function createPersistentEffectSystem(options: PersistentEffectSystemOptions): PersistentEffectSystem` — Create a persistent effect system for managing condition-driven effects. `src/systems/persistent-effect.ts:181`
- `function createTemporaryEffectSystem(options: TemporaryEffectSystemOptions): TemporaryEffectSystem` — Create a temporary effect system for managing time-limited effects. `src/systems/temporary-effect.ts:224`
- `interface PersistentEffectDef` — Definition for a persistent effect, registered at startup. `src/systems/persistent-effect.ts:51`
- `interface PersistentEffectEvents` — Events emitted by the persistent effect system. `src/systems/persistent-effect.ts:84`
- `interface PersistentEffectSystem` — Manages persistent effects: registration, condition watching, and edge-triggered binding. `src/systems/persistent-effect.ts:98`
- `interface PersistentEffectSystemOptions` `src/systems/persistent-effect.ts:92`
- `function replacementBinding(options: ReplacementBindingOptions): Grant[]` — Build a cancel-then-replace binding pair for a modifier chain. `src/systems/modifier-binding.ts:105`
- `interface ReplacementBindingOptions` `src/systems/modifier-binding.ts:44`
- `interface TemporaryEffectDef` — Definition for a temporary effect, registered at startup. `src/systems/temporary-effect.ts:58`
- `interface TemporaryEffectEvents` — Events emitted by the temporary effect system. `src/systems/temporary-effect.ts:128`
- `interface TemporaryEffectInstance` — A live instance of a temporary effect, created by TemporaryEffectSystem.apply. `src/systems/temporary-effect.ts:108`
- `interface TemporaryEffectSystem` — Manages temporary effects: registration, activation, tick countdown, and cleanup. `src/systems/temporary-effect.ts:146`
- `interface TemporaryEffectSystemOptions` `src/systems/temporary-effect.ts:138`

## Formulas

Algebraic expression trees with evaluate / invert / integrate.

- `function arithmeticSeries(from: DecimalSource, count: DecimalSource): DecimalSource` — `Σ (from + i)` for `i` in `[0, count)` — the bare variable's own series. `src/core/formulas/series.ts:75`
- `type BinaryFormulaInstanceOp = (other: FormulaSource) => GenericFormula` — Instance-side signature of a binary op (`formula.add(other)`). `src/core/formulas/formulas.ts:105`
- `type BinaryFormulaOp = (value: FormulaSource, other: FormulaSource) => GenericFormula` — Signature of a two-argument formula op (e.g. `src/core/formulas/formulas.ts:100`
- `function calculateCost(formula: GenericFormula, amountToBuy: DecimalSource, cumulativeCost?: boolean): DecimalSource` — Calculate the total cost of purchasing a specific number of levels. `src/core/formulas/affordability.ts:408`
- `function calculateMaxAffordable(formula: GenericFormula, resource: Resource, cumulativeCost?: Computable<boolean>, maxBulkAmount?: Computable<DecimalSource>): import("vue").ComputedRef<DecimalSource>` — Count how many levels a resource can currently afford on a cost curve — the "buy max" for repeatables and conversions. `src/core/formulas/affordability.ts:102`
- `type ConstantFormulaOptions` — Options for creating a constant formula (a fixed numeric value). `src/core/formulas/types.ts:72`
- `type EvaluateFunction<T extends FormulaSource[]> = (this: Formula<T>, ...inputs: GuardedFormulasToDecimals<T>) => DecimalSource` — Forward evaluation function signature — used in GeneralFormulaOptions. `src/core/formulas/types.ts:25`
- `const F: typeof Formula & FormulaStaticOps` — Formula constructor with full static typings for dynamically-registered operations. `src/core/formulas/formulas.ts:1364`
- `function findNonInvertible(formula: GenericFormula): GenericFormula | null` — Debug helper: find the operation that breaks invertibility in a formula chain. `src/core/formulas/formulas.ts:1410`
- `interface FirstPassageOptions` — Bracket tuning for a first-passage search. `src/core/formulas/passage.ts:41`
- `class Formula<T extends [FormulaSource] | FormulaSource[] = FormulaSource[]>` — A composable math expression that supports forward evaluation, backward inversion, and cumulative integration. `src/core/formulas/formulas.ts:361`
- `interface FormulaInstanceOps` — Instance-side mirror of FormulaStaticOps — the methods `registerOps` adds to `Formula.prototype`. `src/core/formulas/formulas.ts:162`
- `type FormulaOptions<T extends [FormulaSource] | FormulaSource[]> = VariableFormulaOptions | ConstantFormulaOptions | GeneralFormulaOptions<T>` — Union of all formula constructor option shapes. `src/core/formulas/types.ts:90`
- `type FormulaSource = MaybeRef<DecimalSource> | GenericFormula` — A formula or a raw Decimal value — the universal input type for formula operations. `src/core/formulas/types.ts:22`
- `interface FormulaStaticOps` — Type of the static methods `registerOps` adds to F. `src/core/formulas/formulas.ts:113`
- `type FormulasToDecimals<T extends FormulaSource[]>` — Map a tuple of FormulaSource inputs to a tuple of DecimalSource outputs — the value shape `internalEvaluate` / `internalInvert` see at runtime. `src/core/formulas/types.ts:118`
- `type GeneralFormulaOptions<T extends [FormulaSource] | FormulaSource[]>` — Options for creating a formula with custom evaluate/invert/integrate functions. `src/core/formulas/types.ts:78`
- `type GenericFormula = Formula<any>` — Any Formula instance, regardless of capability. `src/core/formulas/types.ts:19`
- `function geometricSeries(base: DecimalSource, from: DecimalSource, count: DecimalSource): DecimalSource` — `Σ base^(from + i)` for `i` in `[0, count)`. `src/core/formulas/series.ts:86`
- `type GuardedFormulasToDecimals<T extends FormulaSource[]> = TupleGuard<T>` — Inference-friendly alias of FormulasToDecimals that keeps tuple positions intact under TypeScript's mapped-type rules. `src/core/formulas/types.ts:134`
- `function hasVariable(value: FormulaSource): value is GenericFormula` — Check if a formula source contains exactly one variable (required for inversion). `src/core/formulas/formulas.ts:57`
- `type IntegrateFunction<T extends FormulaSource[]> = (this: Formula<T>, stack: SubstitutionStack | undefined, ...inputs: T) => GenericFormula` — Integration function signature — used in GeneralFormulaOptions. `src/core/formulas/types.ts:38`
- `type Inversion` — Diagnosed result of Formula.tryInvert / Formula.tryInvertIntegral. `src/core/formulas/inversion.ts:66`
- `type InversionFailureReason` — Why an inversion has no usable answer. `src/core/formulas/inversion.ts:39`
- `function inversionTolerance(target: DecimalSource): number` — Relative tolerance the image check can honestly demand at `target`'s magnitude. `src/core/formulas/inversion.ts:143`
- `type InvertFunction<T extends FormulaSource[]> = (this: Formula<T>, value: DecimalSource, ...inputs: T) => DecimalSource` — Inversion function signature — used in GeneralFormulaOptions. `src/core/formulas/types.ts:31`
- `function isFormula(value: unknown): value is GenericFormula` — Type guard for Formula instances. `src/core/formulas/formulas.ts:52`
- `type Passage` — Result of Formula.firstPassage. `src/core/formulas/passage.ts:67`
- `function powerSeries(power: DecimalSource, from: DecimalSource, count: DecimalSource): DecimalSource | null` — `Σ (from + i)^power` for `i` in `[0, count)`, at non-negative integer `power`, non-negative `from` and integer `count`. `src/core/formulas/series.ts:113`
- `type Series` — Diagnosed result of Formula.sum. `src/core/formulas/series.ts:55`
- `type SubstitutionFunction<T extends FormulaSource[]> = (this: Formula<T>, variable: GenericFormula, ...inputs: T) => GenericFormula` — Substitution function signature (for nested integration) — used in GeneralFormulaOptions. `src/core/formulas/types.ts:59`
- `type SubstitutionStack = ((value: GenericFormula) => GenericFormula)[] | undefined` — Stack of substitution functions used during nested integration. `src/core/formulas/types.ts:111`
- `type SumFunction<T extends FormulaSource[]> = (this: Formula<T>, from: DecimalSource, count: DecimalSource, ...inputs: T) => Series` — Summation function signature — used in GeneralFormulaOptions. `src/core/formulas/types.ts:51`
- `type TupleGuard<T extends any[]> = T extends any[] ? FormulasToDecimals<T> : never` — Conditional wrapper that preserves the tuple shape through mapped-type inference. `src/core/formulas/types.ts:128`
- `type UnaryFormulaInstanceOp = () => GenericFormula` — Instance-side signature of a unary op (`formula.neg()`). `src/core/formulas/formulas.ts:103`
- `type UnaryFormulaOp = (value: FormulaSource) => GenericFormula` — Signature of a one-argument formula op (e.g. `src/core/formulas/formulas.ts:98`
- `function unrefFormulaSource(value: FormulaSource, variable?: DecimalSource): DecimalSource` — Evaluate a FormulaSource to a DecimalSource — unwraps refs and evaluates formulas. `src/core/formulas/formulas.ts:62`
- `type VariableFormulaOptions` — Options for creating a variable formula (the "x" in a cost function). `src/core/formulas/types.ts:66`

## Gate

typed predicate-spec data shape. Type union and pure-data projection live at core layer so `E.conditional` and other core-layer builders can accept Gate without a layer violation. The runtime side (evaluator, predictor, ambient-runtime resolution, requirement adapter) lives in `systems/gate.ts` — it depends on EngineCategories and ResourceRegistry, which are systems-layer concerns

- `interface AllGate` — True when every child Gate is true. `src/core/gate.ts:96`
- `interface AnyGate` — True when at least one child Gate is true. `src/core/gate.ts:102`
- `interface CountGteGate` — True when the entity's `count` signal is `>= value`. `src/core/gate.ts:46`
- `interface CumulativeGteGate` — True when `resource.cumulative.value >= value`. `src/core/gate.ts:34`
- `interface FlagGate` — True when `accessor.isUnlocked(id)` returns true. `src/core/gate.ts:90`
- `type Gate = ResourceGteGate | CumulativeGteGate | CountGteGate | UnlockGate | StateGate | FlagGate | AllGate | AnyGate | NotGate` — Typed declarative predicate spec. `src/core/gate.ts:121`
- `type GateHandle = 'accessor' | 'categories' | 'registry'` — The engine handles a Gate kind reads through. `src/core/gate.ts:174`
- `function getRequiredGateHandles(gate: Gate): ReadonlySet<GateHandle>` — Which engine handles `gate` will actually reach for. `src/core/gate.ts:192`
- `function isGate(value: unknown): value is Gate` — Type guard for Gate. `src/core/gate.ts:150`
- `interface NotGate` — True when the wrapped Gate is false. `src/core/gate.ts:108`
- `type Predicate = Computable<boolean> | Gate` — A yes/no condition in any authoring form: a constant, a ref or getter over state in scope, or a Gate the engine can introspect and predict. `src/core/gate.ts:138`
- `interface ResourceGteGate` — True when `accessor.getResource(resource) >= value`. `src/core/gate.ts:21`
- `interface StateGate` — True when the comparison `accessor.getState(key) <op> value` holds. `src/core/gate.ts:70`
- `interface UnlockGate` — True when the entity's `unlock` signal is true. `src/core/gate.ts:58`
- `interface AdoptedPredicate` — A Predicate adopted by a system at its register site. `src/systems/gate.ts:382`
- `function assertGateHandles(gate: Gate, runtime: GateRuntime, label: string): void` — Throw unless `runtime` carries every handle evaluating `gate` will read. `src/systems/gate.ts:368`
- `function createGateRequirement(options: GateRequirementOptions): Requirement` — Build a Requirement that's met whenever its Gate evaluates truthy. `src/systems/gate.ts:505`
- `function createPredicateResolver(override?: GateRuntime): PredicateResolver` — Build the resolver a system adopts its predicate fields through. `src/systems/gate.ts:431`
- `function evaluateGate(gate: Gate, runtime: GateRuntime): boolean` — Resolve a Gate to its current truth value against the engine's live state. `src/systems/gate.ts:175`
- `function evaluatePredicate(predicate: Predicate, runtime: GateRuntime): boolean` — Evaluate a Predicate once against `runtime` — for consumer code that reads a predicate field back off a definition. `src/systems/gate.ts:465`
- `interface GateRequirementOptions` `src/systems/gate.ts:472`
- `interface GateRuntime` — The engine handles evaluateGate and timeUntilGateFlip read through. `src/systems/gate.ts:124`
- `function getAmbientGateRuntime(override?: GateRuntime): GateRuntime` — Snapshot whichever ambient handles are currently wired into a GateRuntime bundle. `src/systems/gate.ts:149`
- `interface PredicateResolver` — Adopts a system's predicate fields against one captured GateRuntime. `src/systems/gate.ts:395`
- `function timeUntilGateFlip(gate: Gate, runtime: GateRuntime): TransitionDistance` — Distance until `gate` flips truth value at current rates. `src/systems/gate.ts:237`

## Modifier

composable value calculation chains

- `interface AdditiveModifierOptions` `src/core/modifier.ts:69`
- `function applyModifier(modifier: Modifier, value: DecimalSource): DecimalSource` — Apply a single modifier to a value. `src/core/modifier.ts:889`
- `function applyModifiers(modifiers: Modifier[], value: DecimalSource): DecimalSource` — Apply multiple modifiers in sequence to a value (left to right). `src/core/modifier.ts:903`
- `interface BindingRecord` — Attribution record for a single bound modifier, returned by ModifierChain.bindings. `src/core/modifier.ts:434`
- `interface BindOptions` — Options for ModifierChain.bind. `src/core/modifier.ts:396`
- `function computeModifiedValue(base: Computable<DecimalSource>, modifiers: Modifier[]): ComputedRef<DecimalSource>` — Create a computed ref that applies modifiers to a base value. `src/core/modifier.ts:942`
- `function createAdditiveModifier<T extends AdditiveModifierOptions>(options: T): OperationModifier<T>` — Create a modifier that adds a value to the input. `src/core/modifier.ts:99`
- `function createExponentialModifier<T extends ExponentialModifierOptions>(options: T): OperationModifier<T>` — Create a modifier that raises the input to a power. `src/core/modifier.ts:236`
- `function createModifierChain(id: string): ModifierChain` — Create a named modifier chain that other modules can push modifiers into. `src/core/modifier.ts:633`
- `function createMultiplicativeModifier<T extends MultiplicativeModifierOptions>(options: T): OperationModifier<T>` — Create a modifier that multiplies the input by a value. `src/core/modifier.ts:171`
- `function createSequentialModifier<T extends Modifier>(modifiers: T[]): WithRequired<Modifier, Extract<RequiredKeys<T>, keyof Modifier>> & { readonly children: readonly T[]; }` — Compose multiple modifiers into a single pipeline that applies them in order. `src/core/modifier.ts:317`
- `interface ExponentialModifierOptions` `src/core/modifier.ts:200`
- `type Grant` — Declarative binding entry — the shape consumers use inside per-category declarative fields (`grants` / `restricts` / `rewards`). `src/core/modifier.ts:462`
- `function invertModifier(modifier: Modifier, value: DecimalSource): DecimalSource | undefined` — Invert a modifier: given a desired output, find the input that produces it. `src/core/modifier.ts:916`
- `interface Modifier` — A single step in a value calculation pipeline. `src/core/modifier.ts:33`
- `interface ModifierChain extends Modifier` — A named, auto-composing sequential modifier that acts as a registry. `src/core/modifier.ts:513`
- `interface ModifierChainEvents` — Events emitted by a ModifierChain. `src/core/modifier.ts:383`
- `interface ModifierChainSlot` — A position reserved in a ModifierChain by ModifierChain.reserve. `src/core/modifier.ts:570`
- `interface ModifierDescription` — A single line in a modifier breakdown, suitable for rendering in a tooltip or info panel. `src/core/modifier.ts:49`
- `interface MultiplicativeModifierOptions` `src/core/modifier.ts:129`
- `type OperationModifier<T> = WithRequired<Modifier, 'invert' | Extract<RequiredKeys<T>, keyof Modifier>>` — Utility type for modifiers that have all optional methods defined. `src/core/modifier.ts:61`

## Requirements

Requirements system for gating purchases, unlocks, and actions

- `function allOf(...children: Requirement[]): Requirement` — Compose requirements with AND semantics. `src/core/requirements.ts:380`
- `function anyOf(...children: Requirement[]): Requirement` — Compose requirements with OR semantics. `src/core/requirements.ts:329`
- `interface BooleanRequirementOptions` `src/core/requirements.ts:257`
- `interface CostRequirement extends Requirement` — A requirement that costs a resource to satisfy. `src/core/requirements.ts:134`
- `interface CostRequirementOptions` `src/core/requirements.ts:76`
- `function createBooleanRequirement(options: BooleanRequirementOptions): Requirement` — Create a simple true/false requirement. `src/core/requirements.ts:278`
- `function createCostRequirement(options: CostRequirementOptions): CostRequirement` — Create a requirement based on spending a resource. `src/core/requirements.ts:174`
- `function createResetPay(overrideValue?: DecimalSource): (amount?: DecimalSource) => void` — Create a pay function that resets to default. `src/core/requirements.ts:504`
- `function getRequirementDescriptions(requirements: Requirements): string[]` — Get descriptions for all requirements. `src/core/requirements.ts:476`
- `function isCostRequirement(req: Requirement): req is CostRequirement` — Check if a requirement is a cost requirement. `src/core/requirements.ts:515`
- `function maxRequirementsMet(requirements: Requirements): DecimalSource` — Calculate the maximum number of times requirements can be met. `src/core/requirements.ts:424`
- `function payByDivision(requirement: CostRequirement, amount?: DecimalSource): void` — Pay strategy: divide resource instead of subtract. `src/core/requirements.ts:487`
- `function payByReset(requirement: CostRequirement, overrideValue?: DecimalSource): void` — Pay strategy: reset resource to default value. `src/core/requirements.ts:496`
- `function payRequirements(requirements: Requirements, amount?: DecimalSource): void` — Pay the costs for one or more requirements. `src/core/requirements.ts:458`
- `interface Requirement` — Base requirement interface. `src/core/requirements.ts:28`
- `type Requirements = Requirement | Requirement[]` — Utility type for accepting one or more requirements. `src/core/requirements.ts:69`
- `function requirementsMet(requirements: Requirements): boolean` — Check if all requirements are met. `src/core/requirements.ts:408`

## TimedProgress

stateless tickable progress accumulator

- `function createTimedProgress(options: TimedProgressOptions): TimedProgress` — Creates a stateless progress accumulator that ticks on every registered tick, advancing `progress` by `speed * dt` each time. `src/core/timed-progress.ts:269`
- `interface ProgressiveCostEntry` — One progressive-cost entry — amount total across a full run, plus a live balance getter the primitive calls to decide affordability. `src/core/timed-progress.ts:345`
- `interface ProgressiveCostStep` — Result of one stepProgressiveCosts evaluation. `src/core/timed-progress.ts:353`
- `function resourceConsumedAt(progress: DecimalSource, duration: DecimalSource, amount: DecimalSource): Decimal` — How many whole resource units should be consumed at a given progress level. `src/core/timed-progress.ts:316`
- `function stepProgressiveCosts(opts: { prevProgress: DecimalSource; proposedProgress: DecimalSource; duration: DecimalSource; costs: readonly ProgressiveCostEntry[]; }): ProgressiveCostStep` — Compute one tick of progressive-cost metering. `src/core/timed-progress.ts:438`
- `interface TimedProgress` — A stateless ticking progress accumulator created by createTimedProgress. `src/core/timed-progress.ts:89`
- `interface TimedProgressBaseOptions` — Options every createTimedProgress tracker shares. `src/core/timed-progress.ts:59`
- `type TimedProgressOptions` `src/core/timed-progress.ts:44`

## Trace

Resource mutation tracing system

- `function enableTracing(): () => void` — Enable the trace system for the duration of a subscription. `src/core/trace.ts:45`
- `function getCurrentTraceEntries(): readonly TraceEntry[]` — Get trace entries for the current (in-progress) tick. `src/core/trace.ts:156`
- `function getPreviousTraceEntries(): readonly TraceEntry[]` — Get trace entries for the previous (completed) tick. `src/core/trace.ts:161`
- `function getTraceTick(): number` — Get the current tick number. `src/core/trace.ts:151`
- `interface TraceEntry` — A single resource mutation recorded by the trace system. `src/core/trace.ts:17`
- `function withChain<T>(chain: Modifier, fn: () => T): T` — Execute a callback with modifier chain attribution. `src/core/trace.ts:84`
