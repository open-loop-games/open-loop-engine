# Changelog

All notable changes to `@open-loop/engine`. Entries are generated from conventional commits by git-cliff; breaking changes carry their migration inline.

## 0.3.4 (2026-10-07)

### Features

* **systems:** policy auto-buyer can wait for cost (b532d7e)

### Fixes

* **core:** Sequencer.holding is a live read (e36215e)
* **systems:** list-mode ActionCategory marks a skipped slot failed (a85dcf5)
* **systems:** challenge restricts and rewards with the same description no longer collide (5a7f57a)
* **core:** SaveManager slots, activeSlotId and modId are live reads (bacddc6)
* **core:** TickDriver speedMultiplier, running and tickRate are live reads (6f35ea3)
* **core:** modifier chain modifiers and bindings, and registry scopeDepth, are live reads (0b784b9)
* **systems:** RuleAdvisor suggestions is a live read (6636f58)
* **core:** a linked bag's cap clamps gain before cumulative and best count it (07572a7)
* **core:** a resource bag's total and remaining capacity are live reads (1e03eef)

## 0.3.3 (2026-09-27)

### Fixes

* **core:** squares and square roots are exact on integers (b76ac9b)

## 0.3.2 (2026-09-27)

### Fixes

* **systems:** banked acceleration charges excess in real seconds over any baseline (71f53de)

## 0.3.1 (2026-09-27)

### Features

* **core:** RunPool.dispose(); a pool's hook and mirrors stop with its scope (5d798b9)

### Fixes

* **core:** variable-mode simulateTick simulates all of a dt above maxDeltaTime (2acb45c)
* **systems:** a rejected action register no longer replaces or leaves a mapping (81c873b)
* **harness:** a stale modifier-index entry refuses a slot-bound fallback (0cc892e)
* **systems:** content registered after start() stops with engine.dispose() (f4be26e)
* **core:** `persistent(0)` is a `Persistent<number>`, not a `Persistent<0>` (7c9510b)
* **core:** `CostRequirement.requirementMet` is a count, not `DecimalSource | boolean` (b505257)

## 0.3.0 (2026-09-26)

### ⚠ Breaking changes

* **core:** type EffectDefLike.modifiers as grants (72942fe)

  `EffectDefLike.modifiers` narrows from
  `ReadonlyArray<unknown> | (() => ReadonlyArray<unknown>)` to
  `readonly Grant[] | (() => readonly Grant[])`. Reading it off
  `EffectSystemRegistry` defs no longer needs a cast. A hand-built
  `EnumerableEffectSystem` whose defs carry non-Grant `modifiers` stops
  compiling; it never worked with the picker or content perturbation.

  Migration:
    // before
    const raw = (def as { modifiers?: Grant[] | (() => Grant[]) }).modifiers;
    // after
    const raw = def.modifiers;

  Why: the unknown typing outlived its reason. Both engine effect systems
  already hold Grant lists, and every reader cast to that.

* **systems:** a temporary-effect instance ends early through expire() (e19128f)

  `TemporaryEffectInstance.dispose()` is renamed
  `expire()`. Behavior is unchanged: it ends that one instance the way
  expiry does, firing `onExpire` and `expired`, unbinding its modifiers and
  writing the save.

  Migration:
    // before
    const inst = effects.apply('burn');
    inst?.dispose();
    // after
    inst?.expire();

  Why: dispose() is the engine-wide name for silent teardown, and the system
  beside it uses it that way. A reader who knew that got the instance wrong.
  DialogSession keeps its dispose(), which also drops saved state, because
  sessions are discarded per conversation and its TSDoc says so.

* **harness:** until-runners dispose each run's engine unless a teardown is passed (704cf05)

  an engine returned by `buildEngine` on an until-cell, a
  `runProbe` config or a `runWaypointProbe` config is now disposed after its
  run (after `onRunComplete` / `inspect`, and after a run that throws) unless
  the config passes a `teardown`.

  Migration:
    // keep each run's engine alive past the sweep
    runMatrixUntil({ ..., buildEngine, teardown: () => {} })
    // an explicit dispose teardown is now redundant and can go
    teardown: (engine) => engine.dispose()

  Why: every documented until-side teardown was that one dispose line, and
  omitting it kept every run's engine and its persistent refs registered
  until the process ended. A sweep that wants the engine afterwards is the
  exception, so it opts out.

