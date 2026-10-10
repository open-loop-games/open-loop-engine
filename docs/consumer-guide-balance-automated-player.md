# Balance guide — when an agent is the instrument

Companion to [consumer-guide-balance.md](./consumer-guide-balance.md). That file holds the balance process — spine, probe, the loop between them. This one holds the layer that applies when a **policy plays the game for you**: an automation tier driving a headless arc, an opponent bot, a persona standing in for a player.

Read it when your probe's numbers come out of a run somebody's code played. If your economy is projected in closed form and the probe only verifies it, you can skip this until you write your first bot.

A probe that plays the game needs something to play it, and every number it prints is read *through* that agent — so a defect in the agent is indistinguishable from a defect in the design. It never announces itself as "the bot is bad": it arrives as a balance finding with plausible magnitudes, survives sweeps, and gets a design decision built on top of it.

The usual guards do not catch this. Unit specs on a policy assert its *plumbing* — a score breakdown agreeing with its arg-max, a tier gate withholding, a run reproducing — and every one of those stays true of an agent deciding exactly wrongly. Aggregates cannot catch it either: over a long arc with several interacting terms, "a number moved" cannot answer "was that right", so tuning proceeds by comparing runs and converges on nothing.

## Calibrate on situations, not on scores

Write a small suite of **named situations with answers knowable by inspection**, and assert on the *outcome* rather than on the agent's internal choice: the pickup got banked, the threat got disengaged from, the queue drained. Outcomes, because asserting on a chosen heading or a selected candidate pins the implementation, where asserting on the result pins the behaviour and survives a rewrite. Keep it to seconds, so it is something you run while iterating rather than before a release.

