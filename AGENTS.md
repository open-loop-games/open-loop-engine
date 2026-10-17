# AGENTS.md

Repo conventions — read this whether you are Claude Code, Codex, opencode or anything
else. `.claude/CLAUDE.md` imports this file rather than restating it, so this is the one
home for the content; edit here. Both files ship in the published package.

Open Loop Engine — headless incremental game substrate. The API surface grows from real consumer pressure, continuously and selectively. It is never a one-time extraction, and never a promise to absorb every gap a consumer reports.

**Stack:** TypeScript + Vue 3 (reactivity only) + break_eternity.js (`Decimal` for game quantities) + nanoevents + Vitest.
**Peers:** not bundled — consumers own the versions. `peerDependencies` in `package.json` is the list.
**Subpaths:** `@open-loop/engine` (full API surface), `/primitives`, `/core`, `/systems`, `/harness`, `/types` (types-only). The package is `@open-loop/engine`; `open-loop-engine` is the repo.
**Functional core:** Pure evaluation (condition IR, effects, formulas) separated from reactive state (resources, persistent refs). The headless runner shows it: the same engine logic runs with or without a browser.

## Start here — API surface

Route first, before you conclude the engine lacks a primitive or hand-roll a pattern that should already exist. **Route through `docs/api/INDEX.md`, then read the routed API tier's `## Canonical entrypoints` block.** INDEX.md routes by verb (§ Task → API tier), by noun (§ Concept index) and by subsystem (§ API tier map). Each route points into the API tier files that hold the symbols. § API tier map is the list of API tiers. INDEX and the API tier files are generated, so read them rather than a copy kept here. The API tier file's `Canonical entrypoints` block is the essential read. The per-symbol entries under it give `name:line` into source.

A grep for the symbol names you arrived with confirms what you expected, and misses the API surface next to it. The resulting hand-roll is then reported as an engine gap, when it was a reading failure. Route from the task; do not grep from the vocabulary.

- `docs/api/INDEX.md` — router: § Task → API tier, § Concept index and § API tier map, plus the § Reserved names and § Predicate forms disambiguators. `pnpm build:api` generates it, so a hand edit is lost on the next build.
- `docs/api/<tier>.md` — one API tier file, with a `## Canonical entrypoints` block. Read it for the routed API tier before you write code.
- `docs/consumer-guide.md` — narrative thinking model: abstraction levels, persistence, modifier chains, when the engine should grow.

## Terms

`docs/terms.md` is the engine's controlled vocabulary: one term per meaning, each sense with a stable ID, and the rules for engine text. Read the family for a word before you write TSDoc, a doc, a runtime message or a `BREAKING CHANGE:` footer. Inside this repo it holds over any wider term list.

## Commands

```bash
pnpm test             # Vitest run
pnpm test:watch       # Vitest watch mode
pnpm typecheck        # tsc --noEmit
pnpm build            # tsc + tsc-alias (rewrites @/ paths in dist/) + build:api
pnpm build:api        # regenerate docs/api/ (needs a current dist/ — see below)
```

`build:api` takes line anchors from source, but signatures and blurbs from
`dist/index.d.ts`. Run it without a preceding `tsc`, and every anchor refreshes
while the signatures keep their last-built values. The doc then looks
regenerated and is not. Use `pnpm build` after you change a public signature.
A symbol must also reach the root barrel to appear at all. An export from
`src/systems/gate.ts` is not enough; `src/systems/index.ts` must re-export it.

## Commits

Conventional commit prefixes — git-cliff reads them at a cut-point to pick the bump and write the changelog (`cliff.toml`). Pre-1.0, a breaking change bumps MINOR and every other releasable commit bumps PATCH. So a `^0.x.y` range takes features and fixes, and only a breaking release makes a consumer move its specifier.

- `feat:` — new public API (PATCH pre-1.0, MINOR after)
- `fix:` — bug fix (PATCH)
- `refactor:` / `perf:` — internal change, no API surface change (PATCH)
- `feat!:` / `fix!:` or `BREAKING CHANGE:` in body — breaking API change (MINOR pre-1.0, MAJOR after)
- `chore:` / `docs:` / `test:` — no version bump, and no changelog line

