# Candidate Primitives

A catalog of engine-primitive candidates that have surfaced through consumer ports, archetype studies, or research but haven't graduated into the engine yet. Entries cluster broadly: hand-roll convergence sites with multiple consumers, pre-designed shapes from cross-corpus analysis with no first-party consumer yet, capability gaps consumers haven't pressured yet, and engine-internal design questions awaiting pressure. Each entry names the shape and the trigger that would promote it.

Drop here rather than burying the note in a ticket comment. **Before dropping, grep this file for the primitive name or shape, then check the relevant tier's `## Canonical entrypoints` block in [`docs/api/`](./api/) — if the shape is already named there, the gap is a reading failure, not an engine gap.** Cadence is the ecosystem-shared back-flow loop (`/work/studio/CLAUDE.md` § Back-flows): N=1 admitted only when a specific second source is named (pre-designed cross-corpus shapes qualify), N=2 drops and indexes the convergence ("this shape is real"), N=3 is the deliberate graduation dive ("does it belong in the engine" — a judgment, not automatic at N=2). Each entry's `Convergence signal:` line names the recurrence that makes it hot (typically a second instance, N=2); graduation is the N=3 dive above, never automatic on that signal.

Companion to [consumer-guide.md](./consumer-guide.md). Consumer-guide tells you what shape your module should take against the engine today; breaking-change commit bodies (lifted into `CHANGELOG.md`) tell you how to move an existing consumer onto a new primitive; this file tells you what primitives are on deck but not yet real. The mechanical per-symbol lookup is [docs/api/INDEX.md](./api/INDEX.md) — auto-generated, only lists what exists.

## What belongs here

Candidates clear the engine bar at drop time, not graduation time. A shape qualifies if it satisfies all four:

- **Robust surface.** Composes with existing primitives, generalizes across corpus instances, type-safe and reactive contract.
- **Cross-domain generalization.** Two or more independent corpus or first-party instances exhibit the shape. Single-corpus shapes do not land — not as entries, not as in-code markers; the corpus reference is the only record.
- **Not already covered.** Existing primitives, data structures, and composition leave the shape genuinely unreachable. Authoring sugar over data the engine already exposes is consumer-side helper territory.
- **Engine-shaped.** Fits the layering (primitives → core → systems → harness) and composes with neighboring primitives.

The N=2 convergence rule resolves *which qualified candidate graduates first*; it does not let a shape that fails the bar in. A hand-roll recurring across two consumers means "this shape is real" — separate question from "this shape belongs in the engine."

## How the drop spot works

The loop is drop → grep → duplicate-means-ticket. First mention of a qualifying gap lands as a short entry; the second mention is an agent or author trying to drop and finding an existing entry with the same shape. That collision is what signals "we have N=2, graduate this." At that point the entry becomes a research/discussion ticket; the primitive gets built; the entry moves to the "Graduated" section at the bottom with the commit that landed it.

Entries are terse by design — 4–10 lines. If a candidate needs more, it has probably earned a research ticket already; file it and link from here instead of growing the entry.

**In-code markers.** Candidates are cross-referenced from `TODO(expansion)` markers co-located in source. The marker is the local pointer; this file is the cross-shape index. A marker without an entry is a candidate that hasn't been indexed yet — drop it. The reverse case is fine: pre-designed shapes can land here before any first-party consumer creates a marker site. When both exist, keep `Receipts:` accurate.

**Scope.** This file is engine-primitive candidates only. Pattern-library promotion candidates (archetype-level patterns pending Tier-N graduation) live in [`open-loop-research/patterns/candidate-patterns.md`](../../open-loop-research/patterns/candidate-patterns.md). Same drop-grep-ticket loop, different domain.

## Current candidates

### `TimedInput`

`registerTimedInput(engine, (simTime, dt) => ...)` for time-parameterized external state — bot click tapers, script-driven players, "integrate this rate profile over time" shapes. Producer's `expectedClicksAt(simTimeSec)` is the canonical N=1: a pure `(simTime) => cumulativeCount` function the bot differences per tick.

