# @open-loop/engine

A headless TypeScript substrate for incremental and idle games. It has reactive state on top of Vue 3's reactivity primitives, and big-number math via `break_eternity.js`. Its composable evaluation kernel covers modifiers, formulas, requirements, the condition IR and effects. Its systems cover the patterns idle games keep re-inventing: skills, producers, purchasables, achievements, challenges, dialog, zones.

No DOM. No rendering. Wire any UI on top — or run it headless in the balance harness.

## Status

**Pre-1.0.** A breaking change bumps the minor version; features and fixes bump the patch. So `^0.1.0` takes every non-breaking release. A move to `0.2.0` is always a deliberate specifier change, with an API migration in `CHANGELOG.md`.

## Install

```sh
pnpm add @open-loop/engine vue break_eternity.js eternal_notations
```

`vue`, `break_eternity.js`, and `eternal_notations` are peer dependencies — the engine doesn't bundle them so consumers control the versions.

> The published JS and type declarations have explicit `.js` extensions, so the engine works under plain node ESM. A headless run needs no bundler. For TypeScript, use `moduleResolution: "bundler"`; `"nodenext"` currently fails on `break_eternity.js`'s own typings (upstream CJS-interop issue), not on the engine.

## Quick start

```ts
import { createEngine, createResource } from '@open-loop/engine';
import Decimal from 'break_eternity.js';

const engine = createEngine({ gameId: 'my-idle-game' });

engine.use({
  id: 'core',
  install({ onTick }) {
    const gold = createResource(new Decimal(0), { id: 'gold' });
    onTick((dt) => {
      gold.value = Decimal.add(gold.value, dt); // +1 gold/sec
    });
  },
});

engine.start();
```

That's a complete incremental game loop. Resources are reactive: show them with any framework, or read them headless. The same engine logic runs in a browser, or headless in node.

## Subpaths

The package exposes subpaths along the source layers, so consumers can import from the smallest API surface that fits:

- `@open-loop/engine` — full API surface (primitives + core + systems + harness + `createEngine`)
- `@open-loop/engine/primitives` — zero-dep foundation (Decimal, RNG, types)
- `@open-loop/engine/core` — reactive primitives (resource, modifier, formula, save, game loop, headless runner, run pool, ...)
- `@open-loop/engine/systems` — typed registration contracts (skills, producers, purchasables, ...)
- `@open-loop/engine/harness` — the balance harness over a built engine (matrix sweeps, sensitivity, perturbation, probes, solver)
- `@open-loop/engine/types` — evaluation-kernel interface types only (`ICondition`, `IEffect`, `Analyzer`, …), not the factory return types

Default to the root import; use subpath imports when bundle size matters.

## Documentation

The engine contains its own docs, in the repo and in the installed package under `node_modules/@open-loop/engine/`. There's no separate doc site, and the copy you install describes the version you installed.

- **`docs/api/INDEX.md`** — router into the per-symbol API surface: § Task → API tier, § Concept index, § API tier map. The answer to "does the engine already do X?"
- **`docs/consumer-guide.md`** — how to think about composing the engine. Abstraction levels (resource utilities → categories → raw primitives → declarative data), persistence, modifier chains.
- **`docs/consumer-guide-choosing.md`** — which primitive is mine, when two of them overlap. The boundaries INDEX's routing table is too short to draw: producer vs gated purchasable, Cycle vs RunPool, category vs raw purchasable.
- **`docs/consumer-guide-recipes.md`** — the worked-pattern cookbook the guide routes into: worker pools, persona rosters, spatial grids, dialog and subjects.
- **`docs/consumer-guide-recipes-tick.md`** — its companion for shapes a tick handler runs: phases inside a run, drawing ticking game state, a player switch over automation.
- **`docs/consumer-guide-balance.md`** — how numbers get chosen and verified: the closed-form spine, the probe that contradicts it, and the balance loop between them.
- **`docs/consumer-guide-balance-automated-player.md`** — balance when an automated player plays the game your probe measures. It covers calibrating the automated player, what it can't measure, and the balance harness checks that keep its readings honest.

- **`docs/domain-map.md`** — `ol-domain-map`, the bin that generates a vocabulary map of _your_ game's domain types from their structure.

`docs/api/` is generated from TSDoc, and each entry ends in a `src/…:line` pointer. `src/` ships for exactly that reason, so those pointers resolve in an installed copy. It is reference material, not an import surface, because `exports` admits only the subpaths listed above.

API migration guidance for a breaking change is in the body of its `feat!:`/`fix!:` commit. It is lifted verbatim into `CHANGELOG.md`; there is no separate migration doc. The changelog ships in the package. So after an upgrade, the installed copy lists every change between the version you left and the one you're on.

## Stability and feedback

This is a 0.x release. The public API is described and tested, but it will change. If something breaks unexpectedly while you build on it, that's a bug worth reporting. Open an issue with the version you were on, the version you upgraded to, and the symptom.

## License

MIT — see [LICENSE](./LICENSE).
