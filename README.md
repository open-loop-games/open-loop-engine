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

> Requires `moduleResolution: "bundler"` (or `"node16"` with explicit `.js` extensions in your imports). The published types use extensionless cross-file references, which Vite/webpack/esbuild resolve fine but classic node resolution does not.

## Quick start

```ts
import { createEngine, createResource } from '@open-loop/engine';
import Decimal from 'break_eternity.js';

const engine = createEngine({ gameId: 'my-idle-game' });

engine.use({
  id: 'core',
  install({ onTick }) {
    const gold = createResource({ id: 'gold' });
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
- `@open-loop/engine/core` — reactive primitives (resource, modifier, formula, save, loop, ...)
- `@open-loop/engine/systems` — registration surfaces (skills, producers, purchasables, ...)
- `@open-loop/engine/harness` — headless sim runner (matrix sweeps, perturbation, probes)
- `@open-loop/engine/types` — types only

Default to the root import; reach for subpath imports when bundle size matters.

## Documentation

The engine ships its own docs in the repo (not on a separate site yet):

- **`docs/consumer-guide.md`** — how to think about composing the engine. Levels of abstraction (resource helpers → category systems → raw primitives → declarative data), persistence, modifier chains.
- **`docs/api/INDEX.md`** — mechanical per-symbol index across every layer. The answer to "does the engine already do X?"
- **`docs/migration-notes.md`** — engine-internal migration traps when porting from older shapes.

The `INDEX.md` is generated from TSDoc; signatures and behavior live in source, reachable from the index.

## Stability and feedback

This is a 0.x release. The public API is described and tested but will move. If you're building on it and something breaks unexpectedly, that's a bug worth reporting — open an issue with the version you were on, the version you upgraded to, and the symptom.

## License

MIT — see [LICENSE](./LICENSE).
