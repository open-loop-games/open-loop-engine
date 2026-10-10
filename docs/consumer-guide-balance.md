# Balance guide

How numbers get chosen and verified in a game built on `@open-loop/engine`. Read this before touching a balance constant or writing your first probe.

This is the third companion to [consumer-guide.md](./consumer-guide.md). The guide explains **how to compose** the engine; [consumer-guide-recipes.md](./consumer-guide-recipes.md) holds the worked shapes consumers assemble from it; this file holds the discipline for **what the numbers should be** and how you know. It has a companion of its own — [consumer-guide-balance-agents.md](./consumer-guide-balance-agents.md), for when a policy agent is what plays the game your probe measures. It is engineering process over the engine's harness, not game-design theory — the theory lives upstream, per § Cite-out.

It deliberately does not describe any consumer's directory layout. What things are called and where they sit is your repo's business.

## The balance floor

The short version. If you read nothing else here — a first balance pass, a prototype, a spike — this is the part that has to be true.

1. **Write the spine first.** Every balance constant is derived from a closed-form expression, with a one-line derivation comment at the value. Plain arithmetic, no engine. If you cannot predict the shape on paper, that is the finding: the mechanic is probably mis-specified, and no amount of tuning will tell you what the number should have been.

2. **The spine is a prediction, stated so it can be wrong.** It is not a target you defend and not a record of what happened. It says what the math expects, in a form specific enough to be contradicted by a run.

3. **Run the real game and diff prediction against truth.** Construct the engine with the real modules and the game's real automation, play the arc headless, and compare what the spine predicted against what the game did.

4. **When they disagree, decide which one was wrong.** Sometimes the implementation drifted. Sometimes the spine's shape is wrong. Sometimes the *metric* is wrong — the quantity you chose to design against turns out to be structurally unable to express your intent, and no tuning of either side will fix it. All three are findings; only the first is a bug.

5. **The engine is the truth; the spine is the spec.** The math predicts, the engine decides. If a behavior can't be read off an engine run, it doesn't belong in your prediction.

6. **Balance verification is a script that prints, not a test that asserts.** It reports deltas for a human to read. See § Why this isn't a test suite.

7. **Coarsen the tick.** Balance is measured in minutes; the engine's default tick is built for a live loop. See § `tickDelta`.

8. **If a policy plays the game for you, it is part of the instrument.** Every number a bot-driven probe prints is a joint claim about the design *and* about the agent, and the two are indistinguishable until you calibrate the agent separately. See § When an agent is the instrument.

Everything below is these eight with their reasoning, their failure modes, and the engine surface behind each.

## Spec and truth

Two surfaces and a loop between them.

```
      the spine  ───── predicts ─────▶  what should happen
   (closed form,                              │
    plain math)                             diff
                                              │
      the probe  ───── measures ────▶  what actually happens
   (real engine, real modules,
    real automation policies)
```

There is no third surface that pins the result. The diff *is* the check, and it runs when a human runs it.

### The spine — a falsifiable prediction

The spine is the closed-form expression behind every constant, written next to the constant it explains, naming what it couples to and what you would re-tune if the shape came out wrong.

Keep it in plain arithmetic. Not because engine math is forbidden, but because the spine's job is to be *read* — by you in six months, by whoever forks the game, by a reviewer deciding whether the derivation holds. Plain arithmetic is one pass to write and one pass to read. Reach for `Decimal` when magnitudes demand precision the native number type can't carry, and otherwise stay in native arithmetic.

Keep the engine out of it. A prediction that constructs an engine and reads runtime state has stopped predicting and started measuring, which makes agreement between "prediction" and "measurement" vacuous — the two agree because they are the same observation twice. The rule is not "no engine import"; it is **no engine construction and no runtime-state read**. Pure algebra that happens to live in the engine is still algebra.

When the closed form is worth executing — it predicts a run length, sizes a parameter against a target, or projects a horizon a run can't reach in reasonable time — make it a runnable function rather than a comment. That is still the spine, in executable form, not a second source of truth.

