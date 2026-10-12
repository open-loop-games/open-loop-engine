# Balance guide

How a game built on `@open-loop/engine` chooses and verifies its numbers. Read this before you change a balance constant or write your first probe.

This is the third companion to [consumer-guide.md](./consumer-guide.md). That guide explains **how to compose** the engine. [consumer-guide-recipes.md](./consumer-guide-recipes.md) contains the worked shapes consumers build from it. This file contains the discipline for **what the numbers should be**, and how you know. Its own companion, [consumer-guide-balance-automated-player.md](./consumer-guide-balance-automated-player.md), applies when an automated player plays the game your probe measures. It is engineering process over the engine's balance harness; game-design theory is outside this package (§ Cite-out). Directory layout and naming are your repo's decision.

## The balance floor

The short version. If you read nothing else here, for a first balance pass, a prototype or a spike, this part must be true.

1. **Write the spine first.** Derive every balance constant from a closed-form expression, with a one-line derivation comment at the value. Use plain arithmetic and no engine. If you cannot predict the shape on paper, that is the finding: the mechanic is probably mis-specified.

2. **The spine is a prediction, stated so it can be wrong.** It is not a target you defend, and not a record of what happened. It says what the math expects, specifically enough that a headless run can contradict it.

3. **Run the real game and diff prediction against truth.** Build the engine with the real modules and the game's real automation. Play the arc headless, and compare the spine's prediction with what the game did.

4. **When they disagree, decide which one was wrong.** Sometimes the implementation drifted. Sometimes the spine's shape is wrong. Sometimes the *metric* is wrong: the quantity you design against cannot express your intent, and no tuning of either side fixes it. All three are findings; only the first is a bug.

5. **The engine is the truth; the spine is the prediction.** The math predicts, and the engine decides. A behavior that no headless run shows does not belong in your prediction.

6. **Balance verification is a script that prints, not a test that asserts.** It reports deltas for a human to read. See § Why this isn't a test suite.

7. **Coarsen the tick.** Balance is measured in minutes, and the engine's default dt is built for live play. See § `tickDelta`.

8. **An automated player that plays the game for you is part of the instrument.** Every number its probe prints is a joint claim about the design *and* the automated player. You cannot tell the two apart until you calibrate the automated player separately. See § When an automated player is the instrument.

Everything below is these eight, with their reasoning, their failure modes and the engine API behind each.

## Prediction and truth

Two sides, and the balance loop between them.

```
      the spine  ───── predicts ─────▶  what should happen
   (closed form,                              │
    plain math)                             diff
                                              │
      the probe  ───── measures ────▶  what actually happens
   (real engine, real modules,
    real automation policies)
```

Nothing else pins the result. The diff *is* the check, and it runs when a human runs it.

### The spine — a falsifiable prediction

The spine is the closed-form expression behind every constant, written next to it. It names what the constant couples to, and what you would re-tune if the shape came out wrong.

Keep it in plain arithmetic. Engine math is not forbidden. But the spine's job is to be *read*, by you in six months or by a reviewer, and plain arithmetic reads in one pass. Use `Decimal` when magnitudes need more precision than the native number type has.

Keep the engine out of it. A prediction that builds an engine and reads live state has stopped predicting and started measuring. Then prediction and measurement agree vacuously, because they are the same observation twice. The rule is not "no engine import". It is **no engine construction and no live-state read**. Pure algebra in the engine is still algebra.

A closed form can be worth executing. It predicts a run length, sizes a parameter, or projects a horizon no headless run reaches in reasonable time. Then make it a runnable function, not a comment. That is still the spine in executable form, not a second source of truth.

**What a derivation comment must contain.** A one-line derivation is worth having only if the line is checkable. A comment that says `// measured` is not a receipt. It claims a measurement that may never have happened, and it looks identical to one that did. A receipt names the source: the expression it came from. For a value fitted from headless runs, it names those runs, the date and the seed count. If you chose a number by feel, say *that*. An honest guess is more useful than a guess in derivation language, because the next person knows which numbers to attack first.

**A solved quantity has one home, and the code that grows reads it.** The spine may *solve* for a rate: the per-purchase gain that holds time-to-kill flat, or the ladder that puts beats on schedule. Then the implementation must read that solved value, not re-author the growth beside it. Two authored copies drift silently. The failure looks like a permanent deficit and a game that is too hard, not like arithmetic. It gets tuned with the wrong constants. The second face of the rule: **every term that multiplies a solved curve belongs inside the solve.** A term left out is not a small error, because the rest of the model assumes the solve is delivered. The divergence compounds, and nothing reports it.

