# Balance guide — when an automated player is the instrument

Companion to [consumer-guide-balance.md](./consumer-guide-balance.md). That file contains the balance process: the spine, the probe and the balance loop between them. This one contains the rules that apply when an **automated player plays the game for you**. Examples are an automation tier's policy driving a headless arc, an AI opponent, and a persona standing in for a player.

Read it when your probe's numbers come from a headless run that code played. If a closed form projects your economy and the probe only verifies it, skip this file. Return to it when you write your first automated player.

A probe that plays the game needs something to play it. Every number it prints is read *through* that automated player. So a defect in the automated player is indistinguishable from a defect in the design. It never announces itself as "the automated player is bad". It arrives as a balance finding with plausible magnitudes, and it still holds across sweeps. Then a design decision is built on top of it.

The usual guards do not catch this. Unit tests on a policy assert its *plumbing*: a score breakdown agreeing with its arg-max, an automation tier blocking, a headless run reproducing. Every one of those stays true of an automated player that decides exactly wrongly. Aggregates cannot catch it either. Over a long arc with several interacting terms, "a number moved" cannot answer "was that right". So tuning proceeds by comparing headless runs, and converges on nothing.

## Calibrate on situations, not on scores

Write a small suite of **named situations whose answers are knowable by inspection**. Assert on the *outcome*, not the internal choice: the pickup was banked, the threat disengaged from, the queue emptied. Assert on outcomes, because an assertion on a chosen heading or a selected candidate pins the implementation. An assertion on the result pins the behaviour, and it still holds after a rewrite. Keep the suite to seconds, so you run it while iterating rather than before a release.

