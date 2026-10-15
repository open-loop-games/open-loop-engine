# Consumer Guide

How to express a game with `@open-loop/engine`. Read this after you fork `open-loop-starter` and before you write your first module.

This guide explains **how to compose** the engine: the abstraction levels, which API to choose when, and the recurring shapes of modules. It does not list symbols. For those, route through [api/INDEX.md](api/INDEX.md) into the relevant `api/<tier>.md` file. Adjacent docs:

- [consumer-guide-choosing.md](./consumer-guide-choosing.md) — the boundary between two primitives that overlap;
- [consumer-guide-recipes.md](./consumer-guide-recipes.md) and [consumer-guide-recipes-tick.md](./consumer-guide-recipes-tick.md) — worked engine compositions;
- [consumer-guide-balance.md](./consumer-guide-balance.md) — how balance constants are chosen and verified;
- `CHANGELOG.md` — the API migrations of breaking changes.

## A module and an engine

A game is a set of modules. A module builds its state in `install`, and shares an API with other modules through an injection key. `install` can inject a module listed in `dependencies`. `connect` runs after every module has installed, for wiring that needs a module this one does not depend on:

```ts
export const EconomyKey: InjectionKey<{ gold: Resource }> = Symbol('economy');

export const economyModule: EngineModule = {
  id: 'economy',
  dependencies: ['tuning'], // installed first
  install(ctx) {
    const gold = createResource(0, { id: 'gold', displayName: 'Gold' });
    ctx.onTick((dt) => addResource(gold, dt)); // dt in seconds
    ctx.provide(EconomyKey, { gold });
  },
};

const engine = createEngine({ gameId: 'my-game', persistence: true });
engine.use(tuningModule).use(economyModule); // tuningModule: § Tunables
engine.start(); // installs in dependency order, then ticks
engine.load();  // after start, so the refs exist for the load to write
```

`ctx.inject(key)` reads another module's API, and `ctx.tryInject(key)` returns `undefined` when nothing provides it. The engine provides its own services the same way. For example, `ctx.inject(TickDriverKey)` is the TickDriver, which is also `engine.tickDriver`.

## The expression spectrum

The engine offers several abstraction levels for the same problem. The core skill is to know which level to choose, and when to move between them.

### Level 1: Resource utilities (use first)

The engine ships utilities for the Decimal arithmetic, bounds checks and modifier application that every game needs. Use them before you write raw `Decimal.add(resource.value, ...)`:

| Function | What it does | Replaces |
|---|---|---|
| `addResource` | Add to a resource, optionally tagging the gain with a modifier chain for trace attribution | `resource.value = Decimal.add(resource.value, amount)` |
| `subtractResource` | Subtract after an affordability check; returns `false` if the amount is short | `if (Decimal.gte(r.value, cost)) { r.value = Decimal.sub(...) }` |
| `hasResource` | Check whether a resource's amount reaches a threshold | `Decimal.gte(resource.value, amount)` |
| `formatResource` | Format a resource for display | `format(resource.value)` |
| `resetResource` | Reset to the ref default | `resource.value = Decimal.dZero` |
| `resource.best` | Saved high-water mark on persistent resources | Manual `if (gt(current, best)) best = current` |
| `resource.cumulative` | Saved lifetime gain on persistent resources. It starts at the ref default, so a starting amount counts toward it, as `cumulative-gte` reads it | Manual accumulator in a tick handler |

These are the correct API, not sugar. `subtractResource` returns a boolean, so "check and spend" is one call. `addResource`'s chain does *not* multiply the gain, so pre-multiply the amount if you need that.

### Level 2: Categories (the default for content)

Categories are the engine's standard shape for registering content. Each category factory has a typed registration contract and builds live engine objects per def. Define a def type, provide a `map*` callback, and register in bulk. The full factory list is in `api/content-systems.md` and `api/content-narrative.md`. Read each one's **Canonical entrypoints** block before you drop to raw primitives.

```ts
const skills = createSkillCategory<MySkillDef>({
  id: 'skills',
  mapSkill: (def) => ({
    xpToLevel: (xp) => Formula.variable(xp).div(def.xpDivisor).floor(),
    levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
  }),
});
skills.register([{ id: 'woodcutting', xpDivisor: 10 }, { id: 'mining', xpDivisor: 12 }]);
```

The `map*` function is where your game's def shape meets the engine's options shape.