**Keep the retired shape where it was retired.** A headless run can show that the spine was the wrong *family*, not the wrong constant. Then write down what the old shape assumed and what contradicted it, at the value that replaced it. Three lines are the cheapest guard against re-deriving a refuted shape a year later. By then the conclusion is remembered and the refutation is not.

### The probe — real engine, real policies

The probe builds the real engine with the real modules and plays the game headless. It uses the real automation policies, never a re-implementation. A probe that re-implements a mechanic to measure it measures the re-implementation.

A game that ships player-facing automation writes each policy as a pure function over game state, gated by `AutomationTiers`. The probe forces the automation tier instead of modeling the policy: bank a save, set the automation tier state, run. Forcing an automation tier *off* takes one more step. A load re-unlocks any automation tier whose `unlockWhen` predicate holds, so write `tiers.unlocked` after the load returns. The predicate unlocks it again only when it flips to true, or when the next load or reset settles. So the forced state holds for the headless run. The probe then exercises the code the player runs, and the two cannot drift. The policy's parameters are also the sweep axis, and later the player's tuning options. A thin runner works only the manual openers a player would work.

The exception is deliberate. Behavior that exists *only* to perturb the game, such as full-auto play drivers or optimal-play enumeration, is balance-harness tooling. It stays on the probe side. The test: is the behavior also a real mechanic? If so, it is game code.

A probe worth keeping is worth committing. Wire it into your scripts (`"sim": "vite-node scripts/…"`), not a scratch directory. A balance script outside the repo is rebuilt from memory whenever the economy moves. Fold one-off diagnostic scans into it once they have served.

A useful probe has three passes:

- **Anchors** — force a few points on the progression ladder, play at each, and diff the spine against the engine.
- **Coefficients** — refit any empirically fitted scalars from those same headless runs, and print them *beside* the values in source. Drift here signals that something moved under the spine.
- **Arc walk** — play the designed arc under a fixed policy, and report each beat's fire time against the spine.

Report distributions, not point values. `mean [min, max]` is the readable default. State the seed count, because an aggregate over five seeds prints identically to one over two hundred. Where variance expresses design intent, report the moments (mean, variance, p50, p90). There the distribution *shape* is the intent, and a mean alone hides it. Where the policy is deterministic, extra seeds confirm determinism, not correctness. One headless run tells you as much as fifty.

**Probe the design, not the automated player's authored parameters.** A probe targets the design under test: cost curves, ROI on upgrade ladders, hit rates, HP against DPS, spend rates. Authored parameters set *how the automation plays*: decision quality, reaction lag, cadence jitter, persona choice. They are not the design, and neither is a difficulty setting that handicaps one side. The working test: would this number change with a different reasonable automated player? If yes, the probe measures the automation. Keep those parameters fixed *within* a comparison. Before a conclusion, sweep them across the grid. That is a separate rule, with its own reason (§ When an automated player is the instrument).

### The balance loop

Spine, build, run, diff, decide, next pass.

A **contradiction** starts the next pass, not a schedule. You run the game and find a stalled economy, a pinned metric, or a beat far from prediction. That finding sets the next pass. A pass added because the plan said so has no evidence behind it.

The first headless run is the first to exercise the whole chain: rates, resources, predicates, beats. It routinely finds structural defects that no tuning fixes: an economy that never leaves zero, an unreachable purchase, a resource capped all arc. Confirm the game *plays* end to end under its own automation before you treat any number as a balance question. Module unit tests validate contracts; they do not tell you the game runs.

**You are done when the disagreement is boring:** the diff is small and stable across headless runs, and the remaining gap is explained. A good marker is that your throwaway diagnostic scripts are folded into the permanent probe.

### Why this isn't a test suite

Balance verification prints; it does not assert.

The tempting shape is a measured window plus a tolerance band, pinned in the test runner as a drift check. It looks like rigor, and it decays predictably. Legitimate retunes fail the suite, so the bounds get widened until it passes. Then the bound asserts nothing, and the file teaches everyone that balance failures are noise. A bound written before the design settles is a guess with a green check.