* **systems:** drop the 'predict' mode from the gate-handle checks (4c4f3a8)

  `getRequiredGateHandles(gate, use?)` and
  `assertGateHandles(gate, runtime, label, use?)` lose their optional `use`
  parameter. Both now answer what the old default, `'evaluate'`, answered.

  Migration:
    // before
    assertGateHandles(gate, runtime, 'site', 'predict');
    // after: predict directly; timeUntilGateFlip throws naming the missing
    // accessor for a cumulative-gte, as it did before
    assertGateHandles(gate, runtime, 'site');
    timeUntilGateFlip(gate, runtime);

  Why removed: the mode had no caller in the engine or any studio consumer. It
  was a parameter, a doc paragraph and a branch in the handle walker, kept for a
  predictor that might one day assert before predicting. If one does, it can
  check for the accessor at its own site before the engine grows a mode for it.

* **systems:** the dialog runtime throws on a repeated graph or node id (aff438b)

  `createNativeDialogRuntime`, and so `createDialogSession`
  through its default runtime, throws at construction on a graph id repeated
  across `graphs`, and on a node id repeated within one graph. Input that used
  to resolve last-wins now throws.

  Migration: give every graph a unique id across all the categories you
  flatten into one runtime, and every node a unique id within its graph. Where
  the last-wins shadowing was intended, drop the shadowed graph or node from
  the list before passing it.

  Why: a repeated id throws in every registry. A silent last-wins at the
  runtime hid a content collision until a player reached the shadowed line.

### Features

* **harness:** diffAggregates reports the termination-time delta (08d4a92)

### Fixes

* **systems:** RuleAdvisor.dismiss() backfills the freed slot at once (02c6668)
* **core:** resetCursor cancels a held item as cancel() does (a094306)
* **systems:** a load that leaves a CycleLog metric unmoved keeps its growth (17d9b29)
* **core:** RunPool re-seeds handles from a load once hydration runs (a5d924e)
* **core:** a reset run from another reset's hook keeps the outer's load guard (a532b8b)
* **systems:** a reset naming a cycle's module zeroes its run clock (af8172c)
* **core:** name a system's out-of-module fallback context for its kind (cec5123)
* **systems:** the auto-buy reserve clamp prices an unbounded buy (2809d4b)
* **systems:** a grant's inline description no longer freezes the modifier it names (0c2ea95)
* **core:** a rejected SpatialGraph.restore leaves the graph untouched (a2fcba8)
* **core:** TimedProgress.dispose() releases its saved progress (0165988)
* **systems:** a composed reset or cycle warns about its unknown module ids (bfcc08a)
* **core:** runHeadless runs teardown when the run throws (90ee57d)
* **harness:** incremental snapshot re-emits a challenge gate when a category leaf flips (8b0e0d5)
* **core:** log and root with the variable on the right no longer claim an integral (b61e562)
* **core:** a non-linear op over `k − x` integrates with the right sign (36a0721)
* **core:** `k / x` no longer claims integrals it can't build (3fda34d)

### Performance

* **core:** hybrid payback tests the raw gap instead of a floored copy (aefa4a9)
* **engine:** let a released subscription drop out of the dispose list (c0a88a9)
* **systems:** resolve a temporary effect's duration without a throwaway computed (3c69e0f)
* **core:** the bag sums its total on read, not on every write (d1ce1ab)
* **core:** build a timed-progress tracker's tick context once (5963f9b)
* **harness:** export the event-mode checkpoint only for an advance bisection can narrow (fa62a04)
* **systems:** an adopted predicate builds one computed, on first use (b9d0670)
* **core:** buy-max reuses the prices its search paid for (104e86c)
* **core:** buy-max's guard rejects a clear ceiling miss in one comparison (361b9da)
* trim per-tick and per-settle work the simplify pass left behind (1ce791b)

### Refactors

