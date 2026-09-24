# @open-loop/engine

A headless TypeScript substrate for incremental and idle games. Reactive state on top of Vue 3's reactivity primitives, big-number math via `break_eternity.js`, a composable evaluation kernel (modifiers, formulas, requirements, conditions, effects), and registration surfaces for the patterns idle games keep re-inventing — skills, producers, purchasables, achievements, challenges, dialog, zones.

No DOM. No rendering. Wire any UI on top — or run it headless for balance simulation.

## Status

**Pre-1.0.** Expect breaking changes between minor versions until 1.0. Pin `~0.1.0` for patch-only updates if you need stability for a jam or short project.

## Install

```sh
pnpm add @open-loop/engine vue break_eternity.js eternal_notations
```

`vue`, `break_eternity.js`, and `eternal_notations` are peer dependencies — the engine doesn't bundle them so consumers control the versions.

> The published JS and type declarations carry explicit `.js` extensions, so the runtime works under plain node ESM — headless sims need no bundler. For TypeScript, use `moduleResolution: "bundler"`; `"nodenext"` currently fails on `break_eternity.js`'s own typings (upstream CJS-interop issue), not on the engine.

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

That's a complete incremental game loop. Resources are reactive — render them with any framework, or read them headless. The same engine logic runs in a browser or in a node sim.

## Entry points

The package exposes layered subpaths so consumers can import from the smallest surface that fits:

- `@open-loop/engine` — full surface (primitives + core + systems + harness + `createEngine`)
- `@open-loop/engine/primitives` — zero-dep foundation (Decimal, RNG, types)
- `@open-loop/engine/core` — reactive primitives (resource, modifier, formula, save, loop, headless runner, run pool, ...)
- `@open-loop/engine/systems` — registration surfaces (skills, producers, purchasables, ...)
- `@open-loop/engine/harness` — balance-sim tooling over a built engine (matrix sweeps, sensitivity, perturbation, probes, solver)
- `@open-loop/engine/types` — evaluation-kernel interface types only (`IResource`, `ICondition`, `Analyzer`, …), not the factory return types

Default to the root import; reach for subpath imports when bundle size matters.

## Documentation

The engine carries its own docs — in the repo and in the installed package, under `node_modules/@open-loop/engine/`. There's no separate doc site yet, and the copy you install describes the version you installed.

- **`docs/api/INDEX.md`** — router into the per-symbol surface. Task table, concept index, tier map. The answer to "does the engine already do X?"
- **`docs/consumer-guide.md`** — how to think about composing the engine. Levels of abstraction (resource helpers → category systems → raw primitives → declarative data), persistence, modifier chains.
- **`docs/consumer-guide-choosing.md`** — which primitive is mine, when two of them overlap. The boundaries INDEX's routing table is too short to draw: producer vs gated purchasable, Cycle vs RunPool, category vs raw purchasable.
- **`docs/consumer-guide-recipes.md`** — the worked-pattern cookbook the guide routes into: worker pools, persona rosters, spatial boards, dialog and subjects.
- **`docs/consumer-guide-balance.md`** — how numbers get chosen and verified: the closed-form spine, the probe that contradicts it, and the loop between them.
- **`docs/consumer-guide-balance-agents.md`** — the layer that applies when a policy agent plays the game your probe measures: calibrating the agent, what it can't measure, and the harness checks that keep a bot-driven reading honest.

- **`docs/domain-map.md`** — `ol-domain-map`, the bin that generates a vocabulary map of *your* game's domain types from their structure.

`docs/api/` is generated from TSDoc, and each entry ends in a `src/…:line` pointer. `src/` ships for exactly that reason, so those pointers resolve in an installed copy — it's reference material, not an import surface, since `exports` admits only the subpaths listed above.

Migration guidance for breaking changes lives in the commit body of each `feat!:`/`fix!:` commit and is lifted verbatim into `CHANGELOG.md` — there is no separate migration doc. The changelog ships in the package, so after an upgrade the installed copy lists every change between the version you left and the one you're on.

## Stability and feedback

This is a 0.x release. The public API is described and tested but will move. If you're building on it and something breaks unexpectedly, that's a bug worth reporting — open an issue with the version you were on, the version you upgraded to, and the symptom.

## License

MIT — see [LICENSE](./LICENSE).