**What a derivation comment must contain.** "One-line derivation per value" is only worth having if the line is checkable. A comment that says `// measured` is not a receipt; it is a claim about a measurement that may never have happened, and it reads identically to one that did. A receipt names the source: the expression it came from, or — when a value genuinely was fitted from runs rather than derived — which run produced it, when, and over how many seeds. If a number was chosen by feel, say *that*. An honestly-flagged guess is more useful than a guess wearing derivation language, because the next person knows which numbers to attack first.

**A solved quantity gets one home, and the code that grows reads it.** When the spine *solves* for a rate — the per-purchase gain that holds time-to-kill flat, the ladder that lands beats on schedule — the implementation has to consume that solved value rather than re-author the growth beside it. Two authored copies drift silently, and the failure never presents as arithmetic: the economy runs a permanent deficit that reads as "the game is too hard" and gets tuned for by moving constants that are not the problem. The same rule has a second face — **every term that multiplies a solved curve belongs inside the solve.** A term left out is not a small error, because the solve is what the rest of the model assumes is being delivered; downstream code goes on treating the undelivered quantity as constant and the divergence compounds with nothing reporting it.

**Keep the retired shape where it was retired.** When a run shows the spine was the wrong *family* rather than the wrong constant, write down what the old shape assumed and what contradicted it, at the value that replaced it. Three lines, and it is the cheapest guard there is against re-deriving a refuted shape a year later, when the conclusion is remembered and the refutation isn't.

### The probe — real engine, real policies

The probe constructs the real engine with the real modules and plays the game headless. Real automation policies, never a re-implementation — the moment a probe re-implements a mechanic to measure it, it measures the re-implementation.

A game that ships player-facing automation writes each policy as a pure function over game state gated by `AutomationTiers`, and the probe force-unlocks the tier — bank a save, toggle the tier state, run — rather than modelling what the policy does. Forcing a tier *off* takes one more step: a load re-unlocks any tier whose requirement holds, so write `tiers.unlocked` after the load returns. The requirement fires again only on a change or at the next load or reset, so the forced state holds for the run. The sim then exercises the code the player runs, and the two cannot drift; the policy's parameters double as the sweep axis and, later, as the player-facing tuning surface. A thin runner works only the manual openers a player would work.

The exception is deliberate: behavior that exists *only* to perturb the game — full-auto session drivers, optimal-play enumeration — is harness tooling, not a mechanic, and stays probe-side. The test is whether the behavior is also a real mechanic. If it is, it's game code; if it only ever runs under a probe, it isn't.

A probe that is worth keeping is worth committing. Wire it into your scripts (`"sim": "vite-node scripts/…"`) rather than leaving it in a scratch directory — a balance script that lives outside the repo has to be rebuilt from memory every time the economy moves, and it takes its accumulated judgment with it when it goes. Fold one-off diagnostic scans into it once they've served their purpose rather than accumulating a directory of them.

A useful probe has three passes:

- **Anchors** — force a few points on the progression ladder, play at each, and diff the spine's prediction against what the engine produced.
- **Coefficients** — refit any empirically-fitted scalars from those same runs and print them *beside* the values currently in source. Drift here is the signal that something moved under the spine.
- **Arc walk** — play the designed arc under a fixed policy and report where the beats actually land against what the spine says.

Report distributions, not point values. `mean [min, max]` over a stated seed count is the readable default, and state the seed count — an aggregate over five seeds prints identically to one over two hundred. Where variance carries design intent, report the moments (mean, variance, p50, p90), because the distribution *shape* is the spec and a mean alone hides it. Where the policy is deterministic, extra seeds confirm determinism rather than correctness — one run tells you as much as fifty, and fifty tells you nothing extra.

**Probe design parameters, not automation knobs.** A probe targets the design under test: cost curves, ROI on upgrade tiers, hit rates, HP against DPS, spend rates. Knobs that parameterize *how the automation plays* — decision quality, reaction lag, cadence jitter, persona choice — are not the design, and neither is a difficulty dial that handicaps one side. The working test: would this number change if the automation were swapped for a different reasonable one? If yes, the probe is measuring the automation. Keep those knobs fixed *within* a comparison — and sweep them across the grid before a conclusion lands, which is a different move made for a different reason (§ When an agent is the instrument).

### The loop

Spine, build, run, diff, decide, next layer.