A printed diff has none of that failure mode. It reports the delta, not a boolean, so a human sees *how far* things moved and in which direction. When the economy legitimately changed, the honest response is to read the new numbers, not to edit a threshold. It also adds no pass/fail meaning to exploratory work, where a probe that finds something unexpected has succeeded.

The cost is real: nothing runs automatically, so nothing catches balance drift on a commit you did not check. Accept that, and run the probe when the economy moves. The alternative is a drift check disabled months ago that still shows green.

**The assertion that still holds after a retune is liveness, not value.** A third, narrow suite is between behavioral suites and printed probes. It is worth having and easy to miss, because it asserts about the *instrument*, not the design. Four forms recur:

- A **calibration scenario**: the automated player still does the right thing in a situation with a known answer.
- A **fixture-liveness** assertion: the deliberately hard case still fails, and the deliberately survivable one still survives. An improvement that moves the magnitude passes. A change that makes every fixture report success fails, because a fixture that cannot fail has stopped measuring. These go stale on purpose. When a real improvement clears one, re-measure and commit the new table; do not lower the bar.
- A **derivation guard**: a runnable projection still couples to the constants it derives from. So a balance edit that breaks one of its assumptions fails here, instead of silently producing confident wrong numbers.
- A **symmetry** assertion: structurally identical things, such as mirrored sides or interchangeable seats, reach identical state. Otherwise a substrate asymmetry appears as a *balance* result. It is chased through the numbers, and it biases every cell of a sweep at once.

None contains a magnitude, so none decays into a widened bound. All fail for one reason: the instrument stopped measuring.

**Behavioral tests are a different suite, and they stay.** "Does the slot free, does the count go up, does the wave complete" belongs in the test runner, driving the assembled engine tick by tick. Those assertions contain no magnitudes, so they still hold after a retune. Keeping balance out of the suite does not keep the game out of it. Magnitudes and mechanics are different questions. A suite that mixes them fails on every retune and gets ignored.

## When an automated player is the instrument

An automated player can play the game for the probe: an automation tier, an AI opponent, a persona in place of a player. Then every number is read *through* it, and its defect looks the same as a design defect. It arrives as a plausible balance finding, survives sweeps, and a design decision gets built on it. Unit specs on the policy do not catch it: they assert plumbing, and plumbing stays true of a policy that decides exactly wrong.

That subject has its own file, [consumer-guide-balance-automated-player.md](./consumer-guide-balance-automated-player.md). It covers:

- calibration on named situations;
- joining every optimized quantity to a realized counterpart;
- proof that a scoring term has spread before you tune its weight;
- what a converging policy cannot measure;
- personas as a coverage axis;
- three checks on the probe: one brain, restore parity, pipeline liveness.

## Making a pass cheap

**Grading** is the bottleneck of a balance pass, not running: headless runs parallelize, and judgment does not. Most of a pass's cost is headless runs spent on questions a cheaper instrument, or none, already answers.

**Read before you run.** A source read that settles a question is a finding. Read the file header, not only the symbol you arrived with. It often records a standing refusal of exactly the proposed change.

**Name the content that could answer it.** A question is gradeable only where something in your game can express it, and two thresholds differ. A channel with **one carrier** gives an address, not a finding: one carrier cannot separate a mechanism from its own shape. A channel with **zero carriers** gives no result at all. A flat sweep there describes your content, so the honest output is a content request, not a refutation. Generate the carrier list; do not recall it, because recalled lists are often wrong. When a line of work stops producing findings, ask what your content can express. Adding a carrier is often cheaper than another mechanism.

**A printed report is the proof that a refactor preserved behavior.** Re-run the probe against the pre-change tree, and diff the numbers. That is a stronger claim than a green suite, which says only that no assertion broke. Keep the report machine-diffable for this. If a baseline is slow to generate, cache one per commit, built from that commit alone.

**Inertness is cheap; magnitude is not.** Identical-versus-not has no noise floor. So a balance constant measured unchanged across its range is settled in one headless run per end. Only a balance constant that *does* move something needs the wide read.

**Widen along the axis that actually varies.** A read narrower than what moves it reports the wrong shape: it understates a real difference as readily as it invents one. Which axis contains the variance depends on your game:

- seeds, where the arc is stochastic;
- distinct trajectories, where personas diverge;
- content variants, where the game is deterministic and seeds only prove the balance harness repeats.

