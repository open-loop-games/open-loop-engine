# Choosing between engine surfaces

Which primitive is mine, when two of them overlap. Companion to [consumer-guide.md](./consumer-guide.md) — read the guide for *how to think* about composing the engine; come here holding two candidate names and needing the boundary between them.

The split against [api/INDEX.md](api/INDEX.md) is by kind, not depth. INDEX answers **"which symbol does X?"** — one hop, no tension, and it stops there. This file answers **"these two overlap and picking wrong doesn't error"** — the cases where the routing answer alone isn't enough, because both candidates compile and only one is right.

## Common disambiguators

**Purchasable vs achievement.** Player-initiated through requirements (and may spend resources) → purchasable. Observed by the game, auto-earns when true → achievement.

**Producer vs predicate-gated purchasable.** Ownership contributes to a rate → producer. Ownership flips a boolean / grants an effect → purchasable (with `createBooleanRequirement` or a Gate-backed requirement). A predicate-gated purchasable doesn't become a producer just because it's gated.

**TickDriver vs Cycle vs RunPool.** "How does time advance?" → `TickDriver`. "End this gameplay run, reset a scope, replay" → `Cycle`. "Track many independent concurrent run instances" → `RunPool`. The three primitives don't substitute for each other — a game can use all three. `Cycle` is named for that lifecycle rather than for the loop-incremental genre it came from: a prestige layer's reincarnation and a new-game-plus are the same shape and ship on it too.

**Offline progress strategy.** Four families recur across the corpus — *extrapolation* (closed-form reward for time away), *tick-sim* (replay elapsed time through the loop), *cap-and-trickle* (release banked time at a bounded rate), and *banking* (idle becomes spendable fast-forward inside a later active session). The engine ships **mechanism, not policy**: `processOfflineTime` (blocking chunked replay through the TickDriver — covers extrapolation and tick-sim), `TickDriver.speedMultiplier` (the live tick scaler), the `onTicksOverflow` / `onDeltaOverflow` hooks (the seam for re-routing dropped live-path time instead of discarding it), and the time bank for the *banking* family. Which family you pick, whether catch-up runs blocking or drains gradually over frames, whether live-path overflow is re-routed losslessly, and how screen/menu gating works are all **consumer-side policy** composed on top. Shipping consumers diverge on every one of those axes off the same mechanism — by design; don't reach for an engine primitive to unify them. *Banking* is the one family converging across consumers, so it has a surface: `createTimeBank` is the reservoir (deposit and withdraw; earn policy stays yours), `createBankedAcceleration` spends it as a live speed boost and can bank dropped live time itself (`depositLiveOverflow`), and `burstDischarge` dumps it through `processOfflineTime` in one fast-forward. All of these are in `api/lifecycle.md`.

**Sequencer vs advisor.** If the system has to remember what is currently scheduled, it's a sequencer. If it only needs to choose or recommend from candidates each time it's asked, it's an advisor / selection policy.

**Three sibling axes for "choose one from a list."** The engine ships three primitives with the same conceptual job but different shapes. `FillStrategy` (`createConditionalStrategy`, `createPriorityStrategy`, `createRoundRobinStrategy`, `createCompositeStrategy`) is a **stateful generator**: the sequencer calls `next()` when its queue runs dry, and the strategy returns the next `SequencerItem<M>` or `null`. Round-robin binds a persistent cursor. `SelectionPolicy` (`selectionCheapest`, `selectionPaybackPeriod`, `selectionHybridPayback`, `selectionComposite`) is a **stateless selector**: the caller pre-filters candidates and asks `pick(candidates) → T | undefined`. `Recommender` (via `createRecommendationSystem`) is a **scored candidate**: every registered def runs `canApply` / `score` between cycles, and the highest-scoring winner runs `recommend()`. The naming asymmetry (`create*Strategy` verb form vs `selection*` noun form) is deliberate: fill strategies bind closure state, selection policies are stateless dispatchers consumed declaratively (`policy: selectionHybridPayback({ ... })`).

Two adjacent primitives sit in the wider advisor family but don't fit the immediate-choice shape above. `createGoalPicker` maintains a **weighted active-goal pool** (between-tick goal arbitration, persistent only when composed with a Loadout; not a one-shot pick). `createRuleAdvisor` aggregates **observation history** into ranked suggestions surfaced to the player (derived from what happened, not selected from candidates). Both live in `api/advisors.md`; read its Canonical entrypoints block for the one-liner role of each.

**Formula operations that answer near-identical questions.** Two clusters sit close enough to pick wrong without getting an error for it. *Which input?* — `invert` (algebraic pre-image, unchecked, because the op table composes with it recursively), `tryInvert` (that same answer graded, naming the cases where the target falls in a gap the curve never evaluates into), `firstPassage` (the smallest input at which the curve *reaches* a target — no inverse needed, and usually what a time axis meant). *Which total?* — `evaluateIntegral` (bare antiderivative), `cumulative(a, b)` (continuous area across a span), `sum(a, n)` (discrete series).

The compressor for both clusters: ask whether your axis is **levels** or **time**. A cost curve is indexed by level, so it wants `sum` — and `calculateCost` / `calculateMaxAffordable` both use it, so a bulk buy prices at exactly what those purchases cost bought singly. A rate integrated over elapsed seconds is `cumulative`, which is what `firstPassage` inverts. The two totals differ by a boundary term, not a rounding error — worth 7.3% on a `1.15ⁿ` curve — so the wrong one is wrong at any tolerance. Per-method failure reasons, gap sizes, and monotonicity and precision constraints live in each method's tsdoc, which cross-links its siblings; read them at the callsite.

