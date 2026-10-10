# Consumer Guide

How to express a game with `@open-loop/engine`. Read this after forking `open-loop-starter` and before writing your first module.

This guide explains **how to compose** the engine — levels of abstraction, when to reach for which surface, the recurring shapes of consumer modules. It deliberately does not enumerate symbols; for that, route through [api/INDEX.md](api/INDEX.md) into the relevant `api/<tier>.md` file. Adjacent docs: [consumer-guide-choosing.md](./consumer-guide-choosing.md) when two primitives overlap and you need the boundary; [consumer-guide-recipes.md](./consumer-guide-recipes.md) for the worked-pattern cookbook; [consumer-guide-balance.md](./consumer-guide-balance.md) for how numbers get chosen and verified; `CHANGELOG.md` for breaking-change migration blocks.

## The expression spectrum

The engine offers several levels of abstraction for the same problem. Knowing which level to reach for — and when to move between them — is the core skill.

### Level 1: Resource helpers (reach for first)

The engine ships utility functions that handle the Decimal arithmetic, bounds checking, and modifier application that every game needs. Use these before writing raw `Decimal.add(resource.value, ...)`:

| Function | What it does | Replaces |
|---|---|---|
| `addResource` | Add to a resource, optionally tagging the gain with a modifier chain for trace attribution | `resource.value = Decimal.add(resource.value, amount)` |
| `subtractResource` | Subtract with insufficient-funds check; returns `false` if short | `if (Decimal.gte(r.value, cost)) { r.value = Decimal.sub(...) }` |
| `hasResource` | Check if a resource meets a threshold | `Decimal.gte(resource.value, amount)` |
| `displayResource` | Format a resource for display | `format(resource.value)` |
| `resetResource` | Reset to default value | `resource.value = Decimal.dZero` |
| `resource.best` | Persistent high-water mark on persistent resources | Manual `if (gt(current, best)) best = current` |
| `resource.cumulative` | Persistent lifetime gain on persistent resources, seeded with the default, so a starting balance counts as earned (as `cumulative-gte` reads it) | Manual accumulator in onTick |

These aren't sugar — they're the correct API. `subtractResource` returns a boolean so "check and spend" is one call, not two. `addResource` accepts an optional modifier chain that tags the gain for trace attribution (it does *not* apply the chain as a yield multiplier — pre-multiply the amount if you need that).

### Level 2: Category systems (the default for content)

Categories are the engine's standard shape for registering content: each factory exposes a typed registration contract and produces live engine objects per definition. Define a definition type, provide a mapper, register in bulk. The full factory list is in `api/content-systems.md` and `api/content-narrative.md` — read each's **Canonical entrypoints** block before reaching for raw primitives.

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

The `map*` function is where your game's definition shape meets the engine's options shape. For simple cases this is mostly pass-through; for complex cases (skills with custom curves, actions with type-specific behavior) the mapper does real work.

What a category gives you: per-definition persistent context, typed accessors (`getDef` / `getAll`), and per-def lifecycle. A mod adds definitions through the category's own `register`, which builds each def's instance and state — the category's `registry` is a read-and-patch `ContentRegistryView` with no `register` of its own — and changes one with `registry.patch()` without touching the original module. A patch rewrites the def, not what was built from it: a live instance sees it only where its mapping reads the def back through `getDef(id)` inside a getter, since value fields and closures over `def` are copied or frozen at register.

**Categories self-register.** Creating a category enrolls it into a global engine registry, so any consumer — UI surfaces, balance panels, debug overlays, the headless harness, mods — can walk your content by category type without importing the module that declared it. No publishing step; reading is opt-in. This is about who can *read* your content, not about where it may be constructed: the registry, like every other ambient handle, is only wired during `install()` / `connect()`. Bypass categories (raw primitives, no wrapper) and the content still works but falls outside the registry — tooling and mods won't see it.

**Predicate-gated purchasables.** A purchasable's shape is its requirements, not its name. Swap `createCostRequirement` for a predicate requirement and the same primitive becomes an unlock — no cost charged, and the `active` ref flips once it is purchased. Nothing purchases it on its own: `setupSweepAutoPurchase` does, on the first tick the requirement holds. Progression gates, tier ladders, era unlocks, and visibility flags all read through the one accessor — `category.getPurchasable(id)?.active.value` — with no parallel visibility store to keep in sync.

Two predicate-requirement forms, in preference order:

- `createGateRequirement({ gate })` — the Gate-authored path. Express the predicate as a `Gate` AST (`resource-gte`, `cumulative-gte`, `count-gte`, `unlock`, `flag`, `state`, `all`/`any`/`not`) and the adapter lifts it into the Requirement contract. The Gate is the only form that's serializable for save/mod/sim and supports `timeUntilGateFlip` for predictor UIs. Use this whenever the predicate can be expressed as a Gate.
- `createBooleanRequirement({ requirement })` — the closure escape hatch. Use when the predicate doesn't fit a Gate kind (arbitrary cross-system computation, opaque consumer state). Same runtime shape as the Gate adapter, but the predicate isn't introspectable.

**What a Gate needs wired.** A Gate reads only the handles its kinds use, and the engine resolves them from the ambient scope — so construct gates inside `install()` / `connect()`, and hold the result rather than re-resolving from a player-driven path. `count-gte` and `unlock` resolve entirely through the category registry and need **no accessor at all**; `cumulative-gte` evaluates through the resource registry and needs one only when you predict it with `timeUntilGateFlip`; the accessor-backed kinds (`resource-gte`, `flag`, `state`) need one, and it's yours to supply:

```ts
const engine = createEngine({
  gameId: 'my-game',
  // Only needed if you author accessor-backed Gate kinds. Category-only games skip it.
  accessor: {
    getResource: (id) => resourcesById[id]?.value ?? Decimal.dZero,
    getRate: (id) => ratesById[id] ?? Decimal.dZero,
    getInflowRate: (id) => grossById[id] ?? Decimal.dZero, // optional; exact cumulative-gte predictions
    isUnlocked: (id) => flags[id] ?? false,
    getState: (path) => readPath(gameState, path),
    ...mutator, // applyResourceOp / setUnlocked / setState, for the effect side
  },
});
```

A gate that reaches for a handle you didn't wire throws naming both the handle and the kind that wanted it, where you authored it: at construction for `createGateRequirement`, and when the definition registers for a system's predicate field. Every systems-layer predicate field — challenge `visible` / `canStart` / `goal`, achievement `requirement` / `visible` / `hidden`, purchasable and producer `visible`, automation tiers, cycle `endCondition`, reset `canReset`, persistent-effect `active`, a grant's `when` — takes a `Predicate`: a boolean, ref, getter or Gate. Code that reads one back off a definition evaluates it with `evaluatePredicate(def.goal, runtime)`, or reads the instance's reactive field instead.

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

If a category's `map*` is fighting you — the shape is too different, the timing is wrong, you need control the category doesn't expose — drop down to the raw `create*` function directly:

- `createScalingPurchasable` instead of `createPurchasableCategory`
- `createCycle`, `createReset`, `createModifierChain` directly
- `createCategoryBase` for category-shaped registries that don't fit any built-in shape. Pass `Instance = void` and omit `buildInstance` when entries are pure per-def state (no behavior object alongside the def). The base wires per-def persistent context (`{categoryId}/{def.id}`), auto-names persistent fields, and exposes `Resettable` so a category in `createReset` / `createCycle.thingsToReset` resets every entry's per-def context. This is the same primitive `createSkillCategory`, `createPurchasableCategory`, etc. compose internally — drop here when no system-level wrapper fits but the per-def-state-with-mod-aware-registration shape still does.

This is the normal path for one-off constructs, not a failure. The engine's systems layer composes from these same primitives — dropping down gives you the same building blocks with full control. For the purchasable family specifically, [consumer-guide-choosing.md §Choosing among purchasable primitives](./consumer-guide-choosing.md#choosing-among-purchasable-primitives) resolves most "category or raw?" questions; reach here for the rest.

### Level 4: Declarative gates and effects (the data-driven escape hatch)

