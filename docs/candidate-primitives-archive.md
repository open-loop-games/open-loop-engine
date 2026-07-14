# Candidate Primitives — Archive

History companion to [`candidate-primitives.md`](./candidate-primitives.md). Entries leave the live queue three ways, all recorded here so a future agent grepping a shape finds its resolution instead of re-dropping it:

- **Graduated** — shipped in the engine, with the commit that landed it.
- **Closed (composition documented)** — surfaced as a candidate but resolved to consumer-side composition over existing primitives; no extract warranted. Points at the `consumer-guide` recipe that owns the shape.
- **Rejected** — the shape reversed or failed the bar (criteria in [`candidate-primitives.md`](./candidate-primitives.md) § When a candidate is wrong).

The live file stays the current queue.

## Graduated

Entries move here when the candidate ships in the engine. Each records the commit that landed it, so this file is the history of "what used to be parked here" alongside the current queue.

### Event-mode advance floor — micro-advance cliff in `runUntil({mode: 'event'})`

Shipped under `studio/open-loop-engine#1`. `advanceToNextEvent` (`src/harness/run-until-helpers/event-mode.ts`) now floors the realized advance at `tickDelta`: `dt = Math.max(rawHeadDistance, tickDelta)`. Dense auto-purchase cadence that used to collapse the head distance to milliseconds — paying a full incremental-snapshot rebuild (plus checkpoint export under `bisectTolSec`) per micro-step — now takes one tickDelta-sized step instead, making event mode asymptotically never worse than tick mode.

`fired` still reports only the transitions tied at the raw (unfloored) head distance — it's consumed solely by the zero-distance tie path, which is unaffected by the floor. The floor doesn't bypass accuracy: when the floored advance overshoots the true fire time, the caller's existing bisection (`runEventModeLoop`'s `result.advanced > bisectTolSec` branch) narrows it the same way it already does for any large event jump — no new boundary case, confirmed by reading the call site rather than added defensively.

`tickDelta` exactly, no separate `floorSec` knob — it's already threaded through `runEventModeLoop`'s signature for the fallback paths, and no consumer asked for independent control.

### `Sequencer.enqueue(item, { at })` — positional insert

Shipped 2026-05-12 under OL-943 as an additive `options?: { at?: number }` parameter on `enqueue`. `at` omitted or `>= length` appends (existing behavior); `at = 0` prepends; `0 < at < length` arbitrary-position insert; negative throws `RangeError`. Replaces the seven hand-roll sites that did `items.value = [item, ...items.value]` and bypassed `maxSize`, the `enqueue` event emit, and the auto-start guard. Hold-state interaction mirrors `remove`/`reorder`: inserts that displace the held position drop the hold and re-drive. List-mode cursor shifts forward when the insert lands behind a running item. Adoption across incloneution (`modules/actions.ts`, `modules/automation.ts`), idle-loops-ng (`modules/action-queue.ts`, including `insertActionAt`), and open-loop-starter looper (`modules/action-queue.ts`, same shape).

No separate `prepend(item)` sugar; the single canonical method covers all positions. Cursor-jump variant `resetCursor(toIndex)` remains parked separately at `src/core/sequencer.ts:233` — that's list-mode replay-from-marker, structurally distinct from items-mutation.

### Event-stepping mode on `runMatrixUntil` / `runUntil`

Event-stepping (`mode: 'event'`) and stasis-aware-tick (`mode: 'stasis-aware-tick'`) ship as `RunMode` values on `runUntil` and `runMatrixUntil`. Inner loop lives at `src/harness/run-until-helpers/event-mode.ts` (with `advanceToNextEvent` + `isStasis` helpers); `runProbe` and `runMatrixUntil` consumers select the mode at the call site.

Lifted under OL-937 (OL-936 leaf 4). The original wrappers `eventDrivenProbe` (`src/harness/probe/event.ts`) and `stasisAwareTickProbe` (`src/harness/probe/stasis.ts`), plus `advanceToNextEvent` (`src/harness/probe/advance.ts`) and `coarseFineProbe` (`src/harness/probe/coarse-fine.ts`), were absorbed into the mode lift. Original event-mode shipped 2026-04-23 via OL-661 umbrella in commit `4cd754e`; original stasis probe via OL-622 in commit `b9b7ff8`. The lift moves the optimization down to a layer that propagates to every `runUntil`/`runMatrixUntil` consumer rather than only `runProbe` callers.