Iteration is triggered by a **contradiction**, not by a schedule. You do not plan "layer two" in advance; you run the game, find that the economy stalls or a metric is pinned or a beat lands nowhere near prediction, and that finding tells you what the next pass is. A layer added because the plan said so is a layer nobody has evidence for.

The first headless run is the first integration surface that walks the whole chain — rate chain to resource to predicate to beat — and it is routinely where structural defects surface rather than tuning ones. An economy that never leaves zero, a purchase never reachable, a resource pinned at its cap for the entire arc: these are not balance findings, and no amount of constant-tuning addresses them. Confirm the game *plays* end to end under its own automation before treating any number as a balance question. Module-level unit tests validate contracts; they do not tell you the game runs.

**Done is when the disagreement is boring.** Not when a threshold is met — when the diff is small, stable across runs, and the remaining gap is explained rather than surprising. Consolidating your throwaway diagnostic scripts into the permanent probe is a good marker that you've reached it.

### Why this isn't a test suite

Balance verification prints; it does not assert.

The tempting shape is to take a measured window, add a tolerance band, and pin it in the test runner as a drift tripwire. It reads as rigor, and it decays predictably. Legitimate retunes red the suite, so bounds get widened to restore green; the widened bound no longer asserts anything but still looks like a passing test; and the whole file trains everyone to treat balance failures as noise. A bound written before the design settles is a guess with a green check.

A printed diff has none of that failure mode. It reports the delta rather than a boolean, so a human sees *how far* things moved and in which direction, and the honest response to "the economy legitimately changed" is to read the new numbers rather than to edit a threshold. It also carries no pass/fail semantics into work that is exploratory by nature — a probe that surfaces something unexpected has succeeded, and a runtime that calls that a failure is fighting you.

The cost is real and worth naming: nothing runs automatically, so nothing catches balance drift on a commit you didn't think to check. Accept that, and run the probe when the economy moves. The alternative isn't a tripwire that works; it's a tripwire that was disarmed months ago and still shows green.

**The assertion that survives a retune is liveness, not value.** Between behavioral suites and printed probes sits a third, narrow tier that is worth having and is easy to miss, because it asserts about the *instrument* rather than about the design. Four forms recur:

- A **calibration scenario** — the agent still does the knowably-right thing in a situation whose answer is known by inspection (§ When an agent is the instrument).
- A **fixture-liveness** assertion — the deliberately-hard case still fails, the deliberately-survivable one still survives. An improvement that moves the magnitude passes; a change that makes every fixture report success reds, because a fixture that can no longer fail has stopped measuring. These go stale by design: when a real improvement clears one, re-measure and commit the new table rather than lowering the bar.
- A **derivation guard** — a runnable projection still couples to the constants it derives from, so a balance edit that breaks an assumption it rests on fires here instead of silently producing confident wrong numbers.
- A **symmetry** assertion — structurally identical things (mirrored sides, interchangeable seats) reach identical state. A substrate asymmetry otherwise surfaces as a *balance* result, gets chased through the numbers, and biases every cell of a sweep at once.

None carries a magnitude, which is why none decays into a widened bound, and all red for one reason: the instrument stopped instrumenting.

**Behavioral tests are a different suite and they stay.** "Does the slot free, does the count go up, is growth monotonic, does the wave complete" belongs in the test runner, driving the assembled engine tick by tick. Those assertions carry no magnitudes, which is exactly why they survive retunes. Keeping balance out of the suite does not mean keeping the game out of it — it means magnitudes and mechanics are different questions, and mixing them produces a suite that reds on every retune and gets ignored.

## When an agent is the instrument

Where a policy plays the game for the probe — an automation tier, an opponent bot, a persona standing in for a player — every number is read *through* that agent, and a defect in it is indistinguishable from a defect in the design. It arrives as a balance finding with plausible magnitudes rather than as "the bot is bad", survives sweeps, and gets a design decision built on top of it. Unit specs on the policy do not catch it, because they assert plumbing and plumbing stays true of an agent deciding exactly wrongly.