Where the game is deterministic, repeating a cell measures nothing, and averaging cells measures less. Noise comes from measurements on a busy machine, mainly wall-clock time, where a number that moved once has not moved.

**Bank states; do not replay arcs.** Replaying the arc to reach one phase of a run is a pass's largest avoidable cost. Keep named mid-arc saves, and start probes from them. Share the set with the game's QA tools, so use keeps it honest. Two guards apply. First, a banked state goes through the restore path, so it needs restore parity ([consumer-guide-balance-automated-player.md](./consumer-guide-balance-automated-player.md) § Verify the instrument). Second, a fixture must leave the decision under test *free*. A bank so rich that the choice is already made, or an opening inflated until the constraint stops binding, measures a game nobody plays.

**Name your verification suites, and say which one you ran.** Write down your game's suites in order, with what each covers and costs. For example: a seconds-long unit and calibration suite, a minutes-long fixture suite, the full arc, the grid across personas. Then pick the shallowest that covers what the change could move. The shared vocabulary matters most: "fixture suite green, grid pending" is a handoff, and "I ran some probes" is not.

**Write the prediction down before the headless run.** The spine is the prediction. Write it *before* the instrument runs, with what would refute it, and never edit it afterward. A prediction adjusted after the numbers is no evidence, and one commit later the adjustment is invisible. When a result refuses the change, that is the finding. Keep a refused change re-derivable, with the cell it lost on, so a later basis shift can bring it back.

## Reading a game's balance shape

Before you write a spine, classify what it is for. The unit is the **subsystem**, not the game, and it is normal that some subsystems close in standard algebra and others do not. The output is which closed form you write, or that there is none.

### The buckets

Classify each subsystem against this vocabulary:

- **Pure closed-form** — the rate function is in the standard algebra (constant, linear, geometric, polynomial, log, logistic). Integrals exist, the formula is readable, and inversion closes.
- **Piecewise closed-form** — regime-spliced. Same algebra per regime, breakpoints at threshold crossings, extra bookkeeping.
- **Coupled-state deterministic** — several resources with deterministic mutual feedback. Linear systems close through the matrix exponential; general nonlinear coupling does not.
- **Strategy-space integration** — adversarial: the payoff depends on a joint choice. ROI per fixed game-theory strategy closes; the equilibrium is game-theoretic math. Two-player game trees belong here too, with minimax and combinatorial game theory.
- **Stochastic load-bearing** — variance expresses design intent, not just the mean. The distribution *shape* is the intent (geometric, exponential/gamma, phase-type), and its coefficient of variation usually sets feel. Combat with random rolls belongs here when its outcome distribution is the intent.
- **Network-topological** — resources flow through a directed graph, and topology bounds throughput, not just rates. Min-cut/max-flow covers linear capacities.
- **Bilevel interdiction** — the player places blockers within a budget, and a follower re-solves its path against what stays open. The carrier is maze building, where the player's blockers re-route the path. For a fixed blocker set, the follower's shortest path closes; the max-min over blocker sets is a bilevel program.
- **Optimal stopping** — when to reset, and prestige timing. ROI per fixed policy closes; the optimal threshold is a Bellman problem.
- **Combinatorial selection** — a set of choices committed from a discrete option space: an upgrade tree, a loadout, a slot fill. For a fixed selection, the modifiers collapse to constants. Across selections, it is combinatorial optimization.
- **Discrete planning / scheduling** — an ordered action sequence whose steps change the state later steps read. Examples: queue formation under finite slots, build order under capacity, routing under a time budget. Neither rate algebra nor equilibrium fits; the adjacent math is planning and scheduling.

"This is discrete and combinatorial, so no math applies" is the wrong read of discrete planning. The math exists, under planning, scheduling and operations research. Structure decides between the usual algorithms:

- A\* when state is enumerable and an admissible heuristic is cheap;
- dynamic programming when the state space decomposes into overlapping subproblems;
- MCTS when branching defeats enumeration but rollouts are cheap;
- beam search when "good enough" plans are useful and optimal is intractable.

Neighbors split on tests you can run against the code. A set of choices whose options read state an earlier option wrote is a plan, not a selection. A graph that an opponent re-routes around is interdiction, not network flow. A fixed point between opponents is strategy-space; a commitment the other side answers is interdiction.

