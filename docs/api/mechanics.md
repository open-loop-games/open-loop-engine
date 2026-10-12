# Mechanics

The composable evaluation primitives: modifier chains, requirements, formulas, computed values, effects, Gates and trace. Pure evaluation plus reactive wrappers; the substrate the content systems build on.

## Canonical entrypoints

- `createModifierChain` plus `chain.bind` — shared modifier chains and attributed conditional modifiers.
- `createCostRequirement` / `createBooleanRequirement` — requirements with a cost, and requirements that only test.
- `F` / `Formula` / `calculateMaxAffordable` — cost curves, inversion and purchase max previews.
- `Gate` / `E` — declarative predicates and effects, where save, mod or balance-harness data needs a serializable shape.
- `createTimedProgress` — tick-driven progress for actions, workers, and staged costs.

## Common

shared generic type utilities and Vue effect scope ownership

- `type RequiredKeys<T>` — Extract keys that are required (non-optional) from a type. `src/core/common.ts:8`

## Computed

`Computable<T>` and getter utilities for Vue reactive inputs

- `type Computable<T> = T | Readonly<Ref<T>> | (() => T)` — A reactive input that may be a direct value, a Vue ref/computed, or a getter function. `src/core/computed.ts:20`
- `function resolveComputable<T>(value: Computable<T>): T` — Unwrap a Computable to its current value in a single step. `src/core/computed.ts:31`
- `function toMaybeRef<T>(obj: Computable<T>): MaybeRef<T>` — Process a value that may be a getter function. `src/core/computed.ts:58`

## Effects

declarative game-state mutations from `IEffect` ASTs

- `function applyEffect(effect: IEffectInternal, accessor: GameStateAccessor, mutator: GameStateMutator): void` — Apply an effect to game state via the mutator. `src/core/effects.ts:102`
- `const E` — Ergonomic factories for constructing IEffect values. `src/core/effects.ts:145`
- `interface GameStateMutator` — The write side of game state, which applies resolved effects. `src/core/effects.ts:32`
- `interface ResolvedEffect` — One concrete effect step, with every formula evaluated, ready to write. `src/core/effects.ts:20`
- `function resolveEffect(effect: IEffectInternal, accessor: GameStateAccessor): ResolvedEffect[]` — Flatten a declarative IEffectInternal into a list of concrete ResolvedEffect steps. `src/core/effects.ts:66`
- `interface ConditionalEffectDef` — A conditional effect's def, registered at startup. `src/systems/conditional-effect.ts:51`
- `interface ConditionalEffectEvents` — Events emitted by the conditional effect system. `src/systems/conditional-effect.ts:83`
- `interface ConditionalEffectSystem` — Manages conditional effects: registration, predicate watching, and binding on activation. `src/systems/conditional-effect.ts:97`
- `interface ConditionalEffectSystemOptions` `src/systems/conditional-effect.ts:91`
- `function createConditionalEffectSystem(options: ConditionalEffectSystemOptions): ConditionalEffectSystem` — Create a conditional effect system for managing condition-driven effects. `src/systems/conditional-effect.ts:179`
- `function createTemporaryEffectSystem(options: TemporaryEffectSystemOptions): TemporaryEffectSystem` — Create a temporary effect system for managing time-limited effects. `src/systems/temporary-effect.ts:243`
- `function replacementGrants(options: ReplacementGrantsOptions): Grant[]` — Build a cancel-then-replace grant pair for a modifier chain. `src/systems/replacement-grants.ts:105`
- `interface ReplacementGrantsOptions` `src/systems/replacement-grants.ts:44`
- `interface TemporaryEffectDef` — A temporary effect's def, registered at startup. `src/systems/temporary-effect.ts:73`
- `interface TemporaryEffectEvents` — Events emitted by the temporary effect system. `src/systems/temporary-effect.ts:142`
- `interface TemporaryEffectInstance` — A live instance of a temporary effect, created by TemporaryEffectSystem.activate. `src/systems/temporary-effect.ts:122`
- `interface TemporaryEffectSystem` — Manages temporary effects: registration, activation, tick countdown, and cleanup. `src/systems/temporary-effect.ts:160`
- `interface TemporaryEffectSystemOptions` `src/systems/temporary-effect.ts:152`