* **systems:** one snapshot-on-throw helper for every DialogSession call (2f7b6e7)
* **systems:** name the dialog runtime's "can this node be entered" test (6d97211)
* **systems:** index dialog graph owners instead of rescanning the category (29d9372)
* **core:** drop the override registry's unreachable `removed` flag (1794f33)
* **core:** one clipped Chebyshev walk under composed sum() and peak() (595b0b1)
* **core:** one parse, check, apply and announce path for load and importSave (40dc613)
* **core:** lift slot protection in one raw-write helper (a985e1b)
* **core:** write a remapped legacy key one way (e55d753)
* **core:** enter the persistence namespace once, in the save manager (a1e1c5e)
* **engine:** list the engine-owned injection keys once (92a9030)
* **systems:** binding slots own their definition's grants (898c344)
* **systems:** effect-system dispose leaves unbinding to the slot release (597513d)
* **harness:** one wrap stack for binding and chain-modifier overlays (5228853)
* **core:** the bag's total reuses sumAmountsAsDecimal (0121582)
* **core:** one resource-to-bag sync path in link (d4e382e)
* **core:** RunPool keeps one entry per handle, not five maps (055fb47)
* **harness:** drop the incremental snapshot's always-dirty rule for empty deps (a8edc48)
* **harness:** key the incremental snapshot's entities by record, not by string (3a8a27b)
* **harness:** memoizeAccessor builds each cached read from one helper (42ebd08)
* **harness:** one affordability prediction for the purchasable and producer leaves (384a6b1)
* **harness:** cut NOOP_TIMER_PROVIDER's comment to one line (658c268)
* **harness:** runWaypointProbe runs each waypoint through runMatrixUntil (1c6fc0a)
* **core:** delete the dead collectConditionDeps (d91fc62)
* **core:** one gap-over-rate tail for the flip distances (dfded92)
* **systems:** one leaf walker over the Gate AST (73c0416)
* **systems:** pass the accessor override to the resolver as is (8e0466f)
* **core:** one helper ANDs a gate onto a modifier's own enabled (1f9299c)
* **systems:** category and effect grants adopt `when` through one path (9849dc2)
* **core:** applyEffect dispatches a leaf directly (64fd4df)
* **core:** hot profiler sites time through profileStart/profileEnd (47512e0)
* **systems:** the subject normalizer writes its clamp directly (06917c2)
* **core:** write a ref's default back through resetPersistent everywhere (e9017ce)
* **core:** bind a resolver to its build-time namespace in one helper (8dd8494)
* **core:** register a context under the key its lookups build (0c5aa6e)
* **core:** split buildResource once on wrapped ref vs persistent (c75953a)
* **systems:** share the level-triggered latch between achievements and tiers (8ecddb6)
* **core:** one toFormula for the systems that take Formula factories (a3c0067)
* **systems:** scaling purchasables read their saved level directly (c2a1462)
* **core:** an integral stack reaching a rule-less node throws (4ee5d5d)
* **core:** one linear-integral builder for add and both sub orientations (ec595e9)
* **systems:** delete the resettable.ts shim, import Resettable from core (309cf2e)
* **systems:** state the registry-reach rule once, on ContentRegistryView (31ccbfd)
* **systems:** share cachedCategoryList between auto-purchase and setupCategoryTick (631d22d)
* fold the simplify pass's remaining near-duplicates (c0fcdf5)

## 0.2.2 (2026-09-25)

### Features

* **systems:** a dialog line whose choices gate off can advance (b0487c7)
* **harness:** until-sweeps take a per-run teardown (6e3eff5)

### Fixes

* **systems:** a dialog start refused by its entry gate emits nothing (a67998f)
* **systems:** a category def whose build throws takes its refs with it (eb271fa)
* **systems:** a registry patch cannot rename its entry (61484eb)
* **harness:** the picker offers an effect's modifier only as content (5561b52)

## 0.2.1 (2026-09-25)

### Fixes

* **systems:** inventories sharing item ids coexist in one engine (47fa91c)
* a start() whose module install throws disposes the engine (75878ae)

## 0.2.0 (2026-09-25)

### ⚠ Breaking changes

* system events are named in the past tense (d1f6fe8)

  Engine event names are past-tense phrases. Option
  callbacks (`onPurchase`, `onLevelUp`, ...), `before*`/`after*` hooks and
  the `instance:*`, `pool:reset` and `scope:*` families are unchanged; the
  `save:*` renames are their own entry below. No aliases: an old name fails
  to typecheck at `.on()`.

  Migration (old→new (System)):
    unlock→unlocked (Zone, AutomationTiers)
    select→selected (Zone)
    recommend→recommended, apply→applied, dismiss→dismissed (Recommendation)
    purchase→purchased (Purchasable)
    finalize→finalized (CycleLog)
    levelUp→leveledUp (Skill)
    newBest→bestImproved (BestOf)
    suggestions→suggestionsUpdated (RuleAdvisor)
    complete→completed, cancel→cancelled, itemStateChange→itemStateChanged (ActionCategory)
    change→changed (ModifierChain; Subject scalar/vector/flag/enum fields)
    advance→advanced (Subject tier fields)
    enqueue→enqueued, start→started, complete→completed, cancel→cancelled,
      repeat→repeated, skip→skipped, hold→held (Sequencer)

