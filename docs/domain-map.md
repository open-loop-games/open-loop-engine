# Domain-language map

`ol-domain-map` is a bin the engine ships for consumers. Point it at your domain files, and it writes a committed `domain-map.md` that describes your game's own vocabulary. Past some vocabulary size, a small generated map costs less than re-reading your `data/` types. Those types answer "what's an action vs a job, what references what".

## What it emits

- **Vocabulary** — enums plus string-literal and discriminated unions, where membership is an is-a relation.
- **Def inventory** — the def types your game declares.
- **Field-name reference graph** — the untyped id edges (`requiredExplorations` and its kin) that type-graph tools miss, because the edge is a `string`, not a reference.

The map's source of truth is code **structure**, not TSDoc. It regenerates from your types on every run, so it cannot drift.

## Wiring

```jsonc
// package.json
"scripts": { "domain-map": "ol-domain-map src/domain-map.config.mjs" }
```

Commit both the config file and the generated `.md`. Edit the config file, never the `.md`. Run the bin from your git pre-commit hook, so a stale map can never be committed. The engine uses the same regenerate-then-check discipline for its own `docs/api/`.

The config file holds the dialect settings: `scope` globs, `defSuffixes`, and optional `nouns` / `stopwords`. A small hand-written `curated` block holds the concepts across symbols that no single type owns. The starter's archetypes contain worked config files across dialects (`Def` vs `Spec` suffixes).

`ts-morph` must resolve for the bin to run. A workspace consumer gets it through the engine's own `node_modules`. A registry install must add it on the consumer side.