That layer has its own file: [consumer-guide-balance-agents.md](./consumer-guide-balance-agents.md) — calibrating on named situations, joining every optimized quantity to a realized counterpart, proving a scoring term has spread before tuning its weight, what a converging policy structurally cannot measure, personas as a coverage axis, and the three harness checks (one brain, restore parity, pipeline liveness).

## Making a pass cheap

A balance pass is bottlenecked on **grading** — deciding what a set of numbers means — not on running: runs parallelize, judgment doesn't. Most of what makes a pass expensive is spending runs on questions a cheaper instrument, or no instrument, already answers.

**Read before you run.** A source read that settles a question is a finding, and costs nothing a run would not have cost anyway. Read the module's header rather than grepping the symbol you arrived with — a subsystem's prose routinely carries a standing refusal of exactly the change being proposed, above the code the grep opened.

**Name the content that could answer it.** A question is gradeable only where something in your game can express it, and two thresholds differ. A channel with **one carrier** yields an address rather than a finding: one instance cannot distinguish a mechanism from that instance's own shape. A channel with **zero carriers** is not a result at all — a sweep that comes back flat across content that cannot express the thing is a statement about your content, and the honest output is the content ask, not the refutation. Generate the carrier list rather than remembering it; remembered ones are wrong often enough to be worthless. When a line of work stops producing findings, ask what your content can express before asking for a better candidate — adding a carrier is frequently cheaper than another mechanism.

**A printed report is the proof that a refactor was behaviour-preserving.** Re-run the probe against the pre-change tree and diff the numbers. That is a stronger claim than a green suite, which only says nothing asserted broke — and it is the cheapest thing that catches a mechanical change quietly moving play. It is worth keeping the report machine-diffable for exactly this, and worth caching a built baseline per commit if generating one is slow, so the base side is that commit rather than that commit plus whatever was uncommitted when it was built.

**Inertness is cheap; magnitude is not.** Identical-versus-not has no noise floor, so a lever measured unchanged across its range is settled in one run per end. Only a lever that *does* move something needs the wide read. Order the pass accordingly.

**Widen along the axis that actually varies.** A read narrower than the thing that moves it reports the wrong shape in either direction, understating a real effect as readily as manufacturing one. Which axis carries the variance is a property of your game: seeds where the arc is stochastic, distinct trajectories where personas diverge, content variants where the runtime is deterministic and seeds only prove the harness repeats. Where the sim is deterministic, repeating a cell measures nothing and averaging cells measures less. What *does* carry noise is anything measured on a machine doing other things — wall-clock above all, where a number that moved once has not moved.

**Bank states rather than replaying arcs.** Most questions concern one phase of a run, and replaying the arc to reach it is the largest avoidable cost in a pass. Keep named mid-arc saves, stand probes up from them, and share the set with whatever QA or dev-panel picker the game has so it stays honest by being used. Two guards: a banked state travels the restore path and owes restore parity ([consumer-guide-balance-agents.md](./consumer-guide-balance-agents.md) § Verify the instrument), and a fixture must leave the decision under test *free* — a bank seeded so richly that the choice is already made, or an opening inflated until the constraint stops binding, measures a game nobody plays.

**Name your verification tiers, and say which one you ran.** Write down the ladder your game has — a seconds-long unit and calibration tier, a minutes-long fixture tier, the full arc, the grid across personas — with what each covers and costs, then pick the shallowest that covers what the change could move. Part of the value is the ordering; most of it is the shared vocabulary, because "fixture tier green, grid pending" is a handoff and "I ran some probes" is not.

**Write the prediction down before the run.** The spine already is the prediction; the discipline is that it lands *before* the instrument runs, with what would refute it, and is not edited afterwards — a prediction adjusted after seeing the numbers has no evidentiary value, and the adjustment is invisible one commit later. When a result refuses the change, that is the finding. Keep a refused change re-derivable with the cell it lost on, so a later basis shift can revive it rather than leaving it retired by a table that no longer exists.

## Reading a game's balance shape

Before writing a spine, classify what you're writing it for. The unit is the **subsystem**, not the game — a game is a composition of subsystems with their own rate functions, and it is normal for some to close in standard algebra while others don't.

This is a spec-layer tool. Its output is which closed form you write, and it is what tells you when there isn't one.

### The buckets

Walk each subsystem against this vocabulary:

- **Pure closed-form** — the rate function is in the standard algebra (constant, linear, geometric, polynomial, log, logistic). Integrals exist, the formula is readable, inversion closes.
- **Piecewise closed-form** — regime-spliced. Same algebra per regime, breakpoints at threshold crossings, extra bookkeeping.
- **Coupled-state deterministic** — multiple resources with deterministic mutual feedback. Linear systems close via matrix exponential; general nonlinear coupling does not.
- **Strategy-space integration** — adversarial. Payoff depends on a joint choice. Per-fixed-strategy ROI closes; the equilibrium is game-theoretic math. Two-player game trees belong here too, with minimax and combinatorial game theory.
- **Stochastic load-bearing** — variance carries design intent, not just the mean. The distribution *shape* is the spec (geometric, exponential/gamma, phase-type), and the dimensionless feel knob is usually the coefficient of variation. Combat with random targeting or rolls lands here when its outcome distribution is the intent.
- **Network-topological** — resources flow through a directed graph and throughput is bounded by topology, not just rates. Min-cut/max-flow for linear capacities.
- **Bilevel interdiction** — the player places blockers within a budget, and a follower re-solves its path against what stays open. Maze-building tower defense is the carrier. Per fixed blocker set the follower's shortest path closes; the max-min over blocker sets is a bilevel program.
- **Optimal stopping** — when-to-reset surfaces, prestige timing. Per-fixed-strategy ROI closes; the optimal threshold is a Bellman problem.
- **Combinatorial selection** — a configuration committed from a discrete option space: an upgrade tree, a loadout, a slot fill. Per fixed selection the modifiers collapse to constants; across selections it is combinatorial optimization.
- **Discrete planning / scheduling** — an ordered action sequence whose steps change the state later steps read: queue formation under finite slots, build order under capacity, routing under a time budget. Neither rate algebra nor equilibrium fits; the adjacent math is planning and scheduling.

Discrete planning deserves a note, because it is where the framework dodge lives. "This is discrete and combinatorial, so there's no math available" is not the right read — the math is there, under planning, scheduling, and operations research. The candidate algorithms are the usual ones and the choice is made on structure: A\* when state is enumerable and an admissible heuristic is cheap; dynamic programming when the state space decomposes into overlapping subproblems; MCTS when branching defeats enumeration but rollouts are cheap; beam search when "good enough" plans are useful and optimal is intractable.

Neighbors split on tests you can run against the code. A configuration whose options read state an earlier option wrote is a plan, not a selection. A graph that an opponent re-routes around is interdiction, not network flow. A fixed point between agents is strategy-space; a commitment the other side answers is interdiction.

A subsystem can classify two ways at once — coupled-state deterministic per fixed strategy, optimal stopping across strategies, to take the common pair. Name both, because they imply different tooling.

Finding that some of your subsystems close and some don't is not a failure of the method. It is reading the design correctly.

### The orthogonal axis: runtime

A bucket classifies a subsystem's **spec-layer math**. Whether the *runtime* integrates that spec continuously or through discrete-event simulation is a separate annotation and does not change the bucket.

- **Sim as fallback** — the spec doesn't close, so simulation is what you reach for because the integration isn't doable on paper.
- **Sim as gameplay** — the spec *closes*, every constituent rate function is standard, but the gameplay loop *is* the integration over discrete events. Tower defense, auto-battlers, real-time combat.

The temptation in the second case — "we have a sim, so we don't need the math" — is exactly inverted. *Because* the sim is the gameplay, the spec it runs has to be specified precisely, or the gameplay drifts and tuning becomes opaque.

### When prediction and truth disagree

The useful first question is not "which constant do I change" but **which layer is wrong**:

- **The implementation drifted.** The spine is right and the game stopped matching it. Cheapest to fix and the most common cause of a *sudden* disagreement.
- **Retune.** Adjust a constant. The intent is expressible under the current content at a different numeric setting.
- **Reshape content.** Change cardinality or targets. The intent can't be expressed at *any* constant setting. If the reachable modifier stack is 10⁴× and the design asks for 10⁶×, no tuning of one knob closes that; the content surface has to grow.
- **Reshape the predicate.** The predicate measures the wrong moment. "Five achievements earned" fires too early when every achievement grants the same multiplier and the perceptible moment is the first *compounding* one.
- **The spine's shape is wrong.** The closed form was the wrong family for this subsystem. Re-walk the buckets.
- **The basis moved.** Nothing is wrong with the number except the column it was fitted against — a baseline, a denominator, a policy output the change has since moved. Fix the basis and re-take the denominator *before* grading, or every net in the pass is measured against a hole. And re-derive the value on the column it will ship against: the old window's *interior* is not a safe default, and picking a fresh value inside a stored band inherits the refuted table one level down, where the inheritance is invisible.
- **The constant is an average of something that varies across the arc.** A run-average of a quantity that drifts with progression is a summary, not a constant. Re-fitting it does not converge, because the fitted value changes run length and run length changes the quantity; the tell is oscillation with roughly unit gain across passes rather than a drift toward a value. Damping the fit is a workaround and should be labelled as one — the repair is to make the quantity a function of the phase variable.
- **The metric is wrong.** The quantity you chose to design against is structurally unable to express your intent — it stays pinned in a narrow range no matter what the player does, so it cannot mark the transition you wanted it to mark. The fix is to design against a different quantity, one the spine actually predicts well. This is the finding that tuning cannot reach, and it only ever surfaces by running the game.

Often the answer coordinates two or three of these. The probe surfaces the choice; a human makes the call.

## Engine as oracle

The unifying rule: **your prediction never re-implements game mechanics.** The math is the spec, the engine is the truth. A predictor that re-derives cost curves in its own arithmetic is pinned to the engine version it was written against and silently diverges; one that asks the engine cannot.

There are two query modes against the same instance:

**Frozen-state queries.** Build the engine, mutate persistent refs into a hypothetical state, and *don't tick*. Read `ProducerCategory.getTotalRate(resource)` for aggregate per-resource rate, `Purchasable.amount` / `.active` for purchase state, `Purchasable.countToPurchase` and `getCost(n)` for what a buy would take and cost (a producer's purchasable is `producer.repeatable`), the free functions `calculateCost` / `calculateMaxAffordable` over a cost `Formula` at the core layer, and `ModifierChain` bindings with per-link contributions for attribution. The engine answers "what would cost and rate be at this state" without running gameplay — which is how a walker steps a schedule without simulating it.

**Ticking runs.** Install the game's automation, then `runUntil` a beat predicate fires. The engine plays; the script times the beats.

These are probe-lane tools, not spine tools — both construct an engine.

**Ceremony that is load-bearing.** `pushOverrides` + `importSave` + a `overrideDepth === 0` assertion are what make "one engine instance, many iterations" sound. Push scope before each iteration, restore from a captured baseline, run, and assert depth returns to zero before the next. The iteration logic changes per game; the ceremony doesn't. A leaked scope makes iteration N+1 read as a balance finding when it is contamination — the engine-level instance of restore parity (§ When an agent is the instrument), which is the same failure wherever a state is stood up rather than played into.

## Engine surfaces

The harness is the toolkit. Curated entries; the full surface is `docs/api/harness.md`, and `docs/api/INDEX.md` routes per symbol.

| Surface | Use for |
| --- | --- |
| `runUntil` | Predicate-bounded single-engine run. The workhorse. Dispatches on `RunMode` (`'tick'`, `'event'`, `'stasis-aware-tick'`). |
| `runProbe` | Per-beat termination-time distributions from a seed sweep. |
| `runWaypointProbe` | Snapshot-at-time across an arc per seed × waypoint; band occupation reads off the snapshot series. |
| `runHeadless` | Fixed-tick-count run. Replayable only when you pass `seed`: the module-global RNG is entropy-seeded otherwise. |
| `runMatrix` / `runMatrixUntil` | Cartesian runs over a parameter grid, when you want many configurations at once. |
| `runSensitivity` | One parameter swept across a range with per-variant deltas against baseline. Generic over `Cell` and `UntilCell` via `config.until`. |
| `bisectTuner` | 1-D bisection of a fire-time sampler onto a target time, when a spec gives you a shape and you want the scalar. Says when the target lies outside the bracket. |
| `applyPerturbation` | Apply a perturbation to a `PickerEntry` and get an idempotent cleanup. |
| `createPickerSnapshot` | Enumerate the engine's addressable choices (content, chain-registry, tunable). |
| `createSensitivityCell` | Build a matrix cell from a save blob + per-run module factory + analyzer factory. |
| `createEngineFromSave` | Load a save into an isolated scratch engine — a predictor or worker simulating ahead of the live game. |
| `diffAggregates` | Per-metric delta between a variant cell and baseline. |
| `createTransitionSnapshot` / `createIncrementalSnapshot` | Pending content transitions; caching overlay for time-series introspection. |
| `defaultAnalyzerPack` / `seriesAnalyzerPack` | Cycle-finalize and resource-peak analyzers; per-resource trajectory capture. |
| `classifyFlowChannel` / `getFlowChannelBoundaries` | Classify a beat duration into its flow channel; read the threshold table. |