* **systems:** mapSkill returns exactly one skill mode (2d570bd)

  `mapSkill` must return exactly one of
  `retentionFormula` / `levelToMultiplier`; a return with neither or both
  no longer compiles.

* **systems:** a scaling purchasable takes each cost and effect shape under its own key (ac1528a)

  A Formula-factory effect moves from `effect` to
  `effectFormula`; a plain cost function moves from `costFormula` to
  `cost`; `costFormula` takes only a Formula factory, and at most one
  cost shape is allowed.

  Migration:
    // before
    costFormula: (level) => Decimal.pow(10, Decimal.pow(level, 2)),
    effect: (level) => Formula.variable(level).mul(0.5).add(1),
    // after
    cost: (level) => Decimal.pow(10, Decimal.pow(level, 2)),
    effectFormula: (level) => Formula.variable(level).mul(0.5).add(1),

* **systems:** a manual producer yields rate × count and stays out of the policy buyer (00935ab)

  A manual producer with a purchase config or
  `extraCount` now yields `computedRate × count` per `activate()`, and
  `setupPolicyAutoPurchase` no longer buys it.

* **systems:** built-in recommendation defs score improvement in the metric's mode; createGoalDef folds into createBestReplayDef (3c3ca36)

  Built-in recommendation defs score log10 improvement of
  the metric's best over the last cycle, in the metric's BestOf mode;
  custom defs sharing a system should score on that scale. `createGoalDef`
  is removed — use `createBestReplayDef(metric, { id, threshold })`.
  `prefer` has no replacement.

  Migration:
    // before
    createGoalDef({ id: 'goal:peak-data', metric: 'data', prefer: 'maximize', threshold: 10 })
    // after
    createBestReplayDef('data', { id: 'goal:peak-data', threshold: 10 })

  A replay def needs a strategy snapshot on the best entry, where the goal
  def fell back to the current snapshot, so the BestOf needs a
  `captureStrategy`.

* **systems:** a temporary effect rebuilds from its save on its own (6f2f63f)

  TemporaryEffectSystem.restore() is removed — instances
  rebuild after every load, import and reset. Delete `onLoad(() => effects.restore())`.
  TemporaryEffectDef.onRestore is renamed onRehydrate.

* **systems:** restore writes back a snapshot (e1c24e5)

  ChallengeCategory.restore() and Slot.resync() are removed;
  both run after every load and reset. Slot.restore(ids) now re-runs onSelect/
  onDeselect itself. ResourceBag/Inventory deserialize(data) → restore(data).

* **systems:** resetting a category resets only what its entries own (dda7672)

  A category, purchasable or skill in `thingsToReset` resets
  only its own persistent state; list a cost or produced resource, or a ref
  passed as an option, explicitly if the reset should clear it.

* **core:** a resource id is unique per engine (ef6631b)

  A resource id is unique per engine; `createResource`
  throws on a repeat. Give per-layer resources distinct ids. Renaming a
  persistent id changes its save key, so migrate the save. A wrapped ref
  created without an `id` takes its displayName, so two id-less wrapped
  refs sharing a displayName throw too; pass one an `id`.

* **harness:** resource trackers key metrics by id (037cd23)

  Tracker metric keys use `resource.id`:
  `resource-peak:gold.peak`, `series:gold.t3`. Label via
  `ResourceRegistry.findById(id).displayName`.

* **systems:** a category's registry is a read-and-patch view (e146874)

  `<category>.registry` is a `ContentRegistryView` (no
  `register`); add defs with `category.register`. Retype variables holding
  it.

* engine-owned injection keys can't be re-provided (788918e)

  Engine-owned keys can't be re-provided. Delete
  `ctx.provide(CategoriesKey, …)`; categories self-register.
  `EngineCategories.resources` is removed; read `ResourceRegistryKey`.

