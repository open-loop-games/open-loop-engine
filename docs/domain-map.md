# Domain-language map

`ol-domain-map` is a bin the engine ships for consumer games: point it at your domain files and it emits a committed `domain-map.md` describing your game's own vocabulary. Past a certain vocabulary size, re-reading your `data/` types to recall "what's an action vs a job, what references what" costs more than maintaining a small generated map.

## What it emits

- **Vocabulary** — enums plus string-literal and discriminated unions, where membership is an is-a relation.
- **Def inventory** — the content-definition types your game declares.
- **Field-name reference graph** — the untyped-ID edges (`requiredExplorations` and its kin) that type-graph tools miss, because the edge lives in a `string`, not a reference.

Source of truth is code **structure**, not tsdoc. It regenerates from your types on every run, so it can't drift.

## Wiring

```jsonc
// package.json
"scripts": { "domain-map": "ol-domain-map src/domain-map.config.mjs" }
```

Commit both the config and the generated `.md`; edit the config, never the `.md`. Run it from your pre-commit hook so a stale map can never be committed — the same regenerate-then-check discipline the engine uses for its own `docs/api/`.

The config carries the dialect knobs — `scope` globs, `defSuffixes`, optional `nouns` / `stopwords` — plus a small hand-authored `curated` block for the cross-symbol concepts no single type owns. The starter's archetypes carry worked configs across dialects (`Def` vs `Spec` suffixes).

`ts-morph` must resolve for the bin to run. Workspace consumers get it through the engine's own `node_modules`; a registry install needs it added consumer-side.