Most balance work uses the first two and the analyzer packs. The sweep surfaces are there when a design question genuinely is "what does this curve look like across a range" — reach for them then, not as routine process.

### Flow channels

`FlowChannel` classifies a beat duration into six bands — `arousal`, `flow`, `flow-upper`, `boredom`, `frustration`, `breakdown`. The first three are engaged; the rest are not. Collapsing the disengaged three gives a binary read when that's all you want.

The framing that makes this useful is that the objective is **shape of play, not beat-second targets**. "Land beat 3 at minute 17" is a number with nothing behind it. "Spend most of the arc in the engaged bands, with beats firing in order and the arc completing within budget" is an intent the spine can predict and the probe can check.

### `tickDelta`

A two-hour arc at the engine's default tick runs on the order of a hundred thousand ticks per probe. At `tickDelta: 1` it runs a few thousand — one to two orders of magnitude faster, with minute-scale timing unchanged.

Default to `1` for arc probes. Drop lower only when sub-second timing is part of the spec: explicit click cadence, real-time combat resolution, anything resolving faster than a second.

The engine's `maxDeltaTime` (default `1`) bounds the speedup, not the timing. A step larger than the cap reaches the engine as several equal calls under it — every reported second is simulated, but past the cap coarsening stops buying speed. Raise `maxDeltaTime` on the probe engine to coarsen further.

### `stasis-aware-tick`

`runUntil({ mode: 'stasis-aware-tick' })` short-circuits ticking when the game has stopped progressing, turning a probe that would burn to `maxSimTime` into one that terminates early and honestly.

The adoption condition is structural, not a heuristic: **the accessor faithfully captures the engine's income channels if and only if there is no out-of-band rate channel it can't see.**

If every continuous income channel flows through producer categories — or fires as a discrete event the predicate observes directly — it adopts cleanly. If the game has a click affordance, a tick-jitter spawn channel, or any other rate the accessor doesn't read, it misfires: the accessor reads zero, declares stasis, and kills a run that was still bootstrapping. The decision point is the accessor's `getRate(resource)`, and the question is binary.

**The cap-reach sub-axis.** The rule above is necessary but not sufficient. A cap-bounded resource whose value clamps at a ceiling introduces a second wedge: the rate is real but the integrand is bounded. Stasis detection inspects transition-walker transitions — purchasable distances, conversion readiness — rather than the accessor's rate, so a purchasable that is visible and uncapped reports as a finite transition even when the resource it consumes is wedged at a zero cap. Stasis returns false and the run terminates as `maxSimTime` rather than as unreachable. Detecting cap-reach termination needs a budget-bounded reachability check layered on top; that is deliberately absent rather than overlooked.

## Where balance constants live

`tunable()` plus a `TuningRegistry` (`createTuningRegistry`) is the canonical answer. Values declare at their **reader sites**, not in a central constants file:

```ts
// at the reader site — a producer module, an upgrade definition, an achievement threshold
const effect = tunable(tuningRegistry, 'upgrades/double-gold/effect', () => baseEffect.times(amount));
```

The chosen number lives in the default closure. The registry exposes it to the picker, so probes and a balance workbench can enumerate and perturb it, and to scoped overrides, so a probe can swap the value transiently and restore on cleanup. A probe sweeps a knob by pushing a tuning scope, never by editing source.