A category gives you a persistent context per def, typed reads (`getDef` / `getAll`) and a per-def lifecycle. A mod adds defs through the category's own `register`, which builds each def's instance and def state. The category's `registry` is a read-and-patch `ContentRegistryView` with no `register`. A mod changes a def with `registry.patch()`, without touching the original module. A patch rewrites the def, not what was built from it. Value fields and closures over `def` are copied or frozen at register. So a live instance sees a patch only where its mapping reads the def back through `getDef(id)` inside a getter.

**Categories self-register.** A new category enrolls itself in `EngineCategories`. So UIs, balance workbenches, the balance harness and mods can walk your content without importing its module. Like every other ambient value, `EngineCategories` is wired only during `install()` / `connect()`. Content built from raw primitives still works, but tooling and mods do not see it.

**Purchasables as unlocks.** A purchasable's shape is its requirements, not its name. Replace `createCostRequirement` with a predicate requirement, and the same primitive becomes an unlock. It costs nothing, and its `active` ref becomes true once it is purchased. Nothing purchases it on its own: `setupSweepAutoPurchase` does, on the first tick the requirement is met. Progression unlocks, ladders, era unlocks and visibility all read one value, `category.getPurchasable(id)?.active.value`. No parallel visibility store needs to stay in sync.

Two predicate-requirement forms, in preference order:

- `createGateRequirement({ gate })` — the Gate form. Write the predicate as a `Gate` AST (`resource-gte`, `cumulative-gte`, `count-gte`, `active`, `flag`, `state`, `all`/`any`/`not`). The factory wraps it in the `Requirement` contract. Only a Gate is serializable for saves, mods and the balance harness. Only a Gate supports `timeUntilGateFlip` for predictor UIs. Use this form whenever a Gate can express the predicate.
- `createBooleanRequirement({ met })` — the closure form. Use it when no Gate kind fits the predicate: arbitrary computation across systems, or opaque consumer state. It returns the same requirement shape as the Gate form, but the predicate is not introspectable.