### `Gate` — consumer-facing predicate surface

Shipped 2026-05-05 as `src/systems/gate.ts` under OL-848. Adoption across `Achievement.requirement`, `ChallengeCategory.{visible,canStart,goal}`, new `Reset.canReset`, and systems-layer `createGateRequirement` landed under OL-846 in commit `979d52e`; Producer migration (retiring `specToICondition` / `createProducerAccessor` / `nextAchievementFireDistance`) landed under OL-847 in commit `2ee963e`. Validating consumers at design time: Producer, idle-loops-ng, scaler antimatter, progress-knight-ng (N=4, ~250–400 LOC of bespoke stitching retired).

Not a primitive — composition glue over the predictor (`core`), `CategoryEntrySignals` cross-cut, `ResourceRegistry.cumulative`, and `GameStateAccessor`. Type union (variant interfaces + `Gate`) lives at `src/core/gate.ts`; runtime (evaluator, predictor, ambient resolution, requirement adapter) at `src/systems/gate.ts`. 6 leaves (`resource-gte`, `cumulative-gte`, `count-gte`, `unlock`, `state`, `flag`) + 3 combinators (`all`, `any`, `not`). `gateToCondition` partial-projects rate-aware Gates to `ICondition` (engine-internal IR post-OL-1036) for predictor reuse; throws on category descendants by design. `GateRuntime` bundle threads `{ accessor, categories, registry }` at install time.

OL-1036 demote (2026-05-21): `ICondition` + variants, `C`, `evaluateCondition`, `extractDependencies`, and `gateToCondition` are `@internal`; Gate is the sole consumer-facing predicate surface. Public field unions on `DialogNode.condition`, `DialogChoice.condition`, `ChallengeDef.{visible, canStart, goal}`, and `TieredRelationshipDef.gates` dropped their `ICondition` arm. `FlagGate { kind: 'flag', id: string }` added as the flat-unlock-id escape hatch peer to `StateGate`. `E.conditional(gate, then, otherwise?)` accepts Gate and projects internally.

OL-1037 follow-up (2026-05-21): `ConditionalEffect` dropped from the public `IEffect` union; `@internal` `IEffectInternal = IEffect | ConditionalEffect` covers the IR layer. `E.conditional(...)` returns `IEffect` opaquely, so the embedded ICondition is unreachable through public type narrowing. Closes the `ConditionalEffect.condition → ICondition` transitive leak the OL-1036 close-out flagged.

Deferred-widening sites (`purchasable.ts:PurchasableOptions.visibility`, `skill.ts:SkillOptionsBase`, `zone.ts:ZoneSystem.unlock`) keep `TODO(expansion)` markers; Gate itself has landed, so the markers are consumer-pressure-gated only. No separate candidate entry. (A fourth site, `feature.ts:BaseFeatureOptions.visibility`, went away when the feature substrate was dropped.)

### `createInfluenceLayer`

Shipped 2026-04-26 as `src/core/spatial/influence-layer.ts` under OL-715 in commit `6e5b85d`. Multi-source scalar-intensity field over `SpatialGrid<number>` with per-source spread/decay + falloff (`linearFalloff` / `gaussianFalloff` / `exponentialFalloff`) and `composeInfluenceLayers` for cross-axis composition. Replaces the (b) influence-field half of the original `createFlowField / createInfluenceField` candidate; the (a) flow-field half remains parked above.

`FalloffFunction` signature broadened 2026-05-21 under OL-1055 in commit `479bc60` to `(dx, dy, radius) => number`, unblocking Chebyshev / Manhattan / hex grid topologies (engine ships Euclidean built-ins; metric-specific variants live consumer-side until N=2 across consumers per the engine-growth rule).