## Formulas

Algebraic expression trees with evaluate / invert / antiderivative / cumulative.

- `function arithmeticSeries(from: DecimalSource, count: DecimalSource): DecimalSource` — `Σ (from + i)` for `i` in `[0, count)` — the bare variable's own series. `src/core/formulas/series.ts:75`
- `type BinaryFormulaInstanceOp = (other: FormulaSource) => GenericFormula` — Instance-side signature of a binary op (`formula.add(other)`). `src/core/formulas/formulas.ts:106`
- `type BinaryFormulaOp = (value: FormulaSource, other: FormulaSource) => GenericFormula` — Signature of a two-argument formula op (e.g. `src/core/formulas/formulas.ts:101`
- `function calculateCost(formula: GenericFormula, count: DecimalSource, sumLevels?: boolean): DecimalSource` — Calculate the total cost of purchasing a specific number of levels. `src/core/formulas/affordability.ts:404`
- `function calculateMaxAffordable(formula: GenericFormula, resource: Resource, sumLevels?: Computable<boolean>, maxBulkCount?: Computable<DecimalSource>): import("vue").ComputedRef<DecimalSource>` — Count how many levels a resource can currently afford on a cost curve — the "purchase max" for repeatables and conversions. `src/core/formulas/affordability.ts:98`
- `type ConstantFormulaOptions` — Options for creating a constant formula (a fixed numeric value). `src/core/formulas/types.ts:72`
- `type EvaluateFunction<T extends FormulaSource[]> = (this: Formula<T>, ...inputs: GuardedFormulasToDecimals<T>) => DecimalSource` — Forward evaluation function signature — used in GeneralFormulaOptions. `src/core/formulas/types.ts:25`
- `const F: typeof Formula & FormulaStaticOps` — Formula constructor with full static typings for dynamically-registered operations. `src/core/formulas/formulas.ts:1372`
- `function findNonInvertible(formula: GenericFormula): GenericFormula | null` — Debug utility: find the operation that breaks invertibility in a formula chain. `src/core/formulas/formulas.ts:1418`
- `interface FirstPassageOptions` — Bracket tuning for a first-passage search. `src/core/formulas/passage.ts:41`
- `class Formula<T extends [FormulaSource] | FormulaSource[] = FormulaSource[]>` — A composable math expression that supports forward evaluation, backward inversion, the discrete sum and the continuous cumulative. `src/core/formulas/formulas.ts:362`
- `interface FormulaInstanceOps` — Instance-side mirror of FormulaStaticOps — the methods `registerOps` adds to `Formula.prototype`. `src/core/formulas/formulas.ts:163`
- `type FormulaOptions<T extends [FormulaSource] | FormulaSource[]> = VariableFormulaOptions | ConstantFormulaOptions | GeneralFormulaOptions<T>` — Union of all formula constructor option shapes. `src/core/formulas/types.ts:90`
- `type FormulaSource = MaybeRef<DecimalSource> | GenericFormula` — A formula or a raw Decimal value — the universal input type for formula operations. `src/core/formulas/types.ts:22`
- `interface FormulaStaticOps` — Type of the static methods `registerOps` adds to F. `src/core/formulas/formulas.ts:114`
- `type FormulasToDecimals<T extends FormulaSource[]>` — Map a tuple of FormulaSource inputs to a tuple of DecimalSource outputs — the value shape `internalEvaluate` / `internalInvert` see at runtime. `src/core/formulas/types.ts:118`
- `type GeneralFormulaOptions<T extends [FormulaSource] | FormulaSource[]>` — Options for creating a formula with custom evaluate/invert/integrate functions. `src/core/formulas/types.ts:78`
- `type GenericFormula = Formula<any>` — Any Formula instance, regardless of capability. `src/core/formulas/types.ts:19`
- `function geometricSeries(base: DecimalSource, from: DecimalSource, count: DecimalSource): DecimalSource` — `Σ base^(from + i)` for `i` in `[0, count)`. `src/core/formulas/series.ts:86`
- `type GuardedFormulasToDecimals<T extends FormulaSource[]> = TupleGuard<T>` — Inference-friendly alias of FormulasToDecimals that keeps tuple positions intact under TypeScript's mapped-type rules. `src/core/formulas/types.ts:134`
- `function hasVariable(value: FormulaSource): value is GenericFormula` — Check if a formula source contains exactly one variable (required for inversion). `src/core/formulas/formulas.ts:58`
- `type IntegrateFunction<T extends FormulaSource[]> = (this: Formula<T>, stack: SubstitutionStack | undefined, ...inputs: T) => GenericFormula` — Antiderivative function signature — used in GeneralFormulaOptions. `src/core/formulas/types.ts:38`
- `type Inversion` — Graded result of Formula.tryInvert / Formula.tryInvertAntiderivative. `src/core/formulas/inversion.ts:67`
- `type InversionFailureReason` — Why an inversion has no usable answer. `src/core/formulas/inversion.ts:39`
- `function inversionTolerance(target: DecimalSource): number` — Relative tolerance the image check can honestly demand at `target`'s magnitude. `src/core/formulas/inversion.ts:143`
- `type InvertFunction<T extends FormulaSource[]> = (this: Formula<T>, value: DecimalSource, ...inputs: T) => DecimalSource` — Inversion function signature — used in GeneralFormulaOptions. `src/core/formulas/types.ts:31`
- `function isFormula(value: unknown): value is GenericFormula` — Type guard for Formula instances. `src/core/formulas/formulas.ts:53`
- `type Passage` — Result of Formula.firstPassage. `src/core/formulas/passage.ts:67`
- `function powerSeries(power: DecimalSource, from: DecimalSource, count: DecimalSource): DecimalSource | null` — `Σ (from + i)^power` for `i` in `[0, count)`, at non-negative integer `power`, non-negative `from` and integer `count`. `src/core/formulas/series.ts:113`
- `type Series` — Graded result of Formula.sum. `src/core/formulas/series.ts:55`
- `type SubstitutionFunction<T extends FormulaSource[]> = (this: Formula<T>, variable: GenericFormula, ...inputs: T) => GenericFormula` — Substitution function signature (for nested integration) — used in GeneralFormulaOptions. `src/core/formulas/types.ts:59`
- `type SubstitutionStack = ((value: GenericFormula) => GenericFormula)[] | undefined` — Stack of substitution functions used during nested integration. `src/core/formulas/types.ts:111`
- `type SumFunction<T extends FormulaSource[]> = (this: Formula<T>, from: DecimalSource, count: DecimalSource, ...inputs: T) => Series` — Summation function signature — used in GeneralFormulaOptions. `src/core/formulas/types.ts:51`
- `type TupleGuard<T extends any[]> = T extends any[] ? FormulasToDecimals<T> : never` — Conditional wrapper that preserves the tuple shape through mapped-type inference. `src/core/formulas/types.ts:128`
- `type UnaryFormulaInstanceOp = () => GenericFormula` — Instance-side signature of a unary op (`formula.neg()`). `src/core/formulas/formulas.ts:104`
- `type UnaryFormulaOp = (value: FormulaSource) => GenericFormula` — Signature of a one-argument formula op (e.g. `src/core/formulas/formulas.ts:99`
- `function unrefFormulaSource(value: FormulaSource, variable?: DecimalSource): DecimalSource` — Evaluate a FormulaSource to a DecimalSource — unwraps refs and evaluates formulas. `src/core/formulas/formulas.ts:63`
- `type VariableFormulaOptions` — Options for creating a variable formula (the "x" in a cost function). `src/core/formulas/types.ts:66`

## Gate

the typed, serializable yes/no test, as data. The type union and its pure-data projection are in core, so `E.branch` and other core builders can accept a Gate without breaking the one-way imports. The evaluator, predictor, ambient Gate services and requirement adapter are in `systems/gate.ts`, because they read `EngineCategories`, which is in systems

- `interface ActiveGate` — True when the category entry's `active` signal is true. `src/core/gate.ts:57`
- `interface AllGate` — True when every child Gate is true. `src/core/gate.ts:94`
- `interface AnyGate` — True when at least one child Gate is true. `src/core/gate.ts:100`
- `interface CountGteGate` — True when the category entry's `count` signal is `>= value`. `src/core/gate.ts:45`
- `interface CumulativeGteGate` — True when `resource.cumulative.value >= value`. `src/core/gate.ts:34`
- `interface FlagGate` — True when `accessor.getFlag(id)` returns true. `src/core/gate.ts:88`
- `type Gate = ResourceGteGate | CumulativeGteGate | CountGteGate | ActiveGate | StateGate | FlagGate | AllGate | AnyGate | NotGate` — The typed, serializable yes/no test. `src/core/gate.ts:119`
- `type GateService = 'accessor' | 'categories' | 'resourceRegistry'` — A Gate service: a named engine service a Gate kind reads. `src/core/gate.ts:173`
- `function getRequiredGateServices(gate: Gate): ReadonlySet<GateService>` — The Gate services that evaluating `gate` reads. `src/core/gate.ts:190`
- `function isGate(value: unknown): value is Gate` — Type guard for Gate. `src/core/gate.ts:149`
- `interface NotGate` — True when the wrapped Gate is false. `src/core/gate.ts:106`
- `type Predicate = Computable<boolean> | Gate` — A yes/no test in any authoring form. `src/core/gate.ts:136`
- `interface ResourceGteGate` — True when `accessor.getAmount(resource) >= value`. `src/core/gate.ts:21`
- `interface StateGate` — True when the comparison `accessor.getStateAt(path) <op> value` holds. `src/core/gate.ts:69`
- `interface AdoptedPredicate` — A Predicate adopted by a system at its register site. `src/systems/gate.ts:386`
- `function assertGateServices(gate: Gate, services: GateServices, label: string): void` — Throw unless `services` has every Gate service that evaluating `gate` reads. `src/systems/gate.ts:372`
- `function createGateRequirement(options: GateRequirementOptions): Requirement` — Build a Requirement that's met whenever its Gate holds. `src/systems/gate.ts:509`
- `function createPredicateResolver(override?: GateServices): PredicateResolver` — Build the resolver a system adopts its predicate fields through. `src/systems/gate.ts:435`
- `function evaluateGate(gate: Gate, services: GateServices): boolean` — Evaluate a Gate against the engine's live state now. `src/systems/gate.ts:178`
- `function evaluatePredicate(predicate: Predicate, services: GateServices): boolean` — Evaluate a Predicate once against `services` — for consumer code that reads a predicate field back off a def. `src/systems/gate.ts:469`
- `interface GateRequirementOptions` `src/systems/gate.ts:476`
- `interface GateServices` — The Gate services evaluateGate and timeUntilGateFlip read. `src/systems/gate.ts:127`
- `function getAmbientGateServices(override?: GateServices): GateServices` — Snapshot the ambient Gate services wired now into a GateServices bundle. `src/systems/gate.ts:152`
- `interface PredicateResolver` — Adopts a system's predicate fields against one captured GateServices. `src/systems/gate.ts:399`
- `function timeUntilGateFlip(gate: Gate, services: GateServices): TransitionDistance` — Transition distance until `gate` flips, at current rates. `src/systems/gate.ts:241`

## Modifier

composable apply/invert steps and modifier chains

- `interface AdditiveModifierOptions` `src/core/modifier.ts:71`
- `function applyModifier(modifier: Modifier, value: DecimalSource): DecimalSource` — Apply a single modifier to a value. `src/core/modifier.ts:880`
- `function applyModifiers(modifiers: Modifier[], value: DecimalSource): DecimalSource` — Apply multiple modifiers in sequence to a value (left to right). `src/core/modifier.ts:894`
- `interface BindingRecord` — Attribution record for a single bound modifier, returned by ModifierChain.bindings. `src/core/modifier.ts:438`
- `type BindOptions` — Options for ModifierChain.bind. `src/core/modifier.ts:396`
- `function computeModifiedValue(base: Computable<DecimalSource>, modifiers: Modifier[]): ComputedRef<DecimalSource>` — Create a computed ref that applies modifiers to a base value. `src/core/modifier.ts:933`
- `function createAdditiveModifier<T extends AdditiveModifierOptions>(options: T): OperationModifier<T>` — Create a modifier that adds a value to the input. `src/core/modifier.ts:101`
- `function createExponentialModifier<T extends ExponentialModifierOptions>(options: T): OperationModifier<T>` — Create a modifier that raises the input to a power. `src/core/modifier.ts:238`
- `function createModifierChain(id: string): ModifierChain` — Create a named modifier chain that other modules can push modifiers into. `src/core/modifier.ts:642`
- `function createMultiplicativeModifier<T extends MultiplicativeModifierOptions>(options: T): OperationModifier<T>` — Create a modifier that multiplies the input by a value. `src/core/modifier.ts:173`
- `function createSequentialModifier<T extends Modifier>(modifiers: T[]): WithRequired<Modifier, Extract<RequiredKeys<T>, keyof Modifier>> & { readonly children: readonly T[]; }` — Compose modifiers into one sequential modifier that applies them in order. `src/core/modifier.ts:319`
- `interface ExponentialModifierOptions` `src/core/modifier.ts:202`
- `type Grant` — A grant — the authored entry consumers use in a category's declarative fields (`grants` / `restricts` / `rewards`) and an effect-system def's `grants`. `src/core/modifier.ts:467`
- `function invertModifier(modifier: Modifier, value: DecimalSource): DecimalSource | undefined` — Invert a modifier: given a desired output, find the input that produces it. `src/core/modifier.ts:907`
- `interface Modifier` — One apply/invert step on a value. `src/core/modifier.ts:34`
- `interface ModifierChain extends Modifier` — A named, auto-composing sequential modifier that other modules add to, via `add()` (raw) or `bind()` (with attribution). `src/core/modifier.ts:520`
- `interface ModifierChainEvents` — Events emitted by a ModifierChain. `src/core/modifier.ts:382`
- `interface ModifierChainSlot` — A position reserved in a ModifierChain by ModifierChain.reserve. `src/core/modifier.ts:579`
- `interface ModifierDescription` — A single line in a modifier breakdown, suitable for rendering in a tooltip or info panel. `src/core/modifier.ts:51`
- `interface MultiplicativeModifierOptions` `src/core/modifier.ts:131`
- `type OperationModifier<T> = WithRequired<Modifier, 'invert' | Extract<RequiredKeys<T>, keyof Modifier>>` — Utility type for modifiers that have all optional methods defined. `src/core/modifier.ts:63`

## Requirements

the costs and tests that block purchases, unlocks and actions

- `function allOf(...children: Requirement[]): Requirement` — Compose requirements with AND semantics. `src/core/requirements.ts:382`
- `function anyOf(...children: Requirement[]): Requirement` — Compose requirements with OR semantics. `src/core/requirements.ts:331`
- `interface BooleanRequirementOptions` `src/core/requirements.ts:259`
- `interface CostRequirement extends Requirement` — A requirement that costs a resource to satisfy. `src/core/requirements.ts:133`
- `interface CostRequirementOptions` `src/core/requirements.ts:75`
- `function createBooleanRequirement(options: BooleanRequirementOptions): Requirement` — Create a simple true/false requirement. `src/core/requirements.ts:280`
- `function createCostRequirement(options: CostRequirementOptions): CostRequirement` — Create a requirement based on spending a resource. `src/core/requirements.ts:176`
- `function createResetPay(overrideValue?: DecimalSource): (amount?: DecimalSource) => void` — Create a pay function that resets the resource to its ref default. `src/core/requirements.ts:506`
- `function getRequirementDescriptions(requirements: Requirements): string[]` — Get descriptions for all requirements. `src/core/requirements.ts:478`
- `function isCostRequirement(req: Requirement): req is CostRequirement` — Check if a requirement is a cost requirement. `src/core/requirements.ts:517`
- `function maxRequirementsMet(requirements: Requirements): DecimalSource` — Calculate the maximum number of times requirements can be met. `src/core/requirements.ts:426`
- `function payByDivision(requirement: CostRequirement, amount?: DecimalSource): void` — Pay function: divide the resource instead of subtracting. `src/core/requirements.ts:489`
- `function payByReset(requirement: CostRequirement, overrideValue?: DecimalSource): void` — Pay function: reset the resource to its ref default. `src/core/requirements.ts:498`
- `function payRequirements(requirements: Requirements, amount?: DecimalSource): void` — Pay the costs for one or more requirements. `src/core/requirements.ts:460`
- `interface Requirement` — Base requirement interface. `src/core/requirements.ts:27`
- `type Requirements = Requirement | Requirement[]` — Utility type for accepting one or more requirements. `src/core/requirements.ts:68`
- `function requirementsMet(requirements: Requirements): boolean` — Check if all requirements are met. `src/core/requirements.ts:410`

## TimedProgress

tickable progress toward a needed value, with no state machine

- `function createTimedProgress(options: TimedProgressOptions): TimedProgress` — Creates progress that ticks toward a needed value on every registered tick, advancing `progress` by `rate * dt` each time. `src/core/timed-progress.ts:269`
- `interface ProgressiveCostEntry` — One progressive-cost entry — the total amount over one completion, plus a getter for the resource's current amount, which decides affordability. `src/core/timed-progress.ts:345`
- `interface ProgressiveCostStep` — Result of one stepProgressiveCosts evaluation. `src/core/timed-progress.ts:353`
- `function resourcePaidAt(progress: DecimalSource, needed: DecimalSource, amount: DecimalSource): Decimal` — How many whole resource units are paid at a given progress. `src/core/timed-progress.ts:316`
- `function stepProgressiveCosts(opts: { prevProgress: DecimalSource; proposedProgress: DecimalSource; needed: DecimalSource; costs: readonly ProgressiveCostEntry[]; }): ProgressiveCostStep` — Compute one tick of progressive-cost metering. `src/core/timed-progress.ts:438`
- `interface TimedProgress` — Ticking progress toward a needed value, created by createTimedProgress. `src/core/timed-progress.ts:88`
- `interface TimedProgressBaseOptions` — Options every createTimedProgress tracker shares. `src/core/timed-progress.ts:58`
- `type TimedProgressOptions` `src/core/timed-progress.ts:43`

## Trace

Resource mutation tracing system

- `function enableTracing(): () => void` — Enable the trace system for the length of a subscription. `src/core/trace.ts:45`
- `function getCurrentTraceEntries(): readonly TraceEntry[]` — Get trace entries for the current (in-progress) tick. `src/core/trace.ts:155`
- `function getPreviousTraceEntries(): readonly TraceEntry[]` — Get trace entries for the previous (completed) tick. `src/core/trace.ts:160`
- `function getTraceTick(): number` — Get the current tick number. `src/core/trace.ts:150`
- `interface TraceEntry` — A single resource mutation recorded by the trace system. `src/core/trace.ts:17`
- `function withTraceChain<T>(chain: Modifier, fn: () => T): T` — Run `fn` with modifier chain attribution. `src/core/trace.ts:83`
