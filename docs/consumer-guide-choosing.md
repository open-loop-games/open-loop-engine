# Choosing between engine primitives

Which primitive is mine, when two of them overlap. Companion to [consumer-guide.md](./consumer-guide.md). Read the guide for *how to think* about composing the engine. Come here holding two candidate names, when you need the boundary between them.

The split against [api/INDEX.md](api/INDEX.md) is by kind, not depth. INDEX answers **"which symbol does X?"**: one hop, no tension, and it stops there. This file answers **"these two overlap and picking wrong doesn't error"**. Those are the cases where the routing answer alone is not enough, because both candidates compile and only one is right.

## Common disambiguators

**Purchasable vs achievement.** The player starts it through requirements, and it may spend resources → purchasable. The game observes it, and it is earned once its goal holds → achievement.

**Producer vs purchasable behind a predicate.** Ownership adds to a rate → producer. Ownership sets a boolean or applies an effect → purchasable, with `createBooleanRequirement` or a Gate-backed requirement. A purchasable that a predicate blocks is still not a producer.

**TickDriver vs Cycle vs RunPool.** "How does time advance?" → `TickDriver`. "End this run, reset a reset scope, start the next run" → `Cycle`. "Track many independent concurrent runs" → `RunPool`, whose members are pool runs. The three primitives do not substitute for each other, and a game can use all three. `Cycle` is named for that lifecycle, not for one genre. A prestige layer's reincarnation and a new-game-plus have the same shape, and both are built on it.

**Offline progress.** Four families recur across games:

- *extrapolation*: a closed-form reward for the time away;
- *tick replay*: replay the elapsed time through the game loop;
- *cap-and-trickle*: release banked time at a bounded rate;
- *banking*: offline time becomes seconds the player spends later, to accelerate a play session.

The engine ships **the mechanism, not the choices**:

- `processOfflineTime`: a blocking replay in chunks through the TickDriver, for *tick replay*. Its `maxOfflineSeconds` option caps the replay. The elapsed seconds are yours to compute. A successful `engine.load()` returns the save's `timestamp`, in milliseconds since the epoch. So when `result.success` is true, pass `(Date.now() - result.timestamp!) / 1000`. An *extrapolation* is the consumer's closed form, and needs no replay;
- `TickDriver.speedMultiplier`: the game speed of live play;
- the `onTicksOverflow` and `onDeltaOverflow` option callbacks: where dropped live time can be re-routed instead of discarded;
- the time bank, for the *banking* family.

The consumer composes the choices on top:

- which family to use;
- whether catch-up blocks, or runs gradually across intervals;
- whether dropped live time is re-routed without loss;
- how screens and menus are blocked during catch-up.

Shipping consumers diverge on each of those axes over the same mechanism, by design. Do not look for an engine primitive to unify them. *Banking* is the one family converging across consumers, so it has engine primitives:

- `createTimeBank` is the time bank, with deposit and withdraw. The rule for what to deposit stays yours.
- `createBankedAcceleration` spends it as extra game speed. It can also deposit dropped live time itself (`depositLiveOverflow`).
- `burstDischarge` replays it through `processOfflineTime` in one burst.

All of these are in `api/lifecycle.md`.

**Sequencer vs advisor.** If the system must remember what is scheduled now, it is a sequencer. If it only chooses or recommends from candidates each time it is asked, it is an advisor or a selection policy.

**Three sibling axes for "choose one from a list."** The engine ships three primitives with the same job and different shapes:

- `FillStrategy` (`createConditionalStrategy`, `createPriorityStrategy`, `createRoundRobinStrategy`, `createCompositeStrategy`) is a **stateful chooser**. The sequencer calls `next()` when its queue is empty, and the fill strategy returns the next `SequencerItem<M>` or `null`. Round-robin keeps a persistent cursor.
- `SelectionPolicy` (`selectionCheapest`, `selectionPaybackPeriod`, `selectionHybridPayback`, `selectionComposite`) is a **stateless selector**. The caller pre-filters candidates and asks `pick(candidates) → T | undefined`.
- `Recommender` (via `createRecommendationSystem`) is a **scored candidate**. After each run ends, every registered recommender runs `canApply`, and each applicable one runs `score`. The highest-scoring winner runs `recommend()`.