Releases are manual and batched. At a cut-point, `pnpm release` takes the version from git-cliff and prepends its section to `CHANGELOG.md`. It then sets `package.json`, commits `chore(release): <version>`, tags `v<version>` and pushes. `pnpm release --dry-run` previews the version and section; `--no-push` stops after the tag. The release commit runs the pre-commit git hook, so a failing check stops the cut before a tag exists. Publishing is not the script's job. `.gitea/workflows/ci.yml` publishes a pushed `v*` tag after its checks pass, and refuses a tag that disagrees with `package.json`'s version. The same checks run on every push to main. One of them checks that `docs/api/` matches a clean build, because version-keyed drift audits diff it between tags. The prepend recognises `CHANGELOG.md`'s header only when it matches `cliff.toml`'s `header` exactly. Edit the two together, or the file gets a second header.

### Publish surface

`npm pack --dry-run` prints the exact tarball; run it before you publish. `files` is the allowlist that decides the tarball, and `.gitignore` **cannot** re-exclude a path named there. Hence the globs `docs/*.md` + `docs/api` rather than a bare `docs`. A bare `docs` would publish any gitignored working files under it. `src` ships because every `docs/api/` entry ends in a `src/path:line` pointer. The two ship together, or those pointers point at nothing in an installed copy. `exports` still admits only the declared subpaths, so shipped source is reference material, not an import surface. `prepublishOnly` rebuilds, so shipped docs always describe the shipped `dist`. Both instruction files ship. `AGENTS.md` contains the content for any agent harness that reads a consumer's `node_modules`. `.claude/CLAUDE.md` ships beside it, because Claude Code discovers a subdirectory `CLAUDE.md` and does not discover `AGENTS.md`. Without it, a Claude Code session in a consumer silently loses the lazy load it gets when it reads engine source.

`declarationMap` is on, so IDE go-to-definition opens that shipped source instead of a `.d.ts`. The mapping stays correct after `tsc-alias`, because rewriting an import specifier changes a column, never a line. The mapping depends on the build order, so re-verify it if that step ever moves.

A conventional-commit scope is optional but encouraged: `feat(systems):`, `fix(core):`, etc.

### Breaking-change entries

For a `feat!:` / `fix!:` commit, or one with `BREAKING CHANGE:` in its body, write two parts in that body. One is the consumer-side API migration; the other is the maintainer-side rationale. The changelog lifts everything from `BREAKING CHANGE:` up to the `Co-Authored-By` trailer into `CHANGELOG.md` verbatim. So one text serves both audiences, with no separate migration doc and no parallel "removed things" ledger. Prose above the token stays in the commit; anything below it ships.

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
Killed after the starter stress test showed three games each working
around a different part of it. Don't reintroduce a generic Action —
the composition is the primitive.
```

Keep the Migration block short enough to paste into a consumer PR. Keep the Why block specific enough that future-you does not re-derive the primitive. A rename's Migration block is the list `migration.mjs` prints (§ API migrations), and it needs no Why block. For another obvious break, skip both blocks. The blocks are worth writing only for a non-obvious change.

### API migrations

A rename is the one break a tool can apply for a consumer. `api-migrations/` holds a rename manifest per breaking release, and the codemod that applies the manifests a consumer's upgrade crosses. The folder is not in `files`. So a consumer runs the codemod from an engine checkout, never from an installed copy.

- A commit that renames public API adds its entries to `api-migrations/<version>/manifest.json` in that same commit. `pnpm test` checks each entry's shape.
- A consumer whose bump crosses a breaking release runs the codemod first, while the old engine is still installed.
- A breaking release older than the first manifest has none. Migrate its renames by hand, from the changelog.
- Every other break is migrated by hand, from its Migration block.

`api-migrations/README.md` has the manifest format, the consumer's upgrade steps, what typecheck misses after a codemod, and a breaking release's checklist.

### Type-surface pins

`tests/types/public-api.test.ts` pins the inferred types of key factories (`createEngine`, `createResource`, `createSkillCategory`, `EngineContext.inject`, etc.) via vitest's `expectTypeOf`. `pnpm typecheck` enforces them. A refactor that silently widens a generic, drops an overload or loses a literal type fails there. Without the pins, it would appear in a consumer weeks later. When a pin fails intentionally, update the expectation in the same commit as the source change.

## Architecture

Source layers, with a strict one-way dependency. Consumer modules are above the engine:

```
primitives  →  core  →  systems  →  modules (consumer-provided)
                                 ↘  harness  (balance harness, optional)
