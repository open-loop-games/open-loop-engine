# CLAUDE.md

Open Loop Engine — headless incremental game substrate. Foundational layer in the studio dep graph (consumed via starter); see `/work/studio/CLAUDE.md` § Studio components. Ongoing intake from consumers via `docs/candidate-primitives.md` (see studio CLAUDE.md § Back-flows) — not a one-time extraction. Note: `docs/candidate-primitives.md` and `docs/notes/` are gitignored studio-side resources; they live on disk locally and aren't part of the public Codeberg mirror.

**Stack:** TypeScript + Vue 3 (reactivity only) + break_eternity.js (`Decimal` for all game quantities — no plain `number`) + nanoevents + Vitest.
**Peers:** `vue ^3.4`, `break_eternity.js ^2.1` — consumers own the versions (not bundled).
**Entrypoints:** `open-loop-engine` (full surface incl. harness), `/primitives`, `/core`, `/systems`, `/types` (types-only).
**Functional core:** Pure evaluation (conditions, effects, formulas) separated from reactive state (resources, persistent refs). Headless runner proves it — same engine logic runs with or without a browser.

## Start here — API surface

Before assuming the engine lacks a primitive, or hand-rolling a pattern that should already exist: **read `docs/api/INDEX.md` in full.** Per-cluster directory across primitives/core/systems/harness — symbols group by subsystem (usually one file per cluster, sometimes a small group of related files like `modifier` + `chain-registry`, or a subdirectory umbrella like `spatial`). Each entry is `name:line` relative to the file path shown in the section heading. Partial reads miss primitives whose names don't match the problem vocabulary you brought in; a full scan surfaces them by adjacency. Follow each `file:line` to source for signature, TSDoc, and behavior.

This is the single load-bearing entrypoint — the engine has grown past the point where greps, recent-file bias, or partial reads are reliable.

- `docs/api/INDEX.md` — per-symbol surface, every layer. **Full read each session.** Authoritative "does the engine already do X?" lookup.
- `docs/consumer-guide.md` — narrative thinking model: levels of abstraction, persistence, modifier chains, when the engine should grow.
- `docs/candidate-primitives.md` — drop spot for gaps. Grep here before hand-rolling; a duplicate entry graduates the primitive.
- `docs/migration-notes.md` — engine-internal migration traps and port notes.

## Commands

```bash
pnpm test             # Vitest run
pnpm test:watch       # Vitest watch mode
pnpm typecheck        # tsc --noEmit
pnpm build            # tsc (outputs to dist/)
pnpm release          # bump version from commits, update CHANGELOG, tag (local only)
```

## Commits

Conventional commit prefixes — `release-it` picks the bump from accumulated commits at cut-point. Pre-1.0 (`preMajor: true`), `feat!:` / `BREAKING CHANGE:` bump MINOR, not MAJOR — breaking changes are expected in 0.x.

- `feat:` — new public API (MINOR bump)
- `fix:` — bug fix (PATCH bump)
- `refactor:` / `perf:` — internal change, no API surface change (PATCH bump)
- `feat!:` / `fix!:` or `BREAKING CHANGE:` in body — breaking API change (MINOR pre-1.0, MAJOR after)
- `chore:` / `docs:` / `test:` — no version bump

Releases are manual and batched: `pnpm release` at a cut-point bumps version, regenerates `CHANGELOG.md`, commits, tags. `pnpm publish --access public` is a separate step.

Scope is optional but encouraged: `feat(systems):`, `fix(core):`, etc.

### Breaking-change entries

When committing a `feat!:` / `fix!:` or a change with `BREAKING CHANGE:` in the body, include both the consumer-side migration and the maintainer-side rationale inline in the commit body. `release-it` lifts these into `CHANGELOG.md` verbatim, so one surface serves both audiences — no separate migration doc, no parallel "removed things" ledger.

```
feat(core)!: replace Action primitive with Sequencer + task lookup

BREAKING CHANGE: `createAction` is removed. Consumers wire a Sequencer
directly and look tasks up via an id→task map.

Migration:
  // before
  const action = createAction({ id: 'chop', ... })
  // after
  const sequencer = createSequencer()
  const tasks = { chop: { ... } }
  sequencer.enqueue('chop')

Why removed: Action was a god-function whose lifecycle/serialization/cursor
concerns couldn't be untangled without reinventing Sequencer internally.
Killed in OL-385 after the starter stress test showed three games each
working around a different part of it. Don't reintroduce a generic Action —
the composition is the primitive.
```