The naming asymmetry is deliberate: `create*Strategy` is a verb form, and `selection*` is a noun form. Fill strategies keep closure state. Selection policies are stateless objects with a `pick` method. The `selection*` helpers build them, and they are consumed declaratively (`policy: selectionHybridPayback({ ... })`).

Two adjacent primitives are in the wider advisor family, but do not fit the immediate-choice shape above. `createGoalPicker` keeps a **weighted selection of goals from a candidate pool**. It selects on each `pick()` call, which the consumer makes, often from a tick handler. Its selection is persistent only when composed with a Loadout; it is not a one-shot pick. `createRuleAdvisor` reduces **observation history** to a digest, and ranks suggestions shown to the player. Its suggestions derive from what happened, not from a choice among candidates. Both are in `api/advisors.md`; read its Canonical entrypoints block for the role of each.

**Formula operations that answer near-identical questions.** Two groups are close enough to pick wrong without an error. *Which input?* `invert` is the algebraic pre-image, unchecked, because the op table composes with it recursively. `tryInvert` is that same answer as a graded result. It names the cases where the target falls in a gap the curve never evaluates into. `firstPassage` is the smallest input at which the curve *reaches* a target. It needs no inverse, and it is usually what a time axis meant. *Which total?* `evaluateAntiderivative` is the antiderivative alone. `cumulative(a, b)` is the continuous definite integral over a span. `sum(a, n)` is the discrete series of levels.

The test for both groups: ask whether your axis is **levels** or **time**. A cost curve is a discrete series of levels, one per purchase, so it wants `sum`. `calculateCost` and `calculateMaxAffordable` both use it. So a bulk purchase costs exactly what the same purchases cost one at a time. A rate integrated over elapsed seconds is `cumulative`, which is what `firstPassage` inverts. The two totals differ by a boundary term, not a rounding error: 7.3% on a `1.15ⁿ` curve. So the wrong one is wrong at any tolerance. Per-method failure reasons, gap sizes, and monotonicity and precision constraints are in each method's TSDoc, which links its siblings. Read them at the call site.

**Introspection vs balance harness.** "Discover what is live in this engine now" → introspection. "Run a simulation against this engine state" → balance harness. A dev panel usually starts with introspection; a balance experiment starts with the balance harness.

**Unlock taxonomy.** Several primitives change availability. Choose by *who* causes the change and *what* it blocks.

| Shape | Use | Changes |
|---|---|---|
| Player action that pays a cost | `createPurchasableCategory` with `createCostRequirement` | per-instance `active` / `count` |
| A predicate holds, no cost | `createPurchasableCategory` with `createGateRequirement` (`+ setupSweepAutoPurchase`) | per-instance `active` |
| Achievement, earned once its goal holds | `createAchievementCategory` | per-instance `earned` |
| Named region grouping content | `createZoneSystem` | which entries are *addressable* |
| Ordered unlock of automation features | `createAutomationTiers` | which features are exposed |
| Subject rank or relationship status | `createSubjectCategory` ladder field | per-subject rung |

The first three set per-instance values that the rest of the game reads directly (`active.value`, `earned.value`). The last three change *what is shown at all*. They restructure the addressable set, not a single boolean.

## Choosing among purchasable primitives

Consumers use three paths, and each fits a different shape of need. "Purchase-shaped" here covers anything purchased with a cost requirement: buildings, upgrades, unlocks, perks, repeatable purchases.

| Need | Use |
|---|---|
| Building with a continuous rate (clicker buildings, passive producers) | `createProducerCategory` |
| A click that produces through a rate chain | `createProducerCategory` with `trigger: 'manual'`, then `producer.activate?.()` per click |
| Upgrades, unlocks and repeatables with a limit, in batch (perks, sequential upgrade rungs, visibility unlocks) | `createPurchasableCategory` |
| Repeatable purchases customized per instance (a different `effect` / `onPurchase` per instance, wiring after creation) | raw `createScalingPurchasable` |
| A purchase that owns nothing afterwards (a unit sent to a queue, a consumable) | `createPurchasableCategory` with no `limit` and a static cost, whose `onPurchase` does the work |

**Rate-bearing → producer category.** When ownership produces a continuous resource flow, use `createProducerCategory`. It bundles cost, count, rate aggregation and a beat-time read (`purchaseBeatSeconds`) in one def shape. `costRatio` is the cost ratio: each purchase multiplies the next cost by it. A producer category with a purchase:

```ts
const buildings = createProducerCategory<ProducerDef>({
  id: 'buildings',
  registerTick: ctx.onTick,
  mapProducer: (def) => ({
    resource: cookies,
    baseRate: def.baseRate,
    trigger: 'continuous',
    display: def.name,
    purchase: { costResource: cookies, baseCost: def.baseCost, costRatio: def.costRatio },
  }),
});
```

`setupPolicyAutoPurchase` accepts the category for auto-purchase. To purchase the producer whose beat time is shortest, give it `policy: selectionPaybackPeriod((p) => p.purchaseBeatSeconds.value)`. To rank by payback period instead, pass cost over the rate one more unit adds: `(p) => Decimal.div(p.repeatable!.getCost(1), p.computedRate.value).toNumber()`. To block it until an automation tier unlocks, give it `enabled: () => automation.hasReached('auto-purchase')`.

**No rate, batch shape → purchasable category.** When many instances share an effect mapping, `createPurchasableCategory` fits. Examples are repeatables with a limit, sequential upgrade rungs, and unlocks behind a predicate. The mapped `limit` selects the sub-shape: `1` for upgrades and unlocks, a finite limit for repeatable perks, omitted for no limit:

```ts
const perks = createPurchasableCategory<PerkDef>({
  id: 'ngplus-perks',
  mapPurchasable: (def) => ({
    display: { title: def.name, description: def.description },
    requirements: (count) =>
      createCostRequirement({
        resource: dna,
        cost: Formula.exponential(count, def.baseCost, def.costRatio),
        maxBulkCount: Decimal.dInf,
      }),
    limit: def.maxLevel,
    effect: (count) => def.effect(new Decimal(count).toNumber()),
  }),
});
```

**A cost that scales with count takes the factory form of `requirements`.** The callback receives the purchasable's own `count` ref, which `def` alone cannot supply. The ref does not exist until `createPurchasable` runs, and `mapState` runs too late. For a cost in several resources, return an array over the same `count`; `maxRequirementsMet` takes the minimum across them.

The shape to avoid is a cost getter that reads the count back out of the category (`getPurchasable(def.id)?.count.value`). It evaluates correctly one purchase at a time, so nothing looks wrong. But a cost that is not a `Formula` costs a bulk purchase as a linear extrapolation of its current value. So purchase max undercharges any rising cost, and over-reports affordability by the same factor. A static cost has no such gap, because linear is exact when the cost does not move.

**Per-instance closures → raw scaling purchasable.** Sometimes you already iterate per def, and each instance needs its own wiring after creation. Examples are a side-channel modifier closing over the new purchasable's refs, a custom retention list, or an entry in a per-instance lookup. Then call `createScalingPurchasable` directly inside the loop. This is a drop to [Level 3](./consumer-guide.md#level-3-raw-primitives-when-categories-dont-fit). The entry is here because authors who look for "leveled purchasables" otherwise choose the category, and work against its shape:

```ts
for (const def of spellDefs) {
  const purchasable = createScalingPurchasable({
    id: `level-${def.id}`, description: `${def.name} level`,
    resource: knowledge, baseCost: 10, costRatio: 1.15, limit: 50,
    effect: (count: DecimalSource) => Decimal.mul(count, Decimal.mul(def.baseDamage, 0.05)),
    // onPurchase receives the purchase's bulk count, not the new count
    onPurchase: (bulkCount) => schoolSkills.get(def.school)?.addXp(Decimal.mul(bulkCount, 5)),
  });

  // post-creation wiring closing over per-instance refs
  spellPotency.add(createAdditiveModifier({
    addend: () => purchasable.effect.value,
    enabled: () => Decimal.gt(purchasable.count.value, 0),
    description: `${def.name} levels`,
  }));
  spellLevels.set(def.id, purchasable);
}
```

The raw path trades self-registration for direct control. Like any raw-primitive bypass, these purchasables are outside `EngineCategories`, so tooling that walks categories does not see them (see [*Categories self-register*](./consumer-guide.md#level-2-categories-the-default-for-content) in the guide). So track them in consumer code (`Map<id, Purchasable>`) if anything needs batch access.