A subsystem can classify two ways at once. The common pair is coupled-state deterministic per fixed policy, and optimal stopping across policies. Name both, because they imply different tooling.

Some subsystems close and some do not; that is a correct reading of the design, not a failure of the method.

### The orthogonal axis: simulation

A bucket classifies a subsystem's **spine math**. Whether the game integrates it continuously or through discrete-event simulation is a separate note, and does not change the bucket.

- **Simulation as fallback** — the spine does not close, so you simulate because the integration cannot be done on paper.
- **Simulation as gameplay** — the spine *closes*, and every constituent rate function is standard. But play itself *is* the integration over discrete events. Examples: waves that walk a path, battles that resolve on their own, real-time combat.

In the second case, "we have a simulation, so we don't need the math" is exactly inverted. *Because* the simulation is the gameplay, its spine must be precise, or tuning becomes opaque.

### When prediction and truth disagree

The useful first question is not "which constant do I change" but **which part is wrong**:

- **The implementation drifted.** The spine is right, and the game stopped matching it. This is the cheapest to fix, and the most common cause of a *sudden* disagreement.
- **Retune.** Adjust a constant. The current content can express the intent at a different numeric setting.
- **Reshape content.** Change cardinality or targets, because no constant setting can express the intent. If the reachable modifiers total 10⁴× and the design asks for 10⁶×, the content has to grow.
- **Reshape the predicate.** The predicate measures the wrong moment. "Five achievements earned" holds too early when every achievement grants the same multiplier. The perceptible moment is the first *compounding* one.
- **The spine's shape is wrong.** The closed form was the wrong family for this subsystem. Classify it against the buckets again.
- **The basis moved.** Only the column the number was fitted against is wrong: a baseline, a denominator, a policy output the change moved. Fix the basis and re-take the denominator *before* grading, or every net is measured against a hole. Re-derive the value on the column it will ship against. A fresh value inside the old tolerance band silently inherits the refuted table.
- **The constant is an average of something that varies across the arc.** A run-average of a quantity that drifts with progression is not a constant. Re-fitting it does not converge, because the fitted value changes run length, and run length changes the quantity. The tell is oscillation with roughly unit gain across passes. Damping the fit is a workaround; label it as one. The repair makes the quantity a function of the phase variable.
- **The metric is wrong.** The quantity you design against cannot express your intent. It stays in a narrow range whatever the player does, so it cannot mark the moment you wanted. Design against a quantity the spine predicts well. Only a headless run of the game finds this, and tuning cannot fix it.

Often the answer combines two or three of these. The probe shows the choice, and a human makes the call.

## Engine as oracle

The unifying rule: **your prediction never re-implements game mechanics.** The math predicts, and the engine is the truth. A predictor that re-derives cost curves in its own arithmetic silently diverges from later engine versions. One that asks the engine cannot.

**Building one.** A probe's engine is a scratch engine: the game's own modules, on memory storage:

```ts
const engine = createEngine({
  gameId: 'my-game',
  storageAdapter: createMemoryStorage(), // nothing reaches the player's storage
  persistenceNamespace: `probe-${cell}-${seed}`, // unique among engines not yet disposed
  autoSaveInterval: 0,
  timerProvider: { setInterval: () => 0, clearInterval: () => {} }, // no live interval
});
for (const m of gameModules) engine.use(m);
engine.start(); // runUntil and the until-runners take a started engine
try {
  runUntil({ engine, until: () => beatReached(), maxSimTime: 3600 });
} finally {
  engine.dispose(); // frees its persistent refs for the next engine
}
```

The runners advance time themselves, synchronously. `createEngineFromSave` builds the same scratch engine from a save text, with the no-op timer already set. A frozen-state query needs no ticks at all.

Two kinds of query use the same engine instance.

**Frozen-state queries.** Build the engine, write persistent refs into a hypothetical state, and *don't tick*. Then read:

- `ProducerCategory.getTotalRate(resource)` for the total rate of a resource;
- `Purchasable.count` and `.active` for purchase state;
- `Purchasable.countToPurchase` and `getCost(n)` for what a purchase would take and cost (a producer's purchasable is `producer.repeatable`);
- the core functions `calculateCost` and `calculateMaxAffordable`, over a cost `Formula`;
- `ModifierChain.bindings()` for the attribution of bindings, and `EffectSystemRegistryKey` for lowered grants.

So a walker steps through a schedule without simulating it.

**Ticking headless runs.** Install the game's automation, then `runUntil` a beat predicate holds. The engine plays; the script times the beats.

Both are probe tools, not spine tools, because both build an engine.

**Ceremony that matters.** `pushOverrides`, `importSave` and an `overrideDepth === 0` assertion make "one engine instance, many iterations" sound. Push overrides before each iteration, and load a captured baseline save. Run, and assert the depth is back to zero before the next. The iteration logic changes per game; the ceremony does not. A leaked scoped override makes contamination in iteration N+1 look like a balance finding. It is the engine-level case of restore parity (§ When an automated player is the instrument).

## Balance harness API

A selection; `docs/api/harness.md` has the full balance harness API.

| Function | Use for |
| --- | --- |
| `runUntil` | The workhorse: one headless run that a predicate ends, in a `RunMode`. |
| `runBeatProbe` | Termination-time distributions per beat over a seed sweep. |
| `runWaypointProbe` | A snapshot per seed × waypoint across an arc. |
| `runHeadless` | A headless run of a fixed tick count. Pass `seed` to make it replayable. |
| `runMatrix` / `runMatrixUntil` | Cartesian headless runs over a parameter grid, for many cells at once. |
| `runSensitivity` | One parameter swept across a range, with per-variant deltas against the baseline. |
| `bisectTuner` | 1-D bisection of a fire-time sampler onto a target time, for the scalar when the spine gives the shape. |
| `applyPerturbation` | Apply a perturbation to a `PickerEntry`; returns an idempotent cleanup. |
| `createPickerSnapshot` | Enumerate the engine's perturbable addresses: the effect system's lowered grants, chain-registry chains, tunables. |
| `createSensitivityCell` | Build a matrix cell from save text, a module factory per headless run and an analyzer factory. |
| `createEngineFromSave` | Load a save into a scratch engine, to simulate ahead of the live game. |
| `diffAggregates` | The delta per metric between a variant cell and the baseline. |
| `createTransitionSnapshot` / `createIncrementalSnapshot` | Pending content transitions; a cached form that rebuilds only what changed. |
| `defaultAnalyzerPack` / `timeSeriesAnalyzerPack` | Run-finalize and resource-peak analyzers; per-resource trajectory capture. |
| `classifyFlowChannel` / `getFlowChannelBoundaries` | Classify a beat time into its flow channel; read the threshold table. |

Most balance work uses the first two and the analyzer packs. Keep the sweep runners for questions about a curve across a range.

### Flow channels

`FlowChannel` classifies a beat time into six flow channels: `arousal`, `flow`, `flow-upper`, `boredom`, `frustration`, `breakdown`. The first three are engaged; merge the other three for a binary read.

The objective is **shape of play, not beat-second targets**. "Reach beat 3 at minute 17" has nothing behind it. Compare "most of the arc in the engaged flow channels, beats in order, the arc complete within budget". The spine can predict that intent, and the probe can check it.

### `tickDelta`

A two-hour arc at the engine's default dt runs about a hundred thousand ticks per probe. At `tickDelta: 1` it runs a few thousand, with minute-scale timing unchanged.

Default to `1` for arc probes. Go lower only when sub-second timing is part of the design, such as click cadence or real-time combat.

The engine's `maxDeltaTime` (option default `1`) bounds the speedup, not the timing. A `tickDelta` above it reaches the engine as the fewest equal ticks under the cap. Every second is simulated, but past the cap coarsening stops making the probe faster. Raise `maxDeltaTime` on the probe engine to coarsen further.

### `stasis-aware`

`runUntil({ mode: 'stasis-aware' })` stops ticking when the game has stopped progressing. A probe that would run to `maxSimTime` ends early and honestly instead.

The adoption condition is structural, not a heuristic: **the mode fits if and only if the accessor sees every rate channel the game has.**

It fits cleanly if every continuous inflow goes through producer categories, or is a discrete event the predicate observes directly. It misfires if the game has a rate the accessor does not read, such as a click affordance or a tick-jitter spawn channel. The accessor reads zero, declares stasis, and ends a headless run that was still bootstrapping. The question is binary, and the accessor's `getRate(id)` decides it.

**The cap-reach sub-axis.** That rule is necessary but not sufficient. A resource clamped at a cap is a second failure case: the rate is real, but the integrand is bounded. The stasis check reads transition-walker transitions, such as transition distances and conversion readiness, not the accessor's rate. So a visible, uncapped purchasable reports a finite transition, even when the resource it spends is stuck at a zero cap. The stasis check returns false, and the headless run ends at `maxSimTime` rather than as unreachable. Detecting cap-reach termination needs a budget-bounded reachability check on top, which is absent on purpose.

## Where balance constants live

`tunable()` with a `TuningRegistry` (`createTuningRegistry`) is the canonical answer. A value is declared at its **reader site**, not in a central constants file:

```ts
// at the reader site — a producer module, an upgrade def, an achievement threshold
const effect = tunable(tuningRegistry, 'upgrades/double-gold/effect', () => baseEffect.times(amount));
```

The chosen number is the registry default, the closure passed to `tunable()`. The registry exposes it to the picker, so probes and a balance workbench can enumerate and perturb it. It also exposes it to scoped overrides, so a probe can change the value and restore it on cleanup. A probe sweeps a tunable by pushing overrides, never by editing source.

Two rules follow.

**Route balance constants through `tunable()` from the first pass, with no parallel constants file.** A game with both has two homes for one number, and no rule for which wins. Keep plain content data (content shape, ids, cardinality) in your data files. Declare every *perturbable* value at its reader site. A deep-partial override path stays useful for values that are not tunable, such as theme tokens, but not for balance.

**Every field in your data files should have a reader.** Data shapes authored before the modules that read them reliably produce fields nothing reads. An unused field looks like a used one until someone tunes it and nothing happens.

### `Formula` where a constant is wired

The spine stays plain arithmetic. A spine-derived constant wired into a live purchasable's cost or a skill's XP curve is different. There, **express the curve as a `Formula`, not a hand-rolled closure**: `Formula.variable(n).pow(exponent).mul(base)`, or the `baseCost`/`costRatio` shorthands, which build a `Formula`.

A hand-rolled `Math.pow` cost works on the day you write it, but gives up the engine's bulk-purchase math. `calculateMaxAffordable` counts purchases over a cost `Formula`, and seeds the count from its inverse where it has one. At the default `maxBulkCount`, a non-Formula cost is single-purchase only. Raise it, and bulk cost is linear from the current cost, which undercharges any growing cost (`CostRequirementOptions.cost`). Either way, you lose the "next at N" inversion a UI wants, and you find out from a feature request, not an error.

The rule of thumb: a number that only feeds a prediction is plain arithmetic. A number that becomes a cost the player pays repeatedly is a `Formula`.

## When a balance pass finds an engine gap

Missing engine API appears first in balance work, because there you ask the engine questions nobody asked before.

Leave a `TODO(expansion)` marker of three lines at most where you hand-roll a query the engine should own. Record the finding where your project collects them. The distinction that matters: would deleting the hand-roll force you to *invent* new engine API, or only to *re-wire* existing primitives?

The engine grows by pulling from those records, deliberately and selectively. It does not reference them back, and no downstream doc amends this one. So do not write a promotion pointer into this guide; let an engine pass read your records.

Two things make a record worth acting on later. First, state the receipt, the actual site by path and symbol, not a count. A bare "this came up twice" cannot be audited later. Second, state how you got there. A gap found in engine source and a gap a doc told you of are different evidence, and they look identical afterward. A hand-roll that duplicates existing API is still a finding. It says the API was not discoverable, which is a docs fix rather than an engine one.

The prior is "use the engine, fix gaps when they're real". When you bypass an engine primitive, document the decision inline at the bypass.

## Cite-out

This guide covers process over the engine. Game-design theory (rate-function shapes, closed-form progression, research patterns, what number to pick) is outside this package. Questions this package answers:

| Question | Goes to |
| --- | --- |
| What engine primitive does X? | `docs/api/INDEX.md`, then the routed API tier file |
| How do I compose the engine at all? | [consumer-guide.md](./consumer-guide.md) |
| What's the worked shape for this engine composition? | [consumer-guide-recipes.md](./consumer-guide-recipes.md) |
| My probe's numbers come from a headless run an automated player drove. Now what? | [consumer-guide-balance-automated-player.md](./consumer-guide-balance-automated-player.md) |
| How do I run the process? | this file |