**First consumer attempt deferred.** Borglike `bot/danger.ts` port attempted 2026-05-21 under OL-1051; reverted on F3 bench data showing 7–8× slowdown of `computeDangerGrid` vs the existing hand-roll (warrior 11.4 → 80.7µs/call, mage 11.0 → 94.5µs/call on seed 1000 50k-turn deep profile). Three drivers identified, captured as candidates in the live file: `SpatialGrid<T>.fill(mapper)` batched evaporate, allocation-free `inRange` iteration, and `cellChanged`-suppressing internal write path. All three need to land together before OL-1051 retry — closing one leaves the consumer still blocked. Borglike hand-roll + `Int16Array` storage remains canonical for `bot/danger.ts` in the meantime.

### `Sequencer.repeat()` — advance-vs-repeat primitive

Shipped 2026-05-27 under OL-1067 in commit `1fced1c` as an additive imperative method on `Sequencer<M>` plus a new `'repeat'` event on `SequencerEvents`. Consumers call `seq.repeat()` in place of `seq.complete()` when the current item should re-dispatch rather than advance. Queue mode splices the captured item back into `_liveItems` at `_head` (no `'enqueue'` event re-fire); list mode skips the `rawCursor++` that `complete()` would do. Both modes re-enter `dequeueNext`, so `canRun` re-evaluation, `maxAdvancesPerTick`, and the `'notNow'`/`hold` path all compose for free.

Shape selected after N=4 corpus reading: `incloneution` `_shouldRepeat` (queue-wide-scan predicate registered globally), `idle-loops-ng` `shouldRepeatLast` (four-gate inline check inherited from omsi-loops lineage), Cavernous II's hardcoded `actionID == "T"` self-repeat in `complete()`, and Arcanum's per-task-def `repeat: boolean` flag + separate `TASK_REPEATED` event. None of the four are well-modeled by a sequencer-level `repeatItemWhen?: (item) => boolean` option — the decision logic varies too structurally — but all four lower naturally to an imperative call-site verb. The separate `'repeat'` event matches Arcanum's production discrimination between "task finished and ended" vs "task finished and looped."

Closes a question deferred in `open-loop-research/reports/studies/multi-run-orchestration/cavernous-ii-port-sketch.md:115-119` — complete-time cursor manipulation is consumer-driven via `repeat()`, not engine-triggered via a cursor-jump predicate.

Cursor-control family is now `complete()` (advance by 1), `repeat()` (advance by 0), `resetCursor()` (reset to 0); parked `resetCursor(toIndex)` adds absolute-jump. A hypothetical fourth member would trigger consolidation discussion under a unified `advance(n)` / `jumpTo(n)` surface; three members isn't enough.

Consumer adoption: `idle-loops-ng` shipped 2026-05-27 in commit `a109d5e` (OL-1069) — collapsed the `wasLastLoop ? shouldRepeatLast() : queue.complete()` branch in `action-runner.ts:513-519`. `open-loop-starter` looper archetype shipped 2026-05-27 in commit `c9803dd` — same shape, vanilla idleLoops parity port. `incloneution` adoption tracked under OL-1068 — drops `setShouldRepeatCheck` + `_shouldRepeat` registration ceremony at Job-normal and Exploration-repeatable complete sites. Stall-prefetch paths in incloneution (re-enqueue of *different* items ahead of the current one) are not repeat decisions and stay hand-rolled.

### `Sequencer.patchCurrentItem(patch)` / `Sequencer.patchItem(index, patch)` — reactive item-metadata mutation

Shipped 2026-05-27 under OL-1070 as additive imperative methods on `Sequencer<M>`. `patchCurrentItem(fn)` applies `fn` to the current item's metadata; `patchItem(index, fn)` applies `fn` to the metadata at the given `items.value` index. Both no-op when the target doesn't exist. Other items keep their object identity (splat-replace at the targeted slot only).

Mode split: in **list mode**, the current item also lives at `items.value[cursor]` (cursor-walks-list semantics); the patch updates the live array there and mirrors onto `current.value` so `currentItem`/`currentMetadata` observers see the new metadata. In **queue mode** the dispatched item is popped from `_liveItems` and stored only in `current.value`; `patchCurrentItem` re-serializes the patched metadata into that persistent ref. `patchItem` operates exclusively on `items.value`, which is correct in both modes (the running item is *not* in `items.value` in queue mode — use `patchCurrentItem` for that).

