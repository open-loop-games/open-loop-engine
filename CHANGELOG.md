# Changelog

All notable changes to `@open-loop/engine`. Entries are generated from conventional commits by git-cliff; breaking changes carry their migration inline.

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