Keep the Migration block short enough to paste into a consumer PR, and keep the Why block specific enough that future-you doesn't re-derive the primitive. When a breaking change is obvious (e.g. a rename), skip both blocks — the ceremony is only worth it when it's non-obvious.

### Type-surface pins

`tests/types/public-api.test.ts` pins the inferred types of key factories (`createEngine`, `createResource`, `createSkillCategory`, `EngineContext.inject`, etc.) via vitest's `expectTypeOf`. These are enforced by `pnpm typecheck` — a refactor that silently widens a generic, drops an overload, or loses a literal type fails there instead of surfacing in a consumer weeks later. When a pin fails intentionally, update the expectation in the same commit as the source change.

## Architecture

Four layers, strict one-way dependency:

```
primitives  →  core  →  systems  →  modules (consumer-provided)
```

```
src/
├── primitives/    # Zero deps, no Vue. Foundational types, Decimal, RNG.
├── core/          # Vue reactivity enters. Generic composable primitives — no game-pattern opinions.
├── systems/       # Registration surfaces over core — one per validated incremental pattern.
├── harness/       # Headless-sim substrate: runners, probes, walker, picker, perturbation, solver.
└── index.ts       # createEngine(), module system, barrel exports.
```

### Layer Rules

- **Primitives** imports nothing from core or systems
- **Core** imports from primitives only
- **Systems** imports from primitives and core only
- **Modules** (consumer-provided) import from any engine layer

### Layering Principle

**Core = generic composable primitives.** No opinions, no game patterns. Sequencer stores string IDs. Reset resets persistent refs. TickDriver ticks. These compose freely and never force a particular game shape.

**Systems = registration surfaces over core.** Each system encodes a known incremental game pattern as a typed registration contract: accept definitions via a typed registry, create the right engine primitives per definition (persistent context, Skill, Purchasable, etc.), expose accessors (getDef, getInstance, getState), and provide mod extension points (registry.patch). Game authors describe *what* their content looks like (mapSkill, mapPurchasable); the system handles *how* it becomes live engine objects. `createSkillCategory` is the reference implementation. Systems never lock consumers out of core — if a system doesn't fit, drop down to the primitives it composes and wire manually.

**Modules = consumer-provided game content.** Import from any engine layer. The 20% that varies too much to standardize (specific formulas, UI behavior, game-specific action types) lives here.

The test: if you'd copy-paste the same wiring between two different incremental games, it belongs in systems. If it only makes sense for one game's design, it's a module. If it has no opinion about game design at all, it's core.

## Code Rules

**Naming:**
- Functions: `verbNoun` — `createResource`, `evaluateCondition`
- Types: PascalCase — `IResource`, `GameStateAccessor`
- Files: kebab-case.ts
- Factories: `create*()` pattern
- Standard verbs: `getX` aggregator, `isX` type guard, `formatX` formatter, `setupX` wiring. Noun-form (`multiplicativeEffect`, `replacementBinding`, `fractional`) is the carve-out for helpers consumed declaratively as configuration data.

**Code markers:**
- `TODO(expansion)` — validated pattern, deferred until a consumer needs it. Three lines max, co-located with the code it would change.
- `TODO(ergonomics)` — working but verbose path; simplify when the pattern recurs in two+ consumers.
- See `PROCESS.md` § Parked patterns for rationale and graduation rules.

**Content-unit factories:** Factories accepting `id?: string` resolve identity in order — explicit argument, ambient `withPersistentContext` id, auto-counter (tests only).

**Section banners:** `// === UPPERCASE ===` short-form, one line per section. Inner factory-body sub-sections use the same form at deeper indent. Skip banners on files small enough that scrolling isn't an issue.