- **Consumers:** Producer balance bot (OL-630).
- **Receipts:** [`open-loop-starter/src/showcase/archetypes/producer/balance/bot.ts:34`](../../open-loop-starter/src/showcase/archetypes/producer/balance/bot.ts) — `expectedClicksAt` (the in-code `TODO(expansion)` marker was lost in a bot refactor; restore starter-side).
- **Naming (graduation constraint):** don't ship under the `Timed*` stem — it collides with `createTimedProgress`, a documented reach-by-name confusion (INDEX.md § Reserved names). Name the invariant (exogenous input schedule), not the mechanism.
- **Convergence signal:** second archetype's balance bot hand-rolls the same `(simTime) => cumulativeCount` shape, or an event-driven probe needs to reason about rate-change breakpoints symbolically. Today's `ctx.onTick` composition is mechanical-only; a probe needing symbolic input-rate events re-opens the trigger.
- **Probe-side evidence (2026-06-09, beat-forge#1 Q4):** `runUntil` `'stasis-aware-tick'` returns `unreachable` at t=0 on a *reachable* producer-arc beat — the click taper is walker-invisible, so `isStasis` misclassifies the bootstrap phase. Event mode's stasis fast-tick fallback handles the same engine correctly (fire 730s vs tick-mode 728s). Until this graduates, the mode's contract is effectively "sound only when all progression is walker-visible"; beat-forge's tuner defaults to `'event'` and documents the exclusion in [`beat-forge/src/balance/tuner.ts`](../../beat-forge/src/balance/tuner.ts).

### `Perturbation` `scalar-set` kind — absolute-set through the picker seam

`{ kind: 'scalar-set', value }` on `Perturbation` (or a `setTunable(engine, address, value)` sibling on the perturbation applier). The seam is deliberately delta-only today — workbench sensitivity nudges compose on the current resolved value — but a solver bisecting a knob needs to *set* absolute candidates. The multiply-shim (`factor = target/baseline`) is equivalent but undefined at baseline 0 and fragile under scope stacking. Tunable-kind entries only; modifier-kind perturbation appends to the chain tail and is unsound for absolute baselines (documented ordering caveat in `perturbation.ts`).

- **Consumers:** beat-forge tuner shim (N=1) — `setTunable` over `TuningRegistriesKey` + `pushScope`, validated in beat-forge `scripts/q3-knob-enumeration.ts` / `q5-bisect-envelope.ts` (beat-forge#1, 2026-06-09).
- **Receipts:** [`beat-forge/src/balance/tuner.ts`](../../beat-forge/src/balance/tuner.ts) — `TODO(expansion)` at the shim.
- **Convergence signal:** second consumer needs absolute-set through the picker seam (BalanceWorkbench "pin to value" UI, another generated-content tuner). At graduation, decide: new `Perturbation` kind handled by `applyTunablePerturbation` only (throw for modifier-kind), or a separate solver-facing verb beside `applyPerturbation`.

### RNG-injectable pick helpers — `weightedPick`/`shuffle`/`randomInt` taking an explicit stream

`weightedPick`/`shuffle`/`randomInt` (`primitives/rng.ts`) read the module-GLOBAL Alea stream and accept no injected rng. A consumer that needs sampling on a *separate* deterministic stream — independent of gameplay RNG so re-running one never perturbs the other — has to hand-roll the weighted-sum / Fisher–Yates / inclusive-int draw over its own `createSeededRNG` closure. Shape candidate: an overload (or sibling) taking `rng: () => number` as first arg, with the global-stream form delegating to it; the closure form already exists (`createSeededRNG` returns a `() => number`), so the helpers just need to stop closing over the singleton.

- **Consumers:** beat-forge generator draw (N=1) — the draw streams from its own seed so re-tuning never shifts what was generated (design doc § Grounding, determinism hygiene). Hand-rolled `intIn`/`weightedPickWith`/`shuffleWith`.
- **Receipts:** [`beat-forge/src/generator/draw-rng.ts`](../../beat-forge/src/generator/draw-rng.ts) — `TODO(expansion)` at the wrapper.
- **Convergence signal:** second consumer needs an injectable-stream draw (another generator, a save-independent procedural layer, a deterministic test fixture over the engine's own helpers). Cheap shape — an overload, not a new primitive — so a duplicate likely just lands the change rather than a ticket.

### `InfeasibilityOracle`

`isReachable(engine, predicate, budget?): 'reachable' | 'unreachable' | 'indeterminate'` — budget-bounded reachability layer over the content walker. Narrow N=1 form ships today as `runUntil`'s `'stasis-aware-tick'` mode (`isStasis` via `createTransitionSnapshot`). Budget-bounded variant needs event-driven reasoning layered above the existing `'event'` mode substrate.

- **Consumers:** OL-633 stasis analyzer is N=1 narrow form. Candidate N=2+: devtools reachability panels, UI unlock hints, tutorial-step gating, mod-QA progression checks.
- **Receipts:** walker substrate exists in [`src/harness/walker/`](../src/harness/walker/); Oracle placement TBD.
- **Convergence signal:** second consumer beyond stasis analyzer. The budget-bounded variant is the expected graduation shape — unbounded narrow form was proven inadequate for non-decaying-rate archetypes (OL-628 close-out).

### `Planner<S, A, G>` — constructive state-space search

Sibling to `InfeasibilityOracle`: where the Oracle answers "can predicate fire within budget?", a Planner *constructs* the action trajectory. Shape: state vector `S`, conditional action menu `A`, goal `G`, rollouts via `importSave` + `runUntil`. Today's `bisectTuner` covers 1-D parameter search; state-space search has no canonical surface.

- **Consumers (N=1):** Looper balance leaf — A\*(h=0) + beam(W=8) over a decision-point queue-mutation tree, blob-rooted save tree, bracket-state closed-set dedup.
- **Receipts:** [`open-loop-starter/src/showcase/archetypes/looper/balance/solver.ts`](../../open-loop-starter/src/showcase/archetypes/looper/balance/solver.ts) — `TODO(expansion)` at the `astar` / `beam` hand-roll site.
- **Convergence signal:** second consumer hand-rolls the same `{problem, expand(node), goalReached(state), hashState(state)}` shape. At graduation, decide placement (`harness/plan/` parallel to `harness/solve/`) and rollout-contract shape (engine-coupled vs state-only).

### `createBonusTimeBank({ source, capacity, redemption })`

Time-conservation offline strategy — the fourth family in the offline-progress survey (extrapolation, tick-sim, cap-and-trickle, banking). Absence beyond a minimum-floor accumulates into a reservoir; reservoir is spent during active sessions at `bonusSpeed > 1`. Idle becomes future fast-forward inside an active session, not currency on return. KTL canonical; Shark Game Overtime is a hybrid.

- **Consumers:** none engine-side yet. open-loop-starter intends consumer-side adoption.
- **Receipts:** none. Current `processOfflineTime` covers extrapolation and tick-sim families only.
- **Research ref:** [`incremental-math` offline-progress § Bonus-time banking](../../incremental-math/src/pages/modern/offline-progress.mdx).
- **Convergence signal:** second consumer wants the same shape. At graduation, decide: redemption rate parameterization, bank capacity policy (hard vs soft cap), absolute-seconds vs normalized-bonus-units storage.

### `createSymmetricModuleSet({ sides, build })`

Sugar for archetypes with N parallel module instances over shared data — Tug's mirrored player/AI sides, Auto-battler PvP, "two adversarial agents over the same content" shapes. Each `build(side)` returns an `EngineModule[]` for one side; the helper namespaces persistent contexts as `<archetypeId>/<scope>/<side>/<module>`.

- **Consumers:** Tug archetype (OL-702 — 4–5 modules × 2 sides). Pre-designed shape captured at OL-703 close.
- **Receipts:** none yet — Tug rebuild has not landed. Drop `TODO(expansion)` at first hand-roll site.
- **Sibling recipe:** the side-parameterized *policy* that installs atop these mirrored modules is glue, not engine API — starter `candidate-recipes.md` § Bilateral sim-bot. This entry is the structural-primitive half only.
- **Convergence signal:** second symmetric-state consumer hand-rolls the same shape. Engine-side placement candidate: `src/harness/build-engine.ts`-adjacent or `src/core/composition.ts`.

### `createMatchDriverModule({ matchKey })`

The primitive core inside the bilateral sim-bot shape: a small module watching `match.on('matchEnded')` and calling `match.start()` on the next tick, for cumulative multi-match balance probes. The surrounding shape — side-parameterizing the production opponent policy so the same factory installs on both sides ("production AI plays itself") — is a *recipe* (composition over existing primitives), tracked in starter `candidate-recipes.md` § Bilateral sim-bot; only the match-driver is engine API that doesn't exist yet.

- **Consumers:** Tug archetype (first adversarial-state worked example; multi-match driver hand-rolled). Anticipated: Defender, Auto-battler PvP, Survivor/Director adversarial.
- **Receipts:** [`tug/balance/match-driver.ts`](../../open-loop-starter/src/showcase/archetypes/tug/balance/match-driver.ts) — `TODO(expansion)` at the match-driver hand-roll.
- **Convergence signal:** second adversarial-state consumer hand-rolls the same `matchEnded → start next tick` driver. At graduation, graduate `createMatchDriverModule` if match-key shapes converge; the policy-runner recipe resolves on the recipe file's own cadence.

### `createFlowField`

Multi-source Dijkstra/BFS over `SpatialGrid` from a source set, producing per-cell distance + gradient; consumed as navigation flow (toward source) or supply flow (from source). Recomputed on source-set change, not per-tick. Sibling `createInfluenceLayer` already graduated under OL-715.

- **Consumers:** Borglike `game/bot/flow.ts` navigation — N=1.
- **Receipts:** `/work/studio/borglike/src/game/bot/flow.ts`.
- **Convergence signal:** second consumer hand-rolls Dijkstra/BFS over a `SpatialGrid` source set. At graduation, decide whether scalar-advecting transport (mass-along-gradient with nonlinear permeability `D(m) ~ m^α`) belongs in the flow-field primitive or stays consumer-side onto vanilla flow + `createInfluenceLayer`.

### `createContinuousConversion({ inputs, outputs, ratePerSecond })`

Per-tick continuous multi-input/output conversion driver. Today's `createConversion` is atomic (player-fired, single `convert()` call); the continuous shape composes a Conversion with an internal `onTick` driver that integrates input/output magnitudes over `dt` and fail-softs on input shortage.

- **Consumers:** Interlocker archetype (OL-1056) — two sites, single corpus. Smelter (wood + minerals → iron) and per-kitten catnip consumption both hand-roll the same `(inputs[], outputs[], rate × dt)` shape against the building's / village's `ctx.onTick`. Probe 3 confirmed 0% drift vs the closed-form expectation across {1, 3, 10} smelters.
- **Receipts:** [`open-loop-starter/src/showcase/archetypes/interlocker/modules/buildings.ts:266`](../../open-loop-starter/src/showcase/archetypes/interlocker/modules/buildings.ts) — smelter `TODO(expansion)`. [`open-loop-starter/src/showcase/archetypes/interlocker/modules/village.ts:305`](../../open-loop-starter/src/showcase/archetypes/interlocker/modules/village.ts) — catnip drain `TODO(expansion)`.
- **Convergence signal:** second archetype hand-rolls the same shape (Factorio-like, Mindustry-like, future automation-heavy archetypes). At graduation, decide: does `createConversion` grow a `tickDriver` option that internalizes the per-tick driver, or is `createContinuousConversion` a separate primitive composing Conversion + rate? The two-site replication inside one archetype is evidence the shape generalizes but doesn't itself satisfy the N=2-corpus rule.

### `createResourceBag` adoption pattern — wide-graph wallet

Not a new primitive — a graduation-readiness candidate for an existing one. Interlocker is the first wide-graph archetype consumer of `createResourceBag`. The pattern: single wallet bag for the player, per-type capacities sourced through reactive getters that route through per-resource `maxChains[id]` modifier chains, two-way `bag.link` between each slot and its persistent `Resource<Decimal>` ref. Capacity-source polling per-call means `chain.push()` reflects on the next read; save→load hydrates resources first, the bag re-syncs.

- **Consumers:** Interlocker archetype (OL-1056) — N=1. The pattern works in real arc play (probes 1+3 install fresh engines and consume `bag.remainingCapacityForType` correctly).
- **Receipts:** [`open-loop-starter/src/showcase/archetypes/interlocker/modules/resources.ts:128`](../../open-loop-starter/src/showcase/archetypes/interlocker/modules/resources.ts) — `TODO(expansion)` at the bag install site.
- **Convergence signal:** second wide-graph archetype adopts the same bag + per-type-reactive-cap-chain shape. Candidates: Explorer (loadout-style), Director (multi-resource match economy), future Factorio-/Mindustry-likes. Engine-side graduation likely a sugar over current `createResourceBag` rather than a new primitive — the current shape works, the convergence question is whether the bag→chain-getter wiring earns a helper.

### `createNoPressureAnalyzer({ resource, purchaseSources, dropThreshold })`

Headless-run `Analyzer` for the Ambient/cozy "no fail state" invariant: per-tick negative-delta detector on a player-visible resource, masked on ticks where any wired purchase source incremented (so legitimate auto-buy spending isn't conflated with structural pressure). Composes onto the existing `Analyzer` interface; reports via `AnalyzerResult.issues`.

- **Consumers:** Ambient archetype (OL-701) — `runNoPressureAudit` hand-rolls the masked check today.
- **Receipts:** [`open-loop-starter/src/showcase/archetypes/ambient/balance/invariant-probe.ts:124`](../../open-loop-starter/src/showcase/archetypes/ambient/balance/invariant-probe.ts) — `TODO(expansion)`.
- **Convergence signal:** second consumer wants the same shape. At graduation, decide whether the purchase-source contract is `() => Decimal` (poll counts, current shape) or per-event subscription via `Purchasable.onPurchase` (more accurate when purchase amounts are tiny relative to the resource).

### `diffTrajectories<TWaypoint>({ predicted, simulated, keys, tolerance })`

Per-waypoint trajectory diff for methodology-#2 sim-verify drivers — closed-form predictor and schedule-replay sim walk the same schedule, this primitive diffs their waypoint trajectories with tolerance. Distinct from `diffAggregates` (compares end-of-run totals); trajectory diff catches drift waypoint-by-waypoint.

```ts
diffTrajectories<TWaypoint>(
  predicted: TWaypoint[],
  simulated: TWaypoint[],
  options: {
    keys: (keyof TWaypoint)[];
    tolerance: Partial<Record<keyof TWaypoint, number>>;
  },
): TrajectoryDiff[];
```

- **Consumers (N=1):** Producer `balance/verify-probe.ts` — `DiffRow` + `diff()` over `ArcWaypoint[]`. Single-key relative-percent tolerance today.
- **Receipts:** [`open-loop-starter/src/showcase/archetypes/producer/balance/verify-probe.ts:155`](../../open-loop-starter/src/showcase/archetypes/producer/balance/verify-probe.ts) — `TODO(expansion)`.
- **Convergence signal:** second archetype's balance harness hand-rolls the same waypoint-tolerance diff. At graduation, decide tolerance shape: per-key absolute, relative-percent uniform, or discriminated mode per key.

### `createThresholdAutobuyer({ mode: 'amount' | 'time' | 'roi' })`

The one genuine primitive inside the autobuyer-registry shape: a bespoke-tick autobuyer for threshold-style automation (auto-prestige, auto-challenge sweeps) that `setupPolicyAutoPurchase` / `setupSweepAutoPurchase` don't cover. AD's `BigCrunchAutobuyerState` (mode/threshold/time) is canonical ([`autobuyer.js:4-175`](../../open-loop-research/reference-code/AntimatterDimensionsSourceCode/src/core/autobuyers/autobuyer.js)). The registry *around* it — a provided master toggle + `AutobuyerSpec[]` under injection keys, per-category specs delegating the buy decision — is a *recipe*, not a primitive (composition over the existing auto-purchase primitives): starter `candidate-recipes.md` § Autobuyer-as-content registry.

- **Consumers:** none yet as a distinct primitive — the threshold tick is latent inside the Producer/Ambient autobuyer registries (verbatim OL-855 backport mirrors, so N=1 independent), which route everything through the policy/sweep primitives today.
- **Receipts:** `open-loop-starter/src/showcase/archetypes/{producer,ambient}/modules/autobuyers/index.ts` — the bespoke tick bodies a `createThresholdAutobuyer` would absorb.
- **Convergence signal:** a consumer needs an amount/time/roi threshold autobuyer the policy/sweep primitives can't express. **Open flag:** OL-855 graduated the registry-as-primitive on a since-falsified N=3 — scaler's copy was deleted in `9df7f9c`, leaving Producer+Ambient (one deliberate copy). Confirm that graduation was justified before treating any of this as landed; the recipe-side record carries the same flag.

### `createTriggerBuffer` / build-to-max-above-trigger sweep — KS automation primitive

The Kitten-Scientists automation core: every automatable item carries `{ enabled, max, trigger }`, and a manager sweep acts on it only when every capacity-bearing INPUT resource is buffered to ≥ `trigger·maxValue` (the storage-buffer fraction), building/crafting/researching toward `max`. The reusable kernel is `inputsBuffered(inputs, trigger, resources)` — reconstructing `maxValue` as `remainingCapacityForType(id) + value`, skipping uncapped inputs — plus the "iterate defs, gate on enabled/visible/max/buffer, act" loop shape shared across build/craft/research managers.

- **Consumers:** Interlocker archetype (studio/open-loop-starter#8) — N=1. Four managers (autoBuild / autoCraft / autoResearch, plus a tighter autoAssign + autoThrottle) share the trigger-buffer kernel over the shipping module APIs; drives the full arc to megalith closure under a canonical `{enabled,max,trigger}` profile.
- **Receipts:** [`open-loop-starter/src/showcase/archetypes/interlocker/modules/automation.ts`](../../open-loop-starter/src/showcase/archetypes/interlocker/modules/automation.ts) — `inputsBuffered` + the four sweeps.
- **Convergence signal:** a second automation-heavy archetype hand-rolls the same `{enabled,max,trigger}` + input-buffer sweep (a Factorio-/Kittens-like builder, or a fork that ports its own KS-style panel). At graduation, decide whether the primitive is the `inputsBuffered` predicate alone (composable) or a `createTriggerBuffer({ items, resolveInputs, act })` sweep driver. Note the interlocker-specific deviations that should NOT graduate: the catnip-solvency farmer controller and the housing-solvency build gate are archetype economy, not general automation. Also a receipt for the active-count (`on`) building throttle (`buildings.setActiveCount`) — canon's continuous-consumer pause — which is a general building-module shape a second continuous-economy archetype would want.

### `createPrestigeLayer({ base, requires, exponent, type, gainMult, gainExp })`

Layered-architecture facade for AD/TMT/Profectus-lineage tier modules. Engine owns the prestige-gain formula `gain = (base × current^exp)^gainExp × gainMult`, gated by `requires`, with `type: 'normal' | 'static'` cost-shape discriminator. `gainMult` / `gainExp` are externally-bindable chains. TMT's `addLayer` is canonical.

- **Consumers:** Scaler tier modules (coin/prestige/transcend/reincarnation) — within-archetype repetition.
- **Receipts:** none yet — N=1 still mid-port. Drop `TODO(expansion)` at scaler `modules/{coin,prestige,transcend}.ts` once leaf 4 lands the third tier and wiring repeats verbatim.
- **Research ref:** [`incremental-math` modifier-chains § "TMT: chain shape as interface"](../../incremental-math/src/pages/modern/modifier-chains.mdx); canonical [`The-Modding-Tree/js/layers.js`](../../open-loop-research/reference-code/The-Modding-Tree/js/layers.js).
- **Convergence signal:** second consumer beyond scaler. At graduation, decide whether `type: 'normal' | 'static'` is the right discriminator or whether `createConversion` already covers both shapes.

### `Modifier.getFormula` — closed-form `Formula` extraction from chains

Capability gap on [`core/modifier.ts:Modifier`](../src/core/modifier.ts). Engine has both `Formula` (evaluate/invert/integrate) and `Modifier` (apply/invert), but no bridge — chains can `apply` and `invert` but cannot produce a `Formula` callers analyze symbolically. Profectus's `createSequentialModifier` composes `getFormula` across the chain by reduce.

- **Consumers:** none yet. Candidate consumers: `runUntil`'s `'event'` mode analytics (closed-form rate-change reasoning over composed chains), bulk-buy on cascades, whole-chain time-until projections.
- **Receipts:** none — capability absent.
- **Research ref:** [`Profectus/src/game/modifiers.tsx:248-292`](../../open-loop-research/reference-code/Profectus/src/game/modifiers.tsx).
- **Convergence signal:** first consumer hits the gap, OR a budget-bounded `InfeasibilityOracle` variant needs it as structural prereq. Engine work: add `getFormula?` to `Modifier`, populate on the four core factories, compose in `applyModifiers` / `ModifierChain`.

### `Purchasable` — free-level / bonus-level decomposition

Refinement to [`createPurchasable`](../src/systems/purchasable.ts) carrying the "effective level = bought + free" pattern as a first-class part of the contract. Today consumers wire a parallel `computed(() => bought + bonusChain.value)` ref per bonused upgrade.

Shape: optional `freeLevelChain?: Chain` slot. `cost(boughtLevel)` binds to bought only; `maxLevel` caps bought; new `canExceedCap?: boolean` controls whether free levels push effective past max. Effective level = `bought + computeModifiedValue(freeLevelChain, 0)`. External bonus sources `chain.bind` into the free-level chain — no second binding mechanism.

- **Consumers (cross-corpus N=5–6):** Synergism (sing/octeract/hepteract/corruption upgrades), Prestige Tree `freeEnh()`, Incremental Mass Rewritten `getbonusLevel`, Trimps empowerment, autotrimps `extraLevels`, Profectus framework-layer `bonusAmountMixin`. Disconfirming evidence in AD and idle-loops variants where bonuses wire downstream of the upgrade.
- **Receipts:** none engine-side. Universal-pattern subsystems (sing/octeract/cube/talisman) wholesale dropped from scaler slim-port.
- **Research ref:** OL-892 (2026-05-08).
- **Convergence signal:** first engine consumer adopts the pattern. Breaking-change risk: `effect(level)` callback's `level` argument shifts from "bought" to "effective" when chain binds. Decide opt-in via `freeLevelChain` presence vs always effective with sibling `.bought` view.

### `createLoadoutRegistry<TPayload>({ schema, storage, maxSlots?, live?, onActivate? })`

Named-preset / loadout / build-save registry over a state slice. Cross-corpus N=5–6 uniform `{ name, payload }` shape with active-selection pointer, save/load, per-slot persistence — Synergism `CorruptionSaves` (free-form, cap 16), Arcanum spell loadouts (hot-swap), Idle-Loops Lloyd action queues (fixed 8 + rename), AutoTrimps mutator presets (fixed 6), AD time-study presets (fixed 6).

Shape: typed `schema` for payload validation; `storage: 'fixed-slots' | 'free-form'`; optional `live` ref for hot-swap; `saveActiveToSlot(id?)` / `loadSlotToActive(id)` for decoupled-swap games. Per-slot persistence via `persistent()`.

- **Consumers:** none engine-side. Spell-compiler's `focusSlot` / `supportSlot` / `passiveSlot` use engine `createSlot` directly — single-selection, not multi-preset registry. Slot ≠ Loadout registry.
- **Receipts:** none. Drop `TODO(expansion)` at first hand-roll.
- **Research ref:** OL-892 (2026-05-08). Engine baseline gap confirmed: `persistent()` covers single-state, `SaveManager` covers full-game; no sub-slice loadout registry exists.
- **Convergence signal:** first engine consumer hand-rolls. At graduation: storage discriminator, schema validation requirement, raw-slots vs opinionated query API.

### Staged purchasable definitions

Optional `stages` array on `PurchasableOptions` + `stage` ref on instance for purchasables that transform between N phases — buying advances to the next stage rather than incrementing a count.

- **Consumers:** none first-party. Corpus N=2: Kittens Game `stages[]`, AD `charged` overlays.
- **Receipts:** [`src/systems/purchasable.ts:69`](../src/systems/purchasable.ts).
- **Convergence signal:** first consumer hand-rolls phase-transforming purchasable behavior. At graduation, decide whether `stages` is partial-options merged onto the base or full per-stage option objects.

### Gate acceptance on def-level predicate fields — Zone / Skill / Purchasable widening

Three systems carry the same pre-designed widening, each deferred on consumer demand: `ZoneDef.unlockGate?: Gate` (declarative auto-unlock instead of imperative `zones.unlock(id)`), `SkillOptionsBase.unlockGate?`/`prerequisites?` (declarative skill unlocks instead of consumer-side gating closures), and `PurchasableOptions.visibility` widened to `Computable<boolean> | Gate`. `Gate` already exists; the win is flip-distance introspection (`timeUntilGateFlip`) and serializability on fields that today accept only opaque closures. `ChallengeDef.{visible, canStart}` and `AchievementOptions.requirement` already accept `Gate` — the widening aligns the laggard systems with that precedent.

- **Consumers:** none yet — pre-designed deferrals, indexed from their co-located markers.
- **Receipts:** [`src/systems/zone.ts:97`](../src/systems/zone.ts), [`src/systems/skill.ts:78`](../src/systems/skill.ts), [`src/systems/purchasable.ts:106`](../src/systems/purchasable.ts) — `TODO(expansion)` at each site.
- **Convergence signal:** first consumer wants declarative unlock/visibility on any of the three (mod configs, sim walkers, devtools flip-distance). The three widenings likely land together — same accepted-forms shape as `ChallengeDef`'s existing `Gate | boolean` fields.

### `DialogRuntimeState.adapter` — adapter-private persisted payload

Optional `adapter?` field on `DialogRuntimeState` for external runtime adapters (Ink JSON dump, Yarn VM state) to round-trip private state through save/load. StateConstraint-compatible (serializable). Today's workaround is declaration-merging on the type from the adapter's package.

- **Consumers:** none yet — internal `createNativeDialogRuntime` doesn't need it. First external adapter port (Ink/Yarn/Ren'Py) is the trigger.
- **Receipts:** [`src/systems/dialog.ts:88`](../src/systems/dialog.ts).
- **Convergence signal:** first external adapter port. Promotion lifts the declaration-merging contract into a first-class field.

### Multi-cost walker-leaf transition emission

Walker leaves pick the first cost requirement when emitting becomes-affordable transitions. Open question for N>1 cost: emit per-resource, slowest-only, or all-required. Affects any new content-walker leaf inheriting `firstCostRequirement`.

- **Consumers:** internal. Two leaves share the helper today: `walk-producer-transitions`, `walk-purchasable-transitions`.
- **Receipts:** [`src/harness/walker/walk-producer-transitions.ts:68`](../src/harness/walker/walk-producer-transitions.ts), [`src/harness/walker/walk-purchasable-transitions.ts:54`](../src/harness/walker/walk-purchasable-transitions.ts).
- **Convergence signal:** first multi-cost content unit lands and a consumer notices the missed transition. Decide between per-resource emit, slowest-only, or all-required.

### `SpatialGrid<T>.fill(mapper)`

Batch cell mutation: `fill(mapper: (x, y, current: T) => T)` overwrites every cell in one pass with a single bulk event instead of N per-cell `set` calls and N `cellChanged` emits. Documented event-storm risk on large grids (256×256 = 65k events/frame).

- **Consumers:** `createInfluenceLayer` evaporate/reset — N=1 hand-roll. N=2 blocked: borglike danger-field port attempted 2026-05-21 against the InfluenceLayer surface; reverted on bench data — see sibling entry below.
- **Receipts:** [`src/core/spatial/influence-layer.ts:301`](../src/core/spatial/influence-layer.ts) (engine-side `TODO(ergonomics)` marker). Borglike in-vivo bench: post-port `computeDangerGrid` went 11.4µs → 80.7µs/call warrior, 11.0µs → 94.5µs/call mage (7–8× slowdown), with the per-cell `set` evaporate one of the three drivers per the OL-1051 closeout.
- **Convergence signal:** in-vivo perf blocker now satisfied — borglike port reverted because the per-cell evaporate is one of the three drivers of the 7–8× slowdown. Decide at implementation whether emit shape is a single `bulkChanged` event or suppressed entirely (lean: suppressed entirely for `fill`; consumers can subscribe via the layer-level event if they care about composite state).

### InfluenceLayer hot-path perf cluster — allocation-free `inRange` + cellChanged suppression on internal writes

Sibling to `SpatialGrid<T>.fill(mapper)` above; both stem from the same in-vivo bench against borglike's danger field. The fill entry covers evaporate cost; this entry covers the two other drivers of the same 7–8× slowdown.

**Driver 2 — `SpatialGrid.inRange` allocates a cell object per yielded coord.** `createInfluenceLayer.accumulate` iterates `grid.inRange(source.x, source.y, r)` once per source per tick; the iterator yields `{ x, y }` objects. At borglike's call volume (~10 sources × ~80 cells in radius 4 = ~800 cells/tick on cache miss), the per-cell allocation shows up as material GC pressure. The shape candidate is an allocation-free variant — either a paired `inRangeIndices(x, y, r): Iterable<number>` that yields flat `y*width+x` indices (matching the existing internal `idx(x, y)` pattern), or a callback form `forEachInRange(x, y, r, fn)` that doesn't materialize an iterator at all.

**Driver 3 — `cellChanged` event emit on every `set` is unaffordable for hot-path internal writers.** `createInfluenceLayer.accumulate` calls `grid.set(x, y, value)` per cell with a contribution, and `grid.set` unconditionally emits `cellChanged` (`grid.ts:330`). For consumers driving the layer at tick frequency the events are pure overhead — the only legitimate subscriber to `cellChanged` for an influence layer is a UI reactivity wrapper, which can subscribe at the layer level instead. Shape candidate: an internal-write path that bypasses the emit — `grid.setUnchecked(x, y, value)` or a flag on construction (`{ emitCellChanged: false }`) — paired with a layer-level batched event when the consumer wants it.

The three drivers compound. Removing all three closes most of the engine-vs-hand-roll gap in the OL-1051 bench (estimated post-fix ~20-30µs/call vs current 80-95µs/call vs hand-roll 11µs/call — still 2-3× the hand-roll because the hand-roll's tight Int16Array index loop is structurally hard to beat, but back inside the consumer's ±10% perf band).

- **Consumers:** `createInfluenceLayer.accumulate` — N=1 internal driver today. Borglike danger-field port (N=2) attempted 2026-05-21 and reverted on bench data; see OL-1051 closeout for the full per-driver breakdown.
- **Receipts:** [`src/core/spatial/influence-layer.ts:325`](../src/core/spatial/influence-layer.ts) (accumulate loop — inRange iteration + grid.set per cell). [`src/core/spatial/grid.ts:330`](../src/core/spatial/grid.ts) (cellChanged emit on set). Borglike F0 vs F3 bench captured in OL-1051 comments: warrior 11.4 → 80.7µs/call (+608%), mage 11.0 → 94.5µs/call (+758%), total tick warrior 1696.8 → 2753.2ms (+62%), mage 2148.2 → 4338.9ms (+102%) on seed 1000 50k-turn deep profile.
- **Convergence signal:** the fill entry above. These two sub-gaps should land together with `fill(mapper)` because all three serve the same use case (any consumer driving a SpatialGrid at tick frequency with bulk writes), and resolving them separately leaves OL-1051 still blocked after each one ships. Branch decision point at implementation: keep the API shape narrow (`fill` + `inRangeIndices` / `forEachInRange` + a documented internal-write convention via `grid.cells[i] = v` direct write tolerated for engine-internal use) or formalize a "hot-path consumer" mode toggle on the grid itself. Lean: narrow API additions; engine-internal direct-write is already what `accumulate` does for reads (`grid.cells[idx]`), the asymmetric write path is the bug.

### `Sequencer.resetCursor(toIndex)`

Extend list-mode `resetCursor` with optional `toIndex: number` for arbitrary-position cursor jumps — Cavernous II `<` repeat-from-marker semantics. Today's signature hardcodes index 0. Cursor-control family member alongside the graduated `repeat()` (advance by 0), `complete()` (advance by 1), and the no-arg `resetCursor()` (reset to 0); absolute-jump rounds out the set. A fourth member would trigger consolidation discussion under a unified `advance(n)` / `jumpTo(n)` surface.

- **Consumers:** none first-party. Corpus reference: Cavernous II loop replay-from-marker.
- **Receipts:** [`src/core/sequencer.ts:283`](../src/core/sequencer.ts).
- **Research ref:** `open-loop-research/reports/studies/multi-run-orchestration/multi-run-orchestration-primitive-surface.md` § Part 2.
- **Convergence signal:** first in-repo consumer surfaces a replay-from-marker need (Looper revisit, idle-loops-ng Lloyd variant, similar).

### Banked-time accumulator over TickDriver.speedMultiplier

Composes engine `createTimeSystem` (play-time tracking) + `TickDriverKey` (the actual tick-scaler surface) + `processOfflineTime` (offline catch-up replay). Earns from offline excess via a logarithmic curve (`rate × log2(hoursExcess + 1)`), capped at a maximum reservoir. Spending toggles `engine.tickDriver.speedMultiplier` to a configured value (e.g. 10×) and decrements the reservoir per-tick at 1:1 with `dt` (already speed-scaled). Auto-stops at depletion; restores `speedMultiplier` to 1.

The two-engine-speedMultiplier shape (TimeSystem's internal counter vs TickDriver's actual tick scaler) is a known papercut for consumers — banked-time is the first first-party documented use of `TickDriverKey.speedMultiplier` outside the engine's own surfaces. If a second consumer wants the same earn-and-spend acceleration pattern, the boilerplate-reduction candidate is a `createBankedAcceleration({ source, capacity, redemption, gate, tickDriver })` factory along the lines of `createBonusTimeBank` already on this file.

- **Consumers:** maldacena Banked Time module (N=1).
- **Receipts:** [`/work/studio/maldacena/src/modules/time.ts`](../../maldacena/src/modules/time.ts) `timeModule` + `addBankedFromOffline` / `startSpending` / `stopSpending`.
- **Convergence signal:** convergence between this entry and the pre-designed `createBonusTimeBank` candidate already filed. The earn-side (log curve over offline-excess) matches Bonus Time's redemption-rate shape; the spend-side (gating on game-active + auto-stop at depletion) is the new sub-shape that may need to bake into the factory or stay consumer-side.

### Per-action repetition softcap on a Producer rateChain

Multiplicative modifier bound to a content-type Producer's `rateChain` reading `timesCompleted` from the category's per-def state. Formula `1 / (1 + max(0, reps - 1) * scale)` clamped to a floor (e.g. 0.5) — "first emission isn't a repeat" semantic. Per-loop reset rides the category's existing `resetModules` entry; no new state. Generalizes to any "repeating the same action inside a session has diminishing returns" mechanic — natural fit for games that already track per-def completion counters for Pomodoro pacing.

- **Consumers:** maldacena Zeno softcap on gathering / crafting / experimentation / construction (N=1).
- **Receipts:** [`/work/studio/maldacena/src/modules/gathering.ts`](../../maldacena/src/modules/gathering.ts) Zeno binding section (also crafting / experimentation / construction).
- **Convergence signal:** second consumer hand-rolls a per-completion softcap on a Producer-shape category. Likely shape at graduation: a helper `bindRepetitionSoftcap(cat, { scale, floor, readReps })` over `cat.getAll() × rateChain.bind`.

### Optional `chance: number` field on a content def, gating emission via RNG

Lightweight probabilistic-effect pattern: optional `chance` on a per-def content type (Producer-shape or otherwise), evaluated in the content module's `onComplete` to gate emission. On failure: timer / completion-counter / XP still progress; the visible output is skipped. Engine's `chance(p)` primitive does the roll; the pattern is the surrounding convention (where the field sits in the def shape, what gets skipped vs preserved on failure).

- **Consumers:** maldacena Quantum Variance on Producer-shape content defs (N=1).
- **Receipts:** [`/work/studio/maldacena/src/data/types.ts`](../../maldacena/src/data/types.ts) `chance?: number` field on `GatheringDef` / `ProducerContentDef`; gating in each content module's `onComplete`.
- **Convergence signal:** second consumer adds a similar optional-`chance` shape to a content category. At graduation, decide whether the pattern lives as a helper (`createChanceGatedHandler`) or as a documented composition recipe in `consumer-guide.md`.

### History-aware antagonist-bound modifier chain

`createModifierChain` registry seeded with an additive base + multiplicative phase/path/adaptive modifiers + a hyperbolic-saturation softcap, applied to a value at the consumer's read site (no engine-side `chain.setConstraint` / `chain.base` — the engine API takes only `id`). The shape is generic for "antagonist taxes a fraction of production scale" with history-driven adaptive difficulty.

Three reusable sub-shapes inside the composition:

- **Hyperbolic saturation softcap modifier** — `L · x / (x + k)` (per [`incremental-math/modern/softcaps#asymptotic`](../../incremental-math/src/pages/modern/softcaps.mdx)). Hand-rolled `Modifier` with threshold pass-through + asymptotic compression. No engine factory for this curve today (the doc'd `createSoftcap(curveConfig)` factory doesn't exist; `Formula.step` + `createExponentialModifier` don't compose cleanly for non-invertible caps).
- **Adaptive multiplier from `LoopLog.history`** — closure over last-N entries' per-metric `entry.deltas[key].end` snapshot driving a multiplicative chain entry. Generalizes to any "rolling-window-driven difficulty knob."
- **Loop Memory cross-loop pattern detector** — ephemeral per-loop event sequence (collapsed-on-write `Persistent<string[]>` riding a module's `resetModules` entry) compared against a durable anchor (`Persistent<string[]>` in the consumer that owns the antagonist state) via order-sensitive Levenshtein distance normalized by `max(len)`. Distance > threshold resets a persistent repeat counter; otherwise increment. The counter binds into the chain as `1 + count * scale`. Splits ephemeral vs durable state across two modules deliberately because LoopLog's history is session-ephemeral by contract while the comparison anchor needs save-round-trip durability. Generalizes to any "punish/reward the player for repeating template shape" mechanic.

- **Consumers:** maldacena entity-drain (N=1).
- **Receipts:** [`/work/studio/maldacena/src/modules/entity.ts`](../../maldacena/src/modules/entity.ts) `drainChain` + `createDrainSoftcapModifier` + `adaptiveMultiplier` + `levenshtein` + `loopMemoryLastSequence` / `loopMemoryRepeatCount`. Ephemeral input from [`/work/studio/maldacena/src/modules/actions.ts`](../../maldacena/src/modules/actions.ts) `completedSequence`.
- **Convergence signal:** second consumer hand-rolls either the antagonist-drain shape (NPC/relationship-system game with production-tax mechanic) OR the hyperbolic-saturation softcap independently. The softcap sub-shape likely graduates first — it's the broader convergence target ("approaches a ceiling" is genre-prevalent per `incremental-math/rate-functions/bounded-growth.mdx`). Loop Memory's sequence-comparison kernel may converge separately if a second consumer wants "compare current-loop event stream to previous-loop event stream" without the rest of the antagonist scaffolding.

### Per-task speed-chain on the actions-module Sequencer + TimedProgress shape

Maldacena's actions module exposes `TaskDef.speed` as a single `Computable<DecimalSource>`, then folds in a module-scoped "synchronized actions window" multiplier inside `tracker.speed`. The window state (open-until-elapsed-seconds) is set when the entity AI selects the Cooperative Synchronized Actions pattern; the multiplier reads ~1.2× while the window is open. Same shape as the Observable Subject variance window on the entity AI scorer side — both are consumer-side window timers with a closure-read multiplier.

If a second consumer wants per-task speed boosts bound through `chain.bind` (instead of a single Computable plus a module-local multiplier), the substrate candidate is a real `speedChain: ModifierChain` on TaskDef, symmetric with `Producer.rateChain`. The current shape is deliberate — option (c) from the L3b triage, chosen over per-task chain because N=1 doesn't earn the substrate, and over a producer-rateChain binding because entity-interactions aren't producers (they'd miss the boost).

- **Consumers:** maldacena Cooperative Synchronized Actions (N=1). The Observable Subject variance window on the entity-scorer side is the same window-timer pattern but writes to the picker scorer, not the actions tracker.
- **Receipts:** [`/work/studio/maldacena/src/modules/actions.ts`](../../maldacena/src/modules/actions.ts) `tracker.speed` closure folding in `tryReadSynchronizedSpeedMult()`. Window state in [`/work/studio/maldacena/src/modules/entity.ts`](../../maldacena/src/modules/entity.ts) `synchronizedSpeedActiveUntilSeconds` + `currentSynchronizedSpeedMult()`.
- **Convergence signal:** second consumer wants a per-task multiplicative speed window scoped to a transient game state. Likely shape at graduation: optional `speedChain?: ModifierChain` on `TaskDef`; `TimedProgress` consumes it if present, falls back to the existing `speed` Computable when absent. Window-timer sub-shape may converge separately as a `createWindowTimer({ duration, onExpire? })` factory if Observable Subject + Synchronized Actions both adopt it.

### `forEachDefinitionAcross(data, contextIds[], fn)` — multi-context migration sweep

Migration-helper convenience that loops `forEachDefinition` across N context ids in one call. The single-context `forEachDefinition` shipped under OL-1048 as part of `src/core/save-migrations.ts`; the multi-context wrapper was parked at the same time. Consumer wrapper is three lines (`for (const ctx of [...]) forEachDefinition(data, ctx, fn)`), and the only existing real-world migration that would use it (incloneution v1→v2 across `jobs` / `constructions` / `exploration`) is unaffected by the wrapper / no-wrapper choice — same call count, same readability. Not worth the public-surface weight at N=1.

- **Consumers:** incloneution v1→v2 migration (N=1).
- **Receipts:** [`/work/studio/incloneution/src/migrations.ts`](../../incloneution/src/migrations.ts) `1: (data) => ...` iterates the three contexts inline.
- **Convergence signal:** second consumer ships a migration that fans across ≥2 contexts. At that point compare against the consumer-side wrapper — if either consumer has reached for the three-line loop more than once, the wrapper graduates with the third-arg `(entry, id, contextId)` signature from the original sketch.

### `SpatialHexGrid` (or hexagonal coordinate support on `SpatialGrid`)

Axial/cube coordinate mapping and neighbor queries for hexagonal grid layouts. The current `createSpatialGrid` only supports 4-connected and 8-connected square grids, forcing hex-based games to manually define coordinate distance math, axial offsets, and custom neighbor filtering.

- Consumers: Hex Multiverse (N=1).
- Receipts: [`antigravity-hex-multiverse/src/game.ts:86`](../../antigravity-hex-multiverse/src/game.ts) — custom `getAxialDistance`, `getHexNeighbors`, and `getSynergyType` lookups.
- Convergence signal: second spatial hex-grid consumer (another hex-based factory, hex-board battle game, or hexagonal map generator). At graduation, decide: does `createSpatialGrid` grow a coordinate system layout mode (e.g., `layout: 'square' | 'hex'`) with unified neighbors and distance methods, or is `createSpatialHexGrid` a separate primitive?

### Fixed-width ticker formatting — trailing-zero padding above the notation threshold

`format()` pads to `precision` decimals below `NOTATION_THRESHOLD` (`regularFormat` → `toStringWithDecimalPlaces`) but delegates ≥1000 to `notationManager`, whose output doesn't pad — a live counter breathes `1.5K` ↔ `1.52K` every tick and jitters any content-sized layout around it (the design skill's jitter test fails on exactly this). Consumers can't compose a fix without re-implementing `format`'s notation dispatch. Shape candidate: a `pad`/`fixedWidth` option on `format()` (or a `formatTicker` sibling) that post-pads the mantissa to `precision` digits across notations.

- Consumers: multiverse-hr Resources ledger (N=1) — worked around by pinning the window width so only digits move.
- Receipts: [`multiverse-hr/src/ui/components/LedgerBar.vue`](../../multiverse-hr/src/ui/components/LedgerBar.vue) — `TODO(expansion)` at the entries computed.
- Convergence signal: second consumer pins a container or hand-pads mantissas to stop ticker jitter. Cheap shape — a formatting option, not a new primitive — so a duplicate likely just lands the change.

### Parallel session pool for probe scripts — vite-node child-process fan-out

Discovery probes that run many independent engine sessions (seeds × variants × horizons) want them fanned across CPU cores. Engine sessions can't share a process (module context, persistence namespace, Vue reactivity), so the working shape is a child-process pool: the parent holds the job list, spawns one `vite-node` child per job re-invoking the same script, a child recognizes itself via an env key and prints one `RESULT <json>` line. `runWaypointProbe` already owns the seeds×waypoints matrix but runs single-process; this is the "same matrix, process-parallel" gap. Shape candidate: a harness `runSessionPool({ scriptUrl, jobs, runJob })` or a process-parallel option on the existing probe runners.

- Consumers (N=1 game, 4 scripts): frontier `balance/probe-pool.ts` — extracted after the same pool was copy-pasted across territory/codependency/spell probes and a fourth (horizon) was due.
- Receipts: [`frontier/src/game/balance/probe-pool.ts`](../../frontier/src/game/balance/probe-pool.ts) — `TODO(expansion)` in the header.
- Convergence signal: a second game's balance layer hand-rolls a probe process pool. At graduation, decide whether serialization stays JSON-line-over-stdout or moves to a structured channel, and whether the child re-invocation trick (script re-runs itself in job mode) survives outside vite-node.

### Runtime-disposable per-entity modifier chain — `chain.dispose()` / `ChainRegistry` unregister

`createModifierChain` auto-registers into `ChainRegistry`, and `NamedRegistry` exposes no `unregister`/`remove` — so a chain created for a player-placed entity (tower, seated piece) that is later destroyed leaks its registry slot for the engine's lifetime. Spatial games that create/destroy entities at runtime therefore *can't* model per-entity stats as per-entity chains without a growing-forever registry. Both spatial consumers to date sidestep it: the defender towers module uses a `persistent<Instance[]>` + `tunable()` stat table + per-tick handler, and multiverse-hr uses a roster + a recomputed synergy `shallowRef` — neither reaches for a per-entity chain. The engine-internal design question: is the instance-array-plus-tunable pattern the sanctioned answer (chains stay install-time-static), or should `ChainRegistry` gain an unregister and chains a `dispose()` for churned per-entity composition?

- **Consumers:** defender towers (instance-array bypass, N=1); multiverse-hr roster/synergy (bypass, N=1). Both bypass rather than hit the gap directly.
- **Receipts:** `open-loop-starter/src/showcase/archetypes/defender/modules/towers.ts` (instance-array pattern); `multiverse-hr/src/modules/adjacency.ts` (recomputed synergy). Documented as the sanctioned shape in `docs/consumer-guide-recipes.md` § Spatial grids.
- **Convergence signal:** a consumer whose per-entity stat genuinely needs `ModifierChain` composition/attribution for entities it churns at runtime (upgrade stacks on a sellable tower, not a flat tunable). That's the N-signal that the bypass is insufficient and the disposal path (or an explicitly non-registering `createLocalModifierChain`) has to exist.

### Exogenous time-scheduled burn — escalating `g^(t/T_g)` drain

The primitive half of the Cycler kernel: an *exogenous* drain that is a function of elapsed run-time — `W(t) = W₀·g^((t−τ_setup)/T_g)` overtaking a production/capacity ceiling ends (and pays out) the run. Deliberately NOT derived from the wallet it debits — state-coupling the *magnitude* to the drained resource collapses the spine to optimal-stopping; run length stays authored via `{H, g, T_g}`. Distinct from maldacena's antagonist-drain (state-derived, history-adaptive) and `createContinuousConversion` (per-tick resource conversion). This is the `(simTime) => value` shape `TimedInput` / `registerTimedInput` (above) would carry — the two likely graduate together.

The run-phase-controller half (run clock + `running`/`ended` lifecycle + derived beat label + crossing detector) is a *recipe*, not a primitive — starter `candidate-recipes.md` § Run-phase controller.

**N=3 dive filed: studio/open-loop-engine#11.** Cycler's Defense-Command realization (studio/open-loop-starter#21 leaf 3) reshaped its instance from a **time-indexed** `(simTime)=>value` schedule to a **wave-indexed** `W_N = W₀·g^N` one (`(waveIndex)=>value`), and added a genuine **two-phase STANDBY↔INBOUND alternation** (build/repair ↔ defend, unbounded escalating wave count) richer than the single `running`/`ended` lifecycle. That is fresh evidence the schedule generalizes across index kinds and the phase controller is more than a lifecycle — the ticket investigates whether the schedule half graduates to a `TimedInput` primitive carrying both index kinds (+ frozen vs live-pegged baseline) and whether the alternation belongs engine-side or stays a starter recipe.

- **Consumers (N=2, index kinds now 2):** Cycler archetype cycle kernel (**wave-indexed** post-#21; time-indexed pre-#21); multiverse-hr Operating Burn (time-indexed — a deliberate port, same closed form + τ_setup priming + `{H,g,Tg}` decoupling).
- **Receipts:** [`cycler/modules/cycle.ts`](../../open-loop-starter/src/showcase/archetypes/cycler/modules/cycle.ts) (`TODO(expansion)` at the header; wave-indexed salvo + STANDBY↔INBOUND controller, verified in band per [`cycle-probe.ts`](../../open-loop-starter/src/showcase/archetypes/cycler/balance/cycle-probe.ts)); [`multiverse-hr/src/modules/drain.ts`](../../multiverse-hr/src/modules/drain.ts).
- **Graduation divergence (N=3 dive → studio/open-loop-engine#11):** (a) **index kind** — cycler is now `(waveIndex)=>value`, multiverse-hr `(simTime, livePeg)=>value`; a graduated `TimedInput` must span both. (b) **peg** — cycler *freezes* W₀ at run start (crossing closed-form); multiverse-hr pegs B₀ to a **continuous cross-run EMA of production rate** (`pegEma`, drain-independent), not run-frozen. (c) **phase shape** — cycler adds a two-phase alternation, multiverse-hr is a single lifecycle. The exogeneity invariant (burn never reads the resource it debits) holds in all.

### Bidirectional bounded gauge — asymmetric charge/drain, curve-mapped to a multiplier

A per-entity `[0, 1]` scalar that *charges* while one predicate holds (scaled by several multiplicative rate factors) and *drains* otherwise, clamped at both ends, then read through a curve into an effectiveness multiplier. The engine's nearest primitive, `createTimedProgress`, is explicitly rejected at the hand-roll: it's a forward-only completion accumulator (negative speed is a no-op in its tick), while this is a two-directional gauge — one value charging and draining at *different* rates with clamps at both ends. Deleting the hand-roll forces *inventing* that gauge arithmetic; no existing verb captures "bounded scalar that accrues one way and depletes the other." Candidate shape: `createBoundedGauge({ min, max, charge, drain })` read through a mapped output, or a `bidirectional` mode on an accumulator primitive.

- **Consumers:** multiverse-hr burnout (N=1). idle-loops-ng dungeon soulstone-chance is a **divergent cousin, not counted** — same bounded-asymmetric-scalar *family*, different update law (event-multiplicative decay `×0.98` + linear continuous recovery, read directly as a probability; no curve, no continuous bidirectional integration). It would not lower onto one primitive without it degrading to a generic clamped number. cycler's defended line (`wall.ts`) is likewise a **divergent cousin, not counted** — a `[0, maxHP]` buffer with *discrete* leak-damage events + a surplus-fed repair drip and a breach at 0, no curve-to-multiplier; it composes on `persistent` + `Math.min`/`Math.max` (deleting it invents nothing, and `createResource` carries no max/cap), so it degrades to a generic clamped number under the gauge primitive.
- **Receipts:** [`multiverse-hr/src/modules/burnout.ts:109`](../../multiverse-hr/src/modules/burnout.ts) (`burnoutTick` charge/drain + `getEfficiency`/`efficiencyFromBurnout` curve; the module header documents the `createTimedProgress` rejection). Cousins: [`idle-loops-ng/src/modules/multi-part.ts:190`](../../idle-loops-ng/src/modules/multi-part.ts) (`ssChance *= 0.98`) + [`loop.ts:280`](../../idle-loops-ng/src/modules/loop.ts) (`tickDungeonRecovery`); [`open-loop-starter/src/showcase/archetypes/cycler/modules/wall.ts`](../../open-loop-starter/src/showcase/archetypes/cycler/modules/wall.ts) (`applyLeak`/`repair`, breach at 0).
- **Convergence signal:** a second consumer with a *continuous bidirectional* bounded gauge (morale, heat, a cooldown reservoir that both fills and drains on rates) — the N=2 that decides whether the primitive is the narrow "additive bidirectional gauge" (burnout only) or the broader "bounded asymmetric scalar" family (which folds the idle-loops cousin in).

## Graduated · Closed · Rejected → archive

Shipped primitives, composition-resolved candidates, and rejected shapes live in [`candidate-primitives-archive.md`](./candidate-primitives-archive.md), so this file stays the live queue. Grep the archive for a shape's resolution before re-dropping.

## When a candidate is wrong

Candidates are wrong when: (a) the shape doesn't generalize once a second consumer touches it, (b) the "gap" turns out to be composable with existing primitives, or (c) the corpus evidence behind the candidate reverses. Delete the entry and the matching `TODO(expansion)` marker in the same commit. Don't leave dead entries as fossilized speculation — the whole point of this file is that a duplicate *means* something, and silent entries that won't ever graduate dilute that signal.