Sized to the candidate's "low-tilt sugar" framing: additive, no contract tilt, items remain value-semantics. Strict N=2-independent convergence rule waived under that framing — the N=1-lineage hand-roll pressure was sufficient because the candidate doesn't constrain future architecture (items-as-entities Path 3 stays parked).

Adoption sites awaiting migration: `idle-loops-ng/src/modules/action-queue.ts:256` (`patchCursorMeta` + the two accumulator wrappers built on it) and `open-loop-starter/src/showcase/archetypes/looper/modules/action-queue.ts:208` (same shape). Will be re-evaluated under OL-1071 — if `createActionCategory` lands, those consumers migrate to the system's typed verbs (`setItemState`, `tickItemProgress`, etc.) and use `patchItem` only via the system internals.

Composition with `repeat()` is at the call site, not in the engine: `seq.patchCurrentItem(fn); seq.repeat();` is the natural pair. No options bag added to `repeat()` per OL-1067 precedent (no empty options bags in engine).

### `createActionCategory` — system layer over Sequencer (absorbs `SequencerItem.state`)

Shipped 2026-05-27 under OL-1071 in commit `e22634e` as `src/systems/action-category.ts`. Wraps `createCategoryBase` + an internal `createSequencer` + per-def `createModifierChain` to provide the "registered typed actions + per-execution state machine + dispatcher" pattern as engine surface. Mirrors `createProducerCategory`'s compositional discipline (mapping-discriminator polymorphism via per-def `tick` closure; not predicate-handler registration).

Three-way state split: per-def state on `entry.state` (createCategoryBase slot, persistent across enqueues, Resettable forwarded), per-enqueue consumer payload typed via `Payload` generic, per-execution engine-managed slots (`lifecycle: ActionItemState`, `progress: number | Record<string, number>`, `attempt`, `error`, `timing`) on the internal sequencer-item metadata. ID-addressed verbs (`setItemState`, `tickItemProgress`, `setItemError`, `patchItemPayload`) target the current item first, then linear-scan `sequencer.items.value` for the first match (queues <~20 per consumer annotation; `TODO(expansion)` for `Map<defId, index>` when a consumer surfaces >100). All splat-replaces route through OL-1070's `patchCurrentItem` / `patchItem` internally.

`ActionItemState` pinned at 5 values (`pending | running | waiting | completed | failed`) — no `cancelled` terminal; cancellation removes from queue and emits `cancel`. No engine state-machine enum precedent to conflict with. `progress` is plain JSON-serializable; large Decimal quantities stay in sibling `Persistent<DecimalSource>` refs accessed via `entry.state` (Sequencer's JSON serialization doesn't round-trip Decimal cleanly).

**Position A re Worker Bundle**: ActionCategory ships without TimedProgress as a hardcoded tick model. spell-compiler / maldacena keep their existing single-active execution composition unchanged (`consumer-guide.md` § Indirect-control worker pools). ActionCategory is the higher-opinion sibling shape; the worker bundle stays as documented composition. consumer-guide.md selection guidance (ActionCategory vs Worker Bundle vs Slot) lands as a follow-up ticket.

Absorbs the parked `SequencerItem.state` candidate at the primitive layer — that entry retires here. Per-item state machine lives on the system's entry shape, mirroring `SkillCategoryEntry.state`, rather than on `Sequencer` itself (which would tilt the items-as-value-objects contract). The first-party hand-rolls of state-in-metadata (idle-loops-ng `ActionMeta.errorMessage`/`failedCount`; starter looper same; incloneution sibling categories) were the convergence evidence the drop-grep loop missed because they look different on the surface — same gap, two structurally-distinct hand-rolls.