* trim internal factories and flip-distance helpers from the barrels (0616b46)

  `createChainRegistry`, `createEffectSystemRegistry`,
  `createResourceRegistry`, `timeUntilConditionFlip`,
  `collectConditionDeps`, `combineFlipDistances`, `ChildFlipResult` and
  `IncrementalSnapshotEntityRef` are no longer exported. Use
  `ChainRegistryKey` / `EffectSystemRegistryKey` / `ResourceRegistryKey`
  via `tryInject`, and `timeUntilGateFlip`.

* **core:** tunable checks the key and the default's return type (b0f20a4)

  Drop explicit `tunable<…>` type arguments; a typed
  override registry now checks the key and the default's return type.

* **systems:** a repeated id throws in every registry (a2032e9)

  Recommendation defs, automation tier ids and dialog
  graph ids throw on a repeat. Replace a recommendation def with
  `unregister(id)` then `register(def)`; give each automation tier and
  each dialog graph (across every def of a category) its own id.

* **systems:** every systems predicate field takes Predicate, asserted at register (d084ad9)

  Systems predicate fields take `Predicate` (boolean | Ref | () => boolean | Gate):
  automation tier `requirement`, challenge `visible` / `canStart` / `goal`, cycle `endCondition`,
  reset `canReset`, time-bank `gate`, purchasable/producer `visibility`, achievement `visible` /
  `hidden` (and `requirement`, which already took a Gate), subject tier `gates`, `Grant.when`.
  A Gate's handles are checked when the definition registers, not at first evaluation.

  Migration: writers change nothing. Code that reads a field back off a def and calls it
  (`def.goal()`, `options.endCondition()`) reads the instance's reactive field instead, or
  calls `evaluatePredicate(def.goal, runtime)`. A Gate needing the accessor now throws at
  register when none is wired: pass `accessor` to the category or to `createEngine`.

* **systems:** purchasables and producers take visible, like achievements and challenges (4ebe9d8)

  The purchasable visibility field is named `visible`, matching achievements
  and challenges: the `PurchasableOptions` / `ScalingPurchasableOptions` option, the producer
  mapping's `purchase.visible`, and the `Purchasable.visible` instance property, now a
  `ComputedRef<boolean>`.

  Migration: `visibility:` → `visible:` in purchasable options and producer mappings;
  `.visibility` → `.visible` on purchasable instances (`unref(p.visibility)` → `p.visible.value`).

* **systems:** effect systems take Grant; ModifierBinding removed (b380922)

  `ModifierBinding` is removed. Effect-system `modifiers` take `Grant[]`
  (or a factory returning one), the vocabulary of category grants/restricts/rewards;
  `replacementBinding` returns `Grant[]`. `PersistentEffectDef.active` takes `Predicate`.
  A chain array in a grant binds on each chain, and each chain is its own binding index
  for the harness picker and perturbation.

  Migration: `{ chain, modifier }` literals are already Grants — no edit. Replace a
  `ModifierBinding` annotation with `Grant`. Shorthands now work on effects and build a
  fresh modifier per stack: `modifiers: [{ chain, mult: 1.5, description: 'Haste' }]`.

* **core:** save events are named in the past tense (4e64a67)

  Four save events are renamed.

  Migration:
    save:validation-error → save:validation-failed
    save:reconcile-error  → save:reconcile-failed
    save:migration-step   → save:migration-applied
    save:future-version   → save:future-version-refused
  Payloads are unchanged, and the `'future-version'` load-failure reason keeps its name.

### Features

* **systems:** Predicate type and createPredicateResolver (aa84eb5)

### Fixes

* **systems:** temporary-effect dispose drops the lowered grant lists (fdaf6d9)

## 0.1.4 (2026-09-25)

### Features

* **systems:** costScaling accepts a ref or getter (a75f3b6)
* **systems:** auto-purchase keys by id, sweeps a category lazily (939aa25)
* predict cumulative-gte from the gross inflow rate (c704754)

### Fixes

* **core:** hybrid payback ranks cold-start candidates by payback (4b2fafa)
* every stateful system resets through [Resettable] (5df9278)
* **harness:** a sensitivity cell disposes its last engine (f154183)
* **core:** grid coordinates are integers (4bedf4f)
* **systems:** cumulative-gte evaluates without an accessor (f6fdbda)
* **core:** a min over flip distances skips children that never flip (5d07aac)