Two rules follow, both load-bearing:

**Route balance constants through `tunable()` from the first pass — no parallel constants file.** A game with both has two homes for one number and no rule for which wins. Keep pure config (content shape, ids, cardinality) in your data layer, and declare every *perturbable* value at its reader site. A deep-partial override path stays useful for non-tunable surfaces — theme tokens, ids, cardinality — but not for balance.

**Every field in your data layer should have a reader.** Authoring the data shape ahead of the modules that consume it reliably produces fields nothing reads, and a dead field is indistinguishable from a live one until someone tunes it and nothing happens. Author only what consumers read.

### `Formula` at the wiring layer

The spine stays plain arithmetic. But when a spine-derived constant is wired into a live purchasable's cost or a skill's XP curve, **express the curve as a `Formula` rather than a hand-rolled closure** — `Formula.variable(n).pow(exponent).mul(base)`, or the `baseCost`/`costScaling` shorthands that are Formula-backed underneath.

This is easy to miss because a hand-rolled `Math.pow` cost function works fine on the day you write it. What you forfeit is the engine's bulk-purchase math: `calculateMaxAffordable` counts levels over a cost `Formula`, and seeds the count from its inverse where it has one. At the default `maxBulkCount` a non-Formula cost is single-purchase only; raise it and bulk is priced linearly off the current rung, which undercharges any ladder (`CostRequirementOptions.cost`). Either way you lose the "next at N" inversion a UI wants. The limitation shows up much later than the choice does, in a feature request rather than an error.

The rule of thumb: if a number only ever feeds a prediction, plain arithmetic. If it becomes a cost the player pays repeatedly, `Formula`.

## When a balance pass finds an engine gap

Balance work is where missing engine surface shows up first, because it is where you ask the engine questions nobody asked before.

When you find yourself hand-rolling a query the engine should own, leave a `TODO(expansion)` marker at the hand-roll site — three lines, co-located — and record the finding wherever your project collects them. The distinction that matters: would deleting the hand-roll force you to *invent* new engine API, or only to *re-wire* primitives that already exist?

The engine grows by pulling from those records, deliberately and selectively. It does not reference them back, and no downstream doc amends this one — so don't write a promotion pointer into this guide's sections. Record the finding where your project's convention puts it and let an engine pass read it.

Two things make a record worth acting on later. State the receipt — the actual site, by path and symbol — rather than a count; a bare "this came up twice" is unauditable once the two sites are out of view. And state how you got there: reaching a gap against engine source and being handed it by a doc you read are different evidence that read identically afterward. A hand-roll that turns out to duplicate existing API is still a finding — it says the surface wasn't discoverable, which is a docs fix rather than an engine one.

The prior is "use the engine, fix gaps when they're real." When you do bypass an engine primitive to make something work, document the decision inline where the bypass lives.

## Cite-out

This guide owns process over the engine. Theory and prescription live upstream, in sibling repositories rather than in this package:

| Question | Goes to |
| --- | --- |
| What shape does this rate function take, and when does it close? | `open-loop-research/methodology/techniques/closed-form-progression/` |
| Which named adjacent math takes over when it doesn't close? | `closed-form-progression/bifurcations.md` |
| Which rate-function shape is my subsystem on? | `incremental-math/src/pages/rate-functions/` |
| Which composition row does my economy walk? | `closed-form-progression/rate-function-algebra.md` |
| What number should I pick? | `incremental-math/src/pages/design-playbook/` |
| What patterns does my game compose, and how common are they? | `open-loop-research/LIBRARY.md` |
| Where does the agent-as-playtester literature live? | `open-loop-research/reference-code/papers/`, via its README |
| What engine primitive does X? | `docs/api/INDEX.md`, then the routed tier file |
| How do I compose the engine at all? | [consumer-guide.md](./consumer-guide.md) |
| What's the worked shape for this composition? | [consumer-guide-recipes.md](./consumer-guide-recipes.md) |
| My probe's numbers come out of a bot-driven run — now what? | [consumer-guide-balance-agents.md](./consumer-guide-balance-agents.md) |
| How do I run the process? | this file |