```

```
src/
├── primitives/    # Zero deps, no Vue. Foundational types, Decimal, RNG.
├── core/          # Vue reactivity enters. Generic composable primitives — no game-pattern opinions.
├── systems/       # Typed registration contracts over core — one per validated incremental pattern.
├── harness/       # Balance harness: runners, probes, walker, picker, perturbation, solver. Game code never imports it; a consumer's probes and balance workbench do.
├── engine.ts      # Engine assembly — the module-system façade composing core + systems. `createEngine()` is here.
├── reactivity-reexports.ts  # Vue reactivity re-exported by the engine. Consumers import these, not `vue` — a separately-resolved `vue` won't subscribe to engine refs, and updates silently miss.
└── index.ts       # Root barrel — the public API surface.
```

### Source Layer Rules

- **Primitives** imports nothing from core, systems, or harness
- **Core** imports from primitives only
- **Systems** imports from primitives and core only
- **Harness** imports from primitives, core, and systems — is above systems, below consumers; game modules never import it
- **Modules** (consumer-provided) import from any source layer

### Layering Principle

**Core = generic composable primitives.** No opinions, no game patterns. Sequencer stores string ids. TickDriver ticks. Resources hold reactive Decimals. Modifier chains evaluate. Persistent refs serialize. These compose freely and never force a particular game shape.

**Systems = typed registration contracts over core.** Each system encodes a known incremental game pattern as a typed registration contract. A system:

- accepts defs through a content registry;
- creates the right engine primitives per def (persistent context, Skill, Purchasable, etc.);
- exposes read methods (getDef, getEntry, getState);
- provides extension points for mods (registry.patch).

Consumers describe *what* their content looks like (mapSkill, mapPurchasable); the system handles *how* it becomes engine objects. `createSkillCategory` is the reference implementation. Systems never lock consumers out of core. If a system doesn't fit, drop down to the primitives it composes and wire them by hand.

**Modules = consumer-provided game content.** Import from any source layer. The 20% that varies too much to standardize is here: specific formulas, UI behavior, game-specific action types.

The test: if you'd copy-paste the same wiring between two different incremental games, it belongs in systems. If it only makes sense for one game's design, it's a module. If it has no opinion about game design at all, it's core.

## Code Rules

**Naming:**
- Functions: `verbNoun` — `createResource`, `evaluateCondition`
- Types: PascalCase — `IEffect`, `GameStateAccessor`
- Files: kebab-case.ts
- Factories: `create*()` pattern
- Standard verbs: `getX` aggregator, `isX` type guard, `formatX` formatter, `setupX` wiring. A noun-form name (`replacementGrants`, `fractional`) is the carve-out for a utility whose result is declarative data in options or a def.
- `restore(x)` writes back only what the same object's `snapshot()` or `serialize()` produced. Rebuilding live state from persistent refs is hydration. It runs on its own through `onHydrated`, and is never a public method.
- Events:
  - a past-tense phrase names what happened (`purchased`, `leveledUp`, `cancelled`);
  - a `before*`/`after*` pair brackets one step;
  - a `family:` prefix groups a family (`save:loaded`, `run:died`).

  Option callbacks stay `onVerb` (`onPurchase`, `onLevelUp`).

**Code markers:**
- `TODO(expansion)` — validated pattern, deferred until a consumer needs it. Three lines max, co-located with the code it would change.
- `TODO(ergonomics)` — working but verbose path; simplify when the pattern recurs in two+ consumers.

**No game names:** engine source, its doc comments and the shipped `docs/` name no game. That covers a game built on the engine and a game studied as reference. Write a variant by its engine term, and a tuned value as a typical range. Frame an example in a generic domain. The one exception is the license credit for copied code, which points at `THIRD-PARTY-NOTICES.md`.

**Save identity:** a save key is derived from ids the consumer chose, never from creation order or display text. Either of those shifts with a content update, and then every player's value under that key loads as the ref default. A per-item factory that a module builds several of requires `id`, and nests under the enclosing persistent context. Purchasables, achievements and timed-progress trackers are examples. A system that a module builds once takes `id?: string`, and resolves it through `resolveSystemPersistentContextId`. The order is the explicit id, else `${ambient}/${kind}`, else an auto-counter. Only a build outside any module reaches the counter, as in tests. An id that names a whole persistent context is flat: it does not nest under the module. Such ids are an explicit system id, and the required id of a category, Loadout, BestOf, RunPool or Sequencer. Every such id must be unique across the game, because none nests under the module. An explicit system id also drops the kind. A repeated ref id in one persistent context throws at install. The exception is an unowned ref, which a `dispose()` leaves: the new ref takes it over, so a rebuilt object resumes.

**Save shape:** saves that players hold must keep loading. So a change to what an engine system saves is a tolerant read in the system that owns the key. A tolerant read is a new key with a ref default, or a fallback to the old field's name. Loading skips save keys that no ref owns, so a dropped key needs nothing. Bump `ENGINE_SAVE_VERSION` and add its save migration in `applyEnvelope` only for a change no tolerant read can express. An example is a value that moves between persistent contexts. An older engine refuses a save with a newer engine save version.

**Reactive reads:** a public read on an engine object is reactive, whether it is a property getter, a method or a field. A `computed` or a template over it recomputes when its answer changes. Back the read with a ref, or have it read a version ref that every mutation bumps. Keep any raw-read cache behind that version ref; `itemsVersion` in `createModifierChain` is the example. A deliberate snapshot says "snapshot" in its TSDoc, and names what to watch instead. Per-tick hot-path state and an event-driven list are examples. A consumer that mirrors an engine read into its own ref, to make a UI update, is a receipt for this rule. The input side matches: an option the engine reads inside a `computed` or a tick takes `Computable`. An option read once, at creation or per call, stays a plain value.

**Section banners:** `// === UPPERCASE ===` short-form, one line per section. Inner factory-body sub-sections use the same form at deeper indent. Skip banners on files small enough that scrolling isn't an issue.

