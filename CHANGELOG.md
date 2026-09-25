# Changelog

All notable changes to `@open-loop/engine`. Entries are generated from conventional commits by git-cliff; breaking changes carry their migration inline.

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