**Type guards:** all engine primitives — content-unit factories and structural-shape primitives alike — discriminate via structural shape (`instanceof`, `'prop' in x`, class identity, presence of a discriminator field on the runtime object). No `*Type` symbol exports, no branded `isType(x, XType)` guards. When a narrow is genuinely needed at a callsite, inline a one-line type predicate next to the code that needs it (`const isAccumulator = (s: Skill): s is AccumulatorSkill => s.permanentBonus != null;`) rather than exporting a guard from the system.

**Systems-layer factory decomposition:** large `create*` factory bodies in `src/systems/` decompose under `// === SECTION ===` banners with this order — TYPES, CONSTANTS, PRIVATE BUILDERS (`buildX` helpers), PRIVATE TICK (`tickX(ctx, dt)` over a typed `XTickContext`), FACTORIES (public, orchestration-only), PUBLIC UTILITIES (`getX`/`formatX`/`setupX`). Factory body itself follows the ladder: id + context push → state refs → context pop → options destructure → defaults resolve → builder calls → wire object literal + return. Ad-hoc computation between builder calls is a missing builder. Pure helpers that aren't factory concerns live in a sibling file (`purchasable-effects.ts`, etc.). `createSkillCategory` is the reference implementation. Builders are private functions, not classes; factory tests cover the seam, not isolated builder unit tests.

**Must:**
- Type all public API explicitly
- Keep layers one-way (primitives → core → systems)
- Pure functions for evaluation, reactive refs for state
- Test with Vitest, TDD preferred

**Must Not:**
- Import Vue in primitives layer
- Import systems from core
- Add UI components, rendering, or game-specific content
- Add runtime schema validation outside boundaries — TypeScript types are the contract for in-engine calls. Validate only at boundaries: user input, save load, external APIs. The shipped example is `save-validation.ts`, which auto-derives zod schemas from persistent-ref `DefaultValue`s and validates on decode.

## TSDoc Standards

Three tiers based on audience. IDE hover is the primary delivery mechanism — no generated doc site yet.

**Factory functions (`create*()`)** — the consumer's front door:
- One-liner: what it creates, in game-design terms (not implementation terms)
- `@param` for each parameter, with a sentence on the options object's role
- `@returns` describing the returned object's key capabilities
- `@example` with a 5–10 line realistic usage snippet
- Mention related functions if the relationship isn't obvious (e.g., `trackBest` on `createResource`)

**Public interfaces (Options + Return types)** — the shape consumers configure:
- `/** */` on every field that isn't self-documenting from name + type alone
- **Skip** fields where name + type says it all (`id: string`, `name: string`, `enabled: boolean`). Noise like `/** The ID */` is worse than no doc.
- Focus on *what it controls*, not what type it is (the type signature says that)
- For `MaybeRefOrGetter` fields, note whether reactivity is supported ("can be a ref or getter for dynamic values")

**Enum members** — one-liner per value. Enum names are often cryptic; the doc should say what the value *means* in game terms.

**Internal helpers** (`processGetter`, `createLazyProxy`, `topologicalSort`, etc.):
- One-liner explaining *what*, not *how*
- `@internal` tag if exported only for cross-module use
- No `@example` needed

**File headers** — keep the current pattern:
- First line follows the convention `Title — one-line blurb` (em-dash or hyphen with surrounding spaces). The INDEX.md generator uses both: the title becomes the section heading, the blurb appears under it. Without a dash, the whole first paragraph becomes the blurb and the title falls back to the title-cased file stem — fine, but less expressive.
- Module purpose in game-design terms
- Key features as a bullet list
- Cross-references to related modules when non-obvious
- Optional `@cluster <name>` tag joins this file into a named cluster with sibling files in the same layer. Useful when a helper file conceptually belongs to its companion (e.g., `chain-registry.ts` declares `@cluster modifier`; `auto-purchase.ts` and `purchasable-effects.ts` declare `@cluster purchasable`). Without a tag, files cluster by subdirectory (`src/core/spatial/*.ts` → cluster `spatial`) or stand alone. The tag is the source-local way to express "these belong together"; a small `CLUSTER_OVERRIDES` map in `scripts/lib/source-meta.mjs` exists as an escape hatch when editing the source isn't worth it.

**Do not use:** `@since`, `@deprecated` (pre-1.0), redundant `@see` cross-references, or `@module` tags.