This is the one balance-adjacent suite that legitimately asserts, because it contains no magnitudes. It asserts only that "this situation still resolves the right way" (consumer-guide-balance.md § Why this isn't a test suite). Run it before you believe any reading taken through the automated player. When a reading surprises you, run it again first.

## Never let the model read the authored parameter

An automated player's authored parameters state an *intent*. What the policy achieves is a different number, and the two diverge without warning. An authored parameter can bias a term that drops out of the decision. It can also ask for something the rest of the policy prevents. So **every quantity a policy optimizes needs a realized counterpart that the probe joins it against**. Sample that counterpart inside the headless run, rather than reconstructing it afterwards. Any downstream model consumes the realized number. Where a quantity has no realized counterpart, the search is blind in that dimension, and tuning it is evidence of nothing.

How far an authored parameter can drift from what it achieves scales with the **machinery between them**. A policy that executes its objective directly drifts little, and the join is a formality. Some policies have behaviour *fitted* to the objective: tuned, searched or evolved. Such a policy can arrive at a decision rule that contradicts its objective, and still score well on it. That is because the fit optimizes the outcome and never constrains the route. Where anything was fitted, the realized counterpart is not diligence. It is the only connection between the two.

Three corollaries, each learned from a failed pass:

- **Book it at the moment its outcome is decided**, inside the headless run. Do not infer it from aggregates. An inferred quantity double-counts. A residual that still holds after every mechanism that should have explained it is usually the probe's own arithmetic.
- **Read the compound, never one half.** A realized outcome can be a product of two measured factors. Each factor can diverge from its authored parameter in the opposite direction, and the two nearly cancel. So either half alone reports a divergence that the other half already offsets.
- **Re-derive after anything that moves the policy.** A stale realized value is worse than a missing one, because it still looks measured. A realized value can feed a schedule that changes run length, and run length changes the value. Then re-derivation is a feedback loop, not one measurement. See consumer-guide-balance.md § When prediction and truth disagree.

## Prove a scoring term has spread before you tune its weight

Some automated players choose by scoring a candidate set and taking the best. There, a term steers only as far as it *differs* across that set. A term with the same value on every candidate subtracts a constant, and drops out of the decision however large it is. So its weight can sweep across orders of magnitude with nothing moving. The sweep then reports "this authored parameter does nothing", when it measured a term with no spread.

The failure has two ends that look opposite and are one rule. A term that depends on a condition already decided scores zero on every candidate in the decision. A term that is widened, clamped, or swamped by a larger one flattens against the set. So scoring *more* of a thing can make the term inert. Raising the weight cannot help, because it multiplies a spread of zero.

Both are directly measurable, where no comparison of outcomes recovers them. Print each term's spread across the candidate set at decision time. Also print the share of decisions where a branch holds on *every* candidate. When a widened detector goes flat, the repair is usually an **exclusion** rather than a weight. Find the sub-region common to every candidate, and remove it. This holds for any scored selection, not only steering: a draft choosing between offers, target selection, an AI opponent choosing a build.

Where flattening recurs across different terms, the repair is structural rather than per-term. Stop expressing every consideration as one weighted sum. Split the decision into a **rank** and a **weight**. The rank decides which class of action is admissible at all right now. The weight orders the candidates within the admitted class. A term that should block then cannot be outvoted by one that should only sort. A single sum makes that failure unavoidable and invisible at once. An exclusion is the local fix; the split into rank and weight is the shape that stops needing them.

## Know what an automated player cannot measure

An automated player converges. That makes it a good instrument for *tempo*: how long the arc runs, when beats are reached, what the rate curve looks like. It is a poor instrument for the *space of choices*, because it plays one trajectory and never sees the alternatives. Personas built to differ sharply routinely converge on the same board, the same build, the same route. That looks like "the choice doesn't matter", when the instrument cannot see choice.

So pair an automated player's reading with a **policy-free** one whenever the claim is about choice rather than pace. Enumerate the arrangements where the space is small enough. Where it is not, sample, and state that the result is a lower bound. Where neither is possible, compute an **upper bound**: what the best option was worth from the same state. Label it unachievable, because an upper bound ignores a cost the automated player really pays. It is useful in both directions. A small gap says the automated player is near what was there, and the design question is real. A large gap says fix the automated player first. Add a *constructive* lower bound where you can: a naive policy anyone could write down. "Reached 74% of the upper bound" and "lost to a naive policy" are different verdicts. Only the second says replace the automated player.

The remaining option is to point a **second automated player at the first**. Its objective is to beat your policy rather than to play well. It goes where a converging automated player structurally cannot, because it optimizes for exactly what the first one passed by. Read the result by asking whether a player could reach the same exploit. If yes, it is a design finding. If no, it is a finding about the automated player, and it costs you nothing beyond the knowledge. It is listed last, because only it requires building and maintaining another automated player.

## Drive the probe with the policy the spine assumes

A spine predicts the arc for one policy: a build order, a plan, a route and its stops. A probe driven by any other policy measures that policy. Its diff from the prediction then reads as a miss in the economy. Where shipping automation drives the probe, the spine predicts for that policy. Where a game ships none, write the driver from the spine's assumptions.

- **State the assumptions at the driver.** Its header lists what the spine assumes: the purchase order, the reserves kept, the risks taken. A change to them is a change to the spine.
- **Share one source where you can.** A plan that the spine integrates and the driver plays, from one function, cannot drift apart.
- **Split a measured time into the spine's terms before you retune.** Report each stretch in the spine's own terms: travel, waiting, the hit rate. A wait or a purchase the spine never assumed then shows as the driver's, not the economy's.

A driver that plays better than the spine's policy is no improvement here. It can make a purchase cost time that the spine counted as a saving.

## Measure a driver's search parameters; never tune them

A driver that searches has authored parameters that look free: a lookahead depth, the horizon a candidate is scored over, the split of one purse between two uses. A tuned value holds on the board it was tuned on, and fails on the next. So derive each one from the boards, or per decision.

- **A depth is the smallest that no board improves past.** Run the search unbudgeted on every board, at rising depth. A board added later reopens the measurement, not the argument. A scoring horizon whose best value is interior, not a plateau, is measured the same way. Record the values tried beside the one chosen.
- **Split a purse between two uses by price, never by a share.** Price both uses in one currency. Read the price of the second use from a dry run of its own search over the whole purse. Spend past what that search cannot convert must beat its last marginal purchase. A saving that the search holds back is priced at what it buys per unit spent, never kept as a reserve.

## Personas are a coverage axis, not a parameter to tune

Vary the automated player's *objective*, not its policy. Use one shared decision procedure, with several utility functions that express playstyles the design claims to support. Authoring them top-down is the point. They state what the design intends to support, rather than fitting observed players. The check that they are real is that they produce measurably different *outcomes* on the same content. Utility functions that look different are never that check. An objective and the behaviour it produces come apart routinely. That is § Never let the model read the authored parameter, one level up.

**That method needs an automated player with an objective to vary.** It works where candidates are scored against a utility and the best is taken: a search, a scored arbiter, anything with a separable evaluation step. Some automated players *are* a fixed procedure: a state machine, a behaviour tree, an ordered rule set. There, no objective is separate from the policy to swap. The equivalent method is a weight vector over the shared procedure. The coverage intent is the same, and so is the check: different outcomes, not different numbers.

**Author one difference at a time.** A persona is a shared baseline plus a single emphasised objective. That discipline keeps the roster legible enough for a designer to predict what each persona should do. Only that prediction makes a surprising result readable. It also avoids a failure with a specific shape. A persona defined as *all* of the others at once does not add a cell. It collapses onto whichever narrow persona it most resembles. It typically underperforms that one on its own metric, because an objective that rewards everything gives the policy nothing to trade against.

A conclusion drawn from one playstyle is a claim about that playstyle. So sweep the set before you draw one. Count distinct trajectories rather than personas. Two personas whose headless runs are identical are one cell, and a matrix of them reports confidence it does not have. Those authored parameters stay fixed *within* a comparison (consumer-guide-balance.md § The probe).

**A persona reading is a claim about a content set, not about the design.** Personas separate only on content that varies along the axis they differ on. On a single fixture the ordering routinely inverts: the fixture that is worst for one persona is best for another. So a one-fixture persona result measures the fixture. The sweep must run across the content set, or not at all. That is the carrier rule of consumer-guide-balance.md § Making a pass cheap, one level sharper. For personas, the carrier count is a property of the content set rather than of the roster.

The standing limit is worth stating plainly, because the vocabulary invites the overreach. Personas cover the playstyles a design *claims to support*. They are not a model of who plays it. Nothing here establishes that one corresponds to a real player segment. A persona result taken as a statement about your players is a claim the instrument cannot support.

## Verify the instrument, not only the design

Three checks about the probe rather than the design. Each one saves more than it costs the first time a sweep reports nonsense:

**One brain.** Live play and the probe run the same policy. A probe-only policy validates a game nobody ships. A parallel implementation always drifts, and then the design is validated one way and measured another. On the engine, this is a consumer policy written as a pure function over game state behind `AutomationTiers`. The probe force-unlocks it rather than modelling it.

**Restore parity.** Some paths stand a state up directly: a banked save, a snapshot, a fixture. Each one bypasses the construction path the game normally uses. So it must reproduce *every* side effect of that path. These include derived indexes, occupancy the rest of the game reads, and fields resolved during construction. A miss makes the probe measure a different game than it plays. The miss is silent, because the restored state still looks right in every report. The `pushOverrides` + `importSave` ceremony in consumer-guide-balance.md § Engine as oracle is one instance. The general proof is cheap: read the derived state back, and check that it agrees with whatever computed it.

**Pipeline liveness.** A probe that verifies the *measurement path* is a different kind from one that tunes a balance constant. Examples are a headless run's capture reaching the aggregate, and a counter wired at one end arriving at the other. When such a probe fails, the instrumentation is broken, not the balance. When a sweep starts reporting nonsense, the first question is whether the measurement path is intact. Usually no probe answers it.
