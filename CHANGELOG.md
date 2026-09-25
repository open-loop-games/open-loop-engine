# Changelog

All notable changes to `@open-loop/engine`. Entries are generated from conventional commits by git-cliff; breaking changes carry their migration inline.

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