This is the one balance-adjacent suite that legitimately asserts, because it carries no magnitudes — only "this situation still resolves the right way" (consumer-guide-balance.md § Why this isn't a test suite). Run it before believing any reading taken through the agent, and re-run it first when a reading surprises you.

## Never let the model read the dial

An agent's authored parameters state an *intent*; what the policy achieves is a different number, and the two diverge without warning — a dial can bias a term that drops out of the decision, or ask for something the rest of the policy prevents. So **every quantity a policy optimizes needs a realized counterpart the probe joins it against**, sampled inside the run rather than reconstructed afterwards, and it is the realized number any downstream model consumes. Where a quantity has no realized counterpart the search is blind in that dimension by construction, and tuning it is evidence of nothing.

How far a dial can drift from what it achieves scales with the **machinery between them**. A policy that executes its objective directly drifts little, and the join is a formality. A policy whose behaviour was *fitted* to the objective — tuned, searched, evolved — can arrive at a decision rule that contradicts the objective it was fitted against and still scores well on it, because the fit optimizes the outcome and never constrains the route. Where anything was fitted, the realized counterpart is not diligence; it is the only thing connecting the two.

Three corollaries, each of which has cost a pass:

- **Book it at the moment its fate is settled**, in the sim, rather than inferring it from aggregates. An inferred quantity double-counts, and a residual that survives every mechanism that should have explained it is usually the harness's own arithmetic.
- **Read the compound, never one half.** Where a realized outcome is a product of two measured factors, each can diverge from its dial in the opposite direction and nearly cancel — so either half alone reports a divergence the other half already paid for.
- **Re-derive after anything that moves the policy.** A stale realized value is worse than a missing one: it still reads as measured. Where it feeds a schedule that changes run length, re-derivation is a loop rather than a measurement — see consumer-guide-balance.md § When prediction and truth disagree.

## Prove the lever exists before you tune it

Where an agent picks by scoring a candidate set and taking the best, a term steers only to the extent it *differs* across that set. A term reading the same on every candidate subtracts a constant and drops out of the decision however large it is — so its weight sweeps across orders of magnitude with nothing moving, and the sweep reports "this knob does nothing" when what it measured was a knob with no spread.

The failure has two ends that look opposite and are one rule. A term gated on a condition already resolved scores zero on every candidate the decision is between. And a term that is widened, capped, or swamped by a larger one flattens against the set — so pricing *more* of a thing can make the price inert, and raising the weight cannot help, because it multiplies a spread of zero.

Both are directly measurable where no comparison of outcomes recovers them: print each term's spread across the candidate set at decision time, plus the share of decisions where a branch fires on *every* candidate. When a widened detector goes flat, the repair is usually an **exclusion** rather than a weight — find the sub-region common to every candidate and remove it. This holds for any scored selection, not just steering: a draft choosing between offers, target selection, an opponent picking a build.

Where flattening keeps recurring across different terms, the repair is structural rather than per-term: stop expressing every consideration as one weighted sum. Split the decision into a **rank** — which class of action is admissible at all right now — and a **weight** that orders within the admitted class. A term that should gate then cannot be outvoted by one that should merely sort, which is the failure a single sum makes unavoidable and invisible at once. An exclusion is the local fix; this is the shape that stops needing them.

## Know what a policy cannot measure

A policy converges. That makes it a good instrument for *tempo* — how long the arc runs, where beats land, what the income curve looks like — and a poor one for the *space of choices*, because it walks one trajectory and washes the alternatives out. Personas built to differ sharply routinely converge on the same board, the same build, the same route, which reads as "the choice doesn't matter" when what happened is that the instrument cannot see choice.

So pair a policy reading with a **policy-free** one whenever the claim is about choice rather than pace. Enumerate the arrangements where the space is small enough; where it isn't, sample and say the result is a lower bound. Where neither is possible, compute a **ceiling** — what the best option was worth from the same state — and label it unachievable, because a ceiling ignores a cost the agent really pays. It earns its keep in both directions: a small gap says the agent is near what was there and the design question is real, a large one says fix the agent first. Add a *constructive* lower bound where you can — a naive strategy anyone could write down — because "reached 74% of the ceiling" and "lost to a strategy anyone could write down" are different verdicts, and only the second says replace the agent.

The remaining option is to point a **second agent at the first**: one whose objective is to beat your policy rather than to play well. It goes where a converging agent structurally cannot, because what it optimizes for is exactly the thing the first one walked past. Read the result by asking whether a player could reach the same exploit — if yes it is a design finding, if no it is an agent finding and costs you nothing but the knowledge. It is listed last because it is the only one here that means building and maintaining another agent.

## Personas are a coverage axis, not a tuning knob

Vary the agent's *objective*, not its policy: one shared decision procedure, several utility functions expressing playstyles the design claims to support. Authoring them top-down is the point — they state what the design intends to support rather than fitting observed players — and the check that they are real is that they produce measurably different *outcomes* on the same content, never that their utility functions read differently. An objective and the behaviour it produces come apart routinely, which is § Never let the model read the dial one level up.

**That lever needs an agent with an objective to vary.** It works where the agent scores candidates against a utility and takes the best — a search, a scored arbiter, anything with a separable evaluation step. Where the agent *is* a fixed procedure — a state machine, a behaviour tree, an ordered rule set — no objective sits apart from the policy to be swapped, and the equivalent lever is a weight vector over the shared procedure. Same coverage intent, different knob, same check: different outcomes, not different numbers.

**Author one difference at a time.** A persona is a shared baseline plus a single emphasised objective, and the discipline is what keeps the roster legible enough for a designer to predict what each one should do — which is the only thing that makes a surprising result readable. It also avoids a failure with a specific shape: a persona defined as *all* of the others at once does not add a cell. It collapses onto whichever narrow persona it most resembles, and typically underperforms that one on its own metric, because an objective that rewards everything gives the policy nothing to trade against.

A conclusion drawn from one playstyle is a claim about that playstyle, so sweep the set before one lands. Count distinct trajectories rather than personas: two personas whose runs are identical are one cell, and a grid of them reports confidence it has not earned. Those knobs stay fixed *within* a comparison, which is the separate rule at consumer-guide-balance.md § The probe.

**A persona reading is a claim about a content set, not about the design.** Personas only separate on content that varies along the axis they differ on, and on a single fixture the ordering routinely inverts — the map that is worst for one is best for another. So a one-fixture persona result measures the fixture, and the sweep has to run across the content set or not at all. That is consumer-guide-balance.md § Making a pass cheap's carrier rule one level sharper: for personas, the carrier count is a property of the content set rather than of the roster.

The standing limit is worth saying plainly, because the vocabulary invites the overreach: personas cover the playstyles a design *claims to support*. They are not a model of who plays it, nothing here establishes that one corresponds to a real player segment, and a persona result read as a statement about your players is a claim the instrument cannot carry.

## Verify the instrument, not only the design

Three checks about the harness rather than the design, each of which pays for itself the first time a sweep reports nonsense:

**One brain.** Live play and the probe run the same policy. A harness-only strategy validates a game nobody ships, and a parallel implementation always drifts — after which the design is validated one way and measured another. The engine-side shape of this is a policy written as a pure function over game state behind `AutomationTiers`, force-unlocked by the probe rather than modelled by it.

**Restore parity.** Any path that stands a state up directly — a banked save, a snapshot, a scenario fixture — bypasses the construction path the game normally uses, and owes *every* side effect that path has: derived indexes, occupancy the rest of the sim reads, resolved per-tier fields. A miss makes the harness measure a different game than it plays, silently, because the restored state still looks right in every report. The `pushOverrides` + `importSave` ceremony in consumer-guide-balance.md § Engine as oracle is one instance; the general proof is cheap — read the derived state back and check it agrees with whatever computed it.

**Pipeline liveness.** A probe that verifies the *measurement path* — a per-run capture reaching the aggregate, a counter wired at one end arriving at the other — is a different kind from one that tunes a knob, and red means broken instrumentation rather than bad balance. When a sweep starts reporting nonsense the first question is whether the pipes are intact, and usually nothing answers it.