**Introspection vs harness.** "Discover what's live in this engine right now" → introspection. "Run a simulation against this engine state" → harness. A dev panel usually starts with introspection; a balance experiment starts with harness.

**Unlock taxonomy.** Several primitives flip availability; pick by *who* trips the flip and *what* it gates.

| Shape | Use | Flips |
|---|---|---|
| Player action that charges a cost | `createPurchasableCategory` with `createCostRequirement` | per-instance `active` / `amount` |
| Predicate flips, no cost | `createPurchasableCategory` with `createGateRequirement` (`+ setupSweepAutoPurchase`) | per-instance `active` |
| Observed milestone, auto-earns when true | `createAchievementCategory` | per-instance `earned` |
| Named region grouping content | `createZoneSystem` | which entries are *addressable* |
| Ordered ladder of feature availability | `createAutomationTiers` | which features are exposed |
| Entity rank / relationship state | `createSubjectCategory` tier field | per-subject tier value |

The first three flip per-instance bits the rest of the game reads directly (`active.value`, `earned.value`). The last three flip *what's even surfaced* — they restructure the addressable set, not a single boolean.
## Choosing among purchasable primitives

Three paths land in the consumer corpus, each fitting a different shape of need. "Purchase-shaped" here covers anything spent on with a cost requirement — buildings, upgrades, gates, perks, leveled instances:

| Need | Use |
|---|---|
| Building with continuous rate (clicker buildings, ambient auto-producers) | `createProducerCategory` |
| Upgrades / gates / capped repeatables in batch (perks, milestones, sequential tiers, visibility unlocks) | `createPurchasableCategory` |
| Per-instance customized leveled purchases (heterogeneous `effect` / `onPurchase` per instance, post-creation per-instance wiring) | raw `createScalingPurchasable` |

**Rate-bearing → producer category.** When ownership produces a continuous resource flow, `createProducerCategory` bundles cost, count, rate aggregation, autobuy, and payback metric in one definition shape:

```ts
const buildings = createProducerCategory<ProducerDef>({
  id: 'buildings',
  registerTick: ctx.onTick,
  mapProducer: (def) => ({
    resource: cookies,
    baseRate: def.baseRate,
    trigger: 'continuous',
    display: def.name,
    purchase: { costResource: cookies, baseCost: def.baseCost, costScaling: def.costScaling },
  }),
});
```

**No rate, batch shape → purchasable category.** When many instances share an effect mapping — capped repeatables, sequential upgrade tiers, predicate-gated unlocks — `createPurchasableCategory` fits. The mapped `limit` selects the sub-shape: `1` for upgrades and gates, a finite cap for repeatable perks, omitted for unbounded:

```ts
const perks = createPurchasableCategory<PerkDef>({
  id: 'ngplus-perks',
  mapPurchasable: (def) => ({
    display: { title: def.name, description: def.description },
    requirements: (level) =>
      createCostRequirement({
        resource: dna,
        cost: Formula.exponential(level, def.baseCost, def.costRatio),
        maxBulkCount: Decimal.dInf,
      }),
    limit: def.maxLevel,
    effect: (amount) => def.effect(new Decimal(amount).toNumber()),
  }),
});
```

**Leveled costs take the factory form of `requirements`.** The callback receives the purchasable's own `amount` ref, which `def` alone can't supply — the ref doesn't exist until `createPurchasable` runs, and `mapState` is too late. Return an array over the same `level` for multi-resource ladders; `maxRequirementsMet` min-folds across them.

The shape to avoid is a cost getter that reads the level back out of the category (`getPurchasable(def.id)?.amount.value`). It evaluates correctly one purchase at a time, so nothing looks wrong — but a non-Formula cost prices bulk as a linear extrapolation of the current rung, so buy-max undercharges any ladder and over-reports affordability by the same factor. A static cost has no such gap: linear is exact when the price doesn't move.

**Per-instance closures → raw scaling purchasable.** When you're already iterating per definition and each instance needs its own post-creation wiring — a side-channel modifier closing over the produced purchasable's refs, custom retention listing, mapping into a per-instance lookup — drop to `createScalingPurchasable` directly inside the loop. This is a drop to [Level 3](./consumer-guide.md#level-3-raw-primitives-when-categories-dont-fit); the entry is here because future authors looking for "leveled purchasables" otherwise reach for the category and fight its shape:

```ts
for (const def of spellDefs) {
  const purchasable = createScalingPurchasable({
    id: `level-${def.id}`, description: `${def.name} level`,
    resource: knowledge, baseCost: 10, costScaling: 1.15, limit: 50,
    effect: (amount: DecimalSource) => Decimal.mul(amount, Decimal.mul(def.baseDamage, 0.05)),
    onPurchase: (amount) => schoolSkills.get(def.school)?.addXp(Decimal.mul(amount, 5)),
  });

  // post-creation wiring closing over per-instance refs
  spellPotency.add(createAdditiveModifier({
    addend: () => purchasable.effect.value,
    enabled: () => Decimal.gt(purchasable.amount.value, 0),
    description: `${def.name} levels`,
  }));
  spellLevels.set(def.id, purchasable);
}
```

Path C trades self-registration for direct control — like any raw-primitive bypass, the purchasables fall outside the category registry (see [*Categories self-register*](./consumer-guide.md#level-2-category-systems-the-default-for-content) in the guide), so track them at the consumer (`Map<id, Purchasable>`) if anything needs batch access.