**What a Gate needs wired.** A Gate reads only the Gate services its kinds use, from the ambient Gate services. So build Gates inside `install()` / `connect()`, and hold the result. The accessor-backed kinds need a `GameStateAccessor`, and you supply it. [§ Data and live state separation](#data-and-live-state-separation) lists which kinds need it:

```ts
const engine = createEngine({
  gameId: 'my-game',
  // Only needed if you author accessor-backed Gate kinds. Category-only games skip it.
  accessor: {
    getAmount: (id) => resourcesById[id]?.value ?? Decimal.dZero,
    getRate: (id) => ratesById[id] ?? Decimal.dZero,
    getInflowRate: (id) => grossById[id] ?? Decimal.dZero, // optional; exact cumulative-gte predictions
    getFlag: (id) => flags[id] ?? false,
    getStateAt: (path) => readPath(gameState, path),
    ...mutator, // applyResourceOp / setFlag / setStateAt, for the effect side
  },
});
```

A Gate that needs a Gate service you did not wire throws, and names the service and the Gate kinds in play. It throws where you wrote it: at construction for `createGateRequirement`, and at register for a system's predicate field. Every predicate field of the systems layer takes a `Predicate`: a boolean, a ref, a getter or a Gate. `api/INDEX.md#predicate-forms` lists the fields. To read one back off a def, evaluate it with `evaluatePredicate(def.goal, services)`, or read the instance's reactive field.

```ts
const unlocks = createPurchasableCategory<UnlockDef>({
  id: 'unlocks',
  mapPurchasable: (def) => ({
    display: { title: def.title, description: def.description },
    requirements: createGateRequirement({
      gate: { kind: 'cumulative-gte', resource: 'primary', value: def.threshold },
    }),
    limit: 1,
  }),
});
setupSweepAutoPurchase(unlocks, { enabled: true }, ctx.onTick);
// Elsewhere: unlocks.getPurchasable('coop-built')?.active.value
```

### Level 3: Raw primitives (when categories don't fit)

If a category's `map*` works against you, drop down to the raw `create*` function. The signs are a shape that is too different, the wrong timing, or a need for control the category does not expose:

- `createScalingPurchasable` instead of `createPurchasableCategory`
- `createCycle`, `createReset`, `createModifierChain` directly
- `createCategoryBase` for a category of your own shape. Every built-in category is built on it. Pass `Instance = void` and omit `buildInstance` when a def needs only def state.

This is the normal path for one-off constructs, not a failure. The systems layer is built from these same primitives. For purchasables, [consumer-guide-choosing.md §Choosing among purchasable primitives](./consumer-guide-choosing.md#choosing-among-purchasable-primitives) answers most "category or raw?" questions.

### Level 4: Declarative Gates and effects

`Gate` is the typed, serializable predicate. `IEffect`, the `E` builder and `GameStateMutator` are the write side. Both are plain data, evaluated by pure functions: a Gate against the ambient Gate services, an effect through the `GameStateMutator`. Choose this level when typed refs are not available. Examples are save-file replay, mod files, balance tools and content-registry patches. The section [§ Data and live state separation](#data-and-live-state-separation) covers it in full. The form-choice table (Gate vs Requirement vs `Computable<boolean>`) is in `api/INDEX.md#predicate-forms`.

## Data and live state separation

Content modules keep `data/*.ts` free of engine objects. A data file describes what content exists, and never builds engine refs. That makes content swappable, because a mod replaces the data module and the module code stays the same. It makes content serializable, because data is plain values. It makes content analyzable, because a balance tool can read data without booting the engine.

The difficulty is a predicate over live state. An achievement's `goal` must look at a resource amount. An unlock must compare a lifetime total with a threshold. A dialog node's condition must read relationship state. The engine answers those questions while the game runs, but the *shape* of each question is part of the def.

`Gate` is the answer. The predicate's shape is in the def, as a typed AST keyed by string ids. The ambient Gate services resolve those ids to live refs at evaluation time. The data side never touches an engine ref, and the module side never owns a predicate's shape.

Gate kinds split by what they read, and the split decides what you wire:

- **Accessor-backed leaves** (`resource-gte`, `state`, `flag`) are declarative over the accessor. Where the kind permits it, `timeUntilGateFlip` predicts their transition distance. These are the kinds that require a `GameStateAccessor`.
- **`cumulative-gte`** reads the resource's lifetime total from the resource registry, so it evaluates without an accessor. A prediction needs one, and divides by the resource's inflow rate. That rate is `getInflowRate` where your accessor serves it, else the net rate. The net rate overstates the time while anything subtracts from the resource.
- **Category-aware leaves** (`count-gte`, `active`) read through `CategoryEntrySignals`, and need no accessor. Use them when the unlock or the count *is* a category entry.
- **Combinators** (`all`, `any`, `not`) combine either kind. Children go in an `of` field: `of: Gate[]` for `all` / `any`, `of: Gate` for `not`.

**When NOT to use a Gate.** With typed refs at hand, `hasResource(wood, 50)` is clearer than `{ kind: 'resource-gte', resource: 'wood', value: 50 }`. The data-side discipline is for *defs*, where a closure cannot be anyway. Typed call sites inside module code stay typed.

```ts
// data/achievements.ts — pure data, no engine imports
import type { Gate } from '@open-loop/engine';

export interface AchievementDef { id: string; description: string; goal: Gate }

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first-handful', description: 'Ten saved.',
    goal: { kind: 'cumulative-gte', resource: 'eggs', value: 10 } },
  { id: 'coop-built', description: 'Hens settle in.',
    goal: { kind: 'count-gte', category: 'producers', entry: 'coop', value: 1 } },
  { id: 'flock-master', description: 'A big coop and a full larder.',
    goal: { kind: 'all', of: [
      { kind: 'count-gte', category: 'producers', entry: 'coop', value: 5 },
      { kind: 'cumulative-gte', resource: 'eggs', value: 1000 },
    ] } },
];
```

No per-game predicate interface, no module-side implementation table, no closures passed into registration. The Gate union grows in the engine when a validated kind appears across consumers.

**Queries over a collection: use `StateGate`, not a new Gate kind.** A predicate over indexed state fits `StateGate` once the collection is projected into dot-paths that `GameStateAccessor.getStateAt` resolves. Examples are bestiary kill counts, achievement counts, per-tag totals and stats across runs. A "killed ≥5 goblins" check becomes `{ kind: 'state', path: 'bestiary.goblin.kills', operator: 'gte', value: 5 }`. A query that needs iteration, such as "killed any monster with tag X", needs a derived counter on the game side. Compute it over the collection (`computed(() => ...)`), expose it at a path such as `derived.killsByTag.<tag>`, and test *that* path. The engine ships no iteration primitive, because the collection's shape (tags, types, filters) is specific to each game.

A Gate kind that holds a closure is not part of the union, on purpose. It would break the Gate's serializability and predictor introspection. When neither `StateGate` nor a derived counter fits, the predicate is not declarative. Write it as a typed getter on a `Predicate` field, or as `createBooleanRequirement` on a requirement field. Keep it out of `Gate`. An unserializable predicate does not belong in `data/*.ts` either.

## Persistence

The game start-up is `use(...)` → `start()` → `load()`. `start()` installs the modules, so their persistent refs exist, but does not load the save. `load()` applies the save to them, and on first launch it reports `not-found`. `load()` before `start()`, or after `dispose()`, throws.

Build every saved object in `install`. One built after a load starts at its ref default, and its next save replaces the saved value; the engine warns. One built after `install` is also outside the module's persistent context and persistence namespace. Make a late object ephemeral, as `TimedProgress` allows.

With persistence on, the engine autosaves every 30 s. `autoSaveInterval` sets the period, and 0 turns autosave off. `engine.autoSaveInterval` changes it while the game runs, so a player's autosave setting writes there. Autosave waits until a load has run, so a late `load()` never finds its save overwritten with defaults. In dev, a first tick before any load warns while autosave is on. Call `engine.save()` at moments such as a run's end, in addition to the interval.

A load that fails for any reason except `not-found` protects its slot from writes until `saveManager.releaseSlot(id)` or `deleteSave()`. It emits `save:slot-protected` for a UI that offers to discard the unreadable save. `ctx.onLoad` runs after every successful load path, and `ctx.onSave` before every serialization. A "Saved" UI listens to `save:written`, not `onSave`, which is emitted only once a slot is written.

### Persistent context

All persistent engine state must be created inside a persistent context. `withPersistentContext` runs a block inside one, and closes it even if the block throws. Return the refs the caller needs, and destructure them outside:

```ts
const { wood, stone } = withPersistentContext('my-resources', () => ({
  wood: createResource<DecimalSource>(Decimal.dZero, { id: 'wood', displayName: 'Wood' }),
  stone: createResource<DecimalSource>(Decimal.dZero, { id: 'stone', displayName: 'Stone' }),
}));
```

The persistent context id and each ref's `id` make up the save key. A change to either breaks existing saves.

### Resetting persistent refs in bulk

To reset whole modules, use `createReset`'s `resetPersistentContexts` instead of listing refs by hand. Each time the reset runs, it resolves each module id to that module's persistent refs, its category and per-def persistent contexts included. So refs made in `connect()`, or by a module installed later, are in its reset scope. An id that names no module logs a warning:

```ts
const prestigeReset = createReset({
  resetPersistentContexts: ['resources', 'upgrades', 'producers'],
});
```

So a resource, purchasable, producer or category entry you add inside a module joins every reset that names that module.

**The systems' lifetime refs.** These system refs are tagged `lifetime`:

- resource `cumulative` / `best`, accumulator skill `lifetimeBonus`;
- cycle `count` / `bestTime`, time `totalPlayTime`;
- BestOf records, run pool aliveness, automation unlocks, recommendation settings, dialog state;
- achievement `earned` / `earnedAt`, challenge `active` / `completions`.

Neither `resetPersistentContexts` nor a `thingsToReset` walk over an object or a category writes them. A consumer's own ref takes the same flag: `persistent(0, { id: 'careerWins', lifetime: true })` survives every reset of its module. To clear one, name the ref itself in `thingsToReset`, or use the system's own verb (`resetUnlocks`, `clearAll`). The rest is run state: skill `xp`, cycle `elapsed`, TimeBank `banked` (hold it with `keep`). So a reset between runs over a skill category's module clears xp and keeps the lifetime bonus, which is the intended cycle. A module reset also clears an `ActionCategory`'s queue or list, current item, cursor and pause flag, and emits no `cancelled`. `thingsToReset: [category]` reaches only its def state.

A system or category in `thingsToReset` resets what it owns: its own persistent context, or each entry's per-def persistent context. It does not reset what it only names: a purchasable's cost resource, a producer's output, a ref passed as `limit` or `visibility`. List those explicitly when the reset should clear them.

Resource writes inside `onReset`, `afterReset` handlers and a cycle's `onEnd` run under the settle guard, and never reach `cumulative` / `best`. That includes a reset run from another reset's handlers, because the guard holds until the outermost reset ends. Add the prestige gain after `reset()` returns, or in `afterEnd`.

Inline `keep` and `retain` on the same `createReset` act as a denylist over the resolved reset scope, evaluated at reset time. Refs in `keep` keep their value verbatim. Refs in `retain` are captured before the clear, passed through the given transform, and written back after:

```ts
const prestigeReset = createReset({
  resetPersistentContexts: ['resources', 'upgrades'],
  keep: [premium],
  retain: new Map([[skillLevel, fractional(0.1)]]),
});
```

A `Resource` from `createResource` is itself the `Persistent` handle (`Resource<T> & Persistent<T>`). So pass it to `keep` / `retain` directly, with no `.amount`. Inline `keep` / `retain` is shorthand for `createRetention`. Use the standalone factory only when one retention spans more than one reset.

### Categories own their persistent contexts

Category factories (`createSkillCategory`, `createChallengeCategory`, `createPurchasableCategory` and the others) wrap each def in its own persistent context, `{categoryId}/{def.id}`. That id starts the **save key** as given. The enclosing module does not prefix it, so keep category ids unique across the game. The **reset scope** is a separate question. The per-def persistent context is still recorded as a child of the module that built the category. So a reset that names that module reaches every entry's run state. Only `lifetime` refs are outside it (§ Resetting persistent refs in bulk). Put a category whose run state must survive a reset in a module that no reset names.

For challenges, `active` and `completions` survive every prestige layer, which is the genre convention. A challenge also stays entered through every reset played inside it. Naming `'my-challenges/no-upgrades'` in `resetPersistentContexts` does not reset them. To clear completions, name the refs: `thingsToReset: challenges.getAll().map((e) => e.challenge.completions)`.

Rebuilding live state from persistent refs is hydration, and the engine does it after every load and reset. For example, a challenge category re-applies an entered challenge's overrides and patches, so `onLoad` has nothing to call. A public `restore(x)` is a different operation. It writes back what the same object's `snapshot()` or `serialize()` produced, such as a loadout or a resource bag record. Then it brings the object's handlers in line, as a load would.

Hydration runs after every `ctx.onLoad`. It covers challenge overrides, achievement and automation latching, loadout handlers and the temporary-effect rebuild. A watcher on what hydration writes already sees the state `onLoad` rebuilt, but `onLoad` itself sees the state before hydration. A hydration that throws after a successful load leaves the load standing, and emits `save:hydration-failed`.

These option callbacks differ between play and a load:

- A load restores `earned` without `onComplete`, so `onComplete` may grant a reward. An achievement whose goal holds once a load settles latches then, and its `onComplete` runs.
- Challenge `onEnter` / `onExit` run only when a player enters or exits, so they may write game state. Derive ephemeral setup that must come back after a load from `challenge.active`.
- A temporary-effect system calls `onHydrate`, else `onActivate`, and never `onExpire`. So a def whose `onActivate` writes game state needs an `onHydrate`. A reset that clears the system also drops its instances without `onExpire`.

### Chain modifiers are rebuilt at install, not loaded

The modifiers on a chain are not serialized, because closures cannot round-trip. That covers bindings (`chain.bind`, a category's grants) and an effect system's lowered grants. They are in module install code, which runs once at `start()`, before `load()` writes anything. So install sees ref defaults. Bind unconditionally, with `active` / `multiplier` reading persistent refs. Those are reactive, so the chain follows the refs through every load, import and reset in the same tick.

The mistake to avoid: `if (upgrade.active.value) chain.bind(...)` reads the default once at install and never runs again. `active` is a `Computable<boolean>` (`T | Readonly<Ref<T>> | () => T`), so all three forms are valid:

```ts
// Ref in hand — preferred, no closure
chain.bind({ active: upgrade.active, modifier })
// Derived predicate — getter form
chain.bind({ active: () => hasResource(ref.action, 1) && upgrade.active.value, modifier })
// Constant — always-on binding with attribution
chain.bind({ modifier })  // omit `active` entirely
```

Use the getter only when the predicate derives from more than one source.

### Writing save migrations

When you bump `EngineOptions.saveVersion`, supply a `saveMigrations` entry per version, which transforms the save data from `v` to `v+1`. Save migrations run in order over the raw decoded save data, before validation and deserialization. A step must return the data. One that returns nothing does not compile, and fails the load at runtime. A changed ref default needs a save migration too. A leaf at the old default was pruned from the save, so it loads as the new default. A save migration sees `undefined` for it, which means "the writing build's default". The engine ships a small kit of pure transforms. Compose them in the step instead of writing a traversal each time.

```ts
import { renameField, forEachDef, type SaveMigration } from '@open-loop/engine';

const saveMigrations: Record<number, SaveMigration> = {
  // v1 → v2: defs gained derived fields — iterate each def, seed with `??=`.
  1: (data) => {
    for (const group of ['jobs', 'constructions', 'exploration']) {
      forEachDef(data, group, (entry) => {
        entry.genStartCompletions ??= entry.timesCompleted ?? 0;
      });
    }
    return data;
  },
  // v2 → v3: rename a top-level group via a named helper.
  2: (data) => renameField(data, 'oldModule', 'newModule'),
};
```

Every helper mutates the data and returns it, and a missing path is a silent no-op. Each helper's TSDoc has its detail. `getNested` / `setNested` are the raw form for one-off shapes that no named helper fits.

Write the step by hand only when it needs one of these:

- a cross-field invariant, such as one field computed from two others;
- a structural change, such as two persistent contexts merged into one;
- work against the persistent-ref registry. The engine already handles old id-to-name remaps there.

The engine emits `save:migration-applied { from, to }` per step, so per-step logging belongs in an event handler, not the step.

## Conversions

`createConversion` is an atomic transformation over several resources, for crafting, market trades and exchange actions. It spends inputs through `Requirement`s, and produces outputs against a snapshot taken before any write. So an output that adds to an input's resource is well-defined.

**Inputs are Requirements, not necessarily costs.** A `createBooleanRequirement`, or a `createCostRequirement` with `requiresPay: false`, decides `canConvert` and costs nothing. That is the second shape shipping games use: a *conditional trigger* whose real spend is a reset run from `afterConvert`.

Conversion and reset are combined outside the factory, which holds no `Reset` reference:

```ts
const prestige = createConversion({
  inputs: {
    ready: createBooleanRequirement({
      met: () => Decimal.gte(runScore.value, threshold),
      description: 'Run score reached',
    }),
  },
  outputs: {
    prestigePoints: { resource: prestigePoints, amount: () => prestigeGain.value },
  },
  afterConvert: () => prestigeReset.reset(),
});

// At the call site: if (prestige.canConvert.value) prestige.convert();
```

**Prestige does not require a Conversion.** `createReset` plus a gain function is the whole composition, and several shipping games build it that way without this factory. Use a Conversion to put the test, the gain and the reset behind one `convert()`. It gives the UI `canConvert` / `currentGain`. Use `createReset` alone when you do not. Neither path is preferred.

For the gain curve itself, compose the arithmetic you need. The engine ships no prestige-formula helper. A floored root with a fixed exponent is `integerRoot`. A curve whose exponent changes during play is a `Formula`, which also inverts for a "next at" display. The recipe [consumer-guide-recipes.md §Sublinear per-source prestige payouts](./consumer-guide-recipes.md#sublinear-per-source-prestige-payouts) builds a per-source sublinear payout on `integerRoot`.

## Modifier chains and effects

"Effect" has two senses in this section. `IEffect`, the `E` builder and `GameStateMutator` are the **effect**: a declarative state write, evaluated against game state. `createConditionalEffectSystem` and `createTemporaryEffectSystem` are the **effect systems**. They place each def's lowered grants in a reserved chain slot while the def is active, and remove them when it ends. The engine rebuilds those lowered grants from the defs, and never reads them from the save (§ Chain modifiers are rebuilt at install, not loaded). A temporary-effect system does save which instances are active and how long each has left. After every load and reset, it rebuilds their lowered grants from that. `chain.bindings()` does not list lowered grants. `EffectSystemRegistryKey` attributes each one to its system, def and grant index.

`createModifierChain` is a named, composable modifier that several modules can add to. It is a shared chain for production multipliers, or for any value that many systems change:

```ts
// Module A creates the chain
const productionChain = createModifierChain('production');

// Module B pushes a modifier onto it
productionChain.add(createMultiplicativeModifier({
  multiplier: () => Decimal.add(1, Decimal.mul(renown.value, 0.1)),
  description: 'Renown',
}));
```

A chain evaluates in insertion order, so `+10` then `×2` differs from `×2` then `+10`. `chain.replace(old, next)` keeps a modifier's position, but `remove` + `add` moves it to the end. Both effect systems place each binding by registration order. So a chain's value depends on which effects are active, not on the order they activated.

Nothing reads a shared chain until something binds it. A producer's output runs through its own `rateChain`, so bind the shared chain into each one. `mapState` runs for each producer, including those a mod registers later:

```ts
createProducerCategory<BuildingDef>({
  id: 'buildings',
  registerTick: ctx.onTick,
  mapProducer: (def) => ({ resource: eggs, baseRate: def.baseRate, trigger: 'continuous' }),
  mapState: (_def, producer) => { producer.rateChain.bind({ modifier: productionChain, text: 'Production' }); },
});
```

`bind` requires the `text` or an `id`. It never derives the binding id from the modifier's display text, so editing that text does not move the id.

**The player-facing breakdown is `chain.description`.** It lists one `ModifierDescription` (`text`, `formattedValue`, `isBad`) per enabled modifier that has a description, in chain order. A binding's row is its modifier's own `description`; the binding's `text` is attribution text, and no row shows it. A grant's row is its `description`. A chain bound into another chain adds its own rows to the outer list. So a producer's `rateChain` lists every described modifier in force under it. A modifier that is not in force has no row. On a chain, `description` holds a getter, or `undefined` when no modifier has a description. So read it as `const d = chain.description; const rows = typeof d === 'function' ? d() : (d ?? []);`. It is reactive, so a `computed` over it updates when a binding's `active` predicate flips, or when a modifier is added or removed. `chain.bindings()` is the tooling read: it lists bindings for attribution, without their values.

For a modifier in force only while a condition holds, there are three forms. Choose the most specific one that fits:

- **Declarative category fields (`grants` / `restricts` / `rewards`)** — preferred when the modifier's lifecycle matches a category signal. Purchasable and achievement categories have `grants?: Grant[]`, in force while the purchasable's `active` ref is true or the achievement is earned. Challenge categories have `restricts?: Grant[]`, in force while the challenge is entered, and `rewards?: Grant[]`, in force after at least one completion. Each grant becomes a `chain.bind` call, with attribution from the persistent context. So a grant needs no per-binding setup, and the balance harness sees its modifier with an id like `research/overclock/Overclock`.

  ```ts
  createPurchasableCategory<ResearchDef>({
    id: 'research',
    mapPurchasable: (def) => ({
      display: { title: def.title, description: def.description },
      requirements: createCostRequirement({ resource: researchPoints, cost: def.cost }),
      limit: 1,
      grants: [
        { chain: productionChain, multiplier: () => computeMult(), description: 'Overclock' },
      ],
    }),
  });
  ```

- **`chain.bind({ active, modifier })`** — the primitive under the declarative fields. Use it directly for a one-off binding that fits no category signal. Examples are a module-level modifier and one behind an unlock. It derives an attribution id from the enclosing persistent context and the attribution text, and a duplicate id in one chain throws. Binding is **synchronous**. Purchase an upgrade, and `chain.apply(...)` includes the modifier in the same tick, with no `nextTick()`.

- **`createConditionalEffectSystem`** — for what `chain.bind` cannot cover cleanly:
  - a binding over several chains that must activate and deactivate together;
  - a binding with `onActivate` / `onDeactivate` option callbacks;
  - a registration outside any category lifecycle.

  Its `modifiers` take the same `Grant[]` as the category fields, and so do a temporary-effect system's. A predicate that reads a value its own bindings change throws. So do not make a modifier depend on the chain it raises.

A challenge or prestige layer may replace one multiplier with another while it is in force. An example is a challenge that takes a production multiplier from a different source. For this, use `replacementGrants`, which builds the cancel grant and the replacement grant in one call. The two grants have separate descriptions, so attribution stays intact. Do not use `OverrideRegistry` for this, because it bypasses the chain and defeats introspection.

[consumer-guide-recipes.md §Cross-action bonuses](./consumer-guide-recipes.md#cross-action-modifiers) works the most common use of these forms: one def's yield scaled by another def's state.

## Tunables

Balance constants are declared where they are read, through `tunable()`. That puts them in a tuning registry that balance probes, dev panels and mods can read. Declare them there from the first pass, not in a separate constants file. Two homes for one number have no rule for which wins. [consumer-guide-balance.md](./consumer-guide-balance.md) covers where the values come from.

```ts
// modules/tuning.ts — built in install, so the picker finds it; shared by key
export const TuningKey: InjectionKey<TuningRegistry> = Symbol('tuning');
export const tuningModule: EngineModule = {
  id: 'tuning',
  install(ctx) { ctx.provide(TuningKey, createTuningRegistry('my-game')); },
};

// modules/producers.ts — declared where it's read, and passed straight into options
install(ctx) {
  const tuning = ctx.inject(TuningKey);
  const costRatio = tunable(tuning, 'producers/costRatio', () => 1.08);
  createProducerCategory<BuildingDef>({
    id: 'buildings',
    registerTick: ctx.onTick,
    mapProducer: (def) => ({
      resource: eggs, trigger: 'continuous',
      // an option typed Computable takes a tunable as is
      baseRate: tunable(tuning, `producers/${def.id}/baseRate`, () => def.baseRate),
      purchase: {
        costResource: eggs,
        baseCost: tunable(tuning, `producers/${def.id}/baseCost`, () => def.baseCost),
        costRatio,
      },
    }),
  });
}

// data/producers.ts — structural, not a tunable: left unwrapped
export const prestigeEligibleThreshold = 1_000_000;
```

`tunable()` returns a `ComputedRef` that reads the tuning registry's scoped overrides, else its default. `tuning.pushOverrides(label, { 'producers/costRatio': () => 1.2 })` pushes overrides: a map from tuning key to a function that returns the value. The cleanup it returns pops them. The design gives two things:

- **The wraps document *what is a tunable*.** Wrap the values that external tools should change. Leave structural constants unwrapped: architectural thresholds, fixed step counts, level boundaries. A reviewer who scans the tuning registry then sees exactly what is safe to perturb.
- **Temporary overrides need no manual cleanup.** Headless runs, what-if probes and balance bisections push overrides, run and pop them.

Name a key by slash-separated segments for category, def and field (`'producers/tier1/baseRate'`, `'upgrades/double-gold/effect'`). Such keys are greppable, sortable, and clear about what each one controls when the tuning registry is listed.

Built inside install/connect, `createTuningRegistry` enrolls itself in `TuningRegistriesKey`, which the picker enumerates. A registry built at a file's top level, outside install/connect, still serves `tunable()`, but the picker and a balance workbench do not find it. `createOverrideRegistry` is the broader primitive beneath it. Use it directly when the override target is a non-numeric function that the picker should not show. To replace a modifier, prefer `replacementGrants` over a raw `OverrideRegistry` override, because it keeps chain attribution intact.

## Introspection

External tools, such as devtools panels, balance probes, UI hints and mods, walk the live engine through opt-in injection keys: `CategoriesKey`, `ChainRegistryKey`, `EffectSystemRegistryKey`, `TuningRegistriesKey`. Nothing couples them at install. Anything with an engine instance can enumerate them without being wired into its module graph.

The rule that game code never imports the balance harness is for gameplay modules: per-tick logic, content registration, effect bindings. Tooling may import the balance harness's walkers and picker freely. Keep tooling imports in their own module, so the line between gameplay and tooling stays clear.

Two query shapes recur:

- **"What can change this value, and where does it come from?"** — `createPickerSnapshot` walks content, chains and tunables, and deduplicates by `Modifier` identity. Its content entries are declared effect-system bindings, active or not. Its chain entries are what the chains hold now. See `api/harness.md#picker`.
- **"What changes next?"** — the transition walkers return pending transitions, each with a `TransitionDistance`. `createTransitionSnapshot` rebuilds on each call. `createIncrementalSnapshot` caches, for probes that rebuild after each simulated event. See `api/harness.md#transition-walker`.

A null `distance.seconds` is intentional, and the consumer interprets it. A stasis analyzer treats it as "cannot rule out this transition", and a countdown UI hides null rows.

Neither snapshot subscribes to reactive changes, so consumers decide when to recompute. Broader "can this predicate still hold?" coverage would need a search with a budget that combines the walker with rate and input checks. It is absent on purpose, not by oversight.

## Composition recipes

Two companions contain the recurring shapes consumers build from engine primitives. [consumer-guide-recipes.md](./consumer-guide-recipes.md) covers content, queues, grids and payouts. [consumer-guide-recipes-tick.md](./consumer-guide-recipes-tick.md) covers what a tick handler runs, and drawing what ticks change. Read one when you build one.

## When the engine should grow

The engine grows as consumers use it. Two signals:

**`TODO(ergonomics)`** — a path that works but is verbose. When two independent consumers build the same wrapper around the same setup, promote it to engine sugar. One consumer's wrapper is a game-side helper. Two are a missing engine primitive.

**The 10% threshold** — abstraction level 4 is designed for the ~10% of game logic that typed systems cannot express. Suppose more than 10% of your module code is `Gate` / `GameStateAccessor` code. Then either the engine needs a new typed system for that pattern, or an existing system needs a higher-level API. File a research ticket, not a workaround.

The test from [AGENTS.md](../AGENTS.md) § Layering Principle: if you would copy-paste the same wiring between two different games, it belongs in the engine. If it only makes sense for one game's design, it stays in the game. If it has no opinion about game design at all, it is core.