`Gate` is the typed predicate-spec data shape; `IEffect` / `E` builder / `GameStateMutator` are the matching write side — plain data objects evaluated through pure functions against the engine's ambient runtime. Reach for this level when typed refs aren't available: save-file replay, mod configs loaded from JSON/YAML, balance-sim tools, content-registry patches that override behavior via data. The full treatment — Gate kind flavors, when to use vs. avoid, `StateGate` for indexed runtime collections, the closure escape hatch — lives in [§Data and runtime separation](#data-and-runtime-separation). For symbol-level detail see `api/mechanics.md#gate` and `api/mechanics.md#effects`; for the form-choice table (Gate vs Requirement vs `Computable<boolean>`) see `api/INDEX.md#predicate-forms`.

## Data and runtime separation

Content modules keep `data/*.ts` engine-runtime-free: data files describe what content exists, never instantiate engine refs. This isn't dogma — it's what makes content swappable (a mod replaces the data module, the runtime stays the same), serializable (data is plain values), and analyzable (a balance tool can read data without booting the engine).

The trick is when data needs to express predicates over live game state. An achievement's `requirement` has to look at a resource value; an unlock's gate has to check a threshold against a lifetime accumulator; a dialog node's condition has to read relationship state. Those are runtime questions, but the *shape* of the question is part of the content definition.

`Gate` is the answer. Predicate shape lives in the content definition as a typed AST keyed by string IDs; the engine's ambient runtime resolves those IDs to live refs at evaluation time. The data side never touches an engine ref; the runtime side never owns predicate shape.

Gate kinds split by what they read, and the split decides what you have to wire. **Accessor-backed leaves** (`resource-gte`, `state`, `flag`) are declarative against the accessor, with predictor-friendly distance via `timeUntilGateFlip` where the kind admits it — these are the kinds that oblige you to supply a `GameStateAccessor`. `cumulative-gte` reads the resource's lifetime total from the resource registry, so it evaluates without an accessor; predicting it takes one, and divides by the resource's inflow rate — `getInflowRate` where your accessor serves it, else the net rate, which overstates the time while anything drains the resource. **Category-aware leaves** (`count-gte`, `unlock`) read through `CategoryEntrySignals` and need no accessor — use when the unlock or count *is* a registered category entry. Combinators (`all`, `any`, `not`) compose either flavor; children go in an `of` field — `of: Gate[]` for `all`/`any`, `of: Gate` for `not`.

**When NOT to reach for Gate.** When you have direct typed refs in scope, `hasResource(wood, 50)` is clearer than `{ kind: 'resource-gte', resource: 'wood', value: 50 }`. The data-side discipline is about *content definitions* (where the closure can't live anyway) — typed callsites inside engine module code stay typed.

```ts
// data/achievements.ts — pure data, no engine imports
import type { Gate } from '@open-loop/engine';

export interface AchievementDef { id: string; description: string; requirement: Gate }

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first-handful', description: 'Ten saved.',
    requirement: { kind: 'cumulative-gte', resource: 'eggs', value: 10 } },
  { id: 'coop-built', description: 'Hens settle in.',
    requirement: { kind: 'count-gte', category: 'producers', entity: 'coop', value: 1 } },
  { id: 'flock-master', description: 'A big coop and a full larder.',
    requirement: { kind: 'all', of: [
      { kind: 'count-gte', category: 'producers', entity: 'coop', value: 5 },
      { kind: 'cumulative-gte', resource: 'eggs', value: 1000 },
    ] } },
];
```

No per-game predicate interface, no module-side implementation table, no closures handed into registration. The Gate union grows engine-side when a validated kind shows up across consumers; consumer code stays a tree of typed data. The would-be side-table for "what's currently visible?" never materializes because `unlock` reads `unlocks.getPurchasable(id)?.active.value` through the category-signals layer.

**Runtime collection queries — use `StateGate`, not a new Gate kind.** Predicates over indexed runtime state (bestiary kill counts, achievement tallies, per-tag aggregates, multi-run stats) fit `StateGate` once the collection is projected into a dot-path shape and resolved by `GameStateAccessor.getState`. A "killed ≥5 goblins" check becomes `{ kind: 'state', key: 'bestiary.goblin.kills', operator: 'gte', value: 5 }`. Compound queries that need iteration ("killed any monster with tag X") are expressed by precomputing a derived counter game-side (`computed(() => ...)` over the collection, exposed at e.g. `derived.killsByTag.<tag>`) and gating on *that* path — the engine does not ship an iteration primitive because the collection shape (tags, types, filters) is inherently game-specific.

A custom-predicate Gate kind carrying a closure is deliberately *not* part of the union: it would break Gate's serializability and predictor introspection. When neither `StateGate` nor a derived-counter path fits, the signal is that the gate isn't declarative — express it as a typed getter game-side on a `Predicate` field (or `createBooleanRequirement` on requirement-shaped fields) and keep it out of `Gate` entirely. That's the right place for it: an unserializable predicate doesn't belong in `data/*.ts` either way.

## Persistence

The game bootstrap is `use(...)` → `start()` → `load()`. `start()` installs the modules, so their persistent refs exist, and does not load the save. `load()` hydrates them; a first run reports `not-found`. `load()` before `start()` (or after `dispose()`) throws.

With persistence on, the engine autosaves every 30 s. `autoSaveInterval` sets the period, and 0 turns autosave off. `engine.autoSaveInterval` retunes it at runtime, so a player's autosave setting writes there. Autosave holds until a load has run, so a late `load()` never finds defaults written over its save. In dev, a first tick before any load warns while autosave is on. Call `engine.save()` at checkpoints such as a run's end, on top of the interval.

A load that fails for any reason but `not-found` protects its slot: autosave and `save()` skip it until `saveManager.releaseSlot(id)` or `deleteSave()`, and `save:slot-protected` fires for a UI that offers "discard the unreadable save". `ctx.onLoad` fires after every successful load path (`engine.load()`, the save manager's `load` / `importSave`, harness `createEngineFromSave`), and `ctx.onSave` before every serialization, autosave and `exportSave` included. "Saved" UI keys off `save:written`, not `onSave`: it fires only once `save`, `saveToSlot` or autosave has written the slot.

### Persistent context

All engine state that survives save/load must be created inside a persistent context. `withPersistentContext` runs a block inside the context and guarantees the context closes even if the block throws — return whatever refs the caller needs and destructure on the outside:

```ts
const { wood, stone } = withPersistentContext('my-resources', () => ({
  wood: createResource<DecimalSource>(Decimal.dZero, { id: 'wood', displayName: 'Wood' }),
  stone: createResource<DecimalSource>(Decimal.dZero, { id: 'stone', displayName: 'Stone' }),
}));
```

The context ID and each ref's `id` make up the save key. Changing either breaks existing saves.

### Resetting persistent refs in bulk

Use `createReset`'s `resetModules` for module-scoped resets instead of manually enumerating refs. The reset resolves each module ID to that module's persistent refs, nested category and per-definition contexts included, each time it runs — so refs made in `connect()` or by a module installed later are in scope, and an ID naming no module logs a warning:

```ts
const prestigeReset = createReset({
  resetModules: ['resources', 'upgrades', 'producers'],
});
```

So adding a resource, upgrade, producer, or category entry inside a module scope automatically joins resets that reference that module — no cross-file coordination.

**System-owned cross-run state is lifetime.** Resource `cumulative` / `best`, accumulator-skill `permanentBonus`, cycle `count` / `bestTime`, time `totalPlayTime`, BestOf records, run-pool aliveness, automation unlocks, recommendation settings, dialog state, achievement `earned` / `earnedAt` and challenge `active` / `completions` are tagged `lifetime`: neither `resetModules` nor a `thingsToReset` walk over an object or category touches them. Wipe one by naming the ref itself in `thingsToReset`, or through the system's own verb (`resetUnlocks`, `clearAll`). The rest is run state — skill `xp`, cycle `elapsed`, TimeBank `banked` (carry it with `keep`) — so a looper's between-run reset over a skill-category module wipes xp and keeps the permanent bonus, which is the intended cycle shape. A module reset also sweeps an `ActionCategory`'s queue or list, current item, cursor and pause flag, and fires no `cancelled`; `thingsToReset: [category]` reaches only its per-def state.

A system or category in `thingsToReset` resets what it owns — its own persistent context, or each entry's per-definition context — and nothing it merely names: a purchasable's cost resource, a producer's output, a ref passed as `limit` or `visibility`. List those explicitly when the reset should clear them.

Resource writes inside `onReset`, `afterReset` listeners and a cycle's `onRestart` run under the load guard and never reach `cumulative` / `best` — including a reset run from inside another's hooks, since the guard holds until the outermost reset ends. Grant prestige currency after `reset()` returns, or in `afterRestart`.

Inline `keep` and `retain` on the same `createReset` act as a denylist over the resolved scope, evaluated at reset time. Refs in `keep` survive verbatim; refs in `retain` are snapshot before the wipe, run through the supplied transform, and written back after:

```ts
const prestigeReset = createReset({
  resetModules: ['resources', 'upgrades'],
  keep: [premium],
  retain: new Map([[skillLevel, fractional(0.1)]]),
});
```

A `Resource` returned by `createResource` is itself the `Persistent` handle (`Resource<T> & Persistent<T>`), so pass it directly to `keep` / `retain` — no `.amount` indirection. Inline `keep`/`retain` is shorthand for `createRetentionPolicy`; drop to the standalone factory only when the same policy spans more than one reset.

### Category systems scope their own persistence

Category factories (`createSkillCategory`, `createChallengeCategory`, `createPurchasableCategory`, etc.) wrap each registered definition in its own persistent context, `{categoryId}/{def.id}`. That id is the **save key** as given — it isn't prefixed with the ambient module, so keep category ids unique across the game. **Reset scope** is a different axis: the per-definition context is still recorded as a child of the module the category was built in, so a reset naming that module reaches every entry's run state. Only `lifetime` refs escape it (§ Resetting persistent refs in bulk). Keep a category whose run state must outlive a prestige in a module no reset names.

For challenges that means `active` and `completions` survive every prestige tier (the genre convention), and a challenge stays entered through the prestiges played inside it. Naming `'my-challenges/ic1'` in `resetModules` doesn't reset them; to wipe completions, name the refs — `thingsToReset: challenges.getAll().map((e) => e.challenge.completions)`.

Rebuilding runtime state from persisted refs is hydration, and the engine does it itself after every load and reset — a challenge category re-applies an active challenge's overrides and patches, so there is nothing to call from `onLoad`. A public `restore(x)` is a different operation: it writes back what the same object's `snapshot()` or `serialize()` produced, such as a slot loadout or a resource-bag record, and brings the object's hooks in line as a load would. These engine reconciles (challenge scopes, achievement and automation latching, slot hook resync, temporary-effect rebuild) run after every `ctx.onLoad`: a watcher on what they write sees state `onLoad` rebuilt, while `onLoad` itself sees them unreconciled. A reconcile that throws after a successful load leaves the load standing and fires `save:reconcile-failed`. A load restores `earned` without firing `onComplete`, so `onComplete` may grant a reward; and an achievement whose requirement holds once a load settles (one added in a content update, or one a reset wiped by name) latches then. Challenge `onEnter` / `onExit` run only on a player entry or exit, so they may write game state; runtime-only setup that must come back after a load derives from `challenge.active`. A temporary-effect system rebuilds its live instances from the save, calling each def's `onRehydrate` (else `onApply`) and never `onExpire` on the instances it replaces, so a def whose `onApply` grants game state needs an `onRehydrate`; a reset that clears the system drops its instances without `onExpire` too.

### Bindings re-hydrate from install, not from save

Modifier bindings (`chain.bind`, `Grant` lowerings, `PersistentEffectSystem.register`) aren't serialized — closures can't round-trip. They live in module install code, which runs once at `start()`, before `load()` hydrates anything, so install sees default values. Bind unconditionally with `active` / `multiplier` closing over persistent refs: those are reactive, so the chain follows the refs through every load, import and reset the same tick.

The mistake to avoid: `if (upgrade.active.value) chain.bind(...)` reads the default once at install and never re-fires. Bind unconditionally and let `active` gate. `active` is a `Computable<boolean>` (`T | Readonly<Ref<T>> | () => T`), so all three of these are valid:

```ts
// Ref in hand — preferred, no closure
chain.bind({ active: upgrade.active, modifier })
// Derived predicate — getter form
chain.bind({ active: () => hasResource(ref.action, 1) && upgrade.active.value, modifier })
// Constant — always-on binding with attribution
chain.bind({ modifier })  // omit `active` entirely
```

Reach for the getter only when the predicate is derived from more than one source; if you already have a `Ref<boolean>`, pass it as-is.

### Writing migrations

When you bump `EngineConfig.saveVersion`, supply a `saveMigrations` entry for each version that transforms data from `v → v+1`. Migrations run sequentially over the raw decoded save object before validation and deserialize. A step must return the object: one that returns nothing doesn't compile, and fails the load at runtime. Changing a default is a migration too — a leaf at the old default was pruned from the save, so it loads as the new default, and a migration sees `undefined` for it, meaning "the writing build's default". The engine ships a small kit of pure transforms — compose them in the migration body rather than hand-rolling traversal each time.

```ts
import { renameField, retypeField, forEachDefinition, type SaveMigration } from '@open-loop/engine';

const saveMigrations: Record<number, SaveMigration> = {
  // v1 → v2: definitions gained derived fields — iterate each entry, seed with `??=`.
  1: (data) => {
    for (const group of ['jobs', 'constructions', 'exploration']) {
      forEachDefinition(data, group, (entry) => {
        entry.genStartCompletions ??= entry.timesCompleted ?? 0;
      });
    }
    return data;
  },
  // v2 → v3: rename a top-level group via a named helper.
  2: (data) => renameField(data, 'oldModule', 'newModule'),
  // v3 → v4: number → Decimal — engine deserialize accepts string-encoded Decimals.
  3: (data) => retypeField(data, 'inventory.gold', (v) => String(v)),
};
```

The helpers share their `.`-split nested-path convention, silent no-op on missing paths, and mutate-and-return semantics with the engine's serialize/deserialize paths — read their tsdoc for the per-helper detail. `getNested` / `setNested` are the raw escape hatch for one-off shapes that don't fit a named helper.

Drop to a hand-rolled callback only when a migration needs cross-field invariants (compute one field from two others), structural reshaping (collapse two contexts into one), or persistent-ref-registry interaction (legacy ID-to-name remaps — already handled internally). The engine emits `save:migration-applied { from, to }` per migration, so per-step logging belongs in an event listener, not the migration body.

## Conversions

`createConversion` is an atomic multi-resource transformation: spend inputs through `Requirement`s, produce outputs against a snapshot of what those inputs charged. Crafting recipes (`{wood: 100, mineral: 50} → {beam: 1}`), market trades (`{gold: 5} → {wood: 1}`), and exchange actions (`{gold: 'all'} → {mana: ({gold}) => gold * 50}`) are what the machinery is for — multi-input atomicity plus a snapshot taken before any mutation, so same-resource compounding (an output producing more of an input type) is well-defined.

**Inputs are Requirements, not necessarily costs.** A `createBooleanRequirement`, or a `createCostRequirement` with `requiresPay: false`, gates `canConvert` and charges nothing. That is the second shape shipping games use: a *gated trigger* whose real spend is a reset fired from `afterConvert`.

Conversion and reset are composed externally — the factory holds no `Reset` reference:

```ts
const prestige = createConversion({
  inputs: {
    ready: createBooleanRequirement({
      requirement: () => Decimal.gte(runScore.value, threshold),
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

**Prestige does not require a Conversion.** `createReset` plus a gain function is the entire pattern, and several shipping games compose it that way rather than routing through this factory. Reach for a Conversion when you want gate + gain + reset bundled behind one `convert()` with `canConvert` / `currentGain` for the UI to read; drop to `createReset` when you don't. Neither is the blessed path.

For the gain curve itself, compose the arithmetic you need rather than looking for a prestige-formula helper — the engine ships none. A fixed-exponent floored root is `integerRoot`; a curve whose exponent moves at runtime is a `Formula` chain, which also inverts for a "next at" display. For the per-source sublinear payout shape built on the former, see [consumer-guide-recipes.md §Sublinear per-source prestige payouts](./consumer-guide-recipes.md#sublinear-per-source-prestige-payouts).

## Modifier chains and effects

The word "effect" wears two hats in this section. `IEffect` / the `E` builder / `GameStateMutator` are the **state-mutation AST** — declarative writes evaluated against the ambient runtime. `createPersistentEffectSystem` / `createTemporaryEffectSystem` are **binding-lifecycle managers** — they hold live modifier registrations and activate/deactivate them as predicates flip. "Persistent" in the system name refers to the binding's durability across reloads, not to save serialization — the modifier bindings themselves are rebuilt from the defs, never read from the save (see § Bindings re-hydrate from install). A temporary effect does save which instances are active and how long each has left, and rebuilds their bindings from that after every load and reset. The modifier chain is the surface that bindings (from either source) push onto.

`createModifierChain` is a named, composable modifier multiple modules can push onto — a shared surface for production bonuses, yield multipliers, or any value many systems contribute to:

```ts
// Module A creates the chain
const productionChain = createModifierChain('production');

// Module B pushes a modifier onto it
productionChain.add(createMultiplicativeModifier({
  multiplier: () => Decimal.add(1, Decimal.mul(renown.value, 0.1)),
  description: 'Renown',
}));
```

A chain evaluates in insertion order, so `+10` then `×2` differs from `×2` then `+10`. A binding's `active` gates it where it sits, `chain.reserve()` holds a position for modifiers added later, and `chain.replace(old, next)` swaps in place; a raw `remove` + `add` moves the contribution to the end. Both effect systems place each binding by registration order — a static `modifiers` array claims its positions at `register`, a factory array on first activation — so a chain's value depends on which effects are active, not on the order they activated.

Nothing reads a shared chain until something binds it. A producer's output runs through its own `rateChain`, so bind the shared chain into each one; `mapState` runs per producer, including those a mod registers later:

```ts
createProducerCategory<BuildingDef>({
  id: 'buildings',
  registerTick: ctx.onTick,
  mapProducer: (def) => ({ resource: cookies, baseRate: def.baseRate, trigger: 'continuous' }),
  mapState: (_def, producer) => { producer.rateChain.bind({ modifier: productionChain, description: 'Production' }); },
});
```

Pass the `description` (or an `id`): bind derives the binding's attribution id from the modifier's description, and a shared chain has none while it is empty or holds an undescribed modifier, so a bare bind throws "cannot auto-derive binding id" whenever `mapState` runs before the chain fills.

For conditional modifiers (active only when a condition is met), there are three levels; pick the most-specific one that fits:

- **Declarative category fields (`grants` / `restricts` / `rewards`)** — preferred when the modifier's lifecycle matches a category signal. Purchasable and achievement categories expose `grants?: Grant[]` (active while the purchasable's `active` ref is true / the achievement is earned); challenge categories expose `restricts?: Grant[]` (active during the challenge) and `rewards?: Grant[]` (active after at least one completion). Each `Grant` lowers to a `chain.bind` call with scope-derived attribution — zero per-binding ceremony, balance-sim sees the contribution with an id like `ad-ip-upgrades/totalTimeMult/Time Dilation`.

  ```ts
  createPurchasableCategory<IPUpgradeDef>({
    id: 'ad-ip-upgrades',
    mapPurchasable: (def) => ({
      display: { title: def.title, description: def.description },
      requirements: createCostRequirement({ resource: infinityPoints, cost: def.cost }),
      limit: 1,
      grants: [
        { chain: productionChain, mult: () => computeMult(), description: 'Time Dilation' },
      ],
    }),
  });
  ```

- **`chain.bind({ active, modifier })`** — the primitive the declarative fields lower to. Use directly when you have a one-off 1:1 binding that doesn't fit a category signal (ad-hoc module-level buffs, unlock-gated conditional modifiers). Auto-derives an attribution id from the ambient `withPersistentContext` scope and the modifier's description; duplicate ids within one chain throw. Binding is **synchronous** — purchase an upgrade and `chain.apply(...)` reflects the contribution the same tick, no `nextTick()` needed. Bindings aren't persisted — the install-time binding follows its refs reactively across loads (see § Bindings re-hydrate from install, not from save).

- **`createPersistentEffectSystem`** — keep this for cases that `chain.bind` can't cover cleanly: multi-chain atomic bindings where all chains must activate/deactivate together, bindings with `onActivate` / `onDeactivate` side-effect hooks, or explicit registration outside any category-driven lifecycle. Its `modifiers` take the same `Grant[]` as the category fields, and so do a temporary effect's, where each shorthand builds a fresh modifier per stack. An `onActivate` that falsifies its own predicate settles deactivated, and a predicate that reads a value its own bindings change throws — don't gate a bonus on the chain it boosts. `getActive()` / `getByTag()` are reactive.

When a challenge or prestige layer replaces one multiplier with another while active (a challenge that rewires tickspeed to a different source is the canonical example), use `replacementBinding` to generate the cancel + replacement pair as one call. It returns two separately-described grants so attribution stays intact — do not use `OverrideRegistry` for this, which bypasses the chain and defeats introspection.

The most common shape this ladder gets used for — one definition's yield scaled by another definition's state — is worked in [consumer-guide-recipes.md §Cross-action bonuses](./consumer-guide-recipes.md#cross-action-bonuses).

## Tunable knobs

Balance constants — base rates, cost growth, multipliers — declare at their reader sites through `tunable()`, which exposes them via a tuning registry any external surface can read: a balance probe sweeping a knob, a live dev-panel slider, a mod config, an A/B harness. Declare them there from the first pass rather than collecting them in a parallel constants file; two homes for one number has no rule for which wins. Where the values come from in the first place is [consumer-guide-balance.md](./consumer-guide-balance.md).

```ts
// modules/tuning.ts — the registry, shared by every reader site
export const tuning = createTuningRegistry('my-game');

// modules/producers.ts — declared where it's read
const baseRate = tunable(tuning, 'producers/tier1/baseRate', () => 0.5);
const costGrowth = tunable(tuning, 'producers/costGrowth', () => 1.08);

// data/producers.ts — structural, not a knob: left unwrapped
export const prestigeEligibleThreshold = 1_000_000;
```

The wrap returns a `ComputedRef` that reads registry-then-default; `pushScope` and the cleanup it returns install and pop override layers reactively (see `tunable()` tsdoc for the scoped-stack mechanics). The design payoff is two-fold. First, the wrap surface doubles as documentation of *what's a knob*: wrap values external surfaces should touch, leave structural constants (architectural thresholds, fixed step counts, level boundaries) unwrapped, and a reviewer scanning the registry sees exactly what's safe to perturb. Second, transient takeovers — sim runs, what-if probes, balance bisections — push a scope, run, restore: base values come back with no manual cleanup.

Key naming convention: namespace with `category/entity/field` slashes (`'producers/tier1/baseRate'`, `'upgrades/double-gold/effect'`). Greppable, sortable, and clear about what each key controls when the registry is enumerated.

For the cross-engine layer that walks these registries (balance workbench, sim picker, dev panels) see `api/introspection.md#override-registry` — `createTuningRegistry` auto-enrolls into `TuningRegistriesKey` (the picker's enumeration surface) when constructed inside the engine's install/connect ambient. `createOverrideRegistry` is the broader primitive underneath — reach for it directly when the override target is a non-numeric function the picker shouldn't surface (challenge takeover, mod fn replacement, sim swap). For modifier-chain replacement specifically, prefer `replacementBinding` (§Modifier chains) over a raw `OverrideRegistry` swap — it keeps chain attribution intact.

## Introspection

External tools (devtools panels, balance probes, UI hints, mods) walk the live engine surface through opt-in injection keys — `CategoriesKey`, `ChainRegistryKey`, `EffectSystemRegistryKey`, `TuningRegistriesKey`. No install-time coupling: anything with an engine handle can enumerate without being wired into its module graph.

The "game code never imports harness" rule applies to runtime gameplay modules (per-tick logic, content registrations, effect bindings). Tooling consumers — devtools panels, balance probes, "upcoming unlock" hints, content-introspecting mods — are a separate class and may import the harness walkers and picker freely. Keep tooling imports in their own module so the gameplay/tooling boundary stays legible.

Two query shapes recur:

- **"What can modify this value, and where does it come from?"** — `createPickerSnapshot` walks content + chains + tunables and deduplicates by `Modifier` identity. Content entries are declared effect bindings, active or not; chain entries are what the chains hold now. See `api/harness.md#picker`.
- **"What changes next?"** — the transition-walker family returns pending state transitions across challenges/purchasables/producers with `TransitionDistance` per emission. Two adoption shapes, picked by recomputation cadence: `createTransitionSnapshot` rebuilds from scratch on each call (one-shot probes, coarse-cadence UIs), `createIncrementalSnapshot` caches with per-label dependency tracking and `invalidate*` axes (event-stepping probes that rebuild per simulated event). See `api/harness.md#content-walker`.

Null `distance.seconds` is intentional and consumer-interpreted: a stasis analyzer treats it as "cannot rule out this transition"; a countdown UI hides null rows entirely. The walker never makes that policy call.

Neither snapshot subscribes to reactive changes — consumers drive recomputation cadence themselves. Broader "can this predicate still fire?" coverage would need a budget-bounded layer composing the walker with rate and input checks; that's deliberately absent, not overlooked.

## Composition recipes

Recurring shapes consumers assemble from engine primitives — worked patterns from the consumer corpus, not engine symbols — live in [consumer-guide-recipes.md](./consumer-guide-recipes.md): action execution, worker pools, persona rosters, priority-weighted fill, dialog and subjects, spatial boards, cross-action bonuses, prestige payouts, and the shared pure state-function. Reach for it when you're building one of those.

## When the engine should grow

The engine evolves as consumers use it. Two signals:

**`TODO(ergonomics)`** — a working but verbose path. When two independent consumers build the same wrapper around the same ceremony, that's the signal to promote it to engine sugar. One consumer's wrapper is a game-side helper; two is a missing engine primitive.

**The 10% threshold** — the data-driven escape hatch (level 4) is designed for the ~10% of game logic that a generic engine can't express in typed systems. If your game is spending more than 10% of its module code in `Gate` / `GameStateAccessor` territory, that's a signal: either the engine needs a new typed system for the pattern you're expressing, or the existing system needs a higher-level entry point. File a research ticket, not a workaround.

The test from [AGENTS.md](../AGENTS.md) § Layering Principle: if you'd copy-paste the same wiring between two different games, it belongs in the engine. If it only makes sense for one game's design, it stays game-side. If it has no opinion about game design at all, it's core.