**Type guards:** all engine primitives discriminate by structural shape, content-unit factories and structural-shape primitives alike. The forms are `instanceof`, `'prop' in x`, class identity, and a discriminant field present on the object. Export no `*Type` symbols and no branded `isType(x, XType)` guards. When a callsite needs a narrow, inline a one-line type predicate next to that code: `const isAccumulator = (s: Skill): s is AccumulatorSkill => s.lifetimeBonus != null;`. Do not export a guard from the system for it.

**Systems-layer factory decomposition:** a large `create*` factory body in `src/systems/` decomposes under `// === SECTION ===` banners, in this order:

- TYPES;
- CONSTANTS;
- PRIVATE BUILDERS (`buildX` helpers);
- PRIVATE TICK (`tickX(ctx, dt)` over a typed `XTickContext`);
- FACTORIES (public, orchestration-only);
- PUBLIC UTILITIES (`getX`/`formatX`/`setupX`).

The factory body itself follows this order:

1. id + persistent context push;
2. state refs;
3. persistent context pop;
4. options destructure;
5. option defaults resolve;
6. builder calls;
7. wire the object literal, and return it.

Ad-hoc computation between builder calls is a missing builder. Pure functions that aren't factory concerns are in a sibling file: `auto-purchase.ts` beside `purchasable-category.ts`, `recommenders.ts` beside `recommendation.ts`, and so on. `createSkillCategory` is the reference implementation. Builders are private functions, not classes. Factory tests cover the seam, not isolated builder unit tests.

**Decimal arithmetic is neither exact nor total.** Work in the coordinate where the value is defined and where its precision is. Do not evaluate into a domain edge and inspect the result. In practice:

- solve above break_eternity layer 0 in log space;
- take integer roots with `integerRoot`;
- build integer powers by multiplication;
- never verify an answer by raising it back through `pow`. That direction multiplies the stored exponent's ulp by the degree, where the root divides it.

`Decimal` answers plausible finite numbers for undefined inputs: `pow(0, -1)` is `0`. So "no NaN escaped" is not a correctness check. Any assumption that a `Decimal` or `Formula` operation is exact gets a law. A law is a mathematical identity over that operation, checked across a stated domain against an independent reference. The reference is the mpmath oracle, quadrature, a brute-force `Σ` or a round-trip. The law's tolerance is measured in the coordinate the identity is defined in. A single-point assertion is not a law. The word "law" also does not name an invariant, a postcondition or a contract about reporting. Those are ordinary tests, and they belong outside `formulas-conformance.test.ts`.

**Must:**
- Type all public API explicitly
- Keep source layers one-way (primitives → core → systems → harness; modules import from any)
- Pure functions for evaluation, reactive refs for state
- Test with Vitest, TDD preferred