Consumer migrations deliberately deferred to per-consumer follow-up tickets. Looper keeps its three sibling categories (`basicCategory` / `progressCategory` / `regularCategory`); ActionCategory absorbs queue + dispatcher + state machine only. incloneution becomes three ActionCategory instances (one per ActionType) with the per-type dispatcher disappearing — per-instance tick closures replace the `switch (item.metadata.type)`. Pre-completion gating (idle-loops-ng's dmchurch `loopsType` budget-cap chain) stays consumer-side as a recipe in `consumer-guide.md`, not engine surface.

EngineCategories grew an `actions?: ActionCategory<any, any, any>[]` slot; `findCategoryEntrySignals` walks it alongside the existing six. Tier manifest added `action-category` cluster under content-systems.

### `integerRoot(x, degree)` — floored integer nth-root (sublinear-per-source prestige payout, root half only)

Shipped 2026-07-13 as `integerRoot` in `src/primitives/decimal.ts` (barrelled through `primitives/index.ts` → public surface). The largest integer `m` with `mᵈᵉᵍʳᵉᵉ ≤ x`, returned as a Decimal — the correct replacement for the `Decimal.floor(Decimal.root(x, n).add(1e-9))` hand-roll both consumers copied verbatim.

Graduated from the parked "Sublinear-per-source prestige payout" candidate (N=2: multiverse-hr `merge.ts` `sublinearFragments` scales 280/350, Cycler `modules/prestige.ts` `sublinear` scales 2500/5000). The convergence signal was a verbatim copy across two first-party surfaces — the ecosystem's "copy-pasted between two games belongs in the engine" rule, not independent rediscovery.

**Only the root half graduated as a primitive.** The parked entry proposed splitting into a primitives-layer root fix *and* a systems-layer `createPrestigeCurrency({ sources, exponent, floor })` floor-sum facade. Direct numerical audit reframed both halves:

- The nudge is not `Decimal.rootExact`-shaped. break_eternity routes *both* `root` and `pow` through log/exp, so each carries float error in both directions (`root(8,3)`=1.999…, `pow(3,3)`=27.000…4). An exact `mⁿ ≤ x` comparison mis-floors at perfect powers just like the raw floor does. `integerRoot` walks off the raw root with a **magnitude-relative** tolerance (`INTEGER_ROOT_REL_TOL = 1e-9`), correct at every scale — where the copied `+1e-9` *absolute* nudge worked by luck of the tested range, not by construction. (The earlier "fails at scale" framing was not reproducible; the real justification is robustness-by-construction + collapsing a magic constant that shipped with a break_eternity-internals comment at each copy site.)
- The floor-sum facade did **not** graduate. Once `integerRoot` exists the per-source payout is a two-line `sources.reduce((acc, s) => acc.add(integerRoot(div(s.total, s.scale), n)), 0)` — authoring sugar over data the engine already exposes, which the "not already covered" bar assigns to consumer-side. The load-bearing "sum per source, don't pool" insight is design guidance, not a symbol; it landed as a `consumer-guide.md` § Conversions → Sublinear per-source payouts recipe. Re-opens only if the *accumulator/wallet wiring* converges at N=2 (today it diverges: mv-hr uses tunable scales + a Reset-driven wallet; Cycler uses persistent-string accumulators + an onTick auto-bank), which is a different gap than the formula.

Consumer migrations: multiverse-hr `merge.ts` and Cycler `prestige.ts` both dropped the `+1e-9` nudge for `integerRoot`; the Cycler helper's `total.lte(0)` guard folds into the primitive's `x ≤ 0 → 0` contract. Both `TODO(expansion)` markers retired.

## Closed (composition documented)

Entries that surfaced as candidates but resolved to consumer-side composition over existing primitives — no extract warranted. Kept as the dropped-and-resolved record so the next agent grepping the shape finds the resolution instead of re-dropping.

### `createSharedTaskPool` / `createWorkerBundle` / `createWorker`

Both the pool helper and the per-worker identity wrapper resolve to consumer-side composition. Per-worker: a plain object pairing a Sequencer + TimedProgress + `getTask` lookup with `currentTaskId` / `currentTask` computeds and a one-line `dispose` — see `docs/consumer-guide.md` § Indirect-control worker pools for the canonical recipe. Pool: a sequencer fill strategy from [`sequencer-strategies.ts`](../src/core/sequencer-strategies.ts) (`createRoundRobinStrategy` / `createPriorityStrategy` / `createConditionalStrategy` / `createCompositeStrategy`) closing over a shared `Persistent<TaskId[]>`. Claim semantics (round-robin / distance / skill-filter / priority-tier / class-lockout) are strategy-side; recall semantics belong in the consumer's policy module. No engine bundle warranted — the composition is the primitive. `createWorker` shipped briefly (OL-1031 item 5 close: factory dropped, structurally negligible — two computeds + dispose, N=2 single-worker consumers, N=0 pool consumers, N=1 documented bypass per OL-1021). Research ref: Majesty-shape corpus across multiple analyzed games.

### Synergy / cross-action bonuses

Composes onto `chain.bind` (or `createPersistentEffectSystem` when the binding spans chains or carries `onActivate`/`onDeactivate` side-effects) with the multiplier reading the source's state via getter closure — binary gates flip the `active` predicate, level-scaled bonuses keep the binding live and let the multiplier resolve to `1` at zero. No extract warranted; the boilerplate-reduction work is consumer-side helpers (e.g. `bindMiscSelectionMultiplier` in `progress-knight-ng`, `registerAffectedByEffects` in `idle-loops-ng`). See `docs/consumer-guide.md` § Cross-action bonuses. Research ref: `open-loop-research/LIBRARY.md` Cross-pattern properties table — Synergy Systems row.

### Personality roster

Composes onto `SequencerItem.meta` + `sequencer-strategies.ts`. See `docs/consumer-guide.md` § Persona-roster composition. Research ref: [game-ai-variety-primitive-surface.md](../../open-loop-research/reports/studies/game-ai-variety/game-ai-variety-primitive-surface.md).

### `EngineCheckpoint` — transient-runtime-state round-trip

Originally predicted a registry of "include-in-save" serializers for state that lives outside any persistent context (module-global RNG; sequencer in-flight hold). Resolved as three already-shipped composition patterns covering every known consumer:

1. **Promote to `persistent()`** — the canonical answer for per-engine transient state. Receipt: [`src/systems/auto-purchase.ts:236-244`](../src/systems/auto-purchase.ts) `policyAutoPurchaseAccumulator` is `let`-state promoted to a persistent ref *specifically* because closure-local state survives `simulateTick` but not `importSave`.
2. **Self-rehydrate via state-machine re-entry** — the canonical answer when "transient" state is a derivable function of persistent state plus a tick. Receipt: [`src/core/sequencer.ts:446`](../src/core/sequencer.ts) — `_holding` / `_unsubRetryTick` are in-memory only; the next `dequeueNext` (triggered by `enqueue`, `complete`, the watcher at line 720, or resume) reconstructs hold state from queue contents + `canRun`. Verified across all code paths that leave the sequencer with `current.value === ''` after load.
3. **Paired checkpoint `{ blob, rng }`** — the canonical answer for module-global state that can't be promoted (RNG). Receipt: public `getRNGState` / `setRNGState` / `RNGState` API (shipped OL-670), used by [`src/harness/run-until-helpers/event-mode.ts:162`](../src/harness/run-until-helpers/event-mode.ts) and `bisectFireTime` for mid-tick `importSave` in solver bisection.

Maldacena's run-branching (the would-be N=2 consumer) sits between ticks rather than mid-tick, so (1)–(3) cover the desync risk and the actual unmet need was a `SaveManager` slot-copy verb, not a checkpoint primitive. Shipped under OL-985 as `SaveManager.{duplicateSlot,replaceSlot,exportSlot,importSlot}` — byte-level storage operations layered onto the existing slot-index machinery. No new primitive, no envelope version bump, no registry.

A future devtools time-rewind or deterministic-replay infra needing a *fourth* pattern is the only way this re-opens.

## Rejected

None recorded yet. When an entry is deleted from the live queue for the [`candidate-primitives.md`](./candidate-primitives.md) § When a candidate is wrong reasons, move its husk here with the reason — don't delete silently, or the shape gets re-dropped.