## 0.1.3 (2026-09-25)

### Features

* **systems:** createScalingPurchasable takes an effectDisplay override (cc12fed)
* **core:** SpatialGrid.markMaskChanged, the write path for hand-written bitmaps (7f682ed)
* **systems:** DialogSession reads visit counts (27fd649)

### Fixes

* **systems:** an opaque costFormula that can't take the level ref no longer throws at construction (5e93352)
* **systems:** PurchasableCategory.totalEffect leaves out upgrades nobody has bought (2dddc01)
* **systems:** a throw during Skill.addXp no longer leaves levelUp armed for load writes (b86a61d)
* **systems:** a content registry's reads track register and patch (50f0a5f)
* **systems:** pushPatches scopes revert correctly in any order (0b2d535)
* **systems:** a builder throw mid-batch leaves a category's registry and entries in step (397222d)
* **core:** SpatialGrid.restore stores raw cells, not reactive proxies (5d19396)
* **core:** SpatialGrid.restore emits bulkChanged and maskChanged (7160512)
* **core:** distanceField throws on a negative step cost (a93f7e5)
* **core:** composed influence sum() counts only in-bounds cells (be556fb)
* **core:** influence update() skips sources that have left the grid's cells (e6d85b0)
* **core:** SpatialGraph auto ids stay unique across the tree after a restore (ff0e281)
* **core:** registry all() and list() return a snapshot, not the live array (24e7c33)
* **core:** override registry re-resolves tunables on override and ignores unset scope entries (838d0f6)
* **core:** override registries accept an interface type map (d16992f)
* **primitives:** Decimal constructs and stays typed under nodenext (688bedb)
* **systems:** a dialog node with nowhere to go presents as finished (94604f3)
* **systems:** disposing a dialog session releases its saved state (9b76fc6)
* **systems:** subject signals compare against the clamped seed (6d1b028)
* **systems:** subject values loaded from a save stay inside the schema (a78638c)
* **systems:** a goal def skips a stale BestOf entry (c292e90)
* **systems:** RuleAdvisor fills dismissed slots and infers acceptance from the analyzers (a48e55a)

### Performance

* hot profiler wrap sites allocate nothing while profiling is off (f9dc5ed)

### Refactors

* **systems:** CycleOptions.registerTick uses the shared RegisterTick type (9010720)

## 0.1.2 (2026-09-25)

### Fixes

* **systems:** a cycle's run clock survives a save (df020cc)
* **core:** a Decimal held by a number-default ref loads as a Decimal (936bfd9)
* **systems:** a temporary effect's duration never trails its time remaining (aaea9f1)
* **systems:** a BestOf entry saved before the cycleNumber rename reads its loopNumber (8cd3928)
* **core:** the spatial grid snapshot carries a version (f97a192)
* **core:** a save a newer engine wrote is refused, not misread (093b847)
* **core:** RunPool stops saving an instance-id list nothing reads (f1bfb31)

## 0.1.1 (2026-09-25)

### Features

* **harness:** export createEngineFromSave (a0ffcd8)

### Fixes

* **harness:** bisectTuner checks its bracket before bisecting it (bda90fb)
* **harness:** computeMetricStats refuses an empty sample, and median stops claiming to be p50 (219d372)
* **systems:** capture the Gate runtime once per achievement and subject category (a461b7b)
* **harness:** the challenge walker reads Gates through timeUntilGateFlip (bf83070)
* **harness:** runUntil simulates the time it reports (edf21e9)
* **harness:** sweeps seed before they build, and release the engines they build (3603757)
* **harness:** perturb modifiers in place and effect content through its binding (4c07ff3)
* **harness:** a waypoint that lands on a tick snapshots on that tick (f0b0a65)
* **harness:** until-sweep results keep their until-specific data (fa06efb)
* **harness:** a maxed producer stops emitting producer-becomes-affordable (408396d)
* **harness:** affordability transitions report the cost resource's amount as currentValue (55008f5)
* **harness:** the incremental snapshot re-emits entities whose gating state moved (bcee077)
* **harness:** the incremental snapshot refreshes empty-deps emissions on every rebuild (724890e)

## 0.1.0 (2026-09-25)

The first versioned release. The README describes what the engine is and how to start; the installed `docs/api/` lists the whole public surface. Entries from here on are generated from commits.