**Must Not:**
- Import Vue in primitives layer
- Import systems from core
- Add UI components, rendering, or game-specific content
- Add runtime schema validation outside boundaries — TypeScript types are the contract for in-engine calls. Validate only at boundaries: user input, load, external APIs. The shipped example is `save-validation.ts`, which auto-derives zod schemas from persistent-ref `DefaultValue`s and validates on decode.

## TSDoc Standards

TSDoc depth is set by audience. IDE hover is the main way a reader sees it; there is no generated doc site.

**Factory functions (`create*()`)** — the consumer's front door:
- One-liner: what it creates, in game-design terms (not implementation terms)
- `@param` for each parameter, with a sentence on the options object's role
- `@returns` describing the returned object's key capabilities
- `@example` with a 5–10 line realistic usage snippet
- Mention related functions if the relationship isn't obvious (e.g., `formatResource` / `resetResource` on `createResource`)

**Public interfaces (Options + Return types)** — the shape consumers configure:
- `/** */` on every field that isn't self-documenting from name + type alone
- **Skip** fields where name + type says it all (`id: string`, `name: string`, `enabled: boolean`). Noise like `/** The ID */` is worse than no doc.
- Focus on *what it controls*, not what type it is (the type signature says that)
- For `Computable` fields, note whether reactivity is supported ("can be a ref or a getter, for a reactive value")

**Enum members** — one-liner per value. Enum names are often cryptic; the doc should say what the value *means* in game terms.

**Internal helpers** (`toMaybeRef`, `topologicalSort`, etc.):
- One-liner explaining *what*, not *how*
- `@internal` tag if exported only for cross-file use
- No `@example` needed

**File headers** — keep the current pattern:
- First line follows the convention `Title — one-line blurb` (em-dash or hyphen with surrounding spaces). The INDEX.md generator uses both: the title becomes the section heading, the blurb appears under it. Without a dash, the whole first paragraph becomes the blurb. The title then falls back to the title-cased file stem: correct, but less expressive.
- File purpose in game-design terms
- Key features as a bullet list
- Cross-references to related files when non-obvious
- Optional `@cluster <name>` tag joins this file into a named cluster with sibling files in the same source layer. Use it when a helper file belongs to its companion. For example, `purchasable-category.ts` and `auto-purchase.ts` both declare `@cluster purchasable`, and `recommenders.ts` declares `@cluster recommendation` beside `recommendation.ts`. Without a tag, files cluster by subdirectory (`src/core/spatial/*.ts` → cluster `spatial`) or stand alone. The tag is the source-local way to say "these belong together". A small `CLUSTER_OVERRIDES` map in `scripts/lib/source-meta.mjs` is the escape hatch, for when editing the source isn't worth it.

**Do not use:** `@since`, `@deprecated` (pre-1.0), redundant `@see` cross-references, or `@module` tags.

## Quality passes & triage

- **Read before you frame.** Read an abstraction's full source before you treat a contract question as an architectural decision. Existing optional or polymorphic fields often already answer it. Recorded cross-cuts and codified rules are sanity checks to apply *after* reading, not a checklist to execute. Findings decide structure, not the reverse.
- **Substance over cosmetics.** A leaf that produces only banner, TSDoc or naming-nit deltas wasn't worth running. Code-quality findings (unused-API trims, fixes, primitive simplifications) outrank codification-of-divergence.
- **Best shape is found by comparison.** When you audit "what's the right shape for X?", compare `systems/`, `harness/`, `primitives/` and consumer hand-rolls. Do not compare only the folder under audit. Resolve divergence by picking the right shape and aligning the laggards, or by proving both contexts genuinely differ. Never ship both with part tagged "legacy".
- **Audit before answering strict validation.** A ticket may frame several zero-adoption API surfaces as Path-A/B/C choices. Audit real adoption first: essential, calcified, latent contract or aspirational framing. The per-subsystem disposition shape is often the actual finding.
- **Corpus-test ambiguous structure.** Some structural choices do not converge with iteration: an organization axis, a taxonomy, a boundary. For one, give ~4 subagents (2 sonnet + 2 opus) the same structural questions, each with a different concrete task. Brief them not to affirm a prior plan. Convergence plus novel ideas beats single-mind iteration.
- **Distill or drop at close.** An in-thread codification (CC-N labels, scoped notes) qualifies for at most a 1–2 bullet code-shape rule here; otherwise drop it. Keep this file light, and add no per-folder instruction file.
